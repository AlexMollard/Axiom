import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {getHarnessStatus} from './harness-status.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-integration-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const app = path.join(root, 'Axiom app'), home = path.join(root, 'home');
  const vault = path.join(root, 'vault'), backupDir = path.join(root, 'backups');
  await fs.mkdir(app, {recursive: true});
  await fs.symlink(path.join(source, 'node_modules'), path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of await fs.readdir(source)) if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) await fs.copyFile(path.join(source, name), path.join(app, name));
  await fs.cp(path.join(source, 'integrations'), path.join(app, 'integrations'), {recursive: true});
  await fs.mkdir(path.join(vault, 'Owner'), {recursive: true});
  await fs.writeFile(path.join(vault, 'Owner', 'Policies.md'), '# Rules\nFollow the rules.\n');
  await fs.writeFile(path.join(vault, 'Owner', 'Preferences.md'), '# Preferences\nBe clear.\n');
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({vault, backupDir, projects: []}));
  const env = {...process.env, HOME: home, USERPROFILE: home, SHARED_BRAIN_CONFIG: configPath};
  return {root, app, home, vault, config: {vault, configPath, harnessHome: home}, env};
}
function run(f, script, args = [], input) {
  return spawnSync(process.execPath, [path.join(f.app, script), ...args], {env: f.env, cwd: f.root, input, encoding: 'utf8'});
}

test('Claude observes only successful policy loads and rejects oversized mandatory context', async t => {
  const f = await fixture(t);
  const input = JSON.stringify({hook_event_name: 'SessionStart', cwd: f.root});
  await fs.rm(path.join(f.vault, 'Owner', 'Policies.md'));
  let result = run(f, 'integrations/claude-hook.mjs', [], input);
  assert.notEqual(result.status, 0);
  assert.equal((await getHarnessStatus(f.config)).harnesses[1].observation.last, null);
  await fs.writeFile(path.join(f.vault, 'Owner', 'Policies.md'), '# Rules\n' + 'x'.repeat(9000));
  result = run(f, 'integrations/claude-hook.mjs', [], input);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /budget/i);
  assert.equal((await getHarnessStatus(f.config)).harnesses[1].observation.last, null);
  await fs.writeFile(path.join(f.vault, 'Owner', 'Policies.md'), '# Rules\nRequired rule.');
  result = run(f, 'integrations/claude-hook.mjs', [], input);
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /Required rule/);
  assert.equal((await getHarnessStatus(f.config)).harnesses[1].observation.last.outcome, 'success');
});

test('standalone installer preserves settings, replaces only the requested old hooks, and is idempotent', async t => {
  const f = await fixture(t);
  const settings = path.join(f.home, '.claude', 'settings.json');
  const extension = path.join(f.home, '.omp', 'agent', 'extensions', 'shared-brain.ts');
  const adjacent = path.join(f.root, 'configs', 'claude', 'settings.json');
  await fs.mkdir(path.dirname(adjacent), {recursive: true});
  await fs.writeFile(adjacent, 'parent settings must not change');
  const previousRoot = path.join(f.root, 'previous app');
  const oldHook = path.join(previousRoot, 'integrations', 'claude-hook.mjs');
  const otherHook = path.join(f.root, 'other app', 'integrations', 'claude-hook.mjs');
  const existing = {theme: 'dark', hooks: {SessionStart: [{matcher: 'startup', hooks: [
    {type: 'command', command: 'other'},
    {type: 'command', command: process.execPath, args: [oldHook], timeout: 15},
    {type: 'command', command: process.execPath, args: [otherHook]},
    {type: 'command', command: `"${process.execPath.replaceAll('\\', '/')}" "${oldHook.replaceAll('\\', '/')}"`}
  ]}], Stop: [{hooks: [{type: 'command', command: 'stop'}]}]}};
  await fs.mkdir(path.dirname(settings), {recursive: true});
  await fs.writeFile(settings, JSON.stringify(existing));
  const previousRootArgument = process.platform === 'win32' ? previousRoot.toUpperCase() : previousRoot;
  let result = run(f, 'install.mjs', ['--previous-root', previousRootArgument]);
  assert.equal(result.status, 0, result.stderr);
  const merged = JSON.parse(await fs.readFile(settings, 'utf8'));
  const command = `"${process.execPath.replaceAll('\\', '/')}" "${path.join(f.app, 'integrations', 'claude-hook.mjs').replaceAll('\\', '/')}"`;
  assert.equal(merged.theme, 'dark');
  assert.deepEqual(merged.hooks.Stop, existing.hooks.Stop);
  assert.deepEqual(merged.hooks.SessionStart[0].hooks, [existing.hooks.SessionStart[0].hooks[0], existing.hooks.SessionStart[0].hooks[2]]);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse']) {
    const installed = merged.hooks[event].filter(group => group.hooks.some(handler => handler.command === command));
    assert.equal(installed.length, 1);
    assert.deepEqual(installed[0].hooks, [{type: 'command', command, timeout: 15}]);
    if (event === 'PreToolUse') assert.equal(installed[0].matcher, 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell');
  }
  assert.match(await fs.readFile(extension, 'utf8'), /integrations\/omp\.ts/);
  assert.equal(await fs.readFile(adjacent, 'utf8'), 'parent settings must not change');
  result = run(f, 'install.mjs', ['--previous-root', previousRootArgument]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(settings, 'utf8')), merged);
  const snapshots = await fs.readdir(path.join(f.root, 'backups', 'installation'));
  assert.equal(snapshots.length, 2);
  const reports = await Promise.all(snapshots.map(name => fs.readFile(path.join(f.root, 'backups', 'installation', name, 'installation-report.json'), 'utf8').then(JSON.parse)));
  assert.ok(reports.some(report => report.saved.some(entry => entry.file === settings && entry.backup)));
  await assert.rejects(fs.access(path.join(f.app, 'installation-report.json')), {code: 'ENOENT'});
});

