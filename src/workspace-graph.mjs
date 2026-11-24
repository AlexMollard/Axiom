import { catalog, readNote } from './memory.mjs';

export async function buildWorkspaceGraph(config, project, renderMarkdown) {
  const configured = new Set(config.projects.map(({ id }) => id));
  const fullVault = project === '__all';
  if (!project || (!fullVault && project !== 'global' && project !== '__unmapped' && !configured.has(project))) {
    const error = new Error('Unknown workspace.'); error.status = 400; throw error;
  }
  const notes = await catalog(config);
  const resolveWorkspaceId = note => note.project === 'global' || configured.has(note.project) ? note.project : '__unmapped';
  const selected = fullVault
    ? notes
    : notes.filter(note => project === '__unmapped'
      ? note.project !== 'global' && !configured.has(note.project)
      : note.project === project);
  const selectedPaths = new Set(selected.map(note => note.path));
  const byPath = new Map(notes.map(note => [note.path, note]));
  const results = new Array(selected.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(12, selected.length) }, async () => {
    while (cursor < selected.length) {
      const index = cursor++;
      const note = await readNote(config, selected[index].path);
      const graph = { targets: new Set(), unresolvedCount: 0 };
      renderMarkdown(note.content, note.path, notes, graph);
      results[index] = graph;
    }
  }));
  const external = new Set();
  const edges = [];
  let unresolvedCount = 0;
  selected.forEach((note, index) => {
    const result = results[index];
    unresolvedCount += result.unresolvedCount;
    for (const target of [...result.targets].sort()) {
      edges.push({ source: note.path, target });
      if (!selectedPaths.has(target)) external.add(target);
    }
  });
  return {
    project,
    nodes: [
      ...selected.map(note => ({ ...note, workspaceId: resolveWorkspaceId(note), external: false })),
      ...[...external].sort().map(p => {
        const target = byPath.get(p);
        return { ...target, workspaceId: resolveWorkspaceId(target), external: true };
      }),
    ],
    edges,
    unresolvedCount,
  };
}
