# Local library (mirror offline)

Design reference for the local sample mirror. Supersedes [offline-sample-cache.md](./offline-sample-cache.md).

## Layout

```text
samples_dir/
  Pack_Name/
    One-Shots/Bass/Kick_01.mp3
    One-Shots/Bass/Kick_01.mp3.waveform.gz
    cover.jpg   # one pack artwork per folder (not per sample)
  .splicerr/
    library.db
```

- Audio: descrambled **raw MP3** bytes from Splice (no re-encode on disk). **Level 1** is always `parents.items[0].name` (pack title from GraphQL). Deeper folders come from `display_file_path` when present, else `files[0].path` / `sample.name`, with light cleanup (drop vendor folder before `One_Shots`/`Loops`/etc.; drop segments that repeat the pack name).
- Waveform: gzip-compressed JSON array sidecar next to the audio file (same payload as Splice `files[1]`).
- Metadata: SQLite only (no per-sample JSON files).
- `cut_mp3_delay`: playback-only in the app; does not modify files on disk.

## SQLite schema (v1)

See plan: `packs`, `samples`, `tags`, `sample_tags`, `samples_fts` (FTS5).

## UI modes

- **Splice**: remote GraphQL search; play requires valid `samples_dir`; preview materializes MP3 + DB.
- **Mi biblioteca**: `library_search` on local DB; works offline.

## Library sorts

`name`, `bpm`, `duration`, `key`, `ingested_at` only.

## v1 limits

- No disk import for files not ingested through the app.
- No reconciliation scan; missing MP3 on disk shows play error, DB row kept.

## Query checklist (library mode)

- Text search (FTS)
- Tags (AND)
- BPM min/max and exact bpm
- Key, chord_type, asset_category_slug
- Favorites only
- Pagination (50 per page)
