import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Bell, X, ArrowUpRight} from 'lucide-react';
import {initialNotifications, parseNotifications, reconcileNotifications, unreadNotifications, acknowledgeNotifications} from './notification-state.mjs';
import './Notifications.css';

export default function Notifications({catalog, groups, pendingCount, onCatalog, onOpenNote, onOpenReview}) {
  const [record, setRecord] = useState(null), [storageIssue, setStorageIssue] = useState(''), [pollIssue, setPollIssue] = useState('');
  const dialog = useRef(null), current = useRef(catalog), retryPoll = useRef(() => {});
  current.current = catalog;
  const key = catalog?.vaultId ? `axiom-notifications:${catalog.vaultId}` : null;
  const persist = useCallback(state => {
    setRecord({key, state});
    try { localStorage.setItem(key, JSON.stringify(state)); setStorageIssue(''); }
    catch { setStorageIssue('Notification history cannot be saved in this browser. Dismissals may not survive a reload.'); }
  }, [key]);
  useEffect(() => {
    if (!key) return;
    try {
      const raw = localStorage.getItem(key), saved = parseNotifications(raw);
      if (saved) setRecord({key, state: saved});
      else {
        persist(initialNotifications(current.current.notes));
        if (raw !== null) setStorageIssue('Notification history was reset. All pending notes remain in the review queue.');
      }
    } catch { persist(initialNotifications(current.current.notes)); }
    const changed = event => {
      if (event.key === key) setRecord({key, state: parseNotifications(event.newValue) || initialNotifications(current.current.notes)});
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key, persist]);
  useEffect(() => {
    if (!catalog || record?.key !== key) return;
    const next = reconcileNotifications(record.state, catalog.notes);
    if (next !== record.state) persist(next);
  }, [catalog, record, key, persist]);
  useEffect(() => {
    let stopped = false, running = false, controller;
    const check = async () => {
      if (document.hidden || running || !current.current) return;
      const before = current.current;
      running = true; controller = new AbortController();
      try {
        const response = await fetch('/api/catalog', {signal: controller.signal, cache: 'no-store'});
        const next = await response.json();
        if (!response.ok) throw new Error(next.error || 'Could not check for new notes.');
        if (!stopped) { setPollIssue(''); if (current.current === before) onCatalog(next); }
      } catch (error) { if (!stopped && error.name !== 'AbortError') setPollIssue('Live note updates are unavailable.'); }
      finally { running = false; }
    };
    retryPoll.current = check;
    const interval = setInterval(check, 15000);
    document.addEventListener('visibilitychange', check); window.addEventListener('focus', check);
    return () => { stopped = true; retryPoll.current = () => {}; clearInterval(interval); controller?.abort(); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  }, [onCatalog]);
  const state = record?.key === key ? record.state : null;
  const unread = unreadNotifications(state, catalog?.notes || []);
  const markSeen = notes => {
    let latest = state;
    try { latest = parseNotifications(localStorage.getItem(key)) || state; } catch { /* Session state still works when storage is unavailable. */ }
    persist(acknowledgeNotifications(reconcileNotifications(latest, catalog.notes), notes));
  };
  const open = note => {
    if (onOpenNote(note.path) === false) return;
    markSeen([note]); dialog.current.close();
  };
  const workspace = note => groups.find(group => group.id === note.project)?.name || (note.project === 'global' ? 'General' : 'Unmapped notes');
  const kind = note => note.reviewKind === 'changed' ? 'Changed since review' : state?.seen[note.path] ? 'Updated note' : 'New note';
  return <>
    <button className="icon-button notification-trigger" type="button" disabled={!state} aria-label={`Notifications, ${unread.length} unread`} title="New notes and changes needing review" aria-haspopup="dialog" onClick={() => dialog.current.showModal()}><Bell size={18} aria-hidden="true" />{unread.length > 0 && <span className="notification-badge" aria-hidden="true">{unread.length > 99 ? '99+' : unread.length}</span>}</button>
    <span className="sr-only" role="status" aria-live="polite">{unread.length ? `${unread.length} new or changed notes need review.` : ''}</span>
    <dialog ref={dialog} className="notifications-dialog" aria-labelledby="notifications-title" onClick={event => { if (event.target !== dialog.current) return; const r = dialog.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.current.close(); }}>
      <header className="notifications-heading"><div><h2 id="notifications-title">Notifications</h2><p>New notes and changes needing your review</p></div><button type="button" className="icon-button" aria-label="Close notifications" onClick={() => dialog.current.close()}><X size={18} /></button></header>
      {storageIssue && <p className="notification-issue" role="status">{storageIssue}</p>}
      {pollIssue && <div className="notification-issue" role="status">{pollIssue} <button type="button" onClick={() => retryPoll.current()}>Retry live updates</button></div>}
      <div className="notification-actions"><span>{unread.length} unread</span><button type="button" disabled={!unread.length} onClick={() => markSeen(unread)}>Mark all seen</button></div>
      <div className="notification-list">{unread.length ? unread.slice(0, 50).map(note => <article key={note.path}><button type="button" className="notification-note" onClick={() => open(note)}><span className="notification-kind">{kind(note)} · {workspace(note)}</span><strong>{note.title}</strong><small>{new Date(note.updated).toLocaleString()}</small><span className="notification-review">Review note <ArrowUpRight size={14} aria-hidden="true" /></span></button><button type="button" className="notification-dismiss" aria-label={`Dismiss notification for ${note.title}`} onClick={() => markSeen([note])}>Dismiss</button></article>) : <p className="notification-empty">No new notifications. Existing unreviewed notes are still in your review queue.</p>}</div>
      <footer><button type="button" className="button button-soft" onClick={() => { if (onOpenReview() !== false) dialog.current.close(); }}>Review queue · {pendingCount}</button><p>{unread.length > 50 ? 'Showing the latest 50. ' : ''}Seen is not reviewed. Updates check every 15 seconds while this tab is visible.</p></footer>
    </dialog>
  </>;
}
