// suite: pass phase: advance running tickets and the usage limit (the decisions, and the generator runner)
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideAdvance, decideUsageLimit, logMarkers, REBOOT } from '../desk/bin/pass/advance.mjs';
import { registryView } from '../desk/bin/pass/shared.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const HOUR = 3600_000;
// A worker's log: stream-json events, and the harvested output `h` the decision reads its markers from.
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const RESULT = { type: 'result', subtype: 'success' };
const logOf = (key, h, events, { mtimeMs = NOW - HOUR } = {}) => {
  const text = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  const raw = Buffer.from(text);
  return { path: `/state/logs/${key}.log`, h, raw, text, size: raw.length, mtimeMs };
};
const ticket = (key, fields = {}) => ({ key, state: 'running', branch: `fix/${key}`, session_id: `sid-${key}`, ...fields });
// The registry: `sessions` live, or unread.
const snap = (tk, log, { sessions = [], read = true, upload = true } = {}) => ({
  t: tk, log, registry: registryView(read ? { live: sessions } : { why: 'claude agents failed' }), now: NOW, stateDir: '/state',
  resume: { row: 'Resume a killed worker (times)', limit: 2, bad: null }, bootMs: NOW - 24 * HOUR,
  upload: { allowed: upload, perm: upload ? 'yes' : 'ask', key: 'pr-images', command: '/bin/upload-images.mjs' },
  read: { branch: 'main', checkout: '/state/live-read-checkout' },
});

// The runner with stub handlers: each read answers from `answers` (a value, or a function of the
// action), else from what the pass reads when nothing is there.
const READS = {
  'open-pr': '', 'suite-wait': null, 'build-park': null, 'merge-park': null, shots: [], cells: null, 'open-question': null,
  'settle-links': [], 'live-read': null, 'clears-when': { kind: 'none' }, register: { inputs: {}, status: 'new' }, recommends: null,
  'refuse-lease': false, lifted: false, 'exit-code': null,
};
const WRITES = ['set', 'report', 'cloud', 'note', 'hold', 'kill', 'park', 'upload', 'worker-head', 'done', 'park-links', 'keep-links', 'decisions', 'handoff', 'fail', 'keep-holds', 'usage-hold'];
function drive(decide, s, answers = {}) {
  const handlers = Object.fromEntries([...Object.keys(READS), ...WRITES].map((type) => [type, (a) => {
    const v = Object.hasOwn(answers, type) ? answers[type] : READS[type];
    return typeof v === 'function' ? v(a) : v;
  }]));
  const report = { failed: [] };
  const actions = runSteps({ name: 'advance', snapshot: () => s, decide, handlers, report });
  return { actions, failed: report.failed };
}
const advance = (s, answers) => drive(decideAdvance, s, answers).actions;
const types = (as) => as.map((a) => a.type);
const lines = (as, list) => as.filter((a) => a.type === 'report' && (!list || a.list === list)).map((a) => a.line);
const sets = (as) => as.filter((a) => a.type === 'set').flatMap((a) => a.fields);
// What moves a ticket on: anything but a read, or the liveness count (log_bytes, idle_passes).
const LIVENESS = /^(log_bytes|idle_passes|suite_wait_since)=/;
const moves = (as) => as.filter((a) => !Object.hasOwn(READS, a.type) && !(a.type === 'set' && a.fields.every((f) => LIVENESS.test(f))));
// What marks a ticket finished, or starts it again.
const FINISHES = new Set(['done', 'fail', 'park', 'handoff', 'kill', 'worker-head', 'park-links']);
const finishes = (as) => as.filter((a) => FINISHES.has(a.type) || (a.type === 'set' && a.fields.some((f) => /^(state|resume)=/.test(f))));

// AC4: a running ticket with no log yet gets no action. A cloud session has no log here either.
t('AC4 a running ticket with no log yet gets no action', j(advance(snap(ticket('A'), null))), '[]');
t('a cloud session is advanced from its PR, not a log', j(advance(snap(ticket('A', { location: 'cloud', cloud: { started: 'x' } }), null))), j([{ type: 'cloud', key: 'A' }]));

