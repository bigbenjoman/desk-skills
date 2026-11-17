#!/usr/bin/env node
// The Phase 0 baseline: what a repo's workers cost and needed over the last days, per batch and in
// total, with the desk version and levers each run used, so a change in the numbers can be put down
// to a change in desk.
//
//   node phase0-report.mjs [--days <n>] [--no-ci]     the report (7 days unless --days says)
//   node phase0-report.mjs --per-ticket [--json] [--days <n> | --since <iso> [--until <iso>]] [--no-ci]
//       one JSON row per ticket admitted in the window, across every batch, archived ones included,
//       each costing the ticket's whole spend; `carried_in` is the in-window spend of tickets
//       admitted earlier, so rows plus carried_in equal the report's total for the same --days, and
//       `rework` is the rows' cost-weighted rework share by cause (rework.mjs)
//   node phase0-report.mjs spawn-line --ticket <KEY> --session <id> [--stage <s>] [--model <m>]
//       [--effort <e>] [--system-bytes <n>] [--prompt-bytes <n>] [--log <worker log>]
//       one JSON line for spawn-worker.sh to append to $DESK_STATE/workers/<KEY>.runs.jsonl, and with
//       --log the desk_spawn line worker-cost.mjs reads appended to that log
//
// The report is read-only: it reads queues, logs, worker records, the digest's answers and git refs
// as they are, and asks GitHub only for its failed workflow runs. It never fetches, resets, checks out
// or writes anything, and runs git with --no-optional-locks so not even the index is refreshed. A
// figure a run never recorded (a quota reading, a desk commit, the levers) is "not recorded", never a
// zero or a guess.
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { listBatches } from './batches.mjs';
import { readLogFile, saidIn, markersIn } from './harvest.mjs';
import { workerLogs, ticketCost, logUsage, spawnEvent, startFields } from './worker-cost.mjs';
import { windowEvents, probeLog } from './usage-pace.mjs';
import { readInstalled } from './installed.mjs';
import { digestDir } from './digest.mjs';
import { triesMade } from './fix-tries.mjs';
import { leverFingerprints } from './lever-registry.mjs';
import { parkClass } from './failure-class.mjs';
import { sizeOf } from './desk-q-eta.mjs';
import { pinDisagrees } from './lever-pin.mjs';
import { ticketRework, reworkSummary } from './rework.mjs';
import { toolOutcomes } from './log-tool-calls.mjs';
import { everyTicket, readQueueFile } from './queue-store.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NR = 'not recorded';

// ---- what spawn-worker.sh records ----------------------------------------------------------------
// The first line `claude --version` prints, or null when it fails or prints nothing.
export function claudeVersion(run = () => spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })) {
  try {
    const r = run();
    return (r?.status === 0 && String(r.stdout ?? '').trim().split('\n')[0].trim()) || null;
  } catch { return null; }
}

// One worker start: when, which session and stage, its model and effort, the desk commit installed,
// the levers on, the claude version, a hash of each lever's installed code (and any listed file that
// was missing), and the bytes of the system prompt and first message it was handed.
export function spawnLine({ ticket, session, stage = null, model = null, effort = null, systemBytes = null, promptBytes = null, now = new Date(),
  installed = readInstalled(), levers = E.levers(), claude = claudeVersion(), fingerprints = leverFingerprints() }) {
  const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return JSON.stringify({
    at: now.toISOString(), ticket, session, ...startFields({ stage, model, effort }),
    desk_commit: installed?.commit ?? null, levers: levers.on, unknown_levers: levers.unknown,
    claude_version: claude, lever_fp: fingerprints.fp, lever_fp_missing: fingerprints.missing,
    system_bytes: n(systemBytes), prompt_bytes: n(promptBytes),
  });
}

// Every start recorded in a batch's state directory. The report matches them to the starts its
// window's logs show, by session, rather than by their own time.
export function spawnRecords(state) {
  const dir = join(state, 'workers');
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.runs.jsonl')); } catch { return []; }
  const out = [];
  for (const f of names) {
    let text = '';
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r?.ticket && r.session) out.push(r);
    }
  }
  return out;
}

