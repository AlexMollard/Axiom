let currentStats = null;
const listeners = new Set();

export function publishEditorStats(stats) {
  currentStats = stats;
  for (const fn of listeners) fn(currentStats);
}

export function getEditorStats() {
  return currentStats;
}

export function subscribeEditorStats(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
