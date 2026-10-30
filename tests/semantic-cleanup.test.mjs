import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createServer} from '../src/server.mjs';

const alpha = 'Agents/Memory/Projects/alpha/';
const beta = 'Agents/Memory/Projects/beta/';
const digest = 'a'.repeat(64);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-semantic-cleanup-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = {vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup'), configPath: path.join(root, 'config.json'), indexPath: path.join(root, 'index.json'), projects: [{id: 'alpha', root: path.join(root, 'alpha')}, {id: 'beta', root: path.join(root, 'beta')}], workspacePins: {}, port: 0};
  await fs.mkdir(config.vault);
  const note = async (name, content) => { const file = path.join(config.vault, name); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, content); };
  let requests = 0, inputs = [], onEmbed = null, fail = false;
  const model = http.createServer(async (req, res) => {
    requests++;
    let body = ''; for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    res.setHeader('content-type', 'application/json');
    if (fail) { res.writeHead(503); return res.end('{}'); }
    if (req.url === '/api/tags') return res.end(JSON.stringify({models: [{name: 'local:latest', digest}]}));
    if (req.url === '/api/show') return res.end(JSON.stringify({details: {format: 'gguf'}}));
    if (req.url === '/api/ps') return res.end(JSON.stringify({models: []}));
    if (req.url === '/api/embed') {
      inputs.push(...data.input);
      if (onEmbed) { const callback = onEmbed; onEmbed = null; await callback(); }
      return res.end(JSON.stringify({model: 'local:latest', embeddings: data.input.map(text => /orchard|fruit|garden|apple/i.test(text) ? [1, 0] : [0, 1])}));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => model.close(resolve)));
  config.embeddings = {enabled: true, endpoint: `http://127.0.0.1:${model.address().port}`, model: 'local:latest', modelDigest: digest, dimensions: 2};
  await fs.writeFile(config.configPath, JSON.stringify(config));
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const {token} = await (await fetch(base + '/api/editor-session')).json();
  const post = (body = {}, headers = {}) => fetch(base + '/api/cleanup', {method: 'POST', headers: {origin: base, 'content-type': 'application/json', 'x-shared-brain-csrf': token, ...headers}, body: JSON.stringify(body)});
  return {root, config, note, base, token, post, get requests() { return requests; }, get inputs() { return inputs; }, set onEmbed(value) { onEmbed = value; }, set fail(value) { fail = value; }};
}

const pair = item => item.notes.map(note => note.path).sort();

test('guarded semantic scan finds paraphrases within scope without mutating notes or granting deletion', async t => {
  const f = await fixture(t);
  const one = '# Harvest\nAn orchard produces seasonal fruit for families.';
  const two = '# Growing\nGarden apple trees yield food throughout autumn.';
  await f.note(alpha + 'one.md', one); await f.note(alpha + 'two.md', two);
  await f.note(beta + 'other.md', '# Elsewhere\nGarden apple trees grow elsewhere.');
  await f.note(alpha + 'retired.md', '---\nstatus: retired\n---\n# Old\nOrchard fruit remains.');
  const lexical = await (await fetch(f.base + '/api/cleanup?workspace=alpha')).json();
  assert.equal(lexical.semantic.state, 'not-requested'); assert.equal(f.requests, 0);
  assert.equal((await f.post({workspace: 'alpha'}, {'x-shared-brain-csrf': '0'.repeat(64)})).status, 403);
  assert.equal(f.requests, 0);
  const response = await f.post({workspace: 'alpha'}); assert.equal(response.status, 200);
  const result = await response.json();
  const hint = result.items.find(item => item.category === 'merge');
  assert.deepEqual(pair(hint), [alpha + 'one.md', alpha + 'two.md']);
  assert.equal(hint.reviewOnly, true); assert.deepEqual(hint.evidence.methods, ['semantic']);
  assert.equal(hint.evidence.level, 'semantic-overlap');
  assert.deepEqual(hint.evidence.passages.map(passage => passage.path), [alpha + 'one.md', alpha + 'two.md']);
  assert.match(hint.evidence.passages[0].excerpt, /orchard/i);
  assert.match(hint.evidence.passages[1].excerpt, /garden/i);
  assert(!f.inputs.some(text => /elsewhere|remains/i.test(text)));
  const deletion = await fetch(f.base + '/api/note', {method: 'DELETE', headers: {origin: f.base, 'content-type': 'application/json', 'x-shared-brain-csrf': f.token}, body: JSON.stringify({path: hint.notes[0].path, expectedRevision: hint.notes[0].revision, cleanup: true})});
  assert.equal(deletion.status, 409);
  assert.equal(await fs.readFile(path.join(f.config.vault, alpha + 'one.md'), 'utf8'), one);
  assert.equal(await fs.readFile(path.join(f.config.vault, alpha + 'two.md'), 'utf8'), two);
});

test('fresh scan excludes edits, deletes and new index relationships during inference', async t => {
  const f = await fixture(t);
  for (const name of ['one', 'two', 'three', 'four']) await f.note(alpha + name + '.md', `# ${name}\nOrchard fruit description ${name}.`);
  f.onEmbed = async () => {
    await f.note(alpha + 'one.md', '# Changed\nOrchard fruit changed.');
    await fs.rm(path.join(f.config.vault, alpha + 'two.md'));
    await f.note(alpha + 'three.md', '# three\nOrchard fruit description three.\n[[four]]');
  };
  const result = await (await f.post({workspace: 'alpha'})).json();
  assert(!result.items.some(item => item.category === 'merge' && item.notes.some(note => [alpha + 'one.md', alpha + 'two.md', alpha + 'three.md'].includes(note.path))));
  assert.equal(result.semantic.state, 'incomplete');
  assert.equal(result.semantic.incomplete, true);
});

test('model failure preserves lexical results and reports fallback', async t => {
  const f = await fixture(t);
  const shared = 'architecture cache transaction worker durable revision recovery database journal concurrent safety ownership';
  await f.note(alpha + 'one.md', '# One\n' + shared + ' primary');
  await f.note(alpha + 'two.md', '# Two\n' + shared + ' secondary');
  f.fail = true;
  const result = await (await f.post({workspace: 'alpha'})).json();
  assert(result.items.some(item => item.category === 'merge' && item.evidence.methods.includes('lexical')));
  assert.equal(result.semantic.state, 'unavailable');
});

test('lexical and semantic evidence for the same pair is combined once', async t => {
  const f = await fixture(t);
  const shared = 'orchard architecture cache transaction worker durable revision recovery database journal concurrent safety ownership';
  await f.note(alpha + 'one.md', '# One\n' + shared + ' primary');
  await f.note(alpha + 'two.md', '# Two\n' + shared + ' secondary');
  const result = await (await f.post({workspace: 'alpha'})).json();
  const merges = result.items.filter(item => item.category === 'merge');
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].evidence.methods, ['lexical', 'semantic']);
  assert.equal(typeof merges[0].evidence.semanticSimilarity, 'number');
  assert(merges[0].evidence.terms.length);
  assert.equal(merges[0].evidence.passages.length, 2);
  assert(merges[0].evidence.passages.every(passage => passage.excerpt.includes('orchard')));
});
