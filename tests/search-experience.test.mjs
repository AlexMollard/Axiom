import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { search } from '../src/memory.mjs';
import { serializeReviewLedger } from '../src/note-reviews.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  await fs.mkdir(path.join(vault, 'Agents'), { recursive: true });
  const config = { vault, backupDir: path.join(root, 'backup'), projects: [{ id: 'work', root: path.join(root, 'work') }, { id: 'home', root: path.join(root, 'home') }] };
  async function note(relative, content) {
    const file = path.join(vault, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return { root, config, note };
}

test('filters apply before pagination across the entire ranked corpus', async t => {
  const { config, note } = await fixture(t);
  for (let i = 0; i < 115; i++) await note(`Agents/${String(i).padStart(3, '0')}.md`, `---\nproject: work\n---\n# Entry\nquartz evidence\n`);
  await note('Owner/Target.md', '---\nproject: home\n---\n# Target\nquartz evidence\n');
  const target = await search(config, 'quartz', { all: true, owner: 'owner', workspace: 'home', limit: 1 });
  assert.equal(target.total, 1); assert.equal(target.items[0].path, 'Owner/Target.md'); assert.equal(target.hasMore, false);
  const first = await search(config, 'quartz', { all: true, workspace: 'work', limit: 100 });
  const second = await search(config, 'quartz', { all: true, workspace: 'work', limit: 100, offset: 100 });
  assert.equal(first.total, 115); assert.equal(first.items.length, 100); assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 15); assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.path)).size, 115);
});

test('native scope and excluded notes remain unchanged; review uses ledger not status', async t => {
  const { root, config, note } = await fixture(t);
  const approved = '---\nproject: work\nstatus: unreviewed\n---\n# Approved\nquartz evidence\n';
  await note('Agents/Approved.md', approved);
  await note('Agents/Pending.md', '---\nproject: work\nstatus: reviewed\n---\n# Pending\nquartz evidence\n');
  await note('Agents/Home.md', '---\nproject: home\n---\nquartz evidence\n');
  await note('Agents/Proposals/Hidden.md', 'quartz evidence');
  await note('Agents/Handovers/Hidden.md', 'quartz evidence');
  await note('Agents/Archived.md', '---\nstatus: archived\n---\nquartz evidence');
  await note('Owner/Reviews.md', serializeReviewLedger({ 'Agents/Approved.md': { revision: createHash('sha256').update(approved).digest('hex'), reviewedAt: '2026-01-01T00:00:00.000Z', approved: true } }));
  const scoped = await search(config, 'quartz', { cwd: path.join(root, 'work') });
  assert.deepEqual(scoped.items.map(item => item.path).sort(), ['Agents/Approved.md', 'Agents/Pending.md']);
  const reviewed = await search(config, 'quartz', { all: true, review: 'reviewed' });
  assert.deepEqual(reviewed.items.map(item => item.path), ['Agents/Approved.md']);
  const pending = await search(config, 'quartz', { all: true, workspace: 'work', review: 'unreviewed' });
  assert.deepEqual(pending.items.map(item => item.path), ['Agents/Pending.md']);
  await note('Agents/Approved.md', approved + 'changed fresh passage\n');
  const changed = await search(config, 'quartz', { all: true, review: 'unreviewed', workspace: 'work' });
  assert.equal(changed.total, 2);
  assert.match(changed.items.find(item => item.path === 'Agents/Approved.md').excerpt, /changed fresh passage/);
});

test('browser passages show matching prose without metadata or a duplicated title', async t => {
  const {config, note} = await fixture(t);
  await note('Agents/Passage.md', '---\nproject: work\nsource: fixture source\ntitle: Amber finding\n---\n# Amber finding\n\nThe amber service listens on port 4031.\n');
  const result = await search(config, 'amber', {all: true});
  assert.match(result.items[0].excerpt, /amber service listens on port 4031/);
  assert.doesNotMatch(result.items[0].excerpt, /project:|source:|Amber finding/);
});
