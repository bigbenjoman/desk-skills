// The levers controller's blind audit: a quality-risk lever changes the very review that counts P0
// and P1 findings, so a sample of each trial's merged PRs is reviewed again after merge by a worker that
// runs with every lever off and is told nothing of the lever or the arm. It is the one quality signal
// the lever under test cannot touch.
//
// The sample: for each quality-risk lever on trial in a repo whose levers row leaves it to `auto`, the
// merged tickets drawn `on` or `off` under that trial, each arm in merge order. Every 5th of an arm is
// audited (the 5th, 10th, ...), and only as many per arm as the arm with fewer merges has reached, so
// the arms stay balanced. A ticket is audited once, whichever trials sampled it.
//
// Each sampled ticket is an item in <repo state>/audit-queue.json; one audit runs at a time per repo,
// spawned by the pass (pass.mjs) as worker `audit.<TICKET>` in a worktree detached at the merge commit,
// with DESK_LEVERS `none`, on the trial's audit model: the repo's review model when the trial's first
// item was queued (or the `audit_model` its starting event names), kept in the queue file's `trials`
// for the trial's life. An audit due while usage pacing holds spawns waits, as does one due once this
// week's audits (Monday 00:00 UTC on) have spent BUDGET_SHARE of the repo's measured weekly ticket
// spend; each deferral is one `audit_deferred` event in the lever log, reason `window_tight` or
// `weekly_cap`, once per item and reason (and week, for the cap).
//
// An audit that ended is one line in <repo state>/audit.jsonl, in the findings format (reviewer
// `audit`) plus the ticket, PR, merge commit, lever, arm, every quality-risk arm the ticket drew, model,
// `usd` and `duration_s`, and one `audit` event in the lever log citing that line. A P0 on a ticket
// drawn `on` for a lever reverts that lever in the repo as a hard trip (a `trip` event, trip
// `audit-p0`; frozen on a second revert) and raises one needs_you event naming the defect. An audit
// writes nothing to the tracker.
//
//   import { runAudits, sampleAudits, auditTask, auditBrief } from './levers-audit.mjs'
import { mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { batchPaths, workerModels } from './desk-env.mjs';
import { REGISTRY } from './lever-registry.mjs';
import { appendWith, read } from './lever-log.mjs';
import { leverStatesIn, trialId } from './levers-auto.mjs';
import { priorRevertsOf, revertTarget, frozenText } from './levers-evaluate.mjs';
import { REVERTIBLE, ACTOR as TRIP_ACTOR } from './levers-trips.mjs';
import { reviewRounds } from './findings.mjs';
import { readLog, readLogFile } from './harvest.mjs';
import { logUsage, ticketCost } from './worker-cost.mjs';
import { usagePace } from './usage-pace.mjs';
import { readQueue } from './batch-state.mjs';
import { allBatches } from './phase0-report.mjs';
import { withDirLock, writeJsonAtomic } from './dir-lock.mjs';

export const ACTOR = 'audit';
export const EVERY = 5;
export const BUDGET_SHARE = 0.05;
export const TRIP = 'audit-p0';
// A spawn that fails this many times is left failed rather than tried every pass.
export const SPAWN_TRIES = 3;
// A spawn a crashed pass left part way is tried again after this long.
const STARTING_MS = 3_600_000;
const DAY_MS = 86_400_000;
// The marker the audit worker prints once per P0 it confirms.
const P0_MARK = /^[\s`>*-]*AUDIT_P0:[ \t]*(.+?)[\s`]*$/gm;

export const auditFile = (slug) => join(batchPaths(slug).state, 'audit.jsonl');
export const auditQueueFile = (slug) => join(batchPaths(slug).state, 'audit-queue.json');
export const auditKey = (ticket) => `audit.${ticket}`;

// The Monday 00:00 UTC on or before `now`, as ms.
export function weekStart(now) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

// Each line of a jsonl file that parses, with its 1-based line number.
function rowsOf(file) {
  let body = '';
  try { body = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  body.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try { const row = JSON.parse(raw); if (row && typeof row === 'object') out.push({ line: i + 1, row }); } catch { /* not a row */ }
  });
  return out;
}

