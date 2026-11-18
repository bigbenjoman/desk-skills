#!/usr/bin/env node
// The Levers view model: one machine-wide file, ~/.desk-autopilot/levers/view.json, holding every
// figure the Levers page, the desk-q Levers line and the digest show, with the age of each input and
// the honesty rules already applied, so no renderer words a result on its own.
//
//   node levers-view.mjs build      writes view.json and build.json, and prints where
//   node levers-view.mjs render     writes the Levers page, index.html, from view.json beside it
//
// It only reads its sources: every configured repo's levers row (config §3b "Phase 0 levers"), and
// under ~/.desk-autopilot/<slug>/ its levers.jsonl, lever-evals.jsonl, audit.jsonl, levers-evidence/
// (the per-ticket outcome rows each evaluation used), the newest phase0-baseline-*.txt, and in the
// repo's state folder and each named batch's its supervisor.json, health.json and post-merge.jsonl;
// plus the machine-wide ~/.desk-autopilot/levers/pooled-evals.jsonl. A line that does not parse makes
// the panels that read its file `error`, naming the file and line, and the rest build.
//
// The honesty rules: no verdict below the minimum sample in the smaller arm; every effect carries its
// 90% interval and n; a point estimate is hidden below 10 per arm; a guardrail may read breached early
// but never ok early; cost is worded against its non-inferiority margin, and a saving is stated only
// for an adopted lever whose whole interval is under 1.00; unknown is null, never 0.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, BATCHES_DIR, configuredRepos, deskConfigRoot, leverRow, repoConfigValues } from './desk-env.mjs';
import { REGISTRY, DECISION_RULE, KEPT_STATES as KEPT, reasonWording, unassignableText } from './lever-registry.mjs';
import { parseBaseline } from './bench-report.mjs';
import { ageWords, renderPage } from './levers-page.mjs';
import { reworkSummary } from './rework.mjs';
import { writeJsonAtomic, writeTextAtomic } from './dir-lock.mjs';

export const VERSION = 1;
const HOUR_S = 3600;
// How old each input may be before the panels that read it show stale.
export const MAX_AGE_S = Object.freeze({ supervisor: 10 * 60, health: 20 * 60, evals: 26 * HOUR_S, pooled: 26 * HOUR_S, post_merge: 26 * HOUR_S });
// Below this many tickets per arm a point estimate is not shown, only its interval.
export const POINT_MIN_N = 10;
const WEEK_DAYS = 7;
const DAY_MS = 86_400_000;
// Events the change list shows: every automatic or manual change, not the per-ticket assignments.
const CHANGE_KINDS = Object.freeze(['transition', 'trip', 'ramp', 'override', 'freeze', 'thaw', 'row_change', 'fp_reset', 'evidence_incomplete', 'pair']);
const TESTING = Object.freeze(['trial']);

export const autopilotRoot = () => join(HOME, '.desk-autopilot');
export const leversDir = (root = autopilotRoot()) => join(root, 'levers');

// ---- the honesty rules -----------------------------------------------------------------------------
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const smallerArm = (n) => (n && Number.isFinite(n.on) && Number.isFinite(n.off) ? Math.min(n.on, n.off) : null);
const tooEarly = (n, minN) => (n == null ? `too early: sample not recorded, needs ${minN}` : `too early: ${n} of ${minN}`);

// A mechanism effect, lower being better: its interval and n always, a verdict only at the minimum
// sample, and its point estimate only from POINT_MIN_N per arm.
export function effectView(m, n, minN) {
  if (!m) return null;
  const lo = m.lo90 ?? null;
  const hi = m.hi90 ?? null;
  const out = {
    metric: m.metric ?? null, unit: m.unit ?? null, scope: m.scope ?? null, n, min_n: minN,
    est: n != null && n >= POINT_MIN_N ? m.est ?? null : null, lo90: lo, hi90: hi, min_benefit: m.min_benefit ?? null,
  };
  if (n == null || n < minN) return { ...out, verdict: null, label: tooEarly(n, minN) };
  if (lo == null || hi == null) return { ...out, verdict: null, label: 'no interval recorded' };
  if (lo <= 0 && hi >= 0) return { ...out, verdict: 'no_clear_effect', label: 'no clear effect yet' };
  if (lo > 0) return { ...out, verdict: 'worse', label: "can't rule out worse" };
  if (m.min_benefit != null && hi <= m.min_benefit) return { ...out, verdict: 'better', label: 'better by at least the minimum' };
  return { ...out, verdict: 'below_minimum', label: 'no clear effect yet' };
}

