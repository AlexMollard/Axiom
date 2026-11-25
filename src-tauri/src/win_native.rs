use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Manager, WebviewWindow};

pub const AUMID: &str = "com.alexmollard.axiom";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkAction {
    Route(String),
    ToggleQuick,
}

fn has_raw_traversal(raw: &str) -> bool {
    let without_fragment = raw.split('#').next().unwrap_or(raw);
    let (before_query, query_part) = match without_fragment.split_once('?') {
        Some((left, right)) => (left, Some(right)),
        None => (without_fragment, None),
    };
    if let Some(after_scheme) = before_query.split("://").nth(1) {
        if let Some((_host, path_part)) = after_scheme.split_once('/') {
            if path_part
                .split('/')
                .any(|seg| seg == "." || seg == ".." || seg.eq_ignore_ascii_case("%2e%2e") || seg.eq_ignore_ascii_case("%2e"))
            {
                return true;
            }
        }
    }
    if let Some(q) = query_part {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k.eq_ignore_ascii_case("path") {
                    let v_norm = v.replace("%2f", "/").replace("%2F", "/");
                    if v_norm.split('/').any(|seg| seg == "." || seg == "..") {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn validate_safe_note_path(candidate: &str) -> Option<String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains('\\')
        || trimmed.contains(':')
        || trimmed.contains('\0')
    {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.iter().any(|part| {
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.starts_with('.')
            || part.ends_with('.')
            || part.ends_with(' ')
            || part.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    }) {
        return None;
    }
    if !trimmed.to_ascii_lowercase().ends_with(".md") {
        return None;
    }
    Some(trimmed.to_string())
}

fn is_valid_workspace_id(id: &str) -> bool {
    if id == "global" || id == "__unmapped" {
        return true;
    }
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub fn parse_deep_link(raw: &str) -> Option<DeepLinkAction> {
    let trimmed = raw.trim();
    if has_raw_traversal(trimmed) {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "axiom" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    match host.as_str() {
        "review" => Some(DeepLinkAction::Route("/?view=review".to_string())),
        "new" => Some(DeepLinkAction::Route("/?edit=1".to_string())),
        "graph" => Some(DeepLinkAction::Route("/?view=graph".to_string())),
        "quick" => Some(DeepLinkAction::ToggleQuick),
        "search" => {
            let query = parsed
                .query_pairs()
                .find(|(k, _)| k == "q")
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default();
            let q = query.trim();
            if q.is_empty() {
                Some(DeepLinkAction::Route("/?view=search".to_string()))
            } else {
                Some(DeepLinkAction::Route(format!("/?q={}", urlencoding::encode(q))))
            }
        }
        "workspace" => {
            let raw_path = parsed.path().trim_matches('/');
            if raw_path.is_empty() || raw_path.contains('/') {
                return None;
            }
            let decoded = urlencoding::decode(raw_path).ok()?.into_owned();
            if !is_valid_workspace_id(&decoded) {
                return None;
            }
            Some(DeepLinkAction::Route(format!(
                "/?workspace={}",
                urlencoding::encode(&decoded)
            )))
        }
        "note" | "open" => {
            let from_query = parsed
                .query_pairs()
                .find(|(k, _)| k == "path")
                .map(|(_, v)| v.into_owned());
            let raw_candidate = match from_query {
                Some(v) => v,
                None => urlencoding::decode(parsed.path().trim_start_matches('/'))
                    .ok()?
                    .into_owned(),
            };
            let safe = validate_safe_note_path(&raw_candidate)?;
            Some(DeepLinkAction::Route(format!(
                "/?note={}",
                urlencoding::encode(&safe)
            )))
        }
        _ => None,
    }
}

pub fn parse_launch_action(args: &[String]) -> Option<DeepLinkAction> {
    for arg in args.iter().skip(1) {
        let trimmed = arg.trim();
        if trimmed.len() >= 8 && trimmed[..8].eq_ignore_ascii_case("axiom://") {
            return parse_deep_link(trimmed);
        }
        match trimmed {
            "--quick" => return Some(DeepLinkAction::ToggleQuick),
            "--review" => return Some(DeepLinkAction::Route("/?view=review".to_string())),
            "--new-note" => return Some(DeepLinkAction::Route("/?edit=1".to_string())),
            "--graph" => return Some(DeepLinkAction::Route("/?view=graph".to_string())),
            _ => {}
        }
    }
    None
}

fn glyph_3x5(ch: char) -> [u8; 5] {
    match ch {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b001, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

fn draw_glyph(buf: &mut [u8], ch: char, ox: usize, oy: usize) {
    let rows = glyph_3x5(ch);
    for (dy, bits) in rows.iter().enumerate() {
        for dx in 0..3 {
            if (bits >> (2 - dx)) & 1 == 1 {
                let x = ox + dx;
                let y = oy + dy;
                if x < 16 && y < 16 {
                    let idx = (y * 16 + x) * 4;
                    buf[idx] = 0x18;
                    buf[idx + 1] = 0x17;
                    buf[idx + 2] = 0x16;
                    buf[idx + 3] = 0xff;
                }
            }
        }
    }
}

pub fn render_badge_rgba(count: usize) -> Option<Vec<u8>> {
    if count == 0 {
        return None;
    }
    let mut buf = vec![0u8; 16 * 16 * 4];
    for y in 0..16 {
        for x in 0..16 {
            let dx = x as f32 - 7.5;
            let dy = y as f32 - 7.5;
            let dist = (dx * dx + dy * dy).sqrt();
            let idx = (y * 16 + x) * 4;
            if dist <= 6.1 {
                buf[idx] = 211;
                buf[idx + 1] = 148;
                buf[idx + 2] = 118;
                buf[idx + 3] = 255;
            } else if dist <= 7.2 {
                buf[idx] = 0x18;
                buf[idx + 1] = 0x17;
                buf[idx + 2] = 0x16;
                buf[idx + 3] = 255;
            }
        }
    }
    if count <= 9 {
        let ch = char::from_digit(count as u32, 10).unwrap_or('9');
        draw_glyph(&mut buf, ch, 6, 5);
    } else {
        draw_glyph(&mut buf, '9', 4, 5);
        draw_glyph(&mut buf, '+', 8, 5);
    }
    Some(buf)
}

pub fn update_taskbar_badge(app: &AppHandle, pending_count: usize) {
    if let Some(main_win) = app.get_webview_window("main") {
        let icon = render_badge_rgba(pending_count)
            .map(|rgba| tauri::image::Image::new_owned(rgba, 16, 16));
        let _ = main_win.set_overlay_icon(icon);
    }
}

pub fn set_taskbar_progress(app: &AppHandle, percent: Option<u64>) {
    if let Some(main_win) = app.get_webview_window("main") {
        let state = ProgressBarState {
            status: Some(if percent.is_some() {
                ProgressBarStatus::Normal
            } else {
                ProgressBarStatus::None
            }),
            progress: percent.map(|p| p.min(100)),
        };
        let _ = main_win.set_progress_bar(state);
    }
}

pub fn apply_win11_window_polish_with_border(window: &WebviewWindow, border_color: u32) {
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        use windows_sys::Win32::Foundation::HWND;
        use windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute;

        const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
        const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
        const DWMWA_BORDER_COLOR: u32 = 34;
        const DWMWA_CAPTION_COLOR: u32 = 35;
        const DWMWCP_ROUND: i32 = 2;

        if let Ok(raw_hwnd) = window.hwnd() {
            let hwnd: HWND = raw_hwnd.0 as HWND;
            let dark: i32 = 1;
            let round: i32 = DWMWCP_ROUND;
            let caption_color: u32 = 0x0011_1213;
            unsafe {
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_USE_IMMERSIVE_DARK_MODE,
                    &dark as *const i32 as *const c_void,
                    std::mem::size_of::<i32>() as u32,
                );
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &round as *const i32 as *const c_void,
                    std::mem::size_of::<i32>() as u32,
                );
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_BORDER_COLOR,
                    &border_color as *const u32 as *const c_void,
                    std::mem::size_of::<u32>() as u32,
                );
                let _ = DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_CAPTION_COLOR,
                    &caption_color as *const u32 as *const c_void,
                    std::mem::size_of::<u32>() as u32,
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, border_color);
    }
}

pub fn apply_win11_window_polish(window: &WebviewWindow) {
    apply_win11_window_polish_with_border(window, 0x0024_272b);
}

pub fn trigger_snap_layouts() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_LWIN,
        };

        let make_key = |vk: u16, flags: u32| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        let inputs = [
            make_key(VK_LWIN, 0),
            make_key(0x5A, 0),
            make_key(0x5A, KEYEVENTF_KEYUP),
            make_key(VK_LWIN, KEYEVENTF_KEYUP),
        ];
        unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<INPUT>() as i32,
            );
        }
    }
}

