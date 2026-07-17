#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const args = parseArgs(process.argv.slice(2))
const samplesDir = path.resolve(args.samplesDir ?? "/Volumes/disco/splicerr")
const dbPath = path.join(samplesDir, ".splicerr", "library.db")
const batchSize = Math.max(1, Number(args.batchSize ?? 100))
const concurrency = Math.max(1, Number(args.concurrency ?? 8))
const maxItems = args.maxItems == null ? Infinity : Math.max(1, Number(args.maxItems))
const sqliteBin = resolveSqliteBin()

assertLibrary()
let cursor = ""
let processed = 0
let saved = 0
let reused = 0
let failed = 0

while (processed < maxItems) {
    const limit = Math.min(batchSize, maxItems - processed)
    const rows = sqliteJson(`
        SELECT uuid, cover_source_url, cover_relative_path
        FROM packs
        WHERE cover_cached_at = 0 AND cover_source_url IS NOT NULL
          AND cover_relative_path IS NOT NULL AND uuid > ${sql(cursor)}
        ORDER BY uuid LIMIT ${limit};`)
    if (rows.length === 0) break
    cursor = rows.at(-1).uuid
    processed += rows.length

    const successes = []
    await mapConcurrent(rows, concurrency, async (row) => {
        const destination = path.join(samplesDir, row.cover_relative_path)
        if (existsSync(destination)) {
            reused++
            successes.push(row.uuid)
            return
        }
        const temporary = `${destination}.part-${process.pid}`
        try {
            const response = await fetch(row.cover_source_url, { signal: AbortSignal.timeout(10_000) })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const bytes = Buffer.from(await response.arrayBuffer())
            if (bytes.length < 100) throw new Error("empty cover")
            mkdirSync(path.dirname(destination), { recursive: true })
            writeFileSync(temporary, bytes)
            renameSync(temporary, destination)
            saved++
            successes.push(row.uuid)
        } catch (error) {
            rmSync(temporary, { force: true })
            failed++
            console.error(`cover failed uuid=${row.uuid} ${error.message}`)
        }
    })
    if (successes.length) {
        const now = Date.now()
        sqlite(`BEGIN IMMEDIATE;UPDATE packs SET cover_cached_at=${now} WHERE uuid IN (${successes.map(sql).join(",")});COMMIT;`)
    }
    console.log(`covers processed=${processed} saved=${saved} reused=${reused} failed=${failed}`)
}

console.log(`covers complete processed=${processed} saved=${saved} reused=${reused} failed=${failed}`)

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
    const columns = sqliteJson("PRAGMA table_info(packs);")
    if (!columns.some((column) => column.name === "cover_cached_at")) {
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
