import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import './Editor.css';

const normalize = (text) => (text || '').replace(/\r\n?/g, '\n');

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
  { tag: tags.emphasis, color: 'var(--fg-secondary)', fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--accent-bright)', textDecoration: 'underline' },
  { tag: [tags.monospace, tags.list, tags.quote], color: 'var(--accent)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted)' },
]);

export default function MarkdownEditor({ initialNote, vaultName, onSaved, onDirtyChange, onCancel }) {
  const [note, setNote] = useState(initialNote);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState(() => normalize(initialNote?.content));
  const [baseline, setBaseline] = useState(() => normalize(initialNote?.content));
  const [mode, setMode] = useState('split');
  const [token, setToken] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const busy = useRef(false);
  const dirty = content !== baseline || (!note && title !== '');
  const dirtyRef = useRef(dirty);
  const path = note?.path || `Owner/Notes/${title}.md`;
  const extensions = useMemo(() => {
    const nonce = document.querySelector('meta[name="style-nonce"]')?.content;
    return [markdown(), syntaxHighlighting(markdownHighlight), editorTheme, EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': 'Markdown source' }), ...(nonce ? [EditorView.cspNonce.of(nonce)] : [])];
  }, []);

  const reportDirty = useCallback((value) => {
    if (dirtyRef.current !== value) {
      dirtyRef.current = value;
      onDirtyChange(value);
    }
  }, [onDirtyChange]);

  const connect = useCallback(async () => {
    try {
      const data = await responseJson(await fetch('/api/editor-session', { credentials: 'same-origin', cache: 'no-store' }));
      if (!data.token) throw new Error('The editor session did not return a token.');
      setToken(data.token);
      setSessionError('');
    } catch (err) {
      setToken('');
      setSessionError(err.message || 'Could not connect to the editor session.');
    }
  }, []);

  useEffect(() => { connect(); }, [connect]);

  useEffect(() => {
    if (mode === 'edit' || !token || !content.trim()) {
      setPreview('');
      setPreviewError('');
      setPreviewLoading(false);
      return;
    }
    const controller = new AbortController();
    setPreviewLoading(true);
    setPreview('');
    setPreviewError('');
    const timer = setTimeout(async () => {
      try {
        const result = await responseJson(await fetch('/api/preview', {
          method: 'POST', credentials: 'same-origin', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Shared-Brain-CSRF': token },
          body: JSON.stringify({ path, content }),
        }));
        if (!controller.signal.aborted) setPreview(result.html);
      } catch (err) {
        if (!controller.signal.aborted) setPreviewError(err.message || 'Preview unavailable.');
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false);
      }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [content, mode, path, token]);

  const save = useCallback(async () => {
    if (busy.current || saving || conflict) return;
    const invalid = !note && filenameError(title);
    if (invalid) { setError(invalid); return; }
    if (!token) { setSessionError('Connect to the editor session before saving.'); return; }
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await responseJson(await fetch('/api/note', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Shared-Brain-CSRF': token },
        body: JSON.stringify({ path, content, expectedRevision: note?.revision || 'new' }),
      }));
      setNote(result.note);
      setContent(normalize(result.note.content));
      setBaseline(normalize(result.note.content));
      setConflict(false);
      reportDirty(false);
      onSaved(result.note, result.html);
    } catch (err) {
      setError(err.message || 'Could not save your note. Your draft is unchanged.');
      if (err.status === 409) setConflict(path);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [conflict, content, note, onSaved, path, reportDirty, saving, title, token]);

  useEffect(() => {
    const shortcut = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [save]);

  const reloadLatest = async () => {
    if (busy.current || !window.confirm('Discard your draft and load the latest version from disk?')) return;
    busy.current = true;
    setReloading(true);
    try {
      const result = await responseJson(await fetch(`/api/note?path=${encodeURIComponent(conflict)}`, { credentials: 'same-origin', cache: 'no-store' }));
      setNote(result.note);
      setContent(normalize(result.note.content));
      setBaseline(normalize(result.note.content));
      setConflict(false);
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

  const locked = saving || reloading;
  const obsidian = note && `obsidian://open?vault=${encodeURIComponent(vaultName || '')}&file=${encodeURIComponent(note.path)}`;
  return (
    <section className="markdown-editor" aria-label="Markdown editor">
      <header className="editor-heading">
        <div>
          <p className="editor-eyebrow">{note ? 'EDIT NOTE' : 'NEW NOTE'}</p>
          <h1>{note ? note.title : 'Create a note'}</h1>
          <p className="editor-path">{note ? note.path : 'Owner / Notes'}</p>
        </div>
        <div className="editor-actions">
          {obsidian && <a className="editor-button" href={obsidian}>Open in Obsidian</a>}
          <button className="editor-button" type="button" onClick={onCancel} disabled={locked}>Cancel</button>
          <button className="editor-button editor-button-primary" type="button" onClick={save} disabled={locked || conflict}>{saving ? 'Saving…' : 'Save note'}</button>
        </div>
      </header>
      <p className="editor-ownership">{note?.owner === 'agent' ? 'Agent memory · editing this note does not turn it into owner policy.' : 'Your note · this is your authoring space. Agents remain restricted to their own notes.'}</p>
      {!note && <div className="editor-filename"><label htmlFor="editor-filename">Filename</label><div className="editor-filename-field"><input id="editor-filename" value={title} maxLength={120} disabled={locked} onChange={(event) => { const value = event.target.value; setTitle(value); if (conflict && value !== title) { setConflict(false); setError(''); } reportDirty(content !== baseline || value !== ''); }} placeholder="Name your note" autoComplete="off" /><span>.md</span></div><p>Saved in Owner/Notes. The filename is used exactly as entered.</p></div>}
      <div className="editor-toolbar">
        <div className="editor-modes" role="group" aria-label="Editor view">
          {['edit', 'split', 'preview'].map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
        </div>
        <span className="editor-status" role="status">{saving ? 'Saving…' : error || sessionError ? 'Error' : dirty ? 'Unsaved changes' : note ? 'Saved' : 'New draft'} <span className="editor-shortcut">· Ctrl/⌘ S to save</span></span>
      </div>
      {(error || sessionError) && <div className="editor-alert" role="alert"><span>{error || sessionError}</span>{conflict && <button type="button" onClick={reloadLatest} disabled={locked}>{reloading ? 'Loading…' : 'Reload latest'}</button>}<button type="button" onClick={connect} disabled={locked}>Reconnect session</button></div>}
      <div className={`editor-workspace editor-workspace-${mode}`}>
        {mode !== 'preview' && <div className="editor-pane editor-code" aria-label="Markdown source"><div className="editor-pane-label">Markdown</div><CodeMirror value={content} onChange={(value) => { const next = normalize(value); setContent(next); reportDirty(next !== baseline || (!note && title !== '')); }} extensions={extensions} editable={!locked} readOnly={locked} theme="none" basicSetup={{ highlightActiveLine: true }} /></div>}
        {mode !== 'edit' && <div className="editor-pane editor-preview"><div className="editor-pane-label">Preview <span>· rendered by Shared Brain</span></div><div className="editor-preview-body">{!content.trim() ? <p className="editor-preview-empty">Your preview will appear here as you write.</p> : !token ? <p className="editor-preview-empty">Connect to the editor session to see a preview.</p> : previewLoading ? <p className="editor-preview-empty">Rendering preview…</p> : previewError ? <p className="editor-preview-error">{previewError} <button type="button" onClick={connect}>Reconnect session</button></p> : <article className="editor-rendered" dangerouslySetInnerHTML={{ __html: preview }} />}</div></div>}
      </div>
      <p className="editor-footer">Changes are saved only when you choose Save note.</p>
    </section>
  );
}
