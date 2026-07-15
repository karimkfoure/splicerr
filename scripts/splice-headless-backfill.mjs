#!/usr/bin/env node
import { chromium } from "playwright"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"

const SPLICE_GRAPHQL_URL = "https://surfaces-graphql.splice.com/graphql"
const DEFAULT_SAMPLES_DIR = "/Volumes/disco/splicerr"

const DEFAULT_SAMPLE_PAGE_SIZE = 100
const PACK_PAGE_SIZE = 50
const DOWNLOAD_TIMEOUT_MS = 4000
const DOWNLOAD_RETRY_TIMEOUT_MS = 2000
const DOWNLOAD_MAX_ATTEMPTS = 2

const args = parseArgs(process.argv.slice(2))
const samplesDir = args.samplesDir ?? DEFAULT_SAMPLES_DIR
const dbPath = path.join(samplesDir, ".splicerr", "library.db")
const batchSize = Number(args.batchSize ?? 1000)
const samplePageSize = Math.min(100, Math.max(1, Number(args.pageSize ?? DEFAULT_SAMPLE_PAGE_SIZE)))
const concurrency = Math.max(1, Number(args.concurrency ?? 16))
const maxBatches = args.maxBatches == null ? Infinity : Number(args.maxBatches)
const maxPacks = args.maxPacks == null ? Infinity : Number(args.maxPacks)
const mode = args.mode ?? "random"
const randomSeed = String(args.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))

if (!existsSync(samplesDir)) {
    die(`Samples dir does not exist: ${samplesDir}`)
}
if (!existsSync(dbPath)) {
    die(`Library DB does not exist: ${dbPath}`)
}

const sqliteBin = resolveSqliteBin()

const now = () => Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(line) {
    console.log(`[${new Date().toISOString()}] ${line}`)
}

function die(message) {
    console.error(message)
    process.exit(1)
}

function parseArgs(argv) {
    const out = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith("--")) continue
        const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        const next = argv[i + 1]
        if (!next || next.startsWith("--")) {
            out[key] = true
        } else {
            out[key] = next
            i++
        }
    }
    return out
}

function deriveRandomSeed(seed, streamIndex) {
    let hash = BigInt(streamIndex + 1)
    for (const char of seed) {
        hash = (hash * 131n + BigInt(char.charCodeAt(0))) % BigInt(Number.MAX_SAFE_INTEGER)
    }
    return String(hash || 1n)
}

function resolveSqliteBin() {
    const candidates = [
        process.env.SQLITE3_BIN,
        "/opt/homebrew/opt/sqlite/bin/sqlite3",
        "/usr/local/opt/sqlite/bin/sqlite3",
        "sqlite3",
    ].filter(Boolean)
    const rejected = []

    for (const candidate of [...new Set(candidates)]) {
        try {
            const options = execFileSync(candidate, [":memory:", "PRAGMA compile_options;"], {
                encoding: "utf8",
            })
            if (/CCCRYPT|HAS_CODEC|CODEC=/i.test(options)) {
                rejected.push(`${candidate} (Apple codec build)`)
                continue
            }
            return candidate
        } catch (error) {
            if (error?.code !== "ENOENT") rejected.push(`${candidate} (${error.message})`)
        }
    }

    throw new Error(
        `No standard sqlite3 binary found. Install Homebrew sqlite or set SQLITE3_BIN. Rejected: ${rejected.join(", ") || "none"}`
    )
}

function sqlValue(value) {
    if (value == null) return "NULL"
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL"
    return `'${String(value).replaceAll("'", "''")}'`
}

function sqlite(sql) {
    return execFileSync(sqliteBin, [dbPath, `PRAGMA busy_timeout=30000;\n${sql}`], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 64,
    }).trim()
}

function sqliteRows(sql) {
    const out = execFileSync(sqliteBin, [dbPath], {
        input: `.mode tabs\nPRAGMA busy_timeout=30000;\n${sql}`,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 64,
    }).trim()
    if (!out) return []
    return out
        .split("\n")
        .filter((line) => line.trim() !== "30000")
        .map((line) => line.split("\t"))
}

function sqliteExec(sql) {
    execFileSync(sqliteBin, [dbPath], {
        input: `PRAGMA busy_timeout=30000;\n${sql}`,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 64,
    })
}

function sqliteExecAsync(sql) {
    return new Promise((resolve, reject) => {
        const child = spawn(sqliteBin, [dbPath], { stdio: ["pipe", "ignore", "pipe"] })
        let stderr = ""
        child.stderr.setEncoding("utf8")
        child.stderr.on("data", (chunk) => {
            if (stderr.length < 64 * 1024) stderr += chunk
        })
        child.on("error", reject)
        child.on("close", (code) => {
            if (code === 0) resolve()
            else reject(new Error(`sqlite3 exited ${code}: ${stderr.trim()}`))
        })
        child.stdin.end(`PRAGMA busy_timeout=30000;\n${sql}`)
    })
}

function assertDatabaseIntegrity() {
    const rows = sqliteRows("PRAGMA quick_check;")
    const result = rows.map((row) => row.join("\t")).filter(Boolean)
    if (result.length !== 1 || result[0] !== "ok") {
        throw new Error(
            `SQLite integrity check failed; refusing to download or write:\n${result.slice(0, 20).join("\n") || "no result"}`
        )
    }
    log("database integrity check ok")
}

