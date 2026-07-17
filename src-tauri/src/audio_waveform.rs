use crate::audio_export::{decode_mp3, safe_relative_path};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant, UNIX_EPOCH};

const WAVEFORM_BINS: usize = 320;
const WAVEFORM_CACHE_VERSION: i64 = 1;
const WAVEFORM_CACHE_SCHEMA_VERSION: i64 = 1;
const WAVEFORM_CACHE_FILE: &str = "waveforms.db";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWaveformParams {
    pub samples_dir: String,
    pub relative_audio_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWaveformResult {
    pub bins: Vec<[u8; 3]>,
    pub decode_ms: f64,
    pub analyze_ms: f64,
    pub cache_hit: bool,
}

fn open_cache(samples_dir: &str) -> Result<Connection, String> {
    let cache_dir = PathBuf::from(samples_dir).join(".splicerr");
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let conn =
        Connection::open(cache_dir.join(WAVEFORM_CACHE_FILE)).map_err(|error| error.to_string())?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|error| error.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; BEGIN IMMEDIATE;")
        .map_err(|error| error.to_string())?;
    let schema_version = conn
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    if schema_version != WAVEFORM_CACHE_SCHEMA_VERSION {
        conn.execute_batch(
            "DROP TABLE IF EXISTS waveform_cache;
             CREATE TABLE waveform_cache (
                 cache_key INTEGER PRIMARY KEY,
                 version INTEGER NOT NULL,
                 source_size INTEGER NOT NULL,
                 source_mtime_ns INTEGER NOT NULL,
                 rgb BLOB NOT NULL
             );
             PRAGMA user_version=1;",
        )
        .map_err(|error| error.to_string())?;
    }
    conn.execute_batch("COMMIT;")
        .map_err(|error| error.to_string())?;
    Ok(conn)
}

fn cache_key(relative_audio_path: &str) -> i64 {
    // Stable FNV-1a instead of Rust's randomized/default hash. Source metadata
    // also has to match, making a theoretical collision still less plausible.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in relative_audio_path.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash as i64
}

fn source_signature(path: &PathBuf) -> Result<(i64, i64), String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    Ok((metadata.len() as i64, modified.as_nanos() as i64))
}

fn unpack_bins(rgb: Vec<u8>) -> Option<Vec<[u8; 3]>> {
    if rgb.len() != WAVEFORM_BINS * 3 {
        return None;
    }
    Some(
        rgb.chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect(),
    )
}