// AC1: with the session registry unread, nothing is marked finished or started again, whatever the logs say.
{
  const DONE = 'AUTOPILOT_DONE: pr=12 jira=Done';
  const tickets = [
    snap(ticket('D'), logOf('D', DONE, [said(DONE), RESULT]), { read: false }),
    snap(ticket('K'), logOf('K', '', [said('working')]), { read: false }),
    snap(ticket('W', { log_bytes: 0, idle_passes: 5 }), logOf('W', '', []), { read: false }),
    snap(ticket('P'), logOf('P', 'AUTOPILOT_PARK: which colour?', [said('AUTOPILOT_PARK: which colour?')]), { read: false }),
  ];
  const all = tickets.flatMap((s) => advance(s, { 'build-park': () => { throw new Error('read with no registry'); } }));
  t('AC1 an unread registry marks no ticket finished and starts none again', j(finishes(all)), '[]');
  t('AC1 and a quiet worker it cannot stop is counted, not parked as wedged', j(sets(advance(tickets[2]))), '["idle_passes=6"]');
}

// AC2: workers the registry lists, whose logs show them still working, get no action that moves them on.
{
  const sessions = [{ sessionId: 'sid-A', pid: 11 }, { sessionId: 'sid-B', pid: 12 }];
  const all = ['A', 'B'].flatMap((k) => advance(snap(ticket(k, { stage: '3/9', log_bytes: 0 }), logOf(k, 'AUTOPILOT_STAGE: 3/9 implement', [said('AUTOPILOT_STAGE: 3/9 implement'), said('editing')]), { sessions })));
  t('AC2 live workers whose logs grew get nothing but their liveness count', j(moves(all)), '[]');
  t('AC2 and each is asked only whether it waits on a question', j(types(all)), '["set","open-question","set","open-question"]');
  const asked = advance(snap(ticket('A', { stage: '3/9', log_bytes: 0 }), logOf('A', '', [said('x')]), { sessions }), { 'open-question': 'which colour?' });
  t('a live worker sitting on a question is reported waiting, and nothing else', j(lines(asked)), '["A: which colour?"]');
}

// AC3: an exited worker whose log carries AUTOPILOT_DONE is recorded done on its PR.
{
  const DONE = 'AUTOPILOT_DONE: pr=12 jira=Done';
  const as = advance(snap(ticket('D'), logOf('D', DONE, [said(DONE), RESULT])));
  const done = as.find((a) => a.type === 'done');
  t('AC3 a DONE worker is recorded done on the PR it names', j(done), j({ type: 'done', key: 'D', pr: '12', summary: 'pr=12 jira=Done', line: 'pr=12 jira=Done', sets: [] }));
  t('AC3 after recording its exited head, and then its issue links are settled', j(types(as).slice(types(as).indexOf('worker-head'))), '["worker-head","done","settle-links","park-links"]');
  t('DS-193 AC1 a finished worker with no screenshot records none', j(sets(as)), j([`log_bytes=${logOf('D', DONE, [said(DONE), RESULT]).size}`, 'idle_passes=0', 'images_uploaded=none']));
  const parkedLinks = advance(snap(ticket('D'), logOf('D', DONE, [said(DONE), RESULT])), { 'settle-links': [{ why: 'no grant', link: null }] });
  t('links a DONE worker asked for that were not made go to park-links', j(parkedLinks.at(-1)), j({ type: 'park-links', key: 'D', needs: [{ why: 'no grant', link: null }], pr: '12' }));
}

// The cases tests/test_pass_workers.sh runs end to end, decided here.
{
  const DONE = 'AUTOPILOT_DONE: pr=10 jira=none';
  const as = advance(snap(ticket('T-10', { session_id: 'hung-1' }), logOf('T-10', `AUTOPILOT_STAGE: 9/9 cleanup\n${DONE}`, [said(DONE)]), { sessions: [{ sessionId: 'live-1' }, { sessionId: 'hung-1', pid: 4242 }] }));
  t('a DONE log with a live session records the ticket done, and its hung session is stopped',
    j(as.filter((a) => ['kill', 'done'].includes(a.type)).map((a) => a.line ?? a.pid)), j([4242, 'pr=10 jira=none (session still live after DONE — stopped pid 4242)']));
}
{
  const p1 = (stage, extra) => snap(ticket('P-1', { session_id: 'live-1', stage: '5/9', log_bytes: 0 }), logOf('P-1', `AUTOPILOT_STAGE: ${stage}`, [said(stage), ...extra]), { sessions: [{ sessionId: 'live-1' }] });
  t('DS-201 AC2 before Stage 7 the pass does not look for the PR', types(advance(p1('6/9 evidence', []))).includes('open-pr'), false);
  const at7 = advance(p1('7/9 pr', []), { 'open-pr': (a) => (a.branch === 'fix/P-1' ? '77' : '') });
  t('DS-201 AC2 a PR a running worker opened is kept as draft_pr', j([sets(at7).includes('draft_pr=77'), lines(at7, 'advanced')]), j([true, ['P-1 → 7/9', 'P-1 opened PR #77']]));
}
{
  const quiet = (key, h) => { const log = logOf(key, h, [said(h)]); return snap(ticket(key, { session_id: 'live-1', idle_passes: 5, log_bytes: log.size, stage: /STAGE: (\S+)/.exec(h)?.[1] }), log, { sessions: [{ sessionId: 'live-1', pid: 77 }] }); };
  const t11 = advance(quiet('T-11', 'AUTOPILOT_DONE: pr=11 jira=none'));
  t('the stall killer does not park a ticket whose log has DONE', j([t11.find((a) => a.type === 'done')?.pr, lines(t11, 'stalled'), types(t11).includes('park')]), '["11",[],false]');
  const t12 = advance(quiet('T-12', 'AUTOPILOT_STAGE: 3/9 implement'));
  t('the stall killer still parks a quiet ticket with no DONE', j([t12.find((a) => a.type === 'kill')?.pid, /^wedged — no output for 6 passes/.test(t12.find((a) => a.type === 'park')?.question)]), '[77,true]');
  const suite = advance(quiet('T-13', 'AUTOPILOT_STAGE: 4/9 verify'), { 'suite-wait': 'suite' });
  t('a quiet worker running its suite under the test lock is quiet, not wedged',
    j([types(suite).includes('park'), sets(suite), lines(suite, 'quiet')]), j([false, ['idle_passes=6', `suite_wait_since=${NOW}`], ['T-13: quiet for 6 passes, running its suite']]));
}

