import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.jsx';
import { Usage } from './usage.jsx';
import { level, paceOf, step, usageBadge } from './usage-figures.js';
import { stubServer } from './test-server.js';

// Sunday 29 November 2026, 20:00 local: 132 h into a 7-day window that resets Tuesday 1 December at
// 08:00, so 88% used fills it at Monday 14:00, 18 h before the reset.
const NOW = new Date(2026, 10, 29, 20, 0).getTime();
const RESET = new Date(2026, 11, 1, 8, 0).getTime();
const H5 = new Date(2026, 10, 29, 23, 10).getTime();
const MIN = 60000;

const reading = (d7, at = NOW - MIN, h5 = 32) => ({ five_hour: { pct: h5, resets_at: H5 }, seven_day: { pct: d7, resets_at: RESET }, at, none: [] });
const sub = (name, email, more = {}) => ({ name, email, label: email, plan: 'Max 5x', folder: `~/.claude-logins/${name}`, state: 'unused', pinned: [],
  workers: 0, reading: reading(12), limit: null, ...more });
const repo = (name, email, more = {}) => ({ slug: `studia__${name}`, name, email, source: 'row', known: true, on: null, workers: 0, ready: 0, ...more });

// ben@studia.example the default at 88%; studia-web and ai-agents pinned to ops@studia.example (work-2).
function subscriptions({ d7 = 88, limited = false, at = NOW - MIN } = {}) {
  const def = sub('default', 'ben@studia.example', { plan: 'Max 20x', folder: '~/.claude', state: 'default', reading: reading(d7, at),
    limit: limited ? { type: 'seven_day', at: RESET } : null });
  return {
    claude: [def, sub('work-2', 'ops@studia.example', { state: 'pinned', pinned: ['studia-web', 'ai-agents'], on: 'work-2' }),
      sub('work-3', 'ben@personal.example', { plan: 'Pro', state: 'off', reading: null })],
    codex: [sub('default', 'ben@studia.example', { plan: 'Pro', folder: '~/.codex', state: 'default', reading: { five_hour: { pct: 9, resets_at: H5 }, seven_day: { pct: 46, resets_at: RESET }, at: NOW - MIN, none: [] } })],
    default_email: 'ben@studia.example',
    repos: [
      repo('ai-agents', 'ops@studia.example', { on: 'work-2', workers: 3 }),
      repo('desk-skills', 'ben@studia.example', { source: 'default', on: 'default', ready: 12, workers: limited ? 0 : 4 }),
      repo('studia-reports', 'old@studia.example', { source: 'unknown email', known: false }),
      repo('studia-web', 'ops@studia.example', { on: 'work-2' }),
      repo('studia-zendesk', 'ben@studia.example', { source: 'default', on: 'default' }),
    ],
    waiting: limited ? [{ email: 'ben@studia.example', name: 'default', type: 'seven_day', at: RESET, repos: [{ name: 'desk-skills', ready: 12 }, { name: 'studia-zendesk', ready: 0 }] }] : [],
    probe_every_ms: 5 * MIN,
  };
}

const snapshotOf = (subs) => ({ at: new Date(NOW).toISOString(), rev: 1, needs_you: { count: 0, put_off: 0, oldest_at: null }, machine: { running: 7, cap: 30, room: 7, avail_gib: 27.5 },
  repos: [], no_batch: [], tickets: {}, subscriptions: subs });

const ROUTES = { inbox: () => <p>Inbox page</p>, usage: Usage };
async function open(subs = subscriptions()) {
  window.innerWidth = 1440;
  const s = stubServer(snapshotOf(subs));
  render(<App deps={{ get: s.get, Events: s.Events, store: undefined, routes: ROUTES }} />);
  await screen.findByText(/^As of /);
  return s;
}
const cmd = (key) => act(() => { fireEvent.keyDown(window, { key, metaKey: true }); });
const banner = (id) => document.querySelector(`[data-banner="${id}"]`);
const draw = (subs) => render(<Usage snapshot={snapshotOf(subs)} path="/usage" />);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the pace', () => {
  it('fills a linear projection before the reset, and none when it does not', () => {
    expect(paceOf({ pct: 88, resets_at: RESET }, NOW)).toEqual({ at: new Date(2026, 10, 30, 14, 0).getTime(), hours: 18 });
    expect(paceOf({ pct: 40, resets_at: RESET }, NOW)).toBe(null);
    expect([step(88), step(89), step(90)]).toEqual([85, 85, 90]);
  });
});

