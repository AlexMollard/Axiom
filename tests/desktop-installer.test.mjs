import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectInstalledDesktop,
  findLocalDesktopInstaller,
  installDesktopApp,
  shouldSkipDesktopInstall,
} from '../scripts/desktop-installer.mjs';

test('shouldSkipDesktopInstall honors platform, flag, env var, and temp fixtures', () => {
  assert.equal(shouldSkipDesktopInstall({platform: 'linux', homeDir: 'C:\\Users\\alex', tmpDir: 'C:\\Temp'}).skip, true);
  assert.equal(shouldSkipDesktopInstall({platform: 'win32', skipFlag: true, homeDir: 'C:\\Users\\alex', tmpDir: 'C:\\Temp'}).skip, true);
  assert.equal(shouldSkipDesktopInstall({platform: 'win32', env: {AXIOM_SKIP_DESKTOP_INSTALL: '1'}, homeDir: 'C:\\Users\\alex', tmpDir: 'C:\\Temp'}).skip, true);
  const tmp = path.join(os.tmpdir(), 'axiom-test-home');
  assert.equal(shouldSkipDesktopInstall({platform: 'win32', env: {}, homeDir: tmp, tmpDir: os.tmpdir()}).skip, true);
  assert.equal(shouldSkipDesktopInstall({platform: 'win32', env: {}, homeDir: 'C:\\Users\\alex', tmpDir: 'C:\\Users\\alex\\AppData\\Local\\Temp'}).skip, false);
});

test('installDesktopApp prefers local Releases installer and reports failures cleanly', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-desktop-pkg-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  assert.equal(findLocalDesktopInstaller(root), null);

  await fs.mkdir(path.join(root, 'Releases'), {recursive: true});
  const setupExe = path.join(root, 'Releases', 'AxiomDesktop-win-Setup.exe');
  await fs.writeFile(setupExe, 'stub');
  assert.equal(findLocalDesktopInstaller(root), setupExe);

  let invoked = null;
  const ok = await installDesktopApp({
    root,
    platform: 'win32',
    env: {LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local'},
    homeDir: 'C:\\Users\\alex',
    tmpDir: 'C:\\Other\\Temp',
    runInstaller: p => {
      invoked = p;
      return {status: 0, stdout: '', stderr: ''};
    },
  });
  assert.equal(invoked, setupExe);
  assert.equal(ok.status, 'installed');
  assert.equal(ok.source, 'local');
  assert.equal(ok.installDir, path.join('C:\\Users\\alex\\AppData\\Local', 'AxiomDesktop'));
  assert.equal(ok.upgraded, false);

  const localAppData = path.join(root, 'LocalAppData');
  const existingExe = path.join(localAppData, 'AxiomDesktop', 'current', 'axiom.exe');
  await fs.mkdir(path.dirname(existingExe), {recursive: true});
  await fs.writeFile(existingExe, 'existing');
  assert.deepEqual(detectInstalledDesktop({env: {LOCALAPPDATA: localAppData}, homeDir: root}), {
    installed: true,
    installDir: path.join(localAppData, 'AxiomDesktop'),
    exePath: existingExe,
  });
  const upgraded = await installDesktopApp({
    root,
    platform: 'win32',
    env: {LOCALAPPDATA: localAppData},
    homeDir: root,
    tmpDir: 'C:\\Other\\Temp',
    runInstaller: () => ({status: 0, stdout: '', stderr: ''}),
  });
  assert.equal(upgraded.upgraded, true);

  await assert.rejects(
    () =>
      installDesktopApp({
        root,
        platform: 'win32',
        env: {},
        homeDir: 'C:\\Users\\alex',
        tmpDir: 'C:\\Other\\Temp',
        runInstaller: () => ({status: 1603, stdout: '', stderr: 'Setup failed'}),
      }),
    /exited with code 1603/,
  );
});
