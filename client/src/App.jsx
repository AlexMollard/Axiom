import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Bot, Check, ChevronRight, FileText, FolderKanban, LayoutDashboard, List, Network, Plus, RefreshCw, Search, ShieldCheck, UserRound, Inbox, Undo2, Trash2, Settings, Activity, Plug, DatabaseBackup, Command } from 'lucide-react';
import WorkspaceIcon from './WorkspaceIcon.jsx';
import { DeleteNote, WorkspaceSettings, Trash } from './Management.jsx';
import {SearchResults, CommandPalette} from './SearchExperience.jsx';
import {ReviewInbox, ReviewDiff} from './ReviewInbox.jsx';
import {WorkspaceOverview, MemoryHealth} from './KnowledgeViews.jsx';
import HarnessPage from './HarnessPage.jsx';
import RecoveryPage from './RecoveryPage.jsx';
import Notifications from './Notifications.jsx';
import UsagePage, { UsageSummary } from './UsageViews.jsx';

const MarkdownEditor = lazy(() => import('./MarkdownEditor.jsx'));
const WorkspaceGraph = lazy(() => import('./WorkspaceGraph.jsx'));
const labels = { all: 'All notes', owner: 'Your notes', agent: 'Agent memory', review: 'Review queue', proposals: 'Review queue', projects: 'Workspaces', trash: 'Trash', health: 'Memory health', harnesses: 'Harnesses', recovery: 'Backups & recovery', usage: 'Note usage' };
const projectLabel = (id, groups = []) => groups.find(g => g.id === id)?.name || (id === '__unmapped' ? 'Unmapped notes' : id === 'global' ? 'General' : (id || 'General').replaceAll('-', ' ').replace(/^./, c => c.toUpperCase()));
const pendingReview = note => note.owner === 'agent' && note.reviewStatus === 'unreviewed' && !['archived', 'superseded'].includes((note.status || '').toLowerCase());
const reviewLabel = note => note.owner === 'owner' ? 'Owner' : note.reviewStatus === 'reviewed' ? 'Reviewed' : 'Unreviewed';
const proposal = note => note.path.startsWith('Agents/Proposals/');
const latest = notes => [...notes].sort((a, b) => b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path));
const noteUrl = path => '/?note=' + encodeURIComponent(path);
const obsidianUrl = (vault, path = 'Home.md') => `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(path)}`;
function routeFrom(url = new URL(location.href)) {
  const p = url.searchParams;
  if (p.has('note')) return { kind: 'note', path: p.get('note'), edit: p.get('edit') === '1', hash: url.hash, reviewWorkspace: p.get('reviewWorkspace') || 'all', reviewKind: p.get('reviewKind') || 'all' };
  if (p.get('edit') === '1') return { kind: 'new' };
  if (p.has('q')) return { kind: 'search', query: p.get('q'), workspace: p.get('workspace') || '', owner: p.get('owner') || '', review: p.get('review') || '', scope: p.get('scope') || 'all' };
  if (p.has('project')) return { kind: 'project', id: p.get('project'), mode: ['graph', 'notes'].includes(p.get('mode')) ? p.get('mode') : 'overview' };
  return { kind: labels[p.get('view')] ? p.get('view') : 'overview', ...(p.get('view') === 'review' ? { reviewWorkspace: p.get('reviewWorkspace') || 'all', reviewKind: p.get('reviewKind') || 'all' } : {}) };
}
function routeUrl(route) {
  const p = new URLSearchParams();
  if (route.kind === 'note') { p.set('note', route.path); if (route.edit) p.set('edit', '1'); }
  else if (route.kind === 'new') p.set('edit', '1');
  else if (route.kind === 'search') { p.set('q', route.query); for (const key of ['workspace', 'owner', 'review']) if (route[key]) p.set(key, route[key]); p.set('scope', route.scope || 'all'); }
  else if (route.kind === 'project') { p.set('project', route.id); if (route.mode && route.mode !== 'overview') p.set('mode', route.mode); }
  else if (route.kind !== 'overview') p.set('view', route.kind);
  if (route.kind === 'review' || route.kind === 'note') for (const key of ['reviewWorkspace', 'reviewKind']) if (route[key] && route[key] !== 'all') p.set(key, route[key]);
  return (p.size ? '/?' + p : '/') + (route.kind === 'note' ? route.hash || '' : '');
}
async function api(url) {
  const response = await fetch(url); const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function time(value) {
  const date = new Date(value), seconds = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(seconds)) return 'Unknown time';
  if (Math.abs(seconds) < 60) return 'Just now';
  if (seconds >= 60 && seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds >= 3600 && seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds >= 86400 && seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function resolvesTo(link, candidate, note, notes) {
  let target;
  try { target = decodeURIComponent(link.split('#')[0]).replace(/\.md$/i, '').replaceAll('\\', '/'); } catch { return false; }
  const relative = new URL(target, 'https://vault.invalid/' + candidate.path).pathname.slice(1);
  const exact = notes.filter(n => [target, relative].some(v => n.path.replace(/\.md$/i, '').toLowerCase() === v.toLowerCase()));
  if (exact.length === 1) return exact[0].path === note.path;
  const byName = notes.filter(n => n.path.split('/').at(-1).replace(/\.md$/i, '').toLowerCase() === target.toLowerCase() || n.title.toLowerCase() === target.toLowerCase());
  return byName.length === 1 && byName[0].path === note.path;
}
function pinsFrom(html) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const heading = [...doc.querySelectorAll('h1,h2,h3')].find(n => /^(pinned|quick links)$/i.test(n.textContent.trim()));
  const links = [];
  if (heading) { for (let n = heading.nextElementSibling; n && !/^H[123]$/.test(n.tagName); n = n.nextElementSibling) links.push(...n.querySelectorAll('a[href]')); }
  else links.push(...doc.querySelectorAll('a[href]'));
  return links.filter(a => a.getAttribute('href') !== '#').slice(0, 5).map(a => ({ href: a.getAttribute('href'), title: a.textContent }));
}
function NoteRow({ note, excerpt = false }) {
  return <a className="note-row" href={noteUrl(note.path)}><span className="note-glyph"><FileText size={18} strokeWidth={1.7} aria-hidden="true" /></span><span className="note-row-main"><strong title={note.title}>{note.title}</strong><small>{excerpt && note.excerpt ? note.excerpt : note.path}</small></span><span className="note-row-meta"><span className="badge">{reviewLabel(note)}</span>{['archived', 'superseded'].includes((note.status || '').toLowerCase()) && <span className="badge">{note.status}</span>}<small>{time(note.updated)}</small></span><ArrowUpRight className="row-arrow" size={18} strokeWidth={1.7} aria-hidden="true" /></a>;
}
function Panel({ title, action, children, className = '' }) {
  return <section className={'panel ' + className}><div className="panel-heading"><h2>{title}</h2>{action}</div>{children}</section>;
}
function Empty({ children }) { return <p className="empty">{children}</p>; }
function Reader({ data, notes, vaultName, groups, onReview, reviewBusy, reviewError, onNext, onDelete, reviewScope }) {
  const { note, html } = data;
  const parsed = useMemo(() => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const first = doc.body.firstElementChild;
    const titleId = first?.tagName === 'H1' && first.textContent.trim() === note.title.trim() ? first.id : '';
    if (titleId) first.remove();
    return { html: doc.body.innerHTML, titleId, headings: [...doc.querySelectorAll('h1[id],h2[id],h3[id],h4[id]')].map(h => ({ id: h.id, title: h.textContent, level: h.tagName })) };
  }, [html, note.title]);
  const backlinks = notes.filter(n => n.path !== note.path && (n.links || []).some(link => resolvesTo(link, n, note, notes)));
  const scope = note.project !== 'global' && !groups.some(g => g.id === note.project) ? '__unmapped' : note.project;
  return <>
    <div className="breadcrumbs"><a href="/">Overview</a><ChevronRight size={18} strokeWidth={1.7} aria-hidden="true" /><a href={routeUrl({ kind: 'project', id: scope })}>{projectLabel(scope, groups)}</a><ChevronRight size={18} strokeWidth={1.7} aria-hidden="true" />Note</div>
    <header className="reader-heading">
      <div><p className="eyebrow">Knowledge / Note</p><h1 id={parsed.titleId || undefined}>{note.title}</h1><div className="reader-flags"><span className="badge">{reviewLabel(note)}</span>{['archived', 'superseded'].includes((note.status || '').toLowerCase()) && <span className="badge">{note.status}</span>}<span>Updated {time(note.updated)}</span></div></div>
      <div className="heading-actions"><a className="button button-soft" href={obsidianUrl(vaultName, note.path)}>Open in Obsidian <ArrowUpRight size={18} strokeWidth={1.7} aria-hidden="true" /></a><a className="button button-primary" href={routeUrl({ kind: 'note', path: note.path, edit: true, ...reviewScope })}>Edit</a>{note.deleteBlockedReason || ['Owner/Policies.md', 'Owner/Preferences.md', 'Owner/Reviews.md', 'Agents/Workspace icons.md'].includes(note.path) ? <span className="muted">Deletion unavailable: {note.deleteBlockedReason || 'This note is protected.'}</span> : <button className="button danger-button" onClick={onDelete}>Delete</button>}</div>
    </header>
    {note.owner === 'agent' && <section className="review-actions" aria-label="Human review"><div className="review-actions-buttons">{note.reviewStatus === 'reviewed' ? <button className="button" disabled={reviewBusy} onClick={() => onReview('unreviewed', false)}><Undo2 size={16} aria-hidden="true" />Mark unreviewed</button> : <><button className="button button-soft" disabled={reviewBusy} onClick={() => onReview('reviewed', false)}><Check size={16} aria-hidden="true" />Mark reviewed</button><button className="button button-primary" disabled={reviewBusy} onClick={() => onReview('reviewed', true)}><Check size={16} aria-hidden="true" />Mark reviewed &amp; next</button></>}<button className="button" disabled={reviewBusy} onClick={onNext}>Review next <ArrowRight size={16} aria-hidden="true" /></button><a className="button" href={routeUrl({kind: 'review', ...reviewScope})}>Back to review queue</a></div><p>Reviewed means checked, not promoted to owner policy.</p>{reviewError && <p className="review-error" role="alert">{reviewError}</p>}</section>}
    {note.owner === 'agent' && note.reviewKind === 'changed' && <ReviewDiff path={note.path} revision={note.revision} />}
    <div className="reader-grid"><article id="axiom-current-note" tabIndex="-1" className="panel reader markdown">{note.owner === 'agent' && note.reviewKind === 'changed' && <p><a href="#axiom-review-comparison">Jump to comparison</a></p>}<div dangerouslySetInnerHTML={{ __html: parsed.html }} /></article><aside className="reader-side"><UsageSummary path={note.path} /><nav className="panel toc" aria-label="On this page"><h2>On this page</h2>{parsed.headings.length ? parsed.headings.map(h => <a key={h.id} className={'toc-' + h.level.toLowerCase()} href={'#' + encodeURIComponent(h.id)}>{h.title}</a>) : <span className="muted">No section headings</span>}</nav><details className="panel source-details"><summary>Source &amp; revision</summary><p>Canonical Markdown file</p><code>{note.path}</code><p>Revision</p><code>{note.revision}</code></details></aside></div>
    <Panel title="Linked from" className="backlinks">{backlinks.length ? backlinks.slice(0, 8).map(n => <NoteRow key={n.path} note={n} />) : <Empty>No incoming links yet.</Empty>}</Panel>
  </>;
}
export default function App() {
  const [route, setRoute] = useState(routeFrom); const routeRef = useRef(route); const dirty = useRef(false);
  const [catalog, setCatalog] = useState(null); const [data, setData] = useState(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState(route.kind === 'search' ? route.query : ''); const [visible, setVisible] = useState(48); const [activity, setActivity] = useState('all');
  const [reviewBusy, setReviewBusy] = useState(false); const [reviewError, setReviewError] = useState('');
  const [management, setManagement] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { const value = JSON.parse(localStorage.getItem('axiom-workspace-folders') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } });
  const input = useRef(null); const timer = useRef(null); const request = useRef(0);
  const guard = useCallback(() => !dirty.current || window.confirm('Discard your unsaved changes?'), []);
  const navigate = useCallback((next, mode = 'push', bypass = false) => {
    clearTimeout(timer.current);
    const sameEditor = next.kind === 'note' && routeRef.current.kind === 'note' && next.path === routeRef.current.path && next.edit && routeRef.current.edit;
    if (!sameEditor && !bypass && !guard()) { setQuery(routeRef.current.kind === 'search' ? routeRef.current.query : ''); return false; }
    if (!sameEditor) dirty.current = false;
    routeRef.current = next;
    if (mode !== 'none') history[mode === 'replace' ? 'replaceState' : 'pushState']({}, '', routeUrl(next));
    setQuery(next.kind === 'search' ? next.query : ''); setVisible(48); setRoute(next); return true;
  }, [guard]);
  useEffect(() => {
    const pop = () => {
      const next = routeFrom();
      if (JSON.stringify(next) === JSON.stringify(routeRef.current)) return;
      const sameEditor = next.kind === 'note' && routeRef.current.kind === 'note' && next.path === routeRef.current.path && next.edit && routeRef.current.edit;
      if (!sameEditor && !guard()) { history.pushState({}, '', routeUrl(routeRef.current)); return; }
      navigate(next, 'none', true);
    };
    const unload = event => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    const keys = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPaletteOpen(open => !open); }
      if (event.key === 'Escape' && document.activeElement === input.current && input.current.value) { event.preventDefault(); navigate({ kind: 'overview' }, 'replace'); }
    };
    window.addEventListener('popstate', pop); window.addEventListener('beforeunload', unload); document.addEventListener('keydown', keys);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener('beforeunload', unload); document.removeEventListener('keydown', keys); clearTimeout(timer.current); };
  }, [guard, navigate]);
  useEffect(() => {
    const id = ++request.current; setLoading(true); setError(''); setReviewError(''); setData(null);
    (async () => {
      try {
        const cat = await api('/api/catalog'); if (id !== request.current) return; setCatalog(cat);
        let result = null;
        if (route.kind === 'note') result = await api('/api/note?path=' + encodeURIComponent(route.path));
        else if (route.kind === 'overview' && cat.notes.some(n => n.path === 'Home.md')) result = await api('/api/note?path=Home.md');
        if (id !== request.current) return; setData(result); setLoading(false);
      } catch (e) { if (id === request.current) { setError(e.message || 'Unable to read the vault.'); setLoading(false); } }
    })();
    return () => { request.current++; };
  }, [route.kind, route.path, route.edit, route.id, route.mode, refresh]);
  useEffect(() => {
    if (route.kind !== 'note' || route.edit || !data || data.note.path !== route.path || !route.hash) return;
    let id; try { id = decodeURIComponent(route.hash.slice(1)); } catch { return; }
    const article = document.querySelector('article#axiom-current-note');
    const title = document.querySelector('.reader-heading h1');
    const target = id === 'axiom-current-note' ? article : id === 'axiom-review-comparison' ? document.querySelector('section#axiom-review-comparison') : title?.id === id ? title : [...(article?.querySelectorAll('[id]') || [])].find(element => element.id === id);
    if (target) { target.scrollIntoView(); if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
  }, [route, data]);
  const notes = catalog?.notes || [], projects = catalog?.projects || [], vault = catalog?.vaultName || 'Shared Brain';
  const workspaceIcons = catalog?.workspaceIcons || {};
  const unmapped = n => n.project !== 'global' && !projects.some(p => p.id === n.project);
  const names = catalog?.workspaceNames || {}, workspaceGroups = catalog?.workspaceGroups || {};
  const groups = [{ id: 'global', name: names.global || projects.find(p => p.id === 'global')?.name || 'General', icon: workspaceIcons.global, group: workspaceGroups.global || 'work', notes: notes.filter(n => n.project === 'global') }, ...projects.filter(p => p.id !== 'global').map(p => ({ id: p.id, name: names[p.id] || p.name, icon: workspaceIcons[p.id] ?? p.icon, group: workspaceGroups[p.id] || p.group || 'work', notes: notes.filter(n => n.project === p.id) }))];
  const loose = notes.filter(unmapped); if (loose.length) groups.push({ id: '__unmapped', name: names.__unmapped || 'Unmapped notes', icon: workspaceIcons.__unmapped, group: workspaceGroups.__unmapped || 'work', notes: loose });
  groups.sort((a, b) => Number(a.group === 'home') - Number(b.group === 'home'));
  const pending = latest(notes.filter(pendingReview));
  const reviewFilters = { workspace: route.reviewWorkspace || 'all', kind: route.reviewKind || 'all' };
  const reviewScope = { reviewWorkspace: reviewFilters.workspace, reviewKind: reviewFilters.kind };
  const matchesReviewFilter = note => (reviewFilters.workspace === 'all' || (unmapped(note) ? '__unmapped' : note.project) === reviewFilters.workspace) && (reviewFilters.kind === 'all' || (note.reviewKind || 'new') === reviewFilters.kind);
  const scopedPending = pending.filter(matchesReviewFilter);
  const collection = route.kind === 'search' ? (data?.items || []) : latest(notes.filter(n => route.kind === 'owner' ? n.owner === 'owner' : route.kind === 'agent' ? n.owner === 'agent' : route.kind === 'review' ? pendingReview(n) : route.kind === 'proposals' ? proposal(n) : route.kind === 'project' ? (route.id === '__unmapped' ? unmapped(n) : n.project === route.id) : true));
  const refreshView = () => { if (guard()) { dirty.current = false; setRefresh(n => n + 1); } };
  const handleClick = event => {
    const link = event.target.closest('a[href]'); if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
    const href = link.getAttribute('href'); if (href.startsWith('#') && routeRef.current.kind !== 'note') return;
    const url = new URL(link.href, location.href); if (url.origin !== location.origin || url.pathname !== '/') return;
    event.preventDefault(); navigate(routeFrom(url));
  };
  const save = (note, html) => {
    dirty.current = false;
    const next = { ...routeRef.current, kind: 'note', path: note.path, edit: true }; routeRef.current = next;
    history.replaceState({}, '', routeUrl(next)); setCatalog(c => c ? { ...c, notes: [...c.notes.filter(n => n.path !== note.path), note] } : c);
    setData({ note, html }); setRoute(next);
    api('/api/catalog').then(setCatalog).catch(e => setError(e.message));
  };
  const nextReview = (items = scopedPending, current = data?.note?.path) => {
    const index = items.findIndex(n => n.path === current);
    const next = index < 0 ? items[0] : items.slice(index + 1).concat(items.slice(0, index))[0];
    navigate(next ? { kind: 'note', path: next.path, ...reviewScope } : { kind: 'review', ...reviewScope });
  };
  const review = async (decision, advance) => {
    if (reviewBusy || !data?.note || !guard()) return;
    setReviewBusy(true); setReviewError('');
    try {
      const session = await api('/api/editor-session');
      if (!session.token) throw new Error('Could not start a review session. Refresh and try again.');
      const response = await fetch('/api/note-review', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Shared-Brain-CSRF': session.token }, body: JSON.stringify({ path: data.note.path, expectedRevision: data.note.revision, decision }) });
      if (response.status === 409) throw new Error('This note changed since you opened it. Your view has been kept; refresh it before reviewing.');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save review. Try again.');
      if (routeRef.current.kind === 'note' && routeRef.current.path === result.note.path && !routeRef.current.edit) setData(result);
      setCatalog(c => c ? { ...c, notes: c.notes.map(n => n.path === result.note.path ? { ...n, ...result.note } : n) } : c);
      try {
        const fresh = await api('/api/catalog'); setCatalog(fresh);
        if (advance && routeRef.current.kind === 'note' && routeRef.current.path === result.note.path && !routeRef.current.edit) {
          const freshPending = latest(fresh.notes.filter(pendingReview).filter(matchesReviewFilter));
          const index = scopedPending.findIndex(n => n.path === result.note.path);
          const ordered = index < 0 ? [] : scopedPending.slice(index + 1).concat(scopedPending.slice(0, index));
          const next = ordered.find(n => freshPending.some(f => f.path === n.path)) || freshPending[0];
          navigate(next ? { kind: 'note', path: next.path, ...reviewScope } : { kind: 'review', ...reviewScope });
        }
      } catch {
        setReviewError('Review saved, but the queue could not be refreshed. Refresh the vault to continue.');
      }
    } catch (e) { setReviewError(e.message || 'Could not save review. Try again.'); }
    finally { setReviewBusy(false); }
  };
  const nav = [['overview', 'Overview', LayoutDashboard], ['all', 'All notes', FileText], ['owner', 'Your notes', UserRound], ['agent', 'Agent memory', Bot], ['review', 'Review queue', Inbox], ['projects', 'Workspaces', FolderKanban], ['trash', 'Trash', Trash2]];
  let content;
  if (loading) content = <div className="boot">Reading your vault…</div>;
  else if (error && !data && route.kind !== 'new') content = <><h1>Could not load this view</h1><p className="muted">Your source files have not been changed.</p><button className="button" onClick={refreshView}>Try again</button></>;
  else if (route.kind === 'new' || (route.kind === 'note' && route.edit && data)) content = <Suspense fallback={<div className="boot">Opening editor…</div>}><MarkdownEditor key={route.kind === 'new' ? '__new' : route.path} initialNote={route.kind === 'new' ? null : data.note} vaultName={vault} onSaved={save} onDirtyChange={value => { dirty.current = value; }} onCancel={() => navigate(route.kind === 'new' ? { kind: 'overview' } : { ...route, edit: false })} /></Suspense>;
  else if (route.kind === 'note' && data) content = <Reader data={data} notes={notes} vaultName={vault} groups={groups} reviewScope={reviewScope} onReview={review} reviewBusy={reviewBusy} reviewError={reviewError} onNext={() => nextReview()} onDelete={() => setManagement('note')} />;
  else if (route.kind === 'overview') content = <Overview notes={notes} groups={groups} data={data} activity={activity} setActivity={setActivity} />;
  else if (route.kind === 'trash') content = <Trash onRestored={() => api('/api/catalog').then(setCatalog).catch(e => setError(e.message))} />;
  else if (route.kind === 'search') content = <><PageHeading title="Search results" description={`Matches for “${route.query}” in ${route.scope === 'active' ? 'active knowledge' : 'all notes'}.`} /><SearchResults query={route.query} groups={groups} filters={{workspace: route.workspace || '', owner: route.owner || '', review: route.review || '', scope: route.scope || 'all'}} onFiltersChange={filters => navigate({...route, ...filters})} /></>;
  else if (route.kind === 'health') content = <><PageHeading title="Memory health" description="Actionable findings, with uncertainty and provenance preserved." /><MemoryHealth groups={groups} onOpenNote={path => navigate({kind: 'note', path})} /></>;
  else if (route.kind === 'usage') content = <UsagePage groups={groups} />;
  else if (route.kind === 'harnesses') content = <HarnessPage />;
  else if (route.kind === 'recovery') content = <RecoveryPage />;
  else if (route.kind === 'projects') content = <><PageHeading title="Workspaces" description="Explore notes and their connections by workspace." />{['work', 'home'].map(folder => <section className="workspace-card-group" key={folder}><h2>{folder === 'home' ? 'Home' : 'Work'}</h2><div className="project-grid project-grid-full">{groups.filter(g => g.group === folder).map(g => <ProjectCard key={g.id} group={g} />)}</div></section>)}</>;
  else if (route.kind === 'project') content = <>
    <div className="workspace-heading"><div><p className="eyebrow">Workspace</p><h1 className="workspace-heading-title"><WorkspaceIcon name={workspaceIcons[route.id] ?? projects.find(p => p.id === route.id)?.icon} size={28} />{projectLabel(route.id, groups)}</h1><p className="page-description">{collection.length} {collection.length === 1 ? 'note' : 'notes'} in this workspace</p></div><button className="button" onClick={() => setManagement('workspace')}><Settings size={17} aria-hidden="true" /> Settings</button></div>
    <nav className="workspace-modes" aria-label="Workspace view">
      <a className={route.mode === 'overview' ? 'active' : ''} aria-current={route.mode === 'overview' ? 'page' : undefined} href={routeUrl({kind: 'project', id: route.id})}><LayoutDashboard size={18} aria-hidden="true" />Overview</a>
      <a className={route.mode === 'graph' ? 'active' : ''} aria-current={route.mode === 'graph' ? 'page' : undefined} href={routeUrl({ kind: 'project', id: route.id, mode: 'graph' })}><Network size={18} strokeWidth={1.7} aria-hidden="true" />Graph</a>
      <a className={route.mode === 'notes' ? 'active' : ''} aria-current={route.mode === 'notes' ? 'page' : undefined} href={routeUrl({ kind: 'project', id: route.id, mode: 'notes' })}><List size={18} strokeWidth={1.7} aria-hidden="true" />Notes</a>
    </nav>
    {route.mode === 'overview' ? <WorkspaceOverview key={route.id} id={route.id} label={projectLabel(route.id, groups)} onOpenNote={path => navigate({kind: 'note', path})} /> : route.mode === 'notes' ? <Library collection={collection} visible={visible} setVisible={setVisible} /> : <Suspense fallback={<div className="boot">Opening workspace graph…</div>}><WorkspaceGraph project={route.id} label={projectLabel(route.id, groups)} vaultName={vault} onOpenNote={path => navigate({ kind: 'note', path })} /></Suspense>}
  </>;
  else if (route.kind === 'review' || route.kind === 'proposals') content = <><PageHeading title="Review queue" description="Check agent notes without promoting them to owner policy." /><nav className="filter-links" aria-label="Review collection"><a className={route.kind === 'review' ? 'active' : ''} href={routeUrl({kind: 'review', ...reviewScope})}>Unreviewed · {pending.length}</a><a className={route.kind === 'proposals' ? 'active' : ''} href={routeUrl({kind: 'proposals'})}>Proposals · {notes.filter(proposal).length}</a></nav>{route.kind === 'review' ? <ReviewInbox notes={pending} groups={groups} filters={reviewFilters} onFiltersChange={filters => navigate({kind: 'review', reviewWorkspace: filters.workspace, reviewKind: filters.kind})} onOpenNote={path => navigate({kind: 'note', path, ...reviewScope})} /> : <Library collection={collection} visible={visible} setVisible={setVisible} />}</>;
  else content = <><PageHeading title={labels[route.kind]} description="A shared library, with ownership and provenance intact." /><div className="library-toolbar"><div className="filter-links">{[['all', 'Everything'], ['owner', 'Your notes'], ['agent', 'Agent memory'], ['proposals', 'Proposals']].map(([kind, label]) => <a key={kind} className={route.kind === kind ? 'active' : ''} href={routeUrl({kind})}>{label}</a>)}</div><span className="result-count">{collection.length} {collection.length === 1 ? 'note' : 'notes'}</span></div><Library collection={collection} visible={visible} setVisible={setVisible} /></>;
  return <div className="app-shell" onClick={handleClick}>
    <a className="skip" href="#main">Skip to content</a>
    <aside className="sidebar" aria-label="Vault navigation">
      <a className="brand" href="/"><span className="brand-mark">ax<span>.</span></span><span>Axiom<small>PERSONAL KNOWLEDGE</small></span></a>
      <nav className="main-nav" aria-label="Library">{nav.map(([kind, label, Icon]) => <a key={kind} className={route.kind === kind || (kind === 'review' && route.kind === 'proposals') ? 'active' : ''} aria-current={route.kind === kind || (kind === 'review' && route.kind === 'proposals') ? 'page' : undefined} href={routeUrl({ kind })}><Icon className="nav-icon" size={18} strokeWidth={1.7} aria-hidden="true" />{label}{!['overview', 'projects', 'trash'].includes(kind) && <span className="nav-count">{kind === 'all' ? notes.length : kind === 'review' ? pending.length : notes.filter(n => n.owner === kind).length}</span>}</a>)}</nav>
      <nav className="utility-nav" aria-label="Knowledge tools">{[['health', 'Health', Activity], ['usage', 'Usage', List], ['harnesses', 'Harnesses', Plug], ['recovery', 'Backups', DatabaseBackup]].map(([kind, label, Icon]) => <a key={kind} href={routeUrl({kind})} aria-current={route.kind === kind ? 'page' : undefined}><Icon size={16} aria-hidden="true" />{label}</a>)}</nav>
      <div className="sidebar-section"><span>WORKSPACES</span><a href="/?view=projects">All <ArrowRight size={18} strokeWidth={1.7} aria-hidden="true" /></a></div>
      <nav className="project-nav" aria-label="Workspaces">{['work', 'home'].map(folder => <div key={folder}><button className="workspace-folder" type="button" aria-expanded={!collapsed[folder]} onClick={() => { const next = { ...collapsed, [folder]: !collapsed[folder] }; setCollapsed(next); try { localStorage.setItem('axiom-workspace-folders', JSON.stringify(next)); } catch {} }}><ChevronRight size={16} className={collapsed[folder] ? '' : 'expanded'} aria-hidden="true" />{folder === 'home' ? 'Home' : 'Work'}</button>{!collapsed[folder] && groups.filter(g => g.group === folder).map(g => <a key={g.id} className={route.kind === 'project' && route.id === g.id ? 'active' : ''} aria-current={route.kind === 'project' && route.id === g.id ? 'page' : undefined} href={routeUrl({ kind: 'project', id: g.id })}><WorkspaceIcon name={g.icon} />{projectLabel(g.id, groups)}<span className="nav-count">{g.notes.length}</span></a>)}</div>)}</nav>
      <div className="sidebar-bottom"><a className="guard-note" href={noteUrl('Owner/Policies.md')}><ShieldCheck size={18} strokeWidth={1.7} aria-hidden="true" /><span>Owner notes stay yours<small>Rule-level safeguards, not isolation</small></span></a><div className="connection"><span className="connection-dot" />{error ? 'Vault unavailable' : catalog ? 'Vault connected' : 'Connecting to vault'}</div></div>
    </aside>
    <main id="main" tabIndex="-1">
      <header className="topbar"><div className="workspace-title">{route.kind === 'project' ? <><WorkspaceIcon name={workspaceIcons[route.id] ?? projects.find(p => p.id === route.id)?.icon} />{projectLabel(route.id, groups)}</> : 'Axiom'}</div>
        <label className="global-search"><Search size={18} strokeWidth={1.7} aria-hidden="true" /><span className="sr-only">Search the vault</span><input ref={input} type="search" value={query} placeholder="Search notes, decisions, ideas…" onChange={e => { const value = e.target.value; setQuery(value); clearTimeout(timer.current); timer.current = setTimeout(() => navigate(value.trim() ? { ...(routeRef.current.kind === 'search' ? routeRef.current : {}), kind: 'search', query: value } : { kind: 'overview' }, 'replace'), 160); }} /><kbd>Ctrl K</kbd></label>
        <div className="topbar-actions"><Notifications catalog={catalog} groups={groups} pendingCount={pending.length} onCatalog={setCatalog} onOpenNote={path => { if (!navigate({kind: 'note', path})) return false; setRefresh(value => value + 1); return true; }} onOpenReview={() => navigate({kind: 'review'})} /><button className="icon-button" type="button" onClick={() => setPaletteOpen(true)} aria-label="Open command palette" title="Command palette · Ctrl K"><Command size={18} aria-hidden="true" /></button><button className="icon-button" type="button" onClick={refreshView} aria-label="Refresh vault" title="Refresh vault"><RefreshCw size={18} strokeWidth={1.7} aria-hidden="true" /></button><a className="button button-primary" href="/?edit=1"><Plus size={18} strokeWidth={1.7} aria-hidden="true" /> New note</a></div>
      </header>
      <div className="page-content"><div role="status" aria-live="polite">{error && <div className="error-notice">{error}</div>}</div><div aria-busy={loading}>{content}</div></div>
      {management === 'note' && data?.note && <DeleteNote note={data.note} onClose={() => setManagement(null)} onDeleted={() => { setManagement(null); navigate({ kind: 'all' }); setRefresh(n => n + 1); }} />}
      {management === 'workspace' && <WorkspaceSettings key={route.id} id={route.id} onClose={() => setManagement(null)} onChanged={() => { setManagement(null); setRefresh(n => n + 1); }} onDeleted={() => { setManagement(null); navigate({ kind: 'projects' }); setRefresh(n => n + 1); }} />}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={url => navigate(routeFrom(new URL(url, location.href)))} groups={groups} notes={notes} />
    </main>
  </div>;
}
function Library({ collection, visible, setVisible, search = false }) {
  return <section className="panel library-panel">{collection.slice(0, visible).map(n => <NoteRow key={n.path} note={n} excerpt={search} />)}{!collection.length && <Empty>{search ? 'No matching notes. Try another search.' : 'No notes in this collection yet.'}</Empty>}{collection.length > visible && <button className="load-more" onClick={() => setVisible(v => v + 48)}>Show more · {collection.length - visible} remaining</button>}</section>;
}
function Overview({ notes, groups, data, activity, setActivity }) {
  const pinned = pinsFrom(data?.html);
  const [workspaceFolder, setWorkspaceFolder] = useState('work');
  const folderWorkspaces = groups.filter(group => group.group === workspaceFolder).sort((a, b) => b.notes.length - a.notes.length).slice(0, workspaceFolder === 'work' ? 4 : 5);
  const activityNotes = latest(notes.filter(n => !proposal(n) && !n.path.startsWith('Agents/Handovers/') && (activity === 'all' || n.owner === activity))).slice(0, 6);
  return <>
    <div className="page-heading"><div><p className="eyebrow">Your knowledge, together</p><h1>Overview</h1><p className="page-description">Notes, decisions, and context across your vault.</p></div><span className="page-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span></div>
    <div className="metrics">{[['Notes in your vault', notes.length, 'all', FileText], ['Your notes', notes.filter(n => n.owner === 'owner').length, 'owner', UserRound], ['Agent memory', notes.filter(n => n.owner === 'agent').length, 'agent', Bot]].map(([label, count, kind, Icon]) => <a className="metric" href={routeUrl({ kind })} key={kind}><span className="metric-icon"><Icon size={18} strokeWidth={1.7} aria-hidden="true" /></span><span><span className="metric-label">{label}</span><strong className="metric-value">{count}</strong></span><ArrowUpRight className="metric-arrow" size={18} strokeWidth={1.7} aria-hidden="true" /></a>)}</div>
    <div className="dashboard-grid">
      <Panel title="Latest activity" className="panel-activity" action={<div className="segmented" aria-label="Filter latest activity">{[['all', 'All'], ['owner', 'Yours'], ['agent', 'Agents']].map(([v, label]) => <button key={v} type="button" className={activity === v ? 'active' : ''} aria-pressed={activity === v} onClick={() => setActivity(v)}>{label}</button>)}</div>}><div>{activityNotes.length ? activityNotes.map(n => <NoteRow key={n.path} note={n} />) : <Empty>No recent activity in this view.</Empty>}</div><div className="panel-footer"><span>Latest file changes · handovers hidden</span><a href="/?view=all">View library <ArrowRight size={18} strokeWidth={1.7} aria-hidden="true" /></a></div></Panel>
      <Panel title="Pinned" className="panel-pinned" action={<a href={noteUrl('Home.md')}>Home note <ArrowUpRight size={18} strokeWidth={1.7} aria-hidden="true" /></a>}><div className="pinned-list">{pinned.length ? pinned.map((p, i) => <a className="pin-link" href={p.href} key={i}><FileText size={18} strokeWidth={1.7} aria-hidden="true" />{p.title}<ArrowUpRight size={18} strokeWidth={1.7} aria-hidden="true" /></a>) : <Empty>Add links under Pinned in Home.md.</Empty>}</div></Panel>
      <Panel title="Review queue" className="panel-review" action={<a href="/?view=review">View queue <ArrowRight size={18} strokeWidth={1.7} aria-hidden="true" /></a>}>{notes.some(pendingReview) ? latest(notes.filter(pendingReview)).slice(0, 2).map(n => <NoteRow key={n.path} note={n} />) : <Empty>You’re caught up. No active unreviewed agent notes.</Empty>}</Panel>
      <Panel title="Your workspaces" className="panel-projects" action={<a href="/?view=projects">All workspaces <ArrowRight size={18} strokeWidth={1.7} aria-hidden="true" /></a>}>
        <div className="workspace-folder-tabs" role="group" aria-label="Workspace folder">{['work', 'home'].map(folder => <button key={folder} type="button" aria-pressed={workspaceFolder === folder} onClick={() => setWorkspaceFolder(folder)}>{folder === 'home' ? 'Home' : 'Work'}<span>{groups.filter(group => group.group === folder).length}</span></button>)}</div>
        <div className="project-grid">{folderWorkspaces.map(group => <ProjectCard key={group.id} group={group} />)}</div>
        {!folderWorkspaces.length && <Empty>No workspaces in this folder.</Empty>}
      </Panel>
    </div>
  </>;
}
function PageHeading({ title, description }) { return <div className="page-heading"><div><p className="eyebrow">Library</p><h1>{title}</h1><p className="page-description">{description}</p></div></div>; }
function ProjectCard({ group }) { return <a className="project-card" href={routeUrl({ kind: 'project', id: group.id })}><span className="project-avatar"><WorkspaceIcon name={group.icon} /></span><span><strong>{projectLabel(group.id, [group])}</strong><small>{group.notes.length} {group.notes.length === 1 ? 'note' : 'notes'}</small></span><ArrowUpRight className="row-arrow" size={18} strokeWidth={1.7} aria-hidden="true" /></a>; }
