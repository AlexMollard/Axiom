import { existsSync, watch } from 'node:fs';
import path from 'node:path';

function normalizeRel(filename) {
  return String(filename || '').replaceAll('\\', '/');
}

function isRelevantVaultChange(filename) {
  if (!filename) return true;
  const rel = normalizeRel(filename);
  if (/\.tmp$/i.test(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((part, index) => part.startsWith('.') && !(index === 0 && part === '.trash'))) return false;
  if (parts[0] === '.trash' && parts.length > 1 && parts[1] !== 'axiom') return false;
  return true;
}

export function createEventHub(config) {
  const clients = new Set();
  const pendingPaths = new Set();
  let vaultWatcher = null;
  let stateWatcher = null;
  let catalogTimer = null;
  let usageTimer = null;
  let pingTimer = null;
  let closed = false;

  const stateDir = path.join(path.dirname(config.configPath || config.vault), '.state');

  function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      if (res.destroyed || res.writableEnded) {
        clients.delete(res);
        continue;
      }
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  function scheduleCatalog(filename) {
    if (closed || !isRelevantVaultChange(filename)) return;
    if (filename) pendingPaths.add(normalizeRel(filename));
    clearTimeout(catalogTimer);
    catalogTimer = setTimeout(() => {
      if (closed || clients.size === 0) return;
      const changedPaths = [...pendingPaths].slice(0, 100);
      pendingPaths.clear();
      broadcast('catalog', { changedPaths, timestamp: new Date().toISOString() });
    }, 150);
    catalogTimer.unref?.();
  }

  function scheduleUsage(filename) {
    if (closed) return;
    const rel = normalizeRel(filename);
    if (rel && !rel.startsWith('usage-')) return;
    clearTimeout(usageTimer);
    usageTimer = setTimeout(() => {
      if (closed || clients.size === 0) return;
      broadcast('usage', { timestamp: new Date().toISOString() });
    }, 400);
    usageTimer.unref?.();
  }

  function stopWatchers() {
    clearTimeout(catalogTimer);
    clearTimeout(usageTimer);
    clearInterval(pingTimer);
    catalogTimer = null;
    usageTimer = null;
    pingTimer = null;
    pendingPaths.clear();
    try { vaultWatcher?.close(); } catch {}
    try { stateWatcher?.close(); } catch {}
    vaultWatcher = null;
    stateWatcher = null;
  }

  function startWatchers() {
    if (closed || vaultWatcher) return;
    try {
      if (existsSync(config.vault)) {
        vaultWatcher = watch(config.vault, { recursive: true }, (_eventType, filename) => {
          scheduleCatalog(filename);
        });
        vaultWatcher.on('error', () => {
          try { vaultWatcher?.close(); } catch {}
          vaultWatcher = null;
        });
      }
    } catch {
      vaultWatcher = null;
    }

    try {
      if (existsSync(stateDir)) {
        stateWatcher = watch(stateDir, (_eventType, filename) => {
          scheduleUsage(filename);
        });
        stateWatcher.on('error', () => {
          try { stateWatcher?.close(); } catch {}
          stateWatcher = null;
        });
      }
    } catch {
      stateWatcher = null;
    }

    pingTimer = setInterval(() => {
      for (const res of clients) {
        if (res.destroyed || res.writableEnded) {
          clients.delete(res);
          continue;
        }
        try { res.write(': ping\n\n'); } catch { clients.delete(res); }
      }
    }, 25000);
    pingTimer.unref?.();
  }

  function handleRequest(req, res, baseHeaders = {}) {
    if (closed) {
      res.writeHead(503, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Server is closing.' }));
      return;
    }
    req.setTimeout?.(0);
    res.setTimeout?.(0);
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
    });
    res.write('event: connected\ndata: {"ok":true}\n\n');
    clients.add(res);
    if (clients.size === 1) startWatchers();

    const cleanup = () => {
      clients.delete(res);
      if (clients.size === 0) stopWatchers();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  function close() {
    closed = true;
    stopWatchers();
    for (const res of clients) {
      try { res.end(); } catch {}
    }
    clients.clear();
  }

  return { handleRequest, close, clientCount: () => clients.size };
}
