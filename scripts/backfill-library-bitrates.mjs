#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"

const args = parseArgs(process.argv.slice(2))
const samplesDir = path.resolve(args.samplesDir ?? "/Volumes/disco/splicerr")
const dbPath = path.join(samplesDir, ".splicerr", "library.db")
const batchSize = Math.max(1, Number(args.batchSize ?? 10_000))
const concurrency = Math.max(1, Number(args.concurrency ?? 128))
const maxItems = args.maxItems == null ? Infinity : Math.max(1, Number(args.maxItems))
const sqliteBin = resolveSqliteBin()

assertLibrary()
let cursor = ""
let processed = 0
let updated = 0
let missing = 0

while (processed < maxItems) {
    const limit = Math.min(batchSize, maxItems - processed)
    const rows = sqliteJson(`
        SELECT uuid, relative_audio_path, duration_ms
        FROM samples
        WHERE audio_cached_at > 0 AND bitrate_kbps IS NULL
          AND uuid > ${sql(cursor)}
        ORDER BY uuid LIMIT ${limit};`)
    if (rows.length === 0) break

    cursor = rows.at(-1).uuid
    processed += rows.length
    const updates = []
    await mapConcurrent(rows, concurrency, async (row) => {
        const audioPath = path.join(samplesDir, row.relative_audio_path)
        if (row.duration_ms <= 0) {
            missing++
            return
        }
        try {
            const info = await stat(audioPath)
            const bitrate = Math.round((info.size * 8) / row.duration_ms)
            updates.push(`UPDATE samples SET bitrate_kbps=${bitrate} WHERE uuid=${sql(row.uuid)};`)
        } catch {
            missing++
        }
    })
    if (updates.length) sqlite(`BEGIN IMMEDIATE;${updates.join("")}COMMIT;`)
    updated += updates.length
    console.log(`bitrate processed=${processed} updated=${updated} missing=${missing}`)
}

console.log(`bitrate complete processed=${processed} updated=${updated} missing=${missing}`)

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
        out[key] = argv[i + 1]?.startsWith("--") ? true : argv[++i]
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
