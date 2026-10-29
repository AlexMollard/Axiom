import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeHarness, getHarnessStatus } from '../src/harness-status.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-harness-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, config: { vault: path.join(root, 'vault'), configPath: path.join(root, 'config.json'), harnessHome: path.join(root, 'home') } };
}

test('observations are vault-scoped, bounded and contain no task content', async t => {
  const { root, config } = await fixture(t);
  assert.equal(await observeHarness(config, 'omp', 'input'), true);
  assert.equal(await observeHarness(config, 'claude', 'UserPromptSubmit'), true);
  assert.equal(await observeHarness(config, 'claude', 'secret prompt'), false);
  const result = await getHarnessStatus(config);
  assert.equal(result.harnesses[0].observation.last.event, 'input');
  assert.equal(result.harnesses[1].observation.last.event, 'UserPromptSubmit');
  const other = await getHarnessStatus({ ...config, vault: path.join(root, 'other') });
  assert.equal(other.harnesses[0].observation.available, false);
  assert.equal(result.harnesses[0].qualification, null);
  const dir = path.join(root, '.state', (await fs.readdir(path.join(root, '.state')))[0]);
  for (const file of await fs.readdir(dir)) assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))).sort(), ['at', 'event', 'id', 'outcome']);
  for (let i = 0; i < 105; i++) await observeHarness(config, 'omp', 'input');
  assert.ok((await fs.readdir(dir)).length <= 100);
  assert.equal((await getHarnessStatus(config)).harnesses[1].observation.last?.event, 'UserPromptSubmit');
});

test('invalid or disabled configuration is not reported as connected', async t => {
  const { config } = await fixture(t);
  const claude = path.join(config.harnessHome, '.claude');
  const extension = path.join(config.harnessHome, '.omp', 'agent', 'extensions');
  await fs.mkdir(claude, { recursive: true });
  await fs.mkdir(extension, { recursive: true });
  await fs.writeFile(path.join(claude, 'settings.json'), JSON.stringify({ hooks: {}, disableAllHooks: true }));
  await fs.writeFile(path.join(extension, 'shared-brain.ts'), 'export {default} from "./wrong.ts";');
  const result = await getHarnessStatus(config);
  assert.equal(result.harnesses[0].installation.configured, false);
  assert.equal(result.harnesses[1].installation.configured, false);
  assert.match(result.harnesses[1].installation.detail, /disabled/);
});

test('legacy observation has unknown outcome while new observation records success', async t => {
  const { root, config } = await fixture(t);
  await observeHarness(config, 'claude', 'SessionStart');
  const dir = path.join(root, '.state', (await fs.readdir(path.join(root, '.state')))[0]);
  const file = path.join(dir, (await fs.readdir(dir))[0]);
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  delete record.outcome;
  await fs.writeFile(file, JSON.stringify(record));
  assert.equal((await getHarnessStatus(config)).harnesses[1].observation.last.outcome, 'unknown');
  await observeHarness(config, 'omp', 'input');
  assert.equal((await getHarnessStatus(config)).harnesses[0].observation.last.outcome, 'success');
});

test('observation write failure does not throw or claim a successful observation', async t => {
  const { root, config } = await fixture(t);
  await fs.writeFile(path.join(root, '.state'), 'not a directory');
  assert.equal(await observeHarness(config, 'omp', 'input'), false);
  const result = await getHarnessStatus(config);
  assert.equal(result.harnesses[0].observation.available, false);
  assert.equal(result.harnesses[0].observation.last, null);
});

test('Claude installation requires the full command and exact matcher', async t => {
  const { config } = await fixture(t);
  const dir = path.join(config.harnessHome, '.claude');
  await fs.mkdir(dir, { recursive: true });
  const target = fileURLToPath(new URL('../integrations/claude-hook.mjs', import.meta.url)).replace(/\\/g, '/');
  const command = `"${process.execPath.replace(/\\/g, '/')}" "${target}"`;
  const handler = { type: 'command', command };
  const hooks = Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'SubagentStart'].map(event => [event, [{ hooks: [handler] }]]));
  hooks.PreToolUse = [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [handler] }];
  const file = path.join(dir, 'settings.json');
  const status = async settings => {
    await fs.writeFile(file, JSON.stringify(settings));
    return (await getHarnessStatus(config)).harnesses[1].installation.configured;
  };
  assert.equal(await status({ hooks }), true);
  assert.equal(await status({ hooks, disableAllHooks: true }), false);
  assert.equal(await status({ hooks: { ...hooks, PreToolUse: [{ matcher: 'Write', hooks: [handler] }] } }), false);
  assert.equal(await status({ hooks: { ...hooks, SessionStart: [{ hooks: [{ type: 'command', command: process.execPath, args: [target] }] }] } }), false);
});

test('qualification reads private adjacent evidence only for the configured vault', async t => {
  const { root, config } = await fixture(t);
  await fs.writeFile(config.configPath, JSON.stringify({ vault: config.vault }));
  const dir = path.join(root, '.state', 'first-note-evidence');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({ result: { code: 0 }, unique: true, proofs: { gamma: true, delta: true } }));
  assert.ok((await getHarnessStatus(config)).harnesses[0].qualification);
  assert.equal((await getHarnessStatus({ ...config, vault: path.join(root, 'fixture-vault') })).harnesses[0].qualification, null);
  assert.equal((await getHarnessStatus({ ...config, configPath: path.join(root, 'other', 'config.json') })).harnesses[0].qualification, null);
});
