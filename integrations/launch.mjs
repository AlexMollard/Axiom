import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { loadConfig, policies } from '../memory.mjs';

const [program, ...args] = process.argv.slice(2);
if (program !== 'claude' && program !== 'omp') {
  console.error('Usage: node launch.mjs <claude|omp> [args...]');
  process.exit(1);
}
try {
  await policies(await loadConfig(), process.cwd(), '');
  // Native executables avoid cmd.exe and preserve argument boundaries on Windows.
  const filename = process.platform === 'win32' ? `${program}.exe` : program;
  let executable;
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir.replace(/^"|"$/g, ''), filename);
    try { await access(candidate); executable = candidate; break; } catch { /* try next PATH entry */ }
  }
  if (!executable) throw new Error(`Cannot find native ${filename} on PATH`);
  const child = spawn(executable, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit', shell: false });
  child.on('error', error => { console.error(`Shared Brain launcher: ${error.message}`); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (signal) { try { process.kill(process.pid, signal); } catch { process.exitCode = 1; } }
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(`Shared Brain preflight: ${error.message}`);
  process.exitCode = 1;
}
