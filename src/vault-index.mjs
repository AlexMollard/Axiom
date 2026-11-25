import * as fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeSearchText } from './search-index.mjs';

const SCHEMA_VERSION = '3';
const MAX_WARM_SQLITE_BYTES = 64 * 1024 * 1024;
const CORRUPT_RE = /not a database|malformed|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB|database disk image/i;
const UNWRITABLE_CODES = new Set(['ENOTDIR', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'EBUSY', 'ENOENT', 'EEXIST']);

let driverPromise = null;
async function openDatabase(filePath) {
  driverPromise ||= (async () => {
    if (globalThis.Bun) {
      const { Database } = await import('bun:sqlite');
      return target => new Database(target);
    }
    const { DatabaseSync } = await import('node:sqlite');
    return target => new DatabaseSync(target);
  })();
  const create = await driverPromise;
  return create(filePath);
}

const syncQueues = new Map();
function serializedSync(key, fn) {
  const prev = syncQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.then(() => {
    if (syncQueues.get(key) === cleanup) syncQueues.delete(key);
  }, () => {
    if (syncQueues.get(key) === cleanup) syncQueues.delete(key);
  });
  syncQueues.set(key, cleanup);
  return next;
}

let warmSqlite = null;

async function fileStamp(filePath) {
  try {
    const s = await fs.stat(filePath);
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function diskIdentityFor(indexPath) {
  const [mainStat, walStat] = await Promise.all([fileStamp(indexPath), fileStamp(`${indexPath}-wal`)]);
  return `${mainStat}|${walStat}`;
}

function initSchema(db, vault) {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      signature TEXT NOT NULL,
      revision TEXT NOT NULL,
      title TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL,
      project TEXT NOT NULL,
      source TEXT,
      kind TEXT,
      supersedes TEXT,
      conflicts_with TEXT,
      updated TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      links_json TEXT NOT NULL,
      content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_project ON notes(project);
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      title,
      path,
      body,
      tokenize="unicode61 remove_diacritics 2 tokenchars '+#'"
    );
  `);
  const schemaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const vaultRow = db.prepare("SELECT value FROM meta WHERE key = 'vault'").get();
  if (schemaRow?.value === SCHEMA_VERSION && vaultRow?.value === vault) return false;
  db.exec(`
    BEGIN IMMEDIATE;
    DELETE FROM notes_fts;
    DELETE FROM notes;
    DELETE FROM meta;
    INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
    COMMIT;
  `);
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('vault', vault);
  return true;
}

async function removeSqliteFiles(indexPath) {
  await Promise.all([
    fs.rm(indexPath, { force: true }).catch(() => {}),
    fs.rm(`${indexPath}-wal`, { force: true }).catch(() => {}),
    fs.rm(`${indexPath}-shm`, { force: true }).catch(() => {}),
  ]);
}

function isUnwritableError(error) {
  if (!error) return false;
  if (UNWRITABLE_CODES.has(error.code)) return true;
  return /unable to open database file|readonly database|attempt to write a readonly database|SQLITE_CANTOPEN|SQLITE_READONLY/i.test(error.message || '');
}

async function readAllRaw(config, files, readRawNote) {
  const result = new Array(files.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(24, files.length) }, async () => {
    while (cursor < files.length) {
      const i = cursor++;
      const { relative, signature } = files[i];
      const { content, ...note } = await readRawNote(config, relative);
      result[i] = { signature, content, note };
    }
  }));
  return result;
}

function rowToEntry(row) {
  let links = [];
  try {
    const parsed = JSON.parse(row.links_json);
    if (Array.isArray(parsed)) links = parsed;
  } catch {}
  return {
    signature: row.signature,
    content: row.content,
    note: {
      path: row.path,
      title: row.title,
      owner: row.owner,
      status: row.status,
      project: row.project,
      source: row.source ?? null,
      kind: row.kind ?? null,
      supersedes: row.supersedes ?? null,
      conflictsWith: row.conflicts_with ?? null,
      updated: row.updated,
      revision: row.revision,
      excerpt: row.excerpt,
      links,
    },
  };
}

export async function syncVaultIndex(config, indexPath, { readRawNote, hash }) {
  if ((await fs.lstat(config.vault)).isSymbolicLink()) throw new Error('Vault root cannot be a link.');
  const relPaths = [];
  async function walk(relative = '') {
    for (const entry of await fs.readdir(path.join(config.vault, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) relPaths.push(rel);
    }
  }
  await walk();

  const fileInfos = new Array(relPaths.length);
  let statCursor = 0;
  await Promise.all(Array.from({ length: Math.min(24, relPaths.length) }, async () => {
    while (statCursor < relPaths.length) {
      const i = statCursor++;
      const relative = relPaths[i];
      const stat = await fs.lstat(path.join(config.vault, relative));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('A vault path changed while indexing; retry the read.');
      fileInfos[i] = { relative, signature: `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` };
    }
  }));

  const resolvedIndex = path.resolve(indexPath);
  return serializedSync(resolvedIndex, async () => {
    const beforeIdentity = await diskIdentityFor(resolvedIndex);
    const trusted = Boolean(
      warmSqlite &&
      warmSqlite.indexPath === resolvedIndex &&
      warmSqlite.vault === config.vault &&
      warmSqlite.identity === beforeIdentity,
    );

    let db = null;
    try {
      await fs.mkdir(path.dirname(resolvedIndex), { recursive: true });
      db = await openDatabase(resolvedIndex);
      let initialized = false;
      try {
        initialized = initSchema(db, config.vault);
      } catch (schemaError) {
        if (!CORRUPT_RE.test(schemaError.message || '')) throw schemaError;
        try { db.close(); } catch {}
        db = null;
        await removeSqliteFiles(resolvedIndex);
        db = await openDatabase(resolvedIndex);
        initialized = initSchema(db, config.vault);
      }

      const existingRows = db.prepare('SELECT * FROM notes').all();
      const existing = new Map(existingRows.map(row => [row.path, row]));
      const currentSet = new Set(relPaths);
      const deletes = [];
      for (const row of existingRows) {
        if (!currentSet.has(row.path)) deletes.push(row.id);
      }

      const upserts = [];
      for (const info of fileInfos) {
        const old = existing.get(info.relative);
        if (
          old &&
          old.signature === info.signature &&
          typeof old.content === 'string' &&
          old.path === info.relative &&
          (trusted || hash(old.content) === old.revision)
        ) {
          continue;
        }
        upserts.push(info);
      }

      const freshEntries = new Map();
      let upsertCursor = 0;
      await Promise.all(Array.from({ length: Math.min(24, upserts.length) }, async () => {
        while (upsertCursor < upserts.length) {
          const info = upserts[upsertCursor++];
          const { content, ...note } = await readRawNote(config, info.relative);
          freshEntries.set(info.relative, { signature: info.signature, content, note });
        }
      }));

      if (upserts.length > 0 || deletes.length > 0 || initialized) {
        const deleteFts = db.prepare('DELETE FROM notes_fts WHERE rowid = ?');
        const deleteNote = db.prepare('DELETE FROM notes WHERE id = ?');
        const insertFts = db.prepare('INSERT INTO notes_fts(rowid, title, path, body) VALUES (?, ?, ?, ?)');
        const updateNote = db.prepare(
          'UPDATE notes SET signature = ?, revision = ?, title = ?, owner = ?, status = ?, project = ?, source = ?, kind = ?, supersedes = ?, conflicts_with = ?, updated = ?, excerpt = ?, links_json = ?, content = ? WHERE id = ?'
        );
        const insertNote = db.prepare(
          'INSERT INTO notes(path, signature, revision, title, owner, status, project, source, kind, supersedes, conflicts_with, updated, excerpt, links_json, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        db.exec('BEGIN IMMEDIATE');
        try {
          for (const id of deletes) {
            deleteFts.run(id);
            deleteNote.run(id);
          }
          for (const info of upserts) {
            const entry = freshEntries.get(info.relative);
            const { note, content } = entry;
            const linksJson = JSON.stringify(Array.isArray(note.links) ? note.links : []);
            const old = existing.get(note.path);
            let rowId;
            if (old) {
              rowId = Number(old.id);
              deleteFts.run(rowId);
              updateNote.run(
                entry.signature, note.revision, note.title, note.owner, note.status, note.project,
                note.source, note.kind, note.supersedes, note.conflictsWith, note.updated, note.excerpt,
                linksJson, content, rowId
              );
            } else {
              const inserted = insertNote.run(
                note.path, entry.signature, note.revision, note.title, note.owner, note.status, note.project,
                note.source, note.kind, note.supersedes, note.conflictsWith, note.updated, note.excerpt,
                linksJson, content
              );
              rowId = Number(inserted.lastInsertRowid);
            }
            insertFts.run(rowId, normalizeSearchText(note.title), normalizeSearchText(note.path), normalizeSearchText(content));
          }
          db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA_VERSION);
          db.prepare("INSERT INTO meta(key, value) VALUES ('vault', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(config.vault);
          db.exec('COMMIT');
        } catch (txError) {
          try { db.exec('ROLLBACK'); } catch {}
          throw txError;
        }
      }

      const entries = [];
      for (const info of fileInfos) {
        const fresh = freshEntries.get(info.relative);
        if (fresh) entries.push(fresh);
        else entries.push(rowToEntry(existing.get(info.relative)));
      }

      db.close();
      db = null;

      const mainStat = await fs.stat(resolvedIndex).catch(() => null);
      if (mainStat && mainStat.size <= MAX_WARM_SQLITE_BYTES) {
        warmSqlite = {
          indexPath: resolvedIndex,
          vault: config.vault,
          identity: await diskIdentityFor(resolvedIndex),
        };
      } else {
        warmSqlite = null;
      }

      return { entries, persisted: true };
    } catch (error) {
      if (db) {
        try { db.close(); } catch {}
        db = null;
      }
      warmSqlite = null;
      if (isUnwritableError(error) || CORRUPT_RE.test(error.message || '')) {
        console.warn(`Shared Brain: derivative SQLite index unavailable (${error.message}); using memory.`);
        const entries = await readAllRaw(config, fileInfos, readRawNote);
        return { entries, persisted: false };
      }
      throw error;
    } finally {
      if (db) {
        try { db.close(); } catch {}
      }
    }
  });
}

export async function queryVaultFts(config, indexPath, words, { all = false, project = 'global' } = {}) {
  if (!words.length) return [];
  const resolvedIndex = path.resolve(indexPath);
  let db = null;
  try {
    db = await openDatabase(resolvedIndex);
    db.exec('PRAGMA busy_timeout = 5000;');
    const schemaRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const vaultRow = db.prepare("SELECT value FROM meta WHERE key = 'vault'").get();
    if (schemaRow?.value !== SCHEMA_VERSION || vaultRow?.value !== config.vault) return null;
    const match = words.map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ');
    const rows = all
      ? db.prepare('SELECT n.path, bm25(notes_fts, 8.0, 4.0, 1.0) AS rank FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid WHERE notes_fts MATCH ? ORDER BY rank, n.id').all(match)
      : db.prepare("SELECT n.path, bm25(notes_fts, 8.0, 4.0, 1.0) AS rank FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid WHERE notes_fts MATCH ? AND n.project IN ('global', ?) ORDER BY rank, n.id").all(match, project);
    return rows.map(row => ({ path: row.path, score: -Number(row.rank) }));
  } catch (error) {
    console.warn(`Shared Brain: FTS query fallback (${error.message})`);
    return null;
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
}
