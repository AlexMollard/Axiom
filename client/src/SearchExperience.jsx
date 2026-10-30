import React, { useEffect, useMemo, useRef, useState } from 'react';
import './SearchExperience.css';

const noteUrl = path => '/?note=' + encodeURIComponent(path);
const label = (id, groups) => groups.find(group => group.id === id)?.name || (id === '__unmapped' ? 'Unmapped notes' : id || 'General');
const scope = (note, groups) => note.project === 'global' || groups.some(group => group.id === note.project) ? note.project : '__unmapped';

function Highlight({ text = '', query }) {
  const words = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+#]*/gu) || []))].filter(word => !['the','and','for','this','that','with','from','have','please','what','how','can','you'].includes(word)).sort((a, b) => b.length - a.length);
  if (!words.length) return text;
  const pattern = new RegExp('(' + words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'giu');
  return text.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part);
}

export function SearchResults({ query, groups, filters, onFiltersChange }) {
  const [result, setResult] = useState(null), [error, setError] = useState(''), [offset, setOffset] = useState(0);
  const [semanticMessage, setSemanticMessage] = useState(''), [retry, setRetry] = useState(0);
  const workspace = filters.workspace || '', owner = filters.owner || '', review = filters.review || '', searchScope = filters.scope || 'all', mode = filters.mode || 'hybrid';
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const params = new URLSearchParams({ q: query, workspace, owner, review, scope: searchScope, offset: String(offset), limit: '50' });
    setResult(null); setError(''); setSemanticMessage(mode === 'hybrid' ? 'Preparing semantic results; a sleeping model may take 10–40 seconds to wake and index.' : '');
    const request = async searchMode => {
      const requestParams = new URLSearchParams(params); requestParams.set('mode', searchMode);
      const response = await fetch('/api/search?' + requestParams, { signal: controller.signal });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Search failed'); return data;
    };
    const lexical = request('lexical').then(data => { if (active) setResult(data); }, err => { if (active) setError(err.message); });
    if (mode === 'hybrid') {
      const timeout = setTimeout(() => { if (active) { setSemanticMessage('Semantic search timed out. Lexical results remain available.'); controller.abort(); } }, 65000);
      const hybrid = request('hybrid').then(data => ({ data }), err => ({ err }));
      Promise.all([lexical, hybrid]).then(([, outcome]) => {
        clearTimeout(timeout);
        if (!active || controller.signal.aborted) return;
        if (outcome.err) { setSemanticMessage(`Semantic search unavailable: ${outcome.err.message}. Lexical results remain available.`); return; }
        setResult(outcome.data); setError('');
        const status = outcome.data.semantic;
        setSemanticMessage(status?.reason ? `Semantic search: ${status.reason}` : status && (status.enabled === false || ['unavailable', 'disabled', 'incomplete'].includes(status.state)) ? `Semantic search: ${status.state}. Lexical results remain available.` : '');
      });
      return () => { active = false; clearTimeout(timeout); controller.abort(); };
    }
    return () => { active = false; controller.abort(); };
  }, [query, workspace, owner, review, searchScope, mode, offset, retry]);
  const sections = useMemo(() => {
    const buckets = new Map();
    for (const note of result?.items || []) { const id = scope(note, groups); if (!buckets.has(id)) buckets.set(id, []); buckets.get(id).push(note); }
    return [...buckets].sort(([a], [b]) => {
      const ga = groups.find(g => g.id === a), gb = groups.find(g => g.id === b);
      return (ga?.group === 'home' ? 1 : 0) - (gb?.group === 'home' ? 1 : 0) || label(a, groups).localeCompare(label(b, groups));
    });
  }, [result, groups]);
  const change = (key, value) => onFiltersChange({ ...filters, [key]: value });
  return <section className="search-experience" aria-label="Search results">
    <div className="search-filters" aria-label="Search filters">
      <label>Scope<select value={searchScope} onChange={e => change('scope', e.target.value)}><option value="all">All notes</option><option value="active">Active knowledge</option></select></label>
      <label>Workspace<select value={workspace} onChange={e => change('workspace', e.target.value)}><option value="">All workspaces</option>{[...groups].sort((a,b) => (a.group === 'home' ? 1 : 0) - (b.group === 'home' ? 1 : 0) || a.name.localeCompare(b.name)).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <label>Owner<select value={owner} onChange={e => change('owner', e.target.value)}><option value="">Everyone</option><option value="owner">Owner</option><option value="agent">Agent</option></select></label>
      <label>Review<select value={review} onChange={e => change('review', e.target.value)}><option value="">All review states</option><option value="reviewed">Reviewed</option><option value="unreviewed">Unreviewed</option></select></label>
      <label>Search mode<select value={mode} onChange={e => change('mode', e.target.value)}><option value="hybrid">Lexical + semantic</option><option value="lexical">Lexical only</option></select></label>
    </div>
    <p className="search-scope">{searchScope === 'active' ? 'Active knowledge excludes proposals, handovers, archived and superseded notes.' : 'All notes includes proposals, handovers, archived and superseded notes.'}</p>
    <p className="search-count" role="status" aria-live="polite" aria-atomic="true">{error && !result ? `Search failed: ${error}` : !result ? 'Searching…' : `${result.total} ${result.total === 1 ? 'result' : 'results'} · ${result.searchMode === 'hybrid' ? 'Hybrid' : 'Lexical'}${mode === 'hybrid' && semanticMessage.startsWith('Preparing') ? ' (semantic results pending)' : ''}`}</p>
    {semanticMessage && <p className="search-semantic-status" role="status">{semanticMessage} {semanticMessage.startsWith('Semantic search') && <button type="button" className="button" onClick={() => setRetry(value => value + 1)}>Retry semantic search</button>}</p>}
    <div aria-busy={!result && !error}>{result && <>{!result.total && <p>No matching notes.</p>}{sections.map(([id, notes]) => <section className="search-section" key={id}><h2>{label(id, groups)}</h2>{notes.map(note => <a className="search-result" href={noteUrl(note.path) + (note.anchor ? '#' + encodeURIComponent(note.anchor) : '')} key={note.path}><strong><Highlight text={note.title} query={query} /></strong><small>{note.path} · {note.owner === 'owner' ? 'Owner' : note.reviewStatus === 'reviewed' ? 'Reviewed' : 'Unreviewed'}</small>{(note.heading || note.line || note.matchReason) && <small>{[note.heading, note.line ? `Line ${note.line}` : '', note.matchReason].filter(Boolean).join(' · ')}</small>}<div className="search-result-badges">{note.path.startsWith('Agents/Proposals/') && <span className="badge">Proposal</span>}{note.path.startsWith('Agents/Handovers/') && <span className="badge">Handover</span>}{['archived', 'superseded'].includes((note.status || '').toLowerCase()) && <span className="badge">{note.status}</span>}</div><span><Highlight text={note.excerpt} query={query} /></span></a>)}</section>)}<div className="search-pages"><button type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button><button type="button" disabled={!result.hasMore} onClick={() => setOffset(offset + 50)}>Next</button></div></>}</div>
  </section>;
}

