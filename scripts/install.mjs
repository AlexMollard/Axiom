import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {loadConfig, policies} from '../src/memory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let previousRoot;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--previous-root' || !path.isAbsolute(args[1])) {
    throw new Error('Usage: node scripts/install.mjs [--previous-root <absolute old app root>]');
  }
  previousRoot = path.resolve(args[1]);
}
const config = await loadConfig();
await policies(config, process.cwd());
const relativeBackup = path.relative(root, config.backupDir);
if (!relativeBackup || (!relativeBackup.startsWith('..' + path.sep) && relativeBackup !== '..' && !path.isAbsolute(relativeBackup))) {
  throw new Error('Installation backups must be outside the application checkout.');
}
const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
const extension = path.join(os.homedir(), '.omp', 'agent', 'extensions', 'shared-brain.ts');
let settings;
try { settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; settings = {}; }
if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
    (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)))) {
  throw new Error('Invalid Claude settings or hooks object.');
}
const events = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse'];
for (const event of events) {
  const groups = settings.hooks?.[event];
  if (groups !== undefined && (!Array.isArray(groups) || groups.some(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks)))) {
    throw new Error(`Invalid Claude hook groups for ${event}.`);
  }
}
const normalize = value => value.replaceAll('\\', '/');
const pathKey = value => process.platform === 'win32' ? normalize(value).toLowerCase() : normalize(value);
const hook = normalize(path.join(root, 'integrations', 'claude-hook.mjs'));
const oldHook = previousRoot && normalize(path.join(previousRoot, 'integrations', 'claude-hook.mjs'));
const command = `"${normalize(process.execPath)}" "${hook}"`;
function isOwned(handler) {
  if (!handler || handler.type !== 'command') return false;
  const targets = oldHook ? [hook, oldHook] : [hook];
  const node = executable => {
    const value = normalize(executable).replace(/^"|"$/g, '');
    return pathKey(value) === pathKey(process.execPath) || /(?:^|\/)node(?:\.exe)?$/i.test(value);
  };
  if (typeof handler.command !== 'string') return false;
  if (Array.isArray(handler.args) && handler.args.length === 1 && typeof handler.args[0] === 'string' && node(handler.command) && targets.some(target => pathKey(target) === pathKey(handler.args[0]))) return true;
  return targets.some(target => {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^("[^"]+"|\\S+)\\s+"${escaped}"$`, process.platform === 'win32' ? 'i' : '').exec(normalize(handler.command));
    return match && node(match[1]);
  });
}
settings.hooks ||= {};
for (const event of events) {
  const groups = (settings.hooks[event] || []).flatMap(group => {
    const hooks = group.hooks.filter(handler => !isOwned(handler));
    return hooks.length || !group.hooks.length ? [{...group, hooks}] : [];
  });
  groups.push({...(event === 'PreToolUse' ? {matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell'} : {}), hooks: [{type: 'command', command, timeout: 15}]});
  settings.hooks[event] = groups;
}
async function replaceFile(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, {flag: 'wx'});
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, {force: true}); }
}
const snapshot = path.join(config.backupDir, 'installation', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
await fs.mkdir(snapshot, {recursive: true});
const saved = [];
for (const [file, label] of [[settingsFile, 'claude-settings.json'], [extension, 'shared-brain.ts']]) {
  const backup = path.join(snapshot, label);
  try { await fs.copyFile(file, backup); saved.push({file, backup}); }
  catch (error) { if (error.code !== 'ENOENT') throw error; saved.push({file, backup: null}); }
}
await fs.mkdir(path.dirname(settingsFile), {recursive: true});
await replaceFile(settingsFile, JSON.stringify(settings, null, 2).replace(/\r?\n/g, '\r\n') + '\r\n');
await fs.mkdir(path.dirname(extension), {recursive: true});
const target = path.join(root, 'integrations', 'omp.ts');
const relative = path.relative(path.dirname(extension), target);
const specifier = path.isAbsolute(relative) ? pathToFileURL(target).href : normalize(relative.startsWith('.') ? relative : './' + relative);
await replaceFile(extension, `export {default} from ${JSON.stringify(specifier)};\r\n`);
await replaceFile(path.join(snapshot, 'installation-report.json'), JSON.stringify({created: new Date().toISOString(), snapshot, saved}, null, 2).replace(/\r?\n/g, '\r\n') + '\r\n');
console.log(`Axiom integrations installed. Rollback copies: ${snapshot}`);