function ensureMirrorTables() {
    sqliteExec(`
CREATE TABLE IF NOT EXISTS mirror_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  sort TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  total_packs INTEGER NOT NULL DEFAULT 0,
  completed_packs INTEGER NOT NULL DEFAULT 0,
  failed_packs INTEGER NOT NULL DEFAULT 0,
  total_samples INTEGER NOT NULL DEFAULT 0,
  cached_samples INTEGER NOT NULL DEFAULT 0,
  session_saved INTEGER NOT NULL DEFAULT 0,
  current_pack_uuid TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mirror_pack_queue (
  job_id INTEGER NOT NULL,
  pack_uuid TEXT NOT NULL,
  pack_name TEXT NOT NULL,
  rank INTEGER NOT NULL,
  status TEXT NOT NULL,
  cursor TEXT,
  listable_total INTEGER,
  cached_count INTEGER NOT NULL DEFAULT 0,
  listed_count INTEGER NOT NULL DEFAULT 0,
  saved_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, pack_uuid)
);
CREATE INDEX IF NOT EXISTS idx_mirror_pack_queue_status_rank
  ON mirror_pack_queue(job_id, status, rank);
CREATE TABLE IF NOT EXISTS mirror_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  pack_uuid TEXT,
  sample_uuid TEXT,
  error TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`)
}

function getJobId() {
    const rows = sqliteRows(
        "SELECT id FROM mirror_jobs WHERE status IN ('running','paused','idle') ORDER BY updated_at DESC LIMIT 1;"
    )
    if (rows[0]?.[0]) {
        const id = Number(rows[0][0])
        sqliteExec(`
UPDATE mirror_pack_queue
SET status='queued', updated_at=${now()}
WHERE job_id=${id} AND status IN ('listing','downloading');
UPDATE mirror_jobs SET status='running', current_pack_uuid=NULL, updated_at=${now()} WHERE id=${id};
`)
        return id
    }
    const ts = now()
    sqliteExec(`
INSERT INTO mirror_jobs (status, sort, filters_json, created_at, updated_at)
VALUES ('running', 'pack_popularity', '{"tags":[]}', ${ts}, ${ts});
`)
    return Number(sqliteRows("SELECT MAX(id) FROM mirror_jobs;")[0][0])
}

function countCached(packUuid) {
    return Number(
        sqliteRows(
            `SELECT COUNT(*) FROM samples WHERE pack_uuid=${sqlValue(packUuid)} AND audio_cached_at > 0;`
        )[0]?.[0] ?? 0
    )
}

function summarize(jobId) {
    sqliteExec(`
UPDATE mirror_jobs
SET total_packs=(SELECT COUNT(*) FROM mirror_pack_queue WHERE job_id=${jobId}),
    completed_packs=(SELECT COUNT(*) FROM mirror_pack_queue WHERE job_id=${jobId} AND status='complete'),
    failed_packs=(SELECT COUNT(*) FROM mirror_pack_queue WHERE job_id=${jobId} AND status='failed'),
    total_samples=COALESCE((SELECT SUM(COALESCE(listable_total,0)) FROM mirror_pack_queue WHERE job_id=${jobId}),0),
    cached_samples=COALESCE((SELECT SUM(cached_count) FROM mirror_pack_queue WHERE job_id=${jobId}),0),
    updated_at=${now()}
WHERE id=${jobId};
`)
    const rows = sqliteRows(`
SELECT status,total_packs,completed_packs,failed_packs,total_samples,cached_samples,session_saved
FROM mirror_jobs WHERE id=${jobId};
`)
    if (rows[0]) {
        const [status, packs, complete, failed, totalSamples, cached, saved] = rows[0]
        log(
            `summary status=${status} packs=${complete}/${packs} failed=${failed} samples=${cached}/${totalSamples} sessionSaved=${saved}`
        )
    }
}

function refreshQueuedProgress(jobId) {
    const ts = now()
    sqliteExec(`
UPDATE mirror_pack_queue
SET
  cached_count = (
    SELECT COUNT(*) FROM samples
    WHERE samples.pack_uuid = mirror_pack_queue.pack_uuid
      AND samples.audio_cached_at > 0
  ),
  listable_total = COALESCE(
    (SELECT packs.listable_sample_total
     FROM packs
     WHERE packs.uuid = mirror_pack_queue.pack_uuid
       AND packs.listable_sample_total > 0),
    listable_total
  ),
  updated_at = ${ts}
WHERE job_id = ${jobId}
  AND status IN ('queued','paused','listing','downloading');

UPDATE mirror_pack_queue
SET status = 'complete',
    cursor = NULL,
    last_error = NULL,
    updated_at = ${ts}
WHERE job_id = ${jobId}
  AND status IN ('queued','paused','listing','downloading')
  AND listable_total IS NOT NULL
  AND listable_total > 0
  AND cached_count >= listable_total;
`)
}

