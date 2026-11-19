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
// with DESK_LEVERS `none`, on the trial's audit model: the repo's review model at the first pass that
// saw the trial running, kept in the queue file's `trials` for the trial's life. An audit due while
// usage pacing holds spawns, or whose preflight the usage limit refused, waits, as does one due once
// this week's audits (Monday 00:00 UTC on) have spent BUDGET_SHARE of the repo's measured weekly ticket
// spend, preflights included; each deferral is one `audit_deferred` event in the lever log, reason
// `window_tight` or `weekly_cap`, once per item and reason (and week, for the cap).
//
// An audit that ended is one line in <repo state>/audit.jsonl, in the findings format (reviewer
// `audit`) plus the ticket, PR, merge commit, lever, arm, every quality-risk arm the ticket drew, model,
// `usd` (its preflights included) and `duration_s`, and one `audit` event in the lever log citing that
// line. A P0 on a ticket drawn `on` for a lever reverts that lever in the repo as a hard trip through
// levers-trips.mjs applyTrips (a `trip` event, trip `audit-p0`; frozen on a second revert), which
// raises one needs_you event naming the defect. Recording is idempotent, so one a crash cut short is
// finished by a later pass. An audit writes nothing to the tracker, and its worker is denied every
// tracker and PR write (worker-settings.mjs).
//
//   import { runAudits, sampleAudits, auditTask, auditBrief } from './levers-audit.mjs'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { batchPaths, expandHome, workerModels } from './desk-env.mjs';
import { REGISTRY } from './lever-registry.mjs';
import { appendWith, read, stampAfter } from './lever-log.mjs';
import { leverStatesIn, pairTrial, qualityTrials, isPairKey, trialId } from './levers-auto.mjs';
import { REVERTIBLE, applyTrips, tripEvents, lines as rowsOf } from './levers-trips.mjs';
import { reviewRounds } from './findings.mjs';
import { readLog, readLogFile } from './harvest.mjs';
import { logUsage, ticketCost } from './worker-cost.mjs';
import { usagePace } from './usage-pace.mjs';
import { readQueue } from './batch-state.mjs';
import { everyTicket } from './queue-store.mjs';
import { mergedPr } from './post-merge.mjs';
import { allBatches, repoTickets } from './batches.mjs';
import { withDirLock, writeJsonAtomic } from './dir-lock.mjs';

export const ACTOR = 'audit';
export const EVERY = 5;
export const BUDGET_SHARE = 0.05;
export const TRIP = 'audit-p0';
// A spawn that fails this many times is left failed rather than tried every pass.
export const SPAWN_TRIES = 3;
// A spawn a crashed pass left part way is tried again after this long.
const STARTING_MS = 3_600_000;
// A recording a crashed or failed pass left part way is finished by a later pass after this long.
const RECORDING_MS = 600_000;
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


// The audits each quality-risk trial running in the repo samples, from the repo's lever log `events`
// and its queue tickets (every batch's), oldest merge first:
//   [{ ticket, pr, merged_at, lever, arm, trial_id, arms }]
// `arms` is every quality-risk trial arm the ticket drew. A ticket two trials sample is listed once,
// under the first.
// The quality-risk trials running in a repo, a pair trial's included (levers-auto.mjs): each with the key
// its tickets' arms are under, the lever its log events name (a pair's first) and its pair key.
//   -> [{ key, lever, id, pair? }]
export function liveTrials({ slug, events, states, registry = REGISTRY }) {
  return qualityTrials({ slug, events, states, values: null, registry })
    .map((t) => ({ key: t.key, lever: t.levers[0], id: t.id, ...(isPairKey(t.key) ? { pair: t.key } : {}) }));
}

