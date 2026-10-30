const decisions = new Set(['approved', 'rejected', 'undecided']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const text = value => typeof value === 'string' ? value : '';

function vaultKey(vaultId) {
  if (typeof vaultId !== 'string' || !vaultId.trim()) throw new Error('A valid vault ID is required to save cleanup decisions.');
  return `axiom.cleanup.decisions.v1:${encodeURIComponent(vaultId)}`;
}

export function decisionKey(item) {
  if (!plain(item) || typeof item.category !== 'string' || !item.category || typeof item.id !== 'string' || !item.id || !Array.isArray(item.notes) || !item.notes.length) throw new Error('Invalid cleanup item.');
  const sources = item.notes.map(note => {
    if (!plain(note) || typeof note.path !== 'string' || !note.path || typeof note.revision !== 'string' || !note.revision) throw new Error('Cleanup sources require paths and revisions.');
    return [note.path, note.revision];
  }).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  return JSON.stringify([item.category, item.id, sources]);
}

function record(value) {
  if (!plain(value) || !['decision', 'instructions', 'targetPath', 'updatedAt'].every(key => own(value, key)) || !decisions.has(value.decision) || typeof value.instructions !== 'string' || !(value.targetPath === null || typeof value.targetPath === 'string') || typeof value.updatedAt !== 'string' || !value.updatedAt) return null;
  return {decision: value.decision, instructions: value.instructions, targetPath: value.targetPath, updatedAt: value.updatedAt};
}

function cleanRecords(value) {
  const result = Object.create(null);
  if (!plain(value)) return result;
  for (const [key, valueRecord] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const valid = record(valueRecord);
    if (valid) result[key] = valid;
  }
  return result;
}

export function readDecisions(storage, vaultId) {
  const raw = storage.getItem(vaultKey(vaultId));
  if (raw === null) return Object.create(null);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return Object.create(null); }
  return cleanRecords(parsed);
}

export function writeDecisions(storage, vaultId, records) {
  storage.setItem(vaultKey(vaultId), JSON.stringify(cleanRecords(records)));
}

function evidenceOf(value, paths) {
  if (!plain(value)) return null;
  const result = {};
  if (typeof value.level === 'string') result.level = value.level;
  if (Array.isArray(value.methods)) result.methods = value.methods.filter(method => typeof method === 'string');
  if (Array.isArray(value.terms)) result.terms = value.terms.filter(term => typeof term === 'string');
  for (const key of ['overlap', 'semanticSimilarity']) if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = value[key];
  if (Array.isArray(value.passages)) result.passages = value.passages.filter(passage => plain(passage) && paths.has(passage.path) && typeof passage.heading === 'string' && typeof passage.excerpt === 'string').map(passage => ({path: passage.path, heading: passage.heading.slice(0, 160), excerpt: passage.excerpt.slice(0, 400)}));
  return result;
}

export function buildHandoff({vaultId, workspace, items, decisions: saved, generatedAt}) {
  vaultKey(vaultId);
  const records = cleanRecords(saved);
  const reportItems = (Array.isArray(items) ? items : []).map(item => {
    const key = decisionKey(item), selected = records[key] || {decision: 'undecided', instructions: '', targetPath: null, updatedAt: ''};
    const paths = new Set(item.notes.map(note => note.path));
    const targetPath = paths.has(selected.targetPath) ? selected.targetPath : null;
    const approvedMerge = selected.decision === 'approved' && ['merge', 'duplicate'].includes(item.category);
    const humanOnly = item.notes.some(note => note.owner !== 'agent' || !note.path.startsWith('Agents/') || note.path.toLowerCase() === 'agents/workspace icons.md');
    return {key, id: item.id, category: item.category, decision: selected.decision, instructions: selected.instructions, targetPath, updatedAt: selected.updatedAt || null,
      actionable: approvedMerge && !humanOnly, execution: !approvedMerge ? 'none' : humanOnly ? 'human-proposal' : 'agent-merge',
      reason: text(item.reason), recommendation: text(item.recommendation), evidence: evidenceOf(item.evidence, paths),
      notes: item.notes.map(note => ({path: note.path, revision: note.revision, title: text(note.title), owner: text(note.owner), project: text(note.project), cleanupBlockedReason: typeof note.cleanupBlockedReason === 'string' ? note.cleanupBlockedReason : null}))};
  });
  return {version: 1, generatedAt: generatedAt ?? new Date().toISOString(), vaultId, workspace: workspace ?? null,
    scope: 'This brief contains only the current scan items. Similarity and excerpts are evidence for review, not proof that notes agree; embeddings do not generate explanations or judge agreement.',
    rules: [
      'Resolve the configured Axiom vault and verify its vaultId matches this brief before reading or writing source paths.',
      'Only approved merge or duplicate suggestions are actionable. Rejected and undecided items, and all other categories, are not authorization to act.',
      'Re-read every full source and verify its exact recorded revision before acting; stop if any source is missing or changed.',
      'Owner-controlled and control notes are human-only: never modify, move, rename or delete them. Propose owner-note changes under Agents/Proposals/ for human review.',
      'Respect source ownership, protection and project scope. A preferred target is optional and is not authorization to modify a protected note.',
      'Compare the sources critically; preserve provenance, history, disagreements and distinct information. Do not blindly concatenate notes.',
      'Do not automatically delete notes or change review ledgers. Escalate uncertain or conflicting cases to the human.'
    ], items: reportItems};
}
