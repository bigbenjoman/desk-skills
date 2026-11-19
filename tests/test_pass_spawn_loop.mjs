// suite: pass phase: the spawn loop's per-ticket step (skip, record-done, park, hand-away or start)
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideSpawn, whyOf } from '../desk/bin/pass/spawn-loop.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const AT = '2026-11-19T08:00:00.000Z';
const ticket = (key, fields = {}) => ({ key, state: 'triaged', branch: `feat/${key}`, ...fields });
// The loop's state as a candidate's turn comes.
const snap = (tk, { attempts = 0, slots = 2, ...rest } = {}) => ({
  t: tk, at: AT, dry: false, stop: false, attempts, slots,
  rerun: false, resume: false, handoff: false, dbDown: false, dbUp: false, fetchLimit: '60', ...rest,
});
const PICK = { login: { name: 'a' }, vars: {}, row: 'login=null', line: '' };
const SET_UP = { wt: '/wt/A', kept: false, renamed: '', ok: true, exitOk: true, out: '[setup-worktree] worktree=/wt/A\n', retried: '' };
// What each read answers when a case gives nothing: the ticket spawns as nothing holds it.
const READS = {
  'file-budget': false, 'fix-try-stale': false, shipped: null, fresh: true, placement: null, busy: null, 'lock-queue': false,
  'claim-upload': { ok: true, up: null }, 'read-repos': [], login: PICK, setup: SET_UP,
};
const WRITES = ['set', 'report', 'busy-held', 'lock-queue-held', 'take-slot', 'remote-hung', 'db-down', 'skip', 'record-done', 'park', 'hand-away', 'start'];
const handlersFor = (answers = {}, extra = {}) => Object.fromEntries([...Object.keys(READS), ...WRITES].map((type) => [type, (a) => {
  if (extra[type]) extra[type](a);
  const v = Object.hasOwn(answers, type) ? answers[type] : READS[type];
  return typeof v === 'function' ? v(a) : v;
}]));
function step(s, answers) {
  const report = { failed: [] };
  const actions = runSteps({ name: 'spawn loop', snapshot: () => s, decide: decideSpawn, handlers: handlersFor(answers), report });
  return { actions, verdict: actions.at(-1), failed: report.failed };
}
const types = (as) => as.map((a) => a.type);
const lines = (as) => as.filter((a) => a.type === 'report').map((a) => a.line);
const sets = (as) => as.filter((a) => a.type === 'set').flatMap((a) => a.fields);

// The runner over several candidates, as pass.mjs runs it: a slot taken counts at once, a ticket started
// is running for the next candidate's per-file budget (a file `files` gives two tickets has one place),
// and `onStart` stands in for the start's effects.
function loop(cands, { slots = 2, files = {}, answers = {}, per = {}, onStart = () => {} } = {}) {
  const st = { attempts: 0, running: [], stop: false, dbDown: false };
  const atBudget = (key) => (files[key] ?? []).some((f) => st.running.some((k) => (files[k] ?? []).includes(f)));
  const verdicts = [];
  for (const tk of cands) {
    const s = snap(tk, { attempts: st.attempts, slots, stop: st.stop, dbDown: st.dbDown });
    const actions = runSteps({ name: 'spawn loop', snapshot: () => s, decide: decideSpawn,
      handlers: handlersFor({ 'file-budget': (a) => atBudget(a.key), ...answers, ...(per[tk.key] ?? {}) }, { 'take-slot': () => { st.attempts += 1; }, 'db-down': () => { st.dbDown = true; } }),
      report: { failed: [] } });
    const v = actions.at(-1);
    verdicts.push({ key: tk.key, type: v.type, ...(v.stop ? { stop: true } : {}), ...(v.type === 'start' ? { how: v.how } : {}), setup: types(actions).includes('setup') });
    if (v.type === 'skip' && v.stop) break;
    if (v.type === 'start') { st.running.push(tk.key); onStart(st, tk); }
  }
  return { verdicts, attempts: st.attempts };
}
const brief = (vs) => vs.map((v) => `${v.key}:${v.type}${v.stop ? '(stop)' : ''}${v.how ? `(${v.how})` : ''}`).join(' ');

