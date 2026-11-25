import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, catalog, writeNote, saveFromEditor, search, policies } from '../src/memory.mjs';
import { readWorkspaceIcons, serializeWorkspaceIcons } from '../src/workspace-icons.mjs';
import { workspaceDetail, updateWorkspace, deleteWorkspace } from '../src/management.mjs';
import { getCleanup } from '../src/cleanup.mjs';
import { getMemoryHealth, getWorkspaceOverview, getCaptureSuggestions } from '../src/knowledge.mjs';
import { buildWorkspaceGraph } from '../src/workspace-graph.mjs';
import { createServer, renderMarkdown } from '../src/server.mjs';

async function fixture(t, { sqlite = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-personal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const backupDir = path.join(root, 'backups');
  const configPath = path.join(root, 'config.json');
  await fs.mkdir(path.join(vault, 'Owner'), { recursive: true });
  await fs.mkdir(path.join(vault, 'Agents'), { recursive: true });
  await fs.writeFile(path.join(vault, 'Owner', 'Policies.md'), '# Policies\r\nNever deploy automatically.\r\n');
  await fs.writeFile(path.join(vault, 'Owner', 'Preferences.md'), '# Preferences\r\nCite evidence.\r\n');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      vault,
      backupDir,
      projects: [
        { id: 'alpha', root: path.join(root, 'alpha') },
        { id: 'beta', root: path.join(root, 'beta') },
      ],
      port: 0,
    }),
  );
  const config = await loadConfig(configPath);
  if (!sqlite) config.indexPath = path.join(root, 'index.json');
  return { root, vault, config };
}

test('personal workspace appears in /api/catalog top-level and stays outside work/home', async t => {
  const { config } = await fixture(t);
  await saveFromEditor(config, 'Agents/Workspace icons.md', serializeWorkspaceIcons({ global: 'library' }), 'new');
  await writeNote(config, 'Agents/Memory/Projects/personal/prefs.md', '# Prefs\r\nUse dark theme.\r\n', 'new', 'user');
  await saveFromEditor(config, 'Owner/Notes/about.md', '---\r\nproject: personal\r\n---\r\n# About Alex\r\nPrefers concise diffs.\r\n', 'new');

  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const res = await fetch(`http://127.0.0.1:${config.port}/api/catalog`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.workspaceNames.personal, 'Personal');
  assert.equal(body.workspaceGroups.personal, 'personal');
  assert.notEqual(body.workspaceGroups.personal, 'work');
  assert.notEqual(body.workspaceGroups.personal, 'home');

  const personalProject = body.projects.find(p => p.id === 'personal');
  assert.ok(personalProject);
  assert.equal(personalProject.name, 'Personal');
  assert.equal(personalProject.icon, 'user');
  assert.equal(personalProject.group, 'personal');

  const personalNotes = body.notes.filter(n => n.project === 'personal').map(n => n.path).sort();
  assert.deepEqual(personalNotes, ['Agents/Memory/Projects/personal/prefs.md', 'Owner/Notes/about.md']);
});

test('personal workspace is protected from deletion and updates keep it top-level', async t => {
  const { config } = await fixture(t);
  await saveFromEditor(config, 'Agents/Workspace icons.md', serializeWorkspaceIcons({ global: 'library' }), 'new');

  await assert.rejects(
    writeNote(config, 'Agents/Memory/Projects/personal/first.md', '# First\r\nHello.\r\n', 'new'),
    /needs an icon/,
  );
  await writeNote(config, 'Agents/Memory/Projects/personal/first.md', '# First\r\nHello.\r\n', 'new', 'user');
  assert.equal((await readWorkspaceIcons(config)).assignments.personal, 'user');

  const initial = await workspaceDetail(config, 'personal');
  assert.equal(initial.id, 'personal');
  assert.equal(initial.name, 'Personal');
  assert.equal(initial.group, 'personal');
  assert.equal(initial.isSystem, true);
  assert.match(initial.deleteBlockedReason || '', /cannot be deleted/i);

  await assert.rejects(deleteWorkspace(config, 'personal', initial.revision), /cannot be deleted/i);

  const updated = await updateWorkspace(config, {
    id: 'personal',
    name: 'Alex Personal',
    icon: 'user-round',
    group: 'home',
    expectedRevision: initial.revision,
  });
  assert.equal(updated.name, 'Alex Personal');
  assert.equal(updated.icon, 'user-round');
  assert.equal(updated.group, 'personal');

  const persisted = await loadConfig(config.configPath);
  assert.equal(persisted.workspaceNames?.personal, 'Alex Personal');
  assert.equal(persisted.workspaceGroups?.personal, undefined);
});

