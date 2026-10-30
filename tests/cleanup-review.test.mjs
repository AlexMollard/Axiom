import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decisionKey, readDecisions, writeDecisions, buildHandoff, buildAnalysisPack} from '../client/src/cleanup-review.mjs';

const item = (revision = 'rev-a', category = 'merge') => ({id: 'pair', category, reason: 'Possible overlap', recommendation: 'Compare sources', notes: [
  {path: 'Agents/a.md', revision, owner: 'agent', project: 'alpha', content: 'SECRET FULL CONTENT'},
  {path: 'Owner/b.md', revision: 'rev-b', owner: 'owner', project: 'alpha'},
], evidence: {methods: ['semantic'], semanticSimilarity: 0.9, passages: [{path: 'Agents/a.md', heading: 'Section', excerpt: 'Short evidence'}]}});
const decision = (value = 'approved', targetPath = null) => ({decision: value, instructions: 'Compare carefully', targetPath, updatedAt: '2026-10-30T00:00:00Z'});
const storage = () => { const data = new Map(); return {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), data}; };
const report = (items, decisions) => buildHandoff({vaultId: 'vault-a', workspace: 'alpha', items, decisions, generatedAt: '2026-10-30T00:00:00Z'});

test('approval is tied to category, id, and sorted source revisions', () => {
  const original = item(), changed = item('rev-new');
  assert.equal(decisionKey(original), decisionKey({...original, notes: [...original.notes].reverse()}));
  assert.notEqual(decisionKey(original), decisionKey(changed));
  assert.notEqual(decisionKey(original), decisionKey(item('rev-a', 'duplicate')));
  const result = report([changed], {[decisionKey(original)]: decision()});
  assert.equal(result.items[0].decision, 'undecided');
  assert.equal(result.items[0].actionable, false);
  assert.equal(result.items.length, 1);
});

test('storage isolates vaults and propagates unavailable storage', () => {
  const store = storage(), key = decisionKey(item());
  writeDecisions(store, 'vault-a', {[key]: decision()});
  assert.equal(readDecisions(store, 'vault-a')[key].decision, 'approved');
  assert.equal(readDecisions(store, 'vault-b')[key], undefined);
  assert.throws(() => writeDecisions(store, '', {}));
  assert.throws(() => readDecisions(store, '  '));
  assert.throws(() => readDecisions({getItem() { throw new Error('blocked'); }}, 'vault-a'), /blocked/);
  assert.throws(() => writeDecisions({setItem() { throw new Error('quota'); }}, 'vault-a', {}), /quota/);
});

test('malformed and prototype records are ignored', () => {
  const store = storage();
  writeDecisions(store, 'v', {});
  const key = [...store.data.keys()][0];
  store.data.set(key, '{invalid');
  assert.deepEqual(Object.keys(readDecisions(store, 'v')), []);
  store.data.set(key, JSON.stringify({__proto__: null, constructor: decision(), valid: decision(), bad: {decision: 'approved'}, wrong: {...decision(), targetPath: []}}));
  assert.deepEqual(Object.keys(readDecisions(store, 'v')), ['valid']);
  const inherited = Object.create({inherited: decision()}); inherited.own = decision();
  writeDecisions(store, 'v', inherited);
  assert.deepEqual(Object.keys(readDecisions(store, 'v')), []);
});

test('brief limits action, targets, evidence and owner permissions', () => {
  const approved = item(), rejected = {...item('rejected'), id: 'reject'}, undecided = {...item('undecided'), id: 'pending'}, empty = {...item('empty', 'empty'), id: 'empty'};
  const result = report([approved, rejected, undecided, empty], {
    [decisionKey(approved)]: decision('approved', 'outside.md'),
    [decisionKey(rejected)]: decision('rejected'),
    [decisionKey(empty)]: decision('approved'),
    [decisionKey(item('old'))]: decision(),
  });
  assert.deepEqual(result.items.map(entry => entry.actionable), [false, false, false, false]);
  assert.deepEqual(result.items.map(entry => entry.execution), ['human-proposal', 'none', 'none', 'none']);
  assert.deepEqual(result.items.map(entry => entry.decision), ['approved', 'rejected', 'undecided', 'approved']);
  assert.equal(result.items[0].targetPath, null);
  assert.equal(result.items[0].notes[1].owner, 'owner');
  assert.equal(result.items[0].notes[0].revision, 'rev-a');
  assert.equal(result.items[0].evidence.passages[0].excerpt, 'Short evidence');
  assert(!JSON.stringify(result).includes('SECRET FULL CONTENT'));
  const withTarget = report([approved], {[decisionKey(approved)]: decision('approved', 'Agents/a.md')});
  assert.equal(withTarget.items[0].targetPath, 'Agents/a.md');
});