// The cost ratio on against off, worded against its margin; a saving in dollars per admitted ticket
// only for an adopted lever whose whole interval is under 1.00.
export function costView(c, n, minN, adopted = false) {
  if (!c) return null;
  const lo = c.lo90 ?? null;
  const hi = c.hi90 ?? null;
  const margin = c.margin ?? DECISION_RULE.cost_ratio_max;
  const out = { ratio: n != null && n >= POINT_MIN_N ? c.ratio ?? null : null, lo90: lo, hi90: hi, margin, scope: c.scope ?? null, n, min_n: minN,
    usd_per_admitted: c.usd_per_admitted ?? null, saving_usd: null };
  if (n == null || n < minN) return { ...out, verdict: null, label: tooEarly(n, minN) };
  if (lo == null || hi == null) return { ...out, verdict: null, label: 'no interval recorded' };
  const off = c.usd_per_admitted?.off;
  const saving = adopted && hi < 1 && Number.isFinite(off) ? { lo: round((1 - hi) * off, 2), hi: round((1 - lo) * off, 2) } : null;
  return hi < margin
    ? { ...out, verdict: 'not_worse', label: 'not worse than off', saving_usd: saving }
    : { ...out, verdict: 'cant_rule_out_worse', label: "can't rule out worse" };
}

// A guardrail's status from its probability of being worse than its margin: breached may show before
// the minimum sample, because the revert rule fires early; ok and watching may not.
export function guardrailStatus(g, n, minN) {
  if (!g || (g.p_worse == null && g.est == null)) return 'no_data';
  if (g.p_worse != null && g.p_worse >= DECISION_RULE.probability) return 'breached';
  if (n == null || n < minN) return 'too_early';
  if (g.p_worse == null) return 'no_data';
  return g.p_worse >= 0.5 ? 'watching' : 'ok';
}

const ageOf = (at, now) => (at == null ? null : Math.max(0, Math.round((now - Date.parse(at)) / 1000)));
const age = (at, now, max) => { const s = ageOf(at, now); return { as_of: at, age_s: s, words: ageWords(s), stale: s == null || s > max }; };

// ---- reading -----------------------------------------------------------------------------------------
const mtimeIso = (p) => { try { return statSync(p).mtime.toISOString(); } catch { return null; } };
const listDir = (p) => { try { return readdirSync(p).sort(); } catch { return []; } };

// A JSON-lines file: its rows, and the first line that does not parse as an object. A missing file is
// no rows and no error.
export function readJsonl(file) {
  let body;
  try { body = readFileSync(file, 'utf8'); } catch (e) { return { rows: [], error: e.code === 'ENOENT' ? null : { file, line: null, message: e.message }, missing: e.code === 'ENOENT' }; }
  const rows = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let r;
    try { r = JSON.parse(lines[i]); } catch (e) { return { rows, error: { file, line: i + 1, message: e.message }, missing: false }; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { rows, error: { file, line: i + 1, message: 'not a JSON object' }, missing: false };
    rows.push(r);
  }
  return { rows, error: null, missing: false };
}

// The repo's own state folder and each named batch's, archived ones aside.
const stateDirs = (state) => [state, ...listDir(join(state, BATCHES_DIR)).filter((n) => !n.startsWith('.')).map((n) => join(state, BATCHES_DIR, n))];

// The config line holding a repo's levers row, for the waiting-on-you item to point at.
function rowNumber(config) {
  try {
    const i = readFileSync(config, 'utf8').split('\n').findIndex((l) => /^\|\s*Phase 0 levers\s*\|/.test(l));
    return i >= 0 ? i + 1 : null;
  } catch { return null; }
}
const rowLine = (config) => { const n = rowNumber(config); return n ? `${config}:${n}` : config; };

// How a repo's levers row reads, as desk-env's leverRow reads it: no row (not enrolled), `none` (off),
// `auto`, or levers pinned by hand. `invalid` is leverRow's message for a row desk reads as all off.
export function enrolment(items) {
  if (items == null) return { row: 'missing', auto: false, pinned: [], invalid: null };
  const { on, auto, invalid } = leverRow(items);
  return { row: auto ? 'auto' : on.length ? 'pinned' : 'none', auto, pinned: on, invalid };
}

// The Phase 0 baseline's per accepted ticket figures, its window and starts, from bench-report's
// parser of that report. -> { base, error }: a file that cannot be read or is not that report is an
// error naming it, never a missing baseline.
export function readBaseline(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return { base: null, error: { file, line: null, message: e.message } }; }
  const b = parseBaseline(text);
  if (b.why) return { base: null, error: { file, line: null, message: `not a Phase 0 baseline report: ${b.why}` } };
  return {
    base: {
      window: b.window, accepted: b.accepted, tickets_costed: b.perTicket?.over ?? null, starts: b.starts,
      cost: b.usdPerTicket, input_tokens: b.perTicket?.input ?? null, output_tokens: b.perTicket?.output ?? null,
      fix_tries: b.fixTries, denials: b.denials,
    },
    error: null,
  };
}

