// suite: lever registry (each lever's layer, metrics, trips, code and preconditions in one place)
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, REGISTRY, GUARDRAILS, DECISION_RULE, LeverRegistryError, loadRegistry, lever, trialable, preconditions } from '../desk/bin/lever-registry.mjs';
import { LEVERS, parseLevers } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const loadError = (entries) => { try { loadRegistry(entries); return 'loaded'; } catch (e) { return e instanceof LeverRegistryError ? e.message : `other error: ${e.message}`; } };
const without = (name, drop) => ({ ...ENTRIES, [name]: drop({ ...ENTRIES[name], mechanism: { ...ENTRIES[name].mechanism } }) });

// AC1: all seven, in their layers, and the same names desk-env levers parses.
const byLayer = (layer) => Object.values(REGISTRY).filter((l) => l.layer === layer).map((l) => l.name).sort().join(' ');
t('AC1 low-risk layer', byLayer('low-risk'), 'failure-class memory preflight wrappers');
t('AC1 quality-risk layer', byLayer('quality-risk'), 'codex effort review-reuse');
const dropCodex = Object.fromEntries(Object.entries(ENTRIES).filter(([n]) => n !== 'codex'));
t('AC1 a lever desk-env knows with no entry fails loading, by name', loadError(dropCodex), 'lever-registry: no entry for "codex", which desk-env knows as a lever');
t('AC1 an entry desk-env does not know fails loading, by name', loadError({ ...ENTRIES, turbo: ENTRIES.memory }), 'lever-registry: entry "turbo" is not a lever desk-env knows (add it to LEVERS in desk-env.mjs)');
t('AC1 the quality-risk layer is declared but not yet trialled', Object.values(REGISTRY).filter((l) => l.layer === 'quality-risk').every((l) => l.trialled === false), true);
t('AC1 the low-risk layer is trialled', Object.values(REGISTRY).filter((l) => l.layer === 'low-risk').every((l) => l.trialled === true), true);
t('AC1 the loaded registry is frozen', Object.isFrozen(REGISTRY) && Object.isFrozen(REGISTRY.preflight) && Object.isFrozen(REGISTRY.preflight.code), true);

// AC2: a name in a repo's levers row that the registry does not declare is refused, by name.
const row = trialable(['preflight', 'turbo', 'memory', 'warp-drive']);
t('AC2 declared levers may be trialled', row.ok.join(' '), 'preflight memory');
t('AC2 undeclared levers are refused', row.refused.join(' '), 'turbo warp-drive');
t('AC2 the message names each refused lever', /"turbo"/.test(row.message) && /"warp-drive"/.test(row.message), true);
t('AC2 the message does not name a declared lever as refused', /"preflight"/.test(row.message), false);
t('AC2 nothing refused, no message', trialable(['wrappers', 'effort']).message, null);
t('AC2 a lever removed from the registry is refused', trialable(['codex'], loadRegistry(dropCodex, LEVERS.filter((n) => n !== 'codex'))).refused.join(' '), 'codex');
const raw = trialable(['Preflight, turbo', 'MEMORY', 'none']);
t('AC2 the row is read as desk-env reads it: case and comma-separated items', `${raw.ok.join(' ')} | ${raw.refused.join(' ')}`, 'preflight memory | turbo');
t('AC2 and agrees with desk-env on which are on', raw.ok.join(' '), parseLevers(['Preflight, turbo', 'MEMORY']).on.join(' '));

// AC3: loading fails naming the lever and the missing key.
t('AC3 the shipped registry loads', loadError(ENTRIES), 'loaded');
t('AC3 no mechanism metric', loadError(without('memory', (e) => { delete e.mechanism.metric; return e; })), 'lever-registry: lever "memory" is missing "mechanism.metric"');
t('AC3 an empty mechanism metric', loadError(without('wrappers', (e) => { e.mechanism.metric = ''; return e; })), 'lever-registry: lever "wrappers" is missing "mechanism.metric"');
t('AC3 no mechanism at all', loadError(without('codex', (e) => { delete e.mechanism; return e; })), 'lever-registry: lever "codex" is missing "mechanism"');
t('AC3 no code files', loadError(without('preflight', (e) => { delete e.code; return e; })), 'lever-registry: lever "preflight" is missing "code"');
t('AC3 an empty code list', loadError(without('effort', (e) => { e.code = []; return e; })), 'lever-registry: lever "effort" is missing "code"');
t('AC3 a code entry with no path', loadError(without('review-reuse', (e) => { e.code = [{ part: 'x' }]; return e; })), 'lever-registry: lever "review-reuse" is missing "code"');
t('AC3 an unknown layer is refused', loadError(without('memory', (e) => { e.layer = 'medium'; return e; })), 'lever-registry: lever "memory" has layer "medium"; want low-risk or quality-risk');
t('AC3 every declared code file exists', Object.values(REGISTRY).flatMap((l) => l.code).filter((c) => !existsSync(join(ROOT, c.path))).map((c) => c.path).join(', '), '');

