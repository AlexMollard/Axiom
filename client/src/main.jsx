import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

const isQuickMode = new URLSearchParams(location.search).get('desktopMode') === 'quick';
if (isQuickMode) {
  document.documentElement.classList.add('quick-mode');
  if (typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__)) {
    document.documentElement.classList.add('quick-mode-desktop');
  }
}
// A rebuilt or updated backend deletes the old hashed chunks; reload into the new bundle instead of blanking the app.
window.addEventListener('vite:preloadError', event => {
  const key = 'axiom.chunk-reload-at';
  let last = 0;
  try { last = Number(sessionStorage.getItem(key)) || 0; } catch {}
  if (Date.now() - last < 10000) return; // already reloaded just now: let the error surface rather than loop
  try { sessionStorage.setItem(key, String(Date.now())); } catch {}
  event.preventDefault();
  location.reload();
});

const RootView = lazy(() => (isQuickMode ? import('./QuickOverlay.jsx') : import('./App.jsx')));

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={<div className="boot">{isQuickMode ? 'Loading quick switcher...' : 'Reading your vault...'}</div>}>
      <RootView />
    </Suspense>
  </React.StrictMode>
);
