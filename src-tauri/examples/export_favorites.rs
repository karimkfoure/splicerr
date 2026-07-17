use splicerr_lib::audio_export::export_missing_favorite_wavs_sync;

fn main() {
    let samples_dir = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/Volumes/disco/splicerr".to_string());
    match export_missing_favorite_wavs_sync(&samples_dir) {
        Ok(summary) => {
            println!("{}", serde_json::to_string_pretty(&summary).unwrap());
            if summary.failed > 0 {
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("Favorite WAV export failed: {error}");
            std::process::exit(1);
        }
    }
}