function nextPack(jobId) {
    const row = sqliteRows(`
SELECT pack_uuid, pack_name, cursor, COALESCE(listable_total,''), listed_count, saved_count, attempts
FROM mirror_pack_queue
WHERE job_id=${jobId} AND status IN ('queued','paused')
ORDER BY
  CASE
    WHEN listable_total IS NOT NULL AND listable_total > 0 AND cached_count < listable_total THEN 0
    WHEN cached_count = 0 THEN 1
    ELSE 2
  END,
  CASE
    WHEN listable_total IS NOT NULL AND listable_total > 0 THEN cached_count * 1.0 / listable_total
    ELSE 0
  END ASC,
  rank ASC
LIMIT 1;
`)[0]
    if (!row) return null
    const [uuid, name, cursor, total, listed, saved, attempts] = row
    const cached = countCached(uuid)
    sqliteExec(`
UPDATE mirror_pack_queue
SET status='listing', attempts=attempts+1, cached_count=${cached}, last_error=NULL, updated_at=${now()}
WHERE job_id=${jobId} AND pack_uuid=${sqlValue(uuid)};
UPDATE mirror_jobs
SET status='running', current_pack_uuid=${sqlValue(uuid)}, updated_at=${now()}
WHERE id=${jobId};
`)
    return {
        uuid,
        name,
        cursor: cursor || null,
        total: total ? Number(total) : null,
        listed: Number(listed),
        saved: Number(saved),
        attempts: Number(attempts),
    }
}

function markComplete(jobId, pack, total) {
    const cached = countCached(pack.uuid)
    sqliteExec(`
UPDATE mirror_pack_queue
SET status='complete', cursor=NULL, listable_total=COALESCE(${sqlValue(total)}, listable_total),
    cached_count=${cached}, last_error=NULL, updated_at=${now()}
WHERE job_id=${jobId} AND pack_uuid=${sqlValue(pack.uuid)};
UPDATE packs
SET listable_sample_total=COALESCE(${sqlValue(total)}, listable_sample_total)
WHERE uuid=${sqlValue(pack.uuid)};
UPDATE mirror_jobs SET current_pack_uuid=NULL, updated_at=${now()} WHERE id=${jobId};
`)
}

function markFailed(jobId, pack, error) {
    const detail = String(error?.message ?? error).slice(0, 1000)
    sqliteExec(`
UPDATE mirror_pack_queue
SET status='failed', last_error=${sqlValue(detail)}, updated_at=${now()}
WHERE job_id=${jobId} AND pack_uuid=${sqlValue(pack.uuid)};
INSERT INTO mirror_failures (job_id, pack_uuid, error, created_at)
VALUES (${jobId}, ${sqlValue(pack.uuid)}, ${sqlValue(detail)}, ${now()});
UPDATE mirror_jobs
SET current_pack_uuid=NULL, last_error=${sqlValue(detail)}, updated_at=${now()}
WHERE id=${jobId};
`)
}

function checkpoint(jobId, pack, cursor, total, listedDelta, savedDelta, failedDelta) {
    const cached = countCached(pack.uuid)
    sqliteExec(`
UPDATE mirror_pack_queue
SET status='queued',
    cursor=${sqlValue(cursor)},
    listable_total=COALESCE(${sqlValue(total)}, listable_total),
    cached_count=${cached},
    listed_count=listed_count+${Math.max(0, listedDelta)},
    saved_count=saved_count+${Math.max(0, savedDelta)},
    failed_count=failed_count+${Math.max(0, failedDelta)},
    updated_at=${now()}
WHERE job_id=${jobId} AND pack_uuid=${sqlValue(pack.uuid)};
UPDATE mirror_jobs
SET session_saved=session_saved+${Math.max(0, savedDelta)}, updated_at=${now()}
WHERE id=${jobId};
`)
}

function existingUuids(uuids) {
    if (!uuids.length) return new Set()
    const values = uuids.map(sqlValue).join(",")
    const rows = sqliteRows(
        `SELECT uuid FROM samples WHERE audio_cached_at > 0 AND uuid IN (${values});`
    )
    return new Set(rows.map((r) => r[0]))
}

async function loadCachedUuids() {
    const child = spawn(
        sqliteBin,
        [dbPath, "SELECT uuid FROM samples WHERE audio_cached_at > 0;"],
        { stdio: ["ignore", "pipe", "pipe"] }
    )
    const uuids = new Set()
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
        if (stderr.length < 64 * 1024) stderr += chunk
    })
    const closed = new Promise((resolve, reject) => {
        child.on("error", reject)
        child.on("close", (code) => {
            if (code === 0) resolve()
            else reject(new Error(`sqlite3 UUID cache exited ${code}: ${stderr.trim()}`))
        })
    })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    for await (const uuid of lines) {
        if (uuid) uuids.add(uuid)
    }
    await closed
    return uuids
}

function suffixedRelativePath(uuid, rel, fullUuid = false) {
    const ext = path.extname(rel)
    const base = rel.slice(0, rel.length - ext.length)
    return `${base}_${fullUuid ? uuid : uuid.slice(0, 8)}${ext}`
}