// ---- one log -------------------------------------------------------------------------------------
// The words a denial is counted under: a Bash command's program, with its subcommand for the
// programs that have one, or the tool's name.
const SUBCOMMANDS = new Set(['git', 'gh', 'node', 'npm', 'pnpm', 'yarn', 'uv', 'docker', 'codex', 'desk-jira', 'desk-env', 'bash', 'sh', 'python', 'python3']);
export function commandKey(tool, input) {
  if (tool !== 'Bash' || typeof input?.command !== 'string') return tool ?? 'unknown';
  const cmd = input.command.trim().replace(/^cd\s+\S+\s*&&\s*/, '');
  const words = cmd.split(/\s+/).filter(Boolean);
  const prog = (words[0] ?? '').replace(/^.*\//, '');
  if (!SUBCOMMANDS.has(prog)) return prog || 'Bash';
  const sub = words.slice(1).find((w) => !w.startsWith('-'));
  return sub ? `${prog} ${sub.replace(/^.*\//, '')}` : prog;
}

// What one worker log shows: parks it printed, Stage 4b entries, permission denials by command, its
// usage readings and the rate_limit_event lines that could not be read as one, the session of each
// start it holds (one init event per `claude -p` start, a resume's under the same session), and
// whether anything but preflights ran in it at all.
export function logFacts(text) {
  const out = { parks: 0, parkClasses: {}, reviewRounds: 0, denials: {}, readings: windowEvents(text), badReadings: 0, starts: [], ran: false };
  for (const o of toolOutcomes(text)) {
    if (!o.denied) continue;
    const k = commandKey(o.tool, o.input);
    out.denials[k] = (out.denials[k] ?? 0) + 1;
  }
  let events = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('{"type":"rate_limit_event"')) events += 1;
    let d;
    try { d = JSON.parse(line); } catch { if (line.trim()) out.ran = true; continue; }
    if (d?.type !== 'desk_preflight') out.ran = true;
    if (d?.type === 'system' && d.subtype === 'init') out.starts.push(d.session_id ?? null);
    if (d?.type === 'assistant') {
      for (const c of d.message?.content ?? []) {
        const said = saidIn(c);
        if (said == null) continue;
        for (const [k, v] of markersIn([said])) {
          if (k === 'AUTOPILOT_PARK') {
            out.parks += 1;
            const cls = parkClass(v).class;
            out.parkClasses[cls] = (out.parkClasses[cls] ?? 0) + 1;
          }
          if (k === 'AUTOPILOT_STAGE' && /^4b\b/i.test(v.trim())) out.reviewRounds += 1;
        }
      }
    }
  }
  out.badReadings = Math.max(0, events - out.readings.length);
  return out;
}

// ---- one batch -----------------------------------------------------------------------------------
const add = (into, from) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v; };
const addQuota = (into, readings) => {
  for (const e of readings) {
    const w = e.seven_day;
    if (!w) continue;
    const q = into[w.resetsAt] ?? { min: w.utilization, max: w.utilization };
    into[w.resetsAt] = { min: Math.min(q.min, w.utilization), max: Math.max(q.max, w.utilization) };
  }
};

// `input` `output` `cost` add up every run that recorded its spend, whatever else its ticket did;
// `acc*` only the accepted tickets whose every run did, which is what the per-ticket figure divides.
const emptyFigures = () => ({
  tickets: 0, accepted: 0, runs: 0, unknownRuns: 0, input: 0, output: 0, cost: 0,
  accKnown: 0, accInput: 0, accOutput: 0, accCost: 0, fixTries: 0, repairs: {},
  parks: 0, answered: 0, denials: {}, reviewRounds: 0, quota: {}, badReadings: 0, starts: 0, spawns: [], ci: {},
});

// What one queue ticket's logs from `from` show: its spend (`cost` is every run that left a result
// event plus every preflight), parks, review rounds, denials and readings, and each start as its
// session (empty when its log has no init event) and the record of that session, or null for none. The batch figures and the per-ticket
// rows both read a ticket through this, so the rows and their carried-in spend add up to the batch.
function ticketFacts(state, t, from, records) {
  const logs = workerLogs(state, t.key, from);
  const c = logs.length ? ticketCost(state, { ...t, added_at: from }) : null;
  const x = { logs, c, input: 0, output: 0, cost: c?.preflight.cost ?? 0, parks: 0, parkClasses: {}, reviewRounds: 0, denials: {},
    readings: [], badReadings: 0, starts: [] };
  const starts = {};
  for (const file of logs) {
    let text = '';
    try { text = readLogFile(file); } catch { continue; }
    const u = logUsage(text);
    if (u) for (const k of ['input', 'output', 'cost']) x[k] += u[k];
    const l = logFacts(text);
    x.parks += l.parks;
    add(x.parkClasses, l.parkClasses);
    x.reviewRounds += l.reviewRounds;
    add(x.denials, l.denials);
    x.readings.push(...l.readings);
    x.badReadings += l.badReadings;
    // A log that ran with no init event (one cut off at once) is still a start, of no known session.
    for (const s of l.starts.length ? l.starts : l.ran ? [null] : []) add(starts, { [s ?? '']: 1 });
  }
  // A start counts as recorded only against a record of its own session, one record per start.
  for (const [sid, n] of Object.entries(starts)) {
    const mine = sid ? records.filter((r) => r.ticket === t.key && r.session === sid).slice(-n) : [];
    x.starts.push(...mine.map((record) => ({ sid, record })), ...Array(n - mine.length).fill({ sid, record: null }));
  }
  return x;
}

