import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import MarkdownIt from 'markdown-it';
import {headingSlug} from './note-links.mjs';

// Cache keys contain no note paths or text. Changes to formatting invalidate every vector.
const VERSION = 'qwen3-retrieval-chunks-v3';
const MAX_ROWS = 16384, MAX_CHUNKS = 16000, MAX_CORPUS_BYTES = 32 * 1024 * 1024;
const MAX_QUERY_BYTES = 1800, BATCH = 32, MAX_QUEUE = 16;
const jobs = new Map(), queryCache = new Map();
const markdown = new MarkdownIt({html: false});
const hash = text => createHash('sha256').update(text).digest('hex');
const cachePath = config => path.join(path.dirname(config.configPath || config.vault), '.state', 'embeddings.sqlite');
const modelName = name => name.includes(':') ? name : `${name}:latest`;

export function embeddingSettings(config) {
  const value = config?.embeddings;
  if (!value || value === false || value.enabled === false) return {enabled: false};
  if (typeof value !== 'object' || value.enabled !== true) throw new Error('Invalid embeddings configuration.');
  const endpoint = new URL(value.endpoint || 'http://127.0.0.1:11434');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Embedding endpoint must be a loopback HTTP origin.');
  const model = value.model || 'axiom-qwen3-embedding:latest';
  if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/i.test(model) || /(?:cloud|remote)/i.test(model)) throw new Error('Embedding model must be a local model name.');
  const modelDigest = value.modelDigest;
  if (typeof modelDigest !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/i.test(modelDigest)) throw new Error('Embedding model digest must be a SHA-256 digest.');
  const dimensions = value.dimensions ?? 1024, context = value.context ?? 2048, batch = value.batch ?? 256, minSimilarity = value.minSimilarity ?? 0.35;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 1024 || !Number.isInteger(context) || context < 256 || context > 8192 || !Number.isInteger(batch) || batch < 1 || batch > 1024 || typeof minSimilarity !== 'number' || !Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1) throw new Error('Invalid embedding dimensions, context, batch or similarity.');
  const keepAlive = value.keepAlive ?? '2m';
  if (typeof keepAlive !== 'string' || !/^\d+(?:ms|s|m|h)$/.test(keepAlive)) throw new Error('Invalid embedding keepAlive.');
  const digest = modelDigest.replace(/^sha256:/i, '').toLowerCase();
  return {enabled: true, endpoint: endpoint.origin, model: modelName(model), modelDigest: digest, dimensions, context, batch, minSimilarity, keepAlive, fingerprint: hash(`${VERSION}\n${digest}\n${dimensions}\n${context}`)};
}

