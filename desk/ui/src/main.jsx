import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './theme.css';

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

// The service worker keeps the app and the last snapshot, so a reload still shows them while the
// server is down. On the load that registers it, the page and its files were fetched before it
// existed, so the page hands it their addresses to keep (public/sw.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const first = !navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      if (!first) return;
      const loaded = performance.getEntriesByType('resource').map((entry) => entry.name);
      registration.active?.postMessage({ keep: ['/', ...loaded] });
    })
    .catch(() => {});
}
