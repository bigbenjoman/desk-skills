// The levers controller's daily evaluation: once a day, in every repo whose levers row reads `auto`,
// each trialled lever on trial, adopted or reverted is weighed on its tickets' outcomes and adopted,
// reverted, settled or held. A quality-risk lever on trial adopts only once a blind audit of its merged
// PRs is recorded in that repo and none due is still waiting (levers-audit.mjs), at the layer's 40 per
// arm; so does a pair trial of two quality-risk levers kept alone (levers-auto.mjs pairTrial), weighed
// on the cost bound and the guardrails, which on an adopt becomes the repo's default. The mechanism metric and the cost ratio pool every such repo's tickets
// (cost through a Student-t fit of log cost with repo and size as covariates); the guardrails are
// judged per repo, so a harm in one repo cannot hide in the pool. Every interval and probability is
// read from a seeded bootstrap of the per-ticket rows, so the same inputs give the same decision.
//
// The rule (lever-registry.mjs DECISION_RULE): an adopt needs the mechanism better by its registered
// minimum with 90% probability, the cost ratio's 90% upper bound under 1.05, every repo guardrail
// within its margin and complete outcome files, on at least the layer's minimum tickets per arm in the
// repo. A guardrail worse than its margin with 90% probability reverts the lever in that repo from
// `revert_min_per_arm` per arm, before the minimum. At the maximum sample a lever that cannot adopt
// reverts. A lever changes state at most once per repo every `cooldown_days`; a second revert freezes
// it in that repo and raises one needs-you item. An adopted lever settles once its holdback ends with
// no guardrail breached. A ticket counts once its outcome is in (merged, done, parked or failed);
// one listed as a pin mismatch, with an incomplete cost, or run on lever code other than the code
// installed now (its recorded fingerprint) is left out and counted as excluded.
//
// A lever with more than two arms (lever-registry.mjs `values`) on trial is weighed value by value, each
// against its baseline arm, by the same rule, but with the mechanism's probability corrected for the k
// values weighed at once (Bonferroni): each must clear 1 - (1 - p) / k, p the rule's probability, so a
// lever with one value beside its baseline is weighed as an on/off one. A guardrail breach on any value
// reverts the lever to its baseline, whatever another value shows; otherwise it adopts the value with the
// best mechanism estimate among those every adopt condition holds for, carried as the transition's
// `value`, and it reverts at the maximum sample only once no value can adopt. Its row holds each value's
// figures under `values`, the probability each needed as `p_required`, and the leading value's figures
// at the top level.
//
// It writes, under ~/.desk-autopilot/<slug>/: one lever-evals.jsonl row per lever evaluated, whatever
// the decision; the rows each evaluation used in levers-evidence/<eval_id>.jsonl (kept 180 days), whose
// sha256 the row holds; and transition, fp_reset, evidence_incomplete and needs_you events in the lever
// log, with each adopt and revert logged as a taken call in decisions.jsonl (lever-changes.mjs). An
// overridden lever is not evaluated. The pooled estimates go once a day to ~/.desk-autopilot/levers/pooled-evals.jsonl, by whichever
// repo's pass takes the machine-wide lock first; that pass evaluates every `auto` repo.
//
// A ticket's recorded fingerprints are read through the recount's map (lever-fp-history.mjs), so one
// recorded before a lever's fingerprint covered only its part counts where that part is today's.
//
//   import { evaluate, evaluateDue, recount } from './levers-evaluate.mjs'
//   node levers-auto.mjs evaluate                      runs it now if today's has not run
//   node levers-evaluate.mjs --recount [--dry-run]     counts each lever's latest evidence again (recount)
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { REGISTRY, DECISION_RULE, GUARDRAILS, leverFingerprints, isValued } from './lever-registry.mjs';
import { appendWith, isStateChange, read, stampAfter, spendsNeedsYou } from './lever-log.mjs';
import { leverStatesIn, trialId, holdbackEnd, pairTrial, ACTOR } from './levers-auto.mjs';
import { recordLeverDecision } from './lever-changes.mjs';
import { tryLock, unlock } from './dir-lock.mjs';
import { seededRandom } from './seeded-random.mjs';
import { bootstrap, costRatio, interval, meanDiff, rateRatio, seedOf } from './lever-stats.mjs';
import { guardrailStatus, leversDir, autopilotRoot, readJsonl } from './levers-view.mjs';
import { findingsPath, runsPath, stillMissing } from './findings.mjs';
import { postMergePath, readPostMerge } from './post-merge.mjs';
import { parkedHours, liveOf, batchIdentity } from './stuck-time.mjs';
import { perTicket, allBatches, failedRuns } from './phase0-report.mjs';
import { everyTicket } from './queue-store.mjs';
import { readQueue } from './batch-state.mjs';
import { readAsks } from './ask-ledger.mjs';
import { fold, ASK_TOKEN_STEPS } from './ticket-ledger.mjs';
import { ledgerTarget } from './queue-ledger.mjs';
import { quantile } from './quantile.mjs';
import { fpMapFile, readFpMap, mapFp, historyMap, writeFpMap } from './lever-fp-history.mjs';
import { readInstalled } from './installed.mjs';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
export const EVIDENCE_KEEP_DAYS = 180;
// The states the evaluation weighs; a settled, frozen or off lever is not evaluated.
export const EVALUATED = Object.freeze(['trial', 'adopted', 'reverted']);
// Queue states in which a ticket's outcome is in.
const OUTCOME_STATES = Object.freeze(['done', 'parked', 'failed']);
// Park classes the parks guardrail does not count (the registry's `excludes`).
const PARK_EXCLUDES = GUARDRAILS['fix-tries-parks'].excludes;

export const evalsFile = (state) => join(state, 'lever-evals.jsonl');
export const evidenceDir = (state) => join(state, 'levers-evidence');
export const pooledFile = (root = autopilotRoot()) => join(leversDir(root), 'pooled-evals.jsonl');
const snake = (k) => k.replace(/-/g, '_');
// The reason code a revert on guardrail `name` is logged under.
const guardCode = (name) => `guardrail_${snake(String(name))}`;
const dayOf = E.localDay;
const fin = (v) => (Number.isFinite(v) ? v : 0);
const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);

// ---- what a row measures -----------------------------------------------------------------------------
const bytesStarts = (r) => (r.start_records ?? []).filter((s) => Number.isFinite(s.system_bytes) && Number.isFinite(s.prompt_bytes));
// Each trialled lever's mechanism metric as a rate: the sum of `num` over the sum of `den` per arm.
export const MECHANISMS = Object.freeze({
  preflight: { num: (r) => r.preflight_cost, den: (r) => r.starts },
  wrappers: { num: (r) => r.denials, den: (r) => r.starts },
  memory: { num: (r) => bytesStarts(r).reduce((n, s) => n + s.system_bytes + s.prompt_bytes, 0), den: (r) => bytesStarts(r).length },
  'failure-class': { num: (r) => r.fix_tries, den: () => 1 },
  codex: { num: (r) => r.codex_dead, den: (r) => r.review_rounds },
  'review-reuse': { num: (r) => r.review_rounds, den: () => 1 },
  effort: { num: (r) => r.cost, den: (r) => r.starts },
  'finder-model': { num: (r) => r.cost, den: (r) => r.starts },
  // Dollars at list prices over every measured step of the ticket's asks (withAsks), per asking ticket.
  'question-handling': { num: (r) => r.ask_usd, den: () => 1 },
  'handoff-threshold': { num: (r) => r.cost, den: () => 1 },
});

// The tickets a lever is weighed on, by the registry's `rows`: every ticket unless it names some.
const ASKING = 'tickets that raised an ask';
const ROW_FILTERS = Object.freeze({
  [ASKING]: (r) => r.asks > 0,
});
const rowFilter = (reg) => (reg?.rows ? ROW_FILTERS[reg.rows] ?? (() => false) : () => true);
// Of those, the tickets its decision counts toward the sample and weighs: an asking ticket only once
// its asks' dollars are whole. One whose cost is still incomplete shows in the ask report alone, so
// tickets with no priced ask can never make up an arm's minimum.
const weighable = (reg) => (reg?.rows === ASKING ? (r) => Number.isFinite(r.ask_usd) : () => true);

// ---- the blind audit ---------------------------------------------------------------------------------
// The audit queue states of an audit due and not yet recorded (levers-audit.mjs); a failed one is not
// coming.
const AUDIT_PENDING = Object.freeze(['queued', 'deferred', 'starting', 'running', 'recording']);
// A repo's audits (levers-audit.mjs's audit.jsonl and audit-queue.json in its state folder).
//   -> { rows: [audit row], items: [queue item], newest: ms | null }
export function auditsOf(state) {
  const rows = readJsonl(join(state, 'audit.jsonl')).rows;
  let items = [];
  try { items = Object.values(JSON.parse(readFileSync(join(state, 'audit-queue.json'), 'utf8')).items ?? {}); } catch { /* none queued */ }
  const ats = rows.map((r) => Date.parse(r.at)).filter(Number.isFinite);
  return { rows, items, newest: ats.length ? Math.max(...ats) : null };
}
// A quality-risk trial's audits in one repo: how many are recorded with their review's counts, and how
// many are due and not. An audit that ended with no findings line (levers-audit.mjs findings_missing)
// measured nothing, so it is not counted as recorded.
const auditCount = (a, id) => ({
  recorded: a.rows.filter((x) => x.trial_id === id && !x.findings_missing && Number.isInteger(x.p0)).length,
  pending: a.items.filter((i) => i.trial_id === id && AUDIT_PENDING.includes(i.state)).length,
});
// The share of the repo's tickets admitted in the 7 days to `now` that carried every one of `levers`.
function shareOf(events, levers, now) {
  const assigns = (events ?? []).filter((e) => e.kind === 'assign' && Date.parse(e.at) >= now - WEEK_MS && Date.parse(e.at) <= now);
  return assigns.length ? r4(assigns.filter((e) => levers.every((l) => (e.set ?? []).includes(l))).length / assigns.length) : null;
}

