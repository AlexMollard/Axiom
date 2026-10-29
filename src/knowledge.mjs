import { catalog, readNote } from './memory.mjs';

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
