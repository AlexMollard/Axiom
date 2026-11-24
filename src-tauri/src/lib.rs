mod backend;
mod commands;
mod storage;
mod tray;
mod updater;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use backend::{resolve_config_path, BackendManager};
use storage::{desktop_state_dir, load_prefs, load_window_bounds, save_window_bounds, WindowBounds};
use tray::{setup_tray, show_main_window, toggle_quick_overlay, update_tray_backend_status, AppRuntime};

fn fallback_error_html(error: &str, config_path: &str) -> String {
    let escaped_err = error
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let escaped_cfg = config_path
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Axiom - Startup Error</title>
<style>
  body {{ margin: 0; font-family: system-ui, sans-serif; background: #181716; color: #f0ebe6; padding: 48px; line-height: 1.6; }}
  .card {{ max-width: 640px; margin: 40px auto; background: #211f1e; border: 1px solid #3b3430; border-radius: 14px; padding: 28px; }}
  h1 {{ margin-top: 0; font-size: 22px; color: #efb99d; }}
  code {{ display: block; background: #191715; padding: 10px 12px; border-radius: 8px; color: #d0c5bb; overflow-wrap: anywhere; }}
  .err {{ color: #e2a18f; background: #34231f; border: 1px solid #795442; padding: 12px; border-radius: 8px; }}
  button {{ margin-top: 16px; padding: 10px 16px; border-radius: 8px; border: 0; background: #d39476; color: #231812; font-weight: 700; cursor: pointer; }}
</style>
</head>
<body>
  <div class="card">
    <h1>Axiom could not connect to its local backend</h1>
    <p class="err">{escaped_err}</p>
    <p>Configuration path:</p>
    <code>{escaped_cfg}</code>
    <button onclick="location.reload()">Retry</button>
  </div>
</body>
</html>"#
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
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
        ])
        .setup(|app| {
            let config_path = resolve_config_path(None)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotFound, e))?;
            let state_dir = desktop_state_dir(&config_path);
            let prefs = load_prefs(&state_dir);
            let mut manager = BackendManager::new(config_path.clone())
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            let status = manager.ensure_running();

            let status_label = if status.healthy {
                format!("Backend: {} (127.0.0.1:{})", status.mode, status.port)
            } else {
                "Backend: Disconnected".to_string()
            };

            let saved_bounds = load_window_bounds(&state_dir);
            let state_dir_for_events = state_dir.clone();
            app.manage(AppRuntime {
                backend: Arc::new(Mutex::new(manager)),
                state_dir,
                prefs: Mutex::new(prefs.clone()),
                dirty_tabs: AtomicUsize::new(0),
                quitting: AtomicBool::new(false),
                tray: Mutex::new(None),
                pending_update: Mutex::new(None),
            });

            if let Err(err) = setup_tray(app.handle(), &status_label) {
                eprintln!("Tray setup warning: {err}");
            }

            if let Err(err) = app.global_shortcut().register("CommandOrControl+Alt+K") {
                eprintln!("Global shortcut warning (Ctrl+Alt+K): {err}");
            }

            let base_url = status.base_url.clone();
            let main_url = if status.healthy {
                let parsed: url::Url = format!("{base_url}/")
                    .parse()
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
                WebviewUrl::External(parsed)
            } else {
                let html = fallback_error_html(
                    status.error.as_deref().unwrap_or("Unknown error"),
                    &status.config_path,
                );
                let data_url = format!(
                    "data:text/html;charset=utf-8,{}",
                    urlencoding::encode(&html)
                );
                let parsed: url::Url = data_url
                    .parse()
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
                WebviewUrl::External(parsed)
            };

            let mut main_builder = WebviewWindowBuilder::new(app, "main", main_url)
                .title("Axiom")
                .inner_size(1360.0, 880.0)
                .min_inner_size(860.0, 560.0)
                .decorations(false)
                .visible(false)
                .background_color(tauri::window::Color(0x18, 0x17, 0x16, 0xff));
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png")) {
                main_builder = main_builder.icon(icon)?;
            }
            let main_win = main_builder.build()?;

            if let Some(bounds) = saved_bounds {
                if bounds.width >= 860 && bounds.height >= 560 {
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
                        if bounds.maximized {
                            let _ = main_win.maximize();
                        }
                    }
                }
            }
            if !prefs.start_minimized {
                let _ = main_win.show();
            }

            let handle_for_close = app.handle().clone();
            let main_win_for_bounds = main_win.clone();
            let persist_bounds = move || {
                let minimized = main_win_for_bounds.is_minimized().unwrap_or(false);
                if minimized {
                    return;
                }
                let maximized = main_win_for_bounds.is_maximized().unwrap_or(false);
                if let (Ok(pos), Ok(size)) = (
                    main_win_for_bounds.outer_position(),
                    main_win_for_bounds.inner_size(),
                ) {
                    if size.width >= 860 && size.height >= 560 {
                        let existing = load_window_bounds(&state_dir_for_events);
                        let (x, y, width, height) = if maximized {
                            if let Some(prev) = existing {
                                (prev.x, prev.y, prev.width, prev.height)
                            } else {
                                (pos.x, pos.y, size.width, size.height)
                            }
                        } else {
                            (pos.x, pos.y, size.width, size.height)
                        };
                        let _ = save_window_bounds(
                            &state_dir_for_events,
                            &WindowBounds {
                                x,
                                y,
                                width,
                                height,
                                maximized,
                            },
                        );
                    }
                }
            };

            main_win.on_window_event(move |event| match event {
                WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                    persist_bounds();
                }
                WindowEvent::CloseRequested { api, .. } => {
                    persist_bounds();
                    let state = handle_for_close.state::<AppRuntime>();
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
                        if let Some(w) = handle_for_close.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        return;
                    }
                    if state.dirty_tabs.load(Ordering::SeqCst) > 0 {
                        api.prevent_close();
                        let _ = handle_for_close.emit_to("main", "axiom://confirm-close", ());
                        return;
                    }
                    state.quitting.store(true, Ordering::SeqCst);
                    if let Ok(mut backend) = state.backend.lock() {
                        backend.shutdown_if_spawned();
                    };
                }
                _ => {}
            });

            if status.healthy {
                let quick_url: url::Url = format!("{base_url}/?desktopMode=quick")
                    .parse()
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
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
                    quick_builder = quick_builder.icon(icon)?;
                }
                let quick_win = quick_builder.build()?;
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
                    let next = tauri::async_runtime::spawn_blocking(move || {
                        if let Ok(mut backend) = backend_arc.lock() {
                            Some(backend.current_status())
                        } else {
                            None
                        }
                    })
                    .await
                    .ok()
                    .flatten();
                    if let Some(next) = next {
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
                let state = app.state::<AppRuntime>();
                state.quitting.store(true, Ordering::SeqCst);
                if let Ok(mut backend) = state.backend.lock() {
                    backend.shutdown_if_spawned();
                };
            }
        });
}
