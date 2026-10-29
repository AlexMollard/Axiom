const revision = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const agentNote = note => note.owner === 'agent' && typeof note.path === 'string' && revision(note.revision);
export const notifiable = note => agentNote(note) && note.path.toLowerCase() !== 'agents/workspace icons.md' && note.reviewStatus === 'unreviewed' && !['archived', 'superseded'].includes((note.status || '').toLowerCase());

export function initialNotifications(notes) {
  return {version: 1, seen: Object.fromEntries(notes.filter(agentNote).map(note => [note.path, note.revision]))};
}
export function parseNotifications(text) {
  try {
    const data = JSON.parse(text);
    if (data?.version !== 1 || !data.seen || typeof data.seen !== 'object' || Array.isArray(data.seen)) return null;
    const entries = Object.entries(data.seen);
    if (entries.some(([path, value]) => !path.startsWith('Agents/') || !/\.md$/i.test(path) || !revision(value))) return null;
    return {version: 1, seen: Object.fromEntries(entries)};
  } catch { return null; }
}
export function reconcileNotifications(state, notes) {
  const current = notes.filter(agentNote), paths = new Set(current.map(note => note.path));
  const seen = Object.fromEntries(Object.entries(state.seen).filter(([path]) => paths.has(path)));
  for (const note of current) if (!notifiable(note)) seen[note.path] = note.revision;
  const previous = Object.entries(state.seen), next = Object.entries(seen);
  return previous.length === next.length && next.every(([path, value]) => state.seen[path] === value) ? state : {version: 1, seen};
}
export function unreadNotifications(state, notes) {
  if (!state) return [];
  return notes.filter(note => notifiable(note) && state.seen[note.path] !== note.revision).sort((a, b) => b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path));
}
export function acknowledgeNotifications(state, notes) {
  return {version: 1, seen: {...state.seen, ...Object.fromEntries(notes.filter(agentNote).map(note => [note.path, note.revision]))}};
}
