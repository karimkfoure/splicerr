//! Dev-only GraphQL proxy instrumentation (`[splicerr]` in the `tauri dev` terminal).

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};

use crate::{
    is_splice_proxy_host, slog, SpliceGraphqlBridge, PROXY_ORIGIN_URL, PROXY_WEBVIEW_LABEL,
};

pub fn proxy_debug_mode() -> bool {
    std::env::var("SPLICERR_PROXY_DEBUG").ok().as_deref() == Some("1")
}

pub fn debug_logging_enabled() -> bool {
    cfg!(debug_assertions) || proxy_debug_mode()
}

pub fn log_proxy_snapshot(app: &AppHandle, waiting_for: Option<&str>, elapsed_secs: u64) {
    if !debug_logging_enabled() {
        return;
    }
    let bridge = app.state::<SpliceGraphqlBridge>();
    let pending: Vec<String> = bridge
        .pending
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    let ready = bridge.proxy_ready.load(Ordering::SeqCst);
    let proxy_url = app
        .get_webview_window(PROXY_WEBVIEW_LABEL)
        .and_then(|w| w.url().ok())
        .map(|u| u.to_string())
        .unwrap_or_else(|| "<no proxy window>".into());

    if let Some(id) = waiting_for {
        slog!(
            "snapshot[+{elapsed_secs}s] waiting_for={id} proxy_ready={ready} pending={:?} url={proxy_url}",
            pending
        );
    } else {
        slog!(
            "snapshot proxy_ready={ready} pending={:?} url={proxy_url}",
            pending
        );
    }
}

#[tauri::command]
pub fn splicerr_proxy_trace(id: String, phase: String, detail: String) {
    slog!("trace[{id}] {phase}: {detail}");
}

#[tauri::command]
pub fn splicerr_graphql_callback(
    app: AppHandle,
    id: String,
    status: u16,
    body: String,
) -> Result<(), String> {
    slog!(
        "ipc-callback: id={} status={} body_len={}",
        id,
        status,
        body.len()
    );
    let result = if (200..300).contains(&status) {
        Ok(body)
    } else {
        Err(format!(
            "HTTP {}: {}",
            status,
            &body.chars().take(200).collect::<String>()
        ))
    };
    crate::finish_pending(&app.state::<SpliceGraphqlBridge>(), &id, result);
    Ok(())
}

/// Manual probe from the main window: `invoke('splicerr_run_proxy_diagnostics')`.
#[tauri::command]
pub async fn splicerr_run_proxy_diagnostics(app: AppHandle) -> Result<String, String> {
    run_environment_probe(&app).await?;
    Ok("Diagnostics written to the tauri dev terminal ([splicerr] lines).".into())
}

const PROBE_SCRIPT: &str = r#"
(async () => {
  const id = "probe-" + Date.now();
  const GQL = "https://surfaces-graphql.splice.com/graphql";
  const trace = (phase, detail) => {
    try {
      globalThis.__TAURI__?.core?.invoke("splicerr_proxy_trace", {
        id,
        phase,
        detail: String(detail),
      });
    } catch (_) {}
  };
  trace("env", `href=${location.href} origin=${location.origin}`);
  trace("tauri", `invoke=${!!globalThis.__TAURI__?.core?.invoke}`);
  try {
    const res = await fetch(GQL, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "apollo-require-preflight": "true",
        "x-apollo-operation-name": "SamplesSearch",
      },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    const text = await res.text();
    trace("fetch", `graphql status=${res.status} bytes=${text.length}`);
  } catch (e) {
    trace("fetch", `graphql error ${e}`);
  }
  trace("done", "probe finished");
})();
"#;

pub async fn run_environment_probe(app: &AppHandle) -> Result<(), String> {
    slog!("probe: starting on {PROXY_WEBVIEW_LABEL}");
    log_proxy_snapshot(app, None, 0);
    let proxy = app
        .get_webview_window(PROXY_WEBVIEW_LABEL)
        .ok_or("Proxy webview missing")?;
    let host_ok = proxy
        .url()
        .ok()
        .and_then(|u| u.host_str().map(is_splice_proxy_host))
        .unwrap_or(false);
    if !host_ok {
        slog!(
            "probe: navigating to {PROXY_ORIGIN_URL} (was {:?})",
            proxy.url().ok()
        );
        let origin_js = serde_json::to_string(PROXY_ORIGIN_URL).map_err(|e| e.to_string())?;
        proxy
            .eval(format!("location.replace({origin_js});"))
            .map_err(|e| e.to_string())?;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    proxy
        .eval(PROBE_SCRIPT)
        .map_err(|e| format!("probe eval failed: {e}"))?;
    slog!("probe: dispatched (watch trace[probe-…] lines)");
    Ok(())
}

/// Injected into each GraphQL `eval` in the proxy webview (`trace` + `sendCallback`).
pub fn graphql_proxy_script_preamble(request_id_js: &str) -> String {
    format!(
        r#"
  const trace = (phase, detail) => {{
    try {{
      globalThis.__TAURI__?.core?.invoke("splicerr_proxy_trace", {{
        id: {request_id_js},
        phase,
        detail: String(detail),
      }});
    }} catch (_) {{}}
  }};
  const sendCallback = (status, text) => {{
    trace("callback", `status=${{status}} len=${{text.length}}`);
    globalThis.__TAURI__?.core?.invoke("splicerr_graphql_callback", {{
      id: {request_id_js},
      status,
      body: text,
    }});
  }};
"#
    )
}
