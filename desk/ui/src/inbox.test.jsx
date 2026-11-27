import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Inbox, KIND_TIPS, recordCommand, Tabs } from './inbox.jsx';

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

// The server: GETs read the list; POSTs (the writes) are kept in `posts` and answered with `answer`.
function server(list = listOf(ITEMS)) {
  const s = { list, calls: [], posts: [], answer: { exit: 0, stdout: 'recorded\n', stderr: '' }, status: 200 };
  s.get = vi.fn((url, o) => {
    if (o?.method === 'POST') { s.posts.push({ url, body: JSON.parse(o.body) }); return s.write ?? Promise.resolve(json(s.answer, s.status)); }
    s.calls.push(url);
    return s.hold ?? Promise.resolve(json(s.list));
  });
  return s;
}
async function open({ list, snap = snapshot(), width = 1440, s = server(list), go } = {}) {
  window.innerWidth = width;
  render(<Inbox get={s.get} snapshot={snap} go={go} />);
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
    expect(within(detail()).getByRole('button', { name: /^Send answer to SV-3844/ }).disabled).toBe(false);
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

// ---- DS-737: answering from the Inbox
const at = (h, m) => new Date(2026, 10, 26, h, m);
const notNow = { action: 'not-now', recommended: false, why: null, note: null, needs_text: false };
const button = (name) => within(detail()).getByRole('button', { name });
const radio = (name) => within(detail()).getByRole('radio', { name });
// Opened more than a second ago: ⏎ answers.
const later = () => vi.setSystemTime(new Date(Date.now() + 1500));
const sendResume = async (s, text = 'I added the token. Run the Testing checks.') => {
  fireEvent.click(row('SV-3844'));
  key('1');
  fireEvent.change(within(detail()).getByRole('textbox', { name: 'What should the worker do?' }), { target: { value: text } });
  fireEvent.click(button(/^Send answer to SV-3844/));
};

describe('answering from the Inbox', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at(10, 14)); });
  afterEach(() => { vi.useRealTimers(); delete window.desk; });

  it('AC1 Send answer runs the record for that answer and text, reads "Sending answer…" and locks the options until it exits', async () => {
    const s = await open();
    let exit;
    s.write = new Promise((r) => { exit = r; });
    await sendResume(s);
    expect(s.posts).toEqual([{ url: '/api/repos/acme__studia-web/tickets/SV-3844/record', body: { action: 'resume', text: 'I added the token. Run the Testing checks.', batch: 'studia-web' } }]);
    expect(within(detail()).getByRole('button', { name: /Sending answer…/ }).disabled).toBe(true);
    expect(within(detail()).getAllByRole('radio').every((r) => r.matches(':disabled'))).toBe(true);
    key('Escape');
    expect(detail().querySelector('article')).toBeTruthy();
    await act(async () => { exit(json({ exit: 11, stdout: 'no\n', stderr: '' }, 409)); });
    expect(within(detail()).getAllByRole('radio').some((r) => r.matches(':disabled'))).toBe(false);
  });

  it('AC2 exit 0 collapses the question to what was sent, the record line in mono, and the row leaves the list', async () => {
    const s = await open({ list: listOf(ITEMS, { next_pass_at: at(10, 17).toISOString() }) });
    s.answer = { exit: 0, stdout: "recorded studia-web SV-3844 resume \"I added the token.\"\n", stderr: '' };
    await sendResume(s);
    expect(await within(detail()).findByText('Answer sent to SV-3844 at 10:14.')).toBeTruthy();
    expect(within(detail()).getByText('The worker picks it up at the next pass (10:17).')).toBeTruthy();
    const line = detail().querySelector('[data-record-line]');
    expect([line.textContent, line.className.includes('font-mono')]).toEqual(['recorded studia-web SV-3844 resume "I added the token."', true]);
    expect(detail().querySelector('[data-question]')).toBeNull();
    expect(row('SV-3844')).toBeUndefined();
  });

  it('AC3 a recorded answer stays in the detail and offers Next: with the next item\'s first line and j', async () => {
    const s = await open();
    await sendResume(s);
    const next = await waitFor(() => { const n = detail().querySelector('[data-next]'); expect(n).toBeTruthy(); return n; });
    expect(screen.getByRole('article', { name: 'SV-3844 detail' })).toBeTruthy();
    expect([next.textContent.includes('Next:'), next.textContent.includes('DS-651'), next.textContent.includes('DS-651 needs an answer'), next.querySelector('kbd')?.textContent]).toEqual([true, true, true, 'j']);
    key('j');
    expect(screen.getByRole('article', { name: 'DS-651 detail' })).toBeTruthy();
  });

  it('AC4 exit 10 shows a neutral "Nothing changed:" with the command\'s stdout as written', async () => {
    const s = await open();
    s.answer = { exit: 10, stdout: 'nothing to do: SV-3844 PR #2699 is MERGED (10:02 by bigbenjoman)\n', stderr: '' };
    s.status = 202;
    await sendResume(s);
    const note = await waitFor(() => { const n = detail().querySelector('[data-outcome="nothing"]'); expect(n).toBeTruthy(); return n; });
    expect([note.getAttribute('role'), note.textContent]).toEqual(['status', 'Nothing changed:nothing to do: SV-3844 PR #2699 is MERGED (10:02 by bigbenjoman)']);
  });

  it('an exit 0 reply whose first line says ": nothing recorded." shows Nothing changed and keeps the row', async () => {
    const s = await open();
    s.answer = { exit: 0, stdout: 'studia-web SV-3844: run /desk-autopilot admit SV-3844 instead: nothing recorded.\n', stderr: '' };
    await sendResume(s);
    const note = await waitFor(() => { const n = detail().querySelector('[data-outcome="nothing"]'); expect(n).toBeTruthy(); return n; });
    expect(note.textContent).toBe('Nothing changed:studia-web SV-3844: run /desk-autopilot admit SV-3844 instead: nothing recorded.');
    expect(row('SV-3844')).toBeTruthy();
  });

  it('a session item\'s open, which says "not requeued (…)" and records nothing, shows Nothing changed and keeps the row', async () => {
    const s = await open();
    s.answer = { exit: 0, stdout: 'studia-web SV-3844: not requeued (it needs a plan or design agreed with you first). Open an interactive session in ~/studia/web and run /desk-ticket SV-3844.\n', stderr: '' };
    await sendResume(s);
    await waitFor(() => expect(detail().querySelector('[data-outcome="nothing"]')).toBeTruthy());
    expect(row('SV-3844')).toBeTruthy();
  });

  it('a noted item\'s done, which ends "done records nothing.", shows Nothing changed and keeps the row', async () => {
    const s = await open();
    s.answer = { exit: 0, stdout: 'studia-web SV-3844: noted: this item goes once a pass runs again; done records nothing.\n', stderr: '' };
    await sendResume(s);
    await waitFor(() => expect(detail().querySelector('[data-outcome="nothing"]')).toBeTruthy());
    expect(row('SV-3844')).toBeTruthy();
  });

  it('AC5 exit 11 shows "Desk didn\'t record that" with stdout under the action bar, keeps the text, and Choose another answer focuses the options', async () => {
    const s = await open();
    const refusal = "SV-3844's worktree holds work origin does not have (3 unpushed commits): push or discard it first.";
    s.answer = { exit: 11, stdout: `${refusal}\n`, stderr: '' };
    s.status = 409;
    await sendResume(s, 'keep this text');
    const alert = await within(detail()).findByRole('alert');
    expect(within(alert).getByText("Desk didn't record that")).toBeTruthy();
    expect(alert.querySelector('pre').textContent).toBe(refusal);
    expect(detail().querySelector('[data-actions]').compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(detail()).getByRole('textbox', { name: 'What should the worker do?' }).value).toBe('keep this text');
    fireEvent.click(within(alert).getByRole('button', { name: 'Choose another answer' }));
    expect(document.activeElement).toBe(radio(/resume/));
  });

  it('a 400 from the route shows its message, never a generic one', async () => {
    const s = await open();
    s.answer = { error: { code: 'action', message: 'studia-web SV-3844 does not offer resume (it offers not-now).' } };
    s.status = 400;
    await sendResume(s);
    const alert = await within(detail()).findByRole('alert');
    expect(alert.querySelector('pre').textContent).toBe('studia-web SV-3844 does not offer resume (it offers not-now).');
  });

  it('AC6 ⏎ within a second of opening records nothing, scrolls the question into view and says to read it first', async () => {
    const s = await open();
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    fireEvent.click(row('SV-4000'));
    key('2');
    key('Enter');
    expect(s.posts).toEqual([]);
    expect(scrolled).toHaveBeenCalled();
    expect(within(detail()).getByText('Read the question first, then press ⏎.')).toBeTruthy();
    later();
    key('Enter');
    await waitFor(() => expect(s.posts).toEqual([{ url: '/api/repos/acme__studia-web/tickets/SV-4000/record', body: { action: 'not-now', batch: 'studia-web' } }]));
  });

  it('AC6 ⏎ on a list row opens it and records nothing', async () => {
    const s = await open();
    fireEvent.click(row('SV-4000'));
    key('2');
    later();
    fireEvent.keyDown(row('SV-4001'), { key: 'Enter' });
    expect([s.posts.length, screen.getByRole('article').getAttribute('aria-label')]).toEqual([0, 'SV-4001 detail']);
  });

  it('AC7 2 selects option 2 and records nothing', async () => {
    const s = await open();
    fireEvent.click(row('SV-4000'));
    later();
    key('2');
    expect(radio(/not-now/).checked).toBe(true);
    expect(s.posts).toEqual([]);
  });

  it('AC8 with no option chosen, Record answer is off with the tooltip "Choose an answer first."', async () => {
    await open();
    fireEvent.click(row('SV-4000'));
    const b = button(/^Record answer/);
    expect([b.disabled, b.closest('[title]')?.getAttribute('title')]).toEqual([true, 'Choose an answer first.']);
  });

  it('AC9 an option that needs text opens the field, its helper, a 2,000 cap and a counter after 1,500', async () => {
    await open();
    fireEvent.click(row('SV-4000'));
    fireEvent.click(radio(/resume/));
    const field = within(detail()).getByRole('textbox', { name: 'What should the worker do?' });
    expect(within(detail()).getByText("Don't paste tokens or passwords. This text is saved and passed on as written.")).toBeTruthy();
    expect(field.maxLength).toBe(2000);
    expect(button(/^Send answer to SV-4000/).closest('[title]')?.getAttribute('title')).toBe('Say what to do first.');
    fireEvent.change(field, { target: { value: 'x'.repeat(1500) } });
    expect(within(detail()).queryByText(/\/ 2,000/)).toBeNull();
    fireEvent.change(field, { target: { value: 'x'.repeat(1501) } });
    expect(within(detail()).getByText('1,501 / 2,000')).toBeTruthy();
  });

  it('⌘⏎ in the text field sends it, once the question has been read', async () => {
    const s = await open();
    fireEvent.click(row('SV-4000'));
    fireEvent.click(radio(/resume/));
    const field = within(detail()).getByRole('textbox', { name: 'What should the worker do?' });
    fireEvent.change(field, { target: { value: 'go on' } });
    later();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(s.posts).toEqual([]);
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(s.posts.map((p) => p.body)).toEqual([{ action: 'resume', text: 'go on', batch: 'studia-web' }]));
  });

  it('drop is not recorded here: its button is off and points at the needs-you command', async () => {
    await open();
    fireEvent.click(row('SV-3844'));
    fireEvent.click(radio(/^drop/));
    const b = button(/^Record "drop"/);
    expect([b.disabled, b.closest('[title]')?.getAttribute('title')]).toEqual([true, "Desk can't record this one yet. Copy the needs-you command and run it in Terminal."]);
    expect(button('Copy needs-you command').disabled).toBe(false);
  });
});

