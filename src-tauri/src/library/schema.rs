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
    let applied = |version| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = ?1)",
            [version],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false)
    };
    if !applied(1) {
        conn.execute_batch(MIGRATION_V1)
            .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (1)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(2) {
        conn.execute_batch(
            "UPDATE samples SET key = UPPER(key) WHERE key IS NOT NULL AND key != '';
             UPDATE samples SET chord_type = LOWER(chord_type)
               WHERE chord_type IS NOT NULL AND chord_type != '';",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (2)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(3) {
        conn.execute_batch("ALTER TABLE packs ADD COLUMN cover_source_url TEXT;")
            .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (3)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(4) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pack_rank_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pack_uuid TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                rank INTEGER NOT NULL,
                observed_at INTEGER NOT NULL,
                source TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_pack_rank_obs_scope_pack
                ON pack_rank_observations(scope_key, pack_uuid, observed_at DESC);
            CREATE TABLE IF NOT EXISTS pack_popularity_scores (
                pack_uuid TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                score REAL NOT NULL,
                best_rank INTEGER,
                observation_count INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (pack_uuid, scope_key)
            );
            ALTER TABLE samples ADD COLUMN pack_popularity_score REAL;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (4)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(5) {
        conn.execute_batch("ALTER TABLE packs ADD COLUMN listable_sample_total INTEGER;")
            .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (5)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(6) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mirror_jobs (
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
            CREATE INDEX IF NOT EXISTS idx_mirror_jobs_status
                ON mirror_jobs(status, updated_at DESC);

            CREATE TABLE IF NOT EXISTS mirror_pack_queue (
                job_id INTEGER NOT NULL REFERENCES mirror_jobs(id) ON DELETE CASCADE,
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
            CREATE INDEX IF NOT EXISTS idx_mirror_failures_job_pack
                ON mirror_failures(job_id, pack_uuid, created_at DESC);",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (6)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(7) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS library_tag_counts (
                tag_uuid TEXT PRIMARY KEY,
                sample_count INTEGER NOT NULL
            );

            CREATE TRIGGER IF NOT EXISTS library_tag_counts_after_insert
            AFTER INSERT ON sample_tags
            WHEN EXISTS (
                SELECT 1 FROM samples s
                WHERE s.uuid = NEW.sample_uuid AND s.audio_cached_at > 0
            )
            BEGIN
                INSERT INTO library_tag_counts (tag_uuid, sample_count)
                VALUES (NEW.tag_uuid, 1)
                ON CONFLICT(tag_uuid) DO UPDATE
                SET sample_count = sample_count + 1;
            END;

            CREATE TRIGGER IF NOT EXISTS library_tag_counts_after_delete
            AFTER DELETE ON sample_tags
            WHEN EXISTS (
                SELECT 1 FROM samples s
                WHERE s.uuid = OLD.sample_uuid AND s.audio_cached_at > 0
            )
            BEGIN
                UPDATE library_tag_counts
                SET sample_count = sample_count - 1
                WHERE tag_uuid = OLD.tag_uuid;
                DELETE FROM library_tag_counts WHERE sample_count <= 0;
            END;

            CREATE TRIGGER IF NOT EXISTS library_tag_counts_sample_cached
            AFTER UPDATE OF audio_cached_at ON samples
            WHEN OLD.audio_cached_at <= 0 AND NEW.audio_cached_at > 0
            BEGIN
                INSERT INTO library_tag_counts (tag_uuid, sample_count)
                SELECT tag_uuid, 1 FROM sample_tags
                WHERE sample_uuid = NEW.uuid
                ON CONFLICT(tag_uuid) DO UPDATE
                SET sample_count = sample_count + 1;
            END;

            CREATE TRIGGER IF NOT EXISTS library_tag_counts_sample_uncached
            AFTER UPDATE OF audio_cached_at ON samples
            WHEN OLD.audio_cached_at > 0 AND NEW.audio_cached_at <= 0
            BEGIN
                UPDATE library_tag_counts
                SET sample_count = sample_count - 1
                WHERE tag_uuid IN (
                    SELECT tag_uuid FROM sample_tags WHERE sample_uuid = NEW.uuid
                );
                DELETE FROM library_tag_counts WHERE sample_count <= 0;
            END;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (7)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(8) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS library_stats (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                cached_sample_count INTEGER NOT NULL
            );
            INSERT OR REPLACE INTO library_stats (id, cached_sample_count)
            SELECT 1, COUNT(*) FROM samples WHERE audio_cached_at > 0;

            CREATE TRIGGER IF NOT EXISTS library_stats_sample_insert
            AFTER INSERT ON samples
            WHEN NEW.audio_cached_at > 0
            BEGIN
                UPDATE library_stats
                SET cached_sample_count = cached_sample_count + 1
                WHERE id = 1;
            END;

            CREATE TRIGGER IF NOT EXISTS library_stats_sample_delete
            AFTER DELETE ON samples
            WHEN OLD.audio_cached_at > 0
            BEGIN
                UPDATE library_stats
                SET cached_sample_count = cached_sample_count - 1
                WHERE id = 1;
            END;

            CREATE TRIGGER IF NOT EXISTS library_stats_sample_cached
            AFTER UPDATE OF audio_cached_at ON samples
            WHEN OLD.audio_cached_at <= 0 AND NEW.audio_cached_at > 0
            BEGIN
                UPDATE library_stats
                SET cached_sample_count = cached_sample_count + 1
                WHERE id = 1;
            END;

            CREATE TRIGGER IF NOT EXISTS library_stats_sample_uncached
            AFTER UPDATE OF audio_cached_at ON samples
            WHEN OLD.audio_cached_at > 0 AND NEW.audio_cached_at <= 0
            BEGIN
                UPDATE library_stats
                SET cached_sample_count = cached_sample_count - 1
                WHERE id = 1;
            END;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (8)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(9) {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS library_pack_counts (
                pack_uuid TEXT PRIMARY KEY,
                sample_count INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_library_cached_pack
                ON samples(pack_uuid) WHERE audio_cached_at > 0;

            INSERT INTO library_pack_counts (pack_uuid, sample_count)
            SELECT pack_uuid, COUNT(*) FROM samples
            WHERE audio_cached_at > 0 GROUP BY pack_uuid;

            CREATE TRIGGER IF NOT EXISTS library_pack_counts_sample_insert
            AFTER INSERT ON samples
            WHEN NEW.audio_cached_at > 0
            BEGIN
                INSERT INTO library_pack_counts (pack_uuid, sample_count)
                VALUES (NEW.pack_uuid, 1)
                ON CONFLICT(pack_uuid) DO UPDATE
                SET sample_count = sample_count + 1;
            END;

            CREATE TRIGGER IF NOT EXISTS library_pack_counts_sample_delete
            AFTER DELETE ON samples
            WHEN OLD.audio_cached_at > 0
            BEGIN
                UPDATE library_pack_counts SET sample_count = sample_count - 1
                WHERE pack_uuid = OLD.pack_uuid;
                DELETE FROM library_pack_counts WHERE sample_count <= 0;
            END;

            CREATE TRIGGER IF NOT EXISTS library_pack_counts_sample_update
            AFTER UPDATE OF pack_uuid, audio_cached_at ON samples
            WHEN OLD.pack_uuid != NEW.pack_uuid OR
                 (OLD.audio_cached_at > 0) != (NEW.audio_cached_at > 0)
            BEGIN
                UPDATE library_pack_counts SET sample_count = sample_count - 1
                WHERE pack_uuid = OLD.pack_uuid AND OLD.audio_cached_at > 0;
                DELETE FROM library_pack_counts WHERE sample_count <= 0;
                INSERT INTO library_pack_counts (pack_uuid, sample_count)
                SELECT NEW.pack_uuid, 1 WHERE NEW.audio_cached_at > 0
                ON CONFLICT(pack_uuid) DO UPDATE
                SET sample_count = sample_count + 1;
            END;

            CREATE INDEX IF NOT EXISTS idx_library_name
                ON samples(name) WHERE audio_cached_at > 0;
            CREATE INDEX IF NOT EXISTS idx_library_pack_name
                ON samples(pack_name) WHERE audio_cached_at > 0;
            CREATE INDEX IF NOT EXISTS idx_library_duration
                ON samples(duration_ms) WHERE audio_cached_at > 0;
            CREATE INDEX IF NOT EXISTS idx_library_popularity
                ON samples(pack_popularity_score DESC, ingested_at DESC)
                WHERE audio_cached_at > 0;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (9)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(10) {
        conn.execute_batch(
            "ALTER TABLE packs ADD COLUMN cover_cached_at INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE samples ADD COLUMN bitrate_kbps INTEGER;
             CREATE INDEX IF NOT EXISTS idx_packs_cover_pending
                 ON packs(uuid) WHERE cover_cached_at = 0 AND cover_source_url IS NOT NULL;
             CREATE INDEX IF NOT EXISTS idx_samples_bitrate_pending
                 ON samples(uuid) WHERE audio_cached_at > 0 AND bitrate_kbps IS NULL;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (10)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(11) {
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_sample_tags_tag_sample
                 ON sample_tags(tag_uuid, sample_uuid);
             DROP INDEX IF EXISTS idx_sample_tags_tag;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (11)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(12) {
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_library_popularity;
             CREATE INDEX idx_library_popularity
                 ON samples(pack_popularity_score DESC, uuid DESC)
                 WHERE audio_cached_at > 0;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (12)", [])
            .map_err(|e| e.to_string())?;
    }
    if !applied(13) {
        conn.execute_batch(
            "ALTER TABLE packs ADD COLUMN popularity_rank INTEGER;
             ALTER TABLE packs ADD COLUMN popularity_observed_at INTEGER;
             CREATE INDEX idx_packs_popularity_rank
                 ON packs(popularity_rank, uuid);
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
             );",
        )
        .map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO schema_migrations (version) VALUES (13)", [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
