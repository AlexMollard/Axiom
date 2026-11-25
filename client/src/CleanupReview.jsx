import React, { useEffect, useRef, useState } from 'react';
import DiffViewer from './DiffViewer.jsx';

export default function CleanupReview({ item, record, expanded, onExpand, onChange }) {
  const [checked, setChecked] = useState({});
  const [previews, setPreviews] = useState({});
  const [loadingPath, setLoadingPath] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const requests = useRef(new Map());

  useEffect(() => {
    if (!expanded) {
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
      setChecked({});
      setPreviews({});
      setLoadingPath('');
      setShowDiff(false);
    }
    return () => {
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
    };
  }, [expanded]);

  async function inspect(note) {
    const existing = requests.current.get(note.path);
    existing?.abort();
    const controller = new AbortController();
    requests.current.set(note.path, controller);
    setLoadingPath(note.path);
    setChecked(previous => ({ ...previous, [note.path]: false }));
    try {
      const response = await fetch('/api/note?path=' + encodeURIComponent(note.path), {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Source unavailable');
      const matches = Boolean(note.revision && data.note?.revision === note.revision && typeof data.note?.content === 'string');
      if (controller.signal.aborted) return;
      setChecked(previous => ({ ...previous, [note.path]: matches }));
      setPreviews(prev => ({
        ...prev,
        [note.path]: { path: note.path, title: note.title || note.path, note: data.note, html: typeof data.html === 'string' ? data.html : '', matches },
      }));
      if (!matches && record?.decision === 'approved') onChange({ decision: 'undecided' });
    } catch (error) {
      if (controller.signal.aborted) return;
      setChecked(previous => ({ ...previous, [note.path]: false }));
      setPreviews(prev => ({
        ...prev,
        [note.path]: { path: note.path, title: note.title || note.path, error: error.message || 'Source unavailable' },
      }));
      if (record?.decision === 'approved') onChange({ decision: 'undecided' });
    } finally {
      if (!controller.signal.aborted) {
        requests.current.delete(note.path);
        setLoadingPath(cur => (cur === note.path ? '' : cur));
      }
    }
  }

  async function inspectAll() {
    for (const note of item.notes) {
      if (!previews[note.path]?.matches) {
        await inspect(note);
      }
    }
  }

  const ready = item.notes.length > 0 && item.notes.every(note => checked[note.path] === true);
  const decision = record?.decision || 'undecided';
  const loadedList = item.notes.map(n => previews[n.path]).filter(Boolean);
  const diffPair = loadedList.length >= 2 && loadedList[0]?.note?.content !== undefined && loadedList[1]?.note?.content !== undefined
    ? [loadedList[0], loadedList[1]]
    : null;

  return (
    <div className="cleanup-review">
      <div className="cleanup-review-head">
        <strong>Decision: {decision}</strong>
        <button type="button" className="button" aria-expanded={expanded} onClick={onExpand}>
          {expanded ? 'Close review' : 'Review suggestion'}
        </button>
      </div>
      {expanded && (
        <div className="cleanup-review-body">
          <p className="cleanup-meta">
            Inspect every source at its scanned revision before approving. Compare multiple inspected notes side by side or toggle a line diff.
          </p>
          {item.notes.some(note => note.owner !== 'agent' || !note.path.startsWith('Agents/')) && (
            <p className="cleanup-meta">
              This suggestion includes human-owned notes. Approval exports a proposal for human review, not permission for an agent to modify them.
            </p>
          )}
          <div className="cleanup-source-buttons">
            {item.notes.length > 1 && (
              <button type="button" className="button button-soft" onClick={inspectAll} disabled={Boolean(loadingPath)}>
                Inspect all sources
              </button>
            )}
            {item.notes.map(note => (
              <button type="button" className="button" key={note.path} onClick={() => inspect(note)} disabled={loadingPath === note.path}>
                Inspect {note.title || note.path}{checked[note.path] === true ? ' ✓' : checked[note.path] === false ? ' - rescan needed' : ''}
              </button>
            ))}
            {diffPair && (
              <button type="button" className="button" aria-pressed={showDiff} onClick={() => setShowDiff(v => !v)}>
                {showDiff ? 'Hide source diff' : 'Compare diff'}
              </button>
            )}
          </div>
          {loadingPath && <p role="status">Loading {loadingPath}…</p>}
          {showDiff && diffPair && (
            <div className="cleanup-compare">
              <DiffViewer
                beforeText={diffPair[0].note.content}
                afterText={diffPair[1].note.content}
                leftTitle={diffPair[0].title}
                rightTitle={diffPair[1].title}
                allowSideBySide
                defaultSideBySide
              />
            </div>
          )}
          {loadedList.length > 0 && (
            <div className={loadedList.length > 1 ? 'cleanup-previews-grid' : undefined}>
              {loadedList.map(preview => (
                <div className="cleanup-preview" key={preview.path}>
                  <strong>{preview.path}</strong>
                  {preview.error ? (
                    <p role="alert">Source unavailable: {preview.error}. Rescan before approving.</p>
                  ) : (
                    <>
                      <p className="cleanup-meta">
                        Current revision: {preview.note?.revision || 'unavailable'} · {preview.matches ? 'Matches scan' : 'Changed or unavailable - rescan before approving'}
                      </p>
                      {preview.matches && (
                        <>
                          <div className="markdown cleanup-rendered-preview" dangerouslySetInnerHTML={{ __html: preview.html }} />
                          <details>
                            <summary>Markdown source</summary>
                            <pre>{preview.note.content}</pre>
                          </details>
                        </>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="cleanup-decision-buttons" role="group" aria-label="Suggestion decision">
            {[['approved', 'Approve'], ['rejected', 'Reject'], ['undecided', 'Undecided']].map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="button"
                aria-pressed={decision === value}
                disabled={value === 'approved' && (!ready || Boolean(loadingPath))}
                onClick={() => onChange({ decision: value })}
              >
                {label}
              </button>
            ))}
          </div>
          {!ready && <p className="cleanup-meta">Approve is unavailable until every source is inspected and matches the scan.</p>}
          <label>
            Instructions for the agent (optional)
            <textarea value={record?.instructions || ''} onChange={event => onChange({ instructions: event.target.value })} />
          </label>
          {(item.category === 'merge' || item.category === 'duplicate') && (
            <label>
              Preferred destination (optional)
              <select value={record?.targetPath || ''} onChange={event => onChange({ targetPath: event.target.value || null })}>
                <option value="">Let the agent recommend a destination</option>
                {item.notes.map(note => (
                  <option key={note.path} value={note.path}>{note.title} · {note.path}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
