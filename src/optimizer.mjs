import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { catalogWithContent, readRawNote, writeNote, crlf } from './memory.mjs';
import { REVIEW_LEDGER_PATH } from './note-reviews.mjs';
import { readWorkspaceIcons, searchWorkspaceIcons } from './workspace-icons.mjs';
import { protectedDeletionReason, deleteNote } from './management.mjs';
import { createRecoverySnapshot } from './recovery.mjs';
import { getCleanup } from './cleanup.mjs';
import { getMemoryHealth } from './knowledge.mjs';
import { getNoteUsage } from './note-usage.mjs';

export const OPTIMIZER_PROVIDERS = ['auto', 'agy', 'omp', 'claude', 'codex', 'anthropic', 'openai', 'gemini'];
const CLI_ORDER = ['agy', 'omp', 'claude', 'codex'];
const API_ORDER = ['anthropic', 'openai', 'gemini'];
const MAX_RUN_HISTORY = 25;
const MAX_BATCH_BYTES = 11 * 1024;
const BATCH_CONCURRENCY = 3;
const AGY_MAX_INLINE_CHARS = 28000;
const MAX_DEEP_FILES_PER_BATCH = 6;
const MAX_DEEP_EXCERPT_CHARS = 1400;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export const DEFAULT_OPTIMIZER_SETTINGS = Object.freeze({
  provider: 'auto',
  model: '',
  apiKey: '',
  apiBaseUrl: '',
  deepRepoCheck: false,
  maxNotesPerBatch: 18,
  timeoutMs: 240000,
});

const missing = error => error?.code === 'ENOENT';
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};

export function validateOptimizerSettings(raw = {}) {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error('Optimizer settings must be an object.');
  }
  const provider = raw.provider ?? DEFAULT_OPTIMIZER_SETTINGS.provider;
  if (!OPTIMIZER_PROVIDERS.includes(provider)) {
    throw new Error(`Optimizer provider must be one of: ${OPTIMIZER_PROVIDERS.join(', ')}.`);
  }
  const model = typeof raw.model === 'string' ? raw.model.trim() : DEFAULT_OPTIMIZER_SETTINGS.model;
  if (model.length > 120 || /[\r\n\0]/.test(model)) {
    throw new Error('Optimizer model override must be at most 120 characters on one line.');
  }
  const apiBaseUrl = typeof raw.apiBaseUrl === 'string' ? raw.apiBaseUrl.trim() : DEFAULT_OPTIMIZER_SETTINGS.apiBaseUrl;
  if (apiBaseUrl) {
    let parsed;
    try { parsed = new URL(apiBaseUrl); } catch { throw new Error('Optimizer API base URL must be a valid HTTP/HTTPS URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Optimizer API base URL must use http or https.');
    }
  }
  const deepRepoCheck = raw.deepRepoCheck === undefined ? DEFAULT_OPTIMIZER_SETTINGS.deepRepoCheck : Boolean(raw.deepRepoCheck);
  const batchRaw = raw.maxNotesPerBatch === undefined ? DEFAULT_OPTIMIZER_SETTINGS.maxNotesPerBatch : Number(raw.maxNotesPerBatch);
  if (!Number.isInteger(batchRaw) || batchRaw < 4 || batchRaw > 40) {
    throw new Error('Batch size must be an integer between 4 and 40.');
  }
  const timeoutRaw = raw.timeoutMs === undefined ? DEFAULT_OPTIMIZER_SETTINGS.timeoutMs : Number(raw.timeoutMs);
  if (!Number.isInteger(timeoutRaw) || timeoutRaw < 30000 || timeoutRaw > 600000) {
    throw new Error('Timeout must be an integer between 30000 and 600000 ms.');
  }
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  return {
    provider,
    model,
    apiKey,
    apiBaseUrl,
    deepRepoCheck,
    maxNotesPerBatch: batchRaw,
    timeoutMs: timeoutRaw,
  };
}

export function optimizerSettings(config) {
  return validateOptimizerSettings(config?.optimizer || {});
}

export function sanitizeOptimizerSettings(config) {
  const s = optimizerSettings(config);
  const envHasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY);
  const configHasKey = Boolean(s.apiKey);
  return {
    provider: s.provider,
    model: s.model,
    apiBaseUrl: s.apiBaseUrl,
    deepRepoCheck: s.deepRepoCheck,
    maxNotesPerBatch: s.maxNotesPerBatch,
    timeoutMs: s.timeoutMs,
    hasApiKey: configHasKey || envHasKey,
    apiKeySource: configHasKey ? 'config' : envHasKey ? 'env' : null,
  };
}

async function fileExists(candidate) {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveCliExecutable(name) {
  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEntries) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (await fileExists(candidate)) return candidate;
    }
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const appData = process.env.APPDATA || '';
    const home = os.homedir();
    const known = {
      agy: [
        path.join(local, 'agy', 'bin', 'agy.exe'),
      ],
      omp: [
        path.join(appData, 'npm', 'omp.cmd'),
        path.join(appData, 'npm', 'omp.exe'),
        path.join(local, 'Programs', 'omp', 'omp.exe'),
        path.join(home, '.local', 'bin', 'omp.exe'),
      ],
      claude: [
        path.join(home, '.local', 'bin', 'claude.exe'),
      ],
      codex: [
        path.join(appData, 'npm', 'codex.cmd'),
        path.join(appData, 'npm', 'codex.exe'),
      ],
    };
    for (const candidate of known[name] || []) {
      if (candidate && (await fileExists(candidate))) return candidate;
    }
  }
  return null;
}

export async function detectOptimizerProviders(config) {
  const settings = optimizerSettings(config);
  const hasStoredKey = Boolean(settings.apiKey);
  const [agyPath, ompPath, claudePath, codexPath] = await Promise.all([
    resolveCliExecutable('agy'),
    resolveCliExecutable('omp'),
    resolveCliExecutable('claude'),
    resolveCliExecutable('codex'),
  ]);
  return [
    { id: 'agy', label: 'Antigravity CLI (agy)', kind: 'cli', available: Boolean(agyPath), executable: agyPath, defaultModel: 'Active CLI default' },
    { id: 'omp', label: 'OMP CLI (omp)', kind: 'cli', available: Boolean(ompPath), executable: ompPath, defaultModel: 'Active CLI default' },
    { id: 'claude', label: 'Claude Code CLI (claude)', kind: 'cli', available: Boolean(claudePath), executable: claudePath, defaultModel: 'opus' },
    { id: 'codex', label: 'Codex CLI (codex)', kind: 'cli', available: Boolean(codexPath), executable: codexPath, defaultModel: 'Active CLI default' },
    { id: 'anthropic', label: 'Anthropic API', kind: 'api', available: Boolean((settings.provider === 'anthropic' && hasStoredKey) || (settings.provider === 'auto' && hasStoredKey && settings.apiKey.startsWith('sk-ant-')) || process.env.ANTHROPIC_API_KEY), defaultModel: 'claude-opus-4-6' },
    { id: 'openai', label: 'OpenAI API', kind: 'api', available: Boolean((settings.provider === 'openai' && hasStoredKey) || (settings.provider === 'auto' && hasStoredKey && !settings.apiKey.startsWith('sk-ant-') && !settings.apiKey.startsWith('AIza')) || process.env.OPENAI_API_KEY || settings.apiBaseUrl), defaultModel: 'gpt-5.4' },
    { id: 'gemini', label: 'Gemini API', kind: 'api', available: Boolean((settings.provider === 'gemini' && hasStoredKey) || (settings.provider === 'auto' && hasStoredKey && settings.apiKey.startsWith('AIza')) || process.env.GEMINI_API_KEY), defaultModel: 'gemini-2.5-pro' },
  ];
}

