import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  checkDesktopUpdates,
  getDesktopInfo,
  installDesktopUpdate,
  openInBrowser,
  quitDesktop,
  restartBackend,
  revealInExplorer,
  saveDesktopPrefs,
} from './desktop-bridge.mjs';

export default function DesktopSettings({
  open,
  groups,
  pendingUpdate,
  onUpdateInfo,
  onInstallUpdate,
  onClose,
  onZoomChange,
  onRequestQuit,
}) {
  const dialogRef = useRef(null);
  const previousFocusRef = useRef(null);
  const [info, setInfo] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(pendingUpdate || null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (pendingUpdate) setUpdateInfo(pendingUpdate);
  }, [pendingUpdate]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      previousFocusRef.current = document.activeElement;
      setStatus(null);
      if (!dialog.open) dialog.showModal();
      getDesktopInfo().then(data => {
        if (!data) return;
        setInfo(data);
        setPrefs(data.prefs);
      }).catch(e => {
        setStatus({ text: e?.message || 'Could not load desktop configuration.', error: true });
      });
    } else if (dialog.open) {
      dialog.close();
      previousFocusRef.current?.focus?.();
    }
  }, [open]);

  const updatePrefs = async patch => {
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      const saved = await saveDesktopPrefs(next);
      setPrefs(saved);
      if (patch.zoomPercent !== undefined) onZoomChange?.(saved.zoomPercent);
    } catch (e) {
      setStatus({ text: e.message || 'Could not save desktop preferences.', error: true });
    }
  };

  const toggleMute = id => {
    if (!prefs) return;
    const has = prefs.mutedWorkspaces.includes(id);
    const mutedWorkspaces = has
      ? prefs.mutedWorkspaces.filter(item => item !== id)
      : [...prefs.mutedWorkspaces, id];
    updatePrefs({ mutedWorkspaces });
  };

  const doRestart = async (takeover = false) => {
    setBusy(true);
    setStatus(null);
    try {
      const backend = await restartBackend(takeover);
      setInfo(prev => (prev ? { ...prev, backend } : prev));
      setStatus({
        text: backend.healthy
          ? (takeover ? 'Background service switched to this Axiom installation.' : 'Backend restarted.')
          : (backend.error || 'Backend unavailable.'),
        error: !backend.healthy,
      });
    } catch (e) {
      setStatus({ text: e.message || 'Restart failed.', error: true });
    } finally {
      setBusy(false);
    }
  };

  const doCheckUpdates = async () => {
    setCheckingUpdate(true);
    setStatus(null);
    try {
      const res = await checkDesktopUpdates();
      if (res) {
        setUpdateInfo(res);
        onUpdateInfo?.(res);
        setStatus({ text: res.message, error: false });
      }
    } catch (e) {
      setStatus({ text: e.message || 'Could not check for updates.', error: true });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const doInstallUpdate = async () => {
    setInstallingUpdate(true);
    setStatus(null);
    try {
      if (onInstallUpdate) {
        await onInstallUpdate();
      } else {
        await installDesktopUpdate();
      }
    } catch (e) {
      setStatus({ text: e.message || 'Could not install update.', error: true });
      setInstallingUpdate(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="desktop-settings-dialog"
      aria-labelledby="desktop-settings-title"
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClick={event => {
        if (event.target !== dialogRef.current) return;
        const r = dialogRef.current.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) {
          onClose();
        }
      }}
    >
      <div className="desktop-settings-inner">
        <div className="desktop-settings-header">
          <h2 id="desktop-settings-title">Axiom Desktop Settings</h2>
          <button type="button" className="icon-button" aria-label="Close desktop settings" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="desktop-settings-body">
          {!prefs ? (
            <p className="muted">Loading desktop configuration...</p>
          ) : (
            <>
              <div className="desktop-settings-section">
                <label className="desktop-settings-toggle">
                  <span>Minimize to system tray on window close</span>
                  <input
                    type="checkbox"
                    checked={prefs.closeToTray}
                    onChange={e => updatePrefs({ closeToTray: e.target.checked })}
                  />
                </label>
                <label className="desktop-settings-toggle">
                  <span>Windows toast notifications for new or changed agent notes</span>
                  <input
                    type="checkbox"
                    checked={prefs.toastNotifications}
                    onChange={e => updatePrefs({ toastNotifications: e.target.checked })}
                  />
                </label>
                <label className="desktop-settings-toggle">
                  <span>Start hidden in tray</span>
                  <input
                    type="checkbox"
                    checked={prefs.startMinimized}
                    onChange={e => updatePrefs({ startMinimized: e.target.checked })}
                  />
                </label>
                <div className="desktop-settings-toggle">
                  <span>UI zoom ({prefs.zoomPercent}%)</span>
                  <div className="desktop-settings-row">
                    <button type="button" className="button" aria-label="Decrease UI zoom" onClick={() => updatePrefs({ zoomPercent: Math.max(80, prefs.zoomPercent - 10) })}>-</button>
                    <button type="button" className="button" onClick={() => updatePrefs({ zoomPercent: 100 })}>Reset</button>
                    <button type="button" className="button" aria-label="Increase UI zoom" onClick={() => updatePrefs({ zoomPercent: Math.min(150, prefs.zoomPercent + 10) })}>+</button>
                  </div>
                </div>
              </div>

              {groups?.length > 0 && (
                <div className="desktop-settings-section">
                  <span className="muted">Mute Windows toast notifications for workspaces:</span>
                  <div className="desktop-settings-muted">
                    {groups.map(group => (
                      <label key={group.id}>
                        <input
                          type="checkbox"
                          checked={prefs.mutedWorkspaces.includes(group.id)}
                          onChange={() => toggleMute(group.id)}
                        />
                        <span>{group.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {info && (
                <div className="desktop-settings-section">
                  <span className="muted">
                    Backend: <strong>{info.backend.mode}</strong> on {info.backend.baseUrl}
                    {info.backend.pid ? ` (PID ${info.backend.pid})` : ''}
                    {info.backend.appVersion ? ` · v${info.backend.appVersion}` : ''}
                  </span>
                  {info.backend.versionMismatch && (
                    <span className="management-error" role="status">
                      Running backend is v{info.backend.appVersion || 'unknown'} while desktop shell is v{info.version}.
                    </span>
                  )}
                  <span className="muted">Global hotkey: <code>{info.hotkey}</code></span>
                  <div className="desktop-settings-row">
                    <button type="button" className="button" disabled={busy} onClick={() => doRestart(false)}>
                      {busy ? 'Restarting...' : 'Restart backend'}
                    </button>
                    {info.backend.versionMismatch && (
                      <button type="button" className="button button-primary" disabled={busy} onClick={() => doRestart(true)}>
                        {busy ? 'Switching...' : 'Switch service to this version'}
                      </button>
                    )}
                    <button type="button" className="button" onClick={() => revealInExplorer('vault')}>
                      Open vault folder
                    </button>
                    <button type="button" className="button" onClick={() => openInBrowser('/')}>
                      Open in browser
                    </button>
                  </div>
                </div>
              )}

              <div className="desktop-settings-section">
                <span className="muted">
                  Updates (Velopack): <strong>{updateInfo?.currentVersion || info?.version ? `v${updateInfo?.currentVersion || info?.version}` : 'Unknown'}</strong>
                  {updateInfo?.targetVersion ? ` -> v${updateInfo.targetVersion} available` : ''}
                </span>
                {updateInfo?.message && <span className="muted">{updateInfo.message}</span>}
                <div className="desktop-settings-row">
                  <button type="button" className="button" disabled={checkingUpdate || installingUpdate} onClick={doCheckUpdates}>
                    {checkingUpdate ? 'Checking...' : 'Check for updates'}
                  </button>
                  {updateInfo?.available && (
                    <button type="button" className="button button-primary" disabled={installingUpdate} onClick={doInstallUpdate}>
                      {installingUpdate ? 'Downloading & restarting...' : `Download & restart (v${updateInfo.targetVersion})`}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {status && (
            <p className={status.error ? 'management-error' : 'muted'} role={status.error ? 'alert' : 'status'}>
              {status.text}
            </p>
          )}
        </div>
        <div className="desktop-settings-footer">
          <button
            type="button"
            className="button danger-button"
            onClick={() => (onRequestQuit ? onRequestQuit() : quitDesktop())}
          >
            Quit Axiom
          </button>
          <button type="button" className="button button-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