// One batch's figures for the window from `since` (epoch ms). `answered` is the digest's answered
// record ({ "<slug>/<ticket>/<hash>": ISO time }). A queue that cannot be read is { unreadable }.
export function batchFigures({ queue, state, slug, since, answered = {} }) {
  let q;
  try { q = readQueueFile(queue); } catch (e) { return { unreadable: e.message }; }
  const f = emptyFigures();
  const sinceIso = new Date(since).toISOString();
  const inWindow = (at) => at != null && Date.parse(at) >= since;
  const keys = new Set();
  const records = spawnRecords(state);
  // Archived tickets too (queue-store.mjs): every merged ticket is archived within a pass of its merge.
  for (const t of Object.values(everyTicket(q))) {
    const from = t.added_at && Date.parse(t.added_at) > since ? t.added_at : sinceIso;
    const merged = inWindow(t.merged_at);
    const x = ticketFacts(state, t, from, records);
    const { c } = x;
    if (!x.logs.length && !merged) continue;
    keys.add(t.key);
    f.tickets += 1;
    if (merged) f.accepted += 1;
    if (c) { f.runs += c.runs; f.unknownRuns += c.unknown; }
    const tries = (t.fix_tries ?? []).filter((y) => inWindow(y.at));
    for (const y of tries) add(f.repairs, { [y.kind ?? 'unknown']: 1 });
    // Per accepted ticket counts only accepted tickets' tries, as fix-tries.mjs counts a try.
    if (merged) f.fixTries += triesMade(tries);
    const spent = { input: x.input, output: x.output, cost: x.cost };
    for (const k of Object.keys(spent)) f[k] += spent[k];
    f.parks += x.parks;
    f.reviewRounds += x.reviewRounds;
    add(f.denials, x.denials);
    addQuota(f.quota, x.readings);
    f.badReadings += x.badReadings;
    f.starts += x.starts.length;
    f.spawns.push(...x.starts.map((s) => s.record).filter(Boolean));
    // Spend fully recorded: a worker ran here, every run left a result event, and it is not a cloud
    // worker, which reports none. Anything less leaves the ticket out of the per-ticket figure.
    if (merged && c && !c.cloud && !c.unknown) {
      f.accKnown += 1;
      f.accInput += spent.input;
      f.accOutput += spent.output;
      f.accCost += spent.cost;
    }
    if (t.branch) f.branches = [...(f.branches ?? []), t.branch];
  }
  for (const [k, at] of Object.entries(answered)) {
    const [s, ticket] = k.split('/');
    if (s === slug && keys.has(ticket) && inWindow(at)) f.answered += 1;
  }
  return f;
}

export function totalOf(list) {
  const f = emptyFigures();
  for (const b of list) {
    if (b.unreadable) continue;
    for (const k of ['tickets', 'accepted', 'runs', 'unknownRuns', 'input', 'output', 'cost', 'accKnown', 'accInput', 'accOutput', 'accCost',
      'fixTries', 'parks', 'answered', 'reviewRounds', 'badReadings', 'starts']) f[k] += b[k];
    for (const k of ['repairs', 'denials', 'ci']) add(f[k], b[k]);
    for (const [r, q] of Object.entries(b.quota)) {
      const had = f.quota[r];
      f.quota[r] = had ? { min: Math.min(had.min, q.min), max: Math.max(had.max, q.max) } : { ...q };
    }
    f.spawns.push(...b.spawns);
  }
  return f;
}

// ---- red CI --------------------------------------------------------------------------------------
const runGh = (args) => spawnSync('gh', args, { encoding: 'utf8' });

// Failed workflow runs created since `since`, each with its failed jobs' names: { runs: [{ branch,
// jobs }] } or { unreadable }. With `jobs` false, only the list is read and `jobs` is null.
export function failedRuns({ repo, since, gh = runGh, jobs: withJobs = true }) {
  const day = new Date(since).toISOString().slice(0, 10);
  const list = gh(['run', 'list', '--repo', repo, '--status', 'failure', '--created', `>=${day}`, '--limit', '500', '--json', 'databaseId,headBranch,workflowName']);
  if (list.status !== 0) return { unreadable: `gh run list failed: ${String(list.stderr ?? '').trim().split('\n').pop() || `exit ${list.status}`}` };
  let runs;
  try { runs = JSON.parse(list.stdout); } catch { return { unreadable: 'gh run list printed something that is not JSON' }; }
  return {
    runs: runs.map((r) => {
      if (!withJobs) return { branch: r.headBranch, jobs: null };
      const v = gh(['run', 'view', String(r.databaseId), '--repo', repo, '--json', 'jobs']);
      let jobs = null;
      try { jobs = JSON.parse(v.stdout).jobs.filter((j) => j.conclusion === 'failure').map((j) => j.name); } catch { /* read below */ }
      return { branch: r.headBranch, jobs: jobs?.length ? jobs : [`${r.workflowName} (jobs not read)`] };
    }),
  };
}

