import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, FileText, Radio, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import WorkspaceIcon from './WorkspaceIcon.jsx';
import './UsageViews.css';

const filters = [['all', 'All'], ['hot', 'Hot'], ['recent', 'Recent'], ['stale-candidate', 'Stale candidates'], ['insufficient-history', 'Insufficient history']];
const statusLabels = { hot: 'Hot', recent: 'Recent', quiet: 'Quiet', 'insufficient-history': 'Insufficient history', 'stale-candidate': 'Stale candidate' };
const date = value => value ? new Date(value).toLocaleString() : 'Not recorded';
const relative = new Intl.RelativeTimeFormat(undefined, {numeric: 'always'});
const ageUnits = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
function UsageTime({value, now}) {
  if (!value) return 'Not recorded';
  const elapsed = (Date.parse(value) - now) / 1000;
  if (!Number.isFinite(elapsed)) return 'Unknown time';
  const [unit, size] = ageUnits.find(([, size]) => Math.abs(elapsed) >= size) || ['second', 1];
  return <time dateTime={value} title={date(value)}>{relative.format(Math.trunc(elapsed / size), unit)}</time>;
}

function useUsage() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0), [now, setNow] = useState(Date.now);
  const reload = useCallback(() => setRefresh(n => n + 1), []);
  useEffect(() => {
    let active = true, controller, running = false;
    const load = async () => {
      if (running) return;
      running = true;
      controller = new AbortController();
      try {
        const response = await fetch('/api/note-usage', { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
        if (active) { setData(result); setError(''); }
      } catch (e) { if (active && e.name !== 'AbortError') { setData(null); setError(e.message || 'Could not load note usage.'); } }
      finally { running = false; }
    };
    load();
    const wake = () => { if (document.visibilityState === 'visible') { setNow(Date.now()); load(); } };
    const timer = setInterval(wake, 5000);
    const clock = setInterval(() => { if (document.visibilityState === 'visible') setNow(Date.now()); }, 1000);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => { active = false; controller?.abort(); clearInterval(timer); clearInterval(clock); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [refresh]);
  return { data, error, reload, now };
}

function TrackingNotice({ tracking }) {
  return <details className="usage-coverage"><summary>How tracking works <ChevronDown size={14} aria-hidden="true" /></summary><div><p>Observation started {date(tracking.startedAt)}. Counts cover instrumented memory deliveries, not comprehension, ongoing use, browser browsing or raw filesystem reads. CLI and MCP callers are not independently identified.</p><p>Counts span today and the previous {tracking.hotDays - 1} UTC days; daily history is retained for {tracking.retentionDays} days. Hot means at least three full retrievals; Recent includes any delivery in {tracking.recentDays} days.</p><p>Stale candidates require {tracking.staleDays} days of observation, old content and no recorded delivery. Owner notes, pins and recognized references are protected. Insufficient history does not mean unused. Nothing is deleted automatically.</p></div></details>;
}

function UsageDetails({ usage, now }) {
  return <><div className="usage-counts" aria-label="Recorded deliveries over 30 UTC calendar days"><span><strong>{usage.reads30d}</strong> {usage.reads30d === 1 ? 'full retrieval' : 'full retrievals'}</span><span><strong>{usage.excerpts30d}</strong> {usage.excerpts30d === 1 ? 'excerpt' : 'excerpts'}</span><span><strong>{usage.context30d}</strong> {usage.context30d === 1 ? 'context load' : 'context loads'}</span><small>30 UTC days</small></div><p className="usage-evidence">Last full retrieval: <UsageTime value={usage.lastReadAt} now={now} /><br />Last delivery: <UsageTime value={usage.lastUsedAt} now={now} />{usage.lastSource ? ` · ${['cli', 'mcp'].includes(usage.lastSource) ? `${usage.lastSource.toUpperCase()} (caller not identified)` : usage.lastSource}` : ''}<br />Revision at last delivery: <code title={usage.lastRevision || undefined}>{usage.lastRevision?.slice(0, 12) || 'Not recorded'}</code></p>{usage.protectionReasons.length > 0 && <p className="usage-protection">Protected from stale classification: {usage.protectionReasons.join(', ')}</p>}</>;
}

export function UsageSummary({ path }) {
  const { data, error, reload, now } = useUsage();
  const note = data?.notes.find(item => item.path === path);
  return <section className="panel usage-summary"><div className="usage-summary-heading"><h2>Usage</h2><button className="button" type="button" onClick={reload} aria-label="Refresh note usage"><RefreshCw size={15} aria-hidden="true" /> Refresh</button></div>{error ? <p className="usage-error" role="alert">Usage unavailable: {error}</p> : !data ? <p className="muted">Loading usage…</p> : !data.tracking.healthy ? <p className="usage-error">Tracking unavailable{data.tracking.reason ? `: ${data.tracking.reason}` : '.'} Missing deliveries are not evidence of disuse.</p> : !note ? <p className="muted">This note is not in the usage inventory. Refresh to try again.</p> : <><span className="badge">{statusLabels[note.usage.status]}</span><UsageDetails usage={note.usage} now={now} /><p className="usage-summary-limit">Recorded deliveries only; not evidence of comprehension or ongoing use. Stale candidates require manual review.</p><a href="/?view=usage">View note usage</a></>}</section>;
}

export default function UsagePage({ groups }) {
  const { data, error, reload, now } = useUsage();
  const detailPrefix = useId();
  const [filter, setFilter] = useState('all'), [workspace, setWorkspace] = useState('all'), [query, setQuery] = useState(''), [visible, setVisible] = useState(48), [expanded, setExpanded] = useState(null);
  const groupById = useMemo(() => new Map(groups.map(group => [group.id, group])), [groups]);
  const scoped = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (data?.notes || []).filter(note => (workspace === 'all' || (workspace === '__unmapped' ? note.project === '__unmapped' || !groupById.has(note.project) : note.project === workspace)) && (!term || `${note.title} ${note.path}`.toLowerCase().includes(term)));
  }, [data, groupById, workspace, query]);
  const recent = note => note.usage.lastUsedAt && Date.parse(note.usage.lastUsedAt) >= now - data.tracking.recentDays * 86400000;
  const matches = (note, value) => value === 'all' || (value === 'recent' ? recent(note) : note.usage.status === value);
  const filtered = scoped.filter(note => matches(note, filter)).sort((a, b) => {
    if (filter === 'hot') return b.usage.reads30d - a.usage.reads30d || a.path.localeCompare(b.path);
    if (filter === 'stale-candidate') return (a.usage.lastUsedAt || a.usage.observedSince || '').localeCompare(b.usage.lastUsedAt || b.usage.observedSince || '') || a.path.localeCompare(b.path);
    return (b.usage.lastUsedAt || '').localeCompare(a.usage.lastUsedAt || '') || a.path.localeCompare(b.path);
  });
  const totals = useMemo(() => scoped.reduce((sum, note) => [sum[0] + note.usage.reads30d, sum[1] + note.usage.excerpts30d, sum[2] + note.usage.context30d], [0, 0, 0]), [scoped]);
  const healthy = data?.tracking.healthy;
  return <div className="usage-page">
    <header className="usage-page-heading"><div><p className="eyebrow">Knowledge tools</p><h1>Note usage</h1><p className="page-description">See what gets retrieved. Review what may no longer earn its place.</p></div><div className="usage-heading-actions">{healthy && <span className="usage-live"><Radio size={14} aria-hidden="true" /> Live · 5s updates</span>}<button className="button" type="button" onClick={reload} aria-label="Refresh usage"><RefreshCw size={16} aria-hidden="true" /> Refresh</button></div></header>
    {error ? <div className="error-notice" role="alert">Could not load note usage: {error}</div> : !data ? <p className="muted">Loading note usage…</p> : !healthy ? <div className="error-notice" role="alert"><strong>Tracking unavailable.</strong> {data.tracking.reason} Missing deliveries cannot establish that a note is unused.</div> : <>
      <section className="usage-pulse" aria-label="Deliveries for the current workspace and search across all statuses over 30 UTC calendar days">{[['Full retrievals', 'A complete note returned by a memory read'], ['Search excerpts', 'Note excerpts returned in search results'], ['Context loads', 'Automatic policy and reference context']].map(([label, description], index) => <div key={label}><span>{label}</span><strong title={description}>{totals[index].toLocaleString()}</strong></div>)}<div className="usage-window"><span>Count window</span><strong>30 <small>UTC days</small></strong></div></section>
      <div className="usage-context"><span>Recorded delivery, not proof of understanding.</span><TrackingNotice tracking={data.tracking} /></div>
      <section className="panel usage-collection" aria-label="Note activity">
        <div className="usage-toolbar"><div className="usage-filters" role="group" aria-label="Usage status">{filters.map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setVisible(48); }}>{label}<span>{scoped.filter(note => matches(note, value)).length}</span></button>)}</div>
          <div className="usage-controls"><label className="usage-search"><Search size={15} aria-hidden="true" /><span className="sr-only">Search title or path</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setVisible(48); }} placeholder="Find a note…" /></label><label><span className="sr-only">Workspace</span><select value={workspace} onChange={event => { setWorkspace(event.target.value); setVisible(48); }}><option value="all">All workspaces</option>{['work', 'home'].map(folder => <optgroup key={folder} label={folder === 'work' ? 'Work' : 'Home'}>{groups.filter(group => group.group === folder).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</optgroup>)}</select></label></div>
        </div>
        <div className="usage-table-wrap"><table className="usage-table"><caption className="sr-only">Note deliveries over 30 UTC calendar days. Expand a row for provenance and protection details.</caption><thead><tr><th scope="col">Note</th><th scope="col" className="usage-number">Full reads</th><th scope="col" className="usage-number">Excerpts</th><th scope="col" className="usage-number">Context</th><th scope="col">Last delivery</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Details</span></th></tr></thead><tbody>
          {filtered.slice(0, visible).map(note => {
            const usage = note.usage, group = groupById.get(note.project) || groupById.get('__unmapped'), open = expanded === note.path;
            const detailId = `${detailPrefix}-usage-detail-${Array.from(note.path, character => character.codePointAt(0).toString(16)).join('-')}`;
            return <React.Fragment key={note.path}><tr className={open ? 'usage-row expanded' : 'usage-row'}>
              <td className="usage-note-cell"><span className="usage-note-icon"><FileText size={17} aria-hidden="true" /></span><div><a href={'/?note=' + encodeURIComponent(note.path)} title={note.title}>{note.title}</a><span className="usage-note-meta"><WorkspaceIcon name={group?.icon} size={12} /><span>{group?.name || 'Unmapped notes'}</span><span aria-hidden="true">·</span>{note.owner === 'owner' ? 'Yours' : 'Agent'}</span></div></td>
              <td className="usage-number" data-label="Full reads">{usage.reads30d.toLocaleString()}</td><td className="usage-number" data-label="Excerpts">{usage.excerpts30d.toLocaleString()}</td><td className="usage-number" data-label="Context">{usage.context30d.toLocaleString()}</td>
              <td className="usage-last"><UsageTime value={usage.lastUsedAt} now={now} /><small>{['cli', 'mcp'].includes(usage.lastSource) ? `${usage.lastSource.toUpperCase()} · unidentified caller` : usage.lastSource || 'No recorded delivery'}</small></td>
              <td className="usage-status"><span className={'usage-state usage-state-' + usage.status}>{statusLabels[usage.status]}</span>{usage.protectionReasons.length > 0 && <ShieldCheck size={14} aria-label="Protected from stale classification" role="img"><title>{usage.protectionReasons.join(', ')}</title></ShieldCheck>}</td>
              <td className="usage-expand-cell"><button type="button" className="usage-expand" aria-label={`Details for ${note.title}`} aria-expanded={open} aria-controls={detailId} onClick={() => setExpanded(open ? null : note.path)}><ChevronDown size={16} aria-hidden="true" /></button></td>
            </tr><tr id={detailId} className="usage-detail-row" hidden={!open}><td colSpan={7}>{open && <><dl className="usage-detail-grid"><div className="usage-detail-path"><dt>Source path</dt><dd><code>{note.path}</code></dd></div><div><dt>Last full retrieval</dt><dd><UsageTime value={usage.lastReadAt} now={now} /></dd></div><div><dt>Last search excerpt</dt><dd><UsageTime value={usage.lastExcerptAt} now={now} /></dd></div><div><dt>Last context load</dt><dd><UsageTime value={usage.lastContextAt} now={now} /></dd></div><div><dt>Observed since</dt><dd>{date(usage.observedSince)}</dd></div><div className="usage-detail-path"><dt>Revision at last delivery</dt><dd><code>{usage.lastRevision || 'Not recorded'}</code></dd></div></dl><p className="usage-detail-protection"><ShieldCheck size={14} aria-hidden="true" />{usage.protectionReasons.length ? `Protected: ${usage.protectionReasons.join(', ')}` : 'No automatic protection identified. This is not approval to delete the note.'}</p></>}</td></tr></React.Fragment>;
          })}
        </tbody></table>{!filtered.length && <div className="usage-empty"><Search size={24} aria-hidden="true" /><h2>{filter === 'stale-candidate' ? 'No stale candidates' : 'No matching notes'}</h2><p>{filter === 'stale-candidate' ? `Cleanup candidates need ${data.tracking.staleDays} days of history. A new tracker cannot establish that older notes are unused.` : 'Try another status, workspace, or search.'}</p></div>}</div>
        <footer className="usage-table-footer"><span>{Math.min(visible, filtered.length)} of {filtered.length} notes <span aria-hidden="true">·</span> Cleanup always requires manual review.</span>{visible < filtered.length && <button className="button" type="button" onClick={() => setVisible(count => count + 48)}>Show more</button>}</footer>
      </section>
    </>}
  </div>;
}
