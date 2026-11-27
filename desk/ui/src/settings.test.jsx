import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';
import { Prefs, usePrefs } from './color-scheme.js';
import { Settings, sectionOf } from './settings.jsx';
import { ROUTES } from './routes.js';
import { useKept } from './kept.js';

const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
// A window's fetch over a table of routes: anything else never answers.
const serve = (table) => vi.fn((url) => (url in table ? json(table[url]) : new Promise(() => {})));

const REPOS = [{ slug: 'studia__studia-web', name: 'studia-web' }, { slug: 'studia__studia-zendesk', name: 'studia-zendesk' }];
const WEB = { slug: 'studia__studia-web', name: 'studia-web', rows: [
  { group: 'Autonomy (§3)', id: 'pr-merge-green', label: 'Merge on green', value: 'ask', meaning: 'Desk asks you before each merge.', set: true },
  { group: 'People', id: 'jira-site', label: 'Jira site', value: 'Not set', meaning: "Desk can't use this until it's set.", set: false },
] };
const SUBS = { file: '~/.config/desk/subscriptions.md', pinned: ['studia-web and ai-agents run on ops@studia.example (work-2)'], rows: [
  { tool: 'Claude', email: 'ben@studia.example', name: 'default', plan: 'Max 20x', badge: 'Default', note: 'Claude default' },
  { tool: 'Claude', email: 'ops@studia.example', name: 'work-2', plan: null, badge: 'Pinned · 2 repos', note: null },
  { tool: 'Claude', email: 'ben@personal.example', name: 'work-3', plan: null, badge: 'Off', note: "desk won't pick it for new work." },
] };
const INSTALL = { checkout: '~/studia/desk-skills', checked_at: null, installed: { commit: 'c47f43ab00', at: null }, main: { commit: '3e91b0d200', ahead: 2, check: 'pending' },
  state: { glyph: '·', text: "· Waiting for main's tests check on 3e91b0d2. desk installs it once the check passes." }, updates: null };
const META = { version: 'c47f43ab00', app: { build: 'h1', failed: null }, installed: 'c47f43ab00', updates: { count: 3, names: ['context-audit', 'claude-statusline', 'plugin vercel'], at: '2026-11-27T08:00:00Z' } };
const TABLE = { '/api/settings/repos': REPOS, '/api/settings/repos/studia__studia-web': WEB, '/api/settings/subscriptions': SUBS, '/api/settings/install': INSTALL, '/api/meta': META,
  '/api/settings/repos/studia__studia-zendesk': { slug: 'studia__studia-zendesk', name: 'studia-zendesk', error: "Can't read studia-zendesk's desk setup (desk-config.md missing). Run /desk-setup to create it." } };

function appearance(dark) {
  window.matchMedia = vi.fn(() => ({ matches: dark, addEventListener: () => {}, removeEventListener: () => {} }));
}
function Harness({ path, get, bridge = null, go = () => {} }) {
  const prefs = usePrefs(bridge);
  return <Prefs.Provider value={prefs}><Settings path={path} go={go} get={get} routes={ROUTES} /></Prefs.Provider>;
}

beforeEach(() => { appearance(false); });
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); delete document.documentElement.dataset.theme; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('a repo\'s settings', () => {
  it('AC1 shows each row\'s value and meaning, and an unset Jira site as Not set', async () => {
    render(<Harness path="/settings/repos/studia__studia-web" get={serve(TABLE)} />);
    const merge = await screen.findByText('Merge on green');
    const row = merge.closest('[data-row]');
    expect(within(row).getByText('ask')).toBeTruthy();
    expect(within(row).getByText('Desk asks you before each merge.')).toBeTruthy();
    const jira = screen.getByText('Jira site').closest('[data-row]');
    expect(within(jira).getByText('Not set')).toBeTruthy();
    expect(within(jira).getByText("Desk can't use this until it's set.")).toBeTruthy();
  });

  it('AC2 is read only, and says where changes are made', async () => {
    render(<Harness path="/settings/repos/studia__studia-web" get={serve(TABLE)} />);
    expect(await screen.findByText("These come from studia-web's desk setup. To change them, run /desk-setup: it checks each change with you before saving.")).toBeTruthy();
    const main = screen.getByText('Merge on green').closest('[data-row]').parentElement;
    expect(main.querySelectorAll('input, select, textarea').length).toBe(0);
  });

  it('AC3 says when the desk setup is missing', async () => {
    render(<Harness path="/settings/repos/studia__studia-zendesk" get={serve(TABLE)} />);
    expect(await screen.findByText("Can't read studia-zendesk's desk setup (desk-config.md missing). Run /desk-setup to create it.")).toBeTruthy();
  });
});

