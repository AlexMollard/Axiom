import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { loadConfig, policies, search, readNote, writeNote, isProtectedPath } from '../src/memory.mjs';
import { searchWorkspaceIcons } from '../src/workspace-icons.mjs';
import { observeHarness } from '../src/harness-status.mjs';
import { getCaptureSuggestions, getNoteKnowledge } from '../src/knowledge.mjs';

// The installed extension API supplies its own TypeBox-compatible builder.
export default function (pi: ExtensionAPI) {
  const Type = pi.typebox.Type;
  let needsPolicyContext = true;
  const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: {} });
  const failure = (error: unknown) => { throw new Error(`Shared Brain: ${error instanceof Error ? error.message : String(error)}`); };

  pi.registerTool({
    name: 'shared_memory_search', label: 'Search shared memory', approval: 'read',
    description: 'Search global and current-project memory with source revisions and local semantic matches when configured. Cold model loading may take tens of seconds. Optional mode is hybrid (default) or lexical (no inference); inspect semantic status for degraded retrieval.',
    parameters: Type.Object({query: Type.String(), mode: Type.Optional(Type.String())}),
    async execute(_id, args, _signal, _update, ctx) {
      try { return text(await search(await loadConfig(), args.query, {cwd: ctx.cwd, mode: args.mode || 'hybrid', signal: _signal, usage: {source: 'omp'}})); } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: 'shared_memory_read', label: 'Read shared memory', approval: 'read',
    description: 'Read a shared-memory Markdown note and its revision.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args) {
      try { return text(await readNote(await loadConfig(), args.path, { source: 'omp' })); } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: 'shared_memory_workspace_icons', label: 'Find unused workspace icons', approval: 'read',
    description: 'Search unused canonical Lucide icons before the first agent note in a workspace.',
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
    async execute(_id, args) {
      try { return text(await searchWorkspaceIcons(await loadConfig(), args.query, args.limit)); } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: 'shared_memory_capture', label: 'Check related memory before capture', approval: 'read',
    description: 'Find scoped existing notes before saving a durable finding. Suggestions are lexical overlap, not proven duplicates or contradictions; update or link the original where appropriate.',
    parameters: Type.Object({ path: Type.String(), content: Type.String(), limit: Type.Optional(Type.Number()) }),
    async execute(_id, args, _signal, _update, ctx) {
      try { return text(await getCaptureSuggestions(await loadConfig(), { cwd: ctx.cwd, ...args })); } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: 'shared_memory_knowledge', label: 'Inspect memory relationships', approval: 'read',
    description: 'Inspect explicit replacements, conflicts and possible overlaps for a note without changing its authority or review state.',
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, args) {
      try { return text(await getNoteKnowledge(await loadConfig(), args.path)); } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: 'shared_memory_write', label: 'Write agent memory', approval: 'write',
    description: 'Save a durable agent-owned note under Agents/; supply its current revision or new, and an unused workspaceIcon on the first note in an unassigned workspace.',
    parameters: Type.Object({ path: Type.String(), content: Type.String(), expectedRevision: Type.String(), workspaceIcon: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      try { return text(await writeNote(await loadConfig(), args.path, args.content, args.expectedRevision, args.workspaceIcon)); } catch (error) { return failure(error); }
    },
  });

  pi.on('input', async (_event, ctx) => {
    try { const config = await loadConfig(); await policies(config, ctx.cwd, _event.text); await observeHarness(config, 'omp', 'input'); }
    catch (error) {
      ctx.ui.notify(`Shared Brain policy unavailable; prompt blocked: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return { handled: true };
    }
  });
  pi.on('before_agent_start', async (event, ctx) => {
    needsPolicyContext = true;
    try {
      const config = await loadConfig();
      const policy = await policies(config, ctx.cwd, event.prompt, event.reason === 'revive' ? null : { source: 'omp' });
      await observeHarness(config, 'omp', 'before_agent_start');
      needsPolicyContext = event.reason === 'revive';
      if (!needsPolicyContext) return { systemPrompt: [...event.systemPrompt, policy] };
    } catch (error) {
      ctx.abort();
      throw new Error(`Shared Brain policy unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  // Revival discards hook returns; agent-initiated wakes need per-call context instead.
  pi.on('context', async (event, ctx) => {
    if (!needsPolicyContext) return;
    try {
      const policy = await policies(await loadConfig(), ctx.cwd, '', { source: 'omp' });
      return { messages: [...event.messages, { role: 'custom' as const, customType: 'shared-brain-policy', content: policy, display: false, timestamp: Date.now() }] };
    } catch (error) {
      ctx.abort();
      throw new Error(`Shared Brain policy unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  pi.on('before_subagent_spawn', async (_event, ctx) => {
    try { const config = await loadConfig(); await policies(config, ctx.cwd, ''); await observeHarness(config, 'omp', 'before_subagent_spawn'); }
    catch (error) { return { block: true, reason: `Shared Brain policy unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
  });
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'write' && event.toolName !== 'edit') return;
    try {
      const config = await loadConfig();
      const candidates: string[] = [];
      const input: Record<string, unknown> = event.input;
      if (typeof input.path === 'string') candidates.push(input.path);
      if (typeof input.file_path === 'string') candidates.push(input.file_path);
      if (Array.isArray(input.edits)) {
        for (const edit of input.edits) {
          if (edit && typeof edit === 'object' && 'rename' in edit && typeof edit.rename === 'string') candidates.push(edit.rename);
        }
      }
      // The installed edit tool uses input for hashline and apply-patch forms.
      if (typeof input.input === 'string') {
        for (const match of input.input.matchAll(/^\[([^\]#\r\n]+)#[0-9A-Fa-f]{4}\]\s*$|^MV\s+(.+)$|^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gm)) candidates.push((match[1] || match[2] || match[3]).replace(/^"|"$/g, ''));
      }
      for (const candidate of candidates) {
        if (await isProtectedPath(config, candidate, ctx.cwd)) return { block: true, reason: 'Shared Brain owner notes and attachments are read-only; propose corrections instead.' };
      }
    } catch (error) { return { block: true, reason: `Shared Brain guard unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
  });
}
