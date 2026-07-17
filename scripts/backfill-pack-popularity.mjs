#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { chromium } from "playwright"

const GRAPHQL_URL = "https://surfaces-graphql.splice.com/graphql"
const PAGE_SIZE = 50
const PACKS_QUERY = `query PacksSearch($page: Int, $limit: Int = 50) {
  assetsSearch(
    filter: {legacy: true, published: true, asset_type_slug: pack}
    pagination: {page: $page, limit: $limit}
    sort: {sort: popularity, order: DESC}
  ) {
    items { ... on PackAsset { uuid name __typename } __typename }
    pagination_metadata { currentPage totalPages __typename }
    response_metadata { records __typename }
    __typename
  }
}`
const args = parseArgs(process.argv.slice(2))
const samplesDir = path.resolve(args.samplesDir ?? "/Volumes/disco/splicerr")
const dbPath = path.join(samplesDir, ".splicerr", "library.db")
const maxPages = args.maxPages == null ? Infinity : Math.max(1, Number(args.maxPages))
const sqliteBin = resolveSqliteBin()

assertLibrary()
ensureSchema()
if (args.restart === true) restartPass()

let checkpoint = loadCheckpoint()
if (checkpoint.done && args.restart !== true) {
    log(`already complete reason=${checkpoint.stopReason} listed=${checkpoint.listed}; use --restart for a fresh probe`)
    process.exit(0)
}

const browser = await chromium.launch({ headless: true })
try {
    const page = await browser.newPage()
    await page.goto(GRAPHQL_URL, { waitUntil: "domcontentloaded" })
    let sessionPages = 0
    while (sessionPages < maxPages) {
        const requestedPage = checkpoint.nextPage
        const json = await queryGraphql(page, requestedPage)
        const result = json?.data?.assetsSearch
        if (!result) {
            const graphqlError = (json?.errors ?? []).map((error) => error.message).join("; ") || "missing assetsSearch"
            if (checkpoint.listed > 0 && /400:\s*Bad Request/i.test(graphqlError)) {
                finish(checkpoint, `endpoint_rejected_page_${requestedPage}`)
                break
            }
            throw new Error(graphqlError)
        }

        const currentPage = Number(result.pagination_metadata?.currentPage ?? requestedPage)
        const items = result.items ?? []
        if (currentPage !== requestedPage) {
            finish(checkpoint, `server_clamped_to_page_${currentPage}`, result)
            break
        }
        if (items.length === 0) {
            finish(checkpoint, "empty_page", result)
            break
        }

        const fingerprint = `${items[0]?.uuid}:${items.at(-1)?.uuid}`
        if (fingerprint === checkpoint.lastFingerprint) {
            finish(checkpoint, "repeated_page", result)
            break
        }

        persistPage(checkpoint, result, fingerprint)
        checkpoint = loadCheckpoint()
        sessionPages++
        log(`page=${currentPage} listed=${checkpoint.listed} localRanked=${countRankedLocal()}/${countLocalPacks()} remoteRecords=${checkpoint.remoteRecords ?? "?"} reportedPages=${checkpoint.reportedPages ?? "?"}`)
    }
    if (sessionPages === maxPages) log(`session page limit reached; rerun the same command to resume at page ${checkpoint.nextPage}`)
} finally {
    await browser.close()
}

function persistPage(checkpoint, result, fingerprint) {
    const currentPage = Number(result.pagination_metadata?.currentPage ?? checkpoint.nextPage)
    const observedAt = Date.now()
    const updates = (result.items ?? []).map((pack, index) => {
        const rank = (currentPage - 1) * PAGE_SIZE + index + 1
        return `UPDATE packs
SET popularity_rank=${rank}, popularity_observed_at=${observedAt}
WHERE uuid=${sql(pack.uuid)};`
    }).join("\n")
    const nextListed = checkpoint.listed + (result.items?.length ?? 0)
    sqlite(`BEGIN IMMEDIATE;
${updates}
UPDATE pack_popularity_backfill_checkpoint SET
  next_page=${currentPage + 1},
  listed_count=${nextListed},
  remote_records=${sqlNumber(result.response_metadata?.records)},
  reported_pages=${sqlNumber(result.pagination_metadata?.totalPages)},
  last_fingerprint=${sql(fingerprint)},
  done=0,
  stop_reason=NULL,
  updated_at=${observedAt}
WHERE id=1;
COMMIT;`)
}