describe('Usage & costs', () => {
  it('AC1 the hero names the default, its 7-day use, reset, pace and Watch', () => {
    draw(subscriptions());
    const hero = document.querySelector('[data-hero]');
    expect(within(hero).getByRole('heading').textContent).toBe('Claude ben@studia.example (default) · 7d 88% · resets Tue 08:00');
    expect(hero.querySelector('[data-pace]').textContent).toBe('At this pace: 100% Mon 14:00, 18 h before reset.');
    expect(within(hero).getByText('Watch')).toBeTruthy();
  });

  it('AC2 lists each repo with its subscription, and ops@studia.example reads Pinned · 2 repos', () => {
    draw(subscriptions());
    const card = screen.getByRole('article', { name: 'ops@studia.example' });
    expect(within(card).getByText('Pinned · 2 repos')).toBeTruthy();
    expect(within(card).getByText('Pinned by studia-web and ai-agents')).toBeTruthy();
    const runs = (name) => document.querySelector(`[data-repo="${name}"]`).children[1].textContent;
    expect([runs('studia-web'), runs('ai-agents'), runs('desk-skills')]).toEqual(['ops@studia.example', 'ops@studia.example', 'Default (ben@studia.example)']);
  });

  it('AC3 a repo waiting for its subscription\'s reset says so, with its ready tickets and start', () => {
    draw(subscriptions({ d7: 100, limited: true }));
    expect(document.querySelector('[data-wait="desk-skills"]').textContent).toBe("desk-skills waits for ben@studia.example's 7-day reset · 12 ready · starts Tue 08:00");
  });

  it('AC4 no standby, rotation or most-room word appears', () => {
    draw(subscriptions({ d7: 100, limited: true }));
    expect(document.body.textContent).not.toMatch(/standby|rotation|most room/i);
    cleanup();
    draw(subscriptions());
    expect(document.body.textContent).not.toMatch(/standby|rotation|most room/i);
  });

  it('AC5 a repo pinned to an account no subscription here is signed in to cannot start work', () => {
    draw(subscriptions());
    expect(document.querySelector('[data-unknown="studia-reports"]').textContent)
      .toBe("✕ No subscription on this computer is signed in to old@studia.example, so studia-reports can't start work. Pick another subscription for it, or add one signed in to that account.");
    expect(screen.queryByRole('button', { name: /Add subscription/ })).toBe(null);
  });

  it('a repo pinned to an account only a subscription set off is signed in to says to turn it back on', () => {
    const subs = subscriptions();
    subs.repos[2] = { ...subs.repos[2], email: 'ben@personal.example', off: 'work-3' };
    draw(subs);
    expect(document.querySelector('[data-unknown="studia-reports"]').textContent)
      .toBe("✕ The subscription on this computer signed in to ben@personal.example, work-3, is off, so studia-reports can't start work. Turn work-3 back on, or pick another subscription for it.");
  });

  it('a repo whose Subscription row could not be read shows a dash, and no alert naming an account', () => {
    const subs = subscriptions();
    subs.repos.push(repo('studia-new', null, { source: null, known: false, unread: true, off: null }));
    draw(subs);
    const row = document.querySelector('[data-repo="studia-new"]');
    expect(row.children[1].textContent).toBe('—');
    expect(row.children[3].textContent).toBe('nothing running');
    expect(document.querySelector('[data-unknown="studia-new"]')).toBe(null);
    expect(document.body.textContent).not.toMatch(/null/);
    expect(screen.getAllByRole('alert').map((a) => a.getAttribute('data-unknown'))).toEqual(['studia-reports']);
  });

  it('a repo on the default with no default at all is told to set one, not to turn it back on', () => {
    const subs = subscriptions();
    subs.claude = subs.claude.slice(1);
    subs.repos = subs.repos.map((r) => (r.source === 'default' ? { ...r, known: false } : r));
    draw(subs);
    expect(document.querySelector('[data-unknown="desk-skills"]').textContent)
      .toBe("✕ This computer has no default Claude subscription, so desk-skills can't start work. Set one, or pick another subscription for it.");
  });

  it('AC6 at its limit the hero bar is full and says repos wait until the reset', () => {
    draw(subscriptions({ d7: 100, limited: true }));
    const hero = document.querySelector('[data-hero]');
    expect(hero.querySelector('[data-limit]').textContent).toBe("Limit reached. Repos on ben@studia.example wait until Tue 08:00. desk doesn't move them.");
    expect(within(hero).getByRole('meter', { name: '7-day window 100%' }).getAttribute('aria-valuenow')).toBe('100');
    expect(within(hero).getByText('Limit reached')).toBeTruthy();
  });

  it('AC10 a reading over two probe intervals old reads as stale', () => {
    vi.setSystemTime(new Date(2026, 10, 29, 10, 5).getTime());
    draw(subscriptions({ at: new Date(2026, 10, 29, 9, 12).getTime() }));
    expect(document.querySelector('[data-stamp]').textContent).toBe('◌ Probe stale: last read 09:12');
  });

  it('a fresh reading reads as checked, with the next probe', () => {
    draw(subscriptions());
    expect(document.querySelector('[data-stamp]').textContent).toBe('Checked 19:59 · next 20:04');
  });

  it('draws no subscription write: no add, default, off or remove control', () => {
    draw(subscriptions());
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('tab', { name: 'Bills' })).toBe(null);
  });

  it('a reading that rounds to 100% with no limit holding reads Tight, never Limit reached', () => {
    expect(level(100, false).word).toBe('Tight');
    expect(level(99, true).word).toBe('Limit reached');
  });

  it('an off default is labelled Off, and the repos on the default cannot start work', () => {
    const subs = subscriptions();
    subs.claude[0] = { ...subs.claude[0], state: 'off', is_default: true };
    subs.repos = subs.repos.map((r) => (r.source === 'default' ? { ...r, known: false } : r));
    draw(subs);
    // The Claude card: the Codex default is signed in to the same account, and its grid comes after.
    const card = screen.getAllByRole('article', { name: 'ben@studia.example' })[0];
    expect(card.getAttribute('data-sub')).toBe('default');
    expect(within(card).getByText('Off')).toBeTruthy();
    expect(within(card).queryByText('Default')).toBe(null);
    expect(document.querySelector('[data-hero]').textContent)
      .toBe("This computer's default Claude subscription, ben@studia.example, is off, so repos that aren't pinned can't start work.");
    expect(document.querySelector('[data-unknown="desk-skills"]').textContent)
      .toBe("✕ This computer's default Claude subscription is off, so desk-skills can't start work. Turn it back on, or pick another subscription for it.");
    expect(document.querySelector('[data-stamp]').textContent).toBe('Checked 19:59 · next 20:04');
  });

  it('subscriptions the server could not read say so, and draw no figures', () => {
    draw({ error: 'subscriptions.json: Unexpected token' });
    expect(document.querySelector('[data-subs-error]').textContent).toBe("desk couldn't read this computer's subscriptions: subscriptions.json: Unexpected token");
    expect(document.querySelector('[data-hero]')).toBe(null);
    expect(document.querySelector('[data-stamp]')).toBe(null);
  });
});

