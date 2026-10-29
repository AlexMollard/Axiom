import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {backup, restore, policies, locked, safePath, hash, crlf} from './memory.mjs';

const snapshotId = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-f0-9]{8}$/.test(value);
const missing = error => error.code === 'ENOENT';
async function reportPath(config, allowMissing = true) {
  return safePath(config.backupDir, 'restore-checks.json', allowMissing);
}
async function readChecks(config) {
  try {
    const report = JSON.parse(await fs.readFile(await reportPath(config, false), 'utf8'));
    if (report.version !== 1 || !Array.isArray(report.checks)) throw new Error('Restore-check report is invalid.');
    return report.checks;
  } catch (error) { if (missing(error)) return []; throw error; }
}
async function saveCheck(config, check) {
  const checks = [check, ...await readChecks(config)].slice(0, 20);
  const target = await reportPath(config), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, crlf(JSON.stringify({version: 1, checks}, null, 2) + '\n'), {flag: 'wx'});
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, {force: true}); }
}
async function snapshotManifest(config, id) {
  if (!snapshotId(id)) throw new Error('Choose a valid snapshot ID.');
  const file = await safePath(config.backupDir, `snapshots/${id}/manifest.json`);
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !Number.isFinite(Date.parse(manifest.created))) throw new Error('Snapshot manifest is invalid.');
  return manifest;
}
export async function getRecoveryStatus(config) {
  const snapshots = [];
  try {
    const root = await safePath(config.backupDir, 'snapshots');
    const names = (await fs.readdir(root, {withFileTypes: true})).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && snapshotId(entry.name)).map(entry => entry.name).sort().reverse();
    for (const id of names.slice(0, 20)) {
      try {
        const manifest = await snapshotManifest(config, id);
        snapshots.push({id, created: manifest.created, files: manifest.files.length, complete: true});
      } catch (error) { snapshots.push({id, complete: false, error: error.message}); }
    }
  } catch (error) { if (!missing(error)) throw error; }
  return {backupDir: config.backupDir, protection: 'local-only', offMachine: false, snapshots, checks: await readChecks(config)};
}
export async function createRecoverySnapshot(config) {
  const result = await backup(config);
  return {id: path.basename(result.snapshot), files: result.files};
}
export async function checkRecoverySnapshot(config, id) {
  return locked(config, async () => {
    const check = {snapshot: id, checkedAt: new Date().toISOString(), success: false, files: 0};
    let scratch;
    try {
      const manifest = await snapshotManifest(config, id);
      const parent = path.dirname(config.backupDir);
      const folder = `${path.basename(config.backupDir)}-restore-checks`;
      const root = await safePath(parent, folder, true);
      await fs.mkdir(root, {recursive: true});
      await safePath(parent, folder);
      scratch = await safePath(root, randomUUID(), true);
      await fs.mkdir(scratch);
      const target = path.join(scratch, 'vault');
      const restored = await restore(config, path.join(config.backupDir, 'snapshots', id), target);
      for (const file of manifest.files) {
        const copied = await safePath(target, file.path, false, true);
        if (hash(await fs.readFile(copied)) !== file.sha256) throw new Error(`Restored checksum mismatch: ${file.path}`);
      }
      await policies({...config, vault: target}, config.projects[0]?.root || process.cwd());
      check.files = restored.files;
      check.success = true;
      check.policiesLoaded = true;
      check.workspaceSettingsVerified = !!restored.workspaceSettings;
    } catch (error) { check.error = error.message; }
    finally {
      if (scratch) {
        try { await fs.rm(scratch, {recursive: true, force: true}); }
        catch (error) { check.success = false; check.error = `Restore-check cleanup failed: ${error.message}`; }
      }
    }
    await saveCheck(config, check);
    return check;
  });
}
