// suite: levers trips (a hard trip reverts its lever in that repo within one pass)
// covers: desk/bin/levers-trips.mjs desk/bin/levers-auto.mjs desk/bin/lever-log.mjs desk/bin/levers-evaluate.mjs desk/bin/lever-registry.mjs desk/bin/pass.mjs desk/bin/spawn-worker.sh
// runTrips() runs on synthetic queues, run records, worker logs and post-merge files in a scratch HOME,
// one repo per trip so each starts from an empty lever log.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const T = mkdtempSync(join(tmpdir(), 'levers-trips-'));
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
Object.assign(process.env, { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'none.md') });
mkdirSync(join(T, 'home'), { recursive: true });

const { runTrips, recordWait, stepPattern } = await import('../desk/bin/levers-trips.mjs');
const { append, read } = await import('../desk/bin/lever-log.mjs');
const { assignPin, leverStatesIn } = await import('../desk/bin/levers-auto.mjs');
const { leverOnFor } = await import('../desk/bin/lever-pin.mjs');
const { LEVERS } = await import('../desk/bin/desk-env.mjs');
const { REGISTRY } = await import('../desk/bin/lever-registry.mjs');

const HOUR = 3_600_000;
// The clock is the real one: a worker log is read when written since its ticket's admission, by mtime.
const NOW = Date.now();
const at = (hours) => new Date(NOW + hours * HOUR).toISOString();
const AUTO = Object.fromEntries(LEVERS.map((n) => [n, 'auto']));
const VALUES = { 'worker-location': 'local' };
const stateOf = (slug) => join(T, 'home', '.desk-autopilot', slug);
const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
const eventsOf = (slug, kind) => read(slug).events.filter((e) => !kind || e.kind === kind);

// A repo's batch state folder, with its workers and logs folders.
function repo(slug) {
  const state = stateOf(slug);
  mkdirSync(join(state, 'workers'), { recursive: true });
  mkdirSync(join(state, 'logs'), { recursive: true });
  return state;
}
// A queue ticket drawn `on` for `lever` under the trial `id` (the initial trial by default).
const onTicket = (slug, key, lever, o = {}, id = 'initial') => ({
  key, state: 'pr', ...o,
  levers: { set: [lever], arms: { [lever]: 'on' }, trial_ids: { [lever]: `${slug}/${lever}/${id}` }, fp: {}, block: null, at: at(-100) },
});
const queueOf = (...tickets) => ({ tickets: Object.fromEntries(tickets.map((x) => [x.key, x])) });
const run = (slug, queue, states = AUTO) => runTrips({ slug, name: slug.split('__')[1], state: stateOf(slug), queue, states, now: NOW });
const stateIn = (slug, lever) => leverStatesIn(read(slug).events)[lever].state;
// Worker log lines in claude's stream-json shape.
const init = (session) => ({ type: 'system', subtype: 'init', session_id: session });
const call = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: text }] } });

// ---- AC1, AC8: a skipped preflight's worker refused what the preflight checks ---------------------------
const A1 = 'acme__preflight';
const s1 = repo(A1);
const P1 = onTicket(A1, 'P-1', 'preflight');
writeFileSync(join(s1, 'workers', 'P-1.runs.jsonl'), jsonl([
  { at: at(-50), ticket: 'P-1', preflight: 'skipped', worktree: '/wt/P-1', probes: ['pnpm --version'], jira: true, codex: false },
  { at: at(-50), ticket: 'P-1', session: 's1', stage: '0' },
]));
const log1 = join(s1, 'logs', 'P-1.log');
writeFileSync(log1, jsonl([
  init('s1'),
  call('u1', 'Bash', { command: 'git stash list' }),
  result('u1', 'Permission to use Bash with command git stash list has been denied.'),
  call('u2', 'Bash', { command: 'pnpm test' }),
  result('u2', 'Permission to use Bash with command pnpm test has been denied.'),
]));
const r1 = run(A1, queueOf(P1));
const trip1 = eventsOf(A1, 'trip');
t('AC1 preflight is reverted in that repo', [stateIn(A1, 'preflight'), trip1.map((e) => [e.from, e.to])], ['reverted', [['trial', 'reverted']]]);
t('AC1 the reason names the trip and the ticket', [trip1[0].reason_code, /skipped-preflight-failure on P-1/.test(trip1[0].reason)], ['skipped_preflight_failure', true]);
t('AC1 a denial the preflight does not check is not a trip: the cited line is the pnpm one', trip1[0].evidence_line, 5);
t('AC8 one trip event with actor trip, the ticket, and the record\'s path and line',
  [trip1.length, trip1[0].kind, trip1[0].actor, trip1[0].ticket, trip1[0].evidence_file, trip1[0].evidence_line], [1, 'trip', 'trip', 'P-1', log1, 5]);