fn read_cache(
    conn: &Connection,
    key: i64,
    source_size: i64,
    source_mtime_ns: i64,
) -> Option<Vec<[u8; 3]>> {
    conn.query_row(
        "SELECT rgb FROM waveform_cache
         WHERE cache_key = ?1 AND version = ?2
           AND source_size = ?3 AND source_mtime_ns = ?4",
        params![key, WAVEFORM_CACHE_VERSION, source_size, source_mtime_ns],
        |row| row.get::<_, Vec<u8>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .and_then(unpack_bins)
}

fn write_cache(
    conn: &Connection,
    key: i64,
    source_size: i64,
    source_mtime_ns: i64,
    bins: &[[u8; 3]],
) {
    let rgb = bins.iter().flatten().copied().collect::<Vec<_>>();
    let _ = conn.execute(
        "INSERT INTO waveform_cache
             (cache_key, version, source_size, source_mtime_ns, rgb)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(cache_key) DO UPDATE SET
             version = excluded.version,
             source_size = excluded.source_size,
             source_mtime_ns = excluded.source_mtime_ns,
             rgb = excluded.rgb",
        params![
            key,
            WAVEFORM_CACHE_VERSION,
            source_size,
            source_mtime_ns,
            rgb
        ],
    );
}

fn spectral_bins(sample_rate: u32, channels: u16, samples: &[f32]) -> Vec<[u8; 3]> {
    let channels = channels as usize;
    let frames = samples.len() / channels;
    if frames == 0 {
        return vec![[0, 0, 0]; WAVEFORM_BINS];
    }

    let alpha_low = 1.0 - (-2.0 * std::f32::consts::PI * 180.0 / sample_rate as f32).exp();
    let alpha_mid = 1.0 - (-2.0 * std::f32::consts::PI * 2_500.0 / sample_rate as f32).exp();
    let mut low_pass = 0.0f32;
    let mut mid_pass = 0.0f32;
    let mut energy = vec![[0.0f64; 3]; WAVEFORM_BINS];
    let mut counts = vec![0usize; WAVEFORM_BINS];

    for frame in 0..frames {
        let base = frame * channels;
        let mono = samples[base..base + channels].iter().sum::<f32>() / channels as f32;
        low_pass += alpha_low * (mono - low_pass);
        mid_pass += alpha_mid * (mono - mid_pass);
        let bands = [low_pass, mid_pass - low_pass, mono - mid_pass];
        let bin = (frame * WAVEFORM_BINS / frames).min(WAVEFORM_BINS - 1);
        for band in 0..3 {
            energy[bin][band] += (bands[band] * bands[band]) as f64;
        }
        counts[bin] += 1;
    }

    let mut levels = vec![[0.0f32; 3]; WAVEFORM_BINS];
    let mut peak = 0.0f32;
    for bin in 0..WAVEFORM_BINS {
        for band in 0..3 {
            levels[bin][band] = (energy[bin][band] / counts[bin].max(1) as f64).sqrt() as f32;
            peak = peak.max(levels[bin][band]);
        }
    }
    let scale = peak.max(1e-9);
    levels
        .into_iter()
        .map(|bands| {
            let compress = |value: f32| ((value / scale).sqrt() * 255.0).clamp(0.0, 255.0) as u8;
            // Low frequencies are warm, mids green, highs blue: Traktor-style
            // frequency color without performing FFT work on the UI thread.
            [compress(bands[0]), compress(bands[1]), compress(bands[2])]
        })
        .collect()
}

fn local_waveform_sync(params: LocalWaveformParams) -> Result<LocalWaveformResult, String> {
    let relative = safe_relative_path(&params.relative_audio_path)?;
    let relative_key = relative.to_string_lossy().into_owned();
    let key = cache_key(&relative_key);
    let source = PathBuf::from(&params.samples_dir).join(&relative);
    let (source_size, source_mtime_ns) = source_signature(&source)?;
    let cache = open_cache(&params.samples_dir).ok();
    if let Some(bins) = cache
        .as_ref()
        .and_then(|conn| read_cache(conn, key, source_size, source_mtime_ns))
    {
        return Ok(LocalWaveformResult {
            bins,
            decode_ms: 0.0,
            analyze_ms: 0.0,
            cache_hit: true,
        });
    }
    let started = Instant::now();
    let audio = decode_mp3(&source)?;
    let decoded = Instant::now();
    let bins = spectral_bins(audio.sample_rate, audio.channels, &audio.interleaved);
    let analyzed = Instant::now();
    if let Some(conn) = cache.as_ref() {
        write_cache(conn, key, source_size, source_mtime_ns, &bins);
    }
    Ok(LocalWaveformResult {
        bins,
        decode_ms: (decoded - started).as_secs_f64() * 1_000.0,
        analyze_ms: (analyzed - decoded).as_secs_f64() * 1_000.0,
        cache_hit: false,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_audio_waveform(
    params: LocalWaveformParams,
) -> Result<LocalWaveformResult, String> {
    tauri::async_runtime::spawn_blocking(move || local_waveform_sync(params))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_fixed_compact_rgb_bins() {
        let rate = 44_100;
        let samples = (0..rate)
            .map(|index| (index as f32 * 2.0 * std::f32::consts::PI * 80.0 / rate as f32).sin())
            .collect::<Vec<_>>();
        let bins = spectral_bins(rate, 1, &samples);
        assert_eq!(bins.len(), WAVEFORM_BINS);
        assert!(bins.iter().any(|bin| bin[0] > bin[2]));
    }

    #[test]
    fn compact_cache_round_trips_and_rejects_stale_sources() {
        let temporary = tempfile::tempdir().unwrap();
        let conn = open_cache(temporary.path().to_str().unwrap()).unwrap();
        let bins = vec![[12, 34, 56]; WAVEFORM_BINS];
        let key = cache_key("Pack/sample.mp3");
        write_cache(&conn, key, 123, 456, &bins);
        assert_eq!(read_cache(&conn, key, 123, 456), Some(bins));
        assert_eq!(read_cache(&conn, key, 124, 456), None);
    }

    #[test]
    #[ignore = "deterministic benchmark against the maintainer dev cache"]
    fn real_dev_waveform_benchmark() {
        let root = "/Volumes/disco/splicerr";
        let db = PathBuf::from(root).join(".splicerr/library.db");
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
        drop(stmt);
        drop(conn);
        let cache = open_cache(root).unwrap();
        for path in &paths {
            cache
                .execute(
                    "DELETE FROM waveform_cache WHERE cache_key = ?1",
                    [cache_key(path)],
                )
                .unwrap();
        }
        drop(cache);
        let started = Instant::now();
        let mut decode = Vec::new();
        let mut analyze = Vec::new();
        for relative_audio_path in &paths {
            let result = local_waveform_sync(LocalWaveformParams {
                samples_dir: root.into(),
                relative_audio_path: relative_audio_path.clone(),
            })
            .unwrap();
            assert!(!result.cache_hit);
            decode.push(result.decode_ms);
            analyze.push(result.analyze_ms);
        }
        decode.sort_by(f64::total_cmp);
        analyze.sort_by(f64::total_cmp);
        let percentile = |values: &[f64], p: f64| values[((values.len() - 1) as f64 * p) as usize];
        eprintln!(
            "cold waveforms={} wall_ms={:.1} decode_p50={:.2} decode_p95={:.2} analyze_p50={:.2} analyze_p95={:.2}",
            decode.len(),
            started.elapsed().as_secs_f64() * 1_000.0,
            percentile(&decode, 0.50),
            percentile(&decode, 0.95),
            percentile(&analyze, 0.50),
            percentile(&analyze, 0.95),
        );
        let hot_started = Instant::now();
        for relative_audio_path in &paths {
            let result = local_waveform_sync(LocalWaveformParams {
                samples_dir: root.into(),
                relative_audio_path: relative_audio_path.clone(),
            })
            .unwrap();
            assert!(result.cache_hit);
        }
        eprintln!(
            "hot waveforms={} wall_ms={:.1} per_waveform_ms={:.3}",
            paths.len(),
            hot_started.elapsed().as_secs_f64() * 1_000.0,
            hot_started.elapsed().as_secs_f64() * 1_000.0 / paths.len() as f64,
        );
    }
}
