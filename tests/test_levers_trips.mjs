// suite: levers trips (a hard trip reverts its lever in that repo within one pass)
// layer: L2
// covers: desk/bin/levers-trips.mjs desk/bin/log-tool-calls.mjs desk/bin/levers-auto.mjs desk/bin/lever-log.mjs desk/bin/levers-evaluate.mjs desk/bin/lever-registry.mjs desk/bin/pass.mjs desk/bin/spawn-worker.sh
// runTrips() runs on synthetic queues, run records, worker logs and post-merge files in a scratch HOME,
// one repo per trip so each starts from an empty lever log.
import { mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const T = scratch('levers-trips-');
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
  call('u2', 'Bash', { command: 'pnpm dlx prettier --check .' }),
  result('u2', 'Permission to use Bash with command pnpm dlx prettier --check . has been denied.'),
  call('u3', 'Bash', { command: 'pnpm test' }),
  result('u3', 'Exit code 127\n(eval):1: command not found: pnpm'),
]));
const P1before = JSON.stringify(P1);
const r1 = run(A1, queueOf(P1));
const trip1 = eventsOf(A1, 'trip');
t('AC1 preflight is reverted in that repo', [stateIn(A1, 'preflight'), trip1.map((e) => [e.from, e.to])], ['reverted', [['trial', 'reverted']]]);
t('AC1 the reason names the trip and the ticket', [trip1[0].reason_code, /skipped-preflight-failure on P-1/.test(trip1[0].reason)], ['skipped_preflight_failure', true]);
t('AC1 denials the preflight does not check (git stash, a pnpm subcommand the settings refuse) are not a trip: the cited line is the missing pnpm', trip1[0].evidence_line, 7);
t('AC8 one trip event with actor trip, the ticket, and the record\'s path and line',
  [trip1.length, trip1[0].kind, trip1[0].actor, trip1[0].ticket, trip1[0].evidence_file, trip1[0].evidence_line], [1, 'trip', 'trip', 'P-1', log1, 7]);
