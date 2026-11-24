use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

use crate::backend::BackendStatus;
use crate::storage::{
    atomic_write_crlf, delete_state, load_prefs, read_state, resolve_vault_file, save_prefs,
    write_state, DesktopPrefs,
};
use crate::tray::{
    navigate_main, open_external_url, toggle_quick_overlay, update_tray_backend_status,
    update_tray_review_count, AppRuntime,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub version: String,
    pub hotkey: String,
    pub backend: BackendStatus,
    pub prefs: DesktopPrefs,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileResult {
    pub saved: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub async fn desktop_info(state: State<'_, AppRuntime>) -> Result<DesktopInfo, String> {
    let prefs = state
        .prefs
        .lock()
        .map_err(|_| "Desktop preferences unavailable.".to_string())?
        .clone();
    let backend_arc = Arc::clone(&state.backend);
    let backend = tauri::async_runtime::spawn_blocking(move || {
        backend_arc
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())
            .map(|mut b| b.current_status())
    })
    .await
    .map_err(|e| format!("Desktop info task failed: {e}"))??;
    Ok(DesktopInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        hotkey: "Ctrl+Alt+K".to_string(),
        backend,
        prefs,
    })
}

#[tauri::command]
pub async fn desktop_backend_status(state: State<'_, AppRuntime>) -> Result<BackendStatus, String> {
    let backend_arc = Arc::clone(&state.backend);
    tauri::async_runtime::spawn_blocking(move || {
        backend_arc
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())
            .map(|mut b| b.current_status())
    })
    .await
    .map_err(|e| format!("Backend status task failed: {e}"))?
}

#[tauri::command]
pub async fn desktop_restart_backend(
    app: AppHandle,
    state: State<'_, AppRuntime>,
) -> Result<BackendStatus, String> {
    let backend_arc = Arc::clone(&state.backend);
    let status = tauri::async_runtime::spawn_blocking(move || {
        backend_arc
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())
            .map(|mut b| b.restart())
    })
    .await
    .map_err(|e| format!("Restart task failed: {e}"))??;
    update_tray_backend_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub async fn desktop_trigger_backup(state: State<'_, AppRuntime>) -> Result<String, String> {
    let backend_arc = Arc::clone(&state.backend);
    tauri::async_runtime::spawn_blocking(move || {
        let backend = backend_arc
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())?;
        backend.trigger_backup()
    })
    .await
    .map_err(|e| format!("Backup task failed: {e}"))?
}

#[tauri::command]
pub fn desktop_get_prefs(state: State<'_, AppRuntime>) -> Result<DesktopPrefs, String> {
    let fresh = load_prefs(&state.state_dir);
    if let Ok(mut guard) = state.prefs.lock() {
        *guard = fresh.clone();
    }
    Ok(fresh)
}

#[tauri::command]
pub fn desktop_save_prefs(
    state: State<'_, AppRuntime>,
    prefs: DesktopPrefs,
) -> Result<DesktopPrefs, String> {
    let mut sanitized = prefs;
    sanitized.zoom_percent = sanitized.zoom_percent.clamp(80, 150);
    save_prefs(&state.state_dir, &sanitized)?;
    if let Ok(mut guard) = state.prefs.lock() {
        *guard = sanitized.clone();
    }
    Ok(sanitized)
}

#[tauri::command]
pub fn desktop_read_state(
    state: State<'_, AppRuntime>,
    bucket: String,
    key: String,
) -> Result<Option<String>, String> {
    read_state(&state.state_dir, &bucket, &key)
}

#[tauri::command]
pub fn desktop_write_state(
    state: State<'_, AppRuntime>,
    bucket: String,
    key: String,
    value: String,
) -> Result<(), String> {
    write_state(&state.state_dir, &bucket, &key, &value)
}

#[tauri::command]
pub fn desktop_delete_state(
    state: State<'_, AppRuntime>,
    bucket: String,
    key: String,
) -> Result<(), String> {
    delete_state(&state.state_dir, &bucket, &key)
}

#[tauri::command]
pub async fn desktop_save_file(
    app: AppHandle,
    default_name: String,
    content: String,
) -> Result<SaveFileResult, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("JSON files", &["json"])
        .add_filter("Markdown files", &["md"])
        .add_filter("All files", &["*"])
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    let chosen = rx.await.map_err(|_| "Save dialog cancelled.".to_string())?;
    let Some(file_path) = chosen else {
        return Ok(SaveFileResult {
            saved: false,
            path: None,
        });
    };
    let path_buf = file_path
        .into_path()
        .map_err(|e| format!("Unsupported save target: {e}"))?;
    atomic_write_crlf(&path_buf, &content)?;
    Ok(SaveFileResult {
        saved: true,
        path: Some(path_buf.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub fn desktop_open_in_obsidian(
    state: State<'_, AppRuntime>,
    note_path: String,
) -> Result<(), String> {
    let (vault_path, vault_name) = {
        let backend = state
            .backend
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())?;
        (backend.vault_path.clone(), backend.vault_name.clone())
    };
    resolve_vault_file(&vault_path, &note_path)?;
    let url = format!(
        "obsidian://open?vault={}&file={}",
        urlencoding::encode(&vault_name),
        urlencoding::encode(&note_path)
    );
    open_external_url(&url)
}

fn find_vscode_binary() -> Option<PathBuf> {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let insiders = PathBuf::from(&local)
            .join("Programs")
            .join("Microsoft VS Code Insiders")
            .join("bin")
            .join("code-insiders.cmd");
        if insiders.is_file() {
            return Some(insiders);
        }
        let stable = PathBuf::from(&local)
            .join("Programs")
            .join("Microsoft VS Code")
            .join("bin")
            .join("code.cmd");
        if stable.is_file() {
            return Some(stable);
        }
    }
    None
}

#[tauri::command]
pub fn desktop_open_in_vscode(
    state: State<'_, AppRuntime>,
    note_path: String,
) -> Result<(), String> {
    let vault_path = {
        let backend = state
            .backend
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())?;
        backend.vault_path.clone()
    };
    let full = resolve_vault_file(&vault_path, &note_path)?;
    let bin = find_vscode_binary();

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let program = bin
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "code-insiders".to_string());
        let launched = std::process::Command::new(&program)
            .arg(&full)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        if launched.is_ok() {
            return Ok(());
        }
        std::process::Command::new("cmd")
            .args(["/c", "code", &full.to_string_lossy()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Could not launch VS Code: {e}"))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = (full, bin);
        Err("VS Code launch is configured for Windows.".to_string())
    }
}