function allocateRelativePaths(samples, owners = new Map()) {
    const candidates = samples.map((sample) => {
        const base = sampleRelativePath(sample)
        return {
            sample,
            base,
            short: suffixedRelativePath(sample.uuid, base),
        }
    })
    const paths = [...new Set(candidates.flatMap(({ base, short }) => [base, short]))]
    if (paths.length) {
        const rows = sqliteRows(
            `SELECT relative_audio_path, uuid FROM samples WHERE relative_audio_path IN (${paths.map(sqlValue).join(",")});`
        )
        for (const [relativePath, uuid] of rows) {
            if (!owners.has(relativePath)) owners.set(relativePath, uuid)
        }
    }

    const allocated = new Map()
    for (const { sample, base, short } of candidates) {
        let relativePath = base
        if (owners.has(relativePath) && owners.get(relativePath) !== sample.uuid) {
            relativePath = short
        }
        if (owners.has(relativePath) && owners.get(relativePath) !== sample.uuid) {
            relativePath = suffixedRelativePath(sample.uuid, base, true)
        }
        owners.set(relativePath, sample.uuid)
        allocated.set(sample.uuid, relativePath)
    }
    return allocated
}

async function upsertSamples(samples, relativePaths) {
    if (!samples.length) return
    const statements = []
    const materializable = samples.filter((sample) => {
        const pack = sample.parents?.items?.[0]
        return Boolean(pack?.uuid && pack?.name)
    })
    if (!materializable.length) return
    const sampleUuids = materializable.map((sample) => sqlValue(sample.uuid)).join(",")
    for (const sample of materializable) {
        const pack = sample.parents?.items?.[0]
        const relativePath = relativePaths.get(sample.uuid)
        const coverRel = `${sanitizePathSegment(pack.name)}/cover.jpg`
        const coverUrl = resolvePackCoverUrl(pack)
        const audioCachedAt = now()
        const key = sample.key ? String(sample.key).toUpperCase() : null
        const chordType = sample.chord_type ? String(sample.chord_type).toLowerCase() : null
        const displayName = String(sample.name).split("/").pop()
        statements.push(`
INSERT INTO packs (uuid, name, cover_relative_path, cover_source_url)
VALUES (${sqlValue(pack.uuid)}, ${sqlValue(pack.name)}, ${sqlValue(coverRel)}, ${sqlValue(coverUrl)})
ON CONFLICT(uuid) DO UPDATE SET
  name=excluded.name,
  cover_relative_path=COALESCE(excluded.cover_relative_path, packs.cover_relative_path),
  cover_source_url=COALESCE(excluded.cover_source_url, packs.cover_source_url);

INSERT INTO samples (
  uuid, pack_uuid, name, display_name, relative_audio_path,
  duration_ms, bpm, key, chord_type, asset_category_slug,
  favorite, audio_cached_at, ingested_at, pack_name, waveform_relative_path
) VALUES (
  ${sqlValue(sample.uuid)}, ${sqlValue(pack.uuid)}, ${sqlValue(sample.name)},
  ${sqlValue(displayName)}, ${sqlValue(relativePath)}, ${Number(sample.duration ?? 0)},
  ${sample.bpm == null ? "NULL" : Number(sample.bpm)}, ${sqlValue(key)},
  ${sqlValue(chordType)}, ${sqlValue(sample.asset_category_slug ?? "oneshot")},
  0, ${audioCachedAt}, ${audioCachedAt}, ${sqlValue(pack.name)}, NULL
)
ON CONFLICT(uuid) DO UPDATE SET
  pack_uuid=excluded.pack_uuid,
  name=excluded.name,
  display_name=excluded.display_name,
  relative_audio_path=excluded.relative_audio_path,
  duration_ms=excluded.duration_ms,
  bpm=excluded.bpm,
  key=excluded.key,
  chord_type=excluded.chord_type,
  asset_category_slug=excluded.asset_category_slug,
  audio_cached_at=excluded.audio_cached_at,
  pack_name=excluded.pack_name;

INSERT INTO samples_fts (sample_uuid, name, display_name, pack_name)
VALUES (${sqlValue(sample.uuid)}, ${sqlValue(sample.name)}, ${sqlValue(displayName)}, ${sqlValue(pack.name)});
`)
        for (const tag of sample.tags ?? []) {
            statements.push(`
INSERT INTO tags (uuid, label)
VALUES (${sqlValue(tag.uuid)}, ${sqlValue(tag.label)})
ON CONFLICT(uuid) DO UPDATE SET label=excluded.label;
INSERT OR IGNORE INTO sample_tags (sample_uuid, tag_uuid)
VALUES (${sqlValue(sample.uuid)}, ${sqlValue(tag.uuid)});
`)
        }
    }
    await sqliteExecAsync(`BEGIN;
DELETE FROM sample_tags WHERE sample_uuid IN (${sampleUuids});
DELETE FROM samples_fts WHERE sample_uuid IN (${sampleUuids});
${statements.join("\n")}
COMMIT;`)
}

function resolvePackCoverUrl(pack) {
    for (const f of pack.files ?? []) {
        if (
            (f.asset_file_type_slug === "cover_image" ||
                f.asset_file_type_slug === "generated_cover_image") &&
            /^https?:\/\//.test(f.url ?? "")
        ) {
            return f.url
        }
    }
    return null
}

const AUDIO_EXT = /\.(wav|mp3|aiff|aif|flac|m4a)$/i
const CONTENT_ROOT =
    /^(one_?shots?|onshots|loops?|loopp?|midi|fx|sfx|samples?|audio|drums?|perc|oneshots|drum_?hits?)$/i