#[cfg(windows)]
fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn set_hkcu_string(subkey: &str, value_name: Option<&str>, data: &str) {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    let sub_w = to_wide(subkey);
    let mut hkey: HKEY = std::ptr::null_mut();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            sub_w.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            std::ptr::null(),
            &mut hkey,
            std::ptr::null_mut(),
        )
    };
    if status != 0 || hkey.is_null() {
        return;
    }
    let name_w = value_name.map(to_wide);
    let name_ptr = name_w.as_ref().map_or(std::ptr::null(), |v| v.as_ptr());
    let data_w = to_wide(data);
    let byte_len = (data_w.len() * std::mem::size_of::<u16>()) as u32;
    unsafe {
        let _ = RegSetValueExW(
            hkey,
            name_ptr,
            0,
            REG_SZ,
            data_w.as_ptr() as *const u8,
            byte_len,
        );
        let _ = RegCloseKey(hkey);
    }
}

pub fn register_protocol_handler() {
    #[cfg(windows)]
    {
        let Ok(exe_path) = std::env::current_exe() else {
            return;
        };
        let exe = exe_path.to_string_lossy();
        if exe.is_empty() {
            return;
        }
        set_hkcu_string(r"Software\Classes\axiom", None, "URL:Axiom Protocol");
        set_hkcu_string(r"Software\Classes\axiom", Some("URL Protocol"), "");
        set_hkcu_string(
            r"Software\Classes\axiom\DefaultIcon",
            None,
            &format!("\"{exe}\",0"),
        );
        set_hkcu_string(
            r"Software\Classes\axiom\shell\open\command",
            None,
            &format!("\"{exe}\" \"%1\""),
        );
    }
}