const mergedPr = (t) => {
  const pr = Number(t?.pr_status?.pr ?? t?.result?.pr);
  return Number.isInteger(pr) && pr > 0 && Number.isFinite(Date.parse(t?.merged_at)) ? pr : null;
};

// The audits each quality-risk trial running in the repo samples, from the repo's lever log `events`
// and its queue tickets (every batch's), oldest merge first:
//   [{ ticket, pr, merged_at, lever, arm, trial_id, arms }]
// `arms` is every quality-risk trial arm the ticket drew. A ticket two trials sample is listed once,
// under the first.
export function sampleAudits({ slug, events, tickets, states, registry = REGISTRY }) {
  const byLever = leverStatesIn(events, registry);
  const merged = tickets.filter((t) => t?.key && mergedPr(t) != null && t.levers && typeof t.levers === 'object');
  const trials = Object.entries(registry).filter(([name, l]) => l.layer === 'quality-risk' && states?.[name] === 'auto' && byLever[name].state === 'trial')
    .map(([name]) => ({ lever: name, id: trialId(slug, name, byLever[name]) }));
  const armsOf = (t) => Object.fromEntries(trials.filter((x) => t.levers.trial_ids?.[x.lever] === x.id && ['on', 'off'].includes(t.levers.arms?.[x.lever]))
    .map((x) => [x.lever, t.levers.arms[x.lever]]));
  const out = [];
  const seen = new Set();
  for (const { lever, id } of trials) {
    const arm = (a) => merged.filter((t) => t.levers.trial_ids?.[lever] === id && t.levers.arms?.[lever] === a)
      .sort((x, y) => Date.parse(x.merged_at) - Date.parse(y.merged_at) || (x.key < y.key ? -1 : 1));
    const on = arm('on');
    const off = arm('off');
    const n = Math.floor(Math.min(on.length, off.length) / EVERY);
    for (const [a, list] of [['on', on], ['off', off]]) {
      for (let k = 1; k <= n; k++) {
        const t = list[k * EVERY - 1];
        if (seen.has(t.key)) continue;
        seen.add(t.key);
        out.push({ ticket: t.key, pr: mergedPr(t), merged_at: t.merged_at, lever, arm: a, trial_id: id, arms: armsOf(t) });
      }
    }
  }
  return out.sort((x, y) => Date.parse(x.merged_at) - Date.parse(y.merged_at));
}

// The prompt the audit worker starts with (spawn-worker.sh's AUTOPILOT_TASK). It names no lever and no
// arm: the review is blind to how the PR was built.
export function auditTask({ pr, sha, repo }) {
  return 'Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET: ' +
    `a review of PR #${pr} in ${repo}, which has merged, at its merge commit ${sha}. Your worktree $WT is checked out at that commit, detached. ` +
    `Your task is that one review and nothing else: run the review desk-env review-cmd prints over ${sha}^1..${sha}, the change the PR merged, and fix nothing. ` +
    'When it ends, print its findings line with verdict.mjs --findings <results> --reviewer audit, then, for each P0 it confirms, one line ' +
    '`AUDIT_P0: <file:line>: <the defect in one sentence>`, each at the start of a line and never in a code fence. ' +
    'Post nothing anywhere: no PR review or comment, no Jira ticket, comment or transition, and no commit or push. ' +
    `End with AUTOPILOT_DONE: pr=${pr} jira=none.`;
}

// The audit worker's briefing. Like the task, it names no lever and no arm.
export function auditBrief({ ticket, pr, sha, repo }) {
  return [
    `## Review of merged PR #${pr}`, '',
    `PR #${pr} in ${repo} (${ticket}) merged at ${sha}. It is one of a sample of merged PRs reviewed again after merge, to measure review quality.`,
    'Review it as you would any PR, at that commit, with the review your config names. How the change was built is left out of this briefing on purpose.', '',
  ].join('\n');
}

