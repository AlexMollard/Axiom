import {createHash} from 'node:crypto';
import {catalog, readNote} from './memory.mjs';
import {protectedDeletionReason} from './management.mjs';
import {getNoteUsage} from './note-usage.mjs';
import {resolveNote} from './note-links.mjs';
import {queryWords} from './search-index.mjs';
import {semanticPairs} from './embeddings.mjs';

const scanInternals = Symbol('cleanup scan internals');

const MAX_MERGE_NOTES_PER_PROJECT = 300;
const MAX_MERGE_PAIRS = 5000;
const MAX_MERGE_RESULTS = 200;
const MAX_WORDS = 4000;
const bodyOf = content => content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
const normalized = body => body.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
const substantive = body => body.replace(/^\s*\n/, '').replace(/^ {0,3}#\s+[^\n]*(?:\n|$)/, '').trim();
const wordsOf = body => new Set(queryWords(body).filter(word => word.length >= 3 && /\p{L}/u.test(word) && !/^[a-f\d]{6,}$/i.test(word)).slice(0, MAX_WORDS));
const genericTitleWords = new Set(['note', 'notes', 'overview', 'guide', 'reference', 'memory', 'historical']);
function mergeBody(content) {
  let body = substantive(normalized(bodyOf(content)));
  const wrapper = body.match(/^Imported machine-maintained[^\n]*\nOriginal source:[^\n]*\nOriginal snapshot:[^\n]*(?:\n|$)/);
  if (wrapper) body = bodyOf(body.slice(wrapper[0].length).trimStart()).trim();
  body = body.replace(/^Unreviewed extract from \[original\]\([^\n]*\)\. Original source and snapshot are recorded in that note\. Preserve historical context; this is not owner-approved policy\.\s*/, '');
  return body.replace(/\[([^\]]+)\]\([^)\n]+\)/g, '$1').replace(/https?:\/\/[^\s)]+/g, '');
}
function* pairs(entries) {
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) yield [entries[i], entries[j]];
}
const idOf = (category, notes) => createHash('sha256').update(category + '\0' + notes.map(note => note.path).sort().join('\0')).digest('hex');
const references = value => {
  if (!value || /^(?:none|null|unknown|n\/a|\[\])$/i.test(value.trim())) return [];
  const matches = [...value.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]|\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(match => match[1] || match[2]);
  return matches.length ? matches : [value.trim()];
};

