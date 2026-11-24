import { useEffect } from 'react';

const listeners = new Set();
let sharedSource = null;
let retryTimer = null;
let backoffMs = 1000;
let currentStatus = 'reconnecting';

function notifyStatus(status) {
  currentStatus = status;
  for (const sub of listeners) sub.onStatus?.(status);
}

function scheduleSharedReconnect() {
  if (!listeners.size) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    backoffMs = Math.min(15000, backoffMs * 2);
    ensureSharedConnection();
  }, backoffMs);
}

function ensureSharedConnection() {
  if (!listeners.size || sharedSource) return;
  if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
    notifyStatus('disconnected');
    return;
  }
  try {
    sharedSource = new window.EventSource('/api/events');
  } catch {
    notifyStatus('disconnected');
    scheduleSharedReconnect();
    return;
  }

  sharedSource.addEventListener('connected', () => {
    backoffMs = 1000;
    notifyStatus('connected');
  });

  sharedSource.addEventListener('catalog', event => {
    let payload = {};
    try { payload = JSON.parse(event.data || '{}'); } catch {}
    for (const sub of listeners) sub.onCatalog?.(payload);
  });

  sharedSource.addEventListener('usage', event => {
    let payload = {};
    try { payload = JSON.parse(event.data || '{}'); } catch {}
    for (const sub of listeners) sub.onUsage?.(payload);
  });

  sharedSource.onerror = () => {
    if (!listeners.size) return;
    try { sharedSource?.close(); } catch {}
    sharedSource = null;
    notifyStatus('reconnecting');
    scheduleSharedReconnect();
  };
}

export function subscribeVaultEvents({ onCatalog, onUsage, onStatus } = {}) {
  if (typeof window === 'undefined' || typeof window.EventSource !== 'function') {
    onStatus?.('disconnected');
    return () => {};
  }
  const subscriber = { onCatalog, onUsage, onStatus };
  listeners.add(subscriber);
  if (sharedSource && currentStatus === 'connected') {
    onStatus?.('connected');
  } else {
    onStatus?.(currentStatus);
  }
  ensureSharedConnection();

  return () => {
    listeners.delete(subscriber);
    if (!listeners.size) {
      clearTimeout(retryTimer);
      retryTimer = null;
      try { sharedSource?.close(); } catch {}
      sharedSource = null;
      currentStatus = 'disconnected';
    }
    onStatus?.('disconnected');
  };
}

export function useVaultEvents(handlers) {
  useEffect(() => {
    return subscribeVaultEvents(handlers);
    // Handlers are expected to be memoized or read from refs in callers.
  }, []);
}