t('AC1 the pass line says what tripped', r1.line, 'levers trips: preflight trial → reverted (skipped-preflight-failure on P-1)');
t('the next pass reverts nothing more', [run(A1, queueOf(P1)).events.length, eventsOf(A1, 'trip').length], [0, 1]);
t('a refusal in a start that ran its preflight is not a trip', (() => {
  const A = 'acme__ranpreflight';
  const s = repo(A);
  writeFileSync(join(s, 'workers', 'P-2.runs.jsonl'), jsonl([{ at: at(-50), ticket: 'P-2', session: 's2' }]));
  writeFileSync(join(s, 'logs', 'P-2.log'), jsonl([init('s2'), call('u1', 'Bash', { command: 'pnpm test' }), result('u1', 'Permission to use Bash with command pnpm test has been denied.')]));
  return [run(A, queueOf(onTicket(A, 'P-2', 'preflight'))).events.length, stateIn(A, 'preflight')];
})(), [0, 'trial']);

// ---- AC7: tickets in flight keep their pin; new tickets get the lever off --------------------------------
t('AC7 the ticket admitted before the trip still runs with its pinned set', leverOnFor('preflight', P1, { on: [] }), true);
const after = assignPin('P-9', { slug: A1, states: AUTO, frozen: false, values: VALUES, now: new Date(NOW) });
t('AC7 a ticket admitted after the trip gets preflight off and no arm for it', [after.assigned, after.pin.set.includes('preflight'), 'preflight' in after.pin.arms], [true, false, false]);

// ---- AC6: the trip leaves the lever as it was in every other repo ----------------------------------------
const A6 = 'acme__elsewhere';
const other = assignPin('O-1', { slug: A6, states: AUTO, frozen: false, values: VALUES, now: new Date(NOW) });
t('AC6 another repo still has preflight on trial and draws an arm for it', [stateIn(A6, 'preflight'), ['on', 'off'].includes(other.pin.arms.preflight)], ['trial', true]);