t('AC1 a refusal of the probe command itself trips', (() => {
  const A = 'acme__probe';
  const s = repo(A);
  writeFileSync(join(s, 'workers', 'P-3.runs.jsonl'), jsonl([
    { at: at(-50), ticket: 'P-3', preflight: 'skipped', worktree: '/wt/P-3', probes: ['pnpm --version'], jira: false, codex: true },
    { at: at(-50), ticket: 'P-3', session: 's3' },
  ]));
  writeFileSync(join(s, 'logs', 'P-3.log'), jsonl([
    init('s3'),
    call('u1', 'Bash', { command: 'codex exec -m o3 hi' }),
    result('u1', 'Permission to use Bash with command codex exec -m o3 hi has been denied.'),
    call('u3', 'Bash', { command: 'pnpm install && jq . package.json' }),
    result('u3', 'Exit code 127\nzsh:1: command not found: jq'),
    call('u2', 'Bash', { command: 'pnpm  --version' }),
    result('u2', 'Permission to use Bash with command pnpm --version has been denied.'),
  ]));
  run(A, queueOf(onTicket(A, 'P-3', 'preflight')));
  return eventsOf(A, 'trip').map((e) => e.evidence_line);
})(), [7]);
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
t('AC7 the trip leaves the ticket admitted before it as it was, and it still runs with its pinned set', [JSON.stringify(P1) === P1before, stateIn(A1, 'preflight'), leverOnFor('preflight', P1, { on: [] })], [true, 'reverted', true]);
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
// A wait is held on a done ticket's open PR, as the pass's fix tries hold one.
const waiting = (o = {}) => ({ state: 'done', result: { pr: 5 }, ...o });
const F1 = onTicket(A2, 'F-1', 'failure-class', waiting({ held_by: 'B-1' }));
t('a blocker settled 30 hours ago is not yet a trip', [run(A2, queueOf(F1, blocker(-30))).events.length, stateIn(A2, 'failure-class')], [0, 'trial']);
run(A2, queueOf(F1, blocker(-49)));
const trip2 = eventsOf(A2, 'trip');
t('AC2 failure-class is reverted once the wait outlasts its settled blocker by 48 hours', [stateIn(A2, 'failure-class'), trip2.map((e) => [e.reason_code, e.ticket, e.evidence_line])], ['reverted', [['stale_wait', 'F-1', 1]]]);
t('a fix try after the wait ended it', (() => {
  const A = 'acme__tried';
  const s = repo(A);
  recordWait(s, 'F-2', wait, at(-80));
  return run(A, queueOf(onTicket(A, 'F-2', 'failure-class', waiting({ held_by: 'B-1', fix_tries: [{ try: 1, at: at(-60) }] })), blocker(-70))).events.length;
})(), 0);
t('a ticket released from its merged blocker is no longer waiting', (() => {
  const A = 'acme__released';
  const s = repo(A);
  recordWait(s, 'F-4', wait, at(-80));
  return run(A, queueOf(onTicket(A, 'F-4', 'failure-class', waiting()), blocker(-70))).events.length;
})(), 0);
t('a missing decision settles when the person answers', (() => {
  const A = 'acme__answered';
  const s = repo(A);
  recordWait(s, 'F-3', { class: 'missing decision', waiting: 'waiting for a person\'s call on what it quotes', blockers: [], pr: 6, head: 'def' }, at(-80));
  // With no worker waiting, the answer is saved to the briefing alone (answer.mjs).
  mkdirSync(join(s, 'briefings'), { recursive: true });
  writeFileSync(join(s, 'briefings', 'F-3.md'), `# Briefing for F-3\n\n## Answer from the user (${at(-50)})\n\nuse the first option\n`);
  run(A, queueOf(onTicket(A, 'F-3', 'failure-class', waiting({ result: { pr: 6 } }))));
  return eventsOf(A, 'trip').map((e) => e.reason_code);
})(), ['stale_wait']);
t('an answer the person wrote 30 hours ago is not yet a trip', (() => {
  const A = 'acme__answeredlate';
  const s = repo(A);
  recordWait(s, 'F-5', { class: 'missing decision', waiting: 'waiting for a person\'s call on what it quotes', blockers: [], pr: 7, head: 'fed' }, at(-80));
  mkdirSync(join(s, 'answers'), { recursive: true });
  writeFileSync(join(s, 'answers', 'F-5.txt'), 'use the first option');
  utimesSync(join(s, 'answers', 'F-5.txt'), new Date(NOW - 30 * HOUR), new Date(NOW - 30 * HOUR));
  return run(A, queueOf(onTicket(A, 'F-5', 'failure-class', waiting({ result: { pr: 7 } })))).events.length;
})(), 0);
t('a waiting ticket whose PR merged waits no more', (() => {
  const A = 'acme__mergedwait';
  const s = repo(A);
  recordWait(s, 'F-6', wait, at(-80));
  return run(A, queueOf(onTicket(A, 'F-6', 'failure-class', waiting({ held_by: 'B-1', merged_at: at(-1) })), blocker(-70))).events.length;
})(), 0);
t('a waiting ticket whose PR closed unmerged waits no more', (() => {
  const A = 'acme__closedwait';
  const s = repo(A);
  recordWait(s, 'F-7', wait, at(-80));
  return run(A, queueOf(onTicket(A, 'F-7', 'failure-class', waiting({ held_by: 'B-1', pr_status: { pr: 5, state: 'CLOSED' } })), blocker(-70))).events.length;
})(), 0);
t('a closed PR still owed its reopen keeps its wait', (() => {
  const A = 'acme__reopenwait';
  const s = repo(A);
  recordWait(s, 'F-8', wait, at(-80));
  return run(A, queueOf(onTicket(A, 'F-8', 'failure-class', waiting({ held_by: 'B-1', reopening: 5, pr_status: { pr: 5, state: 'CLOSED' } })), blocker(-70))).events.length;
})(), 1);
t('a wait held on an earlier PR ends when the ticket has another', (() => {
  const A = 'acme__newpr';
  const s = repo(A);
  recordWait(s, 'F-9', wait, at(-80));
  return run(A, queueOf(onTicket(A, 'F-9', 'failure-class', waiting({ held_by: 'B-1', result: { pr: 9 } })), blocker(-70))).events.length;
})(), 0);

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
t('AC3 one revert trips every lever its ticket was on', (() => {
  const A = 'acme__twolevers';
  const s = repo(A);
  writeFileSync(join(s, 'post-merge.jsonl'), jsonl([{ kind: 'revert', ticket: 'M-2', pr: 10, at: at(-20) }]));
  const two = { key: 'M-2', state: 'done', merged_at: at(-40), levers: { set: ['memory', 'wrappers'], arms: { memory: 'on', wrappers: 'on' }, trial_ids: { memory: `${A}/memory/initial`, wrappers: `${A}/wrappers/initial` }, fp: {}, block: null, at: at(-100) } };
  run(A, queueOf(two));
  return [stateIn(A, 'memory'), stateIn(A, 'wrappers'), eventsOf(A, 'trip').map((e) => [e.lever, e.evidence_line]).sort()];
})(), ['reverted', 'reverted', [['memory', 1], ['wrappers', 1]]]);
t('AC3 a ticket drawn on under the trial its lever was adopted from still trips it', (() => {
  const A = 'acme__adopted';
  const s = repo(A);
  append(A, { kind: 'transition', lever: 'memory', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'every adopt condition held', eval_id: 'evl_y', evidence_file: 'levers-evidence/evl_y.jsonl', at: at(-50) });
  writeFileSync(join(s, 'post-merge.jsonl'), jsonl([{ kind: 'revert', ticket: 'M-3', pr: 13, at: at(-10) }]));
  run(A, queueOf(onTicket(A, 'M-3', 'memory', { state: 'done', merged_at: at(-40) })));
  return [stateIn(A, 'memory'), eventsOf(A, 'trip').map((e) => [e.from, e.to])];
})(), ['reverted', [['adopted', 'reverted']]]);
t('AC3 a revert of a ticket the queue has archived still trips its lever', await (async () => {
  const { attachArchive, archiveDone } = await import('../desk/bin/queue-store.mjs');
  const A = 'acme__archived';
  const s = repo(A);
  writeFileSync(join(s, 'post-merge.jsonl'), jsonl([{ kind: 'revert', ticket: 'M-4', pr: 14, at: at(-10) }]));
  const qf = join(s, 'queue.json');
  const q = queueOf(onTicket(A, 'M-4', 'memory', { state: 'done', merged_at: at(-40), result: { pr: 14 } }));
  const moved = archiveDone(qf, q);
  writeFileSync(qf, JSON.stringify(q));
  run(A, attachArchive(JSON.parse(readFileSync(qf, 'utf8')), qf));
  return [moved, Object.keys(q.tickets), stateIn(A, 'memory'), eventsOf(A, 'trip').map((e) => e.ticket)];
})(), [['M-4'], [], 'reverted', ['M-4']]);

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
t('every registered trip has a detector, or names the module that applies it', Object.values(REGISTRY).flatMap((l) => l.trips.filter((x) => !x.by).map((x) => x.id)).filter((id) => !['skipped-preflight-failure', 'stale-wait', 'post-merge-revert', 'own-step-error', 'codex-dead-seats'].includes(id)), []);

