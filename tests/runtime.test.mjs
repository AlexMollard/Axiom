import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const processesByConfig = new Map();
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-runtime-'));
  const configPath = path.join(root, 'config.json');
  const config = {vault: path.join(root, 'vault'), backupDir: path.join(root, 'backups'), port: await freePort(), projects: []};
  await fs.mkdir(path.join(config.vault, 'Owner'), {recursive: true});
  await fs.writeFile(path.join(config.vault, 'Owner', 'Policies.md'), '# Policies\r\nFixture only.\r\n');
  await fs.writeFile(path.join(config.vault, 'Owner', 'Preferences.md'), '# Preferences\r\nFixture only.\r\n');
  await fs.writeFile(configPath, JSON.stringify(config));
  processesByConfig.set(configPath, []);
  t.after(async () => {
    for (const process of processesByConfig.get(configPath)) {
      if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
      await process.exited;
    }
    processesByConfig.delete(configPath);
    await fs.rm(root, {recursive: true, force: true});
  });
  const identity = createHash('sha256').update((await fs.realpath(configPath)).toLowerCase()).digest('hex').slice(0, 16).toUpperCase();
  return {root, configPath, config, state: path.join(root, '.state', `runtime-${identity}`)};
}
function launch(t, configPath, argument = configPath) {
  const child = spawn(process.execPath, [serverPath, argument], {cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe']});
  const ready = Promise.withResolvers(), exited = Promise.withResolvers();
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; if (stdout.includes('Shared Brain: http://')) ready.resolve(); });
  child.stderr.on('data', data => { stderr += data; });
  child.once('error', error => { ready.reject(error); exited.reject(error); });
  child.once('exit', (code, signal) => { ready.resolve(); exited.resolve({code, signal, stdout, stderr}); });
  const launched = {child, ready: ready.promise, exited: exited.promise};
  processesByConfig.get(configPath).push(launched);
  return launched;
}

test('Windows runtime rejects alias launches after a port edit and releases ownership after abrupt death', {skip: process.platform !== 'win32', timeout: 20000}, async t => {
  const {root, configPath, config, state} = await fixture(t);
  const first = launch(t, configPath);
  await first.ready;
  const firstHealth = await fetch(`http://127.0.0.1:${config.port}/health`).then(r => r.json());
  assert.equal(firstHealth.ok, true);
  assert.equal(firstHealth.pid, first.child.pid);
  assert.equal(firstHealth.configId, path.basename(state).slice('runtime-'.length));
  const originalPort = config.port;
  config.port = await freePort();
  await fs.writeFile(configPath, JSON.stringify(config));
  const alias = path.join(root, 'alias');
  await fs.symlink(root, alias, 'junction');
  const duplicate = launch(t, configPath, path.join(alias, 'config.json'));
  const rejected = await duplicate.exited;
  assert.notEqual(rejected.code, 0, rejected.stderr);
  assert.match(rejected.stderr, /EADDRINUSE|EACCES/);
  assert.equal((await fs.readFile(path.join(state, 'server.pid'), 'utf8')).trim(), String(first.child.pid));
  assert.equal((await fetch(`http://127.0.0.1:${originalPort}/health`).then(r => r.json())).ok, true);
  first.child.kill('SIGKILL');
  await first.exited;
  const replacement = launch(t, configPath);
  await replacement.ready;
  const replacementHealth = await fetch(`http://127.0.0.1:${config.port}/health`).then(r => r.json());
  assert.equal(replacementHealth.ok, true);
  assert.equal(replacementHealth.pid, replacement.child.pid);
  assert.equal(replacementHealth.configId, firstHealth.configId);
  assert.equal((await fs.readFile(path.join(state, 'server.pid'), 'utf8')).trim(), String(replacement.child.pid));
});

test('fatal startup errors are retained in the private bounded log', {timeout: 15000}, async t => {
  const {configPath, state} = await fixture(t);
  await fs.writeFile(configPath, '{invalid configuration');
  const server = launch(t, configPath);
  assert.notEqual((await server.exited).code, 0);
  const log = await fs.readFile(path.join(state, 'server.log'), 'utf8');
  assert.match(log, /SyntaxError/);
  assert.ok(Buffer.byteLength(log) <= 1024 * 1024);
  assert.equal(/(?<!\r)\n/.test(log), false);
});
