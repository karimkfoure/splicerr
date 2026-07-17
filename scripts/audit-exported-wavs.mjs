import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=")
    return [key, value]
}))
const root = args.samplesDir ?? "/Volumes/disco/splicerr"
const limit = Math.max(1, Number(args.limit ?? 10_000))
const db = join(root, ".splicerr/library.db")
const sqlite = process.env.SQLITE3_BIN ?? "/opt/homebrew/opt/sqlite/bin/sqlite3"

const sql = `SELECT relative_audio_path || char(9) || asset_category_slug || char(9)
                    || duration_ms || char(9) || COALESCE(bpm, 0)
             FROM samples WHERE favorite = 1 AND audio_cached_at > 0
             ORDER BY uuid LIMIT ${limit}`
const text = execFileSync(sqlite, ["-readonly", "-cmd", ".timeout 30000", db, sql], {
    encoding: "utf8",
    maxBuffer: 10_000_000,
}).trim()
const rows = text ? text.split("\n").map((line) => {
    const [relative, category, durationMs, bpm] = line.split("\t")
    return { relative, category, durationMs: Number(durationMs), bpm: Number(bpm) }
}) : []

function probe(path) {
    return JSON.parse(execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels,bits_per_sample,duration_ts,start_time",
        "-of", "json", path,
    ], { encoding: "utf8" })).streams[0]
}

function decodeHead(path, startSample = 0) {
    const filter = startSample ? `atrim=start_sample=${startSample},asetpts=PTS-STARTPTS` : "anull"
    const result = spawnSync("ffmpeg", [
        "-v", "error", "-i", path, "-af", filter, "-t", "0.4",
        "-ac", "1", "-f", "f32le", "pipe:1",
    ], { maxBuffer: 10_000_000 })
    if (result.status !== 0) throw new Error(result.stderr.toString())
    const values = new Float32Array(result.stdout.length / 4)
    for (let index = 0; index < values.length; index++) {
        values[index] = result.stdout.readFloatLE(index * 4)
    }
    return values
}

function correlation(left, right) {
    const length = Math.min(left.length, right.length)
    let dot = 0
    let leftEnergy = 0
    let rightEnergy = 0
    let squaredError = 0
    for (let index = 0; index < length; index++) {
        dot += left[index] * right[index]
        leftEnergy += left[index] ** 2
        rightEnergy += right[index] ** 2
        squaredError += (left[index] - right[index]) ** 2
    }
    return {
        correlation: dot / Math.sqrt(Math.max(leftEnergy * rightEnergy, 1e-30)),
        relativeError: squaredError / Math.max(rightEnergy, 1e-30),
    }
}

const failures = []
const results = []
for (const row of rows) {
    const mp3 = join(root, row.relative)
    const wav = join(root, "exported", row.relative.replace(/\.mp3$/i, ".wav"))
    try {
        if (!existsSync(mp3)) throw new Error("source MP3 missing")
        if (!existsSync(wav)) throw new Error("exported WAV missing")
        if (dirname(wav) !== dirname(join(root, "exported", row.relative))) {
            throw new Error("export tree mismatch")
        }
        const mp3Info = probe(mp3)
        const wavInfo = probe(wav)
        const sampleRate = Number(wavInfo.sample_rate)
        if (Number(wavInfo.bits_per_sample) !== 24) throw new Error("WAV is not 24-bit")
        if (sampleRate !== Number(mp3Info.sample_rate)) throw new Error("sample-rate changed")
        if (Number(wavInfo.channels) !== Number(mp3Info.channels)) throw new Error("channels changed")

        const rawBeats = row.bpm ? row.durationMs * row.bpm / 60_000 : 0
        const beats = Math.round(rawBeats)
        const gridExpected = row.category === "loop" && beats > 0 && Math.abs(rawBeats - beats) <= 0.05
        const targetFrames = gridExpected
            ? Math.round(beats * 60 * sampleRate / row.bpm)
            : null
        if (targetFrames !== null && Number(wavInfo.duration_ts) !== targetFrames) {
            throw new Error(`grid length ${wavInfo.duration_ts} != ${targetFrames}`)
        }

        // FFmpeg applies declared Skip Samples itself. Untagged Splice MP3s
        // require the audited 1105-sample fallback to match the Rust export.
        const ffmpegAlreadySkipped = Number(mp3Info.start_time) > 0
        const reference = decodeHead(mp3, ffmpegAlreadySkipped ? 0 : 1_105)
        const exported = decodeHead(wav)
        const alignment = correlation(exported, reference)
        if (alignment.correlation < 0.999 || alignment.relativeError > 0.001) {
            throw new Error(
                `PCM mismatch corr=${alignment.correlation.toFixed(6)} relerr=${alignment.relativeError.toExponential(3)}`
            )
        }
        results.push({ ...row, wav, targetFrames, ...alignment })
    } catch (error) {
        failures.push({ relative: row.relative, error: error.message })
    }
}

const correlations = results.map((result) => result.correlation).sort((a, b) => a - b)
console.log(JSON.stringify({
    audited: rows.length,
    passed: results.length,
    failed: failures.length,
    exactGridLoops: results.filter((result) => result.targetFrames !== null).length,
    correlationMin: correlations[0] ?? null,
    correlationMedian: correlations[Math.floor(correlations.length / 2)] ?? null,
    failures,
}, null, 2))
if (failures.length) process.exitCode = 1
