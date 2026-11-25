use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
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
    let backend = tauri::async_runtime::spawn_blocking(move || backend_arc.current_status())
        .await
        .map_err(|e| format!("Desktop info task failed: {e}"))?;
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
    tauri::async_runtime::spawn_blocking(move || backend_arc.current_status())
        .await
        .map_err(|e| format!("Backend status task failed: {e}"))
}

#[tauri::command]
pub async fn desktop_restart_backend(
    app: AppHandle,
    state: State<'_, AppRuntime>,
    takeover: Option<bool>,
) -> Result<BackendStatus, String> {
    let backend_arc = Arc::clone(&state.backend);
    let flag = takeover.unwrap_or(false);
    let status = tauri::async_runtime::spawn_blocking(move || backend_arc.restart(flag))
        .await
        .map_err(|e| format!("Restart task failed: {e}"))?;
    update_tray_backend_status(&app, &status);
    let _ = app.emit("axiom://backend-status", &status);
    Ok(status)
}

#[tauri::command]
pub async fn desktop_trigger_backup(state: State<'_, AppRuntime>) -> Result<String, String> {
    let backend_arc = Arc::clone(&state.backend);
    tauri::async_runtime::spawn_blocking(move || backend_arc.trigger_backup())
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
    state: State<'_, AppRuntime>,
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
    if let Ok(canon) = std::fs::canonicalize(&path_buf) {
        if let Ok(mut saved) = state.saved_files.lock() {
            saved.insert(canon);
        }
    }
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
    resolve_vault_file(&state.backend.vault_path, &note_path)?;
    let url = format!(
        "obsidian://open?vault={}&file={}",
        urlencoding::encode(&state.backend.vault_name),
        urlencoding::encode(&note_path)
    );
    open_external_url(&url)
}

