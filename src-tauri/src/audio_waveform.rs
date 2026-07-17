use crate::audio_export::{decode_mp3, safe_relative_path};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Instant;

const WAVEFORM_BINS: usize = 160;

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
    let source = PathBuf::from(params.samples_dir).join(relative);
    let started = Instant::now();
    let audio = decode_mp3(&source)?;
    let decoded = Instant::now();
    let bins = spectral_bins(audio.sample_rate, audio.channels, &audio.interleaved);
    let analyzed = Instant::now();
    Ok(LocalWaveformResult {
        bins,
        decode_ms: (decoded - started).as_secs_f64() * 1_000.0,
        analyze_ms: (analyzed - decoded).as_secs_f64() * 1_000.0,
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
        let started = Instant::now();
        let mut decode = Vec::new();
        let mut analyze = Vec::new();
        for relative_audio_path in paths {
            let result = local_waveform_sync(LocalWaveformParams {
                samples_dir: root.into(),
                relative_audio_path,
            })
            .unwrap();
            decode.push(result.decode_ms);
            analyze.push(result.analyze_ms);
        }
        decode.sort_by(f64::total_cmp);
        analyze.sort_by(f64::total_cmp);
        let percentile = |values: &[f64], p: f64| values[((values.len() - 1) as f64 * p) as usize];
        eprintln!(
            "waveforms={} wall_ms={:.1} decode_p50={:.2} decode_p95={:.2} analyze_p50={:.2} analyze_p95={:.2}",
            decode.len(),
            started.elapsed().as_secs_f64() * 1_000.0,
            percentile(&decode, 0.50),
            percentile(&decode, 0.95),
            percentile(&analyze, 0.50),
            percentile(&analyze, 0.95),
        );
    }
}
