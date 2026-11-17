// The levers controller's daily evaluation: once a day, in every repo whose levers row reads `auto`,
// each low-risk lever on trial, adopted or reverted is weighed on its tickets' outcomes and adopted,
// reverted, settled or held. The mechanism metric and the cost ratio pool every such repo's tickets
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
// It writes, under ~/.desk-autopilot/<slug>/: one lever-evals.jsonl row per lever evaluated, whatever
// the decision; the rows each evaluation used in levers-evidence/<eval_id>.jsonl (kept 180 days), whose
// sha256 the row holds; and transition, fp_reset, evidence_incomplete and needs_you events in the lever
// log. The pooled estimates go once a day to ~/.desk-autopilot/levers/pooled-evals.jsonl, by whichever
// repo's pass takes the machine-wide lock first; that pass evaluates every `auto` repo.
//
//   import { evaluate, evaluateDue } from './levers-evaluate.mjs'
//   node levers-auto.mjs evaluate      runs it now if today's has not run
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as E from './desk-env.mjs';
import { REGISTRY, DECISION_RULE, GUARDRAILS, leverFingerprints } from './lever-registry.mjs';
import { appendWith, read } from './lever-log.mjs';
import { leverStatesIn, ACTOR } from './levers-auto.mjs';
import { tryLock, unlock } from './dir-lock.mjs';
import { seededRandom } from './seeded-random.mjs';
import { bootstrap, costRatio, interval, meanDiff, rateRatio, seedOf } from './lever-stats.mjs';
import { guardrailStatus, leversDir, autopilotRoot, readJsonl } from './levers-view.mjs';
import { findingsPath } from './findings.mjs';
import { postMergePath, readPostMerge } from './post-merge.mjs';
import { perTicket, allBatches, failedRuns } from './phase0-report.mjs';

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
const dayOf = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
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
});

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
});

// ---- outcome files -----------------------------------------------------------------------------------
// Each row with its review P0 and P1 count (from its findings file) and its post-merge records (from
// its batch's post-merge.jsonl). A merged ticket whose file is missing, or whose post-merge file's
// latest scan did not complete, gets null, and the file is named in its `outcome_missing`.
//   -> { rows, newest: { findings, post_merge } }, the newest as ms
export function withOutcomes(rows, batches) {
  const stateOf = new Map(batches.map((b) => [b.name ?? null, b.state]));
  const postMerge = new Map();
  let newestFindings = null;
  let newestScan = null;
  const out = rows.map((r) => {
    const state = stateOf.get(r.batch ?? null);
    if (!state) return { ...r, review_p0_p1: null, post_merge: null };
    const missing = [];
    let review = 0;
    const f = findingsPath(state, r.key);
    if (existsSync(f)) {
      try { newestFindings = Math.max(newestFindings ?? 0, statSync(f).mtimeMs); } catch { /* age only */ }
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (d && !d.carried) review += fin(d.p0) + fin(d.p1);
      }
    } else if (r.merged_at) { review = null; missing.push(f); }
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
    if (Array.isArray(recs)) pm = recs.filter((x) => x.ticket === r.key && (x.kind === 'revert' || x.kind === 'red_main')).length;
    else if (r.merged_at) { pm = null; missing.push(recs?.incomplete ? `${postMergePath(state)} (its latest scan is incomplete)` : postMergePath(state)); }
    return { ...r, review_p0_p1: review, post_merge: pm, ...(missing.length ? { outcome_missing: missing } : {}) };
  });
  return { rows: out, newest: { findings: newestFindings, post_merge: newestScan } };
}

// ---- which rows a lever's evaluation reads -------------------------------------------------------------
const trialId = (slug, lever, s) => `${slug}/${lever}/${s.id ?? 'initial'}`;
const ARMS = { trial: ['on', 'off'], reverted: ['on', 'off'], adopted: ['adopted', 'holdback'] };
const outcomeIn = (r) => !!r.merged_at || OUTCOME_STATES.includes(r.state);

