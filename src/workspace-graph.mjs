import { catalogWithContent } from './memory.mjs';

export async function buildWorkspaceGraph(config, project, renderMarkdown) {
  const configured = new Set(config.projects.map(({ id }) => id));
  const fullVault = project === '__all';
  if (!project || (!fullVault && project !== 'global' && project !== '__unmapped' && !configured.has(project))) {
    const error = new Error('Unknown workspace.'); error.status = 400; throw error;
  }
  const fullNotes = await catalogWithContent(config);
  const notes = fullNotes.map(({ content, ...note }) => note);
  const resolveWorkspaceId = note => note.project === 'global' || configured.has(note.project) ? note.project : '__unmapped';
  const selectedIndexes = [];
  fullNotes.forEach((note, index) => {
    const match = fullVault
      ? true
      : project === '__unmapped'
        ? note.project !== 'global' && !configured.has(note.project)
        : note.project === project;
    if (match) selectedIndexes.push(index);
  });
  const selectedPaths = new Set(selectedIndexes.map(index => notes[index].path));
  const byPath = new Map(notes.map(note => [note.path, note]));
  const external = new Set();
  const edges = [];
  let unresolvedCount = 0;
  for (const index of selectedIndexes) {
    const full = fullNotes[index];
    const graph = { targets: new Set(), unresolvedCount: 0, linksOnly: true };
    renderMarkdown(full.content, full.path, notes, graph);
    unresolvedCount += graph.unresolvedCount;
    for (const target of [...graph.targets].sort()) {
      edges.push({ source: full.path, target });
      if (!selectedPaths.has(target)) external.add(target);
    }
  }
  return {
    project,
    nodes: [
      ...selectedIndexes.map(index => ({ ...notes[index], workspaceId: resolveWorkspaceId(notes[index]), external: false })),
      ...[...external].sort().map(p => {
        const target = byPath.get(p);
        return { ...target, workspaceId: resolveWorkspaceId(target), external: true };
      }),
    ],
    edges,
    unresolvedCount,
  };
}
