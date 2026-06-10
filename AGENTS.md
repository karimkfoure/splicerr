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
```

### UI / store

- **Bulk download vs pack sync** — one run at a time ([`download-session.ts`](src/lib/shared/download-session.ts)). Single download engine in [`bulk-download.svelte.ts`](src/lib/shared/bulk-download.svelte.ts) (cursor listing, 5k collect batches, 250-item slices, `runPool`, 30s timeout, inline retry) + [`bulk-download-health`](src/lib/shared/bulk-download-health.ts) adaptive concurrency (25–100, initial 50). **Pack sync** ([`pack-sync.svelte.ts`](src/lib/shared/pack-sync.svelte.ts)) is a FIFO queue only: one pack at a time, each pack calls `runSpliceDownloadListingSession` with browse sort/filters (`captureBulkSpliceListingSort`, `captureSpliceSearchFilters`, optional dialog “match browse tags”) and `parentPackUuid`.
- `browseStore.mode`: `"splice"` | `"library"`.
- Tab change: `switchBrowseMode()` (per-tab list cache, scroll reset via `onBrowseModeListReset`); do not hand-roll `resetAssetList()` + `fetchAssets()` on tabs.
- Sort: reset on tab change via `resetSortForBrowseMode()` (`relevance` / Splice, `ingested_at` / library); `ensure*CompatibleSort()` remains a safety net on fetch.
- Library pagination: `LIBRARY_PER_PAGE` (local SQLite); Splice stays `PER_PAGE` + infinite scroll.
- Filters (key, BPM, tags): `resetAssetList()` + `fetchAssets()` so pagination identity resets.

### GraphQL

- Queries in `src/lib/splice/api.ts` (from browser devtools). Sample fragment: `display_file_path`, `display_name`, pack `files` with `asset_file_type_slug` (use `cover_image`, not `files[0]` blindly).

### Known limits (v1)

- No import of arbitrary folders; no full-disk reconciliation scan.
- Many one-shots have no `key` in API — key filter only matches rows with key set (expected).
- Pack covers require HTTPS URL at ingest (`cover_source_url`) or materialize from Splice tab once per pack.