// The fingerprints of a lever's code a row ran on: its starts' records, else its pin's at admission.
function rowFps(r, lever) {
  const starts = (r.start_records ?? []).map((s) => s.lever_fp?.[lever]).filter(Boolean);
  if (starts.length) return starts;
  const p = r.pin?.fp?.[lever];
  return p ? [p] : [];
}

// Why a row is left out of a lever's evidence, or null.
export function excludedWhy(r, lever, fp) {
  if (r.pin_mismatch) return 'pin_mismatch';
  if (r.cost_complete !== true || !Number.isFinite(r.cost)) return 'cost_incomplete';
  if (fp && rowFps(r, lever).some((x) => x !== fp)) return 'fp_reset';
  return null;
}

// The rows of one repo's evaluation of `lever` in state `s`: those whose ticket drew one of the
// state's two arms under its trial id and whose outcome is in, each with `on` and `excluded`.
export function leverRows(rows, slug, lever, s, fp) {
  const arms = ARMS[s.state];
  const drew = rows.filter((r) => arms.includes(r.pin?.arms?.[lever]));
  let id;
  if (s.state === 'reverted') {
    // The trial it was reverted from: the latest trial id its tickets drew under.
    id = [...drew].sort((a, b) => Date.parse(a.admitted_at) - Date.parse(b.admitted_at)).at(-1)?.pin?.trial_ids?.[lever] ?? null;
  } else id = trialId(slug, lever, s);
  return drew.filter((r) => r.pin?.trial_ids?.[lever] === id && outcomeIn(r))
    .map((r) => ({ ...r, slug: r.slug ?? slug, on: r.pin.arms[lever] === arms[0], excluded: excludedWhy(r, lever, fp) }));
}

