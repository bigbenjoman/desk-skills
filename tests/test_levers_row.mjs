// suite: desk-env levers (the levers row's auto, pins and none; the machine-wide freeze; the row's changes logged)
// covers: desk/bin/desk-env.mjs desk/bin/lever-log.mjs desk/bin/lever-pin.mjs desk/bin/lever-changes.mjs desk/bin/queue.mjs desk-config.md
// `desk-env levers` says where each lever's state comes from, refuses `none` beside another name,
// sets and clears ~/.desk-autopilot/levers.freeze and logs it in every repo's lever log, and logs a
// changed row; `queue.mjs add` pins the row's named levers. Scratch HOME, config root and queue only.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { leverRow, parseLevers } from '../desk/bin/desk-env.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(root, 'desk', 'bin');

// ---- the parser -----------------------------------------------------------------------------------
t('auto is no lever and no unknown', parseLevers(['auto preflight']), { on: ['preflight'], unknown: [] });
t('auto is read from the row', leverRow(['auto', 'preflight']).auto, true);
t('none beside another name is invalid and every lever off', (({ on, invalid }) => [on, !!invalid])(leverRow(['auto none'])), [[], true]);
t('none beside a lever is invalid too', leverRow(['none', 'preflight']).on, []);
t('none alone is valid', leverRow(['none']).invalid, null);

