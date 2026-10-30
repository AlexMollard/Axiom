import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {getCleanup} from '../src/cleanup.mjs';
import {createServer, renderMarkdown} from '../src/server.mjs';
import {catalog} from '../src/memory.mjs';
import {inventoryUsage} from '../src/note-usage.mjs';
import {serializeReviewLedger} from '../src/note-reviews.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-cleanup-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = {vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup'), configPath: path.join(root, 'config.json'), indexPath: path.join(root, 'index.json'), projects: [{id: 'alpha', root: path.join(root, 'alpha')}, {id: 'beta', root: path.join(root, 'beta')}], workspacePins: {}, port: 0};
  await fs.mkdir(config.vault);
  await fs.writeFile(config.configPath, JSON.stringify(config));
  const note = async (name, content) => { const file = path.join(config.vault, name); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, content); };
  return {config, note};
}
const alpha = 'Agents/Memory/Projects/alpha/';
const beta = 'Agents/Memory/Projects/beta/';
const paths = item => item.notes.map(note => note.path).sort();

test('duplicates preserve code and project boundaries, and empty notes exclude code and links', async t => {
  const {config, note} = await fixture(t);
  await note(alpha + 'a.md', '---\ntitle: First\n---\n# Same\n\n```js\nreturn 1;\n```\n');
  await note(alpha + 'b.md', '---\r\ntitle: Second\r\n---\r\n# Same\r\n\r\n```js\r\nreturn 1;\r\n```\r\n');
  await note(alpha + 'different.md', '# Same\n\n```js\nreturn 2;\n```\n');
  await note(beta + 'other.md', '# Same\n\n```js\nreturn 1;\n```\n');
  await note(alpha + 'empty.md', '---\nstatus: unreviewed\n---\n# Empty\n');
  await note(alpha + 'code.md', '# Code\n\n`x`');
  await note(alpha + 'link.md', '# Link\n\n[external](https://example.com)');
  const all = await getCleanup(config, null, renderMarkdown);
  assert.deepEqual(all.items.filter(item => item.category === 'duplicate').map(paths), [[alpha + 'a.md', alpha + 'b.md']]);
  assert.deepEqual(all.items.filter(item => item.category === 'empty').map(paths), [[alpha + 'empty.md']]);
  assert.equal(all.counts.stale, 0);
  assert.equal((await getCleanup(config, 'beta', renderMarkdown)).counts.duplicate, 0);
  await assert.rejects(getCleanup(config, '../outside', renderMarkdown), {status: 400});
});

test('cleanup protects human, pinned, referenced, reviewed and historical notes without changing canonical bytes', async t => {
  const {config, note} = await fixture(t);
  for (const name of ['pin', 'linked', 'provenance', 'reviewed', 'free']) await note(alpha + name + '.md', '# Empty\n');
  await note('Owner/private.md', '# Empty\n');
  await note('Agents/Handovers/handover.md', '# Empty\n');
  await note(alpha + 'retired.md', '---\nstatus: retired\n---\n# Empty\n');
  await note(beta + 'source.md', '---\nsupersedes: [[provenance]]\n---\n# Source\n[[linked]]');
  config.workspacePins.alpha = [alpha + 'pin.md'];
  const reviewed = (await catalog(config)).find(item => item.path === alpha + 'reviewed.md');
  await note('Owner/Reviews.md', serializeReviewLedger({[reviewed.path]: {revision: reviewed.revision, reviewedAt: '2025-01-01T00:00:00.000Z', approved: true}}));
  const before = await catalog(config);
  const contents = new Map(await Promise.all(before.map(async n => [n.path, await fs.readFile(path.join(config.vault, n.path))])));
  const result = await getCleanup(config, null, renderMarkdown);
  const found = new Map(result.items.filter(item => item.category === 'empty').flatMap(item => item.notes.map(n => [n.path, n])));
  for (const name of [alpha + 'pin.md', alpha + 'linked.md', alpha + 'provenance.md', alpha + 'reviewed.md', alpha + 'retired.md', 'Owner/private.md', 'Agents/Handovers/handover.md']) assert.ok(found.get(name).cleanupBlockedReason, name);
  assert.equal(found.get(alpha + 'free.md').cleanupBlockedReason, null);
  assert.match(found.get(alpha + 'free.md').revision, /^[a-f0-9]{64}$/);
  for (const [name, bytes] of contents) assert.deepEqual(await fs.readFile(path.join(config.vault, name)), bytes);
});

test('merge suggestions are scoped lexical hints rather than asserted agreement', async t => {
  const {config, note} = await fixture(t);
  const text = 'architecture cache transaction worker durable revision recovery database journal concurrent safety ownership';
  await note(alpha + 'one.md', `# First\n${text} identical premise`);
  await note(alpha + 'two.md', `# Second\n${text} different conclusion`);
  await note(beta + 'three.md', `# Third\n${text} different conclusion`);
  const result = await getCleanup(config, null, renderMarkdown);
  const merges = result.items.filter(item => item.category === 'merge');
  assert.deepEqual(merges.map(paths), [[alpha + 'one.md', alpha + 'two.md']]);
});