// The files the view reads: the machine's, then each repo's, by what each holds. readRepo and buildView
// read these and inputFiles fingerprints them, so an input is named in one place.
const machineFiles = (root) => ({ pooled: join(leversDir(root), 'pooled-evals.jsonl'), freeze: join(root, 'levers.freeze') });
function repoFiles(r, root) {
  const state = join(root, r.slug);
  const dirs = stateDirs(state);
  return {
    config: [r.config],
    log: [join(state, 'levers.jsonl')], evals: [join(state, 'lever-evals.jsonl')], audit: [join(state, 'audit.jsonl')],
    evidence: listDir(join(state, 'levers-evidence')).filter((f) => f.endsWith('.jsonl')).map((f) => join(state, 'levers-evidence', f)),
    baselines: listDir(state).filter((f) => /^phase0-baseline-.*\.txt$/.test(f)).map((f) => join(state, f)),
    postMerge: dirs.map((d) => join(d, 'post-merge.jsonl')),
    supervisor: dirs.map((d) => join(d, 'supervisor.json')),
    healths: dirs.map((d) => join(d, 'health.json')),
  };
}
// The repo files a refresh leaves out of its fingerprint: the view shows only when each was last
// written (supervisor.json's age, health.json's `at`), and a refresh rebuilds on age alone often
// enough to keep that current, where fingerprinting them would rebuild on every tick.
const AGE_ONLY = new Set(['supervisor', 'healths']);

// Everything one repo holds, read once.
function readRepo(r, root) {
  const f = repoFiles(r, root);
  const name = (r.ghRepo ?? r.slug).split('/').pop();
  // A malformed levers row is an error naming the config, never a missing row.
  let items = null;
  let configError = null;
  try { items = repoConfigValues(r.slug, 'levers', r.root); } catch (e) { configError = { file: r.config, line: rowNumber(r.config), message: e.message }; }
  const invalid = configError ? null : enrolment(items).invalid;
  if (invalid) configError = { file: r.config, line: rowNumber(r.config), message: invalid };
  const healths = f.healths.filter(existsSync).map((file) => {
    try { return { file, at: JSON.parse(readFileSync(file, 'utf8')).at ?? null, error: null }; } catch (e) { return { file, at: null, error: { file, line: null, message: e.message } }; }
  });
  return {
    slug: r.slug, name, config: r.config, items, configRead: { error: configError },
    enrol: configError ? { row: 'error', auto: false, pinned: [] } : enrolment(items),
    supervisor_at: f.supervisor.map(mtimeIso).filter(Boolean).sort().pop() ?? null, healths,
    log: readJsonl(f.log[0]), evals: readJsonl(f.evals[0]), audit: readJsonl(f.audit[0]),
    postMerge: f.postMerge.map(readJsonl), evidence: f.evidence.map((file) => ({ ...readJsonl(file), at: mtimeIso(file) })),
    baseline: f.baselines.at(-1) ?? null,
  };
}

// Every file whose contents the view's figures read, for a refresh to tell whether any changed.
export function inputFiles({ root = autopilotRoot(), configRoot = deskConfigRoot() } = {}) {
  return [...Object.values(machineFiles(root)), ...configuredRepos(configRoot).flatMap((r) => Object.entries(repoFiles(r, root))
    .filter(([k]) => !AGE_ONLY.has(k)).flatMap(([, files]) => files))];
}

// ---- dates, in the person's own time zone ---------------------------------------------------------------
const dayKey = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const keyMs = (k) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
const addDays = (k, n) => new Date(keyMs(k) + n * DAY_MS).toISOString().slice(0, 10);
const weekStart = (k) => addDays(k, -((new Date(keyMs(k)).getUTCDay() + 6) % 7));
const monthOf = (k) => k.slice(0, 7);
const addMonths = (m, n) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };

// ---- the four trend metrics -------------------------------------------------------------------------------
const costed = (r) => r.cost_complete === true && !r.excluded && Number.isFinite(r.cost);
const counted = (r) => !r.excluded;
// The per accepted ticket metrics read merged tickets only, the population their baseline counts;
// an admitted ticket still in flight or never run would pull the mean down and read as a saving.
const accepted = (r) => !!r.merged_at;
const mean = (xs) => (xs.length ? xs.reduce((n, v) => n + v, 0) / xs.length : null);
const usdMean = (rows) => mean(rows.filter(costed).map((r) => r.cost));
export const METRICS = Object.freeze({
  cost: { title: 'Cost per ticket', unit: 'usd', of: (rows) => usdMean(rows.filter(accepted)), base: (b) => b?.cost ?? null, basis: 'per accepted ticket' },
  tokens: { title: 'Tokens per ticket', unit: 'input tokens', of: (rows) => mean(rows.filter(accepted).filter(costed).filter((r) => Number.isFinite(r.input)).map((r) => r.input)), base: (b) => b?.input_tokens ?? null, basis: 'per accepted ticket' },
  prompts: {
    title: 'Permission prompts per start', unit: 'denials per start',
    of: (rows) => { const s = rows.filter(counted).filter((r) => r.starts > 0 && Number.isFinite(r.denials)); const n = s.reduce((a, r) => a + r.starts, 0); return n ? s.reduce((a, r) => a + r.denials, 0) / n : null; },
    base: (b) => (b?.denials != null && b?.starts ? b.denials / b.starts : null), basis: 'per start',
  },
  fixes: { title: 'Fix tries per ticket', unit: 'fix tries', of: (rows) => mean(rows.filter(accepted).filter(counted).filter((r) => Number.isFinite(r.fix_tries)).map((r) => r.fix_tries)), base: (b) => b?.fix_tries ?? null, basis: 'per accepted ticket' },
});
const pct = (a, b) => (a == null || b == null || b === 0 ? null : round(((a - b) / b) * 100, 1));
const val = (v) => round(v, 4);

