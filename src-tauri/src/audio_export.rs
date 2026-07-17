use serde::{Deserialize, Serialize};
use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub const EXPORT_POLICY_VERSION: u32 = 2;
pub const DEFAULT_MP3_START_TRIM_SAMPLES: usize = 1_105;
const LOOP_GRID_TOLERANCE_BEATS: f64 = 0.05;
const MAX_LOOP_END_PADDING_FRAMES: usize = 1_152;
static TEMP_EXPORT_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSampleParams {
    pub samples_dir: String,
    pub relative_audio_path: String,
    pub asset_category_slug: String,
    pub duration_ms: i64,
    pub bpm: Option<f64>,
    #[serde(default = "default_correction_enabled")]
    pub correction_enabled: bool,
}

fn default_correction_enabled() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSampleResult {
    pub absolute_path: String,
    pub relative_path: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub source_frames: usize,
    pub output_frames: usize,
    pub start_trim_samples: usize,
    pub end_trim_samples: usize,
    pub end_padding_samples: usize,
    pub target_beats: Option<i64>,
    pub grid_confident: bool,
    pub policy_version: u32,
    pub correction_enabled: bool,
    pub declared_padding_samples: Option<u32>,
    pub calculated_padding_samples: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteExportSummary {
    pub exported: usize,
    pub regenerated: usize,
    pub failed: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct ExportPlan {
    start: usize,
    end: usize,
    end_padding: usize,
    target_beats: Option<i64>,
    grid_confident: bool,
}

pub(crate) fn safe_relative_path(relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute() || relative.is_empty() {
        return Err("Audio path must be a non-empty relative path".into());
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Audio path contains unsafe components".into());
    }
    Ok(path.to_path_buf())
}

fn exported_relative_path(source_relative: &Path) -> PathBuf {
    PathBuf::from("exported")
        .join(source_relative)
        .with_extension("wav")
}

fn calculated_padding_samples(declared: Option<u32>) -> usize {
    match declared.map(|value| value as usize) {
        // Reject obviously corrupt metadata rather than producing an empty or
        // severely over-trimmed export. Real audited Splice values are 1105.
        Some(value @ 256..=4_096) => value,
        _ => DEFAULT_MP3_START_TRIM_SAMPLES,
    }
}

fn export_plan(
    total_frames: usize,
    sample_rate: u32,
    category: &str,
    duration_ms: i64,
    bpm: Option<f64>,
    correction_enabled: bool,
    calculated_padding_samples: usize,
) -> ExportPlan {
    if !correction_enabled {
        return ExportPlan {
            start: 0,
            end: total_frames,
            end_padding: 0,
            target_beats: None,
            grid_confident: false,
        };
    }
    let default_start = calculated_padding_samples.min(total_frames);
    if category != "loop" {
        return ExportPlan {
            start: default_start,
            end: total_frames,
            end_padding: 0,
            target_beats: None,
            grid_confident: false,
        };
    }

    let Some(bpm) = bpm.filter(|value| value.is_finite() && *value > 0.0) else {
        return ExportPlan {
            start: default_start,
            end: total_frames,
            end_padding: 0,
            target_beats: None,
            grid_confident: false,
        };
    };
    let raw_beats = duration_ms.max(0) as f64 * bpm / 60_000.0;
    let beats = raw_beats.round() as i64;
    let grid_confident = beats > 0 && (raw_beats - beats as f64).abs() <= LOOP_GRID_TOLERANCE_BEATS;
    if !grid_confident {
        return ExportPlan {
            start: default_start,
            end: total_frames,
            end_padding: 0,
            target_beats: None,
            grid_confident: false,
        };
    }

    let target_frames = ((beats as f64 * 60.0 * sample_rate as f64) / bpm).round() as usize;
    let available_frames = total_frames.saturating_sub(default_start);
    if target_frames > available_frames {
        let deficit = target_frames - available_frames;
        if deficit <= MAX_LOOP_END_PADDING_FRAMES {
            return ExportPlan {
                start: default_start,
                end: total_frames,
                end_padding: deficit,
                target_beats: Some(beats),
                grid_confident: true,
            };
        }
        return ExportPlan {
            start: default_start,
            end: total_frames,
            end_padding: 0,
            target_beats: Some(beats),
            grid_confident: false,
        };
    }

    ExportPlan {
        start: default_start,
        end: default_start + target_frames,
        end_padding: 0,
        target_beats: Some(beats),
        grid_confident: true,
    }
}

pub(crate) struct DecodedMp3 {
    pub sample_rate: u32,
    pub channels: u16,
    pub interleaved: Vec<f32>,
    pub declared_padding: Option<u32>,
}

pub(crate) fn decode_mp3(path: &Path) -> Result<DecodedMp3, String> {
    let file = File::open(path).map_err(|error| format!("Open MP3 {}: {error}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    hint.with_extension("mp3");
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| format!("Probe MP3 {}: {error}", path.display()))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| format!("MP3 {} has no audio track", path.display()))?;
    let track_id = track.id;
    // Symphonia's MP3 demuxer exposes the total leading skip parsed from the
    // LAME/Xing metadata. In the real Splice cohort this is 1105, matching
    // FFmpeg's Skip Samples side data (not merely the 576 encoder component).
    let declared_padding = track.codec_params.delay;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|error| format!("Create MP3 decoder {}: {error}", path.display()))?;

    let mut sample_rate = None;
    let mut channels = None;
    let mut interleaved = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => {
                return Err(format!("MP3 decoder reset required for {}", path.display()))
            }
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(error) => return Err(format!("Read MP3 packet {}: {error}", path.display())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(format!("Decode MP3 {}: {error}", path.display())),
        };
        let spec = *decoded.spec();
        sample_rate.get_or_insert(spec.rate);
        channels.get_or_insert(spec.channels.count() as u16);
        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        samples.copy_interleaved_ref(decoded);
        interleaved.extend_from_slice(samples.samples());
    }

    let sample_rate =
        sample_rate.ok_or_else(|| format!("MP3 {} decoded no samples", path.display()))?;
    let channels = channels.ok_or_else(|| format!("MP3 {} has no channels", path.display()))?;
    if channels == 0 || interleaved.len() % channels as usize != 0 {
        return Err(format!(
            "MP3 {} produced invalid channel data",
            path.display()
        ));
    }
    Ok(DecodedMp3 {
        sample_rate,
        channels,
        interleaved,
        declared_padding,
    })
}

