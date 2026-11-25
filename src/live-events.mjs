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
  let vaultRetryTimer = null;
  let stateRetryTimer = null;
  let vaultRetries = 0;
  let stateRetries = 0;
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
    if (filename && pendingPaths.size < 256) pendingPaths.add(normalizeRel(filename));
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

  function scheduleVaultRetry() {
    if (closed || clients.size === 0 || vaultRetryTimer) return;
    const delay = Math.min(5000, 1000 * 2 ** vaultRetries++);
    vaultRetryTimer = setTimeout(() => {
      vaultRetryTimer = null;
      startVaultWatcher();
    }, delay);
    vaultRetryTimer.unref?.();
  }

  function scheduleStateRetry() {
    if (closed || clients.size === 0 || stateRetryTimer) return;
    const delay = Math.min(5000, 1000 * 2 ** stateRetries++);
    stateRetryTimer = setTimeout(() => {
      stateRetryTimer = null;
      startStateWatcher();
    }, delay);
    stateRetryTimer.unref?.();
  }

  function startVaultWatcher() {
    if (closed || vaultWatcher || clients.size === 0) return;
    try {
      if (existsSync(config.vault)) {
        vaultWatcher = watch(config.vault, { recursive: true }, (_eventType, filename) => {
          scheduleCatalog(filename);
        });
        vaultRetries = 0;
        vaultWatcher.on('error', () => {
          try { vaultWatcher?.close(); } catch {}
          vaultWatcher = null;
          broadcast('catalog', { changedPaths: [], resync: true, timestamp: new Date().toISOString() });
          scheduleVaultRetry();
        });
      } else {
        scheduleVaultRetry();
      }
    } catch {
      vaultWatcher = null;
      scheduleVaultRetry();
    }
  }

  function startStateWatcher() {
    if (closed || stateWatcher || clients.size === 0) return;
    const wasRetrying = stateRetries > 0;
    try {
      if (existsSync(stateDir)) {
        stateWatcher = watch(stateDir, (_eventType, filename) => {
          scheduleUsage(filename);
        });
        stateRetries = 0;
        stateWatcher.on('error', () => {
          try { stateWatcher?.close(); } catch {}
          stateWatcher = null;
          scheduleStateRetry();
        });
        if (wasRetrying) scheduleUsage('usage-resync');
      } else {
        scheduleStateRetry();
      }
    } catch {
      stateWatcher = null;
      scheduleStateRetry();
    }
  }

  function stopWatchers() {
    clearTimeout(catalogTimer);
    clearTimeout(usageTimer);
    clearTimeout(vaultRetryTimer);
    clearTimeout(stateRetryTimer);
    clearInterval(pingTimer);
    catalogTimer = null;
    usageTimer = null;
    vaultRetryTimer = null;
    stateRetryTimer = null;
    vaultRetries = 0;
    stateRetries = 0;
    pingTimer = null;
    pendingPaths.clear();
    try { vaultWatcher?.close(); } catch {}
    try { stateWatcher?.close(); } catch {}
    vaultWatcher = null;
    stateWatcher = null;
  }

  function startWatchers() {
    if (closed) return;
    startVaultWatcher();
    startStateWatcher();
    if (!pingTimer) {
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
