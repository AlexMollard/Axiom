use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPrefs {
    pub close_to_tray: bool,
    pub toast_notifications: bool,
    pub muted_workspaces: Vec<String>,
    pub zoom_percent: u16,
    pub start_minimized: bool,
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            toast_notifications: true,
            muted_workspaces: Vec::new(),
            zoom_percent: 100,
            start_minimized: false,
        }
    }
}

pub fn desktop_state_dir(config_path: &Path) -> PathBuf {
    let parent = config_path.parent().unwrap_or_else(|| Path::new("."));
    parent.join(".state").join("desktop")
}

fn validate_bucket(bucket: &str) -> Result<(), String> {
    match bucket {
        "drafts" | "cleanup" | "notifications" | "session" | "prefs" => Ok(()),
        _ => Err(format!("Unsupported desktop state bucket: {bucket}")),
    }
}

pub fn state_file_path(state_dir: &Path, bucket: &str, key: &str) -> Result<PathBuf, String> {
    validate_bucket(bucket)?;
    if key.is_empty() || key.len() > 2048 {
        return Err("Desktop state key must be 1-2048 characters.".to_string());
    }
    if bucket == "prefs" && key == "settings" {
        return Ok(state_dir.join("prefs").join("settings.json"));
    }
    let mut hasher = Sha256::new();
    hasher.update(key.as_bytes());
    let digest = hex::encode(hasher.finalize());
    Ok(state_dir.join(bucket).join(format!("{digest}.json")))
}

pub fn to_crlf(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    normalized.replace('\n', "\r\n")
}

pub fn atomic_write_crlf(target: &Path, content: &str) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "Target path has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {e}"))?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("state.json");
    let temp = parent.join(format!("{file_name}.{}-{nanos}.tmp", std::process::id()));
    let crlf = to_crlf(content);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| format!("Failed to create temp file: {e}"))?;
    if let Err(e) = file.write_all(crlf.as_bytes()).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temp);
        return Err(format!("Failed to write temp file: {e}"));
    }
    drop(file);
    if let Err(e) = fs::rename(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Failed to finalize file write: {e}"));
    }
    Ok(())
}

pub fn read_state(state_dir: &Path, bucket: &str, key: &str) -> Result<Option<String>, String> {
    let path = state_file_path(state_dir, bucket, key)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Could not read desktop state: {e}")),
    }
}

pub fn write_state(state_dir: &Path, bucket: &str, key: &str, value: &str) -> Result<(), String> {
    let path = state_file_path(state_dir, bucket, key)?;
    atomic_write_crlf(&path, value)
}

pub fn delete_state(state_dir: &Path, bucket: &str, key: &str) -> Result<(), String> {
    let path = state_file_path(state_dir, bucket, key)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete desktop state: {e}")),
    }
}

pub fn load_prefs(state_dir: &Path) -> DesktopPrefs {
    match read_state(state_dir, "prefs", "settings") {
        Ok(Some(raw)) => serde_json::from_str::<DesktopPrefs>(&raw).unwrap_or_default(),
        _ => DesktopPrefs::default(),
    }
}

pub fn save_prefs(state_dir: &Path, prefs: &DesktopPrefs) -> Result<(), String> {
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("Failed to serialize prefs: {e}"))?;
    write_state(state_dir, "prefs", "settings", &(json + "\n"))
}

pub fn load_window_bounds(state_dir: &Path) -> Option<WindowBounds> {
    match read_state(state_dir, "prefs", "window-bounds") {
        Ok(Some(raw)) => serde_json::from_str::<WindowBounds>(&raw).ok(),
        _ => None,
    }
}

pub fn save_window_bounds(state_dir: &Path, bounds: &WindowBounds) -> Result<(), String> {
    let json = serde_json::to_string_pretty(bounds)
        .map_err(|e| format!("Failed to serialize window bounds: {e}"))?;
    write_state(state_dir, "prefs", "window-bounds", &(json + "\n"))
}

fn is_reparse_or_symlink(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        if (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return true;
        }
    }
    false
}

fn is_reserved_windows_name(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or(part).to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

pub fn resolve_vault_file(vault: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.contains('\\')
        || relative.contains(':')
        || relative.contains('\0')
        || relative.starts_with('/')
    {
        return Err("Use a vault-relative forward-slash path.".to_string());
    }
    let parts: Vec<&str> = relative.split('/').collect();
    for part in &parts {
        if part.is_empty()
            || *part == "."
            || *part == ".."
            || part.starts_with('.')
            || part.ends_with('.')
            || part.ends_with(' ')
            || part.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
            || is_reserved_windows_name(part)
        {
            return Err("Unsafe vault path.".to_string());
        }
    }
    let root_meta = fs::symlink_metadata(vault)
        .map_err(|e| format!("Vault root could not be inspected: {e}"))?;
    if !root_meta.is_dir() || is_reparse_or_symlink(&root_meta) {
        return Err("Vault root must be an ordinary directory.".to_string());
    }
    let mut current = vault.to_path_buf();
    for part in parts {
        current.push(part);
        let meta = fs::symlink_metadata(&current)
            .map_err(|e| format!("Vault path could not be accessed: {e}"))?;
        if is_reparse_or_symlink(&meta) {
            return Err("Links and junctions are not allowed in vault paths.".to_string());
        }
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("axiom-storage-test-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_state_roundtrip_and_crlf() {
        let dir = temp_dir("roundtrip");
        write_state(&dir, "drafts", "Owner/Notes/Hello.md", "line1\nline2\n").unwrap();
        let read = read_state(&dir, "drafts", "Owner/Notes/Hello.md")
            .unwrap()
            .unwrap();
        assert_eq!(read, "line1\r\nline2\r\n");
        delete_state(&dir, "drafts", "Owner/Notes/Hello.md").unwrap();
        assert!(read_state(&dir, "drafts", "Owner/Notes/Hello.md")
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_invalid_bucket_and_unsafe_vault_paths() {
        let dir = temp_dir("paths");
        assert!(state_file_path(&dir, "other", "abc").is_err());
        fs::create_dir_all(dir.join("Owner")).unwrap();
        fs::write(dir.join("Owner").join("Test.md"), "# Test").unwrap();

        assert!(resolve_vault_file(&dir, "Owner/Test.md").is_ok());
        assert!(resolve_vault_file(&dir, "../escape.md").is_err());
        assert!(resolve_vault_file(&dir, "Owner\\Test.md").is_err());
        assert!(resolve_vault_file(&dir, "C:/Test.md").is_err());
        assert!(resolve_vault_file(&dir, "Owner/CON.md").is_err());
        assert!(resolve_vault_file(&dir, ".hidden/Test.md").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn window_bounds_roundtrip() {
        let dir = temp_dir("bounds");
        let bounds = WindowBounds {
            x: 120,
            y: 80,
            width: 1440,
            height: 900,
            maximized: true,
        };
        save_window_bounds(&dir, &bounds).unwrap();
        assert_eq!(load_window_bounds(&dir), Some(bounds));
        let _ = fs::remove_dir_all(&dir);
    }
}