function sampleRelativePath(sample) {
    const packName = sample.parents.items[0].name
    const packDir = sanitizePathSegment(packName)
    const { dir, leaf } = resolveSpliceInnerPath(sample)
    const trimmedDir = processInnerDir(dir, packName)
    const fileName = `${leaf.replace(AUDIO_EXT, "")}.mp3`
    return sanitizePathSegment(trimmedDir ? `${packDir}/${trimmedDir}/${fileName}` : `${packDir}/${fileName}`)
}

function sanitizePathSegment(value) {
    return String(value).replace(/[^a-zA-Z0-9#_\-\.\/]/g, "_")
}

function resolveSpliceInnerPath(sample) {
    const displayDir = sample.display_file_path?.replace(/^\/+|\/+$/g, "")
    if (displayDir) {
        return {
            dir: displayDir,
            leaf: sample.display_name?.trim() || spliceSampleLeafName(sample.name),
        }
    }
    const filePath = sample.files?.[0]?.path?.replace(/^\/+/, "")
    if (filePath?.includes("/")) {
        return {
            dir: spliceSampleDirname(filePath),
            leaf: spliceSampleLeafName(filePath),
        }
    }
    return {
        dir: spliceSampleDirname(sample.name),
        leaf: spliceSampleLeafName(sample.name),
    }
}

function spliceSampleDirname(name) {
    const idx = String(name).lastIndexOf("/")
    return idx === -1 ? "" : String(name).slice(0, idx)
}

function spliceSampleLeafName(name) {
    const idx = String(name).lastIndexOf("/")
    return idx === -1 ? String(name) : String(name).slice(idx + 1)
}

function normalizePathToken(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]/g, "")
}

function segmentOverlapsPack(segment, packName) {
    const a = normalizePathToken(segment)
    const b = normalizePathToken(packName)
    if (!a || !b) return false
    if (a === b) return true
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    return short.length >= 4 && long.includes(short)
}

function processInnerDir(dirPath, packName) {
    let parts = String(dirPath).split("/").filter(Boolean)
    if (parts.length >= 2 && (CONTENT_ROOT.test(parts[1]) || CONTENT_ROOT.test(normalizePathToken(parts[1])))) {
        parts = parts.slice(1)
    }
    while (parts.length > 0 && segmentOverlapsPack(parts[0], packName)) {
        parts.shift()
    }
    return parts
        .map((part) => {
            if (!segmentOverlapsPack(part, packName)) return part
            const dashParts = part.split(/_-_/).filter(Boolean)
            const tail = dashParts[dashParts.length - 1]
            return tail && !segmentOverlapsPack(tail, packName) ? tail : part
        })
        .join("/")
}

function descramble(data) {
    if (data.length < 28) throw new Error("scrambled sample too short")
    let dataSize = 0
    for (let i = 0; i < 8; i++) dataSize += data[2 + i] * 256 ** i
    const encodingBlock = data.subarray(10, 28)
    const audio = Buffer.from(data.subarray(28))
    let passIndex = descramblePass(0, audio, encodingBlock, dataSize) + dataSize
    descramblePass(passIndex, audio, encodingBlock, passIndex + dataSize)
    return audio
}

function descramblePass(startIndex, data, encodingBlock, dataSize) {
    for (
        let encodingIndex = 0;
        startIndex < dataSize && startIndex < data.length;
        startIndex++, encodingIndex = (encodingIndex + 1) % encodingBlock.length
    ) {
        data[startIndex] ^= encodingBlock[encodingIndex]
    }
    return startIndex
}

function createTaskLimiter(limit) {
    let active = 0
    const queue = []

    const drain = () => {
        while (active < limit && queue.length) {
            const { task, resolve, reject } = queue.shift()
            active++
            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    active--
                    drain()
                })
        }
    }

    return (task) => new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject })
        drain()
    })
}

async function fetchScrambledSample(url) {
    let attempts = 0
    let timeouts = 0
    let lastError

    while (attempts < DOWNLOAD_MAX_ATTEMPTS) {
        attempts++
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(
                    attempts === 1 ? DOWNLOAD_TIMEOUT_MS : DOWNLOAD_RETRY_TIMEOUT_MS
                ),
            })
            if (!response.ok) {
                const error = new Error(`download HTTP ${response.status}`)
                error.retryable = response.status === 408 || response.status === 429 || response.status >= 500
                throw error
            }
            return {
                scrambled: Buffer.from(await response.arrayBuffer()),
                attempts,
                timeouts,
            }
        } catch (error) {
            lastError = error
            if (error?.name === "TimeoutError" || error?.name === "AbortError") timeouts++
            if (attempts >= DOWNLOAD_MAX_ATTEMPTS || error?.retryable === false) break
            await sleep(100)
        }
    }

    lastError.downloadAttempts = attempts
    lastError.downloadTimeouts = timeouts
    throw lastError
}

async function downloadSampleFile(sample, relativePath) {
    const startedAt = now()
    let attempts = 0
    let timeouts = 0
    try {
        const abs = path.join(samplesDir, relativePath)
        if (!existsSync(abs)) {
            const url = sample.files?.[0]?.url
            if (!url) throw new Error("missing audio url")
            const fetched = await fetchScrambledSample(url)
            attempts = fetched.attempts
            timeouts = fetched.timeouts
            const mp3 = descramble(fetched.scrambled)
            mkdirSync(path.dirname(abs), { recursive: true })
            writeFileSync(abs, mp3)
            return { sample, durationMs: now() - startedAt, reused: false, attempts, timeouts }
        }
        return { sample, durationMs: now() - startedAt, reused: true, attempts, timeouts }
    } catch (error) {
        return {
            sample,
            error,
            durationMs: now() - startedAt,
            reused: false,
            attempts: error?.downloadAttempts ?? attempts,
            timeouts: error?.downloadTimeouts ?? timeouts,
        }
    }
}

