import React, { useEffect, useRef, useState } from 'react';
import { ScanSearch, Trash2 } from 'lucide-react';
import { DeleteNote } from './Management.jsx';
import { decisionKey, readDecisions, writeDecisions, buildHandoff } from './cleanup-review.mjs';
import CleanupReview from './CleanupReview.jsx';
import CleanupAnalysis from './CleanupAnalysis.jsx';
import './Cleanup.css';

const categories = [['all', 'All'], ['duplicate', 'Duplicates'], ['merge', 'Merge suggestions'], ['empty', 'Empty'], ['stale', 'Stale']];
const noteUrl = path => '/?note=' + encodeURIComponent(path);

async function responseData(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function semanticSummary(status) {
  if (!status) return '';
  if (!status.enabled || status.state === 'disabled') return 'Semantic comparison disabled.';
  if (status.state === 'not-requested') return 'Semantic comparison not requested.';
  const details = [];
  if (status.model) details.push(`Model: ${status.model}`);
  if (Number.isFinite(status.cacheHits)) details.push(`${status.cacheHits.toLocaleString()} cached chunks reused`);
  if (Number.isFinite(status.embeddedChunks)) details.push(`${status.embeddedChunks.toLocaleString()} chunks embedded`);
  if (Number.isFinite(status.comparedPairs) && Number.isFinite(status.possiblePairs)) details.push(`${status.comparedPairs.toLocaleString()} of ${status.possiblePairs.toLocaleString()} possible pairs compared`);
  const state = status.state === 'unavailable' || status.state === 'error' ? 'Semantic comparison unavailable' : status.incomplete || status.state === 'incomplete' ? 'Semantic comparison incomplete' : status.state === 'ready' && status.embeddedChunks === 0 && status.cacheHits > 0 ? 'Semantic comparison complete (cached vectors only)' : status.state === 'ready' ? 'Semantic comparison complete' : `Semantic comparison: ${status.state || 'complete'}`;
  return `${state}.${details.length ? ` ${details.join(' · ')}.` : ''}${status.reason ? ` ${status.reason}` : ''}`;
}

export default function Cleanup({ groups, vaultId, onCatalogChanged }) {
  const [workspace, setWorkspace] = useState('');
  const [category, setCategory] = useState('all');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [semantic, setSemantic] = useState(true);
  const [phase, setPhase] = useState('');
  const [semanticError, setSemanticError] = useState('');
  const [visible, setVisible] = useState(20);
  const [selected, setSelected] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [storageError, setStorageError] = useState('');
  const [decisionFilter, setDecisionFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [handoff, setHandoff] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => {
    try { setDecisions(readDecisions(window.localStorage, vaultId)); setStorageError(''); }
    catch { setDecisions({}); setStorageError('Browser storage is unavailable for this vault. Decisions remain in this session only.'); }
  }, [vaultId]);
  function updateDecision(item, changes) {
    const key = decisionKey(item);
    const next = { ...decisions, [key]: { decision: 'undecided', instructions: '', targetPath: null, ...decisions[key], ...changes, updatedAt: new Date().toISOString() } };
    setDecisions(next);
    try { writeDecisions(window.localStorage, vaultId, next); setStorageError(''); }
    catch { setStorageError('Browser storage is unavailable for this vault. Decisions remain in this session only.'); }
    setHandoff('');
  }
  function exportHandoff() {
    const report = buildHandoff({ vaultId, workspace, items, decisions, generatedAt: new Date().toISOString() });
    report.scan = { scannedAt: result.scannedAt, coverage: result.coverage, semantic: result.semantic, warnings: result.warnings, completeScanFinished: !busy };
    const json = JSON.stringify(report, null, 2).replace(/\r?\n/g, '\r\n');
    setHandoff(json); setCopyStatus('');
    return json;
  }
  async function copyHandoff() {
    try { const json = exportHandoff(); await navigator.clipboard.writeText(json); setCopyStatus('Copied JSON to clipboard.'); }
    catch { setCopyStatus('Could not copy automatically. Select the JSON below or download it.'); }
  }
  const request = useRef(null);
  useEffect(() => () => { request.current?.abort(); }, []);

  async function scan(scope = workspace) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setPhase('lexical'); setError(''); setSemanticError(''); setResult(null); setVisible(20); setExpanded(null); setHandoff('');
    const current = () => request.current === controller && !controller.signal.aborted;
    let lexical;
    try {
      lexical = await responseData(await fetch('/api/cleanup' + (scope ? '?workspace=' + encodeURIComponent(scope) : ''), { signal: controller.signal }));
      if (!current()) return;
      setResult(lexical);
      if (!semantic || !lexical.semantic?.enabled) return;
      setPhase('semantic');
      const session = await responseData(await fetch('/api/editor-session', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }));
      if (!session.token) throw new Error('Could not start a secure session. Refresh and try again.');
      const data = await responseData(await fetch('/api/cleanup', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Shared-Brain-CSRF': session.token },
        body: JSON.stringify(scope ? { workspace: scope } : {}),
      }));
      if (current()) setResult(data);
    } catch (e) {
      if (current()) {
        if (lexical) setSemanticError(e.message || 'Semantic comparison failed.');
        else setError(e.message || 'Could not scan notes.');
      }
    } finally {
      if (current()) { setBusy(false); setPhase(''); }
    }
  }
  function changeWorkspace(value) {
    request.current?.abort(); setBusy(false); setPhase(''); setError(''); setSemanticError(''); setResult(null); setVisible(20); setSelected(null); setWorkspace(value); setExpanded(null); setHandoff('');
  }
  const items = result?.items || [];
  const filtered = items.filter(item => (category === 'all' || item.category === category) && (decisionFilter === 'all' || (decisions[decisionKey(item)]?.decision || 'undecided') === decisionFilter));
  const counts = items.reduce((total, item) => { total[decisions[decisionKey(item)]?.decision || 'undecided']++; return total; }, { approved: 0, rejected: 0, undecided: 0 });
  const similarityIncomplete = result?.coverage?.mergeIncomplete || result?.semantic?.incomplete || ['unavailable', 'error'].includes(result?.semantic?.state) || Boolean(semanticError);
  return <section className="cleanup" aria-label="Clean up notes">
    <div className="cleanup-heading"><div><p className="eyebrow">Library / Maintenance</p><h1>Clean up</h1><p className="page-description">Find candidates to inspect, without changing your notes.</p></div></div>
    <div className="cleanup-intro"><p>Inspect the evidence, approve or reject each suggestion, and add any instructions for the merge. Then copy one JSON handoff for your agent to reconcile the full sources.</p><p>Approval records a browser-local decision, not an edit or approval of the note contents. Owner notes remain human-only; their approved suggestions are exported as proposals, never permission for an agent to rewrite them.</p><p>Semantic comparison reuses cached vectors and may load the local model for missing content. Similarity identifies possible overlap, not agreement or merge safety. Nothing is merged or removed automatically.</p></div>
    <div className="cleanup-controls"><label>Workspace<select value={workspace} onChange={e => changeWorkspace(e.target.value)}><option value="">All workspaces</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}{!groups.some(group => group.id === '__unmapped') && <option value="__unmapped">Unmapped notes</option>}</select></label><label className="cleanup-semantic-toggle"><input type="checkbox" checked={semantic} onChange={e => setSemantic(e.target.checked)} disabled={busy} />Include semantic comparison</label><button type="button" className="button button-primary" onClick={() => scan()} disabled={busy}><ScanSearch size={17} aria-hidden="true" />{busy ? 'Scanning…' : result ? 'Scan again' : 'Scan notes'}</button></div>
    {busy && <p role="status">{phase === 'semantic' ? 'Comparing semantic similarity… Lexical results remain available; no notes are being changed.' : 'Scanning notes… No notes are being changed.'}</p>}
    {error && <div className="cleanup-notice" role="alert"><p>Could not scan notes: {error}</p><button type="button" className="button" onClick={() => scan()}>Retry scan</button></div>}
    {semanticError && <div className="cleanup-notice" role="alert">Semantic comparison unavailable: {semanticError} Lexical results are retained.</div>}
    {!result && !busy && !error && <p className="cleanup-empty">Choose a workspace or scan the whole vault to see suggestions.</p>}
    {result && <>
      {storageError && <div className="cleanup-notice" role="alert">{storageError}</div>}
      <div className="cleanup-review-toolbar">
        <div><strong>Suggestion review</strong><p className="cleanup-meta">{counts.approved} approved · {counts.rejected} rejected · {counts.undecided} undecided. These are browser-local decisions, not note review approvals.</p></div>
        <label>Decision <select value={decisionFilter} onChange={e => { setDecisionFilter(e.target.value); setVisible(20); }}><option value="all">All decisions</option><option value="undecided">Undecided</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label>
        <button type="button" className="button button-primary" onClick={copyHandoff} disabled={busy || !vaultId}>Copy JSON handoff</button>
      </div>
      <p className="cleanup-meta">The handoff contains private paths and evidence. Share it only with a trusted agent. It does not execute changes.</p>
      {handoff && <div className="cleanup-handoff"><label htmlFor="cleanup-handoff-json">Handoff JSON (select and copy if needed)</label><textarea id="cleanup-handoff-json" readOnly value={handoff} onFocus={e => e.target.select()} /><a className="button" download="cleanup-handoff.json" href={'data:application/json;charset=utf-8,' + encodeURIComponent(handoff)}>Download JSON</a><p role="status">{copyStatus}</p></div>}
      <CleanupAnalysis vaultId={vaultId} workspace={workspace} items={items} decisions={decisions} scan={result} scanning={busy} />
      <p className="cleanup-meta" role="status">Scanned {result.scannedNotes.toLocaleString()} notes · {new Date(result.scannedAt).toLocaleString()}</p>
      {result.semantic && !semanticError && phase !== 'semantic' && <p className="cleanup-meta" role="status">{semanticSummary(result.semantic)}{result.semantic.state !== 'not-requested' && (result.semantic.incomplete || result.semantic.state === 'incomplete' || result.semantic.state === 'unavailable' || result.semantic.state === 'error') ? ' Lexical results remain available.' : ''}</p>}
      {result.coverage?.insufficientHistoryNotes > 0 && <p className="cleanup-meta">{result.coverage.insufficientHistoryNotes.toLocaleString()} notes lack enough observed usage history for stale classification. Tracking started {result.coverage.trackingHistoryDays ?? 'an unknown number of'} {result.coverage.trackingHistoryDays === 1 ? 'day' : 'days'} ago; stale checks require {result.coverage.usageTracking.staleDays} days per note.</p>}
      {result.warnings?.length > 0 && <div className="cleanup-notice"><strong>Scan limitations</strong><ul>{result.warnings.map((warning, index) => <li key={index}>{typeof warning === 'string' ? warning : JSON.stringify(warning)}</li>)}</ul></div>}
      {result.coverage && <details className="cleanup-coverage"><summary>Scan coverage and limits</summary><dl>
        <dt>Notes checked for protections</dt><dd>{result.coverage.totalNotes.toLocaleString()}</dd>
        <dt>Notes in selected scope</dt><dd>{result.coverage.selectedNotes.toLocaleString()}</dd>
        <dt>Merge comparison coverage</dt><dd>{result.coverage.mergeComparedNotes.toLocaleString()} notes included; {result.coverage.mergeSkippedNotes.toLocaleString()} skipped by the per-workspace limit</dd>
        <dt>Merge pair coverage</dt><dd>{result.coverage.mergePairsCompared.toLocaleString()} of {result.coverage.mergePossiblePairs.toLocaleString()} possible pairs; up to {result.coverage.mergeResultLimit.toLocaleString()} suggestions</dd>
        <dt>Per-workspace merge limit</dt><dd>{result.coverage.mergeNotesPerProjectLimit.toLocaleString()} notes, up to {result.coverage.mergeWordsPerNoteLimit.toLocaleString()} words per note</dd>
        <dt>Stale-note tracking</dt><dd>{result.coverage.usageTracking.healthy ? `Available; requires ${result.coverage.usageTracking.staleDays} days of observed history` : 'Unavailable; absence of receipts cannot establish staleness'}</dd>
        {(result.coverage.workspaces || []).map(scope => <React.Fragment key={scope.project}><dt>{groups.find(group => group.id === scope.project)?.name || scope.project}</dt><dd>{scope.comparedPairs.toLocaleString()} of {scope.possiblePairs.toLocaleString()} pairs inspected</dd></React.Fragment>)}
      </dl></details>}
      <nav className="cleanup-categories" aria-label="Cleanup categories">{categories.map(([key, label]) => <button type="button" key={key} className={category === key ? 'active' : ''} aria-pressed={category === key} onClick={() => { setCategory(key); setVisible(20); }}>{label} <span>{key === 'all' ? items.length : result.counts[key] || 0}</span></button>)}</nav>
      {!filtered.length ? <p className="cleanup-empty">{decisionFilter !== 'all' && items.length ? 'No suggestions match these category and decision filters.' : (category === 'all' || category === 'merge') && phase === 'semantic' ? 'No lexical candidates yet; semantic comparison is still running.' : (category === 'all' || category === 'merge') && similarityIncomplete ? 'No candidates found in the completed checks. Similarity coverage is incomplete; review the status above, retry, or narrow the workspace. This is not a clean bill of health.' : `No ${category === 'all' ? 'cleanup candidates' : categories.find(([key]) => key === category)?.[1].toLowerCase()} found in this scan.`}</p> : <>
        <div className="cleanup-results">{filtered.slice(0, visible).map(item => <article className="cleanup-card" key={item.id}>
          <div className="cleanup-card-heading"><span className="cleanup-tag">{item.category === 'merge' ? item.evidence?.methods?.includes('semantic') ? item.evidence.methods.includes('lexical') ? 'Semantic + lexical' : 'Semantic overlap' : 'Lexical overlap' : categories.find(([key]) => key === item.category)?.[1]}</span><p>{item.reason}</p></div>
          <p className="cleanup-recommendation">Review guidance: {item.recommendation}</p>
          {item.evidence?.terms?.length > 0 && <p className="cleanup-meta">Measured lexical evidence — shared content terms: {item.evidence.terms.join(', ')}</p>}
          {Number.isFinite(item.evidence?.semanticSimilarity) && <p className="cleanup-meta">Measured embedding cosine: {item.evidence.semanticSimilarity.toFixed(3)} — cosine measures the angle between embedding vectors, not probability, agreement, or merge safety. The model generates embeddings, not merge reasoning.</p>}
          {item.evidence?.passages?.length > 0 && <div className="cleanup-evidence"><strong>Best-matching passages</strong>{item.evidence.passages.map((passage, index) => <blockquote key={index}><span>{passage.path}{passage.heading ? ` · ${passage.heading}` : ''}</span><p>{passage.excerpt}</p></blockquote>)}</div>}
          <div className="cleanup-notes">{item.notes.map(note => <div className="cleanup-note" key={note.path}>
            <div><a className="cleanup-note-title" href={noteUrl(note.path)}>{note.title}</a><span className="cleanup-path">{note.path}</span><span className="cleanup-note-meta">{[...new Set([note.project || 'global', note.owner, note.status, note.reviewStatus].filter(Boolean))].join(' · ')}</span><span className="cleanup-note-meta">Scan revision: {note.revision || 'unavailable'}</span></div>
            <div className="cleanup-note-actions"><a className="button" href={noteUrl(note.path)}>Open / inspect</a>{!item.reviewOnly && note.cleanupBlockedReason === null ? <button type="button" className="button" onClick={() => setSelected(note)}><Trash2 size={15} aria-hidden="true" />Move to Trash</button> : <span className="cleanup-blocked">{item.reviewOnly ? 'Review only; compare sources before merging' : `Not available: ${note.cleanupBlockedReason || 'Protection status unavailable'}`}</span>}</div>
          </div>)}</div>
          <CleanupReview key={decisionKey(item)} item={item} record={decisions[decisionKey(item)]} expanded={expanded === decisionKey(item)} onExpand={() => setExpanded(expanded === decisionKey(item) ? null : decisionKey(item))} onChange={changes => updateDecision(item, changes)} />
        </article>)}</div>
        {visible < filtered.length && <button type="button" className="button cleanup-more" onClick={() => setVisible(value => value + 20)}>Show more ({filtered.length - visible} remaining)</button>}
      </>}
    </>}
    {selected && <DeleteNote cleanup note={selected} onClose={() => setSelected(null)} onDeleted={() => { setSelected(null); onCatalogChanged(); scan(); }} />}
  </section>;
}
