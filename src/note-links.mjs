import path from 'node:path';

export const headingSlug = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';

const noteIndexes = new WeakMap();
function noteIndex(notes) {
  let index = noteIndexes.get(notes);
  if (index) return index;
  index = {paths: new Map(), aliases: new Map()};
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

export function resolveNote(target, current, notes) {
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