test('approved agent-only pairs can merge but control-note and owner paths remain proposal-only', () => {
  const agentPair = {...item(), notes: [item().notes[0], {path: 'Agents/b.md', owner: 'agent', revision: 'rev-b', project: 'alpha'}]};
  const controlPair = {...agentPair, id: 'control', notes: [agentPair.notes[0], {...agentPair.notes[1], path: 'Agents/Workspace icons.md'}]};
  const ownerPathPair = {...agentPair, id: 'owner-path', notes: [agentPair.notes[0], {...agentPair.notes[1], path: 'Owner/Notes/b.md'}]};
  const items = [agentPair, controlPair, ownerPathPair];
  const result = report(items, Object.fromEntries(items.map(entry => [decisionKey(entry), decision()])));
  assert.deepEqual(result.items.map(entry => entry.execution), ['agent-merge', 'human-proposal', 'human-proposal']);
  assert.deepEqual(result.items.map(entry => entry.actionable), [true, false, false]);
});

test('analysis pack includes all decisions and deduplicated full source bytes without granting execution', async () => {
  const first = item(), thirdSource = {path: 'Agents/c.md', revision: 'rev-c', owner: 'agent', project: 'alpha'};
  const second = {...item(), id: 'second', notes: [first.notes[1], thirdSource]};
  const third = {...item(), id: 'third', notes: [first.notes[0], thirdSource]};
  const originals = [first.notes[0], first.notes[1], thirdSource].map((note, index) => ({...note, content: `# Full source ${index}\r\n\r\nUnique detail absent from the short matching passage.\r\n`}));
  const reads = [], progress = [];
  const result = await buildAnalysisPack({vaultId: 'v', workspace: 'alpha', items: [first, second, third],
    decisions: {[decisionKey(first)]: decision('approved'), [decisionKey(second)]: decision('rejected')},
    scan: {semantic: {incomplete: true}}, generatedAt: '2026-10-30T00:00:00Z',
    readSource: async path => { reads.push(path); return originals.find(note => note.path === path); },
    onProgress: value => progress.push(value)});
  const pack = JSON.parse(result.json);
  assert.deepEqual(reads, originals.map(note => note.path));
  assert.deepEqual(pack.sources.map(note => note.content), originals.map(note => note.content));
  assert.deepEqual(pack.suggestions.map(suggestion => suggestion.decision), ['approved', 'rejected', 'undecided']);
  assert(pack.suggestions.every(suggestion => !suggestion.actionable && suggestion.execution === 'analysis-only'));
  assert.equal(pack.purpose, 'analysis-only');
  assert.equal(pack.scan.semantic.incomplete, true);
  assert.equal(pack.suggestions[0].instructions, 'Compare carefully');
  assert.deepEqual(progress.at(-1), {loaded: 3, total: 3});
  assert.equal(result.sourceCount, 3);
  assert.equal(result.suggestionCount, 3);
  assert.equal(result.bytes, new TextEncoder().encode(result.json).byteLength);
  assert(!/(?<!\r)\n/.test(result.json));
});

test('analysis export rejects changed, missing, mismatched and internally conflicting sources', async () => {
  const candidate = item();
  const args = {vaultId: 'v', items: [candidate], decisions: {}};
  for (const replacement of [undefined, {...candidate.notes[0], revision: 'changed', content: 'body'}, {...candidate.notes[0], path: 'wrong.md', content: 'body'}]) {
    await assert.rejects(buildAnalysisPack({...args, readSource: async () => replacement}), /Source changed or is unavailable/);
  }
  let reads = 0;
  await assert.rejects(buildAnalysisPack({...args, items: [candidate, item('changed')], readSource: async () => { reads++; }}), /conflicting revisions/);
  assert.equal(reads, 0);
});

test('cancelled analysis loading stops without returning a partial pack or reading later sources', async () => {
  const controller = new AbortController(), candidate = item();
  let reads = 0;
  await assert.rejects(buildAnalysisPack({vaultId: 'v', items: [candidate], decisions: {}, signal: controller.signal,
    readSource: async () => { reads++; controller.abort(); return {...candidate.notes[0], content: 'body'}; }}), {name: 'AbortError'});
  assert.equal(reads, 1);
});

test('analysis export fails rather than truncating UTF-8 content or oversized JSON metadata', async () => {
  const candidate = item(), args = {vaultId: 'v', items: [candidate], decisions: {}};
  await assert.rejects(buildAnalysisPack({...args, maxBytes: 500, readSource: async () => ({...candidate.notes[0], content: '漢'.repeat(200)})}), /size limit/);
  let reads = 0;
  await assert.rejects(buildAnalysisPack({...args, maxBytes: 1000, readSource: async path => { reads++; return {...candidate.notes.find(note => note.path === path), content: 'body'}; }}), /complete JSON pack exceeds/);
  assert.equal(reads, 2);
});
