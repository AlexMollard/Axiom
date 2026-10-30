import React, { useEffect, useRef, useState } from 'react';
import { analysisPrompt, buildAnalysisPack } from './cleanup-review.mjs';

export default function CleanupAnalysis({ vaultId, workspace, items, decisions, scan, scanning }) {
  const [pack, setPack] = useState(null);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const request = useRef(null);
  useEffect(() => {
    request.current?.abort();
    setPack(null); setPreparing(false); setProgress(null); setError(''); setStatus('');
    return () => request.current?.abort();
  }, [vaultId, workspace, items, decisions, scanning]);

  async function prepare() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = () => request.current === controller && !controller.signal.aborted;
    setPreparing(true); setPack(null); setError(''); setStatus('');
    try {
      const result = await buildAnalysisPack({
        vaultId, workspace, items, decisions, signal: controller.signal,
        scan: { scannedAt: scan.scannedAt, coverage: scan.coverage, semantic: scan.semantic, warnings: scan.warnings, completeScanFinished: !scanning },
        onProgress: value => { if (current()) setProgress(value); },
        readSource: async (path, signal) => {
          const response = await fetch('/api/note?path=' + encodeURIComponent(path), { credentials: 'same-origin', cache: 'no-store', signal });
          if (!response.ok) throw new Error(`Could not read ${path}. Retry or rescan before exporting.`);
          return (await response.json()).note;
        },
      });
      if (current()) { setPack(result); setStatus('AI analysis pack ready. Nothing has been changed or sent to a model.'); }
    } catch (failure) {
      if (current()) setError(failure.message || 'Could not prepare the analysis pack.');
    } finally { if (current()) setPreparing(false); }
  }
  function cancel() {
    request.current?.abort(); setPreparing(false); setProgress(null);
    setStatus('Preparation cancelled. No pack was exported.');
  }
  async function copy() {
    try { await navigator.clipboard.writeText(pack.json); setStatus('AI analysis pack copied to clipboard.'); }
    catch { setStatus('Could not copy automatically. Select the JSON below or use Download AI pack.'); }
  }
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(analysisPrompt); setStatus('Companion prompt copied. Paste it with the AI analysis JSON.'); }
    catch { setStatus('Could not copy automatically. Select the companion prompt below and copy it manually.'); }
  }

  return <section className="cleanup-analysis" aria-labelledby="cleanup-analysis-title">
    <h2 id="cleanup-analysis-title">Let a model assess all proposals</h2>
    <p>Prepare a self-contained JSON pack for all {items.length} suggestions in this scan, including undecided and rejected ones, regardless of the display filters. Full source notes are included once, with revisions, evidence, your decisions and a task brief requesting reasoned recommendations and merged drafts.</p>
    <p className="cleanup-meta"><strong>Includes full private Markdown.</strong> Nothing is uploaded automatically. Giving the file to a cloud model sends that content to its provider. The pack is analysis-only, not permission to edit or delete. Up to 8 MiB / 1,000 unique sources; choose a workspace for a smaller pack and check your model's context limits.</p>
    <div className="cleanup-analysis-actions"><button type="button" className="button" onClick={prepare} disabled={scanning || preparing || !vaultId || !items.length}>{preparing ? 'Preparing AI pack…' : 'Prepare AI analysis pack'}</button>{preparing && <button type="button" className="button" onClick={cancel}>Cancel preparation</button>}</div>
    {preparing && progress && <p role="status">Reading full sources: {progress.loaded} of {progress.total}…</p>}
    {error && <p className="cleanup-notice" role="alert">{error} No incomplete pack was exported.</p>}
    {status && <p role="status">{status}</p>}
    {pack && <div className="cleanup-handoff">
      <p>{pack.suggestionCount} proposals · {pack.sourceCount} unique full sources · {(pack.bytes / 1024).toFixed(1)} KiB</p>
      <div className="cleanup-analysis-actions"><button type="button" className="button button-primary" onClick={copy}>Copy AI pack</button><a className="button" download="axiom-cleanup-analysis.json" href={'data:application/json;charset=utf-8,' + encodeURIComponent(pack.json)}>Download AI pack</a></div>
      <label htmlFor="cleanup-analysis-prompt">Prompt to send with the JSON</label><textarea id="cleanup-analysis-prompt" readOnly value={analysisPrompt} onFocus={event => event.target.select()} />
      <div className="cleanup-analysis-actions"><button type="button" className="button" onClick={copyPrompt}>Copy prompt</button></div>
      <label htmlFor="cleanup-analysis-json">AI analysis JSON (select and copy if needed)</label><textarea id="cleanup-analysis-json" readOnly value={pack.json} onFocus={event => event.target.select()} />
    </div>}
  </section>;
}
