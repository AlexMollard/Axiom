import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { autocompletion } from '@codemirror/autocomplete';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { diffLines } from 'diff';
import { draftKey, readDraft, writeDraft, discardDraft } from './editor-drafts.mjs';
import { renderLocalMarkdown } from './markdown-preview.mjs';
import { useConfirm } from './ConfirmDialog.jsx';
import {
  apiMutate,
  deleteBucketState,
  isDesktop,
  openInObsidian,
  openInVscode,
  readBucketState,
  revealInExplorer,
  writeBucketState,
} from './desktop-bridge.mjs';
import './Editor.css';

const normalize = text => (text || '').replace(/\r\n?/g, '\n');

function filenameError(title) {
  if (!title.trim()) return 'Enter a filename for this note.';
  if (title.startsWith('.')) return 'Hidden filenames are not supported.';
  if (title.length > 120) return 'The filename must be 120 characters or fewer.';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(title)) return 'The filename cannot contain slashes or Windows reserved characters: < > : " / \\ | ? *.';
  if (/[. ]$/.test(title)) return 'The filename cannot end in a dot or space.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(title)) return 'That filename is reserved by Windows.';
  return '';
}

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--surface-inset)', color: 'var(--fg)', height: '100%' },
  '.cm-scroller': { fontFamily: '"JetBrains Mono Variable", monospace', lineHeight: '1.75', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--accent-bright)', padding: '18px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface-inset)', color: 'var(--faint)', border: 'none', paddingRight: '12px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-raised)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-hover)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent-bright)' },
}, { dark: true });

const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent-bright)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--fg)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--fg-secondary)' },
  { tag: [tags.link, tags.url], color: 'var(--accent-bright)', textDecoration: 'underline' },
  { tag: [tags.monospace, tags.list, tags.quote], color: 'var(--accent)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted)' },
]);

