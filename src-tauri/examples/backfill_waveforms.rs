use splicerr_lib::audio_waveform::{
    backfill_local_waveforms, WaveformBackfillOptions, WaveformBackfillSummary,
};

fn main() {
    let options = match parse_args() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    eprintln!(
        "waveform backfill samples_dir={} rebuild={} concurrency={} batch_size={} limit={}",
        options.samples_dir,
        options.rebuild,
        options.concurrency,
        options.batch_size,
        options
            .limit
            .map(|value| value.to_string())
            .unwrap_or_else(|| "all".into())
    );
    match backfill_local_waveforms(options, print_progress) {
        Ok(summary) => {
            println!("{}", serde_json::to_string_pretty(&summary).unwrap());
            if summary.failed > 0 {
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("Waveform backfill failed: {error}");
            std::process::exit(1);
        }
    }
}

fn print_progress(summary: &WaveformBackfillSummary) {
    eprintln!(
        "processed={} generated={} cached={} failed={} elapsed_s={:.1}",
        summary.processed,
        summary.generated,
        summary.already_cached,
        summary.failed,
        summary.elapsed_ms / 1_000.0
    );
}

fn parse_args() -> Result<WaveformBackfillOptions, String> {
    let mut samples_dir = "/Volumes/disco/splicerr".to_string();
    let mut rebuild = false;
    let mut limit = None;
    let mut concurrency = 4_usize;
    let mut batch_size = 500_usize;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--samples-dir" => samples_dir = required_value(&mut args, "--samples-dir")?,
            "--rebuild" => rebuild = true,
            "--limit" => limit = Some(parse_usize(&mut args, "--limit")?),
            "--concurrency" => concurrency = parse_usize(&mut args, "--concurrency")?,
            "--batch-size" => batch_size = parse_usize(&mut args, "--batch-size")?,
            "--help" | "-h" => {
                println!(
                    "Usage: pnpm backfill:waveforms -- [--samples-dir PATH] [--rebuild] \
                     [--limit N] [--concurrency N] [--batch-size N]"
                );
                std::process::exit(0);
            }
            _ => return Err(format!("Unknown argument: {arg}")),
        }
    }
    if concurrency == 0 || batch_size == 0 || limit == Some(0) {
        return Err("Numeric arguments must be greater than zero".into());
    }
    Ok(WaveformBackfillOptions {
        samples_dir,
        rebuild,
        limit,
        concurrency,
        batch_size,
    })
}

fn required_value(args: &mut impl Iterator<Item = String>, option: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("Missing value for {option}"))
}

fn parse_usize(args: &mut impl Iterator<Item = String>, option: &str) -> Result<usize, String> {
    required_value(args, option)?
        .parse::<usize>()
        .map_err(|_| format!("Invalid number for {option}"))
}
