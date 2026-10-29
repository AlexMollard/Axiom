export const REVIEW_LEDGER_PATH = 'Owner/Reviews.md';

export function validateAgentNotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('Agents/') || !/\.md$/i.test(value) || value.includes('\\') || value.includes(':') || value.includes('\0')) throw new Error('Review paths must be Markdown notes under Agents/.');
  if (value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.') || part.endsWith('.') || part.endsWith(' ') || /[<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw new Error('Unsafe review path.');
}

export function parseReviewLedger(content) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter || !/^status:\s*current\s*$/m.test(frontmatter[1]) || !/^project:\s*global\s*$/m.test(frontmatter[1])) throw new Error('Review ledger requires status current and project global.');
  const fences = [...content.matchAll(/^```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/gm)];
  if (fences.length !== 1) throw new Error('Review ledger requires one JSON fence.');
  let data;
  try { data = JSON.parse(fences[0][1]); } catch { throw new Error('Invalid review ledger JSON.'); }
  if (!data || Array.isArray(data) || typeof data !== 'object' || ![1, 2].includes(data.version) || !data.reviews || Array.isArray(data.reviews) || typeof data.reviews !== 'object' || Object.keys(data).some(key => !['version', 'reviews'].includes(key))) throw new Error('Invalid review ledger schema.');
  for (const [notePath, entry] of Object.entries(data.reviews)) {
    validateAgentNotePath(notePath);
    if (!entry || Array.isArray(entry) || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== (data.version === 1 ? 'reviewedAt,revision' : 'approved,reviewedAt,revision') || (data.version === 2 && typeof entry.approved !== 'boolean') || !/^[a-f0-9]{64}$/.test(entry.revision || '') || typeof entry.reviewedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.reviewedAt) || Number.isNaN(Date.parse(entry.reviewedAt)) || new Date(entry.reviewedAt).toISOString() !== entry.reviewedAt) throw new Error('Invalid review ledger entry.');
    if (data.version === 1) entry.approved = true;
  }
  return data.reviews;
}

export function serializeReviewLedger(reviews) {
  return `---\nstatus: current\nproject: global\n---\n\n# Human reviews\n\n\`\`\`json\n${JSON.stringify({version: 2, reviews}, null, 2)}\n\`\`\`\n`;
}

export function applyReview(note, reviews) {
  if (note.owner !== 'agent') return note;
  const entry = reviews[note.path];
  const sameRevision = entry?.revision === note.revision;
  const reviewed = sameRevision && entry.approved;
  const reviewKind = !entry ? 'new' : !sameRevision ? 'changed' : entry.approved ? 'reviewed' : 'reopened';
  return {...note, reviewStatus: reviewed ? 'reviewed' : 'unreviewed', reviewedAt: reviewed ? entry.reviewedAt : null, reviewedRevision: entry?.revision || null, lastReviewedAt: entry?.reviewedAt || null, reviewKind};
}
