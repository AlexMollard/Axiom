import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveFromEditor, readNote } from '../src/memory.mjs';
import { serializeWorkspaceIcons } from '../src/workspace-icons.mjs';
import { configureOptimizer, optimizerConfigState, restoreTrash } from '../src/management.mjs';
import { getRecoveryStatus } from '../src/recovery.mjs';
import {
  sanitizeOptimizerSettings,
  inspectNoteRepoReferences,
  parseModelJson,
  detectFormatIssues,
  runMemoryOptimization,
} from '../src/optimizer.mjs';
import { createServer } from '../src/server.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-optimizer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const backupDir = path.join(root, 'backup');
  const repoRoot = path.join(root, 'repo-alpha');
  await fs.mkdir(path.join(vault, 'Owner'), { recursive: true });
  await fs.mkdir(path.join(vault, 'Agents', 'Memory', 'Projects', 'alpha'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'src', 'live.mjs'), 'export const answer = 42;\r\n// line 2\r\n');

  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({
    vault,
    backupDir,
    projects: [{ id: 'alpha', name: 'Alpha', root: repoRoot }],
  }, null, 2));

  const config = await loadConfig(configPath);
  await saveFromEditor(config, 'Home.md', '# Shared Brain\r\n', 'new');
  await saveFromEditor(config, 'Owner/Policies.md', '# Policies\r\n\r\nKeep clean.\r\n', 'new');
  await saveFromEditor(config, 'Agents/Workspace icons.md', serializeWorkspaceIcons({ alpha: 'code', global: 'globe', personal: 'user' }), 'new');
  return { root, vault, backupDir, repoRoot, config };
}

test('optimizer settings save with CAS and never expose stored apiKey', async t => {
  const { config } = await fixture(t);
  const initial = await optimizerConfigState(config);
  assert.equal(initial.settings.provider, 'auto');
  assert.notEqual(initial.settings.apiKeySource, 'config');
  assert.equal(Object.hasOwn(initial.settings, 'apiKey'), false);

  const saved = await configureOptimizer(config, {
    provider: 'openai',
    model: 'gpt-5.4',
    apiKey: 'sk-test-secret-12345',
    deepRepoCheck: true,
    maxNotesPerBatch: 12,
    timeoutMs: 120000,
  }, initial.configRevision);

  assert.equal(saved.settings.provider, 'openai');
  assert.equal(saved.settings.model, 'gpt-5.4');
  assert.equal(saved.settings.deepRepoCheck, true);
  assert.equal(saved.settings.hasApiKey, true);
  assert.equal(saved.settings.apiKeySource, 'config');
  assert.equal(Object.hasOwn(saved.settings, 'apiKey'), false);

  const sanitized = sanitizeOptimizerSettings(await loadConfig(config.configPath));
  assert.equal(Object.hasOwn(sanitized, 'apiKey'), false);
  assert.equal(sanitized.hasApiKey, true);
});

test('inspectNoteRepoReferences distinguishes existing vs missing files and respects deepRepoCheck', async t => {
  const { config, repoRoot } = await fixture(t);
  const note = await saveFromEditor(
    config,
    'Agents/Memory/Projects/alpha/ref-check.md',
    '---\r\ntitle: Repo ref\r\nproject: alpha\r\nsource: src/live.mjs\r\n---\r\n# Repo ref\r\n\r\nUses `src/live.mjs` and old `src/deleted.mjs`.\r\n',
    'new',
  );
  const light = await inspectNoteRepoReferences(note, [repoRoot], { deepRepoCheck: false });
  assert.deepEqual(light.existingPaths, ['src/live.mjs']);
  assert.deepEqual(light.missingPaths, ['src/deleted.mjs']);
  assert.equal(light.excerpts.length, 0);

  const deep = await inspectNoteRepoReferences(note, [repoRoot], { deepRepoCheck: true, excerptBudget: { remainingFiles: 4 } });
  assert.equal(deep.excerpts.length, 1);
  assert.match(deep.excerpts[0].snippet, /answer = 42/);
});

