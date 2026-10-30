import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer as httpServer} from 'node:http';
import {search, policies, loadConfig, hash, catalog} from '../src/memory.mjs';
import {createServer} from '../src/server.mjs';
import {configureEmbeddings} from '../src/management.mjs';
import {getCaptureSuggestions} from '../src/knowledge.mjs';
import {serializeReviewLedger} from '../src/note-reviews.mjs';
import {getNoteUsage} from '../src/note-usage.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-hybrid-'));
  const vault = path.join(root, 'vault'), configPath = path.join(root, 'config.json');
  const state = {embeds: 0, fail: false, beforeEmbed: null};
  const model = 'axiom-qwen3-embedding:latest', digest = 'b'.repeat(64);
  const inference = httpServer(async (req, res) => {
    let text = ''; for await (const data of req) text += data;
    const body = text ? JSON.parse(text) : null;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({models: [{name: model, digest}]}));
    if (req.url === '/api/show') return res.end(JSON.stringify({details: {format: 'gguf'}}));
    if (req.url === '/api/ps') return res.end(JSON.stringify({models: []}));
    if (req.url !== '/api/embed') { res.statusCode = 404; return res.end('{}'); }
    state.embeds++;
    if (state.fail) { res.statusCode = 503; return res.end('{}'); }
    if (state.beforeEmbed) { const change = state.beforeEmbed; state.beforeEmbed = null; await change(); }
    const embeddings = body.input.map(value => /undo|rollout|previous.{0,20}build/i.test(value) ? [1, 0, 0, 0] : [0, 1, 0, 0]);
    res.end(JSON.stringify({model, embeddings}));
  });
  await new Promise(resolve => inference.listen(0, '127.0.0.1', resolve));
  const config = {vault, backupDir: path.join(root, 'backups'), configPath, indexPath: path.join(root, 'index.json'), port: 0,
    projects: [{id: 'work', root: path.join(root, 'work')}, {id: 'home', root: path.join(root, 'home')}],
    embeddings: {enabled: true, endpoint: `http://127.0.0.1:${inference.address().port}`, model, modelDigest: digest, dimensions: 4}};
  async function put(relative, content) { const file = path.join(vault, relative); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, content); }
  await put('Owner/Policies.md', '# Policies\r\nOwner instructions remain authoritative.');
  await put('Owner/Preferences.md', '# Preferences\r\nNever change protected instructions.');
  await fs.writeFile(configPath, JSON.stringify(config));
  t.after(async () => { await new Promise(resolve => inference.close(resolve)); await fs.rm(root, {recursive: true, force: true}); });
  return {root, config, state, put};
}
const current = 'Agents/Memory/Projects/work/recovery.md';
const recovery = '---\r\nproject: work\r\n---\r\n# Recovery\r\n\r\n## Reversal\r\nRevert to the previously verified build.\r\n';

test('hybrid evidence preserves workspace, active state, canonical source and cache-only context', async t => {
  const {root, config, state, put} = await fixture(t);
  await put(current, recovery);
  await put('Agents/Memory/Projects/home/private.md', recovery.replace('project: work', 'project: home'));
  await put('Agents/Memory/Projects/work/retired.md', recovery.replace('project: work', 'project: work\r\nstatus: retired'));
  await put('Agents/Memory/Projects/work/proposal.md', recovery.replace('project: work', 'project: work\r\nkind: proposal'));
  const cwd = path.join(root, 'work');
  assert.equal((await search(config, 'undo rollout', {cwd, mode: 'lexical'})).count, 0);
  const result = await search(config, 'undo rollout', {cwd});
  assert.deepEqual(result.items.map(note => note.path), [current]);
  assert.equal(result.items[0].anchor, 'reversal');
  assert.equal(result.items[0].revision, hash(recovery));
  assert.match(result.items[0].excerpt, /previously verified build/);
  const before = state.embeds;
  const context = await policies(config, cwd, 'undo rollout', {source: 'claude'});
  assert.match(context, /REFERENCE Agents\/Memory\/Projects\/work\/recovery.md/);
  assert.match(context, /previously verified build/);
  assert.equal(state.embeds, before);
  assert.doesNotMatch(context, /home\/private|work\/retired|work\/proposal/);
  const capture = await getCaptureSuggestions(config, {cwd, path: 'Agents/Memory/Projects/work/new.md', content: '# Recovery path\nPlease undo a rollout.'});
  assert.ok(capture.items.some(item => item.note.path === current && item.semanticScore > 0));
  assert.equal(capture.semantic.state, 'sleeping');
  assert.ok(!capture.warnings.some(warning => /sleeping|unavailable/i.test(warning)));
});

