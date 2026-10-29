import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {catalog, readNote, search, saveFromEditor, saveReviewFromEditor, writeNote, projectFor, backup, restore} from '../src/memory.mjs';
import {getReviewDiff, preserveReviewedRevision} from '../src/review-history.mjs';
import {parseReviewLedger, serializeReviewLedger, applyReview} from '../src/note-reviews.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-review-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, 'Agents'), {recursive: true});
  const config = {vault, backupDir: path.join(root, 'backup'), projects: [], port: 0};
  const first = 'Agents/First.md', second = 'Agents/Second.md';
  await fs.writeFile(path.join(vault, first), '---\nstatus: reviewed\nproject: global\n---\n# First\nreviewable search text\n');
  await fs.writeFile(path.join(vault, second), '# Second\nreviewable search text\n');
  return {root, config, first, second};
}

test('HTTP human review, undo, stale revision and editor security', async t => {
  const {config, first} = await fixture(t);
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  config.port = server.address().port;
  const origin = `http://127.0.0.1:${config.port}`;
  const token = (await (await fetch(`${origin}/api/editor-session`)).json()).token;
  const headers = {'content-type': 'application/json', origin, 'x-shared-brain-csrf': token};
  const request = (body, custom = headers) => fetch(`${origin}/api/note-review`, {method: 'PUT', headers: custom, body: JSON.stringify(body)});
  let note = await readNote(config, first);
  assert.equal(note.reviewStatus, 'unreviewed');
  await assert.rejects(fs.stat(path.join(config.vault, 'Owner', 'Reviews.md')), {code: 'ENOENT'});
  assert.equal((await request({path: first, expectedRevision: note.revision, decision: 'reviewed'}, {'content-type': 'application/json', origin})).status, 403);
  assert.equal((await request({path: first, expectedRevision: note.revision, decision: 'reviewed'}, {...headers, origin: 'http://evil.example'})).status, 403);
  assert.equal((await request({path: first, expectedRevision: note.revision, decision: 'reviewed'}, {...headers, 'sec-fetch-site': 'cross-site'})).status, 403);
  assert.equal((await request({path: first, expectedRevision: note.revision, decision: 'reviewed'}, {...headers, 'content-type': 'text/plain'})).status, 415);
  let response = await request({path: first, expectedRevision: note.revision, decision: 'reviewed'});
  assert.equal(response.status, 200);
  let result = await response.json();
  assert.equal(result.note.reviewStatus, 'reviewed');
  assert.ok(result.note.reviewedAt);
  assert.equal(result.note.reviewKind, 'reviewed');
  assert.equal(result.note.reviewedRevision, note.revision);
  assert.equal((await getReviewDiff(config, first)).available, true);
  assert.match(result.html, /First/);
  assert.equal((await catalog(config)).find(item => item.path === first).reviewStatus, 'reviewed');
  assert.equal((await search(config, 'reviewable', {all: true})).items.find(item => item.path === first).reviewStatus, 'reviewed');
  const old = note;
  note = await saveFromEditor(config, first, `${old.content}\nchanged`, old.revision);
  assert.equal(note.reviewStatus, 'unreviewed');
  assert.equal(note.reviewKind, 'changed');
  const changedDiff = await getReviewDiff(config, first);
  assert.equal(changedDiff.available, true);
  assert.ok(changedDiff.changes.some(change => change.type === 'added' && change.text.includes('changed')));
  const diffResponse = await fetch(`${origin}/api/review-diff?path=${encodeURIComponent(first)}`);
  assert.equal(diffResponse.status, 200);
  const httpDiff = await diffResponse.json();
  assert.equal(httpDiff.reviewKind, 'changed');
  assert.equal(httpDiff.reviewedRevision, old.revision);
  assert.ok(httpDiff.changes.some(change => change.type === 'added' && change.text.includes('changed')));
  assert.equal((await request({path: first, expectedRevision: old.revision, decision: 'reviewed'})).status, 409);
  note = await saveFromEditor(config, first, old.content, note.revision);
  // Editor normalizes line endings, so restore exact original bytes separately below.
  await fs.writeFile(path.join(config.vault, first), old.content);
  note = await readNote(config, first);
  assert.equal(note.reviewStatus, 'reviewed');
  response = await request({path: first, expectedRevision: note.revision, decision: 'unreviewed'});
  assert.equal(response.status, 200);
  const reopened = (await response.json()).note;
  assert.equal(reopened.reviewStatus, 'unreviewed');
  assert.equal(reopened.reviewKind, 'reopened');
  assert.equal(reopened.reviewedRevision, note.revision);
  assert.equal((await getReviewDiff(config, first)).available, true);
  const changedAgain = await saveFromEditor(config, first, `${note.content}\nchanged again`, note.revision);
  assert.equal(changedAgain.reviewKind, 'changed');
  await assert.rejects(writeNote(config, 'Owner/Reviews.md', 'bad', 'new'), /restricted/);
});