test('parseModelJson extracts JSON from raw or fenced model output', () => {
  const direct = parseModelJson('{"actions":[{"type":"keep","path":"Agents/a.md"}]}');
  assert.equal(direct.actions.length, 1);

  const fenced = parseModelJson('Here is the optimization plan:\n```json\n{"actions":[{"type":"trash","path":"Agents/b.md","reason":"stale"}]}\n```\nDone.');
  assert.equal(fenced.actions[0].type, 'trash');
});

test('detectFormatIssues identifies imported wrappers, nested YAML blocks, extract boilerplate, and em dashes', () => {
  assert.deepEqual(
    detectFormatIssues({
      content: '---\ntitle: Test\nproject: personal\n---\n# Clean Note\n\nConcise summary for agents.\n\n- Uses `src/app.mjs` cleanly.\n',
    }),
    [],
  );

  const issues = detectFormatIssues({
    content: [
      '---',
      'title: Legacy import',
      'project: global',
      '---',
      '# Legacy import',
      '',
      'Imported machine-maintained Claude memory; not owner-approved policy.',
      'Unreviewed extract from [original](old.md). Original source and snapshot are recorded in that note. Preserve historical context; this is not owner-approved policy.',
      '',
      '---',
      'name: dev-stack-profile',
      'description: "User stack \u2014 C++"',
      '---',
      '',
      'Real text with an em dash \u2014 here.',
    ].join('\n'),
  });
  assert.deepEqual(issues, ['imported-wrapper', 'embedded-yaml-frontmatter', 'unreviewed-extract-wrapper', 'em-dashes']);

  const linkIndexIssues = detectFormatIssues({
    content: [
      '---',
      'title: Overview list',
      'project: handball-src',
      '---',
      '# Overview list',
      '',
      '- [One](one.md) - summary one',
      '- [Two](two.md) - summary two',
      '- [Three](three.md) - summary three',
      '- [Four](four.md) - summary four',
    ].join('\n'),
  });
  assert.deepEqual(linkIndexIssues, ['link-index-wrapper']);
});