function percentile(sorted, value) {
    if (!sorted.length) return 0
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)
    return sorted[index]
}

function summarizeDownloadResults(results) {
    const network = results.filter((result) => !result.reused)
    const durations = network.map((result) => result.durationMs).sort((a, b) => a - b)
    const failedDurations = network
        .filter((result) => result.error)
        .map((result) => result.durationMs)
    return {
        networkCount: network.length,
        reusedCount: results.length - network.length,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        p99Ms: percentile(durations, 0.99),
        maxMs: durations.at(-1) ?? 0,
        failedMaxMs: Math.max(0, ...failedDurations),
        retriedCount: network.filter((result) => result.attempts > 1).length,
        timeoutCount: network.reduce((sum, result) => sum + result.timeouts, 0),
    }
}

async function downloadSampleFiles(samples) {
    const downloadStartedAt = now()
    const relativePaths = allocateRelativePaths(samples)
    const limitTask = createTaskLimiter(concurrency)
    const results = await Promise.all(samples.map((sample) =>
        limitTask(() => downloadSampleFile(sample, relativePaths.get(sample.uuid)))
    ))
    const saved = results.filter((result) => !result.error).map((result) => result.sample)
    const failed = results.filter((result) => result.error)
    return {
        samples: saved,
        saved: saved.length,
        failed,
        relativePaths,
        downloadMs: now() - downloadStartedAt,
    }
}

async function persistDownloaded(result) {
    const startedAt = now()
    if (result.samples.length) await upsertSamples(result.samples, result.relativePaths)
    return now() - startedAt
}

async function downloadSamples(samples) {
    const result = await downloadSampleFiles(samples)
    const dbMs = await persistDownloaded(result)
    return { ...result, dbMs }
}

async function setupGraphqlPages(count) {
    const browser = await chromium.launch({ headless: true })
    const pages = await Promise.all(
        Array.from({ length: count }, async () => {
            const page = await browser.newPage()
            await page.goto(SPLICE_GRAPHQL_URL, { waitUntil: "domcontentloaded" })
            return page
        })
    )
    return { browser, pages }
}

async function queryGraphql(page, body) {
    return await page.evaluate(async ({ body }) => {
        const response = await fetch("/graphql", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "apollo-require-preflight": "true",
                "x-apollo-operation-name": body.operationName,
            },
            body: JSON.stringify(body),
        })
        const text = await response.text()
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
        return JSON.parse(text)
    }, { body })
}

const SamplesSearchCursor = {
    operationName: "SamplesSearchCursor",
    query: `query SamplesSearchCursor($parent_asset_uuid: GUID, $cursor: String, $limit: Int = 50, $sort: AssetSortType = popularity, $order: SortOrder = DESC, $random_seed: String, $parent_asset_type: AssetTypeSlug) {
  assetsSearch(
    filter: {legacy: true, published: true, asset_type_slug: sample}
    children: {parent_asset_uuid: $parent_asset_uuid}
    pagination: {cursor: $cursor, limit: $limit}
    sort: {sort: $sort, order: $order, random_seed: $random_seed}
    legacy: {parent_asset_type: $parent_asset_type}
  ) {
    items {
      ... on IAsset {
        asset_type_slug
        asset_prices { amount currency __typename }
        uuid
        name
        tags { uuid label __typename }
        files { uuid name hash path asset_file_type_slug url __typename }
        __typename
      }
      ... on IAssetChild {
        parents(filter: {asset_type_slug: pack}) {
          items {
            ... on PackAsset {
              permalink_slug
              permalink_base_url
              uuid
              name
              files { uuid path asset_file_type_slug url __typename }
              child_asset_counts { type count __typename }
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      ... on SampleAsset {
        bpm
        chord_type
        key
        duration
        uuid
        name
        display_file_path
        display_name
        asset_category_slug
        __typename
      }
      __typename
    }
    response_metadata { records next previous __typename }
    __typename
  }
}`,
}

const PacksSearch = {
    operationName: "PacksSearch",
    query: `query PacksSearch($page: Int, $limit: Int = 50) {
  assetsSearch(
    filter: {legacy: true, published: true, asset_type_slug: pack}
    pagination: {page: $page, limit: $limit}
    sort: {sort: popularity, order: DESC}
  ) {
    items {
      ... on PackAsset {
        uuid
        name
        permalink_slug
        permalink_base_url
        files { uuid path asset_file_type_slug url __typename }
        child_asset_counts { type count __typename }
        __typename
      }
      __typename
    }
    pagination_metadata { currentPage totalPages __typename }
    response_metadata { records __typename }
    __typename
  }
}`,
}

