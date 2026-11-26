import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';
import { WriteButton } from './system.jsx';

// A fixture token: the app is never given one, and none may reach the page.
const TOKEN = ['tok', 'c3'.repeat(30)].join('');
const AT = new Date(2026, 10, 22, 10, 6).toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A desk-ui server the window talks to, which can stop, refuse the window's sign-in, or report desk missing.
function stubServer() {
  const s = {
    mode: 'up', streams: [], posts: [],
    setup: { installed: true, checkout: '~/studia/desk-skills', repos: 1, found: [] },
    snapshot: { at: AT, rev: 1 },
  };
  s.get = vi.fn(async (url, opts = {}) => {
    if (s.mode === 'down') throw new TypeError('Failed to fetch');
    if (s.mode === 'refused') return json({ error: { code: 'unauthorized', message: 'Not signed in.' } }, 401);
    if (url === '/api/setup') return json(s.setup);
    if (url === '/api/snapshot') return json(s.snapshot);
    if (url === '/api/terminal' && opts.method === 'POST') { s.posts.push(JSON.parse(opts.body)); return json({ opened: JSON.parse(opts.body).folder }); }
    return json({ error: { code: 'not_found' } }, 404);
  });
  s.Events = class {
    constructor(url) { this.url = url; this.on = {}; this.closed = false; s.streams.push(this); }
    addEventListener(name, f) { this.on[name] = f; }
    close() { this.closed = true; }
  };
  const kept = new Map();
  s.store = { open: async () => ({ match: async (k) => kept.get(k)?.clone(), put: async (k, r) => { kept.set(k, r); } }) };
  // The server stops: the open stream errors, as EventSource does when its connection drops.
  s.drop = () => act(() => { for (const es of s.streams) if (!es.closed) es.onerror?.(); });
  s.stop = () => { s.mode = 'down'; s.drop(); };
  s.deps = { get: s.get, Events: s.Events, store: s.store, tickMs: 20 };
  return s;
}

const consoleLines = [];
beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  for (const level of ['log', 'warn', 'error', 'info']) vi.spyOn(console, level).mockImplementation((...a) => { consoleLines.push(a.map(String).join(' ')); });
});
afterEach(() => { cleanup(); sessionStorage.clear(); localStorage.clear(); consoleLines.length = 0; vi.restoreAllMocks(); });

const body = () => document.body.textContent;

describe('the server stops answering', () => {
  it('AC1 shows the server-down body with the copy it holds, the command, and the retry countdown', async () => {
    const s = stubServer();
    render(<App deps={s.deps} />);
    expect(await screen.findByText('As of 10:06')).toBeTruthy();
    s.stop();
    expect(await screen.findByText("Desk can't reach its local server")).toBeTruthy();
    expect(body()).toContain("You're looking at the copy from 10:06.");
    expect(screen.getByText('launchctl kickstart -k gui/$(id -u)/com.desk-skills.ui')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy launchctl kickstart -k gui/$(id -u)/com.desk-skills.ui' })).toBeTruthy();
    expect(screen.getByText('Trying again in 5 s… (attempt 1)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try now' })).toBeTruthy();
    // The countdown runs out and it tries again: still down, so the next attempt.
    expect(await screen.findByText('Trying again in 5 s… (attempt 2)')).toBeTruthy();
  });

  it('AC1 a reload with the server stopped shows the copy kept from before', async () => {
    const s = stubServer();
    render(<App deps={s.deps} />);
    await screen.findByText('As of 10:06');
    cleanup();
    s.mode = 'down';
    render(<App deps={s.deps} />);
    expect(await screen.findByText("Desk can't reach its local server")).toBeTruthy();
    expect(body()).toContain("You're looking at the copy from 10:06.");
  });

  it('AC1 Copy puts the command on the clipboard', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const s = stubServer();
    s.mode = 'down';
    render(<App deps={s.deps} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Copy launchctl/ }));
    expect(writeText).toHaveBeenCalledWith('launchctl kickstart -k gui/$(id -u)/com.desk-skills.ui');
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('AC2 every action button is off, with the tooltip, until the server is back', async () => {
    const s = stubServer();
    render(<App deps={s.deps}><WriteButton>Answer</WriteButton></App>);
    await screen.findByText('As of 10:06');
    const answer = screen.getByRole('button', { name: 'Answer' });
    expect([answer.disabled, answer.parentElement.title]).toEqual([false, '']);
    s.stop();
    await screen.findByText("Desk can't reach its local server");
    expect([answer.disabled, answer.parentElement.title]).toEqual([true, "Can't change anything until the server is back."]);
    s.mode = 'up';
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await waitFor(() => expect(answer.disabled).toBe(false));
  });

  it('AC3 when the server answers again the body goes and the reconnect toast shows', async () => {
    const s = stubServer();
    render(<App deps={s.deps} />);
    await screen.findByText('As of 10:06');
    s.stop();
    await screen.findByText("Desk can't reach its local server");
    s.mode = 'up';
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(await screen.findByText('Reconnected. Showing live data.')).toBeTruthy();
    expect(screen.queryByText("Desk can't reach its local server")).toBeNull();
    expect(screen.getByText('As of 10:06')).toBeTruthy();
  });

  it('AC3 the toast also shows after Desk.app reloads the window for a restarted server', async () => {
    const s = stubServer();
    s.mode = 'down';
    render(<App deps={s.deps} />);
    await screen.findByText("Desk can't reach its local server");
    cleanup();
    s.mode = 'up';
    render(<App deps={s.deps} />);
    expect(await screen.findByText('Reconnected. Showing live data.')).toBeTruthy();
  });
});