// The repo's review model, as config §3b Worker models names it: the high tier, `default` when unset.
export function reviewModel() {
  try {
    const m = workerModels();
    return m.off ? 'default' : m.high ?? m.standard ?? 'default';
  } catch { return 'default'; }
}

// The repo's measured weekly ticket spend: what its tickets merged in the last 28 days cost, over 4.
export function weeklySpend({ slug, now = Date.now(), batches = allBatches(slug) } = {}) {
  let usd = 0;
  for (const b of batches) {
    let q;
    try { q = readQueue(b.queue); } catch { continue; }
    for (const t of Object.values(q?.tickets ?? {})) {
      const m = Date.parse(t?.merged_at);
      if (!Number.isFinite(m) || m < now - 28 * DAY_MS || m > now) continue;
      let c = null;
      try { c = ticketCost(b.state, t); } catch { /* unreadable: not counted */ }
      usd += (c?.usage?.cost ?? 0) + (c?.preflight?.cost ?? 0);
    }
  }
  return usd / 4;
}

// Every queue ticket of the repo's batches, for the sample.
export function repoTickets(slug, batches = allBatches(slug)) {
  return batches.flatMap((b) => {
    try { return Object.entries(readQueue(b.queue)?.tickets ?? {}).map(([key, t]) => ({ ...t, key: t?.key ?? key })); } catch { return []; }
  });
}

// When the audit worker of `item` ended, from the exit file spawn-worker.sh writes: { at } or null.
export function endedFromExit(item) {
  try {
    const e = JSON.parse(readFileSync(join(item.state_dir, 'workers', `${item.key}.exit.json`), 'utf8'));
    return e?.session === item.session ? { at: e.at ?? new Date().toISOString() } : null;
  } catch { return null; }
}
export const logOf = (item) => { try { return readLogFile(join(item.state_dir, 'logs', `${item.key}.log`)); } catch { return ''; } };

// What one ended audit's log shows: its review's counts at the merge commit (the last findings line
// there, or the last at all), its cost, and each P0 it named.
export function readAudit(text, sha) {
  const lines = reviewRounds(text).lines;
  const at = lines.filter((l) => sha && sha.startsWith(l.head));
  const f = at.at(-1) ?? lines.at(-1) ?? null;
  const p0s = [];
  for (const s of readLog(text).said) for (const m of s.matchAll(P0_MARK)) if (!p0s.includes(m[1])) p0s.push(m[1]);
  const u = logUsage(text);
  return { findings: f, usd: u ? Math.round(u.cost * 10000) / 10000 : null, p0s };
}

function loadQueue(file) {
  try {
    const q = JSON.parse(readFileSync(file, 'utf8'));
    return { v: 1, trials: q?.trials ?? {}, items: q?.items ?? {}, spend: q?.spend ?? null };
  } catch { return { v: 1, trials: {}, items: {}, spend: null }; }
}
// Runs `fn(queue)` on the repo's audit queue under its lock and writes it back.
function withQueue(slug, fn) {
  const file = auditQueueFile(slug);
  mkdirSync(dirname(file), { recursive: true });
  return withDirLock(`${file}.lock`, () => {
    const q = loadQueue(file);
    const r = fn(q);
    writeJsonAtomic(file, q);
    return r;
  }, { waitMs: 10_000, pollMs: 20 });
}

