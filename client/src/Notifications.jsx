import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, X, ArrowUpRight } from 'lucide-react';
import { initialNotifications, parseNotifications, reconcileNotifications, unreadNotifications, acknowledgeNotifications } from './notification-state.mjs';
import { getDesktopPrefs, isDesktop, notifyNative, readBucketState, setTrayState, writeBucketState } from './desktop-bridge.mjs';
import { subscribeVaultEvents } from './live-sync.mjs';
import './Notifications.css';

export default function Notifications({ catalog, groups, pendingCount, onCatalog, onOpenNote, onOpenReview }) {
  const [record, setRecord] = useState(null);
  const [storageIssue, setStorageIssue] = useState('');
  const [pollIssue, setPollIssue] = useState('');
  const [sseConnected, setSseConnected] = useState(false);
  const dialog = useRef(null);
  const current = useRef(catalog);
  const retryPoll = useRef(() => {});
  const sseConnectedRef = useRef(false);
  const notifiedRevisions = useRef(new Set());
  const hydratedVault = useRef(null);
  current.current = catalog;
  const key = catalog?.vaultId ? `axiom-notifications:${catalog.vaultId}` : null;

  const persist = useCallback(state => {
    setRecord({ key, state });
    writeBucketState('notifications', key, JSON.stringify(state), value => {
      localStorage.setItem(key, value);
    })
      .then(() => setStorageIssue(''))
      .catch(() => setStorageIssue('Notification history could not be saved. Dismissals may not survive a reload.'));
  }, [key]);

  useEffect(() => {
    if (!key) return;
    let active = true;
    hydratedVault.current = null;
    readBucketState('notifications', key, () => localStorage.getItem(key)).then(raw => {
      if (!active) return;
      const saved = parseNotifications(raw);
      if (saved) {
        setRecord({ key, state: saved });
      } else {
        const init = initialNotifications(current.current?.notes || []);
        persist(init);
        if (raw !== null) setStorageIssue('Notification history was reset. All pending notes remain in the review queue.');
      }
      hydratedVault.current = key;
      const initialUnread = unreadNotifications(saved || initialNotifications(current.current?.notes || []), current.current?.notes || []);
      for (const n of initialUnread) notifiedRevisions.current.add(`${n.path}:${n.revision}`);
    }).catch(() => {
      if (active) persist(initialNotifications(current.current?.notes || []));
    });

    const changed = event => {
      if (event.key === key) {
        setRecord({ key, state: parseNotifications(event.newValue) || initialNotifications(current.current?.notes || []) });
      }
    };
    window.addEventListener('storage', changed);
    return () => {
      active = false;
      window.removeEventListener('storage', changed);
    };
  }, [key, persist]);

  useEffect(() => {
    if (!catalog || record?.key !== key) return;
    const next = reconcileNotifications(record.state, catalog.notes);
    if (next !== record.state) persist(next);
  }, [catalog, record, key, persist]);

  useEffect(() => {
    let stopped = false;
    let running = false;
    let controller = null;
    const check = async ({ force = false } = {}) => {
      if ((!force && document.hidden) || running || !current.current) return;
      const before = current.current;
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch('/api/catalog', { signal: controller.signal, cache: 'no-store' });
        const next = await response.json();
        if (!response.ok) throw new Error(next.error || 'Could not check for new notes.');
        if (!stopped) {
          setPollIssue('');
          if (current.current === before) onCatalog(next);
        }
      } catch (error) {
        if (!stopped && error.name !== 'AbortError') setPollIssue('Live note updates are unavailable.');
      } finally {
        running = false;
      }
    };
    retryPoll.current = () => check({ force: true });

    const unsubscribe = subscribeVaultEvents({
      onStatus: status => {
        sseConnectedRef.current = status === 'connected';
        if (!stopped) setSseConnected(status === 'connected');
      },
    });

    const interval = setInterval(() => {
      if (!sseConnectedRef.current) check();
    }, 15000);
    const onWake = () => { if (!sseConnectedRef.current) check(); };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      stopped = true;
      retryPoll.current = () => {};
      unsubscribe();
      clearInterval(interval);
      controller?.abort();
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [onCatalog]);

  const state = record?.key === key ? record.state : null;
  const unread = unreadNotifications(state, catalog?.notes || []);

  useEffect(() => {
    if (!isDesktop() || !state) return;
    setTrayState(pendingCount, unread.length).catch(() => {});
  }, [pendingCount, unread.length, state]);

  useEffect(() => {
    if (!isDesktop() || !state || hydratedVault.current !== key) return;
    const fresh = unread.filter(n => !notifiedRevisions.current.has(`${n.path}:${n.revision}`));
    if (!fresh.length) return;
    for (const n of fresh) notifiedRevisions.current.add(`${n.path}:${n.revision}`);
    getDesktopPrefs().then(prefs => {
      if (!prefs?.toastNotifications) return;
      const muted = new Set(prefs.mutedWorkspaces || []);
      const audible = fresh.filter(n => !muted.has(n.project));
      if (!audible.length) return;
      if (audible.length === 1) {
        const n = audible[0];
        const verb = n.reviewKind === 'changed' ? 'Updated agent note' : 'New agent note';
        notifyNative(verb, `${n.title} (${n.path})`).catch(() => {});
      } else {
        notifyNative('Axiom review queue', `${audible.length} new or updated agent notes need review.`).catch(() => {});
      }
    }).catch(() => {});
  }, [unread, state, key]);

  const markSeen = notes => {
    let latest = state;
    try { latest = parseNotifications(localStorage.getItem(key)) || state; } catch { /* Session state still works when storage is unavailable. */ }
    persist(acknowledgeNotifications(reconcileNotifications(latest, catalog.notes), notes));
  };

  const open = note => {
    if (onOpenNote(note.path) === false) return;
    markSeen([note]);
    dialog.current.close();
  };

  const workspace = note => groups.find(group => group.id === note.project)?.name || (note.project === 'global' ? 'General' : note.project === 'personal' ? 'Personal' : 'Unmapped notes');
  const kind = note => note.reviewKind === 'changed' ? 'Changed since review' : state?.seen[note.path] ? 'Updated note' : 'New note';

  return (
    <>
      <button className="icon-button notification-trigger" type="button" disabled={!state} aria-label={`Notifications, ${unread.length} unread`} title="New notes and changes needing review" aria-haspopup="dialog" onClick={() => dialog.current.showModal()}>
        <Bell size={18} aria-hidden="true" />
        {unread.length > 0 && <span className="notification-badge" aria-hidden="true">{unread.length > 99 ? '99+' : unread.length}</span>}
      </button>
      <span className="sr-only" role="status" aria-live="polite">{unread.length ? `${unread.length} new or changed notes need review.` : ''}</span>
      <dialog ref={dialog} className="notifications-dialog" aria-labelledby="notifications-title" onClick={event => { if (event.target !== dialog.current) return; const r = dialog.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.current.close(); }}>
        <header className="notifications-heading"><div><h2 id="notifications-title">Notifications</h2><p>New notes and changes needing your review</p></div><button type="button" className="icon-button" aria-label="Close notifications" onClick={() => dialog.current.close()}><X size={18} /></button></header>
        {storageIssue && <p className="notification-issue" role="status">{storageIssue}</p>}
        {pollIssue && <div className="notification-issue" role="status">{pollIssue} <button type="button" onClick={() => retryPoll.current()}>Retry live updates</button></div>}
        <div className="notification-actions"><span>{unread.length} unread</span><button type="button" disabled={!unread.length} onClick={() => markSeen(unread)}>Mark all seen</button></div>
        <div className="notification-list">{unread.length ? unread.slice(0, 50).map(note => <article key={note.path}><button type="button" className="notification-note" onClick={() => open(note)}><span className="notification-kind">{kind(note)} · {workspace(note)}</span><strong>{note.title}</strong><small>{new Date(note.updated).toLocaleString()}</small><span className="notification-review">Review note <ArrowUpRight size={14} aria-hidden="true" /></span></button><button type="button" className="notification-dismiss" aria-label={`Dismiss notification for ${note.title}`} onClick={() => markSeen([note])}>Dismiss</button></article>) : <p className="notification-empty">No new notifications. Existing unreviewed notes are still in your review queue.</p>}</div>
        <footer><button type="button" className="button button-soft" onClick={() => { if (onOpenReview() !== false) dialog.current.close(); }}>Review queue · {pendingCount}</button><p>{unread.length > 50 ? 'Showing the latest 50. ' : ''}Seen is not reviewed. {sseConnected ? 'Live updates via vault stream.' : 'Updates check every 15 seconds while visible.'}</p></footer>
      </dialog>
    </>
  );
}
