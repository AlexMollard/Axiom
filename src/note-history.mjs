import * as fs from 'node:fs/promises';
import {structuredPatch} from 'diff';
import {hash, safePath, readNote, locked, prepareMarkdown, commitMarkdown} from './memory.mjs';
import {REVIEW_LEDGER_PATH} from './note-reviews.mjs';
import {WORKSPACE_ICONS_PATH} from './workspace-icons.mjs';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const ID = /^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-([0-9a-f]{64}))?\.md$/;

function validateId(id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid history revision ID.');
}

function savedAt(id) {
  const date = new Date(Number(ID.exec(id)[1]));
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid history revision timestamp.');
  return date.toISOString();
}

async function historyDirectory(config, relative) {
  try {
    const directory = await safePath(config.backupDir, `history/${hash(relative)}`);
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('History path is not an ordinary directory.');
    return directory;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readRevision(config, relative, id) {
  validateId(id);
  const directory = await historyDirectory(config, relative);
  if (!directory) throw Object.assign(new Error('History revision not found.'), {code: 'ENOENT'});
  const full = await safePath(config.backupDir, `history/${hash(relative)}/${id}`);
  const handle = await fs.open(full, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('History revision must be an ordinary file no larger than 2 MiB.');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error('History revision changed while reading.');
    const bytes = buffer.subarray(0, length);
    const content = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error('History revision is not valid UTF-8 text.');
    const revision = hash(bytes);
    const expected = ID.exec(id)[3];
    if (expected && revision !== expected) throw new Error('History revision failed integrity verification.');
    return {id, revision, content, savedAt: savedAt(id), bytes: bytes.length, integrity: expected ? 'verified' : 'legacy'};
  } finally { await handle.close(); }
}

async function readRequestedRevision(config, relative, canonical, id) {
  validateId(id);
  let found;
  for (const candidate of new Set([canonical, relative])) {
    try {
      const revision = await readRevision(config, candidate, id);
      if (found) throw new Error('History revision ID is ambiguous across archive directories.');
      found = revision;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!found) throw Object.assign(new Error('History revision not found.'), {code: 'ENOENT'});
  return found;
}

export async function getNoteHistory(config, relative, {offset = 0, limit = 30} = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('History offset must be non-negative and limit must be between 1 and 100.');
  const note = await readNote(config, relative);
  const ids = new Set();
  let count = 0;
  for (const candidate of new Set([note.path, relative])) {
    const directory = await historyDirectory(config, candidate);
    if (!directory) continue;
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      if (++count > MAX_ENTRIES) throw new Error('History directory exceeds the safe entry limit.');
      if (ID.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('History revision is not an ordinary file.');
        if (ids.has(entry.name)) throw new Error('History revision ID is ambiguous across archive directories.');
        ids.add(entry.name);
      }
    }
  }
  const ordered = [...ids].sort().reverse();
  const items = [];
  for (const id of ordered.slice(offset, offset + limit)) {
    const {revision, savedAt: time, bytes, integrity} = await readRequestedRevision(config, relative, note.path, id);
    items.push({id, revision, savedAt: time, bytes, integrity});
  }
  return {path: note.path, currentRevision: note.revision, items, total: ids.size, hasMore: offset + items.length < ids.size};
}

export async function getNoteHistoryRevision(config, relative, id) {
  const note = await readNote(config, relative);
  const revision = await readRequestedRevision(config, relative, note.path, id);
  const patch = structuredPatch('history', 'current', revision.content, note.content, '', '', {context: 3, maxEditLength: 4000, timeout: 1000});
  if (!patch) throw new Error('The changes are too large to compare safely.');
  const changes = patch.hunks.flatMap(hunk => [
    {type: 'context', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`},
    ...hunk.lines.map(line => ({type: line[0] === '+' ? 'added' : line[0] === '-' ? 'removed' : 'context', text: (['+', '-', ' '].includes(line[0]) ? line.slice(1) : line).replace(/\r$/, '')}))
  ]);
  return {path: note.path, id, revision: revision.revision, content: revision.content, savedAt: revision.savedAt, integrity: revision.integrity, currentRevision: note.revision, changes};
}

export async function restoreNoteHistoryFromEditor(config, relative, id, expectedRevision) {
  if (!/^[a-f0-9]{64}$/.test(expectedRevision || '')) throw new Error('Supply the current note revision.');
  validateId(id);
  return locked(config, async () => {
    const note = await readNote(config, relative);
    if ([REVIEW_LEDGER_PATH, WORKSPACE_ICONS_PATH].some(control => control.toLowerCase() === note.path.toLowerCase())) throw new Error('Control files cannot be restored through note history.');
    const revision = await readRequestedRevision(config, relative, note.path, id);
    const prepared = await prepareMarkdown(config, note.path, revision.content, expectedRevision, {normalize: false});
    if (prepared.current === revision.content) return note;
    return commitMarkdown(config, prepared);
  });
}