// Each guardrail's per-ticket value (null when not recorded), and how the arms compare against its
// margin: `diff` the on arm's mean less the off arm's, worse below the margin; `ratio` on over off,
// worse above it.
const parksCounted = (r) => Object.entries(r.parks_by_class ?? {}).filter(([c]) => !PARK_EXCLUDES.includes(c)).reduce((n, [, v]) => n + v, 0);
export const GUARDS = Object.freeze({
  acceptance: { kind: 'diff', margin: -GUARDRAILS.acceptance.margin.max_drop_points / 100, value: (r) => (r.merged_at ? 1 : 0) },
  'fix-tries-parks': { kind: 'ratio', margin: GUARDRAILS['fix-tries-parks'].margin.max_rate_ratio, value: (r) => (Number.isFinite(r.fix_tries) ? r.fix_tries + parksCounted(r) : null) },
  'ci-reds': { kind: 'ratio', margin: GUARDRAILS['ci-reds'].margin.max_rate_ratio, value: (r) => (Number.isFinite(r.ci_reds) ? r.ci_reds : null) },
  'review-p0-p1': { kind: 'ratio', margin: GUARDRAILS['review-p0-p1'].margin.max_rate_ratio, value: (r) => r.review_p0_p1 ?? null },
  'post-merge': { kind: 'ratio', margin: GUARDRAILS['post-merge'].margin.max_rate_ratio, value: (r) => r.post_merge ?? null },
  'parked-hours': { kind: 'ratio', margin: GUARDRAILS['parked-hours'].margin.max_rate_ratio, value: (r) => (Number.isFinite(r.parked_hours) ? r.parked_hours : null) },
  // A lever's own guardrails, their margins from the registry entry declaring them.
  interruptions: { kind: 'ratio', margin: ownGuardrail('interruptions')?.margin.max_rate_ratio ?? null, value: (r) => (Number.isFinite(r.interruptions) ? r.interruptions : null) },
});

// A guardrail of a lever's own (lever-registry.mjs `guardrails`), from whichever entry declares it.
function ownGuardrail(name) {
  return Object.values(REGISTRY).map((l) => l.guardrails?.[name]).find((g) => g && !Object.hasOwn(GUARDRAILS, name)) ?? null;
}
const guardMetric = (name) => GUARDRAILS[name]?.metric ?? ownGuardrail(name)?.metric ?? name;

// ---- asks ------------------------------------------------------------------------------------------------
// The token kinds summed over an ask's steps (ticket-ledger.mjs ASK_TOKEN_STEPS).
const TOKEN_KINDS = ['input', 'output', 'cache_read', 'cache_write'];
// The token records an ask needs before its cost is whole: the parked round's once raised, the
// round's that acted once acted, and its presentation's where a decider or the person's session (or
// shell) answered it. A push or a digest costs no tokens.
function wantedSteps(a) {
  const want = [];
  if (a.raised_at) want.push('raise:log');
  if (a.presented?.some((p) => p.via === 'decider')) want.push('present:decider');
  if (a.answered?.by === 'person') want.push(a.answered.session ? 'present:session' : 'present:shell');
  if (a.acted) want.push('act:log');
  return want;
}
// One ticket's asks (ask-ledger.mjs readAsks records) as the evaluation reads them: their count, their
// dollars and tokens by step, its interruptions, how many were answered and by default, and each
// answer's latency. Interruptions count notifications: a push is one; a digest listing is the `share`
// of that digest's one push it was written with (digest.mjs presentAsks: 1 over the fresh, unpushed
// parks of every repo on its page, 0 for one pushed already or with no push sent). A listing written
// with no share counts none, as does any listing of an ask pushed already. A step with a record that is incomplete or
// unpriced, or a record still missing, makes its figure null, and the ticket's dollars null with it,
// so the ticket leaves the mechanism as a ticket with an incomplete cost does, never read as 0.
function askFigures(asks) {
  const steps = Object.fromEntries(ASK_TOKEN_STEPS.map((k) => [k, { tokens: 0, usd: 0 }]));
  let pushes = 0, digests = 0, interruptions = 0, answered = 0, defaulted = 0;
  const latencies = [];
  for (const a of asks) {
    for (const want of wantedSteps(a)) if (!a.tokens?.[want]) steps[want.split(':')[0]] = { tokens: null, usd: null };
    for (const t of Object.values(a.tokens ?? {})) {
      const st = steps[t.step];
      if (!st || st.usd == null) continue;
      if (t.complete !== true || !Number.isFinite(t.usd) || TOKEN_KINDS.some((k) => !Number.isFinite(t[k]))) { steps[t.step] = { tokens: null, usd: null }; continue; }
      st.tokens += TOKEN_KINDS.reduce((n, k) => n + t[k], 0);
      st.usd = Math.round((st.usd + t.usd) * 1e6) / 1e6;
    }
    const pushed = (a.presented ?? []).filter((p) => p.via === 'push').length;
    const listed = (a.presented ?? []).filter((p) => p.via === 'digest');
    pushes += pushed;
    digests += listed.length;
    interruptions += pushed + (pushed ? 0 : listed.reduce((n, p) => n + (Number.isFinite(p.share) ? p.share : 0), 0));
    if (a.answered) {
      answered += 1;
      if (a.answered.by === 'default') defaulted += 1;
      if (Number.isFinite(a.answered.latency_s)) latencies.push(a.answered.latency_s);
    }
  }
  const whole = ASK_TOKEN_STEPS.every((k) => steps[k].usd != null);
  return {
    asks: asks.length, ask_usd: whole ? Math.round(ASK_TOKEN_STEPS.reduce((n, k) => n + steps[k].usd, 0) * 1e6) / 1e6 : null, ask_steps: steps,
    pushes, digests, interruptions: Math.round(interruptions * 1e4) / 1e4, answered, defaulted, latencies,
  };
}

// Each row with its ticket's asks from the repo's ticket ledger (beside the queue of `batches`' first
// live batch): every ask of its key raised since it was admitted. A ledger that cannot be read leaves
// every row's `asks` null, so none counts as an asking ticket.
function withAsks(rows, batches) {
  const queue = batches.find((b) => b.queue && !b.archived)?.queue;
  let all = null;
  try { if (queue) all = readAsks(fold(ledgerTarget(queue).repoDir)); } catch { all = null; }
  if (!all) return rows.map((r) => ({ ...r, asks: null }));
  const byKey = new Map();
  for (const a of all) { if (!byKey.has(a.key)) byKey.set(a.key, []); byKey.get(a.key).push(a); }
  return rows.map((r) => {
    const from = Date.parse(r.admitted_at ?? '');
    const mine = (byKey.get(r.key) ?? []).filter((a) => !Number.isFinite(from) || !(Date.parse(a.since) < from));
    return { ...r, ...askFigures(mine) };
  });
}

