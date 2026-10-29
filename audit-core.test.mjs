import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {catalog, readNote, saveFromEditor, search, policies} from './memory.mjs';
import {getNoteUsage} from './note-usage.mjs';
import {createServer, renderMarkdown} from './server.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-core-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const config = {vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup'), indexPath: path.join(root, 'index.json'), projects: []};
  await fs.mkdir(path.join(config.vault, 'Owner'), {recursive: true});
  await fs.writeFile(path.join(config.vault, 'Owner', 'Policies.md'), '# Rules\nRequired rule');
  await fs.writeFile(path.join(config.vault, 'Owner', 'Preferences.md'), '# Preferences\nRequired preference');
  return {root, config};
}
async function put(config, relative, content) {
  const file = path.join(config.vault, relative);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, content);
}

test('normalized over-limit saves leave canonical bytes and history untouched', async t => {
  const {config} = await fixture(t);
  await put(config, 'Owner/Existing.md', '# Existing\noriginal');
  const before = await readNote(config, 'Owner/Existing.md');
  await assert.rejects(saveFromEditor(config, before.path, 'x\n'.repeat(700000), before.revision), /2 MiB/);
  assert.equal((await readNote(config, before.path)).content, before.content);
  await assert.rejects(fs.stat(path.join(config.backupDir, 'history')), {code: 'ENOENT'});
  assert.ok((await catalog(config)).some(note => note.path === before.path));
  assert.equal((await search(config, 'original')).count, 1);
  assert.match((await saveFromEditor(config, before.path, '# Existing\nupdated', before.revision)).content, /updated/);
});

test('policy budget includes mandatory footer and records only delivered fresh matching references', async t => {
  const {config} = await fixture(t);
  await put(config, 'Agents/Memory/Long.md', '# Long\n' + 'unrelated '.repeat(450) + 'needleunique matching evidence');
  const result = await policies(config, process.cwd(), 'needleunique', {source: 'claude', maxBytes: 8192});
  assert.ok(Buffer.byteLength(result) <= 8192);
  assert.match(result, /needleunique matching evidence/);
  assert.match(result, new RegExp((await readNote(config, 'Agents/Memory/Long.md')).revision));
  const usages = await getNoteUsage(config, await catalog(config));
  assert.equal(usages.notes.find(n => n.path === 'Agents/Memory/Long.md').usage.context30d, 1);
  const mandatory = await policies(config, process.cwd(), '');
  const limited = await policies(config, process.cwd(), 'needleunique', {source: 'claude', maxBytes: Buffer.byteLength(mandatory)});
  assert.doesNotMatch(limited, /REFERENCE/);
  const limitedUsage = await getNoteUsage(config, await catalog(config));
  assert.equal(limitedUsage.notes.find(n => n.path === 'Agents/Memory/Long.md').usage.context30d, 1);
  await assert.rejects(policies(config, process.cwd(), '', {source: 'claude', maxBytes: 1}), /Required policies exceed/);
  const after = await getNoteUsage(config, await catalog(config));
  assert.equal(after.notes.find(n => n.path === 'Owner/Policies.md').usage.context30d, 2);
});

test('Unicode case expansion before a match does not displace search or context evidence', async t => {
  const {config} = await fixture(t);
  const content = '# Unicode\n' + 'İ'.repeat(1000) + '\nneedleunicode actual evidence';
  await put(config, 'Agents/Memory/Unicode.md', content);
  assert.match((await search(config, 'needleunicode')).items[0].excerpt, /needleunicode actual evidence/);
  assert.match((await search(config, 'needleunicode', {all: true})).items[0].excerpt, /needleunicode actual evidence/);
  const context = await policies(config, process.cwd(), 'needleunicode', {source: 'claude'});
  assert.match(context, /needleunicode actual evidence/);
  const usage = await getNoteUsage(config, await catalog(config));
  assert.equal(usage.notes.find(note => note.path === 'Agents/Memory/Unicode.md').usage.context30d, 1);
});

