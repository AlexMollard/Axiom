import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createServer } from './server.mjs';

test('workspace graph follows rendered links and keeps workspace boundaries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-graph-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { vault: path.join(root, 'vault'), backupDir: path.join(root, 'backups'), indexPath: path.join(root, 'index.json'), projects: [{ id: 'alpha', root: path.join(root, 'alpha') }, { id: 'beta', root: path.join(root, 'beta') }], port: 0 };
  async function note(name, content) { const file = path.join(config.vault, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); }
  const base = 'Agents/Memory/Projects/alpha/';
  await note(`${base}start.md`, '# Start\n[[near]] [[near]] [relative](near.md) [root](/Agents/Memory/Projects/beta/other.md) [percent](Space%20Name.md) [[Duplicate]] [[Missing]] [[#section]] `[[CodeOnly]]`\n```\n[[FenceOnly]]\n```\n[remote](https://example.com/remote.md)');
  await note(`${base}near.md`, '# Near');
  await note(`${base}Space Name.md`, '# Space');
  await note(`${base}isolated.md`, '# Isolated');
  await note('Agents/Memory/Projects/beta/other.md', '# Other\n[[Secret]]');
  await note('Agents/Memory/Projects/beta/secret.md', '# Secret');
  await note('one/Duplicate.md', '# Duplicate');
  await note('two/Duplicate.md', '# Duplicate');
  await note('CodeOnly.md', '# CodeOnly');
  await note('FenceOnly.md', '# FenceOnly');
  await note('Agents/Memory/Imported/loose.md', '# Loose');
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (url, headers = {}) => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: config.port, path: url, headers }, response => { let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) })); }).on('error', reject);
  });
  const result = await request('/api/graph?project=alpha');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.edges, [
    { source: `${base}start.md`, target: `${base}near.md` },
    { source: `${base}start.md`, target: `${base}Space Name.md` },
    { source: `${base}start.md`, target: 'Agents/Memory/Projects/beta/other.md' },
  ].sort((a, b) => a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  assert.equal(result.body.unresolvedCount, 2);
  assert(result.body.nodes.some(node => node.path === `${base}isolated.md` && !node.external));
  assert(result.body.nodes.some(node => node.path.endsWith('/beta/other.md') && node.external));
  assert(!result.body.nodes.some(node => /secret|CodeOnly|FenceOnly|Duplicate/.test(node.path)));
  assert.equal((await request('/api/graph?project=unknown')).status, 400);
  assert((await request('/api/graph?project=global')).body.nodes.some(node => node.path === 'CodeOnly.md'));
  assert((await request('/api/graph?project=__unmapped')).body.nodes.some(node => node.path.endsWith('/loose.md')));
  assert.equal((await request('/api/graph?project=alpha', { Host: 'evil.example' })).status, 403);
  assert.equal((await request('/api/graph?project=alpha', { Origin: 'http://evil.example' })).status, 403);
});
