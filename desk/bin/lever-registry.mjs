// The Phase 0 lever registry: for each lever desk may trial, its layer, its mechanism metric and the
// minimum benefit an adopt needs, the guardrail margins, the hard trips that revert it at once, the
// code files its fingerprint covers, its exposure ramp and the repo preconditions it needs. A lever
// this file does not declare is never trialled. Loading checks every entry and throws, naming the
// lever and the key, rather than letting a half-declared lever reach a trial. The lever names are
// desk-env's LEVERS: the registry declares an entry for each of them and no other.
//
//   import { REGISTRY, trialable, preconditions, repoValues, REASON_CODES, reasonWording,
//            leverFingerprints, isValued, armOn, armOff } from './lever-registry.mjs'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerLocation, workerModels, parseWorkerModels, parseWorkerLocation, repoConfigValue, repoConfigValues, configValues, LEVERS, MODEL_BASELINE, parseLevers, HOME, deskHome } from './desk-env.mjs';
import { ALIAS, ROWS } from './config-schema.mjs';

export const LAYERS = Object.freeze(['low-risk', 'quality-risk']);
// The evaluation states in which a lever has been kept.
export const KEPT_STATES = Object.freeze(['adopted', 'settled']);

// The epic's decision rule, shared by every lever: an adopt needs the mechanism metric better by at
// least the lever's minimum with this probability, the cost ratio's upper bound below `cost_ratio_max`,
// and every guardrail within its margin, on at least the layer's `min_per_arm` tickets per arm and at
// most `max_per_arm`. A lever changes state at most once per repo every `cooldown_days`, and a revert
// on a guardrail may come before the minimum sample but not below `revert_min_per_arm`.
export const DECISION_RULE = Object.freeze({
  probability: 0.9,
  cost_ratio_max: 1.05,
  min_per_arm: Object.freeze({ 'low-risk': 30, 'quality-risk': 40 }),
  max_per_arm: 150,
  cooldown_days: 7,
  revert_min_per_arm: 10,
});

