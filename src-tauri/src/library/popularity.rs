use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const MAX_OBSERVATIONS_PER_PACK_SCOPE: i64 = 30;
const OBSERVATION_MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS: f64 = 45.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRankObservationInput {
    pub pack_uuid: String,
    pub pack_name: Option<String>,
    pub rank: i32,
    pub observed_at: i64,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPackRanksParams {
    pub scope_key: String,
    pub observations: Vec<PackRankObservationInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPopularityScoresParams {
    pub scope_key: String,
    pub pack_uuids: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPopularityScore {
    pub score: f64,
    pub best_rank: Option<i32>,
    pub observation_count: i32,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialPackRankInput {
    pub pack_uuid: String,
    pub rank: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialPopularityCheckpointParams {
    pub current_page: i64,
    pub packs: Vec<OfficialPackRankInput>,
    pub remote_records: Option<i64>,
    pub reported_pages: Option<i64>,
    pub fingerprint: String,
    pub observed_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialPopularityStatus {
    pub next_page: i64,
    pub listed_count: i64,
    pub remote_records: Option<i64>,
    pub reported_pages: Option<i64>,
    pub done: bool,
    pub stop_reason: Option<String>,
    pub updated_at: i64,
    pub last_completed_at: Option<i64>,
    pub ranked_local_packs: i64,
    pub total_local_packs: i64,
}

pub fn official_popularity_status(conn: &Connection) -> Result<OfficialPopularityStatus, String> {
    conn.query_row(
        "SELECT c.next_page, c.listed_count, c.remote_records, c.reported_pages,
                c.done, c.stop_reason, c.updated_at, c.last_completed_at,
                (SELECT COUNT(*) FROM library_pack_counts l
                   JOIN packs p ON p.uuid = l.pack_uuid
                  WHERE p.popularity_rank IS NOT NULL),
                (SELECT COUNT(*) FROM library_pack_counts)
         FROM pack_popularity_backfill_checkpoint c WHERE c.id = 1",
        [],
        |row| {
            Ok(OfficialPopularityStatus {
                next_page: row.get(0)?,
                listed_count: row.get(1)?,
                remote_records: row.get(2)?,
                reported_pages: row.get(3)?,
                done: row.get(4)?,
                stop_reason: row.get(5)?,
                updated_at: row.get(6)?,
                last_completed_at: row.get(7)?,
                ranked_local_packs: row.get(8)?,
                total_local_packs: row.get(9)?,
            })
        },
    )
    .map_err(|error| error.to_string())
}

pub fn restart_official_popularity(conn: &Connection) -> Result<OfficialPopularityStatus, String> {
    let now = chrono_now_ms();
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE packs SET popularity_rank = NULL, popularity_observed_at = NULL
         WHERE popularity_rank IS NOT NULL OR popularity_observed_at IS NOT NULL",
        [],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE pack_popularity_backfill_checkpoint SET
             next_page = 1, listed_count = 0, remote_records = NULL,
             reported_pages = NULL, last_fingerprint = NULL, done = 0,
             stop_reason = NULL, updated_at = ?1
         WHERE id = 1",
        [now],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    official_popularity_status(conn)
}

pub fn checkpoint_official_popularity(
    conn: &Connection,
    params: OfficialPopularityCheckpointParams,
) -> Result<OfficialPopularityStatus, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    for pack in &params.packs {
        tx.execute(
            "UPDATE packs SET popularity_rank = ?1, popularity_observed_at = ?2
             WHERE uuid = ?3",
            params![pack.rank, params.observed_at, pack.pack_uuid],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.execute(
        "UPDATE pack_popularity_backfill_checkpoint SET
             next_page = ?1, listed_count = listed_count + ?2,
             remote_records = ?3, reported_pages = ?4, last_fingerprint = ?5,
             done = 0, stop_reason = NULL, updated_at = ?6
         WHERE id = 1",
        params![
            params.current_page + 1,
            params.packs.len() as i64,
            params.remote_records,
            params.reported_pages,
            params.fingerprint,
            params.observed_at,
        ],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    official_popularity_status(conn)
}

pub fn finish_official_popularity(
    conn: &Connection,
    reason: String,
) -> Result<OfficialPopularityStatus, String> {
    let now = chrono_now_ms();
    conn.execute(
        "UPDATE pack_popularity_backfill_checkpoint SET
             done = 1, stop_reason = ?1, updated_at = ?2, last_completed_at = ?2
         WHERE id = 1",
        params![reason, now],
    )
    .map_err(|error| error.to_string())?;
    official_popularity_status(conn)
}

pub fn record_pack_ranks(conn: &Connection, params: RecordPackRanksParams) -> Result<(), String> {
    if params.observations.is_empty() {
        return Ok(());
    }

    let mut affected: HashSet<String> = HashSet::new();

    for obs in &params.observations {
        if obs.pack_uuid.is_empty() || obs.rank < 1 {
            continue;
        }
        let pack_name = obs
            .pack_name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Unknown pack");
        conn.execute(
            "INSERT INTO packs (uuid, name) VALUES (?1, ?2)
             ON CONFLICT(uuid) DO UPDATE SET
               name = CASE WHEN excluded.name != 'Unknown pack' THEN excluded.name ELSE packs.name END",
            params![obs.pack_uuid, pack_name],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO pack_rank_observations (pack_uuid, scope_key, rank, observed_at, source)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                obs.pack_uuid,
                params.scope_key,
                obs.rank,
                obs.observed_at,
                obs.source,
            ],
        )
        .map_err(|e| e.to_string())?;

        affected.insert(obs.pack_uuid.clone());
    }

    prune_observations(conn, &params.scope_key, &affected)?;
    for pack_uuid in &affected {
        recompute_pack_score(conn, &params.scope_key, pack_uuid)?;
    }

    Ok(())
}

fn prune_observations(
    conn: &Connection,
    scope_key: &str,
    pack_uuids: &HashSet<String>,
) -> Result<(), String> {
    let now = chrono_now_ms();
    let cutoff = now - OBSERVATION_MAX_AGE_MS;

    for pack_uuid in pack_uuids {
        conn.execute(
            "DELETE FROM pack_rank_observations
             WHERE scope_key = ?1 AND pack_uuid = ?2 AND observed_at < ?3",
            params![scope_key, pack_uuid, cutoff],
        )
        .map_err(|e| e.to_string())?;

        let excess: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pack_rank_observations
                 WHERE scope_key = ?1 AND pack_uuid = ?2",
                params![scope_key, pack_uuid],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        if excess > MAX_OBSERVATIONS_PER_PACK_SCOPE {
            let to_drop = excess - MAX_OBSERVATIONS_PER_PACK_SCOPE;
            conn.execute(
                "DELETE FROM pack_rank_observations WHERE id IN (
                    SELECT id FROM pack_rank_observations
                    WHERE scope_key = ?1 AND pack_uuid = ?2
                    ORDER BY observed_at ASC
                    LIMIT ?3
                )",
                params![scope_key, pack_uuid, to_drop],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn recompute_pack_score(conn: &Connection, scope_key: &str, pack_uuid: &str) -> Result<(), String> {
    let now = chrono_now_ms();
    let mut stmt = conn
        .prepare(
            "SELECT rank, observed_at FROM pack_rank_observations
             WHERE scope_key = ?1 AND pack_uuid = ?2
             ORDER BY observed_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<(i32, i64)> = stmt
        .query_map(params![scope_key, pack_uuid], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|row| row.ok())
        .collect();

    if rows.is_empty() {
        conn.execute(
            "DELETE FROM pack_popularity_scores WHERE pack_uuid = ?1 AND scope_key = ?2",
            params![pack_uuid, scope_key],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let mut weighted_sum = 0.0_f64;
    let mut weight_total = 0.0_f64;
    let mut best_rank: i32 = i32::MAX;

    for (rank, observed_at) in &rows {
        if *rank < best_rank {
            best_rank = *rank;
        }
        let age_days = (now - observed_at).max(0) as f64 / (24.0 * 60.0 * 60.0 * 1000.0);
        let w = (-age_days / HALF_LIFE_DAYS).exp();
        let rank_f = (*rank).max(1) as f64;
        weighted_sum += w / rank_f;
        weight_total += w;
    }

    let score = if weight_total > 0.0 {
        weighted_sum / weight_total
    } else {
        0.0
    };
    let best = if best_rank == i32::MAX {
        None
    } else {
        Some(best_rank)
    };
    let count = rows.len() as i32;

    conn.execute(
        "INSERT INTO pack_popularity_scores
            (pack_uuid, scope_key, score, best_rank, observation_count, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(pack_uuid, scope_key) DO UPDATE SET
            score = excluded.score,
            best_rank = excluded.best_rank,
            observation_count = excluded.observation_count,
            updated_at = excluded.updated_at",
        params![pack_uuid, scope_key, score, best, count, now],
    )
    .map_err(|e| e.to_string())?;

    // Proxy score to cached samples in this pack (global proxy uses same score for scope)
    conn.execute(
        "UPDATE samples SET pack_popularity_score = ?1
         WHERE pack_uuid = ?2 AND audio_cached_at > 0",
        params![score, pack_uuid],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub fn pack_popularity_scores(
    conn: &Connection,
    params: PackPopularityScoresParams,
) -> Result<HashMap<String, PackPopularityScore>, String> {
    let mut out = HashMap::new();

    if let Some(ref uuids) = params.pack_uuids {
        if uuids.is_empty() {
            return Ok(out);
        }
        let placeholders = std::iter::repeat_n("?", uuids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT pack_uuid, score, best_rank, observation_count, updated_at
             FROM pack_popularity_scores
             WHERE scope_key = ? AND pack_uuid IN ({placeholders})"
        );
        let mut sql_params: Vec<rusqlite::types::Value> = vec![params.scope_key.clone().into()];
        sql_params.extend(uuids.iter().map(|u| u.clone().into()));

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(sql_params.iter()))
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let pack_uuid: String = row.get(0).map_err(|e| e.to_string())?;
            out.insert(
                pack_uuid,
                PackPopularityScore {
                    score: row.get(1).map_err(|e| e.to_string())?,
                    best_rank: row.get(2).map_err(|e| e.to_string())?,
                    observation_count: row.get(3).map_err(|e| e.to_string())?,
                    updated_at: row.get(4).map_err(|e| e.to_string())?,
                },
            );
        }
        return Ok(out);
    }

    let mut stmt = conn
        .prepare(
            "SELECT pack_uuid, score, best_rank, observation_count, updated_at
             FROM pack_popularity_scores WHERE scope_key = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![params.scope_key])
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let pack_uuid: String = row.get(0).map_err(|e| e.to_string())?;
        out.insert(
            pack_uuid,
            PackPopularityScore {
                score: row.get(1).map_err(|e| e.to_string())?,
                best_rank: row.get(2).map_err(|e| e.to_string())?,
                observation_count: row.get(3).map_err(|e| e.to_string())?,
                updated_at: row.get(4).map_err(|e| e.to_string())?,
            },
        );
    }
    Ok(out)
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::schema::migrate;
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn rank_aggregation_orders_by_better_rank() {
        let conn = test_conn();
        let now = chrono_now_ms();
        let scope = "packs|tags:|sort:popularity";

        record_pack_ranks(
            &conn,
            RecordPackRanksParams {
                scope_key: scope.into(),
                observations: vec![
                    PackRankObservationInput {
                        pack_uuid: "pack-a".into(),
                        pack_name: Some("A".into()),
                        rank: 20,
                        observed_at: now - 1_000,
                        source: Some("test".into()),
                    },
                    PackRankObservationInput {
                        pack_uuid: "pack-b".into(),
                        pack_name: Some("B".into()),
                        rank: 1,
                        observed_at: now,
                        source: Some("test".into()),
                    },
                ],
            },
        )
        .unwrap();

        let scores = pack_popularity_scores(
            &conn,
            PackPopularityScoresParams {
                scope_key: scope.into(),
                pack_uuids: None,
            },
        )
        .unwrap();

        let a = scores.get("pack-a").unwrap().score;
        let b = scores.get("pack-b").unwrap().score;
        assert!(b > a, "rank 1 should score higher than rank 20");

        conn.execute(
            "INSERT INTO samples (uuid, pack_uuid, name, display_name, relative_audio_path,
             duration_ms, asset_category_slug, audio_cached_at, ingested_at, pack_name)
             VALUES ('s1', 'pack-b', 'n', 'd', 'p/s.mp3', 1, 'oneshot', 1, 1, 'B')",
            [],
        )
        .unwrap();
        recompute_pack_score(&conn, scope, "pack-b").unwrap();
        let proxy: Option<f64> = conn
            .query_row(
                "SELECT pack_popularity_score FROM samples WHERE uuid = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(proxy.is_some());
        assert!((proxy.unwrap() - b).abs() < 1e-9);
    }

    #[test]
    fn official_sync_checkpoints_local_pack_and_records_completion() {
        let conn = test_conn();
        conn.execute("INSERT INTO packs (uuid, name) VALUES ('pack-a', 'A')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO samples (uuid, pack_uuid, name, display_name, relative_audio_path,
             duration_ms, asset_category_slug, audio_cached_at, ingested_at, pack_name)
             VALUES ('s1', 'pack-a', 'n', 'd', 'p/s.mp3', 1, 'oneshot', 1, 1, 'A')",
            [],
        )
        .unwrap();

        let initial = restart_official_popularity(&conn).unwrap();
        assert_eq!(initial.next_page, 1);
        assert_eq!(initial.total_local_packs, 1);

        let checkpoint = checkpoint_official_popularity(
            &conn,
            OfficialPopularityCheckpointParams {
                current_page: 1,
                packs: vec![OfficialPackRankInput {
                    pack_uuid: "pack-a".into(),
                    rank: 7,
                }],
                remote_records: Some(10_000),
                reported_pages: Some(100),
                fingerprint: "a:z".into(),
                observed_at: 123,
            },
        )
        .unwrap();
        assert_eq!(checkpoint.next_page, 2);
        assert_eq!(checkpoint.listed_count, 1);
        assert_eq!(checkpoint.ranked_local_packs, 1);
        assert_eq!(
            conn.query_row(
                "SELECT popularity_rank FROM packs WHERE uuid = 'pack-a'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            7
        );

        let finished = finish_official_popularity(&conn, "empty_page".into()).unwrap();
        assert!(finished.done);
        assert_eq!(finished.stop_reason.as_deref(), Some("empty_page"));
        assert!(finished.last_completed_at.is_some());
    }
}
