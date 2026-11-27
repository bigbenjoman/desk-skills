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
const QUEUE = { version: 1, batch: 'w', concurrency: 2, tickets: {
  'DS-563': { key: 'DS-563', state: 'done', result: { pr: 651 }, branch: 'fix/DS-563-clears-when', pr_status: recorded(651, REQUIRED.map(passed)) },
  'DS-564': { key: 'DS-564', state: 'running', result: { pr: 652 }, fix: { pr: 652, try: 1, of: 2, what: 'install failed' }, pr_status: recorded(652, REQUIRED.map(passed)) },
  'DS-567': { key: 'DS-567', state: 'done', result: { pr: 654 }, pr_status: recorded(654, REQUIRED.map(passed), { head: 'b'.repeat(40) }) },
  'DS-565': { key: 'DS-565', state: 'queued' },
  'DS-566': { key: 'DS-566', state: 'done', result: { pr: 653 }, pr_status: recorded(653, [passed('unit (node 24)'), { name: 'lint', status: 'completed', conclusion: 'failure', started: at(10, 1), completed: at(10, 2), runner: true, runId: 300, jobId: 301 }]) },
  'base-red-1': { key: 'base-red-1', state: 'queued' },
  // Stuck: held outside the batch with a question of its own, which resuming passes does not move.
  'DS-568': { key: 'DS-568', state: 'parked', outside_blockers: [{ key: 'EXT-9' }], open_questions: 1, park: { question: 'start without EXT-9?', clears_when: { kind: 'pr-merged', pr: 7 } } },
  // Requeued after its first PR merged at 08:00: its replacement PR #655 merged at 09:30.
  'DS-569': { key: 'DS-569', state: 'done', merged_at: at(8, 0), result: { pr: 655 }, pr_status: recorded(655, REQUIRED.map(passed), { state: 'MERGED', merged_at: at(9, 30) }) },
  // Its first PR merged, and the status recorded is that PR's, not its open replacement #656's.
  'DS-570': { key: 'DS-570', state: 'done', merged_at: at(8, 0), result: { pr: 656 }, pr_status: recorded(600, REQUIRED.map(passed), { state: 'MERGED', merged_at: at(8, 0) }) },
  // The merge driver merged replacement PR #657 at 09:45, and no pass has refreshed its OPEN status yet.
  'DS-571': { key: 'DS-571', state: 'done', merged_at: at(8, 0), merge: { pr: 657, at: at(9, 45) }, result: { pr: 657 }, pr_status: recorded(657, REQUIRED.map(passed)) },
  // Its first PR #601 merged, and its replacement #658 has no status recorded yet.
  'DS-572': { key: 'DS-572', state: 'done', merged_at: at(8, 0), merge: { pr: 601, at: at(8, 0) }, result: { pr: 658 } },
  // The merge driver recorded its own clock (09:46) and a pass then read GitHub's time (09:44) for #660.
  'DS-573': { key: 'DS-573', state: 'done', merged_at: at(9, 46), merge: { pr: 660, at: at(9, 46) }, result: { pr: 660 }, pr_status: recorded(660, REQUIRED.map(passed), { state: 'MERGED', merged_at: at(9, 44) }) },
  // A merge recorded with no PR, its PR #602 kept as merged_pr, and replacement #661 with no status yet.
  'DS-574': { key: 'DS-574', state: 'done', merged_at: at(8, 0), merge: { pr: null, at: at(8, 0) }, merged_pr: [602], result: { pr: 661 } },
} };
const QUEUE_FILE = join(process.env.DESK_HOME, 'repos', SLUG, 'queue.json');
writeFileSync(QUEUE_FILE, JSON.stringify(QUEUE));

// A second repo whose merges are granted, run by a supervisor whose passes are live: the merge driver merges its PRs.
const MSLUG = 'acme__merger', MGH = 'acme/merger';
mkdirSync(join(process.env.DESK_CONFIG_ROOT, 'repos', MSLUG), { recursive: true });
writeFileSync(join(process.env.DESK_CONFIG_ROOT, 'repos', MSLUG, 'config.md'),
  `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${join(T, 'merger')}\` |\n\n`
  + '## 3. Permissions\n\n| Key | Your setting |\n|---|---|\n| `autopilot-merge` | `yes` |\n| `pr-merge-green` | `yes` |\n\n'
  + '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3910` |\n| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n\n'
  + `## 4. Tools\n\n| Field | Value |\n|---|---|\n| GitHub repo | \`${MGH}\` |\n| Required checks | ${REQUIRED.map(tick).join(' ')} |\n`);