// Guardrails, judged per repo. A rate-ratio margin is the lever arm's rate over the off arm's.
export const GUARDRAILS = Object.freeze({
  acceptance: Object.freeze({ metric: 'acceptance rate', margin: Object.freeze({ max_drop_points: 5 }) }),
  'fix-tries-parks': Object.freeze({ metric: 'fix tries and parks per ticket', excludes: Object.freeze(['quota', 'dependency wait']), margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
  'ci-reds': Object.freeze({ metric: 'CI reds on the branch per ticket', margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
  'review-p0-p1': Object.freeze({ metric: 'review P0 and P1 findings per ticket', margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
  'post-merge': Object.freeze({ metric: 'post-merge reverts or red main within 24 hours per ticket', margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
  'parked-hours': Object.freeze({ metric: 'parked hours per ticket', margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
});

// How much of a repo's tickets a lever reaches. The low-risk layer is a factorial, each lever drawn on
// for half the tickets; the quality-risk layer is exclusive (one such lever per ticket), steps through
// `ramp` and never reaches more than `cap` of a repo's tickets in flight while unproven. A trial steps
// to the ramp's next share once `step_after` tickets have carried it at its current share with no hard
// trip. After an adopt, `holdback` of tickets stay off for `holdback_weeks`.
const RAMPS = Object.freeze({
  'low-risk': Object.freeze({ on_share: 0.5, exclusive: false, holdback: 0.1, holdback_weeks: 4 }),
  'quality-risk': Object.freeze({ ramp: Object.freeze([0.1, 0.25, 0.5]), step_after: 15, cap: 0.3, exclusive: true, holdback: 0.1, holdback_weeks: 4 }),
});

// Hard trips: a condition that reverts the lever in that repo within one pass, with no statistics.
// `step` names the lever's own command, whose non-zero exit on an on-arm start is a trip.
export const POST_MERGE_REVERT = Object.freeze({ id: 'post-merge-revert', when: 'a post-merge revert is recorded for a ticket on the lever\'s arm' });
// A quality-risk lever's blind post-merge audit finding a P0 on an on-arm PR. `by` names the module that
// applies it, where it is not one of levers-trips.mjs's detectors.
const AUDIT_P0 = Object.freeze({ id: 'audit-p0', by: 'levers-audit.mjs', when: 'the blind audit of a merged PR drawn on for the lever finds a P0' });
// The codex lever's dead seats: a desk-codex review call that timed out (exit 124) or found no Codex
// login to take it (75). More than `rate` of the last `calls` such calls on on-arm tickets trips it.
const CODEX_DEAD_SEATS = Object.freeze({ id: 'codex-dead-seats', exits: Object.freeze([124, 75]), calls: 10, rate: 0.2, when: 'more than 20% of the last 10 desk-codex calls on on-arm tickets died (exit 124 or 75)' });
const ownStepError = (step) => Object.freeze({ id: 'own-step-error', step, when: `a start on an on-arm ticket records ${step} exiting non-zero` });

// The models each model lever tries against its baseline.
const FINDER_MODELS = Object.freeze(['sonnet', 'haiku']);
const WORKER_MODELS = Object.freeze(['sonnet']);
const MODEL_KINDS = Object.freeze(['finder', 'worker']);

const code = (path, part) => Object.freeze(part ? { path, part } : { path });
const metric = (name, minimum) => Object.freeze({ metric: name, direction: 'down', minimum, minimum_set: minimum != null });

// `minimum` is the relative decrease an adopt needs (0.3 is down 30%); null is not yet set, and no
// lever with an unset minimum can be adopted. `trialled: false` is declared but not yet put on trial.
// A lever with more than an on and an off arm declares `values`, two or more arm names, and which of
// them is its `baseline`, the arm a ticket runs on outside a trial. A low-risk one is drawn one of its
// values in blocks; a quality-risk one is drawn on for its trial by exposure, as any quality-risk lever
// is, and a ticket drawn on carries one of its other values (levers-auto.mjs). Every other value is
// weighed against the baseline (levers-evaluate.mjs). A lever with no `values` is on or off. A model
// lever names in `model` the §3b Worker models model it moves (`worker`, every start's, or `finder`,
// desk-review's Claude finders'): its baseline is `config`, that model as the row names it, and each
// other value is a model to run instead (a finder's an Agent tool alias). A lever weighed on
// only some of its tickets names them in `rows`; one with a guardrail of its own declares it in
// `guardrails`, beside the shared ones, its breach code `guardrail_` and its key in snake_case.
export const ENTRIES = Object.freeze({
  preflight: {
    layer: 'low-risk', trialled: true,
    mechanism: metric('preflight dollars per start', 0.3),
    trips: [Object.freeze({ id: 'skipped-preflight-failure', when: 'a worker that skipped its preflight fails on a tool or permission the preflight checks' }), POST_MERGE_REVERT, ownStepError('the preflight')],
    code: [code('desk/bin/spawn-worker.sh', 'preflight block'), code('desk/bin/preflight-fingerprint.mjs')],
    preconditions: [],
  },
  wrappers: {
    layer: 'low-risk', trialled: true,
    mechanism: metric('permission denials per start', 0.25),
    trips: [POST_MERGE_REVERT, ownStepError('desk-env lines')],
    code: [code('hooks/desk-worker-hints.py'), code('desk/bin/worker-settings.mjs')],
    preconditions: [],
  },
  memory: {
    layer: 'low-risk', trialled: true,
    mechanism: metric('start bytes', 0.2),
    trips: [POST_MERGE_REVERT, ownStepError('memory-digest.mjs')],
    code: [code('desk/bin/memory-digest.mjs')],
    preconditions: [],
  },
  'failure-class': {
    layer: 'low-risk', trialled: true,
    mechanism: metric('fix tries per ticket', null),
    trips: [Object.freeze({ id: 'stale-wait', hours: 48, when: 'a ticket waits more than 48 hours in a waiting class after its blocker settled' }), POST_MERGE_REVERT, ownStepError('failure-class.mjs')],
    code: [code('desk/bin/failure-class.mjs')],
    preconditions: [],
  },
  codex: {
    layer: 'quality-risk', trialled: true,
    mechanism: metric('codex seats died per review', null),
    trips: [POST_MERGE_REVERT, ownStepError('desk-codex'), CODEX_DEAD_SEATS, AUDIT_P0],
    code: [code('desk/bin/desk-codex.mjs')],
    preconditions: [],
  },
  'review-reuse': {
    layer: 'quality-risk', trialled: true,
    mechanism: metric('review runs per ticket', null),
    trips: [POST_MERGE_REVERT, ownStepError('undraft.mjs'), AUDIT_P0],
    code: [code('desk/bin/undraft.mjs'), code('desk/bin/review-threads.mjs')],
    preconditions: [],
  },
  effort: {
    layer: 'quality-risk', trialled: true,
    mechanism: metric('dollars per start', null),
    trips: [POST_MERGE_REVERT, ownStepError('desk-env effort'), AUDIT_P0],
    code: [code('desk/bin/desk-env.mjs', 'effort')],
    preconditions: [Object.freeze({ id: 'worker-location', want: 'local', status: 'needs local workers', why: 'effort is set on the local claude launch; a cloud worker never takes it' })],
  },
  // desk-review's Claude finder seats on each model against §3b Worker models' finders (`config`). Bea,
  // the refuters, codex and the audit keep theirs.
  'finder-model': {
    layer: 'quality-risk', trialled: true, model: 'finder', values: [MODEL_BASELINE, ...FINDER_MODELS], baseline: MODEL_BASELINE,
    mechanism: metric('dollars per start', null),
    trips: [POST_MERGE_REVERT, ownStepError('desk-env model finder'), AUDIT_P0],
    code: [code('desk/bin/desk-env.mjs', 'model finder')],
    preconditions: [Object.freeze({ id: 'worker-finder-model', not: FINDER_MODELS, status: `finders already on ${FINDER_MODELS.join('/')}`, why: `§3b Worker models already runs its finders on one of ${FINDER_MODELS.join(', ')}, so that value would be the baseline` })],
  },
  // Every start of a ticket on each model in place of §3b Worker models' standard and high models
  // (`config`), its Stage 7 text model and its finders' left as they are (pass.mjs startModel). A model
  // the CLI cannot start on runs the start on the row's model instead, recorded as model_fallback.
  'worker-model': {
    layer: 'quality-risk', trialled: true, model: 'worker', values: [MODEL_BASELINE, ...WORKER_MODELS], baseline: MODEL_BASELINE,
    mechanism: metric('dollars per ticket', null),
    trips: [POST_MERGE_REVERT, AUDIT_P0],
    code: [code('desk/bin/pass.mjs', 'startModel')],
    preconditions: [
      Object.freeze({ id: 'worker-location', want: 'local', status: 'needs local workers', why: 'the model is set on the local claude launch; a cloud worker never takes it' }),
      Object.freeze({ id: 'worker-model', not: WORKER_MODELS, status: `workers already on ${WORKER_MODELS.join('/')}`, why: `§3b Worker models already runs its standard workers on one of ${WORKER_MODELS.join(', ')}, so that value would be the baseline` }),
    ],
  },
  // How a parked ticket's question reaches the person (question-arms.mjs): `batched` waits for the
  // check-in digest, where a recommended call applies by default; `one-at-a-time` pushes each ask as it
  // is handed on; `mixed` pushes only a blocking one. Weighed only on the tickets that raised an ask
  // (`rows`), its cost the shared one, worker dollars per ticket, and an arm notifying the person 25%
  // more than batched per ticket is refused (levers-evaluate.mjs weighs each).
  'question-handling': {
    layer: 'low-risk', trialled: true, values: ['batched', 'one-at-a-time', 'mixed'], baseline: 'batched',
    mechanism: metric('ask dollars per asking ticket', 0.1),
    rows: 'tickets that raised an ask',
    guardrails: { interruptions: { metric: 'interruptions per ticket (each push, and each digest push shared among the asks it listed)', margin: { max_rate_ratio: 1.25 } } },
    trips: [POST_MERGE_REVERT, ownStepError('question-arms.mjs')],
    code: [code('desk/bin/question-arms.mjs')],
    preconditions: [Object.freeze({ id: 'ledger', want: 'on', status: 'needs ledger on', why: 'its asks and what they cost are read from the ticket ledger' })],
  },
  // The context share at which a worker hands off mid-stage (hooks/desk-handoff.py's worker mode): `config`
  // hands off at config §2's Handoff at context % rows, one for a 200k window and one for 1M; any other
  // value is that percentage on both windows. Weighed on dollars per ticket; the levers page shows the
  // handoffs per ticket beside it. Cloud workers run no hooks, so only local workers take it.
  'handoff-threshold': {
    layer: 'low-risk', trialled: true, values: ['config', '20', '30', '45'], baseline: 'config',
    mechanism: metric('dollars per ticket', 0.1),
    trips: [POST_MERGE_REVERT, ownStepError('handoff.mjs write')],
    code: [code('hooks/desk-handoff.py'), code('desk/bin/handoff.mjs')],
    preconditions: [Object.freeze({ id: 'worker-location', want: 'local', status: 'needs local workers', why: 'the handoff hook runs in a local worker; a cloud worker never takes it' })],
  },
  // The ticket ledger only records queue writes beside queue.json, which stays the truth, so it is not
  // trialled: it is pinned on where a repo wants the log.
  ledger: {
    layer: 'low-risk', trialled: false,
    mechanism: metric('missed ledger appends per pass', null),
    trips: [POST_MERGE_REVERT, ownStepError('queue-ledger.mjs')],
    code: [code('desk/bin/queue-ledger.mjs')],
    preconditions: [],
  },
  // Record mode: the log is written first and queue.json restored from it. It has an effect only with
  // the ledger lever on, and is pinned on once the shadow difference has stayed at zero, never trialled.
  'ledger-record': {
    layer: 'low-risk', trialled: false,
    mechanism: metric('queue.json restores from the log per pass', null),
    trips: [POST_MERGE_REVERT, ownStepError('queue-ledger.mjs')],
    code: [code('desk/bin/queue-ledger.mjs'), code('desk/bin/queue-store.mjs')],
    preconditions: [],
  },
});

// The closed list of reason codes a lever log event may carry (lever-log.mjs refuses any other), each
// with the sentence fragment the Levers page, the digest and desk-q word it from. A trip's code is its
// trip id above in snake_case, a guardrail breach's is `guardrail_` and its key in snake_case.
export const REASON_CODES = Object.freeze({
  adopt_all_conditions: 'every adopt condition held',
  below_min_sample: 'too few tickets on an arm to decide',
  window_tight: 'the usage window was tight, so the audit waited',
  weekly_cap: 'this week\'s audit budget was spent, so the audit waits for next week',
  skipped_preflight_failure: 'a worker that skipped its preflight failed on something the preflight checks',
  stale_wait: 'a ticket waited more than 48 hours after its blocker settled',
  post_merge_revert: 'a ticket on the lever\'s arm was reverted after merging',
  own_step_error: 'the lever\'s own step exited non-zero on an on-arm start',
  guardrail_acceptance: 'acceptance dropped past its margin',
  guardrail_fix_tries_parks: 'fix tries and parks per ticket rose past their margin',
  guardrail_ci_reds: 'CI reds per ticket rose past their margin',
  guardrail_review_p0_p1: 'review P0 and P1 findings per ticket rose past their margin',
  guardrail_post_merge: 'post-merge reverts or red main rose past their margin',
  guardrail_parked_hours: 'parked hours per ticket rose past their margin',
  guardrail_interruptions: 'interruptions per ticket rose past their margin',
  ben_override: 'Ben set it by hand',
  freeze: 'trials were frozen',
  thaw: 'trials were thawed',
  row_change: 'the repo\'s levers row changed',
  assigned_at_admission: 'the ticket was given its arms when it was admitted',
  adopt_conditions_unmet: 'not every adopt condition holds yet',
  no_benefit_max_sample: 'no benefit at maximum sample',
  max_sample_no_adopt: 'the maximum sample was reached without every adopt condition holding',
  change_cooldown: 'the lever changed state in this repo less than 7 days ago',
  holdback_ended: 'the holdback ended with no guardrail breached',
  holdback_running: 'the lever is adopted and its holdback is still running',
  not_evaluated: 'the lever is settled, frozen, overridden or off here, so it is not weighed',
  fp_reset: 'the lever\'s own code changed, so evidence from before the change was dropped',
  evidence_incomplete: 'some outcomes the evaluation reads weren’t recorded',
  frozen_second_revert: 'the lever was reverted a second time in this repo, so it is frozen there',
  audit_recorded: 'a blind audit of a merged PR was recorded',
  audit_p0: 'a blind audit found a P0 in a merged PR drawn on for the lever',
  state_unreadable: 'the repo\'s lever log could not be read, so its tickets cannot be assigned arms',
  codex_dead_seats: 'more than 20% of the last 10 codex calls on its tickets died',
  ramp_clean: 'its tickets so far ran with no hard trip, so it reaches more tickets',
  audit_missing: 'no blind audit has been recorded in this repo yet',
  audits_pending: 'blind audits are due and not yet recorded',
  value_missing: 'a lever with more than two arms is kept or set by hand with no value of its own recorded, so its tickets cannot be assigned arms',
});

// The wording for a reason code, or null for a code not in the list.
export const reasonWording = (code) => (Object.hasOwn(REASON_CODES, code) ? REASON_CODES[code] : null);

// The needs-you item's text for repo `repo`, whose lever log stops its tickets being assigned arms
// because of `why`: written by the assignment (levers-auto.mjs), and shown by the levers view when
// the log cannot be read as far as that item.
export const unassignableText = (repo, why) => `${repo} cannot be assigned trial arms: ${why}; tickets get the levers row's named levers alone until it is fixed`;

export class LeverRegistryError extends Error {}

// A valued lever's arm name: one word, as DESK_LEVER_VALUES carries it, and none of the names the
// on/off arms and the holdback use.
const VALUE = /^[a-z0-9][a-z0-9._-]*$/;
const RESERVED_ARMS = Object.freeze(['on', 'off', 'adopted', 'holdback']);
// A valued lever's `values` and `baseline`, checked: {} for a lever with neither.
function valuesOf(name, e) {
  if (!('values' in e) && !('baseline' in e)) return {};
  const bad = (why) => new LeverRegistryError(`lever-registry: lever "${name}" ${why}`);
  const v = e.values;
  if (!Array.isArray(v) || v.length < 2 || new Set(v).size !== v.length) throw bad('has "values" that are not two or more distinct arm names');
  const wrong = v.find((x) => typeof x !== 'string' || !VALUE.test(x) || RESERVED_ARMS.includes(x));
  if (wrong !== undefined) throw bad(`has value "${wrong}"; want a lower-case word other than ${RESERVED_ARMS.join(', ')}`);
  if (!v.includes(e.baseline)) throw bad(`has baseline "${e.baseline}"; want one of its values (${v.join(', ')})`);
  if ('model' in e) {
    if (e.baseline !== MODEL_BASELINE) throw bad(`has model "${e.model}" and baseline "${e.baseline}"; a model lever's baseline is ${MODEL_BASELINE}`);
    const alias = e.model === 'finder' && v.find((x) => x !== MODEL_BASELINE && !ALIAS.test(x));
    if (alias) throw bad(`has finder model "${alias}"; want an Agent tool alias`);
  }
  return { values: Object.freeze([...v]), baseline: e.baseline };
}

// The shared guardrails, with a lever's own beside them: each a metric and a rate-ratio margin, under a
// key the shared ones do not use.
function ownGuardrails(name, e) {
  if (!('guardrails' in e)) return GUARDRAILS;
  const bad = (why) => new LeverRegistryError(`lever-registry: lever "${name}" ${why}`);
  const own = e.guardrails;
  if (!own || typeof own !== 'object' || Array.isArray(own) || !Object.keys(own).length) throw bad('has "guardrails" that are not an object of its own guardrails');
  for (const [k, g] of Object.entries(own)) {
    if (Object.hasOwn(GUARDRAILS, k)) throw bad(`has guardrail "${k}", which is a shared one`);
    if (!g?.metric || !(g.margin?.max_rate_ratio > 0)) throw bad(`has guardrail "${k}" with no metric or rate-ratio margin`);
  }
  return Object.freeze({ ...GUARDRAILS, ...Object.fromEntries(Object.entries(own).map(([k, g]) => [k, Object.freeze({ metric: g.metric, margin: Object.freeze({ ...g.margin }) })])) });
}

// Every entry, checked and frozen, with its layer's ramp and the shared guardrails filled in. Throws
// LeverRegistryError naming the first lever and key that is missing or malformed, and naming every
// lever in `names` with no entry or every entry not in `names`.
export function loadRegistry(entries = ENTRIES, names = LEVERS) {
  const declared = Object.keys(entries ?? {});
  const undeclared = names.filter((n) => !declared.includes(n));
  if (undeclared.length) throw new LeverRegistryError(`lever-registry: no entry for ${undeclared.map((n) => `"${n}"`).join(', ')}, which desk-env knows as a lever`);
  const unknown = declared.filter((n) => !names.includes(n));
  if (unknown.length) throw new LeverRegistryError(`lever-registry: entry ${unknown.map((n) => `"${n}"`).join(', ')} is not a lever desk-env knows (add it to LEVERS in desk-env.mjs)`);
  const out = {};
  for (const [name, e] of Object.entries(entries ?? {})) {
    const missing = (key) => new LeverRegistryError(`lever-registry: lever "${name}" is missing "${key}"`);
    if (!e || typeof e !== 'object') throw missing('layer');
    if (!LAYERS.includes(e.layer)) throw e.layer == null ? missing('layer') : new LeverRegistryError(`lever-registry: lever "${name}" has layer "${e.layer}"; want ${LAYERS.join(' or ')}`);
    if (!e.mechanism || typeof e.mechanism !== 'object') throw missing('mechanism');
    if (!e.mechanism.metric) throw missing('mechanism.metric');
    if (!('minimum' in e.mechanism)) throw missing('mechanism.minimum');
    if (!Array.isArray(e.code) || !e.code.length || e.code.some((c) => !c?.path)) throw missing('code');
    for (const key of ['trips', 'preconditions']) if (!Array.isArray(e[key])) throw missing(key);
    if (typeof e.trialled !== 'boolean') throw missing('trialled');
    if ('model' in e && !MODEL_KINDS.includes(e.model)) throw new LeverRegistryError(`lever-registry: lever "${name}" has model "${e.model}"; want ${MODEL_KINDS.join(' or ')}`);
    if ('model' in e && !('values' in e)) throw missing('values');
    if ('rows' in e && !(typeof e.rows === 'string' && e.rows)) throw missing('rows');
    out[name] = Object.freeze({
      name, layer: e.layer, trialled: e.trialled, ...('model' in e ? { model: e.model } : {}), ...valuesOf(name, e), mechanism: Object.freeze({ ...e.mechanism }),
      ...('rows' in e ? { rows: e.rows } : {}), guardrails: ownGuardrails(name, e), trips: Object.freeze([...e.trips]), code: Object.freeze([...e.code]),
      ramp: RAMPS[e.layer], preconditions: Object.freeze([...e.preconditions]),
    });
  }
  return Object.freeze(out);
}

export const REGISTRY = loadRegistry();
export const lever = (name, registry = REGISTRY) => registry[name] ?? null;
// Whether a registry lever has more than two arms, each a value.
export const isValued = (l) => Array.isArray(l?.values);
// Whether a ticket's trial arm `arm` for registry lever `l` (undefined for a pair key) is its on arm:
// `on`, or for a lever with more than two arms any of its values but the baseline; and its off arm:
// `off`, or the baseline.
export const armOn = (l, arm) => (isValued(l) ? arm !== l.baseline && l.values.includes(arm) : arm === 'on');
export const armOff = (l, arm) => (isValued(l) ? arm === l.baseline : arm === 'off');
// The choices `levers decide` takes for a lever: off or trial, or a lever with more than two arms'
// values or trial.
export const decideChoices = (name, registry = REGISTRY) => (isValued(registry[name]) ? [...registry[name].values, 'trial'] : ['off', 'trial']);

// Which levers in a repo's levers row (its items, read as desk-env's parseLevers reads them) may be
// trialled: the ones the registry declares. Every other name is refused, and `message` names each
// one; it is null when nothing is refused.
//   -> { ok: [name], refused: [name], message }
export function trialable(items, registry = REGISTRY) {
  const { on, unknown } = parseLevers(items);
  const all = [...on, ...unknown];
  const ok = all.filter((n) => Object.hasOwn(registry, n));
  const refused = all.filter((n) => !Object.hasOwn(registry, n));
  const message = refused.length ? `lever-registry: refusing to trial ${refused.map((n) => `"${n}"`).join(', ')}: not declared in the lever registry (declared: ${Object.keys(registry).join(', ')})` : null;
  return { ok, refused, message };
}

// The config values the preconditions read, from this repo's config; `repoValuesOf` reads another
// repo's (the levers view). `worker-finder-model` is §3b Worker models' `finder=`, `none` when unset,
// and null when the row cannot be read (a malformed row holds spawns on its own).
const finderOf = (read) => { try { return read().finder ?? 'none'; } catch { return null; } };
// `worker-model` is its standard model, `default` for a row of `default`, null when unreadable.
const standardOf = (read) => { try { const m = read(); return m.off ? 'default' : m.standard; } catch { return null; } };
// `ledger` is `on` where the Phase 0 levers row names the ledger lever, as the ledger's writers read it
// (queue-ledger.mjs ledgerOn), else `off`; null when the row cannot be read.
const ledgerOf = (read) => { try { return parseLevers(read()).on.includes('ledger') ? 'on' : 'off'; } catch { return null; } };
export const repoValues = () => ({ 'worker-location': workerLocation(), 'worker-finder-model': finderOf(workerModels), 'worker-model': standardOf(workerModels), ledger: ledgerOf(() => configValues('levers')) });
export function repoValuesOf(slug, root) {
  const raw = (id) => repoConfigValue(slug, id, root) ?? ROWS.find((e) => e.id === id).default;
  let location = null;
  try { location = parseWorkerLocation(raw('worker-location')); } catch { /* unreadable: left null */ }
  const models = () => parseWorkerModels(raw('worker-models'));
  return { 'worker-location': location, 'worker-finder-model': finderOf(models), 'worker-model': standardOf(models), ledger: ledgerOf(() => repoConfigValues(slug, 'levers', root)) };
}

// Where install.sh puts a registry code path: `desk/<rest>` under DESK_HOME, anything else (`hooks/…`)
// under ~/.claude.
export const installedPath = (path) => (path.startsWith('desk/') ? join(deskHome(), path.slice(5)) : join(HOME, '.claude', path));

// A hash per lever of the installed copies of the code files it declares, whole files in registry order,
// so evidence from before a lever's code changed can be told from evidence after. A listed file that
// cannot be read is left out of its lever's hash and named in `missing`; a lever with none readable is
// null.
//   -> { fp: { <lever>: hex | null }, missing: [path] }
export function leverFingerprints(registry = REGISTRY, resolve = installedPath) {
  const fp = {};
  const missing = [];
  for (const [name, l] of Object.entries(registry)) {
    const h = createHash('sha256');
    let read = 0;
    for (const { path } of l.code) {
      let body;
      try { body = readFileSync(resolve(path)); } catch { if (!missing.includes(path)) missing.push(path); continue; }
      h.update(`${path}\0${body.length}\0`).update(body);
      read++;
    }
    fp[name] = read ? h.digest('hex').slice(0, 16) : null;
  }
  return { fp, missing };
}

// Whether a lever is eligible in a repo, given its config values (repoValues() for this one). A lever
// the registry does not declare is never eligible. A precondition holds where the value is its `want`,
// or, for one declaring `not` instead (a value or a list of them), where the value is none of `not`.
//   -> { eligible, reasons: [text], failed: [precondition] }
const notOf = (p) => [p.not].flat();
export function preconditions(name, values = repoValues(), registry = REGISTRY) {
  const l = registry[name];
  if (!l) return { eligible: false, reasons: [`"${name}" is not declared in the lever registry`], failed: [] };
  const failed = l.preconditions.filter((p) => ('not' in p ? notOf(p).includes(values?.[p.id]) : values?.[p.id] !== p.want));
  const reasons = failed.map((p) => ('not' in p ? `${name} is ineligible: config "${p.id}" is already ${values?.[p.id]} (${p.why})`
    : `${name} is ineligible: config "${p.id}" is ${values?.[p.id] ?? 'unset'}, want ${p.want} (${p.why})`));
  return { eligible: reasons.length === 0, reasons, failed };
}
