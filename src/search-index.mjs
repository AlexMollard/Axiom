import MarkdownIt from 'markdown-it';
import {headingSlug} from './note-links.mjs';

const markdown = new MarkdownIt({html: false, linkify: false, breaks: false});
markdown.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== '[[') return false;
  const end = state.src.indexOf(']]', start + 2);
  if (end < 0) return false;
  const [target, ...label] = state.src.slice(start + 2, end).split('|');
  if (!target.trim()) return false;
  if (!silent) state.push('text', '', 0).content = label.join('|').trim() || target.trim();
  state.pos = end + 2;
  return true;
});
let driver;
async function database() {
  driver ||= (async () => {
    if (globalThis.Bun) {
      const {Database} = await import('bun:sqlite');
      return () => new Database(':memory:');
    }
    const {DatabaseSync} = await import('node:sqlite');
    return () => new DatabaseSync(':memory:');
  })();
  return (await driver)();
}

export function normalizeSearchText(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/(?<![\p{L}\p{N}+#])[+#]+(?=[\p{L}\p{N}])/gu, '');
}

export function lexicalTerms(value) {
  return normalizeSearchText(value).match(/[\p{L}\p{N}][\p{L}\p{N}+#]*/gu) || [];
}

// Function words and chat filler: they appear in nearly every note, so a match on them is not evidence.
const STOPWORDS = new Set(('the and for this that with from have please what how can you a an of to in on at by or as if so is it its was were are be been being do does did done ' +
  'i me my we us our your they them their he she his her these those there here then than but not no yes ok okay just also all any some into about out up ' +
  'will would should could may might must shall let lets get got go now very too only when where why which who whom whose while thanks thank s t m d ll re ve don').split(' ')); // trailing entries are contraction fragments: lexicalTerms splits on apostrophes

export function queryWords(query) {
  return [...new Set(lexicalTerms(query))].filter(word => !STOPWORDS.has(word));
}

let warm = null;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;

export async function rankEntries(entries, words, key) {
  const metadataBytes = entries.reduce((sum, {note}) => sum + 512 + Buffer.byteLength(note.path) * 2 + Buffer.byteLength(note.title), 0);
  let index = warm?.key === key ? warm : null;
  if (!index) {
    const db = await database();
    db.exec(`CREATE VIRTUAL TABLE notes USING fts5(title, path, body, tokenize="unicode61 remove_diacritics 2 tokenchars '+#'")`);
    index = {key, db, entries: new Map(), nextId: 1};
    if (warm) warm.db.close();
    warm = index;
  }
  const {db} = index;
  try {
    const insert = db.prepare('INSERT INTO notes(rowid, title, path, body) VALUES (?, ?, ?, ?)');
    const remove = db.prepare('DELETE FROM notes WHERE rowid = ?');
    const current = new Set(entries.map(entry => entry.note.path));
    db.exec('BEGIN');
    for (const [path, old] of index.entries) {
      if (!current.has(path)) { remove.run(old.id); index.entries.delete(path); }
    }
    for (const entry of entries) {
      const {note, content} = entry;
      const old = index.entries.get(note.path);
      if (old && old.revision === note.revision && old.title === note.title) continue;
      if (old) remove.run(old.id);
      const id = old?.id ?? index.nextId++;
      insert.run(id, normalizeSearchText(note.title), normalizeSearchText(note.path), normalizeSearchText(content));
      index.entries.set(note.path, {id, revision: note.revision, title: note.title});
    }
    db.exec('COMMIT');
    const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    if (entries.length > 20000 || pageCount * pageSize + metadataBytes > MAX_INDEX_BYTES) warm = null;
    const match = words.map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ');
    const rows = db.prepare('SELECT rowid, bm25(notes, 8.0, 4.0, 1.0) AS rank FROM notes WHERE notes MATCH ? ORDER BY rank, rowid').all(match);
    const paths = new Map([...index.entries].map(([path, entry]) => [entry.id, path]));
    return rows.map(row => ({path: paths.get(Number(row.rowid)), score: -Number(row.rank)}));
  } catch (error) {
    if (warm === index) warm = null;
    db.close();
    throw error;
  } finally {
    if (warm !== index) { try { db.close(); } catch {} }
  }
}

export function passageEvidence(content, title, path, words) {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, match => match.replace(/[^\r\n]/g, ' '));
  const tokens = markdown.parse(body, {});
  const headings = [];
  const used = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'heading_open') continue;
    const text = (tokens[i + 1]?.children || []).map(child =>
      ['text', 'code_inline', 'image'].includes(child.type) ? child.content :
      ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('');
    const base = headingSlug(text);
    const count = used.get(base) || 0;
    used.set(base, count + 1);
    headings.push({line: token.map[0] + 1, heading: text, anchor: count ? `${base}-${count + 1}` : base});
  }
  const lines = body.split(/\r?\n/);
  const hasWord = text => {
    const terms = new Set(lexicalTerms(text));
    return words.some(word => terms.has(word));
  };
  const headingLines = new Set(headings.map(heading => heading.line));
  let index = lines.findIndex((line, i) => !headingLines.has(i + 1) && hasWord(line));
  const matchReason = hasWord(title) ? 'Title match' : hasWord(path) ? 'Path match' : 'Body match';
  if (index < 0) index = lines.findIndex((line, i) => headingLines.has(i + 1) && hasWord(line));
  if (index < 0) index = lines.findIndex((line, i) => line.trim() && !headingLines.has(i + 1));
  if (index < 0) index = 0;
  const nearest = headings.filter(item => item.line <= index + 1).at(-1);
  const excerpt = (markdown.parseInline(lines.slice(index, index + 4).join(' '), {})[0]?.children || []).map(child =>
    ['text', 'code_inline', 'image'].includes(child.type) ? child.content :
    ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('').replace(/\s+/g, ' ').trim().slice(0, 400);
  return {heading: nearest?.heading || '', anchor: nearest?.anchor || '', line: index + 1, matchReason, excerpt};
}
