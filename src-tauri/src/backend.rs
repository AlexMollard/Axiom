use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AxiomConfigFile {
    pub vault: String,
    pub backup_dir: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendStatus {
    pub mode: String,
    pub healthy: bool,
    pub port: u16,
    pub base_url: String,
    pub config_path: String,
    pub config_id: String,
    pub vault_path: String,
    pub vault_name: String,
    pub backup_dir: String,
    pub pid: Option<u32>,
    pub uptime_seconds: Option<f64>,
    pub error: Option<String>,
}

const REQUIRED_BACKEND_API_VERSION: u32 = 2;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    api_version: Option<u32>,
    app_version: Option<String>,
    pid: Option<u32>,
    config_id: Option<String>,
    uptime_seconds: Option<f64>,
}

pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

pub fn canonicalize_config_path(requested: &Path) -> Result<PathBuf, String> {
    let abs = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Failed to read working directory: {e}"))?
            .join(requested)
    };
    match fs::canonicalize(&abs) {
        Ok(canon) => Ok(strip_verbatim_prefix(&canon)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = abs
                .parent()
                .ok_or_else(|| "Config path has no parent directory.".to_string())?;
            let name = abs
                .file_name()
                .ok_or_else(|| "Config path has no file name.".to_string())?;
            let canon_parent = fs::canonicalize(parent)
                .map_err(|pe| format!("Config parent directory does not exist: {pe}"))?;
            Ok(strip_verbatim_prefix(&canon_parent).join(name))
        }
        Err(e) => Err(format!("Could not resolve config path: {e}")),
    }
}

pub fn compute_config_id(canonical_config_path: &Path) -> String {
    let lower = canonical_config_path.to_string_lossy().to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(lower.as_bytes());
    let digest = hex::encode(hasher.finalize());
    digest[..16].to_ascii_uppercase()
}

