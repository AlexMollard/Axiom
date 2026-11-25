use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::backend::BackendManager;
use crate::storage;

pub struct TrayHandles {
    pub review_item: MenuItem<tauri::Wry>,
    pub status_item: MenuItem<tauri::Wry>,
}

pub struct AppRuntime {
    pub backend: Arc<BackendManager>,
    pub state_dir: PathBuf,
    pub prefs: Mutex<storage::DesktopPrefs>,
    pub dirty_tabs: Mutex<HashMap<String, usize>>,
    pub quitting: AtomicBool,
    pub update_in_flight: AtomicBool,
    pub deferred_maximize: AtomicBool,
    pub tray: Mutex<Option<TrayHandles>>,
    pub pending_update: Mutex<Option<velopack::UpdateInfo>>,
    pub saved_files: Mutex<HashSet<PathBuf>>,
    pub pending_bounds: Mutex<Option<storage::WindowBounds>>,
    pub bounds_seq: AtomicU64,
}

impl AppRuntime {
    pub fn total_dirty_tabs(&self) -> usize {
        self.dirty_tabs
            .lock()
            .map(|m| m.values().sum())
            .unwrap_or(0)
    }

    pub fn window_dirty_tabs(&self, label: &str) -> usize {
        self.dirty_tabs
            .lock()
            .map(|m| m.get(label).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    pub fn set_window_dirty_tabs(&self, label: &str, count: usize) {
        if let Ok(mut map) = self.dirty_tabs.lock() {
            if count == 0 {
                map.remove(label);
            } else {
                map.insert(label.to_string(), count);
            }
        }
    }
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let state = app.state::<AppRuntime>();
        if state.deferred_maximize.swap(false, Ordering::SeqCst) {
            let _ = window.maximize();
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn toggle_quick_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("quick-capture") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            let _ = window.hide();
        } else {
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = app.emit_to("quick-capture", "axiom://quick-opened", ());
        }
    }
}

pub fn navigate_main(app: &AppHandle, route_url: &str) {
    show_main_window(app);
    let _ = app.emit_to("main", "axiom://navigate", route_url.to_string());
}

pub fn setup_tray(app: &AppHandle, status_label: &str) -> Result<(), String> {
    let open_item = MenuItem::with_id(app, "open", "Open Axiom", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quick_item = MenuItem::with_id(
        app,
        "quick",
        "Quick Search / Capture (Ctrl+Alt+K)",
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let review_item = MenuItem::with_id(app, "review", "Review Queue", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let new_note_item = MenuItem::with_id(app, "new_note", "New Note", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let vault_item = MenuItem::with_id(app, "open_vault", "Open Vault Folder", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let backup_item = MenuItem::with_id(app, "backup", "Create Backup Now", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let browser_item = MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let status_item = MenuItem::with_id(app, "status", status_label, false, None::<&str>)
        .map_err(|e| e.to_string())?;
    let restart_item = MenuItem::with_id(app, "restart", "Restart Backend", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let updates_item = MenuItem::with_id(app, "check_updates", "Check for Updates", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let sep3 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit_item =
        MenuItem::with_id(app, "quit", "Quit Axiom", true, None::<&str>).map_err(|e| e.to_string())?;

    let menu = Menu::with_items(
        app,
        &[
            &open_item,
            &quick_item,
            &review_item,
            &new_note_item,
            &sep1,
            &vault_item,
            &backup_item,
            &browser_item,
            &sep2,
            &status_item,
            &restart_item,
            &updates_item,
            &sep3,
            &quit_item,
        ],
    )
    .map_err(|e| e.to_string())?;

    let icon_bytes = include_bytes!("../icons/32x32.png");
    let icon = Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;

    TrayIconBuilder::with_id("axiom-tray")
        .icon(icon)
        .tooltip("Axiom")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quick" => toggle_quick_overlay(app),
            "review" => navigate_main(app, "/?view=review"),
            "new_note" => navigate_main(app, "/?edit=1"),
            "open_vault" => {
                let state = app.state::<AppRuntime>();
                let _ = std::process::Command::new("explorer.exe")
                    .arg(&state.backend.vault_path)
                    .spawn();
            }
            "backup" => {
                let handle = app.clone();
                let backend_arc = Arc::clone(&app.state::<AppRuntime>().backend);
                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking(move || backend_arc.trigger_backup())
                        .await
                        .unwrap_or_else(|e| Err(format!("Backup task failed: {e}")));
                    if let Err(err) = result {
                        let _ = handle.emit_to("main", "axiom://toast-error", err);
                    } else {
                        let _ = handle.emit_to("main", "axiom://backup-created", ());
                    }
                });
            }
            "browser" => {
                let state = app.state::<AppRuntime>();
                let url = state.backend.base_url();
                let _ = open_external_url(&url);
            }
            "restart" => {
                let handle = app.clone();
                let backend_arc = Arc::clone(&app.state::<AppRuntime>().backend);
                tauri::async_runtime::spawn(async move {
                    let status = tauri::async_runtime::spawn_blocking(move || backend_arc.restart(false))
                        .await
                        .ok();
                    if let Some(status) = status {
                        update_tray_backend_status(&handle, &status);
                        let _ = handle.emit("axiom://backend-status", status);
                    }
                });
            }
            "check_updates" => {
                let handle = app.clone();
                show_main_window(&handle);
                let _ = handle.emit_to("main", "axiom://open-settings", ());
                tauri::async_runtime::spawn(async move {
                    let (result, update_info) =
                        tauri::async_runtime::spawn_blocking(crate::updater::check_updates)
                            .await
                            .unwrap_or_else(|e| (Err(format!("Update check task failed: {e}")), None));
                    if let Ok(res) = result {
                        if res.available {
                            if let Ok(mut pending) = handle.state::<AppRuntime>().pending_update.lock() {
                                *pending = update_info;
                            }
                            let _ = handle.emit_to("main", "axiom://update-available", res);
                        }
                    }
                });
            }
            "quit" => {
                let state = app.state::<AppRuntime>();
                if state.total_dirty_tabs() > 0 {
                    show_main_window(app);
                    let _ = app.emit_to("main", "axiom://confirm-close", ());
                    return;
                }
                state.quitting.store(true, Ordering::SeqCst);
                state.backend.shutdown_if_spawned();
                app.exit(0);
            }
            _ => {}
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    let state = app.state::<AppRuntime>();
    if let Ok(mut guard) = state.tray.lock() {
        *guard = Some(TrayHandles {
            review_item,
            status_item,
        });
    }
    Ok(())
}

pub fn update_tray_review_count(app: &AppHandle, pending_count: usize, unread_count: usize) {
    let state = app.state::<AppRuntime>();
    if let Ok(guard) = state.tray.lock() {
        if let Some(handles) = guard.as_ref() {
            let label = if pending_count > 0 {
                format!("Review Queue ({pending_count})")
            } else {
                "Review Queue (All caught up)".to_string()
            };
            let _ = handles.review_item.set_text(label);
        }
    }
    if let Some(tray) = app.tray_by_id("axiom-tray") {
        let tip = if unread_count > 0 {
            format!("Axiom - {unread_count} unread, {pending_count} pending review")
        } else if pending_count > 0 {
            format!("Axiom - {pending_count} pending review")
        } else {
            "Axiom - Vault connected".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

pub fn update_tray_backend_status(app: &AppHandle, status: &crate::backend::BackendStatus) {
    let state = app.state::<AppRuntime>();
    if let Ok(guard) = state.tray.lock() {
        if let Some(handles) = guard.as_ref() {
            let text = if status.healthy {
                format!("Backend: {} (127.0.0.1:{})", status.mode, status.port)
            } else {
                "Backend: Disconnected".to_string()
            };
            let _ = handles.status_item.set_text(text);
        }
    };
}

pub fn validate_external_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" | "obsidian" => Ok(parsed),
        scheme => Err(format!("Unsupported URL scheme: {scheme}")),
    }
}

pub fn open_external_url(url: &str) -> Result<(), String> {
    let parsed = validate_external_url(url)?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let op: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let target: Vec<u16> = parsed
            .as_str()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                target.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if (result as isize) <= 32 {
            return Err(format!("Failed to open URL (ShellExecuteW code {}).", result as isize));
        }
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        let _ = parsed;
        Err("External URL launch is configured for Windows.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_validation_allows_safe_schemes_with_query_params() {
        let obsidian = validate_external_url("obsidian://open?vault=Vault&file=Owner%2FNotes%2FTest.md").unwrap();
        assert_eq!(obsidian.scheme(), "obsidian");
        assert!(obsidian.as_str().contains("&file=Owner%2FNotes%2FTest.md"));

        assert!(validate_external_url("http://127.0.0.1:4318/?view=review").is_ok());
        assert!(validate_external_url("https://github.com/AlexMollard/Axiom").is_ok());
        assert!(validate_external_url("file:///C:/Windows/System32/cmd.exe").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("not a url").is_err());
    }
}
