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

pub const EXPORT_POLICY_VERSION: u32 = 1;
const MP3_ENCODER_DELAY_SAMPLES: usize = 576;
const MP3_DECODER_DELAY_SAMPLES: usize = 529;
pub const DEFAULT_MP3_START_TRIM_SAMPLES: usize =
    MP3_ENCODER_DELAY_SAMPLES + MP3_DECODER_DELAY_SAMPLES;
const LOOP_GRID_TOLERANCE_BEATS: f64 = 0.05;
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
    pub target_beats: Option<i64>,
    pub grid_confident: bool,
    pub policy_version: u32,
    pub correction_enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteExportSummary {
    pub exported: usize,
    pub already_exported: usize,
    pub failed: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, PartialEq)]
struct ExportPlan {
    start: usize,
    end: usize,
    target_beats: Option<i64>,
    grid_confident: bool,
}

fn safe_relative_path(relative: &str) -> Result<PathBuf, String> {
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

fn export_plan(
    total_frames: usize,
    sample_rate: u32,
    category: &str,
    duration_ms: i64,
    bpm: Option<f64>,
    correction_enabled: bool,
) -> ExportPlan {
    if !correction_enabled {
        return ExportPlan {
            start: 0,
            end: total_frames,
            target_beats: None,
            grid_confident: false,
        };
    }
    let default_start = DEFAULT_MP3_START_TRIM_SAMPLES.min(total_frames);
    if category != "loop" {
        return ExportPlan {
            start: default_start,
            end: total_frames,
            target_beats: None,
            grid_confident: false,
        };
    }

    let Some(bpm) = bpm.filter(|value| value.is_finite() && *value > 0.0) else {
        return ExportPlan {
            start: default_start,
            end: total_frames,
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
            target_beats: None,
            grid_confident: false,
        };
    }

    let target_frames = ((beats as f64 * 60.0 * sample_rate as f64) / bpm).round() as usize;
    if target_frames > total_frames {
        return ExportPlan {
            start: default_start,
            end: total_frames,
            target_beats: Some(beats),
            grid_confident: false,
        };
    }

    // Preserve exact musical length even for the small exception cohort whose
    // MP3 does not contain the full 1105-sample leading allowance.
    let start = default_start.min(total_frames - target_frames);
    ExportPlan {
        start,
        end: start + target_frames,
        target_beats: Some(beats),
        grid_confident: true,
    }
}

fn decode_mp3(path: &Path) -> Result<(u32, u16, Vec<f32>), String> {
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
    Ok((sample_rate, channels, interleaved))
}

fn write_wav_atomic(
    destination: &Path,
    sample_rate: u32,
    channels: u16,
    interleaved: &[f32],
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
    let (sample_rate, channels, decoded) = decode_mp3(&source)?;
    let channel_count = channels as usize;
    let source_frames = decoded.len() / channel_count;
    let plan = export_plan(
        source_frames,
        sample_rate,
        &params.asset_category_slug,
        params.duration_ms,
        params.bpm,
        params.correction_enabled,
    );
    let samples = &decoded[plan.start * channel_count..plan.end * channel_count];
    write_wav_atomic(&output, sample_rate, channels, samples)?;
    Ok(ExportSampleResult {
        absolute_path: output.to_string_lossy().into_owned(),
        relative_path: output_relative.to_string_lossy().into_owned(),
        sample_rate,
        channels,
        source_frames,
        output_frames: plan.end - plan.start,
        start_trim_samples: plan.start,
        end_trim_samples: source_frames - plan.end,
        target_beats: plan.target_beats,
        grid_confident: plan.grid_confident,
        policy_version: EXPORT_POLICY_VERSION,
        correction_enabled: params.correction_enabled,
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
        already_exported: 0,
        failed: 0,
        failures: Vec::new(),
    };
    for row in rows {
        let params = row.map_err(|error| error.to_string())?;
        let relative = safe_relative_path(&params.relative_audio_path)?;
        let destination = PathBuf::from(samples_dir).join(exported_relative_path(&relative));
        if destination.exists() {
            summary.already_exported += 1;
            continue;
        }
        match export_sample_wav_sync(params) {
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
            export_plan(20_000, 44_100, "oneshot", 400, None, true),
            ExportPlan {
                start: 1_105,
                end: 20_000,
                target_beats: None,
                grid_confident: false,
            }
        );
    }

    #[test]
    fn loop_uses_exact_bpm_grid_length() {
        let plan = export_plan(354_816, 44_100, "loop", 8_000, Some(120.0), true);
        assert_eq!(plan.start, 1_105);
        assert_eq!(plan.end - plan.start, 352_800);
        assert_eq!(plan.target_beats, Some(16));
        assert!(plan.grid_confident);
    }

    #[test]
    fn short_excess_preserves_exact_loop_length() {
        let plan = export_plan(353_200, 44_100, "loop", 8_000, Some(120.0), true);
        assert_eq!(plan.start, 400);
        assert_eq!(plan.end - plan.start, 352_800);
        assert!(plan.grid_confident);
    }

    #[test]
    fn off_grid_loop_only_applies_leading_trim() {
        let plan = export_plan(360_000, 44_100, "loop", 8_123, Some(120.0), true);
        assert_eq!(plan.start, 1_105);
        assert_eq!(plan.end, 360_000);
        assert!(!plan.grid_confident);
    }

    #[test]
    fn diagnostic_bypass_preserves_all_decoded_frames() {
        assert_eq!(
            export_plan(20_000, 48_000, "loop", 2_000, Some(120.0), false),
            ExportPlan {
                start: 0,
                end: 20_000,
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

        let make_params = || ExportSampleParams {
            samples_dir: temporary.path().to_string_lossy().into_owned(),
            relative_audio_path: row.0.clone(),
            asset_category_slug: "loop".into(),
            duration_ms: row.1,
            bpm: Some(row.2),
            correction_enabled: true,
        };
        let first = export_sample_wav_sync(make_params()).unwrap();
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
        let second = export_sample_wav_sync(make_params()).unwrap();
        assert_eq!(second.output_frames, first.output_frames);
        assert_eq!(std::fs::read(&output).unwrap(), expected);
    }
}
