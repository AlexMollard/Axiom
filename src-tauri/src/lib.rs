mod backend;
mod commands;
mod storage;
mod tray;
mod updater;
mod win_native;

pub use backend::stop_current_dir_node_backend;
pub use win_native::{register_protocol_handler, unregister_protocol_handler};

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use backend::{resolve_config_path, BackendManager};
use storage::{desktop_state_dir, load_prefs, load_window_bounds, save_window_bounds, WindowBounds};
use tray::{
    setup_tray, show_main_window, toggle_quick_overlay, update_tray_backend_status, AppRuntime,
};

fn compute_window_bounds(win: &WebviewWindow, state: &AppRuntime) -> Option<WindowBounds> {
    if win.is_minimized().unwrap_or(false) {
        return None;
    }
    let maximized = win.is_maximized().unwrap_or(false);
    let scale = win.scale_factor().unwrap_or(1.0);
    let pos = win.outer_position().ok()?;
    let size = win.inner_size().ok()?;
    let logical = size.to_logical::<f64>(scale);
    if logical.width < 860.0 || logical.height < 560.0 {
        return None;
    }
    if maximized {
        let prev = state
            .pending_bounds
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .or_else(|| load_window_bounds(&state.state_dir));
        if let Some(prev) = prev {
            return Some(WindowBounds {
                x: prev.x,
                y: prev.y,
                width: prev.width,
                height: prev.height,
                maximized: true,
            });
        }
    }
    Some(WindowBounds {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
    })
}

fn schedule_bounds_save(app: &AppHandle, win: &WebviewWindow) {
    let state = app.state::<AppRuntime>();
    let Some(bounds) = compute_window_bounds(win, &state) else {
        return;
    };
    if let Ok(mut pending) = state.pending_bounds.lock() {
        *pending = Some(bounds);
    }
    let seq = state.bounds_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let state = handle.state::<AppRuntime>();
        if state.bounds_seq.load(Ordering::SeqCst) != seq {
            return;
        }
        let snapshot = state.pending_bounds.lock().ok().and_then(|g| g.clone());
        if let Some(bounds) = snapshot {
            let state_dir = state.state_dir.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = save_window_bounds(&state_dir, &bounds);
            })
            .await;
        }
    });
}

fn flush_bounds_now(app: &AppHandle, win: Option<&WebviewWindow>) {
    let state = app.state::<AppRuntime>();
    if let Some(w) = win {
        if let Some(bounds) = compute_window_bounds(w, &state) {
            if let Ok(mut pending) = state.pending_bounds.lock() {
                *pending = Some(bounds);
            }
        }
    }
    state.bounds_seq.fetch_add(1, Ordering::SeqCst);
    let snapshot = state.pending_bounds.lock().ok().and_then(|g| g.clone());
    if let Some(bounds) = snapshot {
        let _ = save_window_bounds(&state.state_dir, &bounds);
    }
}

fn ensure_quick_capture_window(app: &AppHandle, base_url: &str) {
    if app.get_webview_window("quick-capture").is_some() {
        return;
    }
    let Ok(quick_url) = format!("{base_url}/?desktopMode=quick").parse::<url::Url>() else {
        return;
    };
    let mut quick_builder = WebviewWindowBuilder::new(
        app,
        "quick-capture",
        WebviewUrl::External(quick_url),
    )
    .title("Axiom Quick")
    .inner_size(780.0, 500.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .background_color(tauri::window::Color(0x18, 0x17, 0x16, 0xff));
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")) {
        if let Ok(with_icon) = quick_builder.icon(icon) {
            quick_builder = with_icon;
        } else {
            return;
        }
    }
    if let Ok(quick_win) = quick_builder.build() {
        win_native::apply_win11_window_polish_with_border(&quick_win, 0x0042_5479);
        win_native::attach_webview_crash_recovery(&quick_win, format!("{base_url}/?desktopMode=quick"));
        let quick_handle = quick_win.clone();
        quick_win.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = quick_handle.hide();
            }
            WindowEvent::Focused(false) => {
                let _ = quick_handle.hide();
            }
            _ => {}
        });
    }
}

