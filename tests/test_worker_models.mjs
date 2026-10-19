// suite: worker models (the tier decision and the §3b row)
// Config §3b "Worker models" and the per-ticket tier pass.mjs takes from a triage record. The spawn
// arguments, the preflight and the requeue bump run end to end in test_batch_e2e.sh.
import { modelTier, parseWorkerModels } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

// Triage records as triage.sh and ticket-facts.mjs write them: lane, and size or null.
const rec = (lane, size) => ({ ticket: 'T-1', lane, size, branch: 'fix/T-1', files_in_scope: [], unknowns: [] });
t('lane A, size XS: standard', modelTier(rec('A', 'XS')), 'standard');
t('lane A, size S: standard', modelTier(rec('A', 'S')), 'standard');
t('lane E, size S: standard', modelTier(rec('E', 'S')), 'standard');
t('lane B, size S: high', modelTier(rec('B', 'S')), 'high');
t('lane B, size XS: high', modelTier(rec('B', 'XS')), 'high');
t('lane A, size M: high', modelTier(rec('A', 'M')), 'high');
t('lane E, size M: high', modelTier(rec('E', 'M')), 'high');
t('lane A, no size: high', modelTier(rec('A', null)), 'high');
t('lane A, size missing from the record: high', modelTier({ lane: 'A' }), 'high');
t('lowercase size reads the same', modelTier(rec('A', 's')), 'standard');
t('no record at all: high', modelTier(), 'high');

const models = (v) => { try { return JSON.stringify(parseWorkerModels(v)); } catch (e) { return `refused: ${/Worker models/.test(e.message) ? 'names the row' : e.message}`; } };
t('default: no model passed', models('default'), '{"off":true}');
t('two models', models('standard=sonnet high=opus'), '{"standard":"sonnet","high":"opus"}');
t('either order, full names', models('high=claude-opus-5-5 standard=claude-sonnet-5-5'), '{"standard":"claude-sonnet-5-5","high":"claude-opus-5-5"}');
t('a bracketed alias', models('standard=sonnet high=opus[1m]'), '{"standard":"sonnet","high":"opus[1m]"}');
t('only one tier is refused', models('standard=sonnet'), 'refused: names the row');
t('an unknown tier is refused', models('standard=sonnet max=opus'), 'refused: names the row');
t('a tier named twice is refused', models('standard=sonnet high=opus high=haiku'), 'refused: names the row');
t('an empty model is refused', models('standard= high=opus'), 'refused: names the row');
t('a flag for a model is refused', models('standard=--x high=opus'), 'refused: names the row');
t('a shell character is refused', models('standard=a;b high=opus'), 'refused: names the row');
t('a bare model is refused', models('opus'), 'refused: names the row');

console.log(fails ? `${fails} failed` : 'worker models: all checks passed');
process.exit(fails ? 1 : 0);
