import React, { useState } from 'react';
import { DatabaseBackup, FolderOpen, ShieldCheck } from 'lucide-react';
import { DiagnosticRefresh, useDiagnostic } from './DiagnosticRefresh.jsx';
import { apiMutate, isDesktop, revealInExplorer } from './desktop-bridge.mjs';

export default function RecoveryPage() {
  const { data, error: loadError, loading, checked, failedAt, refresh } = useDiagnostic('/api/recovery');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function act(kind, snapshot) {
    setBusy(snapshot || kind);
    setError('');
    try {
      const result = await apiMutate('/api/recovery/' + kind, {
        method: 'POST',
        body: snapshot ? { snapshot } : {},
      });
      await refresh();
      if (result.success === false) setError(result.error || 'Restore check failed.');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Safety / recovery</p>
          <h1>Backups &amp; recovery</h1>
          <p className="page-description">Local snapshots and deliberate restore checks.</p>
        </div>
        <div className="heading-actions">
          {isDesktop() && (
            <button type="button" className="button" onClick={() => revealInExplorer('backup')}>
              <FolderOpen size={17} aria-hidden="true" /> Open backups folder
            </button>
          )}
          <button className="button button-primary" disabled={!!busy} onClick={() => act('backup')}>
            <DatabaseBackup size={17} />
            {busy === 'backup' ? 'Creating snapshot…' : 'Create snapshot'}
          </button>
        </div>
      </div>
      <p className="recovery-boundary">Local copies are not off-machine protection. Physical independence has not been verified; machine loss can affect both the vault and its backups.</p>
      <DiagnosticRefresh loading={loading} checked={checked} failedAt={failedAt} refresh={refresh} />
      {loadError && <p className="management-error" role="alert">{loadError}</p>}
      {error && <p className="management-error" role="alert">{error}</p>}
      {!data ? (!loadError && <p role="status">Loading backup history…</p>) : (
        <>
          <section className="panel recovery-summary">
            <h2>Backup location</h2>
            <code>{data.backupDir}</code>
            <p>Restore checks copy a snapshot into a separate temporary directory beside the backup folder, verify every restored checksum and captured workspace setting, load required owner policies, then remove that temporary copy. The live vault and its configuration are never replaced.</p>
          </section>
          <section className="panel recovery-history">
            <div className="panel-heading"><h2>Snapshots</h2><span className="muted">Latest {data.snapshots.length}</span></div>
            <div className="recovery-table">
              <table>
                <thead><tr><th>Snapshot</th><th>Files</th><th>Last check</th><th>Action</th></tr></thead>
                <tbody>
                  {data.snapshots.map(snapshot => {
                    const check = data.checks.find(item => item.snapshot === snapshot.id);
                    return (
                      <tr key={snapshot.id}>
                        <td>
                          <strong>{snapshot.created ? new Date(snapshot.created).toLocaleString() : 'Incomplete snapshot'}</strong>
                          <small>{snapshot.id}</small>
                          {snapshot.error && <small className="management-error">{snapshot.error}</small>}
                        </td>
                        <td>{snapshot.files ?? '-'}</td>
                        <td>
                          {check ? (
                            <>
                              <span>{check.success ? 'Verified' : 'Failed'}</span>
                              <small>{new Date(check.checkedAt).toLocaleString()}</small>
                              {check.success && <small>{check.workspaceSettingsVerified ? 'Files, policies & workspace settings' : 'Files & policies; legacy snapshot has no settings'}</small>}
                              {check.error && <small className="management-error">{check.error}</small>}
                            </>
                          ) : 'Not checked'}
                        </td>
                        <td>
                          <button className="button" disabled={!!busy || !snapshot.complete} onClick={() => act('check', snapshot.id)}>
                            <ShieldCheck size={16} />
                            {busy === snapshot.id ? 'Checking restore…' : 'Run restore check'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!data.snapshots.length && <p className="empty">No snapshots yet. Create one before running a restore check.</p>}
          </section>
        </>
      )}
    </>
  );
}
