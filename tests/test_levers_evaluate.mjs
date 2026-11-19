// suite: levers evaluate (the daily adopt, revert, settle or hold of each lever on trial, per repo)
// covers: desk/bin/levers-evaluate.mjs desk/bin/lever-changes.mjs desk/bin/digest.mjs desk/bin/levers-trips.mjs desk/bin/decisions.mjs desk/bin/lever-stats.mjs desk/bin/levers-auto.mjs desk/bin/lever-registry.mjs desk/bin/lever-log.mjs desk/bin/phase0-report.mjs
// evaluate() runs on synthetic per-ticket rows, findings files and post-merge files in a scratch HOME,
// with a fixed clock, so its seeded bootstrap draws the same numbers every run.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const T = mkdtempSync(join(tmpdir(), 'levers-evaluate-'));
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];
Object.assign(process.env, { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'none.md') });
mkdirSync(join(T, 'home'), { recursive: true });

const { evaluate, evaluateDue, decide } = await import('../desk/bin/levers-evaluate.mjs');
const { append, read, logFile } = await import('../desk/bin/lever-log.mjs');
const { assignPin } = await import('../desk/bin/levers-auto.mjs');
const { reasonWording, DECISION_RULE } = await import('../desk/bin/lever-registry.mjs');
const { seededRandom } = await import('../desk/bin/seeded-random.mjs');
const { LEVERS } = await import('../desk/bin/desk-env.mjs');
const { tFit, costRatio } = await import('../desk/bin/lever-stats.mjs');
const { refresh: refreshLevers } = await import('../desk/bin/levers-refresh.mjs');

const DAY = 86_400_000;
const NOW = Date.parse('2026-12-02T08:00:00.000Z');
const at = (days, from = NOW) => new Date(from + days * DAY).toISOString();
const AUTO = Object.fromEntries(LEVERS.map((n) => [n, 'auto']));
const FP = { preflight: 'fpP', wrappers: 'fpW', memory: 'fpM', 'failure-class': 'fpF', codex: null, 'review-reuse': null, effort: null };
const stateOf = (slug) => join(T, 'home', '.desk-autopilot', slug);
const jsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const evalsOf = (slug) => jsonl(join(stateOf(slug), 'lever-evals.jsonl'));
const eventsOf = (slug, kind) => read(slug).events.filter((e) => !kind || e.kind === kind);

// One ticket's per-ticket row (phase0-report perTicket) on `arm` of the wrappers trial `tid`.
let seq = 0;
const jitter = seededRandom(7);
function row(slug, arm, tid, o = {}) {
  seq += 1;
  return {
    slug, batch: null, key: `T-${seq}`, type: 'Story', size: seq % 2 ? 'S' : 'M', admitted_at: at(-20), merged_at: at(-10), state: 'done',
    cost: 10 * (1 + 0.04 * (jitter() - 0.5)), cost_complete: true, preflight_cost: 0.1, starts: 1, fix_tries: 0, parks: 0, parks_by_class: {},
    denials: 1, ci_reds: 0, start_records: [{ at: at(-19), desk_commit: `${seq % 2 ? 'a' : 'b'}`.repeat(40), claude_version: '2.4.1', lever_fp: null, system_bytes: 1000, prompt_bytes: 100 }],
    pin: { set: arm === 'on' || arm === 'adopted' ? ['wrappers'] : [], arms: { wrappers: arm }, trial_ids: { wrappers: tid }, fp: null }, pin_mismatch: false, ...o,
  };
}
// `n` rows per arm; `on(i)` and `off(i)` give each row's overrides.
const arms = (slug, tid, n, on = () => ({}), off = () => ({}), names = ['on', 'off']) => [
  ...Array.from({ length: n }, (_, i) => row(slug, names[0], tid, on(i))),
  ...Array.from({ length: n }, (_, i) => row(slug, names[1], tid, off(i))),
];
// Denials per start down 60% on the lever's arm, everything else equal.
const better = { on: (i) => ({ denials: i % 5 < 2 ? 1 : 0 }), off: () => ({ denials: 1 }) };

// A repo's state folder with a findings file for every merged row (bar `noFindings`) and a scanned
// post-merge.jsonl, as evaluate() is handed it.
function repo(slug, rows, { noFindings = [], postMerge = true } = {}) {
  const state = stateOf(slug);
  mkdirSync(join(state, 'workers'), { recursive: true });
  for (const r of rows) {
    if (r.merged_at && !noFindings.includes(r.key)) writeFileSync(join(state, 'workers', `${r.key}.findings.jsonl`), `${JSON.stringify({ ticket: r.key, round: 1, reviewer: 'self', p0: 0, p1: 0, p2: 0, fixed: 0 })}\n`);
  }
  if (postMerge) writeFileSync(join(state, 'post-merge.jsonl'), `${JSON.stringify({ kind: 'scan', at: at(-1), complete: true })}\n`);
  return { slug, name: slug.split('__')[1], state, states: AUTO, rows, batches: [{ name: null, state }] };
}
const run = (repos, now = NOW, fingerprints = FP) => evaluate({ repos, now, tz: 'UTC', root: join(T, `pooled-${seq}`), frozen: false, fingerprints });
const wrappersRow = (slug) => evalsOf(slug).filter((e) => e.lever === 'wrappers').at(-1);
const initial = (slug) => `${slug}/wrappers/initial`;
const transitionOf = (slug, lever = 'wrappers') => eventsOf(slug, 'transition').filter((e) => e.lever === lever);

// ---- the fit itself ----------------------------------------------------------------------------------
const xs = [...Array(20).keys()];
const fit = tFit(xs.map((x) => (x === 19 ? 400 : x + ((x % 3) - 1) * 0.2)), xs.map((x) => [1, x]));
t('the Student-t fit is not dragged by one runaway value (slope near 1)', Math.abs(fit[1] - 1) < 0.5, true);
const doubled = [...Array(20)].map((_, i) => ({ on: i % 2 === 0, cost: (i % 2 === 0 ? 20 : 10) * (1 + (i % 3) * 0.01), repo: 'a', size: 'S' }));
t('the cost ratio reads the arm\'s coefficient on log cost', Math.abs(costRatio(doubled) - 2) < 0.05, true);