export function sampleAudits({ slug, events, tickets, states, registry = REGISTRY, now = Date.now() }) {
  const merged = tickets.filter((t) => t?.key && mergedPr(t) != null && t.levers && typeof t.levers === 'object');
  const trials = liveTrials({ slug, events, states, registry, now });
  const drawn = (t) => trials.filter((x) => t.levers.trial_ids?.[x.key] === x.id && ['on', 'off'].includes(t.levers.arms?.[x.key]));
  const armsOf = (t) => Object.fromEntries(drawn(t).map((x) => [x.key, t.levers.arms[x.key]]));
  // The trial each of those arms was drawn under, so a P0 trips only that trial and not a fresh one.
  const idsOf = (t) => Object.fromEntries(drawn(t).map((x) => [x.key, x.id]));
  const out = [];
  const seen = new Set();
  for (const { key, lever, id, pair } of trials) {
    const arm = (a) => merged.filter((t) => t.levers.trial_ids?.[key] === id && t.levers.arms?.[key] === a)
      .sort((x, y) => Date.parse(x.merged_at) - Date.parse(y.merged_at) || (x.key < y.key ? -1 : 1));
    const on = arm('on');
    const off = arm('off');
    const n = Math.floor(Math.min(on.length, off.length) / EVERY);
    for (const [a, list] of [['on', on], ['off', off]]) {
      for (let k = 1; k <= n; k++) {
        const t = list[k * EVERY - 1];
        if (seen.has(t.key)) continue;
        seen.add(t.key);
        out.push({ ticket: t.key, pr: mergedPr(t), merged_at: t.merged_at, lever, ...(pair ? { pair } : {}), arm: a, trial_id: id, arms: armsOf(t), trial_ids: idsOf(t) });
      }
    }
  }
  return out.sort((x, y) => Date.parse(x.merged_at) - Date.parse(y.merged_at));
}

// Where the change a PR merged at `sha` starts: its first parent, except a multi-commit PR merged by
// rebase, whose `commits` commits all landed on the base, so it starts that many back.
export function auditBase({ sha, method, commits }) {
  return method === 'rebase' && Number.isInteger(commits) && commits > 1 ? `${sha}~${commits}` : `${sha}^1`;
}

// The prompt the audit worker starts with (spawn-worker.sh's AUTOPILOT_TASK). It names no lever and no
// arm: the review is blind to how the PR was built.
export function auditTask({ pr, sha, base = `${sha}^1`, repo }) {
  return 'Follow the autopilot worker contract in your system prompt exactly. Your ticket is $TICKET: ' +
    `a review of PR #${pr} in ${repo}, which has merged, at its merge commit ${sha}. Your worktree $WT is checked out at that commit, detached. ` +
    `Your task is that one review and nothing else: run the review desk-env review-cmd prints over ${base}..${sha}, the change the PR merged, and fix nothing. ` +
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
    // Archived tickets too: a pass archives every done ticket whose PR merged (queue-store.mjs archiveDone).
    for (const [key, v] of Object.entries(everyTicket(q))) {
      const t = { ...v, key: v?.key ?? key };
      const m = Date.parse(t?.merged_at);
      if (!Number.isFinite(m) || m < now - 28 * DAY_MS || m > now) continue;
      let c = null;
      try { c = ticketCost(b.state, t); } catch { /* unreadable: not counted */ }
      usd += (c?.usage?.cost ?? 0) + (c?.preflight?.cost ?? 0);
    }
  }
  return usd / 4;
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

// Marks queue item `due` deferred for `reason` (`window_tight`, or `weekly_cap` until next week). ->
// { defer: due, fresh }, `fresh` when this deferral is new, so its event is written once.
function deferIn(due, reason, now, why = null) {
  const week = weekStart(now);
  const key = reason === 'weekly_cap' ? `${reason}|${new Date(week).toISOString().slice(0, 10)}` : reason;
  const fresh = due.deferred?.key !== key;
  due.state = 'deferred';
  due.deferred = { key, reason, at: fresh ? new Date(now).toISOString() : due.deferred.at, ...(why ? { why } : {}),
    ...(reason === 'weekly_cap' ? { until: new Date(week + 7 * DAY_MS).toISOString() } : {}) };
  return { defer: due, fresh };
}

// How many of the repo's audit workers are running or part way through starting, for the pass's worker
// counts.
export const auditsRunning = (slug) => Object.values(loadQueue(auditQueueFile(slug)).items).filter((i) => ['running', 'starting'].includes(i.state)).length;

