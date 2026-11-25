import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './theme.css';

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

// The service worker keeps the app and the last snapshot, so a reload still shows them while the
// server is down.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
