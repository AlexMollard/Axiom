use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use velopack::{sources, Error as VelopackError, UpdateCheck, UpdateInfo, UpdateManager};

pub const DEFAULT_UPDATE_REPO: &str = "https://github.com/AlexMollard/Axiom";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub installed: bool,
    pub current_version: String,
    pub available: bool,
    pub target_version: Option<String>,
    pub notes_markdown: Option<String>,
    pub feed_source: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateFeed {
    LocalDir(PathBuf),
    Http(String),
    Github { repo: String, token: Option<String> },
}

impl UpdateFeed {
    pub fn label(&self) -> String {
        match self {
            UpdateFeed::LocalDir(p) => p.to_string_lossy().into_owned(),
            UpdateFeed::Http(url) => url.clone(),
            UpdateFeed::Github { repo, .. } => repo.clone(),
        }
    }
}

pub fn resolve_github_token() -> Option<String> {
    for key in ["AXIOM_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(val) = std::env::var(key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    let mut cmd = Command::new("gh");
    cmd.args(["auth", "token"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    None
}

pub fn resolve_update_feed_from_value(raw: Option<&str>, token: Option<String>) -> UpdateFeed {
    if let Some(val) = raw.map(str::trim).filter(|s| !s.is_empty()) {
        if val.starts_with("http://") || val.starts_with("https://") {
            if val.to_ascii_lowercase().starts_with("https://github.com/") {
                return UpdateFeed::Github {
                    repo: val.trim_end_matches('/').to_string(),
                    token,
                };
            }
            return UpdateFeed::Http(val.to_string());
        }
        return UpdateFeed::LocalDir(PathBuf::from(val));
    }
    UpdateFeed::Github {
        repo: DEFAULT_UPDATE_REPO.to_string(),
        token,
    }
}

pub fn resolve_update_feed() -> UpdateFeed {
    let raw = std::env::var("AXIOM_UPDATE_URL").ok();
    let token = resolve_github_token();
    resolve_update_feed_from_value(raw.as_deref(), token)
}

fn create_manager_for_feed(feed: &UpdateFeed) -> Result<UpdateManager, VelopackError> {
    match feed {
        UpdateFeed::LocalDir(path) => UpdateManager::new(sources::FileSource::new(path), None, None),
        UpdateFeed::Http(url) => UpdateManager::new(sources::HttpSource::new(url), None, None),
        UpdateFeed::Github { repo, token } => {
            UpdateManager::new(sources::GithubSource::new(repo, token.clone(), false), None, None)
        }
    }
}

pub fn check_updates() -> (Result<UpdateCheckResult, String>, Option<UpdateInfo>) {
    let feed = resolve_update_feed();
    let feed_source = feed.label();
    let fallback_version = env!("CARGO_PKG_VERSION").to_string();

    let manager = match create_manager_for_feed(&feed) {
        Ok(m) => m,
        Err(_) => {
            return (
                Ok(UpdateCheckResult {
                    installed: false,
                    current_version: fallback_version,
                    available: false,
                    target_version: None,
                    notes_markdown: None,
                    feed_source,
                    message: "Running unpackaged build. Install via the Axiom installer to enable Velopack updates."
                        .to_string(),
                }),
                None,
            );
        }
    };

    let current_version = manager.get_current_version_as_string();
    match manager.check_for_updates() {
        Ok(UpdateCheck::UpdateAvailable(info)) => {
            let target_version = info.TargetFullRelease.Version.clone();
            let notes_markdown = if info.TargetFullRelease.NotesMarkdown.trim().is_empty() {
                None
            } else {
                Some(info.TargetFullRelease.NotesMarkdown.clone())
            };
            let result = UpdateCheckResult {
                installed: true,
                current_version,
                available: true,
                target_version: Some(target_version.clone()),
                notes_markdown,
                feed_source,
                message: format!("Update v{target_version} is available."),
            };
            (Ok(result), Some(*info))
        }
        Ok(UpdateCheck::NoUpdateAvailable) | Ok(UpdateCheck::RemoteIsEmpty) => (
            Ok(UpdateCheckResult {
                installed: true,
                current_version: current_version.clone(),
                available: false,
                target_version: None,
                notes_markdown: None,
                feed_source,
                message: format!("Axiom v{current_version} is up to date."),
            }),
            None,
        ),
        Err(err) => (
            Err(format!("Could not check for updates: {err}")),
            None,
        ),
    }
}

pub fn download_and_prepare_update(update_info: &UpdateInfo) -> Result<(), String> {
    let feed = resolve_update_feed();
    let manager = create_manager_for_feed(&feed)
        .map_err(|e| format!("Velopack update manager unavailable: {e}"))?;
    manager
        .download_updates(update_info, None)
        .map_err(|e| format!("Failed to download update: {e}"))?;
    manager
        .wait_exit_then_apply_updates(update_info, false, true, Vec::<String>::new())
        .map_err(|e| format!("Failed to stage update installer: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_default_github_and_custom_feeds() {
        assert_eq!(
            resolve_update_feed_from_value(None, Some("tok".to_string())),
            UpdateFeed::Github {
                repo: DEFAULT_UPDATE_REPO.to_string(),
                token: Some("tok".to_string()),
            }
        );
        assert_eq!(
            resolve_update_feed_from_value(Some("https://github.com/AlexMollard/Axiom/"), None),
            UpdateFeed::Github {
                repo: "https://github.com/AlexMollard/Axiom".to_string(),
                token: None,
            }
        );
        assert_eq!(
            resolve_update_feed_from_value(Some("https://updates.example.com/axiom"), None),
            UpdateFeed::Http("https://updates.example.com/axiom".to_string())
        );
        assert_eq!(
            resolve_update_feed_from_value(Some(r"C:\Temp\AxiomReleases"), None),
            UpdateFeed::LocalDir(PathBuf::from(r"C:\Temp\AxiomReleases"))
        );
    }

    #[test]
    fn unpackaged_check_reports_not_installed_cleanly() {
        let (res, info) = check_updates();
        assert!(info.is_none());
        let ok = res.expect("unpackaged check should not error");
        assert!(!ok.installed);
        assert!(!ok.available);
    }
}
