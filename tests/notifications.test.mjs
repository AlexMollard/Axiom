import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialNotifications, parseNotifications, reconcileNotifications, unreadNotifications, acknowledgeNotifications} from '../client/src/notification-state.mjs';

const first = 'a'.repeat(64), second = 'b'.repeat(64), third = 'c'.repeat(64);
const note = (path, revision = first, extra = {}) => ({path, revision, owner: 'agent', reviewStatus: 'unreviewed', status: 'current', updated: '2026-10-28T00:00:00.000Z', ...extra});

test('first visit baselines backlog; later arrivals, offline arrivals and revisions remain unread until seen', () => {
  const old = note('Agents/Old.md'), incoming = note('Agents/New.MD');
  let state = initialNotifications([old]);
  assert.deepEqual(unreadNotifications(state, [old]), []);
  state = parseNotifications(JSON.stringify(state));
  const current = [old, incoming];
  state = reconcileNotifications(state, current);
  assert.deepEqual(unreadNotifications(state, current).map(n => n.path), [incoming.path]);
  const snapshot = JSON.stringify(incoming);
  state = acknowledgeNotifications(state, [incoming]);
  assert.equal(JSON.stringify(incoming), snapshot);
  assert.equal(incoming.reviewStatus, 'unreviewed');
  state = parseNotifications(JSON.stringify(state));
  assert.deepEqual(unreadNotifications(state, current), []);
  const changed = {...incoming, revision: second};
  assert.deepEqual(unreadNotifications(state, [old, changed]).map(n => n.path), [incoming.path]);
  state = acknowledgeNotifications(state, [changed]);
  assert.equal(unreadNotifications(state, [old, {...changed, revision: third}]).length, 1);
});

test('reviewed, retired, owner and registry notes do not notify; restoring a deleted pending note is a new arrival', () => {
  const pending = note('Agents/New.md');
  let state = initialNotifications([]);
  const ignored = [note('Owner/Personal.md', first, {owner: 'owner'}), note('Agents/Workspace icons.md'), note('Agents/Archived.md', first, {status: 'archived'}), note('Agents/Retired.md', first, {status: 'superseded'}), note('Agents/Reviewed.md', first, {reviewStatus: 'reviewed'})];
  assert.deepEqual(unreadNotifications(state, ignored), []);
  state = reconcileNotifications(state, [pending]);
  assert.equal(unreadNotifications(state, [pending]).length, 1);
  const reviewed = {...pending, reviewStatus: 'reviewed'};
  state = reconcileNotifications(state, [reviewed]);
  assert.deepEqual(unreadNotifications(state, [reviewed]), []);
  assert.deepEqual(unreadNotifications(state, [pending]), []);
  state = reconcileNotifications(state, []);
  assert.equal(unreadNotifications(state, [pending]).length, 1);
});

test('invalid notification history cannot fabricate review state and a valid empty baseline is retained', () => {
  for (const text of ['bad JSON', 'null', '{"version":2,"seen":{}}', '{"version":1,"seen":[]}', '{"version":1,"seen":{"Owner/Policies.md":"'+first+'"}}', '{"version":1,"seen":{"Agents/Test.md":"bad"}}']) assert.equal(parseNotifications(text), null);
  const empty = parseNotifications('{"version":1,"seen":{}}');
  assert.equal(unreadNotifications(empty, [note('Agents/Arrived.md')]).length, 1);
});