const MQUEUE = join(process.env.DESK_HOME, 'repos', MSLUG, 'queue.json');
mkdirSync(join(process.env.DESK_HOME, 'repos', MSLUG), { recursive: true });
writeFileSync(MQUEUE, JSON.stringify({ version: 1, batch: 'm', concurrency: 2, supervised: true, tickets: {
  'MG-1': { key: 'MG-1', state: 'done', result: { pr: 700 }, pr_status: { ...recorded(700, REQUIRED.map(passed)), url: `https://github.com/${MGH}/pull/700` } },
} }));
const NEXT = new Date(Date.now() + 10 * 60e3).toISOString();
mkdirSync(join(HOME, '.desk-autopilot', MSLUG, 'orchestrators'), { recursive: true });
writeFileSync(join(HOME, '.desk-autopilot', MSLUG, 'orchestrators', 'q.json'),
  JSON.stringify({ queue: MQUEUE, batch: 'm', pid: 1, at: new Date().toISOString(), pass: new Date().toISOString(), next: NEXT }));
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
const server = makeServer({ p: PORT, log: () => {}, pr: { gh, now: () => now } });
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
const stuck = (await get(api('DS-568'))).body;
t('a stuck ticket is not one stopped passes hold', [stuck.state, stuck.stopped, stuck.passes.live], ['stuck', false, false]);
t('the ticket carries its PR as the last pass recorded it', [tk.key, tk.pr.number, tk.pr.head, tk.gh_repo, tk.jira_browse], ['DS-563', 651, HEAD, GH, 'https://jira.example.net/browse/']);

// ---- AC5: all 14 required checks green and approved
answer = () => ({ exit: 0, stdout: JSON.stringify(prView(651, REQUIRED.map((n) => node(n)))), stderr: '' });
const ready = (await get(api('DS-563', '/pr'))).body;
t('AC5 with no merge grant the verdict reads ready to merge, then that it waits for you', ready.verdict.text, 'Ready to merge: all 14 required checks green and approved. It waits for you to merge it.');
t('AC5 it is read from GitHub now', [ready.source, ready.as_of, ready.checks.length], ['github', new Date(now).toISOString(), 14]);
t('AC5 gh ran once, read only, for that PR in its repo', calls.map((a) => a.slice(0, 5)), [['pr', 'view', '651', '--repo', GH]]);
// Merges granted and passes live: the merge driver merges it at the next pass.
answer = () => ({ exit: 0, stdout: JSON.stringify(prView(700, REQUIRED.map((n) => node(n)), { url: `https://github.com/${MGH}/pull/700` })), stderr: '' });
const driven = (await get(`/api/repos/${MSLUG}/tickets/MG-1/pr`)).body;
t('AC5 the verdict reads ready to merge, then when the merge driver merges it', driven?.verdict?.text,
  `Ready to merge: all 14 required checks green and approved. The merge driver merges it at the next pass (${new Date(NEXT).toTimeString().slice(0, 5)}).`);

// ---- a replacement PR's merge time is its own, not the first PR's
t('a replacement PR that merged reads its own merge time', (await get(api('DS-569'))).body.merged_at, at(9, 30));
t('a ticket whose recorded status is an earlier PR\'s reads no merge time for its own', (await get(api('DS-570'))).body.merged_at, null);
t('a merge the merge driver recorded reads before a pass refreshes the PR\'s status', (await get(api('DS-571'))).body.merged_at, at(9, 45));
t('a replacement PR with no status yet does not read the first PR\'s merge time', (await get(api('DS-572'))).body.merged_at, null);
t('GitHub\'s merge time a pass read wins over the merge driver\'s clock', (await get(api('DS-573'))).body.merged_at, at(9, 44));
t('a merge with no PR named is not a replacement PR\'s when merged_pr keeps another', (await get(api('DS-574'))).body.merged_at, null);
t('the ticket page carries the worker count', typeof tk.passes.workers, 'number');

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
// A head the pass records during the fix try is not the cached read's, so GitHub is read again.
QUEUE.tickets['DS-564'].pr_status.head = 'c'.repeat(40);
writeFileSync(QUEUE_FILE, JSON.stringify(QUEUE));
now += 10_000;
await get(api('DS-564', '/pr'));
t('AC11 a head the pass records during a fix try reads GitHub again', calls.length - fixRead, 1);
// GitHub's head ahead of the one the last pass recorded: the same head as the last fetch, so the cache.
answer = () => ({ exit: 0, stdout: JSON.stringify(prView(654, REQUIRED.map((n) => node(n)))), stderr: '' });
await get(api('DS-567', '/pr'));
const lag = calls.length;
now += 10_000;
await get(api('DS-567', '/pr'));
t('AC11 a head the pass has not recorded yet is answered from the cache too', calls.length - lag, 0);
// A hold the pass records after the read shows at once, from the cached read, with no gh.
QUEUE.tickets['DS-563'].merge_blocked = 'approval: it needs an approving review from a code owner';
writeFileSync(QUEUE_FILE, JSON.stringify(QUEUE));
await get(api('DS-563', '/pr'));
const held = calls.length;
const heldRead = (await get(api('DS-563', '/pr'))).body;
t('a hold recorded since the read reads at once, from the cache', [calls.length - held, heldRead.verdict.tone, heldRead.verdict.text.startsWith('Ready')], [0, 'person', false]);

// ---- AC8 on a fix try: the copy the pass recorded while it was done, and when
answer = () => ({ exit: 1, stdout: '', stderr: 'HTTP 502' });
now += 61_000;
const fixDown = (await get(api('DS-564', '/pr'))).body;
t('AC8 a ticket on a fix try shows the pass\'s copy and its time', [fixDown.source, fixDown.note], ['pass', `Showing the copy from the last pass (${hhmm(at(10, 5))}). GitHub isn't answering.`]);

// ---- AC10: no GitHub credential in any response
t('AC10 no response carries gh\'s token, or a credential gh printed', [texts.length > 10, texts.filter((s) => s.includes(GH_TOKEN) || s.includes(SECRET)).length], [true, 0]);

server.close();
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
