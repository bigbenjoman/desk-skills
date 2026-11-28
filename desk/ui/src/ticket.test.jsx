import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_FILES, NO_PR, TicketPage, stateLine } from './ticket.jsx';

const at = (h, m) => new Date(2026, 10, 26, h, m).toISOString();
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const SNAP = { at: at(10, 8), repos: [{ id: 'bigbenjoman__desk-skills', slug: 'bigbenjoman__desk-skills', name: 'desk-skills', jira_browse: 'https://jira.example.net/browse/' }] };

// DS-676 as the server's ticket read gives it, running at stage 4/9 Verify since 09:53.
const DS676 = {
  key: 'DS-676', repo: 'desk-skills', gh_repo: 'bigbenjoman/desk-skills', jira_browse: 'https://jira.example.net/browse/',
  state: 'running', group: 'running', type: 'Story', size: 'M', lane: 'A', pos: 1, places: 24,
  title: 'desk-pr: a saved-canvas PR shows one stitched image per board and theme, with every breakpoint and its PASS/FAIL table',
  stage: { label: '4/9 verify', at: at(9, 53) }, passes: { live: true, last: at(10, 5), next: at(10, 15), merges: true }, question: null, open_questions: 0, hold: null, behind: [], wait: null,
  collides: ['SV-4017'], fix: null, stuck: null, failed_why: null, merged_at: null, pr: null,
  schedule: [{ label: 'Starts', text: 'running now', note: null }, { label: 'Ships', text: 'today 13:03', note: 'could run to today 17:10 (1 run in 5 is later)' },
    { label: 'Based on', text: '29 merged size M tickets in desk-skills · typical 5.3 h spawn to merge, 4 in 5 within 12.7 h', note: null }],
  lane_reason: 'The change stays inside skills/desk-pr and its tests, and no production surface or shared config moves.',
  files: ['skills/desk-pr/scripts/stitch.mjs', 'skills/desk-pr/references/screenshots.md'], blocks: ['DS-679'],
  worker: { branch: 'feat/DS-676-stitched-canvas-pr-images', worktree: '~/studia/desk-skills-worktrees/DS-676', port: '4831', subscription: 'ben@studia.example',
    model: 'opus', effort: 'high', session_id: '9f2c1e7a-44b0-4c1d-9a1e-0c5b7d2e1f00', log: '~/.desk-autopilot/bigbenjoman__desk-skills/logs/DS-676.log' },
};

function open(ticket, { path = `/t/desk-skills/${ticket.key}`, pr = null } = {}) {
  const get = vi.fn(async (url) => {
    if (url === `/api/repos/${SNAP.repos[0].slug}/tickets/${ticket.key}`) return json(ticket);
    if (url.endsWith('/pr') && pr) return json(pr);
    return json({ error: { code: 'not_found', message: 'No such route.' } }, 404);
  });
  const go = vi.fn();
  render(<TicketPage path={path} go={go} snapshot={SNAP} get={get} />);
  return { get, go };
}
const line = () => document.querySelector('[data-state-line]').textContent;

afterEach(cleanup);

describe('the state line', () => {
  it('AC1: DS-676 running at stage 4/9 Verify since 09:53 moves without you', async () => {
    open(DS676);
    await screen.findByText(DS676.title);
    expect(line()).toBe('Moves without you: a worker is on it, stage 4/9 Verify since 09:53.');
  });

  // AC2: each state's sentence from screen-spec §6.1, with the ticket's own keys and times.
  const base = { ...DS676, stage: null };
  it.each([
    ['needs you', { state: 'needs', question: 'SV-3844 PR #2699 is an external-shape change with no live check possible.' },
      'Needs your answer: SV-3844 PR #2699 is an external-shape change with no live check possible.'],
    ['waiting', { state: 'waiting', behind: [{ key: 'DS-672', state: 'running', stage: '0/9' }] }, 'Moves by itself: behind DS-672 (running, stage 0/9).'],
    ['merging', { state: 'merging', pr: { number: 658, draft: true } }, 'Merges by itself once green: #658 is draft and comes out of draft at the next pass.'],
    ['on checks', { state: 'checks', group: 'merging', pr: { number: 658, draft: true, need: 'draft · waiting on checks: re-run once after their run finishes as their failed logs name no file this PR changes, out of draft once green' } },
      'Merges by itself once green: #658: draft, waiting on checks: re-run once after their run finishes as their failed logs name no file this PR changes, out of draft once green.'],
    ['ready', { state: 'ready', wait: 'waits for DS-606 (collides)' }, 'Starts when a worker is free. Waits for DS-606 (collides).'],
    ['failed', { state: 'failed', failed_why: 'unit (node 24) still red after 2 fix tries' }, 'Stopped: unit (node 24) still red after 2 fix tries. Requeue or drop it in Inbox.'],
    ['done', { state: 'done', merged_at: at(9, 41), pr: { number: 651 } }, 'Merged at 09:41 as #651.'],
  ])('AC2: %s', (_, more, want) => {
    const l = stateLine({ ...base, ...more });
    expect(`${l.lead}${l.rest ? ` ${l.rest}` : ''}`).toBe(want);
  });

  it('a ticket waiting to start does not say it moves while passes are stopped', () => {
    const l = stateLine({ ...base, state: 'ready', wait: 'waits for DS-606 (collides)', passes: { live: false }, stopped: true });
    expect(`${l.lead}${l.rest ? ` ${l.rest}` : ''}`).toBe('Will not move until passes resume.');
  });

  it('a ticket waiting to start with the worker count at 0 says to raise it, not that a worker frees up', () => {
    const l = stateLine({ ...base, state: 'ready', wait: 'workers set to 0', passes: { live: true, workers: 0 }, stopped: false });
    expect(`${l.lead}${l.rest ? ` ${l.rest}` : ''}`).toBe('Will not start until the worker count is raised: workers are set to 0.');
  });
});