// Per arm of `rows` (a lever's asking tickets, each with its `arm`, else on or off), what its asks cost
// and how they reached the person: tokens and dollars per ticket by step (over the tickets whose step
// was whole), pushes and digest presentations per ticket, the share of answered asks answered by
// default, and the median answer latency in seconds.
// `rows` by arm (its `arm`, else on or off), sorted, each arm's rows given to `report`; and a mean per ticket.
function byArm(rows, report) {
  const by = new Map();
  for (const r of rows) { const k = r.arm ?? (r.on ? 'on' : 'off'); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return Object.fromEntries([...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([arm, rs]) => [arm, report(rs)]));
}
const per = (rs, f) => (rs.length ? r4(rs.reduce((n, r) => n + f(r), 0) / rs.length) : null);
function askReport(rows) {
  return byArm(rows, (rs) => {
    const answered = rs.reduce((n, r) => n + (r.answered ?? 0), 0);
    return {
      tickets: rs.length, asks: rs.reduce((n, r) => n + (r.asks ?? 0), 0),
      steps: Object.fromEntries(ASK_TOKEN_STEPS.map((k) => {
        const whole = rs.filter((r) => r.ask_steps?.[k]?.usd != null);
        return [k, { tokens_per_ticket: per(whole, (r) => r.ask_steps[k].tokens), usd_per_ticket: per(whole, (r) => r.ask_steps[k].usd), tickets: whole.length }];
      })),
      pushes_per_ticket: per(rs, (r) => r.pushes ?? 0), digests_per_ticket: per(rs, (r) => r.digests ?? 0),
      defaulted_share: answered ? r4(rs.reduce((n, r) => n + (r.defaulted ?? 0), 0) / answered) : null,
      median_latency_s: quantile(rs.flatMap((r) => r.latencies ?? []), 0.5),
    };
  });
}

// Per value of `rows` (a valued lever's tickets, each with its `arm`; in a holdback, `adopted` read as the
// adopted `value` and `holdback` as the `baseline`), the tickets, dollars per ticket and handoffs to a
// fresh session per ticket: what the handoff-threshold lever's row shows for each value.
export function handoffReport(rows, value, baseline) {
  const named = rows.map((r) => {
    const a = r.pin?.arms?.[r.lever] ?? r.arm;
    return a === 'adopted' && value ? { ...r, arm: value } : a === 'holdback' ? { ...r, arm: baseline } : r;
  });
  return byArm(named, (rs) => ({ tickets: rs.length, usd_per_ticket: per(rs, (r) => fin(r.cost)), handoffs_per_ticket: per(rs, (r) => fin(r.handoffs)) }));
}

// ---- outcome files -----------------------------------------------------------------------------------
// Each row with its review P0 and P1 count (from its findings file) and its post-merge records (from
// its batch's post-merge.jsonl). A merged ticket whose file is missing, or whose post-merge file's
// latest scan did not complete, gets null, and the file is named in its `outcome_missing`. Its
// `parked_hours` are its hours stuck from its admission to `now` (stuck-time.mjs, the repo's
// stuck-intervals.jsonl, its batch named as the pass named it, an archived one's interval still open
// closed at its last pass), 0 with none recorded, null where that file cannot be read.
//   -> { rows, newest: { findings, post_merge } }, the newest as ms
export function withOutcomes(rows, batches, now = Date.now()) {
  const stateOf = new Map(batches.map((b) => [b.name ?? null, b.state]));
  const batchOf = new Map(batches.map((b) => [b.name ?? null, b]));
  const postMerge = new Map();
  const stuck = new Map();
  const live = liveOf(batches);
  let newestFindings = null;
  let newestScan = null;
  const out = rows.map((r) => {
    const state = stateOf.get(r.batch ?? null);
    if (!state) return { ...r, review_p0_p1: null, post_merge: null, parked_hours: null };
    const b = batchOf.get(r.batch ?? null);
    const repoState = b.repoState ?? E.repoStateOf(state);
    if (!stuck.has(repoState)) stuck.set(repoState, parkedHours(repoState, { now, live }));
    const from = Date.parse(r.admitted_at ?? '');
    // The batch as its passes recorded it (its identity), or by its name where it has none.
    const id = b.archived ? { name: b.archived, created: b.created ?? null } : batchIdentity(state) ?? { name: b.name ?? null, created: null };
    const parked = stuck.get(repoState)?.(id.name, id.created, r.key, Number.isFinite(from) ? from : -Infinity) ?? null;
    const missing = [];
    let review = 0;
    const f = findingsPath(state, r.key);
    const lines = [];
    if (existsSync(f)) {
      try { newestFindings = Math.max(newestFindings ?? 0, statSync(f).mtimeMs); } catch { /* age only */ }
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (!d || typeof d !== 'object') continue;
        lines.push(d);
        if (!d.carried) review += fin(d.p0) + fin(d.p1);
      }
    }
    // A round the recorder noted as missing or unreadable (findings.mjs recordFindings), and never
    // recorded since at its head and round, leaves the count partial: never read as clean. Read
    // whether or not the findings file exists: a ticket whose only round was lost has none.
    const gaps = readJsonl(runsPath(state, r.key)).rows.filter((n) => n.findings_unreadable || (n.findings_missing && stillMissing(lines, n.findings_missing)));
    if (gaps.length) { review = null; missing.push(runsPath(state, r.key)); }
    else if (!existsSync(f) && r.merged_at) { review = null; missing.push(f); }
    if (!postMerge.has(state)) {
      let recs = existsSync(postMergePath(state)) ? readPostMerge(state) : null;
      const scans = (recs ?? []).filter((s) => s.kind === 'scan' && Number.isFinite(Date.parse(s.at)));
      for (const s of scans) newestScan = Math.max(newestScan ?? 0, Date.parse(s.at));
      // A watch whose latest scan could not read its sources has not seen every revert or red main.
      if (recs && scans.at(-1)?.complete !== true) recs = { incomplete: true };
      postMerge.set(state, recs);
    }
    const recs = postMerge.get(state);
    let pm = 0;
    // A red main its workflow has since gone green on (red_recovered) is not the ticket's.
    if (Array.isArray(recs)) {
      const mine = recs.filter((x) => x.ticket === r.key);
      const recovered = new Set(mine.filter((x) => x.kind === 'red_recovered').map((x) => x.run?.id));
      pm = mine.filter((x) => x.kind === 'revert' || (x.kind === 'red_main' && !recovered.has(x.run?.id))).length;
    }
    else if (r.merged_at) { pm = null; missing.push(recs?.incomplete ? `${postMergePath(state)} (its latest scan is incomplete)` : postMergePath(state)); }
    return { ...r, review_p0_p1: review, post_merge: pm, parked_hours: parked, ...(missing.length ? { outcome_missing: missing } : {}) };
  });
  return { rows: out, newest: { findings: newestFindings, post_merge: newestScan } };
}

// ---- which rows a lever's evaluation reads -------------------------------------------------------------
const ARMS = { trial: ['on', 'off'], reverted: ['on', 'off'], adopted: ['adopted', 'holdback'] };
// The arms a lever's evaluation in state `state` reads: a valued lever's values on trial or reverted
// from one, its adopted and holdback arms once adopted.
const armsOf = (l, state) => (isValued(l) && state !== 'adopted' ? l.values : ARMS[state]);
// The arm a row on lever `l` is off on, read in state `state`: a valued lever's baseline on trial or
// reverted from one, else the state's second arm.
const offArm = (l, state) => (isValued(l) && state !== 'adopted' ? l.baseline : armsOf(l, state)?.[1]);
// A ticket requeued after merging (batch-state.mjs reworked: its row's `reworked`) has no outcome until its
// current round finishes: merged_at keeps only its first merge.
export const outcomeIn = (r) => !r.reworked && (!!r.merged_at || OUTCOME_STATES.includes(r.state));

// The fingerprints of a lever's code a row ran on: its starts' records, else its pin's at admission,
// each read through the recount's map (lever-fp-history.mjs) as that code's part-only fingerprint.
function rowFps(r, lever, map) {
  const starts = (r.start_records ?? []).map((s) => s.lever_fp?.[lever]).filter(Boolean);
  const p = r.pin?.fp?.[lever];
  return (starts.length ? starts : p ? [p] : []).map((x) => mapFp(map, lever, x));
}

// Why a row is left out of a lever's evidence, or null. `map` is the recount's fingerprint map.
export function excludedWhy(r, lever, fp, map = null) {
  if (r.pin_mismatch) return 'pin_mismatch';
  if (r.cost_complete !== true || !Number.isFinite(r.cost)) return 'cost_incomplete';
  if (fp && rowFps(r, lever, map).some((x) => x !== fp)) return 'fp_reset';
  return null;
}

// The rows of one repo's evaluation of `lever` in state `s`: those whose ticket drew one of the
// state's arms under its trial id and whose outcome is in, each with `on` and `excluded`. A valued
// lever's row carries its `arm` too, and is `on` on any value but the baseline; valueRows pairs each
// value with the baseline.
export function leverRows(rows, slug, lever, s, fp, registry = REGISTRY, map = null) {
  const arms = armsOf(registry[lever], s.state);
  const valued = isValued(registry[lever]) && s.state !== 'adopted';
  const off = offArm(registry[lever], s.state);
  const keep = rowFilter(registry[lever]);
  const drew = rows.filter((r) => arms.includes(r.pin?.arms?.[lever]) && keep(r));
  let id;
  if (s.state === 'reverted') {
    // The trial it was reverted from: the latest trial id its tickets drew under.
    id = [...drew].sort((a, b) => Date.parse(a.admitted_at) - Date.parse(b.admitted_at)).at(-1)?.pin?.trial_ids?.[lever] ?? null;
  } else id = trialId(slug, lever, s);
  return drew.filter((r) => r.pin?.trial_ids?.[lever] === id && outcomeIn(r))
    .map((r) => ({ ...r, slug: r.slug ?? slug, on: r.pin.arms[lever] !== off, ...(valued ? { arm: r.pin.arms[lever] } : {}), excluded: excludedWhy(r, lever, fp, map) }));
}
// A valued lever's rows on `value` against its `baseline`, `on` marking the value's.
const valueRows = (rows, value, baseline) => rows.filter((r) => r.arm === value || r.arm === baseline).map((r) => ({ ...r, on: r.arm === value }));

