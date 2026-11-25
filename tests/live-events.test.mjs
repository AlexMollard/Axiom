import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createServer } from '../src/server.mjs';

function openSse(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, res => {
      resolve({ req, res });
    });
    req.on('error', reject);
    req.end();
  });
}

test('SSE /api/events streams connected, detects vault edits, and closes cleanly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-sse-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    vault: path.join(root, 'vault'),
    backupDir: path.join(root, 'backups'),
    indexPath: path.join(root, '.state', 'index.json'),
    projects: [],
    port: 0,
  };
  await fs.mkdir(path.join(config.vault, 'Owner'), { recursive: true });
  await fs.writeFile(path.join(config.vault, 'Owner', 'Policies.md'), '# Rules\nOk');

  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));

  const rejected = await openSse(config.port, '/api/events', { Host: 'evil.example', Connection: 'close' });
  assert.equal(rejected.res.statusCode, 403);
  rejected.res.resume();

  const { req, res } = await openSse(config.port, '/api/events');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  res.setEncoding('utf8');

  let buffer = '';
  const waitFor = (pattern, timeoutMs = 4000) => new Promise((resolve, reject) => {
    if (pattern.test(buffer)) return resolve(buffer);
    const timer = setTimeout(() => {
      res.off('data', onData);
      reject(new Error(`Timed out waiting for ${pattern} in:\n${buffer}`));
    }, timeoutMs);
    function onData(chunk) {
      buffer += chunk;
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        res.off('data', onData);
        resolve(buffer);
      }
    }
    res.on('data', onData);
  });

  await waitFor(/event: connected\r?\ndata: \{"ok":true\}/);
  await fs.writeFile(path.join(config.vault, 'Owner', 'NewNote.md'), '# New\nHello');
  const data = await waitFor(/event: catalog\r?\ndata: \{.*NewNote\.md/);
  assert.match(data, /event: catalog/);

  req.destroy();
  res.destroy();
});

test('GET /api/graph?project=__all returns full-vault nodes with workspaceId', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-fullgraph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    vault: path.join(root, 'vault'),
    backupDir: path.join(root, 'backups'),
    indexPath: path.join(root, '.state', 'index.json'),
    projects: [{ id: 'alpha', root: path.join(root, 'alpha') }, { id: 'beta', root: path.join(root, 'beta') }],
    port: 0,
  };
  const put = async (rel, content) => {
    const file = path.join(config.vault, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  await put('Home.md', '# Home\n[[alpha-note]]');
  await put('Agents/Memory/Projects/alpha/alpha-note.md', '# Alpha\n[[beta-note]]');
  await put('Agents/Memory/Projects/beta/beta-note.md', '# Beta');
  await put('Agents/Memory/Imported/loose.md', '# Loose');

  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));

  const response = await fetch(`http://127.0.0.1:${config.port}/api/graph?project=__all`, { headers: { Connection: 'close' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.project, '__all');
  assert.equal(body.nodes.length, 4);
  assert.equal(body.edges.length, 2);
  assert.equal(body.nodes.find(n => n.path === 'Home.md').workspaceId, 'global');
  assert.equal(body.nodes.find(n => n.path.endsWith('alpha-note.md')).workspaceId, 'alpha');
  assert.equal(body.nodes.find(n => n.path.endsWith('beta-note.md')).workspaceId, 'beta');
  assert.equal(body.nodes.find(n => n.path.endsWith('loose.md')).workspaceId, '__unmapped');
});

test('SSE retries stateDir watcher after delayed creation and emits usage events', { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-sse-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const config = {
    vault: path.join(root, 'vault'),
    backupDir: path.join(root, 'backups'),
    configPath,
    projects: [],
    port: 0,
  };
  await fs.mkdir(path.join(config.vault, 'Owner'), { recursive: true });
  await fs.writeFile(path.join(config.vault, 'Owner', 'Policies.md'), '# Rules\nOk');
  await fs.writeFile(configPath, JSON.stringify({ vault: config.vault, backupDir: config.backupDir }));

  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));

  const { req, res } = await openSse(config.port, '/api/events');
  assert.equal(res.statusCode, 200);
  res.setEncoding('utf8');

  let buffer = '';
  const waitFor = (pattern, timeoutMs = 5000) => new Promise((resolve, reject) => {
    if (pattern.test(buffer)) return resolve(buffer);
    const timer = setTimeout(() => {
      res.off('data', onData);
      reject(new Error(`Timed out waiting for ${pattern} in:\n${buffer}`));
    }, timeoutMs);
    function onData(chunk) {
      buffer += chunk;
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        res.off('data', onData);
        resolve(buffer);
      }
    }
    res.on('data', onData);
  });

  await waitFor(/event: connected\r?\ndata: \{"ok":true\}/);
  const stateDir = path.join(root, '.state');
  await fs.mkdir(stateDir, { recursive: true });
  const usageEvent = await waitFor(/event: usage\r?\ndata: \{/, 4000);
  assert.match(usageEvent, /event: usage/);

  req.destroy();
  res.destroy();
});