// One metric's 30 daily points ending yesterday, 6 weekly points ending last week, 12 monthly points
// ending this month, its baseline and its nine callouts. A point with no tickets, or before the first
// recorded day, is null.
function trend(metric, rows, base, today, first) {
  const at = (pred) => rows.filter((r) => pred(r.day));
  const point = (pred, before) => (first == null || before < first ? null : val(metric.of(at(pred))));
  const yesterday = addDays(today, -1);
  const daily = Array.from({ length: 30 }, (_, i) => addDays(yesterday, i - 29)).map((d) => ({ date: d, value: point((x) => x === d, d) }));
  const thisWeek = weekStart(today);
  const weekly = Array.from({ length: 6 }, (_, i) => addDays(thisWeek, (i - 6) * WEEK_DAYS)).map((w) => ({ week: w, value: point((x) => x >= w && x < addDays(w, WEEK_DAYS), addDays(w, WEEK_DAYS - 1)) }));
  const month = monthOf(today);
  const monthly = Array.from({ length: 12 }, (_, i) => addMonths(month, i - 11)).map((m) => ({ month: m, value: point((x) => monthOf(x) === m && x < today, `${m}-31`) }));
  const day = daily.at(-1).value;
  const lastWeek = weekly.at(-1).value;
  const mtd = monthly.at(-1).value;
  const toDate = first == null ? null : val(metric.of(at((x) => x < today)));
  return {
    title: metric.title, unit: metric.unit, first_recorded: first,
    baseline: { value: base == null ? null : val(base), basis: metric.basis },
    daily, weekly, monthly,
    callouts: {
      yesterday: day, dod_pct: pct(day, daily.at(-2).value),
      last_week: lastWeek, wow_pct: pct(lastWeek, weekly.at(-2).value), last_week_vs_before_pct: pct(lastWeek, base),
      mtd, mom_pct: pct(mtd, monthly.at(-2).value),
      to_date: toDate, to_date_vs_before_pct: pct(toDate, base),
    },
  };
}

// ---- the build ---------------------------------------------------------------------------------------------
// What one evaluation row showed, with the honesty rules applied: its arms, mechanism effect, cost and
// each guardrail's status.
function evalEvidence(e, layerMin) {
  const minN = e.min_n ?? layerMin;
  const n = smallerArm(e.n);
  return {
    eval_id: e.eval_id ?? null, at: e.at ?? null, state: e.state ?? null,
    n: { on: e.n?.on ?? null, off: e.n?.off ?? null, smaller: n, min: minN },
    effect: effectView(e.mechanism, n, minN), cost: costView(e.cost, n, minN, KEPT.includes(e.state)),
    guardrails: (e.guardrails ?? []).map((g) => ({ ...g, status: guardrailStatus(g, n, minN) })),
  };
}

const panel = (state, body = {}, errors = []) => ({ state: errors.length ? 'error' : state, ...(errors.length ? { errors } : {}), ...body });
const errs = (...reads) => reads.flat(Infinity).map((x) => x?.error).filter(Boolean);