fn find_vscode_binary() -> Option<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Programs"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        roots.push(PathBuf::from(pf));
    }
    for root in &roots {
        let insiders_exe = root.join("Microsoft VS Code Insiders").join("Code - Insiders.exe");
        if insiders_exe.is_file() {
            return Some(insiders_exe);
        }
        let stable_exe = root.join("Microsoft VS Code").join("Code.exe");
        if stable_exe.is_file() {
            return Some(stable_exe);
        }
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for exe_name in ["Code - Insiders.exe", "Code.exe"] {
                let direct = dir.join(exe_name);
                if direct.is_file() {
                    return Some(direct);
                }
                if let Some(parent) = dir.parent() {
                    let parent_exe = parent.join(exe_name);
                    if parent_exe.is_file() {
                        return Some(parent_exe);
                    }
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn desktop_open_in_vscode(
    state: State<'_, AppRuntime>,
    note_path: String,
) -> Result<(), String> {
    let full = resolve_vault_file(&state.backend.vault_path, &note_path)?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let program = find_vscode_binary().ok_or_else(|| {
            "Could not find VS Code or VS Code Insiders executable on this system.".to_string()
        })?;
        std::process::Command::new(&program)
            .arg(&full)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Could not launch VS Code: {e}"))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = full;
        Err("VS Code launch is configured for Windows.".to_string())
    }
}

fn is_allowed_reveal_file(
    runtime: &AppRuntime,
    candidate: &std::path::Path,
) -> Result<PathBuf, String> {
    let meta = std::fs::symlink_metadata(candidate)
        .map_err(|_| "File could not be found on disk.".to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Only regular files can be revealed in Explorer.".to_string());
    }
    let canon = std::fs::canonicalize(candidate)
        .map_err(|e| format!("Could not resolve file path: {e}"))?;
    let in_vault = std::fs::canonicalize(&runtime.backend.vault_path)
        .is_ok_and(|v| canon.starts_with(&v));
    let in_backup = std::fs::canonicalize(&runtime.backend.backup_dir)
        .is_ok_and(|b| canon.starts_with(&b));
    let in_saved = runtime
        .saved_files
        .lock()
        .is_ok_and(|s| s.contains(&canon));
    if !in_vault && !in_backup && !in_saved {
        return Err("Only files inside the vault, backup folder, or native exports can be revealed.".to_string());
    }
    Ok(crate::backend::strip_verbatim_prefix(&canon))
}

#[tauri::command]
pub fn desktop_reveal_in_explorer(
    state: State<'_, AppRuntime>,
    target_kind: String,
    target_path: Option<String>,
) -> Result<(), String> {
    match target_kind.as_str() {
        "note" => {
            let rel = target_path.ok_or_else(|| "A note path is required.".to_string())?;
            let full = resolve_vault_file(&state.backend.vault_path, &rel)?;
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", full.to_string_lossy()))
                .spawn()
                .map_err(|e| format!("Could not open Explorer: {e}"))?;
        }
        "file" => {
            let raw = target_path.ok_or_else(|| "A file path is required.".to_string())?;
            let full = is_allowed_reveal_file(&state, PathBuf::from(&raw).as_path())?;
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", full.to_string_lossy()))
                .spawn()
                .map_err(|e| format!("Could not open Explorer: {e}"))?;
        }
        "vault" => {
            std::process::Command::new("explorer.exe")
                .arg(&state.backend.vault_path)
                .spawn()
                .map_err(|e| format!("Could not open vault folder: {e}"))?;
        }
        "backup" => {
            std::process::Command::new("explorer.exe")
                .arg(&state.backend.backup_dir)
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
    let base = state.backend.base_url();
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
    let base = state.backend.base_url();
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
    let detached_win = builder
        .build()
        .map_err(|e| format!("Could not open detached window: {e}"))?;
    crate::win_native::apply_win11_window_polish(&detached_win);
    crate::win_native::attach_webview_crash_recovery(&detached_win, target);
    let app_for_detached = app.clone();
    let label_for_detached = label.clone();
    detached_win.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let state = app_for_detached.state::<AppRuntime>();
            if state.quitting.load(Ordering::SeqCst) {
                return;
            }
            if state.window_dirty_tabs(&label_for_detached) > 0 {
                api.prevent_close();
                let _ = app_for_detached.emit_to(&label_for_detached, "axiom://confirm-close", ());
            }
        }
        WindowEvent::Destroyed => {
            let state = app_for_detached.state::<AppRuntime>();
            state.set_window_dirty_tabs(&label_for_detached, 0);
        }
        _ => {}
    });
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
pub fn desktop_set_dirty_tabs(
    window: tauri::WebviewWindow,
    state: State<'_, AppRuntime>,
    count: usize,
) -> Result<(), String> {
    state.set_window_dirty_tabs(window.label(), count);
    Ok(())
}

#[tauri::command]
pub fn desktop_quit(app: AppHandle, state: State<'_, AppRuntime>) -> Result<(), String> {
    state.quitting.store(true, Ordering::SeqCst);
    state.backend.shutdown_if_spawned();
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn desktop_check_updates(
    app: AppHandle,
    state: State<'_, AppRuntime>,
) -> Result<crate::updater::UpdateCheckResult, String> {
    let (result, update_info) = tauri::async_runtime::spawn_blocking(crate::updater::check_updates)
        .await
        .map_err(|e| format!("Update check task failed: {e}"))?;
    let ok = result?;
    if let Ok(mut guard) = state.pending_update.lock() {
        *guard = if ok.available { update_info } else { None };
    }
    if ok.available {
        let _ = app.emit("axiom://update-available", &ok);
    }
    Ok(ok)
}

#[tauri::command]
pub fn desktop_open_snap_layouts(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_focused().unwrap_or(false) {
        crate::win_native::trigger_snap_layouts();
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_install_update(
    app: AppHandle,
    state: State<'_, AppRuntime>,
) -> Result<(), String> {
    if state
        .update_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("An update installation is already in progress.".to_string());
    }

    let cached = state
        .pending_update
        .lock()
        .map_err(|_| {
            state.update_in_flight.store(false, Ordering::SeqCst);
            "Update state unavailable.".to_string()
        })?
        .clone();
    let info = match cached {
        Some(info) => info,
        None => {
            let fetched_res = tauri::async_runtime::spawn_blocking(crate::updater::check_updates)
                .await
                .map_err(|e| {
                    state.update_in_flight.store(false, Ordering::SeqCst);
                    format!("Update check task failed: {e}")
                })?;
            let checked = fetched_res.0.map_err(|e| {
                state.update_in_flight.store(false, Ordering::SeqCst);
                e
            })?;
            if !checked.available {
                state.update_in_flight.store(false, Ordering::SeqCst);
                return Err(checked.message);
            }
            fetched_res.1.ok_or_else(|| {
                state.update_in_flight.store(false, Ordering::SeqCst);
                "Update metadata missing.".to_string()
            })?
        }
    };

    let (tx, rx) = std::sync::mpsc::channel::<i16>();
    let progress_app = app.clone();
    std::thread::spawn(move || {
        while let Ok(pct) = rx.recv() {
            let clamped = pct.clamp(0, 100);
            crate::win_native::set_taskbar_progress(&progress_app, Some(clamped as u64));
            let _ = progress_app.emit_to("main", "axiom://update-progress", clamped);
        }
    });

    let download_result = tauri::async_runtime::spawn_blocking(move || {
        crate::updater::download_and_prepare_update(&info, Some(tx))
    })
    .await
    .map_err(|e| format!("Update install task failed: {e}"))
    .and_then(|inner| inner);

    crate::win_native::set_taskbar_progress(&app, None);

    if let Err(err) = download_result {
        state.update_in_flight.store(false, Ordering::SeqCst);
        return Err(err);
    }

    state.quitting.store(true, Ordering::SeqCst);
    let backend_arc = Arc::clone(&state.backend);
    let _ = tauri::async_runtime::spawn_blocking(move || {
        backend_arc.shutdown_owned_or_app_root_backend();
    })
    .await;
    let _ = app.emit("axiom://update-installing", ());
    app.exit(0);
    Ok(())
}
