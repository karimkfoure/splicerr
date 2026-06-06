# AGENTS.md — Splicerr (this fork)

Guide for humans and coding agents working in this repository.

## What this project is

**Splicerr** is a Tauri 2 + Svelte 5 desktop client for the public Splice Sounds GraphQL API. This fork adds a **local library mirror**: samples you preview or download are stored on disk as descrambled MP3, with metadata in SQLite, and browsable offline under **My library**.

Upstream context: community fix for Apollo preflight headers; not the official Splice app. See README for attribution.

## Product goals (current arc)

1. **Splice tab** — remote search, play, drag/drop; preview **materializes** audio + metadata when `samples_dir` is set.
2. **My library tab** — FTS search and filters on local DB; works offline if files exist.
3. **On-disk layout** — human-readable tree under `samples_dir`, one folder per pack (GraphQL pack name), sensible subpaths, `.mp3` bytes, sidecar waveforms, one `cover.jpg` per pack.
4. **Prototype mindset** — prefer small, correct diffs; avoid retrocompat layers unless the user asks. No ID3 tagging on files (explicitly rejected).

## Architecture (high level)

```text
src/                    SvelteKit UI + shared TS
src/lib/splice/         GraphQL query templates, types, descrambler
src/lib/library/        Tauri invoke wrappers, materialize, localize assets
src/lib/shared/         store, files, sample-path, pack-cover, waveform-data
src-tauri/src/library/  SQLite schema, ingest, library_search (Rust)
docs/local-library.md   Design reference for mirror layout and limits
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

- Migrations in `src-tauri/src/library/schema.rs` (WAL, FTS5, key normalization v2, `cover_source_url` v3).
- Library only lists samples with `audio_cached_at > 0` (actually cached MP3).

## How we work

### Scope and diffs

- Match existing style; minimal scope per task.
- Do not add tests unless they cover real behavior or the user asks.
- Do not commit or push unless the user asks (then follow git safety: no amend unless rules allow, HEREDOC messages).

### Commands

```bash
pnpm dev          # Vite + Tauri dev
pnpm check        # svelte-check
cd src-tauri && cargo test ingest_and_search
```

### UI / store conventions

- `browseStore.mode`: `"splice"` | `"library"`.
- Sort: Splice uses API sorts; library uses `ingested_at`, `name`, `bpm`, etc. — `ensureLibraryCompatibleSort()` on tab switch.
- Filter changes should call `resetAssetList()` + `fetchAssets()` where pagination identity matters (key, BPM).

### GraphQL

- Query strings live in `src/lib/splice/api.ts` (copied from browser devtools). Sample fragment includes `display_file_path`, `display_name`, pack `files` with `asset_file_type_slug`.

### Known limits (v1)

- No import of arbitrary folders; no full-disk reconciliation scan.
- Many one-shots have no musical key in API — key filter only matches rows with `key` set.
- Pack covers need `cover_source_url` (from ingest) or a fresh materialize from Splice for older DB rows.

## Files agents touch often

| Area | Files |
|------|--------|
| Library Rust | `src-tauri/src/library/mod.rs`, `schema.rs` |
| Paths | `src/lib/shared/sample-path.ts` |
| Disk I/O | `src/lib/shared/files.svelte.ts`, `sample-bytes.ts` |
| Covers | `src/lib/shared/pack-cover.ts` |
| Waveforms | `src/lib/shared/waveform-data.ts`, `waveform.svelte` |
| Browse state | `src/lib/shared/store.svelte.ts`, `routes/+page.svelte` |

## Documentation

- **Design**: `docs/local-library.md`
- **Deprecated stub**: `docs/offline-sample-cache.md` (points to local-library)

When behavior changes, update `docs/local-library.md` and this file if workflow or architecture shifts.
