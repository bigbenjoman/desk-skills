// suite: worker models (the tier decision and the §3b row)
// Config §3b "Worker models" and the per-ticket tier pass.mjs takes from a triage record. The spawn
// arguments, the preflight and the requeue bump run end to end in test_batch_e2e.sh.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// The finder and text models: unset unless named, after either form, and never on their own.
t('AC1 no finder or text model: neither is set', models('standard=sonnet high=opus'), '{"standard":"sonnet","high":"opus"}');
t('AC2 a finder model after the tiers', models('standard=sonnet high=opus finder=haiku'), '{"standard":"sonnet","high":"opus","finder":"haiku"}');
t('AC3 a text model after default', models('default text=sonnet'), '{"off":true,"text":"sonnet"}');
t('both, in any order among the tiers', models('text=sonnet high=opus finder=haiku standard=sonnet'), '{"standard":"sonnet","high":"opus","finder":"haiku","text":"sonnet"}');
t('a finder model with no tiers or default is refused', models('finder=haiku'), 'refused: names the row');
t('the tiers after default are refused', models('default standard=sonnet high=opus'), 'refused: names the row');
t('a finder named twice is refused', models('default finder=haiku finder=sonnet'), 'refused: names the row');
t('an empty finder model is refused', models('default finder='), 'refused: names the row');
t('a flag for a text model is refused', models('default text=--x'), 'refused: names the row');
t('a full model name for the finder is refused: the Agent tool takes an alias', models('default finder=claude-haiku-5-5'), 'refused: names the row');
t('a full model name for the text model is accepted', models('default text=claude-sonnet-5-5'), '{"off":true,"text":"claude-sonnet-5-5"}');
const why = (v) => { try { parseWorkerModels(v); return 'accepted'; } catch (e) { return e.message; } };
t('AC5 an unknown key is refused, naming the key and the row', /Worker models.*unknown key `reviewer`/.test(why('default reviewer=haiku')), true);
t('AC5 an unknown key after the tiers is named too', /unknown key `finders`/.test(why('standard=sonnet high=opus finders=haiku')), true);

// `desk-env model finder|text` prints the model, or `none` with exit 0 when the row names none.
const T = mkdtempSync(join(tmpdir(), 'worker-models-'));
const cli = (row, which) => {
  const cfg = join(T, 'config.md');
  writeFileSync(cfg, `## 3b. Caps\n| Field | Value |\n|---|---|\n| Worker models | \`${row}\` |\n`);
  const r = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-env.mjs'), 'model', which],
    { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: cfg, DESK_MACHINE: join(T, 'none.md'), HOME: T } });
  return `${r.status} ${r.stdout.trim()}`;
};
t('DS-398 AC6 finder unset: prints none, exits 0', cli('standard=sonnet high=opus', 'finder'), '0 none');
t('DS-398 AC6 text unset under default: prints none, exits 0', cli('default', 'text'), '0 none');
t('DS-398 AC6 finder set: prints it', cli('default finder=haiku', 'finder'), '0 haiku');
t('DS-398 a malformed row still exits 4', cli('opus', 'finder').split(' ')[0], '4');
rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} failed` : 'worker models: all checks passed');
process.exit(fails ? 1 : 0);
