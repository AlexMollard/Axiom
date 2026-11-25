import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { autocompletion } from '@codemirror/autocomplete';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { draftKey, readDraft, writeDraft, discardDraft } from './editor-drafts.mjs';
import { renderLocalMarkdown } from './markdown-preview.mjs';
import { publishEditorStats } from './editor-stats-store.mjs';
import { useConfirm } from './ConfirmDialog.jsx';
import OpenInMenu from './OpenInMenu.jsx';
import DiffViewer from './DiffViewer.jsx';
import {
  apiMutate,
  deleteBucketState,
  isDesktop,
  readBucketState,
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

function parseFrontmatterFields(text) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text || '');
  const fields = { project: '', status: '', kind: '', source: '' };
  if (!match) return { hasFm: false, fields };
  for (const line of match[1].split('\n')) {
    const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (key in fields) fields[key] = m[2].trim();
  }
  return { hasFm: true, fields };
}

function setFrontmatterField(text, key, value) {
  const clean = normalize(text);
  const trimmed = value.trim();
  const match = /^---\n([\s\S]*?)\n---(\n|$)/.exec(clean);
  if (!match) {
    if (!trimmed) return clean;
    return `---\n${key}: ${trimmed}\n---\n${clean}`;
  }
  const lines = match[1].split('\n');
  let replaced = false;
  const nextLines = [];
  for (const line of lines) {
    if (new RegExp(`^${key}:\\s*`).test(line)) {
      replaced = true;
      if (trimmed) nextLines.push(`${key}: ${trimmed}`);
    } else {
      nextLines.push(line);
    }
  }
  if (!replaced && trimmed) nextLines.push(`${key}: ${trimmed}`);
  const rest = clean.slice(match[0].length);
  if (!nextLines.length) return rest;
  return `---\n${nextLines.join('\n')}\n---\n${rest}`;
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
  groups = [],
  vaultName,
  vaultId,
  externalChanged = false,
  onSaved,
  onDirtyChange,
  onCancel,
  onOpenSplit,
}) {
  const [note, setNote] = useState(initialNote);
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('Owner/Notes');
  const [content, setContent] = useState(() => normalize(initialNote?.content));
  const [baseline, setBaseline] = useState(() => normalize(initialNote?.content));
  const [mode, setMode] = useState('split');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [syncScroll, setSyncScroll] = useState(true);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [relatedState, setRelatedState] = useState({ loading: false, items: [], error: '' });
  const busy = useRef(false);
  const previewBodyRef = useRef(null);
  const editorViewRef = useRef(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const cursorRef = useRef({ line: 1, col: 1 });
  const wordsRef = useRef(content.trim() ? content.trim().split(/\s+/).length : 0);
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
  const copyTimer = useRef(null);
  const suppressDraftFlush = useRef(false);
  const saveActionRef = useRef(null);

  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const hadDirtyDraft = useRef(false);
  const dirty = content !== baseline || (!note && title !== '');
  const dirtyRef = useRef(dirty);
  const path = note?.path || `${folder}/${title}.md`;
  const latestDraft = useRef(null);
  latestDraft.current = { key: storageKey, eligible: dirty && !stored.draft && !stored.error, draft: { title, content, baseline, revision: note?.revision || 'new' } };

  useEffect(() => {
    const handle = setTimeout(() => {
      wordsRef.current = content.trim() ? content.trim().split(/\s+/).length : 0;
      publishEditorStats({
        words: wordsRef.current,
        chars: content.length,
        line: cursorRef.current.line,
        col: cursorRef.current.col,
        revision: note?.revision || '',
      });
    }, 150);
    return () => clearTimeout(handle);
  }, [content, note?.revision]);

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
        { key: 'Mod-b', run: view => wrapSelection(view, '**', '**', 'bold') },
        { key: 'Mod-i', run: view => wrapSelection(view, '*', '*', 'italic') },
        { key: 'Mod-k', run: view => wrapSelection(view, '[', '](https://)', 'link text') },
        { key: 'Mod-Shift-s', run: () => { saveActionRef.current?.(true); return true; } },
      ]),
      EditorView.updateListener.of(update => {
        if (update.selectionSet || update.docChanged) {
          const pos = update.state.selection.main.head;
          const line = update.state.doc.lineAt(pos);
          cursorRef.current = { line: line.number, col: pos - line.from + 1 };
          publishEditorStats({
            words: wordsRef.current,
            chars: update.state.doc.length,
            line: cursorRef.current.line,
            col: cursorRef.current.col,
            revision: note?.revision || '',
          });
        }
      }),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown source' }),
      ...(nonce ? [EditorView.cspNonce.of(nonce)] : []),
    ];
  }, [note?.revision]);

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
      setConflict(note?.path || path);
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

  const deferredContent = useDeferredValue(content);
  const renderedPreview = useMemo(() => {
    if (mode === 'edit' || !deferredContent.trim()) return '';
    return renderLocalMarkdown(deferredContent, path, notes);
  }, [deferredContent, mode, path, notes]);

  const fm = useMemo(() => parseFrontmatterFields(content), [content]);

  const loadRelatedNotes = useCallback(async () => {
    setRelatedState(prev => ({ ...prev, loading: true, error: '' }));
    try {
      const res = await apiMutate('/api/capture-suggestions', {
        method: 'POST',
        body: {
          path,
          content,
          ...(fm.fields.project ? { workspace: fm.fields.project } : {}),
        },
      });
      setRelatedState({ loading: false, items: res.items || [], error: '' });
    } catch (err) {
      setRelatedState({ loading: false, items: [], error: err.message || 'Could not check related notes.' });
    }
  }, [path, content, fm.fields.project]);

  const save = useCallback(async (exitAfter = false) => {
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
      onSaved(result.note, result.html, exitAfter);
    } catch (err) {
      setError(err.message || 'Could not save your note. Your draft is unchanged.');
      if (err.status === 409) setConflict(path);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [conflict, content, note, onSaved, path, removeDraftNow, reportDirty, saving, title, stored, storageKey]);
  saveActionRef.current = save;

  useEffect(() => {
    const shortcut = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save(event.shiftKey);
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

  const updateFrontmatter = (key, value) => {
    const next = setFrontmatterField(content, key, value);
    setContent(next);
    reportDirty(next !== baseline || (!note && title !== ''));
  };

  const locked = saving || reloading;
  const folderOptions = [
    { value: 'Owner/Notes', label: 'Owner/Notes (Personal)' },
    { value: 'Owner', label: 'Owner (Root)' },
    { value: 'Agents/Memory', label: 'Agents/Memory (General)' },
    ...groups
      .filter(g => g.id !== 'global' && g.id !== '__unmapped')
      .map(g => ({ value: `Agents/Memory/Projects/${g.id}`, label: `Agents/Memory/Projects/${g.id}` })),
  ];

  return (
    <section className="markdown-editor" aria-label="Markdown editor">
      {dialog}
      <header className="editor-heading">
        <div>
          <p className="editor-eyebrow">{note ? 'EDIT NOTE' : 'NEW NOTE'}</p>
          <h1>{note ? note.title : 'Create a note'}</h1>
          <p className="editor-path">{note ? note.path : path}</p>
        </div>
        <div className="editor-actions">
          {note && (
            <OpenInMenu path={note.path} title={note.title} vaultName={vaultName} onOpenSplit={onOpenSplit} className="editor-button" />
          )}
          <button className="editor-button" type="button" onClick={onCancel} disabled={locked}>{note && !dirty ? 'Done' : 'Cancel'}</button>
          <button className="editor-button editor-button-primary" type="button" onClick={() => save(false)} disabled={locked || conflict || !dirty || !!stored.draft || !!stored.error}>{saving ? 'Saving…' : 'Save note'}</button>
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
          <div className="editor-filename-grid">
            <div>
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
            </div>
            <label className="editor-folder-label">
              Folder
              <select value={folder} disabled={locked} onChange={e => setFolder(e.target.value)}>
                {folderOptions.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </label>
          </div>
          <p>Saved in {folder}. The filename is used exactly as entered.</p>
        </div>
      )}
      <div className="editor-extras">
        <details className="editor-frontmatter">
          <summary>Frontmatter metadata {fm.hasFm ? '(present)' : '(none)'}</summary>
          <div className="editor-frontmatter-grid">
            <label>
              Project
              <input value={fm.fields.project} disabled={locked} placeholder="global" onChange={e => updateFrontmatter('project', e.target.value)} />
            </label>
            <label>
              Status
              <select value={fm.fields.status} disabled={locked} onChange={e => updateFrontmatter('status', e.target.value)}>
                <option value="">Unset</option>
                <option value="current">current</option>
                <option value="superseded">superseded</option>
                <option value="archived">archived</option>
                <option value="stale">stale</option>
              </select>
            </label>
            <label>
              Kind
              <select value={fm.fields.kind} disabled={locked} onChange={e => updateFrontmatter('kind', e.target.value)}>
                <option value="">Unset</option>
                <option value="note">note</option>
                <option value="decision">decision</option>
                <option value="proposal">proposal</option>
              </select>
            </label>
            <label>
              Source
              <input value={fm.fields.source} disabled={locked} placeholder="file path or URL" onChange={e => updateFrontmatter('source', e.target.value)} />
            </label>
          </div>
        </details>
        <details
          className="editor-related"
          open={relatedOpen}
          onToggle={e => {
            const nextOpen = e.currentTarget.open;
            setRelatedOpen(nextOpen);
            if (nextOpen && !relatedState.items.length && !relatedState.loading) loadRelatedNotes();
          }}
        >
          <summary>Related / overlapping notes</summary>
          <div className="editor-related-body">
            <button type="button" className="button" onClick={loadRelatedNotes} disabled={relatedState.loading || !content.trim()}>
              {relatedState.loading ? 'Checking...' : 'Check related notes'}
            </button>
            {relatedState.error && <p className="management-error" role="alert">{relatedState.error}</p>}
            {!relatedState.loading && !relatedState.items.length && <p className="muted">No strong overlap suggestions yet.</p>}
            {relatedState.items.length > 0 && (
              <ul className="editor-related-list">
                {relatedState.items.map(item => (
                  <li key={item.note.path}>
                    <div>
                      <strong>{item.note.title}</strong>
                      <small>{item.note.path} · {item.reasons.join(', ')}</small>
                    </div>
                    {onOpenSplit && (
                      <button type="button" className="button" onClick={() => onOpenSplit({ kind: 'note', path: item.note.path })}>
                        Open in split
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      </div>
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
        <span className="editor-status" role="status">{saving ? 'Saving…' : error ? 'Error' : dirty ? 'Unsaved changes' : note ? 'Saved' : 'New draft'} <span className="editor-shortcut">· Ctrl+S save · Ctrl+Shift+S save &amp; exit · [[ to link</span></span>
      </div>
      {mode !== 'preview' && (
        <div className="editor-format-bar" role="toolbar" aria-label="Markdown formatting">
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '# ')}>H1</button>
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '## ')}>H2</button>
          <button type="button" className="editor-format-btn" onClick={() => toggleLinePrefix(editorViewRef.current, '### ')}>H3</button>
          <button type="button" className="editor-format-btn" title="Bold (Ctrl+B)" onClick={() => wrapSelection(editorViewRef.current, '**', '**', 'bold')}>Bold</button>
          <button type="button" className="editor-format-btn" title="Italic (Ctrl+I)" onClick={() => wrapSelection(editorViewRef.current, '*', '*', 'italic')}>Italic</button>
          <button type="button" className="editor-format-btn" title="Link (Ctrl+K)" onClick={() => wrapSelection(editorViewRef.current, '[', '](https://)', 'link')}>Link</button>
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
          <DiffViewer beforeText={latestComparison} afterText={content} leftTitle="On disk" rightTitle="Your draft" allowSideBySide />
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
                : <article className="editor-rendered" onClick={e => {
                    const link = e.target.closest('a[href]');
                    if (!link) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const url = new URL(link.href, location.href);
                    if (url.origin === location.origin && url.pathname === '/' && url.searchParams.has('note') && onOpenSplit) {
                      onOpenSplit({ kind: 'note', path: url.searchParams.get('note') });
                    }
                  }} dangerouslySetInnerHTML={{ __html: renderedPreview }} />}
            </div>
          </div>
        )}
      </div>
      <p className="editor-footer">Changes are saved to the note only when you choose Save note. Unsaved changes are kept locally, including after Cancel.</p>
    </section>
  );
}
