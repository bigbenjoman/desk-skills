// suite: lever log (every lever action as one line in the repo's levers.jsonl)
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = scratch('lever-log-');
process.env.HOME = HOME;
const { append, read, logFile, LeverLogError } = await import('../desk/bin/lever-log.mjs');
const { REASON_CODES, reasonWording } = await import('../desk/bin/lever-registry.mjs');

const SLUG = 'acme__shop';
const refused = (event, slug = SLUG) => { try { append(slug, event); return 'appended'; } catch (e) { return e instanceof LeverLogError ? e.message : `other error: ${e.message}`; } };
const lines = (slug = SLUG) => (existsSync(logFile(slug)) ? readFileSync(logFile(slug), 'utf8').split('\n').filter(Boolean) : []);
const transition = { lever: 'preflight', kind: 'transition', from: 'trial', to: 'adopted', actor: 'controller', reason_code: 'adopt_all_conditions', reason: 'preflight cut dollars per start by 34% with every guardrail inside its margin', eval_id: 'eval-2026-11-14', evidence_file: 'evidence/2026-11-14-preflight.json' };

t('the log sits in the repo\'s own state folder, outside any batch', logFile(SLUG), join(HOME, '.desk-autopilot', SLUG, 'levers.jsonl'));

// AC1: an unknown kind is refused by name, and nothing is written.
t('AC1 an unknown kind is refused, naming it', refused({ ...transition, kind: 'teleport' }).startsWith('lever-log: kind "teleport" is not one of'), true);
t('AC1 nothing is written', lines().length, 0);

// AC2: an unknown reason code is refused by name, and nothing is written.
t('AC2 an unknown reason code is refused, naming it', refused({ ...transition, reason_code: 'felt_right' }), 'lever-log: reason_code "felt_right" is not in the closed list (lever-registry.mjs REASON_CODES)');
t('AC2 nothing is written', lines().length, 0);

// AC3: a controller's transition holds the whole envelope.
const written = append(SLUG, transition);
const line = JSON.parse(lines()[0]);
t('AC3 one line', lines().length, 1);
t('AC3 the line holds the envelope', ['v', 'id', 'at', 'repo', 'lever', 'kind', 'from', 'to', 'actor', 'reason_code', 'reason', 'eval_id', 'evidence_file'].every((k) => line[k] != null), true);
t('AC3 v, repo and a parseable at are filled in', `${line.v} ${line.repo} ${!Number.isNaN(Date.parse(line.at))}`, `1 ${SLUG} true`);
t('AC3 the reason is stored as written', line.reason, transition.reason);
t('AC3 append returns the line it wrote', JSON.stringify(written), lines()[0]);
t('AC3 a controller transition without eval_id is refused', refused({ ...transition, eval_id: undefined }), 'lever-log: a transition event needs "eval_id"');
t('AC3 a controller transition without evidence_file is refused', refused({ ...transition, evidence_file: undefined }), 'lever-log: a transition event needs "evidence_file"');
t('AC3 a lever the registry does not declare is refused', refused({ ...transition, lever: 'turbo' }), 'lever-log: lever "turbo" is not declared in the lever registry');

// AC4: Ben's own transition needs no evaluation or evidence file.
const { eval_id, evidence_file, ...byHand } = transition;
t('AC4 a transition by ben without eval_id or evidence_file is accepted', refused({ ...byHand, actor: 'ben', reason_code: 'ben_override', reason: 'turning it off while I look at the preflight logs' }), 'appended');
t('AC4 a freeze names no lever', refused({ kind: 'freeze', actor: 'ben', reason_code: 'freeze', reason: 'holiday week' }), 'appended');

// AC5: two processes appending at once leave whole lines.
const RACE = 'acme__race';
const N = 50;
const child = (who) => new Promise((done) => {
  const code = `const { append } = await import(${JSON.stringify(join(ROOT, 'desk/bin/lever-log.mjs'))});
    while (Date.now() < ${Date.now() + 500});
    for (let i = 0; i < ${N}; i++) append(${JSON.stringify(RACE)}, { lever: 'memory', kind: 'audit', actor: '${who}', reason_code: 'below_min_sample', reason: '${who} '.repeat(2000) + i });`;
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME }, stdio: ['ignore', 'ignore', 'inherit'] });
  p.on('exit', done);
});
const exits = await Promise.all([child('a'), child('b')]);
t('AC5 both writers finish', exits.join(' '), '0 0');
const race = read(RACE);
t('AC5 every line is whole and parses', `${race.events.length} ${race.bad.length}`, `${2 * N} 0`);
t('AC5 both writers\' lines are there', `${race.events.filter((e) => e.actor === 'a').length} ${race.events.filter((e) => e.actor === 'b').length}`, `${N} ${N}`);

// AC6: kinds narrows the read, oldest first.
const MIX = 'acme__mix';
const at = (d) => `2026-11-1${d}T09:00:00.000Z`;
append(MIX, { ...transition, at: at(3) });
append(MIX, { lever: 'memory', kind: 'assign', actor: 'controller', reason_code: 'below_min_sample', reason: 'drawn on', at: at(1) });
append(MIX, { lever: 'memory', kind: 'audit', actor: 'controller', reason_code: 'window_tight', reason: 'sampled', at: at(2) });
append(MIX, { ...transition, lever: 'wrappers', at: at(0) });
const only = read(MIX, { kinds: ['transition'] });
t('AC6 only transition lines, oldest first', only.events.map((e) => `${e.kind}:${e.lever}`).join(' '), 'transition:wrappers transition:preflight');
t('AC6 every kind without the filter', read(MIX).events.map((e) => e.kind).join(' '), 'transition assign audit transition');
t('since keeps events at or after it', read(MIX, { since: at(2) }).events.map((e) => e.kind).join(' '), 'audit transition');

// AC7: a line that does not parse is named by number, and the rest are returned.
appendFileSync(logFile(MIX), '{"kind": "transition", "lev\n');
append(MIX, { ...transition, at: at(4) });
const torn = read(MIX);
t('AC7 the other lines are returned', torn.events.length, 5);
t('AC7 the bad line is named by its number', torn.bad.map((b) => b.line).join(' '), '5');
t('a missing log reads as empty', JSON.stringify(read('acme__none')), '{"events":[],"bad":[]}');

// AC8: every reason code has wording.
const codes = Object.keys(REASON_CODES);
t('AC8 the list is not empty', codes.length > 0, true);
t('AC8 every code has a sentence fragment', codes.filter((c) => typeof reasonWording(c) !== 'string' || !reasonWording(c).trim()).join(' '), '');
t('AC8 a code not in the list has none', reasonWording('felt_right'), null);
t('AC8 the handoff\'s examples are in the list', ['adopt_all_conditions', 'below_min_sample', 'window_tight', 'weekly_cap'].every((c) => reasonWording(c)), true);

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all checks passed');