describe('put off and taken back', () => {
  afterEach(() => { vi.useRealTimers(); });
  const SV3957 = item('SV-3957', 'studia-web', 2, { question: 'SV-3957 needs a lane' });

  it('a put-off needs-you keeps listing while tickets wait behind it keeps its row, through later reads', async () => {
    const s = await open({ list: listOf([SV3957, ...ITEMS.slice(0, 2)]) });
    s.answer = { exit: 0, stdout: 'studia-web SV-3957: put off (until its inputs change). It is still listed while 3 or more tickets wait behind it (4 do now).\n', stderr: '' };
    fireEvent.click(row('SV-3957'));
    key('e');
    await waitFor(() => expect(document.querySelector('[data-toast]')).toBeTruthy());
    expect(row('SV-3957')).toBeTruthy();
    const reads = s.calls.length;
    key('r');
    await waitFor(() => expect(s.calls.length).toBeGreaterThan(reads));
    expect(row('SV-3957')).toBeTruthy();
  });

  it('AC10 e puts SV-3957 off at once and the toast offers Undo (⌘Z) for 10 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await open({ list: listOf([SV3957, ...ITEMS.slice(0, 2)]) });
    const timers = vi.spyOn(globalThis, 'setTimeout');
    fireEvent.click(row('SV-3957'));
    key('e');
    await waitFor(() => expect(document.querySelector('[data-toast]')).toBeTruthy());
    expect(s.posts).toEqual([{ url: '/api/repos/acme__studia-web/tickets/SV-3957/record', body: { action: 'not-now', batch: 'studia-web' } }]);
    const toast = document.querySelector('[data-toast]');
    expect(toast.textContent).toContain('SV-3957 put off until the next check-in.');
    expect(within(toast).getByRole('button', { name: 'Undo (⌘Z)' })).toBeTruthy();
    expect(row('SV-3957')).toBeUndefined();
    expect(toast.querySelector('span[aria-hidden]').style.transitionDuration).toBe('10000ms');
    // The toast's own timer is the one 10 s long; when it fires, the toast goes.
    const ends = timers.mock.calls.filter(([, ms]) => ms === 10_000);
    timers.mockRestore();
    expect(ends.length).toBeGreaterThan(0);
    act(() => { ends.at(-1)[0](); });
    expect(document.querySelector('[data-toast]')).toBeNull();
  });

  it('AC11 ⌘Z while the toast shows asks SV-3957 again and it returns to the list', async () => {
    const s = await open({ list: listOf([SV3957, ...ITEMS.slice(0, 2)]) });
    fireEvent.click(row('SV-3957'));
    key('e');
    await waitFor(() => expect(document.querySelector('[data-toast]')).toBeTruthy());
    const reads = s.calls.length;
    act(() => { fireEvent.keyDown(window, { key: 'z', metaKey: true }); });
    await waitFor(() => expect(s.posts.at(-1)).toEqual({ url: '/api/repos/acme__studia-web/tickets/SV-3957/undo-not-now', body: {} }));
    await waitFor(() => expect(row('SV-3957')).toBeTruthy());
    expect(document.querySelector('[data-toast]')).toBeNull();
    expect(s.calls.length).toBeGreaterThan(reads);
  });

  it('an undo the server refuses says so in the toast', async () => {
    const s = await open({ list: listOf([SV3957]) });
    fireEvent.click(row('SV-3957'));
    key('e');
    await waitFor(() => expect(document.querySelector('[data-toast]')).toBeTruthy());
    s.answer = { error: { code: 'undo', message: 'studia-web SV-3957 has nothing put off in the last 2 minutes to take back.' } };
    s.status = 400;
    fireEvent.click(within(document.querySelector('[data-toast]')).getByRole('button', { name: 'Undo (⌘Z)' }));
    await waitFor(() => expect(document.querySelector('[data-toast]').textContent).toBe("Desk couldn't take that back: studia-web SV-3957 has nothing put off in the last 2 minutes to take back."));
  });
});

