import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decisionKey, readDecisions, writeDecisions, buildHandoff} from '../client/src/cleanup-review.mjs';

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