describe('the usage banners and the sidebar', () => {
  it('AC7 a subscription at its limit shows its banner, with See subscriptions, and it cannot be dismissed', async () => {
    await open(subscriptions({ d7: 100, limited: true }));
    const b = banner('limit default');
    expect(b.textContent).toContain("ben@studia.example has reached its 7-day limit. desk-skills and studia-zendesk wait until Tue 08:00. desk doesn't move them to another subscription.");
    expect(within(b).queryByRole('button', { name: 'Dismiss' })).toBe(null);
    fireEvent.click(within(b).getByRole('button', { name: 'See subscriptions' }));
    expect(document.querySelector('[data-page-title]').textContent).toBe('Usage & costs');
    expect(banner('usage pace')).toBe(null);
  });

  it('a limit no window is named for reads as the usage limit, never the 7-day one', async () => {
    const subs = subscriptions({ d7: 100, limited: true });
    subs.waiting[0] = { ...subs.waiting[0], type: 'unknown', at: null };
    await open(subs);
    expect(banner('limit default').textContent).toContain('ben@studia.example has reached its usage limit. desk-skills and studia-zendesk wait until its limit lifts.');
  });

  it('AC8 the 7-day window at 88% shows its banner with See usage', async () => {
    await open();
    const b = banner('usage pace');
    expect(b.textContent).toContain("Claude's 7-day window is at 88% and resets Tue 08:00. At this pace it fills Mon 14:00.");
    fireEvent.click(within(b).getByRole('button', { name: 'See usage' }));
    expect(document.querySelector('[data-page-title]').textContent).toBe('Usage & costs');
  });

  it('AC9 dismissed at 88%, it stays away at 89% and shows again at 90%', async () => {
    const s = await open();
    fireEvent.click(within(banner('usage pace')).getByRole('button', { name: 'Dismiss' }));
    expect(banner('usage pace')).toBe(null);
    s.send('home', { subscriptions: subscriptions({ d7: 89 }) });
    expect(banner('usage pace')).toBe(null);
    s.send('home', { subscriptions: subscriptions({ d7: 90 }) });
    expect(banner('usage pace').textContent).toContain("Claude's 7-day window is at 90%");
  });

  it('AC14 ⌘5 opens Usage & costs, and the sidebar shows 88% in amber', async () => {
    await open();
    const item = screen.getByRole('button', { name: /^Usage & costs/ });
    expect(item.getAttribute('title')).toBe('Usage & costs ⌘5');
    const fig = item.querySelector('[data-badge="usage"]');
    expect(fig.textContent).toBe('88%');
    expect(fig.className).toContain('text-needs');
    cmd('5');
    expect(document.querySelector('[data-page-title]').textContent).toBe('Usage & costs');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Usage & costs');
  });

  it('the sidebar figure is grey under 85%, from the fullest window a repo runs on', () => {
    expect(usageBadge(subscriptions({ d7: 60 }))).toEqual({ pct: 60, hot: false });
    expect(usageBadge(subscriptions({ d7: 85 }))).toEqual({ pct: 85, hot: true });
  });

  it('the sidebar figure counts the Codex default every review runs on', () => {
    const subs = subscriptions({ d7: 60 });
    subs.codex[0].reading.seven_day.pct = 88;
    expect(usageBadge(subs)).toEqual({ pct: 88, hot: true });
  });
});
