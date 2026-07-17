import { execFileSync, spawn } from "node:child_process"

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, value = "true"] = arg.replace(/^--/, "").split("=")
    return [key, value]
}))
const root = args.samplesDir ?? "/Volumes/disco/splicerr"
const requested = Number(args.limit ?? 5_000)
const concurrency = Number(args.concurrency ?? 16)
const category = args.category ?? "loop"
if (!new Set(["loop", "oneshot"]).has(category)) throw new Error(`Unsupported category: ${category}`)
const db = `${root}/.splicerr/library.db`
const sqlite = process.env.SQLITE3_BIN ?? "/opt/homebrew/opt/sqlite/bin/sqlite3"
const candidates = [0, 529, 576, 1_105, 1_152]

function sampleRows() {
    const maxRowid = Number(execFileSync(sqlite, ["-readonly", db, "SELECT MAX(rowid) FROM samples"], { encoding: "utf8" }).trim())
    const blocks = Math.min(50, Math.ceil(requested / 100))
    const perBlock = Math.ceil(requested / blocks)
    const queries = Array.from({ length: blocks }, (_, index) => {
        const rowid = Math.floor(index * maxRowid / blocks)
        const bpmClause = category === "loop" ? "AND bpm BETWEEN 40 AND 240" : ""
        return `SELECT uuid || char(9) || relative_audio_path || char(9) || duration_ms || char(9) || COALESCE(bpm, 0)
                FROM samples WHERE rowid >= ${rowid} AND asset_category_slug = '${category}'
                  AND audio_cached_at > 0 ${bpmClause} LIMIT ${perBlock}`
    })
    return execFileSync(sqlite, ["-readonly", db, queries.join(";")], { encoding: "utf8", maxBuffer: 20_000_000 })
        .trim().split("\n").slice(0, requested).map((line) => {
            const [uuid, path, durationMs, bpm] = line.split("\t")
            return { uuid, path, durationMs: Number(durationMs), bpm: Number(bpm) }
        })
}

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

function meanSquare(values, from, to) {
    const start = Math.max(0, Math.floor(from))
    const end = Math.min(values.length, Math.ceil(to))
    if (end <= start) return 0
    let sum = 0
    for (let index = start; index < end; index++) sum += values[index] * values[index]
    return sum / (end - start)
}

function changePoint(head, sampleRate) {
    const radius = Math.max(32, Math.round(sampleRate * 0.0025))
    const min = Math.round(sampleRate * 0.006)
    const max = Math.min(head.length - radius, Math.round(sampleRate * 0.04))
    let best = { sample: null, jumpDb: -Infinity }
    for (let sample = min; sample <= max; sample += 4) {
        const before = meanSquare(head, sample - radius, sample)
        const after = meanSquare(head, sample, sample + radius)
        const jumpDb = 10 * Math.log10((after + 1e-20) / (before + 1e-20))
        if (jumpDb > best.jumpDb) best = { sample, jumpDb }
    }
    return best
}

function seamScore(head, tail, endTrim, startTrim) {
    const width = 256
    const tailEnd = tail.length - endTrim
    if (startTrim < 0 || startTrim + width > head.length || tailEnd - width < 0 || tailEnd > tail.length) return null
    let error = 0
    let energy = 0
    for (let index = 0; index < width; index++) {
        const left = head[startTrim + index]
        const right = tail[tailEnd - width + index]
        error += (left - right) ** 2
        energy += left ** 2 + right ** 2
    }
    return error / Math.max(energy, 1e-20)
}

