#!/usr/bin/env node
import { chromium } from "playwright"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"

const args = parseArgs(process.argv.slice(2))
const samplesDir = path.resolve(args.samplesDir ?? "/Volumes/disco/splicerr")
const dbPath = path.join(samplesDir, ".splicerr", "library.db")
const sqliteBin = resolveSqliteBin()
if (!existsSync(dbPath)) throw new Error(`Library DB not found: ${dbPath}`)

const tags = Object.fromEntries(
    sqliteJson("SELECT lower(label) label, uuid FROM tags WHERE lower(label) IN ('hip hop','percussion');")
        .map((row) => [row.label, row.uuid])
)
if (!tags["hip hop"] || !tags.percussion) throw new Error("Hip Hop or Percussion tag is missing locally")

const cases = [
    { name: "all" },
    { name: "hip-hop", tags: [tags["hip hop"]] },
    { name: "percussion", tags: [tags.percussion] },
    { name: "hip-hop+percussion", tags: [tags["hip hop"], tags.percussion] },
    { name: "key-c", key: "C" },
    { name: "key-c-major", key: "C", chordType: "major" },
    { name: "bpm-120-130", minBpm: 120, maxBpm: 130 },
    { name: "oneshot", category: "oneshot" },
    { name: "hip-hop+percussion+bpm", tags: [tags["hip hop"], tags.percussion], minBpm: 90, maxBpm: 110 },
]
const selectedCases = args.only
    ? cases.filter((entry) => args.only.split(",").includes(entry.name))
    : cases
if (!selectedCases.length) throw new Error(`No matching cases for --only ${args.only}`)

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
try {
    await page.goto("https://surfaces-graphql.splice.com/graphql", { waitUntil: "domcontentloaded" })
    const results = []
    for (const testCase of selectedCases) {
        const remote = await remoteCount(page, testCase)
        console.log(`${testCase.name}: remote=${remote}`)
        const local = args.remoteOnly ? null : localCount(testCase)
        const result = {
            case: testCase.name,
            remote,
            local,
            delta: local == null ? null : local - remote,
            coverage: local == null || !remote ? "n/a" : `${((local / remote) * 100).toFixed(2)}%`,
        }
        results.push(result)
        if (local != null) console.log(`${testCase.name}: local=${local} coverage=${result.coverage}`)
    }
    console.table(results)
} finally {
    await browser.close()
}

async function remoteCount(page, testCase) {
    const body = {
        operationName: "ValidateSamplesFilter",
        variables: {
            tags: testCase.tags ?? [],
            key: testCase.key ?? null,
            chord_type: testCase.chordType ?? null,
            min_bpm: testCase.minBpm ?? null,
            max_bpm: testCase.maxBpm ?? null,
            asset_category_slug: testCase.category ?? null,
        },
        query: `query ValidateSamplesFilter($tags: [ID], $key: String, $chord_type: String, $min_bpm: Int, $max_bpm: Int, $asset_category_slug: AssetCategorySlug) {
          assetsSearch(
            filter: {legacy: true, published: true, asset_type_slug: sample, tag_ids: $tags, key: $key, chord_type: $chord_type, min_bpm: $min_bpm, max_bpm: $max_bpm, asset_category_slug: $asset_category_slug}
            pagination: {page: 1, limit: 1}
            sort: {sort: popularity, order: DESC}
          ) { response_metadata { records } }
        }`,
    }
    const json = await page.evaluate(async ({ body }) => {
        const response = await fetch("/graphql", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "apollo-require-preflight": "true",
                "x-apollo-operation-name": body.operationName,
            },
            body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error(`GraphQL HTTP ${response.status}`)
        return response.json()
    }, { body })
    const count = json?.data?.assetsSearch?.response_metadata?.records
    if (!Number.isFinite(count)) throw new Error(`${testCase.name}: remote count missing: ${JSON.stringify(json).slice(0, 500)}`)
    return count
}

function localCount(testCase) {
    if (testCase.name === "all") {
        return Number(sqlite("SELECT cached_sample_count FROM library_stats WHERE id=1;"))
    }
    if (testCase.tags?.length === 1 && !testCase.key && !testCase.chordType && testCase.minBpm == null && testCase.maxBpm == null && !testCase.category) {
        return Number(sqlite(`SELECT sample_count FROM library_tag_counts WHERE tag_uuid=${sql(testCase.tags[0])};`))
    }
    const clauses = ["s.audio_cached_at>0"]
    if (testCase.key) clauses.push(`s.key=${sql(testCase.key.toUpperCase())}`)
    if (testCase.chordType) clauses.push(`s.chord_type=${sql(testCase.chordType.toLowerCase())}`)
    if (testCase.minBpm != null) clauses.push(`s.bpm>=${Number(testCase.minBpm)}`)
    if (testCase.maxBpm != null) clauses.push(`s.bpm<=${Number(testCase.maxBpm)}`)
    if (testCase.category) clauses.push(`s.asset_category_slug=${sql(testCase.category)}`)
    for (const tag of testCase.tags ?? []) {
        clauses.push(`EXISTS(SELECT 1 FROM sample_tags st WHERE st.sample_uuid=s.uuid AND st.tag_uuid=${sql(tag)})`)
    }
    return Number(sqlite(`SELECT COUNT(*) FROM samples s WHERE ${clauses.join(" AND ")};`))
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

function sql(value) {
    return `'${String(value).replaceAll("'", "''")}'`
}

function sqlite(statement) {
    return execFileSync(sqliteBin, [dbPath], {
        input: `.timeout 30000\n${statement}`,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
    }).trim()
}

function sqliteJson(statement) {
    const output = execFileSync(sqliteBin, ["-json", dbPath, statement], { encoding: "utf8" }).trim()
    return output ? JSON.parse(output) : []
}
