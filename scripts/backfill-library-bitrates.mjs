#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"

const args = parseArgs(process.argv.slice(2))
const samplesDir = path.resolve(args.samplesDir ?? "/Volumes/disco/splicerr")
const dbPath = path.join(samplesDir, ".splicerr", "library.db")
const batchSize = Math.max(1, Number(args.batchSize ?? 10_000))
const concurrency = Math.max(1, Number(args.concurrency ?? 128))
const maxItems = args.maxItems == null ? Infinity : Math.max(1, Number(args.maxItems))
const recalculate = Boolean(args.recalculate)
const sqliteBin = resolveSqliteBin()
const checkpointTask = "bitrate_mp3_header_v1"

assertLibrary()
sqlite(`CREATE TABLE IF NOT EXISTS library_maintenance (
    task TEXT PRIMARY KEY,
    cursor TEXT,
    completed INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);`)
if (recalculate && args.restart) {
    sqlite(`DELETE FROM library_maintenance WHERE task=${sql(checkpointTask)};`)
}
const checkpoint = recalculate
    ? sqliteJson(`SELECT cursor, completed FROM library_maintenance WHERE task=${sql(checkpointTask)};`)[0]
    : null
if (checkpoint?.completed) {
    console.log("bitrate recalculate already complete; use --restart to run it again")
    process.exit(0)
}
let cursor = checkpoint?.cursor ?? null
let processed = 0
let updated = 0
let missing = 0
let exhausted = false

while (processed < maxItems) {
    const limit = Math.min(batchSize, maxItems - processed)
    const pendingClause = recalculate ? "" : "AND bitrate_kbps IS NULL"
    const cursorClause = cursor == null ? "" : `AND uuid > ${sql(cursor)}`
    const rows = sqliteJson(`
        SELECT uuid, relative_audio_path
        FROM samples
        WHERE audio_cached_at > 0 ${pendingClause} ${cursorClause}
        ORDER BY uuid LIMIT ${limit};`)
    if (rows.length === 0) {
        exhausted = true
        break
    }

    cursor = rows.at(-1).uuid
    processed += rows.length
    const updates = []
    let batchMissing = 0
    await mapConcurrent(rows, concurrency, async (row) => {
        const audioPath = path.join(samplesDir, row.relative_audio_path)
        try {
            const bitrate = await readMp3Bitrate(audioPath)
            if (bitrate == null) throw new Error("no MPEG audio frame")
            updates.push(`UPDATE samples SET bitrate_kbps=${bitrate} WHERE uuid=${sql(row.uuid)};`)
        } catch {
            missing++
            batchMissing++
            if (recalculate) {
                updates.push(`UPDATE samples SET bitrate_kbps=NULL WHERE uuid=${sql(row.uuid)};`)
            }
        }
    })
    const checkpointSql = recalculate
        ? `INSERT INTO library_maintenance(task,cursor,completed,updated_at)
           VALUES(${sql(checkpointTask)},${sql(cursor)},0,${Date.now()})
           ON CONFLICT(task) DO UPDATE SET cursor=excluded.cursor,completed=0,updated_at=excluded.updated_at;`
        : ""
    if (updates.length || checkpointSql) {
        sqlite(`BEGIN IMMEDIATE;${updates.join("")}${checkpointSql}COMMIT;`)
    }
    updated += rows.length - batchMissing
    console.log(`bitrate processed=${processed} updated=${updated} missing=${missing}`)
}

if (recalculate && exhausted) {
    sqlite(`UPDATE library_maintenance SET completed=1,updated_at=${Date.now()} WHERE task=${sql(checkpointTask)};`)
}

console.log(`bitrate complete processed=${processed} updated=${updated} missing=${missing}`)

async function readMp3Bitrate(filePath) {
    const file = await open(filePath, "r")
    try {
        const buffer = Buffer.allocUnsafe(256 * 1024)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        for (let i = 0; i + 3 < bytesRead; i++) {
            const b1 = buffer[i + 1]
            if (buffer[i] !== 0xff || (b1 & 0xe0) !== 0xe0) continue
            const version = (b1 >> 3) & 0x03
            const layer = (b1 >> 1) & 0x03
            const bitrateIndex = buffer[i + 2] >> 4
            const sampleRateIndex = (buffer[i + 2] >> 2) & 0x03
            if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue
            const table = version === 3
                ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
                : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
            const sampleRates = version === 3
                ? [44_100, 48_000, 32_000]
                : version === 2
                  ? [22_050, 24_000, 16_000]
                  : [11_025, 12_000, 8_000]
            const bitrate = table[bitrateIndex]
            const padding = (buffer[i + 2] >> 1) & 1
            const coefficient = version === 3 ? 144_000 : 72_000
            const frameLength = Math.floor((coefficient * bitrate) / sampleRates[sampleRateIndex]) + padding
            const next = i + frameLength
            if (next + 1 < bytesRead && (buffer[next] !== 0xff || (buffer[next + 1] & 0xe0) !== 0xe0)) continue
            return bitrate
        }
        return null
    } finally {
        await file.close()
    }
}

async function mapConcurrent(items, workers, work) {
    let index = 0
    await Promise.all(Array.from({ length: Math.min(workers, items.length) }, async () => {
        while (index < items.length) await work(items[index++])
    }))
}

function parseArgs(argv) {
    const out = {}
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith("--")) continue
        const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        const next = argv[i + 1]
        out[key] = next == null || next.startsWith("--") ? true : argv[++i]
    }
    return out
}

function resolveSqliteBin() {
    for (const candidate of [process.env.SQLITE3_BIN, "/opt/homebrew/opt/sqlite/bin/sqlite3", "/usr/local/opt/sqlite/bin/sqlite3", "sqlite3"].filter(Boolean)) {
        try {
            const options = execFileSync(candidate, [":memory:", "PRAGMA compile_options;"], { encoding: "utf8" })
            if (!/CCCRYPT|HAS_CODEC|CODEC=/i.test(options)) return candidate
        } catch {}
    }
    throw new Error("A standard sqlite3 binary is required")
}

function assertLibrary() {
    if (!existsSync(dbPath)) throw new Error(`Library DB not found: ${dbPath}`)
    if (args.check && sqlite("PRAGMA quick_check;") !== "ok") throw new Error("Library DB quick_check failed")
    const columns = sqliteJson("PRAGMA table_info(samples);")
    if (!columns.some((column) => column.name === "bitrate_kbps")) {
        throw new Error("Open the app once to apply library schema v10")
    }
}

function sql(value) {
    return `'${String(value).replaceAll("'", "''")}'`
}

function sqlite(statement) {
    return execFileSync(sqliteBin, [dbPath], {
        input: `.timeout 30000\n${statement}`,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    }).trim()
}

function sqliteJson(statement) {
    const output = execFileSync(sqliteBin, ["-json", dbPath], {
        input: `.timeout 30000\n${statement}`,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    }).trim()
    return output ? JSON.parse(output) : []
}