// AC10: every case below runs with process starts and file writes trapped (pass_phase_trap.mjs).
const { threw, calls } = withNoIo(() => {
  // AC1: the first start meets the usage limit; the next candidate is skipped, and the loop ends there.
  {
    const r = loop([ticket('A'), ticket('B'), ticket('C')], { slots: 3, onStart: (st) => { st.stop = true; } });
    t('AC1 after a start meets the usage limit, the next candidate is skipped and the loop stops', brief(r.verdicts), 'A:start(local) B:skip(stop)');
    t('AC1 and no further worker starts that pass', r.verdicts.filter((v) => v.type === 'start').length, 1);
    const { actions } = step(snap(ticket('B'), { stop: true }));
    t('AC1 a stopped loop reads nothing for the candidate', j(types(actions)), j(['skip']));
    t('AC1 with no slot left, the loop stops too', j(step(snap(ticket('B'), { attempts: 2, slots: 2 })).verdict), j({ type: 'skip', key: 'B', stop: true }));
  }

  // AC2: two free slots, three candidates, the first shipped outside its worker.
  {
    const r = loop([ticket('A'), ticket('B'), ticket('C')], { slots: 2, per: { A: { shipped: { pr: 7, branch: 'fix/A-x', mergedAt: AT } } } });
    t('AC2 the first is recorded done, and the second and third start', brief(r.verdicts), 'A:record-done B:start(local) C:start(local)');
    const shippedA = step(snap(ticket('A')), { shipped: { pr: 7, branch: 'fix/A-x', mergedAt: AT } });
    t('AC2 the record-done takes no slot', types(shippedA.actions).includes('take-slot'), false);
    const { verdict } = step(snap(ticket('A')), { shipped: { pr: 7, branch: 'fix/A-x', mergedAt: AT } });
    t('AC2 the record-done says how it shipped', j(verdict), j({ type: 'record-done', key: 'A', how: 'PR #7 merged from fix/A-x', pr: 7, mergedAt: AT, line: 'A: PR #7 merged from fix/A-x, outside its worker: recorded done, no worker spawned' }));
    t('a ticket done in Jira with no PR is recorded done too', step(snap(ticket('A')), { shipped: { jira: true } }).verdict.how, 'done in Jira with no PR');
    const rerun = step(snap(ticket('A'), { rerun: true }), { shipped: () => { throw new Error('read'); } });
    t('a ticket named in AUTOPILOT_RERUN is not read for a PR shipped elsewhere', j([types(rerun.actions).includes('shipped'), rerun.verdict.type]), j([false, 'start']));
  }

  // AC3: the worktree setup failed.
  {
    const failed = { ...SET_UP, ok: false, exitOk: false, out: 'creating the worktree failed\n' };
    const { actions, verdict } = step(snap(ticket('A')), { setup: failed });
    t('AC3 a failed worktree setup parks the candidate', j(verdict), j({ type: 'park', key: 'A', line: 'worktree setup failed, not spawned — creating the worktree failed' }));
    t('AC3 and the park takes a slot', types(actions).includes('take-slot'), true);
    const retried = step(snap(ticket('A')), { setup: { ...failed, retried: 'first try: x; re-fetched origin and retried once: ' } }).verdict.line;
    t('a setup retried once on a stale ref says both tries', retried, 'worktree setup failed, not spawned — first try: x; re-fetched origin and retried once: creating the worktree failed');
    const pg = { ...SET_UP, ok: false, exitOk: false, out: '[setup-worktree] FAIL: cannot reach Postgres in container db-1\n' };
    const down = step(snap(ticket('A')), { setup: pg });
    t('a setup that cannot reach the local database waits, and marks the database down', j([types(down.actions).slice(-3), sets(down.actions)]), j([['db-down', 'report', 'skip'], [`db_wait=${AT}`]]));
    t('the database is marked down with setup\'s words', down.actions.find((a) => a.type === 'db-down').why, 'cannot reach Postgres in container db-1');
    const upNow = step(snap(ticket('A', { db_wait: AT }), { dbUp: true }), { setup: pg }).verdict;
    t('a ticket that waited on a database the health check now finds up parks', j([upNow.type, upNow.line.endsWith('(the local database check passes, so waiting for it will not clear this)')]), j(['park', true]));
    const hung = step(snap(ticket('A')), { setup: { ...SET_UP, ok: false, exitOk: false, out: 'FAIL: git fetch origin did not answer within 60s\n' } });
    t('a setup whose fetch hung marks origin hung and waits', j([types(hung.actions).slice(-3), lines(hung.actions)]), j([['remote-hung', 'report', 'skip'], ['A: held, origin did not answer (git fetch origin did not answer within 60s); it spawns on a pass origin answers']]));
    t('origin found hung before setup waits too', lines(step(snap(ticket('A')), { setup: { wt: '/wt/A', kept: false, renamed: '', hung: 'gh pr list ran past 30s' } }).actions)[0], 'A: held, origin did not answer (gh pr list ran past 30s); it spawns on a pass origin answers');
    const cleared = step(snap(ticket('A', { db_wait: AT })));
    t('a setup that worked clears the ticket\'s database wait and starts it', j([sets(cleared.actions), cleared.verdict.how, cleared.verdict.setup.wt]), j([['db_wait=null'], 'local', '/wt/A']));
    t('whyOf keeps the last three failing lines', whyOf('ok\nFAIL: a\nWARNING: b\nfailed c\ncannot lock ref d\n'), 'WARNING: b failed c cannot lock ref d');
    t('whyOf falls back to the tail', whyOf('nothing matched here'), 'nothing matched here');
  }

  // AC4: a file at its per-file budget once tickets started earlier this pass are counted.
  {
    const files = { A: ['desk/bin/pass.mjs'], B: ['desk/bin/pass.mjs', 'README.md'], C: ['tests/x.sh'] };
    const r = loop([ticket('A'), ticket('B'), ticket('C')], { slots: 3, files });
    t('AC4 a candidate naming a file a ticket started this pass fills is skipped', brief(r.verdicts), 'A:start(local) B:skip C:start(local)');
    const held = step(snap(ticket('B')), { 'file-budget': true });
    t('AC4 a file at its per-file budget holds it, reading nothing more', j(types(held.actions)), j(['file-budget', 'skip']));
    t('a ticket with no file at its budget goes on', step(snap(ticket('B'))).verdict.type, 'start');
  }

  // AC5: the local database was found down earlier this pass.
  {
    const pg = { ...SET_UP, ok: false, exitOk: false, out: 'FAIL: cannot reach Postgres in container db-1\n' };
    const r = loop([ticket('A'), ticket('B')], { slots: 3, per: { A: { setup: pg } } });
    t('AC5 after a setup finds the database down, the next candidate is skipped', brief(r.verdicts), 'A:skip B:skip');
    t('AC5 and no worktree is set up for it', r.verdicts[1].setup, false);
    const { actions } = step(snap(ticket('B'), { dbDown: true }));
    t('AC5 the skip says it waits on the database', lines(actions)[0], 'B: held, the local database is not answering (health); it spawns on the first pass it answers');
    t('a resumed session goes ahead with the database down', step(snap(ticket('B', { resume: 'pending' }), { dbDown: true, resume: true }), { fresh: false }).verdict.how, 'resume');
  }

  // AC6: a triage record placing the code wholly in another repo.
  {
    const p = { ghRepo: 'o/other', why: 'its code is in o/other' };
    const { actions, verdict } = step(snap(ticket('A')), { placement: p });
    t('AC6 the candidate is handed away', j(verdict), j({ type: 'hand-away', key: 'A', placement: p }));
    t('AC6 and takes no slot', types(actions).includes('take-slot'), false);
    const later = step(snap(ticket('A', { result: { pr: 3 } })), { fresh: false, placement: () => { throw new Error('read'); } });
    t('a ticket that does not start fresh is not read for its placement', later.verdict.type, 'start');
    // The fix-try check can finish a fix try, which can make the ticket start fresh, so fresh is read after it.
    const order = types(step(snap(ticket('A'))).actions);
    t('whether it starts fresh is read after the fix-try and shipped checks', j(order.slice(0, 5)), j(['file-budget', 'fix-try-stale', 'shipped', 'fresh', 'placement']));
  }

  // AC7: the upload claim found the last round's upload still running.
  {
    const { actions, verdict } = step(snap(ticket('A')), { 'claim-upload': { ok: true, up: { pr: 41 } } });
    t('AC7 the step skips the candidate', j(verdict), j({ type: 'skip', key: 'A' }));
    t('AC7 with a line saying the worker waits for the upload', lines(actions)[0], 'A: its last round\'s upload to PR #41 is running in the machine\'s upload queue, so its next round\'s worker waits for it to end. The next pass looks again');
    const unread = step(snap(ticket('A')), { 'claim-upload': { ok: false, why: 'EACCES' } });
    t('an upload queue that cannot be read holds it too', lines(unread.actions)[0], 'A: the machine\'s upload queue could not be read to drop its last round\'s upload (EACCES), so no worker was spawned. The next pass looks again');
    const resumed = step(snap(ticket('A', { resume: 'pending' }), { resume: true }), { fresh: false });
    t('a resumed session makes no upload claim', types(resumed.actions).includes('claim-upload'), false);
    t('nor does a cloud ticket', types(step(snap(ticket('A', { location: 'cloud' }))).actions).includes('claim-upload'), false);
  }

  // AC8: a fresh candidate, and a read-only repo that could not be refreshed.
  {
    const bad = [{ repo: 'o/lib', why: 'fetch failed' }];
    const { actions, verdict } = step(snap(ticket('A')), { 'read-repos': bad });
    t('AC8 the candidate is parked', j(verdict), j({ type: 'park', key: 'A', line: 'read-only repo could not be refreshed, so no worker was spawned to read a stale copy — o/lib: fetch failed. Once it is reachable: queue.mjs requeue A' }));
    t('AC8 taking a slot, and its handoff cleared, before the park', j(types(actions).slice(-3)), j(['take-slot', 'set', 'park']));
    t('AC8 the handoff is cleared', j(sets(actions)), j(['handoff=null']));
    const resumed = step(snap(ticket('A', { resume: 'pending' }), { resume: true }), { fresh: false, 'read-repos': bad });
    t('a resumed session waits instead, keeping its session', j([resumed.verdict.type, types(resumed.actions).includes('take-slot'), lines(resumed.actions)[0].endsWith('Its session is kept, and the next pass tries again')]), j(['skip', false, true]));
    t('a cloud ticket does not refresh the read-only repos', types(step(snap(ticket('A', { location: 'cloud' }))).actions).includes('read-repos'), false);
  }

  // The holds that take no slot, and the start of each kind of session.
  {
    t('a fix try that ended with no worker is skipped', j(types(step(snap(ticket('A')), { 'fix-try-stale': true }).actions)), j(['file-budget', 'fix-try-stale', 'skip']));
    const busy = step(snap(ticket('A')), { busy: 'its worktree /wt/A is the working directory of vim' });
    t('a worktree in use is held and recorded on the ticket', j([types(busy.actions), sets(busy.actions)]), j([['file-budget', 'fix-try-stale', 'shipped', 'fresh', 'placement', 'busy', 'busy-held', 'set', 'report', 'skip'],
      [`worktree_busy=${j({ why: 'its worktree /wt/A is the working directory of vim', at: AT })}`]]));
    const same = step(snap(ticket('A', { worktree_busy: { why: 'x', at: 'then' } })), { busy: 'x' });
    t('one held for the same reason is not recorded again', sets(same.actions).length, 0);
    t('a dry run records nothing', sets(step(snap(ticket('A'), { dry: true }), { busy: 'x' }).actions).length, 0);
    t('the test-lock queue holds it without a slot', j(types(step(snap(ticket('A')), { 'lock-queue': true }).actions).slice(-2)), j(['lock-queue-held', 'skip']));
    const noLogin = step(snap(ticket('A')), { login: null });
    t('a new session with no login to start on is skipped without a slot', j([noLogin.verdict.type, types(noLogin.actions).includes('take-slot')]), j(['skip', false]));
    const handoff = step(snap(ticket('A', { handoff: 'pending' }), { handoff: true }), { fresh: false });
    t('a handoff starts on the repo login', j([handoff.verdict.how, handoff.verdict.pick === PICK]), j(['handoff', true]));
    const resume = step(snap(ticket('A', { resume: 'pending' }), { resume: true }), { fresh: false, login: () => { throw new Error('read'); } });
    t('a resume starts on its own login', resume.verdict.how, 'resume');
    t('a cloud ticket starts in the cloud', step(snap(ticket('A', { location: 'cloud' }))).verdict.how, 'cloud');
    t('every start takes a slot first', j(types(step(snap(ticket('A'))).actions).slice(-3)), j(['take-slot', 'setup', 'start']));
  }
});
t('AC10 the step starts no process and writes nothing', j(calls), '[]');
t('AC10 and no case threw', threw, null);

process.exit(fails ? 1 : 0);