// ---- estimates -------------------------------------------------------------------------------------------
const strata = (rows) => {
  const g = new Map();
  for (const r of rows) { const k = `${r.slug}|${r.on}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  return [...g.keys()].sort().map((k) => g.get(k));
};
const counts = (rows) => ({ on: rows.filter((r) => r.on).length, off: rows.filter((r) => !r.on).length });

// The mechanism effect over `rows`: the on arm's rate relative to the off arm's (-0.6 is 60% lower),
// with its interval and the probability it is lower by at least the lever's minimum.
export function mechanismEstimate(rows, lever, { seed, scope, registry = REGISTRY }) {
  const m = MECHANISMS[lever];
  const reg = registry[lever];
  const minimum = reg.mechanism.minimum;
  const num = (r) => fin(m.num(r));
  const den = (r) => (Number.isFinite(m.num(r)) ? fin(m.den(r)) : 0);
  const rel = (rs) => { const x = rateRatio(rs, num, den); return x == null ? null : x - 1; };
  const draws = bootstrap(strata(rows), rel, { random: seededRandom(seedOf(seed)) });
  const iv = interval(draws, (d) => minimum != null && d <= -minimum);
  return {
    metric: reg.mechanism.metric, unit: 'ratio', min_benefit: minimum == null ? null : -minimum,
    est: r4(rel(rows)), lo90: r4(iv.lo90), hi90: r4(iv.hi90), p_benefit: minimum == null ? null : r4(iv.p), scope,
  };
}

// The cost ratio on against off over `rows`, from the Student-t fit, with its interval and each arm's
// mean dollars per ticket.
export function costEstimate(rows, { seed, scope }) {
  const fit = (rs) => costRatio(rs.map((r) => ({ cost: r.cost, on: r.on, repo: r.slug, size: r.size })));
  const draws = bootstrap(strata(rows), fit, { random: seededRandom(seedOf(seed)) });
  const iv = interval(draws);
  const mean = (xs) => (xs.length ? r4(xs.reduce((n, r) => n + r.cost, 0) / xs.length) : null);
  return {
    ratio: r4(fit(rows)), lo90: r4(iv.lo90), hi90: r4(iv.hi90), margin: DECISION_RULE.cost_ratio_max,
    usd_per_admitted: { on: mean(rows.filter((r) => r.on)), off: mean(rows.filter((r) => !r.on)) }, scope,
  };
}

// Each guardrail over one repo's rows: estimate, interval, the probability it is worse than its
// margin, and its status as the Levers view words it.
export function guardrailEstimates(rows, { seed, minN, names = Object.keys(GUARDRAILS) }) {
  const n = Math.min(counts(rows).on, counts(rows).off);
  return Object.entries(GUARDS).filter(([name]) => names.includes(name)).map(([name, g]) => {
    const have = rows.filter((r) => g.value(r) != null);
    const stat = g.kind === 'diff' ? (rs) => meanDiff(rs, g.value) : (rs) => rateRatio(rs, g.value);
    const est = stat(have);
    if (est == null) return { name, scope: 'repo', est: null, lo90: null, hi90: null, margin: g.margin, p_worse: null, status: 'no_data' };
    // A ratio over an off arm with none to divide by has no figure yet: too early, never a breach.
    if (!Number.isFinite(est)) return { name, scope: 'repo', est: null, lo90: null, hi90: null, margin: g.margin, p_worse: null, status: 'too_early' };
    const worse = g.kind === 'diff' ? (d) => d < g.margin : (d) => d > g.margin;
    const iv = interval(bootstrap(strata(have), stat, { random: seededRandom(seedOf(`${seed}|${name}`)) }), worse);
    const out = { name, scope: 'repo', est: r4(est), lo90: r4(iv.lo90), hi90: r4(iv.hi90), margin: g.margin, p_worse: r4(iv.p) };
    return { ...out, status: guardrailStatus(out, n, minN) };
  });
}

// ---- the decision ----------------------------------------------------------------------------------------
const NO_FIGURE = 'no figure yet';
const pct = (v) => (v == null ? NO_FIGURE : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
const x2 = (v) => (v == null ? NO_FIGURE : `${v.toFixed(2)}×`);
const fig = (v) => (Number.isFinite(v) ? v : NO_FIGURE);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// The states of a lever desk turned off. A recount never turns one back on: it asks Ben instead.
const TURNED_OFF = Object.freeze(['reverted', 'frozen']);
// The guardrail a logged revert `e` names, where it reverted on one with no estimate: an earlier
// evaluation read a check with no figure as breached. Such a revert is void; null for any other event.
const voidedBy = (e) => (e?.kind === 'transition' && TURNED_OFF.includes(e.to)
  ? (e.guardrails ?? []).find((g) => guardCode(g.name) === e.reason_code && g.est == null) ?? null : null);
// A guardrail with no figure: none to divide by, or no rows to measure. It never stands in the way of
// an adopt as a failure does.
const noFigure = (g) => g.est == null && ['too_early', 'no_data'].includes(g.status);

// How many times repo log `events` have reverted `lever` (an evaluation's transition or a trip), and the
// state its next revert goes to: a lever already reverted once is frozen instead. A void revert does
// not count.
export const priorRevertsOf = (events, lever) => (events ?? [])
  .filter((e) => ['transition', 'trip'].includes(e.kind) && e.lever === lever && TURNED_OFF.includes(e.to) && !voidedBy(e)).length;
export const revertTarget = (priorReverts) => (priorReverts >= 1 ? 'frozen' : 'reverted');
// The recount's needs-you item for `lever` among a repo's log `events` that no later change has
// answered, or null.
function recountWaiting(events, lever) {
  const es = events ?? [];
  return es.filter((e, i) => e.kind === 'needs_you' && e.lever === lever && e.reason_code === 'recount_review'
    && !es.slice(i + 1).some((x) => spendsNeedsYou(e, x))).at(-1) ?? null;
}
// The needs-you item a freeze raises, for `lever` in repo `name`, `why` being what reverted it.
export const frozenText = (lever, name, why) => `${lever} is frozen in ${name} after its second revert (${why}): it stays off there until you set it by hand`;
// The needs-you item a void revert `e` raises, for `lever` in repo `name`, `g` the guardrail it named.
const voidedText = (lever, name, e, g) => `${lever} was turned off in ${name} on ${String(e.at).slice(0, 10)} because ${guardMetric(g.name)} read as worse, `
  + `but that check had ${NO_FIGURE}: the tickets with ${lever} off had none to compare against, so the revert no longer counts. Keep ${lever} off, or test it again?`;

// Raises one needs-you item for each void revert in repo `r`'s log while it is still its lever's latest
// change there, and never twice for one revert.
function raiseVoided(r, at, written) {
  for (const e of r.log.events ?? []) {
    const g = voidedBy(e);
    if (!g) continue;
    const ny = appendWith(r.slug, () => {
      const events = read(r.slug).events;
      if (events.some((x) => x.kind === 'needs_you' && x.revert_id === e.id)) return null;
      if (events.filter((x) => isStateChange(x, e.lever)).at(-1)?.id !== e.id) return null;
      return { kind: 'needs_you', lever: e.lever, actor: ACTOR, reason_code: 'revert_no_figure', at: stampAfter(events, at), revert_id: e.id,
        eval_id: e.eval_id, evidence_file: e.evidence_file, evidence_sha256: e.evidence_sha256, reason: voidedText(e.lever, r.name, e, g) };
    });
    if (ny) written.events.push(ny);
  }
}

// What the evaluation does with one lever in one repo. `n` is the repo's arms, `priorReverts` how many
// times the repo's log has reverted it before, `changedAt` when it last changed state there (ms or
// null). A quality-risk trial passes `audits`, its blind audits in the repo: it adopts only once one is
// recorded and none due is still waiting; `auditP0`, one reverted by a blind audit's P0, never adopts.
// `probability` is what the mechanism's benefit must clear: the rule's, or a valued lever's corrected
// one. A pair trial (`pair`) is weighed on the rule's cost bound and
// guardrails alone, each lever's mechanism having been proven when it was adopted alone.
//   -> { decision, to, reason_code, reason, next }
export function decide({ state, n, minN, maxN, mechanism, cost, guardrails, frozen = false, incomplete = [], changedAt = null, priorReverts = 0, now, holdbackWeeks, audits = null, auditP0 = false, pair = false, probability = DECISION_RULE.probability }) {
  const R = { ...DECISION_RULE, probability };
  const smaller = Math.min(n.on, n.off);
  const earliest = changedAt == null ? now : changedAt + R.cooldown_days * DAY_MS;
  const cooling = now < earliest;
  const next = (needs) => ({ earliest_change: day(Math.max(earliest, now)), needs });
  const hold = (code, reason, needs) => ({ decision: 'hold', to: null, reason_code: code, reason, next: next(needs) });
  const revertTo = revertTarget(priorReverts);
  const sample = `${n.on} vs ${n.off} tickets`;
  if (frozen) return hold('freeze', 'trials are frozen on this computer', 'the freeze lifted (desk-env levers thaw)');

  const breached = state === 'reverted' ? [] : guardrails.filter((g) => g.status === 'breached');
  if (breached.length && smaller >= R.revert_min_per_arm) {
    const g = breached[0];
    const why = `${guardMetric(g.name)} worse than its margin with ${Math.round(g.p_worse * 100)}% probability (${fig(g.est)} against ${g.margin}, 90%: ${fig(g.lo90)} to ${fig(g.hi90)}) at ${sample}`;
    if (cooling) return hold('change_cooldown', `would revert (${why}), but it changed state less than ${R.cooldown_days} days ago`, `the ${R.cooldown_days}-day wait to pass`);
    return { decision: 'revert', to: revertTo, reason_code: guardCode(g.name), reason: why, next: next(null) };
  }
  if (state === 'adopted') {
    if (incomplete.length) return hold('evidence_incomplete', `outcome files missing: ${incomplete.join(', ')}`, 'the missing outcome files');
    // A breach on too small a holdback arm to revert on neither reverts nor lets the lever settle.
    if (breached.length) return hold('holdback_running', `${breached.map((g) => g.name).join(', ')} breached at ${sample}, below the ${R.revert_min_per_arm} per arm a revert needs, so it does not settle`, `${R.revert_min_per_arm - smaller} more tickets in the smaller arm`);
    if (changedAt != null && now >= holdbackEnd(changedAt, holdbackWeeks)) {
      return { decision: 'settle', to: 'settled', reason_code: 'holdback_ended', reason: `the ${holdbackWeeks}-week holdback ended with no guardrail breached (${sample})`, next: next(null) };
    }
    return hold('holdback_running', `adopted; the holdback runs to ${changedAt == null ? '?' : day(holdbackEnd(changedAt, holdbackWeeks))}`, 'the holdback to end');
  }
  if (incomplete.length) return hold('evidence_incomplete', `outcome files missing, so nothing adopts: ${incomplete.join(', ')}`, 'the missing outcome files');
  if (smaller < minN) return hold('below_min_sample', `${smaller} of ${minN} tickets in the smaller arm`, `${minN - smaller} more tickets in the smaller arm`);

  const unmet = [];
  if (pair) { /* no mechanism of its own */ } else if (mechanism.min_benefit == null) unmet.push(`${mechanism.metric} has no registered minimum`);
  else if (!(mechanism.p_benefit >= R.probability)) unmet.push(`${mechanism.metric} ${pct(mechanism.est)} (90%: ${pct(mechanism.lo90)} to ${pct(mechanism.hi90)}) is ${pct(mechanism.min_benefit)} or better with only ${Math.round((mechanism.p_benefit ?? 0) * 100)}% probability${probability !== DECISION_RULE.probability ? `, under the ${Math.round(probability * 1000) / 10}% each of its values needs` : ''}`);
  if (!(Number.isFinite(cost.hi90) && cost.hi90 < R.cost_ratio_max)) unmet.push(`cost ratio ${x2(cost.ratio)} (90%: ${x2(cost.lo90)} to ${x2(cost.hi90)}) does not rule out ${x2(R.cost_ratio_max)}`);
  const notOk = guardrails.filter((g) => g.status !== 'ok');
  if (notOk.length) unmet.push(`guardrails not within margin: ${notOk.map((g) => `${g.name} ${noFigure(g) ? `has ${NO_FIGURE}` : g.status}`).join(', ')}`);
  const noAudit = !!audits && !(audits.recorded > 0);
  if (noAudit) unmet.push('no blind audit of its merged PRs is recorded in this repo yet');
  if (auditP0) unmet.push('a blind audit found a P0 in a merged PR drawn on for it, which reverted it');

  if (!unmet.length && audits?.pending > 0) {
    return hold('audits_pending', `every other adopt condition holds, but ${audits.pending} blind audit(s) due are not yet recorded`, `the ${audits.pending} due audit(s) to be recorded`);
  }
  if (!unmet.length) {
    const effect = pair ? 'the pair against the kept set' : `${mechanism.metric} ${pct(mechanism.est)} (90%: ${pct(mechanism.lo90)} to ${pct(mechanism.hi90)}) beat the ${pct(mechanism.min_benefit)} minimum`;
    const why = `${effect}; cost ratio ${x2(cost.ratio)} (${x2(cost.lo90)} to ${x2(cost.hi90)}) under ${x2(R.cost_ratio_max)}; ${guardrails.length} guardrails within margin${audits ? `; ${audits.recorded} blind audit(s) recorded` : ''}; ${sample}`;
    if (cooling) return hold('change_cooldown', `every adopt condition holds, but it changed state less than ${R.cooldown_days} days ago`, `the ${R.cooldown_days}-day wait to pass`);
    return { decision: 'adopt', to: 'adopted', reason_code: 'adopt_all_conditions', reason: why, next: next(null) };
  }
  if (state === 'trial' && smaller >= maxN) {
    // A guardrail with no figure is not a failure: when it is all that stands between the lever and an
    // adopt, the lever holds rather than reverts.
    if (unmet.length === 1 && notOk.length && notOk.every(noFigure)) {
      return hold('no_figure_yet', `every other adopt condition holds, but ${unmet[0]} (${sample})`, `a figure for ${notOk.map((g) => g.name).join(', ')}`);
    }
    const noBenefit = !pair && (mechanism.min_benefit == null || !(mechanism.p_benefit >= R.probability));
    if (cooling) return hold('change_cooldown', `would revert at the maximum sample, but it changed state less than ${R.cooldown_days} days ago`, `the ${R.cooldown_days}-day wait to pass`);
    return { decision: 'revert', to: revertTo, reason_code: noBenefit ? 'no_benefit_max_sample' : 'max_sample_no_adopt', reason: `${noBenefit ? 'no benefit at maximum sample' : 'maximum sample reached'}: ${unmet.join('; ')} (${sample})`, next: next(null) };
  }
  return hold(noAudit && unmet.length === 1 ? 'audit_missing' : 'adopt_conditions_unmet', unmet.join('; '), unmet.join('; '));
}

// The value a valued lever's evaluation acts on, from each value's weighing against the baseline
// ({ <value>: { mechanism, d } }): one reverting on a guardrail, which reverts the lever to its
// baseline whatever the others show; else, of those that adopt, the best mechanism estimate (lowest,
// every metric falling); else, once every value reverts at the maximum
// sample, the first; else the best estimate among those holding.
function leadValue(perValue) {
  const all = Object.entries(perValue);
  const best = (xs) => [...xs].sort(([, a], [, b]) => (a.mechanism?.est ?? Infinity) - (b.mechanism?.est ?? Infinity))[0][0];
  const breach = all.find(([, x]) => x.d.decision === 'revert' && x.d.reason_code.startsWith('guardrail_'));
  if (breach) return breach[0];
  const adopts = all.filter(([, x]) => x.d.decision === 'adopt');
  if (adopts.length) return best(adopts);
  const holds = all.filter(([, x]) => x.d.decision !== 'revert');
  return holds.length ? best(holds) : all[0][0];
}

// ---- one evaluation run ----------------------------------------------------------------------------------
// The desk commits a set of rows' starts ran on, first and last by start time; null with none.
function commitRange(rows) {
  const starts = rows.flatMap((r) => r.start_records ?? []).filter((s) => s.desk_commit).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return starts.length ? [starts[0].desk_commit.slice(0, 12), starts.at(-1).desk_commit.slice(0, 12)] : null;
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
// An outcome file as a reason names it: by its path under the repo's state folder `state`, or by its
// file name where it sits outside it. The `missing` lists keep the full paths.
const shortName = (state, p) => {
  const rel = relative(state, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : basename(p);
};
const excludedCounts = (rows) => {
  const out = { pin_mismatch: 0, cost_incomplete: 0, fp_reset: 0 };
  for (const r of rows) if (r.excluded) out[r.excluded] += 1;
  return out;
};

// Evaluates every `auto` repo in `repos` and returns what it wrote. Each repo is { slug, name, state,
// states: { <lever>: 'pinned' | 'auto' | 'off' }, rows, batches }: its per-ticket rows (phase0-report
// perTicket) and its batches' state folders. Writes nothing for a repo already evaluated `today`.
//   -> { day, rows: [eval row], events: [event], pooled: [pooled row] }
export function evaluate({
  repos, now = Date.now(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone, root = autopilotRoot(),
  frozen = !!E.leversFrozen(), fingerprints = leverFingerprints().fp, registry = REGISTRY, fpMap = readFpMap(root),
}) {
  const today = dayOf(now, tz);
  const at = new Date(now).toISOString();
  const written = { day: today, rows: [], events: [], pooled: [] };
  const levers = Object.keys(registry).filter((l) => registry[l].trialled && MECHANISMS[l]);

  // Each repo's log, lever states and outcome-filled rows, read once.
  const prepared = repos.filter((r) => Object.values(r.states).includes('auto')).map((r) => {
    let log = null;
    let unreadable = null;
    try { log = read(r.slug); if (log.bad.length) unreadable = `line ${log.bad.map((b) => b.line).join(', ')} of its lever log does not parse`; } catch (e) { unreadable = `its lever log, levers.jsonl, cannot be read (${e.code ?? e.message})`; }
    const outcomes = withOutcomes(r.rows, r.batches, now);
    // A lever weighed on asks reads the repo's ticket ledger, once.
    if (levers.some((l) => registry[l].rows === ASKING)) outcomes.rows = withAsks(outcomes.rows, r.batches);
    const prior = readJsonl(evalsFile(r.state)).rows;
    return { ...r, log, unreadable, byLever: log ? leverStatesIn(log.events, registry) : null, outcomes, prior, audits: auditsOf(r.state), done: prior.some((p) => p.at && dayOf(Date.parse(p.at), tz) === today) };
  });

  // Each lever's rows in each repo, and the pooled estimates across repos weighing it as a trial.
  const plan = [];
  for (const r of prepared) {
    if (r.done || r.unreadable) continue;
    for (const lever of levers) {
      if (r.states[lever] !== 'auto') continue;
      const s = r.byLever[lever];
      if (!EVALUATED.includes(s.state)) continue;
      plan.push({ r, lever, s, rows: leverRows(r.outcomes.rows, r.slug, lever, s, fingerprints[lever] ?? null, registry, fpMap) });
    }
  }
  const pooledBy = {};
  for (const lever of levers) {
    const trials = plan.filter((p) => p.lever === lever && p.s.state !== 'adopted');
    if (!trials.length) continue;
    const rows = trials.flatMap((p) => p.rows.filter((x) => !x.excluded && weighable(registry[lever])(x)));
    const seed = `${today}|${lever}|pooled`;
    const pooled = (rs, sd) => ({
      n: counts(rs),
      mechanism: mechanismEstimate(rs, lever, { seed: `${sd}|mechanism`, scope: 'pooled', registry }),
      cost: costEstimate(rs, { seed: `${sd}|cost`, scope: 'pooled' }),
    });
    const reg = registry[lever];
    // A valued lever pools each value against its baseline.
    const est = isValued(reg)
      ? { baseline: reg.baseline, values: Object.fromEntries(reg.values.filter((v) => v !== reg.baseline).map((v) => [v, pooled(valueRows(rows, v, reg.baseline), `${seed}|${v}`)])) }
      : pooled(rows, seed);
    pooledBy[lever] = { v: 1, at, day: today, lever, repos: trials.map((p) => p.r.slug), ...est, rows: trials.flatMap((p) => p.rows) };
  }

  for (const r of prepared) {
    if (r.done) continue;
    if (!r.unreadable) raiseVoided(r, at, written);
    const lines = [];
    for (const lever of levers) {
      if (r.states[lever] !== 'auto') continue;
      const evalId = `evl_${today}_${r.slug}_${lever}`;
      const reg = registry[lever];
      const minN = DECISION_RULE.min_per_arm[reg.layer];
      const base = { v: 1, eval_id: evalId, at, repo: r.slug, lever, layer: reg.layer, min_n: minN, max_n: DECISION_RULE.max_per_arm, lever_fp: fingerprints[lever] ?? null };
      if (r.unreadable) {
        lines.push({ ...base, state: null, decision: 'hold', reason_code: 'state_unreadable', reason: r.unreadable, next: { earliest_change: null, needs: 'the lever log to be fixed' } });
        continue;
      }
      const p = plan.find((x) => x.r === r && x.lever === lever);
      if (!p) {
        // The lever's last weighed evidence stays on its row, so the board keeps its figures.
        const st = r.byLever[lever];
        const last = r.prior.filter((x) => x.lever === lever && x.n).at(-1);
        const kept = last ? { n: last.n, mechanism: last.mechanism, cost: last.cost, guardrails: last.guardrails, evidence_from: last.eval_id, evidence_file: last.evidence_file, evidence_sha256: last.evidence_sha256 } : {};
        lines.push({ ...base, ...kept, state: st.state, decision: 'hold', reason_code: 'not_evaluated', reason: `${lever} is ${st.state} in ${r.name}${st.at ? ` since ${st.at.slice(0, 10)}` : ''}`, next: { earliest_change: null, needs: 'a change by hand' } });
        continue;
      }
      const { s } = p;
      const used = p.rows.filter((x) => !x.excluded);
      const weighed = used.filter(weighable(reg));
      const pooled = s.state === 'adopted' ? null : pooledBy[lever];
      const seed = `${evalId}`;
      // One arm against its comparison: the pooled estimates for a trial, the repo's guardrails.
      const weigh = (rs, pl, sd) => ({
        mechanism: pl ? pl.mechanism : mechanismEstimate(rs, lever, { seed: `${sd}|mechanism`, scope: 'repo', registry }),
        cost: pl ? pl.cost : costEstimate(rs, { seed: `${sd}|cost`, scope: 'repo' }),
        guardrails: guardrailEstimates(rs, { seed: sd, minN, names: Object.keys(reg.guardrails) }),
        n: { ...counts(rs), pooled_on: (pl?.n ?? counts(rs)).on, pooled_off: (pl?.n ?? counts(rs)).off, excluded: excludedCounts(p.rows) },
      });
      const incomplete = [...new Set(used.flatMap((x) => x.outcome_missing ?? []))].sort();
      const named = incomplete.map((f) => shortName(r.state, f));
      const priorReverts = priorRevertsOf(r.log.events, lever);
      const changedAt = s.at ? Date.parse(s.at) : null;
      // A quality-risk lever on trial, or reverted from one, adopts only on audit evidence from this repo
      // for the trial its tickets drew under; one reverted by a blind audit's P0 never adopts again here.
      const quality = reg.layer === 'quality-risk' && ['trial', 'reverted'].includes(s.state);
      const audits = quality ? auditCount(r.audits, s.state === 'trial' ? trialId(r.slug, lever, s) : p.rows[0]?.pin?.trial_ids?.[lever] ?? null) : null;
      const auditP0 = quality && s.state === 'reverted' && (r.log.events ?? []).filter((e) => e.lever === lever && e.id === s.id).some((e) => e.reason_code === 'audit_p0');
      const decideOn = (w, probability) => decide({ state: s.state, n: w.n, minN, maxN: DECISION_RULE.max_per_arm, mechanism: w.mechanism, cost: w.cost, guardrails: w.guardrails, frozen, incomplete: named, changedAt, priorReverts, now, holdbackWeeks: reg.ramp.holdback_weeks, audits, auditP0, probability });
      // A valued lever's values are weighed at once: each clears the rule's probability shared among them.
      const others = isValued(reg) ? reg.values.filter((v) => v !== reg.baseline) : [];
      const pRequired = r4(1 - (1 - DECISION_RULE.probability) / Math.max(1, others.length));
      let w;
      let d;
      let perValue = null;
      if (isValued(reg) && s.state !== 'adopted') {
        // Each value against the baseline; the lead value's figures and decision stand for the lever.
        perValue = Object.fromEntries(others.map((v) => {
          const wv = weigh(valueRows(weighed, v, reg.baseline), pooled?.values?.[v] ?? null, `${seed}|${v}`);
          return [v, { ...wv, d: decideOn(wv, pRequired) }];
        }));
        const value = leadValue(perValue);
        ({ d, ...w } = perValue[value]);
        d = { ...d, reason: `${value} against ${reg.baseline}: ${d.reason}`, value };
      } else {
        w = weigh(weighed, pooled, seed);
        d = decideOn(w);
        // A valued lever keeps the value it was adopted on when it settles.
        if (isValued(reg) && s.value) d = { ...d, value: s.value };
      }
      // A lever desk turned off whose evidence a recount changed is not judged again: Ben decides.
      const waiting = TURNED_OFF.includes(s.state) ? recountWaiting(r.log.events, lever) : null;
      if (waiting) {
        d = { decision: 'hold', to: null, reason_code: 'recount_review', reason: waiting.reason, next: { earliest_change: null, needs: 'your call: keep it off or test it again (levers decide)' }, ...(d.value ? { value: d.value } : {}) };
      }
      const { mechanism, cost, guardrails, n } = w;

      // The evidence this evaluation used: the pooled rows for a lever on trial, else the repo's.
      const evidence = writeEvidence(r.state, evalId, pooled ? pooled.rows : p.rows);
      const share = shareOf(r.log.events, [lever], now);
      const versions = [...new Set(used.flatMap((x) => (x.start_records ?? []).map((st) => st.claude_version)).filter(Boolean))].sort();
      const range = commitRange(used);
      const append = (event) => {
        const e = appendWith(r.slug, () => event);
        if (e) written.events.push(e);
        return e;
      };

      // The lever's own code changed since its last evaluation here.
      const last = r.prior.filter((x) => x.lever === lever && x.lever_fp).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
      if (last && fingerprints[lever] && mapFp(fpMap, lever, last.lever_fp) !== fingerprints[lever]) {
        append({ kind: 'fp_reset', lever, actor: ACTOR, reason_code: 'fp_reset', at, ...evidence, from_fp: last.lever_fp, to_fp: fingerprints[lever],
          dropped: n.excluded.fp_reset, reason: `${lever}'s code fingerprint changed from ${last.lever_fp} to ${fingerprints[lever]}: ${n.excluded.fp_reset} ticket(s) run on the old code are left out and the count restarts` });
      }
      // Incomplete evidence, once while the same files stay missing.
      if (incomplete.length) {
        const lastIncomplete = (r.log.events ?? []).filter((e) => e.kind === 'evidence_incomplete' && e.lever === lever).at(-1);
        const lastRow = r.prior.filter((x) => x.lever === lever).at(-1);
        const same = lastIncomplete && lastRow?.reason_code === 'evidence_incomplete' && JSON.stringify(lastIncomplete.missing) === JSON.stringify(incomplete);
        if (!same) append({ kind: 'evidence_incomplete', lever, actor: ACTOR, reason_code: 'evidence_incomplete', at, ...evidence, missing: incomplete, reason: `${lever} in ${r.name}: nothing adopts while outcome files are missing: ${named.join(', ')}` });
      }

      let to = null;
      if (d.to) {
        const holdback = d.to === 'adopted' ? { share: reg.ramp.holdback, until: day(holdbackEnd(now, reg.ramp.holdback_weeks)) } : undefined;
        const e = appendWith(r.slug, () => {
          // Written only while the lever is still in the state this evaluation read.
          // Stamped after every event already written, so an undo written while this ran replays first.
          const events = read(r.slug).events;
          const nowState = leverStatesIn(events, registry)[lever];
          if (nowState.state !== s.state || nowState.id !== s.id) return null;
          return {
            kind: 'transition', lever, from: s.state, to: d.to, ...(d.value && d.to !== 'reverted' && d.to !== 'frozen' ? { value: d.value } : {}),
            actor: ACTOR, reason_code: d.reason_code, reason: d.reason, ...evidence, at: stampAfter(events, at),
            n, mechanism, cost, guardrails, desk_commit_range: range, lever_fp: fingerprints[lever] ?? null, ...(holdback ? { holdback } : {}),
          };
        });
        if (e) {
          written.events.push(e);
          to = d.to;
          // An adopt or a revert is a call taken without asking: the digest lists it, to be overridden.
          recordLeverDecision([e], { slug: r.slug, repo: r.ghRepo ?? null, state: r.state, registry });
          if (d.to === 'frozen') {
            append({ kind: 'needs_you', lever, actor: ACTOR, reason_code: 'frozen_second_revert', at, ...evidence,
              reason: frozenText(lever, r.name, d.reason) });
          }
        }
      }
      lines.push({
        ...base, state: to ?? s.state, ...(to ? { from: s.state } : {}), arm_share_7d: share, n, mechanism, cost, guardrails,
        decision: to ? d.decision : 'hold', reason_code: d.reason_code, reason: d.to && !to ? `${d.reason}; not written, as the lever changed state while it was evaluated` : d.reason, next: d.next,
        ...(incomplete.length ? { missing: incomplete } : {}), ...(audits ? { audits } : {}),
        ...(reg.rows === ASKING ? { ask_report: askReport(used) } : {}),
        ...(lever === 'handoff-threshold' ? { handoff_report: handoffReport(used.map((x) => ({ ...x, lever })), s.value ?? null, reg.baseline) } : {}),
        ...(perValue ? { value: d.value, baseline: reg.baseline, p_required: pRequired, values: Object.fromEntries(Object.entries(perValue).map(([v, x]) => [v, { n: x.n, mechanism: x.mechanism, cost: x.cost, guardrails: x.guardrails, decision: x.d.decision, reason_code: x.d.reason_code, reason: x.d.reason }])) } : {}),
        ...evidence, desk_commit_range: range, claude_versions: versions, inputs_age_s: inputsAge(r, now),
      });
    }
    // The repo's pair trial, once two quality-risk levers are kept alone.
    const pt = r.unreadable ? null : pairTrial({ slug: r.slug, events: r.log.events, states: r.states, values: null, registry, now });
    if (pt?.state === 'trial') lines.push(evaluatePair({ r, pt, today, at, now, frozen, registry, written }));
    if (lines.length) {
      mkdirSync(r.state, { recursive: true });
      appendFileSync(evalsFile(r.state), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
      written.rows.push(...lines);
    }
    sweepEvidence(r.state, now);
  }

  const pooledLines = Object.values(pooledBy).map(({ rows, ...p }) => p);
  pooledLines.push({ v: 1, at, day: today, lever: null, repos: prepared.map((r) => r.slug), levers: Object.keys(pooledBy) });
  const file = pooledFile(root);
  mkdirSync(leversDir(root), { recursive: true });
  appendFileSync(file, pooledLines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  written.pooled = pooledLines;
  return written;
}

