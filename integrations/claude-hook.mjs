import { loadConfig, policies, isProtectedPath } from '../src/memory.mjs';
import { observeHarness } from '../src/harness-status.mjs';

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
    const context = await policies(config, cwd, event === 'UserPromptSubmit' ? (input.prompt || '') : '', {source: 'claude', maxBytes: 8192});
    await observeHarness(config, 'claude', event);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
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
