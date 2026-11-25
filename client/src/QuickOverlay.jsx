import React, { useEffect, useMemo, useRef, useState } from 'react';
import { apiMutate, focusMainRoute, hideQuickOverlay, listenDesktop } from './desktop-bridge.mjs';
import { registerWorkspaceIconNodes } from './WorkspaceIcon.jsx';
import './DesktopChrome.css';

const actions = [
  { title: 'Overview', url: '/' },
  { title: 'New note', url: '/?edit=1' },
  { title: 'Review queue', url: '/?view=review' },
  { title: 'All vaults graph', url: '/?project=__all&mode=graph' },
  { title: 'Clean up', url: '/?view=cleanup' },
  { title: 'Memory health', url: '/?view=health' },
  { title: 'Note usage', url: '/?view=usage' },
  { title: 'Workspaces', url: '/?view=projects' },
  { title: 'Trash', url: '/?view=trash' },
];

function filenameError(title) {
  if (!title.trim()) return 'Enter a filename for this note.';
  if (title.startsWith('.')) return 'Hidden filenames are not supported.';
  if (title.length > 120) return 'Filename must be 120 characters or fewer.';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(title)) return 'Filename cannot contain slashes or Windows reserved characters.';
  if (/[. ]$/.test(title)) return 'Filename cannot end in a dot or space.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) return 'That filename is reserved by Windows.';
  return '';
}

