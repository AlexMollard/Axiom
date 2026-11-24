import React, { useState } from 'react';
import { isDesktop } from './desktop-bridge.mjs';

export default function StatusBar({
  sseStatus,
  backendInfo,
  updateInfo,
  stats,
  pendingCount,
  zoomPercent,
  onOpenSettings,
  onOpenReview,
  onResetZoom,
}) {
  const [copiedRev, setCopiedRev] = useState(false);

  if (!isDesktop()) return null;

  const copyRev = async () => {
    if (!stats?.revision) return;
    try {
      await navigator.clipboard.writeText(stats.revision);
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
          <span className={`statusbar-dot statusbar-dot-${sseStatus === 'connected' ? 'live' : 'warn'}`} />
          <span>{sseStatus === 'connected' ? 'Vault live' : 'Reconnecting'}</span>
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
        {stats?.words !== undefined && (
          <span className="statusbar-item statusbar-muted">
            <span>{stats.words.toLocaleString()} words</span>
            <span className="statusbar-hide-narrow">· ~{Math.max(1, Math.ceil(stats.words / 220))} min read</span>
          </span>
        )}
        {stats?.line !== undefined && (
          <span className="statusbar-item statusbar-muted">
            Ln {stats.line}, Col {stats.col}
          </span>
        )}
        {stats?.revision && (
          <button
            type="button"
            className="statusbar-item statusbar-mono"
            onClick={copyRev}
            title={`Copy full revision (${stats.revision})`}
          >
            {copiedRev ? 'Copied rev' : stats.revision.slice(0, 8)}
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
