use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_utils::config::BackgroundThrottlingPolicy;
use tokio::sync::oneshot;

mod proxy_diag;

const SPLICE_GRAPHQL_URL: &str = "https://surfaces-graphql.splice.com/graphql";
/// Session cookies + working `fetch` (WKWebView breaks subresource requests on the GraphQL 404 host).
const PROXY_ORIGIN_URL: &str = "https://www.splice.com/";
const PROXY_WEBVIEW_LABEL: &str = "splice-proxy";

pub(crate) fn is_splice_proxy_host(host: &str) -> bool {
    host == "www.splice.com" || host == "splice.com"
}

#[cfg(debug_assertions)]
fn slog_line(args: std::fmt::Arguments<'_>) {
    eprintln!("[splicerr] {args}");
}

#[cfg(not(debug_assertions))]
#[allow(clippy::needless_pass_by_value)]
fn slog_line(_args: std::fmt::Arguments<'_>) {}

/// Dev-only lines in the `pnpm tauri dev` terminal (debug builds).
#[macro_export]
macro_rules! slog {
    ($($t:tt)*) => {
        $crate::slog_line(format_args!($($t)*))
    };
}

struct SpliceGraphqlBridge {
    proxy_ready: AtomicBool,
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>,
    /// One in-flight `eval` per proxy webview (parallel scripts race each other).
    graphql_lock: tokio::sync::Mutex<()>,
}

impl SpliceGraphqlBridge {
    fn new() -> Self {
        Self {
            proxy_ready: AtomicBool::new(false),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            graphql_lock: tokio::sync::Mutex::new(()),
        }
    }
}

fn graphql_operation_name(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("operationName")
                .and_then(|o| o.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "SamplesSearch".to_string())
}

pub(crate) fn finish_pending(bridge: &SpliceGraphqlBridge, id: &str, result: Result<String, String>) {
    match bridge.pending.lock().unwrap().remove(id) {
        Some(tx) => {
            let _ = tx.send(result);
        }
        None => slog!("callback: no pending request for id={}", id),
    }
}

async fn wait_for_proxy(app: &AppHandle) -> Result<(), String> {
    let bridge = app.state::<SpliceGraphqlBridge>();
    if bridge.proxy_ready.load(Ordering::SeqCst) {
        return Ok(());
    }
    slog!(
        "proxy: waiting for {} to finish loading {PROXY_ORIGIN_URL}…",
        PROXY_WEBVIEW_LABEL
    );
    for attempt in 1..=150 {
        if bridge.proxy_ready.load(Ordering::SeqCst) {
            slog!("proxy: ready after ~{}ms", attempt * 100);
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("Splice connection proxy did not become ready".to_string())
}

async fn ensure_proxy_origin(proxy: &WebviewWindow, app: &AppHandle) -> Result<(), String> {
    let bridge = app.state::<SpliceGraphqlBridge>();
    let on_origin = proxy
        .url()
        .ok()
        .and_then(|u| u.host_str().map(is_splice_proxy_host))
        .unwrap_or(false);
    if on_origin && bridge.proxy_ready.load(Ordering::SeqCst) {
        return Ok(());
    }
    slog!(
        "proxy: navigating to {PROXY_ORIGIN_URL} (current {:?})",
        proxy.url().ok()
    );
    bridge.proxy_ready.store(false, Ordering::SeqCst);
    let origin_js = serde_json::to_string(PROXY_ORIGIN_URL).map_err(|e| e.to_string())?;
    proxy
        .eval(format!("location.replace({origin_js});"))
        .map_err(|e| e.to_string())?;
    wait_for_proxy(app).await
}

#[cfg(not(target_os = "windows"))]
async fn splice_graphql_via_proxy(app: AppHandle, body: String) -> Result<String, String> {
    let started = std::time::Instant::now();
    let bridge = app.state::<SpliceGraphqlBridge>();
    let _graphql_guard = bridge.graphql_lock.lock().await;
    wait_for_proxy(&app).await?;

    let operation_name = graphql_operation_name(&body);
    slog!(
        "graphql[proxy]: → {} (body {} bytes)",
        operation_name,
        body.len()
    );
    let payload: Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid GraphQL body: {e}"))?;

    let request_id = bridge.next_id.fetch_add(1, Ordering::SeqCst).to_string();
    let (tx, rx) = oneshot::channel();
    bridge
        .pending
        .lock()
        .unwrap()
        .insert(request_id.clone(), tx);

    let proxy = app
        .get_webview_window(PROXY_WEBVIEW_LABEL)
        .ok_or("Splice proxy webview is missing")?;
    ensure_proxy_origin(&proxy, &app).await?;

    let payload_js = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let operation_js = serde_json::to_string(&operation_name).map_err(|e| e.to_string())?;
    let request_id_js = serde_json::to_string(&request_id).map_err(|e| e.to_string())?;
    let gql_url_js = serde_json::to_string(SPLICE_GRAPHQL_URL).map_err(|e| e.to_string())?;

    let preamble = proxy_diag::graphql_proxy_script_preamble(&request_id_js);
    let script = format!(
        r#"(async () => {{
  const operationName = {operation_js};
  const payload = {payload_js};
  const gqlUrl = {gql_url_js};
{preamble}
  trace("script", `start href=${{location.href}} ready=${{document.readyState}}`);
  try {{
    const ctrl = new AbortController();
    const abortMs = 45_000;
    const timer = setTimeout(() => ctrl.abort(), abortMs);
    trace("fetch", `POST ${{gqlUrl}} begin abortMs=${{abortMs}}`);
    const response = await fetch(gqlUrl, {{
      method: "POST",
      signal: ctrl.signal,
      credentials: "include",
      headers: {{
        "content-type": "application/json",
        "apollo-require-preflight": "true",
        "x-apollo-operation-name": operationName,
      }},
      body: JSON.stringify(payload),
    }});
    clearTimeout(timer);
    trace("fetch", `response status=${{response.status}}`);
    const text = await response.text();
    trace("fetch", `body bytes=${{text.length}}`);
    sendCallback(response.status, text);
  }} catch (error) {{
    trace("fetch", `error ${{error}}`);
    sendCallback(0, String(error));
  }}
}})();"#
    );

    proxy.eval(script).map_err(|e| {
        let msg = format!("Failed to run GraphQL in Splice webview: {e}");
        slog!("graphql[proxy]: eval failed request_id={}: {}", request_id, msg);
        msg
    })?;
    slog!("graphql[proxy]: eval dispatched request_id={}", request_id);
    proxy_diag::log_proxy_snapshot(&app, Some(&request_id), 0);

    let wait = async {
        match rx.await {
            Ok(r) => r,
            Err(_) => Err("GraphQL proxy channel closed".to_string()),
        }
    };

    let outcome = match tokio::time::timeout(std::time::Duration::from_secs(60), wait).await {
        Ok(inner) => inner,
        Err(_) => {
            bridge.pending.lock().unwrap().remove(&request_id);
            slog!(
                "graphql[proxy]: timed out request_id={} — running environment probe",
                request_id
            );
            let _ = proxy_diag::run_environment_probe(&app).await;
            Err("GraphQL proxy timed out".to_string())
        }
    };

    match &outcome {
        Ok(text) => slog!(
            "graphql[proxy]: ← ok request_id={} {} bytes in {}ms",
            request_id,
            text.len(),
            started.elapsed().as_millis()
        ),
        Err(e) => slog!(
            "graphql[proxy]: ← err request_id={} {} ({}ms)",
            request_id,
            e,
            started.elapsed().as_millis()
        ),
    }
    outcome
}

