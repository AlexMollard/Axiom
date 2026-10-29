import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';
import {readNote, saveFromEditor} from '../src/memory.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-history-http-'));
  const config = {vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup'), indexPath: path.join(root, 'index.json'), projects: [{id: 'alpha', root: path.join(root, 'alpha')}, {id: 'beta', root: path.join(root, 'beta')}], port: 0};
  await fs.mkdir(path.join(config.vault, 'Owner'), {recursive: true});
  await fs.writeFile(path.join(config.vault, 'Owner', 'Example.md'), '# Example\r\nEarlier content.\r\n');
  const original = await readNote(config, 'Owner/Example.md');
  const current = await saveFromEditor(config, original.path, '# Example\r\nCurrent content.\r\n', original.revision);
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await fs.rm(root, {recursive: true, force: true});});
  const origin = `http://127.0.0.1:${config.port}`;
  const token = (await (await fetch(origin + '/api/editor-session')).json()).token;
  const headers = {'content-type': 'application/json', origin, 'x-shared-brain-csrf': token};
  const history = await (await fetch(origin + '/api/note-history?path=' + encodeURIComponent(original.path))).json();
  return {config, origin, headers, original, current, history};
}

test('HTTP restore requires the human-origin session and current revision, preserving the replaced content', async t => {
  const f = await fixture(t);
  const body = {path: f.original.path, id: f.history.items[0].id, expectedRevision: f.current.revision};
  const request = (headers, value = body) => fetch(f.origin + '/api/note-history/restore', {method: 'POST', headers, body: JSON.stringify(value)});
  assert.equal((await request({'content-type': 'application/json', origin: f.origin})).status, 403);
  assert.equal((await request({...f.headers, origin: 'http://evil.invalid'})).status, 403);
  assert.equal((await request({...f.headers, 'sec-fetch-site': 'cross-site'})).status, 403);
  assert.equal((await request({...f.headers, 'content-type': 'text/plain'})).status, 415);
  assert.equal((await request(f.headers, {...body, expectedRevision: f.original.revision})).status, 409);
  assert.equal((await readNote(f.config, f.original.path)).content, f.current.content);
  const response = await request(f.headers);
  assert.equal(response.status, 200);
  const restored = await response.json();
  assert.equal(restored.note.content, f.original.content);
  assert.match(restored.html, /Earlier content/);
  const after = await (await fetch(f.origin + '/api/note-history?path=' + encodeURIComponent(f.original.path))).json();
  assert.ok(after.items.some(item => item.revision === f.current.revision));
  await assert.rejects(fs.stat(path.join(f.config.vault, 'Owner', 'Reviews.md')), {code: 'ENOENT'});
});

test('capture preview is a guarded read-only operation and cannot restore or approve a note', async t => {
  const f = await fixture(t);
  const payload = {path: 'Agents/Memory/General/Candidate.md', content: '# Example\r\nCurrent content.\r\n'};
  const request = headers => fetch(f.origin + '/api/capture-suggestions', {method: 'POST', headers, body: JSON.stringify(payload)});
  assert.equal((await request({'content-type': 'application/json'})).status, 403);
  assert.equal((await request({...f.headers, origin: 'http://evil.invalid'})).status, 403);
  assert.equal((await request(f.headers)).status, 200);
  assert.equal((await readNote(f.config, f.current.path)).revision, f.current.revision);
  await assert.rejects(fs.stat(path.join(f.config.vault, 'Agents', 'Memory', 'General', 'Candidate.md')), {code: 'ENOENT'});
  await assert.rejects(fs.stat(path.join(f.config.vault, 'Owner', 'Reviews.md')), {code: 'ENOENT'});
  const invalid = await fetch(f.origin + '/api/capture-suggestions', {method: 'POST', headers: f.headers, body: JSON.stringify({path: payload.path, content: {not: 'Markdown'}})});
  assert.equal(invalid.status, 400);
});

test('browser capture scope follows the selected workspace rather than server cwd', async t => {
  const f = await fixture(t);
  for (const project of ['alpha', 'beta']) {
    const directory = path.join(f.config.vault, 'Agents', 'Memory', 'Projects', project);
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(path.join(directory, 'Existing.md'), '# Quasar reactor\r\nquasar containment procedure\r\n');
  }
  const payload = {path: 'Agents/Memory/Projects/beta/New.md', content: '# Quasar reactor\r\nquasar containment procedure\r\n'};
  const response = await fetch(f.origin + '/api/capture-suggestions', {method: 'POST', headers: f.headers, body: JSON.stringify(payload)});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.project, 'beta');
  assert.deepEqual(result.items.map(item => item.note.path), ['Agents/Memory/Projects/beta/Existing.md']);
  const invalid = await fetch(f.origin + '/api/capture-suggestions', {method: 'POST', headers: f.headers, body: JSON.stringify({...payload, workspace: 'unknown'})});
  assert.equal(invalid.status, 400);
});
