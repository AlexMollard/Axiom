import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { getWorkspaceOverview, getMemoryHealth, getNoteKnowledge, getCaptureSuggestions } from '../src/knowledge.mjs';
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

test('knowledge resolves explicit relationships without guessing ambiguous links', async t => {
  const { config, note } = await fixture(t);
  await note(base + 'first.md', '---\nsupersedes: [[Old]]\nconflicts_with: [[Other]]\n---\n# Current design\nshared architecture');
  await note(base + 'old.md', '---\nsupersedes: [[Current design]]\n---\n# Old');
  await note(base + 'other.md', '# Other\nshared architecture');
  await note(base + 'ambiguous.md', '---\nsupersedes: [[Duplicate]]\n---\n# Ambiguous');
  await note(base + 'dup1.md', '# Duplicate');
  await note(base + 'dup2.md', '# Duplicate');
  const result = await getNoteKnowledge(config, base + 'first.md');
  assert.equal(result.timeline[0].note.path, base + 'old.md');
  assert.equal(result.timeline[0].relation, 'Replaces');
  assert.equal(result.timeline[0].sourcePath, base + 'first.md');
  assert.equal(result.timeline[0].targetPath, base + 'old.md');
  assert.equal(result.conflicts[0].note.path, base + 'other.md');
  assert(result.warnings.some(message => message.includes('cycle')));
  assert(result.overlaps.some(item => item.note.path === base + 'other.md'));
  const ambiguous = await getNoteKnowledge(config, base + 'ambiguous.md');
  assert.equal(ambiguous.timeline.length, 0);
  assert(ambiguous.warnings.some(message => message.includes('uniquely resolve')));
});

test('capture suggestions are scoped and exclude retired and proposal notes', async t => {
  const { config, note } = await fixture(t);
  await note(base + 'match.md', '# Cache design\ncache transaction architecture');
  await note(base + 'retired.md', '---\nstatus: superseded\n---\n# Cache design\ncache transaction');
  await note(base + 'stale.md', '---\nstatus: stale\n---\n# Cache design\ncache transaction');
  await note(base + 'proposal.md', '---\nkind: proposal\n---\n# Cache design\ncache transaction');
  await note('Agents/Handovers/hidden.md', '# Cache design\ncache transaction');
  await note('Agents/Memory/Projects/beta/private.md', '# Cache design\ncache transaction');
  await note('Owner/global.md', '# Cache design\ncache transaction');
  const result = await getCaptureSuggestions(config, { cwd: config.projects[0].root, path: base + 'new.md', content: '# Cache design\ncache transaction' });
  assert.equal(result.project, 'alpha');
  assert.deepEqual(new Set(result.items.map(item => item.note.path)), new Set([base + 'match.md', 'Owner/global.md']));
  const outside = await getCaptureSuggestions(config, { cwd: path.dirname(config.projects[0].root), content: '# Cache design\ncache transaction' });
  assert.deepEqual(outside.items.map(item => item.note.path), ['Owner/global.md']);
  await assert.rejects(getCaptureSuggestions(config, { content: 'x', limit: 0 }), /Limit/);
});

test('relationships and search candidates are not truncated by catalog order', async t => {
  const { config, note } = await fixture(t);
  for (let i = 0; i < 205; i++) await note(base + `a${String(i).padStart(3, '0')}.md`, '# Filler\nUnrelated.');
  await note(base + 'z-current.md', '---\nsupersedes: [[z-old]]\n---\n# Unique quasar\nquasar reactor');
  await note(base + 'z-old.md', '# Historical finding');
  await note(base + 'z-match.md', '# Unique quasar\nquasar reactor');
  const result = await getNoteKnowledge(config, base + 'z-current.md');
  assert.equal(result.timeline[0].note.path, base + 'z-old.md');
  assert(result.overlaps.some(item => item.note.path === base + 'z-match.md'));
  const suggestions = await getCaptureSuggestions(config, { cwd: config.projects[0].root, content: '# Unique quasar\nquasar reactor' });
  assert(suggestions.items.some(item => item.note.path === base + 'z-match.md'));
});
