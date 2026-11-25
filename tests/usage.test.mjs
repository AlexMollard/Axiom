import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {inventoryUsage, recordUsage, getNoteUsage} from '../src/note-usage.mjs';
import {catalog, readNote, search, policies} from '../src/memory.mjs';
import {createServer} from '../src/server.mjs';

const day = 86400000, start = Date.parse('2025-01-01T12:00:00Z');
const at = days => ({now: start + days * day});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-usage-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = {vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup'), configPath: path.join(root, 'config.json'), indexPath: path.join(root, 'index.json'), projects: [], workspacePins: {}};
  await fs.mkdir(config.vault);
  const make = async (name, body) => { const file = path.join(config.vault, name); await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, body); };
  return {config, make};
}
const note = (name, extra = {}) => ({path: `Agents/${name}.md`, title: name, owner: 'agent', updated: '2020-01-01T00:00:00Z', revision: 'original', links: [], ...extra});
const one = (result, name) => result.notes.find(item => item.path === name).usage;

test('receipt types, rolling maturity, last delivered revision and later use', async t => {
  const {config} = await fixture(t), n = note('old');
  await inventoryUsage(config, [n], at(0));
  assert.equal(one(await getNoteUsage(config, [n], at(89)), n.path).status, 'insufficient-history');
  assert.equal(one(await getNoteUsage(config, [n], at(90)), n.path).status, 'stale-candidate');
  await recordUsage(config, [{...n, revision: 'delivered'}], 'context', 'omp', at(91));
  let u = one(await getNoteUsage(config, [{...n, revision: 'current'}], at(91)), n.path);
  assert.equal(u.status, 'recent'); assert.equal(u.lastRevision, 'delivered'); assert.equal(u.context30d, 1);
  await recordUsage(config, [n], 'excerpt', 'cli', at(92));
  for (let i = 0; i < 3; i++) await recordUsage(config, [n], 'read', 'claude', at(93));
  u = one(await getNoteUsage(config, [n], at(93)), n.path);
  assert.deepEqual([u.reads30d, u.excerpts30d, u.context30d, u.status, u.lastSource], [3, 1, 1, 'hot', 'claude']);
  u = one(await getNoteUsage(config, [n], at(125)), n.path);
  assert.deepEqual([u.reads30d, u.excerpts30d, u.context30d, u.status], [0, 0, 0, 'quiet']);
  assert.equal(one(await getNoteUsage(config, [n], at(184)), n.path).status, 'stale-candidate');
  const imported = note('imported');
  assert.equal(one(await getNoteUsage(config, [imported], at(184)), imported.path).status, 'insufficient-history');
});

test('30 UTC calendar days include the 30th date but exclude the 31st', async t => {
  const {config} = await fixture(t), n = note('boundary');
  const midnight = Date.parse('2025-02-01T00:00:00Z');
  await recordUsage(config, [n], 'read', 'cli', {now: midnight - 30 * day});
  await recordUsage(config, [n], 'read', 'cli', {now: midnight - 29 * day});
  let u = one(await getNoteUsage(config, [n], {now: midnight}), n.path);
  assert.equal(u.reads30d, 1);
  u = one(await getNoteUsage(config, [n], {now: midnight + day - 1}), n.path);
  assert.equal(u.reads30d, 1);
  u = one(await getNoteUsage(config, [n], {now: midnight + day}), n.path);
  assert.equal(u.reads30d, 0);
});

test('system control and metadata references protect targets', async t => {
  const {config} = await fixture(t);
  const notes = [note('Workspace icons'), note('old'), note('conflicted'), note('rooted'), note('source', {supersedes:'old.md', conflictsWith:'conflicted.md', links:['/Agents/rooted.md']})];
  await inventoryUsage(config, notes, at(0));
  const result = await getNoteUsage(config, notes, at(91));
  for (const item of notes.slice(0, 4)) {
    const u = one(result, item.path);
    assert.equal(u.status, 'quiet');
    assert.ok(u.protectionReasons.length);
  }
});

test('pins, owners, decisions and ambiguous incoming links protect mature notes', async t => {
  const {config} = await fixture(t);
  const notes = [note('pinned'), note('same'), note('different', {title:'same'}), note('decision', {kind:'decision'}), note('owner', {owner:'owner', path:'Owner/owner.md'}), note('source', {links:['same']})];
  config.workspacePins = {global: [notes[0].path]};
  await inventoryUsage(config, notes, at(0));
  const result = await getNoteUsage(config, notes, at(91));
  for (const item of notes.slice(0, 5)) { const u = one(result, item.path); assert.equal(u.status, 'quiet'); assert.ok(u.protectionReasons.length); }
  assert.equal(one(result, notes[5].path).status, 'stale-candidate');
});

