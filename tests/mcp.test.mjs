import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createMcpServer} from '../integrations/mcp.mjs';
import {loadConfig} from '../src/memory.mjs';
import {serializeWorkspaceIcons} from '../src/workspace-icons.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axiom-mcp-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const vault = path.join(root, 'vault'), cwd = path.join(root, 'alpha');
  await fs.mkdir(path.join(vault, 'Owner'), {recursive: true});
  await fs.mkdir(path.join(vault, 'Agents'), {recursive: true});
  await fs.writeFile(path.join(vault, 'Owner', 'Policies.md'), '# Policies\r\nNever deploy automatically.\r\n');
  await fs.writeFile(path.join(vault, 'Owner', 'Preferences.md'), '# Preferences\r\nCite evidence.\r\n');
  await fs.writeFile(path.join(vault, 'Agents', 'Workspace icons.md'), serializeWorkspaceIcons({global: 'library', alpha: 'boxes', beta: 'anvil', __unmapped: 'folder-search'}));
  const configPath = path.join(root, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({vault, backupDir: path.join(root, 'backup'), projects: [{id: 'alpha', root: cwd}, {id: 'beta', root: path.join(root, 'beta')}]}));
  return {root, cwd, configPath, config: await loadConfig(configPath)};
}

const call = (client, name, args = {}) => client.callTool({name, arguments: args});
const value = result => JSON.parse(result.content[0].text);

test('MCP SDK tools preserve scope, revisions and ownership', async t => {
  const {config, cwd} = await fixture(t);
  const server = createMcpServer(config, {cwd});
  const client = new Client({name: 'untrusted-client', version: '1'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['capture_suggestions', 'policy', 'read', 'search', 'workspace_icon_search', 'write']);
  const make = (project, body) => call(client, 'write', {path: `Agents/Memory/Projects/${project}/quartz.md`, content: `---\r\nstatus: current\r\n---\r\n# Quartz\r\n${body}`, expectedRevision: 'new'});
  const alpha = value(await make('alpha', 'alpha secret'));
  await make('beta', 'beta secret');
  const found = value(await call(client, 'search', {query: 'quartz'}));
  assert.ok(found.items.some(item => item.path === alpha.path));
  assert.ok(found.items.every(item => !item.path.includes('/beta/')));
  const readResult = await call(client, 'read', {path: alpha.path});
  const read = value(readResult);
  assert.deepEqual(readResult.structuredContent, read);
  assert.equal(read.revision, alpha.revision);
  assert.match(read.content, /alpha secret/);
  assert.match((await call(client, 'policy')).content[0].text, /Never deploy automatically/);
  const updated = value(await call(client, 'write', {path: alpha.path, content: '# Quartz\r\nupdated', expectedRevision: alpha.revision}));
  assert.notEqual(updated.revision, alpha.revision);
  const stale = await call(client, 'write', {path: alpha.path, content: 'lost', expectedRevision: alpha.revision});
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /Revision conflict/);
  for (const protectedPath of ['Owner/Policies.md', 'Agents/Workspace icons.md', 'Agents/../Owner/Policies.md']) {
    assert.equal((await call(client, 'write', {path: protectedPath, content: 'overwrite', expectedRevision: 'new'})).isError, true);
  }
  assert.match(value(await call(client, 'read', {path: 'Owner/Policies.md'})).content, /Never deploy/);
});

test('stdio entrypoint starts through a linked installation with explicit config and cwd', async t => {
  const {root, configPath, cwd} = await fixture(t);
  const client = new Client({name: 'stdio-test', version: '1'});
  const link = path.join(root, 'linked-integrations');
  await fs.symlink(path.resolve('integrations'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const executable = path.join(link, 'mcp.mjs');
  const transport = new StdioClientTransport({command: process.execPath, args: [executable, '--config', configPath, '--cwd', cwd], stderr: 'pipe'});
  await client.connect(transport);
  t.after(() => client.close());
  assert.match((await call(client, 'policy')).content[0].text, /project: alpha/);
});
