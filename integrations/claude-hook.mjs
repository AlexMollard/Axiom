import * as fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, policies, isProtectedPath } from '../src/memory.mjs';
import { observeHarness } from '../src/harness-status.mjs';

// Per-session record of injected references, so a note reaches one conversation once.
// Fails open: any state error means "nothing seen yet", never a blocked prompt.
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const seenFile = (config, session) => path.join(path.dirname(config.indexPath), `prompt-refs-${session}.json`);
async function loadSeen(config, session) {
  try { const keys = JSON.parse(await fs.readFile(seenFile(config, session), 'utf8')); return new Set(Array.isArray(keys) ? keys.filter(key => typeof key === 'string') : []); }
  catch { return new Set(); }
}
async function saveSeen(config, session, seen) {
  const file = seenFile(config, session), temporary = `${file}.${process.pid}.tmp`;
  try { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(temporary, JSON.stringify([...seen])); await fs.rename(temporary, file); }
  catch { await fs.rm(temporary, {force: true}).catch(() => {}); }
}
async function resetSeen(config, session) {
  const dir = path.dirname(config.indexPath);
  await fs.rm(seenFile(config, session), {force: true}).catch(() => {});
  try {
    for (const name of await fs.readdir(dir)) {
      if (!/^prompt-refs-.+\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > SEEN_TTL_MS) await fs.rm(file, {force: true}).catch(() => {});
    }
  } catch {}
}

const input = await new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
  process.stdin.on('error', reject);
}).catch(error => { console.error(`Shared Brain hook input: ${error.message}`); process.exit(2); });

const event = input.hook_event_name;
const cwd = input.cwd || process.cwd();
if (event === 'PreToolUse' && !['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'].includes(input.tool_name)) process.exit(0);
try {
  const config = await loadConfig();
  if (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'SubagentStart') {
    // SessionStart (incl. compact) carries the owner block, SubagentStart only pointers to it; prompts add only unseen matching references.
    const prompt = event === 'UserPromptSubmit';
    const session = typeof input.session_id === 'string' && /^[\w-]{1,128}$/.test(input.session_id) ? input.session_id : '';
    // A fresh, cleared or compacted context no longer holds earlier references; a resumed one does.
    if (session && event === 'SessionStart' && input.source !== 'resume') await resetSeen(config, session);
    const seen = session && prompt ? await loadSeen(config, session) : null;
    const context = await policies(config, cwd, prompt ? (input.prompt || '') : '', {source: 'claude', maxBytes: 8192, referencesOnly: prompt, lean: event === 'SubagentStart', ...(seen ? {seen} : {})});
    if (seen && context) await saveSeen(config, session, seen);
    await observeHarness(config, 'claude', event);
    if (context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
  } else if (event === 'PreToolUse') {
    const name = input.tool_name || '';
    const args = input.tool_input || {};
    let blocked = false;
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
      const candidate = args.file_path || args.notebook_path || args.path;
      blocked = typeof candidate === 'string' && await isProtectedPath(config, candidate, cwd);
    } else if (['Bash', 'PowerShell'].includes(name) && typeof args.command === 'string') {
      const command = args.command;
      const mutation = /(?:^|[;&|\s])(rm|mv|cp|touch|tee|truncate|del|erase|move|copy|ren|rmdir|mkdir|remove-item|move-item|copy-item|set-content|add-content|out-file|new-item|clear-content)\b|(?:^|[^<])>{1,2}/i.test(command);
      if (mutation) {
        const tokens = command.match(/"[^"]*"|'[^']*'|[^\s;&|<>]+/g) || [];
        for (const token of tokens) {
          const candidate = token.replace(/^['"]|['"]$/g, '');
          if (await isProtectedPath(config, candidate, cwd)) { blocked = true; break; }
        }
      }
    }
    if (blocked) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Shared Brain owner notes and attachments are read-only. Propose corrections instead.' } }));
  }
} catch (error) {
  console.error(`Shared Brain ${event}: ${error.message}`);
  if (event === 'UserPromptSubmit' || event === 'PreToolUse') process.exitCode = 2;
  else process.exitCode = 1;
}