// The audit row for an ended item, and its line in audit.jsonl once written.
function recordAudit({ slug, name, item, ended, text, states, now, registry }) {
  const { findings: f, usd, p0s } = readAudit(text, item.sha);
  const at = new Date(Math.max(now, Date.parse(ended.at) || 0)).toISOString();
  const duration = Number.isFinite(Date.parse(item.started_at)) && Number.isFinite(Date.parse(ended.at))
    ? Math.max(0, Math.round((Date.parse(ended.at) - Date.parse(item.started_at)) / 1000)) : null;
  const row = {
    v: 1, at, repo: slug, ticket: item.ticket, pr: item.pr, merge_commit: item.sha, lever: item.lever, arm: item.arm, arms: item.arms,
    trial_id: item.trial_id, model: item.model, reviewer: 'audit',
    round: f?.round ?? null, head: f?.head ?? null, p0: f?.p0 ?? null, p1: f?.p1 ?? null, p2: f?.p2 ?? null, fixed: f?.fixed ?? null,
    carried: f?.carried ?? null, refuter_vendor: f?.refuter_vendor ?? null, ...(f ? {} : { findings_missing: true }),
    usd, duration_s: duration, session: item.session, ended_at: ended.at,
  };
  const file = auditFile(slug);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
  const line = rowsOf(file).findLast((r) => r.row.session === item.session && r.row.ticket === item.ticket)?.line ?? rowsOf(file).length;
  const events = [];
  const add = (e) => { if (e) events.push(e); return e; };
  const counts = f ? `P0 ${f.p0}, P1 ${f.p1}, P2 ${f.p2}` : 'no findings line';
  add(appendWith(slug, () => ({ kind: 'audit', lever: item.lever, actor: ACTOR, reason_code: 'audit_recorded', at, ticket: item.ticket,
    reason: `${item.ticket} (PR #${item.pr}) was audited at ${String(item.sha).slice(0, 12)}: ${counts}`, evidence_file: file, evidence_line: line })));
  if (!(f?.p0 > 0)) return { row, events };
  // A P0 trips every lever the ticket was drawn on for, while it is still in a state a trip reverts.
  const defect = p0s.length ? p0s.join('; ') : `${f.p0} P0 at ${String(item.sha).slice(0, 12)}; the review is in ${join(item.state_dir, 'logs', `${item.key}.log`)}`;
  for (const [lever, a] of Object.entries(item.arms ?? {})) {
    if (a !== 'on' || states?.[lever] !== 'auto') continue;
    const trip = add(appendWith(slug, () => {
      const log = read(slug).events;
      const s = leverStatesIn(log, registry)[lever];
      if (!REVERTIBLE.includes(s?.state)) return null;
      if (log.some((y) => y.kind === 'trip' && y.lever === lever && y.evidence_file === file && y.evidence_line === line)) return null;
      return { kind: 'trip', lever, from: s.state, to: revertTarget(priorRevertsOf(log, lever)), actor: TRIP_ACTOR, reason_code: 'audit_p0', at, trip: TRIP, ticket: item.ticket,
        reason: `${TRIP} on ${item.ticket}: the blind audit of PR #${item.pr} found ${f.p0} P0 (${file}:${line})`, evidence_file: file, evidence_line: line };
    }));
    if (!trip) continue;
    const frozen = trip.to === 'frozen';
    add(appendWith(slug, () => ({ kind: 'needs_you', lever, actor: ACTOR, reason_code: frozen ? 'frozen_second_revert' : 'audit_p0', at, ticket: item.ticket,
      evidence_file: file, evidence_line: line,
      reason: frozen
        ? frozenText(lever, name, `the blind audit of ${item.ticket}, PR #${item.pr}, found a P0: ${defect}`)
        : `${lever} was reverted in ${name}: the blind audit of ${item.ticket}, PR #${item.pr}, found a P0 that merged: ${defect}` })));
  }
  return { row, events };
}

