import { catalog, readNote, projectFor, search } from './memory.mjs';
import {resolveNote} from './note-links.mjs';

const recent = (a, b) => b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path);
function workspaceNotes(config, id, notes) {
  const ids = new Set(config.projects.map(project => project.id));
  if (id !== 'global' && id !== '__unmapped' && !ids.has(id)) throw Object.assign(new Error('Unknown workspace.'), { status: 400 });
  return notes.filter(note => id === '__unmapped' ? note.project !== 'global' && !ids.has(note.project) : note.project === id);
}
async function loadContents(config, notes) {
  const result = new Array(notes.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(12, notes.length) }, async () => {
    while (cursor < notes.length) {
      const index = cursor++;
      result[index] = await readNote(config, notes[index].path);
    }
  }));
  return result;
}
function contentParts(content) {
  const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = Object.create(null);
  for (const line of (front?.[1] || '').split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*(.*?)\s*$/i);
    if (match) fields[match[1].toLowerCase()] = match[2].replace(/^['"]|['"]$/g, '');
  }
  const body = content.slice(front?.[0].length || 0)
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*(?:\n|$)/gm, '')
    .replace(/`+[^`\n]*`+/g, '');
  return { fields, body };
}
const meaningful = value => typeof value === 'string' && value.trim() && !/^(none|null|unknown|n\/a|\[\])$/i.test(value.trim());
function isDecision(note, fields, body) {
  return /^decision$/i.test(note.kind || fields.kind || '') || /^#{1,6}\s+(?:decision|decision record)(?:\s*[:—-].*)?\s*#*\s*$/im.test(body);
}
function isProposal(note, fields) {
  return /^proposal$/i.test(note.kind || fields.kind || '') || /^proposal$/i.test(note.status || '') || /(?:^|\/)proposals?\//i.test(note.path);
}

export async function getWorkspaceOverview(config, id) {
  const selected = workspaceNotes(config, id, await catalog(config));
  const full = await loadContents(config, selected);
  const notes = full.map(({ content, ...note }) => note).sort(recent);
  const byPath = new Map(notes.map(note => [note.path, note]));
  const pins = (Array.isArray(config.workspacePins?.[id]) ? config.workspacePins[id] : []).map(path => ({ path, note: byPath.get(path) || null, stale: !byPath.has(path) }));
  const decisions = [], proposals = [];
  for (const note of full) {
    const { fields, body } = contentParts(note.content);
    const summary = byPath.get(note.path);
    if (!['archived', 'superseded'].includes((note.status || '').toLowerCase())) {
      if (isDecision(note, fields, body)) decisions.push(summary);
      if (isProposal(note, fields) && !['accepted', 'rejected', 'resolved', 'closed'].includes((note.status || '').toLowerCase())) proposals.push(summary);
    }
  }
  decisions.sort(recent); proposals.sort(recent);
  return { id, noteCount: notes.length, pins, decisions: decisions.slice(0, 8), proposals: proposals.slice(0, 8), activity: notes.slice(0, 8), notes };
}

export async function getMemoryHealth(config, renderMarkdown) {
  const allNotes = await catalog(config);
  const notes = await loadContents(config, allNotes);
  const configured = new Set(config.projects.map(project => project.id));
  const ambiguous = [], brokenLinks = [], conflicts = [], missingSources = [], superseded = [], possibleOverlaps = [];
  const titles = new Map();
  for (const note of notes) {
    const { content, ...summary } = note;
    const { fields, body } = contentParts(content);
    const active = !['archived', 'superseded'].includes((note.status || '').toLowerCase());
    if (active && note.project !== 'global' && !configured.has(note.project)) ambiguous.push(summary);
    const graph = { targets: new Set(), unresolvedCount: 0 };
    renderMarkdown(content, note.path, allNotes, graph);
    if (active && graph.unresolvedCount) brokenLinks.push({ note: summary, count: graph.unresolvedCount });
    const conflict = note.conflictsWith || fields.conflicts_with;
    if (active && meaningful(conflict)) conflicts.push({ note: summary, reference: conflict });
    const supersedes = note.supersedes || fields.supersedes;
    if (meaningful(supersedes) || (note.status || '').toLowerCase() === 'superseded') superseded.push({ note: summary, reference: meaningful(supersedes) ? supersedes : null });
    const source = note.source || fields.source;
    const bodySource = /^\s*(?:[-*]\s*)?(?:source|provenance)\s*:\s*\S/im.test(body) || /^#{1,6}[ \t]*(?:sources?|provenance)[ \t]*[:—-][ \t]*\S/im.test(body) || /^#{1,6}[ \t]*(?:sources?|provenance)[ \t]*#*[ \t]*\r?\n(?:[ \t]*\r?\n)*[ \t]*(?!#)\S/im.test(body);
    if (active && note.owner === 'agent' && !meaningful(source) && !bodySource) missingSources.push(summary);
    const title = note.title.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (active && title) {
      const key = `${note.project}\0${title}`;
      if (!titles.has(key)) titles.set(key, []);
      titles.get(key).push(summary);
    }
  }
  for (const matches of titles.values()) if (matches.length > 1) possibleOverlaps.push({ title: matches[0].title, notes: matches.sort(recent) });
  return { ambiguous, brokenLinks, conflicts, missingSources, superseded, possibleOverlaps };
}

const MAX_CANDIDATES = 50;
const summaryOf = ({ content, ...note }) => note;
const words = text => new Set((text.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 4000));
function eligible(note) {
  return !['archived', 'superseded', 'stale', 'retired', 'proposal'].includes((note.status || '').toLowerCase()) &&
    !isProposal(note, {}) && !/^Agents\/(?:Handovers|Proposals)\//i.test(note.path);
}
function similarity(title, body, note) {
  const titleWords = words(title), bodyWords = words(body);
  const candidateTitle = words(note.title), candidateBody = words(contentParts(note.content).body);
  const titleMatches = [...titleWords].filter(word => candidateTitle.has(word)).length;
  const bodyMatches = [...bodyWords].filter(word => candidateBody.has(word)).length;
  const score = titleMatches * 4 + Math.min(bodyMatches, 20);
  const reasons = [];
  if (titleMatches) reasons.push(`${titleMatches} shared title ${titleMatches === 1 ? 'term' : 'terms'}`);
  if (bodyMatches) reasons.push(`${bodyMatches} shared body ${bodyMatches === 1 ? 'term' : 'terms'}`);
  return { score, reasons };
}
function ranked(title, body, notes, limit) {
  return notes.map(note => ({ note: summaryOf(note), ...similarity(title, body, note) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path))
    .slice(0, limit);
}
function references(value) {
  if (!meaningful(value)) return [];
  const links = [...value.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]|\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(match => match[1] || match[2]);
  return links.length ? links : [value.trim()];
}

async function overlapCandidates(config, project, title, body, exclude) {
  const query = [...new Set([...words(title), ...words(body)])].slice(0, 24).join(' ');
  if (!query) return { notes: [], warnings: [] };
  const scopes = project === 'global' || project === 'unmapped' ? ['global'] : [project, 'global'];
  const results = await Promise.all(scopes.map(workspace => search(config, query, { all: true, workspace, limit: MAX_CANDIDATES })));
  const found = results.flatMap(result => result.items).filter(note => note.path !== exclude && eligible(note));
  found.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const selected = found.slice(0, MAX_CANDIDATES);
  const partial = results.some(result => result.hasMore) || found.length > selected.length;
  return { notes: await loadContents(config, selected), warnings: partial ? ['Overlap analysis is limited to 50 search-selected candidates.'] : [] };
}

export async function getNoteKnowledge(config, relative) {
  const current = await readNote(config, relative);
  const all = (await catalog(config)).filter(note => note.project === current.project || note.project === 'global');
  const warnings = [];
  const edges = [], conflicts = [];
  for (const note of all) {
    for (const [field, kind] of [[note.supersedes, 'supersedes'], [note.conflictsWith, 'conflicts']]) {
      for (const reference of references(field)) {
        const target = resolveNote(reference, note.path, all);
        if (!target) {
          if (note.path === current.path) warnings.push(`Could not uniquely resolve ${kind} reference: ${reference}`);
          continue;
        }
        if (kind === 'supersedes') edges.push({ source: note, target, reference });
        else if (note.path === current.path || target.path === current.path) conflicts.push({ note: summaryOf(note.path === current.path ? target : note), reference });
      }
    }
  }
  const seen = new Set([current.path]), queue = [current.path], timeline = [];
  while (queue.length) {
    const path = queue.shift();
    for (const edge of edges) {
      if (edge.source.path !== path && edge.target.path !== path) continue;
      const other = edge.source.path === path ? edge.target : edge.source;
      if (seen.has(other.path)) continue;
      if (seen.size >= 200) {
        if (!warnings.includes('Replacement timeline is limited to 200 linked notes.')) warnings.push('Replacement timeline is limited to 200 linked notes.');
        continue;
      }
      seen.add(other.path); queue.push(other.path);
      timeline.push({ note: summaryOf(other), relation: edge.source.path === path ? 'Replaces' : 'Replaced by', sourcePath: edge.source.path, targetPath: edge.target.path, reference: edge.reference });
    }
  }
  const linkedEdges = edges.filter(edge => seen.has(edge.source.path) && seen.has(edge.target.path));
  const indegree = new Map([...seen].map(path => [path, 0]));
  for (const edge of linkedEdges) indegree.set(edge.target.path, indegree.get(edge.target.path) + 1);
  const roots = [...seen].filter(path => indegree.get(path) === 0);
  let visited = 0;
  while (roots.length) {
    const path = roots.pop(); visited++;
    for (const edge of linkedEdges) if (edge.source.path === path) {
      const degree = indegree.get(edge.target.path) - 1;
      indegree.set(edge.target.path, degree);
      if (!degree) roots.push(edge.target.path);
    }
  }
  if (visited < seen.size) warnings.push('Replacement relationships contain a directed cycle; verify the original notes.');
  timeline.sort((a, b) => a.note.updated.localeCompare(b.note.updated) || a.note.path.localeCompare(b.note.path));
  const body = contentParts(current.content).body;
  const candidates = await overlapCandidates(config, current.project, current.title, body, current.path);
  warnings.push(...candidates.warnings);
  const overlaps = ranked(current.title, body, candidates.notes, 5);
  return { path: current.path, currentRevision: current.revision, timeline, conflicts, overlaps, warnings };
}

export async function getCaptureSuggestions(config, { cwd = process.cwd(), workspace, path = '', content, limit = 5 } = {}) {
  if (typeof cwd !== 'string' || typeof path !== 'string' || typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw Object.assign(new Error('Supply a working directory, path and Markdown content no larger than 2 MiB.'), { status: 400 });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw Object.assign(new Error('Limit must be an integer from 1 to 20.'), { status: 400 });
  if (workspace !== undefined && (typeof workspace !== 'string' || !['global', 'unmapped', ...config.projects.map(project => project.id)].includes(workspace))) throw Object.assign(new Error('Unknown capture workspace.'), {status: 400});
  const project = workspace ?? projectFor(config, cwd);
  const { fields, body } = contentParts(content);
  const title = fields.title || body.match(/^#\s+(.+)$/m)?.[1] || path.split('/').pop()?.replace(/\.md$/i, '') || '';
  const candidates = await overlapCandidates(config, project, title, body, path);
  return { project, items: ranked(title, body, candidates.notes, limit), warnings: candidates.warnings };
}
