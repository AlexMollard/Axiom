import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {structuredPatch} from 'diff';
import {readNote, safePath} from './memory.mjs';
import {validateAgentNotePath} from './note-reviews.mjs';

const hash = content => createHash('sha256').update(content).digest('hex');
const revisionPath = revision => `.axiom/review-revisions/${revision}.md`;

export async function preserveReviewedRevision(config, note) {
  validateAgentNotePath(note.path);
  if (!/^[a-f0-9]{64}$/.test(note.revision || '') || typeof note.content !== 'string' || hash(note.content) !== note.revision) throw new Error('Reviewed content does not match its revision.');
  for (const relative of ['.axiom', '.axiom/review-revisions']) {
    const directory = await safePath(config.vault, relative, true, true);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const checked = await safePath(config.vault, relative, false, true);
    if (!(await fs.lstat(checked)).isDirectory()) throw new Error('Review revision directory is not an ordinary directory.');
  }
  const full = await safePath(config.vault, revisionPath(note.revision), true, true);
  try { await fs.writeFile(full, note.content, {flag: 'wx'}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const checked = await safePath(config.vault, revisionPath(note.revision), false, true);
  const stat = await fs.lstat(checked);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || hash(await fs.readFile(checked)) !== note.revision) throw new Error('Stored review revision failed integrity verification.');
}

export async function getReviewDiff(config, relative) {
  validateAgentNotePath(relative);
  const note = await readNote(config, relative);
  const result = {path: relative, currentRevision: note.revision, reviewedRevision: note.reviewedRevision, reviewedAt: note.lastReviewedAt, reviewKind: note.reviewKind, available: false, changes: []};
  if (!note.reviewedRevision) return {...result, reason: 'This note has no previously reviewed revision.'};
  let baseline;
  try {
    const full = await safePath(config.vault, revisionPath(note.reviewedRevision), false, true);
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return {...result, reason: 'The reviewed baseline is not a valid file.'};
    const bytes = await fs.readFile(full);
    if (hash(bytes) !== note.reviewedRevision) return {...result, reason: 'The reviewed baseline failed integrity verification.'};
    baseline = bytes.toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {...result, reason: 'The reviewed baseline was not preserved (for example, a legacy review).'};
    throw error;
  }
  const patch = structuredPatch('reviewed', 'current', baseline, note.content, '', '', {context: 3, maxEditLength: 4000, timeout: 1000});
  if (!patch) return {...result, reason: 'The changes are too large to compare safely.'};
  const changes = patch.hunks.flatMap(hunk => [
    {type: 'context', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`},
    ...hunk.lines.map(line => ({type: line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context', text: (['+', '-', ' '].includes(line[0]) ? line.slice(1) : line).replace(/\r$/, '')}))
  ]);
  return {...result, available: true, changes};
}
