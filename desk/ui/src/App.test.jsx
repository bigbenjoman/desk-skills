import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';

// The Mac's appearance as Electron passes it to the page, switchable while the app is open.
function appearance(dark) {
  const listeners = new Set();
  const query = { matches: dark, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
  window.matchMedia = vi.fn(() => query);
  return { set(next) { query.matches = next; act(() => listeners.forEach((f) => f())); }, listeners };
}

afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; vi.unstubAllGlobals(); });

describe('the theme follows the Mac', () => {
  it('uses the dark tokens in dark appearance, and the light ones in light', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const mac = appearance(true);
    render(<App />);
    expect(document.documentElement.dataset.theme).toBe('dark');
    mac.set(false);
    expect(document.documentElement.dataset.theme).toBe('light');
    mac.set(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
    cleanup();
    expect(mac.listeners.size).toBe(0);
  });

  it('shows when the snapshot it has was read', async () => {
    appearance(false);
    const at = new Date(2026, 10, 22, 10, 7).toISOString();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ at, rev: 1 }), { status: 200 })));
    vi.stubGlobal('caches', undefined);
    render(<App />);
    expect(await screen.findByText('As of 10:07')).toBeTruthy();
  });
});

// The custom properties a block declares, as { name: value }.
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const blocks = (css) => ({
  light: tokens(css.match(/:root\{([\s\S]*?)\n\}/)[1]),
  system: tokens(css.match(/@media \(prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{([\s\S]*?)\n\}\}/)[1]),
  dark: tokens(css.match(/:root\[data-theme="dark"\]\{([\s\S]*?)\n\}/)[1]),
});
// The canvas draws macOS windows on a board; these are its board and window chrome, not the app's.
const chrome = (name) => /^(cv-|tl-|win-edge$)/.test(name);
const appTokens = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => !chrome(k)));

describe("the theme is the canvas's", () => {
  const canvas = blocks(readFileSync(new URL('../../../docs/design/DS-691/project/index.html', import.meta.url), 'utf8'));
  const app = blocks(readFileSync(new URL('./theme.css', import.meta.url), 'utf8'));

  it('has every light token, value for value', () => {
    const { 'font-sans': sans, ...rest } = appTokens(canvas.light);
    expect(app.light).toMatchObject(rest);
    // The fontsource package names Geist "Geist Sans"; it sits second, after the canvas's "Geist".
    expect(app.light['font-sans']).toBe(sans.replace('"Geist",', '"Geist","Geist Sans",'));
  });

  it('has every dark token, value for value, for the system appearance and for data-theme="dark"', () => {
    expect(app.system).toEqual(appTokens(canvas.system));
    expect(app.dark).toEqual(appTokens(canvas.dark));
  });
});
