import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig, readNote, saveFromEditor} from './memory.mjs';
import {readWorkspaceIcons} from './workspace-icons.mjs';
import {workspaceDetail, updateWorkspace, deleteNote, deleteWorkspace, listTrash, restoreTrash} from './management.mjs';
import {createServer} from './server.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-management-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const configPath = path.join(root, 'config.json');
  await fs.mkdir(path.join(root, 'vault'));
  await fs.writeFile(configPath, JSON.stringify({vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup'), projects: [{id: 'alpha', root: path.join(root, 'alpha')}, {id: 'beta', root: path.join(root, 'beta')}], unrelated: {keep: true}}));
  return loadConfig(configPath);
}
const notePath = 'Agents/Memory/Projects/alpha/test.md';

test('workspace metadata persists, defaults work, validates icon uniqueness and revisions', async t => {
  const config = await fixture(t);
  const first = await workspaceDetail(config, 'alpha');
  assert.equal(first.group, 'work');
  const updated = await updateWorkspace(config, {...first, name: 'Alpha renamed', group: 'home', icon: 'boxes', expectedRevision: first.revision});
  assert.equal(updated.group, 'home');
  assert.equal(updated.root, first.root);
  assert.equal((await loadConfig(config.configPath)).workspaceGroups.alpha, 'home');
  assert.deepEqual(JSON.parse(await fs.readFile(config.configPath, 'utf8')).unrelated, {keep: true});
  await assert.rejects(updateWorkspace(config, {...updated, expectedRevision: first.revision}), {status: 409});
  const beta = await workspaceDetail(config, 'beta');
  await assert.rejects(updateWorkspace(config, {...beta, icon: 'boxes', expectedRevision: beta.revision}), /more than one workspace/);
  await saveFromEditor(config, notePath, '# New note', 'new');
  await assert.rejects(deleteWorkspace(config, 'alpha', updated.revision), {status: 409});
});

test('notes and workspaces restore exact bytes, protect controls and reject collisions', async t => {
  const config = await fixture(t);
  const bytes = '# Original\r\n\r\nText\r\n';
  const note = await saveFromEditor(config, notePath, bytes, 'new');
  await assert.rejects(deleteNote(config, notePath, 'bad'), {status: 409});
  for (const protectedPath of ['owner/policies.md', 'OWNER/Preferences.md', 'Owner/Reviews.md', 'agents/workspace icons.md']) await assert.rejects(deleteNote(config, protectedPath, note.revision), /cannot be deleted/);
  const deleted = await deleteNote(config, notePath, note.revision);
  assert.equal((await listTrash(config)).items[0].id, deleted.id);
  await saveFromEditor(config, notePath, '# Collision', 'new');
  await assert.rejects(restoreTrash(config, deleted.id), {status: 409});
  const collision = await readNote(config, notePath);
  await deleteNote(config, notePath, collision.revision);
  await restoreTrash(config, deleted.id);
  assert.equal(await fs.readFile(path.join(config.vault, ...notePath.split('/')), 'utf8'), bytes);
  let alpha = await workspaceDetail(config, 'alpha');
  alpha = await updateWorkspace(config, {...alpha, name: 'Alpha', group: 'home', icon: 'boxes', expectedRevision: alpha.revision});
  const bulk = await deleteWorkspace(config, 'alpha', alpha.revision);
  assert.equal(bulk.noteCount, 1);
  assert.equal((await readWorkspaceIcons(config)).assignments.alpha, undefined);
  await restoreTrash(config, bulk.id);
  assert.equal((await workspaceDetail(config, 'alpha')).group, 'home');
  assert.equal((await readWorkspaceIcons(config)).assignments.alpha, 'boxes');
  assert.equal(await fs.readFile(path.join(config.vault, ...notePath.split('/')), 'utf8'), bytes);
  const global = await workspaceDetail(config, 'global');
  await assert.rejects(deleteWorkspace(config, 'global', global.revision), /cannot be deleted/);
});

test('workspace restore refuses an icon claimed after deletion', async t => {
  const config = await fixture(t);
  let alpha = await workspaceDetail(config, 'alpha');
  alpha = await updateWorkspace(config, {...alpha, name: 'Alpha', group: 'home', icon: 'boxes', expectedRevision: alpha.revision});
  const deleted = await deleteWorkspace(config, 'alpha', alpha.revision);
  const beta = await workspaceDetail(config, 'beta');
  await updateWorkspace(config, {...beta, icon: 'boxes', expectedRevision: beta.revision});
  await assert.rejects(restoreTrash(config, deleted.id), {status: 409});
  assert.ok((await listTrash(config)).items.some(item => item.id === deleted.id));
});


test('bulk deletion rolls notes back when registry history cannot be written', async t => {
  const config = await fixture(t);
  await saveFromEditor(config, notePath, '# Preserved', 'new');
  let alpha = await workspaceDetail(config, 'alpha');
  alpha = await updateWorkspace(config, {...alpha, icon: 'boxes', expectedRevision: alpha.revision});
  const history = path.join(config.backupDir, 'history');
  await fs.rename(history, `${history}-saved`);
  await fs.writeFile(history, 'block history');
  await assert.rejects(deleteWorkspace(config, 'alpha', alpha.revision));
  assert.match((await readNote(config, notePath)).content, /Preserved/);
  assert.equal((await workspaceDetail(config, 'alpha')).icon, 'boxes');
  assert.equal((await listTrash(config)).items.length, 0);
});
test('management mutations require same-origin CSRF and JSON', async t => {
  const config = await fixture(t);
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  config.port = server.address().port;
  const base = `http://127.0.0.1:${config.port}`;
  const {token} = await (await fetch(`${base}/api/editor-session`)).json();
  const body = JSON.stringify({path: notePath, expectedRevision: 'bad'});
  assert.equal((await fetch(`${base}/api/note`, {method: 'DELETE', headers: {'content-type': 'application/json'}, body})).status, 403);
  assert.equal((await fetch(`${base}/api/note`, {method: 'DELETE', headers: {origin: base, 'content-type': 'application/json', 'x-shared-brain-csrf': token}, body})).status, 400);
  assert.equal((await fetch(`${base}/api/note`, {method: 'DELETE', headers: {origin: base, 'content-type': 'text/plain', 'x-shared-brain-csrf': token}, body})).status, 415);
  assert.equal((await fetch(`${base}/api/note`, {method: 'DELETE', headers: {origin: 'http://evil.example', 'content-type': 'application/json', 'x-shared-brain-csrf': token}, body})).status, 403);
});

test('interrupted workspace moves reconcile unchanged copies and reject newer bytes', async t => {
  const config = await fixture(t);
  const second = 'Agents/Memory/Projects/alpha/second.md';
  await saveFromEditor(config, notePath, '# First', 'new');
  await saveFromEditor(config, second, '# Second', 'new');
  let alpha = await workspaceDetail(config, 'alpha');
  alpha = await updateWorkspace(config, {...alpha, name: 'Alpha', group: 'home', icon: 'boxes', pins: [notePath], expectedRevision: alpha.revision});
  const originalConfig = await fs.readFile(config.configPath);
  const deleted = await deleteWorkspace(config, 'alpha', alpha.revision);
  const dir = path.join(config.vault, '.trash', 'axiom', deleted.id);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const firstIndex = manifest.notes.findIndex(note => note.path === notePath);
  const target = path.join(config.vault, ...notePath.split('/'));
  await fs.copyFile(path.join(dir, `${firstIndex}.md`), target);
  await fs.writeFile(config.configPath, originalConfig);
  manifest.state = 'deleting';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await listTrash(config)).items.find(item => item.id === deleted.id).recovery, 'deleting');
  await fs.writeFile(target, '# Newer');
  await assert.rejects(restoreTrash(config, deleted.id), {status: 409});
  assert.equal(await fs.readFile(target, 'utf8'), '# Newer');
  await fs.copyFile(path.join(dir, `${firstIndex}.md`), target);
  await restoreTrash(config, deleted.id);
  const restored = await workspaceDetail(config, 'alpha');
  assert.equal(restored.name, 'Alpha');
  assert.equal(restored.group, 'home');
  assert.equal(restored.icon, 'boxes');
  assert.deepEqual(restored.pins, [notePath]);
  assert.match((await readNote(config, second)).content, /Second/);
});

