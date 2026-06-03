const SPLICE_GRAPHQL_URL: &str = "https://surfaces-graphql.splice.com/graphql";
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/// Sends a GraphQL request to Splice from the Rust side.
///
/// We can't use the http plugin for this: on Windows it injects an
/// `Origin: http://tauri.localhost` header, which Splice's Cloudflare
/// protection blocks with a 403. A plain reqwest request sends no such
/// Origin and passes.
#[tauri::command]
async fn splice_graphql(body: String) -> Result<String, String> {
    let operation_name = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("operationName")
                .and_then(|o| o.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "SamplesSearch".to_string());

    let client = reqwest::Client::new();
    let response = client
        .post(SPLICE_GRAPHQL_URL)
        .header("content-type", "application/json")
        .header("user-agent", BROWSER_UA)
        .header("apollo-require-preflight", "true")
        .header("x-apollo-operation-name", operation_name)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            &text[..text.len().min(200)]
        ));
    }
    Ok(text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![splice_graphql])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
