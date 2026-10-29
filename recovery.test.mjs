import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {loadConfig, saveFromEditor, readNote} from './memory.mjs';
import {getRecoveryStatus, createRecoverySnapshot, checkRecoverySnapshot} from './recovery.mjs';
import {workspaceDetail, updateWorkspace, deleteWorkspace, restoreTrash} from './management.mjs';
import {createServer} from './server.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-recovery-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const vault = path.join(root, 'vault'), configPath = path.join(root, 'config.json');
  await fs.mkdir(vault);
  await fs.writeFile(configPath, JSON.stringify({vault, backupDir: path.join(root, 'backup'), projects: [{id: 'alpha', root: path.join(root, 'alpha')}, {id: 'beta', root: path.join(root, 'beta')}]}));
  const config = await loadConfig(configPath);
  await saveFromEditor(config, 'Owner/Policies.md', '# Policies\r\nProtect owner notes.\r\n', 'new');
  await saveFromEditor(config, 'Owner/Preferences.md', '# Preferences\r\nKeep sources.\r\n', 'new');
  return config;
}

test('restore checks verify copied files and policies, retain the live vault, and record checksum failures', async t => {
  const config = await fixture(t);
  const original = await readNote(config, 'Owner/Policies.md');
  const snapshot = await createRecoverySnapshot(config);
  const check = await checkRecoverySnapshot(config, snapshot.id);
  assert.equal(check.success, true);
  assert.equal(check.policiesLoaded, true);
  assert.equal(check.workspaceSettingsVerified, true);
  assert.equal(check.files, snapshot.files);
  assert.equal((await readNote(config, original.path)).revision, original.revision);
  assert.deepEqual(await fs.readdir(path.join(path.dirname(config.backupDir), 'backup-restore-checks')), []);
  await fs.writeFile(path.join(config.backupDir, 'snapshots', snapshot.id, 'vault', 'Owner', 'Policies.md'), 'Corrupted backup');
  const failed = await checkRecoverySnapshot(config, snapshot.id);
  assert.equal(failed.success, false);
  assert.match(failed.error, /checksum mismatch/i);
  const status = await getRecoveryStatus(config);
  assert.equal(status.offMachine, false);
  assert.equal(status.checks[0].success, false);
  assert.equal((await readNote(config, original.path)).revision, original.revision);
});

test('restore checks do not qualify a snapshot lacking required owner policies', async t => {
  const config = await fixture(t);
  await fs.unlink(path.join(config.vault, 'Owner', 'Preferences.md'));
  const snapshot = await createRecoverySnapshot(config);
  const result = await checkRecoverySnapshot(config, snapshot.id);
  assert.equal(result.success, false);
  assert.match(result.error, /ENOENT|Preferences/i);
  assert.equal((await getRecoveryStatus(config)).checks[0].success, false);
});

test('workspace pins are scoped, revision checked, and survive workspace Trash restoration', async t => {
  const config = await fixture(t), alpha = 'Owner/Projects/alpha.md', beta = 'Owner/Projects/beta.md';
  await saveFromEditor(config, alpha, '# Alpha\r\n', 'new');
  await saveFromEditor(config, beta, '# Beta\r\n', 'new');
  const detail = await workspaceDetail(config, 'alpha');
  const pinned = await updateWorkspace(config, {...detail, pins: [alpha], expectedRevision: detail.revision});
  assert.deepEqual(pinned.pins, [alpha]);
  await assert.rejects(updateWorkspace(config, {...pinned, pins: [], expectedRevision: detail.revision}), {status: 409});
  await assert.rejects(updateWorkspace(config, {...pinned, pins: [beta], expectedRevision: pinned.revision}), /belong to this workspace/);
  const snapshot = await createRecoverySnapshot(config);
  const settingsFile = path.join(config.backupDir, 'snapshots', snapshot.id, 'workspace-settings.json');
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')).workspacePins.alpha, [alpha]);
  await fs.writeFile(settingsFile, '{}');
  const corruptedSettings = await checkRecoverySnapshot(config, snapshot.id);
  assert.equal(corruptedSettings.success, false);
  assert.match(corruptedSettings.error, /checksum mismatch: workspace settings/);
  const item = await deleteWorkspace(config, 'alpha', pinned.revision);
  assert.equal((await loadConfig(config.configPath)).workspacePins?.alpha, undefined);
  await restoreTrash(config, item.id);
  assert.deepEqual((await workspaceDetail(config, 'alpha')).pins, [alpha]);
  assert.equal((await readNote(config, alpha)).content, '# Alpha\r\n');
});

test('recovery mutations reject missing CSRF and foreign origins', async t => {
  const config = await fixture(t), server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${config.port}`;
  for (const endpoint of ['backup', 'check']) {
    const response = await fetch(`${base}/api/recovery/${endpoint}`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: base}, body: '{}'});
    assert.equal(response.status, 403);
  }
  const {token} = await fetch(base + '/api/editor-session').then(response => response.json());
  const rejected = await fetch(base + '/api/recovery/backup', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://foreign.invalid', 'X-Shared-Brain-CSRF': token}, body: '{}'});
  assert.equal(rejected.status, 403);
});