pub fn resolve_config_path(cli_override: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(p) = cli_override {
        return canonicalize_config_path(&p);
    }
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let s = arg.to_string_lossy();
        if s == "--config" {
            if let Some(val) = args.next() {
                return canonicalize_config_path(Path::new(&val));
            }
        } else if let Some(val) = s.strip_prefix("--config=") {
            return canonicalize_config_path(Path::new(val));
        }
    }
    if let Ok(env_path) = std::env::var("SHARED_BRAIN_CONFIG") {
        if !env_path.trim().is_empty() {
            return canonicalize_config_path(Path::new(env_path.trim()));
        }
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        if !local_app_data.trim().is_empty() {
            return canonicalize_config_path(
                &PathBuf::from(local_app_data).join("Axiom").join("config.json"),
            );
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Could not locate user profile directory for Axiom config.".to_string())?;
    canonicalize_config_path(&PathBuf::from(home).join(".config").join("Axiom").join("config.json"))
}

pub fn parse_axiom_config(config_path: &Path) -> Result<AxiomConfigFile, String> {
    let raw = fs::read_to_string(config_path)
        .map_err(|e| format!("Could not read Axiom config at {}: {e}", config_path.display()))?;
    serde_json::from_str::<AxiomConfigFile>(&raw)
        .map_err(|e| format!("Invalid Axiom config JSON: {e}"))
}

fn find_app_root() -> Option<PathBuf> {
    if let Ok(env_root) = std::env::var("AXIOM_ROOT") {
        let candidate = PathBuf::from(env_root);
        if candidate.join("src").join("server.mjs").is_file() {
            return Some(candidate);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir.join("src").join("server.mjs").is_file() {
                return Some(dir.to_path_buf());
            }
        }
        for ancestor in exe.ancestors() {
            if ancestor.join("src").join("server.mjs").is_file() {
                return Some(ancestor.to_path_buf());
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors() {
            if ancestor.join("src").join("server.mjs").is_file() {
                return Some(ancestor.to_path_buf());
            }
        }
    }
    None
}

fn find_node_binary() -> String {
    if let Ok(node) = std::env::var("AXIOM_NODE") {
        if !node.trim().is_empty() {
            return node;
        }
    }
    #[cfg(windows)]
    {
        let default_win = Path::new(r"C:\Program Files\nodejs\node.exe");
        if default_win.is_file() {
            return default_win.to_string_lossy().into_owned();
        }
    }
    "node".to_string()
}

pub struct BackendManager {
    pub config_path: PathBuf,
    pub config_id: String,
    pub vault_path: PathBuf,
    pub vault_name: String,
    pub backup_dir: PathBuf,
    pub port: u16,
    pub mode: String,
    pub last_error: Option<String>,
    child: Option<Child>,
    client: reqwest::blocking::Client,
}

impl BackendManager {
    pub fn new(config_path: PathBuf) -> Result<Self, String> {
        let config_id = compute_config_id(&config_path);
        let parsed = parse_axiom_config(&config_path)?;
        let vault_path = PathBuf::from(&parsed.vault);
        let vault_name = vault_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Shared Brain")
            .to_string();
        let backup_dir = PathBuf::from(&parsed.backup_dir);
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(1500))
            .no_proxy()
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
        Ok(Self {
            config_path,
            config_id,
            vault_path,
            vault_name,
            backup_dir,
            port: parsed.port,
            mode: "uninitialized".to_string(),
            last_error: None,
            child: None,
            client,
        })
    }

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn probe_health(&self) -> Result<Option<HealthResponse>, String> {
        let url = format!("{}/health", self.base_url());
        match self.client.get(&url).send() {
            Ok(resp) => {
                if !resp.status().is_success() {
                    return Ok(None);
                }
                let data = resp
                    .json::<HealthResponse>()
                    .map_err(|e| format!("Invalid /health payload: {e}"))?;
                Ok(Some(data))
            }
            Err(_) => Ok(None),
        }
    }

    fn restart_attached_via_script(&self) -> Result<(), String> {
        let Some(app_root) = find_app_root() else {
            return Err("Could not find Axiom checkout (scripts/start.ps1).".to_string());
        };
        let start_script = app_root.join("scripts").join("start.ps1");
        if !start_script.is_file() {
            return Err(format!(
                "Missing Axiom start script at {}.",
                start_script.display()
            ));
        }

        let run_shell = |exe: &str| {
            let mut cmd = Command::new(exe);
            cmd.arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-WindowStyle")
                .arg("Hidden")
                .arg("-File")
                .arg(&start_script)
                .arg("-Restart")
                .arg("-ConfigPath")
                .arg(&self.config_path)
                .current_dir(&app_root)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            cmd.output()
        };

        let output = match run_shell("pwsh") {
            Ok(out) => out,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => run_shell("powershell")
                .map_err(|e| format!("Failed to invoke powershell restart script: {e}"))?,
            Err(err) => return Err(format!("Failed to invoke pwsh restart script: {err}")),
        };

        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        Err(if detail.is_empty() {
            format!("start.ps1 -Restart exited with {}", output.status)
        } else {
            format!("start.ps1 -Restart failed: {detail}")
        })
    }

    pub fn ensure_running(&mut self) -> BackendStatus {
        if let Ok(Some(health)) = self.probe_health() {
            if health.ok {
                if let Some(ref found_id) = health.config_id {
                    if found_id != &self.config_id {
                        let msg = format!(
                            "Port {} is already served by another Axiom config ({found_id} != {}).",
                            self.port, self.config_id
                        );
                        self.mode = "error".to_string();
                        self.last_error = Some(msg);
                        return self.status_snapshot(Some(health));
                    }
                }
                let needs_api_upgrade =
                    health.api_version.unwrap_or(0) < REQUIRED_BACKEND_API_VERSION;
                let needs_version_restart = health.app_version.as_deref()
                    != Some(env!("CARGO_PKG_VERSION"));
                if self.child.is_none() && (needs_api_upgrade || needs_version_restart) {
                    let old_ver = health.api_version.unwrap_or(0);
                    if let Err(err) = self.restart_attached_via_script() {
                        if !needs_api_upgrade {
                            self.mode = "attached".to_string();
                            self.last_error = None;
                            return self.status_snapshot(Some(health));
                        }
                        self.mode = "error".to_string();
                        self.last_error = Some(format!(
                            "Attached Axiom backend is outdated (apiVersion {old_ver} < {REQUIRED_BACKEND_API_VERSION}) and auto-restart failed: {err}"
                        ));
                        return self.status_snapshot(Some(health));
                    }
                    let deadline = Instant::now() + Duration::from_secs(5);
                    while Instant::now() < deadline {
                        if let Ok(Some(refreshed)) = self.probe_health() {
                            if refreshed.ok
                                && refreshed.api_version.unwrap_or(0)
                                    >= REQUIRED_BACKEND_API_VERSION
                                && (!needs_version_restart
                                    || refreshed.app_version.as_deref()
                                        == Some(env!("CARGO_PKG_VERSION")))
                            {
                                self.mode = "attached".to_string();
                                self.last_error = None;
                                return self.status_snapshot(Some(refreshed));
                            }
                        }
                        std::thread::sleep(Duration::from_millis(200));
                    }
                    if let Ok(Some(still_old)) = self.probe_health() {
                        if still_old.ok {
                            if still_old.api_version.unwrap_or(0) < REQUIRED_BACKEND_API_VERSION {
                                self.mode = "error".to_string();
                                self.last_error = Some(format!(
                                    "Attached Axiom backend remained outdated after restart (apiVersion {} < {REQUIRED_BACKEND_API_VERSION}).",
                                    still_old.api_version.unwrap_or(0)
                                ));
                                return self.status_snapshot(Some(still_old));
                            }
                            self.mode = "attached".to_string();
                            self.last_error = None;
                            return self.status_snapshot(Some(still_old));
                        }
                    }
                } else {
                    if self.child.is_none() {
                        self.mode = "attached".to_string();
                    } else {
                        self.mode = "spawned".to_string();
                    }
                    self.last_error = None;
                    return self.status_snapshot(Some(health));
                }
            }
        }

        let Some(app_root) = find_app_root() else {
            self.mode = "error".to_string();
            self.last_error = Some("Could not find Axiom checkout (src/server.mjs).".to_string());
            return self.status_snapshot(None);
        };
        let server_script = app_root.join("src").join("server.mjs");
        let node = find_node_binary();
        let mut cmd = Command::new(&node);
        cmd.arg(&server_script)
            .arg(&self.config_path)
            .current_dir(&app_root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        match cmd.spawn() {
            Ok(child) => {
                self.child = Some(child);
                self.mode = "spawned".to_string();
            }
            Err(e) => {
                self.mode = "error".to_string();
                self.last_error = Some(format!("Failed to launch Node backend ({node}): {e}"));
                return self.status_snapshot(None);
            }
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Ok(Some(health)) = self.probe_health() {
                if health.ok {
                    self.last_error = None;
                    return self.status_snapshot(Some(health));
                }
            }
            if let Some(ref mut child) = self.child {
                if let Ok(Some(exit)) = child.try_wait() {
                    self.child = None;
                    // Another instance may have won the race and bound the port.
                    if let Ok(Some(health)) = self.probe_health() {
                        if health.ok && health.config_id.as_deref() == Some(&self.config_id) {
                            self.mode = "attached".to_string();
                            self.last_error = None;
                            return self.status_snapshot(Some(health));
                        }
                    }
                    self.mode = "error".to_string();
                    self.last_error = Some(format!(
                        "Axiom backend exited early ({exit}). Inspect .state/runtime-{}/server.log.",
                        self.config_id
                    ));
                    return self.status_snapshot(None);
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }

        self.mode = "error".to_string();
        self.last_error = Some(format!(
            "Timed out waiting for Axiom backend on 127.0.0.1:{}.",
            self.port
        ));
        self.status_snapshot(None)
    }

    pub fn current_status(&mut self) -> BackendStatus {
        if let Some(ref mut child) = self.child {
            if let Ok(Some(_)) = child.try_wait() {
                self.child = None;
            }
        }
        match self.probe_health() {
            Ok(Some(health)) if health.ok => {
                self.last_error = None;
                if self.child.is_none() && self.mode != "attached" {
                    self.mode = "attached".to_string();
                }
                self.status_snapshot(Some(health))
            }
            _ => self.status_snapshot(None),
        }
    }

    pub fn restart(&mut self) -> BackendStatus {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        } else if let Err(err) = self.restart_attached_via_script() {
            self.mode = "error".to_string();
            self.last_error = Some(err);
            let snapshot_health = self.probe_health().ok().flatten();
            return self.status_snapshot(snapshot_health);
        }
        self.ensure_running()
    }

    pub fn trigger_backup(&self) -> Result<String, String> {
        let base = self.base_url();
        let session_resp = self
            .client
            .get(format!("{base}/api/editor-session"))
            .send()
            .map_err(|e| format!("Failed to fetch editor session: {e}"))?;
        let session: serde_json::Value = session_resp
            .json()
            .map_err(|e| format!("Invalid session response: {e}"))?;
        let token = session
            .get("token")
            .and_then(|t| t.as_str())
            .ok_or_else(|| "Missing CSRF token.".to_string())?;
        let resp = self
            .client
            .post(format!("{base}/api/recovery/backup"))
            .header("Origin", &base)
            .header("Content-Type", "application/json")
            .header("X-Shared-Brain-CSRF", token)
            .body("{}")
            .send()
            .map_err(|e| format!("Backup request failed: {e}"))?;
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Backup failed ({status}): {body}"));
        }
        Ok(body)
    }

    pub fn shutdown_if_spawned(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn status_snapshot(&self, health: Option<HealthResponse>) -> BackendStatus {
        BackendStatus {
            mode: self.mode.clone(),
            healthy: health.as_ref().is_some_and(|h| h.ok),
            port: self.port,
            base_url: self.base_url(),
            config_path: self.config_path.to_string_lossy().into_owned(),
            config_id: self.config_id.clone(),
            vault_path: self.vault_path.to_string_lossy().into_owned(),
            vault_name: self.vault_name.clone(),
            backup_dir: self.backup_dir.to_string_lossy().into_owned(),
            pid: health.as_ref().and_then(|h| h.pid),
            uptime_seconds: health.as_ref().and_then(|h| h.uptime_seconds),
            error: self.last_error.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_id_matches_node_sha256_contract() {
        // Matches Node: createHash('sha256').update('c:\\private\\axiom\\config.json').digest('hex').slice(0,16).toUpperCase()
        let p = Path::new(r"\\?\C:\Private\Axiom\config.json");
        let stripped = strip_verbatim_prefix(p);
        assert_eq!(stripped.to_string_lossy(), r"C:\Private\Axiom\config.json");

        let id = compute_config_id(&stripped);
        let mut h = Sha256::new();
        h.update(b"c:\\private\\axiom\\config.json");
        let expected = hex::encode(h.finalize())[..16].to_ascii_uppercase();
        assert_eq!(id, expected);
    }

    #[test]
    fn parses_axiom_config_file() {
        let dir = std::env::temp_dir().join(format!("axiom-backend-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.json");
        fs::write(
            &cfg,
            r#"{"vault":"C:/tmp/vault","backupDir":"C:/tmp/backup","port":4399,"projects":[]}"#,
        )
        .unwrap();
        let parsed = parse_axiom_config(&cfg).unwrap();
        assert_eq!(parsed.port, 4399);
        assert_eq!(parsed.vault, "C:/tmp/vault");
        assert_eq!(parsed.backup_dir, "C:/tmp/backup");
        let _ = fs::remove_dir_all(&dir);
    }
}