function wrapSelection(view, before, after = before, placeholder = 'text') {
  if (!view) return false;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const inner = selected || placeholder;
  view.dispatch({
    changes: { from, to, insert: `${before}${inner}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + inner.length },
  });
  view.focus();
  return true;
}

function toggleLinePrefix(view, prefix) {
  if (!view) return false;
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const changes = [];
  for (let ln = startLine.number; ln <= endLine.number; ln++) {
    const line = view.state.doc.line(ln);
    if (line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
    } else {
      changes.push({ from: line.from, to: line.from, insert: prefix });
    }
  }
  view.dispatch({ changes });
  view.focus();
  return true;
}

export default function MarkdownEditor({
  initialNote,
  notes = [],
  vaultName,
  vaultId,
  externalChanged = false,
  onSaved,
  onDirtyChange,
  onStatsChange,
  onCancel,
}) {
  const [note, setNote] = useState(initialNote);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(() => normalize(initialNote?.content));
  const [baseline, setBaseline] = useState(() => normalize(initialNote?.content));
  const [mode, setMode] = useState('split');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [syncScroll, setSyncScroll] = useState(true);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const busy = useRef(false);
  const previewBodyRef = useRef(null);
  const editorViewRef = useRef(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const { confirm, dialog } = useConfirm();

  const storageKey = useMemo(() => draftKey(vaultId, initialNote?.path || '\0new-note'), [vaultId, initialNote?.path]);
  const [stored, setStored] = useState(() => {
    try {
      if (!storageKey) return { error: 'Local draft storage is unavailable without a vault identifier.' };
      return { draft: readDraft(window.localStorage, storageKey) };
    } catch (err) { return { error: err.message || 'Could not read local draft storage.' }; }
  });
  const [storageError, setStorageError] = useState('');
  const [latestComparison, setLatestComparison] = useState(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const openMenuRef = useRef(null);
  const copyTimer = useRef(null);
  const suppressDraftFlush = useRef(false);

  useEffect(() => {
    if (!openMenuOpen) return;
    const onDown = e => {
      if (openMenuRef.current && !openMenuRef.current.contains(e.target)) setOpenMenuOpen(false);
    };
    const onKey = e => {
      if (e.key === 'Escape') setOpenMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenuOpen]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const hadDirtyDraft = useRef(false);
  const dirty = content !== baseline || (!note && title !== '');
  const dirtyRef = useRef(dirty);
  const path = note?.path || `Owner/Notes/${title}.md`;
  const latestDraft = useRef(null);
  latestDraft.current = { key: storageKey, eligible: dirty && !stored.draft && !stored.error, draft: { title, content, baseline, revision: note?.revision || 'new' } };

  useEffect(() => {
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    onStatsChange?.({
      words,
      chars: content.length,
      line: cursorPos.line,
      col: cursorPos.col,
      revision: note?.revision || '',
    });
  }, [content, cursorPos, note?.revision, onStatsChange]);

  useEffect(() => {
    if (!isDesktop() || !storageKey) return;
    let active = true;
    readBucketState('drafts', storageKey, () => null).then(raw => {
      if (!active || !raw || dirtyRef.current) return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1 && typeof parsed.content === 'string') {
          setStored({ draft: parsed });
        }
      } catch {}
    }).catch(() => {});
    return () => { active = false; };
  }, [storageKey]);

  const extensions = useMemo(() => {
    const nonce = document.querySelector('meta[name="style-nonce"]')?.content;
    const wikilinkSource = context => {
      const match = context.matchBefore(/\[\[[^\[\]\r\n]*$/);
      if (!match) return null;
      const query = match.text.slice(2).toLowerCase();
      const candidates = notesRef.current
        .filter(n => n.title.toLowerCase().includes(query) || n.path.toLowerCase().includes(query))
        .slice(0, 25)
        .map(n => {
          const withoutExt = n.path.replace(/\.md$/i, '');
          const insert = `[[${withoutExt}|${n.title}]]`;
          return {
            label: n.title,
            detail: n.path,
            apply: (view, _completion, from, to) => {
              const after = view.state.sliceDoc(to, to + 2);
              const replaceTo = after === ']]' ? to + 2 : to;
              view.dispatch({
                changes: { from, to: replaceTo, insert },
                selection: { anchor: from + insert.length },
              });
            },
          };
        });
      return { from: match.from, options: candidates, filter: false };
    };

    return [
      markdown(),
      syntaxHighlighting(markdownHighlight),
      editorTheme,
      EditorView.lineWrapping,
      autocompletion({ override: [wikilinkSource], activateOnTyping: true }),
      keymap.of([
        {
          key: 'Mod-b',
          run: view => wrapSelection(view, '**', '**', 'bold'),
        },
        {
          key: 'Mod-i',
          run: view => wrapSelection(view, '*', '*', 'italic'),
        },
      ]),
      EditorView.updateListener.of(update => {
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head;
          const line = update.state.doc.lineAt(pos);
          setCursorPos({ line: line.number, col: pos - line.from + 1 });
        }
      }),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown source' }),
      ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
    ];
  }, []);

  const reportDirty = useCallback(value => {
    if (dirtyRef.current !== value) {
      dirtyRef.current = value;
      onDirtyChange(value);
    }
  }, [onDirtyChange]);

  const persistDraftNow = useCallback((key, draft) => {
    if (!key) return;
    const payload = JSON.stringify({ version: 1, ...draft });
    writeBucketState('drafts', key, payload).catch(() => {});
    try {
      writeDraft(window.localStorage, key, draft);
      setStorageError('');
    } catch (err) {
      if (!isDesktop()) setStorageError(err.message || 'Could not store your local draft.');
    }
  }, []);

  const removeDraftNow = useCallback(key => {
    if (!key) return;
    deleteBucketState('drafts', key).catch(() => {});
    try {
      discardDraft(window.localStorage, key);
      setStorageError('');
    } catch (err) {
      if (!isDesktop()) setStorageError(err.message || 'Could not remove the local draft.');
    }
  }, []);

  useEffect(() => {
    if (stored.draft || stored.error) return;
    if (!dirty) {
      if (hadDirtyDraft.current) {
        removeDraftNow(storageKey);
        hadDirtyDraft.current = false;
      }
      return;
    }
    suppressDraftFlush.current = false;
    hadDirtyDraft.current = true;
    const timer = setTimeout(() => {
      if (suppressDraftFlush.current) return;
      persistDraftNow(storageKey, latestDraft.current.draft);
    }, 500);
    return () => clearTimeout(timer);
  }, [storageKey, stored, dirty, title, content, baseline, note?.revision, persistDraftNow, removeDraftNow]);

  const clearStored = () => {
    try {
      removeDraftNow(storageKey);
      setStored({});
      return true;
    } catch (err) {
      setStorageError(err.message || 'Could not discard the local draft.');
      return false;
    }
  };

  const recoverStored = async () => {
    const draft = stored.draft;
    if (!draft) return;
    if (dirty) {
      const ok = await confirm({
        title: 'Recover draft',
        message: 'Replace the current unsaved changes with the stored draft?',
        confirmLabel: 'Recover draft',
      });
      if (!ok) return;
    }
    const stale = draft.revision !== (note?.revision || 'new');
    setTitle(draft.title);
    setContent(normalize(draft.content));
    setBaseline(normalize(draft.baseline));
    if (note) setNote({ ...note, revision: draft.revision });
    setStored({});
    reportDirty(true);
    if (stale) {
      setConflict(note?.path || `Owner/Notes/${draft.title}.md`);
      setError('This draft was based on an older revision. Copy or diff your changes before reloading the latest note; saving is blocked to protect the current version.');
    }
  };

  const discardStored = async () => {
    const ok = await confirm({
      title: 'Discard draft',
      message: 'Discard the stored local draft? This cannot be undone.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (ok) clearStored();
  };

  useEffect(() => {
    const flush = () => {
      const current = latestDraft.current;
      if (!current?.eligible || suppressDraftFlush.current) return;
      persistDraftNow(current.key, current.draft);
    };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [storageKey, persistDraftNow]);

  const compareLatest = async () => {
    const targetPath = conflict || note?.path;
    if (!targetPath) return;
    try {
      const result = await responseJson(await fetch(`/api/note?path=${encodeURIComponent(targetPath)}`, { credentials: 'same-origin', cache: 'no-store' }));
      setLatestComparison(normalize(result.note.content));
    } catch (err) {
      setError(err.message || 'Could not load the latest note for comparison.');
    }
  };

  const showCopyStatus = msg => {
    setCopyStatus(msg);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopyStatus(''), 2000);
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(content);
      showCopyStatus('Draft copied to clipboard.');
    } catch {
      showCopyStatus('Could not copy automatically. Select and copy the Markdown source instead.');
    }
  };

  const copyWikilink = async () => {
    const linkTarget = note ? `[[${note.path.replace(/\.md$/i, '')}]]` : `[[Owner/Notes/${title}]]`;
    try {
      await navigator.clipboard.writeText(linkTarget);
      showCopyStatus(`Copied ${linkTarget}`);
    } catch {}
  };

  const renderedPreview = useMemo(() => {
    if (mode === 'edit' || !content.trim()) return '';
    return renderLocalMarkdown(content, path, notes);
  }, [content, mode, path, notes]);

  const conflictHunks = useMemo(() => {
    if (latestComparison === null) return [];
    const parts = diffLines(latestComparison, content);
    const lines = [];
    for (const part of parts) {
      const type = part.added ? 'added' : part.removed ? 'removed' : 'context';
      const rawLines = part.value.replace(/\n$/, '').split('\n');
      for (const line of rawLines) {
        lines.push({ type, text: line });
      }
    }
    return lines;
  }, [latestComparison, content]);

  const save = useCallback(async () => {
    if (busy.current || saving || conflict || stored.draft || stored.error) return;
    const invalid = !note && filenameError(title);
    if (invalid) { setError(invalid); return; }
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await apiMutate('/api/note', {
        method: 'PUT',
        body: { path, content, expectedRevision: note?.revision || 'new' },
      });
      suppressDraftFlush.current = true;
      hadDirtyDraft.current = false;
      removeDraftNow(storageKey);
      setNote(result.note);
      setContent(normalize(result.note.content));
      setBaseline(normalize(result.note.content));
      setConflict(false);
      setLatestComparison(null);
      reportDirty(false);
      onSaved(result.note, result.html);
    } catch (err) {
      setError(err.message || 'Could not save your note. Your draft is unchanged.');
      if (err.status === 409) setConflict(path);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [conflict, content, note, onSaved, path, removeDraftNow, reportDirty, saving, title, stored, storageKey]);

  useEffect(() => {
    const shortcut = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [save]);

  const reloadLatest = async () => {
    const targetPath = conflict || note?.path;
    if (busy.current || !targetPath) return;
    const ok = await confirm({
      title: 'Reload latest version',
      message: 'Discard your draft and load the latest version from disk?',
      confirmLabel: 'Reload latest',
      danger: true,
    });
    if (!ok) return;
    busy.current = true;
    setReloading(true);
    try {
      const result = await responseJson(await fetch(`/api/note?path=${encodeURIComponent(targetPath)}`, { credentials: 'same-origin', cache: 'no-store' }));
      suppressDraftFlush.current = true;
      hadDirtyDraft.current = false;
      if (!clearStored()) { suppressDraftFlush.current = false; hadDirtyDraft.current = true; return; }
      setNote(result.note);
      setContent(normalize(result.note.content));
      setBaseline(normalize(result.note.content));
      setConflict(false);
      setLatestComparison(null);
      setError('');
      reportDirty(false);
      if (!note) onSaved(result.note, result.html);
    } catch (err) {
      setError(err.message || 'Could not load the latest note. Your draft is unchanged.');
    } finally {
      busy.current = false;
      setReloading(false);
    }
  };

  useEffect(() => {
    if (!syncScroll || mode !== 'split') return;
    const scroller = editorViewRef.current?.scrollDOM;
    const previewEl = previewBodyRef.current;
    if (!scroller || !previewEl) return;
    const onScroll = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (max <= 0) return;
      const ratio = scroller.scrollTop / max;
      const pMax = previewEl.scrollHeight - previewEl.clientHeight;
      if (pMax > 0) previewEl.scrollTop = ratio * pMax;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [syncScroll, mode]);

  const locked = saving || reloading;
  const obsidian = note && `obsidian://open?vault=${encodeURIComponent(vaultName || '')}&file=${encodeURIComponent(note.path)}`;

  return (
    <section className="markdown-editor" aria-label="Markdown editor">
      {dialog}
      <header className="editor-heading">
        <div>
          <p className="editor-eyebrow">{note ? 'EDIT NOTE' : 'NEW NOTE'}</p>
          <h1>{note ? note.title : 'Create a note'}</h1>
          <p className="editor-path">{note ? note.path : 'Owner / Notes'}</p>
        </div>
        <div className="editor-actions">
          {note && (
            isDesktop() ? (
              <div className="action-menu" ref={openMenuRef}>
                <button
                  type="button"
                  className="editor-button"
                  aria-haspopup="menu"
                  aria-expanded={openMenuOpen}
                  onClick={() => setOpenMenuOpen(v => !v)}
                >
                  Open in <ChevronDown size={14} aria-hidden="true" />
                </button>
                {openMenuOpen && (
                  <div className="action-menu-popover" role="menu">
                    <button type="button" role="menuitem" onClick={() => { openInObsidian(note.path, vaultName); setOpenMenuOpen(false); }}>Obsidian</button>
                    <button type="button" role="menuitem" onClick={() => { openInVscode(note.path); setOpenMenuOpen(false); }}>VS Code</button>
                    <button type="button" role="menuitem" onClick={() => { revealInExplorer('note', note.path); setOpenMenuOpen(false); }}>Reveal in Explorer</button>
                    <button type="button" role="menuitem" onClick={() => { copyWikilink(); setOpenMenuOpen(false); }}>Copy wikilink</button>
                  </div>
                )}
              </div>
            ) : (
              obsidian && <a className="editor-button" href={obsidian}>Open in Obsidian</a>
            )
          )}
          <button className="editor-button" type="button" onClick={onCancel} disabled={locked}>{note && !dirty ? 'Done' : 'Cancel'}</button>
          <button className="editor-button editor-button-primary" type="button" onClick={save} disabled={locked || conflict || !dirty || !!stored.draft || !!stored.error}>{saving ? 'Saving…' : 'Save note'}</button>
        </div>
      </header>
      <p className="editor-ownership">{note?.owner === 'agent' ? 'Agent memory · editing this note does not turn it into owner policy.' : 'Your note · this is your authoring space. Agents remain restricted to their own notes.'}</p>
      {externalChanged && !conflict && (
        <div className="editor-alert" role="status">
          <span>This note changed on disk outside this editor. Compare or reload before saving to avoid a conflict.</span>
          <button type="button" onClick={compareLatest} disabled={locked}>Compare disk</button>
          <button type="button" onClick={reloadLatest} disabled={locked}>Reload latest</button>
        </div>
      )}
      {(stored.draft || stored.error) && (
        <div className="editor-alert" role="alert">
          <span>{stored.error || `A local draft is available${stored.draft.revision !== (note?.revision || 'new') ? ' from a different revision. Recovery will block saving until you reload the latest version.' : '.'} Recovering replaces the current editor contents; discarding removes only the local draft.`}</span>
          {stored.draft && <button type="button" onClick={recoverStored}>Recover draft</button>}
          <button type="button" onClick={discardStored}>Discard draft</button>
        </div>
      )}
      {storageError && <div className="editor-alert" role="alert"><span>Local draft storage: {storageError}</span></div>}
      {!note && (
        <div className="editor-filename">
          <label htmlFor="editor-filename">Filename</label>
          <div className="editor-filename-field">
            <input
              id="editor-filename"
              value={title}
              maxLength={120}
              disabled={locked}
              onChange={event => {
                const value = event.target.value;
                setTitle(value);
                if (conflict && value !== title) { setConflict(false); setError(''); }
                reportDirty(content !== baseline || value !== '');
              }}
              placeholder="Name your note"
              autoComplete="off"
            />
            <span>.md</span>
          </div>
          <p>Saved in Owner/Notes. The filename is used exactly as entered.</p>
        </div>
      )}
      <div className="editor-toolbar">
        <div className="editor-modes" role="group" aria-label="Editor view">
          {['edit', 'split', 'preview'].map(item => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
        </div>
        {mode === 'split' && (
          <label className="editor-sync-toggle">
            <input type="checkbox" checked={syncScroll} onChange={e => setSyncScroll(e.target.checked)} />
            <span>Sync scroll</span>
          </label>
        )}
        <span className="editor-status" role="status">{saving ? 'Saving…' : error ? 'Error' : dirty ? 'Unsaved changes' : note ? 'Saved' : 'New draft'} <span className="editor-shortcut">· Ctrl/⌘ S to save · Type [[ to link</span></span>
      </div>
      {mode !== 'preview' && (
        <div className="editor-format-bar" role="toolbar" aria-label="Markdown formatting">
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '# ')}>H1</button>
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '## ')}>H2</button>
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '### ')}>H3</button>
          <button type="button" className="editor-format-btn" title="Bold (Ctrl+B)" onClick={() => wrapSelection(editorViewRef.current, '**', '**', 'bold')}>Bold</button>
          <button type="button" className="editor-format-btn" title="Italic (Ctrl+I)" onClick={() => wrapSelection(editorViewRef.current, '*', '*', 'italic')}>Italic</button>
          <button type="button" className="editor-format-btn" onClick={() => wrapSelection(editorViewRef.current, '`', '`', 'code')}>Code</button>
          <button type="button" className="editor-format-btn" onClick={() => wrapSelection(editorViewRef.current, '```\n', '\n```', 'code')}>Block</button>
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '- ')}>List</button>
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '- [ ] ')}>Task</button>
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '> ')}>Quote</button>
          <button type="button" className="editor-format-btn" onClick={() => wrapSelection(editorViewRef.current, '[[', ']]', 'Note')}>[[Link]]</button>
        </div>
      )}
      {error && (
        <div className="editor-alert" role="alert">
          <span>{error}</span>
          {conflict && (
            <>
              <button type="button" onClick={compareLatest} disabled={locked}>Compare latest</button>
              <button type="button" onClick={copyDraft} disabled={locked}>Copy draft</button>
              <button type="button" onClick={reloadLatest} disabled={locked}>{reloading ? 'Loading…' : 'Reload latest'}</button>
            </>
          )}
        </div>
      )}
      {latestComparison !== null && (
        <section className="editor-comparison" aria-label="Draft and latest note comparison">
          <p>Line diff comparing latest on disk (-) against your current draft (+). Reloading discards your draft; copy it first if needed.</p>
          <pre className="editor-diff-lines">
            {conflictHunks.length ? conflictHunks.map((line, i) => (
              <span key={i} className={`editor-diff-${line.type}`}>
                {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}{line.text}
              </span>
            )) : 'No differences.'}
          </pre>
        </section>
      )}
      {copyStatus && <p className="muted" role="status">{copyStatus}</p>}
      <div className={`editor-workspace editor-workspace-${mode}`}>
        {mode !== 'preview' && (
          <div className="editor-pane editor-code" aria-label="Markdown source">
            <div className="editor-pane-label">Markdown</div>
            <CodeMirror
              value={content}
              onCreateEditor={view => { editorViewRef.current = view; }}
              onChange={value => {
                const next = normalize(value);
                setContent(next);
                reportDirty(next !== baseline || (!note && title !== ''));
              }}
              extensions={extensions}
              editable={!locked && !stored.draft && !stored.error}
              readOnly={locked || !!stored.draft || !!stored.error}
              theme="none"
              basicSetup={{ highlightActiveLine: true }}
            />
          </div>
        )}
        {mode !== 'edit' && (
          <div className="editor-pane editor-preview">
            <div className="editor-pane-label">Preview <span>· instant local render</span></div>
            <div ref={previewBodyRef} className="editor-preview-body">
              {!content.trim()
                ? <p className="editor-preview-empty">Your preview will appear here as you write.</p>
                : <article className="editor-rendered" onClick={e => { if (e.target.closest('a[href]')) { e.preventDefault(); e.stopPropagation(); } }} dangerouslySetInnerHTML={{ __html: renderedPreview }} />}
            </div>
          </div>
        )}
      </div>
      <p className="editor-footer">Changes are saved to the note only when you choose Save note. Unsaved changes are kept locally, including after Cancel.</p>
    </section>
  );
}