// ---- scratch HOME, configs, queue -----------------------------------------------------------------
const T = mkdtempSync(join(tmpdir(), 'desk-levers-row-'));
const HOME = join(T, 'home');
const CROOT = join(T, 'config-root');
for (const d of [HOME, join(T, 'repo'), join(T, 'state')]) mkdirSync(d, { recursive: true });
const configText = (row) => `## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`${join(T, 'repo')}\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Phase 0 levers | \`none\` | ${row} |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`none\` |
| Other work id patterns | \`none\` |
`;
const CFG = join(T, 'config.md');
const setRow = (row) => writeFileSync(CFG, configText(row));
// Two repos on this computer, for the machine-wide freeze.
for (const slug of ['acme__widgets', 'acme__gadgets']) {
  mkdirSync(join(CROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(CROOT, 'repos', slug, 'config.md'), configText('`none`'));
}
const QUEUE = join(T, 'queue.json');
const STATE = join(T, 'state');
const env = (extra = {}) => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete e[k];
  return { ...e, HOME, GIT_CONFIG_NOSYSTEM: '1', DESK_CONFIG: CFG, DESK_CONFIG_ROOT: CROOT, DESK_STATE: STATE, DESK_AUTOPILOT_STATE: STATE,
    DESK_QUEUE: QUEUE, DESK_REPO_OVERRIDE: 'acme/widgets', DESK_MACHINE: join(T, 'none.md'), ...extra };
};
const run = (args, extra) => spawnSync('node', [join(BIN, 'desk-env.mjs'), 'levers', ...args], { cwd: join(T, 'repo'), env: env(extra), encoding: 'utf8' });
const lines = (r) => r.stdout.trim().split('\n');
const state = (r, lever) => lines(r).find((l) => l.startsWith(`${lever}: `))?.slice(lever.length + 2);
const others = (r, lever) => [...new Set(['codex', 'effort', 'failure-class', 'memory', 'preflight', 'review-reuse', 'wrappers'].filter((n) => n !== lever).map((n) => state(r, n)))];
let n = 0;
const admitPin = () => {
  const key = `R-${++n}`;
  writeFileSync(QUEUE, JSON.stringify({ version: 1, batch: 'b', concurrency: 1, tickets: {} }));
  spawnSync('node', [join(BIN, 'queue.mjs'), 'add', key, 'Story', 'A'], { cwd: join(T, 'repo'), env: env(), encoding: 'utf8' });
  return JSON.parse(readFileSync(QUEUE, 'utf8')).tickets[key]?.levers;
};
const admit = () => admitPin()?.set;
const log = (slug) => {
  const f = join(HOME, '.desk-autopilot', slug, 'levers.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const FREEZE = join(HOME, '.desk-autopilot', 'levers.freeze');

// ---- AC1, AC2: auto with a pin --------------------------------------------------------------------
setRow('`auto preflight`');
let r = run([]);
t('AC1 exits 0', r.status, 0);
t('AC1 preflight is pinned', state(r, 'preflight'), 'pinned');
t('AC1 every other lever is auto', others(r, 'preflight'), ['auto']);
t('AC1 only the pin is on', lines(r)[0], 'on: preflight');
const autoPin = admitPin();
t('AC2 a ticket admitted under auto preflight is pinned with preflight on, outside any trial', [autoPin?.set.includes('preflight'), Object.hasOwn(autoPin?.arms ?? {}, 'preflight')], [true, false]);
t('AC2 and only the levers auto hands to trials draw arms', Object.keys(autoPin?.arms ?? {}).sort(), ['codex', 'effort', 'failure-class', 'memory', 'review-reuse', 'wrappers']);

// ---- AC3: none --------------------------------------------------------------------------------------
setRow('`none`');
r = run([]);
t('AC3 every lever is off', [...new Set([state(r, 'preflight'), ...others(r, 'preflight')])], ['off']);
t('AC3 a ticket admitted then is pinned with an empty set', admit(), []);

// ---- AC4: a pin alone, as the row reads today -------------------------------------------------------
setRow('`preflight`');
r = run([]);
t('AC4 preflight is pinned', state(r, 'preflight'), 'pinned');
t('AC4 the others are off', others(r, 'preflight'), ['off']);
t('AC4 levers <name> still prints on', run(['preflight']).stdout.trim(), 'on');

// ---- AC7: auto none ---------------------------------------------------------------------------------
setRow('`auto none`');
r = run([]);
t('AC7 exits non-zero', r.status !== 0, true);
t('AC7 names the row as invalid', /Phase 0 levers" is invalid/.test(r.stderr), true);
t('AC7 every lever is off', [...new Set([state(r, 'preflight'), ...others(r, 'preflight')])], ['off']);
t('AC7 a ticket admitted then is pinned with an empty set', admit(), []);
r = run(['codex']);
t('AC7 asking for one lever reads off, says the row is invalid, and exits 0', [r.stdout.trim(), /is invalid/.test(r.stderr), r.status], ['off', true, 0]);

// ---- AC8: an unknown lever ----------------------------------------------------------------------------
setRow('`preflight turbo`');
r = run([]);
t('AC8 names the unknown lever', lines(r).some((l) => l.startsWith('unknown: turbo ')), true);
t('AC8 and still exits 0', r.status, 0);

// ---- a worker's pin -------------------------------------------------------------------------------------
r = run([], { DESK_LEVERS: 'memory' });
t('a pinned worker reads its pin, not the row', [lines(r)[0], state(r, 'memory'), state(r, 'preflight')], ['on: memory', 'pinned', 'off']);
t('and says it comes from the pin', lines(r)[1], 'from: this ticket\'s pin (DESK_LEVERS)');

// ---- AC11: a changed row is logged once ----------------------------------------------------------------
rmSync(join(HOME, '.desk-autopilot', 'acme__widgets'), { recursive: true, force: true });
setRow('`preflight`');
run([]);
let changes = log('acme__widgets').filter((e) => e.kind === 'row_change');
t('AC11 the first read records the row', changes.map((e) => [e.before, e.after]), [[null, 'preflight']]);
run([]);
t('AC11 an unchanged row is not logged again', log('acme__widgets').filter((e) => e.kind === 'row_change').length, 1);
setRow('`auto preflight`');
run(['memory']);
changes = log('acme__widgets').filter((e) => e.kind === 'row_change');
t('AC11 a changed row is one row_change with the row before and after', changes.slice(1).map((e) => [e.before, e.after, e.repo, e.reason_code]), [['preflight', 'auto preflight', 'acme__widgets', 'row_change']]);
setRow('`Preflight, auto`');
run([]);
t('AC11 the same names in another order or case are no change', log('acme__widgets').filter((e) => e.kind === 'row_change').length, 2);
run([], { DESK_LEVERS: 'memory' });
t('AC11 a pinned worker does not read the row, so logs nothing', log('acme__widgets').filter((e) => e.kind === 'row_change').length, 2);
setRow('`memory`');
run(['memory'], { DESK_AUTOPILOT_WORKER: '1' });
t('AC11 an unpinned worker reads the row but logs nothing', log('acme__widgets').filter((e) => e.kind === 'row_change').length, 2);
// Readers of one edit at once record it once: the log is read and written under its lock.
const runAsync = () => new Promise((res) => {
  const c = spawn('node', [join(BIN, 'desk-env.mjs'), 'levers'], { cwd: join(T, 'repo'), env: env(), stdio: 'ignore' });
  c.on('close', res);
});
await Promise.all(Array.from({ length: 6 }, runAsync));
t('AC11 six reads of one edit at once log one row_change', log('acme__widgets').filter((e) => e.kind === 'row_change').map((e) => e.after).slice(2), ['memory']);
setRow('`Preflight, auto`');

// ---- AC5, AC9: freeze -----------------------------------------------------------------------------------
const before = { w: log('acme__widgets').length, g: log('acme__gadgets').length };
r = run(['freeze', 'holiday week']);
t('AC5 freeze exits 0', r.status, 0);
t('AC5 the freeze file exists', existsSync(FREEZE), true);
t('AC5 desk-env levers prints frozen', lines(run([])).some((l) => l.startsWith('frozen: ')), true);
setRow('`none`');
t('AC5 in any repo', lines(run([], { DESK_REPO_OVERRIDE: 'acme/gadgets' })).some((l) => l.startsWith('frozen: ')), true);
setRow('`Preflight, auto`');
const froze = { w: log('acme__widgets').slice(before.w).filter((e) => e.kind === 'freeze'), g: log('acme__gadgets').slice(before.g).filter((e) => e.kind === 'freeze') };
t('AC9 one freeze event in every repo\'s lever log', [froze.w.length, froze.g.length], [1, 1]);
t('AC9 with repo *', [froze.w[0]?.repo, froze.g[0]?.repo], ['*', '*']);
t('AC9 with its reason', froze.w[0]?.reason, 'holiday week');
r = run(['freeze']);
t('a second freeze changes nothing and logs nothing', [r.status, log('acme__widgets').filter((e) => e.kind === 'freeze').length], [0, 1]);
r = run(['freeze'], { DESK_AUTOPILOT_WORKER: '1' });
t('a worker is refused the freeze', r.status, 4);

// ---- AC6, AC10: thaw ------------------------------------------------------------------------------------
r = run(['thaw']);
t('AC6 thaw exits 0', r.status, 0);
t('AC6 the freeze file is gone', existsSync(FREEZE), false);
t('AC6 desk-env levers no longer prints frozen', lines(run([])).some((l) => l.startsWith('frozen')), false);
const thawed = ['acme__widgets', 'acme__gadgets'].map((s) => log(s).filter((e) => e.kind === 'thaw'));
t('AC10 one thaw event with repo * in every repo\'s lever log', thawed.map((ev) => ev.map((e) => e.repo)), [['*'], ['*']]);
t('a thaw with no freeze changes nothing', [run(['thaw']).status, log('acme__widgets').filter((e) => e.kind === 'thaw').length], [0, 1]);

// ---- DS-644 AC6, AC7, AC10: the summary line of each managed lever's state ----------------------------
// preflight pinned; wrappers adopted yesterday with 23 holdback tickets so far; memory on trial with 31
// tickets in its smaller arm; failure-class set off by hand, so it is not on the line.
rmSync(join(HOME, '.desk-autopilot', 'acme__widgets'), { recursive: true, force: true });
mkdirSync(join(HOME, '.desk-autopilot', 'acme__widgets'), { recursive: true });
const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const ev = (o) => ({ v: 1, repo: 'acme__widgets', ...o });
const assign = (lever, arm, trial, i) => ev({ id: `as-${lever}-${arm}-${i}`, at: ago(20), kind: 'assign', actor: 'levers-auto', reason_code: 'assigned_at_admission', reason: 'drew', ticket: `S-${lever}-${arm}-${i}`, arms: { [lever]: arm }, trial_ids: { [lever]: trial } });
const fixture = [
  ev({ id: 'fc-off', at: ago(30), kind: 'transition', lever: 'failure-class', from: 'trial', to: 'off', actor: 'ben', reason_code: 'ben_override', reason: 'off by hand' }),
  ev({ id: 'w-adopt', at: ago(24), kind: 'transition', lever: 'wrappers', from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'adopted', eval_id: 'evl_w', evidence_file: 'levers-evidence/evl_w.jsonl' }),
  ...Array.from({ length: 23 }, (_, i) => assign('wrappers', 'holdback', 'acme__widgets/wrappers/w-adopt', i)),
  ...Array.from({ length: 40 }, (_, i) => assign('wrappers', 'adopted', 'acme__widgets/wrappers/w-adopt', i)),
  ...Array.from({ length: 31 }, (_, i) => assign('memory', 'on', 'acme__widgets/memory/initial', i)),
  ...Array.from({ length: 33 }, (_, i) => assign('memory', 'off', 'acme__widgets/memory/initial', i)),
  // A ticket drawn under an earlier trial id counts for none of these.
  assign('memory', 'on', 'acme__widgets/memory/older', 0),
];
writeFileSync(join(HOME, '.desk-autopilot', 'acme__widgets', 'levers.jsonl'), fixture.map((e) => `${JSON.stringify(e)}\n`).join(''));
setRow('`preflight auto`');
r = run([]);
const summary = (x) => lines(x).filter((l) => l.startsWith('levers: '));
// The quality-risk levers are on trial from the start too, with no ticket drawn yet.
const QR_TRIALS = ' · codex trial 0/40 · review-reuse trial 0/40 · effort trial 0/40';
t('DS-644 AC6 the summary line reads each managed lever\'s state', summary(r), [`levers: preflight pinned · wrappers adopted (holdback 23) · memory trial 31/30${QR_TRIALS}`]);
t('DS-644 AC6 and is the last line', [lines(r).at(-1), r.status], [`levers: preflight pinned · wrappers adopted (holdback 23) · memory trial 31/30${QR_TRIALS}`, 0]);
appendFileSync(join(HOME, '.desk-autopilot', 'acme__widgets', 'levers.jsonl'), `${JSON.stringify(ev({ id: 'w-over', at: ago(1), kind: 'override', lever: 'wrappers', from: 'adopted', to: 'overridden', value: 'off', actor: 'ben', reason_code: 'ben_override', reason: 'off by hand', decision_id: 'd1' }))}\n`);
t('DS-644 AC10 an overridden lever shows its state and value', summary(run([])), [`levers: preflight pinned · wrappers overridden off · memory trial 31/30${QR_TRIALS}`]);
setRow('`preflight`');
t('DS-644 AC7 a row with no auto prints no summary line', summary(run([])), []);
setRow('`Preflight, auto`');

// ---- the row's documentation ----------------------------------------------------------------------------
const doc = readFileSync(join(root, 'desk-config.md'), 'utf8').split('\n').find((l) => l.startsWith('| Phase 0 levers |')) ?? '';
t('desk-config.md documents auto, none and the freeze', ['`auto`', '`none` alone', '`none` beside another name is refused', 'desk-env levers freeze', 'desk-env levers thaw', '`pinned`, `auto` or `off`'].filter((w) => !doc.includes(w)), []);

rmSync(T, { recursive: true, force: true });
if (fails) { console.log(`${fails} failed`); process.exit(1); }
