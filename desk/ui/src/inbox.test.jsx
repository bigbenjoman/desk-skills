import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Inbox, recordCommand, Tabs } from './inbox.jsx';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// Half a minute more, so a waited time read a moment later still rounds down to the same minute.
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000 - 30_000).toISOString();
const JIRA = 'https://jira.example.net/browse/';
const repo = (name, more = {}) => ({ id: `acme__${name}`, slug: `acme__${name}`, name, error: null, needs_you: 0, production_broken: [], jira_browse: JIRA, ...more });
const snapshot = (more = {}) => ({ at: new Date().toISOString(), needs_you: { count: 25 }, machine: { running: 7 },
  repos: [repo('studia-web'), repo('studia-zendesk'), repo('ai-agents'), repo('desk-skills')], ...more });

const Q3844 = "SV-3844 PR #2699 is an external-shape change with no live check possible from a worker (curl denied, no Sentry token, Merl previews behind Vercel Authentication, MERL_ROBIN_TOKEN unset): can someone with a Sentry token run the checks in the PR's Testing list and record a real payload for the fixture, or accept merging with them as post-merge checks? It blocks SV-4017; the head is a742f155.";
const item = (key, repoName, h, more = {}) => ({ id: `${repoName}:${key}:parked`, cause: null, kind: 'parked', repo: repoName, batch: repoName, key, ticket: key,
  since: hoursAgo(h), waited_s: Math.round(h * 3600), question: `${key} needs an answer`, note: null, behind: 0, production_broken: false, repo_level: false, pr: null, approve: null,
  actions: [{ action: 'resume', recommended: true, why: 'a worker finishes it once it has your answer', note: null, needs_text: true }, { action: 'not-now', recommended: false, why: null, note: null, needs_text: false }], ...more });

// 25 items across four repos, in needs-you's order (oldest first after the held).
const ITEMS = [
  item('SV-3844', 'studia-web', 8 * 24 + 19, { kind: 'session', question: Q3844, pr: 2699, behind: 1,
    actions: [{ action: 'resume', recommended: true, why: "Run the PR's Testing checks with a Sentry token, then record the real payload.", note: null, needs_text: true },
      { action: 'not-now', recommended: false, why: null, note: null, needs_text: false }, { action: 'drop', recommended: false, why: null, note: 'removes it from the batch', needs_text: false },
      { action: 'override d-12', recommended: false, why: null, note: 'took "fixture" on "Which payload?"', needs_text: true },
      { action: 'move', recommended: false, why: null, note: 'into another running batch: studia-web:w2', needs_text: true }] }),
  item('DS-651', 'desk-skills', 4 * 24, { approve: { kind: 'jira-comment', target: 'DS-651', body: 'Plan approved.\nBuilding starts once DS-606 merges.' } }),
  ...Array.from({ length: 13 }, (_, n) => item(`SV-${4000 + n}`, 'studia-web', 30 - n)),
  ...Array.from({ length: 10 }, (_, n) => item(`AIA-${200 + n}`, 'ai-agents', 12 - n, { kind: n % 2 ? 'pr' : 'plan' })),
];
const listOf = (items, more = {}) => ({ v: 1, generated_at: new Date(2026, 10, 26, 10, 7).toISOString(), settled: false, count: items.length, put_off: 0, items,
  settled_at: null, github: null, next_pass_at: null, next_checkin_at: null, ...more });

function server(list = listOf(ITEMS)) {
  const s = { list, calls: [] };
  s.get = vi.fn((url) => { s.calls.push(url); return s.hold ?? Promise.resolve(json(s.list)); });
  return s;
}
async function open({ list, snap = snapshot(), width = 1440, s = server(list) } = {}) {
  window.innerWidth = width;
  render(<Inbox get={s.get} snapshot={snap} />);
  if (!s.hold) await screen.findByRole('heading', { name: 'Inbox' }).then(() => waitFor(() => expect(document.querySelector('[data-skeleton]')).toBeNull()));
  return s;
}
const rows = () => [...document.querySelectorAll('[data-item]')];
const row = (key) => rows().find((r) => r.textContent.includes(key));
const key = (k) => act(() => { fireEvent.keyDown(window, { key: k }); });
const detail = () => document.querySelector('[data-detail]');

