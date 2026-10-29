import React, { useEffect, useMemo, useRef, useState } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from 'd3-force';
import { ZoomIn, ZoomOut, Maximize, Search, ExternalLink } from 'lucide-react';
import './Graph.css';

const clamp = value => Math.max(0.12, Math.min(5, value));
const noteUrl = path => '/?note=' + encodeURIComponent(path);

function makeGraph(data, isolates, references) {
  const candidates = data.nodes.filter(node => references || !node.external);
  const visiblePaths = new Set(candidates.map(node => node.path));
  const visibleEdges = data.edges.filter(edge => visiblePaths.has(edge.source) && visiblePaths.has(edge.target));
  const degree = new Map(candidates.map(node => [node.path, 0]));
  visibleEdges.forEach(edge => { degree.set(edge.source, degree.get(edge.source) + 1); degree.set(edge.target, degree.get(edge.target) + 1); });
  const nodes = candidates.filter(node => isolates || degree.get(node.path)).map((node, index) => ({ ...node, degree: degree.get(node.path), x: Math.cos(index * 2.399) * Math.sqrt(index) * 24, y: Math.sin(index * 2.399) * Math.sqrt(index) * 24 }));
  const paths = new Set(nodes.map(node => node.path));
  const edges = visibleEdges.filter(edge => paths.has(edge.source) && paths.has(edge.target)).map(edge => ({ ...edge }));
  const simulation = forceSimulation(nodes).force('link', forceLink(edges).id(node => node.path).distance(68).strength(0.35))
    .force('charge', forceManyBody().strength(-90).distanceMax(260)).force('collision', forceCollide(23))
    .force('x', forceX(0).strength(0.035)).force('y', forceY(0).strength(0.035)).stop();
  simulation.tick(240);
  return { nodes, edges, simulation };
}

