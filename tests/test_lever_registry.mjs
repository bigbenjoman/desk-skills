// suite: lever registry (each lever's layer, metrics, trips, code and preconditions in one place)
// layer: L1
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, REGISTRY, GUARDRAILS, DECISION_RULE, LeverRegistryError, loadRegistry, lever, trialable, preconditions, REASON_CODES, isValued } from '../desk/bin/lever-registry.mjs';
import { LEVERS, MODEL_BASELINE, parseLevers, parseWorkerModels } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const loadError = (entries) => { try { loadRegistry(entries); return 'loaded'; } catch (e) { return e instanceof LeverRegistryError ? e.message : `other error: ${e.message}`; } };
const without = (name, drop) => ({ ...ENTRIES, [name]: drop({ ...ENTRIES[name], mechanism: { ...ENTRIES[name].mechanism } }) });

// AC1: all seven, in their layers, and the same names desk-env levers parses.
const byLayer = (layer) => Object.values(REGISTRY).filter((l) => l.layer === layer).map((l) => l.name).sort().join(' ');
t('AC1 low-risk layer', byLayer('low-risk'), 'failure-class handoff-threshold ledger ledger-record memory preflight question-handling wrappers');
t('AC1 quality-risk layer', byLayer('quality-risk'), 'codex effort finder-model review-reuse worker-model');
const dropCodex = Object.fromEntries(Object.entries(ENTRIES).filter(([n]) => n !== 'codex'));
t('AC1 a lever desk-env knows with no entry fails loading, by name', loadError(dropCodex), 'lever-registry: no entry for "codex", which desk-env knows as a lever');
t('AC1 an entry desk-env does not know fails loading, by name', loadError({ ...ENTRIES, turbo: ENTRIES.memory }), 'lever-registry: entry "turbo" is not a lever desk-env knows (add it to LEVERS in desk-env.mjs)');
t('AC1 the quality-risk layer is trialled (DS-646)', Object.values(REGISTRY).filter((l) => l.layer === 'quality-risk').every((l) => l.trialled === true), true);
t('AC1 the low-risk layer is trialled, but the ledger levers', Object.values(REGISTRY).filter((l) => l.layer === 'low-risk' && !['ledger', 'ledger-record'].includes(l.name)).every((l) => l.trialled === true), true);
t('AC1 the ledger is declared but not trialled (DS-893)', REGISTRY.ledger.trialled, false);
t('the ledger-record lever is declared but not trialled', REGISTRY['ledger-record'].trialled, false);
const ht = REGISTRY['handoff-threshold'];
t('DS-1037 handoff-threshold is a low-risk lever of four values on trial, config the baseline', `${ht.layer} ${isValued(ht)} ${ht.values.join(',')} ${ht.baseline} ${ht.trialled}`, 'low-risk true config,20,30,45 config true');
t('DS-1037 it is weighed on dollars per ticket, and covers the handoff hook and handoff.mjs', `${ht.mechanism.metric} | ${ht.code.map((c) => c.path).join(' ')}`, 'dollars per ticket | hooks/desk-handoff.py desk/bin/handoff.mjs');
t('DS-1037 it needs local workers', `${preconditions('handoff-threshold', { 'worker-location': 'local' }).eligible} ${preconditions('handoff-threshold', { 'worker-location': 'cloud' }).eligible}`, 'true false');
t('AC1 the loaded registry is frozen', Object.isFrozen(REGISTRY) && Object.isFrozen(REGISTRY.preflight) && Object.isFrozen(REGISTRY.preflight.code), true);

// AC2: a name in a repo's levers row that the registry does not declare is refused, by name.
const row = trialable(['preflight', 'turbo', 'memory', 'warp-drive']);
t('AC2 declared levers may be trialled', row.ok.join(' '), 'preflight memory');
t('AC2 undeclared levers are refused', row.refused.join(' '), 'turbo warp-drive');
t('AC2 the message names each refused lever', /"turbo"/.test(row.message) && /"warp-drive"/.test(row.message), true);
t('AC2 the message does not name a declared lever as refused', /"preflight"/.test(row.message), false);
t('AC2 nothing refused, no message', trialable(['wrappers', 'effort']).message, null);
t('AC2 a lever removed from the registry is refused', trialable(['codex'], loadRegistry(dropCodex, LEVERS.filter((n) => n !== 'codex'))).refused.join(' '), 'codex');
const raw = trialable(['Preflight, turbo', 'MEMORY']);
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

