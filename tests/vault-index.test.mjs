import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, catalog, readNote, writeNote, search, backup } from '../src/memory.mjs';

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-sqlite-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const backupDir = path.join(root, 'backups');
  const configPath = path.join(root, 'config.json');
  await fs.mkdir(path.join(vault, 'Owner'), { recursive: true });
  await fs.mkdir(path.join(vault, 'Agents', 'Memory', 'Projects', 'alpha'), { recursive: true });
  await fs.mkdir(path.join(vault, 'Agents', 'Memory', 'Projects', 'beta'), { recursive: true });
  await fs.writeFile(path.join(vault, 'Owner', 'Policies.md'), '# Policies\r\nNever deploy automatically.\r\n');
  await fs.writeFile(path.join(vault, 'Owner', 'Preferences.md'), '# Preferences\r\nCite evidence.\r\n');
  await fs.writeFile(configPath, JSON.stringify({
    vault,
    backupDir,
    projects: [
      { id: 'alpha', root: path.join(root, 'alpha') },
      { id: 'beta', root: path.join(root, 'beta') },
    ],
    ...extra,
  }));
  const config = await loadConfig(configPath);
  return { root, vault, backupDir, configPath, config };
}

test('loadConfig defaults indexPath to .sqlite and persists FTS5 search state', async t => {
  const { root, vault, config } = await fixture(t);
  assert.match(config.indexPath, /\.sqlite$/);

  await fs.writeFile(path.join(vault, 'Owner', 'Languages.md'), '# Languages\r\nUse C++ and C# cleanly. Café rollout ﬀ ligature.\r\n');
  await fs.writeFile(path.join(vault, 'Agents', 'Memory', 'Projects', 'alpha', 'alpha.md'), '# Alpha Note\r\nalphaonlysignal C++\r\n');
  await fs.writeFile(path.join(vault, 'Agents', 'Memory', 'Projects', 'beta', 'beta.md'), '# Beta Note\r\nbetaonlysignal\r\n');

  const firstCatalog = await catalog(config);
  assert.ok(firstCatalog.some(n => n.path === 'Owner/Languages.md'));
  await fs.stat(config.indexPath);

  assert.deepEqual((await search(config, 'C++', { all: true })).items.map(i => i.path).sort(), [
    'Agents/Memory/Projects/alpha/alpha.md',
    'Owner/Languages.md',
  ]);
  assert.deepEqual((await search(config, 'C#', { all: true })).items.map(i => i.path), ['Owner/Languages.md']);
  assert.deepEqual((await search(config, 'ff cafe', { all: true })).items.map(i => i.path), ['Owner/Languages.md']);
  assert.deepEqual((await search(config, 'alphaonlysignal', { cwd: path.join(root, 'alpha') })).items.map(i => i.path), ['Agents/Memory/Projects/alpha/alpha.md']);
  assert.equal((await search(config, 'betaonlysignal', { cwd: path.join(root, 'alpha') })).count, 0);

  // Edit and delete flow updates incremental rows cleanly
  await fs.writeFile(path.join(vault, 'Owner', 'Languages.md'), '# Languages\r\nRust replaced everything.\r\n');
  assert.equal((await search(config, 'C#', { all: true })).count, 0);
  assert.deepEqual((await search(config, 'Rust', { all: true })).items.map(i => i.path), ['Owner/Languages.md']);

  await fs.unlink(path.join(vault, 'Owner', 'Languages.md'));
  assert.equal((await search(config, 'Rust', { all: true })).count, 0);
  assert.equal((await catalog(config)).some(n => n.path === 'Owner/Languages.md'), false);
});

test('corrupt or tampered SQLite index recovers cleanly from canonical vault bytes', async t => {
  const { vault, config } = await fixture(t);
  await fs.writeFile(path.join(vault, 'Owner', 'Fact.md'), '# Canonical\r\nverifiedcanonical\r\n');
  await catalog(config);

  // Tamper content inside SQLite without touching revision or file stats
  const db = new DatabaseSync(config.indexPath);
  db.prepare('UPDATE notes SET content = ? WHERE path = ?').run('# Forged\r\nforgedneedle', 'Owner/Fact.md');
  db.close();

  assert.equal((await search(config, 'forgedneedle', { all: true })).count, 0);
  assert.deepEqual((await search(config, 'verifiedcanonical', { all: true })).items.map(i => i.path), ['Owner/Fact.md']);

  // Overwrite SQLite file with garbage bytes
  await fs.writeFile(config.indexPath, 'not a valid sqlite database payload');
  const recovered = await catalog(config);
  assert.equal(recovered.find(n => n.path === 'Owner/Fact.md')?.title, 'Canonical');
  assert.equal((await search(config, 'verifiedcanonical', { all: true })).count, 1);
});

test('unwritable SQLite index path falls back cleanly without hiding canonical vault errors', async t => {
  const { root, vault, config } = await fixture(t);
  await fs.writeFile(path.join(vault, 'Owner', 'Evidence.md'), '# Evidence\r\nsqlitefallbackprobe\r\n');
  await fs.writeFile(path.join(root, 'blocker'), 'file');
  config.indexPath = path.join(root, 'blocker', 'index.sqlite');

  assert.ok((await catalog(config)).some(n => n.path === 'Owner/Evidence.md'));
  assert.equal((await search(config, 'sqlitefallbackprobe', { all: true })).count, 1);

  await fs.writeFile(path.join(vault, 'Owner', 'TooBig.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(catalog(config), /2 MiB/);
});

test('snapshot staging leaves no .tmp directories on failure and prunes older complete snapshots beyond retention', async t => {
  const { vault, backupDir, config } = await fixture(t, { backupRetention: 2 });
  await fs.writeFile(path.join(vault, 'Owner', 'Note.md'), '# Note\r\nInitial\r\n');

  const s1 = await backup(config);
  await new Promise(resolve => setTimeout(resolve, 25));
  const s2 = await backup(config);
  await new Promise(resolve => setTimeout(resolve, 25));
  const s3 = await backup(config);

  const snapshotsDir = path.join(backupDir, 'snapshots');
  const entries = await fs.readdir(snapshotsDir);
  assert.deepEqual(entries.sort(), [path.basename(s2.snapshot), path.basename(s3.snapshot)].sort());
  assert.ok(!entries.includes(path.basename(s1.snapshot)));

  // Symlink in vault aborts backup before staging leaves any partial snapshot behind
  await fs.symlink(path.join(vault, 'Owner', 'Note.md'), path.join(vault, 'Owner', 'link.md'));
  await assert.rejects(backup(config), /Snapshot refuses links/);
  const afterFail = await fs.readdir(snapshotsDir);
  assert.ok(afterFail.every(name => !name.startsWith('.tmp-')));
  assert.deepEqual(afterFail.sort(), entries.sort());
});