test('runMemoryOptimization snapshots first, applies edits/merges/trash recoverably, and enforces guardrails', async t => {
  const { config } = await fixture(t);
  const ownerNote = await readNote(config, 'Owner/Policies.md');
  const tidyNote = await saveFromEditor(
    config,
    'Agents/Memory/Projects/alpha/tidy.md',
    '---\r\ntitle: Tidy me\r\nproject: alpha\r\nsource: src/live.mjs\r\n---\r\n# Tidy me\r\n\r\nVerbose filler filler filler sentence about live.mjs.\r\n',
    'new',
  );
  const dupA = await saveFromEditor(
    config,
    'Agents/Memory/Projects/alpha/dup-a.md',
    '---\r\ntitle: Dup A\r\nproject: alpha\r\nsource: src/live.mjs\r\n---\r\n# Dup A\r\n\r\nPart one facts from live.mjs.\r\n',
    'new',
  );
  const dupB = await saveFromEditor(
    config,
    'Agents/Memory/Projects/alpha/dup-b.md',
    '---\r\ntitle: Dup B\r\nproject: alpha\r\nsource: src/live.mjs\r\n---\r\n# Dup B\r\n\r\nPart two facts from live.mjs.\r\n',
    'new',
  );
  const staleOriginalBody = '---\r\ntitle: Gone\r\nproject: alpha\r\nsource: src/deleted.mjs\r\n---\r\n# Gone\r\n\r\nObsolete details about deleted file.\r\n';
  const staleNote = await saveFromEditor(config, 'Agents/Memory/Projects/alpha/stale.md', staleOriginalBody, 'new');

  const dryReport = await runMemoryOptimization(config, {
    workspace: 'alpha',
    dryRun: true,
    invokeModel: async () => ({
      providerUsed: 'mock-opus',
      modelUsed: 'mock-opus-1',
      text: JSON.stringify({
        actions: [
          { type: 'update', path: tidyNote.path, expectedRevision: tidyNote.revision, reason: 'Tighten wording', content: '---\ntitle: Tidy me\nproject: alpha\nsource: src/live.mjs\n---\n# Tidy me\n\nConcise curated rule for src/live.mjs.\n' },
          { type: 'trash', path: staleNote.path, expectedRevision: staleNote.revision, reason: 'Referenced file missing' },
        ],
      }),
    }),
  });
  assert.equal(dryReport.snapshotId, null);
  assert.equal(dryReport.counts.updated, 1);
  assert.equal(dryReport.counts.trashed, 1);
  assert.equal((await readNote(config, tidyNote.path)).revision, tidyNote.revision);
  assert.equal((await readNote(config, staleNote.path)).revision, staleNote.revision);

  const report = await runMemoryOptimization(config, {
    workspace: 'alpha',
    dryRun: false,
    invokeModel: async () => ({
      providerUsed: 'mock-opus',
      modelUsed: 'mock-opus-1',
      text: JSON.stringify({
        actions: [
          { type: 'update', path: tidyNote.path, expectedRevision: tidyNote.revision, reason: 'Tighten wording', content: '---\ntitle: Tidy me\nproject: alpha\nsource: src/live.mjs\n---\n# Tidy me\n\nConcise curated rule for src/live.mjs.\n' },
          { type: 'merge', targetPath: dupA.path, expectedRevision: dupA.revision, sourcePaths: [{ path: dupB.path, expectedRevision: dupB.revision }], removeSources: 'trash', reason: 'Consolidate duplicate alpha notes', content: '---\ntitle: Consolidated Alpha\nproject: alpha\nsource: src/live.mjs\n---\n# Consolidated Alpha\n\nCombined part one and part two facts from src/live.mjs.\n' },
          { type: 'trash', path: staleNote.path, expectedRevision: staleNote.revision, reason: 'References missing src/deleted.mjs' },
          { type: 'trash', path: ownerNote.path, expectedRevision: ownerNote.revision, reason: 'Malicious owner delete test' },
          { type: 'update', path: 'Home.md', expectedRevision: 'bad', reason: 'Malicious Home edit test', content: '# Hijacked home page content should fail' },
        ],
      }),
    }),
  });

  assert.ok(report.snapshotId);
  const recovery = await getRecoveryStatus(config);
  assert.ok(recovery.snapshots.some(s => s.id === report.snapshotId));

  assert.equal(report.counts.updated, 1);
  assert.equal(report.counts.merged, 1);
  assert.equal(report.counts.trashed, 1);
  assert.equal(report.counts.skipped, 2);

  const updatedAfter = await readNote(config, tidyNote.path);
  assert.match(updatedAfter.content, /Concise curated rule/);
  const mergedAfter = await readNote(config, dupA.path);
  assert.match(mergedAfter.content, /Combined part one and part two/);
  await assert.rejects(readNote(config, dupB.path), { code: 'ENOENT' });
  await assert.rejects(readNote(config, staleNote.path), { code: 'ENOENT' });
  assert.match((await readNote(config, 'Owner/Policies.md')).content, /Keep clean/);

  const trashItem = report.applied.find(a => a.type === 'trash' && a.path === staleNote.path);
  assert.ok(trashItem?.trashId);
  await restoreTrash(config, trashItem.trashId);
  const restored = await readNote(config, staleNote.path);
  assert.equal(restored.content, staleOriginalBody);
});