const actions = [
  { title: 'New note', url: '/?edit=1' }, { title: 'Review queue', url: '/?view=review' },
  { title: 'Memory health', url: '/?view=health' }, { title: 'Harnesses', url: '/?view=harnesses' },
  { title: 'Recovery', url: '/?view=recovery' }, { title: 'Usage', url: '/?view=usage' },
  { title: 'Workspaces', url: '/?view=projects' }, { title: 'Trash', url: '/?view=trash' },
];
export function CommandPalette({ open, onClose, onNavigate, groups, notes, vaultId, recent }) {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0);
  const input = useRef(null), previous = useRef(null), dialog = useRef(null);
  const [storedRecent, setStoredRecent] = useState({ vaultId: null, paths: [], error: '' });
  useEffect(() => {
    if (!open || !vaultId) return;
    try {
      const value = JSON.parse(localStorage.getItem('axiom-recent-notes:' + vaultId) || '[]');
      setStoredRecent({ vaultId, paths: Array.isArray(value) ? value.filter(path => typeof path === 'string').slice(0, 20) : [], error: '' });
    } catch {
      setStoredRecent({ vaultId, paths: [], error: 'Recent notes are unavailable on this device.' });
    }
  }, [open, vaultId, recent]);
  useEffect(() => {
    if (!open) return;
    previous.current = document.activeElement; setQuery(''); setSelected(0); input.current?.focus();
    return () => previous.current?.focus?.();
  }, [open]);
  const entries = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = value => terms.every(term => value.toLowerCase().includes(term));
    const workspaces = [...groups].sort((a,b) => (a.group === 'home' ? 1 : 0) - (b.group === 'home' ? 1 : 0) || a.name.localeCompare(b.name));
    const recentState = recent?.vaultId === vaultId && recent.error ? recent : storedRecent;
    const byPath = new Map(notes.map(note => [note.path, note]));
    const recentEntries = !terms.length && recentState.vaultId === vaultId ? recentState.paths.map(path => byPath.get(path)).filter(Boolean).map(item => ({title: item.title, detail: item.path, kind: 'Recent', url: noteUrl(item.path)})) : [];
    return [
      ...recentEntries,
      ...actions.filter(item => matches(item.title)).map(item => ({...item, kind: 'Action'})),
      ...workspaces.filter(item => matches(item.name)).map(item => ({title: item.name, kind: 'Workspace', url: '/?project=' + encodeURIComponent(item.id)})),
      ...notes.filter(item => matches(item.title + ' ' + item.path)).slice(0, 50).map(item => ({title: item.title, detail: item.path, kind: 'Note', url: noteUrl(item.path)})),
    ];
  }, [query, groups, notes, vaultId, recent, storedRecent]);
  useEffect(() => { setSelected(0); }, [query]);
  useEffect(() => { if (open) dialog.current?.querySelector(`#palette-option-${selected}`)?.scrollIntoView({block: 'nearest'}); }, [open, selected]);
  if (!open) return null;
  const choose = item => { if (item && onNavigate(item.url) !== false) onClose(); };
  const keyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(i => entries.length ? (i + 1) % entries.length : 0); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(i => entries.length ? (i + entries.length - 1) % entries.length : 0); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(entries[selected]); }
    else if (event.key === 'Tab') { event.preventDefault(); input.current?.focus(); }
  };
  return <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialog} className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={keyDown}><input ref={input} role="combobox" aria-label="Search commands, workspaces and notes" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={entries[selected] ? 'palette-option-' + selected : undefined} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search notes, workspaces, and actions" />{(recent?.vaultId === vaultId && recent.error || storedRecent.vaultId === vaultId && storedRecent.error) && <p role="status">{recent?.error || storedRecent.error}</p>}<div id="palette-results" role="listbox" className="palette-results">{entries.map((item, index) => <React.Fragment key={item.kind + item.url}>{item.kind === 'Recent' && (index === 0 || entries[index - 1].kind !== 'Recent') && <div className="palette-group-label">Recent</div>}<div role="option" aria-selected={selected === index} id={'palette-option-' + index} className={'palette-option' + (index === selected ? ' selected' : '')} onMouseMove={() => setSelected(index)} onClick={() => choose(item)}><span><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span><small>{item.kind}</small></div></React.Fragment>)}{!entries.length && <p>No matches.</p>}</div><small className="palette-hint">↑ ↓ to select · Enter to open · Esc to close</small></div></div>;
}
