import test from 'node:test';
import assert from 'node:assert/strict';
import { draftKey, readDraft, writeDraft, discardDraft, MAX_DRAFT_BYTES } from '../client/src/editor-drafts.mjs';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

const draft = { title: 'New note', content: 'unsaved', baseline: '', revision: 'new' };

test('drafts are isolated by vault and path and retain their baseline', () => {
  const store = storage();
  const key = draftKey('vault-a', 'Owner/Notes/a.md');
  writeDraft(store, key, draft);
  assert.deepEqual(readDraft(store, key), { version: 1, ...draft });
  assert.equal(readDraft(store, draftKey('vault-b', 'Owner/Notes/a.md')), null);
  assert.equal(readDraft(store, draftKey('vault-a', 'Owner/Notes/b.md')), null);
  assert.notEqual(draftKey('vault-a', '\0new-note'), draftKey('vault-a', 'Owner/Notes/__new__.md'));
  discardDraft(store, key);
  assert.equal(readDraft(store, key), null);
});

test('corrupt and oversized drafts are rejected without being overwritten', () => {
  const store = storage();
  const key = draftKey('vault', 'note');
  store.setItem(key, '{');
  assert.throws(() => readDraft(store, key), /corrupt/);
  assert.equal(store.getItem(key), '{');
  store.setItem(key, 'x'.repeat(MAX_DRAFT_BYTES + 1));
  assert.throws(() => readDraft(store, key), /too large/);
  assert.throws(() => writeDraft(store, key, { ...draft, content: 'x'.repeat(MAX_DRAFT_BYTES) }), /size limit/);
  assert.equal(store.getItem(key).length, MAX_DRAFT_BYTES + 1);
});

test('storage failures and absent vault identifiers are explicit', () => {
  assert.equal(draftKey('', 'note'), null);
  assert.throws(() => writeDraft(storage(), null, draft), /vault identifier/);
  const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  assert.throws(() => readDraft(unavailable, 'key'), /denied/);
  assert.throws(() => writeDraft(unavailable, 'key', draft), /quota/);
  assert.throws(() => discardDraft(unavailable, 'key'), /denied/);
});