const ciCounts = (runs) => { const c = {}; for (const r of runs) for (const j of r.jobs) add(c, { [j]: 1 }); return c; };

// Red CI for the window, as the report and the per-ticket rows both read it: { ciRuns, ciNote },
// `ciRuns` failedRuns()'s list or null, and `ciNote` why it is null (null when it was read).
function readCi({ ci, repo, since, gh }) {
  if (!ci) return { ciRuns: null, ciNote: 'not read (--no-ci)' };
  if (!repo) return { ciRuns: null, ciNote: 'unreadable: no GitHub repo for this checkout' };
  const r = failedRuns({ repo, since, gh });
  return r.unreadable ? { ciRuns: null, ciNote: `unreadable: ${r.unreadable}` } : { ciRuns: r.runs, ciNote: null };
}
const repoOrNull = () => { try { return E.ghRepo(); } catch { return null; } };

// ---- one row per admitted ticket -----------------------------------------------------------------
// The levers pin a ticket was admitted with (its queue `levers` object), as the set, arm per trial,
// trial ids and the lever code fingerprints at admission; null for a ticket admitted with no pin.
const pinOf = (l) => (l && typeof l === 'object' && !Array.isArray(l)
  ? { set: l.set ?? null, arms: l.arms ?? null, trial_ids: l.trial_ids ?? null, fp: l.fp ?? null } : null);

// One row per ticket in a batch whose `added_at` falls in [since, until) (epoch ms), with every run
// it made since, runs after `until` included: a row is the ticket's whole outcome. `cost` is what its
// runs recorded plus its preflights, never an estimate: `cost_complete` is false when a run left no
// result event or it ran in the cloud. `ciRuns` is failedRuns()'s list, or null when red CI was not
// read, which leaves `ci_reds` null. -> { rows, carriedIn }: `carriedIn` is each ticket admitted
// before `since` (or with no readable `added_at`) that spent in the window, with that spend as
// batchFigures() counts it, so the rows' costs plus these equal the batch's `cost` for a window
// ending now. A queue that cannot be read is { unreadable }.
export function ticketRows({ queue, state, slug, batch = null, since, until = Infinity, ciRuns = null }) {
  let q;
  try { q = readQueueFile(queue); } catch (e) { return { unreadable: e.message }; }
  const records = spawnRecords(state);
  const rows = [];
  const carriedIn = [];
  const sinceIso = new Date(since).toISOString();
  // Archived tickets too (queue-store.mjs): every merged ticket is archived within a pass of its merge.
  for (const t of Object.values(everyTicket(q))) {
    const at = Date.parse(t.added_at);
    if (!(at >= since)) {
      const x = ticketFacts(state, t, sinceIso, records);
      if (x.logs.length) carriedIn.push({ batch, key: t.key, cost: x.cost });
      continue;
    }
    if (!(at < until)) continue;
    const x = ticketFacts(state, t, t.added_at, records);
    // A cloud worker leaves no log here, so its run is read from the queue entry.
    x.c ??= t.location === 'cloud' && t.cloud ? ticketCost(state, t) : null;
    const size = sizeOf(state, t.key);
    const rework = ticketRework(x.logs, t, x.cost);
    const reds = ciRuns && t.branch ? ciRuns.filter((r) => r.branch === t.branch) : [];
    const starts = x.starts.map(({ sid, record: s }) => ({
      at: s?.at ?? null, session: sid || null, stage: s?.stage ?? null, desk_commit: s?.desk_commit ?? null,
      levers: Array.isArray(s?.levers) ? s.levers : null, claude_version: s?.claude_version ?? null,
      lever_fp: s?.lever_fp ?? null, system_bytes: s?.system_bytes ?? null, prompt_bytes: s?.prompt_bytes ?? null,
    }));
    rows.push({
      slug, batch, key: t.key, type: t.type ?? null, lane: t.lane ?? null, size: size === 'unknown' ? null : size,
      admitted_at: t.added_at, merged_at: t.merged_at ?? null, state: t.state ?? null,
      cost: x.cost, cost_complete: !x.c || (!x.c.cloud && !x.c.unknown), input: x.input, output: x.output,
      preflight_cost: x.c?.preflight.cost ?? 0, runs: x.c?.runs ?? 0, unknown_runs: x.c?.unknown ?? 0,
      starts: starts.length, fix_tries: triesMade(t.fix_tries), parks: x.parks, parks_by_class: x.parkClasses,
      review_rounds: x.reviewRounds, denials: Object.values(x.denials).reduce((n, v) => n + v, 0), denials_by_command: x.denials,
      ci_reds: ciRuns ? reds.length : null, ci_reds_by_job: ciRuns ? ciCounts(reds) : null,
      desk_commits: [...new Set(starts.map((s) => s.desk_commit).filter(Boolean))],
      start_records: starts, login: t.login?.name ?? null, pin: pinOf(t.levers),
      // A start that recorded levers other than the pin's set: false with no pin.
      pin_mismatch: starts.some((s) => pinDisagrees(t.levers?.set, s.levers)),
      // What the starts after the first cost, as a share of `cost`, by cause and failure class (rework.mjs).
      rework_share: rework.share, rework_cost: rework.cost, rework_by_cause: rework.by_cause, rework_by_class: rework.by_class,
      rework_starts: rework.starts,
    });
  }
  return { rows, carriedIn };
}