// ---- estimates -------------------------------------------------------------------------------------------
const strata = (rows) => {
  const g = new Map();
  for (const r of rows) { const k = `${r.slug}|${r.on}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  return [...g.keys()].sort().map((k) => g.get(k));
};
const counts = (rows) => ({ on: rows.filter((r) => r.on).length, off: rows.filter((r) => !r.on).length });

// The mechanism effect over `rows`: the on arm's rate relative to the off arm's (-0.6 is 60% lower),
// with its interval and the probability it is lower by at least the lever's minimum.
export function mechanismEstimate(rows, lever, { seed, scope }) {
  const m = MECHANISMS[lever];
  const reg = REGISTRY[lever];
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
export function guardrailEstimates(rows, { seed, minN }) {
  const n = Math.min(counts(rows).on, counts(rows).off);
  return Object.entries(GUARDS).map(([name, g]) => {
    const have = rows.filter((r) => g.value(r) != null);
    const stat = g.kind === 'diff' ? (rs) => meanDiff(rs, g.value) : (rs) => rateRatio(rs, g.value);
    const est = stat(have);
    if (est == null) return { name, scope: 'repo', est: null, lo90: null, hi90: null, margin: g.margin, p_worse: null, status: 'no_data' };
    const worse = g.kind === 'diff' ? (d) => d < g.margin : (d) => d > g.margin;
    const iv = interval(bootstrap(strata(have), stat, { random: seededRandom(seedOf(`${seed}|${name}`)) }), worse);
    const out = { name, scope: 'repo', est: r4(est), lo90: r4(iv.lo90), hi90: r4(iv.hi90), margin: g.margin, p_worse: r4(iv.p) };
    return { ...out, status: guardrailStatus(out, n, minN) };
  });
}

// ---- the decision ----------------------------------------------------------------------------------------
const pct = (v) => (v == null ? '?' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`);
const x2 = (v) => (v == null ? '?' : `${v.toFixed(2)}×`);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// What the evaluation does with one lever in one repo. `n` is the repo's arms, `priorReverts` how many
// times the repo's log has reverted it before, `changedAt` when it last changed state there (ms or
// null). -> { decision, to, reason_code, reason, next }
export function decide({ state, n, minN, maxN, mechanism, cost, guardrails, frozen = false, incomplete = [], changedAt = null, priorReverts = 0, now, holdbackWeeks }) {
  const R = DECISION_RULE;
  const smaller = Math.min(n.on, n.off);
  const earliest = changedAt == null ? now : changedAt + R.cooldown_days * DAY_MS;
  const cooling = now < earliest;
  const next = (needs) => ({ earliest_change: day(Math.max(earliest, now)), needs });
  const hold = (code, reason, needs) => ({ decision: 'hold', to: null, reason_code: code, reason, next: next(needs) });
  const revertTo = priorReverts >= 1 ? 'frozen' : 'reverted';
  const sample = `${n.on} vs ${n.off} tickets`;
  if (frozen) return hold('freeze', 'trials are frozen on this computer', 'the freeze lifted (desk-env levers thaw)');

  const breached = state === 'reverted' ? [] : guardrails.filter((g) => g.status === 'breached');
  if (breached.length && smaller >= R.revert_min_per_arm) {
    const g = breached[0];
    const why = `${GUARDRAILS[g.name].metric} worse than its margin with ${Math.round(g.p_worse * 100)}% probability (${g.est} against ${g.margin}, 90%: ${g.lo90} to ${g.hi90}) at ${sample}`;
    if (cooling) return hold('change_cooldown', `would revert (${why}), but it changed state less than ${R.cooldown_days} days ago`, `the ${R.cooldown_days}-day wait to pass`);
    return { decision: 'revert', to: revertTo, reason_code: `guardrail_${snake(g.name)}`, reason: why, next: next(null) };
  }
  if (state === 'adopted') {
    if (incomplete.length) return hold('evidence_incomplete', `outcome files missing: ${incomplete.join(', ')}`, 'the missing outcome files');
    // A breach on too small a holdback arm to revert on neither reverts nor lets the lever settle.
    if (breached.length) return hold('holdback_running', `${breached.map((g) => g.name).join(', ')} breached at ${sample}, below the ${R.revert_min_per_arm} per arm a revert needs, so it does not settle`, `${R.revert_min_per_arm - smaller} more tickets in the smaller arm`);
    if (changedAt != null && now >= changedAt + holdbackWeeks * WEEK_MS) {
      return { decision: 'settle', to: 'settled', reason_code: 'holdback_ended', reason: `the ${holdbackWeeks}-week holdback ended with no guardrail breached (${sample})`, next: next(null) };
    }
    return hold('holdback_running', `adopted; the holdback runs to ${changedAt == null ? '?' : day(changedAt + holdbackWeeks * WEEK_MS)}`, 'the holdback to end');
  }
  if (incomplete.length) return hold('evidence_incomplete', `outcome files missing, so nothing adopts: ${incomplete.join(', ')}`, 'the missing outcome files');
  if (smaller < minN) return hold('below_min_sample', `${smaller} of ${minN} tickets in the smaller arm`, `${minN - smaller} more tickets in the smaller arm`);

  const unmet = [];
  if (mechanism.min_benefit == null) unmet.push(`${mechanism.metric} has no registered minimum`);
  else if (!(mechanism.p_benefit >= R.probability)) unmet.push(`${mechanism.metric} ${pct(mechanism.est)} (90%: ${pct(mechanism.lo90)} to ${pct(mechanism.hi90)}) is ${pct(mechanism.min_benefit)} or better with only ${Math.round((mechanism.p_benefit ?? 0) * 100)}% probability`);
  if (!(Number.isFinite(cost.hi90) && cost.hi90 < R.cost_ratio_max)) unmet.push(`cost ratio ${x2(cost.ratio)} (90%: ${x2(cost.lo90)} to ${x2(cost.hi90)}) does not rule out ${x2(R.cost_ratio_max)}`);
  const notOk = guardrails.filter((g) => g.status !== 'ok');
  if (notOk.length) unmet.push(`guardrails not within margin: ${notOk.map((g) => `${g.name} ${g.status}`).join(', ')}`);

  if (!unmet.length) {
    const why = `${mechanism.metric} ${pct(mechanism.est)} (90%: ${pct(mechanism.lo90)} to ${pct(mechanism.hi90)}) beat the ${pct(mechanism.min_benefit)} minimum; cost ratio ${x2(cost.ratio)} (${x2(cost.lo90)} to ${x2(cost.hi90)}) under ${x2(R.cost_ratio_max)}; ${guardrails.length} guardrails within margin; ${sample}`;
    if (cooling) return hold('change_cooldown', `every adopt condition holds, but it changed state less than ${R.cooldown_days} days ago`, `the ${R.cooldown_days}-day wait to pass`);
    return { decision: 'adopt', to: 'adopted', reason_code: 'adopt_all_conditions', reason: why, next: next(null) };
  }
  if (state === 'trial' && smaller >= maxN) {
    const noBenefit = mechanism.min_benefit == null || !(mechanism.p_benefit >= R.probability);
    if (cooling) return hold('change_cooldown', `would revert at the maximum sample, but it changed state less than ${R.cooldown_days} days ago`, `the ${R.cooldown_days}-day wait to pass`);
    return { decision: 'revert', to: revertTo, reason_code: noBenefit ? 'no_benefit_max_sample' : 'max_sample_no_adopt', reason: `${noBenefit ? 'no benefit at maximum sample' : 'maximum sample reached'}: ${unmet.join('; ')} (${sample})`, next: next(null) };
  }
  return hold('adopt_conditions_unmet', unmet.join('; '), unmet.join('; '));
}

// ---- one evaluation run ----------------------------------------------------------------------------------
// The desk commits a set of rows' starts ran on, first and last by start time; null with none.
function commitRange(rows) {
  const starts = rows.flatMap((r) => r.start_records ?? []).filter((s) => s.desk_commit).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return starts.length ? [starts[0].desk_commit.slice(0, 12), starts.at(-1).desk_commit.slice(0, 12)] : null;
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
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
  frozen = !!E.leversFrozen(), fingerprints = leverFingerprints().fp, registry = REGISTRY,
}) {
  const today = dayOf(now, tz);
  const at = new Date(now).toISOString();
  const written = { day: today, rows: [], events: [], pooled: [] };
  const levers = Object.keys(registry).filter((l) => registry[l].layer === 'low-risk' && registry[l].trialled && MECHANISMS[l]);

  // Each repo's log, lever states and outcome-filled rows, read once.
  const prepared = repos.filter((r) => Object.values(r.states).includes('auto')).map((r) => {
    let log = null;
    let unreadable = null;
    try { log = read(r.slug); if (log.bad.length) unreadable = `line ${log.bad.map((b) => b.line).join(', ')} of its lever log does not parse`; } catch (e) { unreadable = e.message; }
    const outcomes = withOutcomes(r.rows, r.batches);
    const prior = readJsonl(evalsFile(r.state)).rows;
    return { ...r, log, unreadable, byLever: log ? leverStatesIn(log.events, registry) : null, outcomes, prior, done: prior.some((p) => p.at && dayOf(Date.parse(p.at), tz) === today) };
  });

  // Each lever's rows in each repo, and the pooled estimates across repos weighing it as a trial.
  const plan = [];
  for (const r of prepared) {
    if (r.done || r.unreadable) continue;
    for (const lever of levers) {
      if (r.states[lever] !== 'auto') continue;
      const s = r.byLever[lever];
      if (!EVALUATED.includes(s.state)) continue;
      plan.push({ r, lever, s, rows: leverRows(r.outcomes.rows, r.slug, lever, s, fingerprints[lever] ?? null) });
    }
  }
  const pooledBy = {};
  for (const lever of levers) {
    const trials = plan.filter((p) => p.lever === lever && p.s.state !== 'adopted');
    if (!trials.length) continue;
    const rows = trials.flatMap((p) => p.rows.filter((x) => !x.excluded));
    const seed = `${today}|${lever}|pooled`;
    pooledBy[lever] = {
      v: 1, at, day: today, lever, repos: trials.map((p) => p.r.slug), n: counts(rows),
      mechanism: mechanismEstimate(rows, lever, { seed: `${seed}|mechanism`, scope: 'pooled' }),
      cost: costEstimate(rows, { seed: `${seed}|cost`, scope: 'pooled' }),
      rows: trials.flatMap((p) => p.rows),
    };
  }

  for (const r of prepared) {
    if (r.done) continue;
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
        const st = r.byLever[lever];
        lines.push({ ...base, state: st.state, decision: 'hold', reason_code: 'not_evaluated', reason: `${lever} is ${st.state} in ${r.name}${st.at ? ` since ${st.at.slice(0, 10)}` : ''}`, next: { earliest_change: null, needs: 'a change by hand' } });
        continue;
      }
      const { s } = p;
      const used = p.rows.filter((x) => !x.excluded);
      const pooled = s.state === 'adopted' ? null : pooledBy[lever];
      const seed = `${evalId}`;
      const mechanism = pooled ? pooled.mechanism : mechanismEstimate(used, lever, { seed: `${seed}|mechanism`, scope: 'repo' });
      const cost = pooled ? pooled.cost : costEstimate(used, { seed: `${seed}|cost`, scope: 'repo' });
      const guardrails = guardrailEstimates(used, { seed, minN });
      const n = { ...counts(used), pooled_on: (pooled?.n ?? counts(used)).on, pooled_off: (pooled?.n ?? counts(used)).off, excluded: excludedCounts(p.rows) };
      const incomplete = [...new Set(used.flatMap((x) => x.outcome_missing ?? []))].sort();
      const transitions = (r.log.events ?? []).filter((e) => e.kind === 'transition' && e.lever === lever);
      const priorReverts = transitions.filter((e) => ['reverted', 'frozen'].includes(e.to)).length;
      const changedAt = s.at ? Date.parse(s.at) : null;
      const d = decide({ state: s.state, n, minN, maxN: DECISION_RULE.max_per_arm, mechanism, cost, guardrails, frozen, incomplete, changedAt, priorReverts, now, holdbackWeeks: reg.ramp.holdback_weeks });

      // The evidence this evaluation used: the pooled rows for a lever on trial, else the repo's.
      const evidenceRows = pooled ? pooled.rows : p.rows;
      const body = evidenceRows.map(({ on, excluded, ...row }) => `${JSON.stringify(excluded ? { ...row, excluded } : row)}\n`).join('');
      const evidenceFile = `levers-evidence/${evalId}.jsonl`;
      mkdirSync(evidenceDir(r.state), { recursive: true });
      writeFileSync(join(r.state, evidenceFile), body);
      const evidenceSha = sha256(body);

      const assigns = (r.log.events ?? []).filter((e) => e.kind === 'assign' && Date.parse(e.at) >= now - WEEK_MS && e.arms?.[lever] != null);
      const share = assigns.length ? r4(assigns.filter((e) => ['on', 'adopted'].includes(e.arms[lever])).length / assigns.length) : null;
      const versions = [...new Set(used.flatMap((x) => (x.start_records ?? []).map((st) => st.claude_version)).filter(Boolean))].sort();
      const age = (ms) => (ms == null ? null : Math.max(0, Math.round((now - ms) / 1000)));
      const range = commitRange(used);
      const evidence = { eval_id: evalId, evidence_file: evidenceFile, evidence_sha256: evidenceSha };
      const append = (event) => {
        const e = appendWith(r.slug, () => event);
        if (e) written.events.push(e);
        return e;
      };

      // The lever's own code changed since its last evaluation here.
      const last = r.prior.filter((x) => x.lever === lever && x.lever_fp).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
      if (last && fingerprints[lever] && last.lever_fp !== fingerprints[lever]) {
        append({ kind: 'fp_reset', lever, actor: ACTOR, reason_code: 'fp_reset', at, ...evidence, from_fp: last.lever_fp, to_fp: fingerprints[lever],
          dropped: n.excluded.fp_reset, reason: `${lever}'s code fingerprint changed from ${last.lever_fp} to ${fingerprints[lever]}: ${n.excluded.fp_reset} ticket(s) run on the old code are left out and the count restarts` });
      }
      // Incomplete evidence, once while the same files stay missing.
      if (incomplete.length) {
        const lastIncomplete = (r.log.events ?? []).filter((e) => e.kind === 'evidence_incomplete' && e.lever === lever).at(-1);
        const lastRow = r.prior.filter((x) => x.lever === lever).at(-1);
        const same = lastIncomplete && lastRow?.reason_code === 'evidence_incomplete' && JSON.stringify(lastIncomplete.missing) === JSON.stringify(incomplete);
        if (!same) append({ kind: 'evidence_incomplete', lever, actor: ACTOR, reason_code: 'evidence_incomplete', at, ...evidence, missing: incomplete, reason: `${lever} in ${r.name}: nothing adopts while outcome files are missing: ${incomplete.join(', ')}` });
      }

      let to = null;
      if (d.to) {
        const holdback = d.to === 'adopted' ? { share: reg.ramp.holdback, until: day(now + reg.ramp.holdback_weeks * WEEK_MS) } : undefined;
        const e = appendWith(r.slug, () => {
          // Written only while the lever is still in the state this evaluation read.
          const nowState = leverStatesIn(read(r.slug).events, registry)[lever];
          if (nowState.state !== s.state || nowState.id !== s.id) return null;
          return {
            kind: 'transition', lever, from: s.state, to: d.to, actor: ACTOR, reason_code: d.reason_code, reason: d.reason, at, ...evidence,
            n, mechanism, cost, guardrails, desk_commit_range: range, lever_fp: fingerprints[lever] ?? null, ...(holdback ? { holdback } : {}),
          };
        });
        if (e) {
          written.events.push(e);
          to = d.to;
          if (d.to === 'frozen') {
            append({ kind: 'needs_you', lever, actor: ACTOR, reason_code: 'frozen_second_revert', at, ...evidence,
              reason: `${lever} is frozen in ${r.name} after its second revert (${d.reason}): it stays off there until you set it by hand` });
          }
        }
      }
      lines.push({
        ...base, state: to ?? s.state, ...(to ? { from: s.state } : {}), arm_share_7d: share, n, mechanism, cost, guardrails,
        decision: to ? d.decision : 'hold', reason_code: d.reason_code, reason: d.to && !to ? `${d.reason}; not written, as the lever changed state while it was evaluated` : d.reason, next: d.next,
        ...(incomplete.length ? { missing: incomplete } : {}),
        ...evidence, desk_commit_range: range, claude_versions: versions,
        inputs_age_s: { outcomes: 0, findings: age(r.outcomes.newest.findings), post_merge: age(r.outcomes.newest.post_merge), audit: null },
      });
    }
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
// Each lever's row state in another repo's levers row, as desk-env leverStates reads this repo's.
export function rowStates(items) {
  const r = E.leverRow(items);
  return Object.fromEntries(E.LEVERS.map((n) => [n, r.on.includes(n) ? 'pinned' : r.auto && !r.invalid ? 'auto' : 'off']));
}

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
    try { for (const t of Object.values(JSON.parse(readFileSync(b.queue, 'utf8')).tickets ?? {})) if (t.branch) branchOf.set(`${b.name ?? ''}|${t.key}`, t.branch); } catch { /* no queue */ }
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
    return { ...c, states: rowStates(items) };
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
      return { slug: c.slug, name: (c.ghRepo ?? c.slug).split('/').pop(), state, states: c.states, rows, batches };
    });
    const w = evaluate({ repos: full, now, tz, root });
    const changes = w.events.filter((e) => e.kind === 'transition').map((e) => `${e.lever} ${e.from} → ${e.to} in ${e.repo}`);
    return { status: 'ran', line: `levers evaluate: ${w.rows.length} lever row(s) across ${full.length} repo(s)${changes.length ? `; ${changes.join(', ')}` : '; no change'}` };
  } finally { unlock(lock); }
}
