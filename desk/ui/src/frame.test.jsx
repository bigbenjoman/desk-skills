import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';

const AT = new Date(2026, 10, 26, 10, 8).toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const repo = (name, more = {}) => ({ id: `owner__${name}`, slug: `owner__${name}`, name, error: null, running: 0, needs_you: 0,
  batches: [], production_broken: [], jira_site: null, ...more });

// The snapshot the server gives: four repos, one with the named batch DS-631; 25 need Ben; 7 workers.
const fixture = () => ({
  at: AT, rev: 1,
  needs_you: { count: 25, put_off: 0, oldest_at: new Date(Date.now() - ((12 * 24 + 14) * 60 + 5) * 60000).toISOString() },
  machine: { running: 7, cap: 30, room: 7, avail_gib: 27.5 },
  repos: [
    repo('desk-skills', { slug: 'bigbenjoman__desk-skills', id: 'bigbenjoman__desk-skills', running: 4,
      batches: [{ id: 'bigbenjoman__desk-skills:DS-631', name: 'desk-skills:DS-631', running: 0, needs_you: 0 }] }),
    repo('studia-web', { needs_you: 14, jira_site: 'jira.example.net' }),
    repo('studia-zendesk', { needs_you: 5 }),
    repo('ai-agents', { needs_you: 6, running: 3 }),
  ],
  no_batch: [], tickets: {},
});

// A desk-ui server with a stream the test drives: `send(event, data)` is the server emitting a change.
function stubServer(snapshot = fixture()) {
  const s = { streams: [] };
  s.get = vi.fn(async (url) => {
    if (url === '/api/setup') return json({ installed: true, checkout: '~/studia/desk-skills', repos: 4, found: [] });
    if (url === '/api/snapshot') return json(snapshot);
    return json({ error: { code: 'not_found' } }, 404);
  });
  s.Events = class {
    constructor(url) { this.url = url; this.on = {}; s.streams.push(this); queueMicrotask(() => this.onopen?.()); }
    addEventListener(name, f) { this.on[name] = f; }
    close() {}
  };
  s.send = (event, data) => act(() => { for (const es of s.streams) es.on[event]?.({ data: JSON.stringify(data) }); });
  return s;
}

const page = (name) => () => <p>{name} page</p>;
const SOME = { inbox: page('Inbox'), workers: page('Workers') };

async function open({ routes = SOME, snapshot, width = 1440 } = {}) {
  window.innerWidth = width;
  const s = stubServer(snapshot);
  render(<App deps={{ get: s.get, Events: s.Events, store: undefined, routes }} />);
  await screen.findByText(/^As of /);
  return s;
}
const nav = () => screen.getByRole('navigation', { name: 'Desk' });
const banners = () => [...document.querySelectorAll('[data-banner]')];
const cmd = (key) => act(() => { fireEvent.keyDown(window, { key, metaKey: true }); });

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});
afterEach(() => { cleanup(); delete window.desk; });

describe('the title bar, sidebar and status bar', () => {
  it('AC1 the needs-you pill and the Inbox badge follow the count, live, with no reload', async () => {
    const s = await open();
    const pill = screen.getByRole('button', { name: /^25 need you · oldest 12d 14h$/ });
    expect(pill.textContent).toBe('◆25');
    expect(document.querySelector('[data-badge="inbox"]').textContent).toBe('25');
    const reads = s.get.mock.calls.length;
    s.send('home', { ...fixture(), needs_you: { count: 24, put_off: 0, oldest_at: null } });
    expect(document.querySelector('[data-count="needs"]').textContent).toBe('24');
    expect(document.querySelector('[data-badge="inbox"]').textContent).toBe('24');
    expect(s.get.mock.calls.length).toBe(reads);
  });

  it("AC2 the Repos section lists each repo with its running and needs-you counts, a named batch under its repo", async () => {
    const s = await open();
    const rows = [...document.querySelectorAll('[data-repos] li')].map((li) => li.textContent);
    expect(rows).toEqual(['desk-skills● 4', 'desk-skills:DS-631', 'studia-web◆ 14', 'studia-zendesk◆ 5', 'ai-agents◆ 6● 3']);
    const batch = within(document.querySelector('[data-repos]')).getByText('desk-skills:DS-631');
    expect(batch.parentElement.className).toContain('pl-8');
    // A repo's row changes on its own event.
    s.send('repo', { slug: 'owner__studia-web', summary: repo('studia-web', { needs_you: 13 }) });
    expect(within(document.querySelector('[data-repos]')).getByText('◆ 13')).toBeTruthy();
  });

  it('AC3 a repo name over 20 characters is cut short, its full name in the tooltip', async () => {
    const snapshot = fixture();
    snapshot.repos = [repo('sophos-education-studia-web-app', { slug: 'sophos-education__sophos-education-studia-web-app' })];
    await open({ snapshot });
    const row = document.querySelector('[data-repos] li');
    expect(row.textContent).toBe('sophos-education-st…');
    expect(row.title).toBe('sophos-education/sophos-education-studia-web-app');
  });

  it('AC4 the status bar reads the machine line and ends with the server', async () => {
    await open();
    const bar = document.querySelector('[data-status-bar]');
    expect(bar.querySelector('[data-segment="machine"]').textContent).toBe('● 7 workers · cap 30 · room for 7 more · 27.5 GiB free');
    expect(bar.lastElementChild.textContent).toBe('Server 127.0.0.1:4823 ●');
  });

  it('AC5 narrowed to 1024 wide, the sidebar is the icon rail with numeric badges and the status bar goes', async () => {
    await open();
    expect(document.querySelector('[data-rail]')).toBeNull();
    act(() => { window.innerWidth = 1024; window.dispatchEvent(new Event('resize')); });
    const rail = document.querySelector('[data-rail]');
    expect(rail.className).toContain('w-14');
    expect(within(rail).getByRole('button', { name: 'Inbox' }).querySelector('[data-badge="inbox"]').textContent).toBe('25');
    expect(within(rail).getByRole('button', { name: 'Workers' }).querySelector('[data-badge="workers"]').textContent).toBe('7');
    expect(document.querySelector('[data-status-bar]')).toBeNull();
  });

  it('AC5 a rail badge over 99 reads 99+', async () => {
    const snapshot = fixture();
    snapshot.needs_you.count = 140;
    await open({ snapshot, width: 1024 });
    expect(document.querySelector('[data-rail] [data-badge="inbox"]').textContent).toBe('99+');
  });

  it('AC11 ⌘\\ hides the sidebar, and again shows it', async () => {
    await open();
    cmd('\\');
    expect(screen.queryByRole('navigation', { name: 'Desk' })).toBeNull();
    cmd('\\');
    expect(nav()).toBeTruthy();
  });

  it('AC12 every sidebar item takes focus, and the focus ring is 2 px at 3:1 or more in light and dark', async () => {
    await open();
    const item = within(nav()).getByRole('button', { name: /Inbox/ });
    item.focus();
    expect(document.activeElement).toBe(item);
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'theme.css'), 'utf8');
    expect(css).toMatch(/:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
    const vars = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
    const light = vars(css.match(/:root\{([\s\S]*?)\n\}/)[1]);
    const dark = vars(css.match(/:root\[data-theme="dark"\]\{([\s\S]*?)\n\}/)[1]);
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    for (const t of [light, dark]) for (const surface of ['sidebar', 'sidebar-accent']) expect(contrast(t.focus, t[surface])).toBeGreaterThanOrEqual(3);
  });
});

