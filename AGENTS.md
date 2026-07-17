# AGENTS.md — Splicerr (this fork)

Guide for humans and coding agents working in this repository.

## What this project is

**Splicerr** is a Tauri 2 + Svelte 5 desktop client for the public Splice Sounds GraphQL API. This fork adds a **local library mirror** (offline **My library**); see product goals and architecture below. Upstream context: community Apollo preflight fix — not the official Splice app. See **README** for attribution and user-facing features.

## Product goals (current arc)

1. **Splice tab** — remote search, play, drag/drop; preview **materializes** audio + metadata when `samples_dir` is set.
2. **My library tab** — FTS search and filters on local DB; works offline if files exist.
3. **On-disk layout** — see [Disk conventions](#disk-conventions) (pack folders, MP3, sidecars, covers).
4. **Prototype phase** — optimize for iteration speed, not in-place upgrades ([prototype rules](#prototype-rules-no-retrocompat-by-default)).

## How we iterate (methodology)

### Loop

1. **Understand** — this file, `README.md`, relevant code, and (for disk/DB bugs) the [dev cache](#dev-cache-inspection-local-machine). Chat may hold extra context; land durable facts in **AGENTS.md** or **README**, not a separate design doc.
2. **Implement** — smallest correct diff; match existing style and patterns in the file you touch.
3. **Verify** — [Commands](#commands) (`pnpm check`, `cargo test ingest_and_search`) plus manual app pass; for path/metadata issues, inspect files and SQLite on the dev `samples_dir`.
4. **Commit** — [Commits when something works](#commits-when-something-works); **commit before** the next unrelated slice or user topic.
5. **Document** — user-visible behavior → `README.md`; architecture, disk, workflow → this file ([self-update](#keeping-agentsmd-current-self-update)).

### Commits when something works

**Default for this fork:** land a git commit whenever a slice is **verified and working**, not when the whole roadmap is done.

**Hard rule — one topic, one commit (minimum):** Do not leave verified work uncommitted while continuing in chat on a **different** concern (e.g. library pagination landed → commit → *then* tab-switch cache). If the user says “commit” (or similar), run `git status` / `git diff` and commit **immediately** — do not start the next fix first. A dirty tree across multiple features is a process failure; split into separate commits when the user asked for multiple topics in one session.

| Counts as “andando” (commit) | Wait (no commit yet) |
|------------------------------|----------------------|
| Bug fix with checks green or clear manual repro fixed | Half-written refactor, broken build |
| New UI behavior you or the user can exercise | Exploratory spike the user may discard |
| Rust/TS change + passing targeted test | “Might work” without verify step |
| `AGENTS.md` / `README.md` sync after a landed behavior change | Chat-only decisions not written anywhere |
| Removal of dead code after a deliberate wipe/rebuild decision | Drive-by formatting across unrelated files |

**One slice ≈ one commit** (split independent fixes; merge same root cause).

**Message style:** English, 1–2 sentences, focus on *why* / user outcome. HEREDOC body when committing (Cursor git rules). Examples: `Fix library key filter by normalizing pitch class on ingest`; `Store pack cover_source_url for offline artwork`.

**Scope:** only files for this slice; no secrets (`.env`, tokens).

**Git:** no push unless the user asks; no config changes, force-push to `main`, or amend games unless Cursor user rules allow. Cursor’s default is “commit only when asked” — **here, commit each working slice during feature/fix work** unless the user says “don’t commit yet.” Ask before enormous or risky commits (mass delete, etc.). After each slice: `git status` must be **clean** before you treat the next message as a new task (unless the user explicitly wants WIP left uncommitted).

**Agent checklist before replying on a new sub-topic:** (1) Is the previous slice committed? (2) If not, commit or ask. (3) Only then implement the new ask.

### Prototype rules (no retrocompat by default)

While this mirror is in active development:

- **Do not** add migration paths for old on-disk filenames, legacy `.wav` mislabels, alternate path candidates, or “copy from old path to new path” unless the user explicitly asks.
- **Do not** design for existing production users upgrading in place; the user may **wipe `samples_dir` and `.splicerr/library.db`** and rebuild from Splice.
- **SQLite schema** may still use versioned migrations in `schema.rs` for the single local DB file during dev — but avoid complex backfill logic; prefer destructive reset + re-ingest when schema or path rules change materially.
- **Rejected ideas** stay rejected unless reopened (e.g. ID3 tagging on MP3 for Ableton).

When the product matures, revisit retrocompat deliberately — do not preempt it in code.

### Agent / user collaboration

- User messages in Spanish are fine; code and commit messages in English.
- Ask before large architectural pivots; small fixes and obvious follow-ups from the same thread should proceed without re-asking.

### Keeping AGENTS.md current (self-update)

Chat is ephemeral; **AGENTS.md** is durable memory for how we build this fork. **README** is for end users (features, setup). No separate `docs/` design spec — it went stale; do not recreate unless the user asks.

**Edit proactively** when something would help the next session:

- **Workflow** norms (commit cadence, verify on dev cache, prototype rules).
- **Decisions** with lasting impact (rejected approaches, wipe-and-re-mirror OK).
- **Recurring pitfalls** — add once under the right architecture/engineering bullet, not duplicated here as a second list.
- **Machine-specific facts** (e.g. dev `samples_dir`) in [Dev cache](#dev-cache-inspection-local-machine), labeled as local QA.
- **Architecture shifts** — update the high-level sections and tree.

**How to self-update well:** distill (no transcripts); stay scannable; point to code paths instead of re-specifying APIs; prune stale sections; commit AGENTS changes with the related slice or a tiny `Update AGENTS.md: …` follow-up.

**Skip bloat:** one-off fixes, one-time debug steps, chat logs, secrets.

**User says “update AGENTS”** — permission to rewrite methodology even without product code; commit under the same [commit rules](#commits-when-something-works).

**Loop:** what worked in chat → general rule here → next session starts aligned.

## Dev cache inspection (local machine)

The maintainer’s current **`samples_dir`** for manual QA (not in repo, machine-specific):

```text
/Volumes/disco/splicerr
```

Use it to validate mirror behavior — agents with shell access should list and query it, not assume paths from docs alone.

| What | Where |
|------|--------|
| Audio + pack folders | `/Volumes/disco/splicerr/{Pack}/…/*.mp3` |
| Pack artwork (once per pack) | `/Volumes/disco/splicerr/{Pack}/cover.jpg` |
| Waveform sidecars | `*.waveform.gz` next to each MP3 |
| SQLite + WAL | `/Volumes/disco/splicerr/.splicerr/library.db` (+ `-wal` / `-shm`) |

**Example commands** (read-only inspection):

```bash
# Tree / counts
find "/Volumes/disco/splicerr" -name "cover.jpg" | wc -l
find "/Volumes/disco/splicerr" -maxdepth 3 -type d | head

# Schema and key stats
sqlite3 "/Volumes/disco/splicerr/.splicerr/library.db" ".schema samples"
sqlite3 "/Volumes/disco/splicerr/.splicerr/library.db" \
  "SELECT key, chord_type, COUNT(*) FROM samples GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;"
```

App settings must point `samples_dir` at this path (or another) via the UI; the repo does not hardcode it.

## Architecture (high level)

```text
src/                    SvelteKit UI + shared TS
src/lib/splice/         GraphQL query templates, types, descrambler
src/lib/library/        Tauri invoke wrappers, materialize, localize assets
src/lib/shared/         store, files, sample-path, pack-cover, waveform-data
src-tauri/src/library/  SQLite schema, ingest, library_search (Rust)
AGENTS.md               Living design + workflow for this fork (source of truth)
README.md               User-facing features and setup
```

### Data flow

- **Materialize** (`ensureSampleMp3OnDisk` → `libraryUpsertFromAsset`): fetch/descramble MP3, optional waveform `.gz`, pack `cover.jpg`, upsert rows in `samples_dir/.splicerr/library.db`.
- **Library browse** (`library_search`): Rust builds `SampleAsset`-shaped JSON; `localizeSampleAsset` turns audio paths into `asset://` URLs; waveforms stay `file://` for `readFile`.
- **Play** — in-memory blob URLs for MP3; transpose uses WAV blobs separately (not written to library paths).

### Disk conventions

- Audio: `{sanitized_pack_name}/{trimmed_subpath}/{file}.mp3` — see `sample-path.ts` (`display_file_path`, vendor-folder trim, pack-duplicate trim).
- Waveform: `{relative_audio_path}.waveform.gz` (gzip JSON like Splice `files[1]`).
- Cover: `{sanitized_pack_name}/cover.jpg` — `cover_source_url` in DB for re-download; UI resolves local file first (`pack-cover.ts`).

### SQLite

- Migrations in `src-tauri/src/library/schema.rs` (WAL, FTS5, etc.).
- Library search only includes samples with `audio_cached_at > 0` (MP3 actually on disk).
- Keys stored normalized (uppercase); Splice often sends lowercase — filters must match.

## Engineering conventions

### Tests

Only when they assert real behavior or the user asks (`ingest_and_search` in Rust is the baseline).

### Commands

```bash
pnpm dev          # Vite + Tauri dev
pnpm check        # svelte-check
cd src-tauri && cargo test ingest_and_search
cd src-tauri && cargo test mirror
```

### UI / store

- **Bulk download vs pack sync** — one run at a time ([`download-session.ts`](src/lib/shared/download-session.ts)). Single listing engine in [`bulk-download.svelte.ts`](src/lib/shared/bulk-download.svelte.ts) (cursor listing, 5k collect batches, 250-item slices, Rust batch materialization, inline retry) + [`bulk-download-health`](src/lib/shared/bulk-download-health.ts) adaptive concurrency. **Pack sync** ([`pack-sync.svelte.ts`](src/lib/shared/pack-sync.svelte.ts)) is a FIFO queue only: one pack at a time, each pack calls `runSpliceDownloadListingSession` with browse sort/filters (`captureBulkSpliceListingSort`, `captureSpliceSearchFilters`, optional dialog “match browse tags”) and `parentPackUuid`.
- **Mass mirror/backfill** — GraphQL listing must still go through the hidden Splice-origin webview (`splice_graphql`); native HTTP clients are blocked by Cloudflare. The resumable mirror lives in [`mirror-backfill.svelte.ts`](src/lib/shared/mirror-backfill.svelte.ts): first persist the pack catalog by popularity, then process one pack at a time with SQLite checkpoints (`mirror_jobs`, `mirror_pack_queue`, `mirror_failures`). Heavy audio materialization should use the Rust batch command (`library_materialize_batch`): it downloads scrambled MP3s, descrambles, writes files, and upserts SQLite rows with bounded backend concurrency. Existing cached samples count as progress; do not wipe by default.
- **Headless mirror runner** — for large one-time backfills, prefer `pnpm backfill:headless -- --samples-dir /Volumes/disco/splicerr --batch-size 4000 --concurrency 100`. Default mode lists global samples in random order, filters out cached UUIDs, then downloads, descrambles, writes MP3s, and upserts SQLite directly from Node. It uses Playwright only for Splice GraphQL (browser-origin fetch) and avoids Svelte/UI reactive state. `--mode packs` is available for deliberate pack-queue cleanup, but random mode is the fast path for accumulating the 3M mirror. Keep FTS cleanup batched: deleting `samples_fts` once per sample scans the large FTS table repeatedly; one `IN (...)` delete per materialization batch reduced measured 1k-sample batches from about 4m50s to 46s. Random mode runs ten independent GraphQL cursor streams with numeric seeds; they share the in-memory cached/scheduled UUID `Set`, path reservations, and one bounded download pool, then prepare the next batch while a single SQLite writer persists the current one. Seeds/cursors are checkpointed in that same sample transaction and resume after restart; completed streams trigger a fresh pass, and rejected stale cursors reset safely because Splice's catalog is mutable. Never infer remote deletion from a missing random result or delete local audio automatically. GraphQL transport retries `429` and `5xx` responses plus fetch failures four times with short exponential backoff, because a single late-pass Cloudflare error must not discard hundreds of thousands of listed results. The Node process prefers IPv4 DNS results because local benchmarks showed lower CDN download tail latency than the default address ordering. Each audio request has a 3s first-attempt timeout and one 1.5s retry for timeout/transport/408/429/5xx; non-retryable responses such as 403 fail immediately. Splice caps cursor pages at 100 items even when a larger limit is requested, so the runner enforces that maximum. Logs include UUID cache load time, aggregate and per-stream pages, phase timings, download p50/p95/p99/max, failed max duration, retry attempts split into recovered/failed counts, timeout counts, and reused-file count; use these metrics before changing timeout or concurrency.
- **Headless DB integrity** — the runner must use standard SQLite (Homebrew on macOS, or `SQLITE3_BIN`), never Apple’s `/usr/bin/sqlite3` codec build: mixing its 12-byte page reserve/checksums with Rust SQLite produces false `database disk image is malformed` failures. The runner validates its binary and performs `PRAGMA quick_check` before opening Chromium or downloading. For recovery, preserve the damaged DB, use the same standard SQLite for `.recover`, and only replace the active DB after `quick_check = ok` and `reserved bytes = 0`; audio files do not need to be downloaded again.
- **MP3 padding analysis (candidate export rule)** — Splice preview MP3s sampled from the mirror are raw CBR streams without Xing/LAME gapless metadata. Deterministic analysis of 10k loops and 10k one-shots found the dominant decoded-content transition at about 1105 samples regardless of 44.1/48k sample rate; correlation against 499 cached Splice waveform sidecars favored 1105 over 0/529/576/1152 in 389 cases and raised median correlation from 0.618 (no trim) to 0.916. Use `pnpm analyze:mp3-padding -- --category=loop --limit=10000`, `--category=oneshot`, and `pnpm analyze:waveform-alignment -- --fine=true` to reproduce. This is analysis evidence, not yet a destructive mirror rewrite: preserve MP3 originals. The intended derived-WAV flow is a 1105-sample default start trim with explicit exceptions; loops with metadata within 0.05 beat of an integer should export at the exact frame length derived from BPM/beats, while one-shots should not be duration-forced. Do not persist per-sample telemetry by default; derive from existing duration/BPM and MP3 headers, with a compact override table only if exceptions prove necessary.
- **Derived local metadata** — `backfill-library-covers.mjs` audits every pack cover by image signature, repairs missing/invalid files atomically, and reconciles `packs.cover_cached_at`; `backfill-library-bitrates.mjs` reads the MPEG Layer III frame header into `samples.bitrate_kbps`, independent of remote duration. `--recalculate` checkpoints UUID progress in `library_maintenance` in the same transaction as each batch. My library must consume these local values only; do not fetch covers or inspect audio during browsing. Tauri's asset protocol must remain enabled because local audio and artwork are exposed through `convertFileSrc`.
- **Filter parity check** — `pnpm validate:filters -- --samples-dir /Volumes/disco/splicerr` compares remote GraphQL totals with exact local SQLite counts and reports coverage. Treat small differences as catalog drift, not failure. Multi-tag local counts can be disk-heavy, so run the full matrix after maintenance backfills finish; use `--remote-only` or `--only all,hip-hop,percussion` for cheap probes.
- **Disk integrity audit** — `pnpm audit:library -- --samples-dir /Volumes/disco/splicerr` streams cached rows and verifies an MPEG frame without loading the catalog into memory. `--repair` removes invalid files and marks those rows uncached for a later mirror pass; `--orphans` additionally walks disk and checks MP3 paths against SQLite in batches.
- `browseStore.mode`: `"splice"` | `"library"`.
- Tab change: `switchBrowseMode()` (per-tab list cache, scroll reset via `onBrowseModeListReset`); do not hand-roll `resetAssetList()` + `fetchAssets()` on tabs.
- Sort: reset on tab change via `resetSortForBrowseMode()` (`relevance` / Splice, `ingested_at` / library); `ensure*CompatibleSort()` remains a safety net on fetch.
- Library browsing: My library has no page number or SQL `OFFSET`. It uses opaque keyset cursors with tuple seeks, an intersection sentinel to prefetch bounded SQLite windows, and virtualizes rows so only the visible range is mounted. Preserve explicit sort indexes for unfiltered browsing; otherwise SQLite may sort the entire mirror. Multi-tag browsing depends on the covering `sample_tags(tag_uuid, sample_uuid)` index and UUID cursor order; do not revert to rowid ordering, which forces a full temporary sort. Splice keeps its separate `PER_PAGE` pagination. Exact filtered totals run independently through `library_count`, so counting never blocks the first result window or scrolling; unfiltered totals remain trigger-maintained in `library_stats`.
- Local library reads use independent read-only SQLite connections on blocking workers. Each page hydrates samples/packs and tags in two batch queries; supported sorts use dedicated indexes, pack options use trigger-maintained `library_pack_counts`, and text search is driven directly by FTS. Do not serialize browse reads behind the writer connection, reuse remote autocomplete, or recompute whole-library facets during interaction.
- Filters (key, BPM, tags): `resetAssetList()` + `fetchAssets()` resets the local cursor and remote page identity.

### GraphQL

- Queries in `src/lib/splice/api.ts` (from browser devtools). Sample fragment: `display_file_path`, `display_name`, pack `files` with `asset_file_type_slug` (use `cover_image`, not `files[0]` blindly).

### Known limits (v1)

- No import of arbitrary folders; no full-disk reconciliation scan.
- Many one-shots have no `key` in API — key filter only matches rows with key set (expected).
- Pack covers require HTTPS URL at ingest (`cover_source_url`) or materialize from Splice tab once per pack.