describe('subscriptions', () => {
  it('AC4 leads each row with its email, badges it, and points at Usage & costs', async () => {
    render(<Harness path="/settings/subscriptions" get={serve(TABLE)} />);
    await screen.findByText('ops@studia.example');
    const rows = [...document.querySelectorAll('[data-subscription]')];
    expect(rows.map((r) => [r.dataset.subscription, r.querySelector('[data-badge]').textContent]))
      .toEqual([['ben@studia.example', 'Default'], ['ops@studia.example', 'Pinned · 2 repos'], ['ben@personal.example', 'Off']]);
    expect(rows.map((r) => r.firstElementChild.firstElementChild.textContent)).toEqual(['ben@studia.example', 'ops@studia.example', 'ben@personal.example']);
    expect(screen.getByText("Make a default, pin a repo or add a subscription in Usage & costs, next to each subscription's limits.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Subscriptions' })).toBeTruthy();
  });
});

describe('Desk install', () => {
  it('AC5 gives the state line while main waits for its tests check', async () => {
    render(<Harness path="/settings/install" get={serve(TABLE)} />);
    expect(await screen.findByText("· Waiting for main's tests check on 3e91b0d2. desk installs it once the check passes.")).toBeTruthy();
  });

  it('AC6 badges Desk install with the update count, and nothing else', async () => {
    render(<Harness path="/settings/app" get={serve(TABLE)} />);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect((await within(nav).findByText('3 updates')).closest('button').textContent).toBe('Desk install3 updates');
    expect(document.querySelectorAll('[data-banner]').length).toBe(0);
  });
});

describe('App preferences', () => {
  it('AC13 Theme Dark turns the window dark at once, and shows Saved for 2 s', async () => {
    let resolve;
    const bridge = { prefs: vi.fn(async () => ({ theme: 'system', density: 'comfortable' })), setPref: vi.fn(() => new Promise((r) => { resolve = r; })) };
    vi.useFakeTimers();
    render(<Harness path="/settings/app" get={serve(TABLE)} bridge={bridge} />);
    await act(async () => {});
    const dark = screen.getByRole('radio', { name: 'Dark' });
    await act(async () => { fireEvent.click(dark); });
    expect(dark.getAttribute('aria-checked')).toBe('true');
    expect(bridge.setPref).toHaveBeenCalledWith('theme', 'dark');
    expect(screen.queryByText('Saved')).toBeNull();
    await act(async () => { resolve({ theme: 'dark', density: 'comfortable' }); });
    expect(screen.getByText('Saved')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1999); });
    expect(screen.getByText('Saved')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('AC13 the theme lands on <html> as soon as it is picked', async () => {
    const bridge = { prefs: vi.fn(async () => ({})), setPref: vi.fn(async (k, v) => ({ theme: v, density: 'comfortable' })) };
    const get = serve({ ...TABLE, '/api/setup': { installed: true, repos: 1 }, '/api/snapshot': { at: new Date().toISOString(), rev: 1 } });
    vi.stubGlobal('caches', undefined);
    render(<App deps={{ get, Events: null, desk: bridge, routes: { settings: Settings } }} />);
    const button = await screen.findByRole('button', { name: /Settings/ });
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('AC14 saves through the app\'s own preferences, and runs no desk command', async () => {
    const bridge = { prefs: vi.fn(async () => ({})), setPref: vi.fn(async (k, v) => ({ theme: v, density: 'comfortable' })) };
    const get = serve(TABLE);
    render(<Harness path="/settings/app" get={get} bridge={bridge} />);
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Dark' })); });
    expect(bridge.setPref).toHaveBeenCalledWith('theme', 'dark');
    expect(get.mock.calls.filter(([, o]) => o?.method && o.method !== 'GET')).toEqual([]);
  });

  it('AC15 a missing or unreadable preferences file is System and Comfortable, with no error', async () => {
    for (const prefs of [async () => null, async () => { throw new Error('unreadable'); }, async () => ({ theme: 'purple' })]) {
      render(<Harness path="/settings/app" get={serve(TABLE)} bridge={{ prefs, setPref: async () => null }} />);
      await act(async () => {});
      expect(screen.getByRole('radio', { name: 'System' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.getByRole('radio', { name: 'Comfortable' }).getAttribute('aria-checked')).toBe('true');
      expect(screen.queryByRole('alert')).toBeNull();
      cleanup();
    }
  });
});

describe('the route', () => {
  it('AC16 ⌘, opens Settings from any screen, and the sidebar footer lists it', async () => {
    const get = serve({ ...TABLE, '/api/setup': { installed: true, repos: 1 }, '/api/snapshot': { at: new Date().toISOString(), rev: 1 }, '/api/inbox': { items: [] } });
    vi.stubGlobal('caches', undefined);
    render(<App deps={{ get, Events: null }} />);
    const footer = await screen.findByRole('button', { name: /^Settings/ });
    expect(footer.closest('ul').classList.contains('mt-auto')).toBe(true);
    act(() => { fireEvent.keyDown(window, { key: '1', metaKey: true }); });
    act(() => { fireEvent.keyDown(window, { key: ',', metaKey: true }); });
    expect(await screen.findByRole('navigation', { name: 'Settings' })).toBeTruthy();
    expect(document.querySelector('[data-page-title]').textContent).toBe('Settings');
  });

  it('reads its section from the path', () => {
    expect(['/settings', '/settings/app', '/settings/subscriptions', '/settings/install', '/settings/repos/a__b', '/settings/nope'].map((p) => sectionOf(p)))
      .toEqual([{ id: 'app' }, { id: 'app' }, { id: 'subscriptions' }, { id: 'install' }, { id: 'repo', slug: 'a__b' }, { id: 'app' }]);
  });
});

// ---- the app's own banners and the release toast --------------------------------------------------

// An EventSource the test drives: `fire(name, data)` sends one event.
function stream() {
  const all = [];
  class Events {
    constructor() { this.l = {}; all.push(this); setTimeout(() => this.onopen?.(), 0); }
    addEventListener(n, f) { this.l[n] = f; }
    close() { this.closed = true; }
  }
  return { Events, fire: (n, d) => act(() => { all.at(-1).l[n]?.({ data: JSON.stringify(d) }); }), error: () => act(() => { all.at(-1).onerror?.(); }), all };
}
const AT = new Date(2026, 10, 27, 10, 12).toISOString();
function live(extra = {}) {
  let up = true;
  const table = { '/api/setup': { installed: true, repos: 1 }, '/api/snapshot': { at: AT, rev: 1 }, '/api/meta': META, '/api/inbox': { items: [] }, ...extra };
  const get = vi.fn((url) => (!up ? Promise.reject(new Error('down')) : url in table ? json(table[url]) : new Promise(() => {})));
  return { get, down: () => { up = false; }, up: () => { up = true; }, table };
}

describe('app updated', () => {
  it('AC7 a new app build while the window is open is the Reload banner', async () => {
    const s = stream();
    const w = live();
    vi.stubGlobal('caches', undefined);
    const reload = vi.fn();
    render(<App deps={{ get: w.get, Events: s.Events, reload }} />);
    await screen.findByRole('navigation', { name: 'Desk' });
    await act(async () => {});
    s.fire('server', { app: { build: 'h2', failed: null }, installed: META.installed });
    const banner = document.querySelector('[data-banner="app-updated"]');
    expect(banner.textContent).toContain('Desk updated. Reload to use the new version of the app.');
    expect(within(banner).getByRole('button', { name: 'Reload ⌘R' })).toBeTruthy();
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload ⌘R' }));
    expect(reload).toHaveBeenCalledTimes(1);
    act(() => { fireEvent.keyDown(window, { key: 'r', metaKey: true }); });
    expect(reload).toHaveBeenCalledTimes(2);
    fireEvent.click(within(banner).getByRole('button', { name: 'Later' }));
    expect(document.querySelector('[data-banner="app-updated"]')).toBeNull();
  });

  it('AC7 the same build is no banner', async () => {
    const s = stream();
    vi.stubGlobal('caches', undefined);
    render(<App deps={{ get: live().get, Events: s.Events }} />);
    await screen.findByRole('navigation', { name: 'Desk' });
    await act(async () => {});
    s.fire('server', { app: { build: 'h1', failed: null }, installed: META.installed });
    expect(document.querySelector('[data-banner]')).toBeNull();
  });

  // "The filter text" is the answer typed and not sent, with the Inbox's filters and the item open: the
  // Inbox has no free-text filter. The keys are App's and the Inbox's own (App.jsx, inbox.jsx).
  it('AC8 a reload keeps the screen, the Inbox item open, its filters and the unsent answer', () => {
    function Probe() {
      const [path, setPath] = useKept('path', '/');
      const [sel, setSel] = useKept('inbox:sel', null);
      const [repo, setRepo] = useKept('inbox:repo', '');
      const [kind, setKind] = useKept('inbox:kind', '');
      const [draft, setDraft] = useKept('inbox:draft:SV-3844', '');
      const type = () => { setPath('/inbox'); setSel('SV-3844'); setRepo('studia-web'); setKind('park'); setDraft('run the checks'); };
      return <div data-kept={JSON.stringify([path, sel, repo, kind, draft])}><button type="button" onClick={type}>type</button></div>;
    }
    const keptNow = () => JSON.parse(document.querySelector('[data-kept]').dataset.kept);
    render(<Probe />);
    fireEvent.click(screen.getByRole('button', { name: 'type' }));
    window.dispatchEvent(new Event('pagehide')); // the reload
    cleanup();
    render(<Probe />);
    expect(keptNow()).toEqual(['/inbox', 'SV-3844', 'studia-web', 'park', 'run the checks']);
    cleanup();
    render(<Probe />); // read back once: a screen opened again later starts fresh
    expect(keptNow()).toEqual(['/', null, '', '', '']);
  });

  it('a 401 before Desk.app signs in again keeps an unsent answer, though the card unmounts its screen', async () => {
    function Draft() {
      const [draft, setDraft] = useKept('inbox:draft:SV-3844', '');
      return <div><span>{draft}</span><button type="button" onClick={() => setDraft('run the checks')}>type</button></div>;
    }
    const s = stream();
    let signedIn = true;
    const table = { '/api/setup': { installed: true, repos: 1 }, '/api/snapshot': { at: AT, rev: 1 }, '/api/meta': META };
    const get = vi.fn((url) => (url === '/api/setup' && !signedIn ? json({ error: { code: 'unauthorized' } }, 401) : url in table ? json(table[url]) : new Promise(() => {})));
    vi.stubGlobal('caches', undefined);
    render(<App deps={{ get, Events: s.Events, routes: { inbox: Draft } }} />);
    await screen.findByRole('navigation', { name: 'Desk' });
    await act(async () => {});
    act(() => { fireEvent.keyDown(window, { key: '1', metaKey: true }); });
    fireEvent.click(await screen.findByRole('button', { name: 'type' }));
    signedIn = false;
    await act(async () => { s.error(); });
    await vi.waitFor(() => { if (screen.queryByRole('button', { name: 'type' })) throw new Error('still mounted'); }, { timeout: 2000, interval: 5 });
    expect(sessionStorage.getItem('desk:kept:inbox:draft:SV-3844')).toBe('"run the checks"');
  });
});

describe('the server restarting after an update', () => {
  it('AC9 losing the server after it said so is the restarting banner over the last copy, AC10 then the reconnected toast', async () => {
    const s = stream();
    const w = live();
    vi.stubGlobal('caches', undefined);
    // A countdown second of 40 ms: the retry comes after 200 ms, and the toast then shows for 200 ms.
    render(<App deps={{ get: w.get, Events: s.Events, tickMs: 40 }} />);
    await screen.findByRole('navigation', { name: 'Desk' });
    await act(async () => {});
    s.fire('server', { app: META.app, installed: 'newer', restartRequired: true, restarting: true });
    w.down();
    await act(async () => { s.error(); });
    const banner = await vi.waitFor(() => { const b = document.querySelector('[data-banner="restarting"]'); if (!b) throw new Error('no banner yet'); return b; }, { timeout: 2000, interval: 5 });
    expect(banner.textContent).toContain("Desk's server is restarting after an update. Reconnecting… You're looking at the copy from 10:12.");
    expect(screen.queryByText("Desk can't reach its local server")).toBeNull();
    w.up();
    await vi.waitFor(() => { if (!screen.queryByText('Reconnected. Showing live data.')) throw new Error('no toast yet'); }, { timeout: 2000, interval: 10 });
    expect(document.querySelector('[data-banner="restarting"]')).toBeNull();
  });
});

describe('the app build failed', () => {
  it('AC11 says so when the window loads, with its sub-line and Open install log', async () => {
    const w = live({ '/api/meta': { ...META, app: { build: 'h1', failed: 'h2' } }, '/api/settings/install-log': { opened: '~/x' } });
    vi.stubGlobal('caches', undefined);
    render(<App deps={{ get: w.get, Events: null }} />);
    await screen.findByRole('navigation', { name: 'Desk' });
    const banner = await vi.waitFor(() => { const b = document.querySelector('[data-banner="app-failed"]'); if (!b) throw new Error('no banner'); return b; });
    expect(banner.textContent).toContain("Desk updated, but the app's new version didn't build. You're on the previous app version.");
    expect(banner.textContent).toContain('The update itself still applies: supervisors and workers run the new desk code. Only the window stays on the previous app.');
    fireEvent.click(within(banner).getByRole('button', { name: 'Open install log' }));
    expect(w.get).toHaveBeenCalledWith('/api/settings/install-log', { method: 'POST' });
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(document.querySelector('[data-banner="app-failed"]')).toBeNull();
  });
});

describe('a desk release', () => {
  it('AC12 installed while the window is open is the release toast', async () => {
    const s = stream();
    vi.stubGlobal('caches', undefined);
    render(<App deps={{ get: live().get, Events: s.Events }} />);
    await screen.findByRole('navigation', { name: 'Desk' });
    await act(async () => {});
    s.fire('server', { app: META.app, installed: '3e91b0d2aa', released: { from: META.installed, commits: 2 } });
    expect(screen.getByText('Desk updated to 3e91b0d2 (2 commits). Supervisors move to it by themselves.').parentElement.textContent).toContain('✓');
  });
});