fn write_wav_atomic(
    destination: &Path,
    sample_rate: u32,
    channels: u16,
    interleaved: &[f32],
    end_padding_frames: usize,
) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| format!("Export path {} has no parent", destination.display()))?;
    std::fs::create_dir_all(parent).map_err(|error| format!("Create export directory: {error}"))?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Export filename is invalid UTF-8".to_string())?;
    let nonce = TEMP_EXPORT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(".{file_name}.tmp-{}-{nonce}", std::process::id()));
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: 24,
        sample_format: hound::SampleFormat::Int,
    };
    let write_result = (|| -> Result<(), String> {
        let mut writer = hound::WavWriter::create(&temporary, spec)
            .map_err(|error| format!("Create WAV {}: {error}", temporary.display()))?;
        for sample in interleaved {
            let quantized = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
            writer
                .write_sample(quantized)
                .map_err(|error| format!("Write WAV {}: {error}", temporary.display()))?;
        }
        for _ in 0..end_padding_frames * channels as usize {
            writer
                .write_sample(0i32)
                .map_err(|error| format!("Pad WAV {}: {error}", temporary.display()))?;
        }
        writer
            .finalize()
            .map_err(|error| format!("Finalize WAV {}: {error}", temporary.display()))?;
        std::fs::rename(&temporary, destination)
            .map_err(|error| format!("Replace WAV {}: {error}", destination.display()))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

fn export_sample_wav_sync(params: ExportSampleParams) -> Result<ExportSampleResult, String> {
    let source_relative = safe_relative_path(&params.relative_audio_path)?;
    let root = PathBuf::from(&params.samples_dir);
    let source = root.join(&source_relative);
    let output_relative = exported_relative_path(&source_relative);
    let output = root.join(&output_relative);
    let decoded = decode_mp3(&source)?;
    let sample_rate = decoded.sample_rate;
    let channels = decoded.channels;
    let declared_padding = decoded.declared_padding;
    let padding_samples = calculated_padding_samples(declared_padding);
    let channel_count = channels as usize;
    let source_frames = decoded.interleaved.len() / channel_count;
    let plan = export_plan(
        source_frames,
        sample_rate,
        &params.asset_category_slug,
        params.duration_ms,
        params.bpm,
        params.correction_enabled,
        padding_samples,
    );
    let samples = &decoded.interleaved[plan.start * channel_count..plan.end * channel_count];
    write_wav_atomic(&output, sample_rate, channels, samples, plan.end_padding)?;
    Ok(ExportSampleResult {
        absolute_path: output.to_string_lossy().into_owned(),
        relative_path: output_relative.to_string_lossy().into_owned(),
        sample_rate,
        channels,
        source_frames,
        output_frames: plan.end - plan.start + plan.end_padding,
        start_trim_samples: plan.start,
        end_trim_samples: source_frames - plan.end,
        end_padding_samples: plan.end_padding,
        target_beats: plan.target_beats,
        grid_confident: plan.grid_confident,
        policy_version: EXPORT_POLICY_VERSION,
        correction_enabled: params.correction_enabled,
        declared_padding_samples: declared_padding,
        calculated_padding_samples: padding_samples,
    })
}

pub fn export_missing_favorite_wavs_sync(
    samples_dir: &str,
) -> Result<FavoriteExportSummary, String> {
    let db = PathBuf::from(samples_dir).join(".splicerr/library.db");
    let conn = rusqlite::Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(30))
        .map_err(|error| error.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT relative_audio_path, asset_category_slug, duration_ms, bpm
                 FROM samples WHERE favorite = 1 AND audio_cached_at > 0 ORDER BY uuid",
        )
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ExportSampleParams {
                samples_dir: samples_dir.to_string(),
                relative_audio_path: row.get(0)?,
                asset_category_slug: row.get(1)?,
                duration_ms: row.get(2)?,
                bpm: row.get(3)?,
                correction_enabled: true,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut summary = FavoriteExportSummary {
        exported: 0,
        regenerated: 0,
        failed: 0,
        failures: Vec::new(),
    };
    for row in rows {
        let params = row.map_err(|error| error.to_string())?;
        let relative = safe_relative_path(&params.relative_audio_path)?;
        let destination = PathBuf::from(samples_dir).join(exported_relative_path(&relative));
        let existed = destination.exists();
        match export_sample_wav_sync(params) {
            Ok(_) if existed => summary.regenerated += 1,
            Ok(_) => summary.exported += 1,
            Err(error) => {
                summary.failed += 1;
                if summary.failures.len() < 20 {
                    summary.failures.push(error);
                }
            }
        }
    }
    Ok(summary)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn export_missing_favorite_wavs(
    samples_dir: String,
) -> Result<FavoriteExportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || export_missing_favorite_wavs_sync(&samples_dir))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn export_sample_wav(params: ExportSampleParams) -> Result<ExportSampleResult, String> {
    tauri::async_runtime::spawn_blocking(move || export_sample_wav_sync(params))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn exported_path_preserves_tree_and_changes_extension() {
        assert_eq!(
            exported_relative_path(Path::new("Pack/Loops/Kick.mp3")),
            PathBuf::from("exported/Pack/Loops/Kick.wav")
        );
    }

    #[test]
    fn rejects_unsafe_relative_paths() {
        assert!(safe_relative_path("../outside.mp3").is_err());
        assert!(safe_relative_path("/absolute.mp3").is_err());
        assert!(safe_relative_path("Pack/Loop.mp3").is_ok());
    }

    #[test]
    fn one_shot_trims_only_the_leading_padding() {
        assert_eq!(
            export_plan(
                20_000,
                44_100,
                "oneshot",
                400,
                None,
                true,
                DEFAULT_MP3_START_TRIM_SAMPLES,
            ),
            ExportPlan {
                start: 1_105,
                end: 20_000,
                end_padding: 0,
                target_beats: None,
                grid_confident: false,
            }
        );
    }

    #[test]
    fn declared_padding_changes_the_export_start() {
        let plan = export_plan(20_000, 44_100, "oneshot", 400, None, true, 1_234);
        assert_eq!(plan.start, 1_234);
        assert_eq!(plan.end, 20_000);
    }

    #[test]
    fn corrupt_declared_padding_uses_the_audited_fallback() {
        assert_eq!(calculated_padding_samples(Some(0)), 1_105);
        assert_eq!(calculated_padding_samples(Some(50_000)), 1_105);
        assert_eq!(calculated_padding_samples(Some(1_234)), 1_234);
        assert_eq!(calculated_padding_samples(None), 1_105);
    }

    #[test]
    fn loop_uses_exact_bpm_grid_length() {
        let plan = export_plan(
            354_816,
            44_100,
            "loop",
            8_000,
            Some(120.0),
            true,
            DEFAULT_MP3_START_TRIM_SAMPLES,
        );
        assert_eq!(plan.start, 1_105);
        assert_eq!(plan.end - plan.start, 352_800);
        assert_eq!(plan.target_beats, Some(16));
        assert!(plan.grid_confident);
    }

    #[test]
    fn short_excess_preserves_trim_and_pads_loop_end() {
        let plan = export_plan(
            353_200,
            44_100,
            "loop",
            8_000,
            Some(120.0),
            true,
            DEFAULT_MP3_START_TRIM_SAMPLES,
        );
        assert_eq!(plan.start, 1_105);
        assert_eq!(plan.end, 353_200);
        assert_eq!(plan.end_padding, 705);
        assert_eq!(plan.end - plan.start + plan.end_padding, 352_800);
        assert!(plan.grid_confident);
    }

    #[test]
    fn off_grid_loop_only_applies_leading_trim() {
        let plan = export_plan(
            360_000,
            44_100,
            "loop",
            8_123,
            Some(120.0),
            true,
            DEFAULT_MP3_START_TRIM_SAMPLES,
        );
        assert_eq!(plan.start, 1_105);
        assert_eq!(plan.end, 360_000);
        assert!(!plan.grid_confident);
    }

    #[test]
    fn contradictory_loop_metadata_is_not_duration_forced() {
        let plan = export_plan(
            340_000,
            44_100,
            "loop",
            8_000,
            Some(120.0),
            true,
            DEFAULT_MP3_START_TRIM_SAMPLES,
        );
        assert_eq!(plan.start, 1_105);
        assert_eq!(plan.end, 340_000);
        assert_eq!(plan.end_padding, 0);
        assert!(!plan.grid_confident);
    }

    #[test]
    fn diagnostic_bypass_preserves_all_decoded_frames() {
        assert_eq!(
            export_plan(
                20_000,
                48_000,
                "loop",
                2_000,
                Some(120.0),
                false,
                DEFAULT_MP3_START_TRIM_SAMPLES,
            ),
            ExportPlan {
                start: 0,
                end: 20_000,
                end_padding: 0,
                target_beats: None,
                grid_confident: false,
            }
        );
    }

    #[test]
    fn real_dev_mp3_exports_exact_wav_and_overwrites() {
        let root = Path::new("/Volumes/disco/splicerr");
        let db = root.join(".splicerr/library.db");
        if !db.exists() {
            eprintln!("Skipping dev-cache export test: {db:?} is unavailable");
            return;
        }
        let conn =
            rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        conn.busy_timeout(std::time::Duration::from_secs(30))
            .unwrap();
        let row: (String, i64, f64) = conn
            .query_row(
                "SELECT relative_audio_path, duration_ms, bpm
                 FROM samples INDEXED BY idx_samples_category
                 WHERE asset_category_slug = 'loop' AND audio_cached_at > 0
                   AND bpm = 120 AND ABS(duration_ms * bpm / 60000.0 - 16.0) < 0.01
                 LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let relative = PathBuf::from(&row.0);
        let copied_source = temporary.path().join(&relative);
        std::fs::create_dir_all(copied_source.parent().unwrap()).unwrap();
        std::fs::copy(root.join(&relative), &copied_source).unwrap();

        let make_params = |correction_enabled| ExportSampleParams {
            samples_dir: temporary.path().to_string_lossy().into_owned(),
            relative_audio_path: row.0.clone(),
            asset_category_slug: "loop".into(),
            duration_ms: row.1,
            bpm: Some(row.2),
            correction_enabled,
        };
        let first = export_sample_wav_sync(make_params(true)).unwrap();
        assert_eq!(first.start_trim_samples, DEFAULT_MP3_START_TRIM_SAMPLES);
        assert_eq!(first.target_beats, Some(16));
        assert!(first.grid_confident);
        assert_eq!(
            first.output_frames,
            (16.0 * 60.0 * first.sample_rate as f64 / 120.0).round() as usize
        );
        let output = PathBuf::from(&first.absolute_path);
        let reader = hound::WavReader::open(&output).unwrap();
        assert_eq!(reader.spec().bits_per_sample, 24);
        assert_eq!(reader.spec().sample_rate, first.sample_rate);
        assert_eq!(reader.duration() as usize, first.output_frames);
        drop(reader);
        let expected = std::fs::read(&output).unwrap();

        std::fs::write(&output, b"must be replaced").unwrap();
        let second = export_sample_wav_sync(make_params(true)).unwrap();
        assert_eq!(second.output_frames, first.output_frames);
        assert_eq!(std::fs::read(&output).unwrap(), expected);

        let bypass = export_sample_wav_sync(make_params(false)).unwrap();
        assert_eq!(bypass.start_trim_samples, 0);
        assert_eq!(bypass.output_frames, bypass.source_frames);
        assert_ne!(std::fs::read(&output).unwrap(), expected);

        let restored = export_sample_wav_sync(make_params(true)).unwrap();
        assert_eq!(restored.policy_version, EXPORT_POLICY_VERSION);
        assert_eq!(std::fs::read(&output).unwrap(), expected);
    }

    #[test]
    fn favorite_reconciliation_regenerates_existing_wav_in_preserved_tree() {
        let root = Path::new("/Volumes/disco/splicerr");
        let source_db = root.join(".splicerr/library.db");
        if !source_db.exists() {
            return;
        }
        let source_conn = rusqlite::Connection::open_with_flags(
            source_db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let row: (String, String, i64, Option<f64>) = source_conn
            .query_row(
                "SELECT relative_audio_path, asset_category_slug, duration_ms, bpm
                 FROM samples WHERE audio_cached_at > 0 ORDER BY uuid LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let relative = PathBuf::from(&row.0);
        let copied_source = temporary.path().join(&relative);
        std::fs::create_dir_all(copied_source.parent().unwrap()).unwrap();
        std::fs::copy(root.join(&relative), &copied_source).unwrap();
        let db_dir = temporary.path().join(".splicerr");
        std::fs::create_dir_all(&db_dir).unwrap();
        let conn = rusqlite::Connection::open(db_dir.join("library.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE samples (
                uuid TEXT, relative_audio_path TEXT, asset_category_slug TEXT,
                duration_ms INTEGER, bpm REAL, favorite INTEGER, audio_cached_at INTEGER
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO samples VALUES ('fixture', ?1, ?2, ?3, ?4, 1, 1)",
            rusqlite::params![row.0, row.1, row.2, row.3],
        )
        .unwrap();
        drop(conn);
        let destination = temporary.path().join(exported_relative_path(&relative));
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();
        std::fs::write(&destination, b"stale policy output").unwrap();

        let summary =
            export_missing_favorite_wavs_sync(temporary.path().to_str().unwrap()).unwrap();
        assert_eq!(summary.exported, 0);
        assert_eq!(summary.regenerated, 1);
        assert_eq!(summary.failed, 0);
        assert!(hound::WavReader::open(&destination).is_ok());
        assert!(destination.starts_with(temporary.path().join("exported")));
    }

    fn correlation_at_lag(left: &[f32], right: &[f32], lag: isize) -> f64 {
        let left_start = 2_000usize;
        let right_start = (left_start as isize + lag) as usize;
        let length = 4_096usize;
        if right_start + length > right.len() || left_start + length > left.len() {
            return f64::NEG_INFINITY;
        }
        let mut dot = 0.0f64;
        let mut left_energy = 0.0f64;
        let mut right_energy = 0.0f64;
        for index in 0..length {
            let a = left[left_start + index] as f64;
            let b = right[right_start + index] as f64;
            dot += a * b;
            left_energy += a * a;
            right_energy += b * b;
        }
        dot / (left_energy * right_energy).sqrt().max(1e-30)
    }

    #[test]
    #[ignore = "deterministic decoder alignment audit against the maintainer dev cache"]
    fn compare_symphonia_and_ffmpeg_decoder_alignment() {
        let root = Path::new("/Volumes/disco/splicerr");
        let db = root.join(".splicerr/library.db");
        if !db.exists() {
            return;
        }
        let conn =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT relative_audio_path FROM samples
                 WHERE audio_cached_at > 0 ORDER BY uuid LIMIT 40",
            )
            .unwrap();
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        let mut lags = Vec::new();
        let mut length_differences = Vec::new();
        let mut records = Vec::new();
        for relative in paths {
            let path = root.join(&relative);
            let symphonia = decode_mp3(&path).unwrap();
            let channels = symphonia.channels as usize;
            let symphonia_mono = symphonia
                .interleaved
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                .collect::<Vec<_>>();
            let output = Command::new("ffmpeg")
                .args(["-v", "error", "-i"])
                .arg(&path)
                .args(["-ac", "1", "-f", "f32le", "pipe:1"])
                .output()
                .unwrap();
            assert!(output.status.success());
            let ffmpeg = output
                .stdout
                .chunks_exact(4)
                .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
                .collect::<Vec<_>>();
            length_differences.push(symphonia_mono.len() as isize - ffmpeg.len() as isize);
            let best = (-1_200isize..=1_200)
                .max_by(|left, right| {
                    correlation_at_lag(&symphonia_mono, &ffmpeg, *left)
                        .total_cmp(&correlation_at_lag(&symphonia_mono, &ffmpeg, *right))
                })
                .unwrap();
            lags.push(best);
            records.push((
                relative,
                best,
                symphonia_mono.len() as isize - ffmpeg.len() as isize,
            ));
        }
        lags.sort_unstable();
        length_differences.sort_unstable();
        eprintln!(
            "decoder_alignment count={} lag_min={} lag_p50={} lag_max={} length_diff_min={} length_diff_p50={} length_diff_max={}",
            lags.len(),
            lags[0],
            lags[lags.len() / 2],
            lags[lags.len() - 1],
            length_differences[0],
            length_differences[length_differences.len() / 2],
            length_differences[length_differences.len() - 1],
        );
        for (path, lag, length_difference) in records {
            eprintln!("decoder_case lag={lag} length_diff={length_difference} path={path}");
        }
    }

    #[test]
    #[ignore = "deterministic declared-padding audit against the maintainer dev cache"]
    fn audit_declared_padding_samples() {
        let root = Path::new("/Volumes/disco/splicerr");
        let db = root.join(".splicerr/library.db");
        if !db.exists() {
            return;
        }
        let conn =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT relative_audio_path FROM samples
                 WHERE audio_cached_at > 0 ORDER BY uuid LIMIT 10000",
            )
            .unwrap();
        let paths = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap);
        let mut counts = std::collections::BTreeMap::<Option<u32>, usize>::new();
        let mut errors = 0usize;
        for relative in paths {
            let path = root.join(relative);
            let result = (|| -> Result<Option<u32>, String> {
                let file = File::open(&path).map_err(|error| error.to_string())?;
                let stream =
                    MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
                let mut hint = Hint::new();
                hint.with_extension("mp3");
                let probed = symphonia::default::get_probe()
                    .format(
                        &hint,
                        stream,
                        &FormatOptions::default(),
                        &MetadataOptions::default(),
                    )
                    .map_err(|error| error.to_string())?;
                Ok(probed
                    .format
                    .default_track()
                    .and_then(|track| track.codec_params.delay))
            })();
            match result {
                Ok(delay) => *counts.entry(delay).or_default() += 1,
                Err(_) => errors += 1,
            }
        }
        eprintln!("declared_padding_samples counts={counts:?} errors={errors}");
        assert!(
            errors <= 1,
            "unexpected unreadable cached MP3 count: {errors}"
        );
    }

    #[test]
    #[ignore = "deterministic loop feasibility audit against the maintainer dev cache"]
    fn audit_real_loop_grid_feasibility() {
        let root = Path::new("/Volumes/disco/splicerr");
        let db = root.join(".splicerr/library.db");
        if !db.exists() {
            return;
        }
        let conn =
            rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT relative_audio_path, duration_ms, bpm FROM samples
                 WHERE audio_cached_at > 0 AND asset_category_slug = 'loop'
                   AND bpm > 0
                   AND ABS(duration_ms * bpm / 60000.0 - ROUND(duration_ms * bpm / 60000.0)) <= 0.05
                 ORDER BY uuid LIMIT 1000",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap);
        let mut feasible = 0usize;
        let mut deficits = Vec::new();
        let mut insufficient_paths = Vec::new();
        let mut errors = 0usize;
        for (relative, duration_ms, bpm) in rows {
            let Ok(audio) = decode_mp3(&root.join(&relative)) else {
                errors += 1;
                continue;
            };
            let source_frames = audio.interleaved.len() / audio.channels as usize;
            let padding = calculated_padding_samples(audio.declared_padding);
            let beats = (duration_ms as f64 * bpm / 60_000.0).round();
            let target = (beats * 60.0 * audio.sample_rate as f64 / bpm).round() as usize;
            if padding + target <= source_frames {
                feasible += 1;
            } else {
                let deficit = (padding + target).saturating_sub(source_frames);
                deficits.push(deficit);
                insufficient_paths.push((relative, deficit, audio.declared_padding));
            }
        }
        deficits.sort_unstable();
        eprintln!(
            "loop_grid_feasibility feasible={} insufficient={} errors={} deficit_p50={} deficit_p95={} deficit_max={}",
            feasible,
            deficits.len(),
            errors,
            deficits.get(deficits.len().saturating_sub(1) / 2).copied().unwrap_or(0),
            deficits.get(deficits.len().saturating_sub(1) * 95 / 100).copied().unwrap_or(0),
            deficits.last().copied().unwrap_or(0),
        );
        for (path, deficit, declared_padding) in insufficient_paths {
            eprintln!(
                "loop_grid_insufficient deficit={deficit} declared_padding={declared_padding:?} path={path}"
            );
        }
        assert!(errors <= 1);
    }
}