// One repo's evaluation of its pair trial `pt` (levers-auto.mjs pairTrial): its `on` arm carries both
// levers, its `off` arm the kept set as it stood. It adopts on the decision rule's cost bound, every
// guardrail and the audit evidence, at the quality-risk minimum per arm; a breach or the maximum
// sample reverts it. A change is one `pair` event, and the row's `lever` is the pair's key.
function evaluatePair({ r, pt, today, at, now, frozen, registry, written }) {
  const key = pt.key;
  const evalId = `evl_${today}_${r.slug}_${key}`;
  const minN = DECISION_RULE.min_per_arm['quality-risk'];
  const rows = r.outcomes.rows.filter((x) => ['on', 'off'].includes(x.pin?.arms?.[key]) && x.pin?.trial_ids?.[key] === pt.id && outcomeIn(x))
    .map((x) => ({ ...x, slug: x.slug ?? r.slug, on: x.pin.arms[key] === 'on', excluded: excludedWhy(x, null, null) }));
  const used = rows.filter((x) => !x.excluded);
  const cost = costEstimate(used, { seed: `${evalId}|cost`, scope: 'repo' });
  const guardrails = guardrailEstimates(used, { seed: evalId, minN });
  const n = { ...counts(used), excluded: excludedCounts(rows) };
  const incomplete = [...new Set(used.flatMap((x) => x.outcome_missing ?? []))].sort();
  const audits = auditCount(r.audits, pt.id);
  const kept = pt.levers.map((l) => Date.parse(r.byLever[l]?.at)).filter(Number.isFinite);
  const d = decide({ state: 'trial', n, minN, maxN: DECISION_RULE.max_per_arm, mechanism: null, cost, guardrails, frozen, incomplete: incomplete.map((f) => shortName(r.state, f)),
    changedAt: kept.length ? Math.max(...kept) : null, now, holdbackWeeks: registry[pt.levers[0]].ramp.holdback_weeks, audits, pair: true });
  const evidence = writeEvidence(r.state, evalId, rows);
  let to = null;
  if (d.to) {
    const e = appendWith(r.slug, () => {
      // Written only while the same pair trial is still running.
      const events = read(r.slug).events;
      const live = pairTrial({ slug: r.slug, events, states: r.states, values: null, registry, now });
      if (live?.id !== pt.id || live.state !== 'trial') return null;
      return { kind: 'pair', levers: pt.levers, pair: key, trial_id: pt.id, from: 'trial', to: d.to === 'frozen' ? 'reverted' : d.to, actor: ACTOR, reason_code: d.reason_code, reason: d.reason, ...evidence, at: stampAfter(events, at), n, cost, guardrails };
    });
    if (e) { written.events.push(e); to = e.to; }
  }
  return {
    v: 1, eval_id: evalId, at, repo: r.slug, lever: key, pair: pt.levers, layer: 'quality-risk', min_n: minN, max_n: DECISION_RULE.max_per_arm, lever_fp: null,
    state: to ?? 'trial', ...(to ? { from: 'trial' } : {}), trial_id: pt.id, arm_share_7d: shareOf(r.log.events, pt.levers, now), n, mechanism: null, cost, guardrails,
    decision: to ? d.decision : 'hold', reason_code: d.reason_code, reason: d.to && !to ? `${d.reason}; not written, as the pair trial changed while it was evaluated` : d.reason, next: d.next,
    ...(incomplete.length ? { missing: incomplete } : {}), audits, ...evidence, desk_commit_range: commitRange(used), claude_versions: [], inputs_age_s: inputsAge(r, now),
  };
}