// The repo's audits running, or ended and not yet recorded, whose worker was spawned into state folder
// `state`: its log and exit record are read from there (logOf, endedFromExit), so moving that folder's
// logs and workers away loses the audit's findings. Read without the queue's lock: the file is written
// whole (writeJsonAtomic), and only the pass of the batch in `state` makes an item run there, so a
// caller holding that pass's lock reads a set that can only shrink. A queue file that does not read
// gives null: it cannot show that none is running.
export function auditsIn(slug, state) {
  const file = auditQueueFile(slug);
  if (!existsSync(file)) return [];
  let items;
  try { items = JSON.parse(readFileSync(file, 'utf8'))?.items ?? {}; } catch { return null; }
  const here = resolve(expandHome(state));
  return Object.values(items)
    .filter((i) => ['running', 'recording'].includes(i.state) && typeof i.state_dir === 'string' && resolve(expandHome(i.state_dir)) === here);
}

// What an item's preflights cost: all of them, or those since `from` (ms).
const preflightUsd = (item, from = -Infinity) => (item.preflights ?? []).filter((p) => Date.parse(p.at) >= from).reduce((n, p) => n + (Number(p.usd) || 0), 0);

// The audit row for an ended item, and its line in audit.jsonl once written. Each write is skipped
// where an earlier, interrupted recording of the same session already made it, so recording again
// finishes the job rather than repeating it.
function recordAudit({ slug, name, repo = null, item, ended, text, states, now, registry }) {
  const { findings: f, usd: workerUsd, p0s } = readAudit(text, item.sha);
  const pre = preflightUsd(item);
  const usd = workerUsd == null && !pre ? null : Math.round(((workerUsd ?? 0) + pre) * 10000) / 10000;
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
  const mine = () => rowsOf(file).findLast((r) => r.rec.session === item.session && r.rec.ticket === item.ticket);
  let written = mine();
  if (!written) { appendFileSync(file, `${JSON.stringify(row)}\n`); written = mine(); }
  const line = written?.line ?? rowsOf(file).length;
  const events = [];
  const counts = f ? `P0 ${f.p0}, P1 ${f.p1}, P2 ${f.p2}` : 'no findings line';
  const noted = appendWith(slug, () => (read(slug).events.some((y) => y.kind === 'audit' && y.evidence_file === file && y.evidence_line === line) ? null
    : { kind: 'audit', lever: item.lever, actor: ACTOR, reason_code: 'audit_recorded', at, ticket: item.ticket,
      reason: `${item.ticket} (PR #${item.pr}) was audited at ${String(item.sha).slice(0, 12)}: ${counts}`, evidence_file: file, evidence_line: line }));
  if (noted) events.push(noted);
  if (!(f?.p0 > 0)) return { row: written?.rec ?? row, events };
  // A P0 trips every lever the ticket was drawn on for, while it is still in a state a trip reverts.
  const defect = p0s.length ? p0s.join('; ') : `${f.p0} P0 at ${String(item.sha).slice(0, 12)}; the review is in ${join(item.state_dir, 'logs', `${item.key}.log`)}`;
  // Read under the log's lock, so a levers undo restoring a trial either lands first (and this trips
  // it) or reads the audit row written above (and its replay trips it).
  let byLever = {};
  appendWith(slug, () => { byLever = leverStatesIn(read(slug).events, registry); return null; });
  // A lever on trial trips only while it is the trial the arm was drawn under: a fresh trial levers
  // decide started since is another one, and a trial an undo restored keeps its id. A lever kept since
  // trips as before. An item queued before it carried trial_ids is checked on its own lever's trial_id.
  const drawnUnder = (lever) => item.trial_ids?.[lever] ?? (lever === item.lever && !item.pair ? item.trial_id : null);
  const sameTrial = (lever) => byLever[lever]?.state !== 'trial' || drawnUnder(lever) == null || trialId(slug, lever, byLever[lever]) === drawnUnder(lever);
  const trips = Object.entries(item.arms ?? {})
    .filter(([lever, a]) => a === 'on' && states?.[lever] === 'auto' && REVERTIBLE.includes(byLever[lever]?.state) && sameTrial(lever))
    .map(([lever]) => ({ lever, trip: TRIP, ticket: item.ticket, from: byLever[lever].state, from_id: byLever[lever].id, file, line,
      why: `the blind audit of PR #${item.pr} found ${f.p0} P0`, defect }));
  events.push(...applyTrips({ slug, name, repo, trips, registry, now: Date.parse(at) }));
  // A P0 on a ticket drawn on for a pair trial ends that trial: the levers stay kept alone.
  for (const [key, a] of Object.entries(item.arms ?? {})) {
    if (a !== 'on' || !isPairKey(key)) continue;
    const e = appendWith(slug, () => {
      const evs = read(slug).events;
      const p = pairTrial({ slug, events: evs, states, values: null, registry, now: Date.parse(at) });
      if (p?.key !== key || p.id !== item.trial_id || p.state !== 'trial') return null;
      // After whatever the log holds, so a revert read past an undo's restore replays after it.
      return pairRevert(p, { at: stampAfter(evs, at), ticket: item.ticket, file, line, reason: `the blind audit of PR #${item.pr} found ${f.p0} P0 on the ${p.levers.join(' with ')} pair: ${defect}` });
    });
    if (e) events.push(e);
  }
  return { row: written?.rec ?? row, events };
}

