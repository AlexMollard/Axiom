import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createGraphSimulation } from './graph-physics.mjs';
import { ZoomIn, ZoomOut, Maximize, Search, ExternalLink, Columns2 } from 'lucide-react';
import OpenInMenu from './OpenInMenu.jsx';
import './Graph.css';

const clamp = value => Math.max(0.12, Math.min(5, value));
const noteUrl = path => '/?note=' + encodeURIComponent(path);

const workspacePalette = [
  '#d39476',
  '#8aa3ab',
  '#97b18d',
  '#c9a87c',
  '#a992b3',
  '#c88a8a',
  '#89a79d',
  '#b49a84',
];

function workspaceColor(id) {
  if (!id || id === 'global') return '#d39476';
  if (id === 'personal') return '#89a79d';
  if (id === '__unmapped') return '#9d8f85';
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return workspacePalette[hash % workspacePalette.length];
}

function makeGraph(data, isolates, references) {
  const candidates = data.nodes.filter(node => references || !node.external);
  const visiblePaths = new Set(candidates.map(node => node.path));
  const visibleEdges = data.edges.filter(edge => visiblePaths.has(edge.source) && visiblePaths.has(edge.target));
  const degree = new Map(candidates.map(node => [node.path, 0]));
  visibleEdges.forEach(edge => {
    degree.set(edge.source, degree.get(edge.source) + 1);
    degree.set(edge.target, degree.get(edge.target) + 1);
  });
  const nodes = candidates
    .filter(node => isolates || degree.get(node.path))
    .map((node, index) => ({
      ...node,
      degree: degree.get(node.path),
      _search: `${node.title} ${node.path}`.toLowerCase(),
      x: Math.cos(index * 2.399) * Math.sqrt(index) * 24,
      y: Math.sin(index * 2.399) * Math.sqrt(index) * 24,
    }));
  const paths = new Set(nodes.map(node => node.path));
  const edges = visibleEdges.filter(edge => paths.has(edge.source) && paths.has(edge.target)).map(edge => ({ ...edge }));
  const sortedByDegree = [...nodes].sort((a, b) => b.degree - a.degree);
  return { nodes, edges, sortedByDegree };
}