let clip;
beforeEach(() => {
  clip = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clip } });
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
});
afterEach(() => { cleanup(); });

describe('the Inbox list', () => {
  it('AC1 lists the 25 items in needs-you\'s order, each with its key, kind tag, repo chip and waited time', async () => {
    const s = await open();
    expect(s.calls[0]).toBe('/api/inbox?settle=0');
    expect(rows().map((r) => r.dataset.item)).toEqual(ITEMS.map((i) => i.id));
    const r = within(row('SV-3844'));
    expect(r.getByText('SV-3844')).toBeTruthy();
    expect(r.getByText('session').getAttribute('title')).toBe('Only an interactive session can do this.');
    expect(row('SV-3844').querySelector('[data-repo]').textContent).toBe('studia-web');
    expect(row('SV-3844').querySelector('[data-waited]').textContent).toBe('8d 19h');
    expect(screen.getByText('25 need you · oldest 8d 19h')).toBeTruthy();
  });

  it('AC6 an item waited 8d 19h draws its waited time red', async () => {
    await open();
    expect(row('SV-3844').querySelector('[data-waited]').className).toContain('text-fail');
  });

  it('AC7 an item waited 4 days draws its waited time amber', async () => {
    await open();
    const w = row('DS-651').querySelector('[data-waited]');
    expect([w.textContent, w.className.includes('text-needs')]).toEqual(['4d 0h', true]);
    expect(row('SV-4000').querySelector('[data-waited]').className).toContain('text-muted-fg');
  });

  it('AC8 a production-broken park is pinned in a red group at the top, and the detail opens on it', async () => {
    const broken = item('SV-4021', 'studia-web', 0.25, { question: 'PRODUCTION BROKEN: course player 500s for every SCORM 1.2 package', production_broken: true });
    await open({ list: listOf([broken, ...ITEMS.slice(0, 3)]) });
    const list = screen.getByRole('listbox', { name: 'Needs you' });
    expect(list.firstChild.textContent).toBe('!Production broken · 1');
    expect(rows()[0].dataset.item).toBe(broken.id);
    expect(rows()[0].className).toContain('bg-fail-bg');
    expect(await screen.findByRole('article', { name: 'SV-4021 detail' })).toBeTruthy();
  });

  it('AC9 with nothing to answer it says so, with the running workers, the next pass and the next check-in', async () => {
    await open({ list: listOf([], { next_pass_at: new Date(2026, 10, 26, 10, 11).toISOString(), next_checkin_at: new Date(2026, 10, 26, 17, 0).toISOString() }) });
    expect(screen.getByRole('heading', { name: 'Nothing needs you' })).toBeTruthy();
    expect(screen.getByText('7 workers are running. The next pass is at 10:11, and the next check-in is at 17:00.')).toBeTruthy();
  });

  it('AC10 GitHub not answering: the stamp and the alert say so, with Try again', async () => {
    const s = await open({ list: listOf(ITEMS, { github: { ok: false, reason: 'down', detail: 'gh: HTTP 502' }, settled_at: new Date(2026, 10, 26, 10, 2).toISOString() }) });
    expect(screen.getByText("◌ As of 10:02 · GitHub didn't answer")).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain("Showing the last list. GitHub isn't answering (gh: HTTP 502), so new PR items may be missing.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(s.calls.at(-1)).toBe('/api/inbox?settle=1'));
    await waitFor(() => expect(screen.queryByText('Checking GitHub and Jira…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(s.calls.filter((c) => c === '/api/inbox?settle=1').length).toBe(2));
  });

  it('AC11 GitHub signed out: it says so, with gh auth login and Check again', async () => {
    await open({ list: listOf(ITEMS, { github: { ok: false, reason: 'signin', detail: null } }) });
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText("GitHub sign-in has expired, so PR items can't be checked.")).toBeTruthy();
    expect(within(alert).getByText('gh auth login')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('AC12 filtered to a repo with no items, it says how many others need Ben, with Clear filters', async () => {
    await open({ list: listOf(ITEMS.slice(0, 20)) });
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'studia-zendesk' } });
    expect(screen.getByText('No items in studia-zendesk match these filters.')).toBeTruthy();
    expect(screen.getByText('20 others need you.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(rows().length).toBe(20);
  });

  it('AC13 before its data arrives, the list and the detail show skeletons, never a blank pane', async () => {
    const s = server();
    s.hold = new Promise(() => {});
    await open({ s });
    expect(document.querySelector('[data-skeleton="list"]').children.length).toBe(8);
    expect(document.querySelector('[data-skeleton="detail"]')).toBeTruthy();
  });

  it('AC14 r twice within a minute settles once, and the stamp reads Checking GitHub and Jira… while it runs', async () => {
    const s = await open();
    let done;
    s.hold = new Promise((r) => { done = r; });
    key('r');
    expect(screen.getByText('Checking GitHub and Jira…')).toBeTruthy();
    key('r');
    await act(async () => { done(json(listOf(ITEMS, { settled: true, github: { ok: true } }))); });
    s.hold = null;
    key('r');
    await waitFor(() => expect(screen.queryByText('Checking GitHub and Jira…')).toBeNull());
    expect(s.calls.filter((c) => c === '/api/inbox?settle=1').length).toBe(1);
  });

  it('AC15 j opens the next item in the detail and puts the focus ring on its row', async () => {
    await open();
    key('j');
    expect(screen.getByRole('article', { name: 'SV-3844 detail' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(row('SV-3844')));
    expect(row('SV-3844').className).toContain('focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]');
    key('j');
    expect(screen.getByRole('article', { name: 'DS-651 detail' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(row('DS-651')));
  });

  it('AC16 at 1024 wide the list is 400 px, the filters are one Filter button and the first three tabs stay out of More', async () => {
    await open({ width: 1024 });
    expect(document.querySelector('[data-list]').className).toContain('w-100');
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
    expect(screen.queryByLabelText('Repo')).toBeNull();
    fireEvent.click(row('SV-3844'));
    const tabs = within(detail()).getByRole('tablist');
    expect([...tabs.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['PR & CI', 'Jira', 'Decisions (1)']);
  });

  it('AC16 in Compact the tabs after the third collapse into More', () => {
    const four = ['One', 'Two', 'Three', 'Four'].map((label) => ({ id: label, label, body: <p>{label} body</p> }));
    render(<Tabs tabs={four} compact />);
    const tabs = screen.getByRole('tablist');
    expect([...tabs.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['One', 'Two', 'Three', 'More ▾']);
    fireEvent.click(within(tabs).getByText('More ▾'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Four' }));
    expect(screen.getByRole('tabpanel').textContent).toBe('Four body');
  });
});

describe('the Inbox detail', () => {
  it('AC3 SV-3844\'s question shows word for word under Needs your answer, its keys, PR numbers and SHAs as links', async () => {
    await open();
    fireEvent.click(row('SV-3844'));
    const q = detail().querySelector('[data-question]');
    expect(q.textContent).toBe(Q3844);
    expect(within(detail()).getByText('Needs your answer')).toBeTruthy();
    const links = [...q.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['SV-3844', `${JIRA}SV-3844`], ['PR #2699', 'https://github.com/acme/studia-web/pull/2699'],
      ['SV-4017', `${JIRA}SV-4017`], ['a742f155', 'https://github.com/acme/studia-web/commit/a742f155']]);
  });

  it('AC4 a park holding a Jira comment shows its exact text in a bordered mono block with Copy and the caption', async () => {
    await open();
    fireEvent.click(row('DS-651'));
    const gate = detail().querySelector('[data-gate]');
    expect(gate.querySelector('pre').textContent).toBe('Plan approved.\nBuilding starts once DS-606 merges.');
    expect(gate.querySelector('pre').className).toContain('font-mono');
    expect(within(gate).getByText('Jira comment on DS-651')).toBeTruthy();
    expect(within(gate).getByText('This is the exact text that will be posted.')).toBeTruthy();
    fireEvent.click(within(gate).getByRole('button', { name: 'Copy the exact text' }));
    expect(clip).toHaveBeenCalledWith('Plan approved.\nBuilding starts once DS-606 merges.');
  });

  it('AC5 with option 1 chosen, Copy needs-you command copies the record command shown under the options', async () => {
    await open();
    fireEvent.click(row('SV-3844'));
    const copy = within(detail()).getByRole('button', { name: 'Copy needs-you command' });
    expect(copy.disabled).toBe(true);
    key('1');
    expect(within(detail()).getByRole('radio', { name: /resume/ }).checked).toBe(true);
    fireEvent.change(within(detail()).getByRole('textbox', { name: 'What should the worker do?' }), { target: { value: 'I added the token. Run the Testing checks.' } });
    const cmd = "node ~/.claude/desk/bin/needs-you.mjs record studia-web SV-3844 resume 'I added the token. Run the Testing checks.'";
    expect(detail().querySelector('[data-runs]').textContent).toBe(`Runs: ${cmd}`);
    fireEvent.click(copy);
    expect(clip).toHaveBeenCalledWith(cmd);
    expect(within(detail()).queryByRole('button', { name: /Record/ })).toBeNull();
  });

  it('a command needs its text quoted for the shell, and none for an action without text', () => {
    const i = ITEMS[0];
    expect(recordCommand(i, 'not-now')).toBe('node ~/.claude/desk/bin/needs-you.mjs record studia-web SV-3844 not-now');
    expect(recordCommand(i, 'resume', '')).toBeNull();
    expect(recordCommand(i, 'override d-12', 'keep it')).toBe("node ~/.claude/desk/bin/needs-you.mjs record studia-web SV-3844 override d-12 'keep it'");
    expect(recordCommand(i, 'move', '')).toBeNull();
    expect(recordCommand(i, 'move', 'studia-web:w2')).toBe('node ~/.claude/desk/bin/needs-you.mjs record studia-web SV-3844 move studia-web:w2');
    expect(recordCommand(i, 'resume', '=ls')).toBe("node ~/.claude/desk/bin/needs-you.mjs record studia-web SV-3844 resume '=ls'");
  });

  it('a proposal\'s reject, which needs no text, copies without any', () => {
    const p = { ...ITEMS[0], kind: 'proposal', key: 'proposal:SV-3844', actions: [{ action: 'promote', needs_text: true }, { action: 'reject', needs_text: false }] };
    expect(recordCommand(p, 'reject')).toBe('node ~/.claude/desk/bin/needs-you.mjs record studia-web proposal:SV-3844 reject');
    expect(recordCommand(p, 'promote', '')).toBeNull();
  });

  it('a shell reads the copied text back byte for byte, quotes, $, backticks and ! included', () => {
    const text = `it's "done" $HOME \`id\` $(id) !! !x \\ end`;
    const cmd = recordCommand(ITEMS[0], 'resume', text);
    const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${cmd}`], { encoding: 'utf8', env: { HOME: '/home/ben', PATH: process.env.PATH } });
    expect(out.trimEnd().split('\n')).toEqual(['node', '/home/ben/.claude/desk/bin/needs-you.mjs', 'record', 'studia-web', 'SV-3844', 'resume', text]);
  });

  it('choosing move asks which batch, and copies nothing until one is named', async () => {
    await open();
    fireEvent.click(row('SV-3844'));
    fireEvent.click(within(detail()).getByRole('radio', { name: /^move/ }));
    const copy = within(detail()).getByRole('button', { name: 'Copy needs-you command' });
    expect(copy.disabled).toBe(true);
    fireEvent.change(within(detail()).getByRole('textbox', { name: 'Which batch should it move to?' }), { target: { value: 'studia-web:w2' } });
    expect(copy.disabled).toBe(false);
  });

  it('the list reads again when the snapshot\'s needs-you figures change', async () => {
    const s = server();
    window.innerWidth = 1440;
    const { rerender } = render(<Inbox get={s.get} snapshot={snapshot()} />);
    await waitFor(() => expect(s.calls.length).toBe(1));
    rerender(<Inbox get={s.get} snapshot={snapshot({ needs_you: { count: 24 } })} />);
    await waitFor(() => expect(s.calls.length).toBe(2));
  });
});
