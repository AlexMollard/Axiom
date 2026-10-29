import {useEffect, useState} from 'react';
import './ReviewInbox.css';

const labels = {new: 'New', changed: 'Changed', reopened: 'Reopened', reviewed: 'Reviewed'};

export function ReviewInbox({notes, groups, filters, onFiltersChange, onOpenNote}) {
  const {workspace, kind} = filters;
  const [limit, setLimit] = useState(48);
  const changeFilters = next => { setLimit(48); onFiltersChange(next); };
  const pending = notes.filter(note => note.owner === 'agent' && note.reviewStatus === 'unreviewed' && !['archived', 'superseded'].includes((note.status || '').toLowerCase()));
  const scope = note => note.project === 'global' || groups.some(group => group.id === note.project) ? note.project : '__unmapped';
  const visible = pending.filter(note => (workspace === 'all' || scope(note) === workspace) && (kind === 'all' || (note.reviewKind || 'new') === kind));
  const ids = [...new Set([...groups.map(group => group.id), ...(workspace === 'all' ? [] : [workspace])])];
  const label = id => groups.find(group => group.id === id)?.name || (id === 'global' ? 'General' : id);
  ids.sort((a, b) => Number(groups.find(group => group.id === a)?.group === 'home') - Number(groups.find(group => group.id === b)?.group === 'home') || label(a).localeCompare(label(b)));
  return <section className="review-inbox" aria-label="Review inbox">
    <div className="review-filters">
      <label>Workspace <select value={workspace} onChange={event => changeFilters({...filters, workspace: event.target.value})}><option value="all">All workspaces</option>{ids.map(id => <option key={id} value={id}>{label(id)}</option>)}</select></label>
      <label>Review state <select value={kind} onChange={event => changeFilters({...filters, kind: event.target.value})}><option value="all">All pending</option><option value="new">New</option><option value="changed">Changed</option><option value="reopened">Reopened</option></select></label>
    </div>
    {visible.length ? <ul className="review-list">{visible.slice(0, limit).map(note => <li key={note.path}><button type="button" onClick={() => onOpenNote(note.path)}><span><strong>{note.title}</strong><small>{note.path}</small></span><span className="review-list-meta">{label(scope(note))} · {labels[note.reviewKind] || 'New'}</span></button></li>)}</ul> : <p className="review-empty">No notes match these review filters.</p>}
    {visible.length > limit && <button type="button" className="load-more" onClick={() => setLimit(value => value + 48)}>Show more · {visible.length - limit} remaining</button>}
  </section>;
}

export function ReviewDiff({path, revision}) {
  const [state, setState] = useState({loading: true});
  useEffect(() => {
    const controller = new AbortController();
    setState({loading: true});
    fetch(`/api/review-diff?path=${encodeURIComponent(path)}`, {signal: controller.signal}).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load review diff.');
      setState({data});
    }).catch(error => { if (error.name !== 'AbortError') setState({error: error.message}); });
    return () => controller.abort();
  }, [path, revision]);
  return <section id="axiom-review-comparison" tabIndex="-1" className="review-diff panel" aria-label="Changes since review"><h2>Changes since review</h2><p><a href="#axiom-current-note">Jump to rendered note</a></p>
    {state.loading ? <p>Loading comparison…</p> : state.error ? <p role="alert">{state.error}</p> : state.data.currentRevision !== revision ? <p role="alert">This note changed while you were viewing it. Refresh before comparing or reviewing.</p> : !state.data.available ? <p>{state.data.reason}</p> : <><p className="review-diff-caption">Compared with the revision reviewed {state.data.reviewedAt ? new Date(state.data.reviewedAt).toLocaleString() : 'previously'}.</p><pre className="review-diff-lines">{state.data.changes.map((change, index) => <span className={`review-diff-${change.type}`} key={index}>{change.text}</span>)}</pre></>}
  </section>;
}