test('runMemoryOptimization relocates misplaced notes cleanly and enforces move guardrails', async t => {
  const { config } = await fixture(t);
  const wrongWorkspaceBody = '---\r\ntitle: Dark mode taste\r\nproject: alpha\r\nsource: manual note\r\n---\r\n# Dark mode taste\r\n\r\nAlex prefers charcoal backgrounds with terracotta accents.\r\n';
  const misplaced = await saveFromEditor(config, 'Agents/Memory/Projects/alpha/dark-mode.md', wrongWorkspaceBody, 'new');
  const existing = await saveFromEditor(config, 'Agents/Memory/Projects/personal/already-here.md', '---\r\ntitle: Existing\r\nproject: personal\r\nsource: manual\r\n---\r\n# Existing\r\n\r\nAlready in personal workspace.\r\n', 'new');
  const ownerNote = await readNote(config, 'Owner/Policies.md');

  const report = await runMemoryOptimization(config, {
    dryRun: false,
    invokeModel: async prompt => {
      if (!prompt.includes('Workspace scope: alpha')) {
        return { providerUsed: 'mock-opus', modelUsed: 'mock-opus-1', text: JSON.stringify({ actions: [] }) };
      }
      return {
        providerUsed: 'mock-opus',
        modelUsed: 'mock-opus-1',
        text: JSON.stringify({
          actions: [
            {
              type: 'move',
              path: misplaced.path,
              expectedRevision: misplaced.revision,
              targetWorkspace: 'personal',
              targetPath: 'Agents/Memory/Projects/personal/dark-mode.md',
              reason: 'Personal UI preference saved inside alpha project',
              content: '---\ntitle: Dark mode taste\nproject: alpha\nsource: manual note\n---\n# Dark mode taste\n\nAlex prefers warm charcoal surfaces with terracotta accents.\n',
            },
            {
              type: 'move',
              path: misplaced.path,
              expectedRevision: misplaced.revision,
              targetWorkspace: 'global',
              targetPath: 'Agents/Workspace icons.md',
              reason: 'Target protected icon registry',
              content: '---\nproject: global\n---\n# Hack\n\nShould be blocked by protection guardrail.\n',
            },
            {
              type: 'move',
              path: existing.path,
              expectedRevision: existing.revision,
              targetWorkspace: 'alpha',
              targetPath: misplaced.path,
              reason: 'Colliding move test',
              content: existing.content,
            },
            {
              type: 'move',
              path: ownerNote.path,
              expectedRevision: ownerNote.revision,
              targetWorkspace: 'personal',
              targetPath: 'Agents/Memory/Projects/personal/stolen-owner.md',
              reason: 'Should never move owner notes',
              content: ownerNote.content,
            },
          ],
        }),
      };
    },
  });

  assert.equal(report.counts.moved, 1);
  assert.equal(report.counts.skipped, 2);

  const relocated = await readNote(config, 'Agents/Memory/Projects/personal/dark-mode.md');
  assert.equal(relocated.project, 'personal');
  assert.match(relocated.content, /project:\s*personal/);
  assert.match(relocated.content, /warm charcoal surfaces/);
  await assert.rejects(readNote(config, misplaced.path), { code: 'ENOENT' });

  const moveItem = report.applied.find(a => a.type === 'move' && a.outcome === 'applied');
  assert.ok(moveItem?.trashId);
  assert.equal(moveItem.fromWorkspace, 'alpha');
  assert.equal(moveItem.toWorkspace, 'personal');

  await restoreTrash(config, moveItem.trashId);
  assert.equal((await readNote(config, misplaced.path)).content, wrongWorkspaceBody);
});

test('optimizer HTTP endpoints enforce CSRF, expose sanitized settings, and track status', async t => {
  const { config } = await fixture(t);
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const session = await (await fetch(`${origin}/api/editor-session`)).json();
  const initialRes = await fetch(`${origin}/api/optimizer/settings`);
  assert.equal(initialRes.status, 200);
  const initial = await initialRes.json();
  assert.ok(Array.isArray(initial.providers));
  assert.notEqual(initial.settings.apiKeySource, 'config');
  assert.equal(Object.hasOwn(initial.settings, 'apiKey'), false);

  const unauthPut = await fetch(`${origin}/api/optimizer/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ provider: 'openai', expectedRevision: initial.configRevision }),
  });
  assert.equal(unauthPut.status, 403);

  const putRes = await fetch(`${origin}/api/optimizer/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin, 'x-shared-brain-csrf': session.token },
    body: JSON.stringify({
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      apiKey: 'AIzaTestSecretKey',
      deepRepoCheck: false,
      maxNotesPerBatch: 10,
      timeoutMs: 90000,
      expectedRevision: initial.configRevision,
    }),
  });
  assert.equal(putRes.status, 200);
  const updated = await putRes.json();
  assert.equal(updated.settings.provider, 'gemini');
  assert.equal(updated.settings.hasApiKey, true);
  assert.equal(Object.hasOwn(updated.settings, 'apiKey'), false);

  const statusRes = await fetch(`${origin}/api/optimizer/status`);
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.ok(Array.isArray(statusData.runs));
});