// The view model for the inputs under `root` and the configs under `configRoot`, as of `now`.
export function buildView({ root = autopilotRoot(), configRoot = deskConfigRoot(), now = Date.now(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone, generatedAt = Date.now() } = {}) {
  const repos = configuredRepos(configRoot).map((r) => readRepo({ ...r, root: configRoot }, root));
  const machine = machineFiles(root);
  const pooled = readJsonl(machine.pooled);
  const frozen = existsSync(machine.freeze);
  const today = dayKey(now, tz);
  const weekAgo = now - WEEK_DAYS * DAY_MS;

  // Per-ticket outcome rows: the latest evaluation's copy of each ticket.
  const byTicket = new Map();
  for (const r of repos) for (const f of r.evidence) for (const row of f.rows) {
    if (!row.key || !row.admitted_at || Number.isNaN(Date.parse(row.admitted_at))) continue;
    byTicket.set(`${row.slug ?? r.slug}|${row.batch ?? ''}|${row.key}`, { ...row, slug: row.slug ?? r.slug, repo: r.name, day: dayKey(Date.parse(row.admitted_at), tz) });
  }
  const rows = [...byTicket.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  const rowErrors = errs(repos.map((r) => r.evidence));
  const first = rows.length ? rows.map((r) => r.day).sort()[0] : null;

  // Baseline: the newest Phase 0 baseline file of any repo.
  const bfile = repos.map((r) => r.baseline && { file: r.baseline, repo: r.name }).filter(Boolean).sort((a, b) => (a.file.split('/').pop() < b.file.split('/').pop() ? 1 : -1))[0] ?? null;
  const baseRead = bfile ? readBaseline(bfile.file) : { base: null, error: null };
  const baseline = baseRead.base ? { ...baseRead.base, file: bfile.file, repo: bfile.repo, label: 'per accepted ticket' } : null;
  const configErrors = errs(repos.map((r) => r.configRead));

  // Each repo's latest evaluation row per lever.
  const latest = new Map();
  for (const r of repos) for (const e of r.evals.rows) {
    if (!e.lever || Number.isNaN(Date.parse(e.at))) continue;
    const k = `${r.slug}|${e.lever}`;
    if (!latest.has(k) || Date.parse(latest.get(k).at) <= Date.parse(e.at)) latest.set(k, e);
  }
  const evalAt = [...latest.values()].map((e) => e.at).sort().pop() ?? null;
  const pooledAt = pooled.rows.map((p) => p.at).filter((a) => !Number.isNaN(Date.parse(a))).sort().pop() ?? null;

  // The repos, each with its column's state.
  const repoView = repos.map((r) => {
    const sup = age(r.supervisor_at, now, MAX_AGE_S.supervisor);
    const reads = { missing: 'not enrolled', none: 'off', auto: 'auto', pinned: `pinned: ${r.enrol.pinned.join(', ')}`, error: 'levers row unreadable' }[r.enrol.row];
    const bad = errs(r.configRead, r.evals, r.log);
    return { slug: r.slug, name: r.name, config: r.config, row: r.enrol.row, reads, pinned: r.enrol.pinned, column: bad.length ? 'error' : sup.stale ? 'stale' : 'ok', supervisor: sup, ...(bad.length ? { errors: bad } : {}) };
  });

  // P1 status strip.
  const healthErrors = repos.flatMap((r) => r.healths.map((h) => h.error).filter(Boolean));
  const health = repos.map((r) => ({ repo: r.name, ...age(r.healths.map((h) => h.at).filter(Boolean).sort().pop() ?? null, now, MAX_AGE_S.health) }));
  const evalAge = age(evalAt, now, MAX_AGE_S.evals);
  const controller = frozen ? 'frozen' : evalAt == null ? 'not running' : evalAge.stale ? 'stale' : 'running';
  const pinnedList = repos.flatMap((r) => r.enrol.pinned.map((lever) => ({ lever, repo: r.name })));
  const status = panel(repoView.some((c) => c.column === 'stale') || (evalAt && evalAge.stale) ? 'stale' : 'ok', {
    controller, repos: repos.length, on_auto: repos.filter((r) => r.enrol.auto).length, pinned: pinnedList,
    last_evaluation: evalAt, evaluation: evalAt ? evalAge : null, stale_repos: repoView.filter((c) => c.column === 'stale').map((c) => c.name), health,
    baseline: baseline ? { file: baseline.file, window: baseline.window, label: baseline.label } : null,
  }, [...healthErrors, ...configErrors, ...errs(baseRead)]);

  // P2 waiting on you: enrolment gaps, then the lever items raised since the lever last changed.
  const waitingItems = [];
  for (const r of repos) {
    if (r.enrol.row === 'missing') waitingItems.push({ kind: 'enrol', repo: r.name, text: `set \`auto\` in ${r.name}`, detail: 'no levers row', config: r.config });
    else if (r.enrol.row === 'none') waitingItems.push({ kind: 'enrol', repo: r.name, text: `set \`auto\` in ${r.name}`, detail: 'the levers row reads `none`', config: rowLine(r.config) });
  }
  const leverItems = [];
  for (const r of repos) {
    const evs = r.log.rows.filter((e) => !Number.isNaN(Date.parse(e.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let unassignable = false;
    evs.forEach((e, i) => {
      if (e.kind !== 'needs_you') return;
      const spent = evs.slice(i + 1).some((x) => ['transition', 'override', 'thaw', 'trip'].includes(x.kind) && (e.lever == null || x.lever === e.lever));
      if (spent) return;
      leverItems.push({ kind: 'lever', repo: r.name, lever: e.lever ?? null, at: e.at, text: e.reason ?? null, command: `needs-you list ${r.name}` });
      if (e.reason_code === 'state_unreadable') unassignable = true;
    });
    // A log that cannot be opened, or stops at a line that does not parse, also stops an auto repo's
    // tickets being assigned arms, and the item the assignment wrote is beyond what was read.
    if (r.enrol.auto && r.log.error && !unassignable) {
      const why = r.log.error.line == null ? `its lever log cannot be read (${r.log.error.message})` : `line ${r.log.error.line} of its lever log does not parse`;
      leverItems.push({ kind: 'lever', repo: r.name, lever: null, at: null, text: unassignableText(r.name, why), command: `needs-you list ${r.name}` });
    }
  }
  const waiting = panel(waitingItems.length || leverItems.length ? 'ok' : 'empty', { count: waitingItems.length + leverItems.length, items: [...leverItems, ...waitingItems] }, errs(repos.map((r) => r.log)));

  // P5 lever board.
  const cells = Object.keys(REGISTRY).map((lever) => {
    const reg = REGISTRY[lever];
    const min = DECISION_RULE.min_per_arm[reg.layer];
    return {
      lever, layer: reg.layer,
      cells: repos.map((r) => {
        const col = repoView.find((c) => c.slug === r.slug);
        if (r.evals.error) return { repo: r.name, state: 'error', error: r.evals.error };
        const e = latest.get(`${r.slug}|${lever}`);
        // Only a lever with no evaluation reads its state from the levers row.
        if (!e && r.configRead.error) return { repo: r.name, state: 'error', error: r.configRead.error };
        if (!e) {
          if (r.enrol.pinned.includes(lever)) return { repo: r.name, state: 'pinned', note: 'pinned by hand: before/after only, not a trial', stale: col.column === 'stale' };
          return { repo: r.name, state: r.enrol.auto ? 'off' : 'not_enrolled', stale: col.column === 'stale' };
        }
        const minN = e.min_n ?? min;
        const n = smallerArm(e.n);
        const { effect, cost, guardrails } = evalEvidence(e, min);
        const chip = {};
        for (const g of guardrails) chip[g.status] = (chip[g.status] ?? 0) + 1;
        return {
          repo: r.name, state: e.state ?? null, as_of: e.at, stale: col.column === 'stale' || age(e.at, now, MAX_AGE_S.evals).stale,
          arm_share_7d: e.arm_share_7d ?? null,
          sample: { n, min: minN, max: e.max_n ?? DECISION_RULE.max_per_arm, on: e.n?.on ?? null, off: e.n?.off ?? null, pooled_on: e.n?.pooled_on ?? null, pooled_off: e.n?.pooled_off ?? null },
          effect, cost,
          guardrails, guardrail_chip: chip, decision: e.decision ?? null, reason_code: e.reason_code ?? null, reason: reasonWording(e.reason_code), next: e.next ?? null,
        };
      }),
    };
  });
  const boardErrors = errs(repos.map((r) => r.evals), pooled, repos.map((r) => r.configRead));
  const boardAge = evalAt ? evalAge : null;
  const pooledAge = pooledAt ? age(pooledAt, now, MAX_AGE_S.pooled) : null;
  const board = panel(!evalAt ? 'empty' : evalAge.stale || pooledAge?.stale ? 'stale' : 'ok', { age: boardAge, pooled_age: pooledAge, levers: cells }, boardErrors);

  // P4 guardrails, per repo and lever.
  const guardRows = cells.flatMap((l) => l.cells.filter((c) => c.guardrails).flatMap((c) => c.guardrails.map((g) => ({ repo: c.repo, lever: l.lever, ...g }))));
  const scans = repos.map((r) => ({ repo: r.name, at: r.postMerge.flatMap((p) => p.rows).filter((x) => x.kind === 'scan').map((x) => x.at).sort().pop() ?? null }));
  const scanStale = scans.filter((s) => s.at && age(s.at, now, MAX_AGE_S.post_merge).stale).map((s) => s.repo);
  // Each repo's rework share over its tickets admitted this week, aged by its newest evidence file.
  const rework = repos.map((r) => {
    const mine = rows.filter((x) => x.slug === r.slug && Date.parse(x.admitted_at) >= weekAgo && Date.parse(x.admitted_at) < now);
    const s = reworkSummary(mine);
    const usdOf = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, round(v, 2)]));
    return {
      repo: r.name, admitted: mine.length, known: s.known, unknown: s.unknown.length,
      share: round(s.share, 4), rework_usd: s.known ? round(s.rework_cost, 2) : null, usd: s.known ? round(s.cost, 2) : null,
      by_cause: Object.fromEntries(Object.entries(s.by_cause).map(([c, v]) => [c, { usd: round(v.cost, 2), share: round(v.share, 4) }])),
      by_class: usdOf(s.by_class), age: age(r.evidence.map((f) => f.at).filter(Boolean).sort().pop() ?? null, now, MAX_AGE_S.evals),
    };
  });
  const reworkStale = rework.some((x) => x.admitted && x.age.stale);
  const guardStale = (guardRows.length && (scanStale.length || evalAge.stale)) || reworkStale;
  const guardrails = panel(!guardRows.length && !rework.some((x) => x.admitted) ? 'empty' : guardStale ? 'stale' : 'ok',
    { rows: guardRows, post_merge: scans.map((s) => ({ repo: s.repo, ...age(s.at, now, MAX_AGE_S.post_merge) })), rework },
    errs(repos.map((r) => r.evals), repos.map((r) => r.postMerge), rowErrors.map((error) => ({ error }))));

  // P6 the changes: this week's, and every one, each with the evaluation it cites.
  const evalById = new Map();
  for (const r of repos) for (const e of r.evals.rows) if (e.eval_id) evalById.set(`${r.slug}|${e.eval_id}`, e);
  const changesAll = repos.flatMap((r) => r.log.rows.filter((e) => CHANGE_KINDS.includes(e.kind) && !Number.isNaN(Date.parse(e.at))).map((e) => {
    const ev = e.eval_id ? evalById.get(`${r.slug}|${e.eval_id}`) : null;
    return {
      at: e.at, repo: e.repo === '*' ? '*' : r.name, lever: e.lever ?? e.pair ?? null, kind: e.kind, from: e.from ?? null, to: e.to ?? null, actor: e.actor ?? null,
      reason_code: e.reason_code ?? null, wording: reasonWording(e.reason_code), reason: e.reason ?? null, ticket: e.ticket ?? null,
      eval_id: e.eval_id ?? null, evidence_file: e.evidence_file ?? null, decision_id: e.decision_id ?? null, desk_commit_range: e.desk_commit_range ?? null,
      evidence: ev ? evalEvidence(ev, DECISION_RULE.min_per_arm[REGISTRY[ev.lever]?.layer] ?? null) : null,
    };
  })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.repo < b.repo ? -1 : 1));
  const week = changesAll.filter((e) => Date.parse(e.at) >= weekAgo);
  const changes = panel(week.length ? 'ok' : 'empty', { events: week, all: changesAll, last_change: changesAll[0] ?? null }, errs(repos.map((r) => r.log)));

  // P7 experiment overhead.
  const audits = repos.flatMap((r) => r.audit.rows.filter((a) => Date.parse(a.at) >= weekAgo).map((a) => ({ ...a, repo: r.name })));
  const deferred = repos.flatMap((r) => r.log.rows.filter((e) => e.kind === 'audit_deferred' && Date.parse(e.at) >= weekAgo));
  const byReason = {};
  for (const d of deferred) byReason[d.reason_code ?? 'unknown'] = (byReason[d.reason_code ?? 'unknown'] ?? 0) + 1;
  const quality = [...latest.values()].filter((e) => REGISTRY[e.lever]?.layer === 'quality-risk' && Number.isFinite(e.arm_share_7d));
  const overhead = panel(audits.length || deferred.length || quality.length ? 'ok' : 'empty', {
    audits: audits.length, audit_usd: audits.length && audits.every((a) => Number.isFinite(a.usd)) ? round(audits.reduce((n, a) => n + a.usd, 0), 2) : null,
    deferred: deferred.length, deferred_by_reason: byReason,
    quality_risk_share: quality.length ? Math.max(...quality.map((e) => e.arm_share_7d)) : null,
    quality_risk_cap: Object.values(REGISTRY).find((reg) => reg.layer === 'quality-risk')?.ramp?.cap ?? null,
  }, errs(repos.map((r) => r.audit), repos.map((r) => r.log), repos.map((r) => r.evals)));

  // P8 data quality.
  const excluded = { cost_incomplete: 0, pin_mismatch: 0, fp_reset: 0, other: 0 };
  for (const r of rows) {
    if (r.excluded) excluded[Object.hasOwn(excluded, r.excluded) ? r.excluded : 'other'] += 1;
    else if (r.cost_complete !== true) excluded.cost_incomplete += 1;
  }
  const starts = rows.flatMap((r) => r.start_records ?? []);
  const dataQuality = panel(rows.length ? 'ok' : 'empty', {
    tickets: rows.length, excluded, excluded_total: Object.values(excluded).reduce((n, v) => n + v, 0),
    starts: starts.length, starts_with_claude_version: starts.filter((s) => s.claude_version).length,
    desk_commits: [...new Set(starts.map((s) => s.desk_commit).filter(Boolean))].sort(),
  }, rowErrors);

  // P3 cost per admitted ticket.
  const window = (from, to) => rows.filter((r) => Date.parse(r.admitted_at) >= from && Date.parse(r.admitted_at) < to);
  const usdPer = (rs) => round(usdMean(rs), 2);
  const thisWeek = window(weekAgo, now);
  const perRepo = repos.map((r) => {
    const mine = thisWeek.filter((x) => x.slug === r.slug);
    return { repo: r.name, admitted: mine.length, merged: mine.filter((x) => x.merged_at).length, usd_per_admitted: usdPer(mine), cost_incomplete: mine.filter((x) => !x.excluded && x.cost_complete !== true).length };
  });
  const savings = cells.flatMap((l) => l.cells.filter((c) => c.cost?.saving_usd).map((c) => ({ lever: l.lever, repo: c.repo, ...c.cost.saving_usd })));
  const cost = panel(thisWeek.length ? 'ok' : 'empty', {
    this_week: { admitted: thisWeek.length, usd_per_admitted: usdPer(thisWeek) },
    weeks_before: [1, 2, 3, 4].map((k) => { const rs = window(weekAgo - k * WEEK_DAYS * DAY_MS, weekAgo - (k - 1) * WEEK_DAYS * DAY_MS); return { admitted: rs.length, usd_per_admitted: usdPer(rs) }; }),
    baseline: baseline ? { usd: baseline.cost, input_tokens: baseline.input_tokens, output_tokens: baseline.output_tokens, tickets: baseline.tickets_costed, window: baseline.window, label: baseline.label, file: baseline.file } : null,
    per_repo: perRepo, savings,
  }, [...rowErrors, ...errs(repos.map((r) => r.evals), baseRead)]);

  // Trends.
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, trend(m, rows, m.base(baseline), today, first)]));
  const trends = panel(rows.length ? 'ok' : 'empty', { first_recorded: first, metrics }, [...rowErrors, ...errs(baseRead)]);

  // The desk-q line.
  const evalCells = cells.flatMap((l) => l.cells.filter((c) => c.sample).map((c) => ({ lever: l.lever, ...c })));
  const testing = new Set(evalCells.filter((c) => TESTING.includes(c.state)).map((c) => c.lever));
  const kept = new Set(evalCells.filter((c) => KEPT.includes(c.state)).map((c) => c.lever));
  const early = evalCells.filter((c) => TESTING.includes(c.state) && c.sample.n != null).sort((a, b) => a.sample.n / a.sample.min - b.sample.n / b.sample.min)[0] ?? null;
  const lineErrors = errs(repos.map((r) => r.evals), repos.map((r) => r.log), repos.map((r) => r.configRead), baseRead, rowErrors.map((error) => ({ error })));
  const common = { on_auto: status.on_auto, repos: repos.length, pinned: pinnedList };
  const vsBefore = metrics.cost.callouts.last_week_vs_before_pct;
  const figures = { cheaper_pct: vsBefore == null ? null : round(-vsBefore, 1), kept: kept.size, testing: testing.size, needs_you: leverItems.length };
  let line;
  if (lineErrors.length) line = { state: 'broken', error: lineErrors[0], ...common };
  else if (!testing.size && !kept.size) line = { state: 'today', ...common, needs_you: leverItems.length };
  else if (leverItems.length) line = { state: 'needs_you', ...common, ...figures };
  else if (!kept.size && evalCells.every((c) => !TESTING.includes(c.state) || c.sample.n == null || c.sample.n < c.sample.min)) {
    line = { state: 'early', ...common, testing: testing.size, smaller_arm: early ? { n: early.sample.n, min: early.sample.min } : null };
  } else line = { state: 'working', ...common, ...figures };

  return {
    v: VERSION, generated_at: new Date(generatedAt).toISOString(), tz,
    repos: repoView, baseline,
    panels: { status, waiting, cost, guardrails, board, changes, overhead, data_quality: dataQuality, trends },
    line,
  };
}