test('staleness requires actual mature usage history', async t => {
  const {config, note} = await fixture(t);
  await note(alpha + 'old.md', '# Old\nbody');
  const old = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(path.join(config.vault, alpha + 'old.md'), old, old);
  const notes = await catalog(config);
  await inventoryUsage(config, notes, {now: Date.now() - 100 * 86400000});
  await note(alpha + 'new.md', '# New\nbody');
  const result = await getCleanup(config, 'alpha', renderMarkdown);
  assert.deepEqual(result.items.filter(item => item.category === 'stale').map(paths), [[alpha + 'old.md']]);
});


test('merge limits report partial coverage while exact duplicates remain complete', async t => {
  const {config, note} = await fixture(t);
  const text = 'architecture cache transaction worker durable revision recovery database journal concurrent safety ownership';
  for (let i = 0; i < 22; i++) await note(alpha + `candidate-${i}.md`, `# Candidate ${i}\n${text} distinct${i}`);
  await note(beta + 'duplicate-one.md', '# Identical\nSame substantive content.');
  await note(beta + 'duplicate-two.md', '# Identical\nSame substantive content.');
  const result = await getCleanup(config, null, renderMarkdown);
  assert.equal(result.counts.merge, 200);
  assert.equal(result.coverage.mergeResultLimit, 200);
  assert(result.coverage.mergePairsCompared < result.coverage.mergePossiblePairs);
  assert(result.items.some(item => item.category === 'duplicate' && paths(item).join(',') === [beta + 'duplicate-one.md', beta + 'duplicate-two.md'].join(',')));
});
test('GET cleanup validates workspace and exposes scan without mutation', async t => {
  const {config, note} = await fixture(t);
  await note(alpha + 'empty.md', '# Empty');
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = url => new Promise((resolve, reject) => http.get({hostname: '127.0.0.1', port: config.port, path: url}, response => { let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => resolve({status: response.statusCode, body: JSON.parse(body)})); }).on('error', reject));
  const result = await request('/api/cleanup?workspace=alpha');
  assert.equal(result.status, 200);
  assert.equal(result.body.counts.empty, 1);
  assert.equal((await request('/api/cleanup?workspace=..%2Foutside')).status, 400);
  assert.equal(await fs.readFile(path.join(config.vault, alpha + 'empty.md'), 'utf8'), '# Empty');
});

test('cleanup deletion rechecks eligibility, protection and revision at confirmation', async t => {
  const {config, note} = await fixture(t);
  for (const name of ['pin', 'review', 'linked', 'changed', 'ordinary', 'delete']) await note(alpha + name + '.md', `# ${name}\n`);
  await note(alpha + 'duplicate-one.md', '# Shared\nDistinctive content.');
  await note(alpha + 'duplicate-two.md', '# Shared\nDistinctive content.');
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${config.port}`;
  const {token} = await (await fetch(`${base}/api/editor-session`)).json();
  const scan = await (await fetch(`${base}/api/cleanup`)).json();
  const notes = new Map(scan.items.flatMap(item => item.notes.map(entry => [entry.path, entry])));
  const remove = (name, cleanup = true) => fetch(`${base}/api/note`, {
    method: 'DELETE', headers: {origin: base, 'content-type': 'application/json', 'x-shared-brain-csrf': token},
    body: JSON.stringify({path: alpha + name + '.md', expectedRevision: notes.get(alpha + name + '.md').revision, cleanup}),
  });
  await fs.writeFile(config.configPath, JSON.stringify({...config, workspacePins: {alpha: [alpha + 'pin.md']}}));
  assert.equal((await remove('pin')).status, 409);
  await note('Owner/Reviews.md', serializeReviewLedger({[alpha + 'review.md']: {revision: notes.get(alpha + 'review.md').revision, reviewedAt: '2025-01-01T00:00:00.000Z', approved: true}}));
  assert.equal((await remove('review')).status, 409);
  await note(beta + 'source.md', '# Source\n[[linked]]');
  assert.equal((await remove('linked')).status, 409);
  await note(alpha + 'changed.md', '# changed\nSubstantive content.');
  assert.equal((await remove('changed')).status, 409);
  await fs.rm(path.join(config.vault, alpha + 'duplicate-two.md'));
  assert.equal((await remove('duplicate-one')).status, 409);
  await fs.rm(path.join(config.vault, alpha + 'ordinary.md'));
  assert.equal((await remove('ordinary')).status, 409);
  assert.equal((await remove('delete')).status, 200);
  assert.equal((await remove('pin', false)).status, 200);
});

test('merge comparisons cover later workspaces before exhausting a large workspace budget', async t => {
  const {config, note} = await fixture(t);
  for (let i = 0; i < 110; i++) await note(alpha + `noise-${i}.md`, `# Log ${i}\n` + Array.from({length: 16}, (_, j) => `term${i}x${j}`).join(' '));
  const shared = 'architecture cache transaction worker durable revision recovery database journal concurrent safety ownership';
  await note(beta + 'one.md', '# Recovery procedure\n' + shared + ' verify primary');
  await note(beta + 'two.md', '# Recovery instructions\n' + shared + ' inspect secondary');
  const result = await getCleanup(config, null, renderMarkdown);
  assert.deepEqual(result.items.filter(item => item.category === 'merge').map(paths), [[beta + 'one.md', beta + 'two.md']]);
  assert.equal(result.coverage.workspaces.find(scope => scope.project === 'beta').comparedPairs, 1);
  assert(result.coverage.mergeIncomplete);
});

