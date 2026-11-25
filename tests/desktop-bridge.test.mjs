import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLocalMarkdown, isSafeHref } from '../client/src/markdown-preview.mjs';
import { closeTab, createTab, nextTabId, openTab, routeTitle, setTabDirty } from '../client/src/tabs-state.mjs';

test('renderLocalMarkdown resolves wikilinks, relative links, heading ids, and strips XSS', () => {
  const notes = [
    { path: 'Home.md', title: 'Home' },
    { path: 'Agents/Memory/Projects/alpha/Setup.md', title: 'Setup Guide' },
  ];
  const md = [
    '---',
    'title: Ignore frontmatter',
    '---',
    '# Heading',
    '## Heading',
    '- [x] Done task',
    '- [ ] Open task',
    '[[Setup#Step One]] and [home](../../Home.md#top) and [bad](javascript:alert(1))',
    '<script>alert("xss")</script>',
    '![alt text](https://example.com/pic.png)',
  ].join('\n');

  const html = renderLocalMarkdown(md, 'Agents/Memory/Projects/alpha/Index.md', notes);
  assert.match(html, /id="heading"/);
  assert.match(html, /id="heading-2"/);
  assert.match(html, /<input type="checkbox" class="task-list-checkbox" checked disabled>/);
  assert.match(html, /<input type="checkbox" class="task-list-checkbox" disabled>/);
  assert.match(html, /href="\/\?note=Agents%2FMemory%2FProjects%2Falpha%2FSetup\.md#step-one"/);
  assert.match(html, /href="\/\?note=Home\.md#top"/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.doesNotMatch(html, /<a[^>]*javascript:/i);
  assert.doesNotMatch(html, /<script>/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /alt text/);
  assert.equal(isSafeHref('javascript:alert(1)'), false);
  assert.equal(isSafeHref('https://example.com'), true);
});

test('tab state helpers handle open, dedupe, dirty tracking, cycling, and close', () => {
  const t1 = createTab({ kind: 'overview' }, 'Overview', 't1');
  let state = openTab([t1], 't1', { kind: 'note', path: 'Home.md' }, 'Home', { newTab: true });
  assert.equal(state.tabs.length, 2);
  assert.notEqual(state.activeId, 't1');

  // Opening same route focuses existing tab instead of duplicating
  const t2Id = state.activeId;
  const deduped = openTab(state.tabs, 't1', { kind: 'note', path: 'Home.md' }, 'Home');
  assert.equal(deduped.tabs.length, 2);
  assert.equal(deduped.activeId, t2Id);

  // Dirty tab is preserved when opening a new route without newTab flag
  const dirtyTabs = setTabDirty(state.tabs, t2Id, true);
  assert.equal(dirtyTabs.find(t => t.id === t2Id).dirty, true);
  const splitOpen = openTab(dirtyTabs, t2Id, { kind: 'note', path: 'Owner/Policies.md' }, 'Policies');
  assert.equal(splitOpen.tabs.length, 3);

  assert.equal(nextTabId(splitOpen.tabs, 't1', 1), t2Id);
  const dupOverview = openTab(splitOpen.tabs, t2Id, { kind: 'overview' }, 'Overview', { newTab: true });
  assert.equal(dupOverview.tabs.length, 4);
  const closed = closeTab(splitOpen.tabs, t2Id, t2Id);
  assert.equal(closed.tabs.length, 2);
  assert.equal(routeTitle({ kind: 'project', id: '__all', mode: 'graph' }), 'All vaults graph');
});