async function analyze(row) {
    const path = `${root}/${row.path}`
    const probe = await run("ffprobe", [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels,bit_rate,duration",
        "-of", "csv=p=0", path,
    ])
    if (!probe) return { ...row, error: "probe" }
    // ffprobe's CSV writer emits fields in schema order, with duration before bit_rate.
    const [sampleRate, channels, durationSec, bitRate] = probe.toString().trim().split(",").map(Number)
    const edgeSeconds = Math.max(0.12, 4096 / sampleRate)
    const [headBuffer, tailBuffer] = await Promise.all([
        run("ffmpeg", ["-v", "error", "-i", path, "-t", String(edgeSeconds), "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"]),
        run("ffmpeg", ["-v", "error", "-sseof", String(-edgeSeconds), "-i", path, "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"]),
    ])
    const head = floats(headBuffer)
    const tail = floats(tailBuffer)
    if (!head || !tail) return { ...row, error: "decode" }

    const rawBeats = row.durationMs * row.bpm / 60_000
    const beats = Math.round(rawBeats)
    const gridConfident = category === "loop" && Math.abs(rawBeats - beats) <= 0.05 && beats > 0
    const targetMs = gridConfident ? beats * 60_000 / row.bpm : row.durationMs
    const decodedFrames = Math.round(durationSec * sampleRate)
    const targetFrames = Math.round(targetMs * sampleRate / 1_000)
    const excessFrames = decodedFrames - targetFrames
    const change = changePoint(head, sampleRate)
    const scores = Object.fromEntries(candidates.map((startTrim) => {
        const endTrim = excessFrames - startTrim
        return [startTrim, seamScore(head, tail, endTrim, startTrim)]
    }))
    const validScores = Object.entries(scores).filter(([, score]) => score !== null)
    const seamWinner = validScores.sort((a, b) => a[1] - b[1])[0]?.[0] ?? null
    return {
        ...row, sampleRate, channels, bitRate, family: `${sampleRate}/${channels}/${bitRate}`,
        durationSec, beats, gridConfident,
        targetFrames, decodedFrames, excessFrames, changeSample: change.sample,
        changeJumpDb: change.jumpDb, scores, seamWinner,
    }
}

const rows = sampleRows()
console.error(`Analyzing ${rows.length} deterministic ${category} samples with concurrency ${concurrency}`)
let cursor = 0
let completed = 0
const results = []
async function worker() {
    while (cursor < rows.length) {
        const row = rows[cursor++]
        results.push(await analyze(row))
        completed++
        if (completed % 500 === 0) console.error(`  ${completed}/${rows.length}`)
    }
}
await Promise.all(Array.from({ length: concurrency }, worker))

function quantile(rows, key, fraction) {
    const values = rows.map((row) => row[key]).filter(Number.isFinite).sort((a, b) => a - b)
    return values[Math.floor((values.length - 1) * fraction)]
}
function distribution(rows, key) {
    return Object.fromEntries([.01, .1, .25, .5, .75, .9, .99].map((fraction) => [
        `p${String(fraction * 100).padStart(2, "0")}`,
        Number(quantile(rows, key, fraction)?.toFixed(3)),
    ]))
}
function countBy(rows, key) {
    const counts = new Map()
    for (const row of rows) counts.set(String(row[key]), (counts.get(String(row[key])) ?? 0) + 1)
    return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]))
}

const decoded = results.filter((row) => !row.error)
const strongChange = decoded.filter((row) => row.changeJumpDb >= 20)
const strongNear1105 = strongChange.filter((row) => Math.abs(row.changeSample - 1_105) <= 128)
const gridded = decoded.filter((row) => row.gridConfident)
console.log(JSON.stringify({
    category, requested, decoded: decoded.length, errors: countBy(results.filter((row) => row.error), "error"),
    gridConfident: decoded.filter((row) => row.gridConfident).length,
    families: countBy(decoded, "sampleRate"),
    encodingFamilies: countBy(decoded, "family"),
    excessFrames: distribution(decoded, "excessFrames"),
    changeSampleAll: distribution(decoded, "changeSample"),
    strongChangeCount: strongChange.length,
    strongChangeNear1105: strongNear1105.length,
    changeSampleStrong: distribution(strongChange, "changeSample"),
    changeJumpDb: distribution(decoded, "changeJumpDb"),
    insufficientFor1105: decoded.filter((row) => row.excessFrames < 1_105).length,
    griddedExcessFrames: distribution(gridded, "excessFrames"),
    griddedInsufficientFor1105: gridded.filter((row) => row.excessFrames < 1_105).length,
    griddedNegativeExcess: gridded.filter((row) => row.excessFrames < 0).length,
    excessiveOver2304: decoded.filter((row) => row.excessFrames > 2_304).length,
    seamWinners: countBy(decoded, "seamWinner"),
    bySampleRate: Object.fromEntries([...new Set(decoded.map((row) => row.sampleRate))].map((rate) => {
        const family = decoded.filter((row) => row.sampleRate === rate)
        return [rate, {
            count: family.length,
            excessFrames: distribution(family, "excessFrames"),
            changeSampleStrong: distribution(family.filter((row) => row.changeJumpDb >= 20), "changeSample"),
            insufficientFor1105: family.filter((row) => row.excessFrames < 1_105).length,
        }]
    })),
}, null, 2))
