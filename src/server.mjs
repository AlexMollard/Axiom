import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, appendFileSync, statSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { format } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { catalog, readNote, search, loadConfig, backup, saveFromEditor, saveReviewFromEditor, hash } from './memory.mjs';
import { buildWorkspaceGraph } from './workspace-graph.mjs';
import { readWorkspaceIcons, searchWorkspaceIcons } from './workspace-icons.mjs';
import { workspaceDetail, updateWorkspace, deleteNote, deleteWorkspace, listTrash, restoreTrash, protectedDeletionReason } from './management.mjs';
import {getReviewDiff} from './review-history.mjs';
import {getWorkspaceOverview, getMemoryHealth} from './knowledge.mjs';
import {getHarnessStatus} from './harness-status.mjs';
import {getRecoveryStatus, createRecoverySnapshot, checkRecoverySnapshot} from './recovery.mjs';
import {inventoryUsage, getNoteUsage} from './note-usage.mjs';

const buildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const assetTypes = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const headingSlug = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
function noteHref(note, target, wiki = false) {
  const fragment = target.includes('#') ? target.slice(target.indexOf('#') + 1) : '';
  let decoded = fragment;
  try { decoded = decodeURIComponent(fragment); } catch {}
  return '/?note=' + encodeURIComponent(note.path) + (fragment ? '#' + encodeURIComponent(wiki ? headingSlug(decoded) : decoded) : '');
}

const noteIndexes = new WeakMap();
function noteIndex(notes) {
  let index = noteIndexes.get(notes);
  if (index) return index;
  index = { paths: new Map(), aliases: new Map() };
  const add = (map, key, note) => map.set(key, map.has(key) ? null : note);
  for (const note of notes) {
    const fullPath = note.path.replace(/\.md$/i, '').toLowerCase();
    const basename = note.path.split('/').pop().replace(/\.md$/i, '').toLowerCase();
    const title = note.title.toLowerCase();
    add(index.paths, fullPath, note);
    add(index.aliases, basename, note);
    if (title !== basename) add(index.aliases, title, note);
  }
  noteIndexes.set(notes, index);
  return index;
}