#[cfg(target_os = "windows")]
async fn splice_graphql_via_reqwest(body: String) -> Result<String, String> {
    let started = std::time::Instant::now();
    let operation_name = graphql_operation_name(&body);
    slog!(
        "graphql[reqwest]: → {} (body {} bytes)",
        operation_name,
        body.len()
    );

    let client = reqwest::Client::builder()
        .use_native_tls()
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(SPLICE_GRAPHQL_URL)
        .header("content-type", "application/json")
        .header("apollo-require-preflight", "true")
        .header("x-apollo-operation-name", operation_name)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let err = format!(
            "HTTP {}: {}",
            status.as_u16(),
            &text[..text.len().min(200)]
        );
        slog!(
            "graphql[reqwest]: ← {} in {}ms",
            err,
            started.elapsed().as_millis()
        );
        return Err(err);
    }
    slog!(
        "graphql[reqwest]: ← HTTP {} {} bytes in {}ms",
        status.as_u16(),
        text.len(),
        started.elapsed().as_millis()
    );
    Ok(text)
}

/// Mirrors `console.log` from the UI into the `tauri dev` terminal (debug builds).
#[tauri::command]
fn splicerr_debug_log(message: String) {
    slog!("ui: {}", message);
}

/// GraphQL to Splice. Windows: reqwest (no bad `Origin`). macOS/Linux: hidden WebView on www.splice.com → CORS fetch to GraphQL.
#[tauri::command]
async fn splice_graphql(app: AppHandle, body: String) -> Result<String, String> {
    slog!("invoke splice_graphql ({} byte body)", body.len());
    #[cfg(target_os = "windows")]
    {
        return splice_graphql_via_reqwest(body).await;
    }
    #[cfg(not(target_os = "windows"))]
    {
        return splice_graphql_via_proxy(app, body).await;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SpliceGraphqlBridge::new())
        .setup(|app| {
            let debug_proxy = proxy_diag::proxy_debug_mode();
            slog!(
                "app setup: proxy webview (SPLICERR_PROXY_DEBUG={})",
                if debug_proxy { "1" } else { "0" }
            );
            let mut proxy_builder = WebviewWindowBuilder::new(
                app,
                PROXY_WEBVIEW_LABEL,
                WebviewUrl::External(PROXY_ORIGIN_URL.parse().unwrap()),
            )
            .title("Splicerr GraphQL proxy")
            .inner_size(480.0, 320.0);
            if debug_proxy {
                slog!("proxy: debug mode → visible, devtools, background throttling off");
                proxy_builder = proxy_builder
                    .visible(true)
                    .focused(false)
                    .devtools(true)
                    .background_throttling(BackgroundThrottlingPolicy::Disabled);
            } else {
                proxy_builder = proxy_builder
                    .visible(false)
                    .focused(false)
                    .inner_size(1.0, 1.0)
                    .position(-2000.0, -2000.0);
            }
            let _proxy = proxy_builder
            .on_page_load(|webview, payload| {
                let event = payload.event();
                slog!("proxy: page_load {:?} url={}", event, payload.url());
                if event == PageLoadEvent::Finished {
                    let host = payload.url().host_str().unwrap_or("");
                    if is_splice_proxy_host(host) {
                        webview
                            .app_handle()
                            .state::<SpliceGraphqlBridge>()
                            .proxy_ready
                            .store(true, Ordering::SeqCst);
                        slog!("proxy: Splice origin ready ({host})");
                    }
                }
            })
            .build()
            .map_err(|e| {
                slog!("proxy: failed to create webview: {}", e);
                e.to_string()
            })?;
            slog!("app setup: main window + proxy webview ready");
            Ok(())
        })
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            splice_graphql,
            splicerr_debug_log,
            proxy_diag::splicerr_proxy_trace,
            proxy_diag::splicerr_graphql_callback,
            proxy_diag::splicerr_run_proxy_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