export default function WorkspaceGraph({ project, label, groups = [], onOpenNote, onOpenSplit, vaultName }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [query, setQuery] = useState('');
  const [isolates, setIsolates] = useState(true);
  const [references, setReferences] = useState(true);
  const [highlightUnreviewed, setHighlightUnreviewed] = useState(false);
  const [spotlightWorkspace, setSpotlightWorkspace] = useState('');
  const [size, setSize] = useState({ width: 800, height: 550 });
  const [settled, setSettled] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const [visible, setVisible] = useState(48);

  const canvasRef = useRef(null);
  const gestures = useRef(new Map());
  const moved = useRef(false);
  const viewRef = useRef({ x: 400, y: 275, scale: 1 });
  const prevSizeRef = useRef({ width: 800, height: 550 });
  const fittedGraphRef = useRef(null);
  const activeRef = useRef(null);
  const selectedRef = useRef(null);
  const queryRef = useRef('');
  const spotlightRef = useRef('');
  const highlightUnreviewedRef = useRef(false);
  const rafRef = useRef(0);
  const tweenRafRef = useRef(0);
  const animatingRef = useRef(false);

  selectedRef.current = selected;
  queryRef.current = query;
  spotlightRef.current = spotlightWorkspace;
  highlightUnreviewedRef.current = highlightUnreviewed;

  const groupNames = useMemo(() => {
    const map = new Map([['personal', 'Personal'], ['global', 'General'], ['__unmapped', 'Unmapped']]);
    for (const g of groups) {
      if (g?.id) map.set(g.id, g.name || g.id);
    }
    return map;
  }, [groups]);
  const friendlyWorkspace = useCallback(id => groupNames.get(id) || id || 'General', [groupNames]);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    setSelected(null);
    setQuery('');
    setSpotlightWorkspace('');
    fetch(`/api/graph?project=${encodeURIComponent(project)}`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load graph.');
        return body;
      })
      .then(setData)
      .catch(err => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, [project]);

  const prepared = useMemo(() => (data ? makeGraph(data, isolates, references) : null), [data, isolates, references]);

  useEffect(() => {
    if (!prepared) return;
    let active = true;
    setError('');
    const worker = new Worker(new URL('./graph-layout.worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: result }) => {
      if (!active) return;
      prepared.nodes.forEach((node, index) => Object.assign(node, result.positions[index]));
      prepared.simulation = createGraphSimulation(prepared.nodes, prepared.edges).alpha(result.alpha);
      setSettled(prepared);
      worker.terminate();
    };
    worker.onerror = () => {
      if (active) setError('Graph layout failed. Refresh the view to try again.');
      worker.terminate();
    };
    worker.postMessage({
      nodes: prepared.nodes.map(({ path, x, y }) => ({ path, x, y })),
      edges: prepared.edges,
    });
    return () => {
      active = false;
      worker.terminate();
    };
  }, [prepared]);

  const graph = settled === prepared ? settled : null;
  useEffect(() => { setVisible(48); }, [query, graph]);
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    cancelAnimationFrame(tweenRafRef.current);
    graph?.simulation.stop();
    graph?.simulation.on('tick', null);
  }, [graph]);

  const active = hovered || selected;
  activeRef.current = active;

  const workspaceGroups = useMemo(() => {
    if (!graph || project !== '__all') return [];
    const counts = new Map();
    for (const node of graph.nodes) {
      const ws = node.workspaceId || node.project || 'global';
      counts.set(ws, (counts.get(ws) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || friendlyWorkspace(a[0]).localeCompare(friendlyWorkspace(b[0])))
      .map(([id, count]) => ({ id, name: friendlyWorkspace(id), count, color: workspaceColor(id) }));
  }, [graph, project, friendlyWorkspace]);

  const neighbors = useMemo(() => {
    const paths = new Set(active ? [active] : []);
    if (active && graph) {
      graph.edges.forEach(edge => {
        if (edge.source.path === active) paths.add(edge.target.path);
        if (edge.target.path === active) paths.add(edge.source.path);
      });
    }
    return paths;
  }, [graph, active]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !graph) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = size.width;
    const height = size.height;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const view = viewRef.current;
    const currentActive = activeRef.current;
    const currentSelected = selectedRef.current;
    const term = queryRef.current.trim().toLowerCase();
    const spotlight = spotlightRef.current;
    const onlyUnreviewed = highlightUnreviewedRef.current;
    const isAllVault = project === '__all';
    const baseRadius = Math.max(4.5, Math.min(8, 6 * Math.sqrt(view.scale)));

    const isUnreviewedAgent = node =>
      node.owner === 'agent' && node.reviewStatus === 'unreviewed' && !['archived', 'superseded'].includes((node.status || '').toLowerCase());

    const isHighlightedNode = node => {
      if (currentActive && !neighbors.has(node.path)) return false;
      if (spotlight && (node.workspaceId || node.project || 'global') !== spotlight) return false;
      if (onlyUnreviewed && !isUnreviewedAgent(node)) return false;
      if (term && !node._search.includes(term)) return false;
      return true;
    };

    // Edges + directional arrowheads for connected edges of the active node
    ctx.lineWidth = 1.1;
    for (const edge of graph.edges) {
      const touchesActive = currentActive && (edge.source.path === currentActive || edge.target.path === currentActive);
      const dimByActive = currentActive && !touchesActive;
      const dimBySpotlight = spotlight && (edge.source.workspaceId || edge.source.project) !== spotlight && (edge.target.workspaceId || edge.target.project) !== spotlight;
      const dimByUnreviewed = onlyUnreviewed && !isUnreviewedAgent(edge.source) && !isUnreviewedAgent(edge.target);
      const dim = dimByActive || dimBySpotlight || dimByUnreviewed;
      const sx = edge.source.x * view.scale + view.x;
      const sy = edge.source.y * view.scale + view.y;
      const tx = edge.target.x * view.scale + view.x;
      const ty = edge.target.y * view.scale + view.y;
      if ((sx < -50 && tx < -50) || (sx > width + 50 && tx > width + 50) || (sy < -50 && ty < -50) || (sy > height + 50 && ty > height + 50)) {
        continue;
      }
      ctx.strokeStyle = touchesActive ? 'rgba(239, 185, 157, 0.72)' : dim ? 'rgba(211, 148, 118, 0.08)' : 'rgba(211, 148, 118, 0.42)';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();

      if (touchesActive) {
        const angle = Math.atan2(ty - sy, tx - sx);
        const targetR = baseRadius + Math.min(3, Math.sqrt(edge.target.degree || 0) * 0.7) + 3;
        const ax = tx - Math.cos(angle) * targetR;
        const ay = ty - Math.sin(angle) * targetR;
        const head = 6.5;
        ctx.fillStyle = 'rgba(239, 185, 157, 0.85)';
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(angle - 0.42) * head, ay - Math.sin(angle - 0.42) * head);
        ctx.lineTo(ax - Math.cos(angle + 0.42) * head, ay - Math.sin(angle + 0.42) * head);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Nodes
    for (const node of graph.nodes) {
      const nx = node.x * view.scale + view.x;
      const ny = node.y * view.scale + view.y;
      if (nx < -40 || nx > width + 40 || ny < -40 || ny > height + 40) continue;

      const highlighted = isHighlightedNode(node);
      const isSelected = currentSelected === node.path;
      const isActive = currentActive === node.path;
      const color = isUnreviewedAgent(node) && onlyUnreviewed
        ? '#efb99d'
        : isAllVault
          ? workspaceColor(node.workspaceId || node.project)
          : '#d39476';
      const r = isSelected ? baseRadius + 2.5 : baseRadius + Math.min(3, Math.sqrt(node.degree || 0) * 0.7);

      ctx.save();
      ctx.globalAlpha = highlighted ? 1 : 0.14;

      if (isActive || isSelected) {
        ctx.beginPath();
        ctx.arc(nx, ny, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(211, 148, 118, 0.20)';
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(nx, ny, r, 0, Math.PI * 2);

      if (node.external) {
        ctx.fillStyle = '#191715';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = color;
        ctx.stroke();
      } else {
        ctx.fillStyle = isSelected ? '#efb99d' : color;
        ctx.fill();
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.strokeStyle = isSelected ? '#f0ebe6' : '#191715';
        ctx.stroke();
      }
      ctx.restore();
    }

    // Collision-culled labels (neighbor priority when a node is active, otherwise pre-sorted degree order)
    ctx.font = '500 12px "Manrope Variable", sans-serif';
    ctx.textBaseline = 'middle';
    const occupied = [];
    const ordered = currentActive && neighbors.size
      ? [
          ...graph.sortedByDegree.filter(n => neighbors.has(n.path)),
          ...graph.sortedByDegree.filter(n => !neighbors.has(n.path)),
        ]
      : graph.sortedByDegree;

    for (const node of ordered) {
      if (!neighbors.has(node.path) && view.scale < 0.6 && node.degree < 3 && !term && !spotlight && !onlyUnreviewed) continue;
      if (term && !node._search.includes(term) && node.path !== currentActive) continue;
      if (spotlight && (node.workspaceId || node.project || 'global') !== spotlight && !neighbors.has(node.path)) continue;
      if (onlyUnreviewed && !isUnreviewedAgent(node) && node.path !== currentActive) continue;
      const nx = node.x * view.scale + view.x;
      const ny = node.y * view.scale + view.y;
      if (nx < -120 || nx > width + 20 || ny < -20 || ny > height + 20) continue;

      const labelText = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title;
      const tx = nx + 11;
      const ty = ny;
      const tw = Math.min(180, ctx.measureText(labelText).width + 6);
      const collides = occupied.some(box => tx < box.x + box.width && tx + tw > box.x && Math.abs(ty - box.y) < 17);
      if (node.path !== currentActive && collides) continue;
      occupied.push({ x: tx, y: ty, width: tw });

      const dim = currentActive && !neighbors.has(node.path);
      ctx.save();
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#191715';
      ctx.strokeText(labelText, tx, ty);
      ctx.fillStyle = node.path === currentActive ? '#efb99d' : '#f0ebe6';
      ctx.fillText(labelText, tx, ty);
      ctx.restore();
    }

    ctx.restore();
  }, [graph, neighbors, project, size.height, size.width]);

  const scheduleDraw = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(drawCanvas);
  }, [drawCanvas]);

  const animateViewTo = useCallback((target, durationMs = 240) => {
    cancelAnimationFrame(tweenRafRef.current);
    const start = { ...viewRef.current };
    const started = performance.now();
    const step = now => {
      const rawT = Math.min(1, (now - started) / durationMs);
      const ease = 1 - Math.pow(1 - rawT, 3);
      viewRef.current = {
        x: start.x + (target.x - start.x) * ease,
        y: start.y + (target.y - start.y) * ease,
        scale: start.scale + (target.scale - start.scale) * ease,
      };
      drawCanvas();
      if (rawT < 1) tweenRafRef.current = requestAnimationFrame(step);
    };
    tweenRafRef.current = requestAnimationFrame(step);
  }, [drawCanvas]);

  useEffect(() => {
    scheduleDraw();
  }, [scheduleDraw, graph, active, selected, query, spotlightWorkspace, highlightUnreviewed, size.width, size.height]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      if (rect.width && rect.height) {
        const dx = (rect.width - prevSizeRef.current.width) / 2;
        const dy = (rect.height - prevSizeRef.current.height) / 2;
        if (dx || dy) {
          viewRef.current = { ...viewRef.current, x: viewRef.current.x + dx, y: viewRef.current.y + dy };
        }
        prevSizeRef.current = { width: rect.width, height: rect.height };
        setSize({ width: rect.width, height: rect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph]);

  const computeFitTarget = useCallback((dims = size) => {
    if (!graph?.nodes.length) return null;
    const xs = graph.nodes.map(node => node.x);
    const ys = graph.nodes.map(node => node.y);
    const minX = Math.min(...xs) - 35;
    const maxX = Math.max(...xs) + 35;
    const minY = Math.min(...ys) - 35;
    const maxY = Math.max(...ys) + 35;
    const scale = clamp(Math.min(1.8, (dims.width - 40) / (maxX - minX), (dims.height - 40) / (maxY - minY)));
    return {
      x: dims.width / 2 - ((minX + maxX) / 2) * scale,
      y: dims.height / 2 - ((minY + maxY) / 2) * scale,
      scale,
    };
  }, [graph, size]);

  useEffect(() => {
    if (!graph || fittedGraphRef.current === graph) return;
    fittedGraphRef.current = graph;
    const target = computeFitTarget();
    if (target) {
      viewRef.current = target;
      scheduleDraw();
    }
  }, [graph, computeFitTarget, scheduleDraw]);

  const fit = useCallback(() => {
    const target = computeFitTarget();
    if (target) animateViewTo(target);
  }, [computeFitTarget, animateViewTo]);

  const zoomAt = useCallback((factor, x, y) => {
    cancelAnimationFrame(tweenRafRef.current);
    const old = viewRef.current;
    const scale = clamp(old.scale * factor);
    const ratio = scale / old.scale;
    viewRef.current = { x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio, scale };
    scheduleDraw();
  }, [scheduleDraw]);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return undefined;
    const wheel = event => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [graph, zoomAt]);

  const point = event => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const nodeAt = (sx, sy) => {
    if (!graph) return null;
    const view = viewRef.current;
    const wx = (sx - view.x) / view.scale;
    const wy = (sy - view.y) / view.scale;
    const hitRadius = Math.max(12 / view.scale, 7 + 4 / view.scale);
    let best = null;
    let bestDist = hitRadius * hitRadius;
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const node = graph.nodes[i];
      const dx = node.x - wx;
      const dy = node.y - wy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestDist) {
        bestDist = d2;
        best = node;
      }
    }
    return best;
  };

  const focusNode = node => {
    setSelected(node.path);
    const scale = Math.max(viewRef.current.scale, 1.25);
    animateViewTo({ x: size.width / 2 - node.x * scale, y: size.height / 2 - node.y * scale, scale });
  };

  const startTickDraw = () => {
    if (animatingRef.current || !graph?.simulation) return;
    animatingRef.current = true;
    graph.simulation.on('tick', () => {
      drawCanvas();
    }).on('end', () => {
      animatingRef.current = false;
      drawCanvas();
    });
  };

  const pointerDown = event => {
    if (event.button !== 0 || !graph) return;
    cancelAnimationFrame(tweenRafRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event);
    const hit = gestures.current.size === 0 ? nodeAt(p.x, p.y) : null;
    gestures.current.set(event.pointerId, { ...p, startX: p.x, startY: p.y, node: hit });
    moved.current = false;
    if (hit && gestures.current.size === 1) {
      hit.fx = hit.x;
      hit.fy = hit.y;
      startTickDraw();
      graph.simulation.alphaTarget(0.2).restart();
    }
  };

  const pointerMove = event => {
    const previous = gestures.current.get(event.pointerId);
    const p = point(event);
    if (!previous) {
      const hit = nodeAt(p.x, p.y);
      const nextHover = hit ? hit.path : null;
      if (nextHover !== hovered) setHovered(nextHover);
      if (canvasRef.current) canvasRef.current.style.cursor = hit ? 'pointer' : 'grab';
      return;
    }
    const all = gestures.current;
    if (Math.hypot(p.x - previous.startX, p.y - previous.startY) > 4) moved.current = true;
    if (all.size > 1) {
      moved.current = true;
      const other = [...all.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(p.x - other.x, p.y - other.y);
        const old = viewRef.current;
        const scale = clamp(old.scale * (after / (before || after)));
        const ratio = scale / old.scale;
        const cx = (previous.x + other.x) / 2;
        const cy = (previous.y + other.y) / 2;
        viewRef.current = { scale, x: (p.x + other.x) / 2 - (cx - old.x) * ratio, y: (p.y + other.y) / 2 - (cy - old.y) * ratio };
        scheduleDraw();
      }
    } else if (previous.node) {
      previous.node.fx = (p.x - viewRef.current.x) / viewRef.current.scale;
      previous.node.fy = (p.y - viewRef.current.y) / viewRef.current.scale;
    } else {
      const old = viewRef.current;
      viewRef.current = { ...old, x: old.x + p.x - previous.x, y: old.y + p.y - previous.y };
      scheduleDraw();
    }
    all.set(event.pointerId, { ...previous, ...p });
  };

  const pointerUp = event => {
    const item = gestures.current.get(event.pointerId);
    if (!item) return;
    const wasClick = !moved.current;
    if (item.node) {
      item.node.fx = null;
      item.node.fy = null;
      graph.simulation.alphaTarget(0);
    }
    gestures.current.delete(event.pointerId);
    if (wasClick && item.node) {
      if (event.altKey && onOpenSplit) onOpenSplit({ kind: 'note', path: item.node.path });
      else if (event.ctrlKey || event.metaKey) onOpenNote(item.node.path);
      else focusNode(item.node);
    } else if (wasClick && !item.node) {
      setSelected(null);
    }
    if (gestures.current.size === 1) {
      const remaining = gestures.current.values().next().value;
      if (remaining.node) {
        remaining.node.fx = (remaining.x - viewRef.current.x) / viewRef.current.scale;
        remaining.node.fy = (remaining.y - viewRef.current.y) / viewRef.current.scale;
        startTickDraw();
        graph.simulation.alphaTarget(0.2).restart();
      }
    }
  };

  useEffect(() => {
    const release = () => {
      for (const item of gestures.current.values()) {
        if (item.node) { item.node.fx = null; item.node.fy = null; }
      }
      gestures.current.clear();
      graph?.simulation.alphaTarget(0).stop();
    };
    window.addEventListener('blur', release);
    return () => { window.removeEventListener('blur', release); release(); };
  }, [graph]);

  const current = graph?.nodes.find(node => node.path === selected);
  const incoming = graph?.edges.filter(edge => edge.target.path === selected) || [];
  const outgoing = graph?.edges.filter(edge => edge.source.path === selected) || [];
  const matches = useMemo(() => {
    if (!graph) return [];
    const term = query.trim().toLowerCase();
    return term ? graph.nodes.filter(node => node._search.includes(term)) : graph.nodes;
  }, [graph, query]);

  return (
    <section className="workspace-graph" aria-label={`${label} knowledge graph`}>
      {error && <p role="alert">{error}</p>}
      {!graph && !error && <p role="status">{data ? 'Laying out graph…' : 'Loading graph…'}</p>}
      {graph && (
        <>
          <div className="graph-toolbar">
            <label className="graph-search">
              <Search size={18} />
              <span className="graph-sr">Search graph notes</span>
              <input
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && matches.length) {
                    event.preventDefault();
                    focusNode(matches[0]);
                  }
                }}
                placeholder="Find a note (Enter to focus)"
              />
            </label>
            <label className="graph-filter">
              <input type="checkbox" checked={isolates} onChange={event => setIsolates(event.target.checked)} /> Isolates
            </label>
            {project !== '__all' && (
              <label className="graph-filter">
                <input type="checkbox" checked={references} onChange={event => setReferences(event.target.checked)} /> References
              </label>
            )}
            <label className="graph-filter">
              <input type="checkbox" checked={highlightUnreviewed} onChange={event => setHighlightUnreviewed(event.target.checked)} /> Unreviewed only
            </label>
            <div className="graph-controls">
              <button type="button" onClick={() => zoomAt(1.3, size.width / 2, size.height / 2)} aria-label="Zoom in"><ZoomIn size={18} /></button>
              <button type="button" onClick={() => zoomAt(1 / 1.3, size.width / 2, size.height / 2)} aria-label="Zoom out"><ZoomOut size={18} /></button>
              <button type="button" onClick={fit} aria-label="Fit graph"><Maximize size={18} /></button>
            </div>
          </div>
          <p className="graph-summary">
            {graph.nodes.filter(node => !node.external).length} notes · {graph.nodes.filter(node => node.external).length} external references · {graph.edges.length} links · {data.unresolvedCount || 0} unresolved references. Click to inspect, double-click to open{onOpenSplit ? ', Alt+click for split' : ''}.
          </p>
          {workspaceGroups.length > 0 && (
            <div className="graph-legend" role="group" aria-label="Filter graph by workspace">
              {workspaceGroups.map(ws => (
                <button
                  key={ws.id}
                  type="button"
                  className="graph-legend-item"
                  aria-pressed={spotlightWorkspace === ws.id}
                  onClick={() => setSpotlightWorkspace(prev => (prev === ws.id ? '' : ws.id))}
                >
                  <span className="graph-legend-dot" style={{ backgroundColor: ws.color }} />
                  <span>{ws.name}</span>
                  <small>{ws.count}</small>
                </button>
              ))}
            </div>
          )}
          {!graph.nodes.length ? (
            <p className="graph-empty">No visible notes. Change the filters or add notes to this workspace.</p>
          ) : (
            <div className="graph-main">
              <canvas
                ref={canvasRef}
                className="graph-canvas"
                tabIndex="0"
                aria-label="Knowledge graph canvas. Drag to pan, scroll to zoom, arrow keys to pan, plus or minus to zoom. Use the note list below for keyboard selection."
                onKeyDown={event => {
                  const step = event.shiftKey ? 100 : 30;
                  const delta = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
                  if (delta) {
                    event.preventDefault();
                    viewRef.current = { ...viewRef.current, x: viewRef.current.x + delta[0], y: viewRef.current.y + delta[1] };
                    scheduleDraw();
                  } else if (['+', '=', '-'].includes(event.key)) {
                    event.preventDefault();
                    zoomAt(event.key === '-' ? 1 / 1.3 : 1.3, size.width / 2, size.height / 2);
                  } else if (event.key === 'Enter' && current) {
                    event.preventDefault();
                    onOpenNote(current.path);
                  }
                }}
                onDoubleClick={event => {
                  const p = point(event);
                  const hit = nodeAt(p.x, p.y);
                  if (hit) onOpenNote(hit.path);
                }}
                onContextMenu={event => {
                  event.preventDefault();
                  const p = point(event);
                  const hit = nodeAt(p.x, p.y);
                  if (hit) focusNode(hit);
                }}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerUp}
                onPointerCancel={pointerUp}
                onLostPointerCapture={pointerUp}
                onPointerLeave={() => { if (!gestures.current.size) setHovered(null); }}
              />
              <aside className="graph-inspector" aria-live="polite">
                {current ? (
                  <>
                    <span className="graph-kicker">{current.external ? 'External reference' : friendlyWorkspace(current.workspaceId || current.project)}</span>
                    <h3>{current.title}</h3>
                    <p className="graph-path">{current.path}</p>
                    <p>{current.excerpt}</p>
                    <div className="graph-inspector-actions">
                      <button type="button" className="button button-primary" onClick={() => onOpenNote(current.path)}><ExternalLink size={15} /> Open note</button>
                      {onOpenSplit && (
                        <button type="button" className="button" onClick={() => onOpenSplit({ kind: 'note', path: current.path })}>
                          <Columns2 size={15} /> Split
                        </button>
                      )}
                      <OpenInMenu path={current.path} title={current.title} vaultName={vaultName} className="button" />
                    </div>
                    <h4>Incoming ({incoming.length})</h4>
                    {incoming.map(edge => <button className="graph-link" key={edge.source.path} onClick={() => focusNode(edge.source)}>{edge.source.title}</button>)}
                    <h4>Outgoing ({outgoing.length})</h4>
                    {outgoing.map(edge => <button className="graph-link" key={edge.target.path} onClick={() => focusNode(edge.target)}>{edge.target.title}</button>)}
                  </>
                ) : (
                  <p>Click a node or choose one from the list to inspect its connections.</p>
                )}
              </aside>
            </div>
          )}
          <details className="graph-list" open={Boolean(query) || listOpen} onToggle={event => setListOpen(event.currentTarget.open)}>
            <summary>Notes in graph ({matches.length})</summary>
            {(query || listOpen) && (matches.length ? (
              <>
                <ul>
                  {matches.slice(0, visible).map(node => (
                    <li key={node.path}>
                      <button type="button" onClick={() => focusNode(node)} aria-pressed={selected === node.path}>
                        {node.title}{node.external ? ' (reference)' : ''}
                        <small>{node.path}</small>
                      </button>
                      <a
                        href={noteUrl(node.path)}
                        onClick={event => {
                          event.stopPropagation();
                          if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) {
                            event.preventDefault();
                            onOpenNote(node.path);
                          }
                        }}
                        aria-label={`Open ${node.title}`}
                      >
                        <ExternalLink size={18} />
                      </a>
                    </li>
                  ))}
                </ul>
                {matches.length > visible && (
                  <button className="button" type="button" onClick={() => setVisible(count => count + 48)}>
                    Show more · {matches.length - visible} remaining
                  </button>
                )}
              </>
            ) : (
              <p>No matching notes.</p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