test('search scopes include inactive only when explicitly requested', async t => {
  const {config} = await fixture(t);
  await put(config, 'Agents/Proposals/Test.md', '# Scope\nuniquescope');
  assert.equal((await search(config, 'uniquescope')).count, 0);
  assert.equal((await search(config, 'uniquescope', {all: true, includeInactive: true})).count, 1);
  const server = createServer(config);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/search?q=uniquescope`;
  assert.equal((await (await fetch(base)).json()).count, 1);
  assert.equal((await (await fetch(base + '&scope=active')).json()).count, 0);
  assert.equal((await fetch(base + '&scope=wrong')).status, 400);
});

test('section links preserve fragments and same-note anchors do not create graph nodes', () => {
  const notes = [{path: 'Home.md', title: 'Home'}, {path: 'Other.md', title: 'Other'}];
  const graph = {targets: new Set(), unresolvedCount: 0};
  const html = renderMarkdown('# Current Heading\n[[#Current Heading]] [[Other#Next Heading]] [other](Other.md#next-heading) [local](#current-heading)', 'Home.md', notes, graph);
  assert.match(html, /href="\/?\?note=Home.md#current-heading"/);
  assert.match(html, /href="\/?\?note=Other.md#next-heading"/);
  assert.match(html, /href="#current-heading"/);
  assert.deepEqual([...graph.targets], ['Other.md']);
  assert.equal(graph.unresolvedCount, 0);
});

test('link resolution preserves path precedence and ambiguous aliases', () => {
  const notes = [
    {path: 'folder/Home.md', title: 'Home'},
    {path: 'folder/Topic.md', title: 'Local'},
    {path: 'Topic.md', title: 'Root'},
    {path: 'folder/Space Name.md', title: 'Space Name'},
    {path: 'elsewhere/Unique.md', title: 'Unique'},
    {path: 'one/Foo.md', title: 'Shared'},
    {path: 'two/Bar.md', title: 'SHARED'},
    {path: 'Dupe.md', title: 'First'},
    {path: 'dupe.MD', title: 'Second'},
  ];
  const content = '[[tOpIc]] [[/TOPIC]] [[Space%20Name?x#Heading]] [[unique]] [[shared]] [[dupe]] [[%ZZ]] [[https://example.com]]';
  for (let i = 0; i < 2; i++) {
    const graph = {targets: new Set(), unresolvedCount: 0};
    const html = renderMarkdown(content, 'folder/Home.md', notes, graph);
    assert.deepEqual([...graph.targets], ['folder/Topic.md', 'Topic.md', 'folder/Space Name.md', 'elsewhere/Unique.md']);
    assert.equal(graph.unresolvedCount, 3);
    assert.match(html, /href="\/\?note=folder%2FSpace%20Name.md#heading"/);
    assert.doesNotMatch(html, /note=(?:one%2FFoo|two%2FBar|Dupe|dupe)/i);
  }
});

test('heading ids use visible link, code and emphasis text and retain duplicate numbering', () => {
  const notes = [{path: 'Home.md', title: 'Home'}];
  const html = renderMarkdown('## [Install](https://example.com)\n## `Install`\n## *Install*\n[[#Install]]', 'Home.md', notes);
  assert.match(html, /id="install"/);
  assert.match(html, /id="install-2"/);
  assert.match(html, /id="install-3"/);
  assert.match(html, /href="\/\?note=Home.md#install"/);
  assert.doesNotMatch(html, /install-https-example-com/);
});

test('unwritable derivative index does not hide canonical content or canonical errors', async t => {
  const {root, config} = await fixture(t);
  await put(config, 'Owner/Evidence.md', '# Evidence\ncacheprobe');
  await fs.writeFile(path.join(root, 'blocked'), 'file');
  config.indexPath = path.join(root, 'blocked', 'index.json');
  assert.ok((await catalog(config)).some(n => n.path === 'Owner/Evidence.md'));
  assert.equal((await search(config, 'cacheprobe')).count, 1);
  assert.match(await policies(config, process.cwd(), 'cacheprobe'), /cacheprobe/);
  await put(config, 'Owner/Huge.md', 'a'.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(catalog(config), /2 MiB/);
});

test('successful reads use filesystem identity for usage receipts', async t => {
  const {config} = await fixture(t);
  await put(config, 'Owner/CaseNote.md', '# Case note');
  if (process.platform !== 'win32') await put(config, 'Owner/casenote.md', '# Distinct note');
  const requested = process.platform === 'win32' ? 'Owner/casenote.md' : 'Owner/CaseNote.md';
  const note = await readNote(config, requested, {source: 'omp'});
  assert.equal(note.path, 'Owner/CaseNote.md');
  const usage = await getNoteUsage(config, await catalog(config));
  assert.equal(usage.notes.find(n => n.path === 'Owner/CaseNote.md').usage.reads30d, 1);
  if (process.platform !== 'win32') assert.equal(usage.notes.find(n => n.path === 'Owner/casenote.md').usage.reads30d, 0);
});
