import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {semanticPairs} from '../src/embeddings.mjs';

const digest = 'a'.repeat(64), model = 'axiom-qwen3-embedding:latest';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'axiom-pairs-'));
  const state = {digest, requests: [], loaded: false};
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const input = body ? JSON.parse(body) : null;
    state.requests.push({route: req.url, input});
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({models: [{name: model, digest: state.digest}]}));
    if (req.url === '/api/show') return res.end(JSON.stringify({details: {format: 'gguf'}}));
    if (req.url === '/api/ps') return res.end(JSON.stringify({models: state.loaded ? [{name: model, digest: state.digest}] : []}));
    if (req.url === '/api/embed') {
      state.loaded = true;
      return res.end(JSON.stringify({model, embeddings: input.input.map(text => /orchard|fruit/i.test(text) ? [1, 0, 0, 0] : [0, 1, 0, 0])}));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, {recursive: true, force: true}); });
  return {state, config: {vault: path.join(dir, 'vault'), configPath: path.join(dir, 'config.json'), embeddings: {enabled: true, endpoint: `http://127.0.0.1:${server.address().port}`, model, modelDigest: digest, dimensions: 4}}};
}
const entry = (name, content, project = 'one') => ({note: {path: `${name}.md`, title: name, revision: `rev-${name}`, project}, content});
const inputs = [entry('a', 'orchard trees'), entry('b', 'fruit garden'), entry('c', 'rocket engine'), entry('d', 'fruit elsewhere', 'two')];

test('document similarity finds paraphrases, excludes unrelated and cross-workspace pairs, and reuses cache offline', async t => {
  const {state, config} = await fixture(t);
  const first = await semanticPairs(config, inputs);
  assert.deepEqual(first.pairs.map(pair => [pair.left.path, pair.right.path]), [['a.md', 'b.md']]);
  assert.equal(first.pairs[0].left.revision, 'rev-a');
  assert.ok(first.pairs[0].similarity > 0.99);
  assert.deepEqual(first.pairs[0].passages, [
    {path: 'a.md', heading: '', excerpt: 'orchard trees'},
    {path: 'b.md', heading: '', excerpt: 'fruit garden'},
  ]);
  assert.equal(first.status.possiblePairs, 3);
  assert.equal(first.status.comparedPairs, 3);
  assert.equal(first.status.embeddedChunks, 3);
  const calls = state.requests.length;
  const offline = {...config, embeddings: {...config.embeddings, endpoint: 'http://127.0.0.1:1'}};
  const cached = await semanticPairs(offline, inputs);
  assert.deepEqual(cached.pairs, first.pairs);
  assert.equal(cached.status.state, 'ready');
  assert.equal(cached.status.cacheHits, 3);
  assert.equal(cached.status.embeddedChunks, 0);
  assert.equal(state.requests.length, calls);
});

test('cached-only misses do not inspect or wake the model', async t => {
  const {state, config} = await fixture(t);
  const result = await semanticPairs(config, inputs, {warmOnly: true});
  assert.deepEqual(result.pairs, []);
  assert.equal(result.status.state, 'incomplete');
  assert.deepEqual(state.requests, []);
});

test('digest mismatch blocks inference on a cache miss', async t => {
  const {state, config} = await fixture(t);
  state.digest = 'b'.repeat(64);
  const result = await semanticPairs(config, inputs);
  assert.equal(result.status.state, 'unavailable');
  assert.deepEqual(result.pairs, []);
  assert.ok(!state.requests.some(request => request.route === '/api/embed'));
});

test('aborted comparison stops before inference', async t => {
  const {state, config} = await fixture(t);
  const controller = new AbortController(); controller.abort();
  const result = await semanticPairs(config, inputs, {signal: controller.signal});
  assert.equal(result.status.state, 'unavailable');
  assert.deepEqual(result.pairs, []);
  assert.ok(!state.requests.some(request => request.route === '/api/embed'));
});

test('a singleton workspace never wakes the model for an impossible pair', async t => {
  const {state, config} = await fixture(t);
  const result = await semanticPairs(config, [entry('only', 'orchard trees')]);
  assert.deepEqual(result.pairs, []);
  assert.equal(result.status.possiblePairs, 0);
  assert.equal(result.status.embeddedChunks, 0);
  assert.deepEqual(state.requests, []);
});

test('matching empty section headings do not manufacture document similarity', async t => {
  const {config} = await fixture(t);
  const result = await semanticPairs(config, [
    entry('a', '# Shared overview\n\n## Details\nOrchard trees produce seasonal fruit.'),
    entry('b', '# Shared overview\n\n## Details\nRocket engines launch spacecraft.'),
  ]);
  assert.deepEqual(result.pairs, []);
  assert.equal(result.status.comparedPairs, 1);
});

test('passages identify the best scoring content chunks and headings', async t => {
  const {config} = await fixture(t);
  const result = await semanticPairs(config, [
    entry('a', '## Launch\nRocket engines.\n\n## Harvest\nOrchard trees.'),
    entry('b', '## Harvesting\nFruit garden.'),
  ]);
  assert.deepEqual(result.pairs[0].passages, [
    {path: 'a.md', heading: 'Harvest', excerpt: 'Orchard trees.'},
    {path: 'b.md', heading: 'Harvesting', excerpt: 'Fruit garden.'},
  ]);
});