// Writes an evaluation's evidence rows to its file in the repo's state folder.
//   -> { eval_id, evidence_file, evidence_sha256 }
function writeEvidence(state, evalId, rows) {
  const body = rows.map(({ on, excluded, ...row }) => `${JSON.stringify(excluded ? { ...row, excluded } : row)}\n`).join('');
  const evidenceFile = `levers-evidence/${evalId}.jsonl`;
  mkdirSync(evidenceDir(state), { recursive: true });
  writeFileSync(join(state, evidenceFile), body);
  return { eval_id: evalId, evidence_file: evidenceFile, evidence_sha256: sha256(body) };
}

// How old, in seconds at `now`, the newest of each input an evaluation of repo `r` read is.
function inputsAge(r, now) {
  const age = (ms) => (ms == null ? null : Math.max(0, Math.round((now - ms) / 1000)));
  return { outcomes: 0, findings: age(r.outcomes.newest.findings), post_merge: age(r.outcomes.newest.post_merge), audit: age(r.audits.newest) };
}

// Removes evidence files older than EVIDENCE_KEEP_DAYS.
function sweepEvidence(state, now) {
  const dir = evidenceDir(state);
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return; }
  for (const f of names) {
    try { if (now - statSync(join(dir, f)).mtimeMs > EVIDENCE_KEEP_DAYS * DAY_MS) rmSync(join(dir, f), { force: true }); } catch { /* the next run tries again */ }
  }
}

