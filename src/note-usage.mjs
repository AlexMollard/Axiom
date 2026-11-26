import * as fs from 'node:fs/promises';
import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const DAY = 86400000;
const constants = {retentionDays: 180, staleDays: 90, hotDays: 30, recentDays: 7};
const nowOf = options => new Date(options?.now ?? Date.now());
const statePath = config => path.join(path.dirname(config.configPath || config.vault), '.state', `usage-${createHash('sha256').update(config.vault).digest('hex').slice(0, 16)}.sqlite`);
const iso = date => date.toISOString();

async function open(config, now) {
  const file = statePath(config), marker = `${file}.gap`;
  await fs.mkdir(path.dirname(file), {recursive: true});
  const Database = globalThis.Bun ? (await import('bun:sqlite')).Database : (await import('node:sqlite')).DatabaseSync;
  const db = new Database(file);
  try {
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (path TEXT PRIMARY KEY, observed TEXT NOT NULL, last_read TEXT, last_excerpt TEXT, last_context TEXT, last_used TEXT, last_source TEXT, last_revision TEXT);
      CREATE TABLE IF NOT EXISTS daily (path TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(path, day, kind));
      CREATE INDEX IF NOT EXISTS daily_day ON daily(day);`);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('started', iso(now));
      const gap = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
      const handledGap = db.prepare('SELECT value FROM meta WHERE key = ?').get('handled-gap')?.value;
      if (gap && gap !== handledGap) {
        db.prepare('UPDATE notes SET observed = ?').run(iso(now));
        db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(iso(now), 'started');
        db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('handled-gap', gap);
      }
      db.prepare('DELETE FROM daily WHERE day < ?').run(iso(new Date(now.getTime() - (constants.retentionDays - 1) * DAY)).slice(0, 10));
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    return db;
  } catch (error) { db.close(); throw error; }
}
async function failed(config, error) {
  try {
    const file = statePath(config), marker = `${file}.gap`, temporary = `${marker}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(file), {recursive: true});
    try { writeFileSync(temporary, randomUUID() + '\r\n'); await fs.rename(temporary, marker); }
    finally { try { unlinkSync(temporary); } catch {} }
  } catch {}
  console.warn(`Axiom usage tracking unavailable: ${error.message}`);
  return {healthy: false, reason: `Usage tracking unavailable: ${error.message}`};
}
function insertInventory(db, notes, now) {
  const insert = db.prepare('INSERT OR IGNORE INTO notes(path, observed) VALUES (?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try { for (const note of notes) insert.run(note.path, iso(now)); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export async function inventoryUsage(config, notes, options = {}) {
  let db;
  try { const now = nowOf(options); db = await open(config, now); insertInventory(db, notes, now); return {healthy: true, reason: null}; }
  catch (error) { return failed(config, error); } finally { db?.close(); }
}
// Receipts describe delivery, not comprehension; revision belongs to the delivered bytes.
export async function recordUsage(config, notes, kind, source, options = {}) {
  if (!['read', 'excerpt', 'context'].includes(kind) || !['cli', 'omp', 'claude', 'mcp'].includes(source)) throw new Error('Invalid usage receipt.');
  if (!notes.length) return {healthy: true, reason: null};
  let db;
  try {
    const now = nowOf(options), at = iso(now), day = at.slice(0, 10); db = await open(config, now);
    db.exec('BEGIN IMMEDIATE');
    try {
      const add = db.prepare('INSERT OR IGNORE INTO notes(path, observed) VALUES (?, ?)');
      const count = db.prepare('INSERT INTO daily(path, day, kind, count) VALUES (?, ?, ?, 1) ON CONFLICT(path, day, kind) DO UPDATE SET count = count + 1');
      const update = db.prepare(`UPDATE notes SET last_${kind} = CASE WHEN last_${kind} IS NULL OR last_${kind} <= ? THEN ? ELSE last_${kind} END, last_source = CASE WHEN last_used IS NULL OR last_used <= ? THEN ? ELSE last_source END, last_revision = CASE WHEN last_used IS NULL OR last_used <= ? THEN ? ELSE last_revision END, last_used = CASE WHEN last_used IS NULL OR last_used <= ? THEN ? ELSE last_used END WHERE path = ?`);
      for (const note of notes) { add.run(note.path, at); count.run(note.path, day, kind); update.run(at, at, at, source, at, note.revision || null, at, at, note.path); }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return {healthy: true, reason: null};
  } catch (error) { return failed(config, error); } finally { db?.close(); }
}
function protections(config, notes) {
  const result = new Map(notes.map(note => [note.path, []]));
  const add = (note, reason) => { const list = result.get(note.path); if (!list.includes(reason)) list.push(reason); };
  const pins = new Set(Object.values(config.workspacePins || {}).flat().map(value => String(value).toLowerCase()));
  for (const note of notes) {
    if (note.owner !== 'agent' || !note.path.startsWith('Agents/') || note.path.toLowerCase() === 'agents/workspace icons.md') add(note, 'Owner or system control');
    if (pins.has(note.path.toLowerCase())) add(note, 'Workspace pin');
    if (/decision|conflict|proposal/i.test(`${note.kind || ''} ${note.status || ''} ${note.path}`) || note.conflictsWith) add(note, 'Decision, conflict or proposal');
  }
  const norm = value => String(value).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '').toLowerCase();
  const lookup = new Map();
  for (const note of notes) for (const key of new Set([norm(note.path), norm(path.posix.basename(note.path)), norm(note.title)])) {
    if (!lookup.has(key)) lookup.set(key, []);
    lookup.get(key).push(note);
  }
  for (const source of notes) for (const link of [...(source.links || []), source.supersedes, source.conflictsWith].filter(Boolean)) {
    let decoded = link; try { decoded = decodeURIComponent(link); } catch {}
    const target = norm(decoded), relative = norm(path.posix.normalize(path.posix.join(path.posix.dirname(source.path), decoded)));
    for (const key of new Set([target, relative])) for (const note of lookup.get(key) || []) {
      if (note.path !== source.path) add(note, 'Incoming link');
    }
  }
  return result;
}
export async function getNoteUsage(config, notes, options = {}) {
  const now = nowOf(options), targetPath = options?.targetPath ?? null, reasons = protections(config, notes);
  const targetNote = targetPath !== null ? (notes.find(note => note.path === targetPath) || null) : null;
  let db, healthy = true, reason = null, startedAt = null, rows = new Map(), counts = new Map();
  const fromDay = iso(new Date(now.getTime() - (constants.hotDays - 1) * DAY)).slice(0, 10), toDay = iso(now).slice(0, 10);
  try {
    db = await open(config, now);
    insertInventory(db, targetPath !== null ? (targetNote ? [targetNote] : []) : notes, now);
    startedAt = db.prepare('SELECT value FROM meta WHERE key = ?').get('started')?.value || null;
    if (targetPath !== null) {
      const row = db.prepare('SELECT * FROM notes WHERE path = ?').get(targetPath);
      if (row) rows.set(row.path, row);
      for (const entry of db.prepare('SELECT kind, SUM(count) AS count FROM daily WHERE path = ? AND day >= ? AND day <= ? GROUP BY kind').all(targetPath, fromDay, toDay)) {
        counts.set(`${targetPath}\0${entry.kind}`, Number(entry.count));
      }
    } else {
      rows = new Map(db.prepare('SELECT * FROM notes').all().map(row => [row.path, row]));
      for (const row of db.prepare('SELECT path, kind, SUM(count) AS count FROM daily WHERE day >= ? AND day <= ? GROUP BY path, kind').all(fromDay, toDay)) counts.set(`${row.path}\0${row.kind}`, Number(row.count));
    }
  } catch (error) { ({healthy, reason} = await failed(config, error)); } finally { db?.close(); }
  const age = value => value ? now.getTime() - Date.parse(value) : Infinity;
  const formatNote = note => {
    const row = rows.get(note.path), protectionReasons = reasons.get(note.path), reads30d = counts.get(`${note.path}\0read`) || 0, excerpts30d = counts.get(`${note.path}\0excerpt`) || 0, context30d = counts.get(`${note.path}\0context`) || 0;
    let status = 'insufficient-history';
    if (reads30d >= 3) status = 'hot';
    else if (age(row?.last_used) <= 7 * DAY) status = 'recent';
    else if (healthy && row && age(row.observed) >= 90 * DAY) {
      status = !protectionReasons.length && Number.isFinite(Date.parse(note.updated)) && age(note.updated) >= 90 * DAY && age(row.last_used) >= 90 * DAY ? 'stale-candidate' : 'quiet';
    }
    return {...note, usage: {reads30d, excerpts30d, context30d, lastReadAt: row?.last_read || null, lastExcerptAt: row?.last_excerpt || null, lastContextAt: row?.last_context || null, lastUsedAt: row?.last_used || null, lastSource: row?.last_source || null, lastRevision: row?.last_revision || null, observedSince: row?.observed || null, status, protectionReasons}};
  };
  const tracking = {startedAt, healthy, reason, ...constants};
  if (targetPath !== null) return {tracking, note: targetNote ? formatNote(targetNote) : null};
  return {tracking, notes: notes.map(formatNote)};
}