function runSubprocess(executable, args, stdinText, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Optimization cancelled.'));
      return;
    }
    const isCmd = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable);
    const cmd = isCmd ? (process.env.ComSpec || 'cmd.exe') : executable;
    const spawnArgs = isCmd ? ['/d', '/s', '/c', executable, ...args] : args;
    const child = spawn(cmd, spawnArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const finishError = err => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch {}
      finishError(new Error('Optimization cancelled.'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finishError(new Error(`Model runner timed out after ${Math.round((timeoutMs || 240000) / 1000)}s.`));
    }, timeoutMs || 240000);

    child.stdout.on('data', chunk => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on('data', chunk => {
      if (stderrChunks.reduce((n, b) => n + b.length, 0) < 256 * 1024) {
        stderrChunks.push(chunk);
      }
    });
    child.on('error', err => finishError(err));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        const detail = [stderr, stdout].filter(Boolean).join('\n').slice(0, 800);
        finishError(new Error(`CLI exited with code ${code}${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolve({ text: stdout, stderr });
    });

    if (stdinText !== undefined && stdinText !== null) {
      child.stdin.end(stdinText);
    } else {
      child.stdin.end();
    }
  });
}

async function invokeCliProvider(providerId, executable, prompt, { model, timeoutMs, signal }) {
  if (providerId === 'agy') {
    if (prompt.length > AGY_MAX_INLINE_CHARS) {
      throw new Error(`Prompt exceeds Windows agy inline CLI limit (${prompt.length} > ${AGY_MAX_INLINE_CHARS} chars).`);
    }
    const args = ['--disable-slash-commands', '--output-format', 'text'];
    if (model) args.push('--model', model);
    args.push(`--print=${prompt}`);
    const res = await runSubprocess(executable, args, null, { timeoutMs, signal });
    return { text: res.text, modelUsed: model || 'agy-default' };
  }
  if (providerId === 'omp') {
    const args = ['-p', '--no-session', '--no-tools', '--no-lsp', '--mode', 'text', '--thinking=high'];
    if (model) args.push(`--model=${model}`);
    const res = await runSubprocess(executable, args, prompt, { timeoutMs, signal });
    return { text: res.text, modelUsed: model || 'omp-default' };
  }
  if (providerId === 'claude') {
    const chosenModel = model || 'opus';
    const args = ['-p', '--model', chosenModel, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--output-format', 'text'];
    const res = await runSubprocess(executable, args, prompt, { timeoutMs, signal });
    return { text: res.text, modelUsed: chosenModel };
  }
  if (providerId === 'codex') {
    const args = ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check'];
    if (model) args.push('--model', model);
    args.push('-');
    const res = await runSubprocess(executable, args, prompt, { timeoutMs, signal });
    return { text: res.text, modelUsed: model || 'codex-default' };
  }
  throw new Error(`Unsupported CLI provider: ${providerId}`);
}

async function invokeApiProvider(providerId, prompt, { model, apiKey, apiBaseUrl, timeoutMs, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`API request timed out after ${Math.round((timeoutMs || 240000) / 1000)}s.`)), timeoutMs || 240000);
  const onAbort = () => controller.abort(new Error('Optimization cancelled.'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (providerId === 'anthropic') {
      const key = apiKey || process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('Anthropic API key is missing.');
      const chosenModel = model || 'claude-opus-4-6';
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: chosenModel, max_tokens: 16384, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error?.message || `Anthropic API failed (${resp.status}).`);
      const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      return { text, modelUsed: data.model || chosenModel };
    }
    if (providerId === 'openai') {
      const key = apiKey || process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OpenAI API key is missing.');
      const chosenModel = model || 'gpt-5.4';
      const base = (apiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: chosenModel, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error?.message || `OpenAI API failed (${resp.status}).`);
      const text = data.choices?.[0]?.message?.content || '';
      return { text, modelUsed: data.model || chosenModel };
    }
    if (providerId === 'gemini') {
      const key = apiKey || process.env.GEMINI_API_KEY;
      if (!key) throw new Error('Gemini API key is missing.');
      const chosenModel = model || 'gemini-2.5-pro';
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error?.message || `Gemini API failed (${resp.status}).`);
      const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
      return { text, modelUsed: chosenModel };
    }
    throw new Error(`Unsupported API provider: ${providerId}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export async function invokeModel(config, prompt, overrides = {}) {
  const settings = optimizerSettings(config);
  const requested = overrides.provider || settings.provider || 'auto';
  const model = overrides.model !== undefined ? overrides.model : settings.model;
  const timeoutMs = overrides.timeoutMs || settings.timeoutMs;
  const signal = overrides.signal;
  const providers = await detectOptimizerProviders(config);
  const byId = new Map(providers.map(p => [p.id, p]));

  const tryOne = async id => {
    const info = byId.get(id);
    if (!info) throw new Error(`Unknown optimizer provider: ${id}`);
    if (info.kind === 'cli') {
      if (!info.executable) throw new Error(`${info.label} executable not found.`);
      const res = await invokeCliProvider(id, info.executable, prompt, { model, timeoutMs, signal });
      return { providerUsed: id, ...res };
    }
    if (!info.available && !settings.apiKey) throw new Error(`${info.label} key not configured.`);
    const res = await invokeApiProvider(id, prompt, { model, apiKey: settings.apiKey, apiBaseUrl: settings.apiBaseUrl, timeoutMs, signal });
    return { providerUsed: id, ...res };
  };

  if (requested !== 'auto') return tryOne(requested);

  const candidates = [...CLI_ORDER, ...API_ORDER].filter(id => byId.get(id)?.available);
  if (!candidates.length) {
    throw new Error('No optimizer model runner is ready. Sign in to a CLI (agy, omp, claude, codex) or save an API key in Model settings.');
  }
  const errors = [];
  for (const id of candidates) {
    if (signal?.aborted) throw new Error('Optimization cancelled.');
    try {
      return await tryOne(id);
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
    }
  }
  throw new Error(`All configured model runners failed:\n${errors.join('\n')}`);
}

export function parseModelJson(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('Model returned an empty response.');
  }
  const trimmed = rawText.trim();
  const candidates = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.actions)) {
        return parsed;
      }
    } catch {}
  }
  throw new Error('Model response did not contain a valid JSON object with an "actions" array.');
}

