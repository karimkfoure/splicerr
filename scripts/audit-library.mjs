#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import { opendir, open, rm } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const args = parseArgs(process.argv.slice(2))
const samplesDir = path.resolve(args.samplesDir ?? "/Volumes/disco/splicerr")
const dbPath = path.join(samplesDir, ".splicerr", "library.db")
const sqliteBin = resolveSqliteBin()
const maxItems = args.maxItems == null ? null : Math.max(1, Number(args.maxItems))

let checked = 0
let missing = 0
let invalid = 0
const repairUuids = []
const query = `SELECT uuid, hex(relative_audio_path) FROM samples WHERE audio_cached_at>0 ORDER BY uuid${maxItems ? ` LIMIT ${maxItems}` : ""};`
const sqlite = spawn(sqliteBin, ["-readonly", "-separator", "|", dbPath, query], {
    stdio: ["ignore", "pipe", "inherit"],
})
const sqliteClosed = new Promise((resolve) => sqlite.on("close", resolve))
const lines = readline.createInterface({ input: sqlite.stdout, crlfDelay: Infinity })
for await (const line of lines) {
    const separator = line.indexOf("|")
    if (separator < 0) continue
    const uuid = line.slice(0, separator)
    const relativePath = Buffer.from(line.slice(separator + 1), "hex").toString("utf8")
    const result = await inspectMp3(path.join(samplesDir, relativePath))
    checked++
    if (result === "missing") missing++
    if (result === "invalid") invalid++
    if (args.repair && result !== "ok") {
        repairUuids.push(uuid)
        if (result === "invalid") await rm(path.join(samplesDir, relativePath), { force: true })
    }
    if (result !== "ok" && missing + invalid <= 20) {
        console.error(`${result} uuid=${uuid} path=${relativePath}`)
    }
    if (checked % 100_000 === 0) {
        console.log(`audio checked=${checked} missing=${missing} invalid=${invalid}`)
    }
}
const exitCode = await sqliteClosed
if (exitCode !== 0) process.exit(exitCode)
for (let i = 0; i < repairUuids.length; i += 500) {
    const values = repairUuids.slice(i, i + 500).map(sqlValue).join(",")
    sqliteExec(`UPDATE samples SET audio_cached_at=0, bitrate_kbps=NULL WHERE uuid IN (${values});`)
}

let orphaned = 0
let diskMp3s = 0
if (args.orphans) {
    let batch = []
    for await (const absolutePath of walkMp3s(samplesDir)) {
        diskMp3s++
        batch.push(path.relative(samplesDir, absolutePath))
        if (batch.length === 500) {
            orphaned += findOrphans(batch)
            batch = []
        }
    }
    if (batch.length) orphaned += findOrphans(batch)
}

console.log(`library audit audio=${checked} missing=${missing} invalid=${invalid} repaired=${repairUuids.length} diskMp3s=${diskMp3s} orphaned=${orphaned}`)
if ((missing || invalid) && !args.repair || orphaned) process.exitCode = 1

async function inspectMp3(filePath) {
    let file
    try {
        file = await open(filePath, "r")
        const bytes = Buffer.allocUnsafe(256 * 1024)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        for (let i = 0; i + 3 < bytesRead; i++) {
            if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue
            const version = (bytes[i + 1] >> 3) & 0x03
            const layer = (bytes[i + 1] >> 1) & 0x03
            const bitrate = bytes[i + 2] >> 4
            const sampleRate = (bytes[i + 2] >> 2) & 0x03
            if (version !== 1 && layer === 1 && bitrate > 0 && bitrate < 15 && sampleRate < 3) return "ok"
        }
        return "invalid"
    } catch (error) {
        return error?.code === "ENOENT" ? "missing" : "invalid"
    } finally {
        await file?.close()
    }
}

async function* walkMp3s(directory) {
    const entries = await opendir(directory)
    for await (const entry of entries) {
        if (entry.name === ".splicerr") continue
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) yield* walkMp3s(entryPath)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp3")) yield entryPath
    }
}

function findOrphans(paths) {
    const values = paths.map(sqlValue).join(",")
    const found = new Set(sqliteJson(`SELECT relative_audio_path FROM samples WHERE audio_cached_at>0 AND relative_audio_path IN (${values});`).map((row) => row.relative_audio_path))
    let count = 0
    for (const relativePath of paths) {
        if (found.has(relativePath)) continue
        count++
        if (count <= 20) console.error(`orphan path=${relativePath}`)
    }
    return count
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

function sqliteJson(statement) {
    const output = execFileSync(sqliteBin, ["-readonly", "-json", dbPath, statement], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim()
    return output ? JSON.parse(output) : []
}

function sqliteExec(statement) {
    execFileSync(sqliteBin, [dbPath, statement], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
}

function sqlValue(value) {
    return `'${String(value).replaceAll("'", "''")}'`
}