async function catalogSomePacks(page, jobId) {
    const totalPacks = Number(sqliteRows(`SELECT total_packs FROM mirror_jobs WHERE id=${jobId};`)[0]?.[0] ?? 0)
    const nextPage = Math.floor(totalPacks / PACK_PAGE_SIZE) + 1
    log(`no queued packs; cataloging packs page ${nextPage}`)
    const json = await queryGraphql(page, {
        ...PacksSearch,
        variables: { page: nextPage, limit: PACK_PAGE_SIZE },
    })
    const result = json?.data?.assetsSearch
    if (!result?.items?.length) return false
    const rankOffset = (result.pagination_metadata.currentPage - 1) * PACK_PAGE_SIZE
    const ts = now()
    const statements = result.items.map((pack, index) => {
        const total = pack.child_asset_counts?.find((row) => row.type === "sample")?.count ?? null
        const cached = countCached(pack.uuid)
        const status = total && cached >= total ? "complete" : "queued"
        return `
INSERT INTO packs (uuid, name, listable_sample_total)
VALUES (${sqlValue(pack.uuid)}, ${sqlValue(pack.name)}, ${sqlValue(total)})
ON CONFLICT(uuid) DO UPDATE SET
  name=excluded.name,
  listable_sample_total=COALESCE(excluded.listable_sample_total, packs.listable_sample_total);
INSERT INTO mirror_pack_queue (job_id, pack_uuid, pack_name, rank, status, listable_total, cached_count, updated_at)
VALUES (${jobId}, ${sqlValue(pack.uuid)}, ${sqlValue(pack.name)}, ${rankOffset + index + 1}, ${sqlValue(status)}, ${sqlValue(total)}, ${cached}, ${ts})
ON CONFLICT(job_id, pack_uuid) DO NOTHING;
`
    })
    sqliteExec(`BEGIN;\n${statements.join("\n")}\nCOMMIT;`)
    summarize(jobId)
    return true
}

async function processPack(page, jobId, pack) {
    log(`pack start ${pack.name} (${pack.uuid}) cursor=${pack.cursor ?? "first"}`)
    let cursor = pack.cursor
    let total = pack.total
    let collected = []
    let listedDelta = 0
    let lastCursor = cursor

    while (collected.length < batchSize) {
        const json = await queryGraphql(page, {
            ...SamplesSearchCursor,
            variables: {
                parent_asset_uuid: pack.uuid,
                cursor,
                limit: samplePageSize,
            },
        })
        const result = json?.data?.assetsSearch
        if (!result) throw new Error("missing assetsSearch")
        const items = result.items ?? []
        total = result.response_metadata?.records ?? total
        const existing = existingUuids(items.map((item) => item.uuid))
        const missing = items.filter((item) => !existing.has(item.uuid))
        collected.push(...missing)
        listedDelta += items.length
        lastCursor = result.response_metadata?.next ?? null
        cursor = lastCursor
        if (!cursor || items.length === 0) break
    }

    const batch = collected.slice(0, batchSize)
    const result = await downloadSamples(batch)
    checkpoint(jobId, pack, lastCursor, total, listedDelta, result.saved, result.failed.length)
    log(
        `pack batch ${pack.name}: listed=${listedDelta} missing=${batch.length} saved=${result.saved} failed=${result.failed.length} next=${lastCursor ? "yes" : "no"}`
    )
    if (result.failed.length) {
        throw new Error(result.failed[0].error?.message ?? "sample download failed")
    }
    if (!lastCursor) {
        markComplete(jobId, pack, total)
        log(`pack complete ${pack.name}`)
    }
}

async function collectRandomStream(page, state, seed, target, knownUuids, shared) {
    let cursor = state.cursor
    let done = state.done
    let accepted = 0
    let listed = 0
    let pages = 0
    let total = 0

    while (!done && accepted < target) {
        const json = await queryGraphql(page, {
            ...SamplesSearchCursor,
            variables: {
                parent_asset_uuid: null,
                parent_asset_type: null,
                cursor,
                limit: samplePageSize,
                sort: "random",
                order: "DESC",
                random_seed: seed,
            },
        })
        const result = json?.data?.assetsSearch
        if (!result) throw new Error("missing assetsSearch")
        pages++
        const items = result.items ?? []
        total = result.response_metadata?.records ?? total
        listed += items.length
        const missing = []
        for (const item of items) {
            if (accepted + missing.length >= target) break
            if (knownUuids.has(item.uuid)) continue
            knownUuids.add(item.uuid)
            missing.push(item)
        }
        if (missing.length) {
            const allocated = allocateRelativePaths(missing, shared.pathOwners)
            if (shared.downloadStartedAt == null) shared.downloadStartedAt = now()
            for (const sample of missing) {
                const relativePath = allocated.get(sample.uuid)
                shared.relativePaths.set(sample.uuid, relativePath)
                shared.collected.push(sample)
                shared.downloadTasks.push(
                    shared.limitDownload(() => downloadSampleFile(sample, relativePath))
                )
            }
            accepted += missing.length
        }
        cursor = result.response_metadata?.next ?? null
        done = !cursor || items.length === 0
    }

    return { state: { cursor, done }, accepted, listed, pages, total }
}