// ---- the daily run -----------------------------------------------------------------------------------------
// gh for the evaluation's one read of failed runs, ended after GH_TIMEOUT_MS so a hung call cannot
// hold the pass.
const GH_TIMEOUT_MS = 60_000;
const ghBounded = (args) => spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS });

// The per-ticket rows the evaluation reads for one repo: every row admitted in the evidence window,
// with red CI counted from one list of the repo's failed runs since the earliest admission among the
// tickets on an evaluated arm.
export function repoRows({ slug, ghRepo, now, batches = allBatches(slug), gh = ghBounded }) {
  const since = now - EVIDENCE_KEEP_DAYS * DAY_MS;
  const all = perTicket({ slug, batches, since, until: now, ci: false, repo: ghRepo });
  const armed = all.rows.filter((r) => r.pin?.arms && Object.keys(r.pin.arms).length);
  if (!armed.length) return { rows: all.rows, batches };
  const from = Math.min(...armed.map((r) => Date.parse(r.admitted_at)));
  const ci = failedRuns({ repo: ghRepo, since: from, gh, jobs: false });
  if (ci.unreadable) return { rows: all.rows, batches };
  // The rows name no branch, so red CI is matched through each batch's queue.
  const branchOf = new Map();
  for (const b of batches) {
    try { for (const t of Object.values(everyTicket(readQueue(b.queue)))) if (t.branch) branchOf.set(`${b.name ?? ''}|${t.key}`, t.branch); } catch { /* no queue */ }
  }
  const rows = all.rows.map((r) => {
    const branch = branchOf.get(`${r.batch ?? ''}|${r.key}`);
    return { ...r, ci_reds: branch ? ci.runs.filter((x) => x.branch === branch).length : 0 };
  });
  return { rows, batches };
}