describe('the window is not signed in', () => {
  it('AC4 says so, with the install command for this checkout', async () => {
    const s = stubServer();
    render(<App deps={s.deps} />);
    await screen.findByText('As of 10:06');
    s.mode = 'refused'; // the server forgot this window's session: the stream drops, the next request is refused
    s.drop();
    expect(await screen.findByText("This window isn't signed in to Desk")).toBeTruthy();
    expect(screen.getByText("Re-run install.sh in Terminal. It writes Desk's sign-in again, and this window signs in by itself.")).toBeTruthy();
    expect(screen.getByText('cd ~/studia/desk-skills && ./install.sh')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy cd ~/studia/desk-skills && ./install.sh' })).toBeTruthy();
  });

  it('AC5 no part of the token reaches the page, its tooltips or the console', async () => {
    const s = stubServer();
    s.mode = 'refused';
    render(<App deps={s.deps}><WriteButton>Answer</WriteButton></App>);
    await screen.findByText("This window isn't signed in to Desk");
    expect(screen.getByRole('button', { name: 'Answer' }).parentElement.title).toBe('Sign in first: re-run install.sh in Terminal.');
    const seen = [document.documentElement.outerHTML, ...[...document.querySelectorAll('[title]')].map((e) => e.title), ...consoleLines].join('\n');
    for (let i = 0; i + 8 <= TOKEN.length; i += 4) expect(seen).not.toContain(TOKEN.slice(i, i + 8));
  });
});

describe('desk is not set up', () => {
  it('AC7 desk missing: says so, with the clone and install command', async () => {
    const s = stubServer();
    s.setup = { installed: false, checkout: null, repos: 0, found: [] };
    render(<App deps={s.deps} />);
    expect(await screen.findByText("Desk isn't installed on this Mac yet.")).toBeTruthy();
    expect(screen.getByText('Install it, then reopen this window.')).toBeTruthy();
    expect(screen.getByText('git clone https://github.com/bigbenjoman/desk-skills && cd desk-skills && ./install.sh')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Copy git clone/ })).toBeTruthy();
  });

  it('AC8 no repo configured: lists each git repo with Set up', async () => {
    const s = stubServer();
    s.setup = { installed: true, checkout: '~/studia/desk-skills', repos: 0,
      found: [{ name: 'desk-skills', path: '~/studia/desk-skills' }, { name: 'studia-web', path: '~/studia/studia-web' }] };
    render(<App deps={s.deps} />);
    expect(await screen.findByText('Set up desk in your first repo')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Set up / }).map((b) => b.textContent)).toEqual(['Set up', 'Set up']);
    expect(screen.getByText('~/studia/studia-web')).toBeTruthy();
    expect(screen.getByText('Desk only acts in repos you set up.')).toBeTruthy();
  });

  it('AC9 Set up on studia-web asks the server to open Terminal there', async () => {
    const s = stubServer();
    s.setup = { installed: true, checkout: null, repos: 0, found: [{ name: 'studia-web', path: '~/studia/studia-web' }] };
    render(<App deps={s.deps} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up studia-web' }));
    expect(await screen.findByText(/Terminal is running \/desk-setup in studia-web/)).toBeTruthy();
    expect(s.posts).toEqual([{ folder: 'studia-web' }]);
  });

  it('a repo set up from the list ends the list', async () => {
    const s = stubServer();
    s.setup = { installed: true, checkout: null, repos: 0, found: [{ name: 'studia-web', path: '~/studia/studia-web' }] };
    render(<App deps={s.deps} />);
    await screen.findByText('Set up desk in your first repo');
    s.setup = { ...s.setup, repos: 1, found: [] };
    act(() => { s.streams.at(-1).on.repo?.({ data: '{}' }); });
    expect(await screen.findByText('As of 10:06')).toBeTruthy();
  });
});