function extractCandidatePaths(note) {
  const candidates = new Set();
  const push = raw => {
    if (typeof raw !== 'string') return;
    const cleaned = raw.trim().replace(/^['"`]|['"`]$/g, '').replace(/[),.;:]+$/, '');
    if (!cleaned || cleaned.length < 3 || cleaned.length > 260) return;
    if (/^(?:https?:|mailto:|obsidian:|axiom:)/i.test(cleaned)) return;
    if (/\.(?:mjs|js|jsx|ts|tsx|json|rs|toml|cs|cpp|h|hpp|py|ps1|md|sql|yml|yaml|css|scss|html)$/i.test(cleaned) || /[\\/]/.test(cleaned)) {
      if (!/[\r\n<>*?|"]/.test(cleaned)) candidates.add(cleaned);
    }
  };
  if (note.source) push(note.source);
  const content = note.content || '';
  for (const m of content.matchAll(/`([^`\r\n]{3,200})`/g)) push(m[1]);
  for (const m of content.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) push(m[1]);
  return [...candidates].slice(0, 12);
}

export async function inspectNoteRepoReferences(note, roots, { deepRepoCheck = false, excerptBudget } = {}) {
  if (!Array.isArray(roots) || !roots.length) {
    return { existingPaths: [], missingPaths: [], excerpts: [] };
  }
  const normalizedRoots = roots.map(r => path.resolve(r));
  const candidates = extractCandidatePaths(note);
  const existingPaths = [];
  const missingPaths = [];
  const excerpts = [];
  const seen = new Set();

  for (const rawCandidate of candidates) {
    const normCandidate = rawCandidate.replaceAll('/', path.sep);
    let resolved = null;
    if (path.isAbsolute(normCandidate)) {
      const abs = path.resolve(normCandidate);
      if (normalizedRoots.some(root => inside(root, abs))) resolved = abs;
    } else {
      for (const root of normalizedRoots) {
        const joined = path.resolve(root, normCandidate);
        if (inside(root, joined)) {
          resolved = joined;
          try { await fs.stat(joined); break; } catch {}
        }
      }
    }
    if (!resolved || seen.has(resolved.toLowerCase())) continue;
    seen.add(resolved.toLowerCase());
    try {
      const stat = await fs.stat(resolved);
      existingPaths.push(rawCandidate);
      if (deepRepoCheck && stat.isFile() && excerptBudget && excerptBudget.remainingFiles > 0) {
        const text = await fs.readFile(resolved, 'utf8');
        const slice = text.split(/\r?\n/).slice(0, 35).join('\n').slice(0, MAX_DEEP_EXCERPT_CHARS);
        excerpts.push({ path: rawCandidate, snippet: slice });
        excerptBudget.remainingFiles--;
      }
    } catch (error) {
      if (missing(error)) missingPaths.push(rawCandidate);
    }
  }
  return { existingPaths, missingPaths, excerpts };
}

async function getRecentGitCommits(root) {
  if (!root) return [];
  try {
    const res = await runSubprocess('git', ['-C', root, 'log', '-n', '8', '--oneline'], null, { timeoutMs: 5000 });
    return res.text ? res.text.split(/\r?\n/).slice(0, 8) : [];
  } catch {
    return [];
  }
}

function isProtectedPath(relative, pins) {
  if (typeof relative !== 'string' || !relative.startsWith('Agents/') || !/\.md$/i.test(relative)) return 'Path must stay under Agents/ and end in .md.';
  if (protectedDeletionReason(relative)) return protectedDeletionReason(relative);
  if (relative.toLowerCase() === REVIEW_LEDGER_PATH.toLowerCase()) return 'The review ledger cannot be modified.';
  if (pins.has(relative.toLowerCase())) return 'Pinned in workspace.';
  return null;
}

function isTrashBlocked(note, pins) {
  if (!note) return 'Note does not exist in vault.';
  if (note.owner !== 'agent') return 'Owner-controlled note cannot be trashed.';
  const protectedReason = isProtectedPath(note.path, pins);
  if (protectedReason) return protectedReason;
  if (/^Agents\/(?:Handovers|Proposals)\//i.test(note.path)) return 'Protected handover or proposal note.';
  return null;
}

const bodyOf = content => String(content || '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();

export function detectFormatIssues(note) {
  const body = bodyOf(note?.content);
  const issues = [];
  if (/Imported machine-maintained/i.test(body)) issues.push('imported-wrapper');
  if (/(?:^|\r?\n)---\r?\n(?:name|description|metadata|originSessionId|node_type):/im.test(body)) issues.push('embedded-yaml-frontmatter');
  if (/Unreviewed extract from \[original\]/i.test(body)) issues.push('unreviewed-extract-wrapper');
  if (/[\u2014\u2013]/.test(body)) issues.push('em-dashes');
  const contentLines = body
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !/^#{1,6}\s/.test(l) && !/^(?:Imported machine-maintained|Original source:|Original snapshot:|Unreviewed extract from )/i.test(l));
  const linkLines = contentLines.filter(l => /^[-*]\s+\[[^\]]+\]\([^)\s]+\.md(?:#[^)]*)?\)/i.test(l));
  if (linkLines.length >= 4 && linkLines.length / contentLines.length >= 0.6) {
    issues.push('link-index-wrapper');
  }
  return issues;
}

function canonicalTargetPath(targetWorkspace, requestedPath, sourcePath) {
  const prefix = targetWorkspace === 'global' ? 'Agents/Memory/General/' : `Agents/Memory/Projects/${targetWorkspace}/`;
  const clean = typeof requestedPath === 'string' ? requestedPath.replaceAll('\\', '/').replace(/^\.?\/+/, '').trim() : '';
  if (clean && clean.startsWith(prefix) && /\.md$/i.test(clean) && !clean.includes('..') && !/[:*?"<>|\0]/.test(clean)) {
    return clean;
  }
  const baseSource = clean ? clean.split('/').pop() : path.basename(sourcePath || 'note.md');
  const safeBase = (baseSource || 'note.md').replace(/[\\/:*?"<>|\0]+/g, '-').trim();
  const withExt = /\.md$/i.test(safeBase) ? safeBase : `${safeBase}.md`;
  return `${prefix}${withExt}`;
}

function ensureFrontmatterProject(content, targetWorkspace) {
  const fm = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!fm) {
    return `---\r\nproject: ${targetWorkspace}\r\n---\r\n${content}`;
  }
  const lines = fm[1].split(/\r?\n/).filter(line => !/^project:/i.test(line));
  lines.push(`project: ${targetWorkspace}`);
  return `---\r\n${lines.join('\r\n')}\r\n---${fm[2]}${content.slice(fm[0].length)}`;
}

function buildBatchPrompt({ workspace, availableWorkspaces, batchIndex, totalBatches, mutableNotes, contextNotes, repoSummary, recentCommits, cleanupHints, deepRepoCheck }) {
  const mutablePayload = mutableNotes.map(({ note, usage, repoCheck }) => ({
    path: note.path,
    revision: note.revision,
    title: note.title,
    project: note.project,
    status: note.status,
    reviewStatus: note.reviewStatus || 'unreviewed',
    source: note.source || null,
    kind: note.kind || null,
    usageStatus: usage?.status || 'unknown',
    formatIssues: detectFormatIssues(note),
    existingRepoPaths: repoCheck.existingPaths,
    missingRepoPaths: repoCheck.missingPaths,
    ...(deepRepoCheck && repoCheck.excerpts.length ? { repoExcerpts: repoCheck.excerpts } : {}),
    content: note.content,
  }));

  const readOnlyPayload = contextNotes.map(n => ({
    path: n.path,
    title: n.title,
    project: n.project,
    owner: n.owner,
    status: n.status,
    excerpt: n.excerpt,
  }));

  return [
    'You are Axiom Memory Optimizer, a high-intelligence curator for Alex Mollard\'s Shared Brain vault.',
    `Workspace scope: ${workspace} (batch ${batchIndex + 1} of ${totalBatches}).`,
    `Available workspaces (relocate misplaced notes to the right one):\n${JSON.stringify(availableWorkspaces)}`,
    repoSummary.length ? `Mapped repo roots:\n${repoSummary.join('\n')}` : 'Mapped repo roots: none',
    recentCommits.length ? `Recent commits in primary repo:\n${recentCommits.join('\n')}` : '',
    cleanupHints.length ? `Heuristic cleanup hints:\n${JSON.stringify(cleanupHints)}` : '',
    readOnlyPayload.length ? `Read-only reference context (NEVER modify or trash):\n${JSON.stringify(readOnlyPayload)}` : '',
    '',
    'Your task: Inspect every mutable note below and decide whether to KEEP, UPDATE (tidy/normalize formatting), MOVE (relocate to the right workspace), MERGE (consolidate duplicates/overlaps), or TRASH (bad/empty/stale/obsolete junk).',
    '',
    'Canonical Note Quality Standard (for BOTH human readability and fast agent retrieval):',
    'A. Single flat YAML frontmatter ONLY at the very top (`title:`, `project:`, `status:`, `source:`, optional `kind:`). NEVER leave a nested `---` block or Claude export keys (`name:`, `description:`, `metadata:`, `node_type:`, `originSessionId:`, `modified:`) inside the Markdown body.',
    'B. Strip all import boilerplate from the body (`Imported machine-maintained Claude memory; not owner-approved policy.`, `Original source: ...`, `Original snapshot: ...`, `Unreviewed extract from [original]...`). Preserve the real source/provenance path in top frontmatter `source:` (and optional compact `## Sources` section at the bottom if multiple).',
    'C. Lead for high signal-to-noise: Start the body immediately with `# <Clear Title>`, followed by a crisp 1-2 sentence TL;DR summary of the core rule or fact so Axiom search excerpts (first 240 chars) give agents the actual answer immediately instead of metadata noise.',
    'D. Format cleanly: Use short scannable bullets, bold key phrases, exact file paths/symbols/commands in backticks, short headings (`## Rules`, `## Details`, `## Why`) only when helpful, and zero em dashes or en dashes (use `-`, `,`, or `:`).',
    'E. Mandatory format cleanup: Any note with non-empty `formatIssues` MUST NOT be returned as `keep` -- rewrite it cleanly with `update` (or `move`/`merge`/`trash` as appropriate).',
    'F. Link-list index notes (`formatIssues` includes `"link-index-wrapper"`, such as imported `MEMORY.md` or `Workspace mapping/index-*.md` overview lists of links): Axiom already organizes notes by workspace, search, and graph. If the linked topics already exist as individual notes in the vault, TRASH the redundant link-list index note rather than keeping a list of links. Only keep/update a concise thematic note if it holds durable facts not present in any standalone note.',
    '',
    'Action & Safety Rules:',
    '1. NEVER invent facts, file paths, or sources. Preserve all accurate `source:`, `project:`, dates, and owner-facing facts.',
    '2. Keep `reviewStatus: "reviewed"` notes conservative: still clean up broken `formatIssues` or merge clear duplicates while preserving every verified fact.',
    '3. For `update`: keep `path`, update content cleanly (body >= 20 chars after frontmatter).',
    '4. For `move`: relocate misplaced useful notes (personal preferences -> `personal`, project facts -> matching project ID, cross-project tooling/workflow -> `global`), setting `targetWorkspace`, canonical `targetPath` under `Agents/Memory/Projects/<targetWorkspace>/` or `Agents/Memory/General/`, `project: <targetWorkspace>` in frontmatter, and apply Standards A-D.',
    '5. For `merge`: combine 2+ overlapping notes into one canonical `targetPath` under `Agents/...`, listing `sourcePaths` (`removeSources: "trash"` for duplicate/import noise, `"supersede"` if provenance matters), and apply Standards A-D.',
    '6. For `trash`: delete genuinely bad, empty, superseded-junk, or provably stale notes (e.g. `missingRepoPaths` confirms files no longer exist and no enduring value remains). Do NOT trash a useful note merely for being in the wrong workspace: use `move`.',
    '7. Every mutable note path MUST appear in exactly one action with exact `expectedRevision`. NEVER touch `Owner/`, `Home.md`, or `Agents/Workspace icons.md`.',
    '',
    'Return ONLY a raw JSON object matching this exact schema:',
    JSON.stringify({
      actions: [
        { type: 'keep', path: 'Agents/...md', expectedRevision: '<sha256>', reason: 'Already clean, concise, and in right workspace' },
        { type: 'update', path: 'Agents/...md', expectedRevision: '<sha256>', reason: 'Stripped import boilerplate/nested YAML and tightened for agent retrieval', content: '---\ntitle: ...\nproject: ...\nstatus: unreviewed\nsource: ...\n---\n# Title\n\nCrisp 1-2 sentence TL;DR rule.\n\n- Key fact with `path/to/file`.\n' },
        { type: 'move', path: 'Agents/...md', expectedRevision: '<sha256>', targetWorkspace: 'personal', targetPath: 'Agents/Memory/Projects/personal/example.md', reason: 'Personal preference stored in wrong workspace', content: '---\ntitle: ...\nproject: personal\nstatus: unreviewed\nsource: ...\n---\n# Title\n\nCrisp TL;DR.\n' },
        { type: 'merge', targetPath: 'Agents/...md', expectedRevision: '<sha256 or new>', sourcePaths: [{ path: 'Agents/...md', expectedRevision: '<sha256>' }], removeSources: 'trash', reason: 'Consolidated overlapping notes', content: '---\ntitle: ...\nproject: ...\n---\n# Merged\n\nCrisp summary.\n' },
        { type: 'trash', path: 'Agents/...md', expectedRevision: '<sha256>', reason: 'Why note is stale or empty' },
      ],
    }),
    '',
    'Mutable notes to optimize:',
    JSON.stringify(mutablePayload),
  ].filter(Boolean).join('\n');
}

function chunkNotes(items, maxNotesPerBatch) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(item.note.content || '', 'utf8') + 1024;
    if (current.length > 0 && (current.length >= maxNotesPerBatch || currentBytes + size > MAX_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function applyOptimizationActions(config, actions, { dryRun = false, byPath, pins }) {
  const results = [];
  const counts = { kept: 0, updated: 0, merged: 0, moved: 0, trashed: 0, skipped: 0 };
  const mutated = new Set();
  const configuredIds = new Set((config.projects || []).map(p => p.id));

  const actionable = actions.filter(a => a && ['update', 'move', 'merge', 'trash'].includes(a.type));
  let snapshotId = null;
  if (!dryRun && actionable.length > 0) {
    const snap = await createRecoverySnapshot(config);
    snapshotId = snap.id;
  }

  const ordered = [
    ...actions.filter(a => a?.type === 'merge'),
    ...actions.filter(a => a?.type === 'move'),
    ...actions.filter(a => a?.type === 'update'),
    ...actions.filter(a => a?.type === 'trash'),
    ...actions.filter(a => a?.type === 'keep'),
  ];

  for (const action of ordered) {
    if (!action || typeof action !== 'object') continue;
    if (action.type === 'keep') {
      counts.kept++;
      results.push({ type: 'keep', path: action.path, title: byPath.get(action.path)?.title || null, reason: action.reason || 'Concise and accurate.', outcome: 'kept' });
      continue;
    }
    if (action.type === 'move') {
      const sourceNote = byPath.get(action.path);
      const blocked = isTrashBlocked(sourceNote, pins);
      if (blocked) {
        counts.skipped++;
        results.push({ type: 'move', path: action.path, title: sourceNote?.title, reason: action.reason, outcome: 'blocked', error: blocked });
        continue;
      }
      if (mutated.has(sourceNote.path)) continue;
      const targetWorkspace = typeof action.targetWorkspace === 'string' ? action.targetWorkspace.trim() : '';
      if (!['global', 'personal'].includes(targetWorkspace) && !configuredIds.has(targetWorkspace)) {
        counts.skipped++;
        results.push({ type: 'move', path: action.path, title: sourceNote.title, reason: action.reason, outcome: 'skipped', error: `Invalid target workspace: ${targetWorkspace || 'empty'}.` });
        continue;
      }
      const rawRequestedTarget = typeof action.targetPath === 'string' ? action.targetPath.replaceAll('\\', '/').replace(/^\.?\/+/, '').trim() : '';
      const rawProtected = rawRequestedTarget ? (protectedDeletionReason(rawRequestedTarget) || (!rawRequestedTarget.startsWith('Agents/') ? 'Destination path must stay under Agents/.' : null)) : null;
      if (rawProtected) {
        counts.skipped++;
        results.push({ type: 'move', path: action.path, targetPath: rawRequestedTarget, title: sourceNote.title, reason: action.reason, outcome: 'blocked', error: rawProtected });
        continue;
      }
      const targetPath = canonicalTargetPath(targetWorkspace, action.targetPath, sourceNote.path);
      const targetBlocked = isProtectedPath(targetPath, pins);
      if (targetBlocked) {
        counts.skipped++;
        results.push({ type: 'move', path: action.path, targetPath, title: sourceNote.title, reason: action.reason, outcome: 'blocked', error: targetBlocked });
        continue;
      }
      const baseContent = typeof action.content === 'string' && action.content.trim() ? action.content : sourceNote.content;
      const finalContent = ensureFrontmatterProject(baseContent, targetWorkspace);
      if (bodyOf(finalContent).length < 20) {
        counts.skipped++;
        results.push({ type: 'move', path: action.path, targetPath, title: sourceNote.title, reason: action.reason, outcome: 'skipped', error: 'Refused empty or too-short relocated body.' });
        continue;
      }
      const samePath = targetPath.toLowerCase() === sourceNote.path.toLowerCase();
      if (!samePath && (byPath.has(targetPath) || mutated.has(targetPath))) {
        counts.skipped++;
        results.push({ type: 'move', path: action.path, targetPath, fromWorkspace: sourceNote.project, toWorkspace: targetWorkspace, title: sourceNote.title, reason: action.reason, outcome: 'skipped', error: `Destination already exists: ${targetPath}.` });
        continue;
      }
      if (dryRun) {
        mutated.add(sourceNote.path);
        mutated.add(targetPath);
        counts.moved++;
        results.push({ type: 'move', path: sourceNote.path, targetPath, fromWorkspace: sourceNote.project, toWorkspace: targetWorkspace, title: sourceNote.title, reason: action.reason || `Would move to ${targetWorkspace}.`, outcome: 'dry-run' });
        continue;
      }
      try {
        const { assignments } = await readWorkspaceIcons(config);
        let workspaceIcon;
        if (!Object.hasOwn(assignments, targetWorkspace)) {
          const found = await searchWorkspaceIcons(config, targetWorkspace, 1);
          const fallback = found.candidates.length ? found : await searchWorkspaceIcons(config, '', 1);
          workspaceIcon = fallback.candidates[0];
        }
        if (samePath) {
          await writeNote(config, sourceNote.path, crlf(finalContent), action.expectedRevision || sourceNote.revision, workspaceIcon);
          mutated.add(sourceNote.path);
          counts.moved++;
          results.push({ type: 'move', path: sourceNote.path, targetPath: sourceNote.path, fromWorkspace: sourceNote.project, toWorkspace: targetWorkspace, title: sourceNote.title, reason: action.reason || `Updated workspace to ${targetWorkspace}.`, outcome: 'applied' });
        } else {
          await writeNote(config, targetPath, crlf(finalContent), 'new', workspaceIcon);
          const manifest = await deleteNote(config, sourceNote.path, action.expectedRevision || sourceNote.revision);
          mutated.add(sourceNote.path);
          mutated.add(targetPath);
          counts.moved++;
          results.push({ type: 'move', path: sourceNote.path, targetPath, fromWorkspace: sourceNote.project, toWorkspace: targetWorkspace, title: sourceNote.title, trashId: manifest.id, reason: action.reason || `Moved to ${targetWorkspace}.`, outcome: 'applied' });
        }
      } catch (error) {
        counts.skipped++;
        results.push({ type: 'move', path: action.path, targetPath, fromWorkspace: sourceNote.project, toWorkspace: targetWorkspace, title: sourceNote.title, reason: action.reason, outcome: 'skipped', error: error.message });
      }
      continue;
    }
    if (action.type === 'update') {
      const target = byPath.get(action.path);
      const blockedReason = !target ? 'Note not found in vault.' : target.owner !== 'agent' ? 'Owner-controlled note cannot be edited.' : isProtectedPath(target.path, pins);
      if (blockedReason) {
        counts.skipped++;
        results.push({ type: 'update', path: action.path, title: target?.title, reason: action.reason, outcome: 'blocked', error: blockedReason });
        continue;
      }
      if (mutated.has(target.path)) continue;
      if (typeof action.content !== 'string' || bodyOf(action.content).length < 20) {
        counts.skipped++;
        results.push({ type: 'update', path: action.path, title: target.title, reason: action.reason, outcome: 'skipped', error: 'Refused empty or too-short optimized body.' });
        continue;
      }
      if (dryRun) {
        mutated.add(target.path);
        counts.updated++;
        results.push({ type: 'update', path: target.path, title: target.title, reason: action.reason || 'Would tidy wording.', outcome: 'dry-run' });
        continue;
      }
      try {
        await writeNote(config, target.path, crlf(action.content), action.expectedRevision || target.revision);
        mutated.add(target.path);
        counts.updated++;
        results.push({ type: 'update', path: target.path, title: target.title, reason: action.reason || 'Tidied wording and structure.', outcome: 'applied' });
      } catch (error) {
        counts.skipped++;
        results.push({ type: 'update', path: target.path, title: target.title, reason: action.reason, outcome: 'skipped', error: error.message });
      }
      continue;
    }
    if (action.type === 'merge') {
      const targetPath = action.targetPath || action.path;
      const existingTarget = byPath.get(targetPath);
      const targetBlocked = isProtectedPath(targetPath, pins) || (existingTarget && existingTarget.owner !== 'agent' ? 'Owner-controlled note cannot be edited.' : null);
      if (targetBlocked) {
        counts.skipped++;
        results.push({ type: 'merge', targetPath, title: existingTarget?.title, reason: action.reason, outcome: 'blocked', error: targetBlocked });
        continue;
      }
      if (typeof action.content !== 'string' || bodyOf(action.content).length < 20) {
        counts.skipped++;
        results.push({ type: 'merge', targetPath, title: existingTarget?.title, reason: action.reason, outcome: 'skipped', error: 'Refused empty merged body.' });
        continue;
      }
      const rawSources = Array.isArray(action.sourcePaths) ? action.sourcePaths : [];
      const sourceList = rawSources
        .map(s => (typeof s === 'string' ? { path: s, expectedRevision: byPath.get(s)?.revision } : s))
        .filter(s => s?.path && s.path !== targetPath);
      if (dryRun) {
        mutated.add(targetPath);
        for (const s of sourceList) mutated.add(s.path);
        counts.merged++;
        results.push({ type: 'merge', targetPath, title: existingTarget?.title || targetPath, sourcePaths: sourceList.map(s => s.path), reason: action.reason || 'Would consolidate overlapping notes.', outcome: 'dry-run' });
        continue;
      }
      try {
        const expected = existingTarget ? (action.expectedRevision || existingTarget.revision) : 'new';
        await writeNote(config, targetPath, crlf(action.content), expected);
        mutated.add(targetPath);
        const trashedSources = [];
        for (const src of sourceList) {
          const srcNote = byPath.get(src.path);
          if (!srcNote || mutated.has(src.path)) continue;
          const trashErr = isTrashBlocked(srcNote, pins);
          if (action.removeSources === 'supersede' || trashErr) {
            const noteProtected = isProtectedPath(srcNote.path, pins) || srcNote.owner !== 'agent';
            if (!noteProtected && !/^status:\s*superseded/im.test(srcNote.content)) {
              const raw = await readRawNote(config, srcNote.path);
              const updatedSrc = markSupersededFrontmatter(raw.content, targetPath);
              await writeNote(config, srcNote.path, crlf(updatedSrc), raw.revision);
              mutated.add(srcNote.path);
            }
            continue;
          }
          const manifest = await deleteNote(config, srcNote.path, src.expectedRevision || srcNote.revision);
          mutated.add(srcNote.path);
          trashedSources.push({ path: srcNote.path, trashId: manifest.id });
        }
        counts.merged++;
        results.push({
          type: 'merge',
          targetPath,
          title: existingTarget?.title || targetPath,
          sourcePaths: sourceList.map(s => s.path),
          trashedSources,
          reason: action.reason || 'Consolidated overlapping notes.',
          outcome: 'applied',
        });
      } catch (error) {
        counts.skipped++;
        results.push({ type: 'merge', targetPath, title: existingTarget?.title, sourcePaths: sourceList.map(s => s.path), reason: action.reason, outcome: 'skipped', error: error.message });
      }
      continue;
    }
    if (action.type === 'trash') {
      const target = byPath.get(action.path);
      const blocked = isTrashBlocked(target, pins);
      if (blocked) {
        counts.skipped++;
        results.push({ type: 'trash', path: action.path, title: target?.title, reason: action.reason, outcome: 'blocked', error: blocked });
        continue;
      }
      if (mutated.has(target.path)) continue;
      if (dryRun) {
        mutated.add(target.path);
        counts.trashed++;
        results.push({ type: 'trash', path: target.path, title: target.title, reason: action.reason || 'Would move to Trash.', outcome: 'dry-run' });
        continue;
      }
      try {
        const manifest = await deleteNote(config, target.path, action.expectedRevision || target.revision);
        mutated.add(target.path);
        counts.trashed++;
        results.push({ type: 'trash', path: target.path, title: target.title, trashId: manifest.id, reason: action.reason || 'Moved bad/stale note to Trash.', outcome: 'applied' });
      } catch (error) {
        counts.skipped++;
        results.push({ type: 'trash', path: target.path, title: target.title, reason: action.reason, outcome: 'skipped', error: error.message });
      }
      continue;
    }
    counts.skipped++;
    results.push({ type: String(action.type), path: action.path, reason: action.reason, outcome: 'skipped', error: 'Unknown action type.' });
  }

  return { snapshotId, counts, applied: results };
}

function markSupersededFrontmatter(content, targetPath) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!fm) {
    return `---\r\nstatus: superseded\r\nsuperseded_by: ${targetPath}\r\n---\r\n${content}`;
  }
  const lines = fm[1].split(/\r?\n/).filter(line => !/^(?:status|superseded_by):/i.test(line));
  lines.push('status: superseded', `superseded_by: ${targetPath}`);
  return `---\r\n${lines.join('\r\n')}\r\n---${fm[2]}${content.slice(fm[0].length)}`;
}

function runHistoryPath(config) {
  const base = config.configPath ? path.dirname(path.resolve(config.configPath)) : path.resolve(config.backupDir);
  return path.join(base, '.state', 'optimizer-runs.json');
}

export async function readOptimizerRuns(config) {
  const file = runHistoryPath(config);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch (error) {
    if (missing(error)) return [];
    return [];
  }
}

async function persistOptimizerRun(config, runRecord) {
  const file = runHistoryPath(config);
  const existing = await readOptimizerRuns(config);
  const runs = [runRecord, ...existing.filter(r => r.id !== runRecord.id)].slice(0, MAX_RUN_HISTORY);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, crlf(JSON.stringify({ version: 1, runs }, null, 2) + '\n'), { flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  return runs;
}

export async function getOptimizerStatus(config) {
  const [settings, providers, runs] = await Promise.all([
    Promise.resolve(sanitizeOptimizerSettings(config)),
    detectOptimizerProviders(config),
    readOptimizerRuns(config),
  ]);
  return { settings, providers, runs };
}

export async function runMemoryOptimization(config, options = {}) {
  const startedAt = new Date().toISOString();
  const id = randomUUID();
  const settings = optimizerSettings(config);
  const workspaceFilter = options.workspace || null;
  const deepRepoCheck = options.deepRepoCheck !== undefined ? Boolean(options.deepRepoCheck) : settings.deepRepoCheck;
  const dryRun = Boolean(options.dryRun);
  const provider = options.provider || settings.provider;
  const model = options.model !== undefined ? options.model : settings.model;
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const modelRunner = typeof options.invokeModel === 'function'
    ? options.invokeModel
    : (prompt, callOpts) => invokeModel(config, prompt, callOpts);

  onProgress({ phase: 'Scanning vault notes and cleanup signals...', completedBatches: 0, totalBatches: 0 });
  const configuredIds = new Set(config.projects.map(p => p.id));
  if (workspaceFilter && !['global', 'personal', '__unmapped'].includes(workspaceFilter) && !configuredIds.has(workspaceFilter)) {
    throw Object.assign(new Error('Unknown workspace.'), { status: 400 });
  }

  const allNotes = await catalogWithContent(config);
  const byPath = new Map(allNotes.map(n => [n.path, n]));
  const pins = new Set(Object.values(config.workspacePins || {}).flat().map(p => String(p).toLowerCase()));
  const usageData = await getNoteUsage(config, allNotes);
  const usageByPath = new Map(usageData.notes.map(n => [n.path, n.usage]));
  const renderMd = typeof options.renderMarkdown === 'function' ? options.renderMarkdown : () => '';
  const [cleanup, health] = await Promise.all([
    getCleanup(config, workspaceFilter, renderMd, { semantic: false, signal }).catch(() => ({ items: [] })),
    getMemoryHealth(config, renderMd).catch(() => ({ brokenLinks: [], possibleOverlaps: [], conflicts: [] })),
  ]);

  const workspaceOf = note => {
    if (note.project === 'global' || note.project === 'personal') return note.project;
    if (configuredIds.has(note.project)) return note.project;
    return '__unmapped';
  };

  const selectedNotes = allNotes.filter(n => !workspaceFilter || workspaceOf(n) === workspaceFilter);
  const workspaceBuckets = new Map();
  for (const note of selectedNotes) {
    const ws = workspaceOf(note);
    if (!workspaceBuckets.has(ws)) workspaceBuckets.set(ws, { mutable: [], context: [] });
    const bucket = workspaceBuckets.get(ws);
    if (note.owner === 'agent' && !isProtectedPath(note.path, pins)) {
      bucket.mutable.push(note);
    } else {
      bucket.context.push(note);
    }
  }

  const batches = [];
  const gitCommitCache = new Map();
  const projectMap = new Map(config.projects.map(p => [p.id, p]));
  const availableWorkspaces = [
    { id: 'personal', name: config.workspaceNames?.personal || 'Personal', folder: 'Agents/Memory/Projects/personal/', purpose: 'Alex Mollard personal preferences, writing/visual/theme taste, accessibility, personal identity and non-project user facts' },
    { id: 'global', name: config.workspaceNames?.global || 'General', folder: 'Agents/Memory/General/', purpose: 'Cross-project engineering workflows, harness/tooling procedures, vault operational rules' },
    ...config.projects.map(p => ({ id: p.id, name: p.name || p.id, folder: `Agents/Memory/Projects/${p.id}/`, roots: [p.root, ...(p.additionalRoots || [])] })),
  ];
  for (const [ws, bucket] of [...workspaceBuckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!bucket.mutable.length) continue;
    const proj = projectMap.get(ws);
    const roots = proj ? [proj.root, ...(proj.additionalRoots || [])] : [];
    const repoSummary = proj ? [proj.root, ...(proj.additionalRoots || [])].map(r => `- ${r}`) : [];
    let recentCommits = [];
    if (deepRepoCheck && proj?.root) {
      if (!gitCommitCache.has(proj.root)) gitCommitCache.set(proj.root, await getRecentGitCommits(proj.root));
      recentCommits = gitCommitCache.get(proj.root);
    }

    const excerptBudget = { remainingFiles: MAX_DEEP_FILES_PER_BATCH };
    const enriched = [];
    for (const note of bucket.mutable) {
      if (signal?.aborted) throw new Error('Optimization cancelled.');
      const repoCheck = await inspectNoteRepoReferences(note, roots, { deepRepoCheck, excerptBudget });
      enriched.push({ note, usage: usageByPath.get(note.path), repoCheck });
    }

    const wsCleanupHints = (cleanup.items || [])
      .filter(it => it.notes.some(n => workspaceOf(n) === ws))
      .slice(0, 20)
      .map(it => ({ category: it.category, reason: it.reason, paths: it.notes.map(n => n.path) }));

    const effectiveBatchLimit = Math.min(settings.maxNotesPerBatch, provider === 'agy' ? 8 : settings.maxNotesPerBatch);
    for (const chunk of chunkNotes(enriched, effectiveBatchLimit)) {
      batches.push({ ws, chunk, context: bucket.context.slice(0, 10), repoSummary, recentCommits, wsCleanupHints });
    }
  }

  const totalBatches = batches.length;
  onProgress({ phase: totalBatches ? 'Running AI curation across workspaces...' : 'No mutable agent notes found.', completedBatches: 0, totalBatches });

  const batchResults = new Array(totalBatches);
  const warnings = [];
  let providerUsed = provider;
  let modelUsed = model || '';
  let completedBatches = 0;
  let cursor = 0;

  const workerCount = Math.min(BATCH_CONCURRENCY, Math.max(1, totalBatches));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < totalBatches) {
      if (signal?.aborted) throw new Error('Optimization cancelled.');
      const i = cursor++;
      const b = batches[i];
      const wsBatches = batches.filter(x => x.ws === b.ws);
      const wsTotal = wsBatches.length;
      const wsIndex = wsBatches.indexOf(b);

      onProgress({
        phase: `Analyzing ${b.ws} (${completedBatches}/${totalBatches} complete)...`,
        completedBatches,
        totalBatches,
        lastMessage: `Evaluating ${b.chunk.length} notes in ${b.ws}`,
      });

      const prompt = buildBatchPrompt({
        workspace: b.ws,
        availableWorkspaces,
        batchIndex: wsIndex,
        totalBatches: wsTotal,
        mutableNotes: b.chunk,
        contextNotes: b.context,
        repoSummary: b.repoSummary,
        recentCommits: b.recentCommits,
        cleanupHints: b.wsCleanupHints,
        deepRepoCheck,
      });

      try {
        const response = await modelRunner(prompt, { provider, model, timeoutMs: settings.timeoutMs, signal });
        providerUsed = response.providerUsed || providerUsed;
        modelUsed = response.modelUsed || modelUsed;
        const parsed = parseModelJson(response.text);
        batchResults[i] = parsed.actions;
      } catch (error) {
        if (signal?.aborted) throw error;
        batchResults[i] = [];
        warnings.push(`Workspace "${b.ws}" batch ${wsIndex + 1} failed: ${error.message}`);
      } finally {
        completedBatches++;
        onProgress({
          phase: `Analyzed ${completedBatches}/${totalBatches} batches (${b.ws})...`,
          completedBatches,
          totalBatches,
          warnings: [...warnings],
        });
      }
    }
  }));

  const proposedActions = batchResults.flat().filter(Boolean);

  onProgress({ phase: dryRun ? 'Preparing preview report...' : 'Snapshotting vault and applying changes...', completedBatches: totalBatches, totalBatches });
  const { snapshotId, counts, applied } = await applyOptimizationActions(config, proposedActions, { dryRun, byPath, pins });
  if (health.brokenLinks?.length) {
    warnings.push(`${health.brokenLinks.length} notes had broken links before optimization; inspect after applying.`);
  }

  const finishedAt = new Date().toISOString();
  const report = {
    id,
    startedAt,
    finishedAt,
    workspace: workspaceFilter,
    deepRepoCheck,
    dryRun,
    provider,
    providerUsed,
    modelUsed,
    scannedNotes: batches.reduce((n, b) => n + b.chunk.length, 0),
    batches: totalBatches,
    snapshotId,
    counts,
    warnings,
    applied,
  };
  await persistOptimizerRun(config, report);
  onProgress({ phase: 'Complete', completedBatches: totalBatches, totalBatches, counts });
  return report;
}

