import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeNote, readNote, saveFromEditor, backup, restore} from '../src/memory.mjs';
import {WORKSPACE_ICONS_PATH, readWorkspaceIcons, searchWorkspaceIcons, serializeWorkspaceIcons} from '../src/workspace-icons.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-icons-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const config = {vault:path.join(root,'vault'), backupDir:path.join(root,'backups'), projects:[{id:'alpha',root:path.join(root,'alpha')},{id:'beta',root:path.join(root,'beta')}]};
  await fs.mkdir(config.vault);
  return {root, config};
}

test('first note requires a unique icon and subsequent writes retain it', async t => {
  const {config} = await fixture(t);
  assert.deepEqual(await readWorkspaceIcons(config), {assignments:{}, revision:'new'});
  const target = 'Agents/Memory/Projects/alpha/first.md';
  await assert.rejects(writeNote(config,target,'# First','new'), /needs an icon/);
  await assert.rejects(readNote(config,target), {code:'ENOENT'});
  const note = await writeNote(config,target,'# First','new','boxes');
  assert.equal((await readWorkspaceIcons(config)).assignments.alpha, 'boxes');
  await writeNote(config,target,'# Updated',note.revision);
  await assert.rejects(writeNote(config,'Agents/Memory/Projects/alpha/second.md','# Second','new','anvil'), /cannot reassign/);
  await assert.rejects(writeNote(config,'Agents/Memory/Projects/beta/first.md','# First','new','boxes'), /more than one workspace/);
  await assert.rejects(writeNote(config,'Agents/Memory/Projects/beta/first.md','# First','new','alarm-check'), /non-canonical/);
  await assert.rejects(writeNote(config,'Agents/Memory/Projects/beta/first.md','# First','new','not-a-real-icon'), /non-canonical/);
  await writeNote(config,'Agents/Memory/unknown.md','---\nproject: unknown\n---\n# Unknown','new','folder-search');
  await writeNote(config,'Agents/Memory/general.md','# General','new','library');
  assert.deepEqual((await readWorkspaceIcons(config)).assignments, {alpha:'boxes',__unmapped:'folder-search',global:'library'});
  const result = await searchWorkspaceIcons(config,'box',1);
  assert.equal(result.candidates.includes('boxes'),false);
  assert.equal(result.candidates.length,1);
});

test('registry edits use CAS, validate human and agent writes, and preserve history', async t => {
  const {config} = await fixture(t);
  const first = await writeNote(config,WORKSPACE_ICONS_PATH,serializeWorkspaceIcons({global:'library'}),'new');
  const second = await saveFromEditor(config,WORKSPACE_ICONS_PATH,serializeWorkspaceIcons({global:'library',alpha:'boxes'}),first.revision);
  await assert.rejects(writeNote(config,WORKSPACE_ICONS_PATH,serializeWorkspaceIcons({global:'library',beta:'anvil'}),first.revision),/Revision conflict/);
  await assert.rejects(saveFromEditor(config,WORKSPACE_ICONS_PATH,serializeWorkspaceIcons({global:'library',alpha:'library'}),second.revision),/more than one workspace/);
  await assert.rejects(saveFromEditor(config,WORKSPACE_ICONS_PATH,serializeWorkspaceIcons({global:'alarm-check'}),second.revision),/non-canonical/);
  await assert.rejects(saveFromEditor(config,WORKSPACE_ICONS_PATH,'# broken',second.revision),/status: current/);
  assert.equal((await readNote(config,WORKSPACE_ICONS_PATH)).revision,second.revision);
  const histories = await fs.readdir(path.join(config.backupDir,'history'));
  assert.equal(histories.length,1);
  const saved = await backup(config);
  const restored = path.join(path.dirname(config.vault),'restored');
  await restore(config,saved.snapshot,restored);
  assert.equal(await fs.readFile(path.join(restored,'Agents','Workspace icons.md'),'utf8'),second.content);
});

test('competing first writes cannot claim the same icon and a retained assignment permits retry', async t => {
  const {config} = await fixture(t);
  const targets = ['Agents/Memory/Projects/alpha/a.md','Agents/Memory/Projects/beta/b.md'];
  const attempts = await Promise.allSettled(targets.map(target => writeNote(config,target,'# First','new','boxes')));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length,1);
  const winner = attempts.findIndex(result => result.status === 'fulfilled');
  const loser = 1-winner;
  await assert.rejects(writeNote(config,targets[loser],'# First','new','boxes'),/more than one workspace/);
  const assignments = (await readWorkspaceIcons(config)).assignments;
  const workspace = winner === 0 ? 'alpha' : 'beta';
  assert.equal(assignments[workspace], 'boxes');
  await writeNote(config,targets[winner].replace(/\/[^/]+$/, '/retry.md'),'# Retry','new');
  await writeNote(config,targets[loser],'# Retry','new','anvil');
});

test('a failed note replacement leaves its assignment available for recovery', async t => {
  const {root, config} = await fixture(t);
  const relative = 'Agents/Memory/Projects/alpha/existing.md';
  const full = path.join(config.vault, ...relative.split('/'));
  await fs.mkdir(path.dirname(full), {recursive:true});
  await fs.writeFile(full, '# Original\r\n');
  const original = await readNote(config, relative);
  await fs.writeFile(config.backupDir, 'blocks history directory');
  await assert.rejects(writeNote(config,relative,'# Updated',original.revision,'boxes'));
  assert.equal((await readNote(config,relative)).revision,original.revision);
  assert.equal((await readWorkspaceIcons(config)).assignments.alpha,'boxes');
  await fs.unlink(config.backupDir);
  await writeNote(config,relative,'# Updated',original.revision);
  assert.match((await readNote(config,relative)).content,/# Updated/);
});

test('a workspace name matching an object prototype still requires an icon', async t => {
  const {config, root} = await fixture(t);
  config.projects.push({id:'constructor', root:path.join(root,'constructor')});
  const target = 'Agents/Memory/Projects/constructor/first.md';
  await assert.rejects(writeNote(config,target,'# First','new'), /needs an icon/);
  await writeNote(config,target,'# First','new','factory');
  assert.equal((await readWorkspaceIcons(config)).assignments.constructor,'factory');
});