// Each start in the window whose recorded levers differ from its ticket's pin, oldest first:
// [{ key, session, at, pin, levers }]. A ticket with no pin, a start that recorded no levers, and a
// queue that cannot be read give none.
export function pinMismatches({ queue, state, since }) {
  let q;
  try { q = readQueueFile(queue); } catch { return []; }
  return spawnRecords(state)
    .filter((r) => Date.parse(r.at) >= since && pinDisagrees(q.tickets?.[r.ticket]?.levers?.set, r.levers))
    .map((r) => ({ key: r.ticket, session: r.session, at: r.at, pin: q.tickets[r.ticket].levers.set, levers: r.levers }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
const pinMismatchLines = (batches, since) => {
  const found = batches.flatMap((b) => (existsSync(b.queue) ? pinMismatches({ queue: b.queue, state: b.state, since }) : []).map((m) => ({ b, m })));
  if (!found.length) return ['pin mismatch: none (every start recorded its ticket\'s pinned levers)'];
  const set = (l) => (l.length ? l.join(', ') : 'none');
  return ['pin mismatch: starts whose levers differ from their ticket\'s pin',
    ...found.map(({ b, m }) => `  ${m.key}${b.name ? ` (batch ${b.name})` : ''}: started ${m.at}, session ${m.session}, with ${set(m.levers)}; pinned ${set(m.pin)}`)];
};

// Every batch's rows for the window, and how red CI was read: { slug, since, until, ci, rows,
// carried_in: { cost, tickets: [{ batch, key, cost }] }, unreadable: [{ batch, why }] }. Each input
// is a parameter so a test can point it at fixtures.
export function perTicket({
  slug = E.repoSlug(), batches = allBatches(slug), since, until = Date.now(), ci = true, gh = runGh, repo = repoOrNull(),
} = {}) {
  const { ciRuns, ciNote } = readCi({ ci, repo, since, gh });
  const rows = [];
  const carried = [];
  const unreadable = [];
  for (const b of batches) {
    const got = existsSync(b.queue)
      ? ticketRows({ queue: b.queue, state: b.state, slug, batch: b.name ?? null, since, until, ciRuns })
      : { unreadable: `no queue at ${b.queue}` };
    if (got.unreadable) unreadable.push({ batch: b.name ?? null, why: got.unreadable });
    else { rows.push(...got.rows); carried.push(...got.carriedIn); }
  }
  return {
    slug, since: new Date(since).toISOString(), until: new Date(until).toISOString(), ci: ciNote ?? 'read', rows,
    carried_in: { cost: carried.reduce((n, c) => n + c.cost, 0), tickets: carried }, unreadable, rework: reworkSummary(rows),
  };
}

// The rework share of the tickets admitted in the window, by cause and failure class, with the tickets
// whose cost or rework was not recorded named apart.
function reworkLines(s) {
  const head = 'rework share, tickets admitted in the window';
  if (!s.tickets) return [`${head}: no ticket admitted`];
  const out = [s.share == null
    ? `${head}: ${NR}: no admitted ticket has its cost and rework recorded`
    : `${head}: ${pct(s.share)}, ${usd(s.rework_cost)} of ${usd(s.cost)} over ${s.known} ticket(s) with their cost recorded (what each ticket's starts after its first cost, over all it cost)`];
  const causes = Object.entries(s.by_cause);
  out.push(`  by cause: ${causes.length ? causes.map(([c, v]) => `${c} ${usd(v.cost)} (${pct(v.share)})`).join(' · ') : 'none'}`);
  const classes = byCount(s.by_class);
  out.push(`  by failure class: ${classes.length ? classes.map(([c, v]) => `${c} ${usd(v)}`).join(' · ') : 'none'}`);
  out.push(`  unknown cost, counted apart: ${s.unknown.length ? `${s.unknown.length} ticket(s): ${s.unknown.join(', ')}` : 'none'}`);
  return out;
}

// ---- versions and the checkout -------------------------------------------------------------------
const git = (dir, ...args) => {
  const r = spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const short = (sha) => (sha ? sha.slice(0, 12) : 'unknown');

// The main checkout and every other worktree of it, as git last saw origin: nothing is fetched.
export function checkoutLines({ root, defaultBranch }) {
  const out = [];
  const head = git(root, 'rev-parse', 'HEAD');
  if (!head) return [`main checkout: ${root} cannot be read as a git checkout`];
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  const upstream = `origin/${defaultBranch}`;
  const behind = git(root, 'rev-list', '--count', `HEAD..${upstream}`);
  const ahead = git(root, 'rev-list', '--count', `${upstream}..HEAD`);
  const dirty = git(root, 'status', '--porcelain');
  const changed = dirty == null ? 'uncommitted files unknown' : dirty ? `${dirty.split('\n').length} uncommitted file(s)` : 'no uncommitted files';
  const rel = behind == null ? `${upstream} unknown here` : `${behind} behind and ${ahead} ahead of ${upstream} as last fetched`;
  out.push(`main checkout: ${root} at ${short(head)} on ${branch}, ${rel}, ${changed} (reported only: nothing is fetched, reset or checked out)`);
  const list = git(root, 'worktree', 'list', '--porcelain') ?? '';
  const trees = list.split('\n\n').map((b) => ({
    path: /^worktree (.*)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.*)$/m.exec(b)?.[1] ?? 'detached',
  })).filter((w) => w.path && w.path !== root && (() => { try { return realpathSync(w.path) !== realpathSync(root); } catch { return false; } })());
  if (!trees.length) out.push('worktrees: none besides the main checkout');
  for (const w of trees) {
    if (!existsSync(w.path)) { out.push(`  worktree ${w.path} (${w.branch}): missing on disk`); continue; }
    const base = git(w.path, 'merge-base', 'HEAD', upstream);
    const behindBase = base && git(w.path, 'rev-list', '--count', `${base}..${upstream}`);
    out.push(`  worktree ${w.path} (${w.branch}): base ${short(base)}${behindBase != null && base ? `, ${behindBase} behind ${upstream}` : ''}`);
  }
  return out;
}

const fileBytes = (p) => { try { return statSync(p).size; } catch { return null; } };

// ---- rendering -----------------------------------------------------------------------------------
const num = (n) => Math.round(n).toLocaleString('en-US');
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (u) => `${Math.round(u * 100)}%`;
const byCount = (m) => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const listOf = (m, none = 'none') => (Object.keys(m).length ? byCount(m).map(([k, v]) => `${k} ${v}`).join(' · ') : none);
const resetIso = (s) => new Date(Number(s) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

function quotaLines(f, { missing }) {
  const windows = Object.entries(f.quota).sort((a, b) => Number(a[0]) - Number(b[0]));
  const bad = f.badReadings ? ` (${f.badReadings} more reading(s) could not be read)` : '';
  if (!windows.length) return [`quota, the signed-in login: ${missing}${bad}`];
  return windows.map(([r, q]) => `quota, the signed-in login's 7-day window resetting ${resetIso(r)}: ${pct(q.min)} to ${pct(q.max)}, ${Math.round((q.max - q.min) * 100)} point(s) used in the readings seen${bad}`);
}

// The spread of one recorded field over the starts that recorded it, and the starts that did not.
function recorded(f, label, valueOf) {
  const counts = {};
  for (const s of f.spawns) add(counts, { [valueOf(s)]: 1 });
  const unrecorded = Math.max(0, f.starts - f.spawns.length);
  const parts = byCount(counts).map(([k, v]) => `${k} (${v} start(s))`);
  if (unrecorded || !parts.length) parts.push(`${NR}${unrecorded ? ` (${unrecorded} start(s))` : ''}`);
  return `${label}: ${parts.join(' · ')}`;
}

const commitOf = (s) => (s.desk_commit ? short(s.desk_commit) : NR);
const leversOf = (s) => (Array.isArray(s.levers) ? (s.levers.length ? s.levers.join(',') : 'none') : NR);
const bytesOf = (s) => (s.system_bytes != null && s.prompt_bytes != null ? `${num(s.system_bytes + s.prompt_bytes)} bytes loaded` : `bytes loaded ${NR}`);
// Each recorded start on its own line: which session ran on which desk commit, and what it loaded.
const startLines = (f) => [...f.spawns].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  .map((s) => `  start ${s.ticket} session ${String(s.session).slice(0, 8)} at ${s.at} (stage ${s.stage}, effort ${s.effort ?? NR}): desk ${commitOf(s)}, levers ${leversOf(s)}, ${bytesOf(s)}`);

function bytesLine(f) {
  const s = f.spawns.filter((x) => x.system_bytes != null && x.prompt_bytes != null);
  if (!s.length) return `instructions loaded at start: ${NR}`;
  const avg = (k) => s.reduce((n, x) => n + x[k], 0) / s.length;
  return `instructions loaded at start: ${num(avg('system_bytes') + avg('prompt_bytes'))} bytes on average over ${s.length} start(s) (system prompt ${num(avg('system_bytes'))}, first message ${num(avg('prompt_bytes'))})`;
}

export function figureLines(f, { ci, quotaMissing, perStart = false }) {
  if (f.unreadable) return [`queue unreadable: ${f.unreadable}`];
  const lines = [`tickets with work or a merge in the window: ${f.tickets}, accepted (PR merged): ${f.accepted}`];
  const unknown = f.unknownRuns ? ` (${f.unknownRuns} run(s) with no result event not counted)` : '';
  lines.push(`spent in the window: ${num(f.input)} input tokens · ${num(f.output)} output tokens · ${usd(f.cost)} API-equivalent${unknown}`);
  const left = f.accepted - f.accKnown;
  const leftOut = left ? `; ${left} accepted ticket(s) left out, their spend not fully recorded (a run with no result event, no log in the window, or a cloud worker)` : '';
  lines.push(!f.accepted ? 'per accepted ticket: no ticket accepted'
    : !f.accKnown ? `per accepted ticket: ${NR}: no accepted ticket has its spend fully recorded${leftOut}`
      : `per accepted ticket: ${num(f.accInput / f.accKnown)} input tokens · ${num(f.accOutput / f.accKnown)} output tokens · ${usd(f.accCost / f.accKnown)} API-equivalent, over ${f.accKnown} of ${f.accepted}${leftOut}`);
  lines.push(`fix tries per accepted ticket: ${f.accepted ? (f.fixTries / f.accepted).toFixed(2) : 'no ticket accepted'} (${f.fixTries} made by accepted tickets)`);
  lines.push(`repair cycles by kind: ${listOf(f.repairs)}`);
  lines.push(`needs-you items: ${f.parks} raised (worker parks) · ${f.answered} answered (from the digest)`);
  const denials = Object.values(f.denials).reduce((n, v) => n + v, 0);
  lines.push(`permission denials by command: ${denials ? `${denials} in all: ${listOf(f.denials)}` : 'none'}`);
  lines.push(`Stage 4b review rounds: ${f.reviewRounds}`);
  lines.push(`red CI runs by failing job: ${ci ?? listOf(f.ci)}`);
  lines.push(...quotaLines(f, { missing: quotaMissing }));
  lines.push(recorded(f, 'desk commit workers ran on', commitOf));
  lines.push(recorded(f, 'levers on', leversOf));
  lines.push(bytesLine(f));
  if (perStart) lines.push(...startLines(f));
  return lines;
}

// The archived named batches: batch.mjs moves a batch's queue folder and its state folder into
// batches/.done/ under the same name, so a batch archived inside the window still counts.
export function archivedBatches({ queueRoot, stateRoot }) {
  const qdone = join(queueRoot, E.BATCHES_DIR, '.done');
  let names = [];
  try { names = readdirSync(qdone, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
  return names.filter((n) => existsSync(join(qdone, n, 'queue.json')))
    .map((n) => ({ name: `${n} (archived)`, queue: join(qdone, n, 'queue.json'), state: join(stateRoot, E.BATCHES_DIR, '.done', n) }));
}
export const allBatches = (slug) => {
  const standing = E.batchPaths(slug);
  return [...listBatches(slug), ...archivedBatches({ queueRoot: dirname(standing.queue), stateRoot: standing.state })];
};

// The whole report, as lines. Every input is a parameter so a test can point it at fixtures.
export function report({
  slug = E.repoSlug(), batches = allBatches(slug), days = 7, now = Date.now(), ci = true, gh = runGh,
  repo = repoOrNull(),
  root = (() => { try { return E.repoRoot(); } catch { return null; } })(),
  defaultBranch = (() => { try { return E.defaultBranch(); } catch { return 'main'; } })(),
  installed = readInstalled(), levers = E.levers(), answered = readJson(join(digestDir(), 'answered.json')),
  usageFiles = [], contract = join(E.skillsDir(), 'desk-autopilot', 'references', 'autopilot-worker-contract.md'),
  memoryIndex = (() => { try { return join(E.memoryDir(), 'MEMORY.md'); } catch { return null; } })(),
} = {}) {
  const since = now - days * DAY_MS;
  const out = [`PHASE 0 BASELINE: ${slug}, the ${days} day(s) from ${new Date(since).toISOString()} to ${new Date(now).toISOString()}. Read-only: nothing is fetched, reset, checked out or written.`];
  out.push(...(root ? checkoutLines({ root, defaultBranch }) : ['main checkout: config §2 Primary repo root is not set']));
  out.push(`installed desk: ${installed?.commit ? `${short(installed.commit)}${installed.dirty ? ' (with uncommitted changes)' : ''}, installed ${installed.at ?? 'at an unknown time'}` : NR}`);
  const cb = contract && fileBytes(contract);
  const mb = memoryIndex && fileBytes(memoryIndex);
  out.push(`instructions a worker loads now: worker contract core ${cb == null ? 'not found' : `${num(cb)} bytes`}, memory index ${mb == null ? 'none' : `${num(mb)} bytes`}`);
  out.push(`levers row now: on ${levers.on.join(', ') || 'none'}${levers.unknown.length ? `; unknown, read as off: ${levers.unknown.join(', ')}` : ''}`);

  const { ciRuns, ciNote } = readCi({ ci, repo, since, gh });

  const figures = batches.map((b) => {
    const f = existsSync(b.queue) ? batchFigures({ queue: b.queue, state: b.state, slug, since, answered }) : { unreadable: `no queue at ${b.queue}` };
    if (!f.unreadable && ciRuns) { const mine = new Set(f.branches ?? []); f.ci = ciCounts(ciRuns.filter((r) => mine.has(r.branch))); }
    return { b, f };
  });
  for (const { b, f } of figures) {
    if (!f.unreadable && !f.tickets) continue;
    out.push('', `batch ${b.name ?? '(standing)'}:`);
    out.push(...figureLines(f, { ci: ciNote, quotaMissing: `unreadable: ${NR} in this batch's logs`, perStart: true }).map((l) => `  ${l}`));
  }
  const total = totalOf(figures.map((x) => x.f));
  if (ciRuns) total.ci = ciCounts(ciRuns);
  for (const file of usageFiles) {
    let text = '';
    try { if (statSync(file).mtimeMs >= since) text = readLogFile(file); } catch { continue; }
    addQuota(total.quota, windowEvents(text));
  }
  const missing = total.badReadings
    ? 'unreadable: every reading in the window failed to parse'
    : `unreadable: no 7-day usage reading in any worker log or usage probe output since ${new Date(since).toISOString()}`;
  out.push('', `total${ciRuns ? ' (red CI counts every failed run in the repo, not only batch branches)' : ''}:`);
  out.push(...figureLines(total, { ci: ciNote, quotaMissing: missing }).map((l) => `  ${l}`));
  const admitted = batches.flatMap((b) => {
    const got = existsSync(b.queue) ? ticketRows({ queue: b.queue, state: b.state, slug, batch: b.name ?? null, since, until: now }) : { rows: [] };
    return got.rows ?? [];
  });
  out.push('', ...reworkLines(reworkSummary(admitted)));
  out.push('', ...pinMismatchLines(batches, since));
  out.push('', 'Usage readings name no login, so a 7-day window stands for the login it belongs to. Needs-you raised counts AUTOPILOT_PARK lines workers printed; answered counts answers recorded through the digest. Starts before workers recorded their desk commit and levers show as not recorded.');
  return out;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };

// ---- CLI -----------------------------------------------------------------------------------------
const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  try {
    if (args[0] === 'spawn-line') {
      const ticket = opt('--ticket');
      const session = opt('--session');
      if (!ticket || !session) { console.error('usage: phase0-report.mjs spawn-line --ticket <KEY> --session <id> [--stage <s>] [--model <m>] [--effort <e>] [--system-bytes <n>] [--prompt-bytes <n>] [--log <worker log>]'); process.exit(2); }
      const start = { session, stage: opt('--stage'), model: opt('--model'), effort: opt('--effort') };
      if (opt('--log')) { try { appendFileSync(opt('--log'), spawnEvent(start)); } catch { /* a record that cannot be written never stops a spawn */ } }
      console.log(spawnLine({ ticket, ...start, systemBytes: opt('--system-bytes'), promptBytes: opt('--prompt-bytes') }));
    } else if (args.includes('--per-ticket')) {
      const usage = 'usage: phase0-report.mjs --per-ticket [--json] [--days <n> | --since <iso> [--until <iso>]] [--no-ci]';
      const until = opt('--until') == null ? Date.now() : Date.parse(opt('--until'));
      const days = opt('--days') == null ? 7 : Number(opt('--days'));
      const since = opt('--since') == null ? until - days * DAY_MS : Date.parse(opt('--since'));
      if (!(days > 0) || !Number.isFinite(since) || !Number.isFinite(until) || since >= until || (opt('--since') != null && opt('--days') != null)) {
        console.error(usage); process.exit(2);
      }
      console.log(JSON.stringify(perTicket({ since, until, ci: !args.includes('--no-ci') }), null, 2));
    } else {
      const days = opt('--days') == null ? 7 : Number(opt('--days'));
      if (!(days > 0) || args.some((a) => ['--json', '--since', '--until'].includes(a))) {
        console.error('usage: phase0-report.mjs [--days <n>] [--no-ci]   (--json, --since and --until go with --per-ticket)'); process.exit(2);
      }
      for (const l of report({ days, ci: !args.includes('--no-ci'), usageFiles: [probeLog()] })) console.log(l);
    }
  } catch (e) {
    console.error(`phase0-report: ${e.message}`);
    process.exit(e instanceof E.DeskConfigError ? 4 : 1);
  }
}
