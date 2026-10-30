import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {embeddingSettings, embeddingStatus, semanticSearch} from '../src/embeddings.mjs';

const digest = 'a'.repeat(64), model = 'axiom-qwen3-embedding:latest';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'axiom-embedding-'));
  const state = {digest, loaded: false, requests: [], active: 0, maxActive: 0, delay: 0, bad: null, remote: false};
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const input = body ? JSON.parse(body) : null;
    state.requests.push({route: req.url, input});
    res.setHeader('content-type', 'application/json');
    if (state.bad === 'oversized' && req.url === '/api/tags') return res.end(JSON.stringify({padding: 'x'.repeat(4 * 1024 * 1024)}));
    if (req.url === '/api/tags') return res.end(JSON.stringify({models: [{name: model, digest: state.digest}]}));
    if (req.url === '/api/show') return res.end(JSON.stringify({details: {format: 'gguf'}, ...(state.remote ? {remote_host: 'cloud.example'} : {})}));
    if (req.url === '/api/ps') return res.end(JSON.stringify({models: state.loaded ? [{name: model, digest: state.digest, size_vram: 123}] : []}));
    if (req.url === '/api/embed') {
      state.active++; state.maxActive = Math.max(state.maxActive, state.active);
      state.onEmbed?.();
      if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
      state.loaded = true;
      const vectors = input.input.map(text => {
        if (state.bad === 'dimensions') return [1];
        if (state.bad === 'nonfinite') return [1, null, 0, 0];
        if (state.bad === 'zero') return [0, 0, 0, 0];
        return /banana/i.test(text) ? [0, 1, 0, 0] : [1, 0, 0, 0];
      });
      state.active--; return res.end(JSON.stringify({model, embeddings: vectors}));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, {recursive: true, force: true}); });
  return {state, config: {vault: path.join(dir, 'vault'), configPath: path.join(dir, 'config.json'), embeddings: {enabled: true, endpoint: `http://127.0.0.1:${server.address().port}`, model, modelDigest: digest, dimensions: 4}}};
}
const entry = (name, content, revision = 'r1') => ({note: {path: `${name}.md`, title: name, revision}, content});
const embeds = state => state.requests.filter(request => request.route === '/api/embed');

test('cached vectors never widen the eligible scope and edited or removed notes do not leak', async t => {
  const {state, config} = await fixture(t);
  const a = entry('alpha', '---\nprivate: ignored\n---\n# Heading\nordinary text');
  const b = entry('secret', '# Secret\nordinary text');
  const first = await semanticSearch(config, [a, b], 'ordinary');
  assert.deepEqual(first.matches.map(hit => hit.path).sort(), ['alpha.md', 'secret.md']);
  assert.equal(first.matches.find(hit => hit.path === 'alpha.md').heading, 'Heading');
  const passage = first.matches.find(hit => hit.path === 'alpha.md');
  assert.equal(a.content.slice(passage.start).split('\n')[0], passage.excerpt);
  assert.equal(passage.line, a.content.slice(0, passage.start).split('\n').length);
  assert.ok(!embeds(state).flatMap(call => call.input.input).some(text => text.includes('private: ignored')));
  const before = embeds(state).length;
  const scoped = await semanticSearch(config, [a], 'ordinary');
  assert.deepEqual(scoped.matches.map(hit => hit.path), ['alpha.md']);
  assert.equal(embeds(state).length, before);
  const edited = await semanticSearch(config, [entry('alpha', '# Heading\nbanana', 'r2')], 'ordinary');
  assert.deepEqual(edited.matches, []);
  assert.ok(embeds(state).length > before);
  assert.deepEqual((await semanticSearch(config, [], 'ordinary')).matches, []);
});

test('identity changes reject stale cache and remote models without inference', async t => {
  const {state, config} = await fixture(t);
  await semanticSearch(config, [entry('a', 'ordinary')], 'ordinary');
  const before = embeds(state).length;
  state.digest = 'b'.repeat(64);
  const stale = await semanticSearch(config, [entry('a', 'ordinary')], 'ordinary');
  assert.equal(stale.status.state, 'unavailable'); assert.match(stale.status.reason, /digest/); assert.deepEqual(stale.matches, []);
  state.digest = digest; state.remote = true;
  assert.equal((await embeddingStatus(config)).state, 'unavailable');
  assert.equal((await semanticSearch(config, [entry('a', 'ordinary')], 'ordinary')).status.state, 'unavailable');
  assert.equal(embeds(state).length, before);
});

test('concurrent callers share serialized missing work and bounded batches', async t => {
  const {state, config} = await fixture(t); state.delay = 10;
  const entries = Array.from({length: 70}, (_, i) => entry(`note${i}`, `ordinary ${i}`));
  const results = await Promise.all(Array.from({length: 4}, () => semanticSearch(config, entries, 'ordinary')));
  assert.ok(results.every(result => result.matches.length === 70));
  assert.equal(state.maxActive, 1);
  const calls = embeds(state);
  const documents = calls.flatMap(call => call.input.input).filter(text => !text.startsWith('Instruct: '));
  assert.equal(documents.length, entries.length);
  assert.equal(new Set(documents).size, entries.length);
  assert.ok(calls.every(call => call.input.input.length <= 32));
});

