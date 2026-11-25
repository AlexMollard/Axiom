import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Pencil, Trash2 } from 'lucide-react';
import { apiMutate } from './desktop-bridge.mjs';
import { showToast } from './Toast.jsx';
import DiffViewer from './DiffViewer.jsx';
import './ReviewInbox.css';

const labels = { new: 'New', changed: 'Changed', reopened: 'Reopened', reviewed: 'Reviewed' };
const noteCache = new Map();

function rememberNote(key, value) {
  if (noteCache.has(key)) noteCache.delete(key);
  noteCache.set(key, value);
  if (noteCache.size > 24) {
    noteCache.delete(noteCache.keys().next().value);
  }
}

export function ReviewInbox({
  notes,
  groups,
  filters,
  onFiltersChange,
  onOpenNote,
  onEditNote,
  onNotesReviewed,
  onDeleteNote,
}) {
  const { workspace, kind } = filters;
  const [limit, setLimit] = useState(48);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [selectedPaths, setSelectedPaths] = useState(() => new Set());
  const [activePath, setActivePath] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState('');
  const prefetchRef = useRef(new Set());

  const changeFilters = next => {
    setLimit(48);
    onFiltersChange(next);
  };

  const pending = useMemo(
    () => notes.filter(note => note.owner === 'agent' && note.reviewStatus === 'unreviewed' && !['archived', 'superseded'].includes((note.status || '').toLowerCase())),
    [notes],
  );
  const groupIds = useMemo(() => new Set(groups.map(g => g.id)), [groups]);
  const scope = useCallback(note => (['global', 'personal'].includes(note.project) || groupIds.has(note.project) ? note.project : '__unmapped'), [groupIds]);

  const workspaceCounts = useMemo(() => {
    const counts = new Map();
    for (const note of pending) {
      if (kind !== 'all' && (note.reviewKind || 'new') !== kind) continue;
      const ws = scope(note);
      counts.set(ws, (counts.get(ws) || 0) + 1);
    }
    return counts;
  }, [pending, kind, scope]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = pending.filter(note => {
      if (workspace !== 'all' && scope(note) !== workspace) return false;
      if (kind !== 'all' && (note.reviewKind || 'new') !== kind) return false;
      if (term && !`${note.title} ${note.path} ${note.excerpt || ''}`.toLowerCase().includes(term)) return false;
      return true;
    });
    if (sortBy === 'oldest') {
      return [...list].sort((a, b) => (a.updated || '').localeCompare(b.updated || '') || a.path.localeCompare(b.path));
    }
    if (sortBy === 'title') {
      return [...list].sort((a, b) => a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
    }
    return list;
  }, [pending, workspace, kind, search, sortBy, scope]);

  const ids = useMemo(() => {
    const unique = [...new Set([...groups.map(g => g.id), ...(workspace === 'all' ? [] : [workspace])])];
    const nameOf = id => groups.find(g => g.id === id)?.name || (id === 'global' ? 'General' : id === 'personal' ? 'Personal' : id);
    const rankOf = id => {
      const g = groups.find(item => item.id === id);
      return g?.id === 'personal' || g?.group === 'personal' ? 0 : g?.group === 'home' ? 2 : 1;
    };
    return unique.sort((a, b) => {
      const rankDiff = rankOf(a) - rankOf(b);
      const countDiff = (workspaceCounts.get(b) || 0) - (workspaceCounts.get(a) || 0);
      return rankDiff || countDiff || nameOf(a).localeCompare(nameOf(b));
    });
  }, [groups, workspace, workspaceCounts]);

  const label = id => groups.find(g => g.id === id)?.name || (id === 'global' ? 'General' : id === 'personal' ? 'Personal' : id);

  useEffect(() => {
    if (!visible.length) {
      setActivePath('');
      return;
    }
    if (!activePath || !visible.some(n => n.path === activePath)) {
      setActivePath(visible[0].path);
    }
  }, [visible, activePath]);

  const activeNote = useMemo(() => visible.find(n => n.path === activePath) || null, [visible, activePath]);

  useEffect(() => {
    if (!activeNote) {
      setPreview(null);
      setPreviewError('');
      setPreviewLoading(false);
      return undefined;
    }
    const cacheKey = `${activeNote.path}:${activeNote.revision}`;
    const cached = noteCache.get(cacheKey);
    if (cached) {
      setPreview(cached);
      setPreviewError('');
      setPreviewLoading(false);
    } else {
      setPreviewLoading(true);
      setPreviewError('');
    }
    const controller = new AbortController();
    fetch('/api/note?path=' + encodeURIComponent(activeNote.path), { signal: controller.signal })
      .then(async res => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Unable to load note.');
        return body;
      })
      .then(body => {
        if (controller.signal.aborted) return;
        rememberNote(`${body.note.path}:${body.note.revision}`, body);
        setPreview(body);
        setPreviewError('');
        setPreviewLoading(false);
      })
      .catch(err => {
        if (!controller.signal.aborted && !cached) {
          setPreviewError(err.message || 'Could not load note preview.');
          setPreviewLoading(false);
        }
      });

    const idx = visible.findIndex(n => n.path === activeNote.path);
    const nextNote = idx >= 0 ? visible[idx + 1] : null;
    if (nextNote) {
      const nextKey = `${nextNote.path}:${nextNote.revision}`;
      if (!noteCache.has(nextKey) && !prefetchRef.current.has(nextKey)) {
        prefetchRef.current.add(nextKey);
        fetch('/api/note?path=' + encodeURIComponent(nextNote.path))
          .then(r => (r.ok ? r.json() : null))
          .then(body => { if (body?.note) rememberNote(`${body.note.path}:${body.note.revision}`, body); })
          .catch(() => {})
          .finally(() => prefetchRef.current.delete(nextKey));
      }
    }
    return () => controller.abort();
  }, [activeNote, visible]);

  const toggleSelected = useCallback(path => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const visibleSlice = useMemo(() => visible.slice(0, limit), [visible, limit]);
  const selectedNotes = useMemo(() => pending.filter(n => selectedPaths.has(n.path)), [pending, selectedPaths]);

  const runBatchReview = useCallback(async (items, decision, { advanceFrom = '' } = {}) => {
    if (!items.length || batchBusy) return;
    setBatchBusy(true);
    setBatchError('');
    try {
      const payload = items.map(n => ({ path: n.path, expectedRevision: n.revision }));
      const result = await apiMutate('/api/note-reviews/batch', {
        method: 'PUT',
        body: { items: payload, decision },
      });
      if (result.updated?.length) {
        onNotesReviewed?.(result.updated);
        const approvedSet = new Set(result.updated.map(n => n.path));
        setSelectedPaths(prev => {
          const next = new Set(prev);
          for (const p of approvedSet) next.delete(p);
          return next;
        });
        if (advanceFrom && approvedSet.has(advanceFrom)) {
          const idx = visible.findIndex(n => n.path === advanceFrom);
          const nextCandidate = visible.slice(idx + 1).find(n => !approvedSet.has(n.path)) || visible.find(n => !approvedSet.has(n.path));
          setActivePath(nextCandidate?.path || '');
        }
        if (decision === 'reviewed') {
          const undoItems = result.updated.map(n => ({ path: n.path, expectedRevision: n.revision }));
          showToast({
            message: result.updated.length === 1
              ? `Approved ${result.updated[0].title}`
              : `Approved ${result.updated.length} notes`,
            actionLabel: 'Undo',
            onAction: () => {
              apiMutate('/api/note-reviews/batch', {
                method: 'PUT',
                body: { items: undoItems, decision: 'unreviewed' },
              })
                .then(undoRes => {
                  if (undoRes.updated?.length) onNotesReviewed?.(undoRes.updated);
                })
                .catch(e => showToast({ message: e.message || 'Undo failed.', tone: 'error' }));
            },
          });
        }
      }
      if (result.conflicts?.length) {
        setBatchError(`${result.conflicts.length} note(s) changed on disk and were skipped. Refresh to inspect.`);
      }
    } catch (e) {
      setBatchError(e.message || 'Could not update selected notes.');
    } finally {
      setBatchBusy(false);
    }
  }, [batchBusy, onNotesReviewed, visible]);

  useEffect(() => {
    const onKeyDown = event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      const el = document.activeElement;
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return;
      if (!visible.length) return;
      const k = event.key.toLowerCase();
      const idx = visible.findIndex(n => n.path === activePath);
      if (k === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        const next = visible[(idx + 1 + visible.length) % visible.length];
        if (next) setActivePath(next.path);
      } else if (k === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        const prev = visible[(idx - 1 + visible.length) % visible.length];
        if (prev) setActivePath(prev.path);
      } else if (event.key === ' ' && activeNote) {
        event.preventDefault();
        toggleSelected(activeNote.path);
      } else if (k === 'a' && activeNote) {
        event.preventDefault();
        runBatchReview([activeNote], 'reviewed', { advanceFrom: activeNote.path });
      } else if (k === 'e' && activeNote && onEditNote) {
        event.preventDefault();
        onEditNote(activeNote.path);
      } else if (event.key === 'Enter' && activeNote && el?.tagName !== 'BUTTON' && el?.tagName !== 'A') {
        event.preventDefault();
        onOpenNote(activeNote.path);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, activePath, activeNote, toggleSelected, runBatchReview, onEditNote, onOpenNote]);

  const selectAllVisible = () => {
    const slicePaths = visibleSlice.map(n => n.path);
    const allChecked = slicePaths.length > 0 && slicePaths.every(p => selectedPaths.has(p));
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (allChecked) slicePaths.forEach(p => next.delete(p));
      else slicePaths.forEach(p => next.add(p));
      return next;
    });
  };

  return (
    <section className="review-inbox" aria-label="Review inbox">
      <div className="review-filters">
        <label>
          Search
          <input
            type="search"
            value={search}
            placeholder="Filter title, path, excerpt..."
            onChange={event => { setSearch(event.target.value); setLimit(48); }}
          />
        </label>
        <label>
          Workspace
          <select value={workspace} onChange={event => changeFilters({ ...filters, workspace: event.target.value })}>
            <option value="all">All workspaces ({pending.length})</option>
            {ids.map(id => (
              <option key={id} value={id}>
                {label(id)} ({workspaceCounts.get(id) || 0})
              </option>
            ))}
          </select>
        </label>
        <label>
          State
          <select value={kind} onChange={event => changeFilters({ ...filters, kind: event.target.value })}>
            <option value="all">All pending</option>
            <option value="new">New</option>
            <option value="changed">Changed</option>
            <option value="reopened">Reopened</option>
          </select>
        </label>
        <label>
          Sort
          <select value={sortBy} onChange={event => setSortBy(event.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title A-Z</option>
          </select>
        </label>
      </div>

      {visible.length > 0 && (
        <div className="review-batch-bar">
          <div className="review-batch-left">
            <button type="button" className="button" onClick={selectAllVisible}>
              {visibleSlice.length > 0 && visibleSlice.every(n => selectedPaths.has(n.path)) ? 'Clear visible' : `Select visible (${visibleSlice.length})`}
            </button>
            {selectedNotes.length > 0 && (
              <>
                <button
                  type="button"
                  className="button button-primary"
                  disabled={batchBusy}
                  onClick={() => runBatchReview(selectedNotes.slice(0, 200), 'reviewed')}
                >
                  <Check size={15} aria-hidden="true" />
                  {batchBusy ? 'Approving...' : `Approve selected (${Math.min(selectedNotes.length, 200)})`}
                </button>
                <button type="button" className="button" onClick={() => setSelectedPaths(new Set())}>Clear selection</button>
              </>
            )}
          </div>
          <span className="review-triage-hints">J/K step · Space select · A approve · E edit · Enter open</span>
        </div>
      )}

      {batchError && <p className="review-error" role="alert">{batchError}</p>}

      {!visible.length ? (
        <p className="review-empty">No notes match these review filters.</p>
      ) : (
        <div className="review-triage-split">
          <div className="review-triage-rail">
            <ul className="review-list" role="listbox" aria-label="Pending review notes">
              {visibleSlice.map(note => {
                const isActive = note.path === activePath;
                const isChecked = selectedPaths.has(note.path);
                return (
                  <li key={note.path} className={isActive ? 'review-item-active' : undefined}>
                    <label className="review-check" aria-label={`Select ${note.title}`}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleSelected(note.path)}
                      />
                    </label>
                    <button
                      type="button"
                      className="review-row-btn"
                      aria-selected={isActive}
                      onClick={() => setActivePath(note.path)}
                      onDoubleClick={() => onOpenNote(note.path)}
                    >
                      <span>
                        <strong>{note.title}</strong>
                        <small>{note.path}</small>
                        {note.excerpt && <small className="review-row-excerpt">{note.excerpt}</small>}
                      </span>
                      <span className="review-list-meta">
                        <span className="badge">{labels[note.reviewKind] || 'New'}</span>
                        <small>{label(scope(note))}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {visible.length > limit && (
              <button type="button" className="load-more" onClick={() => setLimit(value => value + 48)}>
                Show more · {visible.length - limit} remaining
              </button>
            )}
          </div>

          <aside className="review-triage-preview panel" aria-label="Selected note preview">
            {activeNote ? (
              <>
                <header className="review-preview-head">
                  <div>
                    <p className="eyebrow">{label(scope(activeNote))} · {labels[activeNote.reviewKind] || 'New'}</p>
                    <h2>{activeNote.title}</h2>
                    <small className="review-preview-path">{activeNote.path}</small>
                  </div>
                  <div className="review-preview-actions">
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={batchBusy}
                      onClick={() => runBatchReview([activeNote], 'reviewed', { advanceFrom: activeNote.path })}
                    >
                      <Check size={15} aria-hidden="true" /> Approve &amp; Next (A)
                    </button>
                    {onEditNote && (
                      <button type="button" className="button" onClick={() => onEditNote(activeNote.path)}>
                        <Pencil size={14} aria-hidden="true" /> Edit (E)
                      </button>
                    )}
                    <button type="button" className="button button-soft" onClick={() => onOpenNote(activeNote.path)}>
                      Open full <ArrowRight size={14} aria-hidden="true" />
                    </button>
                    {onDeleteNote && !activeNote.deleteBlockedReason && (
                      <button type="button" className="button danger-button" onClick={() => onDeleteNote(activeNote)}>
                        <Trash2 size={14} aria-hidden="true" /> Trash
                      </button>
                    )}
                  </div>
                </header>
                {activeNote.reviewKind === 'changed' && (
                  <ReviewDiff path={activeNote.path} revision={activeNote.revision} />
                )}
                {previewLoading && !preview ? (
                  <p className="muted">Loading preview...</p>
                ) : previewError ? (
                  <p className="review-error" role="alert">{previewError}</p>
                ) : preview?.html ? (
                  <article className="markdown review-preview-body" dangerouslySetInnerHTML={{ __html: preview.html }} />
                ) : null}
              </>
            ) : (
              <p className="review-empty">Select a note to inspect before approving.</p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

export function ReviewDiff({ path, revision }) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true });
    fetch(`/api/review-diff?path=${encodeURIComponent(path)}`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load review diff.');
        setState({ data });
      })
      .catch(error => {
        if (error.name !== 'AbortError') setState({ error: error.message });
      });
    return () => controller.abort();
  }, [path, revision]);
  return (
    <section id="axiom-review-comparison" tabIndex="-1" className="review-diff panel" aria-label="Changes since review">
      <h2>Changes since review</h2>
      <p><a href="#axiom-current-note">Jump to rendered note</a></p>
      {state.loading ? (
        <p>Loading comparison…</p>
      ) : state.error ? (
        <p role="alert">{state.error}</p>
      ) : state.data.currentRevision !== revision ? (
        <p role="alert">This note changed while you were viewing it. Refresh before comparing or reviewing.</p>
      ) : !state.data.available ? (
        <p>{state.data.reason}</p>
      ) : (
        <>
          <p className="review-diff-caption">
            Compared with the revision reviewed {state.data.reviewedAt ? new Date(state.data.reviewedAt).toLocaleString() : 'previously'}.
          </p>
          <DiffViewer changes={state.data.changes} emptyText="No textual changes recorded." />
        </>
      )}
    </section>
  );
}
