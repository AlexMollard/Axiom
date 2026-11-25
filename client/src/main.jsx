import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

const isQuickMode = new URLSearchParams(location.search).get('desktopMode') === 'quick';
const RootView = lazy(() => (isQuickMode ? import('./QuickOverlay.jsx') : import('./App.jsx')));

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={<div className="boot">{isQuickMode ? 'Loading quick switcher...' : 'Reading your vault...'}</div>}>
      <RootView />
    </Suspense>
  </React.StrictMode>
);
