import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';

let nextToastId = 1;
let toasts = [];
const listeners = new Set();

function notifyListeners() {
  for (const fn of listeners) fn([...toasts]);
}

export function dismissToast(id) {
  toasts = toasts.filter(item => item.id !== id);
  notifyListeners();
}

export function showToast({ message, tone = 'info', actionLabel = '', onAction = null, durationMs = 5000 }) {
  const id = nextToastId++;
  toasts = [...toasts.slice(-3), { id, message, tone, actionLabel, onAction }];
  notifyListeners();
  if (durationMs > 0) {
    setTimeout(() => dismissToast(id), durationMs);
  }
  return id;
}

export function ToastViewport() {
  const [items, setItems] = useState(toasts);
  useEffect(() => {
    listeners.add(setItems);
    return () => listeners.delete(setItems);
  }, []);

  if (!items.length) return null;

  return (
    <div className="toast-viewport" aria-live="polite" aria-label="Notifications">
      {items.map(item => (
        <div key={item.id} className={`toast toast-${item.tone}`} role={item.tone === 'error' ? 'alert' : 'status'}>
          <span className="toast-message">{item.message}</span>
          {item.actionLabel && item.onAction && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                dismissToast(item.id);
                item.onAction();
              }}
            >
              {item.actionLabel}
            </button>
          )}
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(item.id)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
