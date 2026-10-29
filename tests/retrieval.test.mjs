import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {search, readNote, policies} from '../src/memory.mjs';

test('technical terms, scoped pagination, canonical revisions and heading anchors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-retrieval-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, 'Owner'), {recursive: true});
  const config = {vault, backupDir: path.join(root, 'backup'), projects: [{id: 'work', root: path.join(root, 'work')}]};
  const file = path.join(vault, 'Owner', 'api.md');
  await fs.writeFile(file, '# Topic\n\n## Port\nother\n\n## Port\nUse C++ and AI on port 42.\n');
  await fs.writeFile(path.join(vault, 'Owner', 'old.md'), '---\nstatus: stale\n---\n# Old\nAI\n');
  const result = await search(config, 'AI', {cwd: path.join(root, 'work'), limit: 1});
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].anchor, 'port-2');
  assert.equal(result.items[0].line, 7);
  assert.equal(result.items[0].revision, (await readNote(config, 'Owner/api.md')).revision);
  assert.equal((await search(config, 'AI', {offset: 1})).items.length, 0);
  assert.equal((await search(config, 'C++')).count, 1);
  await fs.writeFile(path.join(vault, 'Owner', 'sharp.md'), '# Language\nC# runtime.\n');
  assert.deepEqual((await search(config, 'C++')).items.map(note => note.path), ['Owner/api.md']);
  assert.deepEqual((await search(config, 'C#')).items.map(note => note.path), ['Owner/sharp.md']);
  await fs.writeFile(file, '# Topic\nReplacement DB fact.\n');
  assert.equal((await search(config, 'AI')).count, 0);
  assert.equal((await search(config, 'DB')).count, 1);
});

test('normalized ligatures, hashtags and heading-only matches return canonical evidence', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-retrieval-normalization-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, 'Owner'), {recursive: true});
  const config = {vault, backupDir: path.join(root, 'backup'), projects: []};
  await fs.writeFile(path.join(vault, 'Owner', 'Policies.md'), '# Policies\nRequired rules.\n');
  await fs.writeFile(path.join(vault, 'Owner', 'Preferences.md'), '# Preferences\nRequired preferences.\n');
  await fs.writeFile(path.join(vault, 'Owner', 'Café.md'), '# Intro\nUnrelated introduction.\n\n## Rollout\n\n#incident and a ﬀ ligature, café reference.\n');
  for (const query of ['ff', '#incident', 'incident']) {
    const result = await search(config, query);
    assert.equal(result.items[0].path, 'Owner/Café.md');
  }
  const heading = await search(config, 'rollout');
  assert.equal(heading.items[0].anchor, 'rollout');
  assert.equal(heading.items[0].line, 4);
  assert.match(await policies(config, root, 'cafe'), /REFERENCE Owner\/Café\.md[\s\S]*café reference/);
  assert.match(await policies(config, root, 'ff'), /REFERENCE Owner\/Café\.md[\s\S]*ﬀ ligature/);
});
