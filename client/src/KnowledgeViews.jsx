import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { DiagnosticRefresh, useDiagnostic } from './DiagnosticRefresh.jsx';
import { apiMutate } from './desktop-bridge.mjs';
import './KnowledgeViews.css';

async function get(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function NoteLink({ note, onOpenNote }) {
  return <button type="button" className="knowledge-note" onClick={() => onOpenNote(note.path)}><strong>{note.title}</strong><span>{note.path}</span><span>{note.owner === 'owner' ? 'Owner' : `Agent${note.reviewStatus ? ` | ${note.reviewStatus === 'reviewed' ? 'Reviewed' : 'Unreviewed'}` : ''}`}{note.status && note.status !== 'owner' && note.status !== note.reviewStatus ? ` | ${note.status}` : ''}{note.source ? ` | Source: ${note.source}` : ''}</span></button>;
}
function NoteList({ title, notes, empty, onOpenNote }) {
  return <section className="knowledge-card"><h2>{title}</h2>{notes.length ? <ul className="knowledge-list">{notes.map(note => <li key={note.path}><NoteLink note={note} onOpenNote={onOpenNote} /></li>)}</ul> : <p>{empty}</p>}</section>;
}
export function WorkspaceOverview({ id, label, onOpenNote }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [picking, setPicking] = useState(false);
  useEffect(() => {
    let active = true;
    setData(null); setError(''); setPicking(false);
    get('/api/workspace-overview?id=' + encodeURIComponent(id)).then(value => { if (active) setData(value); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [id]);
  async function changePin(path, add) {
    setBusy(true); setError('');
    try {
      const detail = await get('/api/workspace?id=' + encodeURIComponent(id));
      const pins = Array.isArray(detail.pins) ? detail.pins : [];
      const next = add ? [...new Set([...pins, path])] : pins.filter(item => item !== path);
      await apiMutate('/api/workspace', { method: 'PUT', body: { id, name: detail.name, icon: detail.icon, group: detail.group, expectedRevision: detail.revision, pins: next } });
      setData(await get('/api/workspace-overview?id=' + encodeURIComponent(id)));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!data) return <section className="knowledge-view">{error ? <p role="alert">{error}</p> : <p>Loading workspace overview…</p>}</section>;
  const pinned = new Set(data.pins.map(pin => pin.path));
  return <section className="knowledge-view" aria-label={`${label} overview`}>
    {error && <p className="knowledge-error" role="alert">{error}</p>}
    <div className="knowledge-grid"><section className="knowledge-card"><div className="knowledge-heading"><h2>Pinned notes</h2><button type="button" className="button" disabled={busy} aria-expanded={picking} onClick={() => setPicking(!picking)}>{picking ? 'Close picker' : 'Choose pins'}</button></div>
      {data.pins.length ? <ul className="knowledge-list">{data.pins.map(pin => <li className="knowledge-pin" key={pin.path}>{pin.note ? <NoteLink note={pin.note} onOpenNote={onOpenNote} /> : <span className="knowledge-stale">Unavailable or outside this workspace: {pin.path}</span>}<button type="button" className="button" disabled={busy} onClick={() => changePin(pin.path, false)} aria-label={`Remove pin ${pin.path}`}>Remove</button></li>)}</ul> : <p>No pinned notes yet.</p>}
      {picking && <div className="knowledge-picker"><h3>Workspace notes</h3>{data.notes.length ? <ul className="knowledge-list">{data.notes.map(note => <li className="knowledge-pin" key={note.path}><NoteLink note={note} onOpenNote={onOpenNote} /><button type="button" className="button" disabled={busy || pinned.has(note.path)} onClick={() => changePin(note.path, true)}>{pinned.has(note.path) ? 'Pinned' : 'Pin'}</button></li>)}</ul> : <p>There are no notes to pin in this workspace.</p>}</div>}
    </section><NoteList title="Recent decisions" notes={data.decisions} empty="No explicitly recorded decisions." onOpenNote={onOpenNote} /><NoteList title="Proposals" notes={data.proposals} empty="No proposals recorded." onOpenNote={onOpenNote} /><NoteList title="Recent activity" notes={data.activity} empty="No notes in this workspace yet." onOpenNote={onOpenNote} /></div>
  </section>;
}
function Queue({ title, description, children, empty }) {
  return <section className="knowledge-card"><h2>{title}</h2><p>{description}</p>{children.length ? <ul className="knowledge-list">{children}</ul> : <p>{empty}</p>}</section>;
}
function SemanticHealth() {
  const [status, setStatus] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(true), [reindexing, setReindexing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/embeddings', { signal: controller.signal }).then(async response => {
      const data = await response.json(); if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`); return data;
    }).then(setStatus).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  async function refreshStatus() {
    setBusy(true); setError('');
    try { setStatus(await get('/api/embeddings')); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function reindex() {
    setBusy(true); setReindexing(true); setError('');
    try {
      const result = await apiMutate('/api/embeddings/reindex', { method: 'POST', body: {} });
      setStatus(result);
    } catch (e) { setError(e.message); } finally { setBusy(false); setReindexing(false); }
  }
  return <section className="knowledge-card semantic-health" aria-label="Semantic search health">
    <h2>Semantic search</h2>
    <p>Check the local model without waking it. Reindexing may wake the model and take some time; it does not change notes.</p>
    {error && <p role="alert">{error}</p>}
    {!status && !error && <p role="status">Checking semantic search…</p>}
    {status && <div role="status"><p>{status.enabled === false ? 'Disabled' : status.loaded ? 'Model loaded' : status.state === 'unavailable' || status.state === 'error' ? 'Unavailable' : 'Model sleeping or not loaded'}{status.state ? ` · ${status.state}` : ''}{status.model ? ` · ${status.model}` : ''}</p>
      {status.reason && <p>{status.reason}</p>}
      {Number.isFinite(status.indexedChunks) && <p>Cached chunks: {status.indexedChunks.toLocaleString()}</p>}
      {Number.isFinite(status.gpuBytes) && status.gpuBytes > 0 && <p>Model GPU allocation: {(status.gpuBytes / 1048576).toFixed(0)} MiB (not total VRAM).</p>}
    </div>}
    <div className="semantic-health-actions"><button type="button" className="button" disabled={busy} onClick={refreshStatus}><RefreshCw size={16} aria-hidden="true" />Refresh status</button><button type="button" className="button" disabled={busy || status?.enabled === false} onClick={reindex}>Reindex active notes</button></div>
    {reindexing && <p role="status">Reindexing… This can take 10–40 seconds or longer.</p>}
  </section>;
}
export function MemoryHealth({ groups, onOpenNote }) {
  const {data, error, loading, checked, failedAt, refresh} = useDiagnostic('/api/memory-health');
  return <section className="knowledge-view"><SemanticHealth /><DiagnosticRefresh loading={loading} checked={checked} failedAt={failedAt} refresh={refresh} />{error && <p role="alert">{error}</p>}{!data && !error && <p>Checking memory…</p>}{data && <><p>Inspect these notes and edit them where appropriate. No notes are changed automatically.</p><div className="knowledge-grid">
    <Queue title="Unmapped workspaces" description="Notes whose project is not a configured workspace." empty="No unmapped notes.">{data.ambiguous.map(note => <li key={note.path}><NoteLink note={note} onOpenNote={onOpenNote} /><span>Project: {note.project}</span></li>)}</Queue>
    <Queue title="Unresolved links" description="Links the Markdown resolver could not uniquely resolve; open the source note to investigate." empty="No unresolved links.">{data.brokenLinks.map(({ note, count }) => <li key={note.path}><NoteLink note={note} onOpenNote={onOpenNote} /><span>{count} unresolved {count === 1 ? 'link' : 'links'}</span></li>)}</Queue>
    <Queue title="Recorded conflicts" description="Explicit author-recorded references, not an automatic contradiction finding. Open the source and its Knowledge panel to navigate resolved references." empty="No explicit conflicts recorded.">{data.conflicts.map(({ note, reference }) => <li key={note.path}><NoteLink note={note} onOpenNote={onOpenNote} /><span>Conflicts with: {reference}</span></li>)}</Queue>
    <Queue title="Missing sources" description="Agent notes without an explicit source or provenance statement." empty="No agent notes missing source evidence.">{data.missingSources.map(note => <li key={note.path}><NoteLink note={note} onOpenNote={onOpenNote} /></li>)}</Queue>
    <Queue title="Superseded findings" description="Informational: retired findings and explicit replacement relationships." empty="No superseded findings or replacement records.">{data.superseded.map(({ note, reference }) => <li key={note.path}><NoteLink note={note} onOpenNote={onOpenNote} /><span>{reference ? `Supersedes: ${reference}` : 'Marked superseded; retained for provenance.'}</span></li>)}</Queue>
    <Queue title="Possible title overlaps" description="Same normalized title in a workspace; inspect each note's Knowledge panel for semantic suggestions. Neither establishes duplication or conflict." empty="No title overlaps found.">{data.possibleOverlaps.map(group => <li key={group.notes.map(note => note.path).join('|')}><strong>{group.title}</strong>{group.notes.map(note => <NoteLink key={note.path} note={note} onOpenNote={onOpenNote} />)}</li>)}</Queue>
  </div><p>To suggest a correction to an owner note, an agent can create a proposal for human review. Suggestions do not change the owner note or approve themselves.</p></>}</section>;
}

export function NoteKnowledge({ note, onOpenNote }) {
  const [open, setOpen] = useState(false), [data, setData] = useState(null), [error, setError] = useState('');
  useEffect(() => { setOpen(false); setData(null); setError(''); }, [note.path]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setData(null); setError('');
    get('/api/note-knowledge?path=' + encodeURIComponent(note.path)).then(value => { if (active) setData(value); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [open, note.path, note.revision]);
  const suggestions = data ? [...data.overlaps, ...(data.related || []).filter(item => !data.overlaps.some(overlap => overlap.note.path === item.note.path))] : [];
  return <section className="knowledge-view" aria-label="Note knowledge">
    <button type="button" className="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide knowledge' : 'Inspect knowledge'}</button>
    {open && <div className="knowledge-card">
      <p>Recorded links, shared terms and semantic matches are evidence to inspect, not proof of agreement, conflict or duplication. Owner and reviewed notes retain their existing authority.</p>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p>Loading knowledge...</p>}
      {data && <>
        {data.currentRevision !== note.revision && <p role="alert">This note changed since it was opened. Reload it before relying on these relationships.</p>}
        {data.warnings.map((warning, index) => <p role="alert" key={index}>{warning}</p>)}
        <h2>Replacement timeline</h2>
        {data.timeline.length ? <ul className="knowledge-list">{data.timeline.map((item, index) => <li key={index}><NoteLink note={item.note} onOpenNote={onOpenNote} /><span>Last updated: <time dateTime={item.note.updated} title={item.note.updated}>{new Date(item.note.updated).toLocaleString()}</time> | {item.sourcePath} replaces {item.targetPath} | Reference: {item.reference}</span></li>)}</ul> : <p>No resolved replacement relationships.</p>}
        <h2>Recorded conflicts</h2>
        {data.conflicts.length ? <ul className="knowledge-list">{data.conflicts.map((item, index) => <li key={index}><NoteLink note={item.note} onOpenNote={onOpenNote} /><span>Reference: {item.reference}</span></li>)}</ul> : <p>No resolved conflict references.</p>}
        <h2>Related notes and possible overlaps</h2>
        {data.semantic?.reason && <p role="status">Semantic search: {data.semantic.reason}</p>}
        {suggestions.length ? <ul className="knowledge-list">{suggestions.map(item => <li key={item.note.path}><NoteLink note={item.note} onOpenNote={onOpenNote} /><span>{(item.reasons || [item.reason]).filter(Boolean).join('; ')}</span></li>)}</ul> : <p>No related notes or shared-term overlaps found.</p>}
      </>}
    </div>}
  </section>;
}