// ---- AC1, AC8, AC11, AC13, AC14, AC16: an adopt -----------------------------------------------------------
const A1 = 'acme__adopts';
const a1rows = [
  ...arms(A1, initial(A1), 30, better.on, better.off),
  row(A1, 'on', initial(A1), { pin_mismatch: true }),
  row(A1, 'off', initial(A1), { cost_complete: false }),
  row(A1, 'on', initial(A1), { cost_complete: false }),
];
run([repo(A1, a1rows)]);
const a1 = wrappersRow(A1);
t('AC1 wrappers is adopted', [a1.decision, a1.state, a1.reason_code], ['adopt', 'adopted', 'adopt_all_conditions']);
t('AC1 the mechanism is down about 60% with its interval clear of 25%', [Math.round(a1.mechanism.est * 100), a1.mechanism.hi90 < -0.25, a1.mechanism.p_benefit >= 0.9], [-60, true, true]);
t('AC1 the cost ratio\'s upper bound is under 1.05', a1.cost.hi90 < 1.05, true);
t('AC1 every guardrail is within its margin', a1.guardrails.map((g) => g.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
const a1t = transitionOf(A1);
t('AC1 one transition line, trial to adopted, with a 10% holdback', a1t.map((e) => [e.from, e.to, e.holdback?.share]), [['trial', 'adopted', 0.1]]);
t('AC16 it is a transition event with its reason code', [a1t[0].kind, a1t[0].reason_code, a1t[0].actor], ['transition', 'adopt_all_conditions', 'levers-auto']);
t('AC8 the pin mismatch and incomplete costs are left out and counted', [a1t[0].n.on, a1t[0].n.off, a1t[0].n.excluded], [30, 30, { pin_mismatch: 1, cost_incomplete: 2, fp_reset: 0 }]);
const e = a1t[0];
t('AC11 the line holds n per arm, both estimates with 90% intervals, each guardrail, the commit range, the fingerprint and the reason',
  [e.n.on != null && e.n.off != null, ['est', 'lo90', 'hi90'].every((k) => Number.isFinite(e.mechanism[k])), ['ratio', 'lo90', 'hi90'].every((k) => Number.isFinite(e.cost[k])),
    e.guardrails.map((g) => g.name), e.desk_commit_range, e.lever_fp, typeof e.reason === 'string' && e.reason.length > 20],
  [true, true, true, ['acceptance', 'fix-tries-parks', 'ci-reds', 'review-p0-p1', 'post-merge'], ['a'.repeat(12), 'b'.repeat(12)], 'fpW', true]);
const ev = jsonl(join(stateOf(A1), a1.evidence_file));
t('AC14 the evidence file holds every row the evaluation read, with the excluded ones marked', [ev.length, ev.filter((x) => x.excluded).map((x) => x.excluded).sort()], [63, ['cost_incomplete', 'cost_incomplete', 'pin_mismatch']]);
t('AC14 the row holds the evidence file\'s sha256', a1.evidence_sha256, createHash('sha256').update(readFileSync(join(stateOf(A1), a1.evidence_file))).digest('hex'));
t('AC14 the transition cites the same evaluation and file', [e.eval_id, e.evidence_file, e.evidence_sha256], [a1.eval_id, a1.evidence_file, a1.evidence_sha256]);
const a1all = evalsOf(A1);
t('AC13 every trialled lever gets one row, holds included', a1all.map((x) => x.lever).sort(), ['codex', 'effort', 'failure-class', 'memory', 'preflight', 'review-reuse', 'wrappers']);
t('AC13 a quality-risk lever with no state recorded is on trial and weighed', a1all.filter((x) => x.layer === 'quality-risk').map((x) => [x.state, x.reason_code]), [['trial', 'below_min_sample'], ['trial', 'below_min_sample'], ['trial', 'below_min_sample']]);
const pre = a1all.find((x) => x.lever === 'preflight');
t('AC13 a hold carries its reason code and what would change it next', [pre.decision, pre.reason_code, pre.next.needs], ['hold', 'below_min_sample', '30 more tickets in the smaller arm']);
t('AC13 the row is in the view\'s schema', ['v', 'eval_id', 'at', 'repo', 'lever', 'layer', 'state', 'arm_share_7d', 'n', 'min_n', 'max_n', 'mechanism', 'cost', 'guardrails', 'decision', 'reason_code', 'next', 'evidence_file', 'evidence_sha256', 'lever_fp', 'claude_versions', 'inputs_age_s'].filter((k) => !(k in a1)), []);
run([repo(A1, a1rows)]);
t('a second evaluation the same day writes nothing more', evalsOf(A1).length, a1all.length);

// ---- AC2: a guardrail breach reverts before the minimum sample ---------------------------------------------------
const A2 = 'acme__breach';
run([repo(A2, arms(A2, initial(A2), 12, (i) => ({ ...better.on(i), parks: 4, parks_by_class: { 'agent mistake': 3 + (i % 3) } }), (i) => ({ denials: 1, parks: 1, parks_by_class: { 'agent mistake': i % 3 } })))]);
const a2 = wrappersRow(A2);
t('AC2 the parks guardrail is breached at 12 per arm', a2.guardrails.find((g) => g.name === 'fix-tries-parks').status, 'breached');
t('AC2 the lever reverts before the minimum sample', [a2.decision, a2.state, a2.reason_code, transitionOf(A2).map((x) => x.to)], ['revert', 'reverted', 'guardrail_fix_tries_parks', ['reverted']]);
const A2q = 'acme__quota';
run([repo(A2q, arms(A2q, initial(A2q), 12, (i) => ({ ...better.on(i), parks_by_class: { quota: 4 } }), () => ({ denials: 1 })))]);
t('AC2 parks for quota do not count against the guardrail', wrappersRow(A2q).decision, 'hold');

// ---- AC3: at most one change every 7 days ----------------------------------------------------------------------
const A3 = 'acme__cooldown';
append(A3, { kind: 'transition', lever: 'wrappers', from: 'trial', to: 'reverted', actor: 'levers-auto', reason_code: 'guardrail_ci_reds', reason: 'an earlier revert', eval_id: 'evl_x', evidence_file: 'levers-evidence/evl_x.jsonl', at: at(-3) });
const a3repo = repo(A3, arms(A3, initial(A3), 30, better.on, better.off));
run([a3repo]);
t('AC3 three days after a revert, evidence that meets every adopt condition changes nothing', [wrappersRow(A3).decision, wrappersRow(A3).reason_code, wrappersRow(A3).state, wrappersRow(A3).next.earliest_change], ['hold', 'change_cooldown', 'reverted', '2026-12-06']);
run([a3repo], NOW + 3 * DAY);
t('AC3 six days after, still nothing', wrappersRow(A3).reason_code, 'change_cooldown');
run([a3repo], NOW + 4 * DAY);
t('AC3 the first evaluation 7 days after the revert adopts it', [wrappersRow(A3).decision, transitionOf(A3).map((x) => `${x.from}>${x.to}`)], ['adopt', ['trial>reverted', 'reverted>adopted']]);

// ---- AC4: the minimum sample -------------------------------------------------------------------------------------------
const A4 = 'acme__twentynine';
run([repo(A4, arms(A4, initial(A4), 29, better.on, better.off))]);
t('AC4 29 tickets per arm stay on trial', [wrappersRow(A4).decision, wrappersRow(A4).state, wrappersRow(A4).reason_code, transitionOf(A4).length], ['hold', 'trial', 'below_min_sample', 0]);

// ---- AC5: the maximum sample -------------------------------------------------------------------------------------------
const A5 = 'acme__maximum';
run([repo(A5, arms(A5, initial(A5), 150, () => ({ denials: 1 }), () => ({ denials: 1 })))]);
t('AC5 150 per arm with no benefit reverts', [wrappersRow(A5).decision, wrappersRow(A5).reason_code, reasonWording(wrappersRow(A5).reason_code)], ['revert', 'no_benefit_max_sample', 'no benefit at maximum sample']);

// ---- AC6: estimates pool, guardrails are per repo ------------------------------------------------------------------------------
const A6a = 'acme__pooled';
const A6b = 'acme__harmed';
run([
  repo(A6a, arms(A6a, initial(A6a), 30, better.on, better.off)),
  repo(A6b, arms(A6b, initial(A6b), 30, (i) => ({ ...better.on(i), ...(i % 2 ? { merged_at: null } : {}) }), better.off)),
]);
t('AC6 the pooled mechanism counts both repos', wrappersRow(A6a).n.pooled_on, 60);
t('AC6 the other repo adopts', wrappersRow(A6a).decision, 'adopt');
t('AC6 the repo whose acceptance drops in the lever arm reverts', [wrappersRow(A6b).decision, wrappersRow(A6b).reason_code], ['revert', 'guardrail_acceptance']);

// ---- AC7: a second revert freezes ---------------------------------------------------------------------------------------------
const A7 = 'acme__twice';
append(A7, { kind: 'transition', lever: 'wrappers', from: 'trial', to: 'reverted', actor: 'levers-auto', reason_code: 'guardrail_ci_reds', reason: 'the first revert', eval_id: 'evl_y', evidence_file: 'levers-evidence/evl_y.jsonl', at: at(-40) });
const back = append(A7, { kind: 'override', lever: 'wrappers', from: 'reverted', to: 'trial', actor: 'ben', reason_code: 'ben_override', reason: 'put back on trial', at: at(-20) });
run([repo(A7, arms(A7, `${A7}/wrappers/${back.id}`, 12, () => ({ parks_by_class: { 'agent mistake': 4 } }), (i) => ({ parks_by_class: { 'agent mistake': i % 2 } })))]);
t('AC7 the second revert freezes the lever in that repo', [wrappersRow(A7).state, transitionOf(A7).map((x) => x.to)], ['frozen', ['reverted', 'frozen']]);
const ny = eventsOf(A7, 'needs_you');
t('AC7 one needs-you item names the lever and the repo', [ny.length, ny[0]?.lever, /wrappers is frozen in twice/.test(ny[0]?.reason ?? '')], [1, 'wrappers', true]);

// ---- AC9: a change to the lever's own code restarts the count ----------------------------------------------------------------------
const A9 = 'acme__fingerprint';
const withFp = (fp) => (o) => ({ ...o, start_records: [{ at: at(-19), desk_commit: 'c'.repeat(40), claude_version: '2.4.1', lever_fp: { wrappers: fp } }] });
const a9rows = [
  ...arms(A9, initial(A9), 30, (i) => withFp('old')(better.on(i)), () => withFp('old')(better.off())),
  ...arms(A9, initial(A9), 5, (i) => withFp('new')(better.on(i)), () => withFp('new')(better.off())),
];
mkdirSync(stateOf(A9), { recursive: true });
writeFileSync(join(stateOf(A9), 'lever-evals.jsonl'), `${JSON.stringify({ v: 1, eval_id: 'evl_old', at: at(-1), repo: A9, lever: 'wrappers', lever_fp: 'old', decision: 'hold' })}\n`);
run([repo(A9, a9rows)], NOW, { ...FP, wrappers: 'new' });
const a9 = wrappersRow(A9);
t('AC9 evidence from before the change is dropped and the count restarts', [a9.n.on, a9.n.off, a9.n.excluded.fp_reset, a9.decision, a9.reason_code], [5, 5, 60, 'hold', 'below_min_sample']);
const fpr = eventsOf(A9, 'fp_reset');
t('AC16 the fingerprint reset is one fp_reset event with its reason code', [fpr.length, fpr[0]?.reason_code, fpr[0]?.from_fp, fpr[0]?.to_fp], [1, 'fp_reset', 'old', 'new']);

// ---- AC10: the holdback ends -----------------------------------------------------------------------------------------------------------
const A10 = 'acme__settles';
const adopted = append(A10, { kind: 'transition', lever: 'wrappers', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'adopted', eval_id: 'evl_z', evidence_file: 'levers-evidence/evl_z.jsonl', at: at(-29) });
run([repo(A10, arms(A10, `${A10}/wrappers/${adopted.id}`, 12, () => ({}), () => ({}), ['adopted', 'holdback']))]);
t('AC10 four weeks into its holdback with no breach, it settles', [wrappersRow(A10).decision, wrappersRow(A10).state, wrappersRow(A10).reason_code], ['settle', 'settled', 'holdback_ended']);
const pin = assignPin('NEW-1', { size: 'S', slug: A10, states: AUTO, frozen: false, random: seededRandom(3), now: new Date(NOW), values: { 'worker-location': 'local' } }).pin;
t('AC10 a new ticket gets wrappers on with no holdback arm', [pin.set.includes('wrappers'), pin.arms.wrappers ?? null], [true, null]);
const A10b = 'acme__holding';
const recent = append(A10b, { kind: 'transition', lever: 'wrappers', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'adopted', eval_id: 'evl_w', evidence_file: 'levers-evidence/evl_w.jsonl', at: at(-10) });
run([repo(A10b, arms(A10b, `${A10b}/wrappers/${recent.id}`, 12, () => ({}), () => ({}), ['adopted', 'holdback']))]);
t('AC13 a held-back lever gets its row, held while the holdback runs', [wrappersRow(A10b).state, wrappersRow(A10b).decision, wrappersRow(A10b).reason_code], ['adopted', 'hold', 'holdback_running']);

// ---- AC12: a missing outcome file adopts nothing --------------------------------------------------------------------------------------------
const A12 = 'acme__incomplete';
const a12rows = arms(A12, initial(A12), 30, better.on, better.off);
const a12 = repo(A12, a12rows, { noFindings: [a12rows[0].key] });
run([a12]);
t('AC12 a missing findings file adopts nothing and says why', [wrappersRow(A12).decision, wrappersRow(A12).reason_code, wrappersRow(A12).missing], ['hold', 'evidence_incomplete', [join(stateOf(A12), 'workers', `${a12rows[0].key}.findings.jsonl`)]]);
t('AC16 it is recorded as one evidence_incomplete event', eventsOf(A12, 'evidence_incomplete').filter((x) => x.lever === 'wrappers').map((x) => [x.reason_code, x.missing.length]), [['evidence_incomplete', 1]]);
run([a12], NOW + DAY);
t('AC16 the same missing file is not recorded again the next day', eventsOf(A12, 'evidence_incomplete').filter((x) => x.lever === 'wrappers').length, 1);
const A12b = 'acme__nopostmerge';
run([repo(A12b, arms(A12b, initial(A12b), 30, better.on, better.off), { postMerge: false })]);
t('AC12 a missing post-merge.jsonl adopts nothing', [wrappersRow(A12b).decision, wrappersRow(A12b).missing], ['hold', [join(stateOf(A12b), 'post-merge.jsonl')]]);

// ---- AC15: once a day across every repo, under the machine-wide lock --------------------------------------------------------------------
const configRoot = join(T, 'config');
const conf = (slug, gh) => {
  mkdirSync(join(configRoot, 'repos', slug), { recursive: true });
  writeFileSync(join(configRoot, 'repos', slug, 'config.md'), `## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | \`${gh}\` |\n| Default branch | \`main\` |\n\n## 3b. Cost and autonomy\n| Field | Recommended | Your setting |\n|---|---|---|\n| Phase 0 levers | \`none\` | \`auto\` |\n`);
};
['one', 'two', 'three', 'four'].forEach((n) => conf(`acme__${n}`, `acme/${n}`));
const fixtures = {};
for (const n of ['one', 'two', 'three', 'four']) { const s = `acme__${n}`; fixtures[s] = repo(s, arms(s, initial(s), 8, better.on, better.off)); }
let reads = 0;
const rowsFor = ({ slug }) => { reads += 1; return { rows: fixtures[slug].rows, batches: fixtures[slug].batches }; };
const lockDir = join(T, 'home', '.desk-autopilot', 'levers', 'evaluate.lock.d');
mkdirSync(lockDir, { recursive: true });
writeFileSync(join(lockDir, 'pid'), `${process.ppid}\n`);
t('AC15 a pass that finds the lock held does nothing', [evaluateDue({ now: NOW, configRoot, tz: 'UTC', rowsFor }).status, reads], ['busy', 0]);
rmSync(lockDir, { recursive: true, force: true });
const first = evaluateDue({ now: NOW, configRoot, tz: 'UTC', rowsFor });
const passes = [first.status, ...[1, 2, 3].map(() => evaluateDue({ now: NOW + 60_000, configRoot, tz: 'UTC', rowsFor }).status)];
t('AC15 the first of four passes evaluates; the rest find today done', passes, ['ran', 'not_due', 'not_due', 'not_due']);
const pooled = jsonl(join(T, 'home', '.desk-autopilot', 'levers', 'pooled-evals.jsonl'));
t('AC15 the pooled estimates are written once that day, across the four repos', [pooled.filter((p) => p.lever === 'wrappers').length, pooled.find((p) => p.lever === 'wrappers')?.n, pooled.find((p) => p.lever === null)?.repos.length], [1, { on: 32, off: 32 }, 4]);
t('AC15 every repo got its rows from that one run', ['one', 'two', 'three', 'four'].map((n) => evalsOf(`acme__${n}`).filter((x) => x.lever === 'wrappers').length), [1, 1, 1, 1]);
t('AC15 its line names what it did', /^levers evaluate: 28 lever row\(s\) across 4 repo\(s\); no change$/.test(first.line), true);
t('AC15 the next day it runs again', evaluateDue({ now: NOW + DAY, configRoot, tz: 'UTC', rowsFor }).status, 'ran');

// ---- review findings: each guarded -------------------------------------------------------------------------------------------------------------------
run([repo(A10, [])], NOW + DAY);
t('a settled lever still gets its daily row, so the board does not read it stale', [wrappersRow(A10).state, wrappersRow(A10).decision, wrappersRow(A10).reason_code], ['settled', 'hold', 'not_evaluated']);
const settledRows = evalsOf(A10).filter((x) => x.lever === 'wrappers');
t('that row keeps the evidence the lever was last weighed on', [wrappersRow(A10).n, wrappersRow(A10).cost, wrappersRow(A10).evidence_from], [settledRows.at(-2).n, settledRows.at(-2).cost, settledRows.at(-2).eval_id]);
const A10c = 'acme__smallholdback';
const early = append(A10c, { kind: 'transition', lever: 'wrappers', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'adopted', eval_id: 'evl_v', evidence_file: 'levers-evidence/evl_v.jsonl', at: at(-29) });
run([repo(A10c, [
  ...Array.from({ length: 20 }, () => row(A10c, 'adopted', `${A10c}/wrappers/${early.id}`, { merged_at: null })),
  ...Array.from({ length: 5 }, () => row(A10c, 'holdback', `${A10c}/wrappers/${early.id}`)),
])]);
t('a breach on a holdback arm too small to revert on does not settle the lever', [wrappersRow(A10c).decision, wrappersRow(A10c).state, wrappersRow(A10c).reason_code], ['hold', 'adopted', 'holdback_running']);
const { costEstimate } = await import('../desk/bin/levers-evaluate.mjs');
const mix = [
  ...Array.from({ length: 5 }, (_, i) => ({ slug: 'a', on: true, cost: 10 * (1 + i * 0.01), size: 'S' })), ...Array.from({ length: 25 }, (_, i) => ({ slug: 'a', on: false, cost: 10 * (1 + (i % 5) * 0.01), size: 'S' })),
  ...Array.from({ length: 25 }, (_, i) => ({ slug: 'b', on: true, cost: 100 * (1 + (i % 5) * 0.01), size: 'S' })), ...Array.from({ length: 5 }, (_, i) => ({ slug: 'b', on: false, cost: 100 * (1 + i * 0.01), size: 'S' })),
];
t('the pooled cost fit adjusts for the repo each row came from', Math.abs(costEstimate(mix, { seed: 'x', scope: 'pooled' }).ratio - 1) < 0.05, true);
const A12c = 'acme__scanfailed';
const a12c = repo(A12c, arms(A12c, initial(A12c), 30, better.on, better.off));
writeFileSync(join(stateOf(A12c), 'post-merge.jsonl'), `${JSON.stringify({ kind: 'scan', at: at(-1), complete: false, why: 'gh run list failed' })}\n`);
run([a12c]);
t('a post-merge watch whose latest scan failed adopts nothing', [wrappersRow(A12c).decision, wrappersRow(A12c).reason_code], ['hold', 'evidence_incomplete']);
const { failedRuns } = await import('../desk/bin/phase0-report.mjs');
let ghCalls = 0;
const listed = failedRuns({ repo: 'acme/x', since: NOW, jobs: false, gh: () => { ghCalls += 1; return { status: 0, stdout: JSON.stringify([{ databaseId: 1, headBranch: 'b1' }, { databaseId: 2, headBranch: 'b2' }]) }; } });
t('red CI for the evaluation is one list call, no per-run view', [ghCalls, listed.runs.map((r) => r.branch)], [1, ['b1', 'b2']]);
{
  // A round the recorder noted missing stays a gap until a line at its head and round is recorded, and
  // is read whether or not the ticket has a findings file at all.
  const { withOutcomes } = await import('../desk/bin/levers-evaluate.mjs');
  const st = join(T, 'gaps-state');
  mkdirSync(join(st, 'workers'), { recursive: true });
  writeFileSync(join(st, 'post-merge.jsonl'), `${JSON.stringify({ kind: 'scan', at: at(-1), complete: true })}\n`);
  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);
  const put = (key, findings, notes) => {
    if (findings) writeFileSync(join(st, 'workers', `${key}.findings.jsonl`), findings.map((l) => `${JSON.stringify({ ticket: key, ...l })}\n`).join(''));
    writeFileSync(join(st, 'workers', `${key}.runs.jsonl`), notes.map((n) => `${JSON.stringify({ ticket: key, ...n })}\n`).join(''));
  };
  const line = (head, round, reviewer = 'self', extra = {}) => ({ round, reviewer, head, p0: 0, p1: 0, p2: 0, fixed: 0, carried: false, ...extra });
  put('G-1', [line(H1.slice(0, 12), 1)], [{ findings_missing: { head: H2, round: 1 } }]);
  put('G-2', [line(H2.slice(0, 12), 1, 'pr')], [{ findings_missing: { head: H2, round: 1 } }]);
  put('G-3', null, [{ findings_missing: { head: H2, round: 1 } }]);
  put('G-4', [line(H2, 1, 'pr', { from: H1, carried: true })], [{ findings_missing: { head: H2, round: 1 } }]);
  put('G-5', null, []);
  const rows = ['G-1', 'G-2', 'G-3', 'G-4', 'G-5'].map((key) => ({ key, batch: 'gaps', state: 'parked', merged_at: null }));
  const got = withOutcomes(rows, [{ name: 'gaps', state: st }]).rows.map((r) => r.review_p0_p1);
  t('a lost PR round is not cleared by a self-review line at the same round number, only by one at its head', got.slice(0, 2), [null, 0]);
  t('a parked ticket whose only round was lost, with no findings file, is a gap, not clean', got[2], null);
  t('a carried line does not clear a lost round', got[3], null);
  t('a parked ticket with no rounds and no notes counts none', got[4], 0);
}
{
  // A finished, merged ticket moves to the queue's archive (queue-store.mjs archiveDone): it is still evidence.
  const { repoRows } = await import('../desk/bin/levers-evaluate.mjs');
  const dir = join(T, 'archived-batch');
  mkdirSync(dir, { recursive: true });
  const queue = join(dir, 'queue.json');
  writeFileSync(queue, JSON.stringify({ tickets: {} }));
  const added = new Date(NOW - 3 * DAY).toISOString();
  writeFileSync(join(dir, 'queue.archive.json'), JSON.stringify({ tickets: { 'Z-1': {
    key: 'Z-1', state: 'done', added_at: added, merged_at: new Date(NOW - 2 * DAY).toISOString(), result: { pr: 7 }, branch: 'feat/Z-1',
    levers: { set: ['wrappers'], arms: { wrappers: 'on' }, trial_ids: { wrappers: 'acme__arch/wrappers/initial' }, fp: {}, block: null, at: added },
  } } }));
  const gh = () => ({ status: 0, stdout: JSON.stringify([{ databaseId: 1, headBranch: 'feat/Z-1' }, { databaseId: 2, headBranch: 'other' }]) });
  const got = repoRows({ slug: 'acme__arch', ghRepo: 'acme/arch', now: NOW, batches: [{ name: 'b', queue, state: join(dir, 'state') }], gh });
  t('an archived ticket is an evidence row, its red CI matched by its branch', got.rows.map((r) => [r.key, r.ci_reds]), [['Z-1', 1]]);
}

// ---- DS-644: each adopt or revert is a decision, listed on the digest and overridden from it ----------------------------------------------------
{
  const { checkin, override, leverChanges, DEFAULT_TIMES } = await import('../desk/bin/digest.mjs');
  const { applyTrips } = await import('../desk/bin/levers-trips.mjs');
  const { leverStatesIn } = await import('../desk/bin/levers-auto.mjs');
  const HOUR = 3_600_000;
  const BIN = new URL('../desk/bin', import.meta.url).pathname;
  const decisionsOf = (slug) => jsonl(join(stateOf(slug), 'decisions.jsonl')).filter((d) => d.lever && !d.override_of);
  const entry = (slug) => {
    const queue = join(T, 'q', slug, 'queue.json');
    mkdirSync(join(T, 'q', slug), { recursive: true });
    writeFileSync(queue, JSON.stringify({ batch: 'b', tickets: {} }));
    return { slug, batch: null, state: stateOf(slug), queue };
  };
  const TRIPS = 'acme__trips';
  mkdirSync(stateOf(TRIPS), { recursive: true });
  const list = [entry(A1), entry(A2), entry(TRIPS)];
  const dir = join(T, 'digest');
  const dig = (h) => checkin({ times: DEFAULT_TIMES, now: new Date(NOW + h * HOUR), dir, list, bin: BIN, self: A1, promote: () => null, checkJira: () => null });
  const leversOf = (page) => { const s = page.indexOf('## Levers\n'); return s < 0 ? null : page.slice(s, page.indexOf('\n## ', s + 1) < 0 ? undefined : page.indexOf('\n## ', s + 1)).trim().split('\n'); };

  const [d1] = decisionsOf(A1);
  t('DS-644 AC3 the adopt is one engineering decision in the repo\'s decisions log', decisionsOf(A1).map((d) => [d.lever, d.category, d.chose, d.lever_event]), [['wrappers', 'engineering', 'on', a1t[0].id]]);
  const [d2] = decisionsOf(A2);
  t('DS-644 AC3 a revert is one too, with off chosen', decisionsOf(A2).map((d) => [d.lever, d.category, d.chose]), [['wrappers', 'engineering', 'off']]);

  const r1 = await dig(12);
  const p1 = readFileSync(r1.page, 'utf8');
  const l1 = leversOf(p1);
  const adoptLine = l1?.find((l) => l.startsWith('- [ ] adopted wrappers in adopts'));
  t('DS-644 AC1 the Levers line names the lever, the repo, the mechanism and cost changes with their intervals, the tickets per arm and the guardrails',
    /^- \[ \] adopted wrappers in adopts: permission denials per start -\d+% \(90%: -\d+% to -\d+%\), cost per ticket [+-]?\d+% \([+-]?\d+% to [+-]?\d+%\), 30 vs 30 tickets, no guardrail moved · id `[0-9a-f]{16}` · override: `node \S+digest\.mjs override acme__adopts [0-9a-f]{16} off`$/.test(adoptLine ?? ''), true);
  t('DS-644 AC1 it carries the decision\'s id', adoptLine?.includes(`id \`${d1.id}\``), true);
  t('DS-644 AC1 and raises no needs-you item', [eventsOf(A1, 'needs_you').length, p1.includes('### Questions'), p1.includes('### Decisions taken')], [0, false, false]);
  t('DS-644 AC11 the section\'s last line opens the Levers page', l1?.at(-1), `open: file://${join(T, 'home', '.desk-autopilot', 'levers', 'index.html')}`);
  t('DS-644 AC11 and the digest builds the page it links', existsSync(join(T, 'home', '.desk-autopilot', 'levers', 'index.html')), true);
  t('DS-644 a push for lever changes alone counts their repos', /lever change\(s\) across 2 repo\(s\)/.test(r1.push?.text ?? ''), true);
  t('DS-644 the revert is listed with its reason', l1?.some((l) => l.startsWith('- [ ] reverted wrappers in breach (fix tries and parks per ticket rose past their margin): ')), true);

  t('DS-644 AC2 no lever change since the last digest, no Levers section', leversOf(readFileSync((await dig(36)).page, 'utf8')), null);

  // A hard trip in another repo, and the adopt overridden off and the revert on.
  applyTrips({ slug: TRIPS, trips: [{ lever: 'wrappers', trip: 'post-merge-revert', ticket: 'T-900', file: join(stateOf(TRIPS), 'post-merge.jsonl'), line: 3, why: 'its PR #9 was reverted after merging', from: 'trial' }], now: NOW + 40 * HOUR });
  t('DS-644 AC3 a trip is a decision too, naming its ticket', decisionsOf(TRIPS).map((d) => [d.lever, d.category, d.chose, d.ticket]), [['wrappers', 'engineering', 'off', 'T-900']]);
  t('DS-644 an override takes only on or off', [override({ slug: A1, id: d1.id, choice: 'maybe', dir, list }).ok, eventsOf(A1, 'override').length], [false, 0]);
  const o1 = override({ slug: A1, id: d1.id, choice: 'off', dir, list, now: new Date(NOW + 41 * HOUR) });
  t('DS-644 AC12 overriding the adopt off appends one override event, actor ben, with the decision id', [o1.ok, eventsOf(A1, 'override').map((e) => [e.actor, e.decision_id, e.to, e.value])], [true, [['ben', d1.id, 'overridden', 'off']]]);
  t('DS-644 AC4 the lever\'s state reads overridden', leverStatesIn(read(A1).events).wrappers.state, 'overridden');
  const values = { 'worker-location': 'local' };
  const n1 = assignPin('NEXT-1', { slug: A1, size: 'S', states: AUTO, frozen: false, random: seededRandom(1), now: new Date(NOW + 42 * HOUR), values });
  t('DS-644 AC4 the next ticket admitted there has it pinned off, with no arm', [n1.assigned, n1.pin.set.includes('wrappers'), Object.hasOwn(n1.pin.arms, 'wrappers')], [true, false, false]);
  t('DS-644 the same decision cannot be overridden twice', override({ slug: A1, id: d1.id, choice: 'on', dir, list }).ok, false);
  t('DS-644 AC8 overriding the revert on', override({ slug: A2, id: d2.id, choice: 'on', dir, list, now: new Date(NOW + 41 * HOUR) }).ok, true);
  const n2 = assignPin('NEXT-2', { slug: A2, size: 'S', states: AUTO, frozen: false, random: seededRandom(2), now: new Date(NOW + 42 * HOUR), values });
  t('DS-644 AC8 the next ticket admitted there has it pinned on and its state reads overridden', [n2.pin.set.includes('wrappers'), Object.hasOwn(n2.pin.arms, 'wrappers'), leverStatesIn(read(A2).events).wrappers.state], [true, false, 'overridden']);

  const page3 = (await dig(60)).page;
  const l3 = leversOf(readFileSync(page3, 'utf8'));
  t('DS-644 AC9 a hard-trip revert names the trip and the ticket',
    l3?.find((l) => l.includes('in trips')), `- [ ] reverted wrappers in trips on a hard trip, post-merge-revert on T-900: its PR #9 was reverted after merging (${join(stateOf(TRIPS), 'post-merge.jsonl')}:3) · id \`${decisionsOf(TRIPS)[0].id}\` · override: \`node ${join(BIN, 'digest.mjs')} override ${TRIPS} ${decisionsOf(TRIPS)[0].id} on\``);
  t('DS-644 each override is listed too', l3?.filter((l) => l.startsWith('- overridden ')), [`- overridden wrappers off in adopts by ben (decision \`${d1.id}\`)`, `- overridden wrappers on in breach by ben (decision \`${d2.id}\`)`]);

  // A lever log with an unreadable line is one admission would not read, so it takes no override.
  const tripLog = logFile(TRIPS);
  const tripBody = readFileSync(tripLog, 'utf8');
  writeFileSync(tripLog, `${tripBody}not an event\n`);
  const [dt] = decisionsOf(TRIPS);
  const refused = override({ slug: TRIPS, id: dt.id, choice: 'on', dir, list, now: new Date(NOW + 61 * HOUR) });
  t('DS-644 an override is refused while the lever log has an unreadable line', [refused.ok, /unreadable line/.test(refused.why ?? ''), eventsOf(TRIPS, 'override').length], [false, true, 0]);
  writeFileSync(tripLog, tripBody);
  const o3 = override({ slug: TRIPS, id: dt.id, choice: 'on', dir, list, now: new Date(NOW + 61 * HOUR) });
  const p3 = readFileSync(page3, 'utf8');
  t('DS-644 the override ticks the lever\'s line on the latest digest and takes its command off', [o3.ok, o3.marked, leversOf(p3)?.some((l) => l.startsWith('- [x] reverted wrappers in trips') && !l.includes('override: ') && l.includes('overridden to **on**'))], [true, true, true]);

  // An adopt that lands in the log after a digest passed its time, with no decision written for it.
  append(TRIPS, { kind: 'transition', lever: 'wrappers', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'every adopt condition held', eval_id: 'late', evidence_file: 'late.json', at: new Date(NOW + 59.5 * HOUR).toISOString() });
  // A failed build a supervisor's refresh recorded moments ago: the digest's own refresh skips it on
  // unchanged inputs, and the digest still says the page could not be rebuilt.
  refreshLevers();
  const buildFile = join(T, 'home', '.desk-autopilot', 'levers', 'build.json');
  const goodBuild = readFileSync(buildFile, 'utf8');
  writeFileSync(buildFile, JSON.stringify({ ...JSON.parse(goodBuild), attempted_at: new Date().toISOString(), failed: { at: new Date().toISOString(), error: { file: null, line: null, message: 'x' }, where: 'adopts lever-evals.jsonl line 3' } }));
  const l4 = leversOf(readFileSync((await dig(84)).page, 'utf8'));
  t('DS-654 a build failure a recent refresh recorded is still named in the digest',
    l4?.some((l) => l.includes('the Levers page could not be rebuilt, so it may be out of date: adopts lever-evals.jsonl line 3')), true);
  writeFileSync(buildFile, goodBuild);
  const late = decisionsOf(TRIPS).find((d) => d.chose === 'on');
  t('DS-644 an event that landed after the last digest passed its time is listed by the next, with its decision recorded then',
    [!!late, l4?.some((l) => l.startsWith('- [ ] adopted wrappers in trips') && l.includes(`id \`${late?.id}\``))], [true, true]);
  t('DS-644 and only once', leversOf(readFileSync((await dig(108)).page, 'utf8')), null);

  // An override whose run stopped after its lever log event and before its decision log entry.
  const decFile = join(stateOf(TRIPS), 'decisions.jsonl');
  const decBody = readFileSync(decFile, 'utf8');
  const lost = decBody.split('\n').filter((l) => !l.includes(`"override_of":"${dt.id}"`)).join('\n');
  writeFileSync(decFile, lost);
  const again = override({ slug: TRIPS, id: dt.id, choice: 'on', dir, list, now: new Date(NOW + 120 * HOUR) });
  t('DS-644 a retried override finishes its decision entry and writes no second override event',
    [again.ok, eventsOf(TRIPS, 'override').length, again.entry?.at === eventsOf(TRIPS, 'override')[0]?.at], [true, 1, true]);
  writeFileSync(decFile, lost);
  const flip = override({ slug: TRIPS, id: dt.id, choice: 'off', dir, list, now: new Date(NOW + 121 * HOUR) });
  t('DS-644 and one to the other value is refused', [flip.ok, /already overridden on/.test(flip.why ?? ''), eventsOf(TRIPS, 'override').length], [false, true, 1]);
  writeFileSync(decFile, decBody);

  // A trip stamped after the override's own time, written to the log first: the override still holds.
  const RACE = 'acme__race';
  mkdirSync(stateOf(RACE), { recursive: true });
  applyTrips({ slug: RACE, trips: [{ lever: 'wrappers', trip: 'post-merge-revert', ticket: 'T-901', file: join(stateOf(RACE), 'post-merge.jsonl'), line: 1, why: 'reverted', from: 'trial' }], now: NOW + 100 * HOUR });
  const [dr] = decisionsOf(RACE);
  const raced = override({ slug: RACE, id: dr.id, choice: 'on', dir, list: [...list, entry(RACE)], now: new Date(NOW + 99 * HOUR) });
  t('DS-644 an override written after a later-stamped trip is not replayed before it',
    [raced.ok, leverStatesIn(read(RACE).events).wrappers.state, leverStatesIn(read(RACE).events).wrappers.value], [true, 'overridden', 'on']);
  t('DS-644 a first override is not superseded', raced.superseded, false);
  // Its decision entry lost, then the lever set the other way by another decision: the retry says so.
  const raceDec = join(stateOf(RACE), 'decisions.jsonl');
  append(RACE, { kind: 'override', lever: 'wrappers', actor: 'ben', reason_code: 'ben_override', reason: 'set off by hand', from: 'overridden', to: 'overridden', value: 'off', decision_id: 'other', at: new Date(NOW + 101 * HOUR).toISOString() });
  writeFileSync(raceDec, readFileSync(raceDec, 'utf8').split('\n').filter((l) => !l.includes(`"override_of":"${dr.id}"`)).join('\n'));
  const stale = override({ slug: RACE, id: dr.id, choice: 'on', dir, list: [...list, entry(RACE)], now: new Date(NOW + 102 * HOUR) });
  t('DS-644 a retried override another change has since replaced says it is superseded, writing no event',
    [stale.ok, stale.superseded, eventsOf(RACE, 'override').length, leverStatesIn(read(RACE).events).wrappers.value], [true, true, 2, 'off']);

  // A repo with only named batches lists no standing entry until its decision log exists.
  const NAMED = 'acme__named';
  append(NAMED, { kind: 'transition', lever: 'wrappers', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'every adopt condition held', eval_id: 'named', evidence_file: 'named.json', at: new Date(NOW + 130 * HOUR).toISOString() });
  const named = leverChanges({ list: [{ slug: NAMED, batch: 'b1', state: join(stateOf(NAMED), 'batches', 'b1'), queue: join(T, 'q', NAMED, 'queue.json') }], now: new Date(NOW + 131 * HOUR) });
  t('DS-644 a lever change in a repo with only named batches records its decision in the repo\'s own log and lists its command',
    [named.changes.length, /override: `node \S+ override acme__named [0-9a-f]{16} off`$/.test(named.changes[0]?.line ?? ''), decisionsOf(NAMED).length], [1, true, 1]);

  run([repo(A1, a1rows)], NOW + 2 * DAY);
  t('DS-644 AC5 an overridden lever is not evaluated, so evidence that would adopt it leaves it overridden', [wrappersRow(A1).state, wrappersRow(A1).reason_code, transitionOf(A1).length, leverStatesIn(read(A1).events).wrappers.state], ['overridden', 'not_evaluated', 1, 'overridden']);
}

// ---- the rule itself ------------------------------------------------------------------------------------------------------------------------------
t('the rule: no cost interval (a singular fit) does not adopt', decide({ ...{ state: 'trial', n: { on: 40, off: 40 }, minN: 30, maxN: 150, now: NOW, holdbackWeeks: 4 }, mechanism: { metric: 'm', min_benefit: -0.25, est: -0.6, p_benefit: 1 }, cost: { ratio: null, lo90: null, hi90: null }, guardrails: [{ status: 'ok' }] }).reason_code, 'adopt_conditions_unmet');
const ok = { status: 'ok' };
const good = { mechanism: { metric: 'm', min_benefit: -0.25, est: -0.6, lo90: -0.7, hi90: -0.5, p_benefit: 1 }, cost: { ratio: 1, lo90: 0.95, hi90: 1.02 }, guardrails: [ok, ok] };
const base = { state: 'trial', n: { on: 40, off: 40 }, minN: 30, maxN: 150, now: NOW, holdbackWeeks: 4 };
t('the rule: a cost interval reaching 1.05 does not adopt', decide({ ...base, ...good, cost: { ratio: 1, lo90: 0.9, hi90: 1.05 } }).reason_code, 'adopt_conditions_unmet');
t('the rule: a guardrail only watching does not adopt', decide({ ...base, ...good, guardrails: [ok, { status: 'watching' }] }).reason_code, 'adopt_conditions_unmet');
t('the rule: a lever with no registered minimum never adopts', decide({ ...base, ...good, mechanism: { ...good.mechanism, min_benefit: null, p_benefit: null } }).reason_code, 'adopt_conditions_unmet');
t('the rule: a breach below the revert floor holds', decide({ ...base, ...good, n: { on: DECISION_RULE.revert_min_per_arm - 1, off: 20 }, guardrails: [{ name: 'acceptance', status: 'breached', p_worse: 1 }] }).reason_code, 'below_min_sample');
t('the rule: frozen trials hold', decide({ ...base, ...good, frozen: true }).reason_code, 'freeze');

// ---- DS-646: the quality-risk layer adopts on audit evidence, and a pair of kept levers is tried together ----------------
{
  const { ENTRIES, loadRegistry } = await import('../desk/bin/lever-registry.mjs');
  const { pairTrial } = await import('../desk/bin/levers-auto.mjs');
  // review-reuse with a minimum set, so its evidence can meet every adopt condition.
  const QR = loadRegistry({ ...ENTRIES, 'review-reuse': { ...ENTRIES['review-reuse'], mechanism: { ...ENTRIES['review-reuse'].mechanism, minimum: 0.3, minimum_set: true } } });
  const byHand = (slug, lever, to, when) => append(slug, { kind: 'override', lever, to, actor: 'ben', reason_code: 'ben_override', reason: `${lever} ${to} by hand`, at: when });
  const qrow = (slug, key, arm, tid, o = {}) => row(slug, arm, tid, { review_rounds: arm === 'on' ? 1 : 3, pin: { set: arm === 'on' ? key.split('+') : [], arms: { [key]: arm }, trial_ids: { [key]: tid }, fp: null }, ...o });
  const qarms = (slug, key, tid, n) => [...Array.from({ length: n }, () => qrow(slug, key, 'on', tid)), ...Array.from({ length: n }, () => qrow(slug, key, 'off', tid))];
  const evalQ = (repos) => evaluate({ repos, now: NOW, tz: 'UTC', root: join(T, `pooled-q-${++seq}`), frozen: false, fingerprints: FP, registry: QR });
  const rowOf = (slug, lever) => evalsOf(slug).filter((x) => x.lever === lever).at(-1);
  const audit = (slug, tid, o = {}) => writeFileSync(join(stateOf(slug), 'audit.jsonl'), `${JSON.stringify({ v: 1, at: at(-2), repo: slug, ticket: 'T-a', trial_id: tid, reviewer: 'audit', p0: 0, p1: 0, usd: 4.2, ...o })}\n`);
  const queued = (slug, tid, state) => writeFileSync(join(stateOf(slug), 'audit-queue.json'), JSON.stringify({ v: 1, trials: {}, items: { 'T-q': { ticket: 'T-q', trial_id: tid, lever: 'review-reuse', state } } }));

  // AC6: 40 per arm meeting every condition, no audit recorded from the repo: stays on trial.
  const Q6 = 'acme__q6';
  const tr6 = byHand(Q6, 'review-reuse', 'trial', at(-30));
  const tid6 = `${Q6}/review-reuse/${tr6.id}`;
  evalQ([repo(Q6, qarms(Q6, 'review-reuse', tid6, 40))]);
  const q6 = rowOf(Q6, 'review-reuse');
  t('AC6 no audit recorded in the repo: it stays on trial', [q6.decision, q6.state, q6.reason_code, transitionOf(Q6, 'review-reuse').length], ['hold', 'trial', 'audit_missing', 0]);
  t('AC6 the mechanism, cost and guardrails alone would adopt it', [q6.mechanism.p_benefit >= 0.9, q6.cost.hi90 < 1.05, q6.guardrails.every((g) => g.status === 'ok')], [true, true, true]);
  t('AC6 the row carries the audit counts and says what it needs', [q6.audits, /no blind audit/.test(q6.reason)], [{ recorded: 0, pending: 0 }, true]);
  const Q6b = 'acme__q6b';
  const tr6b = byHand(Q6b, 'review-reuse', 'trial', at(-30));
  const tid6b = `${Q6b}/review-reuse/${tr6b.id}`;
  const r6b = repo(Q6b, qarms(Q6b, 'review-reuse', tid6b, 40));
  audit(Q6b, `${Q6}/review-reuse/other`);
  evalQ([r6b]);
  t('AC6 an audit of another trial is not this one\'s evidence', rowOf(Q6b, 'review-reuse').reason_code, 'audit_missing');

  // AC7: audits due and deferred hold the adopt until they are recorded.
  const Q7 = 'acme__q7';
  const tr7 = byHand(Q7, 'review-reuse', 'trial', at(-30));
  const tid7 = `${Q7}/review-reuse/${tr7.id}`;
  const r7 = repo(Q7, qarms(Q7, 'review-reuse', tid7, 40));
  audit(Q7, tid7);
  queued(Q7, tid7, 'deferred');
  evalQ([r7]);
  const q7 = rowOf(Q7, 'review-reuse');
  t('AC7 an audit due and deferred: no adopt', [q7.decision, q7.state, q7.reason_code, q7.audits], ['hold', 'trial', 'audits_pending', { recorded: 1, pending: 1 }]);
  t('AC7 the next change names the audits', /due audit/.test(q7.next.needs), true);
  const Q7c = 'acme__q7c';
  const tr7c = byHand(Q7c, 'review-reuse', 'trial', at(-30));
  const tid7c = `${Q7c}/review-reuse/${tr7c.id}`;
  const r7c = repo(Q7c, qarms(Q7c, 'review-reuse', tid7c, 40));
  audit(Q7c, tid7c);
  queued(Q7c, tid7c, 'failed');
  evalQ([r7c]);
  t('AC7 an audit whose spawn failed for good is not waited on', [rowOf(Q7c, 'review-reuse').decision, rowOf(Q7c, 'review-reuse').audits], ['adopt', { recorded: 1, pending: 0 }]);
  const Q7b = 'acme__q7b';
  const tr7b = byHand(Q7b, 'review-reuse', 'trial', at(-30));
  const tid7b = `${Q7b}/review-reuse/${tr7b.id}`;
  const r7b = repo(Q7b, qarms(Q7b, 'review-reuse', tid7b, 40));
  audit(Q7b, tid7b);
  evalQ([r7b]);
  t('AC7 with the audits recorded and none due, the quality-risk lever adopts', [rowOf(Q7b, 'review-reuse').decision, transitionOf(Q7b, 'review-reuse').map((e) => [e.from, e.to])], ['adopt', [['trial', 'adopted']]]);

  // A quality-risk lever reverted from its trial is weighed under the same audit gate, on the trial its
  // tickets drew under; one a blind audit's P0 reverted never adopts again.
  const revertedFrom = (slug, reasonCode, kind = 'transition') => {
    const tr = byHand(slug, 'review-reuse', 'trial', at(-60));
    const tid = `${slug}/review-reuse/${tr.id}`;
    append(slug, { kind, lever: 'review-reuse', from: 'trial', to: 'reverted', actor: kind === 'trip' ? 'audit' : 'levers-auto', reason_code: reasonCode, reason: 'reverted', at: at(-20),
      ...(kind === 'trip' ? { ticket: 'T-p0', trip: 'audit-p0', evidence_file: '/x/audit.jsonl', evidence_line: 1 } : { eval_id: 'evl_r', evidence_file: 'levers-evidence/evl_r.jsonl' }) });
    return { tid, r: repo(slug, qarms(slug, 'review-reuse', tid, 40)) };
  };
  const QR1 = 'acme__qr1';
  const r1 = revertedFrom(QR1, 'max_sample_no_adopt');
  evalQ([r1.r]);
  t('reverted quality-risk lever, no audit recorded: it does not adopt', [rowOf(QR1, 'review-reuse').decision, rowOf(QR1, 'review-reuse').reason_code, rowOf(QR1, 'review-reuse').audits], ['hold', 'audit_missing', { recorded: 0, pending: 0 }]);
  const QR2 = 'acme__qr2';
  const r2 = revertedFrom(QR2, 'max_sample_no_adopt');
  audit(QR2, r2.tid);
  evalQ([r2.r]);
  t('reverted quality-risk lever, its trial audited: it adopts', [rowOf(QR2, 'review-reuse').decision, transitionOf(QR2, 'review-reuse').map((e) => [e.from, e.to]).at(-1)], ['adopt', ['reverted', 'adopted']]);
  const QR3 = 'acme__qr3';
  const r3 = revertedFrom(QR3, 'audit_p0', 'trip');
  audit(QR3, r3.tid);
  evalQ([r3.r]);
  t('reverted by a blind audit\'s P0: it never adopts again', [rowOf(QR3, 'review-reuse').decision, /blind audit found a P0/.test(rowOf(QR3, 'review-reuse').reason)], ['hold', true]);

  // AC12: arm_share_7d is the share of the repo's last 7 days of admitted tickets that carried it.
  const assign = (slug, key, set, when) => append(slug, { kind: 'assign', actor: 'levers-auto', reason_code: 'assigned_at_admission', reason: `${key} drew`, ticket: key, set, arms: {}, trial_ids: {}, at: when });
  for (let i = 0; i < 10; i++) assign(Q6b, `A-${i}`, i < 3 ? ['review-reuse'] : ['memory'], at(-1));
  assign(Q6b, 'A-old', ['review-reuse'], at(-9));
  const Q12 = 'acme__q12';
  const tr12 = byHand(Q12, 'review-reuse', 'trial', at(-30));
  for (let i = 0; i < 10; i++) assign(Q12, `A-${i}`, i < 3 ? ['review-reuse'] : ['memory'], at(-1));
  assign(Q12, 'A-old', ['review-reuse'], at(-9));
  evalQ([repo(Q12, qarms(Q12, 'review-reuse', `${Q12}/review-reuse/${tr12.id}`, 10))]);
  t('AC12 the row holds arm_share_7d: 3 of the 10 tickets admitted in the last 7 days carried it', rowOf(Q12, 'review-reuse').arm_share_7d, 0.3);

  // AC10: the pair trial of two kept alone, 40 per arm meeting the rule with audit evidence: the pair becomes the default.
  const Q10 = 'acme__q10';
  byHand(Q10, 'codex', 'adopted', at(-60));
  byHand(Q10, 'review-reuse', 'settled', at(-40));
  const pt = pairTrial({ slug: Q10, events: read(Q10).events, states: AUTO, values: null, registry: QR, now: NOW });
  t('AC10 the repo runs a pair trial of the two', [pt?.key, pt?.state], ['codex+review-reuse', 'trial']);
  const r10 = repo(Q10, qarms(Q10, pt.key, pt.id, 40));
  evalQ([r10]);
  const q10a = rowOf(Q10, pt.key);
  t('AC10 no audit of the pair yet: it holds', [q10a.decision, q10a.reason_code, eventsOf(Q10, 'pair').length], ['hold', 'audit_missing', 0]);
  const Q10b = 'acme__q10b';
  byHand(Q10b, 'codex', 'adopted', at(-60));
  byHand(Q10b, 'review-reuse', 'settled', at(-40));
  const ptb = pairTrial({ slug: Q10b, events: read(Q10b).events, states: AUTO, values: null, registry: QR, now: NOW });
  const r10b = repo(Q10b, qarms(Q10b, ptb.key, ptb.id, 40));
  audit(Q10b, ptb.id);
  evalQ([r10b]);
  const q10 = rowOf(Q10b, ptb.key);
  t('AC10 with audit evidence the pair is adopted', [q10.decision, q10.state, q10.reason_code, q10.pair], ['adopt', 'adopted', 'adopt_all_conditions', ['codex', 'review-reuse']]);
  const pe = eventsOf(Q10b, 'pair');
  t('AC10 one pair event, trial to adopted, citing the evaluation', pe.map((e) => [e.levers, e.from, e.to, e.trial_id, e.eval_id === q10.eval_id]), [[['codex', 'review-reuse'], 'trial', 'adopted', ptb.id, true]]);
  t('AC10 the pair is the repo\'s default from then on', pairTrial({ slug: Q10b, events: read(Q10b).events, states: AUTO, values: null, registry: QR, now: NOW }).state, 'adopted');
  const pin = assignPin('N-1', { slug: Q10b, size: 'S', states: AUTO, random: seededRandom(1), now: new Date(NOW), inFlight: [], values: { 'worker-location': 'local' }, registry: QR }).pin;
  t('AC10 the next ticket carries both, with no pair arm', [['codex', 'review-reuse'].every((l) => pin.set.includes(l)), pin.arms[ptb.key] ?? null], [true, null]);
  t('AC10 a pair adopt needs no mechanism of its own', decide({ ...base, ...good, mechanism: null, pair: true, audits: { recorded: 1, pending: 0 } }).decision, 'adopt');
  const { leverChanges: pairChanges } = await import('../desk/bin/digest.mjs');
  const pairLines = pairChanges({ list: [{ slug: Q10b, state: stateOf(Q10b) }], now: new Date(NOW + 3_600_000) }).changes.map((c) => c.line);
  t('AC10 the digest lists the pair adopt as the repo\'s new default', pairLines.some((l) => l.startsWith('adopted codex with review-reuse together in q10b, now its default')), true);
}

rmSync(T, { recursive: true, force: true });
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all checks passed');
