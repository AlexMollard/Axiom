import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, FileText, FolderKanban, LayoutDashboard, List, Network, Plus, RefreshCw, Search, ShieldCheck, UserRound, Inbox, Undo2, Trash2, Settings, Activity, Plug, DatabaseBackup, Command, ScanSearch, Columns2, X } from 'lucide-react';
import WorkspaceIcon, { registerWorkspaceIconNodes } from './WorkspaceIcon.jsx';
import { DeleteNote, WorkspaceSettings, Trash } from './Management.jsx';
import { SearchResults, CommandPalette } from './SearchExperience.jsx';
import { ReviewInbox, ReviewDiff } from './ReviewInbox.jsx';
import { WorkspaceOverview, MemoryHealth, NoteKnowledge } from './KnowledgeViews.jsx';
import HarnessPage from './HarnessPage.jsx';
import RecoveryPage from './RecoveryPage.jsx';
import Notifications from './Notifications.jsx';
import UsagePage, { UsageSummary } from './UsageViews.jsx';
import Cleanup from './Cleanup.jsx';
import TitleBar from './TitleBar.jsx';
import TabBar from './TabBar.jsx';
import StatusBar from './StatusBar.jsx';
import DesktopSettings from './DesktopSettings.jsx';
import InNoteFind from './InNoteFind.jsx';
import { useConfirm } from './ConfirmDialog.jsx';
import {
  apiMutate,
  getDesktopInfo,
  getDesktopPrefs,
  installDesktopUpdate,
  isDesktop,
  listenDesktop,
  openDetachedWindow,
  openInObsidian,
  openInVscode,
  quitDesktop,
  readBucketState,
  revealInExplorer,
  saveDesktopPrefs,
  setDirtyTabCount,
  toggleQuickOverlay,
  writeBucketState,
} from './desktop-bridge.mjs';
import { closeTab, createTab, nextTabId, openTab, routeTitle, setTabDirty } from './tabs-state.mjs';
import { subscribeVaultEvents } from './live-sync.mjs';
import { AXIOM_ICON_DATA_URI } from './axiom-icon.mjs';

const MarkdownEditor = lazy(() => import('./MarkdownEditor.jsx'));
const NoteHistory = lazy(() => import('./NoteHistory.jsx'));
const WorkspaceGraph = lazy(() => import('./WorkspaceGraph.jsx'));
const QuickOverlay = lazy(() => import('./QuickOverlay.jsx'));

const labels = { all: 'All notes', owner: 'Your notes', agent: 'Agent memory', review: 'Review queue', proposals: 'Review queue', projects: 'Workspaces', trash: 'Trash', health: 'Memory health', cleanup: 'Clean up', harnesses: 'Harnesses', recovery: 'Backups & recovery', usage: 'Note usage' };
const projectLabel = (id, groups = []) => groups.find(g => g.id === id)?.name || (id === '__all' ? 'All vaults' : id === '__unmapped' ? 'Unmapped notes' : id === 'global' ? 'General' : (id || 'General').replaceAll('-', ' ').replace(/^./, c => c.toUpperCase()));
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
  if (p.has('q')) return { kind: 'search', query: p.get('q'), workspace: p.get('workspace') || '', owner: p.get('owner') || '', review: p.get('review') || '', scope: p.get('scope') || 'all', mode: p.get('mode') === 'lexical' ? 'lexical' : 'hybrid' };
  if (p.has('project')) return { kind: 'project', id: p.get('project'), mode: ['graph', 'notes'].includes(p.get('mode')) ? p.get('mode') : 'overview' };
  return { kind: labels[p.get('view')] ? p.get('view') : 'overview', ...(p.get('view') === 'review' ? { reviewWorkspace: p.get('reviewWorkspace') || 'all', reviewKind: p.get('reviewKind') || 'all' } : {}) };
}

function routeUrl(route) {
  const p = new URLSearchParams();
  if (route.kind === 'note') { p.set('note', route.path); if (route.edit) p.set('edit', '1'); }
  else if (route.kind === 'new') p.set('edit', '1');
  else if (route.kind === 'search') { p.set('q', route.query); for (const key of ['workspace', 'owner', 'review']) if (route[key]) p.set(key, route[key]); p.set('scope', route.scope || 'all'); p.set('mode', route.mode === 'lexical' ? 'lexical' : 'hybrid'); }
  else if (route.kind === 'project') { p.set('project', route.id); if (route.mode && route.mode !== 'overview') p.set('mode', route.mode); }
  else if (route.kind !== 'overview') p.set('view', route.kind);
  if (route.kind === 'review' || route.kind === 'note') for (const key of ['reviewWorkspace', 'reviewKind']) if (route[key] && route[key] !== 'all') p.set(key, route[key]);
  return (p.size ? '/?' + p : '/') + (route.kind === 'note' ? route.hash || '' : '');
}

