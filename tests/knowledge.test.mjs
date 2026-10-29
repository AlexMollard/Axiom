import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getWorkspaceOverview, getMemoryHealth } from '../src/knowledge.mjs';
import { renderMarkdown } from '../src/server.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-knowledge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { vault: path.join(root, 'vault'), backupDir: path.join(root, 'backup'), indexPath: path.join(root, 'index.json'), projects: [{ id: 'alpha', root: path.join(root, 'alpha') }, { id: 'beta', root: path.join(root, 'beta') }], workspacePins: {} };
  await fs.mkdir(config.vault);
  async function note(name, content) {
    const file = path.join(config.vault, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return { config, note };
}
const base = 'Agents/Memory/Projects/alpha/';

test('overview scopes notes, decisions, proposals, activity and stale pins', async t => {
  const { config, note } = await fixture(t);
  await note(base + 'architecture.md', '# Architecture\nOverview only.');
  await note(base + 'choice.md', '---\nkind: decision\n---\n# Choice');
  await note(base + 'record.md', '# Record\n## Decision\nUse it.');
  await note(base + 'proposal.md', '---\nkind: proposal\n---\n# Proposal');
  await note('Agents/Memory/Projects/beta/other.md', '---\nkind: decision\n---\n# Other');
  config.workspacePins.alpha = [base + 'choice.md', 'Agents/Memory/Projects/beta/other.md', base + 'deleted.md'];
  const result = await getWorkspaceOverview(config, 'alpha');
  assert.equal(result.noteCount, 4);
  assert.deepEqual(new Set(result.decisions.map(item => item.path)), new Set([base + 'choice.md', base + 'record.md']));
  assert.deepEqual(result.proposals.map(item => item.path), [base + 'proposal.md']);
  assert.equal(result.activity.length, 4);
  assert.equal(result.pins[0].note.path, base + 'choice.md');
  assert(result.pins[1].stale && result.pins[2].stale);
  assert.equal((await getWorkspaceOverview(config, 'beta')).noteCount, 1);
  await assert.rejects(getWorkspaceOverview(config, 'missing'), /Unknown workspace/);
});

test('health uses rendered links and explicit provenance and relationships', async t => {
  const { config, note } = await fixture(t);
  await note(base + 'first.md', '---\nsource: Design meeting\nconflicts_with: [[Second]]\nsupersedes: [[Old]]\n---\n# First\n[[Missing]] [[Duplicate]] `[[InlineMissing]]`\n```md\n[[FenceMissing]]\n```\n[External](https://example.com/missing.md)');
  await note(base + 'second.md', '# Second\nSource: issue 42');
  await note(base + 'third.md', '# Third\n## Provenance\nA recorded conversation.');
  await note(base + 'unsourced.md', '# Unsourced\n`Source: fake`\n```\nSource: fake\n```');
  await note('one/Duplicate.md', '# Duplicate');
  await note('two/Duplicate.md', '# Duplicate');
  await note('Agents/Memory/Imported/loose.md', '# Loose');
  await note(base + 'same-one.md', '# Shared title');
  await note(base + 'same-two.md', '# Shared-title');
  await note('Agents/Memory/Projects/beta/same.md', '# Shared title');
  const result = await getMemoryHealth(config, renderMarkdown);
  assert.deepEqual(result.brokenLinks.map(item => [item.note.path, item.count]), [[base + 'first.md', 2]]);
  assert.deepEqual(result.conflicts.map(item => [item.note.path, item.reference]), [[base + 'first.md', '[[Second]]']]);
  assert.deepEqual(result.superseded.map(item => [item.note.path, item.reference]), [[base + 'first.md', '[[Old]]']]);
  assert(result.ambiguous.some(item => item.path.endsWith('/loose.md')));
  const missing = new Set(result.missingSources.map(item => item.path));
  assert(missing.has(base + 'unsourced.md'));
  assert(!missing.has(base + 'first.md') && !missing.has(base + 'second.md') && !missing.has(base + 'third.md'));
  const overlap = result.possibleOverlaps.find(item => item.notes.some(n => n.path === base + 'same-one.md'));
  assert.deepEqual(new Set(overlap.notes.map(item => item.path)), new Set([base + 'same-one.md', base + 'same-two.md']));
  assert(!result.conflicts.some(item => item.note.path === base + 'same-one.md'));
});

test('workspace proposal overview excludes explicitly resolved decisions', async t => {
  const {config, note} = await fixture(t);
  await note(base + 'open.md', '---\nkind: proposal\nstatus: proposal\n---\n# Open proposal');
  for (const status of ['accepted', 'rejected', 'resolved', 'closed']) await note(base + status + '.md', `---\nkind: proposal\nstatus: ${status}\n---\n# ${status}`);
  assert.deepEqual((await getWorkspaceOverview(config, 'alpha')).proposals.map(item => item.path), [base + 'open.md']);
});
