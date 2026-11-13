// The Phase 0 lever registry: for each lever desk may trial, its layer, its mechanism metric and the
// minimum benefit an adopt needs, the guardrail margins, the hard trips that revert it at once, the
// code files its fingerprint covers, its exposure ramp and the repo preconditions it needs. A lever
// this file does not declare is never trialled. Loading checks every entry and throws, naming the
// lever and the key, rather than letting a half-declared lever reach a trial. The lever names are
// desk-env's LEVERS: the registry declares an entry for each of them and no other.
//
//   import { REGISTRY, trialable, preconditions, repoValues } from './lever-registry.mjs'
import { workerLocation, LEVERS, parseLevers } from './desk-env.mjs';

export const LAYERS = Object.freeze(['low-risk', 'quality-risk']);

// The epic's decision rule, shared by every lever: an adopt needs the mechanism metric better by at
// least the lever's minimum with this probability, the cost ratio's upper bound below `cost_ratio_max`,
// and every guardrail within its margin, on at least the layer's `min_per_arm` tickets per arm and at
// most `max_per_arm`.
export const DECISION_RULE = Object.freeze({
  probability: 0.9,
  cost_ratio_max: 1.05,
  min_per_arm: Object.freeze({ 'low-risk': 30, 'quality-risk': 40 }),
  max_per_arm: 150,
});

// Guardrails, judged per repo. A rate-ratio margin is the lever arm's rate over the off arm's.
export const GUARDRAILS = Object.freeze({
  acceptance: Object.freeze({ metric: 'acceptance rate', margin: Object.freeze({ max_drop_points: 5 }) }),
  'fix-tries-parks': Object.freeze({ metric: 'fix tries and parks per ticket', excludes: Object.freeze(['quota', 'dependency wait']), margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
  'ci-reds': Object.freeze({ metric: 'CI reds on the branch per ticket', margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
  'review-p0-p1': Object.freeze({ metric: 'review P0 and P1 findings per ticket', margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
  'post-merge': Object.freeze({ metric: 'post-merge reverts or red main within 24 hours per ticket', margin: Object.freeze({ max_rate_ratio: 1.25 }) }),
});

// How much of a repo's tickets a lever reaches. The low-risk layer is a factorial, each lever drawn on
// for half the tickets; the quality-risk layer is exclusive (one such lever per ticket), steps through
// `ramp` and never reaches more than `cap` of a repo's tickets while unproven. After an adopt,
// `holdback` of tickets stay off for `holdback_weeks`.
const RAMPS = Object.freeze({
  'low-risk': Object.freeze({ on_share: 0.5, exclusive: false, holdback: 0.1, holdback_weeks: 4 }),
  'quality-risk': Object.freeze({ ramp: Object.freeze([0.1, 0.25, 0.5]), cap: 0.3, exclusive: true, holdback: 0.1, holdback_weeks: 4 }),
});

// Hard trips: a condition that reverts the lever in that repo within one pass, with no statistics.
// `step` names the lever's own command, whose non-zero exit on an on-arm start is a trip.
const POST_MERGE_REVERT = Object.freeze({ id: 'post-merge-revert', when: 'a post-merge revert is recorded for a ticket on the lever\'s arm' });
const ownStepError = (step) => Object.freeze({ id: 'own-step-error', step, when: `a start on an on-arm ticket records ${step} exiting non-zero` });

const code = (path, part) => Object.freeze(part ? { path, part } : { path });
const metric = (name, minimum) => Object.freeze({ metric: name, direction: 'down', minimum, minimum_set: minimum != null });

// `minimum` is the relative decrease an adopt needs (0.3 is down 30%); null is not yet set, and no
// lever with an unset minimum can be adopted. `trialled: false` is declared but not yet put on trial.
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
    layer: 'quality-risk', trialled: false,
    mechanism: metric('codex seats died per review', null),
    trips: [POST_MERGE_REVERT, ownStepError('desk-codex')],
    code: [code('desk/bin/desk-codex.mjs')],
    preconditions: [],
  },
  'review-reuse': {
    layer: 'quality-risk', trialled: false,
    mechanism: metric('review runs per ticket', null),
    trips: [POST_MERGE_REVERT, ownStepError('undraft.mjs')],
    code: [code('desk/bin/undraft.mjs'), code('desk/bin/review-threads.mjs')],
    preconditions: [],
  },
  effort: {
    layer: 'quality-risk', trialled: false,
    mechanism: metric('dollars per start', null),
    trips: [POST_MERGE_REVERT, ownStepError('desk-env effort')],
    code: [code('desk/bin/desk-env.mjs', 'effort')],
    preconditions: [Object.freeze({ id: 'worker-location', want: 'local', why: 'effort is set on the local claude launch; a cloud worker never takes it' })],
  },
});

export class LeverRegistryError extends Error {}

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
    out[name] = Object.freeze({
      name, layer: e.layer, trialled: e.trialled, mechanism: Object.freeze({ ...e.mechanism }),
      guardrails: GUARDRAILS, trips: Object.freeze([...e.trips]), code: Object.freeze([...e.code]),
      ramp: RAMPS[e.layer], preconditions: Object.freeze([...e.preconditions]),
    });
  }
  return Object.freeze(out);
}

export const REGISTRY = loadRegistry();
export const lever = (name, registry = REGISTRY) => registry[name] ?? null;

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

// The config values the preconditions read, from this repo's config.
export const repoValues = () => ({ 'worker-location': workerLocation() });

// Whether a lever is eligible in a repo, given its config values (repoValues() for this one). A lever
// the registry does not declare is never eligible.
//   -> { eligible, reasons: [text] }
export function preconditions(name, values = repoValues(), registry = REGISTRY) {
  const l = registry[name];
  if (!l) return { eligible: false, reasons: [`"${name}" is not declared in the lever registry`] };
  const reasons = l.preconditions.filter((p) => values?.[p.id] !== p.want)
    .map((p) => `${name} is ineligible: config "${p.id}" is ${values?.[p.id] ?? 'unset'}, want ${p.want} (${p.why})`);
  return { eligible: reasons.length === 0, reasons };
}