test('only explicit delivery records retrieval and policy references', async t => {
  const {config, make} = await fixture(t);
  await make('Owner/Policies.md', '# Rules\nPolicies here');
  await make('Owner/Preferences.md', '# Preferences\nPreferences here');
  await make('Agents/apple.md', '# Apple\nUnusualfruit detail');
  await make('Agents/other.md', '# Other\nNothing');
  const notes = await catalog(config); await inventoryUsage(config, notes);
  const originals = await Promise.all(notes.map(async note => {
    const file = path.join(config.vault, note.path);
    return {file, bytes: await fs.readFile(file), mtime: (await fs.stat(file)).mtimeMs};
  }));
  await readNote(config, 'Agents/apple.md'); await search(config, 'Unusualfruit'); await policies(config, config.vault, 'Unusualfruit'); await catalog(config);
  let u = one(await getNoteUsage(config, notes), 'Agents/apple.md');
  assert.deepEqual([u.reads30d, u.excerpts30d, u.context30d], [0, 0, 0]);
  await search(config, 'Unusualfruit', {usage:{source:'omp'}});
  await readNote(config, 'Agents/apple.md', {source:'cli'});
  await policies(config, config.vault, 'Unusualfruit', {source:'claude'});
  const result = await getNoteUsage(config, notes); u = one(result, 'Agents/apple.md');
  assert.deepEqual([u.reads30d, u.excerpts30d, u.context30d], [1, 1, 1]);
  assert.equal(one(result, 'Agents/other.md').context30d, 0);
  assert.equal(one(result, 'Owner/Policies.md').context30d, 1);
  for (const original of originals) {
    assert.deepEqual(await fs.readFile(original.file), original.bytes);
    assert.equal((await fs.stat(original.file)).mtimeMs, original.mtime);
  }
  await assert.rejects(fs.access(path.join(config.vault, 'Owner', 'Reviews.md')), {code: 'ENOENT'});
});

test('simultaneous subprocess receipts are not lost', async t => {
  const {config} = await fixture(t), n = note('concurrent');
  await inventoryUsage(config, [n]);
  const moduleUrl = new URL('../src/note-usage.mjs', import.meta.url).href;
  const program = `import {recordUsage} from ${JSON.stringify(moduleUrl)}; const [config,note]=JSON.parse(process.argv[1]); for(let i=0;i<10;i++) {const result=await recordUsage(config,[note],'read','cli'); if(!result.healthy) process.exit(1);}`;
  await Promise.all(Array.from({length: 4}, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, JSON.stringify([config, n])], {stdio:'ignore'});
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
  })));
  assert.equal(one(await getNoteUsage(config, [n]), n.path).reads30d, 40);
});

test('failed tracking reports degradation and resets maturity on recovery', async t => {
  const {config} = await fixture(t), n = note('gap');
  await inventoryUsage(config, [n], at(0));
  const dir = path.join(path.dirname(config.configPath), '.state');
  const db = (await fs.readdir(dir)).find(name => name.endsWith('.sqlite'));
  await fs.rename(path.join(dir, db), path.join(dir, `${db}.saved`));
  await fs.mkdir(path.join(dir, db));
  const failed = await getNoteUsage(config, [n], at(91));
  assert.equal(failed.tracking.healthy, false); assert.notEqual(one(failed, n.path).status, 'stale-candidate');
  await fs.rmdir(path.join(dir, db)); await fs.rename(path.join(dir, `${db}.saved`), path.join(dir, db));
  assert.equal(one(await getNoteUsage(config, [n], at(92)), n.path).status, 'insufficient-history');
});

test('GET /api/note-usage?path=... returns single-note usage and tracking status', async t => {
  const {config, make} = await fixture(t);
  await make('Agents/Alpha.md', '# Alpha\nalpha content');
  await make('Agents/Beta.md', '# Beta\nbeta content');
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/api/note-usage?path=${encodeURIComponent('Agents/Alpha.md')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tracking.healthy, true);
  assert.equal(body.note.path, 'Agents/Alpha.md');
  assert.equal(body.notes, undefined);
});
