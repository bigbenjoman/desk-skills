// suite: desk-ui ticket page reads (the ticket, its PR & CI tab from a stubbed gh, the job log, the 60 s cache)
// layer: L1
// covers: desk/bin/desk-ui.mjs desk/bin/desk-ui-ticket.mjs desk/bin/desk-q-model.mjs
// The server in this process on a throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT and a free port, with a
// stub in place of gh that counts its calls. The gh pr view fixture keeps the shape of a real
// `gh pr view 1517 --repo bigbenjoman/desk-skills --json …` answer, recorded 2026-11-26.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { call as callPort, freePort } from './local-http.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const T = scratch('desk-ui-ticket-');
const HOME = join(T, 'home');
// Credential-shaped values gh's environment and output carry: none may reach a response.
const GH_TOKEN = ['gho', 'Zx9'.repeat(12)].join('_');
const SECRET = ['ghs', 'Qq7'.repeat(12)].join('_');
Object.assign(process.env, { HOME, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'), GH_TOKEN });
mkdirSync(HOME, { recursive: true });
writeFileSync(process.env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');
const TOKEN = ['tok', 'e5'.repeat(30)].join('');
mkdirSync(process.env.DESK_CONFIG_ROOT, { recursive: true });
writeFileSync(join(process.env.DESK_CONFIG_ROOT, 'ui-token'), `${TOKEN}\n`, { mode: 0o600 });

const SLUG = 'acme__desk-skills', GH = 'acme/desk-skills';
const REQUIRED = ['unit (node 24)', 'unit (node 22)', 'lint', 'skills-index', 'desk-q snapshot', 'browser (playwright)', 'types', 'plan',
  'prose', 'install', 'shell', 'scope', 'related', 'docs'];
const tick = (s) => `\`${s}\``;
mkdirSync(join(process.env.DESK_CONFIG_ROOT, 'repos', SLUG), { recursive: true });
writeFileSync(join(process.env.DESK_CONFIG_ROOT, 'repos', SLUG, 'config.md'),
  `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${join(T, 'checkout')}\` |\n\n`
  + '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3900` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n\n'
  + `## 4. Tools\n\n| Field | Value |\n|---|---|\n| Required checks | ${REQUIRED.map(tick).join(' ')} |\n| Advisory checks | \`docs links\` |\n`
  + '| Known flaky checks | `supervisor e2e: e2e/**` |\n| Jira site | `jira.example.net` |\n');

const at = (h, m) => new Date(2026, 10, 26, h, m).toISOString();
const HEAD = '73ee8aca9b1d2c3e4f5a6b7c8d9e0f1a2b3c4d5e';
const recorded = (pr, checks, more = {}) => ({ pr, state: 'OPEN', isDraft: false, head: HEAD, at: at(10, 5), url: `https://github.com/${GH}/pull/${pr}`, checks, ...more });
const passed = (name) => ({ name, status: 'completed', conclusion: 'success', started: at(9, 50), completed: at(9, 54) });
mkdirSync(join(process.env.DESK_HOME, 'repos', SLUG), { recursive: true });
writeFileSync(join(process.env.DESK_HOME, 'repos', SLUG, 'queue.json'), JSON.stringify({ version: 1, batch: 'w', concurrency: 2, tickets: {
  'DS-563': { key: 'DS-563', state: 'done', result: { pr: 651 }, branch: 'fix/DS-563-clears-when', pr_status: recorded(651, REQUIRED.map(passed)) },
  'DS-564': { key: 'DS-564', state: 'running', result: { pr: 652 }, fix: { pr: 652, try: 1, of: 2, what: 'install failed' } },
  'DS-565': { key: 'DS-565', state: 'queued' },
  'DS-566': { key: 'DS-566', state: 'done', result: { pr: 653 }, pr_status: recorded(653, [passed('unit (node 24)'), { name: 'lint', status: 'completed', conclusion: 'failure', started: at(10, 1), completed: at(10, 2), runner: true, runId: 300, jobId: 301 }]) },
  'base-red-1': { key: 'base-red-1', state: 'queued' },
} }));
const STATE = join(HOME, '.desk-autopilot', SLUG);
mkdirSync(join(STATE, 'triage'), { recursive: true });
writeFileSync(join(STATE, 'triage', 'DS-565.json'), JSON.stringify({ summary: 'desk-ui: a ticket page', lane: 'A', size: 'M', lane_reason: 'Mechanical.', files_in_scope: [] }));

// The gh stub: `answer(args)` decides each call; every call is counted.
const calls = [];
let answer = () => ({ exit: 1, stdout: '', stderr: 'unset' });
const gh = async (args) => { calls.push(args); return answer(args); };
let now = Date.parse(at(10, 7));
const node = (name, conclusion = 'SUCCESS', job = 2000 + REQUIRED.indexOf(name)) => ({ __typename: 'CheckRun', completedAt: '2026-11-26T10:06:00Z', conclusion, name, status: 'COMPLETED', workflowName: 'tests',
  startedAt: '2026-11-26T10:02:00Z', detailsUrl: `https://github.com/${GH}/actions/runs/100/job/${job}` });
const prView = (n, rollup, more = {}) => ({ number: n, title: `fix(autopilot): PR ${n}`, url: `https://github.com/${GH}/pull/${n}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', latestReviews: [{ state: 'APPROVED', author: { login: 'reviewer' }, body: SECRET }], headRefOid: HEAD,
  headRefName: 'fix/x', baseRefName: 'main', mergedAt: null, statusCheckRollup: rollup, token: SECRET, ...more });

const { makeServer } = await import('../desk/bin/desk-ui.mjs');
const PORT = await freePort();
const server = makeServer({ p: PORT, log: () => {}, github: { gh, now: () => now } });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const call = (method, path, opts) => callPort(PORT, method, path, opts);
const ex = await call('POST', '/api/auth/exchange', { headers: { Origin: `http://127.0.0.1:${PORT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
const signed = { Cookie: String(ex.headers['set-cookie']).split(';')[0], 'X-Desk-Load': JSON.parse(ex.text).loadToken };
const texts = [];
const get = async (path) => { const r = await call('GET', path, { headers: signed }); texts.push(r.text); return { status: r.status, body: (() => { try { return JSON.parse(r.text); } catch { return null; } })() }; };
const api = (key, rest = '') => `/api/repos/${SLUG}/tickets/${key}${rest}`;

// ---- the routes are a signed-in window's only
t('the ticket read needs the window signed in', (await call('GET', api('DS-563'))).status, 401);
t('a key that is not one is refused', (await get(api('DS..563'))).status, 400);
t('any id a queue admits is read, a lowercase base-red one included', (await get(api('base-red-1'))).body?.key, 'base-red-1');
t('a repo that is not configured is a 404', (await get(`/api/repos/acme__nope/tickets/DS-563`)).status, 404);
t('a ticket in no batch is a 404', (await get(api('DS-999'))).status, 404);
const tk = (await get(api('DS-563'))).body;
t('the ticket carries its PR as the last pass recorded it', [tk.key, tk.pr.number, tk.pr.head, tk.gh_repo, tk.jira_browse], ['DS-563', 651, HEAD, GH, 'https://jira.example.net/browse/']);

// ---- AC5: all 14 required checks green and approved
answer = () => ({ exit: 0, stdout: JSON.stringify(prView(651, REQUIRED.map((n) => node(n)))), stderr: '' });
const ready = (await get(api('DS-563', '/pr'))).body;
t('AC5 the verdict reads ready to merge, then when the merge driver merges it', ready.verdict.text, 'Ready to merge: all 14 required checks green and approved. It waits for you to merge it.');
t('AC5 it is read from GitHub now', [ready.source, ready.as_of, ready.checks.length], ['github', new Date(now).toISOString(), 14]);
t('AC5 gh ran once, read only, for that PR in its repo', calls.map((a) => a.slice(0, 5)), [['pr', 'view', '651', '--repo', GH]]);

// ---- AC6: one failed, 13 passed: the failed row first, each with its job link
answer = () => ({ exit: 0, stdout: JSON.stringify(prView(652, REQUIRED.map((n, i) => node(n, i === 9 ? 'FAILURE' : 'SUCCESS')))), stderr: '' });
const red = (await get(api('DS-564', '/pr'))).body;
t('AC6 the failed check is the first row', [red.checks[0].name, red.checks[0].status, red.checks.slice(1).every((c) => c.status === 'passed')], ['install', 'failed', true]);
t('AC6 every row links to its job on GitHub', red.checks.every((c) => c.url === `https://github.com/${GH}/actions/runs/100/job/${c.job_id}`), true);
t('AC6 the verdict names the red check and the fix try running', red.verdict.text, 'Blocked: install is red. Fix try 1 of 2 is running.');

// ---- AC7: the failed row's job log, its last 40 lines, with when it was read
const LOG = Array.from({ length: 55 }, (_, i) => `tests\tRun unit\t﻿2026-11-26T10:05:${String(i).padStart(2, '0')}.0000000Z line ${i + 1}`).join('\n');
answer = (a) => (a[0] === 'run' ? { exit: 0, stdout: `${LOG}\n`, stderr: '' } : { exit: 1, stdout: '', stderr: '' });
const job = red.checks[0].job_id;
const log = (await get(api('DS-564', `/pr/jobs/${job}/log`))).body;
t('AC7 the job log is its last 40 lines, each its time and text', [log.lines.length, log.lines[0], log.lines.at(-1)], [40, '2026-11-26T10:05:15.0000000Z line 16', '2026-11-26T10:05:54.0000000Z line 55']);
t('AC7 it says when it was read', log.as_of, new Date(now).toISOString());
t('AC7 gh read that job of that repo', calls.at(-1), ['run', 'view', '--job', job, '--log', '--repo', GH]);
t('a job id that is not a number is no route', (await get(api('DS-564', '/pr/jobs/12;rm/log'))).status, 404);
const before7 = calls.length;
t('a job that is not one of the PR\'s checks is refused, and runs no gh', [(await get(api('DS-564', '/pr/jobs/99999/log'))).status, calls.length - before7], [404, 0]);

// ---- AC8: GitHub not answering: the last pass's copy, said as such
answer = () => ({ exit: 1, stdout: '', stderr: `HTTP 502 (token ${SECRET})` });
const down = (await get(api('DS-566', '/pr'))).body;
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);
t('AC8 the note says it is the last pass\'s copy, and when', down.note, `Showing the copy from the last pass (${hhmm(at(10, 5))}). GitHub isn't answering.`);
t('AC8 and shows that copy, failed first', [down.source, down.checks.map((c) => [c.name, c.status])], ['pass', [['lint', 'failed'], ['unit (node 24)', 'passed']]]);
t('AC8 the copy keeps the job the pass recorded, with its link', [down.checks[0].job_id, down.checks[0].url, down.checks[0].runner], [301, `https://github.com/${GH}/actions/runs/300/job/301`, null]);

// ---- the verdict reads the PR as prNeed does: green checks on a PR in conflict are not ready
answer = () => ({ exit: 0, stdout: JSON.stringify(prView(653, REQUIRED.map((n) => node(n)), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })), stderr: '' });
const clash = (await get(api('DS-566', '/pr'))).body;
t('a PR in conflict is not ready to merge', clash.verdict, { tone: 'warn', text: 'Merge conflict with main, the next pass sends it to a worker, try 1 of 2.' });

// ---- AC9: no PR yet
const ran = calls.length;
const none = await get(api('DS-565', '/pr'));
t('AC9 a ticket with no PR says so, and runs no gh', [none.body.pr, none.body.text, calls.length - ran], [null, 'No PR yet. The worker opens one at stage 7/9 (PR).', 0]);

// ---- AC11: read again inside 60 s at the same head: from the cache, no gh
answer = () => ({ exit: 0, stdout: JSON.stringify(prView(651, REQUIRED.map((n) => node(n)))), stderr: '' });
now += 61_000;
await get(api('DS-563', '/pr'));
const before = calls.length;
now += 30_000;
const again = (await get(api('DS-563', '/pr'))).body;
t('AC11 inside 60 s at the same head the server answers from its cache without running gh', [calls.length - before, again.verdict.text.startsWith('Ready to merge')], [0, true]);
now += 31_000;
await get(api('DS-563', '/pr'));
t('AC11 once 60 s have passed it reads GitHub again', calls.length - before, 1);
// A ticket on a fix try has no head the pass recorded, and is cached all the same.
answer = () => ({ exit: 0, stdout: JSON.stringify(prView(652, REQUIRED.map((n) => node(n)))), stderr: '' });
now += 61_000;
await get(api('DS-564', '/pr'));
const fixRead = calls.length;
now += 10_000;
await get(api('DS-564', '/pr'));
t('AC11 a ticket on a fix try is answered from the cache too', calls.length - fixRead, 0);

// ---- AC10: no GitHub credential in any response
t('AC10 no response carries gh\'s token, or a credential gh printed', [texts.length > 10, texts.filter((s) => s.includes(GH_TOKEN) || s.includes(SECRET)).length], [true, 0]);

server.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
