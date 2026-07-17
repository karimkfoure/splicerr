mod popularity;
mod schema;

use rusqlite::{params, Connection, OptionalExtension};
use schema::migrate;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::sync::Semaphore;

pub struct LibraryState {
    conn: Arc<Mutex<Option<Connection>>>,
}

impl Default for LibraryState {
    fn default() -> Self {
        Self {
            conn: Arc::new(Mutex::new(None)),
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
    PathBuf::from(samples_dir)
        .join(".splicerr")
        .join("library.db")
}

fn open_read_conn(samples_dir: &str) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        db_path(samples_dir),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA query_only=ON; PRAGMA busy_timeout=3000;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeBatchItem {
    pub asset: serde_json::Value,
    pub relative_audio_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeBatchResult {
    pub saved: usize,
    pub already_cached: usize,
    pub failed: usize,
    pub failures: Vec<String>,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn library_materialize_batch(
    state: State<'_, LibraryState>,
    samples_dir: String,
    items: Vec<MaterializeBatchItem>,
    concurrency: usize,
) -> Result<MaterializeBatchResult, String> {
    if items.is_empty() {
        return Ok(MaterializeBatchResult {
            saved: 0,
            already_cached: 0,
            failed: 0,
            failures: Vec::new(),
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let concurrency = concurrency.clamp(1, 32);
    let limiter = std::sync::Arc::new(Semaphore::new(concurrency));
    let base = PathBuf::from(samples_dir);

    let mut tasks = tokio::task::JoinSet::new();
    for item in items {
        let permit = limiter
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?;
        let client = client.clone();
        let base = base.clone();
        tasks.spawn(async move {
            let _permit = permit;
            materialize_one(&client, &base, item).await
        });
    }

    let mut saved_payloads = Vec::new();
    let mut saved = 0;
    let mut already_cached = 0;
    let mut failures = Vec::new();

    while let Some(result) = tasks.join_next().await {
        match result {
            Ok(Ok(done)) => {
                if done.wrote_new_audio {
                    saved += 1;
                } else {
                    already_cached += 1;
                }
                saved_payloads.push(done.payload);
            }
            Ok(Err(e)) => failures.push(e),
            Err(e) => failures.push(e.to_string()),
        }
    }

    if !saved_payloads.is_empty() {
        with_conn(&state, |conn| {
            for payload in saved_payloads {
                ingest::upsert(conn, payload)?;
            }
            Ok(())
        })?;
    }

    Ok(MaterializeBatchResult {
        saved,
        already_cached,
        failed: failures.len(),
        failures: failures.into_iter().take(50).collect(),
    })
}

struct MaterializedOne {
    wrote_new_audio: bool,
    payload: UpsertPayload,
}

async fn materialize_one(
    client: &reqwest::Client,
    samples_dir: &Path,
    item: MaterializeBatchItem,
) -> Result<MaterializedOne, String> {
    let uuid = item
        .asset
        .get("uuid")
        .and_then(|v| v.as_str())
        .unwrap_or("(missing uuid)")
        .to_string();
    let path = samples_dir.join(&item.relative_audio_path);
    let mut wrote_new_audio = false;

    if !path.exists() {
        let url = item
            .asset
            .get("files")
            .and_then(|v| v.as_array())
            .and_then(|files| files.first())
            .and_then(|file| file.get("url"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{uuid}: missing audio url"))?;

        let response = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("{uuid}: download failed: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("{uuid}: download HTTP {}", response.status()));
        }
        let mut bytes = response
            .bytes()
            .await
            .map_err(|e| format!("{uuid}: reading body failed: {e}"))?
            .to_vec();
        descramble_sample(&mut bytes).map_err(|e| format!("{uuid}: {e}"))?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("{uuid}: mkdir failed: {e}"))?;
        }
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| format!("{uuid}: write failed: {e}"))?;
        wrote_new_audio = true;
    }

    Ok(MaterializedOne {
        wrote_new_audio,
        payload: UpsertPayload {
            asset: item.asset,
            relative_audio_path: item.relative_audio_path,
            waveform_relative_path: None,
            audio_cached_at: chrono_now_ms(),
            favorite: None,
        },
    })
}

fn descramble_sample(data: &mut Vec<u8>) -> Result<(), String> {
    if data.len() < 28 {
        return Err("scrambled sample is too short".into());
    }
    let data_size = data[2..10]
        .iter()
        .enumerate()
        .fold(0usize, |acc, (index, byte)| {
            acc + (*byte as usize) * 256usize.pow(index as u32)
        });
    let encoding_block = data[10..28].to_vec();
    if encoding_block.is_empty() {
        return Err("missing encoding block".into());
    }

    let audio_data = &mut data[28..];
    let pass_index = descramble_pass(0, audio_data, &encoding_block, data_size) + data_size;
    descramble_pass(
        pass_index,
        audio_data,
        &encoding_block,
        pass_index + data_size,
    );
    data.drain(0..28);
    Ok(())
}

fn descramble_pass(
    mut start_index: usize,
    data: &mut [u8],
    encoding_block: &[u8],
    data_size: usize,
) -> usize {
    let mut encoding_index = 0usize;
    while start_index < data_size && start_index < data.len() {
        data[start_index] ^= encoding_block[encoding_index];
        start_index += 1;
        encoding_index = (encoding_index + 1) % encoding_block.len();
    }
    start_index
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
    with_conn(&state, |conn| {
        set_pack_listable_total(conn, &pack_uuid, total)
    })
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
    with_conn(&state, |conn| {
        popularity::pack_popularity_scores(conn, params)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStartParams {
    pub filters_json: String,
    pub sort: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorPackInput {
    pub uuid: String,
    pub name: String,
    pub rank: i64,
    pub listable_total: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MirrorPackRow {
    pub job_id: i64,
    pub pack_uuid: String,
    pub pack_name: String,
    pub rank: i64,
    pub status: String,
    pub cursor: Option<String>,
    pub listable_total: Option<i64>,
    pub cached_count: i64,
    pub listed_count: i64,
    pub saved_count: i64,
    pub failed_count: i64,
    pub attempts: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSummary {
    pub job_id: Option<i64>,
    pub status: String,
    pub total_packs: i64,
    pub queued_packs: i64,
    pub running_packs: i64,
    pub completed_packs: i64,
    pub failed_packs: i64,
    pub total_samples: i64,
    pub cached_samples: i64,
    pub session_saved: i64,
    pub current_pack_uuid: Option<String>,
    pub current_pack_name: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorCheckpointParams {
    pub job_id: i64,
    pub pack_uuid: String,
    pub cursor: Option<String>,
    pub listable_total: Option<i64>,
    pub listed_delta: i64,
    pub saved_delta: i64,
    pub failed_delta: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorPackFinishParams {
    pub job_id: i64,
    pub pack_uuid: String,
    pub listable_total: Option<i64>,
    pub error: Option<String>,
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_start_or_resume(
    state: State<LibraryState>,
    params: MirrorStartParams,
) -> Result<MirrorSummary, String> {
    with_conn(&state, |conn| mirror::start_or_resume(conn, params))
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_summary(state: State<LibraryState>) -> Result<MirrorSummary, String> {
    with_conn(&state, mirror::summary)
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_enqueue_packs(
    state: State<LibraryState>,
    job_id: i64,
    packs: Vec<MirrorPackInput>,
) -> Result<MirrorSummary, String> {
    with_conn(&state, |conn| mirror::enqueue_packs(conn, job_id, packs))
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_claim_next_pack(
    state: State<LibraryState>,
    job_id: i64,
) -> Result<Option<MirrorPackRow>, String> {
    with_conn(&state, |conn| mirror::claim_next_pack(conn, job_id))
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_checkpoint_pack(
    state: State<LibraryState>,
    params: MirrorCheckpointParams,
) -> Result<MirrorSummary, String> {
    with_conn(&state, |conn| mirror::checkpoint_pack(conn, params))
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_complete_pack(
    state: State<LibraryState>,
    params: MirrorPackFinishParams,
) -> Result<MirrorSummary, String> {
    with_conn(&state, |conn| mirror::complete_pack(conn, params))
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_fail_pack(
    state: State<LibraryState>,
    params: MirrorPackFinishParams,
) -> Result<MirrorSummary, String> {
    with_conn(&state, |conn| mirror::fail_pack(conn, params))
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_pause_job(state: State<LibraryState>, job_id: i64) -> Result<MirrorSummary, String> {
    with_conn(&state, |conn| mirror::pause_job(conn, job_id))
}

#[tauri::command(rename_all = "camelCase")]
pub fn mirror_retry_failed(
    state: State<LibraryState>,
    job_id: i64,
) -> Result<MirrorSummary, String> {
    with_conn(&state, |conn| mirror::retry_failed(conn, job_id))
}

fn pack_cached_counts(
    conn: &Connection,
    pack_uuids: &[String],
) -> Result<HashMap<String, i64>, String> {
    let mut out: HashMap<String, i64> = pack_uuids.iter().map(|uuid| (uuid.clone(), 0)).collect();
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
    let mut listable: HashMap<String, Option<i64>> =
        pack_uuids.iter().map(|u| (u.clone(), None)).collect();
    if !pack_uuids.is_empty() {
        let placeholders = std::iter::repeat_n("?", pack_uuids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql =
            format!("SELECT uuid, listable_sample_total FROM packs WHERE uuid IN ({placeholders})");
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

fn set_pack_listable_total(conn: &Connection, pack_uuid: &str, total: i64) -> Result<(), String> {
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
    pub total_exact: bool,
    pub has_more: bool,
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
pub async fn library_search(
    _state: State<'_, LibraryState>,
    params: LibrarySearchParams,
) -> Result<LibrarySearchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&params.samples_dir)?;
        search::search(&conn, params)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn library_tag_summary(
    _state: State<'_, LibraryState>,
    params: LibrarySearchParams,
) -> Result<Vec<TagSummaryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&params.samples_dir)?;
        search::tag_summary(&conn, params)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn library_list_packs(
    _state: State<'_, LibraryState>,
    params: LibraryListPacksParams,
) -> Result<Vec<PackListEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open_read_conn(&params.samples_dir)?;
        search::list_packs(&conn, &params)
    })
    .await
    .map_err(|e| e.to_string())?
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

        if existing_path.is_none() {
            tx.execute(
                "INSERT INTO samples_fts (sample_uuid, name, display_name, pack_name)
                 VALUES (?1, ?2, ?3, ?4)",
                params![uuid, name, display_name, pack_name],
            )
            .map_err(|e| e.to_string())?;
        }

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

    fn is_unfiltered(params: &LibrarySearchParams) -> bool {
        params.tags.is_empty()
            && !params.favorites_only
            && params.query.as_deref().unwrap_or("").trim().is_empty()
            && params.asset_category_slug.is_none()
            && params.key.is_none()
            && params.chord_type.is_none()
            && params.min_bpm.is_none()
            && params.max_bpm.is_none()
            && params.bpm.is_none()
            && params.pack_uuid.is_none()
    }

    pub fn search(
        conn: &Connection,
        params: LibrarySearchParams,
    ) -> Result<LibrarySearchResponse, String> {
        let has_query = params
            .query
            .as_deref()
            .is_some_and(|query| !query.trim().is_empty());
        let (where_sql, mut where_params) = build_filter(&params, !has_query)?;
        let exact_total: Option<i64> = if is_unfiltered(&params) {
            Some(query_scalar(
                conn,
                "SELECT cached_sample_count FROM library_stats WHERE id = 1",
                &[],
            )?)
        } else {
            None
        };

        let order = if params.order.eq_ignore_ascii_case("ASC") {
            "ASC"
        } else {
            "DESC"
        };
        let offset = (params.page.max(1) - 1) * params.limit.max(1);
        let fetch_limit = params.limit.max(1) + 1;
        let sql = if has_query {
            let fts_query = params
                .query
                .as_deref()
                .unwrap_or_default()
                .trim()
                .split_whitespace()
                .map(|word| format!("\"{}\"", word.replace('"', "")))
                .collect::<Vec<_>>()
                .join(" ");
            where_params.insert(0, fts_query.into());
            format!(
                "SELECT s.uuid FROM samples_fts f JOIN samples s ON s.uuid = f.sample_uuid
                 WHERE f.samples_fts MATCH ? AND {} ORDER BY f.rowid DESC LIMIT {} OFFSET {}",
                where_sql, fetch_limit, offset
            )
        } else if params.sort == "pack_popularity" {
            let index = if params.pack_uuid.is_some() {
                "idx_library_cached_pack"
            } else {
                "idx_library_popularity"
            };
            format!(
                "SELECT s.uuid FROM samples s INDEXED BY {} WHERE {} ORDER BY s.pack_popularity_score IS NULL, s.pack_popularity_score {} , s.ingested_at DESC LIMIT {} OFFSET {}",
                index,
                where_sql,
                if order == "ASC" { "ASC" } else { "DESC" },
                fetch_limit,
                offset
            )
        } else {
            let (sort_col, mut sort_index) = match params.sort.as_str() {
                "bpm" => ("s.bpm", "idx_samples_bpm"),
                "duration" => ("s.duration_ms", "idx_library_duration"),
                "key" => ("s.key", "idx_samples_key"),
                "ingested_at" => ("s.ingested_at", "idx_samples_ingested"),
                "pack_name" => ("s.pack_name", "idx_library_pack_name"),
                _ => ("s.name", "idx_library_name"),
            };
            if params.pack_uuid.is_some() {
                sort_index = "idx_library_cached_pack";
            }
            format!(
                "SELECT s.uuid FROM samples s INDEXED BY {} WHERE {} ORDER BY {} {} LIMIT {} OFFSET {}",
                sort_index, where_sql, sort_col, order, fetch_limit, offset
            )
        };

        let mut uuids: Vec<String> = query_rows(conn, &sql, &where_params, |r| r.get(0))?;
        let has_more = uuids.len() > params.limit.max(1) as usize;
        if has_more {
            uuids.pop();
        }

        let items = hydrate_assets(conn, &uuids, &params.samples_dir)?;
        let loaded_through = i64::from(offset) + items.len() as i64;
        let (total, total_exact) = match exact_total {
            Some(total) => (total, true),
            None if !has_more => (loaded_through, true),
            None => (loaded_through, false),
        };

        let tag_summary = tag_summary(conn, params)?;

        Ok(LibrarySearchResponse {
            items,
            total_records: total,
            total_exact,
            has_more,
            tag_summary,
        })
    }

    pub fn tag_summary(
        conn: &Connection,
        _params: LibrarySearchParams,
    ) -> Result<Vec<TagSummaryEntry>, String> {
        query_rows(
            conn,
            "SELECT t.uuid, t.label, c.sample_count
             FROM library_tag_counts c
             JOIN tags t ON t.uuid = c.tag_uuid
             ORDER BY c.sample_count DESC
             LIMIT 200",
            &[],
            |r| {
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
            },
        )
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

    fn query_rows<T, F>(
        conn: &Connection,
        sql: &str,
        params: &[Value],
        f: F,
    ) -> Result<Vec<T>, String>
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

    fn build_filter(
        params: &LibrarySearchParams,
        include_query: bool,
    ) -> Result<(String, Vec<Value>), String> {
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
        if include_query {
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
        let mut clauses = Vec::new();
        let mut sql_params: Vec<Value> = vec![];
        if let Some(ref q) = params.query {
            let trimmed = q.trim();
            if !trimmed.is_empty() {
                clauses.push("LOWER(p.name) LIKE LOWER(?)".to_string());
                sql_params.push(format!("%{}%", trimmed).into());
            }
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT p.uuid, p.name, p.cover_relative_path
             FROM library_pack_counts c JOIN packs p ON p.uuid = c.pack_uuid
             {filter} ORDER BY p.name COLLATE NOCASE LIMIT 80"
        );
        query_rows(conn, &sql, &sql_params, |r| {
            Ok(PackListEntry {
                uuid: r.get(0)?,
                name: r.get(1)?,
                cover_relative_path: r.get(2)?,
            })
        })
    }

    struct AssetRow {
        uuid: String,
        name: String,
        audio_rel: String,
        duration: i64,
        bpm: Option<i64>,
        key: Option<String>,
        chord_type: Option<String>,
        category: String,
        favorite: bool,
        waveform_rel: Option<String>,
        pack_uuid: String,
        pack_name: String,
        cover_rel: Option<String>,
        cover_source_url: Option<String>,
    }

    fn hydrate_assets(
        conn: &Connection,
        uuids: &[String],
        samples_dir: &str,
    ) -> Result<Vec<serde_json::Value>, String> {
        if uuids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = uuids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let values = uuids.iter().cloned().map(Value::from).collect::<Vec<_>>();
        let rows = query_rows(
            conn,
            &format!(
                "SELECT s.uuid, s.name, s.relative_audio_path, s.duration_ms, s.bpm, s.key, s.chord_type,
                        s.asset_category_slug, s.favorite, s.waveform_relative_path,
                        p.uuid, p.name, p.cover_relative_path, p.cover_source_url
                 FROM samples s JOIN packs p ON p.uuid = s.pack_uuid
                 WHERE s.uuid IN ({placeholders})"
            ),
            &values,
            |r| {
                Ok(AssetRow {
                    uuid: r.get(0)?,
                    name: r.get(1)?,
                    audio_rel: r.get(2)?,
                    duration: r.get(3)?,
                    bpm: r.get(4)?,
                    key: r.get(5)?,
                    chord_type: r.get(6)?,
                    category: r.get(7)?,
                    favorite: r.get::<_, i32>(8)? != 0,
                    waveform_rel: r.get(9)?,
                    pack_uuid: r.get(10)?,
                    pack_name: r.get(11)?,
                    cover_rel: r.get(12)?,
                    cover_source_url: r.get(13)?,
                })
            },
        )?;
        let mut rows_by_uuid = rows
            .into_iter()
            .map(|row| (row.uuid.clone(), row))
            .collect::<HashMap<_, _>>();

        let mut tags_by_uuid: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
        let tags = query_rows(
            conn,
            &format!(
                "SELECT st.sample_uuid, t.uuid, t.label
                 FROM sample_tags st JOIN tags t ON t.uuid = st.tag_uuid
                 WHERE st.sample_uuid IN ({placeholders})"
            ),
            &values,
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    serde_json::json!({
                        "uuid": r.get::<_, String>(1)?,
                        "label": r.get::<_, String>(2)?,
                        "__typename": "Tag"
                    }),
                ))
            },
        )?;
        for (sample_uuid, tag) in tags {
            tags_by_uuid.entry(sample_uuid).or_default().push(tag);
        }

        Ok(uuids
            .iter()
            .filter_map(|uuid| {
                let row = rows_by_uuid.remove(uuid)?;
                let tags = tags_by_uuid.remove(uuid).unwrap_or_default();
                let audio_url = format!(
                    "file://{}",
                    PathBuf::from(samples_dir).join(&row.audio_rel).display()
                );
                let waveform_url = row
                    .waveform_rel
                    .map(|path| {
                        format!(
                            "file://{}",
                            PathBuf::from(samples_dir).join(path).display()
                        )
                    })
                    .unwrap_or_default();
                let cover_url = row
                    .cover_rel
                    .map(|path| {
                        format!(
                            "file://{}",
                            PathBuf::from(samples_dir).join(path).display()
                        )
                    })
                    .unwrap_or_default();
                Some(serde_json::json!({
                    "uuid": row.uuid,
                    "name": row.name,
                    "duration": row.duration,
                    "bpm": row.bpm,
                    "key": row.key,
                    "chord_type": row.chord_type,
                    "asset_category_slug": row.category,
                    "favorite": row.favorite,
                    "asset_type_slug": "sample",
                    "asset_prices": [],
                    "__typename": "SampleAsset",
                    "tags": tags,
                    "files": [
                        { "url": audio_url, "__typename": "AssetFile" },
                        { "url": waveform_url, "__typename": "AssetFile" }
                    ],
                    "parents": {
                        "items": [{
                            "uuid": row.pack_uuid,
                            "name": row.pack_name,
                            "permalink_slug": "",
                            "permalink_base_url": "",
                            "cover_source_url": row.cover_source_url,
                            "files": [{ "url": cover_url, "asset_file_type_slug": "cover_image", "__typename": "AssetFile" }],
                            "__typename": "PackAsset"
                        }],
                        "__typename": "AssetPage"
                    }
                }))
            })
            .collect())
    }
}

mod mirror {
    use super::*;

    pub fn start_or_resume(
        conn: &Connection,
        params: MirrorStartParams,
    ) -> Result<MirrorSummary, String> {
        let now = chrono_now_ms();
        let job_id = if let Some(id) = active_job_id(conn)? {
            conn.execute(
                "UPDATE mirror_jobs
                 SET status = 'running', sort = ?1, filters_json = ?2,
                     last_error = NULL, updated_at = ?3
                 WHERE id = ?4",
                params![params.sort, params.filters_json, now, id],
            )
            .map_err(|e| e.to_string())?;
            id
        } else {
            conn.execute(
                "INSERT INTO mirror_jobs
                    (status, sort, filters_json, created_at, updated_at)
                 VALUES ('running', ?1, ?2, ?3, ?3)",
                params![params.sort, params.filters_json, now],
            )
            .map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        };
        recompute_job_counts(conn, job_id)?;
        summary_for_job(conn, Some(job_id))
    }

    pub fn summary(conn: &Connection) -> Result<MirrorSummary, String> {
        summary_for_job(conn, latest_job_id(conn)?)
    }

    pub fn enqueue_packs(
        conn: &Connection,
        job_id: i64,
        packs: Vec<MirrorPackInput>,
    ) -> Result<MirrorSummary, String> {
        let now = chrono_now_ms();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for pack in packs {
            let cached = cached_count(&tx, &pack.uuid)?;
            let status = if pack
                .listable_total
                .map(|total| total > 0 && cached >= total)
                .unwrap_or(false)
            {
                "complete"
            } else {
                "queued"
            };
            tx.execute(
                "INSERT INTO packs (uuid, name, listable_sample_total)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(uuid) DO UPDATE SET
                    name = CASE WHEN excluded.name != 'Unknown pack'
                        THEN excluded.name ELSE packs.name END,
                    listable_sample_total = COALESCE(
                        excluded.listable_sample_total,
                        packs.listable_sample_total
                    )",
                params![pack.uuid, pack.name, pack.listable_total],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO mirror_pack_queue
                    (job_id, pack_uuid, pack_name, rank, status,
                     listable_total, cached_count, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(job_id, pack_uuid) DO UPDATE SET
                    pack_name = excluded.pack_name,
                    rank = MIN(mirror_pack_queue.rank, excluded.rank),
                    listable_total = COALESCE(
                        excluded.listable_total,
                        mirror_pack_queue.listable_total
                    ),
                    cached_count = excluded.cached_count,
                    status = CASE
                        WHEN mirror_pack_queue.status = 'complete' THEN 'complete'
                        WHEN excluded.status = 'complete' THEN 'complete'
                        ELSE mirror_pack_queue.status
                    END,
                    updated_at = excluded.updated_at",
                params![
                    job_id,
                    pack.uuid,
                    pack.name,
                    pack.rank,
                    status,
                    pack.listable_total,
                    cached,
                    now
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        recompute_job_counts(conn, job_id)?;
        summary_for_job(conn, Some(job_id))
    }

    pub fn claim_next_pack(
        conn: &Connection,
        job_id: i64,
    ) -> Result<Option<MirrorPackRow>, String> {
        let row = conn
            .query_row(
                "SELECT job_id, pack_uuid, pack_name, rank, status, cursor,
                    listable_total, cached_count, listed_count, saved_count,
                    failed_count, attempts, last_error
                 FROM mirror_pack_queue
                 WHERE job_id = ?1 AND status IN ('queued', 'paused')
                 ORDER BY rank ASC
                 LIMIT 1",
                params![job_id],
                row_from_sql,
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(row) = row else {
            return Ok(None);
        };
        let now = chrono_now_ms();
        let cached = cached_count(conn, &row.pack_uuid)?;
        conn.execute(
            "UPDATE mirror_pack_queue
             SET status = 'listing', attempts = attempts + 1,
                 cached_count = ?1, last_error = NULL, updated_at = ?2
             WHERE job_id = ?3 AND pack_uuid = ?4",
            params![cached, now, job_id, row.pack_uuid],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE mirror_jobs
             SET status = 'running', current_pack_uuid = ?1,
                 last_error = NULL, updated_at = ?2
             WHERE id = ?3",
            params![row.pack_uuid, now, job_id],
        )
        .map_err(|e| e.to_string())?;
        queue_row(conn, job_id, &row.pack_uuid).map(Some)
    }

    pub fn checkpoint_pack(
        conn: &Connection,
        params: MirrorCheckpointParams,
    ) -> Result<MirrorSummary, String> {
        let now = chrono_now_ms();
        let cached = cached_count(conn, &params.pack_uuid)?;
        conn.execute(
            "UPDATE mirror_pack_queue
             SET status = 'downloading',
                 cursor = COALESCE(?1, cursor),
                 listable_total = COALESCE(?2, listable_total),
                 cached_count = ?3,
                 listed_count = listed_count + ?4,
                 saved_count = saved_count + ?5,
                 failed_count = failed_count + ?6,
                 updated_at = ?7
             WHERE job_id = ?8 AND pack_uuid = ?9",
            params![
                params.cursor,
                params.listable_total,
                cached,
                params.listed_delta.max(0),
                params.saved_delta.max(0),
                params.failed_delta.max(0),
                now,
                params.job_id,
                params.pack_uuid
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE mirror_jobs
             SET session_saved = session_saved + ?1, updated_at = ?2
             WHERE id = ?3",
            params![params.saved_delta.max(0), now, params.job_id],
        )
        .map_err(|e| e.to_string())?;
        recompute_job_counts(conn, params.job_id)?;
        summary_for_job(conn, Some(params.job_id))
    }

    pub fn complete_pack(
        conn: &Connection,
        params: MirrorPackFinishParams,
    ) -> Result<MirrorSummary, String> {
        let now = chrono_now_ms();
        let cached = cached_count(conn, &params.pack_uuid)?;
        conn.execute(
            "UPDATE mirror_pack_queue
             SET status = 'complete', cursor = NULL,
                 listable_total = COALESCE(?1, listable_total),
                 cached_count = ?2, last_error = NULL, updated_at = ?3
             WHERE job_id = ?4 AND pack_uuid = ?5",
            params![
                params.listable_total,
                cached,
                now,
                params.job_id,
                params.pack_uuid
            ],
        )
        .map_err(|e| e.to_string())?;
        if let Some(total) = params.listable_total {
            super::set_pack_listable_total(conn, &params.pack_uuid, total)?;
        }
        conn.execute(
            "UPDATE mirror_jobs
             SET current_pack_uuid = NULL, last_error = NULL, updated_at = ?1
             WHERE id = ?2",
            params![now, params.job_id],
        )
        .map_err(|e| e.to_string())?;
        recompute_job_counts(conn, params.job_id)?;
        maybe_finish_job(conn, params.job_id)?;
        summary_for_job(conn, Some(params.job_id))
    }

    pub fn fail_pack(
        conn: &Connection,
        params: MirrorPackFinishParams,
    ) -> Result<MirrorSummary, String> {
        let now = chrono_now_ms();
        let error = params.error.unwrap_or_else(|| "Pack failed".to_string());
        conn.execute(
            "UPDATE mirror_pack_queue
             SET status = 'failed', last_error = ?1, updated_at = ?2
             WHERE job_id = ?3 AND pack_uuid = ?4",
            params![error, now, params.job_id, params.pack_uuid],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO mirror_failures (job_id, pack_uuid, error, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![params.job_id, params.pack_uuid, error, now],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE mirror_jobs
             SET current_pack_uuid = NULL, last_error = ?1, updated_at = ?2
             WHERE id = ?3",
            params![error, now, params.job_id],
        )
        .map_err(|e| e.to_string())?;
        recompute_job_counts(conn, params.job_id)?;
        summary_for_job(conn, Some(params.job_id))
    }

    pub fn pause_job(conn: &Connection, job_id: i64) -> Result<MirrorSummary, String> {
        let now = chrono_now_ms();
        conn.execute(
            "UPDATE mirror_pack_queue
             SET status = 'paused', updated_at = ?1
             WHERE job_id = ?2 AND status IN ('listing', 'downloading')",
            params![now, job_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE mirror_jobs
             SET status = 'paused', current_pack_uuid = NULL, updated_at = ?1
             WHERE id = ?2",
            params![now, job_id],
        )
        .map_err(|e| e.to_string())?;
        recompute_job_counts(conn, job_id)?;
        summary_for_job(conn, Some(job_id))
    }

    pub fn retry_failed(conn: &Connection, job_id: i64) -> Result<MirrorSummary, String> {
        let now = chrono_now_ms();
        conn.execute(
            "UPDATE mirror_pack_queue
             SET status = 'queued', last_error = NULL, updated_at = ?1
             WHERE job_id = ?2 AND status = 'failed'",
            params![now, job_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE mirror_jobs
             SET status = 'running', last_error = NULL, updated_at = ?1
             WHERE id = ?2",
            params![now, job_id],
        )
        .map_err(|e| e.to_string())?;
        recompute_job_counts(conn, job_id)?;
        summary_for_job(conn, Some(job_id))
    }

    fn active_job_id(conn: &Connection) -> Result<Option<i64>, String> {
        conn.query_row(
            "SELECT id FROM mirror_jobs
             WHERE status IN ('running', 'paused', 'idle')
             ORDER BY updated_at DESC
             LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    fn latest_job_id(conn: &Connection) -> Result<Option<i64>, String> {
        conn.query_row(
            "SELECT id FROM mirror_jobs ORDER BY updated_at DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    fn cached_count(conn: &Connection, pack_uuid: &str) -> Result<i64, String> {
        conn.query_row(
            "SELECT COUNT(*) FROM samples
             WHERE pack_uuid = ?1 AND audio_cached_at > 0",
            params![pack_uuid],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
    }

    fn row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<MirrorPackRow> {
        Ok(MirrorPackRow {
            job_id: row.get(0)?,
            pack_uuid: row.get(1)?,
            pack_name: row.get(2)?,
            rank: row.get(3)?,
            status: row.get(4)?,
            cursor: row.get(5)?,
            listable_total: row.get(6)?,
            cached_count: row.get(7)?,
            listed_count: row.get(8)?,
            saved_count: row.get(9)?,
            failed_count: row.get(10)?,
            attempts: row.get(11)?,
            last_error: row.get(12)?,
        })
    }

    fn queue_row(conn: &Connection, job_id: i64, pack_uuid: &str) -> Result<MirrorPackRow, String> {
        conn.query_row(
            "SELECT job_id, pack_uuid, pack_name, rank, status, cursor,
                listable_total, cached_count, listed_count, saved_count,
                failed_count, attempts, last_error
             FROM mirror_pack_queue
             WHERE job_id = ?1 AND pack_uuid = ?2",
            params![job_id, pack_uuid],
            row_from_sql,
        )
        .map_err(|e| e.to_string())
    }

    fn recompute_job_counts(conn: &Connection, job_id: i64) -> Result<(), String> {
        let now = chrono_now_ms();
        conn.execute(
            "UPDATE mirror_jobs
             SET
                total_packs = (
                    SELECT COUNT(*) FROM mirror_pack_queue WHERE job_id = ?1
                ),
                completed_packs = (
                    SELECT COUNT(*) FROM mirror_pack_queue
                    WHERE job_id = ?1 AND status = 'complete'
                ),
                failed_packs = (
                    SELECT COUNT(*) FROM mirror_pack_queue
                    WHERE job_id = ?1 AND status = 'failed'
                ),
                total_samples = COALESCE((
                    SELECT SUM(COALESCE(listable_total, 0))
                    FROM mirror_pack_queue WHERE job_id = ?1
                ), 0),
                cached_samples = COALESCE((
                    SELECT SUM(cached_count)
                    FROM mirror_pack_queue WHERE job_id = ?1
                ), 0),
                updated_at = ?2
             WHERE id = ?1",
            params![job_id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn maybe_finish_job(conn: &Connection, job_id: i64) -> Result<(), String> {
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mirror_pack_queue
                 WHERE job_id = ?1 AND status IN ('queued', 'listing', 'downloading', 'paused')",
                params![job_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if remaining == 0 {
            let failed: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mirror_pack_queue
                     WHERE job_id = ?1 AND status = 'failed'",
                    params![job_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let status = if failed > 0 { "idle" } else { "complete" };
            conn.execute(
                "UPDATE mirror_jobs SET status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, chrono_now_ms(), job_id],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn summary_for_job(conn: &Connection, job_id: Option<i64>) -> Result<MirrorSummary, String> {
        let Some(job_id) = job_id else {
            return Ok(MirrorSummary {
                job_id: None,
                status: "idle".into(),
                total_packs: 0,
                queued_packs: 0,
                running_packs: 0,
                completed_packs: 0,
                failed_packs: 0,
                total_samples: 0,
                cached_samples: 0,
                session_saved: 0,
                current_pack_uuid: None,
                current_pack_name: None,
                last_error: None,
                updated_at: None,
            });
        };

        let mut summary = conn
            .query_row(
                "SELECT id, status, total_packs, completed_packs, failed_packs,
                    total_samples, cached_samples, session_saved,
                    current_pack_uuid, last_error, updated_at
                 FROM mirror_jobs WHERE id = ?1",
                params![job_id],
                |r| {
                    Ok(MirrorSummary {
                        job_id: Some(r.get(0)?),
                        status: r.get(1)?,
                        total_packs: r.get(2)?,
                        queued_packs: 0,
                        running_packs: 0,
                        completed_packs: r.get(3)?,
                        failed_packs: r.get(4)?,
                        total_samples: r.get(5)?,
                        cached_samples: r.get(6)?,
                        session_saved: r.get(7)?,
                        current_pack_uuid: r.get(8)?,
                        current_pack_name: None,
                        last_error: r.get(9)?,
                        updated_at: Some(r.get(10)?),
                    })
                },
            )
            .map_err(|e| e.to_string())?;

        summary.queued_packs = count_status(conn, job_id, &["queued", "paused"])?;
        summary.running_packs = count_status(conn, job_id, &["listing", "downloading"])?;
        if let Some(ref uuid) = summary.current_pack_uuid {
            summary.current_pack_name = conn
                .query_row(
                    "SELECT pack_name FROM mirror_pack_queue
                     WHERE job_id = ?1 AND pack_uuid = ?2",
                    params![job_id, uuid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
        }
        Ok(summary)
    }

    fn count_status(conn: &Connection, job_id: i64, statuses: &[&str]) -> Result<i64, String> {
        if statuses.is_empty() {
            return Ok(0);
        }
        let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let sql = format!(
            "SELECT COUNT(*) FROM mirror_pack_queue
             WHERE job_id = ? AND status IN ({placeholders})"
        );
        let mut values: Vec<rusqlite::types::Value> = vec![job_id.into()];
        values.extend(statuses.iter().map(|s| (*s).to_string().into()));
        let refs: Vec<&dyn rusqlite::ToSql> =
            values.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        conn.query_row(&sql, refs.as_slice(), |r| r.get(0))
            .map_err(|e| e.to_string())
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

    fn test_conn() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = db_path(dir.path().to_str().unwrap());
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        migrate(&conn).unwrap();
        (dir, conn)
    }

    fn sample_asset(uuid: &str, pack_uuid: &str, pack_name: &str) -> serde_json::Value {
        serde_json::json!({
            "uuid": uuid,
            "name": format!("{pack_name}/kick.mp3"),
            "duration": 1000,
            "bpm": 120,
            "key": "C",
            "chord_type": "major",
            "asset_category_slug": "oneshot",
            "tags": [{ "uuid": "t1", "label": "Kick", "__typename": "Tag" }],
            "parents": {
                "items": [{
                    "uuid": pack_uuid,
                    "name": pack_name,
                    "files": [],
                    "__typename": "PackAsset"
                }]
            }
        })
    }

    #[test]
    fn ingest_and_search() {
        let (dir, conn) = test_conn();

        ingest::upsert(
            &conn,
            UpsertPayload {
                asset: sample_asset("sample-1", "pack-1", "My Pack"),
                relative_audio_path: "My_Pack/kick.mp3".into(),
                waveform_relative_path: None,
                audio_cached_at: 1,
                favorite: Some(true),
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

        ingest::upsert(
            &conn,
            UpsertPayload {
                asset: sample_asset("sample-2", "pack-1", "My Pack"),
                relative_audio_path: "My_Pack/kick-2.mp3".into(),
                waveform_relative_path: None,
                audio_cached_at: 1,
                favorite: Some(false),
            },
        )
        .unwrap();

        let paged = search::search(
            &conn,
            LibrarySearchParams {
                query: None,
                tags: vec![],
                page: 1,
                limit: 1,
                sort: "ingested_at".into(),
                order: "DESC".into(),
                favorites_only: false,
                asset_category_slug: Some("oneshot".into()),
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
        assert_eq!(paged.total_records, 1);
        assert!(!paged.total_exact);
        assert!(paged.has_more);

        let combined = search::search(
            &conn,
            LibrarySearchParams {
                query: Some("kick".into()),
                tags: vec!["t1".into()],
                page: 1,
                limit: 50,
                sort: "bpm".into(),
                order: "ASC".into(),
                favorites_only: true,
                asset_category_slug: Some("oneshot".into()),
                key: Some("c".into()),
                chord_type: Some("MAJOR".into()),
                min_bpm: Some(110),
                max_bpm: Some(130),
                bpm: Some("120".into()),
                pack_uuid: Some("pack-1".into()),
                samples_dir: dir.path().to_str().unwrap().into(),
            },
        )
        .unwrap();
        assert_eq!(combined.total_records, 1);
        assert_eq!(combined.items[0]["uuid"], "sample-1");
        assert_eq!(combined.tag_summary[0].count, 2);

        let packs = search::list_packs(
            &conn,
            &LibraryListPacksParams {
                query: Some("My".into()),
                samples_dir: dir.path().to_str().unwrap().into(),
            },
        )
        .unwrap();
        assert_eq!(packs.len(), 1);
    }

    #[test]
    fn mirror_job_resumes_and_preserves_cached_progress() {
        let (_dir, conn) = test_conn();

        ingest::upsert(
            &conn,
            UpsertPayload {
                asset: sample_asset("sample-1", "pack-1", "Cached Pack"),
                relative_audio_path: "Cached_Pack/kick.mp3".into(),
                waveform_relative_path: None,
                audio_cached_at: 1,
                favorite: None,
            },
        )
        .unwrap();

        let started = mirror::start_or_resume(
            &conn,
            MirrorStartParams {
                filters_json: "{}".into(),
                sort: "pack_popularity".into(),
            },
        )
        .unwrap();
        let job_id = started.job_id.unwrap();

        let summary = mirror::enqueue_packs(
            &conn,
            job_id,
            vec![
                MirrorPackInput {
                    uuid: "pack-1".into(),
                    name: "Cached Pack".into(),
                    rank: 1,
                    listable_total: Some(1),
                },
                MirrorPackInput {
                    uuid: "pack-2".into(),
                    name: "Missing Pack".into(),
                    rank: 2,
                    listable_total: Some(2),
                },
            ],
        )
        .unwrap();

        assert_eq!(summary.total_packs, 2);
        assert_eq!(summary.completed_packs, 1);
        assert_eq!(summary.queued_packs, 1);
        assert_eq!(summary.cached_samples, 1);

        let resumed = mirror::start_or_resume(
            &conn,
            MirrorStartParams {
                filters_json: "{}".into(),
                sort: "pack_popularity".into(),
            },
        )
        .unwrap();
        assert_eq!(resumed.job_id, Some(job_id));
    }

    #[test]
    fn mirror_checkpoint_complete_and_retry_failed_pack() {
        let (_dir, conn) = test_conn();
        let started = mirror::start_or_resume(
            &conn,
            MirrorStartParams {
                filters_json: "{}".into(),
                sort: "pack_popularity".into(),
            },
        )
        .unwrap();
        let job_id = started.job_id.unwrap();

        mirror::enqueue_packs(
            &conn,
            job_id,
            vec![MirrorPackInput {
                uuid: "pack-1".into(),
                name: "Pack 1".into(),
                rank: 1,
                listable_total: Some(10),
            }],
        )
        .unwrap();

        let claimed = mirror::claim_next_pack(&conn, job_id).unwrap().unwrap();
        assert_eq!(claimed.status, "listing");
        assert_eq!(claimed.attempts, 1);

        let checkpoint = mirror::checkpoint_pack(
            &conn,
            MirrorCheckpointParams {
                job_id,
                pack_uuid: "pack-1".into(),
                cursor: Some("cursor-2".into()),
                listable_total: Some(10),
                listed_delta: 5,
                saved_delta: 3,
                failed_delta: 0,
            },
        )
        .unwrap();
        assert_eq!(checkpoint.session_saved, 3);

        mirror::fail_pack(
            &conn,
            MirrorPackFinishParams {
                job_id,
                pack_uuid: "pack-1".into(),
                listable_total: Some(10),
                error: Some("network".into()),
            },
        )
        .unwrap();
        let retry = mirror::retry_failed(&conn, job_id).unwrap();
        assert_eq!(retry.failed_packs, 0);
        assert_eq!(retry.queued_packs, 1);

        mirror::complete_pack(
            &conn,
            MirrorPackFinishParams {
                job_id,
                pack_uuid: "pack-1".into(),
                listable_total: Some(10),
                error: None,
            },
        )
        .unwrap();
        let done = mirror::summary(&conn).unwrap();
        assert_eq!(done.completed_packs, 1);
    }
}
