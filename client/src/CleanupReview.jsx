import React, { useEffect, useRef, useState } from 'react';

export default function CleanupReview({ item, record, expanded, onExpand, onChange }) {
  const [checked, setChecked] = useState({});
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(null);
  useEffect(() => {
    if (!expanded) { request.current?.abort(); setChecked({}); setPreview(null); setLoading(false); }
    return () => request.current?.abort();
  }, [expanded]);
  async function inspect(note) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setPreview(null); setChecked(previous => ({ ...previous, [note.path]: false }));
    try {
      const response = await fetch('/api/note?path=' + encodeURIComponent(note.path), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Source unavailable');
      const matches = Boolean(note.revision && data.note?.revision === note.revision && typeof data.note?.content === 'string');
      if (controller.signal.aborted) return;
      setChecked(previous => ({ ...previous, [note.path]: matches }));
      setPreview({ path: note.path, note: data.note, html: typeof data.html === 'string' ? data.html : '', matches });
      if (!matches && record?.decision === 'approved') onChange({ decision: 'undecided' });
    } catch (error) {
      if (controller.signal.aborted) return;
      setChecked(previous => ({ ...previous, [note.path]: false }));
      setPreview({ path: note.path, error: error.message || 'Source unavailable' });
      if (record?.decision === 'approved') onChange({ decision: 'undecided' });
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }
  const ready = item.notes.length > 0 && item.notes.every(note => checked[note.path] === true);
  const decision = record?.decision || 'undecided';
  return <div className="cleanup-review">
    <div className="cleanup-review-head"><strong>Decision: {decision}</strong><button type="button" className="button" aria-expanded={expanded} onClick={onExpand}>{expanded ? 'Close review' : 'Review suggestion'}</button></div>
    {expanded && <div className="cleanup-review-body">
      <p className="cleanup-meta">Inspect every source at its scanned revision before approving. A missing or changed source requires a rescan. Only one source preview is held open at a time.</p>
      {item.notes.some(note => note.owner !== 'agent' || !note.path.startsWith('Agents/')) && <p className="cleanup-meta">This suggestion includes human-owned notes. Approval exports a proposal for human review, not permission for an agent to modify them.</p>}
      <div className="cleanup-source-buttons">{item.notes.map(note => <button type="button" className="button" key={note.path} onClick={() => inspect(note)} disabled={loading}>Inspect {note.title || note.path}{checked[note.path] === true ? ' ✓' : checked[note.path] === false ? ' — rescan needed' : ''}</button>)}</div>
      {loading && <p role="status">Loading source…</p>}
      {preview && <div className="cleanup-preview"><strong>{preview.path}</strong>{preview.error ? <p role="alert">Source unavailable: {preview.error}. Rescan before approving.</p> : <><p className="cleanup-meta">Current revision: {preview.note?.revision || 'unavailable'} · {preview.matches ? 'Matches scan' : 'Changed or unavailable — rescan before approving'}</p>{preview.matches && <><div className="markdown cleanup-rendered-preview" dangerouslySetInnerHTML={{ __html: preview.html }} /><details><summary>Markdown source</summary><pre>{preview.note.content}</pre></details></>}</>}</div>}
      <div className="cleanup-decision-buttons" role="group" aria-label="Suggestion decision">{[['approved', 'Approve'], ['rejected', 'Reject'], ['undecided', 'Undecided']].map(([value, label]) => <button key={value} type="button" className="button" aria-pressed={decision === value} disabled={value === 'approved' && (!ready || loading)} onClick={() => onChange({ decision: value })}>{label}</button>)}</div>
      {!ready && <p className="cleanup-meta">Approve is unavailable until every source is inspected and matches the scan.</p>}
      <label>Instructions for the agent (optional)<textarea value={record?.instructions || ''} onChange={event => onChange({ instructions: event.target.value })} /></label>
      {(item.category === 'merge' || item.category === 'duplicate') && <label>Preferred destination (optional)<select value={record?.targetPath || ''} onChange={event => onChange({ targetPath: event.target.value || null })}><option value="">Let the agent recommend a destination</option>{item.notes.map(note => <option key={note.path} value={note.path}>{note.title} · {note.path}</option>)}</select></label>}
    </div>}
  </div>;
}