test('ledger validation preserves existing reviews and concurrent attempts cannot lose updates', async t => {
  const {config, first, second} = await fixture(t);
  const a = await readNote(config, first), b = await readNote(config, second);
  const outcomes = await Promise.allSettled([saveReviewFromEditor(config, first, a.revision, 'reviewed'), saveReviewFromEditor(config, second, b.revision, 'reviewed')]);
  for (let i = 0; i < outcomes.length; i++) if (outcomes[i].status === 'rejected') {
    assert.match(outcomes[i].reason.message, /holds/);
    await saveReviewFromEditor(config, [first, second][i], [a, b][i].revision, 'reviewed');
  }
  assert.equal((await readNote(config, first)).reviewStatus, 'reviewed');
  assert.equal((await readNote(config, second)).reviewStatus, 'reviewed');
  const ledger = await readNote(config, 'Owner/Reviews.md');
  await assert.rejects(saveFromEditor(config, ledger.path, '---\nstatus: current\nproject: global\n---\n```json\n{"version":1,"reviews":{"Agents/../Owner/x.md":{"revision":"bad","reviewedAt":"bad"}}}\n```\n', ledger.revision), /review|Unsafe/i);
  assert.equal((await readNote(config, ledger.path)).revision, ledger.revision);
  assert.equal((await readNote(config, first)).reviewStatus, 'reviewed');
  const historyRoot = path.join(config.backupDir, 'history');
  const histories = await fs.readdir(historyRoot, {recursive: true});
  const previousLedgers = await Promise.all(histories.filter(file => file.endsWith('.md')).map(file => fs.readFile(path.join(historyRoot, file), 'utf8')));
  assert.ok(previousLedgers.some(content => content.includes(a.revision) && !content.includes(b.revision)) || previousLedgers.some(content => content.includes(b.revision) && !content.includes(a.revision)));
  const snapshot = await backup(config);
  const destination = path.join(config.vault, '..', 'restored');
  await restore(config, snapshot.snapshot, destination);
  const recovered = {...config, vault: destination};
  assert.equal((await readNote(recovered, first)).reviewStatus, 'reviewed');
  assert.equal((await readNote(recovered, second)).reviewStatus, 'reviewed');
});

test('legacy reviews remain readable and unavailable baselines are explicit', async t => {
  const {config, first} = await fixture(t);
  const note = await readNote(config, first);
  const reviewedAt = '2025-01-01T00:00:00.000Z';
  const legacy = `---\nstatus: current\nproject: global\n---\n\`\`\`json\n${JSON.stringify({version: 1, reviews: {[first]: {revision: note.revision, reviewedAt}}})}\n\`\`\`\n`;
  const reviews = parseReviewLedger(legacy);
  assert.equal(reviews[first].approved, true);
  assert.equal(applyReview(note, reviews).reviewKind, 'reviewed');
  assert.match(serializeReviewLedger(reviews), /"version": 2/);
  await fs.mkdir(path.join(config.vault, 'Owner'));
  await fs.writeFile(path.join(config.vault, 'Owner', 'Reviews.md'), legacy);
  const diff = await getReviewDiff(config, first);
  assert.equal(diff.available, false);
  assert.match(diff.reason, /not preserved/);
  assert.deepEqual(diff.changes, []);
  assert.equal(await fs.readFile(path.join(config.vault, 'Owner', 'Reviews.md'), 'utf8'), legacy);
});

test('revision store rejects corrupt existing baselines and exposes no false diff', async t => {
  const {config, first} = await fixture(t);
  const note = await readNote(config, first);
  await saveReviewFromEditor(config, first, note.revision, 'reviewed');
  const baseline = path.join(config.vault, '.axiom', 'review-revisions', `${note.revision}.md`);
  await fs.writeFile(baseline, 'corrupted');
  await assert.rejects(preserveReviewedRevision(config, note), /integrity/);
  const diff = await getReviewDiff(config, first);
  assert.equal(diff.available, false);
  assert.match(diff.reason, /integrity/);
  assert.deepEqual(diff.changes, []);
});

test('workspace aliases and nested roots select longest match', async t => {
  const {root} = await fixture(t);
  const config = {projects: [{id: 'outer', root: path.join(root, 'outer'), additionalRoots: [path.join(root, 'alias')]}, {id: 'inner', root: path.join(root, 'other'), additionalRoots: [path.join(root, 'alias', 'nested')]}]};
  assert.equal(projectFor(config, path.join(root, 'alias', 'file')), 'outer');
  assert.equal(projectFor(config, path.join(root, 'alias', 'nested', 'file')), 'inner');
  assert.equal(projectFor(config, path.join(root, 'alias-sibling')), 'unmapped');
});
