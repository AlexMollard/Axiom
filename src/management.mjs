import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadConfig, catalog, locked, safePath, readRawNote, prepareMarkdown, commitMarkdown, backupUnlocked, hash, crlf} from './memory.mjs';
import {WORKSPACE_ICONS_PATH, readWorkspaceIcons, validateWorkspaceIcons, serializeWorkspaceIcons} from './workspace-icons.mjs';
import {embeddingSettings} from './embeddings.mjs';
import {sanitizeOptimizerSettings, validateOptimizerSettings} from './optimizer.mjs';

const protectedPaths = new Set(['owner/policies.md', 'owner/preferences.md', 'owner/reviews.md', WORKSPACE_ICONS_PATH.toLowerCase()]);
export const protectedDeletionReason = value => typeof value === 'string' && protectedPaths.has(value.toLowerCase()) ? 'This control note cannot be deleted.' : null;
const conflict = message => Object.assign(new Error(message), {status: 409});
const missing = error => error.code === 'ENOENT';
async function refresh(config) {
  if (!config.configPath) throw new Error('Management requires a trusted config path.');
  const bytes = await fs.readFile(config.configPath);
  const fresh = await loadConfig(config.configPath);
  if (fresh.vault !== config.vault || fresh.backupDir !== config.backupDir) throw conflict('Vault configuration changed; restart the server.');
  if (!bytes.equals(await fs.readFile(config.configPath))) throw conflict('Configuration changed on disk.');
  Object.assign(config, fresh);
  return {raw: JSON.parse(bytes.toString('utf8')), revision: hash(bytes)};
}
async function saveConfig(config, raw, expectedRevision) {
  const before = await fs.readFile(config.configPath);
  const history = path.join(config.backupDir, 'history', 'config', `${Date.now()}-${randomUUID()}.json`);
  if (hash(before) !== expectedRevision) throw conflict('Configuration changed on disk.');
  await fs.mkdir(path.dirname(history), {recursive: true});
  await fs.writeFile(history, before, {flag: 'wx'});
  const temp = `${config.configPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, crlf(JSON.stringify(raw, null, 2) + '\n'), {flag: 'wx'});
    if (!before.equals(await fs.readFile(config.configPath))) throw conflict('Configuration changed on disk.');
    await fs.rename(temp, config.configPath);
  } finally { await fs.rm(temp, {force: true}); }
  await refresh(config);
}

export async function configureEmbeddings(config, settings, expectedRevision) {
  embeddingSettings({embeddings: settings});
  return locked(config, async () => {
    const {raw, revision} = await refresh(config);
    if (revision !== expectedRevision) throw conflict('Configuration changed during model setup; rerun setup to preserve the newer settings.');
    raw.embeddings = settings;
    await saveConfig(config, raw, revision);
    return config.embeddings;
  });
}
export async function optimizerConfigState(config) {
  const {revision} = await refresh(config);
  return {settings: sanitizeOptimizerSettings(config), configRevision: revision};
}
export async function configureOptimizer(config, settings, expectedRevision) {
  const validated = validateOptimizerSettings(settings);
  return locked(config, async () => {
    const {raw, revision} = await refresh(config);
    if (revision !== expectedRevision) throw conflict('Configuration changed during optimizer setup; reload and retry.');
    const existing = raw.optimizer && typeof raw.optimizer === 'object' ? raw.optimizer : {};
    const next = {
      provider: validated.provider,
      model: validated.model,
      apiBaseUrl: validated.apiBaseUrl,
      deepRepoCheck: validated.deepRepoCheck,
      maxNotesPerBatch: validated.maxNotesPerBatch,
      timeoutMs: validated.timeoutMs,
    };
    if (settings?.clearApiKey === true) {
      next.apiKey = '';
    } else if (typeof settings?.apiKey === 'string' && settings.apiKey.trim()) {
      next.apiKey = settings.apiKey.trim();
    } else if (typeof existing.apiKey === 'string' && existing.apiKey.trim()) {
      next.apiKey = existing.apiKey.trim();
    }
    raw.optimizer = next;
    await saveConfig(config, raw, revision);
    const after = await refresh(config);
    return {settings: sanitizeOptimizerSettings(config), configRevision: after.revision};
  });
}
function selectNotes(config, id, notes) {
  const ids = new Set(config.projects.map(project => project.id));
  return notes.filter(note => id === '__unmapped' ? !['global', 'personal'].includes(note.project) && !ids.has(note.project) : note.project === id);
}
async function detail(config, id) {
  const project = config.projects.find(item => item.id === id);
  if (!project && id !== 'global' && id !== 'personal' && id !== '__unmapped') throw new Error('Unknown workspace.');
  const notes = selectNotes(config, id, await catalog(config));
  const {assignments} = await readWorkspaceIcons(config);
  const name = project?.name || (Object.hasOwn(config.workspaceNames || {}, id) ? config.workspaceNames[id] : null) || (id === 'global' ? 'General' : id === 'personal' ? 'Personal' : id === '__unmapped' ? 'Unmapped notes' : id);
  const group = id === 'personal' ? 'personal' : config.workspaceGroups?.[id] === 'home' ? 'home' : 'work';
  const icon = Object.hasOwn(assignments, id) ? assignments[id] : null;
  const pins = Array.isArray(config.workspacePins?.[id]) ? config.workspacePins[id] : [];
  const revision = hash(JSON.stringify({project: project || null, name, group, icon, pins, notes: notes.map(note => [note.path, note.revision]).sort((a,b) => a[0].localeCompare(b[0]))}));
  const deleteBlockedReason = id === 'global'
    ? 'The general workspace cannot be deleted.'
    : id === 'personal'
      ? 'The personal workspace cannot be deleted.'
      : notes.map(note => protectedDeletionReason(note.path)).find(Boolean) || null;
  return {id, name, group, icon, pins, revision, noteCount: notes.length, isSystem: !project || id === 'personal', deleteBlockedReason, ...(project ? {root: project.root, ...(project.additionalRoots ? {additionalRoots: project.additionalRoots} : {})} : {})};
}
export async function workspaceDetail(config, id) { await refresh(config); return detail(config, id); }
async function writeIcons(config, assignments) {
  await validateWorkspaceIcons(assignments);
  const {revision} = await readWorkspaceIcons(config);
  await commitMarkdown(config, await prepareMarkdown(config, WORKSPACE_ICONS_PATH, serializeWorkspaceIcons(assignments), revision));
}
export async function updateWorkspace(config, {id, name, icon, group, pins, expectedRevision}) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\r\n\0]/.test(name)) throw new Error('Workspace name must be 1-120 characters on one line.');
  if (id === 'personal') {
    if (group !== undefined && !['personal', 'work', 'home'].includes(group)) throw new Error('Invalid workspace group.');
  } else if (!['home', 'work'].includes(group)) {
    throw new Error('Workspace group must be home or work.');
  }
  if (icon !== null && (typeof icon !== 'string' || !icon)) throw new Error('Choose a canonical icon or null.');
  return locked(config, async () => {
    const {raw, revision} = await refresh(config), current = await detail(config, id);
    if (current.revision !== expectedRevision) throw conflict('Workspace changed; reload before saving.');
    if (pins !== undefined) {
      if (!Array.isArray(pins) || pins.length > 100 || pins.some(pin => typeof pin !== 'string') || new Set(pins).size !== pins.length) throw new Error('Supply up to 100 unique note paths.');
      const allowed = new Set(selectNotes(config, id, await catalog(config)).map(note => note.path));
      if (pins.some(pin => !current.pins.includes(pin) && !allowed.has(pin))) throw new Error('New pins must belong to this workspace.');
      raw.workspacePins ||= {};
      if (pins.length) raw.workspacePins[id] = pins; else delete raw.workspacePins[id];
    }
    const {assignments} = await readWorkspaceIcons(config), next = {...assignments};
    if (icon === null) delete next[id]; else next[id] = icon;
    await validateWorkspaceIcons(next);
    const project = raw.projects?.find(item => item.id === id);
    if (project) project.name = name.trim(); else { raw.workspaceNames ||= {}; raw.workspaceNames[id] = name.trim(); }
    raw.workspaceGroups ||= {};
    if (id === 'personal') delete raw.workspaceGroups[id];
    else if (group === 'home') raw.workspaceGroups[id] = 'home';
    else delete raw.workspaceGroups[id];
    const iconChanged = current.icon !== icon;
    if (iconChanged) await writeIcons(config, next);
    try { await saveConfig(config, raw, revision); } catch (error) { if (iconChanged) await writeIcons(config, assignments); throw error; }
    return detail(config, id);
  });
}
async function trashDir(config, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id || '')) throw new Error('Invalid trash ID.');
  return safePath(config.vault, `.trash/axiom/${id}`, true, true);
}
async function move(source, target) {
  await fs.mkdir(path.dirname(target), {recursive: true});
  // Exclusive hard-link publication exposes complete bytes even if the process
  // dies before unlinking the source. Trash and notes share the vault volume.
  try { await fs.link(source, target); }
  catch (error) {
    if (error.code === 'EEXIST') throw conflict('A destination already exists.');
    if (['EXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) throw new Error(`Cannot safely move notes: exclusive hard links are unavailable (${error.code}).`, {cause: error});
    throw error;
  }
  try { await fs.unlink(source); } catch (error) { await fs.unlink(target); throw error; }
}
async function checkpoint(dir, manifest, state) {
  const updated = {...manifest, state};
  const temp = path.join(dir, `manifest-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, crlf(JSON.stringify(updated, null, 2) + '\n'), {flag: 'wx'});
    await fs.rename(temp, path.join(dir, 'manifest.json'));
    manifest.state = state;
  } finally { await fs.rm(temp, {force: true}); }
}
async function trash(config, type, name, notes, workspace) {
  for (const note of notes) {
    if (protectedDeletionReason(note.path)) throw new Error(protectedDeletionReason(note.path));
    if ((await readRawNote(config, note.path)).revision !== note.revision) throw conflict('A note changed; reload before deleting.');
  }
  const id = randomUUID(), dir = await trashDir(config, id), moved = [];
  const manifest = {version: 1, id, type, name, deletedAt: new Date().toISOString(), noteCount: notes.length, notes: notes.map(({path, revision}) => ({path, revision})), workspace, state: 'deleting'};
  await fs.mkdir(dir, {recursive: true});
  try {
    await fs.writeFile(path.join(dir, 'manifest.json'), crlf(JSON.stringify(manifest, null, 2) + '\n'), {flag: 'wx'});
    for (let i = 0; i < notes.length; i++) { await move(await safePath(config.vault, notes[i].path), path.join(dir, `${i}.md`)); moved.push(i); }
    if (type === 'note') await checkpoint(dir, manifest, 'complete');
    return manifest;
  } catch (error) {
    for (const i of moved.reverse()) await move(path.join(dir, `${i}.md`), await safePath(config.vault, notes[i].path, true));
    await fs.rm(dir, {recursive: true, force: true});
    throw error;
  }
}
export async function deleteNote(config, relative, expectedRevision) {
  return locked(config, async () => {
    if (protectedDeletionReason(relative)) throw new Error(protectedDeletionReason(relative));
    const note = await readRawNote(config, relative);
    if (note.revision !== expectedRevision) throw conflict('Note changed; reload before deleting.');
    return trash(config, 'note', note.title, [note]);
  });
}
export async function deleteWorkspace(config, id, expectedRevision) {
  return locked(config, async () => {
    const {raw, revision} = await refresh(config), current = await detail(config, id);
    if (current.revision !== expectedRevision) throw conflict('Workspace changed; reload before deleting.');
    if (current.deleteBlockedReason) throw new Error(current.deleteBlockedReason);
    await backupUnlocked(config);
    if ((await detail(config, id)).revision !== expectedRevision) throw conflict('Workspace changed during snapshot; reload before deleting.');
    const notes = selectNotes(config, id, await catalog(config));
    for (const note of notes) await safePath(config.vault, note.path);
    const {assignments} = await readWorkspaceIcons(config);
    const project = raw.projects?.find(item => item.id === id) || null;
    const workspace = {id, project, name: Object.hasOwn(raw.workspaceNames || {}, id) ? raw.workspaceNames[id] : undefined, group: current.group, icon: Object.hasOwn(assignments, id) ? assignments[id] : null, pins: current.pins};
    const manifest = await trash(config, 'workspace', current.name, notes, workspace);
    const next = {...assignments}; delete next[id];
    try {
      if (project) raw.projects = raw.projects.filter(item => item.id !== id);
      if (raw.workspaceNames) delete raw.workspaceNames[id];
      if (raw.workspaceGroups) delete raw.workspaceGroups[id];
      if (raw.workspacePins) delete raw.workspacePins[id];
      await writeIcons(config, next);
      try { await saveConfig(config, raw, revision); } catch (error) { await writeIcons(config, assignments); throw error; }
    } catch (error) { await restoreUnlocked(config, manifest.id, false); throw error; }
    await checkpoint(await trashDir(config, manifest.id), manifest, 'complete');
    return manifest;
  });
}
async function readManifest(config, id) {
  const dir = await trashDir(config, id);
  const manifest = JSON.parse(await fs.readFile(await safePath(config.vault, `.trash/axiom/${id}/manifest.json`, false, true), 'utf8'));
  if (manifest.version !== 1 || manifest.id !== id || !['note', 'workspace'].includes(manifest.type) || typeof manifest.name !== 'string' || !Number.isFinite(Date.parse(manifest.deletedAt)) || !Array.isArray(manifest.notes) || manifest.noteCount !== manifest.notes.length || (manifest.type === 'note' && manifest.notes.length !== 1)) throw new Error('Invalid trash manifest.');
  if (manifest.state !== undefined && !['deleting', 'complete', 'restoring'].includes(manifest.state)) throw new Error('Invalid trash operation state.');
  const paths = new Set();
  for (const note of manifest.notes) {
    if (typeof note.path !== 'string' || !/\.md$/i.test(note.path) || !/^[a-f0-9]{64}$/.test(note.revision) || paths.has(note.path.toLowerCase())) throw new Error('Invalid trash note record.');
    await safePath(config.vault, note.path, true);
    paths.add(note.path.toLowerCase());
  }
  if (manifest.type === 'workspace') {
    const workspace = manifest.workspace, project = workspace?.project;
    if (!workspace || workspace.id === 'global' || workspace.id === 'personal' || !/^(?:__unmapped|[a-z0-9][a-z0-9-]*)$/.test(workspace.id) || !['home', 'work'].includes(workspace.group) || (workspace.name !== undefined && typeof workspace.name !== 'string')) throw new Error('Invalid trash workspace record.');
    if (project && (project.id !== workspace.id || !path.isAbsolute(project.root || '') || (project.additionalRoots !== undefined && (!Array.isArray(project.additionalRoots) || project.additionalRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)))))) throw new Error('Invalid trash workspace roots.');
    if (!project && workspace.id !== '__unmapped') throw new Error('Missing trash workspace mapping.');
  }
  return {dir, manifest};
}
export async function listTrash(config) {
  const root = await safePath(config.vault, '.trash/axiom', true, true);
  let entries;
  try { entries = await fs.readdir(root, {withFileTypes: true}); } catch (error) { if (missing(error)) return {items: []}; throw error; }
  const items = [];
  for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) {
    const {manifest} = await readManifest(config, entry.name);
    let recovery = manifest.state === 'deleting' || manifest.state === 'restoring' ? manifest.state : null;
    if (manifest.state === undefined && manifest.type === 'workspace') {
      let atTarget = false, atTrash = false;
      for (let i = 0; i < manifest.notes.length; i++) {
        const exists = async file => { try { await fs.lstat(file); return true; } catch (error) { if (missing(error)) return false; throw error; } };
        const target = await safePath(config.vault, manifest.notes[i].path, true);
        const source = await safePath(config.vault, `.trash/axiom/${entry.name}/${i}.md`, true, true);
        if (await exists(target) && !(await exists(source))) atTarget = true;
        if (await exists(source) && !(await exists(target))) atTrash = true;
      }
      if (atTarget && atTrash) recovery = 'legacy';
    }
    items.push({id: manifest.id, type: manifest.type, name: manifest.name, deletedAt: manifest.deletedAt, noteCount: manifest.noteCount, recovery});
  }
  return {items: items.sort ( (a,b) => b.deletedAt.localeCompare(a.deletedAt))};
}
async function restoreUnlocked(config, id, restoreWorkspace = true) {
  const {dir, manifest} = await readManifest(config, id), {raw, revision} = await refresh(config);
  const locations = [];
  for (let i = 0; i < manifest.notes.length; i++) {
    const note = manifest.notes[i];
    if (protectedDeletionReason(note.path)) throw new Error('Protected notes cannot be restored from trash.');
    const target = await safePath(config.vault, note.path, true);
    const source = await safePath(config.vault, `.trash/axiom/${id}/${i}.md`, true, true);
    const read = async file => {
      try { return hash(await fs.readFile(file, 'utf8')); }
      catch (error) { if (missing(error)) return null; throw error; }
    };
    locations.push({target, source, targetHash: await read(target), sourceHash: await read(source), note});
  }
  const workspace = manifest.workspace;
  let assignments, next, mappingPresent = false;
  if (manifest.type === 'workspace') {
    ({assignments} = await readWorkspaceIcons(config));
    mappingPresent = !!workspace.project && !!raw.projects?.some(project => project.id === workspace.id);
  }
  // Old manifests have no checkpoint. Only a split workspace with its original
  // mapping is recognizable as a legacy interrupted deletion.
  const legacySplit = manifest.state === undefined && manifest.type === 'workspace' && mappingPresent &&
    locations.some(item => item.targetHash && !item.sourceHash) && locations.some(item => item.sourceHash && !item.targetHash) &&
    locations.every(item => !item.targetHash || !item.sourceHash);
  const recovering = !restoreWorkspace || manifest.state === 'deleting' || manifest.state === 'restoring' || legacySplit;
  for (const item of locations) {
    if (item.targetHash && !recovering) throw conflict(`Restore target already exists: ${item.note.path}`);
    if ((item.targetHash && item.targetHash !== item.note.revision) || (item.sourceHash && item.sourceHash !== item.note.revision)) throw conflict(`Content changed; reconcile ${item.note.path} before restoring.`);
    if (!item.targetHash && !item.sourceHash) throw conflict(`Both copies are missing: ${item.note.path}`);
  }
  if (restoreWorkspace && manifest.type === 'workspace') {
    const currentProject = raw.projects?.find(project => project.id === workspace.id);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const metadataPresent = Object.hasOwn(raw.workspaceNames || {}, workspace.id) || Object.hasOwn(raw.workspaceGroups || {}, workspace.id) || Object.hasOwn(raw.workspacePins || {}, workspace.id);
    if (currentProject || metadataPresent) {
      if (!recovering || !same(currentProject || null, workspace.project || null) ||
          !same(raw.workspaceNames?.[workspace.id], workspace.name) ||
          (raw.workspaceGroups?.[workspace.id] || 'work') !== workspace.group ||
          !same(raw.workspacePins?.[workspace.id] || [], workspace.pins || [])) throw conflict('Workspace mapping or metadata changed; reconcile before restoring.');
    }
    const rootKey = root => {
      const resolved = path.resolve(root);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    const roots = new Set(workspace.project ? [workspace.project.root, ...(workspace.project.additionalRoots || [])].map(rootKey) : []);
    for (const project of raw.projects || []) {
      if (project.id === workspace.id && recovering && same(project, workspace.project)) continue;
      if ([project.root, ...(project.additionalRoots || [])].some(root => roots.has(rootKey(root)))) throw conflict('Workspace root is already assigned; reconcile before restoring.');
    }
    next = {...assignments};
    const existingIcon = next[workspace.id] || null;
    if (legacySplit && existingIcon !== (workspace.icon || null)) throw conflict('Workspace icon changed; reconcile before restoring.');
    if (existingIcon && (!recovering || existingIcon !== workspace.icon)) throw conflict('Workspace icon is already in use.');
    if (workspace.icon) {
      if (Object.entries(next).some(([key, icon]) => key !== workspace.id && icon === workspace.icon)) throw conflict('Workspace icon is already assigned.');
      next[workspace.id] = workspace.icon;
    }
    await validateWorkspaceIcons(next);
    if (workspace.project && !currentProject) (raw.projects ||= []).push(workspace.project);
    if (workspace.name !== undefined) { raw.workspaceNames ||= {}; raw.workspaceNames[workspace.id] = workspace.name; }
    if (workspace.group === 'home') { raw.workspaceGroups ||= {}; raw.workspaceGroups[workspace.id] = 'home'; }
    if (Array.isArray(workspace.pins) && workspace.pins.length) { raw.workspacePins ||= {}; raw.workspacePins[workspace.id] = workspace.pins; }
  }
  const previousState = manifest.state, moved = [];
  await checkpoint(dir, manifest, 'restoring');
  try {
    for (const item of locations) {
      if (!item.targetHash) {
        if (hash(await fs.readFile(item.source, 'utf8')) !== item.note.revision) throw conflict(`Content changed; reconcile ${item.note.path} before restoring.`);
        await move(item.source, item.target);
        moved.push(item);
      } else if (item.sourceHash && (hash(await fs.readFile(item.target, 'utf8')) !== item.note.revision || hash(await fs.readFile(item.source, 'utf8')) !== item.note.revision)) {
        throw conflict(`Content changed; reconcile ${item.note.path} before restoring.`);
      }
    }
    if (next) {
      await writeIcons(config, next);
      try { await saveConfig(config, raw, revision); } catch (error) { await writeIcons(config, assignments); throw error; }
    }
  } catch (error) {
    for (const item of moved.reverse()) {
      if (hash(await fs.readFile(item.target, 'utf8')) !== item.note.revision) throw conflict(`Content changed during rollback; reconcile ${item.note.path}.`);
      await move(item.target, item.source);
    }
    await checkpoint(dir, manifest, previousState);
    throw error;
  }
  await fs.rm(dir, {recursive: true, force: true});
  return {id, restored: true};
}
export async function restoreTrash(config, id) { return locked(config, () => restoreUnlocked(config, id)); }