// How an exited worker with no marker ended.
{
  const dead = (key, extra = {}, mtimeMs = NOW - HOUR) => snap(ticket(key, extra), logOf(key, '', [said('working')], { mtimeMs }));
  t('a worker killed while the computer stayed up is queued to resume',
    j(sets(advance(dead('K-1'))).filter((f) => !LIVENESS.test(f))), j(['state=triaged', 'resume=pending', 'resume_why=its process died while the computer stayed up']));
  t('one whose last log write came before the restart was killed by it',
    sets(advance(dead('K-2', {}, NOW - 48 * HOUR))).includes(`resume_why=${REBOOT}`), true);
  t('one whose log was written in the last 2 minutes is left running, not resumed',
    j(lines(advance(dead('K-3', {}, NOW - 30_000)), 'quiet')), j(['K-3: not in the session registry, but its log was written in the last 2 minutes — left running, checked again next pass']));
  const spent = advance(dead('K-4', { resumes: 2 }));
  t('one resumed as often as §3b allows parks, naming the row', /^killed again .* the most config §3b "Resume a killed worker \(times\)" allows \(2\)/.test(spent.find((a) => a.type === 'park')?.question), true);
  const ended = (key) => snap(ticket(key), logOf(key, '', [said('working'), RESULT]));
  t('a worker that ended normally with an open PR and no marker is done on that PR',
    j(advance(ended('N-1'), { 'open-pr': '31' }).find((a) => a.type === 'done')?.pr), '"31"');
  const failed = advance(ended('N-2'), { 'exit-code': 1 }).find((a) => a.type === 'fail');
  t('with no PR either it is failed, naming its exit', j([failed?.why.startsWith('exited with no marker and no open PR on fix/N-2'), failed?.why.includes('exit code 1'), failed?.tail]), j([true, true, ' — check /state/logs/N-2.log']));
  const held = advance(snap(ticket('N-3', { fix: { kind: 'instruction' } }), logOf('N-3', '', [said('x'), RESULT])), { 'open-pr': '40' });
  t('a fix holding the merge on an instruction is parked, not done, with no marker', /^its worker ended with no marker, so your instruction on PR #40/.test(held.find((a) => a.type === 'park')?.question), true);
}

// The text a park's write waits on, from the worker's park file: only for the question it parked on.
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { parkApprove } = await import('../desk/bin/batch-state.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'park-approve-'));
  mkdirSync(join(dir, 'parks'));
  const write = (o) => writeFileSync(join(dir, 'parks', 'P-1.json'), JSON.stringify(o));
  write({ question: 'post the comment?', approve: { kind: 'jira-comment', target: 'P-1', body: 'exact\ntext' } });
  t('#775 a park file naming the question parked on gives its text', j(parkApprove(dir, 'P-1', 'post the comment?')), j({ kind: 'jira-comment', target: 'P-1', body: 'exact\ntext' }));
  t('#775 an earlier round\'s file, on another question, gives nothing', parkApprove(dir, 'P-1', 'which colour?'), null);
  write({ question: 'post the comment?' });
  t('#775 a file with no approve gives nothing', parkApprove(dir, 'P-1', 'post the comment?'), null);
  t('#775 no file gives nothing', parkApprove(dir, 'P-2', 'x'), null);
}

// The markers: whichever was written last says how the worker ended.
t('a DONE after a PARK has finished', j(logMarkers('AUTOPILOT_PARK: q\nAUTOPILOT_DONE: pr=1', {})), j({ done: 'pr=1', reboots: 0 }));
t('a PARK after a DONE is a park', j(logMarkers('AUTOPILOT_DONE: pr=1\nAUTOPILOT_PARK: q', {})), j({ park: 'q', reboots: 0 }));
t('a handoff last is a handoff', j(logMarkers('AUTOPILOT_PARK: q\nAUTOPILOT_HANDOFF: 7', {})), j({ handoff: '7', reboots: 0 }));
t('a reboot stop already acted on is spent', j(logMarkers('AUTOPILOT_REBOOT: patch', { reboot_stops: 1 })), j({ reboots: 1 }));
t('a new reboot stop is one', j(logMarkers('AUTOPILOT_REBOOT: patch', {})), j({ reboot: 'patch', reboots: 1 }));

// A park: its links, its clears-when and the register, read in the order the pass makes them.
{
  const Q = 'AUTOPILOT_PARK: which colour?';
  const s = snap(ticket('Q-1'), logOf('Q-1', Q, [said(Q), RESULT]));
  const as = advance(s, { 'settle-links': [{ why: 'no grant', link: null }] });
  t('a park\'s question carries the links not made', as.find((a) => a.type === 'park')?.question, 'which colour?. Issue links not made: no grant');
  t('its reads and writes run in the pass\'s order', j(types(as).slice(types(as).indexOf('worker-head'))),
    '["worker-head","settle-links","park","park-approve","set","live-read","clears-when","register","recommends","set","keep-links","decisions","report"]');
  t('#775 the text a park awaits approval of is read for the question the worker parked on', j(as.find((a) => a.type === 'park-approve')), j({ type: 'park-approve', key: 'Q-1', question: 'which colour?' }));
  t('and it is reported parked', j(lines(as, 'parked')), j(['Q-1: which colour?. Issue links not made: no grant']));
  const off = advance(s, { register: { inputs: {}, status: 'put_off', entry: { at: '2026-11-01T00:00:00Z' } } });
  t('a park the person put off is reported put off', j(lines(off, 'putOff')), j(['Q-1: which colour? (put off on 2026-11-01)']));
  const built = advance(s, { 'build-park': { pr: 9, head: 'abcdef1234567', checks: ['build'], command: 'make' } });
  t('a park waiting only on a §4 Check builds check is recorded done, and the merge question is not read',
    j([built.find((a) => a.type === 'done')?.pr, types(built).includes('merge-park')]), '["9",false]');
  const merged = advance(s, { 'merge-park': { call: 'done', pr: 5, head: 'abcdef1234567', grant: 'config §3 pr-merge is "yes"' } });
  t('a park asking only who merges a green PR desk may merge is recorded done', j(merged.find((a) => a.type === 'done')?.sets.slice(1)), '["follow_on_comment=due"]');
}

// The usage limit, in the advance step and after it.
{
  const reset = Math.floor((NOW + HOUR) / 1000);
  const limited = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: reset } });
  const log = { ...logOf('U-1', '', [said('working')]) };
  log.text += `${limited}\n`;
  log.raw = Buffer.from(log.text);
  const as = advance(snap(ticket('U-1', { log_bytes: log.raw.length, idle_passes: 4 }), log, { sessions: [{ sessionId: 'sid-U-1', pid: 3 }] }));
  t('a worker at the limit is held, and its quiet passes are not a stall', j([as.find((a) => a.type === 'hold')?.limit, sets(as)]), j([{ kind: 'limit', type: 'five_hour', resetsAt: reset, resumed: false }, ['idle_passes=0']]));
  const exited = advance(snap(ticket('U-2', { log_bytes: log.raw.length }), { ...log, path: '/state/logs/U-2.log' }), { lifted: true });
  t('one that exited at the limit, once it lifts, is queued to resume in its own session', sets(exited).includes('resume=usage'), true);
  t('and until it lifts nothing moves it', j(finishes(advance(snap(ticket('U-3', { log_bytes: log.raw.length }), log))).map((a) => a.type)), '["worker-head"]');
}
{
  const repo = { dir: '/home/.claude', name: 'own' };
  const other = { dir: '/home/.claude-work', name: 'work' };
  const limit = { kind: 'limit', type: 'five_hour', resetsAt: null, resumed: false };
  const us = (s, answers) => drive(decideUsageLimit, { tickets: {}, holds: [], stored: null, preLogin: null, repoLogin: repo, now: NOW, ...s }, answers).actions;
  const tickets = { A: { key: 'A', state: 'running' }, B: { key: 'B', state: 'done', usage_paused: { type: 'five_hour' } } };
  const holds = [{ key: 'A', limit, was: null, login: repo }, { key: 'B', limit, was: null, login: repo }];
  const held = us({ tickets, holds });
  t('a held worker no longer running drops its hold and its paused mark', j(held.slice(0, 2)), j([{ type: 'set', key: 'B', fields: ['usage_paused=null'] }, { type: 'keep-holds', keys: ['A'] }]));
  t('one still running is reported paused, and holds the batch while its limit stands',
    j([lines(held, 'paused'), held.at(-1)]), j([['A on the 5-hour usage limit, then it resumes, or sooner once a probe call succeeds'], { type: 'usage-hold', hold: { type: 'five_hour', resetsAt: null, preflight: null, login: repo } }]));
  t('once it lifts it holds nothing', types(us({ tickets, holds }, { lifted: true })).includes('usage-hold'), false);
  t('a hold on another login holds that worker alone, and the probe is not run for it', types(us({ tickets, holds: [{ ...holds[0], login: other }] })).filter((x) => ['lifted', 'usage-hold'].includes(x)).length, 0);
  const stored = { preflight: 'P-1', type: 'seven_day', resets_at: null };
  t('a preflight the limit refused holds the batch, naming it', j(us({ stored, preLogin: repo }).at(-1)?.hold?.preflight), '"P-1"');
  t('and once a probe succeeds, spawns go ahead', j(lines(us({ stored, preLogin: repo }, { lifted: true }))), j(['the weekly usage limit lifted (a probe call succeeded): spawns and resumes go ahead']));
  t('one on another login no longer holds the batch', j(lines(us({ stored, preLogin: other }))), j(['the weekly usage limit on login work no longer holds the batch, as this repo\'s subscription is another: spawns go ahead']));
  const moved = us({ tickets: { M: { key: 'M', state: 'triaged', session_id: 's', login_move: { from: 'work' } }, N: { key: 'N', state: 'parked', login_move: {} } } });
  t('a ticket left waiting to move logins resumes its own session there, and the field goes from every ticket',
    j(moved.filter((a) => a.type === 'set')), j([{ type: 'set', key: 'M', fields: ['login_move=null', 'resume=usage', 'resume_why=was waiting to move off login work, which desk no longer does'] }, { type: 'set', key: 'N', fields: ['login_move=null'] }]));
}