describe('the Overview tab', () => {
  it('AC3: shows the schedule, the verbatim lane reason, the files, the collisions and blockers, and the worker', async () => {
    open(DS676);
    await screen.findByText(DS676.title);
    expect(screen.getByText('running now')).toBeTruthy();
    expect(screen.getByText('today 13:03')).toBeTruthy();
    expect(screen.getByText(/^Based on 29 merged size M tickets in desk-skills/)).toBeTruthy();
    expect(screen.getByText('Why lane A')).toBeTruthy();
    expect(screen.getByText(DS676.lane_reason)).toBeTruthy();
    for (const f of DS676.files) expect(screen.getByText(f)).toBeTruthy();
    expect(screen.getByText('Never runs with')).toBeTruthy();
    expect(screen.getByText('SV-4017')).toBeTruthy();
    expect(screen.getByText('DS-679')).toBeTruthy();
    for (const v of [DS676.worker.branch, DS676.worker.worktree, '4831', 'ben@studia.example', 'opus · effort high', DS676.worker.session_id]) expect(screen.getByText(v)).toBeTruthy();
  });

  it('AC4: a ticket with no listed files says the worker decides scope', async () => {
    open({ ...DS676, files: [] });
    await screen.findByText(DS676.title);
    expect(screen.getByText(NO_FILES).textContent).toBe('No files listed. The worker decides scope.');
  });
});

describe('the PR & CI tab', () => {
  it('a ticket with no PR says when the worker opens one, and asks the server for none', async () => {
    const { get } = open(DS676, { path: '/t/desk-skills/DS-676/pr' });
    expect((await screen.findByText(NO_PR)).textContent).toBe('No PR yet. The worker opens one at stage 7/9 (PR).');
    expect(get.mock.calls.some(([u]) => u.endsWith('/pr'))).toBe(false);
  });

  it('shows the verdict and the checks, the failed row first with its job link, and expands its log', async () => {
    window.desk = { openExternal: vi.fn() };
    const job = 'https://github.com/bigbenjoman/desk-skills/actions/runs/1/job/9';
    const pr = { pr: { number: 652, title: 'fix: x', url: 'https://github.com/bigbenjoman/desk-skills/pull/652', state: 'OPEN', draft: false }, source: 'github', as_of: at(10, 7), note: null,
      verdict: { tone: 'warn', text: 'Blocked: install is red. Fix try 1 of 2 is running.' },
      checks: [{ name: 'install', status: 'failed', kind: 'required', job_id: '9', url: job }, { name: 'lint', status: 'passed', kind: 'required', job_id: '8', url: job.replace('/9', '/8') }] };
    const { get } = open({ ...DS676, pr: { number: 652, url: pr.pr.url } }, { path: '/t/desk-skills/DS-676/pr', pr });
    expect((await screen.findByText('Blocked:')).parentElement.textContent).toBe('Blocked: install is red. Fix try 1 of 2 is running.');
    const rows = [...document.querySelectorAll('[data-check]')].map((r) => r.dataset.check);
    expect(rows).toEqual(['failed', 'passed']);
    fireEvent.click(screen.getAllByText('Job')[0]);
    expect(window.desk.openExternal).toHaveBeenCalledWith(job);
    get.mockImplementation(async (url) => (url.endsWith('/jobs/9/log') ? json({ job: '9', lines: ['line 1', 'line 2'], as_of: at(10, 7) }) : json(pr)));
    fireEvent.click(screen.getByRole('button', { name: 'install' }));
    expect((await screen.findByText(/the last 2 lines/)).textContent).toBe('As of 10:07 · the last 2 lines');
  });
});
