import { execFileSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=")
    return [key, value]
}))
const root = args.samplesDir ?? "/Volumes/disco/splicerr"
const limit = Number(args.limit ?? 500)
const concurrency = Number(args.concurrency ?? 4)
const db = `${root}/.splicerr/library.db`
const sqlite = process.env.SQLITE3_BIN ?? "/opt/homebrew/opt/sqlite/bin/sqlite3"
const fine = args.fine === "true"
const candidates = fine
    ? [0, 529, 576, ...Array.from({ length: 151 }, (_, index) => 800 + index * 4)]
    : [0, 529, 576, 1_105, 1_152]

const sql = `SELECT rowid || char(9) || asset_category_slug || char(9) || duration_ms || char(9)
                    || COALESCE(bpm, 0) || char(9) || relative_audio_path || char(9) || waveform_relative_path
             FROM samples WHERE waveform_relative_path IS NOT NULL LIMIT ${limit}`
const rows = execFileSync(sqlite, ["-readonly", db, sql], { encoding: "utf8", maxBuffer: 10_000_000 })
    .trim().split("\n").map((line) => {
        const [rowid, category, durationMs, bpm, path, waveformPath] = line.split("\t")
        return { rowid: Number(rowid), category, durationMs: Number(durationMs), bpm: Number(bpm), path, waveformPath }
    })

function run(command, commandArgs) {
    return new Promise((resolve) => {
        const stdout = []
        const child = spawn(command, commandArgs)
        child.stdout.on("data", (chunk) => stdout.push(chunk))
        child.on("error", () => resolve(null))
        child.on("close", (code) => resolve(code ? null : Buffer.concat(stdout)))
    })
}

function floats(buffer) {
    if (!buffer) return null
    const values = new Float32Array(buffer.length / 4)
    for (let index = 0; index < values.length; index++) values[index] = buffer.readFloatLE(index * 4)
    return values
}

function envelope(values, start, length, bins, mode) {
    if (start < 0 || start + length > values.length || length < bins) return null
    const output = new Float64Array(bins)
    let maximum = 0
    for (let bin = 0; bin < bins; bin++) {
        const from = start + Math.floor(bin * length / bins)
        const to = start + Math.floor((bin + 1) * length / bins)
        let value = 0
        if (mode === "rms") {
            for (let index = from; index < to; index++) value += values[index] ** 2
            value = Math.sqrt(value / Math.max(1, to - from))
        } else {
            for (let index = from; index < to; index++) value = Math.max(value, Math.abs(values[index]))
        }
        output[bin] = value
        maximum = Math.max(maximum, value)
    }
    if (maximum) for (let index = 0; index < output.length; index++) output[index] /= maximum
    return output
}

function correlation(left, right) {
    let meanLeft = 0
    let meanRight = 0
    for (let index = 0; index < left.length; index++) {
        meanLeft += left[index]
        meanRight += right[index]
    }
    meanLeft /= left.length
    meanRight /= right.length
    let numerator = 0
    let leftEnergy = 0
    let rightEnergy = 0
    for (let index = 0; index < left.length; index++) {
        const a = left[index] - meanLeft
        const b = right[index] - meanRight
        numerator += a * b
        leftEnergy += a * a
        rightEnergy += b * b
    }
    return numerator / Math.sqrt(Math.max(leftEnergy * rightEnergy, 1e-30))
}

async function analyze(row) {
    const path = `${root}/${row.path}`
    const probe = await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path])
    const pcmBuffer = await run("ffmpeg", ["-v", "error", "-i", path, "-ac", "1", "-f", "f32le", "pipe:1"])
    if (!probe || !pcmBuffer) return { ...row, error: true }
    const sampleRate = Number(probe.toString().trim())
    const pcm = floats(pcmBuffer)
    const waveformBytes = readFileSync(`${root}/${row.waveformPath}`)
    const waveformText = waveformBytes[0] === 0x1f && waveformBytes[1] === 0x8b
        ? gunzipSync(waveformBytes).toString()
        : waveformBytes.toString()
    const reference = JSON.parse(waveformText)
    const rawBeats = row.bpm ? row.durationMs * row.bpm / 60_000 : 0
    const beats = Math.round(rawBeats)
    const gridConfident = row.category === "loop" && row.bpm && Math.abs(rawBeats - beats) <= 0.05
    const targetMs = gridConfident ? beats * 60_000 / row.bpm : row.durationMs
    const targetFrames = Math.round(targetMs * sampleRate / 1_000)
    const scores = {}
    for (const candidate of candidates) {
        const peak = envelope(pcm, candidate, targetFrames, reference.length, "peak")
        const rms = envelope(pcm, candidate, targetFrames, reference.length, "rms")
        scores[candidate] = peak && rms ? Math.max(correlation(peak, reference), correlation(rms, reference)) : null
    }
    const winner = Object.entries(scores).filter(([, score]) => score !== null).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
    const margin = winner === null ? null : scores[winner] - Object.entries(scores).filter(([key, score]) => key !== winner && score !== null).sort((a, b) => b[1] - a[1])[0]?.[1]
    return { ...row, sampleRate, targetFrames, decodedFrames: pcm.length, winner, margin, scores }
}

let cursor = 0
let completed = 0
const results = []
async function worker() {
    while (cursor < rows.length) {
        results.push(await analyze(rows[cursor++]))
        completed++
        if (completed % 50 === 0) console.error(`${completed}/${rows.length}`)
    }
}
console.error(`Analyzing ${rows.length} cached Splice waveforms, rowid ${rows[0]?.rowid}..${rows.at(-1)?.rowid}`)
await Promise.all(Array.from({ length: concurrency }, worker))

function countBy(rows, key) {
    const counts = new Map()
    for (const row of rows) counts.set(String(row[key]), (counts.get(String(row[key])) ?? 0) + 1)
    return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]))
}
function q(values, fraction) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
    return sorted[Math.floor((sorted.length - 1) * fraction)]
}
const decoded = results.filter((row) => !row.error)
const winnerCounts = countBy(decoded, "winner")
console.log(JSON.stringify({
    decoded: decoded.length,
    categories: countBy(decoded, "category"),
    winners: fine ? Object.fromEntries(Object.entries(winnerCounts).slice(0, 15)) : winnerCounts,
    winnersByCategory: Object.fromEntries(["loop", "oneshot"].map((category) => {
        const counts = countBy(decoded.filter((row) => row.category === category), "winner")
        return [category, fine ? Object.fromEntries(Object.entries(counts).slice(0, 15)) : counts]
    })),
    decisiveMarginOver001: decoded.filter((row) => row.margin > 0.01).length,
    margin: { p50: q(decoded.map((row) => row.margin), .5), p90: q(decoded.map((row) => row.margin), .9), p99: q(decoded.map((row) => row.margin), .99) },
    winnerOffset: { p10: q(decoded.map((row) => Number(row.winner)), .1), p25: q(decoded.map((row) => Number(row.winner)), .25), p50: q(decoded.map((row) => Number(row.winner)), .5), p75: q(decoded.map((row) => Number(row.winner)), .75), p90: q(decoded.map((row) => Number(row.winner)), .9) },
    medianCorrelationByCandidate: Object.fromEntries((fine ? [0, 529, 576, 1_104, 1_152] : candidates).map((candidate) => [candidate, q(decoded.map((row) => row.scores[candidate]), .5)])),
}, null, 2))
