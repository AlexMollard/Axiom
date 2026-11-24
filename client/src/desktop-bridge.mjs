export function isDesktop() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

let tauriCore = null;
let tauriEvent = null;
let tauriWindow = null;

async function core() {
  if (!isDesktop()) return null;
  tauriCore ||= await import('@tauri-apps/api/core');
  return tauriCore;
}

async function eventsApi() {
  if (!isDesktop()) return null;
  tauriEvent ||= await import('@tauri-apps/api/event');
  return tauriEvent;
}

async function windowApi() {
  if (!isDesktop()) return null;
  tauriWindow ||= await import('@tauri-apps/api/window');
  return tauriWindow;
}

export async function invokeDesktop(cmd, args = {}) {
  const api = await core();
  if (!api) return null;
  return api.invoke(cmd, args);
}

export async function listenDesktop(eventName, handler) {
  const api = await eventsApi();
  if (!api) return () => {};
  return api.listen(eventName, handler);
}

export async function getCurrentDesktopWindow() {
  const api = await windowApi();
  if (!api) return null;
  return api.getCurrentWindow();
}

export async function getDesktopInfo() {
  return invokeDesktop('desktop_info');
}

export async function getBackendStatus() {
  return invokeDesktop('desktop_backend_status');
}

export async function restartBackend() {
  return invokeDesktop('desktop_restart_backend');
}

export async function triggerDesktopBackup() {
  return invokeDesktop('desktop_trigger_backup');
}

export async function getDesktopPrefs() {
  return invokeDesktop('desktop_get_prefs');
}

export async function saveDesktopPrefs(prefs) {
  return invokeDesktop('desktop_save_prefs', { prefs });
}

export async function readBucketState(bucket, key, localFallback) {
  if (isDesktop()) {
    try {
      const value = await invokeDesktop('desktop_read_state', { bucket, key });
      if (value !== null && value !== undefined) return value;
    } catch {
      // Fall through to local fallback if desktop storage is temporarily unavailable.
    }
  }
  return localFallback ? localFallback() : null;
}

export async function writeBucketState(bucket, key, value, localFallback) {
  if (isDesktop()) {
    await invokeDesktop('desktop_write_state', { bucket, key, value });
  }
  if (localFallback) {
    try { localFallback(value); } catch { /* Browser storage fallback is optional in desktop mode. */ }
  }
}

export async function deleteBucketState(bucket, key, localFallback) {
  if (isDesktop()) {
    await invokeDesktop('desktop_delete_state', { bucket, key });
  }
  if (localFallback) {
    try { localFallback(); } catch { /* Browser storage fallback is optional in desktop mode. */ }
  }
}

export async function saveFileNative(defaultName, content) {
  return invokeDesktop('desktop_save_file', { defaultName, content });
}

export async function openInObsidian(notePath, vaultName) {
  if (isDesktop()) {
    return invokeDesktop('desktop_open_in_obsidian', { notePath });
  }
  const url = `obsidian://open?vault=${encodeURIComponent(vaultName || '')}&file=${encodeURIComponent(notePath)}`;
  window.location.assign(url);
  return null;
}

export async function openInVscode(notePath) {
  return invokeDesktop('desktop_open_in_vscode', { notePath });
}

export async function revealInExplorer(targetKind, targetPath = null) {
  return invokeDesktop('desktop_reveal_in_explorer', { targetKind, targetPath });
}

export async function openInBrowser(routeUrl = '/') {
  return invokeDesktop('desktop_open_in_browser', { routeUrl });
}

export async function notifyNative(title, body) {
  return invokeDesktop('desktop_notify', { title, body });
}

export async function setTrayState(pendingCount, unreadCount) {
  return invokeDesktop('desktop_set_tray_state', { pendingCount, unreadCount });
}

export async function openDetachedWindow(routeUrl, title) {
  return invokeDesktop('desktop_open_note_window', { routeUrl, title });
}

export async function focusMainRoute(routeUrl) {
  return invokeDesktop('desktop_focus_main_route', { routeUrl });
}

export async function hideQuickOverlay() {
  return invokeDesktop('desktop_hide_quick_overlay');
}

export async function toggleQuickOverlay() {
  return invokeDesktop('desktop_toggle_quick_overlay');
}

export async function setDirtyTabCount(count) {
  return invokeDesktop('desktop_set_dirty_tabs', { count });
}

export async function quitDesktop() {
  return invokeDesktop('desktop_quit');
}

let cachedCsrfToken = '';

export async function fetchCsrfToken(forceRefresh = false) {
  if (cachedCsrfToken && !forceRefresh) return cachedCsrfToken;
  const response = await fetch('/api/editor-session', { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    cachedCsrfToken = '';
    throw new Error(data.error || 'Could not start a secure editor session.');
  }
  cachedCsrfToken = data.token;
  return cachedCsrfToken;
}

export async function apiMutate(url, { method = 'POST', body, signal } = {}) {
  let token = await fetchCsrfToken(false);
  const execute = async csrfToken => {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Shared-Brain-CSRF': csrfToken,
      },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };
  let result = await execute(token);
  if (result.response.status === 403) {
    token = await fetchCsrfToken(true);
    result = await execute(token);
  }
  if (!result.response.ok) {
    const error = new Error(result.data.error || `Request failed (${result.response.status}).`);
    error.status = result.response.status;
    throw error;
  }
  return result.data;
}