// The event that ends pair trial `p` (levers-auto.mjs pairTrial) for an audit P0.
const pairRevert = (p, { at, ticket, file, line, reason }) => ({
  kind: 'pair', levers: p.levers, pair: p.key, trial_id: p.id, from: 'trial', to: 'reverted', actor: ACTOR, reason_code: 'audit_p0', at, ticket,
  reason, evidence_file: file, evidence_line: line,
});

// A blind audit's P0 on a trial's on arm, recorded while that trial was not running (a lever set off by
// hand, so neither a trip nor a pair revert could be written), answered for each trial running in
// `events`: the lever log as it stands once a levers undo restores the trial, under its trial id. Pure:
// levers undo appends these in the same locked write as the restore, so no ticket is drawn into the
// restored trial first. -> [event]: a pair trial's revert, or the lever's trip and its needs_you.
export function auditP0Replay({ slug, name = slug, events, states, at, registry = REGISTRY }) {
  const file = auditFile(slug);
  const rows = rowsOf(file).filter((r) => r.rec.p0 > 0 && r.rec.arm === 'on');
  if (!rows.length) return [];
  const out = [];
  for (const t of liveTrials({ slug, events, states, registry })) {
    const r = rows.find((x) => x.rec.trial_id === t.id);
    if (!r) continue;
    const why = `the blind audit of PR #${r.rec.pr} found ${r.rec.p0} P0 while its trial was not running`;
    const defect = `${r.rec.p0} P0 at ${String(r.rec.merge_commit).slice(0, 12)}`;
    if (t.pair) {
      const p = pairTrial({ slug, events, states, values: null, registry });
      out.push(pairRevert(p, { at, ticket: r.rec.ticket, file, line: r.line, reason: `${why}, on the ${p.levers.join(' with ')} pair: ${defect}` }));
    } else {
      out.push(...tripEvents({ events, name, at, registry, x: { lever: t.lever, trip: TRIP, ticket: r.rec.ticket, from: 'trial', file, line: r.line, why, defect } }));
    }
  }
  return out;
}

