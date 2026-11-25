export function routeKey(route) {
  if (!route) return 'overview';
  if (route.kind === 'note') return `note:${route.path}:${route.edit ? 'edit' : 'read'}`;
  if (route.kind === 'new') return 'new';
  if (route.kind === 'search') return `search:${route.query || ''}:${route.workspace || ''}:${route.owner || ''}:${route.review || ''}:${route.scope || 'all'}:${route.mode || 'hybrid'}`;
  if (route.kind === 'project') return `project:${route.id}:${route.mode || 'overview'}`;
  return `view:${route.kind || 'overview'}`;
}

export function routeTitle(route, notes = [], groups = []) {
  if (!route) return 'Overview';
  if (route.kind === 'note') {
    const match = notes.find(n => n.path === route.path);
    const base = match?.title || route.path?.split('/').pop()?.replace(/\.md$/i, '') || 'Note';
    return route.edit ? `Edit: ${base}` : base;
  }
  if (route.kind === 'new') return 'New note';
  if (route.kind === 'search') return route.query ? `Search: ${route.query}` : 'Search';
  if (route.kind === 'project') {
    if (route.id === '__all') return 'All vaults graph';
    const g = groups.find(item => item.id === route.id);
    return g?.name || (route.id === 'global' ? 'General' : route.id === 'personal' ? 'Personal' : route.id === '__unmapped' ? 'Unmapped' : route.id);
  }
  const labels = {
    overview: 'Overview',
    all: 'All notes',
    owner: 'Your notes',
    agent: 'Agent memory',
    review: 'Review queue',
    proposals: 'Proposals',
    projects: 'Workspaces',
    cleanup: 'Clean up',
    trash: 'Trash',
    health: 'Memory health',
    usage: 'Note usage',
    harnesses: 'Harnesses',
    recovery: 'Backups & recovery',
  };
  return labels[route.kind] || 'Axiom';
}

export function createTab(route, title, id = null) {
  return {
    id: id || `tab-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    route,
    title: title || routeTitle(route),
    dirty: false,
  };
}

export function openTab(tabs, activeId, route, title, { newTab = false } = {}) {
  const key = routeKey(route);
  const existing = tabs.find(t => routeKey(t.route) === key);
  if (existing && !newTab) {
    return { tabs, activeId: existing.id };
  }
  if (!newTab && tabs.length) {
    const current = tabs.find(t => t.id === activeId);
    if (current && !current.dirty) {
      const next = tabs.map(t => (t.id === activeId ? { ...t, route, title: title || routeTitle(route) } : t));
      return { tabs: next, activeId };
    }
  }
  const created = createTab(route, title);
  return { tabs: [...tabs, created].slice(-24), activeId: created.id };
}

export function closeTab(tabs, activeId, targetId) {
  if (tabs.length <= 1) {
    const fallback = createTab({ kind: 'overview' }, 'Overview', tabs[0]?.id);
    return { tabs: [fallback], activeId: fallback.id };
  }
  const idx = tabs.findIndex(t => t.id === targetId);
  if (idx < 0) return { tabs, activeId };
  const nextTabs = tabs.filter(t => t.id !== targetId);
  if (activeId !== targetId) return { tabs: nextTabs, activeId };
  const nextActive = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id || nextTabs[0].id;
  return { tabs: nextTabs, activeId: nextActive };
}

export function setTabDirty(tabs, tabId, dirty) {
  let changed = false;
  const next = tabs.map(t => {
    if (t.id === tabId && t.dirty !== Boolean(dirty)) {
      changed = true;
      return { ...t, dirty: Boolean(dirty) };
    }
    return t;
  });
  return changed ? next : tabs;
}

export function nextTabId(tabs, activeId, delta) {
  if (tabs.length <= 1) return activeId;
  const idx = tabs.findIndex(t => t.id === activeId);
  if (idx < 0) return tabs[0].id;
  const target = (idx + delta + tabs.length) % tabs.length;
  return tabs[target].id;
}