async function openCache(config) {
  const file = cachePath(config);
  await fs.mkdir(path.dirname(file), {recursive: true});
  const Database = globalThis.Bun ? (await import('bun:sqlite')).Database : (await import('node:sqlite')).DatabaseSync;
  const db = new Database(file);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS vectors (fingerprint TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL, touched INTEGER NOT NULL, PRIMARY KEY(fingerprint, hash)); CREATE INDEX IF NOT EXISTS vectors_touched ON vectors(touched);');
    return db;
  } catch (error) { db.close(); throw error; }
}
function count(db, settings) { return Number(db.prepare("SELECT count(*) AS n FROM vectors WHERE fingerprint = ? AND hash NOT LIKE 'q:%'").get(settings.fingerprint).n); }
function loadVector(db, settings, key) {
  const row = db.prepare('SELECT vector FROM vectors WHERE fingerprint = ? AND hash = ?').get(settings.fingerprint, key);
  if (!row || row.vector.byteLength !== settings.dimensions * 4) return null;
  const bytes = Buffer.from(row.vector), vector = new Float32Array(settings.dimensions);
  for (let i = 0; i < vector.length; i++) { vector[i] = bytes.readFloatLE(i * 4); if (!Number.isFinite(vector[i])) return null; }
  return vector;
}
function storeVectors(db, settings, records) {
  const insert = db.prepare('INSERT OR REPLACE INTO vectors(fingerprint, hash, vector, touched) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, vector] of records) {
      const bytes = Buffer.allocUnsafe(vector.length * 4);
      for (let i = 0; i < vector.length; i++) bytes.writeFloatLE(vector[i], i * 4);
      insert.run(settings.fingerprint, key, bytes, Date.now());
    }
    // Bound both row count and vector payload, including vectors from older fingerprints.
    db.exec(`DELETE FROM vectors WHERE rowid IN (SELECT rowid FROM vectors ORDER BY touched DESC, rowid DESC LIMIT -1 OFFSET ${MAX_ROWS});`);
    db.exec('DELETE FROM vectors WHERE rowid IN (SELECT rowid FROM (SELECT rowid, sum(length(vector)) OVER (ORDER BY touched DESC, rowid DESC) AS bytes FROM vectors) WHERE bytes > 67108864);');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
async function request(settings, route, body, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Embedding request timed out.');
  const timeout = AbortSignal.timeout(Math.min(remaining, 60000));
  const signal = settings.signal ? AbortSignal.any([settings.signal, timeout]) : timeout;
  const response = await fetch(`${settings.endpoint}${route}`, {method: body ? 'POST' : 'GET', headers: body ? {'content-type': 'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal});
  if (!response.ok) throw new Error(`Embedding service returned HTTP ${response.status}.`);
  const limit = 4 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Embedding service response is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Embedding service returned an empty response.');
  const parts = []; let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('Embedding service response is too large.'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(parts.map(part => Buffer.from(part))).toString('utf8'));
}
async function inspect(settings, deadline) {
  const tags = await request(settings, '/api/tags', null, deadline);
  const installed = tags.models?.find(item => modelName(item.name || item.model || '') === settings.model);
  if (!installed || String(installed.digest || '').replace(/^sha256:/, '').toLowerCase() !== settings.modelDigest) throw new Error('Local model is missing or its digest does not match the pinned model.');
  const show = await request(settings, '/api/show', {model: settings.model}, deadline);
  const remote = object => object && typeof object === 'object' && Object.entries(object).some(([key, value]) => (/^(remote_host|remote_model|remote_url|cloud)$/i.test(key) && Boolean(value)) || (value && typeof value === 'object' && remote(value)));
  if (remote(installed) || remote(show) || (show.details?.format && show.details.format !== 'gguf')) throw new Error('Remote or non-local embedding models are not allowed.');
  const ps = await request(settings, '/api/ps', null, deadline);
  const running = ps.models?.find(item => modelName(item.name || item.model || '') === settings.model);
  if (running && String(running.digest || '').replace(/^sha256:/, '').toLowerCase() !== settings.modelDigest) throw new Error('Loaded model digest does not match the pinned model.');
  return {loaded: Boolean(running), gpuBytes: Number.isFinite(running?.size_vram) ? running.size_vram : 0};
}
function normalized(values, dimensions) {
  if (!Array.isArray(values) || values.length !== dimensions || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Embedding service returned an invalid vector.');
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding service returned a zero or invalid vector.');
  return Float32Array.from(values, value => value / norm);
}
async function embed(settings, inputs, deadline, warmOnly) {
  // Ollama does not return a digest with embeddings; check identity on both sides.
  const before = await inspect(settings, deadline);
  if (warmOnly && !before.loaded) throw new Error('Model is sleeping; automatic retrieval will not wake it.');
  const result = await request(settings, '/api/embed', {model: settings.model, input: inputs, keep_alive: settings.keepAlive, truncate: false, dimensions: settings.dimensions, options: {num_ctx: settings.context, num_batch: settings.batch}}, deadline);
  if (modelName(result.model || '') !== settings.model || !Array.isArray(result.embeddings) || result.embeddings.length !== inputs.length) throw new Error('Embedding service returned an unexpected model or vector count.');
  await inspect(settings, deadline);
  return result.embeddings.map(vector => normalized(vector, settings.dimensions));
}
function boundedText(text, bytes) {
  let result = '', size = 0;
  for (const char of text) { const n = Buffer.byteLength(char); if (size + n > bytes) break; result += char; size += n; }
  return result;
}
function chunksFor(entry, budget) {
  const content = String(entry.content || '');
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, match => match.replace(/[^\r\n]/g, ' '));
  const lines = body.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean), tokens = markdown.parse(body, {}), headings = new Map(), used = new Map();
  const starts = []; let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length; }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]; if (token.type !== 'heading_open') continue;
    const heading = (tokens[i + 1]?.children || []).map(child => ['text', 'code_inline', 'image'].includes(child.type) ? child.content : ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('');
    const base = headingSlug(heading), n = used.get(base) || 0; used.set(base, n + 1);
    headings.set(token.map[0] + 1, {heading, anchor: n ? `${base}-${n + 1}` : base, start: starts[token.map[0]], end: starts[token.map[1]] ?? body.length});
  }
  const chunks = []; let current = '', currentStart = 0, heading = '', anchor = '', headingRange = null, incomplete = false;
  const flush = () => {
    const trimmed = current.trim();
    if (!trimmed) { current = ''; return; }
    if (chunks.length >= budget) { incomplete = true; current = ''; return; }
    const start = currentStart + (current.length - current.trimStart().length);
    const title = boundedText(String(entry.note.title || '').trim(), 160);
    const section = boundedText(heading.trim(), 160);
    const prefix = [title, ...(section && section.toLocaleLowerCase() !== title.toLocaleLowerCase() ? [section] : [])].filter(Boolean).join('\n');
    const omitHeading = headingRange && Buffer.byteLength(heading) <= 160 && start === headingRange.start && currentStart + current.length >= headingRange.end;
    const document = omitHeading ? current.slice(headingRange.end - currentStart).trim() : trimmed;
    const text = `${prefix}${prefix && document ? '\n\n' : ''}${document}`;
    const sourceStart = omitHeading && document ? currentStart + current.indexOf(document, headingRange.end - currentStart) : start;
    let low = 0, high = starts.length;
    while (low < high) { const mid = (low + high) >>> 1; if (starts[mid] <= sourceStart) low = mid + 1; else high = mid; }
    chunks.push({key: hash(text), text, heading, anchor, start: sourceStart, line: low, excerpt: (document || trimmed).replace(/\s+/g, ' ').slice(0, 400)}); current = '';
  };
  for (let i = 0; i < lines.length && !incomplete; i++) {
    const h = headings.get(i + 1);
    if (h) { flush(); heading = h.heading; anchor = h.anchor; headingRange = h; }
    let rest = lines[i], position = starts[i];
    while (rest && !incomplete) {
      if (!current) currentStart = position;
      const part = boundedText(rest, Math.max(0, 1200 - Buffer.byteLength(current)));
      current += part; rest = rest.slice(part.length); position += part.length;
      if (rest) {
        let overlapStart = Math.max(0, current.length - 120);
        if (overlapStart && /[\uDC00-\uDFFF]/.test(current[overlapStart])) overlapStart++;
        const overlap = current.slice(overlapStart), overlapOffset = currentStart + overlapStart;
        flush();
        if (!incomplete) { current = overlap; currentStart = overlapOffset; }
      }
    }
  }
  flush(); return {chunks, incomplete};
}
async function serialized(key, deadline, signal, work) {
  let slot = jobs.get(key);
  if (!slot) { slot = {tail: Promise.resolve(), pending: 0}; jobs.set(key, slot); }
  if (slot.pending >= MAX_QUEUE) throw new Error('Embedding queue is full.');
  slot.pending++;
  const previous = slot.tail;
  let release; slot.tail = new Promise(resolve => { release = resolve; });
  let timer, onAbort;
  try {
    const waiting = [previous, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Embedding queue timed out.')), Math.max(1, deadline - Date.now())); })];
    if (signal) waiting.push(new Promise((_, reject) => {
      onAbort = () => reject(new Error('Semantic search was cancelled.'));
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, {once: true});
    }));
    await Promise.race(waiting);
    clearTimeout(timer);
    if (signal?.aborted) throw new Error('Semantic search was cancelled.');
    if (Date.now() >= deadline) throw new Error('Embedding queue timed out.');
    return await work();
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    // A timed-out waiter must not release the next job ahead of its predecessor.
    previous.finally(() => release());
    if (--slot.pending === 0) jobs.delete(key);
  }
}
function fail(config, error) { return {enabled: Boolean(config?.embeddings?.enabled), state: 'unavailable', model: config?.embeddings?.model || null, reason: `Semantic retrieval unavailable: ${error.message}`}; }
export async function embeddingStatus(config) {
  let db;
  try {
    const settings = embeddingSettings(config);
    if (!settings.enabled) return {enabled: false, state: 'disabled', model: null};
    const info = await inspect(settings, Date.now() + 10000);
    db = await openCache(config);
    return {enabled: true, state: info.loaded ? 'ready' : 'sleeping', model: settings.model, ...info, indexedChunks: count(db, settings)};
  } catch (error) { return fail(config, error); } finally { db?.close(); }
}
export async function semanticSearch(config, entries, query, {limit = 100, timeoutMs = 60000, warmOnly = false, signal} = {}) {
  let db;
  try {
    const settings = embeddingSettings(config);
    if (!settings.enabled) return {matches: [], status: {enabled: false, state: 'disabled', model: null}};
    settings.signal = signal;
    const deadline = Date.now() + Math.max(1, Math.min(Number.isFinite(timeoutMs) ? timeoutMs : 60000, 120000));
    const key = `${cachePath(config)}\n${settings.endpoint}\n${settings.fingerprint}`;
    return await serialized(key, deadline, signal, async () => {
      const info = await inspect(settings, deadline);
      db = await openCache(config);
      const status = {enabled: true, state: info.loaded ? 'ready' : 'sleeping', model: settings.model, ...info, indexedChunks: count(db, settings)};
      if (warmOnly) status.reason = 'Automatic retrieval uses cached query and document vectors only; it never performs inference or wakes the model.';
      let bytes = 0, incomplete = false; const chunks = [];
      for (const entry of entries) {
        bytes += Buffer.byteLength(String(entry.content || ''));
        if (bytes > MAX_CORPUS_BYTES || chunks.length >= MAX_CHUNKS) { incomplete = true; break; }
        const parsed = chunksFor(entry, MAX_CHUNKS - chunks.length);
        for (const chunk of parsed.chunks) chunks.push({...chunk, note: entry.note});
        if (parsed.incomplete) { incomplete = true; break; }
      }
      const unique = new Map();
      for (const chunk of chunks) if (!unique.has(chunk.key)) unique.set(chunk.key, chunk);
      const vectors = new Map(), missing = [];
      for (const chunk of unique.values()) { const vector = loadVector(db, settings, chunk.key); if (vector) vectors.set(chunk.key, vector); else missing.push(chunk); }
      const rawQuery = String(query || '').trim();
      const instruction = 'Instruct: Retrieve notes relevant to the query.\nQuery: ';
      const queryText = boundedText(rawQuery, MAX_QUERY_BYTES - Buffer.byteLength(instruction));
      const shortened = queryText.length < rawQuery.length;
      const prompt = instruction + queryText, queryHash = `q:${hash(prompt)}`;
      const qkey = `${settings.fingerprint}\n${queryHash}`;
      const diskQuery = queryText ? loadVector(db, settings, queryHash) : null;
      const cachedQuery = queryText ? (queryCache.get(qkey) || diskQuery) : null;
      if (cachedQuery && !diskQuery) storeVectors(db, settings, [[queryHash, cachedQuery]]);
      // Checking /api/ps cannot prevent an unload between that check and /api/embed.
      // Automatic callers therefore use cached vectors only, even if currently loaded.
      if (warmOnly && (missing.length || (queryText && !cachedQuery))) return {matches: [], status: {...status, state: info.loaded ? 'incomplete' : 'sleeping', reason: `Automatic retrieval uses cached query and document vectors only; semantic vectors are missing.${shortened ? ' Semantic query was shortened to fit the model context.' : ''}`}};
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH), result = await embed(settings, batch.map(chunk => chunk.text), deadline, warmOnly);
        const records = batch.map((chunk, index) => [chunk.key, result[index]]); storeVectors(db, settings, records);
        for (const [chunkKey, vector] of records) vectors.set(chunkKey, vector);
      }
      status.indexedChunks = count(db, settings);
      let qvector = cachedQuery;
      if (queryText && !qvector) {
        [qvector] = await embed(settings, [prompt], deadline, warmOnly);
        storeVectors(db, settings, [[queryHash, qvector]]);
        queryCache.set(qkey, qvector); if (queryCache.size > 128) queryCache.delete(queryCache.keys().next().value);
      } else if (qvector) { queryCache.delete(qkey); queryCache.set(qkey, qvector); }
      if (missing.length || (queryText && !cachedQuery)) {
        const refreshed = await inspect(settings, deadline);
        Object.assign(status, refreshed, {state: refreshed.loaded ? 'ready' : 'sleeping'});
      }
      if (incomplete) { status.state = 'incomplete'; status.reason = 'Semantic indexing reached its corpus or chunk limit.'; }
      if (shortened) { status.state = 'incomplete'; status.reason = `${status.reason ? `${status.reason} ` : ''}Semantic query was shortened to fit the model context.`; }
      const best = new Map();
      if (qvector) for (const chunk of chunks) {
        const vector = vectors.get(chunk.key); if (!vector) continue;
        let similarity = 0; for (let i = 0; i < vector.length; i++) similarity += vector[i] * qvector[i];
        if (similarity < settings.minSimilarity) continue;
        const old = best.get(chunk.note.path);
        if (!old || similarity > old.similarity) best.set(chunk.note.path, {path: chunk.note.path, revision: chunk.note.revision, similarity, excerpt: chunk.excerpt, heading: chunk.heading, anchor: chunk.anchor, line: chunk.line, start: chunk.start});
      }
      const max = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 100;
      return {matches: [...best.values()].sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path)).slice(0, max), status};
    });
  } catch (error) { return {matches: [], status: fail(config, error)}; } finally { db?.close(); }
}