// The evaluation as a pass runs it: at most once a day across every repo on this computer, by whichever
// pass takes the machine-wide lock first; a pass that finds it held, or today's run done, does nothing.
//   -> { status: 'ran' | 'not_due' | 'busy' | 'none', line }
export function evaluateDue({ now = Date.now(), root = autopilotRoot(), configRoot = E.deskConfigRoot(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone, rowsFor = repoRows } = {}) {
  const repos = E.configuredRepos(configRoot).map((c) => {
    let items = null;
    try { items = E.repoConfigValues(c.slug, 'levers', configRoot); } catch { /* read as off */ }
    return { ...c, states: E.rowStates(items) };
  }).filter((c) => Object.values(c.states).includes('auto'));
  if (!repos.length) return { status: 'none', line: null };
  const lock = join(leversDir(root), 'evaluate.lock.d');
  mkdirSync(leversDir(root), { recursive: true });
  if (tryLock(lock) !== true) return { status: 'busy', line: null };
  try {
    const today = dayOf(now, tz);
    if (readJsonl(pooledFile(root)).rows.some((p) => p.day === today)) return { status: 'not_due', line: null };
    const full = repos.map((c) => {
      const state = join(root, c.slug);
      const { rows, batches } = rowsFor({ slug: c.slug, ghRepo: c.ghRepo, now });
      return { slug: c.slug, ghRepo: c.ghRepo ?? null, name: (c.ghRepo ?? c.slug).split('/').pop(), state, states: c.states, rows, batches };
    });
    const w = evaluate({ repos: full, now, tz, root });
    const changes = w.events.filter((e) => e.kind === 'transition').map((e) => `${e.lever} ${e.from} → ${e.to} in ${e.repo}`);
    return { status: 'ran', line: `levers evaluate: ${w.rows.length} lever row(s) across ${full.length} repo(s)${changes.length ? `; ${changes.join(', ')}` : '; no change'}` };
  } finally { unlock(lock); }
}

// ---- the recount -------------------------------------------------------------------------------------------
// Each repo's latest evidence for every lever counted again, its tickets read through the fingerprint map
// the source checkout's history gives (lever-fp-history.mjs historyMap): a ticket whose recorded
// fingerprint is that of code whose own part is today's counts. Each lever's on and off counts before
// (as its evidence file recorded them) and after. A dry run writes nothing; otherwise the map is written,
// which every evaluation from then on reads, and each repo's lever log gets one `recount` event with its
// counts, and one needs_you event for each lever desk turned off whose counts changed, which the
// evaluation then holds until Ben keeps it off or tests it again.
//   -> { lines: [text], repos: [{ slug, name, counts: { <lever>: { before, after, state } }, events }], notes, file }
export function recount({ repos, checkout, dryRun = true, root = autopilotRoot(), fingerprints = leverFingerprints().fp, registry = REGISTRY, now = Date.now(), history = historyMap }) {
  if (dryRun) return recountUnder({ repos, checkout, dryRun, root, fingerprints, registry, now, history });
  // A real run holds the daily evaluation's lock from its first read to its last write, so no evaluation
  // changes a lever's state or evidence under it, nor reads the map between its writes.
  const lock = join(leversDir(root), 'evaluate.lock.d');
  const got = tryLock(lock);
  if (got !== true) throw new Error(`an evaluation is running (pid ${got ?? '?'}): run the recount again once it finishes`);
  try { return recountUnder({ repos, checkout, dryRun, root, fingerprints, registry, now, history }); } finally { unlock(lock); }
}
// Whether a lever turned off in `state` is asked about: its counts changed.
const recountAsks = (state, c) => TURNED_OFF.includes(state) && (c.before.on !== c.after.on || c.before.off !== c.after.off);
function recountUnder({ repos, checkout, dryRun, root, fingerprints, registry, now, history }) {
  const { levers: map, notes } = history({ checkout, registry });
  const at = new Date(now).toISOString();
  const lines = notes.map((n) => `note: ${n}`);
  const out = [];
  // On and off counts as the evaluation that wrote the evidence split them, in the state it read them in.
  const arms = (rows, lever, state) => {
    const off = offArm(registry[lever], state);
    const n = { on: 0, off: 0 };
    for (const x of rows) n[x.pin?.arms?.[lever] === off ? 'off' : 'on'] += 1;
    return n;
  };
  for (const r of repos) {
    const prior = readJsonl(evalsFile(r.state)).rows;
    let events = [];
    try { events = read(r.slug).events; } catch { /* no log: every lever reads as never trialled */ }
    const states = leverStatesIn(events, registry);
    const counts = {};
    for (const lever of Object.keys(registry)) {
      // The row that wrote the latest evidence: a lever not evaluated (frozen, say) carries its last
      // evidence forward on rows of its own (`evidence_from`), in a state that split none of it.
      const last = prior.filter((x) => x.lever === lever && x.evidence_file && !x.evidence_from).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
      if (!last) continue;
      if (!fingerprints[lever]) { lines.push(`${r.name} ${lever}: not counted again, as its code installed now has no fingerprint`); continue; }
      const rows = readJsonl(join(r.state, last.evidence_file)).rows.filter((x) => (x.slug ?? r.slug) === r.slug && weighable(registry[lever])(x));
      const splitIn = last.from ?? last.state;
      const before = arms(rows.filter((x) => !x.excluded), lever, splitIn);
      const after = arms(rows.filter((x) => !excludedWhy(x, lever, fingerprints[lever] ?? null, map)), lever, splitIn);
      counts[lever] = { before, after, state: states[lever]?.state ?? null };
      const ask = recountAsks(counts[lever].state, counts[lever]);
      lines.push(`${r.name} ${lever}: on ${before.on} → ${after.on}, off ${before.off} → ${after.off}${ask ? ` (${counts[lever].state}: not judged again, Ben decides)` : ''}`);
    }
    out.push({ slug: r.slug, name: r.name, counts, events: [] });
  }
  if (dryRun) return { lines: [...lines, 'dry run: nothing written'], repos: out, notes, file: null };
  // Every repo's holds are in its log before the map is written, so no evaluation reads the map without
  // the holds it needs. Each hold is decided on the log as it reads under its own lock, so a lever a trip
  // turned off since is asked about too. A recount stopped part way leaves the map unwritten and is safe
  // to run again: a lever whose hold is already waiting gets no second one.
  const file = fpMapFile(root);
  for (const r of out) {
    if (!Object.keys(r.counts).length) continue;
    const written = appendWith(r.slug, () => {
      const events = read(r.slug).events;
      const states = leverStatesIn(events, registry);
      const changed = Object.entries(r.counts).map(([lever, c]) => [lever, { ...c, state: states[lever]?.state ?? null }])
        .filter(([lever, c]) => recountAsks(c.state, c) && !recountWaiting(events, lever));
      const stamp = stampAfter(events, at);
      return [
        { kind: 'recount', actor: ACTOR, reason_code: 'recount', at: stamp, fp_map: file,
          counts: Object.fromEntries(Object.entries(r.counts).map(([l, c]) => [l, { before: c.before, after: c.after }])),
          reason: `${Object.keys(r.counts).length} lever(s)' latest evidence counted again on the code each ticket ran on, read through ${file}` },
        ...changed.map(([lever, c]) => ({ kind: 'needs_you', lever, actor: ACTOR, reason_code: 'recount_review', at: stamp, reason: recountText(lever, r.name, c, registry) })),
      ];
    });
    r.events = written ?? [];
  }
  writeFpMap(map, { root, at });
  return { lines: [...lines, `fingerprint map written: ${file}`, ...out.filter((r) => r.events.length).map((r) => `${r.name}: ${r.events.length} event(s) in its lever log`)], repos: out, notes, file };
}
// The needs-you item for `lever` in repo `name`, turned off on `c.before` and recounted to `c.after`.
export function recountText(lever, name, c, registry = REGISTRY) {
  const keep = isValued(registry[lever]) ? registry[lever].baseline : 'off';
  return `${lever} was turned off in ${name} (${c.state}) on ${c.before.on} on and ${c.before.off} off tickets; counted again on the code each ran on, it has ${c.after.on} on and ${c.after.off} off. Keep it off (levers decide ${name} ${lever} ${keep}) or test it again (levers decide ${name} ${lever} trial)`;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] !== '--recount' || args.slice(1).some((a) => a !== '--dry-run')) { console.error('usage: levers-evaluate.mjs --recount [--dry-run]'); process.exit(2); }
  const checkout = readInstalled()?.from ?? null;
  if (!checkout) { console.error('levers-evaluate: no source checkout is recorded in installed.json, so the fingerprint history cannot be read; run install.sh'); process.exit(1); }
  try {
    const repos = E.configuredRepos(E.deskConfigRoot()).map((c) => ({ slug: c.slug, name: (c.ghRepo ?? c.slug).split('/').pop(), state: join(autopilotRoot(), c.slug) }));
    for (const l of recount({ repos, checkout, dryRun: args.includes('--dry-run') }).lines) console.log(l);
  } catch (e) { console.error(`levers-evaluate: ${e.message}`); process.exit(1); }
}
