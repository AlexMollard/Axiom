#!/usr/bin/env node
import path from 'node:path';
import * as fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {loadConfig, policies, readNote, search, writeNote} from '../src/memory.mjs';
import {searchWorkspaceIcons, WORKSPACE_ICONS_PATH} from '../src/workspace-icons.mjs';

const usage = {source: 'mcp'};
const text = value => typeof value === 'string'
  ? {content: [{type: 'text', text: value}]}
  : {content: [{type: 'text', text: JSON.stringify(value)}], ...(value && typeof value === 'object' && !Array.isArray(value) ? {structuredContent: value} : {})};

export function createMcpServer(config, {cwd = process.cwd()} = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('MCP cwd must be an absolute path.');
  const server = new McpServer({name: 'axiom-memory', version: '1.2.0'}, {maxToolInputElements: 100});
  const register = (name, description, inputSchema, action) => server.registerTool(name, {description, inputSchema}, async args => {
    try { return text(await action(args)); }
    catch (error) { return {isError: true, content: [{type: 'text', text: error.message}]}; }
  });
  register('policy', 'Load owner policies and scoped context for the configured working directory.', {query: z.string().optional()}, ({query = ''}) => policies(config, cwd, query, usage));
  register('search', 'Search scoped shared memory. Results include revision and match details.', {
    query: z.string(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional(),
    all: z.boolean().optional(), includeInactive: z.boolean().optional(), workspace: z.string().optional(), owner: z.string().optional(), review: z.string().optional()
  }, args => search(config, args.query, {...args, cwd, usage}));
  register('read', 'Read a Markdown note and its current revision.', {path: z.string()}, args => readNote(config, args.path, usage));
  register('write', 'Write an agent-owned Markdown note using its current revision or new. Owner and protected notes cannot be written.', {
    path: z.string(), content: z.string(), expectedRevision: z.string(), workspaceIcon: z.string().optional()
  }, args => {
    if (args.path.toLowerCase() === WORKSPACE_ICONS_PATH.toLowerCase()) throw new Error('Protected control notes cannot be written through MCP.');
    return writeNote(config, args.path, args.content, args.expectedRevision, args.workspaceIcon);
  });
  register('workspace_icon_search', 'Search available canonical workspace icons.', {query: z.string().optional(), limit: z.number().int().min(1).max(1000).optional()}, ({query = '', limit = 24}) => searchWorkspaceIcons(config, query, limit));
  register('capture_suggestions', 'Find scoped existing notes relevant to a proposed capture.', {
    path: z.string().optional(), content: z.string(), limit: z.number().int().min(1).max(20).optional()
  }, async args => (await import('../src/knowledge.mjs')).getCaptureSuggestions(config, {...args, cwd}));
  return server;
}

export async function startMcp({configPath, cwd = process.cwd(), transport = new StdioServerTransport()} = {}) {
  const config = await loadConfig(configPath);
  const server = createMcpServer(config, {cwd});
  await server.connect(transport);
  return server;
}

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--config', '--cwd'].includes(flag) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Usage: axiom-memory-mcp [--config <file>] [--cwd <absolute-directory>]');
    const key = flag === '--config' ? 'configPath' : 'cwd';
    if (result[key] !== undefined) throw new Error(`Duplicate option: ${flag}`);
    result[key] = argv[++i];
  }
  return result;
}

const entryPath = process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null);
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try { await startMcp(options(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