test('automatic search never wakes a sleeping model, even on a cache miss', async t => {
  const {state, config} = await fixture(t);
  const entries = [entry('a', 'ordinary')];
  const cold = await semanticSearch(config, entries, 'ordinary', {warmOnly: true});
  assert.equal(cold.status.state, 'sleeping'); assert.deepEqual(cold.matches, []); assert.equal(embeds(state).length, 0);
  await semanticSearch(config, entries, 'ordinary'); state.loaded = false;
  const cached = await semanticSearch(config, entries, 'ordinary', {warmOnly: true});
  assert.equal(cached.matches.length, 1); assert.equal(cached.status.state, 'sleeping');
  const before = embeds(state).length;
  const miss = await semanticSearch(config, entries, 'different query', {warmOnly: true});
  assert.equal(miss.status.state, 'sleeping'); assert.equal(embeds(state).length, before);
  state.loaded = true;
  const loadedMiss = await semanticSearch(config, entries, 'different query', {warmOnly: true});
  assert.equal(loadedMiss.status.state, 'incomplete'); assert.equal(embeds(state).length, before);
});

test('invalid vectors, prohibited endpoints and network failures degrade explicitly', async t => {
  const {state, config} = await fixture(t);
  for (const bad of ['dimensions', 'nonfinite', 'zero']) {
    state.bad = bad;
    const result = await semanticSearch(config, [entry(bad, bad)], 'ordinary');
    assert.equal(result.status.state, 'unavailable'); assert.deepEqual(result.matches, []);
  }
  for (const endpoint of ['https://127.0.0.1:11434', 'http://example.com', 'http://127.0.0.1/path', 'http://user@localhost:11434']) {
    assert.throws(() => embeddingSettings({...config, embeddings: {...config.embeddings, endpoint}}));
  }
  assert.throws(() => embeddingSettings({...config, embeddings: {...config.embeddings, model: 'model:cloud'}}));
  const offline = {...config, embeddings: {...config.embeddings, endpoint: 'http://127.0.0.1:1'}};
  assert.equal((await semanticSearch(offline, [], 'ordinary', {timeoutMs: 1000})).status.state, 'unavailable');
});

test('explicit refresh indexes documents without embedding an empty query', async t => {
  const {state, config} = await fixture(t);
  const result = await semanticSearch(config, [entry('a', 'ordinary')], '', {limit: 0});
  assert.deepEqual(result.matches, []); assert.equal(result.status.indexedChunks, 1);
  assert.equal(embeds(state).length, 1); assert.equal(embeds(state)[0].input.input.length, 1);
});

test('later overlapping chunks retain exact CRLF-aware UTF-16 offsets and duplicate heading anchors', async t => {
  const {config} = await fixture(t);
  const prefix = '# Same\r\nfirst\r\n# Same\r\n';
  const content = prefix + '😀'.repeat(500) + 'x'.repeat(600) + 'banana';
  const result = await semanticSearch(config, [entry('a', content)], 'banana');
  const hit = result.matches[0];
  assert.equal(hit.heading, 'Same'); assert.equal(hit.anchor, 'same-2');
  assert.equal(hit.line, 4);
  assert.ok(hit.start > prefix.length);
  const source = content.slice(hit.start);
  assert.equal(source.replace(/\s+/g, ' ').slice(0, 400), hit.excerpt);
  assert.ok(!/^[\uDC00-\uDFFF]/.test(source));
});

test('persistent query vectors allow a separate module instance to use cache only', async t => {
  const {state, config} = await fixture(t);
  const entries = [entry('a', 'ordinary')];
  await semanticSearch(config, entries, 'ordinary');
  const calls = embeds(state).length; state.loaded = false;
  const other = await import(`../src/embeddings.mjs?independent=${Date.now()}`);
  const result = await other.semanticSearch(config, entries, 'ordinary', {warmOnly: true});
  assert.equal(result.matches.length, 1);
  assert.equal(result.status.indexedChunks, 1);
  assert.equal(embeds(state).length, calls);
});

test('long Unicode queries are shortened at a code-point boundary with explicit status', async t => {
  const {state, config} = await fixture(t);
  const result = await semanticSearch(config, [entry('a', 'ordinary')], '😀'.repeat(3000));
  assert.equal(result.status.state, 'incomplete');
  assert.match(result.status.reason, /shortened/);
  const prompt = embeds(state).at(-1).input.input[0];
  assert.ok(Buffer.byteLength(prompt) <= 1800);
  assert.ok(!prompt.includes('\ufffd'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(prompt));
});

test('oversized service responses fail closed', async t => {
  const {state, config} = await fixture(t); state.bad = 'oversized';
  const result = await semanticSearch(config, [entry('a', 'ordinary')], 'ordinary');
  assert.equal(result.status.state, 'unavailable');
  assert.match(result.status.reason, /too large/);
  assert.deepEqual(result.matches, []);
});

test('aborted queued search performs no inference and preserves the following queue', async t => {
  const {state, config} = await fixture(t); state.delay = 40;
  let started; const firstEmbed = new Promise(resolve => { started = resolve; });
  state.onEmbed = started;
  const entries = [entry('a', 'ordinary')];
  const first = semanticSearch(config, entries, 'first');
  await firstEmbed;
  const controller = new AbortController();
  const cancelled = semanticSearch(config, entries, 'cancelled query', {signal: controller.signal});
  const following = semanticSearch(config, entries, 'following query');
  controller.abort();
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult.status.state, 'unavailable');
  assert.match(cancelledResult.status.reason, /cancelled/i);
  const [firstResult, followingResult] = await Promise.all([first, following]);
  assert.equal(firstResult.matches.length, 1);
  assert.equal(followingResult.matches.length, 1);
  assert.equal(state.maxActive, 1);
  assert.ok(!embeds(state).flatMap(call => call.input.input).some(text => text.includes('cancelled query')));
});

