import { useEffect, useRef, useState } from 'react';
import './NoteHistory.css';

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Could not load note history.');
    error.status = response.status;
    throw error;
  }
  return data;
}

export default function NoteHistory({ note, onRestored }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [reload, setReload] = useState(0);
  const identity = useRef({ path: note.path, revision: note.revision, generation: 0 });
  const mounted = useRef(true);
  if (identity.current.path !== note.path || identity.current.revision !== note.revision) {
    identity.current = { path: note.path, revision: note.revision, generation: identity.current.generation + 1 };
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    setHistory(null); setPreview(null); setError(''); setLoading(false); setRestoring(false);
  }, [note.path, note.revision]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    request(`/api/note-history?path=${encodeURIComponent(note.path)}&offset=0&limit=30`, { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setHistory(data); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, note.path, note.revision, reload]);

  const more = async () => {
    const generation = identity.current.generation;
    const current = () => mounted.current && identity.current.generation === generation;
    setLoading(true); setError('');
    try {
      const data = await request(`/api/note-history?path=${encodeURIComponent(note.path)}&offset=${history.items.length}&limit=30`);
      if (!current()) return;
      if (data.currentRevision !== history.currentRevision) throw new Error('The current note changed. Reopen history to refresh the list.');
      setHistory({ ...data, items: [...history.items, ...data.items] });
    } catch (err) { if (current()) setError(err.message); }
    finally { if (current()) setLoading(false); }
  };

  const showRevision = async id => {
    const generation = identity.current.generation;
    const current = () => mounted.current && identity.current.generation === generation;
    setLoading(true); setError('');
    try {
      const result = await request(`/api/note-history-revision?path=${encodeURIComponent(note.path)}&id=${encodeURIComponent(id)}`);
      if (current()) setPreview(result);
    } catch (err) { if (current()) setError(err.message); }
    finally { if (current()) setLoading(false); }
  };

  const restore = async () => {
    if (!preview || restoring || preview.currentRevision !== note.revision) return;
    if (!window.confirm('Restore this archived version? The current note will be archived first. Restoring bytes identical to a previously approved revision may regain its existing review status; the review ledger itself is unchanged.')) return;
    const generation = identity.current.generation;
    const current = () => mounted.current && identity.current.generation === generation;
    setRestoring(true); setError('');
    try {
      const session = await request('/api/editor-session');
      if (!current()) return;
      if (!session.token) throw new Error('Could not start a secure editor session.');
      const result = await request('/api/note-history/restore', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shared-Brain-CSRF': session.token },
        body: JSON.stringify({ path: note.path, id: preview.id, expectedRevision: note.revision }),
      });
      if (!current()) return;
      setPreview(null); setReload(value => value + 1);
      onRestored(result);
    } catch (err) {
      if (current()) setError(err.status === 409 ? 'The note changed since it was opened. Your history preview is retained; refresh the note before restoring.' : err.message);
    } finally { if (current()) setRestoring(false); }
  };

  return <section className="note-history" aria-label="Revision history">
    <button type="button" className="history-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>Revision history {open ? '−' : '+'}</button>
    {open && <div className="history-body">
      <p>Archived versions are separate from the reviewed diff. Changes made outside Axiom may not be archived.</p>
      {error && <p className="history-error" role="alert">{error} <button type="button" onClick={() => setReload(value => value + 1)}>Refresh history</button></p>}
      {loading && <p role="status">Loading history...</p>}
      {history && <>
        {!history.items.length && <p>No archived versions are available.</p>}
        <ul className="history-list">{history.items.map(item => <li key={item.id}><button type="button" disabled={loading || restoring} aria-pressed={preview?.id === item.id} onClick={() => showRevision(item.id)}>{new Date(item.savedAt).toLocaleString()} <span>{item.bytes.toLocaleString()} bytes{item.integrity === 'legacy' ? ' · legacy, unverified' : ''}</span></button></li>)}</ul>
        {history.hasMore && <button type="button" disabled={loading || restoring} onClick={more}>Load more</button>}
      </>}
      {preview && <div className="history-preview">
        <h3>Archived version compared with current</h3>
        <p>Minus lines belong to the archived version; plus lines belong to the current note.</p>
        <p>Restoring bytes identical to a previously approved revision may regain its existing review status. The review ledger itself is unchanged.</p>
        {preview.integrity === 'legacy' && <p className="history-error" role="status">This older archive has no independent checksum, so its integrity cannot be verified.</p>}
        {preview.currentRevision !== note.revision && <p className="history-error" role="alert">The current note changed since it was opened. Refresh the note before restoring.</p>}
        <pre className="history-diff">{preview.changes.length ? preview.changes.map((change, index) => <span key={index} className={`history-${change.type}`}>{change.type === 'added' ? '+' : change.type === 'removed' ? '-' : ' '}{change.text}{'\n'}</span>) : 'No differences.'}</pre>
        <details><summary>View archived Markdown</summary><pre className="history-source">{preview.content}</pre></details>
        <button type="button" disabled={restoring || loading || preview.currentRevision !== note.revision} onClick={restore}>{restoring ? 'Restoring...' : 'Restore this version'}</button>
      </div>}
    </div>}
  </section>;
}