test('interrupted restore resumes and completed Trash still refuses same-byte collisions', async t => {
  const config = await fixture(t);
  await saveFromEditor(config, notePath, '# First', 'new');
  const second = 'Agents/Memory/Projects/alpha/second.md';
  await saveFromEditor(config, second, '# Second', 'new');
  const alpha = await workspaceDetail(config, 'alpha');
  const deleted = await deleteWorkspace(config, 'alpha', alpha.revision);
  const dir = path.join(config.vault, '.trash', 'axiom', deleted.id);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const target = path.join(config.vault, ...notePath.split('/'));
  const firstIndex = manifest.notes.findIndex(note => note.path === notePath);
  const secondIndex = manifest.notes.findIndex(note => note.path === second);
  await fs.link(path.join(dir, `${firstIndex}.md`), target);
  await assert.rejects(restoreTrash(config, deleted.id), {status: 409});
  manifest.state = 'restoring';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.rename(path.join(dir, `${secondIndex}.md`), path.join(config.vault, ...second.split('/')));
  await restoreTrash(config, deleted.id);
  assert.match((await readNote(config, notePath)).content, /First/);
  assert.match((await readNote(config, second)).content, /Second/);
  assert.equal((await workspaceDetail(config, 'alpha')).id, 'alpha');
});