async function api(url) {
  const response = await fetch(url);
  const data = await response.json();
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

function Reader({ data, notes, vaultName, groups, onReview, reviewBusy, reviewError, onNext, onPrev, onDelete, reviewScope, onOpenNote, onOpenSplit, onRestored }) {
  const { note, html } = data;
  const parsed = React.useMemo(() => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const first = doc.body.firstElementChild;
    const titleId = first?.tagName === 'H1' && first.textContent.trim() === note.title.trim() ? first.id : '';
    if (titleId) first.remove();
    return { html: doc.body.innerHTML, titleId, headings: [...doc.querySelectorAll('h1[id],h2[id],h3[id],h4[id]')].map(h => ({ id: h.id, title: h.textContent, level: h.tagName })) };
  }, [html, note.title]);
  const backlinks = notes.filter(n => n.path !== note.path && (n.links || []).some(link => resolvesTo(link, n, note, notes)));
  const scope = note.project !== 'global' && !groups.some(g => g.id === note.project) ? '__unmapped' : note.project;
  const [copiedMsg, setCopiedMsg] = useState('');
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const openMenuRef = useRef(null);
  const copyTimer = useRef(null);

  useEffect(() => {
    if (!openMenuOpen) return;
    const onDown = event => {
      if (openMenuRef.current && !openMenuRef.current.contains(event.target)) setOpenMenuOpen(false);
    };
    const onKey = event => {
      if (event.key === 'Escape') setOpenMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [openMenuOpen]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const copyWikilink = async () => {
    const link = `[[${note.path.replace(/\.md$/i, '')}]]`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedMsg('Copied');
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedMsg(''), 1500);
    } catch {}
  };

  return (
    <>
      <div className="breadcrumbs"><a href="/">Overview</a><ChevronRight size={18} strokeWidth={1.7} aria-hidden="true" /><a href={routeUrl({ kind: 'project', id: scope })}>{projectLabel(scope, groups)}</a><ChevronRight size={18} strokeWidth={1.7} aria-hidden="true" />Note</div>
      <header className="reader-heading">
        <div><p className="eyebrow">Knowledge / Note</p><h1 id={parsed.titleId || undefined}>{note.title}</h1><div className="reader-flags"><span className="badge">{reviewLabel(note)}</span>{['archived', 'superseded'].includes((note.status || '').toLowerCase()) && <span className="badge">{note.status}</span>}<span>Updated {time(note.updated)}</span></div></div>
        <div className="heading-actions">
          {isDesktop() ? (
            <div className="action-menu" ref={openMenuRef}>
              <button
                type="button"
                className="button button-soft"
                aria-haspopup="menu"
                aria-expanded={openMenuOpen}
                onClick={() => setOpenMenuOpen(v => !v)}
              >
                {copiedMsg || 'Open in'} <ChevronDown size={14} aria-hidden="true" />
              </button>
              {openMenuOpen && (
                <div className="action-menu-popover" role="menu">
                  <button type="button" role="menuitem" onClick={() => { openInObsidian(note.path, vaultName); setOpenMenuOpen(false); }}>Open in Obsidian</button>
                  <button type="button" role="menuitem" onClick={() => { openInVscode(note.path); setOpenMenuOpen(false); }}>Open in VS Code</button>
                  <button type="button" role="menuitem" onClick={() => { revealInExplorer('note', note.path); setOpenMenuOpen(false); }}>Reveal in Explorer</button>
                  <button type="button" role="menuitem" onClick={() => { copyWikilink(); setOpenMenuOpen(false); }}>Copy wikilink</button>
                </div>
              )}
            </div>
          ) : (
            <>
              <a className="button button-soft" href={obsidianUrl(vaultName, note.path)}>Open in Obsidian <ArrowUpRight size={18} strokeWidth={1.7} aria-hidden="true" /></a>
              {onOpenSplit && <button type="button" className="button" onClick={() => onOpenSplit({ kind: 'note', path: note.path })}><Columns2 size={16} aria-hidden="true" /> Split</button>}
            </>
          )}
          <a className="button button-primary" href={routeUrl({ kind: 'note', path: note.path, edit: true, ...reviewScope })}>Edit</a>
          {note.deleteBlockedReason || ['Owner/Policies.md', 'Owner/Preferences.md', 'Owner/Reviews.md', 'Agents/Workspace icons.md'].includes(note.path) ? <span className="muted">Deletion unavailable: {note.deleteBlockedReason || 'This note is protected.'}</span> : <button className="button danger-button" onClick={onDelete}>Delete</button>}
        </div>
      </header>
      {note.owner === 'agent' && (
        <section className="review-actions" aria-label="Human review">
          <div className="review-actions-buttons">
            {note.reviewStatus === 'reviewed'
              ? <button className="button" disabled={reviewBusy} onClick={() => onReview('unreviewed', false)}><Undo2 size={16} aria-hidden="true" />Mark unreviewed</button>
              : <><button className="button button-soft" disabled={reviewBusy} onClick={() => onReview('reviewed', false)}><Check size={16} aria-hidden="true" />Mark reviewed</button><button className="button button-primary" disabled={reviewBusy} onClick={() => onReview('reviewed', true)}><Check size={16} aria-hidden="true" />Mark reviewed &amp; next (A)</button></>}
            {onPrev && <button className="button" disabled={reviewBusy} onClick={onPrev}>Prev (K)</button>}
            <button className="button" disabled={reviewBusy} onClick={onNext}>Review next (J) <ArrowRight size={16} aria-hidden="true" /></button>
            <a className="button" href={routeUrl({ kind: 'review', ...reviewScope })}>Back to review queue</a>
          </div>
          <p>Reviewed means checked, not promoted to owner policy. Shortcuts: J/K step, A approve &amp; next, D diff, E edit, Ctrl+F find.</p>
          {reviewError && <p className="review-error" role="alert">{reviewError}</p>}
        </section>
      )}
      {note.owner === 'agent' && note.reviewKind === 'changed' && <ReviewDiff path={note.path} revision={note.revision} />}
      <InNoteFind containerSelector="#axiom-current-note" noteKey={`${note.path}:${note.revision}`} />
      <div className="reader-grid">
        <article id="axiom-current-note" tabIndex="-1" className="panel reader markdown">
          {note.owner === 'agent' && note.reviewKind === 'changed' && <p><a href="#axiom-review-comparison">Jump to comparison</a></p>}
          <div dangerouslySetInnerHTML={{ __html: parsed.html }} />
        </article>
        <aside className="reader-side">
          <UsageSummary path={note.path} />
          <nav className="panel toc" aria-label="On this page">
            <h2>On this page</h2>
            {parsed.headings.length ? parsed.headings.map(h => <a key={h.id} className={'toc-' + h.level.toLowerCase()} href={'#' + encodeURIComponent(h.id)}>{h.title}</a>) : <span className="muted">No section headings</span>}
          </nav>
          <details className="panel source-details"><summary>Source &amp; revision</summary><p>Canonical Markdown file</p><code>{note.path}</code><p>Revision</p><code>{note.revision}</code></details>
        </aside>
      </div>
      <Panel title="Linked from" className="backlinks">{backlinks.length ? backlinks.slice(0, 8).map(n => <NoteRow key={n.path} note={n} />) : <Empty>No incoming links yet.</Empty>}</Panel>
      <NoteKnowledge note={note} onOpenNote={onOpenNote} />
      <Suspense fallback={<p className="muted">Loading note history...</p>}><NoteHistory note={note} onRestored={onRestored} /></Suspense>
    </>
  );
}

function SplitPane({ splitRoute, vaultName, onClose, onChangeSplitRoute, onOpenMainNote }) {
  const [splitData, setSplitData] = useState(null);
  const [splitError, setSplitError] = useState('');

  useEffect(() => {
    if (!splitRoute || splitRoute.kind !== 'note') { setSplitData(null); return; }
    let active = true;
    setSplitError('');
    api('/api/note?path=' + encodeURIComponent(splitRoute.path))
      .then(res => { if (active) setSplitData(res); })
      .catch(err => { if (active) setSplitError(err.message); });
    return () => { active = false; };
  }, [splitRoute]);

  if (!splitRoute) return null;

  const handleSplitClick = event => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname === '/' && url.searchParams.has('note')) {
      event.preventDefault();
      event.stopPropagation();
      onChangeSplitRoute({ kind: 'note', path: url.searchParams.get('note') });
    }
  };

  return (
    <aside className="split-secondary-pane" aria-label="Split reference pane" onClick={handleSplitClick}>
      <div className="split-secondary-header">
        <strong>{splitRoute.kind === 'project' ? 'Graph view' : splitRoute.kind === 'note' ? (splitData?.note?.title || splitRoute.path) : 'Split view'}</strong>
        <div className="topbar-actions">
          {splitRoute.kind === 'note' && (
            <button type="button" className="button" onClick={() => onOpenMainNote(splitRoute.path)}>Focus main</button>
          )}
          <button type="button" className="icon-button" aria-label="Close split pane" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </div>
      </div>
      {splitError && <p className="error-notice">{splitError}</p>}
      {splitRoute.kind === 'project' ? (
        <Suspense fallback={<p className="muted">Loading graph...</p>}>
          <WorkspaceGraph project={splitRoute.id} label={splitRoute.id} vaultName={vaultName} onOpenNote={p => onChangeSplitRoute({ kind: 'note', path: p })} />
        </Suspense>
      ) : splitRoute.kind !== 'note' ? (
        <p className="muted">Select a note or workspace graph to view in split mode.</p>
      ) : !splitData ? (
        <p className="muted">Loading reference note...</p>
      ) : (
        <article className="panel reader markdown">
          <div dangerouslySetInnerHTML={{ __html: splitData.html }} />
        </article>
      )}
    </aside>
  );
}

