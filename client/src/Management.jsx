import React, { useEffect, useRef, useState } from 'react';
import WorkspaceIcon from './WorkspaceIcon.jsx';

async function get(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function mutate(url, method, body) {
  const { token } = await get('/api/editor-session');
  if (!token) throw new Error('Could not start a secure session. Refresh and try again.');
  const response = await fetch(url, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Shared-Brain-CSRF': token }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function Dialog({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => { if (dialog.open) dialog.close(); }; }, []);
  return <dialog ref={ref} className="management-dialog" aria-labelledby="management-title" onCancel={e => { e.preventDefault(); onClose(); }}><div className="management-dialog-inner"><h2 id="management-title">{title}</h2>{children}</div></dialog>;
}
export function DeleteNote({ note, onClose, onDeleted }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function remove() {
    setBusy(true); setError('');
    try { await mutate('/api/note', 'DELETE', { path: note.path, expectedRevision: note.revision }); onDeleted(); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  return <Dialog title="Move note to Trash?" onClose={onClose}><p>Move <strong>{note.title}</strong> ({note.path}) to Trash? You can restore it later.</p>{error && <p className="management-error" role="alert">{error}</p>}<div className="management-actions"><button className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button danger-button" onClick={remove} disabled={busy}>{busy ? 'Moving…' : 'Move to Trash'}</button></div></Dialog>;
}
export function WorkspaceSettings({ id, onClose, onChanged, onDeleted }) {
  const [detail, setDetail] = useState(null), [name, setName] = useState(''), [icon, setIcon] = useState(''), [group, setGroup] = useState('work');
  const [query, setQuery] = useState(''), [icons, setIcons] = useState([]), [total, setTotal] = useState(0), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false), [typed, setTyped] = useState('');
  useEffect(() => { let active = true; get('/api/workspace?id=' + encodeURIComponent(id)).then(d => { if (active) { setDetail(d); setName(d.name); setIcon(d.icon || ''); setGroup(d.group); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [id]);
  useEffect(() => { let active = true; get('/api/workspace-icons?q=' + encodeURIComponent(query) + '&limit=24').then(d => { if (active) { setIcons(d.candidates); setTotal(d.total); } }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [query]);
  async function save(e) {
    e.preventDefault(); setBusy(true); setError('');
    try { await mutate('/api/workspace', 'PUT', { id, name, icon, group, expectedRevision: detail.revision }); onChanged(); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError('');
    try { await mutate('/api/workspace', 'DELETE', { id, expectedRevision: detail.revision }); onDeleted(); }
    catch (e) { setError(e.message); setBusy(false); }
  }
  return <Dialog title="Workspace settings" onClose={onClose}>{!detail ? <p>{error || 'Loading workspace…'}</p> : <><form onSubmit={save} className="management-form"><label>Display name<input value={name} onChange={e => setName(e.target.value)} required /></label><label>Group<select value={group} onChange={e => setGroup(e.target.value)}><option value="work">Work</option><option value="home">Home</option></select></label><fieldset><legend>Workspace icon</legend><p>Selected: <WorkspaceIcon name={icon} /> {icon || 'None'}</p><label>Search available Lucide icons<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label><div className="icon-picker" role="group" aria-label="Available icons">{icons.map(candidate => <button type="button" key={candidate} aria-pressed={icon === candidate} onClick={() => setIcon(candidate)}><WorkspaceIcon name={candidate} />{candidate}</button>)}</div><small>{total > icons.length ? `Showing ${icons.length} of ${total}; search to narrow the list.` : `${total} available`}</small></fieldset>{error && <p className="management-error" role="alert">{error}</p>}<div className="management-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy || !name.trim() || !icon}>Save changes</button></div></form><div className="management-delete"><h3>Delete workspace</h3>{detail.deleteBlockedReason ? <p>{detail.deleteBlockedReason}</p> : confirm ? <><p>Move <strong>{detail.name}</strong> and its {detail.noteCount} {detail.noteCount === 1 ? 'note' : 'notes'} to Trash. Type the current workspace name to confirm.</p><label>Workspace name<input value={typed} onChange={e => setTyped(e.target.value)} /></label><div className="management-actions"><button className="button" onClick={() => setConfirm(false)} disabled={busy}>Cancel deletion</button><button className="button danger-button" disabled={busy || typed !== detail.name} onClick={remove}>{busy ? 'Moving…' : 'Move workspace to Trash'}</button></div></> : <button className="button danger-button" type="button" onClick={() => setConfirm(true)}>Delete workspace…</button>}</div></>}</Dialog>;
}
export function Trash({ onRestored }) {
  const [items, setItems] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const load = () => get('/api/trash').then(d => setItems(d.items)).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);
  async function restore(id) {
    setBusy(id); setError('');
    try { await mutate('/api/trash/restore', 'POST', { id }); await load(); onRestored(); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  return <><div className="page-heading"><div><p className="eyebrow">Library</p><h1>Trash</h1><p className="page-description">Restore deleted notes and workspaces. Existing files are never overwritten.</p></div></div>{error && <p className="management-error" role="alert">{error}</p>}<section className="panel trash-list" aria-label="Trash items">{!items ? <p className="empty">Loading Trash…</p> : !items.length ? <p className="empty">Trash is empty.</p> : items.map(item => <div className="trash-item" key={item.id}><div><strong>{item.name}</strong><small>{item.type === 'workspace' ? `Workspace · ${item.noteCount} ${item.noteCount === 1 ? 'note' : 'notes'}` : 'Note'} · Deleted {new Date(item.deletedAt).toLocaleString()}</small>{item.recovery && <small>{item.recovery === 'deleting' ? 'Move interrupted' : item.recovery === 'restoring' ? 'Restore interrupted' : 'Possible interrupted move'} · Resume restoration of verified unchanged copies; conflicts require reconciliation.</small>}</div><button className="button" disabled={!!busy} onClick={() => restore(item.id)}>{busy === item.id ? 'Restoring…' : item.recovery ? 'Resume restoration' : 'Restore'}</button></div>)}</section></>;
}