test('partial subject overlap is review-only and shared import scaffolding is not content evidence', async t => {
  const {config, note} = await fixture(t);
  const common = 'worker durable revision recovery database journal concurrent safety';
  await note(alpha + 'short.md', '# Cache recovery steps\n' + common + ' startup sequence');
  await note(alpha + 'long.md', '# Cache recovery reference\n' + common + ' disk checksum transaction filesystem snapshot retention rollback scheduler handle source process network routing schema migration locks cancellation timeout deployment');
  const wrapper = '# Operator glossary\n\nImported machine-maintained Claude memory; not owner-approved policy.\nOriginal source: C:/archives/common-source\nOriginal snapshot: D:/archives/common-snapshot\n\n---\nname: imported-memory\ndescription: Common inherited migration reference metadata operator glossary descriptors\nmetadata:\n  type: reference\n---\n\n';
  await note(alpha + 'coast.md', wrapper + 'Coastal ocean tide currents sediment beaches islands marine geography saltwater shoreline');
  await note(alpha + 'compiler.md', wrapper + 'Compiler registers parsing instructions syntax optimizer intermediate bytecode assembler linker diagnostics');
  const result = await getCleanup(config, null, renderMarkdown);
  const merges = result.items.filter(item => item.category === 'merge');
  assert.deepEqual(merges.map(paths), [[alpha + 'long.md', alpha + 'short.md']]);
  assert.equal(merges[0].reviewOnly, true);
  assert.equal(merges[0].evidence.level, 'possible-overlap');
  assert.equal(result.counts.duplicate, 0);
  assert.equal(result.coverage.insufficientHistoryNotes, 4);
});

test('an existing index-to-detail relationship is not suggested as redundant content', async t => {
  const {config, note} = await fixture(t);
  const common = 'worker durable revision recovery database journal concurrent safety ownership';
  await note(alpha + 'index.md', '# Cache recovery index\n' + common + '\n[[details]]');
  await note(alpha + 'details.md', '# Cache recovery details\n' + common + ' verify snapshots before restarting');
  const result = await getCleanup(config, null, renderMarkdown);
  assert.deepEqual(result.items.filter(item => item.category === 'merge'), []);
});

test('a merge suggestion cannot authorize cleanup deletion', async t => {
  const {config, note} = await fixture(t);
  const shared = 'architecture cache transaction worker durable revision recovery database journal concurrent safety ownership';
  await note(alpha + 'one.md', '# Recovery one\n' + shared + ' inspect primary');
  await note(alpha + 'two.md', '# Recovery two\n' + shared + ' verify secondary');
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const {token} = await (await fetch(base + '/api/editor-session')).json();
  const scan = await (await fetch(base + '/api/cleanup')).json();
  const candidate = scan.items.find(item => item.category === 'merge').notes[0];
  const before = await fs.readFile(path.join(config.vault, candidate.path));
  const response = await fetch(base + '/api/note', {method: 'DELETE', headers: {origin: base, 'content-type': 'application/json', 'x-shared-brain-csrf': token}, body: JSON.stringify({path: candidate.path, expectedRevision: candidate.revision, cleanup: true})});
  assert.equal(response.status, 409);
  assert.deepEqual(await fs.readFile(path.join(config.vault, candidate.path)), before);
});

test('shared extract provenance and link destinations do not manufacture merge hints', async t => {
  const {config, note} = await fixture(t);
  const wrapper = '# Operator glossary\n\nUnreviewed extract from [original](Agents/Memory/Imported/common/source.md). Original source and snapshot are recorded in that note. Preserve historical context; this is not owner-approved policy.\n\n';
  await note(alpha + 'coast.md', wrapper + 'Coastal ocean tide currents sediment beaches islands marine geography saltwater shoreline [map](https://example.com/common/metadata/operator/reference/guide/archive)');
  await note(alpha + 'compiler.md', wrapper + 'Compiler registers parsing instructions syntax optimizer intermediate bytecode assembler linker diagnostics [compiler](https://example.com/common/metadata/operator/reference/guide/archive)');
  const result = await getCleanup(config, null, renderMarkdown);
  assert.deepEqual(result.items.filter(item => item.category === 'merge'), []);
});
