// suite: levers audit (a blind audit sample measures review quality independently of the levers on trial)
// covers: desk/bin/levers-audit.mjs desk/bin/lever-registry.mjs desk/bin/lever-log.mjs desk/bin/levers-auto.mjs desk/bin/desk-env.mjs desk/bin/pass.mjs desk/bin/spawn-worker.sh
// runAudits() runs on synthetic queues and lever logs in a scratch HOME, with a stub review worker:
// its spawn, merge-commit read, end and log are functions the test supplies.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const T = mkdtempSync(join(tmpdir(), 'levers-audit-'));
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
// A desk-jira on PATH that records any call, so AC8 can show the audit never reached the tracker.
const fakeBin = join(T, 'bin');
mkdirSync(fakeBin, { recursive: true });
writeFileSync(join(fakeBin, 'desk-jira'), `#!/bin/sh\necho "$@" >> ${join(T, 'jira-calls')}\n`);
chmodSync(join(fakeBin, 'desk-jira'), 0o755);
Object.assign(process.env, { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'none.md'), PATH: `${fakeBin}:${process.env.PATH}` });
mkdirSync(join(T, 'home'), { recursive: true });

const A = await import('../desk/bin/levers-audit.mjs');
const { append, read } = await import('../desk/bin/lever-log.mjs');
const { leverStatesIn, trialId } = await import('../desk/bin/levers-auto.mjs');
const { LEVERS } = await import('../desk/bin/desk-env.mjs');
const { REGISTRY, REASON_CODES } = await import('../desk/bin/lever-registry.mjs');