// The finder-model lever: its models against the row's finders, and its precondition on §3b Worker
// models' finder=.
const fm = lever('finder-model');
t('DS-1036 AC3 finder-model carries sonnet and haiku against config, the row\'s finders', `${fm.model} ${fm.values.join(',')} ${fm.baseline} ${fm.baseline === MODEL_BASELINE}`, 'finder config,sonnet,haiku config true');
t('DS-1000 each model is one the finder= check takes', fm.values.filter((v) => v !== fm.baseline).map((v) => parseWorkerModels(`default finder=${v}`).finder).join(' '), 'sonnet haiku');
t('DS-1000 a lever with no model carries none', 'model' in lever('effort'), false);
t('DS-1036 a finder model that is no alias fails loading', loadError(without('finder-model', (e) => { e.values = ['config', 'claude-sonnet-5-5']; return e; })), 'lever-registry: lever "finder-model" has finder model "claude-sonnet-5-5"; want an Agent tool alias');
t('DS-1036 a model kind desk has not got fails loading', loadError(without('finder-model', (e) => { e.model = 'sonnet'; return e; })), 'lever-registry: lever "finder-model" has model "sonnet"; want finder or worker');
t('DS-1036 a model lever with no values fails loading', loadError(without('finder-model', (e) => { delete e.values; delete e.baseline; return e; })), 'lever-registry: lever "finder-model" is missing "values"');
t('DS-1036 a model lever\'s baseline is config', loadError(without('finder-model', (e) => { e.baseline = 'sonnet'; return e; })), 'lever-registry: lever "finder-model" has model "finder" and baseline "sonnet"; a model lever\'s baseline is config');
t('DS-1000 quality-risk, dollars per start, minimum unset', `${fm.layer} ${fm.mechanism.metric} ${fm.mechanism.minimum}`, 'quality-risk dollars per start null');
t('DS-1000 trips: post-merge revert, its own step, a blind-audit P0', fm.trips.map((x) => `${x.id}${x.step ? `:${x.step}` : ''}`).join(' '), 'post-merge-revert own-step-error:desk-env model finder audit-p0');
t('DS-1000 its code is desk-env model finder', JSON.stringify(fm.code), '[{"path":"desk/bin/desk-env.mjs","part":"model finder"}]');
t('DS-1036 a repo whose finder= is already one of its models is ineligible', ['sonnet', 'haiku'].map((m) => preconditions('finder-model', { 'worker-finder-model': m }).eligible).join(' '), 'false false');
t('DS-1036 and the reason names the model, which would be the baseline', /worker-finder-model" is already haiku .*that value would be the baseline/.test(preconditions('finder-model', { 'worker-finder-model': 'haiku' }).reasons[0]), true);
t('DS-1000 AC4 finder= unset is eligible', preconditions('finder-model', { 'worker-finder-model': 'none' }).eligible, true);
t('DS-1036 finder= on another model is eligible', preconditions('finder-model', { 'worker-finder-model': 'opus' }).eligible, true);
t('DS-1000 AC4 an unreadable row does not make it ineligible', preconditions('finder-model', { 'worker-finder-model': null }).eligible, true);

// The worker-model lever: every start on its model against the row's.
const wm = lever('worker-model');
t('DS-1036 AC1 worker-model is a quality-risk lever with values and a baseline, on trial', `${wm.layer} ${wm.model} ${wm.values.join(',')} ${wm.baseline} ${wm.trialled}`, 'quality-risk worker config,sonnet config true');
t('DS-1036 AC1 a quality-risk lever with values loads', loadError({ ...ENTRIES, codex: { ...ENTRIES.codex, values: ['a', 'b'], baseline: 'a' } }), 'loaded');
t('DS-1036 weighed on dollars per ticket, its code pass.mjs startModel', `${wm.mechanism.metric} ${wm.mechanism.minimum} | ${JSON.stringify(wm.code)}`, 'dollars per ticket null | [{"path":"desk/bin/pass.mjs","part":"startModel"}]');
t('DS-1036 trips: post-merge revert and a blind-audit P0', wm.trips.map((x) => x.id).join(' '), 'post-merge-revert audit-p0');
t('DS-1036 needs local workers', `${preconditions('worker-model', { 'worker-location': 'local', 'worker-model': 'default' }).eligible} ${preconditions('worker-model', { 'worker-location': 'cloud', 'worker-model': 'default' }).eligible}`, 'true false');
t('DS-1036 a repo whose standard= is already its model is ineligible', `${preconditions('worker-model', { 'worker-location': 'local', 'worker-model': 'sonnet' }).eligible} ${preconditions('worker-model', { 'worker-location': 'local', 'worker-model': 'opus' }).eligible}`, 'false true');

// AC5: the mechanism metric with its minimum, and the epic's guardrail margins.
const min = (name) => `${lever(name).mechanism.metric} ${lever(name).mechanism.direction} ${lever(name).mechanism.minimum}`;
t('AC5 preflight', min('preflight'), 'preflight dollars per start down 0.3');
t('AC5 wrappers', min('wrappers'), 'permission denials per start down 0.25');
t('AC5 memory', min('memory'), 'start bytes down 0.2');
t('AC5 the other four name a metric with the minimum not yet set', ['failure-class', 'codex', 'review-reuse', 'effort'].every((n) => lever(n).mechanism.metric && lever(n).mechanism.minimum === null && lever(n).mechanism.minimum_set === false), true);
t('AC5 the three set minimums are marked set', ['preflight', 'wrappers', 'memory'].every((n) => lever(n).mechanism.minimum_set === true), true);
t('AC5 every lever carries the guardrails', Object.values(REGISTRY).every((l) => Object.keys(GUARDRAILS).every((k) => l.guardrails[k] === GUARDRAILS[k])), true);
t('AC5 and only question handling has one of its own', Object.values(REGISTRY).filter((l) => l.guardrails !== GUARDRAILS).map((l) => l.name).join(' '), 'question-handling');
t('AC5 acceptance within 5 points', GUARDRAILS.acceptance.margin.max_drop_points, 5);
t('AC5 fix tries and parks rate ratio below 1.25', GUARDRAILS['fix-tries-parks'].margin.max_rate_ratio, 1.25);
t('AC5 fix tries and parks exclude quota and dependency wait', GUARDRAILS['fix-tries-parks'].excludes.join(', '), 'quota, dependency wait');
t('AC5 the other guardrails', ['ci-reds', 'review-p0-p1', 'post-merge'].every((k) => GUARDRAILS[k].margin.max_rate_ratio === 1.25), true);
t('AC5 decision rule', `${DECISION_RULE.probability} ${DECISION_RULE.cost_ratio_max} ${DECISION_RULE.min_per_arm['low-risk']} ${DECISION_RULE.min_per_arm['quality-risk']} ${DECISION_RULE.max_per_arm}`, '0.9 1.05 30 40 150');

// The rest of each entry: trips and ramps.
t('every lever reverts on a post-merge revert', Object.values(REGISTRY).every((l) => l.trips.some((x) => x.id === 'post-merge-revert')), true);
t('every lever with a step of its own reverts on it failing', Object.values(REGISTRY).filter((l) => l.name !== 'worker-model').every((l) => l.trips.some((x) => x.id === 'own-step-error' && x.step)), true);
t('preflight trips on a skipped preflight failing', lever('preflight').trips.some((x) => x.id === 'skipped-preflight-failure'), true);
t('failure-class trips after 48 hours waiting', lever('failure-class').trips.find((x) => x.id === 'stale-wait')?.hours, 48);
t('low-risk ramp: a factorial at one half', `${lever('memory').ramp.on_share} ${lever('memory').ramp.exclusive}`, '0.5 false');
t('quality-risk ramp: 10, 25, 50, capped at 30%, exclusive', `${lever('codex').ramp.ramp.join(',')} ${lever('codex').ramp.cap} ${lever('codex').ramp.exclusive}`, '0.1,0.25,0.5 0.3 true');
t('quality-risk ramp steps after 15 clean tickets', lever('review-reuse').ramp.step_after, 15);
const dead = lever('codex').trips.find((x) => x.id === 'codex-dead-seats');
t('codex trips on dead seats (exit 124 or 75) above 20% of its last 10 calls', JSON.stringify([dead?.exits, dead?.calls, dead?.rate]), '[[124,75],10,0.2]');
t('every reason code a DS-646 event or row carries is in the list', ['codex_dead_seats', 'ramp_clean', 'audit_missing', 'audits_pending'].every((c) => c in REASON_CODES), true);
t('every lever holds back 10% for 4 weeks after an adopt', Object.values(REGISTRY).every((l) => l.ramp.holdback === 0.1 && l.ramp.holdback_weeks === 4), true);

// A lever with more than two arms: its values and the baseline among them.
const valued = (v, baseline, o = {}) => ({ ...ENTRIES, memory: { ...ENTRIES.memory, values: v, baseline, ...o } });
const vreg = loadRegistry(valued(['one-at-a-time', 'batched', 'mixed'], 'one-at-a-time'));
t('a lever may declare values and its baseline', `${vreg.memory.values.join(' ')} | ${vreg.memory.baseline} | ${isValued(vreg.memory)}`, 'one-at-a-time batched mixed | one-at-a-time | true');
t('a valued lever\'s values are frozen', Object.isFrozen(vreg.memory.values), true);
t('a lever with no values is on or off, as before', `${isValued(REGISTRY.memory)} ${'values' in REGISTRY.memory} ${'baseline' in REGISTRY.memory}`, 'false false false');
t('a baseline that is not one of the values fails loading', loadError(valued(['a', 'b'], 'c')), 'lever-registry: lever "memory" has baseline "c"; want one of its values (a, b)');
t('a single value fails loading', loadError(valued(['a'], 'a')), 'lever-registry: lever "memory" has "values" that are not two or more distinct arm names');
t('a value named like an on/off arm fails loading', loadError(valued(['on', 'b'], 'b')), 'lever-registry: lever "memory" has value "on"; want a lower-case word other than on, off, adopted, holdback');
t('a value DESK_LEVER_VALUES could not carry fails loading', /has value "a b"/.test(loadError(valued(['a b', 'c'], 'c'))), true);

// Question handling: three arms, batched the baseline, on trial.
const qh = lever('question-handling');
t('question handling: its arms, batched the baseline', `${qh.values.join(' ')} | ${qh.baseline} | ${qh.trialled}`, 'batched one-at-a-time mixed | batched | true');
t('question handling: ask dollars per asking ticket, down at least 10%', min('question-handling'), 'ask dollars per asking ticket down 0.1');
t('question handling: weighed only on the tickets that raised an ask', qh.rows, 'tickets that raised an ask');
t('question handling: parked hours guarded, as every lever is', qh.guardrails['parked-hours'] === GUARDRAILS['parked-hours'], true);
t('question handling: interruptions per ticket refused past 1.25 times batched\'s', qh.guardrails.interruptions.margin.max_rate_ratio, 1.25);
t('question handling: a breach of its guardrail has words of its own', REASON_CODES.guardrail_interruptions, 'interruptions per ticket rose past their margin');
t('question handling: its code is the arms module', qh.code.map((c) => c.path).join(' '), 'desk/bin/question-arms.mjs');
t('question handling: needs the ledger on', `${preconditions('question-handling', { ledger: 'off' }).eligible} ${preconditions('question-handling', { ledger: 'on' }).eligible}`, 'false true');
t('question handling: an unreadable levers row leaves it ineligible', preconditions('question-handling', { ledger: null }).eligible, false);
const ownGuard = (g) => ({ ...ENTRIES, memory: { ...ENTRIES.memory, guardrails: g } });
t('a guardrail of a lever\'s own may not reuse a shared key', loadError(ownGuard({ acceptance: { metric: 'x', margin: { max_rate_ratio: 1.1 } } })), 'lever-registry: lever "memory" has guardrail "acceptance", which is a shared one');
t('a guardrail of a lever\'s own needs a margin', loadError(ownGuard({ pings: { metric: 'pings per ticket' } })), 'lever-registry: lever "memory" has guardrail "pings" with no metric or rate-ratio margin');
t('rows that name nothing fail loading', loadError({ ...ENTRIES, memory: { ...ENTRIES.memory, rows: '' } }), 'lever-registry: lever "memory" is missing "rows"');

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all checks passed');