export async function getCleanup(config, workspace, renderMarkdown, {semantic = false, signal} = {}) {
  const configured = new Set(config.projects.map(project => project.id));
  if (workspace !== null && workspace !== undefined && workspace !== 'global' && workspace !== '__unmapped' && !configured.has(workspace)) throw Object.assign(new Error('Unknown workspace.'), {status: 400});
  const scannedAt = new Date().toISOString();
  const catalogNotes = await catalog(config);
  // Incoming links can cross workspace boundaries.
  const notes = new Array(catalogNotes.length);
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(12, notes.length)}, async () => {
    while (cursor < notes.length) { const index = cursor++; notes[index] = await readNote(config, catalogNotes[index].path); }
  }));
  const incoming = new Set(), outgoing = new Map();
  for (const note of notes) {
    const graph = {targets: new Set(), unresolvedCount: 0};
    renderMarkdown(note.content, note.path, notes, graph);
    outgoing.set(note.path, graph.targets);
    for (const target of graph.targets) incoming.add(target);
    for (const value of [note.supersedes, note.conflictsWith]) for (const reference of references(value)) {
      const target = resolveNote(reference, note.path, notes);
      if (target) incoming.add(target.path);
    }
  }
  const usage = await getNoteUsage(config, notes);
  const usageByPath = new Map(usage.notes.map(note => [note.path, note.usage]));
  const pins = new Set(Object.values(config.workspacePins || {}).flat().map(path => String(path).toLowerCase()));
  function blocked(note) {
    if (note.owner !== 'agent') return 'Owner-controlled note.';
    const control = protectedDeletionReason(note.path); if (control) return control;
    if (pins.has(note.path.toLowerCase())) return 'Pinned in a workspace.';
    if (incoming.has(note.path)) return 'Referenced by another note or provenance record.';
    if (note.reviewStatus === 'reviewed' || note.reviewedRevision) return 'Has human review history.';
    if (note.supersedes || note.conflictsWith) return 'Contains replacement or conflict provenance.';
    if (/^(?:archived|retired|superseded|proposal)$/i.test(note.status || '') || /^(?:proposal|decision|conflict)$/i.test(note.kind || '') || /^Agents\/(?:Handovers|Proposals)\//i.test(note.path)) return 'Protected historical, handover, decision or proposal content.';
    const reasons = usageByPath.get(note.path)?.protectionReasons || [];
    return reasons.length ? reasons.join('; ') : null;
  }
  const selected = notes.filter(note => workspace == null || (workspace === '__unmapped' ? note.project !== 'global' && !configured.has(note.project) : note.project === workspace));
  const summaries = new Map(selected.map(note => { const {content, ...summary} = note; return [note.path, {...summary, cleanupBlockedReason: blocked(note)}]; }));
  const items = [], counts = {duplicate: 0, merge: 0, empty: 0, stale: 0};
  function add(category, reason, recommendation, group, details) {
    const result = group.map(note => summaries.get(note.path));
    items.push({id: idOf(category, result), category, reason, recommendation, notes: result, ...details}); counts[category]++;
  }
  const groups = new Map(), projects = new Map();
  for (const note of selected) {
    const body = normalized(bodyOf(note.content));
    if (!substantive(body)) add('empty', 'No substantive Markdown body after the optional title.', 'Inspect the note before deciding whether to remove it.', [note]);
    else {
      const key = note.project + '\0' + body;
      if (!groups.has(key)) groups.set(key, []); groups.get(key).push(note);
      if (!/^(?:archived|retired|superseded|proposal)$/i.test(note.status || '') && !/^Agents\/(?:Handovers|Proposals)\//i.test(note.path)) {
        if (!projects.has(note.project)) projects.set(note.project, []);
        projects.get(note.project).push({note, body, words: wordsOf(mergeBody(note.content)), title: new Set([...wordsOf(note.title)].filter(word => !genericTitleWords.has(word)))});
      }
    }
    if (usageByPath.get(note.path)?.status === 'stale-candidate') add('stale', 'The usage tracker identifies this note as a stale candidate.', 'Inspect its history and contents before deciding whether to remove it.', [note]);
  }
  for (const group of groups.values()) if (group.length > 1) add('duplicate', 'Identical normalized Markdown bodies in the same project.', 'Inspect each note and its metadata before choosing any removal.', group);
  const comparedPaths = new Set(), scopes = [], frequencies = new Map();
  let mergeSkippedNotes = 0, mergePairsCompared = 0, mergePossiblePairs = 0;
  for (const [project, entries] of [...projects].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort((a, b) => a.note.path.localeCompare(b.note.path));
    for (const entry of entries) for (const word of entry.words) frequencies.set(word, (frequencies.get(word) || 0) + 1);
    mergeSkippedNotes += Math.max(0, entries.length - MAX_MERGE_NOTES_PER_PROJECT);
    const limited = entries.slice(0, MAX_MERGE_NOTES_PER_PROJECT), possiblePairs = limited.length * (limited.length - 1) / 2;
    mergePossiblePairs += possiblePairs;
    scopes.push({project, notes: limited.length, possiblePairs, comparedPairs: 0, iterator: pairs(limited), done: false});
  }
  // Share the bounded budget across workspaces instead of exhausting it alphabetically.
  while (mergePairsCompared < MAX_MERGE_PAIRS && counts.merge < MAX_MERGE_RESULTS) {
    let advanced = false;
    for (const scope of scopes) {
      if (mergePairsCompared >= MAX_MERGE_PAIRS || counts.merge >= MAX_MERGE_RESULTS) break;
      if (scope.done) continue;
      const next = scope.iterator.next();
      if (next.done) { scope.done = true; continue; }
      advanced = true;
      const [a, b] = next.value;
      scope.comparedPairs++; mergePairsCompared++; comparedPaths.add(a.note.path); comparedPaths.add(b.note.path);
      if (a.body === b.body || Math.min(a.words.size, b.words.size) < 6 || outgoing.get(a.note.path)?.has(b.note.path) || outgoing.get(b.note.path)?.has(a.note.path)) continue;
      const shared = [...a.words].filter(word => b.words.has(word)), titleTerms = [...a.title].filter(word => b.title.has(word));
      const smallerOverlap = shared.length / Math.min(a.words.size, b.words.size), largerOverlap = shared.length / Math.max(a.words.size, b.words.size);
      const strong = shared.length >= 12 && smallerOverlap >= 0.8 && largerOverlap >= 0.6;
      const possible = shared.length >= 6 && titleTerms.length >= 2 && smallerOverlap >= 0.3 && largerOverlap >= 0.15 ||
        shared.length >= 8 && smallerOverlap >= 0.75 && largerOverlap >= 0.2;
      if (!strong && !possible) continue;
      shared.sort((a, b) => frequencies.get(a) - frequencies.get(b) || a.localeCompare(b));
      add('merge', strong ? 'Strong content overlap; inspect differences before considering a merge.' : 'Possible topic overlap; the notes may contain complementary or conflicting details.',
        'Review only: compare both sources. This suggestion never authorizes removal or an automatic merge.', [a.note, b.note],
        {reviewOnly: true, evidence: {level: strong ? 'strong-overlap' : 'possible-overlap', methods: ['lexical'], terms: [...new Set([...titleTerms, ...shared])].slice(0, 8), overlap: 2 * shared.length / (a.words.size + b.words.size)}});
    }
    if (!advanced) break;
  }
  items.sort((a, b) => {
    if (a.category !== 'merge' || b.category !== 'merge') return Number(a.category === 'merge') - Number(b.category === 'merge');
    return b.evidence.overlap - a.evidence.overlap || a.id.localeCompare(b.id);
  });
  const mergeIncomplete = mergeSkippedNotes > 0 || mergePairsCompared < mergePossiblePairs;
  const warnings = [];
  if (mergeSkippedNotes) warnings.push('Merge suggestions are limited to the first 300 substantive active notes per project; additional notes were not compared.');
  if (mergeIncomplete) warnings.push('Lexical overlap coverage is partial. The comparison budget is shared across workspaces; narrow the workspace to inspect more pairs.');
  if (!usage.tracking.healthy) warnings.push(usage.tracking.reason || 'Usage tracking unavailable; stale candidates may be incomplete.');
  const started = Date.parse(usage.tracking.startedAt);
  const result = {scannedAt, scannedNotes: selected.length, items, counts, warnings, semantic: {
    enabled: Boolean(config.embeddings?.enabled), state: config.embeddings?.enabled ? 'not-requested' : 'disabled', model: config.embeddings?.model || null,
  }, coverage: {
    totalNotes: notes.length, selectedNotes: selected.length, mergeComparedNotes: comparedPaths.size, mergeSkippedNotes, mergePairsCompared, mergePossiblePairs, mergeIncomplete,
    mergePairLimit: MAX_MERGE_PAIRS, mergeResultLimit: MAX_MERGE_RESULTS, mergeNotesPerProjectLimit: MAX_MERGE_NOTES_PER_PROJECT, mergeWordsPerNoteLimit: MAX_WORDS,
    workspaces: scopes.map(({project, notes, possiblePairs, comparedPairs}) => ({project, notes, possiblePairs, comparedPairs})),
    insufficientHistoryNotes: selected.filter(note => usageByPath.get(note.path)?.status === 'insufficient-history').length,
    trackingHistoryDays: Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 86400000)) : null, usageTracking: usage.tracking}};
  Object.defineProperty(result, scanInternals, {value: {projects, outgoing, summaries}});
  if (!semantic || !config.embeddings?.enabled) return result;
  const entries = [...projects.values()].flat().filter(({note}) => !protectedDeletionReason(note.path) && note.kind !== 'proposal').map(({note}) => ({note, content: mergeBody(note.content)})).filter(entry => entry.content.trim());
  let output;
  try {
    output = await semanticPairs(config, entries, {signal});
  } catch (error) {
    if (signal?.aborted) throw error;
    output = {pairs: [], status: {enabled: true, state: 'error', model: config.embeddings?.model || null, reason: error.message || 'Semantic comparison unavailable.'}};
  }
  if (signal?.aborted) throw signal.reason || new Error('Cleanup request cancelled.');
  // Rebuild the lexical scan after inference so neither its results nor semantic hints
  // describe notes or relationships that changed while the model was running.
  const fresh = await getCleanup(config, workspace, renderMarkdown);
  fresh.semantic = output.status;
  const current = new Map([...fresh[scanInternals].projects.values()].flat().map(entry => [entry.note.path, entry]));
  const original = new Map(entries.map(entry => [entry.note.path, entry.note]));
  const mergeItems = new Map(fresh.items.filter(item => item.category === 'merge').map(item => [item.id, item]));
  let stalePairs = 0;
  for (const pair of output.pairs) {
    const a = current.get(pair.left.path), b = current.get(pair.right.path);
    const beforeA = original.get(pair.left.path), beforeB = original.get(pair.right.path);
    if (!a || !b || !beforeA || !beforeB || a.note.path === b.note.path || a.note.project !== b.note.project ||
        a.note.revision !== pair.left.revision || b.note.revision !== pair.right.revision ||
        a.note.reviewStatus !== beforeA.reviewStatus || b.note.reviewStatus !== beforeB.reviewStatus ||
        a.note.reviewedRevision !== beforeA.reviewedRevision || b.note.reviewedRevision !== beforeB.reviewedRevision) { stalePairs++; continue; }
    if (a.body === b.body || fresh[scanInternals].outgoing.get(a.note.path)?.has(b.note.path) || fresh[scanInternals].outgoing.get(b.note.path)?.has(a.note.path)) continue;
    const id = idOf('merge', [a.note, b.note]), existing = mergeItems.get(id);
    if (existing) {
      existing.evidence.semanticSimilarity = pair.similarity;
      existing.evidence.passages = pair.passages;
      existing.evidence.methods = ['lexical', 'semantic'];
    } else {
      const summary = note => fresh[scanInternals].summaries.get(note.path);
      const item = {id, category: 'merge', reason: 'Semantic content similarity suggests possible overlap; similarity is not a probability or proof of duplication.',
        recommendation: 'Review only: compare both sources. This suggestion never authorizes removal or an automatic merge.',
        notes: [summary(a.note), summary(b.note)], reviewOnly: true,
        evidence: {level: 'semantic-overlap', methods: ['semantic'], terms: [], overlap: pair.similarity, semanticSimilarity: pair.similarity, passages: pair.passages}};
      fresh.items.push(item); fresh.counts.merge++; mergeItems.set(id, item);
    }
  }
  if (stalePairs) fresh.semantic = {...fresh.semantic, incomplete: true, state: 'incomplete',
    reason: `${fresh.semantic.reason ? fresh.semantic.reason + ' ' : ''}Some notes or review state changed during comparison; stale evidence was dropped. Rescan to compare current sources.`};
  fresh.items.sort((a, b) => a.category !== 'merge' || b.category !== 'merge' ? Number(a.category === 'merge') - Number(b.category === 'merge') : b.evidence.overlap - a.evidence.overlap || a.id.localeCompare(b.id));
  return fresh;
}
