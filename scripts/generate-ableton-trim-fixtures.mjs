import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=")
    return [key, value]
}))
const root = args.samplesDir ?? "/Volumes/disco/splicerr"
const outputDir = args.outputDir ?? "/tmp/splicerr-ableton-validation"
const db = `${root}/.splicerr/library.db`
const sqlite = process.env.SQLITE3_BIN ?? "/opt/homebrew/opt/sqlite/bin/sqlite3"
const bpms = [120, 124, 140]
mkdirSync(outputDir, { recursive: true })

for (const bpm of bpms) {
    const sql = `SELECT relative_audio_path || char(9) || duration_ms
                 FROM samples INDEXED BY idx_samples_category
                 WHERE asset_category_slug = 'loop' AND bpm = ${bpm} AND audio_cached_at > 0
                   AND ABS(duration_ms * bpm / 60000.0 - 16.0) < 0.01 LIMIT 1`
    const [relativePath, durationText] = execFileSync(sqlite, ["-readonly", "-cmd", ".timeout 30000", db, sql], { encoding: "utf8" }).trim().split("\t")
    if (!relativePath) throw new Error(`No deterministic 16-beat fixture found for ${bpm} BPM`)
    const input = `${root}/${relativePath}`
    const sampleRate = Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", input], { encoding: "utf8" }).trim())
    const targetFrames = Math.round(16 * 60 * sampleRate / bpm)
    const variants = [
        ["raw", 0, null],
        ["12ms", Math.round(sampleRate * 0.012), targetFrames],
        ["1105", 1_105, targetFrames],
    ]
    for (const [label, start, length] of variants) {
        const output = `${outputDir}/${bpm}BPM_16beats_${sampleRate}Hz_${label}.wav`
        const filter = length === null
            ? "anull"
            : `atrim=start_sample=${start}:end_sample=${start + length},asetpts=PTS-STARTPTS`
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", input, "-af", filter, "-c:a", "pcm_s24le", output])
        const frames = Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts", "-of", "csv=p=0", output], { encoding: "utf8" }).trim())
        console.log(JSON.stringify({ bpm, label, sampleRate, sourceDurationMs: Number(durationText), targetFrames: length, outputFrames: frames, output }))
    }
}