pub fn unregister_protocol_handler() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};

        let key = to_wide(r"Software\Classes\axiom");
        unsafe {
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, key.as_ptr());
        }
    }
}

#[cfg(windows)]
struct ComApartmentGuard(bool);

#[cfg(windows)]
impl Drop for ComApartmentGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

pub fn setup_jump_list() {
    #[cfg(windows)]
    {
        if let Err(err) = setup_jump_list_inner() {
            eprintln!("Jump List setup warning: {err}");
        }
    }
}

#[cfg(windows)]
fn setup_jump_list_inner() -> windows::core::Result<()> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
    };

    let exe_path = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    if exe_path.is_empty() {
        return Ok(());
    }

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let _guard = ComApartmentGuard(hr.is_ok());

        let list: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        list.SetAppID(&HSTRING::from(AUMID))?;
        let mut min_slots: u32 = 0;
        let _removed: IObjectArray = list.BeginList(&mut min_slots)?;

        let collection: IObjectCollection =
            CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        let tasks = [
            ("Quick Search / Capture", "--quick"),
            ("Review Queue", "--review"),
            ("New Note", "--new-note"),
            ("Vault Graph", "--graph"),
        ];
        for (title, args) in tasks {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(&HSTRING::from(exe_path.as_str()))?;
            link.SetArguments(&HSTRING::from(args))?;
            link.SetDescription(&HSTRING::from(title))?;
            let store: IPropertyStore = link.cast()?;
            let prop = PROPVARIANT::from(title);
            store.SetValue(&PKEY_Title, &prop)?;
            store.Commit()?;
            collection.AddObject(&link)?;
        }

        let array: IObjectArray = collection.cast()?;
        list.AddUserTasks(&array)?;
        list.CommitList()?;
    }
    Ok(())
}

