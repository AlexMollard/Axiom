import React, { useEffect, useState } from 'react';
import { isDesktop } from './desktop-bridge.mjs';
import { getEditorStats, subscribeEditorStats } from './editor-stats-store.mjs';

export default function StatusBar({
  sseStatus,
  backendInfo,
  updateInfo,
  stats,
  isEditing = false,
  pendingCount,
  zoomPercent,
  onOpenSettings,
  onOpenReview,
  onResetZoom,
}) {
  const [copiedRev, setCopiedRev] = useState(false);
  const [liveEditorStats, setLiveEditorStats] = useState(getEditorStats);

  useEffect(() => {
    if (!isEditing) {
      setLiveEditorStats(null);
      return undefined;
    }
    setLiveEditorStats(getEditorStats());
    return subscribeEditorStats(setLiveEditorStats);
  }, [isEditing]);

  if (!isDesktop()) return null;

  const activeStats = isEditing ? (liveEditorStats || stats) : stats;
  const backendHealthy = backendInfo ? backendInfo.healthy : sseStatus === 'connected';
  const dotTone = sseStatus === 'connected' && backendHealthy ? 'live' : backendInfo?.healthy === false ? 'error' : 'warn';
  const statusText = backendInfo?.healthy === false
    ? 'Backend disconnected'
    : sseStatus === 'connected'
      ? 'Vault live'
      : 'Reconnecting';

  const copyRev = async () => {
    if (!activeStats?.revision) return;
    try {
      await navigator.clipboard.writeText(activeStats.revision);
      setCopiedRev(true);
      setTimeout(() => setCopiedRev(false), 1400);
    } catch {}
  };

  return (
    <footer className="desktop-statusbar" aria-label="Workspace status">
      <div className="desktop-statusbar-group">
        <button
          type="button"
          className="statusbar-item"
          onClick={onOpenSettings}
          title="Open desktop settings"
        >
          <span className={`statusbar-dot statusbar-dot-${dotTone}`} />
          <span>{statusText}</span>
        </button>
        {backendInfo && (
          <button
            type="button"
            className="statusbar-item statusbar-muted"
            onClick={onOpenSettings}
            title="Backend connection details"
          >
            <span>{backendInfo.mode === 'attached' ? 'Attached' : 'Managed'}</span>
            <span className="statusbar-hide-narrow">· 127.0.0.1:{backendInfo.port}</span>
          </button>
        )}
      </div>

      <div className="desktop-statusbar-group">
        {activeStats?.words !== undefined && (
          <span className="statusbar-item statusbar-muted">
            <span>{activeStats.words.toLocaleString()} words</span>
            <span className="statusbar-hide-narrow">· ~{Math.max(1, Math.ceil(activeStats.words / 220))} min read</span>
          </span>
        )}
        {activeStats?.line !== undefined && (
          <span className="statusbar-item statusbar-muted">
            Ln {activeStats.line}, Col {activeStats.col}
          </span>
        )}
        {activeStats?.revision && (
          <button
            type="button"
            className="statusbar-item statusbar-mono"
            onClick={copyRev}
            title={`Copy full revision (${activeStats.revision})`}
          >
            {copiedRev ? 'Copied rev' : activeStats.revision.slice(0, 8)}
          </button>
        )}
        {updateInfo?.available && updateInfo?.targetVersion && (
          <button
            type="button"
            className="statusbar-item statusbar-accent"
            onClick={onOpenSettings}
            title={updateInfo.message || `Update v${updateInfo.targetVersion} ready`}
          >
            Update v{updateInfo.targetVersion}
          </button>
        )}
        <button
          type="button"
          className={`statusbar-item${pendingCount > 0 ? ' statusbar-accent' : ' statusbar-muted'}`}
          onClick={onOpenReview}
          title="Open review queue"
        >
          Review: {pendingCount}
        </button>
        {zoomPercent !== 100 && (
          <button
            type="button"
            className="statusbar-item"
            onClick={onResetZoom}
            title="Click to reset zoom to 100%"
          >
            {zoomPercent}%
          </button>
        )}
      </div>
    </footer>
  );
}