export default function QuickOverlay() {
  const [mode, setMode] = useState('jump');
  const [catalog, setCatalog] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [captureTarget, setCaptureTarget] = useState('new');
  const [captureWorkspace, setCaptureWorkspace] = useState('global');
  const [appendPath, setAppendPath] = useState('Home.md');
  const [filename, setFilename] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const searchInputRef = useRef(null);
  const filenameInputRef = useRef(null);
  const bodyRef = useRef(null);
  const modeRef = useRef(mode);
  const captureTargetRef = useRef(captureTarget);
  modeRef.current = mode;
  captureTargetRef.current = captureTarget;

  const loadCatalog = async () => {
    try {
      const resp = await fetch('/api/catalog', { cache: 'no-store' });
      if (resp.ok) {
        const nextCatalog = await resp.json();
        registerWorkspaceIconNodes(nextCatalog.workspaceIconNodes);
        setCatalog(nextCatalog);
      }
    } catch {}
  };

  useEffect(() => {
    loadCatalog();
    let unlisten = null;
    listenDesktop('axiom://quick-opened', () => {
      loadCatalog();
      setStatus('');
      requestAnimationFrame(() => {
        if (modeRef.current === 'jump') searchInputRef.current?.focus();
        else if (captureTargetRef.current === 'new') filenameInputRef.current?.focus();
        else bodyRef.current?.focus();
      });
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  const ownerNotes = useMemo(() => {
    const notes = (catalog?.notes || []).filter(n => n.owner === 'owner');
    return notes.sort((a, b) => (a.path === 'Home.md' ? -1 : b.path === 'Home.md' ? 1 : a.path.localeCompare(b.path)));
  }, [catalog]);

  useEffect(() => {
    if (ownerNotes.length && !ownerNotes.some(n => n.path === appendPath)) {
      setAppendPath(ownerNotes[0].path);
    }
  }, [ownerNotes, appendPath]);

  const entries = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = value => terms.every(term => value.toLowerCase().includes(term));
    const notes = catalog?.notes || [];
    const byPath = new Map(notes.map(n => [n.path, n]));
    const projects = catalog?.projects || [];
    const workspaces = [
      { id: 'personal', name: catalog?.workspaceNames?.personal || 'Personal' },
      { id: 'global', name: catalog?.workspaceNames?.global || 'General' },
      ...projects.filter(p => p.id !== 'global' && p.id !== 'personal').map(p => ({ id: p.id, name: catalog?.workspaceNames?.[p.id] || p.name || p.id })),
    ];

    let recentEntries = [];
    if (!terms.length && catalog?.vaultId) {
      try {
        const stored = JSON.parse(localStorage.getItem('axiom-recent-notes:' + catalog.vaultId) || '[]');
        if (Array.isArray(stored)) {
          recentEntries = stored
            .map(p => byPath.get(p))
            .filter(Boolean)
            .slice(0, 6)
            .map(n => ({ title: n.title, detail: n.path, kind: 'Recent', url: '/?note=' + encodeURIComponent(n.path), note: n }));
        }
      } catch {}
    }

    return [
      ...recentEntries,
      ...actions.filter(a => matches(a.title)).map(a => ({ ...a, kind: 'Action' })),
      ...workspaces.filter(w => matches(w.name)).map(w => ({ title: w.name, kind: 'Workspace', url: '/?project=' + encodeURIComponent(w.id) })),
      ...notes.filter(n => matches(`${n.title} ${n.path}`)).slice(0, 40).map(n => ({ title: n.title, detail: n.path, kind: 'Note', url: '/?note=' + encodeURIComponent(n.path), note: n })),
    ];
  }, [catalog, query]);

  useEffect(() => { setSelected(0); }, [query]);

  const choose = async item => {
    if (!item) return;
    await focusMainRoute(item.url);
    setQuery('');
    await hideQuickOverlay();
  };

  const captureWorkspaces = useMemo(() => {
    const projects = catalog?.projects || [];
    return [
      { id: 'personal', name: catalog?.workspaceNames?.personal || 'Personal' },
      { id: 'global', name: catalog?.workspaceNames?.global || 'General' },
      ...projects.filter(p => p.id !== 'global' && p.id !== 'personal').map(p => ({ id: p.id, name: catalog?.workspaceNames?.[p.id] || p.name || p.id })),
    ];
  }, [catalog]);

  const saveQuickNote = async () => {
    if (saving) return;
    setSaving(true);
    setStatus('');
    try {
      if (captureTarget === 'new') {
        const err = filenameError(filename);
        if (err) { setStatus(err); setSaving(false); return; }
        const path = `Owner/Notes/${filename.trim()}.md`;
        const rawBody = body.trim() ? body : `# ${filename.trim()}\n`;
        let content = rawBody;
        if (captureWorkspace && captureWorkspace !== 'global') {
          const normalized = rawBody.replace(/\r\n?/g, '\n');
          const fmMatch = /^---\n([\s\S]*?)\n---(\n|$)/.exec(normalized);
          if (fmMatch) {
            const lines = fmMatch[1].split('\n').filter(line => !/^project:\s*/i.test(line));
            lines.unshift(`project: ${captureWorkspace}`);
            content = `---\n${lines.join('\n')}\n---\n${normalized.slice(fmMatch[0].length)}`;
          } else {
            content = `---\nproject: ${captureWorkspace}\n---\n${normalized}`;
          }
        }
        const result = await apiMutate('/api/note', {
          method: 'PUT',
          body: { path, content, expectedRevision: 'new' },
        });
        setFilename('');
        setBody('');
        await focusMainRoute('/?note=' + encodeURIComponent(result.note.path));
        await hideQuickOverlay();
      } else {
        if (!body.trim()) { setStatus('Enter text to append.'); setSaving(false); return; }
        const currentResp = await fetch('/api/note?path=' + encodeURIComponent(appendPath), { cache: 'no-store' });
        const currentData = await currentResp.json();
        if (!currentResp.ok) throw new Error(currentData.error || 'Could not load target note.');
        const existing = currentData.note.content.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        const stamp = new Date().toLocaleString();
        const nextContent = `${existing}\n\n- **${stamp}**: ${body.trim()}\n`;
        const result = await apiMutate('/api/note', {
          method: 'PUT',
          body: { path: currentData.note.path, content: nextContent, expectedRevision: currentData.note.revision },
        });
        setBody('');
        await focusMainRoute('/?note=' + encodeURIComponent(result.note.path));
        await hideQuickOverlay();
      }
    } catch (e) {
      setStatus(e.message || 'Could not save quick note.');
    } finally {
      setSaving(false);
    }
  };

  const resultsRef = useRef(null);

  useEffect(() => {
    resultsRef.current?.querySelector(`[data-quick-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected, entries.length]);

  useEffect(() => {
    const onWindowKeyDown = async event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        await hideQuickOverlay();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '1') {
        event.preventDefault();
        setMode('jump');
        requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '2') {
        event.preventDefault();
        setMode('capture');
        requestAnimationFrame(() => (captureTarget === 'new' ? filenameInputRef.current : bodyRef.current)?.focus());
        return;
      }
      if (mode === 'jump') {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelected(i => (entries.length ? (i + 1) % entries.length : 0));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelected(i => (entries.length ? (i + entries.length - 1) % entries.length : 0));
        } else if (event.key === 'Enter' && document.activeElement?.closest('.quick-overlay-results, .quick-overlay-input')) {
          event.preventDefault();
          await choose(entries[selected]);
        }
      } else if (mode === 'capture' && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        await saveQuickNote();
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, [mode, entries, selected, captureTarget]);

  const activeItem = entries[selected];

  return (
    <div className="quick-overlay">
      <header className="quick-overlay-header" data-tauri-drag-region>
        <div className="quick-overlay-modes" role="group" aria-label="Quick overlay mode">
          <button type="button" aria-pressed={mode === 'jump'} onClick={() => setMode('jump')}>Quick jump</button>
          <button type="button" aria-pressed={mode === 'capture'} onClick={() => setMode('capture')}>Quick capture</button>
        </div>
        <button type="button" className="button" onClick={() => hideQuickOverlay()}>Esc</button>
      </header>
      <div className="quick-overlay-body">
        {mode === 'jump' ? (
          <>
            <input
              ref={searchInputRef}
              autoFocus
              role="combobox"
              aria-label="Jump to a note, workspace, or action"
              aria-expanded="true"
              aria-controls="quick-overlay-results"
              aria-activedescendant={activeItem ? `quick-option-${selected}` : undefined}
              className="quick-overlay-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Jump to a note, workspace, or action..."
            />
            <div className="quick-overlay-split">
              <div ref={resultsRef} id="quick-overlay-results" className="quick-overlay-results" role="listbox">
                {entries.map((item, idx) => (
                  <button
                    key={`${item.kind}:${item.url}:${idx}`}
                    id={`quick-option-${idx}`}
                    data-quick-index={idx}
                    type="button"
                    role="option"
                    aria-selected={idx === selected}
                    className={`quick-overlay-item${idx === selected ? ' selected' : ''}`}
                    onMouseEnter={() => setSelected(idx)}
                    onClick={() => choose(item)}
                  >
                    <span>
                      <strong>{item.title}</strong>
                      {item.detail && <small>{item.detail}</small>}
                    </span>
                    <small>{item.kind}</small>
                  </button>
                ))}
                {!entries.length && <p className="muted">No matching items.</p>}
              </div>
              <aside className="quick-overlay-preview" aria-live="polite">
                {activeItem?.note ? (
                  <>
                    <span className="badge">{activeItem.note.owner === 'owner' ? 'Owner' : activeItem.note.reviewStatus}</span>
                    <h3>{activeItem.note.title}</h3>
                    <span className="quick-overlay-preview-path">{activeItem.note.path}</span>
                    <small className="muted">Updated {new Date(activeItem.note.updated).toLocaleString()}</small>
                    <p className="quick-overlay-preview-excerpt">{activeItem.note.excerpt || 'No excerpt available.'}</p>
                  </>
                ) : activeItem ? (
                  <>
                    <span className="badge">{activeItem.kind}</span>
                    <h3>{activeItem.title}</h3>
                    <p className="muted">Press Enter to open in Axiom.</p>
                  </>
                ) : (
                  <p className="muted">Select a note or action to preview.</p>
                )}
              </aside>
            </div>
          </>
        ) : (
          <>
            <div className="quick-overlay-modes" role="group" aria-label="Capture destination">
              <button type="button" aria-pressed={captureTarget === 'new'} onClick={() => setCaptureTarget('new')}>New note</button>
              <button type="button" aria-pressed={captureTarget === 'append'} onClick={() => setCaptureTarget('append')}>Append to owner note</button>
            </div>
            {captureTarget === 'new' ? (
              <>
                <input
                  ref={filenameInputRef}
                  autoFocus
                  aria-label="New note filename"
                  className="quick-overlay-input"
                  value={filename}
                  onChange={e => setFilename(e.target.value)}
                  placeholder="Note filename (saved in Owner/Notes/<name>.md)"
                />
                <select aria-label="Workspace for new note" className="quick-overlay-select" value={captureWorkspace} onChange={e => setCaptureWorkspace(e.target.value)}>
                  {captureWorkspaces.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}
                </select>
              </>
            ) : (
              <select aria-label="Target owner note to append" className="quick-overlay-select" value={appendPath} onChange={e => setAppendPath(e.target.value)}>
                {ownerNotes.map(n => <option key={n.path} value={n.path}>{n.title} ({n.path})</option>)}
              </select>
            )}
            <textarea
              ref={bodyRef}
              aria-label={captureTarget === 'new' ? 'New note Markdown content' : 'Note entry to append'}
              className="quick-overlay-textarea"
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder={captureTarget === 'new' ? 'Write your note in Markdown...' : 'Note text to append with a timestamp...'}
            />
            {status && <p className="management-error" role="alert">{status}</p>}
            <div className="confirm-dialog-actions">
              <button type="button" className="button button-primary" disabled={saving} onClick={saveQuickNote}>
                {saving ? 'Saving...' : captureTarget === 'new' ? 'Save to Owner/Notes (Ctrl+Enter)' : 'Append entry (Ctrl+Enter)'}
              </button>
            </div>
          </>
        )}
      </div>
      <footer className="quick-overlay-footer">
        <span>Ctrl+1 Jump · Ctrl+2 Capture · Esc Hide</span>
        <span>Ctrl+Alt+K</span>
      </footer>
    </div>
  );
}
