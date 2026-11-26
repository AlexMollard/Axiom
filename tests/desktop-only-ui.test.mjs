import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from '../src/server.mjs';

test('the UI is served only to desktop shell windows; browsers get the desktop-app page', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-desktop-only-'));
  const config = {vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup'), indexPath: path.join(root, 'index.json'), projects: [], port: 0};
  await fs.mkdir(config.vault, {recursive: true});
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await new Promise(resolve => server.close(resolve)); await fs.rm(root, {recursive: true, force: true});});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isApp = res => !/Axiom is a desktop app/.test(res);

  const browser = await fetch(origin + '/');
  assert.equal(browser.status, 200);
  assert.match(await browser.text(), /Axiom is a desktop app/);
  assert.equal(browser.headers.get('set-cookie'), null);

  // Without a frontend build the shell path reports 503 rather than the desktop-only page; either way it is not gated.
  const shell = await fetch(origin + '/?desktopMode=main');
  assert.ok(shell.status === 200 || shell.status === 503);
  assert.ok(isApp(await shell.text()));
  if (shell.status === 200) assert.match(shell.headers.get('set-cookie') || '', /axiom_shell=desktop/);

  const reload = await fetch(origin + '/?view=cleanup', {headers: {cookie: 'axiom_shell=desktop'}});
  assert.ok(isApp(await reload.text()));

  assert.equal((await fetch(origin + '/health')).status, 200);
});