// The runner: an action with no handler is reported, and the decision goes on.
{
  const report = { failed: [] };
  const got = [];
  runSteps({ name: 'x', snapshot: () => ({}), report, handlers: { ask: () => 42, say: (a) => { got.push(a.v); } },
    decide: function* () { const v = yield { type: 'ask' }; yield { type: 'nope', key: 'K' }; yield { type: 'say', v }; } });
  t('a handler\'s answer is what the yield gives back', j(got), '[42]');
  t('an action with no handler is named in the report\'s failed list', j(report.failed), j(['K: the x step has no handler for its "nope" action, so that action was not carried out']));
}

// AC6: the decisions start no process, call no git, gh or Jira, and write nothing, the queue included.
{
  const DONE = 'AUTOPILOT_DONE: pr=12 jira=Done';
  const { out, threw, calls } = withNoIo(() => [
    advance(snap(ticket('D'), logOf('D', DONE, [said(DONE), RESULT]))),
    advance(snap(ticket('Q'), logOf('Q', 'AUTOPILOT_PARK: q', [said('q'), RESULT]))),
    advance(snap(ticket('K'), logOf('K', '', [said('x')]))),
    advance(snap(ticket('W', { idle_passes: 5, log_bytes: 9999 }), logOf('W', '', []), { sessions: [{ sessionId: 'sid-W', pid: 5 }] })),
    drive(decideUsageLimit, { tickets: { A: { key: 'A', state: 'running' } }, holds: [{ key: 'A', limit: { type: 'five_hour', resetsAt: null }, login: { dir: 'd' } }], stored: null, preLogin: null, repoLogin: { dir: 'd' }, now: NOW }).actions,
  ].map(types));
  t('AC6 the decisions return their actions', j(out?.map((x) => x.includes('done') || x.includes('park') || x.includes('set') || x.includes('usage-hold'))), '[true,true,true,true,true]');
  t('AC6 and start no process and write no file on the way', j([threw, calls]), '[null,[]]');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
