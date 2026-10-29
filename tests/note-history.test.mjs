import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readNote, saveFromEditor, saveReviewFromEditor, hash} from '../src/memory.mjs';
import {REVIEW_LEDGER_PATH, serializeReviewLedger} from '../src/note-reviews.mjs';
import {WORKSPACE_ICONS_PATH} from '../src/workspace-icons.mjs';
import {getNoteHistory, getNoteHistoryRevision, restoreNoteHistoryFromEditor} from '../src/note-history.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-history-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, 'Agents'), {recursive: true});
  const config = {vault, backupDir: path.join(root, 'backup'), projects: []};
  const relative = 'Agents/Note.md';
  await fs.writeFile(path.join(vault, relative), '# Original\nFirst line\n');
  return {config, relative};
}

test('lists, compares and restores archived exact bytes with CAS and undo', async t => {
  const {config, relative} = await fixture(t);
  const original = await readNote(config, relative);
  assert.deepEqual((await getNoteHistory(config, relative)).items, []);
  const changed = await saveFromEditor(config, relative, '# Changed\nSecond line\n', original.revision);
  const list = await getNoteHistory(config, relative, {limit: 1});
  assert.equal(list.total, 1);
  assert.equal(list.items[0].revision, original.revision);
  assert.equal(list.items[0].bytes, Buffer.byteLength(original.content));
  assert.equal(list.items[0].integrity, 'verified');
  const detail = await getNoteHistoryRevision(config, relative, list.items[0].id);
  assert.equal(detail.content, original.content);
  assert.equal(detail.currentRevision, changed.revision);
  assert.equal(detail.integrity, 'verified');
  assert.ok(detail.changes.some(change => change.type === 'added' && change.text.includes('Changed')));
  await assert.rejects(restoreNoteHistoryFromEditor(config, relative, list.items[0].id, original.revision), {status: 409});
  const restored = await restoreNoteHistoryFromEditor(config, relative, list.items[0].id, changed.revision);
  assert.equal(restored.revision, original.revision);
  assert.equal(restored.content, original.content);
  const after = await getNoteHistory(config, relative, {offset: 1, limit: 1});
  assert.equal(after.total, 2);
  assert.equal(after.items.length, 1);
  assert.equal(after.hasMore, false);
  await restoreNoteHistoryFromEditor(config, relative, list.items[0].id, restored.revision);
  assert.equal((await getNoteHistory(config, relative)).total, 2);
});

test('restores do not edit the human review ledger', async t => {
  const {config, relative} = await fixture(t);
  const original = await readNote(config, relative);
  await saveReviewFromEditor(config, relative, original.revision, 'reviewed');
  const ledger = await fs.readFile(path.join(config.vault, REVIEW_LEDGER_PATH));
  const changed = await saveFromEditor(config, relative, '# Changed\n', original.revision);
  const id = (await getNoteHistory(config, relative)).items[0].id;
  const restored = await restoreNoteHistoryFromEditor(config, relative, id, changed.revision);
  assert.equal(restored.revision, original.revision);
  assert.deepEqual(await fs.readFile(path.join(config.vault, REVIEW_LEDGER_PATH)), ledger);
});

test('rejects invalid IDs, pagination, missing notes and protected restores', async t => {
  const {config, relative} = await fixture(t);
  const original = await readNote(config, relative);
  await assert.rejects(getNoteHistory(config, relative, {limit: 101}));
  await assert.rejects(getNoteHistory(config, '../escape.md'));
  await assert.rejects(getNoteHistory(config, 'Agents/Missing.md'));
  await assert.rejects(getNoteHistoryRevision(config, relative, '../outside.md'));
  await assert.rejects(restoreNoteHistoryFromEditor(config, relative, '../outside.md', original.revision));
  for (const control of [REVIEW_LEDGER_PATH, WORKSPACE_ICONS_PATH]) {
    await fs.mkdir(path.dirname(path.join(config.vault, control)), {recursive: true});
    const content = control === REVIEW_LEDGER_PATH ? serializeReviewLedger({}) : '# Control\n';
    await fs.writeFile(path.join(config.vault, control), content);
    await assert.rejects(restoreNoteHistoryFromEditor(config, control, '1234567890123-12345678-1234-1234-1234-123456789abc.md', hash(content)), /Control files/);
  }
});

test('rejects oversized and linked history revisions', async t => {
  const {config, relative} = await fixture(t);
  const note = await readNote(config, relative);
  await saveFromEditor(config, relative, '# New\n', note.revision);
  const id = (await getNoteHistory(config, relative)).items[0].id;
  const archive = path.join(config.backupDir, 'history', hash(relative), id);
  await fs.writeFile(archive, Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(getNoteHistoryRevision(config, relative, id), /2 MiB/);
  if (process.platform !== 'win32') {
    await fs.unlink(archive);
    await fs.symlink(path.join(config.vault, relative), archive);
    await assert.rejects(getNoteHistoryRevision(config, relative, id), /Links and junctions/);
  }
});

test('labels legacy archives and rejects tampered checksummed archives', async t => {
  const {config, relative} = await fixture(t);
  const original = await readNote(config, relative);
  const current = await saveFromEditor(config, relative, '# Changed\n', original.revision);
  const directory = path.join(config.backupDir, 'history', hash(relative));
  const verified = (await getNoteHistory(config, relative)).items[0];
  const legacyId = '1234567890123-12345678-1234-1234-1234-123456789abc.md';
  await fs.writeFile(path.join(directory, legacyId), '# Legacy\n');
  const legacy = await getNoteHistoryRevision(config, relative, legacyId);
  assert.equal(legacy.integrity, 'legacy');
  assert.equal((await getNoteHistory(config, relative)).items.find(item => item.id === legacyId).integrity, 'legacy');
  await fs.writeFile(path.join(directory, verified.id), '# Tampered\n');
  await assert.rejects(getNoteHistoryRevision(config, relative, verified.id), /integrity/);
  await assert.rejects(restoreNoteHistoryFromEditor(config, relative, verified.id, current.revision), /integrity/);
});

test('restores large LF archives without expanding line endings', async t => {
  const {config, relative} = await fixture(t);
  const content = '\n'.repeat(2 * 1024 * 1024);
  await fs.writeFile(path.join(config.vault, relative), content);
  const original = await readNote(config, relative);
  const current = await saveFromEditor(config, relative, '# Small\n', original.revision);
  const id = (await getNoteHistory(config, relative)).items[0].id;
  const restored = await restoreNoteHistoryFromEditor(config, relative, id, current.revision);
  assert.equal(restored.revision, original.revision);
  assert.equal(restored.content, content);
});

test('Windows finds explicitly supplied legacy spelling alongside canonical history', {skip: process.platform !== 'win32'}, async t => {
  const {config, relative} = await fixture(t);
  const alternate = 'agents/note.md';
  const original = await readNote(config, relative);
  const current = await saveFromEditor(config, relative, '# New\n', original.revision);
  const directory = path.join(config.backupDir, 'history', hash(alternate));
  await fs.mkdir(directory, {recursive: true});
  const id = '1234567890123-12345678-1234-1234-1234-123456789abc.md';
  await fs.writeFile(path.join(directory, id), '# Legacy\n');
  assert.equal((await getNoteHistory(config, alternate)).total, 2);
  assert.equal((await getNoteHistoryRevision(config, alternate, id)).content, '# Legacy\n');
  assert.equal((await restoreNoteHistoryFromEditor(config, alternate, id, current.revision)).content, '# Legacy\n');
  assert.equal((await getNoteHistory(config, relative)).total, 2);
});
