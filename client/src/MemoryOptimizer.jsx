import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, RotateCcw, Settings, Sparkles, Square, Trash2, Wrench } from 'lucide-react';
import { apiMutate } from './desktop-bridge.mjs';

const noteUrl = path => '/?note=' + encodeURIComponent(path);

async function responseData(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

const DEFAULT_FORM = {
  provider: 'auto',
  model: '',
  apiKey: '',
  apiBaseUrl: '',
  deepRepoCheck: false,
  maxNotesPerBatch: 18,
  timeoutMs: 240000,
};

export default function MemoryOptimizer({ groups, onCatalogChanged, onOpenSplit }) {
  const [settings, setSettings] = useState(null);
  const [configRevision, setConfigRevision] = useState('');
  const [providers, setProviders] = useState([]);
  const [activeJob, setActiveJob] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [form, setForm] = useState(DEFAULT_FORM);
  const [showSettings, setShowSettings] = useState(false);
  const [workspace, setWorkspace] = useState('');
  const [deepRepoCheck, setDeepRepoCheck] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [error, setError] = useState('');
  const [settingsMessage, setSettingsMessage] = useState('');
  const [restoredIds, setRestoredIds] = useState(() => new Set());
  const [restoringId, setRestoringId] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const prevJobStatusRef = useRef('');

  async function loadInitial() {
    setLoading(true);
    setError('');
    try {
      const data = await responseData(await fetch('/api/optimizer/settings'));
      setSettings(data.settings);
      setConfigRevision(data.configRevision || '');
      setProviders(data.providers || []);
      setActiveJob(data.activeJob || null);
      setRuns(data.runs || []);
      setForm({
        provider: data.settings?.provider || 'auto',
        model: data.settings?.model || '',
        apiKey: '',
        apiBaseUrl: data.settings?.apiBaseUrl || '',
        deepRepoCheck: Boolean(data.settings?.deepRepoCheck),
        maxNotesPerBatch: data.settings?.maxNotesPerBatch || 18,
        timeoutMs: data.settings?.timeoutMs || 240000,
      });
      setDeepRepoCheck(Boolean(data.settings?.deepRepoCheck));
      const anyReady = (data.providers || []).some(p => p.available);
      if (!anyReady) setShowSettings(true);
      if (!selectedRunId && data.runs?.length) setSelectedRunId(data.runs[0].id);
    } catch (e) {
      setError(e.message || 'Could not load Memory Optimizer settings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadInitial();
  }, []);

  useEffect(() => {
    if (activeJob?.status !== 'running') return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await responseData(await fetch('/api/optimizer/status'));
        if (cancelled) return;
        setActiveJob(data.activeJob || null);
        if (Array.isArray(data.runs)) {
          setRuns(data.runs);
          if (data.runs[0] && prevJobStatusRef.current === 'running' && data.activeJob?.status !== 'running') {
            setSelectedRunId(data.runs[0].id);
            const c = data.runs[0].counts || {};
            if (!data.runs[0].dryRun && (c.updated > 0 || c.merged > 0 || c.moved > 0 || c.trashed > 0)) {
              onCatalogChanged?.();
            }
          }
        }
        prevJobStatusRef.current = data.activeJob?.status || '';
      } catch {}
    };
    prevJobStatusRef.current = 'running';
    const timer = setInterval(poll, 1200);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeJob?.status]);

  async function saveSettings(clearApiKey = false) {
    setSavingSettings(true);
    setSettingsMessage('');
    setError('');
    try {
      const payload = {
        provider: form.provider,
        model: form.model.trim(),
        apiBaseUrl: form.apiBaseUrl.trim(),
        deepRepoCheck: Boolean(form.deepRepoCheck),
        maxNotesPerBatch: Number(form.maxNotesPerBatch) || 18,
        timeoutMs: Number(form.timeoutMs) || 240000,
        expectedRevision: configRevision,
      };
      if (clearApiKey) payload.clearApiKey = true;
      else if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
      const updated = await apiMutate('/api/optimizer/settings', { method: 'PUT', body: payload });
      setSettings(updated.settings);
      setConfigRevision(updated.configRevision || '');
      setProviders(updated.providers || []);
      setForm(prev => ({ ...prev, apiKey: '' }));
      setDeepRepoCheck(Boolean(updated.settings?.deepRepoCheck));
      setSettingsMessage(clearApiKey ? 'Cleared stored API key and saved settings.' : 'Optimizer settings saved.');
    } catch (e) {
      setError(e.message || 'Could not save optimizer settings.');
    } finally {
      setSavingSettings(false);
    }
  }

  async function startRun() {
    setError('');
    setRestoreError('');
    try {
      const data = await apiMutate('/api/optimizer/run', {
        method: 'POST',
        body: {
          workspace: workspace || null,
          provider: form.provider,
          model: form.model.trim(),
          deepRepoCheck,
          dryRun,
        },
      });
      prevJobStatusRef.current = 'running';
      setActiveJob(data.job);
    } catch (e) {
      setError(e.message || 'Could not start optimization run.');
    }
  }

  async function cancelRun() {
    try {
      const data = await apiMutate('/api/optimizer/cancel', { method: 'POST', body: {} });
      setActiveJob(data.activeJob || null);
    } catch (e) {
      setError(e.message || 'Could not cancel optimization run.');
    }
  }

  async function restoreTrashItem(trashId) {
    if (!trashId) return;
    setRestoringId(trashId);
    setRestoreError('');
    try {
      await apiMutate('/api/trash/restore', { method: 'POST', body: { id: trashId } });
      setRestoredIds(prev => new Set([...prev, trashId]));
      onCatalogChanged?.();
    } catch (e) {
      setRestoreError(e.message || 'Could not restore note from Trash.');
    } finally {
      setRestoringId('');
    }
  }

  const running = activeJob?.status === 'running';
  const activeRun = runs.find(r => r.id === selectedRunId) || runs[0] || null;
  const readyProviders = providers.filter(p => p.available);

  return (
    <div className="optimizer-panel">
      <div className="cleanup-intro">
        <p>
          Run a high-intelligence model across your <code>Agents/</code> memories to tighten verbose notes, relocate misplaced notes to the right workspace, merge duplicates, and move bad or provably stale notes into Axiom&apos;s recoverable Trash.
        </p>
        <p>
          Before making any edits, Axiom takes a full Vault recovery snapshot. <code>Owner/</code> notes, <code>Home.md</code>, and <code>Agents/Workspace icons.md</code> stay strictly read-only and are never modified or trashed.
        </p>
      </div>

      <div className="cleanup-controls optimizer-controls">
        <label>
          Workspace
          <select value={workspace} onChange={e => setWorkspace(e.target.value)} disabled={running || loading}>
            <option value="">All workspaces</option>
            {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            {!groups.some(group => group.id === '__unmapped') && <option value="__unmapped">Unmapped notes</option>}
          </select>
        </label>

        <label className="cleanup-semantic-toggle" title="Include bounded file excerpts and recent git log for mapped project repos">
          <input type="checkbox" checked={deepRepoCheck} onChange={e => setDeepRepoCheck(e.target.checked)} disabled={running || loading} />
          Deep repo check
        </label>

        <label className="cleanup-semantic-toggle" title="Analyze and report changes without modifying or trashing any note">
          <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} disabled={running || loading} />
          Preview only (dry run)
        </label>

        <div className="optimizer-action-buttons">
          {!running ? (
            <button type="button" className="button button-primary" onClick={startRun} disabled={loading || (!readyProviders.length && form.provider === 'auto')}>
              <Sparkles size={16} aria-hidden="true" />
              {dryRun ? 'Preview optimization' : 'Optimize memories'}
            </button>
          ) : (
            <button type="button" className="button danger-button" onClick={cancelRun}>
              <Square size={15} aria-hidden="true" />
              Cancel run
            </button>
          )}
          <button type="button" className="button" onClick={() => setShowSettings(s => !s)} aria-expanded={showSettings}>
            <Settings size={16} aria-hidden="true" />
            Model settings
          </button>
        </div>
      </div>

      <div className="optimizer-provider-strip" aria-label="Available model runners">
        <span className="cleanup-meta">Detected runners:</span>
        {providers.map(p => (
          <span key={p.id} className={`optimizer-badge ${p.available ? 'ready' : 'unavailable'}`} title={p.detail || ''}>
            <span className="optimizer-badge-dot" aria-hidden="true" />
            {p.label}
          </span>
        ))}
      </div>

      {showSettings && (
        <section className="cleanup-card optimizer-settings" aria-label="Memory Optimizer model settings">
          <div className="optimizer-settings-head">
            <h2><Wrench size={16} aria-hidden="true" /> Model &amp; runner configuration</h2>
            <span className="cleanup-meta">Auto picks an installed authenticated CLI first, then any configured API key.</span>
          </div>
          <div className="optimizer-settings-grid">
            <label>
              Provider
              <select value={form.provider} onChange={e => setForm(prev => ({ ...prev, provider: e.target.value }))} disabled={savingSettings || running}>
                <option value="auto">Auto (best available CLI or API)</option>
                {providers.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.label}{p.available ? '' : ' (not detected)'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model override (optional)
              <input
                type="text"
                value={form.model}
                placeholder="Default for selected provider"
                onChange={e => setForm(prev => ({ ...prev, model: e.target.value }))}
                disabled={savingSettings || running}
              />
            </label>
            <label>
              Batch size (notes per call)
              <input
                type="number"
                min={4}
                max={40}
                value={form.maxNotesPerBatch}
                onChange={e => setForm(prev => ({ ...prev, maxNotesPerBatch: e.target.value }))}
                disabled={savingSettings || running}
              />
            </label>
            <label>
              API key (for Anthropic / OpenAI / Gemini API)
              <input
                type="password"
                value={form.apiKey}
                placeholder={settings?.hasApiKey ? `Saved (${settings.apiKeySource || 'config'}) - leave blank to keep` : 'Paste key or set env var'}
                onChange={e => setForm(prev => ({ ...prev, apiKey: e.target.value }))}
                disabled={savingSettings || running}
              />
            </label>
            <label>
              OpenAI-compatible base URL (optional)
              <input
                type="url"
                value={form.apiBaseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={e => setForm(prev => ({ ...prev, apiBaseUrl: e.target.value }))}
                disabled={savingSettings || running}
              />
            </label>
            <label className="cleanup-semantic-toggle">
              <input
                type="checkbox"
                checked={form.deepRepoCheck}
                onChange={e => setForm(prev => ({ ...prev, deepRepoCheck: e.target.checked }))}
                disabled={savingSettings || running}
              />
              Default to deep repo check
            </label>
          </div>
          <div className="optimizer-settings-actions">
            <button type="button" className="button button-primary" onClick={() => saveSettings(false)} disabled={savingSettings || running}>
              {savingSettings ? 'Saving...' : 'Save settings'}
            </button>
            {settings?.apiKeySource === 'config' && (
              <button type="button" className="button" onClick={() => saveSettings(true)} disabled={savingSettings || running}>
                Clear stored API key
              </button>
            )}
            {settingsMessage && <span className="cleanup-meta" role="status">{settingsMessage}</span>}
          </div>
        </section>
      )}

      {error && (
        <div className="cleanup-notice" role="alert">
          <p>{error}</p>
        </div>
      )}

      {running && activeJob && (
        <section className="cleanup-card optimizer-progress" role="status" aria-live="polite">
          <div className="optimizer-progress-head">
            <strong>{activeJob.phase || 'Running optimization...'}</strong>
            <span className="cleanup-meta">
              {activeJob.completedBatches || 0} / {activeJob.totalBatches || '?'} batches
            </span>
          </div>
          <div className="optimizer-progress-bar">
            <div
              className="optimizer-progress-fill"
              style={{ width: activeJob.totalBatches ? `${Math.round(((activeJob.completedBatches || 0) / activeJob.totalBatches) * 100)}%` : '12%' }}
            />
          </div>
          <div className="optimizer-stats-row">
            <span>Updated: {activeJob.counts?.updated || 0}</span>
            <span>Merged: {activeJob.counts?.merged || 0}</span>
            <span>Moved: {activeJob.counts?.moved || 0}</span>
            <span>Trashed: {activeJob.counts?.trashed || 0}</span>
            <span>Kept: {activeJob.counts?.kept || 0}</span>
          </div>
          {activeJob.lastMessage && <p className="cleanup-meta">{activeJob.lastMessage}</p>}
        </section>
      )}

      {!running && !activeRun && !loading && (
        <p className="cleanup-empty">No optimization runs recorded yet. Choose a workspace above and click Optimize memories.</p>
      )}

      {activeRun && (
        <section className="optimizer-report" aria-label="Optimization results">
          <div className="optimizer-report-header">
            <div>
              <h2>{activeRun.dryRun ? 'Preview run report' : 'Optimization report'}</h2>
              <p className="cleanup-meta">
                {new Date(activeRun.startedAt).toLocaleString()} · Runner: <strong>{activeRun.providerUsed || activeRun.provider}</strong>
                {activeRun.modelUsed ? ` (${activeRun.modelUsed})` : ''}
                {activeRun.workspace ? ` · Workspace: ${activeRun.workspace}` : ' · All workspaces'}
                {activeRun.snapshotId ? ` · Pre-run snapshot: ${activeRun.snapshotId}` : ''}
              </p>
            </div>
            {runs.length > 1 && (
              <label className="optimizer-history-select">
                Run history
                <select value={activeRun.id} onChange={e => setSelectedRunId(e.target.value)}>
                  {runs.map(run => (
                    <option key={run.id} value={run.id}>
                      {new Date(run.startedAt).toLocaleString()} ({run.dryRun ? 'Dry run' : `${(run.counts?.updated || 0) + (run.counts?.merged || 0) + (run.counts?.moved || 0) + (run.counts?.trashed || 0)} changes`})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="optimizer-summary-grid">
            <div className="cleanup-card optimizer-stat-card"><span>Evaluated</span><strong>{activeRun.scannedNotes ?? 0}</strong></div>
            <div className="cleanup-card optimizer-stat-card"><span>Updated</span><strong>{activeRun.counts?.updated ?? 0}</strong></div>
            <div className="cleanup-card optimizer-stat-card"><span>Merged</span><strong>{activeRun.counts?.merged ?? 0}</strong></div>
            <div className="cleanup-card optimizer-stat-card"><span>Moved</span><strong>{activeRun.counts?.moved ?? 0}</strong></div>
            <div className="cleanup-card optimizer-stat-card"><span>Trashed</span><strong>{activeRun.counts?.trashed ?? 0}</strong></div>
            <div className="cleanup-card optimizer-stat-card"><span>Kept</span><strong>{activeRun.counts?.kept ?? 0}</strong></div>
            <div className="cleanup-card optimizer-stat-card"><span>Skipped / Blocked</span><strong>{activeRun.counts?.skipped ?? 0}</strong></div>
          </div>

          {activeRun.error && (
            <div className="cleanup-notice" role="alert">
              <p>Run error: {activeRun.error}</p>
            </div>
          )}
          {restoreError && (
            <div className="cleanup-notice" role="alert">
              <p>{restoreError}</p>
            </div>
          )}
          {activeRun.warnings?.length > 0 && (
            <div className="cleanup-notice">
              <strong>Run notes</strong>
              <ul>
                {activeRun.warnings.map((w, idx) => <li key={idx}>{w}</li>)}
              </ul>
            </div>
          )}

          {activeRun.applied?.length > 0 && (
            <div className="optimizer-action-list">
              {(activeRun.applied || []).filter(item => item.type !== 'keep').map((item, idx) => {
                const isRestored = item.trashId && restoredIds.has(item.trashId);
                return (
                  <article className="cleanup-card optimizer-action-card" key={`${item.type}-${item.path || item.targetPath || idx}`}>
                    <div className="cleanup-card-heading">
                      <span className={`cleanup-tag optimizer-tag-${item.outcome || item.type}`}>
                        {item.type === 'trash' ? (activeRun.dryRun ? 'Would trash' : 'Moved to Trash')
                          : item.type === 'move' ? (activeRun.dryRun ? 'Would move' : 'Moved workspace')
                            : item.type === 'merge' ? (activeRun.dryRun ? 'Would merge' : 'Merged')
                              : item.type === 'update' ? (activeRun.dryRun ? 'Would tidy' : 'Updated')
                                : item.outcome || item.type}
                      </span>
                      <a className="cleanup-note-title" href={noteUrl(item.targetPath || item.path)}>
                        {item.title || item.targetPath || item.path}
                      </a>
                    </div>
                    <p className="cleanup-path">{item.type === 'move' ? `${item.fromWorkspace || 'unknown'} -> ${item.toWorkspace} · From ${item.path} to ${item.targetPath}` : (item.targetPath || item.path)}</p>
                    {item.sourcePaths?.length > 0 && (
                      <p className="cleanup-meta">Sources consolidated: {item.sourcePaths.join(', ')}</p>
                    )}
                    {item.reason && <p className="cleanup-recommendation">{item.reason}</p>}
                    {item.error && <p className="cleanup-blocked">{item.error}</p>}
                    <div className="cleanup-note-actions">
                      {item.type !== 'trash' && (
                        <>
                          <a className="button" href={noteUrl(item.targetPath || item.path)}>Open note</a>
                          {onOpenSplit && (
                            <button type="button" className="button" onClick={() => onOpenSplit({ kind: 'note', path: item.targetPath || item.path })}>
                              Open in split
                            </button>
                          )}
                        </>
                      )}
                      {item.trashId && !activeRun.dryRun && (
                        isRestored ? (
                          <span className="cleanup-meta optimizer-restored"><CheckCircle2 size={15} aria-hidden="true" /> Restored to vault</span>
                        ) : (
                          <button
                            type="button"
                            className="button"
                            onClick={() => restoreTrashItem(item.trashId)}
                            disabled={restoringId === item.trashId}
                          >
                            <RotateCcw size={15} aria-hidden="true" />
                            {restoringId === item.trashId ? 'Restoring...' : 'Restore from Trash'}
                          </button>
                        )
                      )}
                      {Array.isArray(item.trashedSources) && item.trashedSources.map(src => (
                        src.trashId && (
                          restoredIds.has(src.trashId) ? (
                            <span key={src.trashId} className="cleanup-meta optimizer-restored"><CheckCircle2 size={15} aria-hidden="true" /> Restored {src.path}</span>
                          ) : (
                            <button
                              key={src.trashId}
                              type="button"
                              className="button"
                              onClick={() => restoreTrashItem(src.trashId)}
                              disabled={restoringId === src.trashId}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                              Restore {src.path.split('/').pop()}
                            </button>
                          )
                        )
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
