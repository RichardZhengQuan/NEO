import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { STORAGE_KEYS, readString } from './lib/storage.js';
import { getPlatform, registerServiceWorker } from './platform/index.js';

// Apply the last known theme before the first paint (no light flash in dark mode).
const cachedTheme = readString(STORAGE_KEYS.theme);
if (cachedTheme === 'light' || cachedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', cachedTheme);
  document.documentElement.classList.toggle('dark', cachedTheme === 'dark');
}

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The PWA's service worker (offline shell + push). Not in dev (stale caches),
// and not inside the desktop/mobile shells, which load the app from disk.
if (import.meta.env.PROD && getPlatform().kind === 'browser') {
  window.addEventListener('load', () => void registerServiceWorker());
}