// ---- AC2: a failure-class wait outlasts its settled blocker by 48 hours --------------------------------
const A2 = 'acme__stale';
const s2 = repo(A2);
const wait = { class: 'dependency wait', waiting: 'waiting for B-1 to merge', blockers: ['B-1'], pr: 5, head: 'abc' };
recordWait(s2, 'F-1', wait, at(-80));
recordWait(s2, 'F-1', wait, at(-70));
t('a wait is recorded once per head and class however many passes hold it', readFileSync(join(s2, 'workers', 'F-1.runs.jsonl'), 'utf8').trim().split('\n').length, 1);
const blocker = (hours) => ({ key: 'B-1', state: 'done', merged_at: at(hours) });
const F1 = onTicket(A2, 'F-1', 'failure-class', { held_by: 'B-1' });
t('a blocker settled 30 hours ago is not yet a trip', [run(A2, queueOf(F1, blocker(-30))).events.length, stateIn(A2, 'failure-class')], [0, 'trial']);
run(A2, queueOf(F1, blocker(-49)));
const trip2 = eventsOf(A2, 'trip');
t('AC2 failure-class is reverted once the wait outlasts its settled blocker by 48 hours', [stateIn(A2, 'failure-class'), trip2.map((e) => [e.reason_code, e.ticket, e.evidence_line])], ['reverted', [['stale_wait', 'F-1', 1]]]);
t('a fix try after the wait ended it', (() => {
  const A = 'acme__tried';
  const s = repo(A);
  recordWait(s, 'F-2', wait, at(-80));
  return run(A, queueOf(onTicket(A, 'F-2', 'failure-class', { fix_tries: [{ try: 1, at: at(-60) }] }), blocker(-70))).events.length;
})(), 0);
t('a missing decision settles when the person answers', (() => {
  const A = 'acme__answered';
  const s = repo(A);
  recordWait(s, 'F-3', { class: 'missing decision', waiting: 'waiting for a person\'s call on what it quotes', blockers: [], pr: 6, head: 'def' }, at(-80));
  mkdirSync(join(s, 'answers'), { recursive: true });
  writeFileSync(join(s, 'answers', 'F-3.txt'), 'use the first option');
  utimesSync(join(s, 'answers', 'F-3.txt'), new Date(NOW - 50 * HOUR), new Date(NOW - 50 * HOUR));
  run(A, queueOf(onTicket(A, 'F-3', 'failure-class')));
  return eventsOf(A, 'trip').map((e) => e.reason_code);
})(), ['stale_wait']);

// ---- AC3: a post-merge revert on the lever's arm ----------------------------------------------------------
const A3 = 'acme__reverted';
const s3 = repo(A3);
writeFileSync(join(s3, 'post-merge.jsonl'), jsonl([
  { kind: 'scan', at: at(-30), complete: true },
  { kind: 'revert', ticket: 'M-0', pr: 8, commit: 'c'.repeat(40), at: at(-29) },
  { kind: 'revert', ticket: 'M-1', pr: 9, commit: 'd'.repeat(40), at: at(-28) },
]));
const offArm = { ...onTicket(A3, 'M-0', 'memory'), levers: { set: [], arms: { memory: 'off' }, trial_ids: { memory: `${A3}/memory/initial` }, fp: {}, block: null, at: at(-100) } };
run(A3, queueOf(offArm, onTicket(A3, 'M-1', 'memory', { state: 'done', merged_at: at(-40) })));
t('AC3 memory is reverted on the revert of a ticket on its arm, not the off arm\'s', [stateIn(A3, 'memory'), eventsOf(A3, 'trip').map((e) => [e.reason_code, e.ticket, e.evidence_line])], ['reverted', [['post_merge_revert', 'M-1', 3]]]);

// ---- AC4: the lever's own step exited non-zero on an on-arm start ------------------------------------------
const A4 = 'acme__steperror';
const s4 = repo(A4);
writeFileSync(join(s4, 'workers', 'W-1.runs.jsonl'), jsonl([{ at: at(-50), ticket: 'W-1', session: 's4' }]));
writeFileSync(join(s4, 'logs', 'W-1.log'), jsonl([
  init('s4'),
  call('u1', 'Bash', { command: 'desk-env lines src/a.ts 1,20' }),
  result('u1', 'Exit code 3\nno such file: src/a.ts'),
]));
run(A4, queueOf(onTicket(A4, 'W-1', 'wrappers')));
const needs4 = eventsOf(A4, 'needs_you');
t('AC4 wrappers is reverted on its own step\'s non-zero exit', [stateIn(A4, 'wrappers'), eventsOf(A4, 'trip').map((e) => [e.reason_code, e.error])], ['reverted', [['own_step_error', 'desk-env lines exited 3: no such file: src/a.ts']]]);
t('AC4 one needs-you item names the error', [needs4.length, needs4[0]?.reason_code, /desk-env lines exited 3/.test(needs4[0]?.reason)], [1, 'own_step_error', true]);
const A4b = 'acme__recordedstep';
const s4b = repo(A4b);
const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../desk/bin/levers-trips.mjs', import.meta.url)), 'record-step', '--state', s4b, '--ticket', 'D-1', '--lever', 'memory', '--step', 'memory-digest.mjs', '--exit', '1', '--session', 's9'], { encoding: 'utf8' });
run(A4b, queueOf(onTicket(A4b, 'D-1', 'memory')));
t('AC4 a step error the spawn recorded in the run record trips too', [cli.status, stateIn(A4b, 'memory'), eventsOf(A4b, 'trip')[0]?.error], [0, 'reverted', 'memory-digest.mjs exited 1']);
t('the codex step is matched as a worker calls it', [stepPattern('desk-codex').test('node ~/.claude/desk/bin/desk-codex.mjs probe'), stepPattern('desk-codex').test('desk-codex finder x'), stepPattern('the preflight')], [true, true, null]);