export default function WorkspaceGraph({ project, label, onOpenNote, vaultName }) {
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [selected, setSelected] = useState(null), [hovered, setHovered] = useState(null), [query, setQuery] = useState('');
  const [isolates, setIsolates] = useState(true), [references, setReferences] = useState(true);
  const [size, setSize] = useState({ width: 800, height: 550 });
  const [view, setView] = useState({ x: 400, y: 275, scale: 1 });
  const [, redraw] = useState(0);
  const svg = useRef(null), gestures = useRef(new Map()), moved = useRef(false), animation = useRef(null), viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(''); setSelected(null); setQuery('');
    fetch(`/api/graph?project=${encodeURIComponent(project)}`, { signal: controller.signal })
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Unable to load graph.'); return body; })
      .then(setData).catch(err => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, [project]);
  const graph = useMemo(() => data ? makeGraph(data, isolates, references) : null, [data, isolates, references]);
  useEffect(() => () => { graph?.simulation.stop(); graph?.simulation.on('tick', null); }, [graph]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(entries => { const rect = entries[0].contentRect; if (rect.width && rect.height) setSize({ width: rect.width, height: rect.height }); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph]);
  const setAnimatedView = target => {
    cancelAnimationFrame(animation.current);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { viewRef.current = target; setView(target); return; }
    const start = viewRef.current, begin = performance.now();
    const frame = now => { const t = Math.min(1, (now - begin) / 180), eased = 1 - (1 - t) ** 3; const next = { x: start.x + (target.x - start.x) * eased, y: start.y + (target.y - start.y) * eased, scale: start.scale + (target.scale - start.scale) * eased }; viewRef.current = next; setView(next); if (t < 1) animation.current = requestAnimationFrame(frame); };
    animation.current = requestAnimationFrame(frame);
  };
  useEffect(() => () => cancelAnimationFrame(animation.current), []);
  const fit = () => {
    if (!graph?.nodes.length) return;
    const xs = graph.nodes.map(node => node.x), ys = graph.nodes.map(node => node.y);
    const minX = Math.min(...xs) - 35, maxX = Math.max(...xs) + 35, minY = Math.min(...ys) - 35, maxY = Math.max(...ys) + 35;
    const scale = clamp(Math.min(1.8, (size.width - 40) / (maxX - minX), (size.height - 40) / (maxY - minY)));
    setAnimatedView({ x: size.width / 2 - (minX + maxX) / 2 * scale, y: size.height / 2 - (minY + maxY) / 2 * scale, scale });
  };
  useEffect(() => { if (graph) fit(); }, [graph, size.width, size.height]);
  const zoomAt = (factor, x, y) => { const old = viewRef.current, scale = clamp(old.scale * factor), ratio = scale / old.scale; setAnimatedView({ x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio, scale }); };
  useEffect(() => {
    const element = svg.current;
    if (!element) return undefined;
    const wheel = event => { event.preventDefault(); const rect = element.getBoundingClientRect(); zoomAt(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top); };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [graph]);
  const point = event => { const rect = svg.current.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const focusNode = node => { setSelected(node.path); const scale = Math.max(viewRef.current.scale, 1.25); setAnimatedView({ x: size.width / 2 - node.x * scale, y: size.height / 2 - node.y * scale, scale }); };
  const pointerDown = (event, node = null) => {
    if (event.button !== 0) return;
    cancelAnimationFrame(animation.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event); gestures.current.set(event.pointerId, { ...p, startX: p.x, startY: p.y, node }); moved.current = false;
    if (node && gestures.current.size === 1) { node.fx = node.x; node.fy = node.y; graph.simulation.on('tick', () => redraw(n => n + 1)).alphaTarget(0.2).restart(); }
  };
  const pointerMove = event => {
    const previous = gestures.current.get(event.pointerId); if (!previous) return;
    const p = point(event), all = gestures.current;
    if (Math.hypot(p.x - previous.startX, p.y - previous.startY) > 4) moved.current = true;
    if (all.size > 1) {
      moved.current = true;
      const other = [...all.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) { const before = Math.hypot(previous.x - other.x, previous.y - other.y), after = Math.hypot(p.x - other.x, p.y - other.y); const old = viewRef.current, scale = clamp(old.scale * (after / (before || after))), ratio = scale / old.scale, cx = (previous.x + other.x) / 2, cy = (previous.y + other.y) / 2; const next = { scale, x: (p.x + other.x) / 2 - (cx - old.x) * ratio, y: (p.y + other.y) / 2 - (cy - old.y) * ratio }; viewRef.current = next; setView(next); }
    } else if (previous.node) { previous.node.fx = (p.x - viewRef.current.x) / viewRef.current.scale; previous.node.fy = (p.y - viewRef.current.y) / viewRef.current.scale; }
    else { const old = viewRef.current, next = { ...old, x: old.x + p.x - previous.x, y: old.y + p.y - previous.y }; viewRef.current = next; setView(next); }
    all.set(event.pointerId, { ...previous, ...p });
  };
  const pointerUp = event => {
    const item = gestures.current.get(event.pointerId);
    if (!item) return;
    if (item.node) { item.node.fx = null; item.node.fy = null; graph.simulation.alphaTarget(0); }
    gestures.current.delete(event.pointerId);
    if (gestures.current.size === 1) {
      const remaining = gestures.current.values().next().value;
      if (remaining.node) {
        remaining.node.fx = (remaining.x - viewRef.current.x) / viewRef.current.scale;
        remaining.node.fy = (remaining.y - viewRef.current.y) / viewRef.current.scale;
        graph.simulation.on('tick', () => redraw(n => n + 1)).alphaTarget(0.2).restart();
      }
    }
  };
  useEffect(() => {
    const release = () => {
      for (const item of gestures.current.values()) if (item.node) { item.node.fx = null; item.node.fy = null; }
      gestures.current.clear();
      graph?.simulation.alphaTarget(0).stop();
    };
    window.addEventListener('blur', release);
    return () => { window.removeEventListener('blur', release); release(); };
  }, [graph]);
  const active = hovered || selected;
  const current = graph?.nodes.find(node => node.path === selected);
  const incoming = graph?.edges.filter(edge => edge.target.path === selected) || [], outgoing = graph?.edges.filter(edge => edge.source.path === selected) || [];
  const neighbors = new Set([active]); graph?.edges.forEach(edge => { if (edge.source.path === active) neighbors.add(edge.target.path); if (edge.target.path === active) neighbors.add(edge.source.path); });
  const matches = graph?.nodes.filter(node => `${node.title} ${node.path}`.toLowerCase().includes(query.toLowerCase())) || [];
  const labels = new Set(), occupied = [];
  [...(graph?.nodes || [])].sort((a, b) => (neighbors.has(b.path) - neighbors.has(a.path)) || b.degree - a.degree).forEach(node => {
    if (!neighbors.has(node.path) && view.scale < 0.65 && node.degree < 3) return;
    const x = view.x + node.x * view.scale + 12, y = view.y + node.y * view.scale, width = Math.min(180, (node.title || '').length * 7 + 8);
    if (node.path === active || !occupied.some(box => x < box.x + box.width && x + width > box.x && Math.abs(y - box.y) < 17)) { labels.add(node.path); occupied.push({ x, y, width }); }
  });
  return <section className="workspace-graph" aria-label={`${label} knowledge graph`}>
    {error && <p role="alert">{error}</p>}{!data && !error && <p>Loading graph…</p>}
    {graph && <>
      <div className="graph-toolbar"><label className="graph-search"><Search size={18} /><span className="graph-sr">Search graph notes</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a note" /></label>
        <label className="graph-filter"><input type="checkbox" checked={isolates} onChange={event => setIsolates(event.target.checked)} /> Isolates</label><label className="graph-filter"><input type="checkbox" checked={references} onChange={event => setReferences(event.target.checked)} /> References</label>
        <div className="graph-controls"><button type="button" onClick={() => zoomAt(1.3, size.width / 2, size.height / 2)} aria-label="Zoom in"><ZoomIn size={18} /></button><button type="button" onClick={() => zoomAt(1 / 1.3, size.width / 2, size.height / 2)} aria-label="Zoom out"><ZoomOut size={18} /></button><button type="button" onClick={fit} aria-label="Fit graph"><Maximize size={18} /></button></div>
      </div>
      <p className="graph-summary">{graph.nodes.filter(node => !node.external).length} workspace notes · {graph.nodes.filter(node => node.external).length} references · {graph.edges.length} links · {data.unresolvedCount || 0} unresolved references. Drag to explore; right-click a note for details.</p>
      {!graph.nodes.length ? <p className="graph-empty">No visible notes. Change the filters or add notes to this workspace.</p> : <div className="graph-main">
        <svg ref={svg} className="graph-canvas" tabIndex="0" aria-label="Knowledge graph. Drag to pan, use arrow keys to pan, plus or minus to zoom. Use the note list to find and open notes." onKeyDown={event => { const step = event.shiftKey ? 100 : 30; const delta = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key]; if (delta) { event.preventDefault(); setView(old => ({ ...old, x: old.x + delta[0], y: old.y + delta[1] })); } else if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoomAt(event.key === '-' ? 1 / 1.3 : 1.3, size.width / 2, size.height / 2); } }} onPointerDown={event => { if (!event.target.closest('[data-node]')) pointerDown(event); }} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp}>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            {graph.edges.map(edge => <line key={`${edge.source.path}\u0000${edge.target.path}`} x1={edge.source.x} y1={edge.source.y} x2={edge.target.x} y2={edge.target.y} vectorEffect="non-scaling-stroke" className={active && edge.source.path !== active && edge.target.path !== active ? 'graph-dim' : ''} />)}
            {graph.nodes.map(node => <a key={node.path} href={noteUrl(node.path)} data-node="true" aria-label={`${node.title}${node.external ? ', reference' : ''}. Press Shift+F10 for details`} className={`graph-node${node.external ? ' graph-external' : ''}${selected === node.path ? ' graph-selected' : ''}${active && !neighbors.has(node.path) ? ' graph-dim' : ''}`} transform={`translate(${node.x} ${node.y})`} onPointerDown={event => { event.stopPropagation(); pointerDown(event, node); }} onPointerEnter={() => setHovered(node.path)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(node.path)} onBlur={() => setHovered(null)} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); focusNode(node); } }} onContextMenu={event => { event.preventDefault(); focusNode(node); }} onClick={event => { event.stopPropagation(); if (moved.current && event.detail > 0) { event.preventDefault(); moved.current = false; } else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); moved.current = false; onOpenNote(node.path); } }}><title>{node.title} — {node.path}</title><circle className="graph-hit" r={Math.max(12 / view.scale, 5 + 2 / view.scale)} /><circle className="graph-dot" r={Math.max(5, 7 / view.scale)} vectorEffect="non-scaling-stroke" />{labels.has(node.path) && <text x={12 / view.scale} y={4 / view.scale} fontSize={12 / view.scale}>{node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title}</text>}</a>)}
          </g>
        </svg>
        <aside className="graph-inspector" aria-live="polite">{current ? <><span className="graph-kicker">{current.external ? 'External reference' : 'Workspace note'}</span><h3>{current.title}</h3><p className="graph-path">{current.path}</p><p>{current.excerpt}</p><button type="button" onClick={() => onOpenNote(current.path)}><ExternalLink size={18} /> Open note</button>{vaultName && <a className="graph-obsidian" href={`obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(current.path)}`}>Open in Obsidian</a>}<h4>Incoming ({incoming.length})</h4>{incoming.map(edge => <button className="graph-link" key={edge.source.path} onClick={() => focusNode(edge.source)}>{edge.source.title}</button>)}<h4>Outgoing ({outgoing.length})</h4>{outgoing.map(edge => <button className="graph-link" key={edge.target.path} onClick={() => focusNode(edge.target)}>{edge.target.title}</button>)}</> : <p>Right-click a note or choose one from the list to inspect its connections.</p>}</aside>
      </div>}
      <details className="graph-list" open={query ? true : undefined}><summary>Notes in graph ({matches.length})</summary>{matches.length ? <ul>{matches.map(node => <li key={node.path}><button type="button" onClick={() => focusNode(node)} aria-pressed={selected === node.path}>{node.title}{node.external ? ' (reference)' : ''}<small>{node.path}</small></button><a href={noteUrl(node.path)} onClick={event => { event.stopPropagation(); if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); onOpenNote(node.path); } }} aria-label={`Open ${node.title}`}><ExternalLink size={18} /></a></li>)}</ul> : <p>No matching notes.</p>}</details>
    </>}
  </section>;
}
