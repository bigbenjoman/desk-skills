// suite: levers auto (each admitted ticket's trial arms, by blocked randomisation, recorded on its pin)
// covers: desk/bin/levers-auto.mjs desk/bin/lever-log.mjs desk/bin/lever-registry.mjs desk/bin/lever-pin.mjs desk/bin/queue.mjs desk/bin/seeded-random.mjs
// assignPin draws against a repo's lever log in a scratch HOME with a seeded random source; queue.mjs
// admit and add and `levers-auto.mjs assign` run as subprocesses on a scratch queue and repo.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'levers-auto-'));
for (const d of ['home', 'repo', 'deskhome', 'state']) mkdirSync(join(T, d), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete process.env[k];

const config = (name, row) => {
  const p = join(T, `${name}.md`);
  writeFileSync(p, `## 0. Repo
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
| Worker location | \`local\` | \`local\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`none\` |
| Other work id patterns | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Unit tests | \`bash tests/run.sh\` |
`);
  return p;
};
const AUTO = config('auto', '`auto`');
const ROW = config('row', '`preflight`');
Object.assign(process.env, {
  HOME: join(T, 'home'), DESK_CONFIG: AUTO, DESK_HOME: join(T, 'deskhome'), DESK_REPO_OVERRIDE: 'acme/widgets',
  DESK_MACHINE: join(T, 'none.md'), GIT_CONFIG_NOSYSTEM: '1',
});

const { assignPin, leverStatesIn } = await import('../desk/bin/levers-auto.mjs');
const { seededRandom } = await import('../desk/bin/seeded-random.mjs');
const { append, read, logFile } = await import('../desk/bin/lever-log.mjs');
const { REGISTRY } = await import('../desk/bin/lever-registry.mjs');
const { leverRow, LEVERS } = await import('../desk/bin/desk-env.mjs');
// Each lever's state for a levers row, as desk-env's leverStates gives it for the config's row.
const rowStates = (row) => { const r = leverRow([row]); return Object.fromEntries(LEVERS.map((n) => [n, r.on.includes(n) ? 'pinned' : r.auto ? 'auto' : 'off'])); };
const ROW_STATES = rowStates('preflight');
const AUTO_PIN_STATES = rowStates('auto preflight');

const TRIAL = Object.keys(REGISTRY).filter((n) => REGISTRY[n].layer === 'low-risk' && REGISTRY[n].trialled);
const QUALITY = Object.keys(REGISTRY).filter((n) => REGISTRY[n].layer === 'quality-risk');
const NOW = new Date('2026-11-16T10:00:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const admitMany = (slug, n, { size = 'S', seed = 7, frozen = null, prefix = 'K' } = {}) => {
  const random = seededRandom(seed);
  return Array.from({ length: n }, (_, i) => assignPin(`${prefix}-${i + 1}`, { slug, size, random, frozen, now: NOW }));
};
const share = (pins, pred) => pins.filter((r) => pred(r.pin)).length / pins.length;
const byHand = (slug, lever, to, at) => append(slug, { kind: 'override', lever, to, actor: 'ben', reason_code: 'ben_override', reason: `set ${lever} ${to} by hand`, at });

t('no state recorded: every trialled low-risk lever is on trial, every quality-risk lever off',
  Object.fromEntries(Object.entries(leverStatesIn([])).map(([n, s]) => [n, s.state])),
  Object.fromEntries(Object.keys(REGISTRY).map((n) => [n, TRIAL.includes(n) ? 'trial' : 'off'])));

// ---- AC1: blocks of four per size keep each arm at exactly two ----------------------------------
{
  const random = seededRandom(11);
  const pins = [];
  for (let i = 0; i < 8; i++) {
    pins.push(assignPin(`S-${i + 1}`, { slug: 'ac1', size: 'S', random, now: NOW }).pin);
    if (i % 3 === 0) assignPin(`M-${i + 1}`, { slug: 'ac1', size: 'm', random, now: NOW });
  }
  for (const [label, block] of [['first', pins.slice(0, 4)], ['second', pins.slice(4)]]) {
    for (const lever of ['wrappers', 'memory']) t(`AC1 ${label} block of four S tickets: ${lever} is on for exactly two`, block.filter((p) => p.set.includes(lever)).length, 2);
    t(`AC1 ${label} block: every trial lever's arms are two on, two off`, TRIAL.every((l) => block.filter((p) => p.arms[l] === 'on').length === 2 && block.filter((p) => p.arms[l] === 'off').length === 2), true);
    t(`AC1 ${label} block: its four tickets share one block id`, new Set(block.map((p) => p.block)).size, 1);
  }
  t('AC1 the two S blocks are different blocks', pins[0].block !== pins[4].block, true);
  t('AC1 M tickets fill blocks of their own', read('ac1', { kinds: ['assign'] }).events.filter((e) => e.size === 'M').map((e) => e.block), ['ac1/M/1', 'ac1/M/1', 'ac1/M/1']);
  const unsized = assignPin('U-1', { slug: 'ac1', size: null, random, now: NOW }).pin;
  t('AC1 a ticket with no size gets a block of its own', unsized.block, 'ac1/unsized/U-1');
}

// ---- AC2: the levers are drawn independently ---------------------------------------------------
{
  const pins = admitMany('ac2', 1000, { seed: 2026 });
  const both = share(pins, (p) => p.set.includes('wrappers') && p.set.includes('memory'));
  t(`AC2 with a fixed seed, both wrappers and memory on for 20-30% of 1,000 tickets (${both})`, both >= 0.2 && both <= 0.3, true);
  t('AC2 each is on for exactly half', [share(pins, (p) => p.set.includes('wrappers')), share(pins, (p) => p.set.includes('memory'))], [0.5, 0.5]);
  const again = admitMany('ac2-again', 20, { seed: 2026 }).map((r) => r.pin.arms);
  t('AC2 the same seed draws the same arms', JSON.stringify(again) === JSON.stringify(pins.slice(0, 20).map((r) => r.pin.arms)), true);
}

// ---- AC3 and AC11: the pin and its assign event ------------------------------------------------
{
  const { pin, assigned } = assignPin('P-1', { slug: 'ac3', size: 'M', random: seededRandom(3), now: NOW });
  t('AC3 assigned', assigned, true);
  t('AC3 the pin holds the set, the arms, the trial ids, the fingerprints, the block and the time', Object.keys(pin), ['set', 'arms', 'trial_ids', 'fp', 'block', 'at']);
  t('AC3 an arm per lever on trial', Object.keys(pin.arms).sort(), [...TRIAL].sort());
  t('AC3 a trial id per lever on trial', Object.keys(pin.trial_ids).sort(), [...TRIAL].sort());
  t('AC3 the trial id names the repo, the lever and the trial', pin.trial_ids.wrappers, 'ac3/wrappers/initial');
  t('AC3 a fingerprint entry per registry lever', Object.keys(pin.fp).sort(), Object.keys(REGISTRY).sort());
  t('AC3 the time it was pinned', pin.at, NOW.toISOString());
  t('AC3 the set is the levers drawn on', pin.set, TRIAL.filter((l) => pin.arms[l] === 'on'));
  const events = read('ac3').events;
  t('AC11 one assign event', events.map((e) => e.kind), ['assign']);
  const e = events[0];
  t('AC11 it holds the ticket, its arms, its trial ids and its block id', [e.ticket, e.arms, e.trial_ids, e.block], ['P-1', pin.arms, pin.trial_ids, pin.block]);
  t('AC11 it is in the repo\'s lever log', logFile('ac3'), join(T, 'home', '.desk-autopilot', 'ac3', 'levers.jsonl'));
}

// ---- AC4: holdback after an adopt --------------------------------------------------------------
{
  byHand('ac4', 'wrappers', 'adopted', daysAgo(7));
  const pins = admitMany('ac4', 1000, { seed: 44 });
  const held = share(pins, (p) => p.arms.wrappers === 'holdback');
  t(`AC4 inside the holdback, 7-13% of 1,000 tickets have wrappers off as holdback (${held})`, held >= 0.07 && held <= 0.13, true);
  t('AC4 every holdback ticket has it off, every other has it on', pins.every((r) => r.pin.set.includes('wrappers') === (r.pin.arms.wrappers === 'adopted')), true);
  byHand('ac4-late', 'wrappers', 'adopted', daysAgo(29));
  const late = assignPin('L-1', { slug: 'ac4-late', size: 'S', random: seededRandom(1), now: NOW }).pin;
  t('AC4 past its four weeks it is on with no arm', [late.set.includes('wrappers'), late.arms.wrappers ?? null], [true, null]);
}

// ---- AC5: reverted and frozen levers are off ---------------------------------------------------
{
  byHand('ac5', 'memory', 'reverted', daysAgo(2));
  byHand('ac5', 'preflight', 'frozen', daysAgo(1));
  const pins = admitMany('ac5', 8, { seed: 5 });
  t('AC5 a reverted lever is off on every ticket, with no arm', pins.every((r) => !r.pin.set.includes('memory') && r.pin.arms.memory == null), true);
  t('AC5 a frozen lever is off on every ticket, with no arm', pins.every((r) => !r.pin.set.includes('preflight') && r.pin.arms.preflight == null), true);
  t('AC5 the others are still drawn', pins.every((r) => ['on', 'off'].includes(r.pin.arms.wrappers)), true);
}

// ---- AC6: a repo with no auto pins its row -----------------------------------------------------
{
  const r = assignPin('R-1', { slug: 'ac6', size: 'S', states: ROW_STATES, random: seededRandom(6), now: NOW });
  t('AC6 the pin is the row\'s set and the time, with no arm', r.pin, { set: ['preflight'], at: NOW.toISOString() });
  t('AC6 nothing is written to the lever log', existsSync(logFile('ac6')), false);
}

// ---- AC7: the machine-wide freeze -------------------------------------------------------------
{
  byHand('ac7', 'wrappers', 'adopted', daysAgo(3));
  byHand('ac7', 'memory', 'settled', daysAgo(90));
  const pins = admitMany('ac7', 20, { seed: 7, frozen: { at: daysAgo(0), reason: 'test' } });
  t('AC7 frozen: the pin holds the repo\'s adopted set', [...new Set(pins.map((r) => [...r.pin.set].sort().join(' ')))], ['memory wrappers']);
  t('AC7 frozen: no trial arm and no block', pins.every((r) => !Object.keys(r.pin.arms).length && r.pin.block == null), true);
  const named = assignPin('F-1', { slug: 'ac7', size: 'S', states: AUTO_PIN_STATES, random: seededRandom(1), frozen: { at: daysAgo(0) }, now: NOW }).pin;
  t('AC7 frozen: a lever the row names stays on', [...named.set].sort(), ['memory', 'preflight', 'wrappers']);
}

// ---- DS-646: the quality-risk layer, exclusive, ramped and capped ----------------------------------
{
  const quality = (pin) => QUALITY.filter((l) => pin.set.includes(l));
  const LOCAL = { 'worker-location': 'local' };
  const admitQ = (slug, n, { seed = 46, inFlight = [], values = LOCAL, prefix = 'Q', random = seededRandom(seed) } = {}) =>
    Array.from({ length: n }, (_, i) => assignPin(`${prefix}-${i + 1}`, { slug, size: 'S', random, now: NOW, inFlight, values }).pin);
  t('the registry marks every quality-risk lever trialled', QUALITY.every((l) => REGISTRY[l].trialled === true), true);
  t('with no state recorded a quality-risk lever is off: a trial is begun by a transition', QUALITY.map((l) => leverStatesIn([])[l].state), QUALITY.map(() => 'off'));

  // AC1: two on trial, at most one per ticket.
  for (const l of ['codex', 'review-reuse']) byHand('q1', l, 'trial', daysAgo(1));
  const p1 = admitQ('q1', 300);
  t('AC1 codex and review-reuse on trial: no ticket carries both', p1.every((p) => !(p.set.includes('codex') && p.set.includes('review-reuse'))), true);
  t('AC1 each is carried by some tickets', ['codex', 'review-reuse'].every((l) => p1.some((p) => p.set.includes(l))), true);
  t('AC1 a ticket on one trial has no arm in the other; one on neither is off in both', p1.every((p) => {
    const a = [p.arms.codex ?? null, p.arms['review-reuse'] ?? null];
    return ['on,', ',on', 'off,off'].includes(a.join(','));
  }), true);
  t('AC1 a carried quality-risk lever is the ticket\'s arm `on`', p1.every((p) => quality(p).every((l) => p.arms[l] === 'on')), true);
  t('AC1 the quality-risk arms keep the low-risk block', p1.every((p) => typeof p.block === 'string'), true);

  // AC2 and AC11: 10%, then 25% after 15 clean tickets, then 50% after 15 more.
  byHand('q2', 'codex', 'trial', daysAgo(1));
  const random = seededRandom(2);
  let i = 0;
  const admitOne = () => assignPin(`R-${++i}`, { slug: 'q2', size: 'S', random, now: NOW, inFlight: [], values: LOCAL }).pin;
  const ramps = () => read('q2', { kinds: ['ramp'] }).events;
  let on = 0;
  while (on < 15 && i < 2000) if (admitOne().set.includes('codex')) on++;
  const before = i;
  t('AC2 at the first share, about 10% carry it', before > 80 && before < 300, true);
  t('AC2 no step while only 15 tickets have carried it', ramps().length, 0);
  const sixteenth = admitOne();
  t('AC11 the next admission appends one ramp event, the share before and after', ramps().map((e) => [e.lever, e.from, e.to, e.reason_code, e.trial_id]), [['codex', 0.1, 0.25, 'ramp_clean', 'q2/codex/' + read('q2', { kinds: ['override'] }).events[0].id]]);
  t('AC11 the ramp event names the ticket it was written for', ramps()[0].ticket, `R-${i}`);
  on = sixteenth.set.includes('codex') ? 1 : 0;
  const stepAt = i;
  while (on < 15 && i < 4000) if (admitOne().set.includes('codex')) on++;
  t('AC2 at 25%, 15 more carriers take far fewer tickets', i - stepAt < before, true);
  admitOne();
  t('AC2 after 15 more clean tickets the share is 50%', ramps().map((e) => [e.from, e.to]), [[0.1, 0.25], [0.25, 0.5]]);
  const later = Array.from({ length: 400 }, admitOne);
  const half = later.filter((p) => p.set.includes('codex')).length / later.length;
  t(`AC2 at 50%, about half carry it (${half})`, half > 0.4 && half < 0.6, true);
  t('AC2 the share stops at the ramp\'s last step', ramps().length, 2);

  // AC3: a hard trip in its first 15 tickets: no step.
  byHand('q3', 'codex', 'trial', daysAgo(1));
  const r3 = seededRandom(3);
  let n3 = 0;
  let k3 = 0;
  while (n3 < 3) if (assignPin(`T-${++k3}`, { slug: 'q3', size: 'S', random: r3, now: NOW, inFlight: [], values: LOCAL }).pin.set.includes('codex')) n3++;
  append('q3', { kind: 'trip', lever: 'codex', from: 'trial', to: 'reverted', actor: 'trip', reason_code: 'post_merge_revert', reason: 'reverted', ticket: `T-${k3}`, evidence_file: '/x/post-merge.jsonl', evidence_line: 1, trip: 'post-merge-revert', at: NOW.toISOString() });
  const after = Array.from({ length: 300 }, (_, j) => assignPin(`T2-${j}`, { slug: 'q3', size: 'S', random: r3, now: NOW, inFlight: [], values: LOCAL }).pin);
  t('AC3 a trip in its first 15 tickets: no ramp event', read('q3', { kinds: ['ramp'] }).events.length, 0);
  t('AC3 and the tripped lever reaches no more tickets', after.every((p) => !p.set.includes('codex') && p.arms.codex == null), true);
  const { exposureOf } = await import('../desk/bin/levers-auto.mjs');
  const trial = { key: 'codex', id: 'x/codex/1', levers: ['codex'] };
  const ev = [...Array.from({ length: 16 }, () => ({ kind: 'assign', arms: { codex: 'on' }, trial_ids: { codex: 'x/codex/1' } })), { kind: 'trip', lever: 'codex' }];
  t('AC3 exposure: 16 carriers but a trip since the first, so it is held', [exposureOf(ev, trial, REGISTRY.codex.ramp).carried, exposureOf(ev, trial, REGISTRY.codex.ramp).tripped], [16, true]);

  // AC4: 30% of the repo's tickets in flight already carry an unproven one.
  byHand('q4', 'codex', 'trial', daysAgo(1));
  const flight = (carrying) => Array.from({ length: 10 }, (_, j) => ({ set: [], arms: j < carrying ? { codex: 'on' } : { codex: 'off' }, at: NOW.toISOString() }));
  const full = admitQ('q4', 100, { inFlight: flight(3), prefix: 'F' });
  t('AC4 at 30% in flight, a ticket carries no quality-risk lever', full.every((p) => quality(p).length === 0), true);
  t('AC4 and is the off arm', full.every((p) => p.arms.codex === 'off'), true);
  byHand('q4b', 'codex', 'trial', daysAgo(1));
  const room = admitQ('q4b', 100, { inFlight: flight(2), prefix: 'H' });
  t('AC4 below 30% in flight, some tickets carry it', room.some((p) => p.set.includes('codex')), true);
  const { inFlightPins } = await import('../desk/bin/levers-auto.mjs');
  t('AC4 a repo with no batch has none in flight', inFlightPins('q4-none'), []);

  // AC5: effort is never trialled where Worker location is not local.
  byHand('q5', 'effort', 'trial', daysAgo(1));
  const cloud = admitQ('q5', 150, { values: { 'worker-location': 'cloud' }, prefix: 'C' });
  t('AC5 Worker location cloud: no ticket on an effort trial', cloud.every((p) => !p.set.includes('effort') && p.arms.effort == null), true);
  const local = admitQ('q5', 150, { prefix: 'L' });
  t('AC5 Worker location local: effort is drawn', local.some((p) => p.set.includes('effort')) && local.every((p) => ['on', 'off'].includes(p.arms.effort)), true);

  // AC9: two kept alone, past their holdbacks: the next tickets are drawn into a trial of the pair.
  byHand('q9', 'codex', 'adopted', daysAgo(60));
  byHand('q9', 'review-reuse', 'settled', daysAgo(40));
  const PAIR = 'codex+review-reuse';
  const p9 = admitQ('q9', 200, { prefix: 'P' });
  t('AC9 every ticket is on an arm of the pair trial', p9.every((p) => ['on', 'off'].includes(p.arms[PAIR])), true);
  t('AC9 the pair trial id names both kept states', /^q9\/codex\+review-reuse\/.+\+.+$/.test(p9[0].trial_ids[PAIR]), true);
  t('AC9 the on arm carries both', p9.filter((p) => p.arms[PAIR] === 'on').every((p) => quality(p).join() === 'codex,review-reuse'), true);
  t('AC9 the off arm carries the kept set alone: one of the two', p9.filter((p) => p.arms[PAIR] === 'off').every((p) => quality(p).length === 1), true);
  t('AC9 both arms are drawn', ['on', 'off'].every((a) => p9.some((p) => p.arms[PAIR] === a)), true);
  append('q9', { kind: 'pair', levers: ['codex', 'review-reuse'], from: 'trial', to: 'adopted', actor: 'levers-auto', reason_code: 'adopt_all_conditions', reason: 'pair adopted', trial_id: p9[0].trial_ids[PAIR], at: NOW.toISOString() });
  const proven = admitQ('q9', 20, { prefix: 'PP' });
  t('AC10 once the pair is adopted, every ticket carries both, with no arm', proven.every((p) => quality(p).join() === 'codex,review-reuse' && p.arms[PAIR] == null), true);
  byHand('q9h', 'codex', 'adopted', daysAgo(60));
  byHand('q9h', 'review-reuse', 'adopted', daysAgo(3));
  const held = admitQ('q9h', 100, { prefix: 'HB' });
  t('AC9 no pair trial while one of them is in its holdback, and still one lever per ticket', held.every((p) => p.arms[PAIR] == null && quality(p).length <= 1), true);

  // Frozen: kept levers only, still one quality-risk lever per ticket.
  const frozen = Array.from({ length: 20 }, (_, j) => assignPin(`Z-${j}`, { slug: 'q9', size: 'S', random: seededRandom(j), now: NOW, frozen: { at: NOW.toISOString() }, inFlight: [], values: LOCAL }).pin);
  t('frozen: no quality-risk arm', frozen.every((p) => !Object.keys(p.arms).length), true);
}

// ---- AC9: a lever log that cannot be read ------------------------------------------------------
{
  append('ac9', { kind: 'override', lever: 'memory', to: 'reverted', actor: 'ben', reason_code: 'ben_override', reason: 'off', at: daysAgo(2) });
  appendFileSync(logFile('ac9'), '{ torn\n');
  const a = assignPin('B-1', { slug: 'ac9', size: 'S', states: AUTO_PIN_STATES, random: seededRandom(9), now: NOW });
  const b = assignPin('B-2', { slug: 'ac9', size: 'S', states: AUTO_PIN_STATES, random: seededRandom(9), now: NOW });
  t('AC9 the pin is the row\'s named levers alone', [a.pin, a.assigned], [{ set: ['preflight'], at: NOW.toISOString() }, false]);
  t('AC9 it says why', /ac9 cannot be assigned trial arms \(line 2 of its lever log does not parse\)/.test(a.warning), true);
  const items = read('ac9', { kinds: ['needs_you'] }).events;
  t('AC9 one needs-you item, however many tickets are admitted', [items.length, b.pin.set], [1, ['preflight']]);
  t('AC9 the item says the repo cannot be assigned', [items[0].reason_code, /^ac9 cannot be assigned trial arms/.test(items[0].reason)], ['state_unreadable', true]);
  t('AC9 no assign event is written', read('ac9', { kinds: ['assign'] }).events.length, 0);
  mkdirSync(logFile('ac9-dir'), { recursive: true });
  const c = assignPin('D-1', { slug: 'ac9-dir', size: 'S', random: seededRandom(9), now: NOW });
  t('AC9 a log that cannot be opened: the row\'s set, saying so', [c.pin.set, c.assigned, /ac9-dir cannot be assigned/.test(c.warning)], [[], false, true]);
  // The needs-you item for a log that cannot be read as far as the assignment's own item is the levers
  // view's (tests/test_levers_view.mjs, "unassignable").
}

// ---- AC10 and admission: queue.mjs and the CLI -------------------------------------------------
{
  const QUEUE = join(T, 'queue.json');
  const STATE = join(T, 'state');
  spawnSync('git', ['-C', join(T, 'repo'), 'init', '-q', '-b', 'main']);
  const env = { ...process.env, DESK_QUEUE: QUEUE, DESK_STATE: STATE, DESK_AUTOPILOT_STATE: STATE };
  const node = (args, extra = {}) => spawnSync('node', args, { cwd: join(T, 'repo'), env: { ...env, ...extra }, encoding: 'utf8' });
  const queue = () => JSON.parse(readFileSync(QUEUE, 'utf8'));
  writeFileSync(QUEUE, JSON.stringify({ version: 1, batch: 'b', concurrency: 1, tickets: {} }));
  mkdirSync(join(STATE, 'triage'), { recursive: true });
  writeFileSync(join(STATE, 'triage', 'Q-1.json'), JSON.stringify({ ticket: 'Q-1', type: 'Story', lane: 'A', size: 'S', files_in_scope: ['src/q1.js'], unknowns: [], blockers: [] }));
  let r = node([join(BIN, 'queue.mjs'), 'admit', 'Q-1', '--by', 'intake']);
  t('admit in an auto repo succeeds', r.status, 0);
  const pin = queue().tickets['Q-1']?.levers;
  t('admit pins the ticket with its trial arms', Object.keys(pin?.arms ?? {}).sort(), [...TRIAL].sort());
  t('admit: the block is the repo\'s, by triage size', pin?.block, 'acme__widgets/S/1');
  const logged = read('acme__widgets', { kinds: ['assign'] }).events;
  t('admit writes the assign event', logged.map((e) => [e.ticket, e.block]), [['Q-1', 'acme__widgets/S/1']]);
  r = node([join(BIN, 'queue.mjs'), 'add', 'Q-2', 'Story', 'A']);
  t('add pins a ticket with no triage size in a block of its own', queue().tickets['Q-2']?.levers?.block, 'acme__widgets/unsized/Q-2');
  r = node([join(BIN, 'levers-auto.mjs'), 'assign', 'Q-1']);
  t('AC10 assign on a pinned ticket leaves its pin unchanged', [r.status, JSON.stringify(queue().tickets['Q-1'].levers) === JSON.stringify(pin), /already pinned; unchanged/.test(r.stdout)], [0, true, true]);
  t('AC10 and writes no second assign event', read('acme__widgets', { kinds: ['assign'] }).events.filter((e) => e.ticket === 'Q-1').length, 1);
  const q = queue();
  q.tickets['Q-3'] = { key: 'Q-3', state: 'queued' };
  writeFileSync(QUEUE, JSON.stringify(q));
  r = node([join(BIN, 'levers-auto.mjs'), 'assign', 'Q-3']);
  t('assign pins a queued ticket that has none', [r.status, Object.keys(queue().tickets['Q-3']?.levers?.arms ?? {}).length], [0, TRIAL.length]);
  r = node([join(BIN, 'levers-auto.mjs'), 'assign', 'Q-9']);
  t('assign on a ticket not in the queue fails, naming it', [r.status, /no such ticket in the queue: Q-9/.test(r.stderr)], [1, true]);
  r = node([join(BIN, 'queue.mjs'), 'add', 'Q-4', 'Story', 'A'], { DESK_CONFIG: ROW });
  t('add in a repo with no auto pins the row', queue().tickets['Q-4']?.levers?.set, ['preflight']);
}

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
