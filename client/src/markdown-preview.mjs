import MarkdownIt from 'markdown-it';

export const headingSlug = text =>
  String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '') || 'section';

function posixNormalize(p) {
  const parts = String(p || '').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function posixDirname(p) {
  const idx = String(p || '').lastIndexOf('/');
  return idx <= 0 ? '' : p.slice(0, idx);
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
    const title = (note.title || basename).toLowerCase();
    add(index.paths, fullPath, note);
    add(index.aliases, basename, note);
    if (title !== basename) add(index.aliases, title, note);
  }
  noteIndexes.set(notes, index);
  return index;
}

export function resolveNote(target, current, notes) {
  const clean = String(target || '').split('#')[0].split('?')[0].replace(/\\/g, '/');
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch { return null; }
  if (!decoded || /^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('//')) return null;
  const withoutExt = decoded.replace(/\.md$/i, '');
  const dir = posixDirname(current || '');
  const relative = posixNormalize(dir ? `${dir}/${withoutExt}` : withoutExt);
  const root = posixNormalize(withoutExt.replace(/^\//, ''));
  const index = noteIndex(notes);
  const match = index.paths.get((decoded.startsWith('/') ? root : relative).toLowerCase());
  if (match) return match;
  const rootMatch = index.paths.get(root.toLowerCase());
  if (rootMatch) return rootMatch;
  return index.aliases.get(root.toLowerCase()) || null;
}

function noteHref(note, target, wiki = false) {
  const fragment = target.includes('#') ? target.slice(target.indexOf('#') + 1) : '';
  let decoded = fragment;
  try { decoded = decodeURIComponent(fragment); } catch {}
  return '/?note=' + encodeURIComponent(note.path) + (fragment ? '#' + encodeURIComponent(wiki ? headingSlug(decoded) : decoded) : '');
}

export function isSafeHref(href) {
  const trimmed = String(href || '').trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('/?') || trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('//')) return false;
  const schemeMatch = /^([a-z][a-z\d+.-]*):/i.exec(trimmed);
  if (!schemeMatch) return true;
  return ['http', 'https', 'mailto'].includes(schemeMatch[1].toLowerCase());
}

export function renderLocalMarkdown(content, currentPath, notes = []) {
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
      const note = trimmed.startsWith('#')
        ? notes.find(item => item.path === currentPath) || { path: currentPath }
        : resolveNote(trimmed, currentPath, notes);
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
      const note = resolveNote(href, currentPath, notes);
      token.attrSet('href', note ? noteHref(note, href) : '#');
    } else if (!isSafeHref(href)) {
      token.attrSet('href', '#');
    }
    return originalLink(tokens, idx, options, env, self);
  };

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

  const body = String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return md.render(body);
}