test('workspace restore rejects primary and additional root collisions before changing anything', async t => {
  for (const kind of ['primary', 'additional']) {
    await t.test(kind, async t => {
      const config = await fixture(t);
      await saveFromEditor(config, notePath, '# Preserved', 'new');
      const raw = JSON.parse(await fs.readFile(config.configPath, 'utf8'));
      raw.projects[0].additionalRoots = [path.join(path.dirname(raw.projects[0].root), 'extra')];
      await fs.writeFile(config.configPath, JSON.stringify(raw));
      const alpha = await workspaceDetail(config, 'alpha');
      const deleted = await deleteWorkspace(config, 'alpha', alpha.revision);
      const changed = JSON.parse(await fs.readFile(config.configPath, 'utf8'));
      changed.projects[0].additionalRoots = [kind === 'primary' ? raw.projects[0].root : raw.projects[0].additionalRoots[0]];
      await fs.writeFile(config.configPath, JSON.stringify(changed));
      const before = await fs.readFile(config.configPath);
      await assert.rejects(restoreTrash(config, deleted.id), {status: 409});
      assert.deepEqual(await fs.readFile(config.configPath), before);
      await assert.rejects(fs.stat(path.join(config.vault, ...notePath.split('/'))), {code: 'ENOENT'});
      assert.ok((await listTrash(config)).items.some(item => item.id === deleted.id));
    });
  }
});

test('legacy split workspace requires the unchanged mapping before reconciliation', async t => {
  const config = await fixture(t);
  const second = 'Agents/Memory/Projects/alpha/second.md';
  await saveFromEditor(config, notePath, '# First', 'new');
  await saveFromEditor(config, second, '# Second', 'new');
  const original = JSON.parse(await fs.readFile(config.configPath, 'utf8'));
  const alpha = await workspaceDetail(config, 'alpha');
  const deleted = await deleteWorkspace(config, 'alpha', alpha.revision);
  const dir = path.join(config.vault, '.trash', 'axiom', deleted.id);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  delete manifest.state;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const index = manifest.notes.findIndex(note => note.path === notePath);
  await fs.rename(path.join(dir, `${index}.md`), path.join(config.vault, ...notePath.split('/')));
  original.projects[0].root += '-changed';
  await fs.writeFile(config.configPath, JSON.stringify(original));
  assert.equal((await listTrash(config)).items.find(item => item.id === deleted.id).recovery, 'legacy');
  await assert.rejects(restoreTrash(config, deleted.id), {status: 409});
  original.projects[0].root = original.projects[0].root.slice(0, -'-changed'.length);
  await fs.writeFile(config.configPath, JSON.stringify(original));
  await restoreTrash(config, deleted.id);
  assert.match((await readNote(config, second)).content, /Second/);
});