// One pass's audits for repo `slug`: records each audit that ended, queues what the sample adds, and
// starts the oldest item due, or defers it. Every effect outside this module is a dependency, so a
// stub review worker stands in for one in tests:
//   spawn({ key, item, sha, model, task, brief, env }) -> { session, worktree, state, preflight_usd }
//     | { error, preflight_usd } | { wait: 'window_tight' | <why>, why, preflight_usd }
//   mergeCommit(item) -> sha | { sha, commits } | null                       mergeMethod: config §4's
//   ended(item) -> { at } | null     log(item) -> text
//   cleanup(item)                          pace() -> { hold }                 spend({ slug, now }) -> usd
//   room() -> why no worker may start now, or null
//   -> { recorded: [row], deferred: [event], started: [item], failed: [text], events: [event], line }
export async function runAudits({
  slug, name = slug, repo = slug, states, tickets, now = Date.now(), registry = REGISTRY, model = reviewModel,
  spawn, mergeCommit, mergeMethod = 'merge', ended = endedFromExit, log = logOf, cleanup = () => {}, pace = () => usagePace(), spend = weeklySpend, room = () => null,
}) {
  const out = { recorded: [], deferred: [], started: [], failed: [], events: [], line: null };
  // A log that does not parse is the assignment's to report; nothing is sampled on a partial read.
  // An audit already started is recorded below whether or not `auto` is still in the row, so turning it
  // off never strands one (a move or archive of the folder it runs in waits for it).
  if (read(slug).bad.length) return out;

  // Each running audit that ended is claimed under the queue's lock, so two passes never record one
  // twice, then recorded, and leaves the queue.
  // A recording a pass left part way (it died, or a write failed) is claimed again once it is stale.
  const ending = !existsSync(auditQueueFile(slug)) ? [] : withQueue(slug, (q) => Object.values(q.items).flatMap((i) => {
    let e = null;
    if (i.state === 'recording' && !(now - Date.parse(i.recording_at) < RECORDING_MS)) e = i.ended ?? ended(i);
    else if (i.state === 'running') e = ended(i);
    if (!e) return [];
    Object.assign(i, { state: 'recording', recording_at: new Date(now).toISOString(), ended: e });
    return [{ item: { ...i }, e }];
  }));
  for (const { item, e } of ending) {
    // One audit's failure to record leaves it for a later pass, never the others.
    try {
      const r = recordAudit({ slug, name, repo, item, ended: e, text: log(item), states, now, registry });
      out.recorded.push(r.row);
      out.events.push(...r.events);
    } catch (err) {
      out.failed.push(`${item.ticket} audit not recorded, a later pass finishes it: ${String(err?.message ?? err).split('\n')[0]}`);
      continue;
    }
    try { cleanup(item); } catch { /* a worktree left behind is not the audit's result */ }
    withQueue(slug, (q) => { delete q.items[item.ticket]; });
  }
  // Nothing new is sampled or started where the row has no `auto`.
  if (!Object.values(states ?? {}).includes('auto')) return summarise(out);
  const all = tickets ?? repoTickets(slug);

  // The sample adds what is newly due; a ticket audited already, or queued, is not added again.
  const rows = rowsOf(auditFile(slug));
  const audited = new Set(rows.map((r) => r.rec.ticket));
  const events = read(slug).events;
  const sample = sampleAudits({ slug, events, tickets: all, states, registry, now });
  const live = new Set(liveTrials({ slug, events, states, registry, now }).map((x) => x.id));
  const next = withQueue(slug, (q) => {
    // A trial's audit model is the review model when the trial is first seen running, fixed for its life.
    for (const id of live) q.trials[id] ??= { model: model(), at: new Date(now).toISOString() };
    // An audit not yet started whose trial has ended (adopted, reverted, or left to the row) is dropped.
    for (const [k, i] of Object.entries(q.items)) if (['queued', 'deferred', 'failed'].includes(i.state) && !live.has(i.trial_id)) delete q.items[k];
    for (const s of sample) {
      if (audited.has(s.ticket) || q.items[s.ticket]) continue;
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
      // Recorded audits, and the preflights of those not yet recorded, started or not.
      const spent = rows.filter((r) => Date.parse(r.rec.at) >= week).reduce((n, r) => n + (Number(r.rec.usd) || 0), 0)
        + items.reduce((n, i) => n + preflightUsd(i, week), 0);
      // The spend reads every ticket's logs, so it is measured once a day and kept in the queue file.
      const day = new Date(now).toISOString().slice(0, 10);
      if (q.spend?.day !== day || !Number.isFinite(q.spend?.usd)) q.spend = { day, usd: Number(spend({ slug, now })) || 0 };
      const cap = BUDGET_SHARE * q.spend.usd;
      if (spent >= cap) reason = 'weekly_cap';
      due.cap = { spent: Math.round(spent * 100) / 100, cap: Math.round(cap * 100) / 100 };
    }
    if (reason) return deferIn(due, reason, now);
    // No room for another worker this pass (memory, the machine's or repo's cap): it waits, untried.
    if (room()) return null;
    due.state = 'starting';
    due.starting_at = new Date(now).toISOString();
    return { start: { ...due } };
  });

  const deferEvent = (d) => {
    const e = appendWith(slug, () => ({
      kind: 'audit_deferred', lever: d.lever, actor: ACTOR, reason_code: d.deferred.reason, at: new Date(now).toISOString(), ticket: d.ticket,
      reason: d.deferred.reason === 'window_tight'
        ? `the audit of ${d.ticket} (PR #${d.pr}) waits: ${d.deferred.why ?? 'usage pacing is holding spawns'}`
        : `the audit of ${d.ticket} (PR #${d.pr}) waits for the week of ${d.deferred.until.slice(0, 10)}: this week's audits spent $${d.cap.spent} of their $${d.cap.cap}`,
    }));
    if (e) { out.deferred.push(e); out.events.push(e); }
  };
  if (next?.defer) {
    if (next.fresh) deferEvent(next.defer);
  } else if (next?.start) {
    const item = next.start;
    // Each preflight the start paid for is the audit's spend, whatever became of the start.
    const paid = (i, s) => { if (Number.isFinite(s?.preflight_usd)) (i.preflights ??= []).push({ at: new Date(now).toISOString(), usd: s.preflight_usd }); };
    const fail = (why, s) => withQueue(slug, (q) => {
      const i = q.items[item.ticket];
      if (!i) return;
      paid(i, s);
      i.tries = (i.tries ?? 0) + 1;
      i.error = String(why).slice(0, 300);
      i.state = i.tries >= SPAWN_TRIES ? 'failed' : 'queued';
      out.failed.push(`${item.ticket} audit not started (try ${i.tries} of ${SPAWN_TRIES}): ${i.error}`);
    });
    // A start refused for want of usage or a login is no fault of the audit: it waits, untried, and a
    // usage-limit refusal is a tight window like any other.
    const wait = (s) => {
      const d = withQueue(slug, (q) => {
        const i = q.items[item.ticket];
        if (!i) return null;
        paid(i, s);
        if (s.wait === 'window_tight') return deferIn(i, 'window_tight', now, s.why);
        i.state = 'queued';
        out.failed.push(`${item.ticket} audit waits: ${s.why ?? s.wait}`);
        return null;
      });
      if (d?.fresh) deferEvent(d.defer);
    };
    let m = null;
    try { m = await mergeCommit(item); } catch { m = null; }
    const sha = typeof m === 'string' ? m : m?.sha;
    if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) fail(`the merge commit of PR #${item.pr} could not be read`);
    else {
      const ctx = { ticket: item.ticket, pr: item.pr, sha, base: auditBase({ sha, method: mergeMethod, commits: m?.commits }), repo };
      let s;
      try { s = await spawn({ key: item.key, item, sha, model: item.model, task: auditTask(ctx), brief: auditBrief(ctx), env: { DESK_LEVERS: 'none' } }); } catch (e) { s = { error: e?.message ?? String(e) }; }
      if (s?.wait) wait(s);
      else if (!s || s.error || !s.session) fail(s?.error ?? 'the spawn returned no session', s);
      else {
        const started = withQueue(slug, (q) => {
          const i = q.items[item.ticket];
          if (!i) return null;
          paid(i, s);
          Object.assign(i, { state: 'running', sha, session: s.session, worktree: s.worktree ?? null, state_dir: s.state ?? null, started_at: new Date(now).toISOString() });
          return { ...i };
        });
        if (started) out.started.push(started);
      }
    }
  }
  return summarise(out);
}

// runAudits' result with its one-line summary for the pass's report, or null when nothing happened.
function summarise(out) {
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