export default function App() {
  const searchParams = new URLSearchParams(location.search);
  const desktopMode = searchParams.get('desktopMode') || '';
  if (desktopMode === 'quick') {
    return (
      <Suspense fallback={<div className="boot">Loading quick switcher...</div>}>
        <QuickOverlay />
      </Suspense>
    );
  }
  return <MainApp detached={desktopMode === 'detached'} />;
}

function MainApp({ detached = false }) {
  const [route, setRoute] = useState(routeFrom);
  const routeRef = useRef(route);
  const dirty = useRef(false);
  const [catalog, setCatalogState] = useState(null);
  const setCatalog = useCallback(next => {
    setCatalogState(prev => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      if (resolved?.workspaceIconNodes) registerWorkspaceIconNodes(resolved.workspaceIconNodes);
      return resolved;
    });
  }, []);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState(route.kind === 'search' ? route.query : '');
  const [visible, setVisible] = useState(48);
  const [activity, setActivity] = useState('all');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [management, setManagement] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [sseStatus, setSseStatus] = useState('reconnecting');
  const [backendInfo, setBackendInfo] = useState(null);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [editorStats, setEditorStats] = useState(null);
  const [externalChangedPath, setExternalChangedPath] = useState('');
  const [splitRoute, setSplitRoute] = useState(null);
  const [splitPercent, setSplitPercent] = useState(44);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const [tabs, setTabs] = useState(() => [createTab(routeFrom(), routeTitle(routeFrom()), 'tab-initial')]);
  const [activeTabId, setActiveTabId] = useState('tab-initial');
  const activeTabRef = useRef('tab-initial');
  const tabsRef = useRef(tabs);
  const splitWorkspaceRef = useRef(null);
  tabsRef.current = tabs;
  activeTabRef.current = activeTabId;

  const [recent, setRecent] = useState({ vaultId: null, paths: [], error: '' });
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem('axiom-workspace-folders') || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  });

  const input = useRef(null);
  const timer = useRef(null);
  const request = useRef(0);
  const { confirm, dialog } = useConfirm();

  const applyZoom = useCallback((nextZoom, persist = true) => {
    const clamped = Math.max(80, Math.min(150, nextZoom));
    setZoomPercent(clamped);
    document.documentElement.style.zoom = `${clamped}%`;
    if (persist && isDesktop()) {
      getDesktopPrefs().then(p => p && saveDesktopPrefs({ ...p, zoomPercent: clamped })).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    getDesktopInfo().then(info => {
      if (!info) return;
      setBackendInfo(info.backend || null);
      if (info.prefs?.zoomPercent) applyZoom(info.prefs.zoomPercent, false);
    }).catch(() => {});
    let unlisten = null;
    listenDesktop('axiom://backend-status', event => {
      if (event.payload) setBackendInfo(event.payload);
    }).then(fn => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [applyZoom]);

  const confirmLeaveDirty = useCallback(() => {
    if (!dirty.current) return Promise.resolve(true);
    return confirm({
      title: 'Unsaved changes',
      message: 'Leave this editor without saving? Your draft is kept locally for recovery.',
      confirmLabel: 'Leave without saving',
      danger: true,
    });
  }, [confirm]);

  const commitNavigate = useCallback((next, mode = 'push', { newTab = false, targetTabId = null } = {}) => {
    clearTimeout(timer.current);
    dirty.current = false;
    setExternalChangedPath('');
    if (['kind', 'path', 'edit', 'id'].some(key => next[key] !== routeRef.current[key]) || (next.kind === 'project' && next.mode !== routeRef.current.mode)) {
      setLoading(true);
    }
    routeRef.current = next;
    if (mode !== 'none') history[mode === 'replace' ? 'replaceState' : 'pushState']({}, '', routeUrl(next));
    setQuery(next.kind === 'search' ? next.query : '');
    setVisible(48);
    setRoute(next);

    if (targetTabId) {
      setActiveTabId(targetTabId);
      setTabs(prev => setTabDirty(prev, targetTabId, false));
    } else {
      const title = routeTitle(next, catalog?.notes || [], catalog?.projects || []);
      const res = openTab(tabsRef.current, activeTabRef.current, next, title, { newTab });
      setTabs(res.tabs);
      setActiveTabId(res.activeId);
    }
    return true;
  }, [catalog]);

  const navigate = useCallback((next, mode = 'push', bypass = false, options = {}) => {
    const sameEditor = next.kind === 'note' && routeRef.current.kind === 'note' && next.path === routeRef.current.path && next.edit && routeRef.current.edit;
    if (sameEditor || bypass || !dirty.current || options.newTab) {
      return commitNavigate(next, mode, options);
    }
    confirmLeaveDirty().then(ok => {
      if (ok) commitNavigate(next, mode, options);
      else setQuery(routeRef.current.kind === 'search' ? routeRef.current.query : '');
    });
    return false;
  }, [commitNavigate, confirmLeaveDirty]);

  useEffect(() => {
    if (!isDesktop()) return;
    setDirtyTabCount(tabs.filter(t => t.dirty).length).catch(() => {});
  }, [tabs]);

  useEffect(() => {
    if (detached || !catalog?.vaultId) return;
    const key = `tabs:${catalog.vaultId}`;
    writeBucketState('session', key, JSON.stringify({ tabs: tabs.map(t => ({ ...t, dirty: false })), activeId: activeTabId, splitPercent })).catch(() => {});
  }, [tabs, activeTabId, splitPercent, catalog?.vaultId, detached]);

  const hydratedTabs = useRef(false);
  useEffect(() => {
    if (detached || hydratedTabs.current || !catalog?.vaultId) return;
    hydratedTabs.current = true;
    const key = `tabs:${catalog.vaultId}`;
    readBucketState('session', key, () => null).then(raw => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (Number.isFinite(parsed.splitPercent)) {
          setSplitPercent(Math.max(25, Math.min(70, parsed.splitPercent)));
        }
        if (Array.isArray(parsed.tabs) && parsed.tabs.length) {
          const initial = routeFrom();
          if (initial.kind === 'overview') {
            const target = parsed.tabs.find(t => t.id === parsed.activeId) || parsed.tabs[0];
            setTabs(parsed.tabs);
            setActiveTabId(target.id);
            if (target.route && target.route.kind !== 'overview') {
              commitNavigate(target.route, 'replace', { targetTabId: target.id });
            }
          } else {
            const res = openTab(parsed.tabs, parsed.activeId, initial, routeTitle(initial, catalog.notes, catalog.projects), { newTab: true });
            setTabs(res.tabs);
            setActiveTabId(res.activeId);
          }
        }
      } catch {}
    }).catch(() => {});
  }, [catalog, detached, commitNavigate]);

  useEffect(() => {
    const unsub = subscribeVaultEvents({
      onStatus: setSseStatus,
      onCatalog: payload => {
        const changed = Array.isArray(payload?.changedPaths) ? payload.changedPaths : [];
        const current = routeRef.current;
        if (current.kind === 'note' && current.edit && dirty.current && changed.includes(current.path)) {
          setExternalChangedPath(current.path);
          return;
        }
        if (current.kind === 'note' && !current.edit && (!changed.length || changed.includes(current.path))) {
          setRefresh(n => n + 1);
        }
      },
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!isDesktop() || detached) return;
    const unsubs = [];
    listenDesktop('axiom://navigate', event => {
      if (typeof event.payload === 'string') {
        navigate(routeFrom(new URL(event.payload, location.href)), 'push', false, { newTab: true });
      }
    }).then(fn => unsubs.push(fn));
    listenDesktop('axiom://confirm-close', async () => {
      const ok = await confirm({
        title: 'Unsaved changes',
        message: 'You have unsaved editor changes. Quit Axiom without saving?',
        confirmLabel: 'Quit anyway',
        danger: true,
      });
      if (ok) quitDesktop();
    }).then(fn => unsubs.push(fn));
    listenDesktop('axiom://backup-created', () => {
      setRefresh(n => n + 1);
    }).then(fn => unsubs.push(fn));
    listenDesktop('axiom://update-available', event => {
      if (event.payload) setUpdateInfo(event.payload);
    }).then(fn => unsubs.push(fn));
    listenDesktop('axiom://open-settings', () => {
      setSettingsOpen(true);
    }).then(fn => unsubs.push(fn));
    return () => { unsubs.forEach(fn => fn()); };
  }, [detached, navigate, confirm]);

  useEffect(() => {
    const pop = () => {
      const next = routeFrom();
      if (JSON.stringify(next) === JSON.stringify(routeRef.current)) return;
      navigate(next, 'none');
    };
    const unload = event => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    const mouseNav = event => {
      if (event.button === 3) { event.preventDefault(); history.back(); }
      else if (event.button === 4) { event.preventDefault(); history.forward(); }
    };
    window.addEventListener('popstate', pop);
    window.addEventListener('beforeunload', unload);
    window.addEventListener('mouseup', mouseNav);
    return () => {
      window.removeEventListener('popstate', pop);
      window.removeEventListener('beforeunload', unload);
      window.removeEventListener('mouseup', mouseNav);
      clearTimeout(timer.current);
    };
  }, [navigate]);

  useEffect(() => {
    const id = ++request.current;
    setLoading(true);
    setError('');
    setReviewError('');
    setData(null);
    (async () => {
      try {
        const cat = await api('/api/catalog');
        if (id !== request.current) return;
        setCatalog(cat);
        let result = null;
        if (route.kind === 'note') result = await api('/api/note?path=' + encodeURIComponent(route.path));
        else if (route.kind === 'overview' && cat.notes.some(n => n.path === 'Home.md')) result = await api('/api/note?path=Home.md');
        if (id !== request.current) return;
        setData(result);
        setLoading(false);
        const resolvedTitle = routeTitle(route, cat.notes, cat.projects);
        setTabs(prev => prev.map(t => (t.id === activeTabRef.current ? { ...t, title: resolvedTitle } : t)));
        if (route.kind === 'note' && !route.edit && result?.note?.path === route.path && cat.vaultId) {
          const key = 'axiom-recent-notes:' + cat.vaultId;
          try {
            const stored = JSON.parse(localStorage.getItem(key) || '[]');
            const paths = [route.path, ...(Array.isArray(stored) ? stored.filter(p => typeof p === 'string' && p !== route.path) : [])].slice(0, 20);
            localStorage.setItem(key, JSON.stringify(paths));
            setRecent({ vaultId: cat.vaultId, paths, error: '' });
          } catch {
            setRecent(previous => ({ vaultId: cat.vaultId, paths: [route.path, ...(previous.vaultId === cat.vaultId ? previous.paths.filter(p => p !== route.path) : [])].slice(0, 20), error: 'Recent notes could not be saved on this device.' }));
          }
        }
      } catch (e) {
        if (id === request.current) { setError(e.message || 'Unable to read the vault.'); setLoading(false); }
      }
    })();
    return () => { request.current++; };
  }, [route.kind, route.path, route.edit, route.id, route.kind === 'project' ? route.mode : null, refresh]);

  useEffect(() => {
    if (route.kind !== 'note' || route.edit || !data || data.note.path !== route.path || !route.hash) return;
    let id;
    try { id = decodeURIComponent(route.hash.slice(1)); } catch { return; }
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
  const loose = notes.filter(unmapped);
  if (loose.length) groups.push({ id: '__unmapped', name: names.__unmapped || 'Unmapped notes', icon: workspaceIcons.__unmapped, group: workspaceGroups.__unmapped || 'work', notes: loose });
  groups.sort((a, b) => Number(a.group === 'home') - Number(b.group === 'home'));

  const pending = latest(notes.filter(pendingReview));
  const reviewFilters = { workspace: route.reviewWorkspace || 'all', kind: route.reviewKind || 'all' };
  const reviewScope = { reviewWorkspace: reviewFilters.workspace, reviewKind: reviewFilters.kind };
  const matchesReviewFilter = note => (reviewFilters.workspace === 'all' || (unmapped(note) ? '__unmapped' : note.project) === reviewFilters.workspace) && (reviewFilters.kind === 'all' || (note.reviewKind || 'new') === reviewFilters.kind);
  const scopedPending = pending.filter(matchesReviewFilter);
  const collection = route.kind === 'search' ? (data?.items || []) : latest(notes.filter(n => route.kind === 'owner' ? n.owner === 'owner' : route.kind === 'agent' ? n.owner === 'agent' : route.kind === 'review' ? pendingReview(n) : route.kind === 'proposals' ? proposal(n) : route.kind === 'project' ? (route.id === '__unmapped' ? unmapped(n) : n.project === route.id) : true));

  const refreshView = () => {
    confirmLeaveDirty().then(ok => {
      if (ok) { dirty.current = false; setRefresh(n => n + 1); }
    });
  };

  const handleClick = event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
    const href = link.getAttribute('href');
    if (href.startsWith('#') && routeRef.current.kind !== 'note') return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== '/') return;
    event.preventDefault();
    navigate(routeFrom(url), 'push', false, { newTab: event.ctrlKey || event.metaKey });
  };

  const save = (note, html) => {
    dirty.current = false;
    setExternalChangedPath('');
    setTabs(prev => setTabDirty(prev, activeTabRef.current, false));
    const next = { ...routeRef.current, kind: 'note', path: note.path, edit: true };
    routeRef.current = next;
    history.replaceState({}, '', routeUrl(next));
    setCatalog(c => c ? { ...c, notes: [...c.notes.filter(n => n.path !== note.path), note] } : c);
    setData({ note, html });
    setRoute(next);
    api('/api/catalog').then(setCatalog).catch(e => setError(e.message));
  };

  const stepReview = useCallback((delta = 1, items = scopedPending, current = data?.note?.path) => {
    if (!items.length) { navigate({ kind: 'review', ...reviewScope }); return; }
    const index = items.findIndex(n => n.path === current);
    const nextIdx = index < 0 ? 0 : (index + delta + items.length) % items.length;
    const next = items[nextIdx];
    navigate(next ? { kind: 'note', path: next.path, ...reviewScope } : { kind: 'review', ...reviewScope });
  }, [scopedPending, data?.note?.path, navigate, reviewScope]);

  const review = useCallback(async (decision, advance) => {
    if (reviewBusy || !data?.note) return;
    const ok = await confirmLeaveDirty();
    if (!ok) return;
    setReviewBusy(true);
    setReviewError('');
    try {
      const result = await apiMutate('/api/note-review', {
        method: 'PUT',
        body: { path: data.note.path, expectedRevision: data.note.revision, decision },
      });
      if (routeRef.current.kind === 'note' && routeRef.current.path === result.note.path && !routeRef.current.edit) setData(result);
      setCatalog(c => c ? { ...c, notes: c.notes.map(n => n.path === result.note.path ? { ...n, ...result.note } : n) } : c);
      try {
        const fresh = await api('/api/catalog');
        setCatalog(fresh);
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
    } catch (e) {
      setReviewError(e.status === 409 ? 'This note changed since you opened it. Refresh before reviewing.' : (e.message || 'Could not save review. Try again.'));
    } finally {
      setReviewBusy(false);
    }
  }, [reviewBusy, data, confirmLeaveDirty, matchesReviewFilter, scopedPending, navigate, reviewScope]);

  const selectTab = useCallback(tabId => {
    const target = tabsRef.current.find(t => t.id === tabId);
    if (!target || target.id === activeTabRef.current) return;
    navigate(target.route, 'push', false, { targetTabId: target.id });
  }, [navigate]);

  const handleCloseTab = useCallback(async tabId => {
    const target = tabsRef.current.find(t => t.id === tabId);
    if (target?.dirty) {
      const ok = await confirm({
        title: 'Close tab with unsaved changes',
        message: `Close "${target.title}"? Your draft is kept locally for recovery.`,
        confirmLabel: 'Close tab',
        danger: true,
      });
      if (!ok) return;
    }
    const res = closeTab(tabsRef.current, activeTabRef.current, tabId);
    setTabs(res.tabs);
    const nextTab = res.tabs.find(t => t.id === res.activeId);
    if (nextTab && res.activeId !== activeTabRef.current) {
      commitNavigate(nextTab.route, 'push', { targetTabId: nextTab.id });
    } else if (tabsRef.current.length <= 1 && nextTab) {
      commitNavigate(nextTab.route, 'push', { targetTabId: nextTab.id });
    }
  }, [confirm, commitNavigate]);

  const handleCloseOtherTabs = useCallback(keepId => {
    const kept = tabsRef.current.find(t => t.id === keepId);
    if (!kept) return;
    const clean = tabsRef.current.filter(t => t.id === keepId || t.dirty);
    setTabs(clean);
    if (activeTabRef.current !== keepId) {
      commitNavigate(kept.route, 'push', { targetTabId: keepId });
    }
  }, [commitNavigate]);

  const handleDuplicateTab = useCallback(tab => {
    if (!tab) return;
    const created = createTab(tab.route, tab.title);
    setTabs(prev => [...prev, created].slice(-24));
    commitNavigate(tab.route, 'push', { targetTabId: created.id });
  }, [commitNavigate]);

  const toggleSplit = useCallback(() => {
    setSplitRoute(prev => prev ? null : (routeRef.current.kind === 'note' ? { kind: 'note', path: routeRef.current.path } : { kind: 'project', id: '__all', mode: 'graph' }));
  }, []);

  const handleDesktopAction = useCallback(action => {
    if (action === 'toggle-split') toggleSplit();
    else if (action === 'pop-out') openDetachedWindow(routeUrl(routeRef.current), routeTitle(routeRef.current, notes, projects));
    else if (action === 'open-vault') revealInExplorer('vault');
    else if (action === 'open-settings') setSettingsOpen(true);
    else if (action === 'reset-zoom') applyZoom(100);
  }, [toggleSplit, notes, projects, applyZoom]);

  const startSplitResize = event => {
    event.preventDefault();
    setDraggingSplit(true);
    const onMove = moveEvent => {
      const container = splitWorkspaceRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (!rect.width) return;
      const rightPct = ((rect.right - moveEvent.clientX) / rect.width) * 100;
      setSplitPercent(Math.round(Math.max(25, Math.min(70, rightPct))));
    };
    const onUp = () => {
      setDraggingSplit(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  useEffect(() => {
    const keys = event => {
      const mod = event.ctrlKey || event.metaKey;
      const modalOpen = Boolean(document.querySelector('dialog[open]'));
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(open => !open);
        return;
      }
      if (event.altKey && !mod && event.key === 'ArrowLeft') {
        event.preventDefault();
        history.back();
        return;
      }
      if (event.altKey && !mod && event.key === 'ArrowRight') {
        event.preventDefault();
        history.forward();
        return;
      }
      if (mod && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key) && !detached && !modalOpen) {
        const idx = Number(event.key) - 1;
        const target = tabsRef.current[idx];
        if (target) {
          event.preventDefault();
          selectTab(target.id);
        }
        return;
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 't' && !detached && !modalOpen) {
        event.preventDefault();
        navigate({ kind: 'overview' }, 'push', true, { newTab: true });
        return;
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'w' && !detached && !modalOpen) {
        event.preventDefault();
        handleCloseTab(activeTabRef.current);
        return;
      }
      if (mod && event.key === 'Tab' && !detached && !modalOpen) {
        event.preventDefault();
        const nextId = nextTabId(tabsRef.current, activeTabRef.current, event.shiftKey ? -1 : 1);
        selectTab(nextId);
        return;
      }
      if (isDesktop() && mod && (event.key === '=' || event.key === '+')) {
        event.preventDefault();
        applyZoom(zoomPercent + 10);
        return;
      }
      if (isDesktop() && mod && event.key === '-') {
        event.preventDefault();
        applyZoom(zoomPercent - 10);
        return;
      }
      if (isDesktop() && mod && event.key === '0') {
        event.preventDefault();
        applyZoom(100);
        return;
      }
      if (event.key === 'Escape' && document.activeElement === input.current && input.current.value) {
        event.preventDefault();
        navigate({ kind: 'overview' }, 'replace');
        return;
      }

      const activeEl = document.activeElement;
      const inInput = activeEl && (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName) || activeEl.isContentEditable || activeEl.closest?.('.cm-editor'));
      if (!mod && !event.altKey && !inInput && !modalOpen) {
        if (event.key === '/' && input.current) {
          event.preventDefault();
          input.current.focus();
          input.current.select();
          return;
        }
        if (routeRef.current.kind === 'note' && !routeRef.current.edit && data?.note) {
          const k = event.key.toLowerCase();
          if (data.note.owner === 'agent') {
            if (k === 'j') { event.preventDefault(); stepReview(1); }
            else if (k === 'k') { event.preventDefault(); stepReview(-1); }
            else if (k === 'a' && data.note.reviewStatus !== 'reviewed') { event.preventDefault(); review('reviewed', true); }
            else if (k === 'd') {
              const el = document.querySelector('section#axiom-review-comparison');
              if (el) { event.preventDefault(); el.scrollIntoView({ behavior: 'smooth' }); }
            }
          }
          if (k === 'e') {
            event.preventDefault();
            navigate({ kind: 'note', path: data.note.path, edit: true, ...reviewScope });
          }
        }
      }
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  }, [detached, navigate, handleCloseTab, selectTab, applyZoom, zoomPercent, data, stepReview, review, reviewScope]);

  const statusMetrics = React.useMemo(() => {
    if (route.kind === 'note' && route.edit && editorStats) return editorStats;
    if (route.kind === 'note' && data?.note?.content) {
      const words = data.note.content.trim() ? data.note.content.trim().split(/\s+/).length : 0;
      return { words, revision: data.note.revision };
    }
    return null;
  }, [route.kind, route.edit, editorStats, data?.note]);

  const nav = [['overview', 'Overview', LayoutDashboard], ['all', 'All notes', FileText], ['owner', 'Your notes', UserRound], ['agent', 'Agent memory', Bot], ['review', 'Review queue', Inbox], ['projects', 'Workspaces', FolderKanban], ['cleanup', 'Clean up', ScanSearch], ['trash', 'Trash', Trash2]];

  let content;
  if (loading) content = <div className="boot">Reading your vault…</div>;
  else if (error && !data && route.kind !== 'new') content = <><h1>Could not load this view</h1><p className="muted">Your source files have not been changed.</p><button className="button" onClick={refreshView}>Try again</button></>;
  else if (route.kind === 'new' || (route.kind === 'note' && route.edit && data)) {
    content = (
      <Suspense fallback={<div className="boot">Opening editor...</div>}>
        <MarkdownEditor
          key={JSON.stringify([catalog?.vaultId, route.kind === 'new' ? null : route.path])}
          initialNote={route.kind === 'new' ? null : data.note}
          notes={notes}
          vaultName={vault}
          vaultId={catalog?.vaultId}
          externalChanged={externalChangedPath === (route.kind === 'new' ? '' : route.path)}
          onSaved={save}
          onStatsChange={setEditorStats}
          onDirtyChange={value => {
            dirty.current = value;
            setTabs(prev => setTabDirty(prev, activeTabRef.current, value));
          }}
          onCancel={() => navigate(route.kind === 'new' ? { kind: 'overview' } : { ...route, edit: false })}
        />
      </Suspense>
    );
  }
  else if (route.kind === 'note' && data) {
    content = (
      <Reader
        key={JSON.stringify([catalog?.vaultId, data.note.path])}
        data={data}
        notes={notes}
        vaultName={vault}
        groups={groups}
        reviewScope={reviewScope}
        onReview={review}
        reviewBusy={reviewBusy}
        reviewError={reviewError}
        onNext={() => stepReview(1)}
        onPrev={() => stepReview(-1)}
        onDelete={() => setManagement('note')}
        onOpenNote={p => navigate({ kind: 'note', path: p })}
        onOpenSplit={r => setSplitRoute(r)}
        onRestored={({ note, html }) => {
          setCatalog(c => c ? { ...c, notes: c.notes.map(n => n.path === note.path ? note : n) } : c);
          if (routeRef.current.kind === 'note' && !routeRef.current.edit && routeRef.current.path === note.path) setData({ note, html });
        }}
      />
    );
  }
  else if (route.kind === 'overview') content = <Overview notes={notes} groups={groups} data={data} activity={activity} setActivity={setActivity} />;
  else if (route.kind === 'trash') content = <Trash onRestored={() => api('/api/catalog').then(setCatalog).catch(e => setError(e.message))} />;
  else if (route.kind === 'search') content = <><PageHeading title="Search results" description={`Matches for “${route.query}” in ${route.scope === 'active' ? 'active knowledge' : 'all notes'}.`} /><SearchResults key={JSON.stringify([route.query, route.workspace, route.owner, route.review, route.scope, route.mode])} query={route.query} groups={groups} filters={{ workspace: route.workspace || '', owner: route.owner || '', review: route.review || '', scope: route.scope || 'all', mode: route.mode || 'hybrid' }} onFiltersChange={filters => navigate({ ...route, ...filters })} /></>;
  else if (route.kind === 'health') content = <><PageHeading title="Memory health" description="Actionable findings, with uncertainty and provenance preserved." /><p><a className="button" href={routeUrl({ kind: 'cleanup' })}>Clean up notes <ArrowRight size={16} aria-hidden="true" /></a></p><MemoryHealth groups={groups} onOpenNote={p => navigate({ kind: 'note', path: p })} /></>;
  else if (route.kind === 'cleanup') content = <Cleanup vaultId={catalog?.vaultId} groups={groups} onCatalogChanged={() => api('/api/catalog').then(value => { if (routeRef.current.kind === 'cleanup') setCatalog(value); }).catch(e => { if (routeRef.current.kind === 'cleanup') setError(e.message); })} />;
  else if (route.kind === 'usage') content = <UsagePage groups={groups} />;
  else if (route.kind === 'harnesses') content = <HarnessPage />;
  else if (route.kind === 'recovery') content = <RecoveryPage />;
  else if (route.kind === 'projects') content = <><div className="page-heading"><div><p className="eyebrow">Library</p><h1>Workspaces</h1><p className="page-description">Explore notes and their connections by workspace.</p></div><a className="button button-soft" href="/?project=__all&mode=graph"><Network size={17} aria-hidden="true" /> Full-vault graph</a></div>{['work', 'home'].map(folder => <section className="workspace-card-group" key={folder}><h2>{folder === 'home' ? 'Home' : 'Work'}</h2><div className="project-grid project-grid-full">{groups.filter(g => g.group === folder).map(g => <ProjectCard key={g.id} group={g} />)}</div></section>)}</>;
  else if (route.kind === 'project') {
    const isAll = route.id === '__all';
    content = (
      <>
        <div className="workspace-heading">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1 className="workspace-heading-title"><WorkspaceIcon name={workspaceIcons[route.id] ?? projects.find(p => p.id === route.id)?.icon} size={28} />{projectLabel(route.id, groups)}</h1>
            <p className="page-description">{isAll ? `${notes.length} notes across all workspaces` : `${collection.length} ${collection.length === 1 ? 'note' : 'notes'} in this workspace`}</p>
          </div>
          {!isAll && <button className="button" onClick={() => setManagement('workspace')}><Settings size={17} aria-hidden="true" /> Settings</button>}
        </div>
        {!isAll && (
          <nav className="workspace-modes" aria-label="Workspace view">
            <a className={route.mode === 'overview' ? 'active' : ''} aria-current={route.mode === 'overview' ? 'page' : undefined} href={routeUrl({ kind: 'project', id: route.id })}><LayoutDashboard size={18} aria-hidden="true" />Overview</a>
            <a className={route.mode === 'graph' ? 'active' : ''} aria-current={route.mode === 'graph' ? 'page' : undefined} href={routeUrl({ kind: 'project', id: route.id, mode: 'graph' })}><Network size={18} strokeWidth={1.7} aria-hidden="true" />Graph</a>
            <a className={route.mode === 'notes' ? 'active' : ''} aria-current={route.mode === 'notes' ? 'page' : undefined} href={routeUrl({ kind: 'project', id: route.id, mode: 'notes' })}><List size={18} strokeWidth={1.7} aria-hidden="true" />Notes</a>
          </nav>
        )}
        {!isAll && route.mode === 'overview'
          ? <WorkspaceOverview key={route.id} id={route.id} label={projectLabel(route.id, groups)} onOpenNote={p => navigate({ kind: 'note', path: p })} />
          : !isAll && route.mode === 'notes'
            ? <Library collection={collection} visible={visible} setVisible={setVisible} />
            : <Suspense fallback={<div className="boot">Opening workspace graph…</div>}><WorkspaceGraph project={route.id} label={projectLabel(route.id, groups)} vaultName={vault} onOpenNote={p => navigate({ kind: 'note', path: p })} onOpenSplit={r => setSplitRoute(r)} /></Suspense>}
      </>
    );
  }
  else if (route.kind === 'review' || route.kind === 'proposals') content = <><PageHeading title="Review queue" description="Check agent notes without promoting them to owner policy." /><nav className="filter-links" aria-label="Review collection"><a className={route.kind === 'review' ? 'active' : ''} href={routeUrl({ kind: 'review', ...reviewScope })}>Unreviewed · {pending.length}</a><a className={route.kind === 'proposals' ? 'active' : ''} href={routeUrl({ kind: 'proposals' })}>Proposals · {notes.filter(proposal).length}</a></nav>{route.kind === 'review' ? <ReviewInbox notes={pending} groups={groups} filters={reviewFilters} onFiltersChange={filters => navigate({ kind: 'review', reviewWorkspace: filters.workspace, reviewKind: filters.kind })} onOpenNote={p => navigate({ kind: 'note', path: p, ...reviewScope })} /> : <Library collection={collection} visible={visible} setVisible={setVisible} />}</>;
  else content = <><PageHeading title={labels[route.kind]} description="A shared library, with ownership and provenance intact." /><div className="library-toolbar"><div className="filter-links">{[['all', 'Everything'], ['owner', 'Your notes'], ['agent', 'Agent memory'], ['proposals', 'Proposals']].map(([kind, label]) => <a key={kind} className={route.kind === kind ? 'active' : ''} href={routeUrl({ kind })}>{label}</a>)}</div><span className="result-count">{collection.length} {collection.length === 1 ? 'note' : 'notes'}</span></div><Library collection={collection} visible={visible} setVisible={setVisible} /></>;

  const desktopShell = !detached && isDesktop();
  const activeNoteScope = data?.note
    ? (data.note.project !== 'global' && !groups.some(g => g.id === data.note.project) ? '__unmapped' : data.note.project)
    : null;
  const topbarLabel = route.kind === 'project'
    ? <><WorkspaceIcon name={workspaceIcons[route.id] ?? projects.find(p => p.id === route.id)?.icon} />{projectLabel(route.id, groups)}</>
    : route.kind === 'note' && activeNoteScope
      ? <><WorkspaceIcon name={workspaceIcons[activeNoteScope] ?? projects.find(p => p.id === activeNoteScope)?.icon} />{projectLabel(activeNoteScope, groups)}</>
      : route.kind !== 'overview'
        ? routeTitle(route, notes, projects)
        : '';

  const titleBarEl = (
    <TitleBar
      tabs={tabs}
      activeId={activeTabId}
      splitOpen={Boolean(splitRoute)}
      detached={detached}
      label={detached ? `Axiom - ${routeTitle(route, notes, projects)}` : 'Axiom'}
      onSelectTab={selectTab}
      onCloseTab={handleCloseTab}
      onCloseOtherTabs={handleCloseOtherTabs}
      onDuplicateTab={handleDuplicateTab}
      onNewTab={() => navigate({ kind: 'overview' }, 'push', true, { newTab: true })}
      onToggleSplit={toggleSplit}
      onOpenTabInSplit={tab => { if (tab?.route) setSplitRoute(tab.route.kind === 'note' ? { kind: 'note', path: tab.route.path } : tab.route); }}
      onPopOut={() => openDetachedWindow(routeUrl(route), routeTitle(route, notes, projects))}
      onPopOutTab={tab => { if (tab?.route) openDetachedWindow(routeUrl(tab.route), tab.title); }}
      onOpenQuick={detached ? null : () => toggleQuickOverlay()}
      onOpenSettings={detached ? null : () => setSettingsOpen(true)}
      onBack={() => history.back()}
      onForward={() => history.forward()}
    />
  );

  const shellEl = (
    <div className={detached ? 'app-shell-detached' : 'app-shell'} onClick={handleClick}>
      {!detached && (
        <>
          <a className="skip" href="#main">Skip to content</a>
          <aside className="sidebar" aria-label="Vault navigation">
            <a className="brand" href="/"><img className="brand-icon-img" src={AXIOM_ICON_DATA_URI} alt="" /><span>Axiom<small>PERSONAL KNOWLEDGE</small></span></a>
            <nav className="main-nav" aria-label="Library">{nav.map(([kind, label, Icon]) => <a key={kind} className={route.kind === kind || (kind === 'review' && route.kind === 'proposals') ? 'active' : ''} aria-current={route.kind === kind || (kind === 'review' && route.kind === 'proposals') ? 'page' : undefined} href={routeUrl({ kind })}><Icon className="nav-icon" size={18} strokeWidth={1.7} aria-hidden="true" />{label}{!['overview', 'projects', 'trash', 'cleanup'].includes(kind) && <span className="nav-count">{kind === 'all' ? notes.length : kind === 'review' ? pending.length : notes.filter(n => n.owner === kind).length}</span>}</a>)}</nav>
            <nav className="utility-nav" aria-label="Knowledge tools">{[['health', 'Health', Activity], ['usage', 'Usage', List], ['harnesses', 'Harnesses', Plug], ['recovery', 'Backups', DatabaseBackup]].map(([kind, label, Icon]) => <a key={kind} href={routeUrl({ kind })} aria-current={route.kind === kind ? 'page' : undefined}><Icon size={16} aria-hidden="true" />{label}</a>)}</nav>
            <div className="sidebar-section"><span>WORKSPACES</span><a href="/?project=__all&mode=graph">Graph <Network size={14} aria-hidden="true" /></a></div>
            <nav className="project-nav" aria-label="Workspaces">{['work', 'home'].map(folder => <div key={folder}><button className="workspace-folder" type="button" aria-expanded={!collapsed[folder]} onClick={() => { const next = { ...collapsed, [folder]: !collapsed[folder] }; setCollapsed(next); try { localStorage.setItem('axiom-workspace-folders', JSON.stringify(next)); } catch {} }}><ChevronRight size={16} className={collapsed[folder] ? '' : 'expanded'} aria-hidden="true" />{folder === 'home' ? 'Home' : 'Work'}</button>{!collapsed[folder] && groups.filter(g => g.group === folder).map(g => <a key={g.id} className={route.kind === 'project' && route.id === g.id ? 'active' : ''} aria-current={route.kind === 'project' && route.id === g.id ? 'page' : undefined} href={routeUrl({ kind: 'project', id: g.id })}><WorkspaceIcon name={g.icon} />{projectLabel(g.id, groups)}<span className="nav-count">{g.notes.length}</span></a>)}</div>)}</nav>
            <div className="sidebar-bottom"><a className="guard-note" href={noteUrl('Owner/Policies.md')}><ShieldCheck size={18} strokeWidth={1.7} aria-hidden="true" /><span>Owner notes stay yours<small>Rule-level safeguards, not isolation</small></span></a><div className="connection"><span className="connection-dot" />{error ? 'Vault unavailable' : catalog ? (sseStatus === 'connected' ? 'Vault live' : 'Vault connected') : 'Connecting to vault'}</div></div>
          </aside>
        </>
      )}
      <main id="main" tabIndex="-1">
        {!detached && (
          <>
            <header className="topbar">
              <div className="workspace-title">{topbarLabel}</div>
              <label className="global-search"><Search size={18} strokeWidth={1.7} aria-hidden="true" /><span className="sr-only">Search the vault</span><input ref={input} type="search" value={query} placeholder="Search notes, decisions, ideas…" onChange={e => { const value = e.target.value; setQuery(value); clearTimeout(timer.current); timer.current = setTimeout(() => navigate(value.trim() ? { ...(routeRef.current.kind === 'search' ? routeRef.current : {}), kind: 'search', query: value } : { kind: 'overview' }, 'replace'), 160); }} /><kbd>/</kbd></label>
              <div className="topbar-actions">
                <Notifications catalog={catalog} groups={groups} pendingCount={pending.length} onCatalog={setCatalog} onOpenNote={p => { if (!navigate({ kind: 'note', path: p })) return false; setRefresh(value => value + 1); return true; }} onOpenReview={() => navigate({ kind: 'review' })} />
                <button className="icon-button" type="button" onClick={() => setPaletteOpen(true)} aria-label="Open command palette" title="Command palette · Ctrl+K"><Command size={18} aria-hidden="true" /></button>
                <button className="icon-button" type="button" onClick={refreshView} aria-label="Refresh vault" title="Refresh vault"><RefreshCw size={18} strokeWidth={1.7} aria-hidden="true" /></button>
                <a className="button button-primary" href="/?edit=1"><Plus size={18} strokeWidth={1.7} aria-hidden="true" /> New note</a>
              </div>
            </header>
            {!isDesktop() && (
              <TabBar
                tabs={tabs}
                activeId={activeTabId}
                splitOpen={Boolean(splitRoute)}
                onSelectTab={selectTab}
                onCloseTab={handleCloseTab}
                onNewTab={() => navigate({ kind: 'overview' }, 'push', true, { newTab: true })}
                onToggleSplit={toggleSplit}
              />
            )}
          </>
        )}
        <div
          ref={splitWorkspaceRef}
          className={splitRoute ? 'split-workspace' : undefined}
          style={splitRoute ? { '--split-width': `${splitPercent}%` } : undefined}
        >
          <div className="page-content">
            <div role="status" aria-live="polite">{error && <div className="error-notice">{error}</div>}</div>
            <div aria-busy={loading}>{content}</div>
          </div>
          {splitRoute && (
            <>
              <div
                className={`split-divider${draggingSplit ? ' split-divider-dragging' : ''}`}
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="Resize split pane"
                aria-valuenow={Math.round(splitPercent)}
                aria-valuemin={25}
                aria-valuemax={70}
                onPointerDown={startSplitResize}
                onDoubleClick={() => setSplitPercent(50)}
                onKeyDown={event => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    setSplitPercent(p => Math.min(70, p + 5));
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    setSplitPercent(p => Math.max(25, p - 5));
                  }
                }}
              />
              <SplitPane
                splitRoute={splitRoute}
                vaultName={vault}
                onClose={() => setSplitRoute(null)}
                onChangeSplitRoute={setSplitRoute}
                onOpenMainNote={p => navigate({ kind: 'note', path: p })}
              />
            </>
          )}
        </div>
        {management === 'note' && data?.note && <DeleteNote note={data.note} onClose={() => setManagement(null)} onDeleted={() => { setManagement(null); navigate({ kind: 'all' }); setRefresh(n => n + 1); }} />}
        {management === 'workspace' && <WorkspaceSettings key={route.id} id={route.id} onClose={() => setManagement(null)} onChanged={() => { setManagement(null); setRefresh(n => n + 1); }} onDeleted={() => { setManagement(null); navigate({ kind: 'projects' }); setRefresh(n => n + 1); }} />}
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onNavigate={url => navigate(routeFrom(new URL(url, location.href)))}
          onOpenNewTab={url => navigate(routeFrom(new URL(url, location.href)), 'push', true, { newTab: true })}
          onOpenSplit={setSplitRoute}
          onDesktopAction={handleDesktopAction}
          groups={groups}
          notes={notes}
          vaultId={catalog?.vaultId}
          recent={recent}
        />
        <DesktopSettings
          open={settingsOpen}
          groups={groups}
          pendingUpdate={updateInfo}
          onUpdateInfo={setUpdateInfo}
          onInstallUpdate={async () => {
            if (dirty.current || tabs.some(t => t.dirty)) {
              const ok = await confirm({
                title: 'Unsaved changes',
                message: 'You have unsaved editor changes. Download and restart Axiom to apply the update anyway?',
                confirmLabel: 'Update & restart',
                danger: true,
              });
              if (!ok) return;
            }
            await installDesktopUpdate();
          }}
          onClose={() => setSettingsOpen(false)}
          onZoomChange={z => applyZoom(z, false)}
          onRequestQuit={async () => {
            if (dirty.current || tabs.some(t => t.dirty)) {
              const ok = await confirm({
                title: 'Unsaved changes',
                message: 'You have unsaved editor changes. Quit Axiom without saving?',
                confirmLabel: 'Quit anyway',
                danger: true,
              });
              if (!ok) return;
            }
            quitDesktop();
          }}
        />
      </main>
    </div>
  );

  if (desktopShell) {
    return (
      <div className="desktop-frame">
        {dialog}
        {titleBarEl}
        {shellEl}
        <StatusBar
          sseStatus={sseStatus}
          backendInfo={backendInfo}
          updateInfo={updateInfo}
          stats={statusMetrics}
          pendingCount={pending.length}
          zoomPercent={zoomPercent}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenReview={() => navigate({ kind: 'review' })}
          onResetZoom={() => applyZoom(100)}
        />
      </div>
    );
  }

  return (
    <>
      {dialog}
      {titleBarEl}
      {shellEl}
    </>
  );
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
    <div className="page-heading"><div><p className="eyebrow">Your knowledge, together</p><h1>Overview</h1><p className="page-description">Notes, decisions, and context across your vault.</p></div><div className="heading-actions"><span className="page-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span><a className="button" href={routeUrl({ kind: 'cleanup' })}><ScanSearch size={17} aria-hidden="true" />Clean up</a></div></div>
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