pub fn attach_webview_crash_recovery(window: &WebviewWindow, fallback_url: String) {
    #[cfg(windows)]
    {
        use std::sync::{Arc, Mutex};
        use std::time::{Duration, Instant};
        use webview2_com::ProcessFailedEventHandler;
        use windows::core::HSTRING;

        let crashes: Arc<Mutex<Vec<Instant>>> = Arc::new(Mutex::new(Vec::new()));
        let _ = window.with_webview(move |webview| unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            let crash_log = Arc::clone(&crashes);
            let url_copy = fallback_url.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, _args| {
                let now = Instant::now();
                let should_reload = if let Ok(mut list) = crash_log.lock() {
                    list.retain(|t| now.duration_since(*t) <= Duration::from_secs(30));
                    list.push(now);
                    list.len() <= 3
                } else {
                    false
                };
                if !should_reload {
                    eprintln!("WebView2 process failed repeatedly (>3 in 30s); auto-reload paused.");
                    return Ok(());
                }
                eprintln!("WebView2 process failed; attempting automatic reload.");
                if let Some(wv) = sender {
                    if wv.Reload().is_err() {
                        let _ = wv.Navigate(&HSTRING::from(url_copy.as_str()));
                    }
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_ProcessFailed(&handler, &mut token);
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (window, fallback_url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_and_rejects_unsafe_deep_links() {
        assert_eq!(
            parse_deep_link("axiom://note/Owner/Policies.md"),
            Some(DeepLinkAction::Route("/?note=Owner%2FPolicies.md".to_string()))
        );
        assert_eq!(
            parse_deep_link("axiom://open?path=Agents%2FMemory%2Fa.md"),
            Some(DeepLinkAction::Route("/?note=Agents%2FMemory%2Fa.md".to_string()))
        );
        assert_eq!(
            parse_deep_link("axiom://review"),
            Some(DeepLinkAction::Route("/?view=review".to_string()))
        );
        assert_eq!(
            parse_deep_link("axiom://new"),
            Some(DeepLinkAction::Route("/?edit=1".to_string()))
        );
        assert_eq!(
            parse_deep_link("axiom://graph"),
            Some(DeepLinkAction::Route("/?view=graph".to_string()))
        );
        assert_eq!(
            parse_deep_link("axiom://search?q=sqlite+fts5"),
            Some(DeepLinkAction::Route("/?q=sqlite%20fts5".to_string()))
        );
        assert_eq!(
            parse_deep_link("axiom://workspace/alpha"),
            Some(DeepLinkAction::Route("/?workspace=alpha".to_string()))
        );
        assert_eq!(
            parse_deep_link("axiom://quick"),
            Some(DeepLinkAction::ToggleQuick)
        );

        assert_eq!(parse_deep_link("axiom://note/../secret.md"), None);
        assert_eq!(parse_deep_link("axiom://note/C:bad.md"), None);
        assert_eq!(parse_deep_link("axiom://open?path=../escape.md"), None);
        assert_eq!(parse_deep_link("https://example.com/review"), None);
        assert_eq!(parse_deep_link("axiom://workspace/bad/id"), None);
    }

    #[test]
    fn parses_cli_flags_and_deep_link_launch_args() {
        let mk = |items: &[&str]| items.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            parse_launch_action(&mk(&["axiom.exe", "--quick"])),
            Some(DeepLinkAction::ToggleQuick)
        );
        assert_eq!(
            parse_launch_action(&mk(&["axiom.exe", "--review"])),
            Some(DeepLinkAction::Route("/?view=review".to_string()))
        );
        assert_eq!(
            parse_launch_action(&mk(&["axiom.exe", "--new-note"])),
            Some(DeepLinkAction::Route("/?edit=1".to_string()))
        );
        assert_eq!(
            parse_launch_action(&mk(&["axiom.exe", "--graph"])),
            Some(DeepLinkAction::Route("/?view=graph".to_string()))
        );
        assert_eq!(
            parse_launch_action(&mk(&["axiom.exe", "axiom://review"])),
            Some(DeepLinkAction::Route("/?view=review".to_string()))
        );
        assert_eq!(parse_launch_action(&mk(&["axiom.exe"])), None);
    }

    #[test]
    fn renders_taskbar_badge_pixels() {
        assert!(render_badge_rgba(0).is_none());
        let one = render_badge_rgba(1).expect("badge 1");
        assert_eq!(one.len(), 16 * 16 * 4);
        assert!(one.chunks_exact(4).any(|px| px[3] > 0));
        let many = render_badge_rgba(42).expect("badge 42");
        assert_eq!(many.len(), 16 * 16 * 4);
        assert_ne!(one, many);
    }
}