const MIN = 60_000;
const DAY = 86_400_000;
// A Wednesday, so a week's start and the next are easy to read.
const NOW = Date.parse('2026-11-18T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const AUTO = Object.fromEntries(LEVERS.map((n) => [n, 'auto']));
const sha = (n) => String(n).padStart(40, 'a').replace(/[^0-9a-f]/g, 'a');
const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');

// A repo whose codex lever is on trial, by hand, a day before NOW.
function repo(slug) {
  const e = append(slug, { kind: 'override', lever: 'codex', from: 'off', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'trial codex', at: iso(NOW - 30 * DAY) });
  return trialId(slug, 'codex', { id: e.id });
}
// `on` and `off` merged tickets drawn under trial `tid`, merged a minute apart, on before off.
function tickets(tid, nOn, nOff, prefix = 'C') {
  const out = [];
  let i = 0;
  for (const [arm, n] of [['on', nOn], ['off', nOff]]) {
    for (let k = 1; k <= n; k++) {
      i++;
      out.push({ key: `${prefix}-${arm}${k}`, state: 'done', result: { pr: 100 + i }, merged_at: iso(NOW - 20 * DAY + i * MIN),
        levers: { set: arm === 'on' ? ['codex'] : [], arms: { codex: arm }, trial_ids: { codex: tid }, fp: {}, block: null, at: iso(NOW - 25 * DAY) } });
    }
  }
  return out;
}
// The stub review worker: a log with the findings line it printed, the P0s it named and its cost.
function workerLog({ head, p0 = 0, p1 = 0, usd = 1.25, defects = [] }) {
  const said = [`AUTOPILOT_FINDINGS: ${JSON.stringify({ round: 1, reviewer: 'audit', head, p0, p1, p2: 0, fixed: 0, carried: false, refuter_vendor: 'claude' })}`,
    ...defects.map((d) => `AUDIT_P0: ${d}`), 'AUTOPILOT_DONE: pr=1 jira=none'];
  return jsonl([
    { type: 'assistant', message: { content: [{ type: 'text', text: said.join('\n') }] } },
    { type: 'result', total_cost_usd: usd, duration_ms: 1000, usage: {} },
  ]);
}
// A pass-by-pass harness around runAudits: every spawn is captured, and an audit ends when the test
// says so, with the log the test gives it.
function harness(slug, all, o = {}) {
  const h = { spawns: [], ended: new Map(), logs: new Map(), cleaned: [], pace: { hold: false }, spendUsd: 1000, model: () => 'opus' };
  h.pass = (now, extra = {}) => A.runAudits({
    slug, name: slug.split('__')[1], repo: `acme/${slug}`, states: o.states ?? AUTO, tickets: all, now,
    model: () => h.model(),
    spawn: async (x) => { h.spawns.push(x); return { session: `s-${x.item.ticket}`, worktree: `/wt/${x.key}`, state: join(T, 'state') }; },
    mergeCommit: async (item) => sha(item.pr),
    ended: (item) => h.ended.get(item.ticket) ?? null,
    log: (item) => h.logs.get(item.ticket) ?? '',
    cleanup: (item) => h.cleaned.push(item.ticket),
    pace: () => h.pace,
    spend: () => h.spendUsd,
    ...extra,
  });
  // Ends the running audit at `at`, its log as given, and runs the next pass.
  h.finish = async (ticket, at, log, now = at) => { h.ended.set(ticket, { at: iso(at) }); h.logs.set(ticket, log); return h.pass(now); };
  return h;
}
const auditRows = (slug) => { try { return readFileSync(A.auditFile(slug), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const queueOf = (slug) => JSON.parse(readFileSync(A.auditQueueFile(slug), 'utf8'));

// ---- AC1: 1 in 5 per arm, balanced -------------------------------------------------------------
const S1 = 'acme__sample';
const tid1 = repo(S1);
const all1 = tickets(tid1, 20, 20);
const sample1 = A.sampleAudits({ slug: S1, events: read(S1).events, tickets: all1, states: AUTO });
t('AC1 20 merged per arm: 4 audited per arm', ['on', 'off'].map((a) => sample1.filter((s) => s.arm === a).length), [4, 4]);
t('AC1 chosen 1 in 5 in merge order: the 5th, 10th, 15th and 20th of each arm',
  sample1.map((s) => s.ticket), ['C-on5', 'C-on10', 'C-on15', 'C-on20', 'C-off5', 'C-off10', 'C-off15', 'C-off20']);
const uneven = A.sampleAudits({ slug: S1, events: read(S1).events, tickets: tickets(tid1, 20, 12, 'U'), states: AUTO });
t('AC1 balanced: an arm with 12 merges holds the other to its 2', ['on', 'off'].map((a) => uneven.filter((s) => s.arm === a).length), [2, 2]);
t('AC1 a lever the row does not leave to auto is not sampled', A.sampleAudits({ slug: S1, events: read(S1).events, tickets: all1, states: { ...AUTO, codex: 'off' } }).length, 0);
t('AC1 a ticket drawn under another trial is not sampled', A.sampleAudits({ slug: S1, events: read(S1).events, tickets: tickets(`${S1}/codex/old`, 20, 20, 'X'), states: AUTO }).length, 0);

// A pass archives every done ticket whose PR merged (queue-store.mjs archiveDone): the sample and the
// weekly spend read those archived tickets as well as the live ones.
{
  const bdir = join(T, 'archived-batch');
  mkdirSync(join(bdir, 'logs'), { recursive: true });
  const [live, ...rest] = tickets(tid1, 5, 5, 'R');
  writeFileSync(join(bdir, 'queue.json'), JSON.stringify({ batch: 'B', tickets: { [live.key]: live } }));
  const recent = rest.at(-1);
  recent.merged_at = iso(NOW - DAY);
  writeFileSync(join(bdir, 'queue.archive.json'), JSON.stringify({ tickets: Object.fromEntries(rest.map((x) => [x.key, x])) }));
  writeFileSync(join(bdir, 'logs', `${recent.key}.log`), workerLog({ head: 'abc', usd: 8 }));
  const batches = [{ queue: join(bdir, 'queue.json'), state: bdir }];
  const got = A.repoTickets(S1, batches);
  t('AC1 archived merged tickets are sampled with the live ones', [got.length, A.sampleAudits({ slug: S1, events: read(S1).events, tickets: got, states: AUTO }).map((s) => s.ticket)], [10, ['R-on5', 'R-off5']]);
  t('AC6 an archived merged ticket counts in the weekly spend', A.weeklySpend({ slug: S1, now: NOW, batches }), 2);
}

// ---- AC2, AC3, AC4, AC9: one audit, start to record ----------------------------------------------
const S2 = 'acme__record';
const tid2 = repo(S2);
const all2 = tickets(tid2, 5, 5);
const h2 = harness(S2, all2);
const p1 = await h2.pass(NOW);
t('AC3 one audit starts at a time, the oldest merge first', [h2.spawns.length, p1.started.map((i) => i.ticket)], [1, ['C-on5']]);
const sp = h2.spawns[0];
t('AC3 it runs at the merge commit, with every lever off, on the trial\'s audit model', [sp.sha, sp.env.DESK_LEVERS, sp.model, sp.key], [sha(105), 'none', 'opus', 'audit.C-on5']);
const words = new RegExp(`\\b(${[...Object.keys(REGISTRY), 'lever', 'levers', 'arm', 'arms', 'trial', 'trials', 'holdback'].join('|')})\\b`, 'i');
t('AC2 the task and the briefing name no lever and no arm', [words.exec(sp.task)?.[0] ?? null, words.exec(sp.brief)?.[0] ?? null], [null, null]);
t('AC2 the task names the PR and its merge commit', [sp.task.includes('PR #105'), sp.task.includes(`${sha(105)}^1..${sha(105)}`), sp.task.includes('--reviewer audit')], [true, true, true]);
const p1b = await h2.pass(NOW + MIN);
t('AC3 nothing else starts while it runs', [h2.spawns.length, p1b.started.length], [1, 0]);
h2.model = () => 'sonnet';
const ENDED = NOW + 10 * MIN;
const p2 = await h2.finish('C-on5', ENDED, workerLog({ head: sha(105), p0: 0, p1: 2, usd: 1.5 }), ENDED + MIN);
const row = auditRows(S2)[0];
t('AC4 one line in the repo\'s audit file: ticket, merge commit, P0, P1, arm', [auditRows(S2).length, row.ticket, row.merge_commit, row.p0, row.p1, row.arm, row.reviewer], [1, 'C-on5', sha(105), 0, 2, 'on', 'audit']);
t('AC4 written after the review ended', Date.parse(row.at) >= ENDED, true);
t('AC9 it holds the audit\'s cost and duration', [row.usd, row.duration_s], [1.5, 600]);
t('AC4 one audit event cites the line', read(S2).events.filter((e) => e.kind === 'audit').map((e) => [e.ticket, e.evidence_file, e.evidence_line]), [['C-on5', A.auditFile(S2), 1]]);
t('AC4 the worktree is cleaned and the next audit starts', [h2.cleaned, p2.started.map((i) => i.ticket)], [['C-on5'], ['C-off5']]);
t('AC3 the audit model stays the trial\'s for its life', h2.spawns[1].model, 'opus');
t('AC1 an audited ticket is never queued again', [Object.keys(queueOf(S2).items), A.sampleAudits({ slug: S2, events: read(S2).events, tickets: all2, states: AUTO }).length], [['C-off5'], 2]);
t('AC4 an off-arm P0 is recorded and trips nothing', await (async () => {
  await h2.finish('C-off5', ENDED + 20 * MIN, workerLog({ head: sha(110), p0: 1 }));
  return [auditRows(S2)[1].p0, auditRows(S2)[1].arm, read(S2).events.filter((e) => e.kind === 'trip').length, leverStatesIn(read(S2).events).codex.state];
})(), [1, 'off', 0, 'trial']);

// ---- AC5, AC10: a tight window defers -------------------------------------------------------------
const S3 = 'acme__tight';
const tid3 = repo(S3);
const h3 = harness(S3, tickets(tid3, 5, 5));
h3.pace = { hold: true };
const d1 = await h3.pass(NOW);
const d2 = await h3.pass(NOW + MIN);
const deferred3 = read(S3).events.filter((e) => e.kind === 'audit_deferred');
t('AC5 with the window tight, the audit is deferred and recorded as deferred', [h3.spawns.length, queueOf(S3).items['C-on5'].state, queueOf(S3).items['C-on5'].deferred.reason], [0, 'deferred', 'window_tight']);
t('AC10 one audit_deferred event, reason window_tight, however many passes it waits', [deferred3.length, deferred3[0].reason_code, deferred3[0].lever, deferred3[0].ticket, d1.deferred.length, d2.deferred.length], [1, 'window_tight', 'codex', 'C-on5', 1, 0]);
h3.pace = { hold: false };
t('AC5 once the window eases it starts', [(await h3.pass(NOW + 2 * MIN)).started.map((i) => i.ticket)], [['C-on5']]);

// ---- AC6, AC10: the weekly cap defers to next week ------------------------------------------------
const S4 = 'acme__cap';
const tid4 = repo(S4);
const h4 = harness(S4, tickets(tid4, 5, 5));
h4.spendUsd = 40; // 5% of it is a $2 week
await h4.pass(NOW);
await h4.finish('C-on5', NOW + 10 * MIN, workerLog({ head: sha(105), usd: 2.5 }));
const capped = queueOf(S4).items['C-off5'];
const deferred4 = read(S4).events.filter((e) => e.kind === 'audit_deferred');
t('AC6 at the weekly audit cap, the next audit is deferred to next week', [h4.spawns.length, capped.state, capped.deferred.reason, capped.deferred.until], [1, 'deferred', 'weekly_cap', '2026-11-23T00:00:00.000Z']);
t('AC10 one audit_deferred event, reason weekly_cap', [deferred4.length, deferred4[0].reason_code], [1, 'weekly_cap']);
await h4.pass(NOW + DAY);
t('AC6 still deferred later the same week, with no second event', [h4.spawns.length, read(S4).events.filter((e) => e.kind === 'audit_deferred').length], [1, 1]);
const nextWeek = await h4.pass(Date.parse('2026-11-23T08:00:00Z'));
t('AC6 the next week it starts', nextWeek.started.map((i) => i.ticket), ['C-off5']);
t('AC6 the cap is 5% of the measured weekly ticket spend', A.BUDGET_SHARE, 0.05);

// ---- AC7, AC8: a P0 on an on-arm PR is a hard trip ------------------------------------------------
const S5 = 'acme__p0';
const tid5 = repo(S5);
const h5 = harness(S5, tickets(tid5, 5, 5));
await h5.pass(NOW);
const defect = 'desk/bin/x.mjs:12: the lock is released before the write it guards';
const tripped = await h5.finish('C-on5', NOW + 10 * MIN, workerLog({ head: sha(105), p0: 1, defects: [defect] }));
const trips = read(S5).events.filter((e) => e.kind === 'trip');
const needs = read(S5).events.filter((e) => e.kind === 'needs_you');
t('AC7 the lever is reverted in the repo as a hard trip', [leverStatesIn(read(S5).events).codex.state, trips.map((e) => [e.lever, e.from, e.to, e.actor, e.trip, e.reason_code, e.ticket])],
  ['reverted', [['codex', 'trial', 'reverted', 'trip', 'audit-p0', 'audit_p0', 'C-on5']]]);
t('AC7 the trip cites the audit line', [trips[0].evidence_file, trips[0].evidence_line], [A.auditFile(S5), 1]);
t('AC7 one needs-you item describes the defect', [needs.length, needs[0].lever, needs[0].reason.includes(defect)], [1, 'codex', true]);
t('AC7 the report line says so', /codex trial → reverted \(audit-p0 on C-on5\)/.test(tripped.line), true);
t('AC7 the registry declares the trip and its reason codes', [REGISTRY.codex.trips.some((x) => x.id === 'audit-p0'), ['audit_p0', 'audit_recorded', 'window_tight', 'weekly_cap'].every((c) => REASON_CODES[c])], [true, true]);
t('AC7 a reverted lever samples no more audits, and its queued ones are dropped', [A.sampleAudits({ slug: S5, events: read(S5).events, tickets: tickets(tid5, 5, 5), states: AUTO }).length, tripped.started.length, Object.keys(queueOf(S5).items)], [0, 0, []]);
t('AC8 no audit wrote to the tracker', existsSync(join(T, 'jira-calls')), false);
t('AC8 the task forbids every tracker write', /no Jira ticket, comment or transition/.test(h5.spawns[0].task) && /jira=none/.test(h5.spawns[0].task), true);

// ---- spawn failures and the row ----------------------------------------------------------------
const S6 = 'acme__fail';
const tid6 = repo(S6);
const h6 = harness(S6, tickets(tid6, 5, 5));
for (let i = 0; i < 4; i++) await h6.pass(NOW + i * MIN, { spawn: async () => ({ error: 'refused' }) });
t('a spawn that fails three times is left failed, not tried every pass', [queueOf(S6).items['C-on5'].state, queueOf(S6).items['C-on5'].tries], ['failed', 3]);
const roomless = harness('acme__room', tickets(repo('acme__room'), 5, 5));
await roomless.pass(NOW, { room: () => 'no room' });
t('no room for a worker: it waits untried', [roomless.spawns.length, queueOf('acme__room').items['C-on5'].state, queueOf('acme__room').items['C-on5'].tries], [0, 'queued', 0]);
t('a repo with no auto in its row runs nothing', (await A.runAudits({ slug: 'acme__none', states: {}, tickets: [] })).line, null);
t('the week starts on Monday 00:00 UTC', iso(A.weekStart(NOW)), '2026-11-16T00:00:00.000Z');

// ---- AC3: the audit key is a ticket id of its own, which spawn-worker.sh runs with every lever off ----
const CFG = join(T, 'config.md');
writeFileSync(CFG, '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n\n## 4. Toolchain\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `DS-[0-9]+` |\n| Other work id patterns | `none` |\n');
const kind = (id) => {
  const r = spawnSync('node', [join(import.meta.dirname, '..', 'desk', 'bin', 'desk-env.mjs'), 'ticket-kind', id], { env: { ...process.env, DESK_CONFIG: CFG, DESK_REPO_OVERRIDE: 'acme/widgets' }, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : `exit ${r.status}`;
};
t('AC3 audit.<key> is kind audit; an audit of an audit, or of no ticket, is refused', [kind('audit.DS-645'), kind('audit.audit.DS-645'), kind('audit.nope')], ['audit', 'exit 2', 'exit 2']);
// spawn-worker.sh exports what lever-pin.mjs env prints as DESK_LEVERS, before anything reads a lever.
const pinEnv = (id) => {
  const r = spawnSync('node', [join(import.meta.dirname, '..', 'desk', 'bin', 'lever-pin.mjs'), 'env', id], { env: { ...process.env, DESK_CONFIG: CFG, DESK_REPO_OVERRIDE: 'acme/widgets', DESK_QUEUE: join(T, 'no-queue.json') }, encoding: 'utf8' });
  return [r.status, r.stdout.trim()];
};
t('AC3 an audit runs with every lever off: its DESK_LEVERS is none; a ticket with no pin reads the row', [pinEnv('audit.DS-645'), pinEnv('DS-645')], [[0, 'none'], [3, '']]);

// ---- review findings: a rebase merge, a recording cut short, a usage limit, preflight spend ----------
t('a rebase merge of several commits is audited whole; a merge or squash from its first parent',
  [A.auditBase({ sha: 'abc', method: 'rebase', commits: 3 }), A.auditBase({ sha: 'abc', method: 'rebase', commits: 1 }), A.auditBase({ sha: 'abc', method: 'squash', commits: 3 }), A.auditBase({ sha: 'abc', method: 'merge', commits: 3 })],
  ['abc~3', 'abc^1', 'abc^1', 'abc^1']);
const S7 = 'acme__rebase';
const h7 = harness(S7, tickets(repo(S7), 5, 5));
await h7.pass(NOW, { mergeMethod: 'rebase', mergeCommit: async (item) => ({ sha: sha(item.pr), commits: 4 }) });
t('the task of a rebase-merged PR reviews all its commits', h7.spawns[0].task.includes(`${sha(105)}~4..${sha(105)}`), true);

const S8 = 'acme__resume';
const h8 = harness(S8, tickets(repo(S8), 5, 5));
await h8.pass(NOW);
h8.ended.set('C-on5', { at: iso(NOW + 10 * MIN) });
const cut = await h8.pass(NOW + 11 * MIN, { log: () => { throw new Error('the lever log is locked'); } });
t('a recording that fails is reported and left for a later pass', [cut.recorded.length, cut.failed.length, queueOf(S8).items['C-on5'].state, h8.cleaned], [0, 1, 'recording', []]);
const soon = await h8.pass(NOW + 12 * MIN);
t('a recording in hand is not claimed again at once', soon.recorded.length, 0);
h8.logs.set('C-on5', workerLog({ head: sha(105), p0: 1, defects: ['a.mjs:1: x'] }));
const resumed = await h8.pass(NOW + 30 * MIN);
t('a later pass finishes it: one row, one audit event, the trip and its needs-you', [resumed.recorded.length, auditRows(S8).length, read(S8).events.filter((e) => e.kind === 'audit').length,
  read(S8).events.filter((e) => e.kind === 'trip').length, read(S8).events.filter((e) => e.kind === 'needs_you').length, h8.cleaned], [1, 1, 1, 1, 1, ['C-on5']]);

const S9 = 'acme__limit';
const h9 = harness(S9, tickets(repo(S9), 5, 5));
for (let i = 0; i < 4; i++) await h9.pass(NOW + i * MIN, { spawn: async () => ({ wait: 'window_tight', why: 'its preflight was refused at the usage limit', preflight_usd: 0.1 }) });
t('a usage-limit refusal spends no try: the audit is deferred for a tight window, recorded once',
  [queueOf(S9).items['C-on5'].state, queueOf(S9).items['C-on5'].tries, read(S9).events.filter((e) => e.kind === 'audit_deferred').map((e) => e.reason_code)], ['deferred', 0, ['window_tight']]);
await h9.pass(NOW + 5 * MIN, { spawn: async () => ({ wait: 'no login', why: 'no login' }) });
t('no login to start on spends no try either', [queueOf(S9).items['C-on5'].state, queueOf(S9).items['C-on5'].tries], ['queued', 0]);

const S10 = 'acme__preflight';
const h10 = harness(S10, tickets(repo(S10), 5, 5));
h10.spendUsd = 40; // a $2 week
await h10.pass(NOW, { spawn: async () => ({ error: 'refused', preflight_usd: 0.5 }) });
const h10spawn = async (x) => { h10.spawns.push(x); return { session: `s-${x.item.ticket}`, worktree: `/wt/${x.key}`, state: join(T, 'state'), preflight_usd: 0.25 }; };
await h10.pass(NOW + MIN, { spawn: h10spawn });
h10.ended.set('C-on5', { at: iso(NOW + 10 * MIN) });
h10.logs.set('C-on5', workerLog({ head: sha(105), usd: 1 }));
await h10.pass(NOW + 10 * MIN, { spawn: async () => ({ error: 'refused', preflight_usd: 0.5 }) });
t('AC9 the audit\'s cost holds its preflights, a failed start\'s too', auditRows(S10)[0].usd, 1.75);
await h10.pass(NOW + 11 * MIN, { spawn: async () => ({ error: 'refused', preflight_usd: 0.5 }) });
t('AC6 a failed start\'s preflight counts against the week: $1.75 + $0.50 reaches the $2 cap', [queueOf(S10).items['C-off5'].state, queueOf(S10).items['C-off5'].deferred?.reason ?? null], ['deferred', 'weekly_cap']);

const S11 = 'acme__model';
const tid11 = repo(S11);
const h11 = harness(S11, tickets(tid11, 3, 3));
await h11.pass(NOW);
h11.model = () => 'sonnet';
t('AC3 the audit model is recorded on the trial when it is first seen running, before any audit is due', [queueOf(S11).trials[tid11]?.model, h11.spawns.length], ['opus', 0]);

// ---- DS-646: a pair trial of two kept quality-risk levers is audited too -----------------------------------------------
{
  const { pairTrial } = await import('../desk/bin/levers-auto.mjs');
  const SP = 'acme__pair';
  for (const [lever, to, days] of [['codex', 'adopted', 60], ['review-reuse', 'settled', 40]]) append(SP, { kind: 'override', lever, to, actor: 'ben', reason_code: 'ben_override', reason: `${lever} ${to}`, at: iso(NOW - days * DAY) });
  const pt = pairTrial({ slug: SP, events: read(SP).events, states: AUTO, values: null, now: NOW });
  const KEY = 'codex+review-reuse';
  const pairTickets = tickets('x', 5, 5, 'P').map((x) => ({ ...x, levers: { ...x.levers, set: x.levers.arms.codex === 'on' ? ['codex', 'review-reuse'] : ['codex'], arms: { [KEY]: x.levers.arms.codex }, trial_ids: { [KEY]: pt.id } } }));
  const s = A.sampleAudits({ slug: SP, events: read(SP).events, tickets: pairTickets, states: AUTO, now: NOW });
  t('the pair trial\'s merged PRs are sampled like a lever\'s, every 5th per arm', s.map((x) => [x.ticket, x.pair, x.lever, x.arm, x.trial_id === pt.id]), [['P-on5', KEY, 'codex', 'on', true], ['P-off5', KEY, 'codex', 'off', true]]);
  const hp = harness(SP, pairTickets);
  await hp.pass(NOW);
  const done = await hp.finish('P-on5', NOW + 10 * MIN, workerLog({ head: sha(105), p0: 1, defects: ['src/a.js:3: drops the error'] }));
  const pe = read(SP).events.filter((e) => e.kind === 'pair');
  t('a P0 on the pair\'s on arm ends the pair trial, the levers kept alone', [pe.map((e) => [e.from, e.to, e.reason_code, e.trial_id === pt.id]), pairTrial({ slug: SP, events: read(SP).events, states: AUTO, values: null, now: NOW + 11 * MIN }).state], [[['trial', 'reverted', 'audit_p0', true]], 'reverted']);
  t('and trips neither lever alone', read(SP).events.filter((e) => e.kind === 'trip').length + (done.events.some((e) => e.kind === 'trip') ? 1 : 0), 0);

  // A P0 recorded while a member of the pair was set off by hand ends the pair trial once an undo
  // restores it, rather than the pair being drawn again under its old trial id.
  const SQ = 'acme__pairoff';
  const kept = ['codex', 'review-reuse'].map((lever, i) => append(SQ, { kind: 'override', lever, to: 'adopted', actor: 'ben', reason_code: 'ben_override', reason: `${lever} adopted`, at: iso(NOW - (60 - i) * DAY) }));
  const qt = pairTrial({ slug: SQ, events: read(SQ).events, states: AUTO, values: null, now: NOW });
  const hq = harness(SQ, pairTickets.map((x) => ({ ...x, levers: { ...x.levers, trial_ids: { [KEY]: qt.id } } })));
  await hq.pass(NOW);
  const off = append(SQ, { kind: 'override', lever: 'codex', to: 'off', value: 'off', actor: 'ben', reason_code: 'ben_override', reason: 'codex off', at: iso(NOW + MIN) });
  await hq.finish('P-on5', NOW + 10 * MIN, workerLog({ head: sha(105), p0: 1, defects: ['src/a.js:3: drops the error'] }));
  t('a P0 while a member is off writes no pair revert: the pair is not running', read(SQ).events.filter((e) => e.kind === 'pair').length, 0);
  append(SQ, { kind: 'override', lever: 'codex', to: 'adopted', actor: 'ben', reason_code: 'ben_override', reason: 'undid codex off', restores: { id: kept[0].id, at: kept[0].at }, undoes_event: off.id, at: iso(NOW + 11 * MIN) });
  t('the undo restores the pair trial id', pairTrial({ slug: SQ, events: read(SQ).events, states: AUTO, values: null, now: NOW + 11 * MIN }).id, qt.id);
  const rq = await hq.pass(NOW + 12 * MIN);
  t('the next pass reverts the restored pair trial for the P0 recorded while it was off', [rq.events.filter((e) => e.kind === 'pair').map((e) => [e.to, e.reason_code, e.trial_id === qt.id]), pairTrial({ slug: SQ, events: read(SQ).events, states: AUTO, values: null, now: NOW + 13 * MIN }).state], [[['reverted', 'audit_p0', true]], 'reverted']);
  t('and a later pass writes it once', (await hq.pass(NOW + 14 * MIN)).events.filter((e) => e.kind === 'pair').length, 0);
}

// The same for a lever on trial alone: its P0 recorded while it was off trips it once an undo restores
// the trial.
{
  const SO = 'acme__trialoff';
  const tr = append(SO, { kind: 'override', lever: 'codex', from: 'off', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'trial codex', at: iso(NOW - 30 * DAY) });
  const ho = harness(SO, tickets(trialId(SO, 'codex', { id: tr.id }), 5, 5));
  await ho.pass(NOW);
  const off = append(SO, { kind: 'override', lever: 'codex', to: 'off', value: 'off', actor: 'ben', reason_code: 'ben_override', reason: 'codex off', at: iso(NOW + MIN) });
  await ho.finish('C-on5', NOW + 10 * MIN, workerLog({ head: sha(105), p0: 1 }));
  t('a P0 while the lever is off trips nothing', read(SO).events.filter((e) => e.kind === 'trip').length, 0);
  append(SO, { kind: 'override', lever: 'codex', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'undid codex off', restores: { id: tr.id, at: tr.at }, undoes_event: off.id, at: iso(NOW + 11 * MIN) });
  const ro = await ho.pass(NOW + 12 * MIN);
  t('the next pass trips the restored trial for it', [ro.events.filter((e) => e.kind === 'trip').map((e) => [e.lever, e.from, e.to, e.trip]), leverStatesIn(read(SO).events).codex.state], [[['codex', 'trial', 'reverted', 'audit-p0']], 'reverted']);
}

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
