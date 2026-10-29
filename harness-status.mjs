import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const events = { omp: ['input', 'before_agent_start', 'before_subagent_spawn'], claude: ['SessionStart', 'UserPromptSubmit', 'SubagentStart'] };
const stateDirectory = config => path.join(path.dirname(config.configPath || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.config'), 'Axiom', 'config.json')), '.state');
const journalDirectory = config => path.join(stateDirectory(config), `harness-observations-${createHash('sha256').update(path.resolve(config.vault)).digest('hex').slice(0, 16)}`);

// One atomic file per event avoids lost updates between independent native processes.
export async function observeHarness(config, id, event) {
  if (!Object.hasOwn(events, id) || !events[id].includes(event)) return false;
  try {
    const dir = journalDirectory(config);
    await fs.mkdir(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID()}`;
    const temporary = path.join(dir, `${name}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ id, event, at: new Date().toISOString(), outcome: 'success' }), { flag: 'wx' });
      await fs.rename(temporary, path.join(dir, `${name}.json`));
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    const files = (await fs.readdir(dir)).filter(file => /^\d+-[\da-f-]+\.json$/.test(file)).sort().reverse();
    if (files.length > 100) {
      const records = await Promise.all(files.map(async file => {
        try { return {file, value: JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))}; }
        catch { return null; }
      }));
      const latest = new Map();
      for (const record of records) if (record?.value && Object.hasOwn(events, record.value.id) && events[record.value.id].includes(record.value.event) && Number.isFinite(Date.parse(record.value.at)) && !latest.has(record.value.id)) latest.set(record.value.id, record.file);
      const retained = new Set(latest.values());
      for (const file of files) { if (retained.size >= 100) break; retained.add(file); }
      await Promise.all(files.filter(file => !retained.has(file)).map(file => fs.rm(path.join(dir, file), {force: true}).catch(() => {})));
    }
    return true;
  } catch { return false; }
}

async function configured(home, id) {
  try {
    if (id === 'omp') {
      const file = path.join(home, '.omp', 'agent', 'extensions', 'shared-brain.ts');
      const source = await fs.readFile(file, 'utf8');
      const match = source.match(/export\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']/);
      const target = path.join(root, 'integrations', 'omp.ts');
      const valid = !!match && (match[1].startsWith('file:') ? fileURLToPath(match[1]) : path.resolve(path.dirname(file), match[1])) === target;
      if (valid) await fs.access(target);
      return { configured: valid, source: file, detail: valid ? 'Extension wrapper points to the Shared Brain integration.' : 'Extension wrapper does not point to the Shared Brain integration.' };
    }
    const file = path.join(home, '.claude', 'settings.json');
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    const target = path.join(root, 'integrations', 'claude-hook.mjs');
    await fs.access(target);
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${target.replace(/\\/g, '/')}"`;
    const missing = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse'].filter(event => !(settings.hooks?.[event] || []).some(group => {
      const matcher = event === 'PreToolUse' ? group.matcher === 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell' : !group.matcher;
      return matcher && (group.hooks || []).some(handler => handler.type === 'command' && handler.command === command);
    }));
    const disabled = settings.disableAllHooks === true;
    return { configured: !disabled && missing.length === 0, source: file, detail: disabled ? 'All Claude hooks are disabled.' : missing.length ? `Missing configured hooks: ${missing.join(', ')}.` : 'All four Shared Brain hooks are configured.' };
  } catch (error) { return { configured: false, detail: `Configuration unavailable: ${error.message}` }; }
}

async function qualification(config, id) {
  try {
    if (!config.configPath) return null;
    const canonical = JSON.parse(await fs.readFile(config.configPath, 'utf8'));
    if (path.resolve(canonical.vault) !== path.resolve(config.vault)) return null;
    const sources = id === 'claude' ? ['claude-qualification/summary.json', 'first-note-evidence/summary.json'] : ['first-note-evidence/summary.json'];
    const available = [];
    for (const source of sources) {
      try {
        const file = path.join(stateDirectory(config), source);
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        const valid = source.includes('claude-qualification') ? !!(data.fixture_session && data.compaction && data.missing_policy_result) : data.result?.code === 0 && data.unique === true && !!data.proofs?.gamma && !!data.proofs?.delta;
        if (valid) available.push({ path: source, at: (await fs.stat(file)).mtime.toISOString() });
      } catch { /* Missing or invalid evidence is not a pass. */ }
    }
    if (!available.length) return null;
    return { at: available.map(item => item.at).sort().at(-1), timestampBasis: 'Evidence file modification time', sources: available, coverage: id === 'claude' ? 'Artifacts record lifecycle and first-note exercises where available. Native Write guard was not invoked; direct hook and CLI guard were exercised.' : 'First-note evidence only; other historical qualification coverage is not represented by these artifacts.', missing: sources.filter(source => !available.some(item => item.path === source)) };
  } catch { return null; }
}

async function observations(config) {
  try {
    const dir = journalDirectory(config);
    const names = (await fs.readdir(dir)).filter(file => /^\d+-[\da-f-]+\.json$/.test(file)).sort().reverse();
    const latest = {};
    for (const name of names) {
      try {
        const item = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        if (events[item.id]?.includes(item.event) && !Number.isNaN(Date.parse(item.at)) && !latest[item.id]) latest[item.id] = { event: item.event, at: item.at, outcome: item.outcome === 'success' ? 'success' : 'unknown' };
      } catch { /* Ignore incomplete or malformed entries. */ }
    }
    return { available: true, latest };
  } catch (error) { return { available: false, latest: {}, reason: error.code === 'ENOENT' ? 'No observation journal exists yet.' : `Observation journal unavailable: ${error.message}` }; }
}

export async function getHarnessStatus(config) {
  const home = config.harnessHome || os.homedir();
  const observed = await observations(config);
  return { harnesses: await Promise.all(['omp', 'claude'].map(async id => ({ id, name: id === 'omp' ? 'omp' : 'Claude Code', installation: await configured(home, id), qualification: await qualification(config, id), observation: { available: observed.available, reason: observed.reason, last: observed.latest[id] || null } }))) };
}