// What build.json records: when it built, how long it took, each input's age and every panel error.
export function buildRecord(view, ms) {
  const errors = [];
  for (const [name, p] of Object.entries(view.panels)) for (const e of p.errors ?? []) {
    const had = errors.find((x) => x.file === e.file && x.line === e.line);
    if (had) had.panels.push(name); else errors.push({ ...e, panels: [name] });
  }
  if (view.line.state === 'broken' && !errors.some((x) => x.file === view.line.error.file && x.line === view.line.error.line)) errors.push({ ...view.line.error, panels: ['line'] });
  return {
    v: VERSION, generated_at: view.generated_at, duration_ms: ms,
    inputs: {
      supervisor: view.repos.map((r) => ({ repo: r.name, ...r.supervisor })), health: view.panels.status.health,
      evaluation: view.panels.board.age, pooled: view.panels.board.pooled_age, post_merge: view.panels.guardrails.post_merge,
    },
    errors,
  };
}

// Builds the view and writes view.json and build.json into `out`. -> { view, record, files }
export function build({ out = leversDir(), ...opts } = {}) {
  const t0 = Date.now();
  const view = buildView(opts);
  const record = buildRecord(view, Date.now() - t0);
  mkdirSync(out, { recursive: true });
  const files = { view: join(out, 'view.json'), build: join(out, 'build.json') };
  writeJsonAtomic(files.view, view);
  writeJsonAtomic(files.build, record);
  return { view, record, files };
}

// Renders the Levers page from the view.json in `dir` into index.html beside it. -> { file, view }
export function render({ dir = leversDir() } = {}) {
  const src = join(dir, 'view.json');
  let view;
  try { view = JSON.parse(readFileSync(src, 'utf8')); } catch (e) { throw new Error(e.code === 'ENOENT' ? `no view.json at ${src}: run \`levers-view.mjs build\` first` : `cannot read ${src}: ${e.message}`); }
  const file = join(dir, 'index.html');
  writeTextAtomic(file, renderPage(view));
  return { file, view };
}

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== 'build' && cmd !== 'render') { console.error('usage: levers-view.mjs build|render'); process.exit(2); }
  try {
    if (cmd === 'render') {
      const { file } = render();
      console.log(`levers-view: wrote ${file}`);
      process.exit(0);
    }
    const { files, record, view } = build();
    console.log(`levers-view: wrote ${files.view} and ${files.build} (line: ${view.line.state}${record.errors.length ? `; ${record.errors.length} input error(s), see build.json` : ''})`);
  } catch (e) {
    console.error(`levers-view: ${e.message}`);
    process.exit(1);
  }
}