for (const sqlite of [false, true]) {
  test(`scoped search (${sqlite ? 'SQLite FTS5' : 'JS index'}) returns personal with global and active project while preserving referencesOnly`, async t => {
    const { root, config } = await fixture(t, { sqlite });
    await saveFromEditor(config, 'Agents/Workspace icons.md', serializeWorkspaceIcons({ global: 'library', personal: 'user', alpha: 'boxes', beta: 'anvil' }), 'new');
    await saveFromEditor(config, 'Owner/global.md', '# Global\r\npersonalsearchprobe global entry.\r\n', 'new');
    await writeNote(config, 'Agents/Memory/Projects/personal/pref.md', '# Personal pref\r\npersonalsearchprobe personal preference.\r\n', 'new');
    await saveFromEditor(config, 'Owner/Notes/about.md', '---\r\nproject: personal\r\n---\r\n# About\r\npersonalsearchprobe owner personal.\r\n', 'new');
    await writeNote(config, 'Agents/Memory/Projects/alpha/alpha.md', '# Alpha\r\npersonalsearchprobe alpha project.\r\n', 'new');
    await writeNote(config, 'Agents/Memory/Projects/beta/beta.md', '# Beta\r\npersonalsearchprobe beta private.\r\n', 'new');

    const alphaRoot = path.join(root, 'alpha');
    const scoped = await search(config, 'personalsearchprobe', { cwd: alphaRoot });
    assert.deepEqual(
      scoped.items.map(item => item.path).sort(),
      [
        'Agents/Memory/Projects/alpha/alpha.md',
        'Agents/Memory/Projects/personal/pref.md',
        'Owner/Notes/about.md',
        'Owner/global.md',
      ],
    );

    const unmapped = await search(config, 'personalsearchprobe', { all: true, workspace: '__unmapped' });
    assert.equal(unmapped.count, 0);

    const refOnly = await policies(config, alphaRoot, 'personalsearchprobe alpha project', {
      source: 'claude',
      referencesOnly: true,
    });
    assert.match(refOnly, /Agents\/Memory\/Projects\/alpha\/alpha\.md/);
    assert.doesNotMatch(refOnly, /personal\/pref\.md|Owner\/Notes\/about\.md|Owner\/global\.md|beta\.md/);
  });
}

test('cleanup, memory health, capture suggestions, overview and graph recognize personal', async t => {
  const { config } = await fixture(t);
  await saveFromEditor(config, 'Agents/Workspace icons.md', serializeWorkspaceIcons({ global: 'library', personal: 'user' }), 'new');
  await writeNote(config, 'Agents/Memory/Projects/personal/overlap.md', '---\r\nsource: interview\r\n---\r\n# Punctuation style\r\nAvoid em dashes in responses and code.\r\n', 'new');
  await writeNote(config, 'Agents/Memory/Projects/personal/empty.md', '---\r\nstatus: unreviewed\r\n---\r\n# Empty\r\n', 'new');

  const health = await getMemoryHealth(config, renderMarkdown);
  assert.equal(health.ambiguous.some(note => note.project === 'personal'), false);

  const overview = await getWorkspaceOverview(config, 'personal');
  assert.equal(overview.id, 'personal');
  assert.equal(overview.noteCount, 2);

  const capture = await getCaptureSuggestions(config, {
    workspace: 'personal',
    path: 'Agents/Memory/Projects/personal/candidate.md',
    content: '# Punctuation style\r\nAvoid em dashes in code.\r\n',
  });
  assert.equal(capture.project, 'personal');
  assert.ok(capture.items.some(item => item.note.path === 'Agents/Memory/Projects/personal/overlap.md'));

  const graph = await buildWorkspaceGraph(config, 'personal', renderMarkdown);
  assert.equal(graph.nodes.length, 2);
  assert.ok(graph.nodes.every(node => node.workspaceId === 'personal'));
  assert.equal((await buildWorkspaceGraph(config, '__unmapped', renderMarkdown)).nodes.length, 0);

  const scan = await getCleanup(config, 'personal', renderMarkdown);
  assert.equal(scan.counts.empty, 1);

  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = `http://127.0.0.1:${config.port}`;
  const { token } = await (await fetch(`${base}/api/editor-session`)).json();
  const emptyNote = (await catalog(config)).find(n => n.path === 'Agents/Memory/Projects/personal/empty.md');
  const del = await fetch(`${base}/api/note`, {
    method: 'DELETE',
    headers: { origin: base, 'content-type': 'application/json', 'x-shared-brain-csrf': token },
    body: JSON.stringify({ path: emptyNote.path, expectedRevision: emptyNote.revision, cleanup: true }),
  });
  assert.equal(del.status, 200);
});