test('installer initializes missing settings and fails safely on malformed settings or missing policies', async t => {
  const f = await fixture(t);
  const settings = path.join(f.home, '.claude', 'settings.json');
  const extension = path.join(f.home, '.omp', 'agent', 'extensions', 'shared-brain.ts');
  let result = run(f, 'install.mjs');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(await fs.readFile(settings, 'utf8')).hooks.SessionStart.length);
  await assert.rejects(fs.access(path.join(f.root, 'configs')), {code: 'ENOENT'});
  const wrapper = await fs.readFile(extension, 'utf8');
  await fs.writeFile(settings, '{broken');
  result = run(f, 'install.mjs');
  assert.notEqual(result.status, 0);
  assert.equal(await fs.readFile(settings, 'utf8'), '{broken');
  assert.equal(await fs.readFile(extension, 'utf8'), wrapper);
  await fs.writeFile(settings, '{}');
  await fs.rm(path.join(f.vault, 'Owner', 'Policies.md'));
  result = run(f, 'install.mjs');
  assert.notEqual(result.status, 0);
  assert.equal(await fs.readFile(settings, 'utf8'), '{}');
  assert.equal(await fs.readFile(extension, 'utf8'), wrapper);
});

test('revived requests deliver fresh policies without phantom receipts or transcript growth', async t => {
  const f = await fixture(t);
  const program = `
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs/promises';
    import {pathToFileURL} from 'node:url';
    const app = ${JSON.stringify(f.app)};
    const {default: integrate} = await import(pathToFileURL(app + '/integrations/omp.ts').href);
    const {loadConfig, catalog} = await import(pathToFileURL(app + '/memory.mjs').href);
    const {getNoteUsage} = await import(pathToFileURL(app + '/note-usage.mjs').href);
    const handlers = new Map(), schema = () => ({});
    integrate({typebox: {Type: {Object: schema, String: schema, Number: schema, Optional: schema}}, registerTool() {}, on(name, handler) { handlers.set(name, handler); }});
    const config = await loadConfig();
    let aborted = false;
    const ctx = {cwd: ${JSON.stringify(f.root)}, abort() { aborted = true; }};
    const counts = async () => (await getNoteUsage(config, await catalog(config))).notes.find(note => note.path === 'Owner/Policies.md').usage;
    const start = handlers.get('before_agent_start'), context = handlers.get('context');
    const prompt = {reason: 'prompt', prompt: '', systemPrompt: ['Base system rules']};
    await start(prompt, ctx);
    assert.equal((await counts()).context30d, 1);
    await start({...prompt, reason: 'revive'}, ctx);
    assert.equal((await counts()).context30d, 1, 'a discarded revival result is not delivered context');
    const file = config.vault + '/Owner/Policies.md';
    await fs.rm(file);
    await assert.rejects(context({messages: []}, ctx), /policy unavailable/);
    assert.equal(aborted, true);
    await fs.writeFile(file, '# Rules\\r\\nFRESH_WAKE_POLICY_V2\\r\\n');
    assert.equal((await counts()).context30d, 1);
    const messages = [{role: 'user', content: 'Agent-initiated wake', timestamp: 1}];
    const wake = await context({messages}, ctx);
    assert.match(wake.messages.at(-1).content, /FRESH_WAKE_POLICY_V2/);
    assert.equal(wake.messages.length, messages.length + 1);
    assert.equal(messages.length, 1, 'per-call policy must not accumulate in transcript messages');
    assert.equal((await counts()).context30d, 2);
    await fs.writeFile(file, '# Rules\\r\\nFRESH_WAKE_POLICY_V3\\r\\n');
    const next = await context({messages}, ctx);
    assert.match(next.messages.at(-1).content, /FRESH_WAKE_POLICY_V3/);
    assert.doesNotMatch(next.messages.at(-1).content, /FRESH_WAKE_POLICY_V2/);
    assert.equal(next.messages.length, messages.length + 1);
    assert.equal((await counts()).context30d, 3);
    const normal = await start(prompt, ctx);
    assert.match(normal.systemPrompt.at(-1), /FRESH_WAKE_POLICY_V3/);
    assert.equal(await context({messages}, ctx), undefined);
    assert.equal((await counts()).context30d, 4, 'ordinary prompts must not gain duplicate per-call receipts');
    aborted = false;
    await fs.rm(file);
    await assert.rejects(start({...prompt, reason: 'revive'}, ctx), /policy unavailable/);
    assert.equal(aborted, true);
    await assert.rejects(context({messages}, ctx), /policy unavailable/);
    await fs.writeFile(file, '# Rules\\r\\nFRESH_WAKE_POLICY_V3\\r\\n');
    assert.equal((await counts()).context30d, 4);
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program], {env: f.env, cwd: f.root, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