fn dispatch_launch_action(app: &AppHandle, action: Option<win_native::DeepLinkAction>) {
    match action {
        Some(win_native::DeepLinkAction::ToggleQuick) => toggle_quick_overlay(app),
        Some(win_native::DeepLinkAction::Route(route)) => tray::navigate_main(app, &route),
        None => show_main_window(app),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            dispatch_launch_action(app, win_native::parse_launch_action(&args));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_quick_overlay(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::desktop_info,
            commands::desktop_backend_status,
            commands::desktop_restart_backend,
            commands::desktop_trigger_backup,
            commands::desktop_get_prefs,
            commands::desktop_save_prefs,
            commands::desktop_read_state,
            commands::desktop_write_state,
            commands::desktop_delete_state,
            commands::desktop_save_file,
            commands::desktop_open_in_obsidian,
            commands::desktop_open_in_vscode,
            commands::desktop_reveal_in_explorer,
            commands::desktop_open_in_browser,
            commands::desktop_notify,
            commands::desktop_set_tray_state,
            commands::desktop_open_note_window,
            commands::desktop_toggle_quick_overlay,
            commands::desktop_focus_main_route,
            commands::desktop_hide_quick_overlay,
            commands::desktop_set_dirty_tabs,
            commands::desktop_quit,
            commands::desktop_check_updates,
            commands::desktop_install_update,
            commands::desktop_open_snap_layouts,
        ])
        .setup(|app| {
            tauri::async_runtime::spawn_blocking(|| {
                win_native::register_protocol_handler();
                win_native::setup_jump_list();
            });

            let config_path = resolve_config_path(None)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, e))?;
            let state_dir = desktop_state_dir(&config_path);
            let prefs = load_prefs(&state_dir);
            let manager = BackendManager::new(config_path.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            let status = manager.ensure_running();

            let status_label = if status.healthy {
                format!("Backend: {} (127.0.0.1:{})", status.mode, status.port)
            } else {
                "Backend: Disconnected".to_string()
            };

            let saved_bounds = load_window_bounds(&state_dir);
            let initial_args: Vec<String> = std::env::args().collect();
            let initial_action = win_native::parse_launch_action(&initial_args);
            let force_show_main = matches!(initial_action, Some(win_native::DeepLinkAction::Route(_)));
            let initial_deferred_max = !force_show_main
                && prefs.start_minimized
                && saved_bounds.as_ref().is_some_and(|b| b.maximized);
            app.manage(AppRuntime {
                backend: Arc::new(manager),
                state_dir,
                prefs: Mutex::new(prefs.clone()),
                dirty_tabs: Mutex::new(HashMap::new()),
                quitting: AtomicBool::new(false),
                update_in_flight: AtomicBool::new(false),
                deferred_maximize: AtomicBool::new(initial_deferred_max),
                tray: Mutex::new(None),
                pending_update: Mutex::new(None),
                saved_files: Mutex::new(HashSet::new()),
                pending_bounds: Mutex::new(saved_bounds.clone()),
                bounds_seq: AtomicU64::new(0),
            });

            if let Err(err) = setup_tray(app.handle(), &status_label) {
                eprintln!("Tray setup warning: {err}");
            }

            if let Err(err) = app.global_shortcut().register("CommandOrControl+Alt+K") {
                eprintln!("Global shortcut warning (Ctrl+Alt+K): {err}");
            }

            let base_url = status.base_url.clone();
            let initial_route = match &initial_action {
                Some(win_native::DeepLinkAction::Route(route)) => route.as_str(),
                _ => "/",
            };
            let main_url = if status.healthy {
                let parsed: url::Url = format!("{base_url}{initial_route}")
                    .parse()
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
                WebviewUrl::External(parsed)
            } else {
                WebviewUrl::App("index.html".into())
            };

            let main_win = WebviewWindowBuilder::new(app, "main", main_url)
                .title("Axiom")
                .inner_size(1360.0, 880.0)
                .min_inner_size(860.0, 560.0)
                .decorations(false)
                .visible(false)
                .background_color(tauri::window::Color(0x18, 0x17, 0x16, 0xff))
                .build()?;
            win_native::apply_win11_window_polish(&main_win);
            win_native::attach_webview_crash_recovery(&main_win, format!("{base_url}/"));

            if let Some(bounds) = saved_bounds {
                let scale = main_win.scale_factor().unwrap_or(1.0);
                let logical_w = bounds.width as f64 / scale;
                let logical_h = bounds.height as f64 / scale;
                if logical_w >= 860.0 && logical_h >= 560.0 {
                    let monitors = main_win.available_monitors().unwrap_or_default();
                    let visible_on_monitor = monitors.iter().any(|m| {
                        let pos = m.position();
                        let sz = m.size();
                        let right = pos.x + sz.width as i32;
                        let bottom = pos.y + sz.height as i32;
                        bounds.x + 80 > pos.x
                            && bounds.x < right - 80
                            && bounds.y + 40 > pos.y
                            && bounds.y < bottom - 40
                    });
                    if visible_on_monitor {
                        let _ = main_win.set_position(tauri::Position::Physical(
                            tauri::PhysicalPosition::new(bounds.x, bounds.y),
                        ));
                        let _ = main_win.set_size(tauri::Size::Physical(
                            tauri::PhysicalSize::new(bounds.width, bounds.height),
                        ));
                        if bounds.maximized && (!prefs.start_minimized || force_show_main) {
                            let _ = main_win.maximize();
                        }
                    }
                }
            }
            #[cfg(windows)]
            win_native::refresh_main_window_icon(&main_win);
            if !prefs.start_minimized || force_show_main {
                let _ = main_win.show();
            }

            let handle_for_events = app.handle().clone();
            let main_win_for_events = main_win.clone();
            main_win.on_window_event(move |event| match event {
                #[cfg(windows)]
                WindowEvent::ScaleFactorChanged { .. } => {
                    win_native::refresh_main_window_icon(&main_win_for_events);
                }
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                    schedule_bounds_save(&handle_for_events, &main_win_for_events);
                }
                WindowEvent::CloseRequested { api, .. } => {
                    flush_bounds_now(&handle_for_events, Some(&main_win_for_events));
                    let state = handle_for_events.state::<AppRuntime>();
                    if state.quitting.load(Ordering::SeqCst) {
                        return;
                    }
                    let close_to_tray = state
                        .prefs
                        .lock()
                        .map(|p| p.close_to_tray)
                        .unwrap_or(true);
                    if close_to_tray {
                        api.prevent_close();
                        if let Some(w) = handle_for_events.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        return;
                    }
                    if state.total_dirty_tabs() > 0 {
                        api.prevent_close();
                        let _ = handle_for_events.emit_to("main", "axiom://confirm-close", ());
                        return;
                    }
                    state.quitting.store(true, Ordering::SeqCst);
                    state.backend.shutdown_if_spawned();
                }
                _ => {}
            });

            if status.healthy {
                ensure_quick_capture_window(app.handle(), &base_url);
                if matches!(initial_action, Some(win_native::DeepLinkAction::ToggleQuick)) {
                    toggle_quick_overlay(app.handle());
                }
            }

            let monitor_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut prev_healthy = status.healthy;
                loop {
                    tokio::time::sleep(Duration::from_secs(4)).await;
                    let state = monitor_handle.state::<AppRuntime>();
                    if state.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    let backend_arc = Arc::clone(&state.backend);
                    let next = tauri::async_runtime::spawn_blocking(move || backend_arc.current_status())
                        .await
                        .ok();
                    if let Some(next) = next {
                        if next.healthy {
                            ensure_quick_capture_window(&monitor_handle, &next.base_url);
                            if !prev_healthy {
                                if let Some(main_win) = monitor_handle.get_webview_window("main") {
                                    if let Ok(url) = main_win.url() {
                                        if url.host_str() != Some("127.0.0.1")
                                            && url.host_str() != Some("localhost")
                                        {
                                            if let Ok(target) = format!("{}/", next.base_url).parse() {
                                                let _ = main_win.navigate(target);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if next.healthy != prev_healthy {
                            prev_healthy = next.healthy;
                            update_tray_backend_status(&monitor_handle, &next);
                            let _ = monitor_handle.emit("axiom://backend-status", &next);
                        }
                    }
                }
            });

            let update_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(8)).await;
                let state = update_handle.state::<AppRuntime>();
                if state.quitting.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok((Ok(res), update_info)) =
                    tauri::async_runtime::spawn_blocking(updater::check_updates).await
                {
                    if res.available {
                        if let Ok(mut pending) = state.pending_update.lock() {
                            *pending = update_info;
                        }
                        let _ = update_handle.emit_to("main", "axiom://update-available", res);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Axiom desktop application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                flush_bounds_now(app, None);
                let state = app.state::<AppRuntime>();
                state.quitting.store(true, Ordering::SeqCst);
                state.backend.shutdown_if_spawned();
            }
        });
}
