import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
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

const buildDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
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

function resolveNote(target, current, notes) {
  const clean = target.split('#')[0].split('?')[0].replace(/\\/g, '/');
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch { return null; }
  if (!decoded || /^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('//')) return null;
  const withoutExt = decoded.replace(/\.md$/i, '');
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(current), withoutExt)).replace(/^\.\//, '');
  const root = path.posix.normalize(withoutExt.replace(/^\//, ''));
  const lookup = p => notes.filter(n => n.path.replace(/\.md$/i, '').toLowerCase() === p.toLowerCase());
  const matches = decoded.startsWith('/') ? lookup(root) : lookup(relative);
  if (matches.length === 1) return matches[0];
  const rootMatches = lookup(root);
  if (rootMatches.length === 1) return rootMatches[0];
  const byName = notes.filter(n => n.path.split('/').pop().replace(/\.md$/i, '').toLowerCase() === root.toLowerCase() || n.title.toLowerCase() === root.toLowerCase());
  return byName.length === 1 ? byName[0] : null;
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

export function createServer(config) {
  const csrf = randomBytes(32);
  const server = http.createServer(async (req, res) => {
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { ...headers, 'Content-Type': type, ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const json = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    const host = req.headers.host;
    const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
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
        return send(200, type, await readFile(path.join(buildDir, url.pathname.slice(1))));
      }
      if (url.pathname === '/health') return json(200, { ok: true });
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
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadConfig();
  const save = async () => {
    const result = await backup(config);
    console.log(`Backup: ${result.snapshot} (${result.files} files)`);
  };
  await save();
  setInterval(() => save().catch(error => console.error(`BACKUP FAILED: ${error.message}`)), 24 * 60 * 60 * 1000).unref();
  createServer(config).listen(config.port, '127.0.0.1', () => console.log(`Shared Brain: http://127.0.0.1:${config.port}`));
}