test('a canonical edit during inference rejects stale semantic evidence and failed inference retains lexical results', async t => {
  const {root, config, state, put} = await fixture(t);
  await put(current, recovery);
  state.beforeEmbed = () => put(current, '# Replacement\r\nThe replacement discusses gardening.');
  const result = await search(config, 'undo rollout', {cwd: path.join(root, 'work')});
  assert.equal(result.count, 0);
  await put(current, recovery);
  state.fail = true;
  const degraded = await search(config, 'verified', {cwd: path.join(root, 'work')});
  assert.deepEqual(degraded.items.map(note => note.path), [current]);
  assert.equal(degraded.semantic.state, 'unavailable');
  assert.match(degraded.items[0].excerpt, /previously verified build/);
});

test('human reindex requires same-origin CSRF and model setup preserves newer configuration', async t => {
  const {config, state, put} = await fixture(t);
  await put(current, recovery);
  const web = createServer(config);
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => web.close(resolve)));
  const origin = `http://127.0.0.1:${web.address().port}`;
  const denied = await fetch(origin + '/api/embeddings/reindex', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(denied.status, 403); assert.equal(state.embeds, 0);
  assert.equal((await fetch(origin + '/api/embeddings')).status, 200); assert.equal(state.embeds, 0);
  const {token} = await (await fetch(origin + '/api/editor-session')).json();
  const reindexed = await fetch(origin + '/api/embeddings/reindex', {method: 'POST', headers: {origin, 'content-type': 'application/json', 'x-shared-brain-csrf': token}, body: '{}'});
  assert.equal(reindexed.status, 200);
  assert.ok((await reindexed.json()).indexedChunks > 0);
  const before = await fs.readFile(config.configPath), newer = JSON.parse(before);
  newer.workspaceGroups = {work: 'home'};
  await fs.writeFile(config.configPath, JSON.stringify(newer));
  await assert.rejects(configureEmbeddings(config, {enabled: false}, hash(before)), /Configuration changed/);
  assert.deepEqual(JSON.parse(await fs.readFile(config.configPath, 'utf8')).workspaceGroups, {work: 'home'});
  const revision = hash(await fs.readFile(config.configPath));
  await configureEmbeddings(config, {enabled: false}, revision);
  const saved = await loadConfig(config.configPath);
  assert.equal(saved.embeddings.enabled, false);
  assert.deepEqual(saved.workspaceGroups, {work: 'home'});
});

test('review revocation during inference removes the note from reviewed-only results', async t => {
  const {root, config, state, put} = await fixture(t);
  await put(current, recovery);
  const approval = {revision: hash(recovery), reviewedAt: '2026-10-30T00:00:00.000Z', approved: true};
  await put('Owner/Reviews.md', serializeReviewLedger({[current]: approval}));
  state.beforeEmbed = () => put('Owner/Reviews.md', serializeReviewLedger({[current]: {...approval, approved: false}}));
  const result = await search(config, 'undo rollout', {cwd: path.join(root, 'work'), review: 'reviewed'});
  assert.equal(result.count, 0);
  assert.equal(state.beforeEmbed, null);
});

test('a cancelled search does not record excerpts that were never returned', async t => {
  const {root, config, state, put} = await fixture(t);
  await put(current, recovery);
  const controller = new AbortController();
  state.beforeEmbed = () => controller.abort();
  await assert.rejects(search(config, 'undo rollout', {cwd: path.join(root, 'work'), signal: controller.signal, usage: {source: 'omp'}}), {name: 'AbortError'});
  const inventory = await getNoteUsage(config, await catalog(config));
  assert.equal(inventory.notes.find(note => note.path === current).usage.excerpts30d, 0);
});