// ---- AC5: a second revert freezes the lever and raises one needs-you item -------------------------------------
const A5 = 'acme__second';
const s5 = repo(A5);
append(A5, { kind: 'transition', lever: 'memory', from: 'trial', to: 'reverted', actor: 'levers-auto', reason_code: 'guardrail_ci_reds', reason: 'CI reds rose', eval_id: 'evl_x', evidence_file: 'levers-evidence/evl_x.jsonl', at: at(-300) });
const back = append(A5, { kind: 'override', lever: 'memory', from: 'reverted', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'trying it again', at: at(-200) });
writeFileSync(join(s5, 'post-merge.jsonl'), jsonl([{ kind: 'revert', ticket: 'M-5', pr: 11, commit: 'e'.repeat(40), at: at(-10) }]));
t('a ticket from the trial before the revert does not trip the trial running now', run(A5, queueOf(onTicket(A5, 'M-5', 'memory'))).events.length, 0);
run(A5, queueOf(onTicket(A5, 'M-5', 'memory', {}, back.id)));
const needs5 = eventsOf(A5, 'needs_you');
t('AC5 the second revert freezes memory in that repo', [stateIn(A5, 'memory'), eventsOf(A5, 'trip').map((e) => [e.from, e.to])], ['frozen', [['trial', 'frozen']]]);
t('AC5 one needs-you item names the lever and the repo', [needs5.length, needs5[0]?.reason_code, needs5[0]?.lever, /memory is frozen in second/.test(needs5[0]?.reason)], [1, 'frozen_second_revert', 'memory', true]);

// ---- what a trip leaves alone ------------------------------------------------------------------------------------
const A9 = 'acme__pinned';
const s9 = repo(A9);
writeFileSync(join(s9, 'post-merge.jsonl'), jsonl([{ kind: 'revert', ticket: 'M-9', pr: 12, at: at(-10) }]));
t('a lever the row pins is not the controller\'s to revert', run(A9, queueOf(onTicket(A9, 'M-9', 'memory')), { ...AUTO, memory: 'pinned' }).events.length, 0);
t('a repo with no auto in its row runs no trips', run(A9, queueOf(onTicket(A9, 'M-9', 'memory')), Object.fromEntries(LEVERS.map((n) => [n, 'off']))).line, null);
t('every registered trip has a detector', Object.values(REGISTRY).flatMap((l) => l.trips.map((x) => x.id)).filter((id) => !['skipped-preflight-failure', 'stale-wait', 'post-merge-revert', 'own-step-error'].includes(id)), []);
t('a trip event missing its record\'s line is refused', (() => { try { append(A9, { kind: 'trip', lever: 'memory', from: 'trial', to: 'reverted', actor: 'trip', reason_code: 'post_merge_revert', reason: 'x', ticket: 'M-9', evidence_file: 'f' }); return 'appended'; } catch (e) { return /evidence_line/.test(e.message); } })(), true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
