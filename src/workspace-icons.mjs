import {readNote} from './memory.mjs';

export const WORKSPACE_ICONS_PATH = 'Agents/Workspace icons.md';

// The dynamic import table maps aliases to the same canonical icon module. Inspecting
// its lazy loader functions does not load React or any individual icon modules.
let namesPromise;
async function canonicalNames() {
  namesPromise ||= import('lucide-react/dynamicIconImports').then(({default: imports}) => {
    const names = new Set();
    for (const [name, load] of Object.entries(imports)) {
      const target = String(load).match(/\/icons\/([^/'"]+)\.mjs/);
      if (!target) throw new Error('Unable to identify canonical Lucide icon names.');
      if (name === target[1]) names.add(name);
    }
    return names;
  });
  return namesPromise;
}

export async function validateWorkspaceIcons(assignments) {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) throw new Error('Workspace icon assignments must be a JSON object.');
  const names = await canonicalNames();
  const used = new Set();
  for (const [workspace, icon] of Object.entries(assignments)) {
    if (!/^(?:[a-z0-9][a-z0-9-]*|__unmapped)$/.test(workspace)) throw new Error(`Invalid workspace ID: ${workspace}`);
    if (typeof icon !== 'string' || !names.has(icon)) throw new Error(`Invalid or non-canonical Lucide icon: ${icon}`);
    if (used.has(icon)) throw new Error(`Lucide icon ${icon} is assigned to more than one workspace.`);
    used.add(icon);
  }
  return assignments;
}

export async function parseWorkspaceIcons(content) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter || !/^status:\s*current\s*$/m.test(frontmatter[1]) || !/^project:\s*global\s*$/m.test(frontmatter[1])) throw new Error('Workspace icons note must have status: current and project: global.');
  const blocks = [...content.matchAll(/^```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/gm)];
  if (blocks.length !== 1) throw new Error('Workspace icons note must contain exactly one fenced JSON object.');
  let assignments;
  try { assignments = JSON.parse(blocks[0][1]); } catch { throw new Error('Workspace icons note contains invalid JSON.'); }
  return validateWorkspaceIcons(assignments);
}

export function serializeWorkspaceIcons(assignments) {
  return `---\r\nstatus: current\r\nproject: global\r\n---\r\n# Workspace icons\r\n\r\n\`\`\`json\r\n${JSON.stringify(assignments, null, 2).replace(/\n/g, '\r\n')}\r\n\`\`\`\r\n`;
}

export async function readWorkspaceIcons(config) {
  let note;
  try { note = await readNote(config, WORKSPACE_ICONS_PATH); }
  catch (error) { if (error.code === 'ENOENT') return {assignments: {}, revision: 'new'}; throw error; }
  return {assignments: await parseWorkspaceIcons(note.content), revision: note.revision};
}

export async function searchWorkspaceIcons(config, query = '', limit = 24) {
  if (typeof query !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Icon search requires a text query and a limit between 1 and 1000.');
  const {assignments} = await readWorkspaceIcons(config);
  const used = new Set(Object.values(assignments));
  const matches = [...await canonicalNames()].filter(name => !used.has(name) && name.includes(query.trim().toLowerCase())).sort();
  return {assignments, candidates: matches.slice(0, limit), total: matches.length, limit};
}
