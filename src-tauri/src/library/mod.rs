mod popularity;
mod schema;

use rusqlite::{params, Connection, OptionalExtension};
use schema::migrate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub struct LibraryState {
    conn: Mutex<Option<Connection>>,
}

impl Default for LibraryState {
    fn default() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
}

fn with_conn<F, T>(state: &LibraryState, f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("Library database is not open")?;
    f(conn)
}

fn db_path(samples_dir: &str) -> PathBuf {
    PathBuf::from(samples_dir).join(".splicerr").join("library.db")
}

/// Match UI key labels (`C`, `F#`, …). Splice often sends lowercase.
fn normalize_key(key: Option<&str>) -> Option<String> {
    key.and_then(|k| {
        let k = k.trim();
        if k.is_empty() {
            None
        } else {
            Some(k.to_uppercase())
        }
    })
}

fn normalize_chord_type(chord_type: Option<&str>) -> Option<String> {
    chord_type.and_then(|c| {
        let c = c.trim().to_lowercase();
        if c.is_empty() {
            None
        } else {
            Some(c)
        }
    })
}

#[tauri::command]
pub fn library_open(state: State<LibraryState>, samples_dir: String) -> Result<(), String> {
    let path = db_path(&samples_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    *guard = Some(conn);
    Ok(())
}

#[tauri::command]
pub fn library_close(state: State<LibraryState>) -> Result<(), String> {
    let mut guard = state.conn.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertPayload {
    pub asset: serde_json::Value,
    pub relative_audio_path: String,
    pub waveform_relative_path: Option<String>,
    pub audio_cached_at: i64,
    pub favorite: Option<bool>,
}

#[tauri::command]
pub fn library_upsert_from_asset(
    state: State<LibraryState>,
    payload: UpsertPayload,
) -> Result<(), String> {
    with_conn(&state, |conn| ingest::upsert(conn, payload))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySampleFlags {
    pub in_library: bool,
    pub favorite: bool,
}

#[tauri::command]
pub fn library_batch_flags(
    state: State<LibraryState>,
    uuids: Vec<String>,
) -> Result<HashMap<String, LibrarySampleFlags>, String> {
    with_conn(&state, |conn| batch_flags_for_uuids(conn, &uuids))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackMirrorStats {
    pub cached: i64,
    pub listable_total: Option<i64>,
}

#[tauri::command(rename_all = "camelCase")]
pub fn library_pack_cached_counts(
    state: State<LibraryState>,
    pack_uuids: Vec<String>,
) -> Result<HashMap<String, i64>, String> {
    with_conn(&state, |conn| pack_cached_counts(conn, &pack_uuids))
}

#[tauri::command(rename_all = "camelCase")]
pub fn library_pack_mirror_stats(
    state: State<LibraryState>,
    pack_uuids: Vec<String>,
) -> Result<HashMap<String, PackMirrorStats>, String> {
    with_conn(&state, |conn| pack_mirror_stats(conn, &pack_uuids))
}

#[tauri::command(rename_all = "camelCase")]
pub fn library_set_pack_listable_total(
    state: State<LibraryState>,
    pack_uuid: String,
    total: i64,
) -> Result<(), String> {
    with_conn(&state, |conn| set_pack_listable_total(conn, &pack_uuid, total))
}

#[tauri::command(rename_all = "camelCase")]
pub fn library_record_pack_ranks(
    state: State<LibraryState>,
    params: popularity::RecordPackRanksParams,
) -> Result<(), String> {
    with_conn(&state, |conn| popularity::record_pack_ranks(conn, params))
}

#[tauri::command(rename_all = "camelCase")]
pub fn library_pack_popularity_scores(
    state: State<LibraryState>,
    params: popularity::PackPopularityScoresParams,
) -> Result<HashMap<String, popularity::PackPopularityScore>, String> {
    with_conn(&state, |conn| popularity::pack_popularity_scores(conn, params))
}

fn pack_cached_counts(
    conn: &Connection,
    pack_uuids: &[String],
) -> Result<HashMap<String, i64>, String> {
    let mut out: HashMap<String, i64> = pack_uuids
        .iter()
        .map(|uuid| (uuid.clone(), 0))
        .collect();
    if pack_uuids.is_empty() {
        return Ok(out);
    }
    let placeholders = std::iter::repeat_n("?", pack_uuids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT pack_uuid, COUNT(*) FROM samples WHERE pack_uuid IN ({placeholders}) AND audio_cached_at > 0 GROUP BY pack_uuid"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(pack_uuids.iter()))
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let pack_uuid: String = row.get(0).map_err(|e| e.to_string())?;
        let count: i64 = row.get(1).map_err(|e| e.to_string())?;
        out.insert(pack_uuid, count);
    }
    Ok(out)
}

fn pack_mirror_stats(
    conn: &Connection,
    pack_uuids: &[String],
) -> Result<HashMap<String, PackMirrorStats>, String> {
    let cached = pack_cached_counts(conn, pack_uuids)?;
    let mut listable: HashMap<String, Option<i64>> = pack_uuids
        .iter()
        .map(|u| (u.clone(), None))
        .collect();
    if !pack_uuids.is_empty() {
        let placeholders = std::iter::repeat_n("?", pack_uuids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT uuid, listable_sample_total FROM packs WHERE uuid IN ({placeholders})"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(pack_uuids.iter()))
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let uuid: String = row.get(0).map_err(|e| e.to_string())?;
            let total: Option<i64> = row.get(1).map_err(|e| e.to_string())?;
            listable.insert(uuid, total);
        }
    }
    Ok(pack_uuids
        .iter()
        .map(|uuid| {
            (
                uuid.clone(),
                PackMirrorStats {
                    cached: *cached.get(uuid).unwrap_or(&0),
                    listable_total: listable.get(uuid).copied().flatten(),
                },
            )
        })
        .collect())
}

fn set_pack_listable_total(
    conn: &Connection,
    pack_uuid: &str,
    total: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO packs (uuid, name, listable_sample_total) VALUES (?1, 'Unknown pack', ?2)
         ON CONFLICT(uuid) DO UPDATE SET listable_sample_total = excluded.listable_sample_total",
        rusqlite::params![pack_uuid, total],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn batch_flags_for_uuids(
    conn: &Connection,
    uuids: &[String],
) -> Result<HashMap<String, LibrarySampleFlags>, String> {
    let mut out: HashMap<String, LibrarySampleFlags> = uuids
        .iter()
        .map(|uuid| {
            (
                uuid.clone(),
                LibrarySampleFlags {
                    in_library: false,
                    favorite: false,
                },
            )
        })
        .collect();

    if uuids.is_empty() {
        return Ok(out);
    }

    let placeholders = std::iter::repeat_n("?", uuids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT uuid, audio_cached_at, favorite FROM samples WHERE uuid IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(uuids.iter()))
        .map_err(|e| e.to_string())?;

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let uuid: String = row.get(0).map_err(|e| e.to_string())?;
        let cached: i64 = row.get(1).map_err(|e| e.to_string())?;
        let fav: i32 = row.get(2).map_err(|e| e.to_string())?;
        out.insert(
            uuid,
            LibrarySampleFlags {
                in_library: cached > 0,
                favorite: fav != 0,
            },
        );
    }

    Ok(out)
}

#[tauri::command(rename_all = "camelCase")]
pub fn library_set_favorite(
    state: State<LibraryState>,
    uuid: String,
    favorite: bool,
    asset: Option<serde_json::Value>,
    relative_audio_path: Option<String>,
) -> Result<(), String> {
    with_conn(&state, |conn| {
        let updated = conn
            .execute(
                "UPDATE samples SET favorite = ?1 WHERE uuid = ?2",
                params![i32::from(favorite), uuid],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            if let (Some(asset), Some(path)) = (asset, relative_audio_path) {
                ingest::upsert(
                    conn,
                    UpsertPayload {
                        asset,
                        relative_audio_path: path,
                        waveform_relative_path: None,
                        audio_cached_at: 0,
                        favorite: Some(favorite),
                    },
                )?;
            } else {
                return Err("Sample not in library".into());
            }
        }
        Ok(())
    })
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySearchParams {
    pub query: Option<String>,
    pub tags: Vec<String>,
    pub page: i32,
    pub limit: i32,
    pub sort: String,
    pub order: String,
    pub favorites_only: bool,
    pub asset_category_slug: Option<String>,
    pub key: Option<String>,
    pub chord_type: Option<String>,
    pub min_bpm: Option<i32>,
    pub max_bpm: Option<i32>,
    pub bpm: Option<String>,
    pub pack_uuid: Option<String>,
    pub samples_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListPacksParams {
    pub query: Option<String>,
    pub samples_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackListEntry {
    pub uuid: String,
    pub name: String,
    pub cover_relative_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySearchResponse {
    pub items: Vec<serde_json::Value>,
    pub total_records: i64,
    pub tag_summary: Vec<TagSummaryEntry>,
}

#[derive(Debug, Serialize)]
pub struct TagSummaryEntry {
    pub count: i64,
    pub tag: serde_json::Value,
    #[serde(rename = "__typename")]
    pub typename: String,
}

#[tauri::command]
pub fn library_search(
    state: State<LibraryState>,
    params: LibrarySearchParams,
) -> Result<LibrarySearchResponse, String> {
    with_conn(&state, |conn| search::search(conn, params))
}

#[tauri::command]
pub fn library_tag_summary(
    state: State<LibraryState>,
    params: LibrarySearchParams,
) -> Result<Vec<TagSummaryEntry>, String> {
    with_conn(&state, |conn| search::tag_summary(conn, params))
}

#[tauri::command]
pub fn library_list_packs(
    state: State<LibraryState>,
    params: LibraryListPacksParams,
) -> Result<Vec<PackListEntry>, String> {
    with_conn(&state, |conn| search::list_packs(conn, &params))
}

fn pack_cover_source_url_from_json(pack: &serde_json::Value) -> Option<String> {
    let files = pack.get("files")?.as_array()?;
    for f in files {
        let slug = f
            .get("asset_file_type_slug")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        if slug == "cover_image" || slug == "generated_cover_image" {
            if let Some(url) = f.get("url").and_then(|u| u.as_str()) {
                if url.starts_with("http://") || url.starts_with("https://") {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

mod ingest {
    use super::*;

    pub fn upsert(conn: &Connection, payload: UpsertPayload) -> Result<(), String> {
        let asset = &payload.asset;
        let uuid = asset["uuid"].as_str().ok_or("missing uuid")?;
        let name = asset["name"].as_str().ok_or("missing name")?;
        let pack_value = asset["parents"]["items"][0].clone();
        let pack = pack_value.as_object().ok_or("missing pack")?;
        let pack_uuid = pack["uuid"].as_str().ok_or("missing pack uuid")?;
        let pack_name = pack["name"].as_str().ok_or("missing pack name")?;
        let duration_ms = asset["duration"].as_i64().unwrap_or(0);
        let bpm = asset["bpm"].as_i64();
        let key = normalize_key(asset["key"].as_str());
        let chord_type = normalize_chord_type(asset["chord_type"].as_str());
        let category = asset["asset_category_slug"]
            .as_str()
            .ok_or("missing category")?;
        let display_name = name.rsplit('/').next().unwrap_or(name).to_string();
        let favorite_set = payload.favorite.map(|f| i32::from(f));
        let now = chrono_now_ms();

        let existing_path: Option<String> = conn
            .query_row(
                "SELECT relative_audio_path FROM samples WHERE uuid = ?1",
                params![uuid],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;

        if existing_path.is_none() {
            let other_uuid: Option<String> = conn
                .query_row(
                    "SELECT uuid FROM samples WHERE relative_audio_path = ?1 AND uuid != ?2",
                    params![payload.relative_audio_path, uuid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if other_uuid.is_some() {
                return Err("Audio path already used by another sample".into());
            }
        }

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        let cover_rel = format!("{}/cover.jpg", sanitize_path_segment(pack_name));
        let cover_source_url = pack_cover_source_url_from_json(&pack_value);
        tx.execute(
            "INSERT INTO packs (uuid, name, cover_relative_path, cover_source_url) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(uuid) DO UPDATE SET name = excluded.name,
             cover_relative_path = COALESCE(excluded.cover_relative_path, packs.cover_relative_path),
             cover_source_url = COALESCE(excluded.cover_source_url, packs.cover_source_url)",
            params![pack_uuid, pack_name, cover_rel, cover_source_url],
        )
        .map_err(|e| e.to_string())?;

        let audio_cached = if payload.audio_cached_at > 0 {
            payload.audio_cached_at
        } else {
            0
        };
        let ingested = now;

        tx.execute(
            "INSERT INTO samples (
                uuid, pack_uuid, name, display_name, relative_audio_path,
                duration_ms, bpm, key, chord_type, asset_category_slug,
                favorite, audio_cached_at, ingested_at, pack_name, waveform_relative_path
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
            ON CONFLICT(uuid) DO UPDATE SET
                pack_uuid = excluded.pack_uuid,
                name = excluded.name,
                display_name = excluded.display_name,
                relative_audio_path = excluded.relative_audio_path,
                duration_ms = excluded.duration_ms,
                bpm = excluded.bpm,
                key = excluded.key,
                chord_type = excluded.chord_type,
                asset_category_slug = excluded.asset_category_slug,
                audio_cached_at = CASE WHEN excluded.audio_cached_at > 0 THEN excluded.audio_cached_at ELSE samples.audio_cached_at END,
                pack_name = excluded.pack_name,
                waveform_relative_path = COALESCE(excluded.waveform_relative_path, samples.waveform_relative_path)",
            params![
                uuid,
                pack_uuid,
                name,
                display_name,
                payload.relative_audio_path,
                duration_ms,
                bpm,
                key,
                chord_type,
                category,
                favorite_set.unwrap_or(0),
                audio_cached,
                ingested,
                pack_name,
                payload.waveform_relative_path,
            ],
        )
        .map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM sample_tags WHERE sample_uuid = ?1",
            params![uuid],
        )
        .map_err(|e| e.to_string())?;

        if let Some(tags) = asset["tags"].as_array() {
            for tag in tags {
                let tag_uuid = tag["uuid"].as_str().ok_or("tag uuid")?;
                let label = tag["label"].as_str().ok_or("tag label")?;
                tx.execute(
                    "INSERT INTO tags (uuid, label) VALUES (?1, ?2)
                     ON CONFLICT(uuid) DO UPDATE SET label = excluded.label",
                    params![tag_uuid, label],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT OR IGNORE INTO sample_tags (sample_uuid, tag_uuid) VALUES (?1, ?2)",
                    params![uuid, tag_uuid],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        tx.execute(
            "DELETE FROM samples_fts WHERE sample_uuid = ?1",
            params![uuid],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO samples_fts (sample_uuid, name, display_name, pack_name)
             VALUES (?1, ?2, ?3, ?4)",
            params![uuid, name, display_name, pack_name],
        )
        .map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    fn sanitize_path_segment(s: &str) -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "#_-/.".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    }
}

mod search {
    use super::*;
    use rusqlite::types::Value;

    pub fn search(conn: &Connection, params: LibrarySearchParams) -> Result<LibrarySearchResponse, String> {
        let (where_sql, where_params) = build_filter(&params)?;
        let total: i64 = query_scalar(conn, &format!("SELECT COUNT(*) FROM samples s WHERE {}", where_sql), &where_params)?;

        let order = if params.order.eq_ignore_ascii_case("ASC") {
            "ASC"
        } else {
            "DESC"
        };
        let offset = (params.page.max(1) - 1) * params.limit.max(1);
        let sql = if params.sort == "pack_popularity" {
            format!(
                "SELECT s.uuid FROM samples s WHERE {} ORDER BY s.pack_popularity_score IS NULL, s.pack_popularity_score {} , s.ingested_at DESC LIMIT {} OFFSET {}",
                where_sql,
                if order == "ASC" { "ASC" } else { "DESC" },
                params.limit,
                offset
            )
        } else {
            let sort_col = match params.sort.as_str() {
                "bpm" => "s.bpm",
                "duration" => "s.duration_ms",
                "key" => "s.key",
                "ingested_at" => "s.ingested_at",
                "pack_name" => "s.pack_name",
                _ => "s.name",
            };
            format!(
                "SELECT s.uuid FROM samples s WHERE {} ORDER BY {} {} LIMIT {} OFFSET {}",
                where_sql, sort_col, order, params.limit, offset
            )
        };

        let uuids: Vec<String> = query_rows(conn, &sql, &where_params, |r| r.get(0))?;

        let items: Vec<serde_json::Value> = uuids
            .iter()
            .filter_map(|uuid| row_to_asset(conn, uuid, &params.samples_dir).ok())
            .collect();

        let tag_summary = tag_summary(conn, params.clone())?;

        Ok(LibrarySearchResponse {
            items,
            total_records: total,
            tag_summary,
        })
    }

    pub fn tag_summary(conn: &Connection, params: LibrarySearchParams) -> Result<Vec<TagSummaryEntry>, String> {
        let (where_sql, where_params) = build_filter(&params)?;
        let sql = format!(
            "SELECT t.uuid, t.label, COUNT(DISTINCT s.uuid) as cnt
             FROM samples s
             INNER JOIN sample_tags st ON st.sample_uuid = s.uuid
             INNER JOIN tags t ON t.uuid = st.tag_uuid
             WHERE {}
             GROUP BY t.uuid, t.label
             ORDER BY cnt DESC
             LIMIT 200",
            where_sql
        );
        query_rows(conn, &sql, &where_params, |r| {
            let uuid: String = r.get(0)?;
            let label: String = r.get(1)?;
            let count: i64 = r.get(2)?;
            Ok(TagSummaryEntry {
                count,
                tag: serde_json::json!({
                    "uuid": uuid,
                    "label": label,
                    "taxonomy": {
                        "uuid": "",
                        "name": "Library",
                        "__typename": "Taxonomy"
                    },
                    "__typename": "Tag"
                }),
                typename: "TagSummaryEntry".into(),
            })
        })
    }

    fn param_refs(params: &[Value]) -> Vec<&dyn rusqlite::ToSql> {
        params.iter().map(|v| v as &dyn rusqlite::ToSql).collect()
    }

    fn query_scalar<T: rusqlite::types::FromSql>(
        conn: &Connection,
        sql: &str,
        params: &[Value],
    ) -> Result<T, String> {
        let refs = param_refs(params);
        conn.query_row(sql, refs.as_slice(), |r| r.get(0))
            .map_err(|e| e.to_string())
    }

    fn query_rows<T, F>(conn: &Connection, sql: &str, params: &[Value], f: F) -> Result<Vec<T>, String>
    where
        F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    {
        let refs = param_refs(params);
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(refs.as_slice(), f)
            .map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    fn build_filter(params: &LibrarySearchParams) -> Result<(String, Vec<Value>), String> {
        let mut clauses = vec!["s.audio_cached_at > 0".to_string()];
        let mut sql_params: Vec<Value> = vec![];

        if params.favorites_only {
            clauses.push("s.favorite = 1".to_string());
        }
        if let Some(ref cat) = params.asset_category_slug {
            clauses.push("s.asset_category_slug = ?".to_string());
            sql_params.push(cat.clone().into());
        }
        if let Some(ref k) = params.key {
            if let Some(nk) = normalize_key(Some(k.as_str())) {
                clauses.push("s.key = ?".to_string());
                sql_params.push(nk.into());
            }
        }
        if let Some(ref ct) = params.chord_type {
            if let Some(nct) = normalize_chord_type(Some(ct.as_str())) {
                clauses.push("s.chord_type = ?".to_string());
                sql_params.push(nct.into());
            }
        }
        if let Some(min) = params.min_bpm {
            clauses.push("s.bpm >= ?".to_string());
            sql_params.push(min.into());
        }
        if let Some(max) = params.max_bpm {
            clauses.push("s.bpm <= ?".to_string());
            sql_params.push(max.into());
        }
        if let Some(ref bpm) = params.bpm {
            if let Ok(n) = bpm.parse::<i32>() {
                clauses.push("s.bpm = ?".to_string());
                sql_params.push(n.into());
            }
        }
        for tag in &params.tags {
            clauses.push(
                "EXISTS (SELECT 1 FROM sample_tags st WHERE st.sample_uuid = s.uuid AND st.tag_uuid = ?)"
                    .to_string(),
            );
            sql_params.push(tag.clone().into());
        }
        if let Some(ref q) = params.query {
            let trimmed = q.trim();
            if !trimmed.is_empty() {
                clauses.push(
                    "s.uuid IN (SELECT sample_uuid FROM samples_fts WHERE samples_fts MATCH ?)"
                        .to_string(),
                );
                let fts_q = trimmed
                    .split_whitespace()
                    .map(|w| format!("\"{}\"", w.replace('"', "")))
                    .collect::<Vec<_>>()
                    .join(" ");
                sql_params.push(fts_q.into());
            }
        }
        if let Some(ref pack_uuid) = params.pack_uuid {
            clauses.push("s.pack_uuid = ?".to_string());
            sql_params.push(pack_uuid.clone().into());
        }

        Ok((clauses.join(" AND "), sql_params))
    }

    pub fn list_packs(
        conn: &Connection,
        params: &LibraryListPacksParams,
    ) -> Result<Vec<PackListEntry>, String> {
        let mut clauses = vec![
            "EXISTS (SELECT 1 FROM samples s WHERE s.pack_uuid = p.uuid AND s.audio_cached_at > 0)"
                .to_string(),
        ];
        let mut sql_params: Vec<Value> = vec![];
        if let Some(ref q) = params.query {
            let trimmed = q.trim();
            if !trimmed.is_empty() {
                clauses.push("LOWER(p.name) LIKE LOWER(?)".to_string());
                sql_params.push(format!("%{}%", trimmed).into());
            }
        }
        let sql = format!(
            "SELECT p.uuid, p.name, p.cover_relative_path FROM packs p WHERE {} ORDER BY p.name COLLATE NOCASE LIMIT 80",
            clauses.join(" AND ")
        );
        query_rows(conn, &sql, &sql_params, |r| {
            Ok(PackListEntry {
                uuid: r.get(0)?,
                name: r.get(1)?,
                cover_relative_path: r.get(2)?,
            })
        })
    }

    fn row_to_asset(
        conn: &Connection,
        uuid: &str,
        samples_dir: &str,
    ) -> Result<serde_json::Value, String> {
        type RowData = (
            String,
            String,
            String,
            i64,
            Option<i64>,
            Option<String>,
            Option<String>,
            String,
            i32,
            Option<String>,
            String,
            String,
            Option<String>,
            Option<String>,
        );

        let row: RowData = conn
            .query_row(
                "SELECT s.uuid, s.name, s.relative_audio_path, s.duration_ms, s.bpm, s.key, s.chord_type,
                        s.asset_category_slug, s.favorite, s.waveform_relative_path,
                        p.uuid, p.name, p.cover_relative_path, p.cover_source_url
                 FROM samples s
                 JOIN packs p ON p.uuid = s.pack_uuid
                 WHERE s.uuid = ?1",
                params![uuid],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                        r.get(10)?,
                        r.get(11)?,
                        r.get(12)?,
                        r.get(13)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;

        let (
            uuid,
            name,
            audio_rel,
            duration,
            bpm,
            key,
            chord_type,
            category,
            _favorite,
            waveform_rel,
            pack_uuid,
            pack_name,
            cover_rel,
            cover_source_url,
        ) = row;

        let audio_abs = PathBuf::from(samples_dir).join(&audio_rel);
        let audio_url = format!("file://{}", audio_abs.display());
        let waveform_url = waveform_rel.map(|w| {
            format!(
                "file://{}",
                PathBuf::from(samples_dir).join(w).display()
            )
        });
        let cover_url = cover_rel.map(|cover_rel| {
            format!(
                "file://{}",
                PathBuf::from(samples_dir).join(cover_rel).display()
            )
        }).unwrap_or_default();

        let tags: Vec<serde_json::Value> = conn
            .prepare(
                "SELECT t.uuid, t.label FROM tags t
                 INNER JOIN sample_tags st ON st.tag_uuid = t.uuid
                 WHERE st.sample_uuid = ?1",
            )
            .map_err(|e| e.to_string())?
            .query_map(params![uuid], |r| {
                Ok(serde_json::json!({
                    "uuid": r.get::<_, String>(0)?,
                    "label": r.get::<_, String>(1)?,
                    "__typename": "Tag"
                }))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let wf = waveform_url.unwrap_or_else(|| "".to_string());

        Ok(serde_json::json!({
            "uuid": uuid,
            "name": name,
            "duration": duration,
            "bpm": bpm,
            "key": key,
            "chord_type": chord_type,
            "asset_category_slug": category,
            "favorite": _favorite != 0,
            "asset_type_slug": "sample",
            "asset_prices": [],
            "__typename": "SampleAsset",
            "tags": tags,
            "files": [
                { "url": audio_url, "__typename": "AssetFile" },
                { "url": wf, "__typename": "AssetFile" }
            ],
            "parents": {
                "items": [{
                    "uuid": pack_uuid,
                    "name": pack_name,
                    "permalink_slug": "",
                    "permalink_base_url": "",
                    "cover_source_url": cover_source_url,
                    "files": [{ "url": cover_url, "asset_file_type_slug": "cover_image", "__typename": "AssetFile" }],
                    "__typename": "PackAsset"
                }],
                "__typename": "AssetPage"
            }
        }))
    }
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

    #[test]
    fn ingest_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_path(dir.path().to_str().unwrap());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        migrate(&conn).unwrap();

        let asset = serde_json::json!({
            "uuid": "sample-1",
            "name": "pack/kick.mp3",
            "duration": 1000,
            "bpm": 120,
            "key": "C",
            "chord_type": "major",
            "asset_category_slug": "oneshot",
            "tags": [{ "uuid": "t1", "label": "Kick", "__typename": "Tag" }],
            "parents": {
                "items": [{
                    "uuid": "pack-1",
                    "name": "My Pack",
                    "files": [],
                    "__typename": "PackAsset"
                }]
            }
        });

        ingest::upsert(
            &conn,
            UpsertPayload {
                asset,
                relative_audio_path: "My_Pack/kick.mp3".into(),
                waveform_relative_path: None,
                audio_cached_at: 1,
                favorite: Some(false),
            },
        )
        .unwrap();

        let res = search::search(
            &conn,
            LibrarySearchParams {
                query: Some("kick".into()),
                tags: vec![],
                page: 1,
                limit: 50,
                sort: "name".into(),
                order: "DESC".into(),
                favorites_only: false,
                asset_category_slug: None,
                key: None,
                chord_type: None,
                min_bpm: None,
                max_bpm: None,
                bpm: None,
                pack_uuid: None,
                samples_dir: dir.path().to_str().unwrap().into(),
            },
        )
        .unwrap();
        assert_eq!(res.total_records, 1);

        let by_key = search::search(
            &conn,
            LibrarySearchParams {
                query: None,
                tags: vec![],
                page: 1,
                limit: 50,
                sort: "name".into(),
                order: "DESC".into(),
                favorites_only: false,
                asset_category_slug: None,
                key: Some("C".into()),
                chord_type: Some("major".into()),
                min_bpm: None,
                max_bpm: None,
                bpm: None,
                pack_uuid: None,
                samples_dir: dir.path().to_str().unwrap().into(),
            },
        )
        .unwrap();
        assert_eq!(by_key.total_records, 1);
    }
}
