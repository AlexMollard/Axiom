import * as fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export const DEFAULT_GITHUB_REPO = 'AlexMollard/Axiom';

export function shouldSkipDesktopInstall({
  platform = process.platform,
  skipFlag = false,
  env = process.env,
  homeDir = os.homedir(),
  tmpDir = os.tmpdir(),
} = {}) {
  if (platform !== 'win32') {
    return {skip: true, reason: 'Windows desktop app is installed only on Windows.'};
  }
  if (skipFlag) {
    return {skip: true, reason: 'Skipped via --skip-desktop.'};
  }
  if (env.AXIOM_SKIP_DESKTOP_INSTALL === '1') {
    return {skip: true, reason: 'Skipped via AXIOM_SKIP_DESKTOP_INSTALL=1.'};
  }
  const resolvedHome = path.resolve(homeDir || '').toLowerCase();
  const resolvedTmp = path.resolve(tmpDir || '').toLowerCase();
  if (resolvedTmp && resolvedHome.startsWith(resolvedTmp + path.sep)) {
    return {skip: true, reason: 'Skipped in temporary test environment.'};
  }
  return {skip: false, reason: ''};
}

export function detectInstalledDesktop({
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const installDir = path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'AxiomDesktop');
  const exePath = path.join(installDir, 'current', 'axiom.exe');
  return {
    installed: fs.existsSync(exePath),
    installDir,
    exePath,
  };
}

export function findLocalDesktopInstaller(root) {
  const releasesDir = path.join(root, 'Releases');
  if (!fs.existsSync(releasesDir)) return null;
  const preferred = path.join(releasesDir, 'AxiomDesktop-win-Setup.exe');
  if (fs.existsSync(preferred) && fs.statSync(preferred).isFile()) {
    return preferred;
  }
  const entries = fs.readdirSync(releasesDir)
    .filter(name => /-Setup\.exe$/i.test(name))
    .map(name => {
      const fullPath = path.join(releasesDir, name);
      const stat = fs.statSync(fullPath);
      return {fullPath, isFile: stat.isFile(), mtimeMs: stat.mtimeMs};
    })
    .filter(item => item.isFile)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries[0]?.fullPath || null;
}

export async function downloadLatestDesktopInstaller(
  targetDir,
  {repo = DEFAULT_GITHUB_REPO, env = process.env} = {},
) {
  await fsp.mkdir(targetDir, {recursive: true});

  const ghResult = spawnSync(
    'gh',
    ['release', 'download', '--repo', repo, '--pattern', '*-Setup.exe', '--dir', targetDir, '--clobber'],
    {env, encoding: 'utf8', windowsHide: true},
  );
  if (ghResult.status === 0) {
    const files = (await fsp.readdir(targetDir)).filter(name => /-Setup\.exe$/i.test(name));
    if (files.length) {
      return {setupPath: path.join(targetDir, files[0]), reason: ''};
    }
  }

  let token = (env.AXIOM_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  if (!token) {
    const authRes = spawnSync('gh', ['auth', 'token'], {
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (authRes.status === 0 && authRes.stdout) {
      token = authRes.stdout.trim();
    }
  }
  const apiHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Axiom-Installer',
    ...(token ? {Authorization: `Bearer ${token}`} : {}),
  };

  try {
    const relResp = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {headers: apiHeaders});
    if (!relResp.ok) {
      return {
        setupPath: null,
        reason: `No published GitHub Release found for ${repo} (HTTP ${relResp.status}).`,
      };
    }
    const release = await relResp.json();
    const asset = (release.assets || []).find(item => /-Setup\.exe$/i.test(item.name || ''));
    if (!asset) {
      return {
        setupPath: null,
        reason: `Latest GitHub Release for ${repo} does not contain a Setup.exe asset.`,
      };
    }
    const downloadUrl = token ? asset.url : asset.browser_download_url;
    const binResp = await fetch(downloadUrl, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'Axiom-Installer',
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
      },
    });
    if (!binResp.ok) {
      return {
        setupPath: null,
        reason: `Could not download ${asset.name} (HTTP ${binResp.status}).`,
      };
    }
    const outPath = path.join(targetDir, asset.name);
    const bytes = Buffer.from(await binResp.arrayBuffer());
    await fsp.writeFile(outPath, bytes);
    return {setupPath: outPath, reason: ''};
  } catch (error) {
    return {
      setupPath: null,
      reason: `Could not fetch GitHub Release installer: ${error.message}`,
    };
  }
}

export function defaultRunInstaller(setupPath) {
  return spawnSync(setupPath, ['--silent'], {
    cwd: path.dirname(setupPath),
    encoding: 'utf8',
    windowsHide: true,
  });
}

export async function installDesktopApp({
  root,
  platform = process.platform,
  skipFlag = false,
  env = process.env,
  homeDir = os.homedir(),
  tmpDir = os.tmpdir(),
  repo = DEFAULT_GITHUB_REPO,
  runInstaller = defaultRunInstaller,
  downloader = downloadLatestDesktopInstaller,
} = {}) {
  const skipCheck = shouldSkipDesktopInstall({platform, skipFlag, env, homeDir, tmpDir});
  if (skipCheck.skip) {
    return {status: 'skipped', reason: skipCheck.reason};
  }

  let source = 'local';
  let cleanupDir = null;
  let setupPath = findLocalDesktopInstaller(root);

  if (!setupPath) {
    source = 'github';
    cleanupDir = await fsp.mkdtemp(path.join(tmpDir, 'axiom-desktop-setup-'));
    const downloaded = await downloader(cleanupDir, {repo, env});
    setupPath = downloaded.setupPath;
    if (!setupPath) {
      await fsp.rm(cleanupDir, {recursive: true, force: true}).catch(() => {});
      return {
        status: 'unavailable',
        reason: downloaded.reason || 'No desktop installer found in Releases/ or GitHub Releases.',
      };
    }
  }

  const before = detectInstalledDesktop({env, homeDir});
  try {
    const result = runInstaller(setupPath);
    if (result.error) {
      throw new Error(`Failed to execute desktop installer (${setupPath}): ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new Error(
        `Desktop installer exited with code ${result.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    return {
      status: 'installed',
      source,
      setupPath,
      installDir: before.installDir,
      upgraded: before.installed,
    };
  } finally {
    if (cleanupDir) {
      await fsp.rm(cleanupDir, {recursive: true, force: true}).catch(() => {});
    }
  }
}
