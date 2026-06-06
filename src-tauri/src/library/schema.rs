use rusqlite::Connection;

const MIGRATION_V1: &str = "
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS packs (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cover_relative_path TEXT
);

CREATE TABLE IF NOT EXISTS samples (
    uuid TEXT PRIMARY KEY,
    pack_uuid TEXT NOT NULL REFERENCES packs(uuid),
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    relative_audio_path TEXT NOT NULL UNIQUE,
    duration_ms INTEGER NOT NULL,
    bpm INTEGER,
    key TEXT,
    chord_type TEXT,
    asset_category_slug TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    audio_cached_at INTEGER NOT NULL DEFAULT 0,
    ingested_at INTEGER NOT NULL,
    pack_name TEXT NOT NULL,
    waveform_relative_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_samples_pack ON samples(pack_uuid);
CREATE INDEX IF NOT EXISTS idx_samples_favorite ON samples(favorite);
CREATE INDEX IF NOT EXISTS idx_samples_bpm ON samples(bpm);
CREATE INDEX IF NOT EXISTS idx_samples_key ON samples(key);
CREATE INDEX IF NOT EXISTS idx_samples_category ON samples(asset_category_slug);
CREATE INDEX IF NOT EXISTS idx_samples_ingested ON samples(ingested_at DESC);

CREATE TABLE IF NOT EXISTS tags (
    uuid TEXT PRIMARY KEY,
    label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sample_tags (
    sample_uuid TEXT NOT NULL,
    tag_uuid TEXT NOT NULL,
    PRIMARY KEY (sample_uuid, tag_uuid)
);

CREATE INDEX IF NOT EXISTS idx_sample_tags_tag ON sample_tags(tag_uuid);

CREATE VIRTUAL TABLE IF NOT EXISTS samples_fts USING fts5(
    sample_uuid UNINDEXED,
    name,
    display_name,
    pack_name
);
";

pub fn migrate(conn: &Connection) -> Result<(), String> {
    let version: Option<i32> = conn
        .query_row(
            "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    let v = version.unwrap_or(0);
    if v < 1 {
        conn.execute_batch(MIGRATION_V1)
            .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (1)", [])
            .map_err(|e| e.to_string())?;
    }
    if v < 2 {
        conn.execute_batch(
            "UPDATE samples SET key = UPPER(key) WHERE key IS NOT NULL AND key != '';
             UPDATE samples SET chord_type = LOWER(chord_type)
               WHERE chord_type IS NOT NULL AND chord_type != '';",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (2)", [])
            .map_err(|e| e.to_string())?;
    }
    if v < 3 {
        conn.execute_batch(
            "ALTER TABLE packs ADD COLUMN cover_source_url TEXT;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (3)", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