describe('items that answer differently', () => {
  afterEach(() => { delete window.desk; });

  it('AC12 an answer to a live session\'s batch shows the MESSAGE to pass it, Copy message and that Desk can\'t send it', async () => {
    const SV3880 = item('SV-3880', 'studia-web', 18, { kind: 'worktree', actions: [{ action: 'start', recommended: true, why: 'in a fresh worktree', note: null, needs_text: false }, notNow] });
    const s = await open({ list: listOf([SV3880, ...ITEMS.slice(0, 2)]) });
    s.answer = { exit: 0, stdout: 'recorded studia-web SV-3880 start\nMESSAGE desk-autopilot-web: SV-3880 start\n', stderr: '' };
    fireEvent.click(row('SV-3880'));
    fireEvent.click(radio(/^start/));
    fireEvent.click(button(/^Start SV-3880/));
    const m = await waitFor(() => { const n = detail().querySelector('[data-message]'); expect(n).toBeTruthy(); return n; });
    expect(m.querySelector('p').textContent).toBe('A live Claude session runs this batch (desk-autopilot-web). Pass it this message:');
    expect(m.querySelector('pre').textContent).toBe('MESSAGE desk-autopilot-web: SV-3880 start');
    expect(within(m).getByText("Desk can't send to a session directly yet.")).toBeTruthy();
    fireEvent.click(within(m).getByRole('button', { name: 'Copy message' }));
    expect(clip).toHaveBeenCalledWith('MESSAGE desk-autopilot-web: SV-3880 start');
    expect(detail().querySelector('[data-record-line]').textContent).toBe('recorded studia-web SV-3880 start');
  });

  it('AC13 a PR merge hold offers Open PR to merge (Recommended), which opens the PR, then done: I merged it', async () => {
    const hold = item('SV-3954', 'studia-web', 12.8, { kind: 'pr', pr: 3084, question: '#3084 · only a person merges it: changes CI workflow (.github/workflows/tests.yml).',
      actions: [{ action: 'done', recommended: true, why: 'once it has merged', note: null, needs_text: false }, notNow] });
    const s = await open({ list: listOf([hold, ...ITEMS.slice(0, 2)]) });
    const openExternal = vi.fn();
    window.desk = { openExternal };
    fireEvent.click(row('SV-3954'));
    const cards = within(detail()).getAllByRole('radio').map((r) => r.closest('label'));
    expect(cards.map((c) => c.querySelector('span').textContent.replace(/\d$/, ''))).toEqual(['↗Open PR to mergeRecommended', 'done: I merged it', 'not-now']);
    expect(cards[0].textContent).toContain('Merge it on GitHub, then come back and choose "done". Desk checks the PR before it records.');
    key('1');
    fireEvent.click(button(/^Open #3084 on GitHub/));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/studia-web/pull/3084');
    expect(s.posts).toEqual([]);
    key('2');
    expect(detail().querySelector('[data-runs]').textContent).toBe('Runs: node ~/.claude/desk/bin/needs-you.mjs record studia-web SV-3954 done');
  });

  it('AC14 a usage hold offers Wait until Tue 08:00 (Recommended) and Open Subscriptions in Usage & costs, and neither pins a subscription', async () => {
    const usage = item('usage-limit', 'desk-skills', 0.7, { kind: 'usage', ticket: null, question: 'held on the weekly usage limit until Tue 24 Nov 08:00: nothing new starts. It carries on by itself once the limit lifts',
      resets_at: new Date(2026, 10, 24, 8, 0).toISOString(), actions: [{ action: 'done', recommended: true, why: 'it lifts by itself', note: null, needs_text: false }, notNow] });
    const go = vi.fn();
    const snap = snapshot({ repos: [repo('studia-web'), repo('desk-skills', { ready: 12 })] });
    const s = await open({ list: listOf([usage, ...ITEMS.slice(0, 1)]), snap, go });
    fireEvent.click(row('usage-limit'));
    const cards = within(detail()).getAllByRole('radio').map((r) => r.closest('label'));
    expect(cards.map((c) => c.querySelector('span').textContent.replace(/\d$/, ''))).toEqual(['Wait until Tue 08:00Recommended', '↗Open Subscriptions in Usage & costs']);
    expect(cards[0].textContent).toContain('The 12 tickets start at Tue 08:00. Nothing else changes.');
    expect(cards[1].textContent).toContain('Pin desk-skills to another subscription there.');
    expect(within(detail()).getByText('Every subscription change happens in Usage & costs, not here.')).toBeTruthy();
    key('2');
    fireEvent.click(button(/^Open Usage & costs/));
    expect(go).toHaveBeenCalledWith('/usage');
    key('1');
    expect(detail().querySelector('[data-runs]').textContent).toBe('Runs: node ~/.claude/desk/bin/needs-you.mjs record desk-skills usage-limit not-now');
    fireEvent.click(button(/^Wait until Tue 08:00/));
    await waitFor(() => expect(s.posts).toEqual([{ url: '/api/repos/acme__desk-skills/tickets/usage-limit/record', body: { action: 'not-now', batch: 'desk-skills' } }]));
  });

  it('AC15 an open item answered in Terminal reads as answered elsewhere at the next refresh, with its record line and Next item · j', async () => {
    const SV3952 = item('SV-3952', 'studia-web', 3, { kind: 'reviewer' });
    const s = await open({ list: listOf([SV3952, ...ITEMS.slice(0, 2)]) });
    fireEvent.click(row('SV-3952'));
    s.list = listOf(ITEMS.slice(0, 2), { recorded: [{ at: at(10, 11).toISOString(), batch: 'studia-web', key: 'SV-3952', action: 'done', line: 'recorded studia-web SV-3952 done' }] });
    key('r');
    const gone = await waitFor(() => { const n = detail().querySelector('[data-gone]'); expect(n).toBeTruthy(); return n; });
    expect(within(gone).getByText('SV-3952 was answered elsewhere at 10:11.')).toBeTruthy();
    expect(gone.querySelector('pre').textContent).toBe('recorded studia-web SV-3952 done');
    expect(within(gone).getByRole('button', { name: 'Next item (j)' }).getAttribute('title')).toBe('Next item · j');
    key('j');
    expect(screen.getByRole('article', { name: 'SV-3844 detail' })).toBeTruthy();
  });

  it('an item Desk recorded is not read as answered elsewhere when the refresh drops it', async () => {
    const s = await open();
    fireEvent.click(row('SV-4000'));
    fireEvent.click(radio(/not-now/));
    fireEvent.click(button(/^Put off/));
    await waitFor(() => expect(detail().querySelector('[data-recorded]')).toBeTruthy());
    s.list = listOf(ITEMS.filter((i) => i.key !== 'SV-4000'));
    key('r');
    await waitFor(() => expect(s.calls.length).toBe(2));
    expect([detail().querySelector('[data-gone]'), !!detail().querySelector('[data-recorded]')]).toEqual([null, true]);
  });

  it('an item Desk recorded that a later read lists again is asked again in the list', async () => {
    const s = await open();
    fireEvent.click(row('SV-4000'));
    fireEvent.click(radio(/not-now/));
    fireEvent.click(button(/^Put off/));
    await waitFor(() => expect(row('SV-4000')).toBeUndefined());
    // Still listed by the read straight after: hidden until needs-you drops it.
    key('r');
    await waitFor(() => expect(s.calls.length).toBe(2));
    expect(row('SV-4000')).toBeUndefined();
    s.list = listOf(ITEMS.filter((i) => i.key !== 'SV-4000'));
    key('r');
    await waitFor(() => expect(s.calls.length).toBe(3));
    s.list = listOf(ITEMS);
    key('r');
    await waitFor(() => expect(row('SV-4000')).toBeTruthy());
  });

  it('a record older than the last read that listed the item is not credited as its answer', async () => {
    const SV3952 = item('SV-3952', 'studia-web', 3, { kind: 'reviewer' });
    const s = await open({ list: listOf([SV3952, ...ITEMS.slice(0, 2)]) });
    fireEvent.click(row('SV-3952'));
    s.list = listOf(ITEMS.slice(0, 2), { generated_at: at(10, 12).toISOString(),
      recorded: [{ at: at(9, 40).toISOString(), batch: 'studia-web', key: 'SV-3952', action: 'not-now', line: 'studia-web SV-3952: put off' }] });
    key('r');
    const gone = await waitFor(() => { const n = detail().querySelector('[data-gone]'); expect(n).toBeTruthy(); return n; });
    expect(within(gone).getByText('SV-3952 left the list at 10:12.')).toBeTruthy();
    expect(gone.querySelector('pre')).toBeNull();
  });

  it('AC16 every needs-you kind offers its own actions, each Runs: line naming desk\'s own command', async () => {
    const ACTIONS = { parked: ['resume', 'not-now'], session: ['resume', 'not-now'], spine: ['answer', 'not-now'], plan: ['approve', 'reject'], triage: ['answer', 'not-now'],
      held: ['start', 'not-now'], stopped: ['requeue', 'drop'], pr: ['done', 'not-now'], worktree: ['start', 'drop'], usage: ['done', 'not-now'], 'base-push': ['approve', 'not-now'],
      config: ['done', 'not-now'], templates: ['done', 'not-now'], unset: ['done', 'not-now'], reviewer: ['done', 'not-now'], step: ['done', 'not-now'], lever: ['keep', 'drop'],
      // The kinds needs-you emits beyond the tips, each with its constructor's actions (a session ask's are its own choices).
      artifacts: ['done', 'not-now'], 'plan-first': ['open', 'not-now'], follow: ['done', 'not-now'], 'base-red': ['done', 'not-now'], duplicate: ['drop', 'not-now'],
      'browser-signin': ['done', 'not-now'], 'upload-page': ['done', 'not-now'], 'lease-trial': ['done', 'not-now'], ask: ['Plan2', 'A', 'done', 'not-now'],
      proposal: ['promote', 'reject', 'not-now'], 'ci-red': ['done', 'not-now'], ticketless: ['done', 'not-now'], 'cloud-archive': ['done', 'not-now'], stalled: ['done', 'not-now'],
      'subscription-off': ['done', 'not-now'], 'base-sync': ['done', 'not-now'] };
    // Every kind needs-you.mjs sets, as a literal or through its named constant, has a fixture here.
    // Vitest runs in desk/ui, and jsdom's import.meta.url is not a file URL.
    const src = readFileSync(`${process.cwd()}/../bin/needs-you.mjs`, 'utf8');
    const named = Object.fromEntries([...src.matchAll(/^const ([A-Z_]+) = '([a-z-]+)';/gm)].map((m) => [m[1], m[2]]));
    const emitted = new Set([...src.matchAll(/\bkind: (?:'([a-z-]+)'|([A-Z_]+)\b)/g)].map((m) => m[1] ?? named[m[2]]).filter(Boolean));
    expect(emitted.size).toBeGreaterThan(25);
    expect([...emitted].filter((k) => !(k in ACTIONS))).toEqual([]);
    expect(Object.keys(KIND_TIPS).filter((k) => !(k in ACTIONS))).toEqual([]);
    const fixtures = Object.entries(ACTIONS).map(([kind, acts], n) => item(kind === 'usage' ? 'usage-limit' : kind === 'step' ? 'step:DS-9:2' : `K-${n + 1}`, 'studia-web', n + 1,
      { kind, id: `studia-web:${kind}:${kind}`, ...(kind === 'usage' ? { ticket: null, resets_at: new Date(2026, 10, 24, 8, 0).toISOString() } : kind === 'step' ? { ticket: null } : {}),
        actions: acts.map((a) => ({ action: a, recommended: false, why: null, note: null, needs_text: ['resume', 'answer'].includes(a) })) }));
    await open({ list: listOf(fixtures) });
    for (const f of fixtures) {
      fireEvent.click(rows().find((r) => r.dataset.item === f.id));
      const cards = within(detail()).getAllByRole('radio');
      const own = f.kind === 'usage' ? ['wait', 'usage'] : f.actions.map((a) => a.action);
      expect(cards.map((r) => r.value)).toEqual(own);
      for (const r of cards) {
        fireEvent.click(r);
        const a = f.kind === 'usage' && r.value === 'wait' ? 'not-now' : r.value;
        if (f.kind === 'usage' && r.value === 'usage') { expect(detail().querySelector('[data-opens]').textContent).toBe('Opens: Usage & costs'); continue; }
        const field = within(detail()).queryByRole('textbox');
        if (field) fireEvent.change(field, { target: { value: 'go on' } });
        expect(detail().querySelector('[data-runs]').textContent).toBe(`Runs: node ~/.claude/desk/bin/needs-you.mjs record studia-web ${f.key} ${a}${field ? " 'go on'" : ''}`);
      }
    }
  });
});