// AC4: effort needs the local worker location.
t('AC4 effort with a cloud worker location is ineligible', preconditions('effort', { 'worker-location': 'cloud' }).eligible, false);
t('AC4 and the reason names the row', /worker-location" is cloud, want local/.test(preconditions('effort', { 'worker-location': 'cloud' }).reasons[0]), true);
t('AC4 effort with a local worker location is eligible', preconditions('effort', { 'worker-location': 'local' }).eligible, true);
t('AC4 a lever with no precondition is eligible with a cloud worker location', preconditions('memory', { 'worker-location': 'cloud' }).eligible, true);
t('AC4 an undeclared lever is never eligible', preconditions('turbo', { 'worker-location': 'local' }).eligible, false);

// AC5: the mechanism metric with its minimum, and the epic's guardrail margins.
const min = (name) => `${lever(name).mechanism.metric} ${lever(name).mechanism.direction} ${lever(name).mechanism.minimum}`;
t('AC5 preflight', min('preflight'), 'preflight dollars per start down 0.3');
t('AC5 wrappers', min('wrappers'), 'permission denials per start down 0.25');
t('AC5 memory', min('memory'), 'start bytes down 0.2');
t('AC5 the other four name a metric with the minimum not yet set', ['failure-class', 'codex', 'review-reuse', 'effort'].every((n) => lever(n).mechanism.metric && lever(n).mechanism.minimum === null && lever(n).mechanism.minimum_set === false), true);
t('AC5 the three set minimums are marked set', ['preflight', 'wrappers', 'memory'].every((n) => lever(n).mechanism.minimum_set === true), true);
t('AC5 every lever carries the guardrails', Object.values(REGISTRY).every((l) => l.guardrails === GUARDRAILS), true);
t('AC5 acceptance within 5 points', GUARDRAILS.acceptance.margin.max_drop_points, 5);
t('AC5 fix tries and parks rate ratio below 1.25', GUARDRAILS['fix-tries-parks'].margin.max_rate_ratio, 1.25);
t('AC5 fix tries and parks exclude quota and dependency wait', GUARDRAILS['fix-tries-parks'].excludes.join(', '), 'quota, dependency wait');
t('AC5 the other guardrails', ['ci-reds', 'review-p0-p1', 'post-merge'].every((k) => GUARDRAILS[k].margin.max_rate_ratio === 1.25), true);
t('AC5 decision rule', `${DECISION_RULE.probability} ${DECISION_RULE.cost_ratio_max} ${DECISION_RULE.min_per_arm['low-risk']} ${DECISION_RULE.min_per_arm['quality-risk']} ${DECISION_RULE.max_per_arm}`, '0.9 1.05 30 40 150');

// The rest of each entry: trips and ramps.
t('every lever reverts on a post-merge revert', Object.values(REGISTRY).every((l) => l.trips.some((x) => x.id === 'post-merge-revert')), true);
t('every lever reverts on its own step failing', Object.values(REGISTRY).every((l) => l.trips.some((x) => x.id === 'own-step-error' && x.step)), true);
t('preflight trips on a skipped preflight failing', lever('preflight').trips.some((x) => x.id === 'skipped-preflight-failure'), true);
t('failure-class trips after 48 hours waiting', lever('failure-class').trips.find((x) => x.id === 'stale-wait')?.hours, 48);
t('low-risk ramp: a factorial at one half', `${lever('memory').ramp.on_share} ${lever('memory').ramp.exclusive}`, '0.5 false');
t('quality-risk ramp: 10, 25, 50, capped at 30%, exclusive', `${lever('codex').ramp.ramp.join(',')} ${lever('codex').ramp.cap} ${lever('codex').ramp.exclusive}`, '0.1,0.25,0.5 0.3 true');
t('every lever holds back 10% for 4 weeks after an adopt', Object.values(REGISTRY).every((l) => l.ramp.holdback === 0.1 && l.ramp.holdback_weeks === 4), true);

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all checks passed');
