// suite: not-now register (put-off questions, matched on their inputs)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRegister, lookup, putOffEntry, addPutOff, clearPutOff, parseInputs, refreshInputs, notNowPath, questionKey, NOT_NOW } from '../desk/bin/not-now.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const dir = mkdtempSync(join(tmpdir(), 'desk-not-now-'));
const Q = 'Rotate the production database password?';
const inputs = { ticket: 'V-7', 'pr-head': 'a1b2' };

t('a missing register is an empty one', readRegister(dir).entries.size, 0);
t('nothing put off is asked', lookup(readRegister(dir), { question: Q, inputs }).status, 'ask');
t('"not now" reads as putting it off', NOT_NOW.test('Not now — after the launch'), true);
t('"now" does not', NOT_NOW.test('now, please'), false);

// AC5: the register holds the question, the date and the inputs.
addPutOff(putOffEntry({ question: Q, ticket: 'V-7', inputs, by: 'Ben', at: '2026-10-21T09:00:00.000Z' }), dir);
const e = JSON.parse(readFileSync(notNowPath(dir), 'utf8').trim());
t('AC5 the entry holds the question, date, inputs and their hash', `${e.question} | ${e.at} | ${JSON.stringify(e.inputs)} | ${typeof e.hash}`, `${Q} | 2026-10-21T09:00:00.000Z | {"ticket":"V-7","pr-head":"a1b2"} | string`);

// AC6: unchanged inputs, in any order, and the same question however it is spaced or punctuated.
const reg = readRegister(dir);
t('AC6 unchanged inputs are put off', lookup(reg, { question: Q, inputs: { 'pr-head': 'a1b2', ticket: 'V-7' } }).status, 'put_off');
t('AC6 matched on the text, not its case or closing punctuation', lookup(reg, { question: '  rotate the PRODUCTION database password ', inputs }).status, 'put_off');
t('a different question is asked', lookup(reg, { question: 'Rotate the staging password?', inputs }).status, 'ask');

// AC7: changed inputs are asked, with a line saying what changed.
const ch = lookup(reg, { question: Q, inputs: { ticket: 'V-7', 'pr-head': 'c3d4', config: 'x' } });
t('AC7 changed inputs are asked', ch.status, 'changed');
t('AC7 with what changed since it was put off', ch.line, 'Changed since Ben put it off on 2026-10-21: config (new) → x; pr-head a1b2 → c3d4.');
t('an input gone is a change too', lookup(reg, { question: Q, inputs: { ticket: 'V-7' } }).line.includes('pr-head a1b2 → (gone)'), true);

// A later "not now" with the new inputs replaces the entry; clearing it asks again.
addPutOff(putOffEntry({ question: Q, ticket: 'V-7', inputs: { ticket: 'V-7', 'pr-head': 'c3d4' }, at: '2026-10-22T09:00:00.000Z' }), dir);
t('the latest entry for a question wins', lookup(readRegister(dir), { question: Q, inputs: { ticket: 'V-7', 'pr-head': 'c3d4' } }).status, 'put_off');
t('a cleared question is asked again', `${clearPutOff(Q, dir).ok} ${lookup(readRegister(dir), { question: Q, inputs: { ticket: 'V-7', 'pr-head': 'c3d4' } }).status}`, 'true ask');
t('clearing what is not there is refused', clearPutOff('Never asked?', dir).ok, false);

// A pass re-reads the inputs it can: pr-head and config rows. Others, and a reader with no answer, stay.
const read = { prHead: () => 'f00d', config: (id) => (id === 'default-branch' ? 'develop' : null) };
t('pr-head and a config row are read again, the rest kept', JSON.stringify(refreshInputs({ ticket: 'V-7', 'pr-head': 'a1b2', 'config:default-branch': 'main', 'config:gone': 'x' }, read)),
  '{"ticket":"V-7","pr-head":"f00d","config:default-branch":"develop","config:gone":"x"}');

// Inputs are a flat object of plain values.
t('no inputs are {}', JSON.stringify(parseInputs(null).inputs), '{}');
t('numbers are kept as text', parseInputs('{"pr": 12}').inputs.pr, '12');
t('a nested value is refused', parseInputs('{"a": {"b": 1}}').ok, false);
t('not JSON is refused', parseInputs('{a').why, 'inputs are not JSON');

// AC8: a register that cannot be read puts nothing off, so the question is asked as today.
const bad = join(dir, 'bad');
mkdirSync(bad);
writeFileSync(notNowPath(bad), `${JSON.stringify(putOffEntry({ question: Q, ticket: 'V-7', inputs }))}\n{"key": "torn`);
const unreadable = readRegister(bad);
t('AC8 a line that does not parse makes it unreadable, naming the line', `${unreadable.ok} ${/line 2 is not JSON/.test(unreadable.why)}`, 'false true');
t('AC8 and an unreadable register asks', lookup(unreadable, { question: Q, inputs }).status, 'ask');
const asDir = join(dir, 'dir');
mkdirSync(join(asDir, 'not-now.jsonl'), { recursive: true });
t('AC8 a register that is not a file is unreadable', readRegister(asDir).ok, false);

// The CLI, as an interactive session uses it.
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'not-now.mjs');
const sdir = join(dir, 'session');
const env = { ...process.env, DESK_AUTOPILOT_STATE: sdir, DESK_CONFIG: join(dir, 'none.md') };
for (const k of ['DESK_REPO_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG']) delete env[k];
const run = (args) => { try { return { code: 0, out: execFileSync('node', [cli, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: dir }) }; } catch (x) { return { code: x.status, out: `${x.stdout}${x.stderr}` }; } };
t('check on an empty register says ask', `${run(['check', Q]).code}`, '0');
t('add puts it off', /^put off: /.test(run(['add', 'V-7', Q, '--inputs', '{"ticket":"V-7"}']).out), true);
t('check with the same inputs exits 3', run(['check', Q, '--inputs', '{"ticket":"V-7"}']).code, 3);
const changed = run(['check', Q, '--inputs', '{"ticket":"V-8"}']);
t('check with changed inputs asks, with the line', `${changed.code} ${changed.out.includes('ticket V-7 → V-8')}`, '0 true');
t('bad inputs are refused with exit 11', run(['check', Q, '--inputs', '[1]']).code, 11);
t('a bad ticket id is refused with exit 11', run(['add', '../x', Q]).code, 11);
t('the key is the question\'s', JSON.parse(readFileSync(notNowPath(sdir), 'utf8').trim()).key, questionKey(Q));

rmSync(dir, { recursive: true, force: true });
t('cleaned up', existsSync(dir), false);
if (fails) { console.log(`${fails} failed`); process.exit(1); }