// One pass's audits for repo `slug`: records each audit that ended, queues what the sample adds, and
// starts the oldest item due, or defers it. Every effect outside this module is a dependency, so a
// stub review worker stands in for one in tests:
//   spawn({ key, item, sha, model, task, brief, env }) -> { session, worktree, state } | { error }
//   mergeCommit(item) -> sha | null       ended(item) -> { at } | null     log(item) -> text
//   cleanup(item)                          pace() -> { hold }                 spend({ slug, now }) -> usd
//   room() -> why no worker may start now, or null
//   -> { recorded: [row], deferred: [event], started: [item], failed: [text], events: [event], line }
export async function runAudits({
  slug, name = slug, repo = slug, states, tickets, now = Date.now(), registry = REGISTRY, model = reviewModel,
  spawn, mergeCommit, ended = endedFromExit, log = logOf, cleanup = () => {}, pace = () => usagePace(), spend = weeklySpend, room = () => null,
}) {
  const out = { recorded: [], deferred: [], started: [], failed: [], events: [], line: null };
  if (!Object.values(states ?? {}).includes('auto')) return out;
  // A log that does not parse is the assignment's to report; nothing is sampled on a partial read.
  if (read(slug).bad.length) return out;
  const all = tickets ?? repoTickets(slug);

  // Each running audit that ended is claimed under the queue's lock, so two passes never record one
  // twice, then recorded, and leaves the queue.
  const ending = withQueue(slug, (q) => Object.values(q.items).flatMap((i) => {
    if (i.state !== 'running') return [];
    const e = ended(i);
    if (!e) return [];
    i.state = 'recording';
    return [{ item: { ...i }, e }];
  }));
  for (const { item, e } of ending) {
    const r = recordAudit({ slug, name, item, ended: e, text: log(item), states, now, registry });
    out.recorded.push(r.row);
    out.events.push(...r.events);
    try { cleanup(item); } catch { /* a worktree left behind is not the audit's result */ }
    withQueue(slug, (q) => { delete q.items[item.ticket]; });
  }

  // The sample adds what is newly due; a ticket audited already, or queued, is not added again.
  const audited = new Set(rowsOf(auditFile(slug)).map((r) => r.row.ticket));
  const events = read(slug).events;
  const sample = sampleAudits({ slug, events, tickets: all, states, registry });
  const byLever = leverStatesIn(events, registry);
  const live = new Set(Object.keys(registry).filter((n) => states?.[n] === 'auto' && byLever[n].state === 'trial').map((n) => trialId(slug, n, byLever[n])));
  const next = withQueue(slug, (q) => {
    // An audit not yet started whose trial has ended (adopted, reverted, or left to the row) is dropped.
    for (const [k, i] of Object.entries(q.items)) if (['queued', 'deferred', 'failed'].includes(i.state) && !live.has(i.trial_id)) delete q.items[k];
    for (const s of sample) {
      if (audited.has(s.ticket) || q.items[s.ticket]) continue;
      if (!q.trials[s.trial_id]) {
        const opener = events.find((e) => e.id === s.trial_id.split('/').pop());
        q.trials[s.trial_id] = { model: typeof opener?.audit_model === 'string' ? opener.audit_model : model(), at: new Date(now).toISOString() };
      }
      q.items[s.ticket] = { ...s, key: auditKey(s.ticket), model: q.trials[s.trial_id].model, state: 'queued', queued_at: new Date(now).toISOString(), tries: 0 };
    }
    const items = Object.values(q.items);
    // One audit at a time per repo; a spawn a crashed pass left part way counts as queued again.
    if (items.some((i) => i.state === 'running' || (i.state === 'starting' && now - Date.parse(i.starting_at) < STARTING_MS))) return null;
    const due = items.filter((i) => ['queued', 'deferred', 'starting'].includes(i.state))
      .sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at))[0];
    if (!due) return null;
    // Deferred while usage pacing holds spawns, or once this week's audits have spent their share.
    const week = weekStart(now);
    let reason = null;
    if (pace()?.hold) reason = 'window_tight';
    else {
      const spent = rowsOf(auditFile(slug)).filter((r) => Date.parse(r.row.at) >= week).reduce((n, r) => n + (Number(r.row.usd) || 0), 0);
      // The spend reads every ticket's logs, so it is measured once a day and kept in the queue file.
      const day = new Date(now).toISOString().slice(0, 10);
      if (q.spend?.day !== day || !Number.isFinite(q.spend?.usd)) q.spend = { day, usd: Number(spend({ slug, now })) || 0 };
      const cap = BUDGET_SHARE * q.spend.usd;
      if (spent >= cap) reason = 'weekly_cap';
      due.cap = { spent: Math.round(spent * 100) / 100, cap: Math.round(cap * 100) / 100 };
    }
    if (reason) {
      const key = reason === 'weekly_cap' ? `${reason}|${new Date(week).toISOString().slice(0, 10)}` : reason;
      const fresh = due.deferred?.key !== key;
      due.state = 'deferred';
      due.deferred = { key, reason, at: fresh ? new Date(now).toISOString() : due.deferred.at, ...(reason === 'weekly_cap' ? { until: new Date(week + 7 * DAY_MS).toISOString() } : {}) };
      return { defer: due, fresh };
    }
    // No room for another worker this pass (memory, the machine's or repo's cap): it waits, untried.
    if (room()) return null;
    due.state = 'starting';
    due.starting_at = new Date(now).toISOString();
    return { start: { ...due } };
  });

  if (next?.defer) {
    const d = next.defer;
    if (next.fresh) {
      const e = appendWith(slug, () => ({
        kind: 'audit_deferred', lever: d.lever, actor: ACTOR, reason_code: d.deferred.reason, at: new Date(now).toISOString(), ticket: d.ticket,
        reason: d.deferred.reason === 'window_tight'
          ? `the audit of ${d.ticket} (PR #${d.pr}) waits: usage pacing is holding spawns`
          : `the audit of ${d.ticket} (PR #${d.pr}) waits for the week of ${d.deferred.until.slice(0, 10)}: this week's audits spent $${d.cap.spent} of their $${d.cap.cap}`,
      }));
      if (e) { out.deferred.push(e); out.events.push(e); }
    }
  } else if (next?.start) {
    const item = next.start;
    const fail = (why) => withQueue(slug, (q) => {
      const i = q.items[item.ticket];
      if (!i) return;
      i.tries = (i.tries ?? 0) + 1;
      i.error = String(why).slice(0, 300);
      i.state = i.tries >= SPAWN_TRIES ? 'failed' : 'queued';
      out.failed.push(`${item.ticket} audit not started (try ${i.tries} of ${SPAWN_TRIES}): ${i.error}`);
    });
    let sha = null;
    try { sha = await mergeCommit(item); } catch { sha = null; }
    if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) fail(`the merge commit of PR #${item.pr} could not be read`);
    else {
      const ctx = { ticket: item.ticket, pr: item.pr, sha, repo };
      let s;
      try { s = await spawn({ key: item.key, item, sha, model: item.model, task: auditTask(ctx), brief: auditBrief(ctx), env: { DESK_LEVERS: 'none' } }); } catch (e) { s = { error: e?.message ?? String(e) }; }
      if (!s || s.error || !s.session) fail(s?.error ?? 'the spawn returned no session');
      else {
        const started = withQueue(slug, (q) => {
          const i = q.items[item.ticket];
          if (!i) return null;
          Object.assign(i, { state: 'running', sha, session: s.session, worktree: s.worktree ?? null, state_dir: s.state ?? null, started_at: new Date(now).toISOString() });
          return { ...i };
        });
        if (started) out.started.push(started);
      }
    }
  }
  const parts = [
    ...out.recorded.map((r) => `${r.ticket} audited (${r.p0 == null ? 'no findings line' : `P0 ${r.p0}, P1 ${r.p1}`}${r.usd == null ? '' : `, $${r.usd.toFixed(2)}`})`),
    ...out.events.filter((e) => e.kind === 'trip').map((e) => `${e.lever} ${e.from} → ${e.to} (${TRIP} on ${e.ticket})`),
    ...out.deferred.map((e) => `${e.ticket} deferred (${e.reason_code})`),
    ...out.started.map((i) => `${i.ticket} audit started at ${i.sha.slice(0, 12)}`),
    ...out.failed,
  ];
  out.line = parts.length ? `levers audits: ${parts.join(', ')}` : null;
  return out;
}