describe('the banner slot', () => {
  const broken = (repos) => { const s = fixture(); s.repos = repos; return s; };

  it('AC7 a production-broken park is the first banner, with no dismiss control', async () => {
    await open({ snapshot: broken([repo('studia-web', { needs_you: 1, production_broken: ['SV-4021'] })]) });
    const [first] = banners();
    expect(first.textContent.replace(/Answer now$/, '')).toBe('!Production is broken in studia-web: SV-4021 is waiting for your answer.');
    expect(first.firstElementChild.textContent).toBe('!');
    expect(within(first).queryByRole('button', { name: /dismiss|close/i })).toBeNull();
    expect(within(first).getByRole('button', { name: 'Answer now' })).toBeTruthy();
  });

  it('AC7 with no Inbox yet, the banner offers no Answer now', async () => {
    await open({ routes: {}, snapshot: broken([repo('studia-web', { production_broken: ['SV-4021'] })]) });
    expect(within(banners()[0]).queryByRole('button')).toBeNull();
  });

  it('AC8 three at once: the two highest show, and "+1 more" lists the third', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    await open({ snapshot: broken([repo('studia-web', { production_broken: ['SV-4021', 'SV-4022'] })]) });
    expect(banners().map((b) => b.dataset.banner)).toEqual(['broken owner__studia-web SV-4021', 'broken owner__studia-web SV-4022']);
    fireEvent.click(screen.getByRole('button', { name: '+1 more' }));
    expect(banners().map((b) => b.dataset.banner)).toEqual(['broken owner__studia-web SV-4021', 'broken owner__studia-web SV-4022', 'offline']);
  });

  it('AC9 offline: the offline banner shows and cannot be dismissed, and goes once back online', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    await open();
    const [b] = banners();
    expect(b.textContent).toBe("You're offline. Queues and logs still update; PR and Jira panels show their last copy.");
    expect(within(b).queryByRole('button')).toBeNull();
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(banners()).toEqual([]);
  });

  it("AC10 ⌘-click on a ticket key opens its Jira page in the browser and the window stays where it was", async () => {
    const openExternal = vi.fn();
    window.desk = { openExternal };
    await open({ snapshot: broken([repo('studia-web', { production_broken: ['DS-563'], jira_site: 'jira.example.net' })]) });
    const before = document.body.innerHTML;
    const link = screen.getByRole('link', { name: /DS-563/ });
    expect(link.title).toBe('⌘-click to open DS-563 in Jira');
    fireEvent.click(link, { metaKey: true });
    expect(openExternal).toHaveBeenCalledWith('https://jira.example.net/browse/DS-563');
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('only the screens that exist', () => {
  it('AC13 a screen not shipped has no sidebar item, and its shortcut does nothing', async () => {
    await open({ routes: { inbox: page('Inbox') } });
    expect(within(nav()).queryByRole('button', { name: /Conversations/ })).toBeNull();
    expect(within(nav()).queryByRole('button', { name: /Workers/ })).toBeNull();
    cmd('4');
    expect(screen.queryByText(/page$/)).toBeNull();
    expect(document.querySelector('[data-page-title]')).toBeNull();
    cmd('1');
    expect(screen.getByText('Inbox page')).toBeTruthy();
    expect(document.querySelector('[data-page-title]').textContent).toBe('Inbox');
  });

  it('AC13 with no screen shipped, nothing opens one: no item, no pill link, the repos only listed', async () => {
    await open({ routes: {} });
    expect(within(nav()).queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('button', { name: /need you/ })).toBeNull();
    expect(document.querySelectorAll('[data-repos] li').length).toBe(5);
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', ',']) cmd(k);
    await waitFor(() => expect(screen.getByText('Desk', { selector: 'h1' })).toBeTruthy());
  });
});