export function createOptimizerManager(config, renderMarkdown) {
  let activeJob = null;
  let activeController = null;

  return {
    async getState() {
      return {
        activeJob: activeJob ? { ...activeJob } : null,
        runs: await readOptimizerRuns(config),
      };
    },
    startRun(params = {}) {
      if (activeJob?.status === 'running') {
        const error = new Error('An optimization run is already in progress.');
        error.status = 409;
        throw error;
      }
      const controller = new AbortController();
      activeController = controller;
      const jobId = randomUUID();
      activeJob = {
        id: jobId,
        status: 'running',
        startedAt: new Date().toISOString(),
        workspace: params.workspace || null,
        deepRepoCheck: params.deepRepoCheck,
        dryRun: Boolean(params.dryRun),
        phase: 'Starting optimization...',
        completedBatches: 0,
        totalBatches: 0,
        counts: { kept: 0, updated: 0, merged: 0, moved: 0, trashed: 0, skipped: 0 },
        lastMessage: '',
        error: null,
      };

      void (async () => {
        try {
          const report = await runMemoryOptimization(config, {
            workspace: params.workspace || null,
            provider: params.provider || undefined,
            model: params.model !== undefined ? params.model : undefined,
            deepRepoCheck: params.deepRepoCheck,
            dryRun: Boolean(params.dryRun),
            renderMarkdown,
            signal: controller.signal,
            onProgress: patch => {
              if (activeJob?.id === jobId) {
                Object.assign(activeJob, patch);
              }
            },
          });
          if (activeJob?.id === jobId) {
            activeJob.status = 'completed';
            activeJob.finishedAt = report.finishedAt;
            activeJob.counts = report.counts;
            activeJob.runId = report.id;
          }
        } catch (error) {
          const failedRun = {
            id: jobId,
            startedAt: activeJob?.startedAt || new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            workspace: params.workspace || null,
            deepRepoCheck: Boolean(params.deepRepoCheck),
            dryRun: Boolean(params.dryRun),
            provider: params.provider || optimizerSettings(config).provider,
            providerUsed: null,
            modelUsed: null,
            scannedNotes: 0,
            batches: 0,
            snapshotId: null,
            counts: { kept: 0, updated: 0, merged: 0, moved: 0, trashed: 0, skipped: 0 },
            warnings: [],
            applied: [],
            error: error.message || 'Optimization failed.',
          };
          await persistOptimizerRun(config, failedRun).catch(() => {});
          if (activeJob?.id === jobId) {
            activeJob.status = controller.signal.aborted ? 'cancelled' : 'failed';
            activeJob.finishedAt = failedRun.finishedAt;
            activeJob.error = failedRun.error;
          }
        } finally {
          if (activeController === controller) activeController = null;
        }
      })();

      return { ...activeJob };
    },
    cancelRun() {
      if (activeController && activeJob?.status === 'running') {
        activeController.abort(new Error('Optimization cancelled.'));
        activeJob.phase = 'Cancelling...';
        return { cancelled: true, activeJob: { ...activeJob } };
      }
      return { cancelled: false, activeJob: activeJob ? { ...activeJob } : null };
    },
  };
}