function finish(checkpoint, reason, result = null) {
    const remoteRecords = result?.response_metadata?.records ?? checkpoint.remoteRecords
    const reportedPages = result?.pagination_metadata?.totalPages ?? checkpoint.reportedPages
    sqlite(`UPDATE pack_popularity_backfill_checkpoint SET
  remote_records=${sqlNumber(remoteRecords)},
  reported_pages=${sqlNumber(reportedPages)},
  done=1,
  stop_reason=${sql(reason)},
  updated_at=${Date.now()}
WHERE id=1;`)
    log(`complete reason=${reason} requestedPage=${checkpoint.nextPage} listed=${checkpoint.listed} localRanked=${countRankedLocal()}/${countLocalPacks()} remoteRecords=${remoteRecords ?? "?"} reportedPages=${reportedPages ?? "?"}`)
}

function ensureSchema() {
    const columns = new Set(sqliteJson("PRAGMA table_info(packs);").map((column) => column.name))
    if (!columns.has("popularity_rank")) sqlite("ALTER TABLE packs ADD COLUMN popularity_rank INTEGER;")
    if (!columns.has("popularity_observed_at")) sqlite("ALTER TABLE packs ADD COLUMN popularity_observed_at INTEGER;")
    sqlite(`CREATE INDEX IF NOT EXISTS idx_packs_popularity_rank ON packs(popularity_rank, uuid);
CREATE TABLE IF NOT EXISTS pack_popularity_backfill_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id=1),
  next_page INTEGER NOT NULL,
  listed_count INTEGER NOT NULL,
  remote_records INTEGER,
  reported_pages INTEGER,
  last_fingerprint TEXT,
  done INTEGER NOT NULL,
  stop_reason TEXT,
  updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO pack_popularity_backfill_checkpoint
  (id, next_page, listed_count, done, updated_at)
VALUES (1, 1, 0, 0, ${Date.now()});
INSERT OR IGNORE INTO schema_migrations(version) VALUES(13);`)
}

function restartPass() {
    sqlite(`BEGIN IMMEDIATE;
UPDATE packs SET popularity_rank=NULL, popularity_observed_at=NULL
WHERE popularity_rank IS NOT NULL OR popularity_observed_at IS NOT NULL;
UPDATE pack_popularity_backfill_checkpoint SET
  next_page=1, listed_count=0, remote_records=NULL, reported_pages=NULL,
  last_fingerprint=NULL, done=0, stop_reason=NULL, updated_at=${Date.now()}
WHERE id=1;
COMMIT;`)
}

function loadCheckpoint() {
    const row = sqliteJson("SELECT * FROM pack_popularity_backfill_checkpoint WHERE id=1;")[0]
    return {
        nextPage: Number(row.next_page),
        listed: Number(row.listed_count),
        remoteRecords: row.remote_records,
        reportedPages: row.reported_pages,
        lastFingerprint: row.last_fingerprint,
        done: Boolean(row.done),
        stopReason: row.stop_reason,
    }
}

function countLocalPacks() {
    return Number(sqlite("SELECT COUNT(*) FROM library_pack_counts;"))
}

function countRankedLocal() {
    return Number(sqlite("SELECT COUNT(*) FROM library_pack_counts c JOIN packs p ON p.uuid=c.pack_uuid WHERE p.popularity_rank IS NOT NULL;"))
}

async function queryGraphql(page, requestedPage) {
    return page.evaluate(async ({ requestedPage, pageSize, query }) => {
        let lastError
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const response = await fetch("/graphql", {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "apollo-require-preflight": "true",
                        "x-apollo-operation-name": "PacksSearch",
                    },
                    body: JSON.stringify({
                        operationName: "PacksSearch",
                        variables: { page: requestedPage, limit: pageSize },
                        query,
                    }),
                })
                const text = await response.text()
                if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
                return JSON.parse(text)
            } catch (error) {
                lastError = error
                if (attempt === 3) throw error
                await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
            }
        }
        throw lastError
    }, { requestedPage, pageSize: PAGE_SIZE, query: PACKS_QUERY })
}

function assertLibrary() {
    if (!existsSync(dbPath)) throw new Error(`Library DB not found: ${dbPath}`)
}

function parseArgs(argv) {
    const out = {}
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith("--")) continue
        const key = argv[i].slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
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

function sqlite(statement) {
    return execFileSync(sqliteBin, [dbPath], {
        input: `.timeout 30000\n${statement}`,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    }).trim()
}

function sqliteJson(statement) {
    const output = execFileSync(sqliteBin, ["-json", dbPath, statement], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    }).trim()
    return output ? JSON.parse(output) : []
}

function sql(value) {
    if (value == null) return "NULL"
    return `'${String(value).replaceAll("'", "''")}'`
}

function sqlNumber(value) {
    const number = Number(value)
    return Number.isFinite(number) ? String(number) : "NULL"
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`)
}