function resolveNote(target, current, notes) {
  const clean = target.split('#')[0].split('?')[0].replace(/\\/g, '/');
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch { return null; }
  if (!decoded || /^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('//')) return null;
  const withoutExt = decoded.replace(/\.md$/i, '');
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(current), withoutExt)).replace(/^\.\//, '');
  const root = path.posix.normalize(withoutExt.replace(/^\//, ''));
  const index = noteIndex(notes);
  const match = index.paths.get((decoded.startsWith('/') ? root : relative).toLowerCase());
  if (match) return match;
  const rootMatch = index.paths.get(root.toLowerCase());
  if (rootMatch) return rootMatch;
  return index.aliases.get(root.toLowerCase()) || null;
}

export function renderMarkdown(content, current, notes, graph = null) {
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const start = state.pos;
    if (state.src.slice(start, start + 2) !== '[[') return false;
    const end = state.src.indexOf(']]', start + 2);
    if (end < 0) return false;
    const [target, ...label] = state.src.slice(start + 2, end).split('|');
    if (!target.trim()) return false;
    if (!silent) {
      const trimmed = target.trim();
      const note = trimmed.startsWith('#') ? notes.find(item => item.path === current) || {path: current} : resolveNote(trimmed, current, notes);
      if (graph && target.trim().split('#')[0].split('?')[0] && !/^[a-z][a-z\d+.-]*:/i.test(target.trim()) && !target.trim().startsWith('//')) {
        if (note && note.path !== current) graph.targets.add(note.path);
        else if (!note) graph.unresolvedCount++;
      }
      if (note) {
        const open = state.push('link_open', 'a', 1);
        open.attrSet('href', noteHref(note, trimmed, true));
      }
      const text = state.push('text', '', 0);
      text.content = label.join('|').trim() || target.trim();
      if (note) state.push('link_close', 'a', -1);
    }
    state.pos = end + 2;
    return true;
  });
  const originalLink = md.renderer.rules.link_open || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') || '';
    if (!href.startsWith('/?note=') && /\.md(?:[?#]|$)/i.test(href) && !/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//')) {
      const note = resolveNote(href, current, notes);
      if (graph) {
        if (note && note.path !== current) graph.targets.add(note.path);
        else if (!note) graph.unresolvedCount++;
      }
      token.attrSet('href', note ? noteHref(note, href) : '#');
    }
    return originalLink(tokens, idx, options, env, self);
  };
  // Remote and embedded content is not loaded by the reader.
  md.renderer.rules.image = (tokens, idx) => md.utils.escapeHtml(tokens[idx].content || 'Image');
  const used = new Map();
  md.core.ruler.push('heading_ids', state => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token.type !== 'heading_open') continue;
      const text = (state.tokens[i + 1]?.children || []).map(child =>
        ['text', 'code_inline', 'image'].includes(child.type) ? child.content :
        ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('');
      const base = headingSlug(text);
      const count = used.get(base) || 0;
      used.set(base, count + 1);
      token.attrSet('id', count ? `${base}-${count + 1}` : base);
    }
  });
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return sanitizeHtml(md.render(body), {
    allowedTags: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'strong', 'em', 's', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    allowedAttributes: { a: ['href', 'title'], h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'] },
    allowedSchemes: ['http', 'https', 'mailto'], allowProtocolRelative: false,
  });
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    const error = new Error('Use application/json.'); error.status = 415; throw error;
  }
  const chunks = [];
  let size = 0;
  // JSON control-character escaping can be six times larger than the Markdown bytes.
  const maximum = 12 * 1024 * 1024 + 8192;
  for await (const chunk of req) { size += chunk.length; if (size <= maximum) chunks.push(chunk); }
  if (size > maximum) { const error = new Error('Request body is too large.'); error.status = 413; throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createServer(config, configId = null) {
  const csrf = randomBytes(32);
  const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const server = http.createServer(async (req, res) => {
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { ...headers, 'Content-Type': type, ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const json = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    const host = req.headers.host;
    if (!host || !allowedHosts.has(host.toLowerCase())) return json(403, { error: 'Invalid host' });
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { return json(403, { error: 'Invalid origin' }); }
      if (origin.protocol !== 'http:' || !allowedHosts.has(origin.host.toLowerCase()) || origin.origin !== req.headers.origin) return json(403, { error: 'Invalid origin' });
    }
    try {
      const url = new URL(req.url, `http://${host}`);
      const read = req.method === 'GET' || req.method === 'HEAD';
      const save = req.method === 'PUT' && url.pathname === '/api/note';
      const preview = req.method === 'POST' && url.pathname === '/api/preview';
      const review = req.method === 'PUT' && url.pathname === '/api/note-review';
      const management = (req.method === 'PUT' && url.pathname === '/api/workspace') || (req.method === 'DELETE' && ['/api/note', '/api/workspace'].includes(url.pathname)) || (req.method === 'POST' && url.pathname === '/api/trash/restore');
      const recovery = req.method === 'POST' && ['/api/recovery/backup', '/api/recovery/check'].includes(url.pathname);
      if (!read && !save && !preview && !review && !management && !recovery) { res.setHeader('Allow', 'GET, HEAD, PUT, POST, DELETE'); return json(405, { error: 'Method not allowed' }); }
      if (save || preview || review || management || recovery) {
        if (req.headers.origin !== `http://${host.toLowerCase()}` || req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Editor requests must originate from this site.' });
        const token = req.headers['x-shared-brain-csrf'];
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token, 'hex'), csrf)) return json(403, { error: 'Editor session is missing or expired. Reload the editor session; your draft has not been saved.' });
        const body = await readJson(req);
        if (recovery) return json(200, url.pathname === '/api/recovery/backup' ? await createRecoverySnapshot(config) : await checkRecoverySnapshot(config, body.snapshot));
        if (management) {
          if (url.pathname === '/api/trash/restore') return json(200, await restoreTrash(config, body.id));
          if (url.pathname === '/api/workspace') return json(200, req.method === 'PUT' ? await updateWorkspace(config, body) : await deleteWorkspace(config, body.id, body.expectedRevision));
          return json(200, await deleteNote(config, body.path, body.expectedRevision));
        }
        if (review) {
          const note = await saveReviewFromEditor(config, body.path, body.expectedRevision, body.decision);
          return json(200, { note, html: renderMarkdown(note.content, note.path, await catalog(config)) });
        }
        if (typeof body.path !== 'string' || typeof body.content !== 'string' || Buffer.byteLength(body.content) > 2 * 1024 * 1024) return json(400, { error: 'Provide a Markdown path and content no larger than 2 MiB.' });
        if (save) {
          const note = await saveFromEditor(config, body.path, body.content, body.expectedRevision);
          return json(200, { note, html: renderMarkdown(note.content, note.path, await catalog(config)) });
        }
        return json(200, { html: renderMarkdown(body.content, body.path, await catalog(config)) });
      }
      if (url.pathname === '/api/editor-session') {
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Cross-site editor access denied.' });
        return json(200, { token: csrf.toString('hex'), protection: 'rule-level' });
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const nonce = randomBytes(18).toString('base64');
        let html;
        try { html = await readFile(path.join(buildDir, 'index.html'), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; return json(503, { error: 'Frontend build is missing. Run npm run build.' }); }
        return send(200, 'text/html; charset=utf-8', html.replaceAll('__STYLE_NONCE__', nonce), { 'Content-Security-Policy': headers['Content-Security-Policy'].replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`) });
      }
      if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname) || /^\/licenses\/(?:Manrope|JetBrains-Mono)-OFL\.txt$/.test(url.pathname)) {
        const type = assetTypes[path.extname(url.pathname)];
        if (!type) return json(404, { error: 'Not found' });
        const hashed = /^\/assets\/[a-zA-Z0-9_.-]+-[a-zA-Z0-9_-]{8}\.(?:js|css|woff2)$/.test(url.pathname);
        return send(200, type, await readFile(path.join(buildDir, url.pathname.slice(1))), hashed ? { 'Cache-Control': 'public, max-age=31536000, immutable' } : {});
      }
      if (url.pathname === '/health') return json(200, configId ? { ok: true, pid: process.pid, configId, uptimeSeconds: process.uptime() } : { ok: true });
      if (url.pathname === '/api/catalog') {
        const { assignments: workspaceIcons } = await readWorkspaceIcons(config);
        const workspaceNames = {global: config.workspaceNames?.global || 'General', __unmapped: config.workspaceNames?.__unmapped || 'Unmapped', ...Object.fromEntries(config.projects.map(({id, name}) => [id, name || id]))};
        const workspaceGroups = Object.fromEntries(Object.keys(workspaceNames).map(id => [id, config.workspaceGroups?.[id] === 'home' ? 'home' : 'work']));
        const notes = await catalog(config);
        const usageTracking = await inventoryUsage(config, notes);
        return json(200, { notes: notes.map(note => ({...note, deleteBlockedReason: protectedDeletionReason(note.path)})), usageTracking, vaultName: path.basename(config.vault), vaultId: hash(config.vault), protection: 'rule-level', workspaceIcons, workspaceNames, workspaceGroups, projects: config.projects.map(({ id, name }) => ({ id, name: name || id, icon: workspaceIcons[id] || null, group: workspaceGroups[id] })) });
      }
      if (url.pathname === '/api/workspace') return json(200, await workspaceDetail(config, url.searchParams.get('id')));
      if (url.pathname === '/api/workspace-icons') return json(200, await searchWorkspaceIcons(config, url.searchParams.get('q') || '', Number(url.searchParams.get('limit') || 24)));
      if (url.pathname === '/api/trash') return json(200, await listTrash(config));
      if (url.pathname === '/api/graph') return json(200, await buildWorkspaceGraph(config, url.searchParams.get('project'), renderMarkdown));
      if (url.pathname === '/api/review-diff') return json(200, await getReviewDiff(config, url.searchParams.get('path')));
      if (url.pathname === '/api/workspace-overview') return json(200, await getWorkspaceOverview(config, url.searchParams.get('id')));
      if (url.pathname === '/api/memory-health') return json(200, await getMemoryHealth(config, renderMarkdown));
      if (url.pathname === '/api/harnesses') return json(200, await getHarnessStatus(config));
      if (url.pathname === '/api/recovery') return json(200, await getRecoveryStatus(config));
      if (url.pathname === '/api/note-usage') return json(200, await getNoteUsage(config, await catalog(config)));
      if (url.pathname === '/api/note') {
        const notePath = url.searchParams.get('path');
        if (!notePath) return json(400, { error: 'A note path is required' });
        const note = await readNote(config, notePath);
        note.deleteBlockedReason = protectedDeletionReason(note.path);
        return json(200, { note, html: renderMarkdown(note.content, note.path, await catalog(config)) });
      }
      if (url.pathname === '/api/search') {
        const scope = url.searchParams.get('scope') ?? 'all';
        if (!['all', 'active'].includes(scope)) return json(400, {error: 'Search scope must be all or active.'});
        return json(200, await search(config, url.searchParams.get('q') || '', {all: true, includeInactive: scope === 'all', workspace: url.searchParams.get('workspace') || '', owner: url.searchParams.get('owner') || '', review: url.searchParams.get('review') || '', offset: url.searchParams.get('offset') || 0, limit: url.searchParams.get('limit') || 50}));
      }
      return json(404, { error: 'Not found' });
    } catch (error) {
      return json(Number.isInteger(error.status) ? error.status : 400, { error: error.message || 'Unable to load resource' });
    }
  });
  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address !== 'string') {
      allowedHosts.clear();
      allowedHosts.add(`127.0.0.1:${address.port}`);
      allowedHosts.add(`localhost:${address.port}`);
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return server;
}

let isEntrypoint = false;
if (process.argv[1]) {
  try { isEntrypoint = realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url)); }
  catch { /* Imported with a missing or non-file argv entry. */ }
}
if (isEntrypoint) {
  const requestedConfig = path.resolve(process.argv[2] || process.env.SHARED_BRAIN_CONFIG || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.config'), 'Axiom', 'config.json'));
  let configPath;
  try { configPath = realpathSync.native(requestedConfig); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    configPath = path.join(realpathSync.native(path.dirname(requestedConfig)), path.basename(requestedConfig));
  }
  const identity = createHash('sha256').update(configPath.toLowerCase()).digest('hex');
  const state = path.join(path.dirname(configPath), '.state', `runtime-${identity.slice(0, 16).toUpperCase()}`);
  mkdirSync(state, { recursive: true });
  // Retain bounded diagnostics even when the server is launched without a console.
  const log = path.join(state, 'server.log');
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const line = `${new Date().toISOString()} ${format(...args).replace(/\r?\n/g, '\r\n')}\r\n`;
      try {
        try { if (statSync(log).size + Buffer.byteLength(line) > 1024 * 1024) writeFileSync(log, ''); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        appendFileSync(log, Buffer.from(line).subarray(0, 1024 * 1024));
      } catch (error) { original(`Could not write server log: ${error.message}`); }
      original(...args);
    };
  }
  process.on('warning', warning => console.warn(warning.stack || warning.message));
  process.on('uncaughtException', error => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
  process.on('unhandledRejection', error => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
  // libuv uses FILE_FLAG_FIRST_PIPE_INSTANCE; the kernel releases it on exit.
  if (process.platform === 'win32') {
    const guard = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      guard.once('error', reject);
      guard.listen(`\\\\.\\pipe\\axiom-${identity}`, resolve);
    });
  }
  writeFileSync(path.join(state, 'server.pid'), `${process.pid}\r\n`);
  const config = await loadConfig(configPath);
  const server = createServer(config, identity.slice(0, 16).toUpperCase());
  // The HTTP socket also rejects a conflicting listener on the configured port.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', resolve);
  });
  const save = async () => {
    const result = await backup(config);
    console.log(`Backup: ${result.snapshot} (${result.files} files)`);
  };
  await save();
  setInterval(() => save().catch(error => console.error(`BACKUP FAILED: ${error.message}`)), 24 * 60 * 60 * 1000).unref();
  console.log(`Shared Brain: http://127.0.0.1:${config.port}`);
}