#[tauri::command]
pub fn desktop_reveal_in_explorer(
    state: State<'_, AppRuntime>,
    target_kind: String,
    target_path: Option<String>,
) -> Result<(), String> {
    let (vault_path, backup_dir) = {
        let backend = state
            .backend
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())?;
        (backend.vault_path.clone(), backend.backup_dir.clone())
    };
    match target_kind.as_str() {
        "note" => {
            let rel = target_path.ok_or_else(|| "A note path is required.".to_string())?;
            let full = resolve_vault_file(&vault_path, &rel)?;
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", full.to_string_lossy()))
                .spawn()
                .map_err(|e| format!("Could not open Explorer: {e}"))?;
        }
        "file" => {
            let raw = target_path.ok_or_else(|| "A file path is required.".to_string())?;
            let full = PathBuf::from(&raw);
            if !full.is_file() {
                return Err("File could not be found on disk.".to_string());
            }
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", full.to_string_lossy()))
                .spawn()
                .map_err(|e| format!("Could not open Explorer: {e}"))?;
        }
        "vault" => {
            std::process::Command::new("explorer.exe")
                .arg(&vault_path)
                .spawn()
                .map_err(|e| format!("Could not open vault folder: {e}"))?;
        }
        "backup" => {
            std::process::Command::new("explorer.exe")
                .arg(&backup_dir)
                .spawn()
                .map_err(|e| format!("Could not open backup folder: {e}"))?;
        }
        _ => return Err("Unknown Explorer target kind.".to_string()),
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_open_in_browser(
    state: State<'_, AppRuntime>,
    route_url: Option<String>,
) -> Result<(), String> {
    let base = {
        let backend = state
            .backend
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())?;
        backend.base_url()
    };
    let suffix = route_url.unwrap_or_else(|| "/".to_string());
    let clean = if suffix.starts_with('/') {
        suffix
    } else {
        format!("/{suffix}")
    };
    open_external_url(&format!("{base}{clean}"))
}

#[tauri::command]
pub fn desktop_notify(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    title: String,
    body: String,
) -> Result<(), String> {
    let enabled = state
        .prefs
        .lock()
        .map(|p| p.toast_notifications)
        .unwrap_or(true);
    if !enabled {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("Could not send notification: {e}"))
}

#[tauri::command]
pub fn desktop_set_tray_state(
    app: AppHandle,
    pending_count: usize,
    unread_count: usize,
) -> Result<(), String> {
    update_tray_review_count(&app, pending_count, unread_count);
    Ok(())
}

#[tauri::command]
pub async fn desktop_open_note_window(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    route_url: String,
    title: Option<String>,
) -> Result<(), String> {
    let base = {
        let backend = state
            .backend
            .lock()
            .map_err(|_| "Backend state unavailable.".to_string())?;
        backend.base_url()
    };
    let clean = if route_url.starts_with('/') {
        route_url
    } else {
        format!("/{route_url}")
    };
    let mut hasher = Sha256::new();
    hasher.update(clean.as_bytes());
    let label = format!("note-{}", &hex::encode(hasher.finalize())[..12]);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }
    let sep = if clean.contains('?') { '&' } else { '?' };
    let target = format!("{base}{clean}{sep}desktopMode=detached");
    let url: url::Url = target
        .parse()
        .map_err(|e| format!("Invalid window URL: {e}"))?;
    let window_title = title.unwrap_or_else(|| "Axiom Note".to_string());
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title(&window_title)
        .inner_size(1120.0, 780.0)
        .min_inner_size(640.0, 440.0)
        .decorations(false)
        .background_color(tauri::window::Color(0x18, 0x17, 0x16, 0xff));
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")) {
        builder = builder
            .icon(icon)
            .map_err(|e| format!("Could not set detached window icon: {e}"))?;
    }
    builder
        .build()
        .map_err(|e| format!("Could not open detached window: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn desktop_toggle_quick_overlay(app: AppHandle) -> Result<(), String> {
    toggle_quick_overlay(&app);
    Ok(())
}

#[tauri::command]
pub fn desktop_focus_main_route(app: AppHandle, route_url: String) -> Result<(), String> {
    navigate_main(&app, &route_url);
    Ok(())
}

#[tauri::command]
pub fn desktop_hide_quick_overlay(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("quick-capture") {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_set_dirty_tabs(state: State<'_, AppRuntime>, count: usize) -> Result<(), String> {
    state.dirty_tabs.store(count, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn desktop_quit(app: AppHandle, state: State<'_, AppRuntime>) -> Result<(), String> {
    state.quitting.store(true, Ordering::SeqCst);
    if let Ok(mut backend) = state.backend.lock() {
        backend.shutdown_if_spawned();
    }
    app.exit(0);
    Ok(())
}