// ---- DS-646 AC8: codex's dead seats above 20% over its last 10 calls revert it ----------------------------------
{
  const ok = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'finding' }] } });
  // A ticket's worker log of desk-codex calls, `exits` each one's exit code.
  const codexLog = (state, key, exits) => writeFileSync(join(state, 'logs', `${key}.log`), jsonl([init(`s-${key}`), ...exits.flatMap((x, i) => {
    const id = `${key}-c${i}`;
    return [call(id, 'Bash', { command: `desk-codex ${i % 2 ? 'refuter' : 'finder'} --cd /wt 'review this'` }), x === 0 ? ok(id) : result(id, `Exit code ${x}\ndesk-codex: timed out after 600s`)];
  })]));
  const trialOf = (slug) => append(slug, { kind: 'override', lever: 'codex', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'trial codex', at: at(-200) });
  const C1 = 'acme__codex';
  const c1 = repo(C1);
  const tr = trialOf(C1);
  // 10 calls over two tickets, 3 dead (124, 75, 124): 30%.
  codexLog(c1, 'C-1', [0, 124, 0, 0, 75]);
  codexLog(c1, 'C-2', [0, 0, 124, 0, 0]);
  const tickets = [onTicket(C1, 'C-1', 'codex', {}, tr.id), onTicket(C1, 'C-2', 'codex', {}, tr.id)];
  tickets[1].levers.at = at(-90);
  const r = run(C1, queueOf(...tickets));
  const trip = eventsOf(C1, 'trip');
  t('AC8 3 of the last 10 codex calls dead: codex is reverted in that repo', [stateIn(C1, 'codex'), trip.map((e) => [e.trip, e.reason_code, e.from, e.to])], ['reverted', [['codex-dead-seats', 'codex_dead_seats', 'trial', 'reverted']]]);
  t('AC8 the trip cites the latest call and says the rate', [trip[0].ticket, trip[0].evidence_line, /3 of its last 10 codex calls died/.test(trip[0].reason), /codex trip/.test(r.line ?? '') || /codex trial → reverted/.test(r.line ?? '')], ['C-2', 11, true, true]);

  const C2 = 'acme__codex_ok';
  const c2 = repo(C2);
  const tr2 = trialOf(C2);
  // 2 dead in the last 10 (20%, not above it); an older dead call has rolled out of the window.
  codexLog(c2, 'D-1', [124, 0, 0, 124, 0, 0]);
  codexLog(c2, 'D-2', [0, 0, 75, 0, 0]);
  const t2 = [onTicket(C2, 'D-1', 'codex', {}, tr2.id), onTicket(C2, 'D-2', 'codex', {}, tr2.id)];
  t2[1].levers.at = at(-90);
  t('AC8 20% dead over the last 10 calls is no trip, and a single dead seat is not its own step failing', [run(C2, queueOf(...t2)).events.length, stateIn(C2, 'codex')], [0, 'trial']);
  const C3 = 'acme__codex_few';
  const c3 = repo(C3);
  const tr3 = trialOf(C3);
  codexLog(c3, 'E-1', [124, 124, 0]);
  t('AC8 fewer than 10 calls: no rate yet', run(C3, queueOf(onTicket(C3, 'E-1', 'codex', {}, tr3.id))).events.length, 0);
  codexLog(c3, 'E-1', [0, 1]);
  run(C3, queueOf(onTicket(C3, 'E-1', 'codex', {}, tr3.id)));
  t('codex exiting with its own error (not a dead seat) is still its own step failing', eventsOf(C3, 'trip').map((e) => e.trip), ['own-step-error']);
}
// A trip read before a levers undo restored the trial, and written after it, is stamped after the
// restore, so the log replays it last and the trial reads reverted.
{
  const { tripEvents } = await import('../desk/bin/levers-trips.mjs');
  const early = new Date(Date.now() - 60_000).toISOString();
  const restoreAt = new Date().toISOString();
  const log = [
    { id: 'o1', at: new Date(Date.now() - 120_000).toISOString(), kind: 'override', lever: 'codex', actor: 'ben', reason_code: 'ben_override', from: 'trial', to: 'off', value: 'off', reason: 'off' },
    { id: 'o2', at: restoreAt, kind: 'override', lever: 'codex', actor: 'ben', reason_code: 'ben_override', from: 'overridden', to: 'trial', restores: { id: null, at: null }, undoes_event: 'o1', reason: 'undo' },
  ];
  // Read on the initial trial (id null), which the undo restores: the trip still lands.
  const x = { lever: 'codex', trip: 'audit-p0', ticket: 'K-1', from: 'trial', from_id: null, file: 'audit.jsonl', line: 1, why: 'a P0', defect: 'a P0' };
  const evs = tripEvents({ events: log, name: 'acme', at: early, x });
  const after = [...log, ...evs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  t('a trip built after a restore is stamped no earlier than it, and the trial reads reverted', [evs.map((e) => e.at >= restoreAt), leverStatesIn(after).codex.state], [[true, true], 'reverted']);
  // A fresh trial levers decide started since the trip was read is another trial: the trip writes nothing.
  const fresh = [log[0], { id: 'o3', at: restoreAt, kind: 'override', lever: 'codex', actor: 'ben', reason_code: 'ben_override', from: 'overridden', to: 'trial', decision_id: 'd3', reason: 'trial' }];
  t('a trip read on one trial writes nothing on a fresh trial started since', tripEvents({ events: fresh, name: 'acme', at: early, x }), []);
}
// An audit-p0 trip and its needs_you are one write to the lever log, so no crash falls between them, and
// a pass replaying the trip writes neither again.
{
  const { applyTrips } = await import('../desk/bin/levers-trips.mjs');
  const { logFile } = await import('../desk/bin/lever-log.mjs');
  const AP = 'acme__auditp0';
  repo(AP);
  append(AP, { kind: 'override', lever: 'codex', from: 'off', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'trial codex', at: at(-300) });
  const x = { lever: 'codex', trip: 'audit-p0', ticket: 'K-2', from: 'trial', file: join(stateOf(AP), 'audit.jsonl'), line: 1, why: 'the blind audit of PR #7 found 1 P0', defect: 'a.mjs:1: x' };
  const before = readFileSync(logFile(AP), 'utf8').split('\n').filter(Boolean).length;
  const first = applyTrips({ slug: AP, name: 'auditp0', trips: [x], now: NOW });
  const lines = readFileSync(logFile(AP), 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l));
  t('AC3 the audit-p0 trip and its needs_you are written together, in one append', [first.map((e) => e.kind), lines.map((e) => e.kind), new Set(lines.map((e) => e.at)).size], [['trip', 'needs_you'], ['trip', 'needs_you'], 1]);
  applyTrips({ slug: AP, name: 'auditp0', trips: [x], now: NOW + HOUR });
  t('AC3 a pass that replays the trip leaves exactly one needs_you for it', [eventsOf(AP, 'trip').length, eventsOf(AP, 'needs_you').filter((e) => e.evidence_file === x.file && e.evidence_line === 1).length], [1, 1]);
}
t('a trip event missing its record\'s line is refused', (() => { try { append(A9, { kind: 'trip', lever: 'memory', from: 'trial', to: 'reverted', actor: 'trip', reason_code: 'post_merge_revert', reason: 'x', ticket: 'M-9', evidence_file: 'f' }); return 'appended'; } catch (e) { return /evidence_line/.test(e.message); } })(), true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