async function prepareRandomBatch(pages, states, seeds, knownUuids) {
    const prepareStartedAt = now()
    const listingStartedAt = now()
    const shared = {
        collected: [],
        relativePaths: new Map(),
        pathOwners: new Map(),
        downloadTasks: [],
        limitDownload: createTaskLimiter(concurrency),
        downloadStartedAt: null,
    }
    const firstTarget = Math.ceil(batchSize / 2)
    const targets = [firstTarget, batchSize - firstTarget]
    const streams = await Promise.all(
        pages.map((page, index) =>
            collectRandomStream(
                page,
                states[index],
                seeds[index],
                targets[index],
                knownUuids,
                shared
            )
        )
    )

    const listingFinishedAt = now()
    const results = await Promise.all(shared.downloadTasks)
    const downloadFinishedAt = now()
    const saved = results.filter((result) => !result.error).map((result) => result.sample)
    const failed = results.filter((result) => result.error)
    if (!shared.collected.length) return null

    const batch = {
        items: shared.collected,
        listed: streams.reduce((sum, stream) => sum + stream.listed, 0),
        total: Math.max(...streams.map((stream) => stream.total)),
        states: streams.map((stream) => stream.state),
        pages: streams.reduce((sum, stream) => sum + stream.pages, 0),
        streamPages: streams.map((stream) => stream.pages),
    }
    const downloaded = {
        samples: saved,
        saved: saved.length,
        failed,
        relativePaths: shared.relativePaths,
        downloadMs: shared.downloadStartedAt == null ? 0 : downloadFinishedAt - shared.downloadStartedAt,
        downloadTailMs: downloadFinishedAt - listingFinishedAt,
        stats: summarizeDownloadResults(results),
    }
    return {
        batch,
        downloaded,
        listingMs: listingFinishedAt - listingStartedAt,
        prepareMs: downloadFinishedAt - prepareStartedAt,
    }
}

async function runRandomSamples(pages) {
    const seeds = pages.map((_, index) =>
        index === 0 ? randomSeed : deriveRandomSeed(randomSeed, index)
    )
    log(`random sample mode seeds=${seeds.join(",")} streams=${pages.length} batchSize=${batchSize} pageSize=${samplePageSize} concurrency=${concurrency}`)
    if (maxBatches <= 0) return
    const cacheStartedAt = now()
    const knownUuids = await loadCachedUuids()
    log(`UUID cache loaded count=${knownUuids.size} ms=${now() - cacheStartedAt}`)
    let batches = 0
    let savedTotal = 0
    const initialStates = pages.map(() => ({ cursor: null, done: false }))
    let prepared = await prepareRandomBatch(pages, initialStates, seeds, knownUuids)
    while (prepared && batches < maxBatches) {
        const { batch, downloaded, listingMs, prepareMs } = prepared
        const dbPromise = persistDownloaded(downloaded)
        const hasNext = batch.states.some((state) => !state.done)
        const nextPromise = batches + 1 < maxBatches && hasNext
            ? prepareRandomBatch(pages, batch.states, seeds, knownUuids).then(
                (nextPrepared) => ({ nextPrepared }),
                (error) => ({ error })
            )
            : null
        const dbMs = await dbPromise
        const result = { ...downloaded, dbMs }
        savedTotal += result.saved
        batches++
        log(
            `random batch ${batches}: listed=${batch.listed} pages=${batch.pages} streamPages=${batch.streamPages.join("+")} total=${batch.total} missing=${batch.items.length} saved=${result.saved} failed=${result.failed.length} sessionSaved=${savedTotal} prepareMs=${prepareMs} listingMs=${listingMs} downloadMs=${result.downloadMs} downloadTailMs=${result.downloadTailMs} dbMs=${result.dbMs} downloadP50Ms=${result.stats.p50Ms} downloadP95Ms=${result.stats.p95Ms} downloadP99Ms=${result.stats.p99Ms} downloadMaxMs=${result.stats.maxMs} failedMaxMs=${result.stats.failedMaxMs} retried=${result.stats.retriedCount} timeouts=${result.stats.timeoutCount} reused=${result.stats.reusedCount} next=${hasNext ? "yes" : "no"}`
        )
        if (result.failed.length) {
            log(`first failure: ${result.failed[0].sample.uuid} durationMs=${result.failed[0].durationMs} ${result.failed[0].error?.message ?? result.failed[0].error}`)
        }
        if (!nextPromise) break
        const nextResult = await nextPromise
        if (nextResult.error) throw nextResult.error
        prepared = nextResult.nextPrepared
    }
}

async function main() {
    log(`sqlite binary ${sqliteBin}`)
    assertDatabaseIntegrity()
    ensureMirrorTables()
    const { browser, pages } = await setupGraphqlPages(mode === "packs" ? 1 : 2)
    const page = pages[0]
    try {
        if (mode === "packs") {
            const jobId = getJobId()
            refreshQueuedProgress(jobId)
            summarize(jobId)
            let batches = 0
            let packs = 0
            while (batches < maxBatches && packs < maxPacks) {
                let pack = nextPack(jobId)
                if (!pack) {
                    const cataloged = await catalogSomePacks(page, jobId)
                    if (!cataloged) break
                    pack = nextPack(jobId)
                    if (!pack) break
                }
                try {
                    await processPack(page, jobId, pack)
                } catch (e) {
                    log(`pack failed ${pack.name}: ${e.message ?? e}`)
                    markFailed(jobId, pack, e)
                }
                batches++
                packs++
                if (batches % 5 === 0) summarize(jobId)
            }
            summarize(jobId)
        } else {
            await runRandomSamples(pages)
        }
    } finally {
        await browser.close()
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
