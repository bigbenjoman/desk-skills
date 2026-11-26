// suite: loop tick (a session's /loop that lost its next tick: blocked at turn end, re-armed, reported)
// layer: L2
// covers: desk/bin/loop-tick.mjs
// One repo whose batch a session runs, its queue and heartbeat under a throwaway HOME, DESK_HOME and
// DESK_CONFIG_ROOT. hooks/desk-handoff.py is fed Stop and PostToolUse inputs as Claude Code sends them;
// needs-you's stalled item is read in this process. Nothing touches your real ~/.claude or state.
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'hooks', 'desk-handoff.py');
const T = scratch('desk-loop-tick-');
const env = { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_PLATFORM: 'win32', DESK_LOCK_DIR: join(T, 'locks') };
for (const k of Object.keys(process.env)) if (k.startsWith('DESK_') || k.startsWith('AUTOPILOT_') || k.startsWith('CLAUDE_')) delete process.env[k];
Object.assign(process.env, env);
mkdirSync(env.DESK_LOCK_DIR, { recursive: true });
mkdirSync(env.DESK_HOME, { recursive: true });
symlinkSync(join(ROOT, 'desk', 'bin'), join(env.DESK_HOME, 'bin'));
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

const SLUG = 'acme__loop';
const REPO = join(T, 'repos', 'loop');
mkdirSync(REPO, { recursive: true });
spawnSync('git', ['init', '-q', REPO]);
spawnSync('git', ['-C', REPO, 'remote', 'add', 'origin', 'https://github.com/acme/loop.git']);
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', SLUG), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', SLUG, 'config.md'),
  `## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${REPO}\` |\n\n` +
  '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `4420` |\n' +
  '| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n| Batches run by | `supervisor` | `session` |\n');
const QUEUE = join(env.DESK_HOME, 'repos', SLUG, 'queue.json');
const STATE = join(env.HOME, '.desk-autopilot', SLUG);
mkdirSync(dirname(QUEUE), { recursive: true });
mkdirSync(join(STATE, 'orchestrators'), { recursive: true });
const NOW = Date.now();
const iso = (m) => new Date(NOW + m * 60000).toISOString();
const queue = (tickets) => writeFileSync(QUEUE, JSON.stringify({ version: 1, batch: 'loop-batch', concurrency: 2, supervised: false,
  tickets: Object.fromEntries(Object.entries(tickets).map(([k, v]) => [k, { key: k, added_at: iso(-600), ...v }])) }));
// beat(<last pass, minutes from now>, <next pass, minutes from now, or null>, <session>, <loop session>),
// in the file pass.mjs and queue.mjs next-pass write
const BEAT = join(STATE, 'orchestrators', `${QUEUE.replace(/[^A-Za-z0-9]/g, '-')}.json`);
const beat = (pass, next, session = 's1', loop = null) => writeFileSync(BEAT,
  JSON.stringify({ queue: QUEUE, batch: 'loop-batch', pid: 1, at: iso(pass), pass: iso(pass), ...(next == null ? {} : { next: iso(next) }), session, ...(loop ? { loop } : {}) }));
queue({ 'L-1': { state: 'triaged', lane: 'A' } });

let out = '';
const hook = (event, session = 's1', extra = {}) => {
  const r = spawnSync('python3', [HOOK], { encoding: 'utf8', env: { ...process.env, DESK_HANDOFF_PID: session },
    input: JSON.stringify({ hook_event_name: event, session_id: session, transcript_path: join(T, 'none.jsonl'), cwd: REPO, ...extra }) });
  out = r.stdout.trim();
  try { return JSON.parse(out); } catch { return null; }
};
const reason = (o) => o?.decision === 'block' ? o.reason : '';
const ctx = (o) => o?.hookSpecificOutput?.additionalContext ?? '';
const tick = () => (existsSync(join(STATE, 'loop-tick.json')) ? JSON.parse(readFileSync(join(STATE, 'loop-tick.json'), 'utf8')) : null);

// ---- AC1: a pass that ended with no next tick scheduled, whatever ended it, cannot end the turn quietly
beat(-2, null);
let o = hook('Stop');
t('AC1 a turn ending with no next pass recorded is blocked', /no next pass is scheduled/.test(reason(o)) && /queue\.mjs next-pass \+<seconds>/.test(reason(o)), true);
t('AC1 the block says to schedule it whatever the pass printed or however it ended', /whatever the last pass printed or however it ended/.test(reason(o)), true);
hook('Stop');
t('AC1 once per pass: a second turn end is not blocked', out, '');
hook('Stop', 's2');
t('AC1 another session, which does not run the batch, is never blocked', out, '');
beat(-1, 20);
hook('Stop');
t('AC1 with the next pass recorded still to come, nothing blocks', out, '');
queue({ 'L-1': { state: 'parked', lane: 'A', park: { question: 'Which one?', since: iso(-5) } } });
beat(-3, null);
hook('Stop');
t('AC1 a batch with nothing a pass could move is never blocked: its loop may stop', out, '');
queue({ 'L-1': { state: 'triaged', lane: 'A' } });
o = hook('Stop');
t('AC1 that pass is checked again once its queue has work a pass could move', /no next pass is scheduled/.test(reason(o)), true);
beat(-2.5, null);
o = hook('Stop', 's1', { stop_hook_active: true });
t('AC1 a turn end another block (the handoff\'s) already held is still blocked, once', /no next pass is scheduled/.test(reason(o)), true);
hook('Stop', 's1', { stop_hook_active: true });
t('AC1 and its follow-up turn end is not blocked again', out, '');

// A pass run by hand: another session's pass keeps the loop's session, so only the loop's is held to it
beat(-1.5, null, 's2', 's1');
hook('Stop', 's2');
t('AC1 a pass run by hand in another session does not hold that session to the loop', out, '');
o = hook('Stop');
t('AC1 the session whose loop it is is held to it', /no next pass is scheduled/.test(reason(o)), true);
const B = await import('../desk/bin/borrow.mjs');
const carried = (prev, opts) => B.loopCarried(prev, { now: NOW, ...opts });
t('a pass with --next is the loop\'s: its session is the loop\'s', carried({ next: NOW + 60e3, loop: 's1' }, { next: NOW + 120e3, session: 's2' }), 's2');
t('a pass run by hand keeps the loop\'s session while its next pass is to come', carried({ next: NOW + 60e3, loop: 's1' }, { session: 's2' }), 's1');
t('and after another such pass, which recorded no next pass', carried({ next: null, loop: 's1' }, { session: 's2' }), 's1');
t('with the loop\'s next pass gone by, the session it ran in schedules the next', carried({ next: NOW - 60e3, loop: 's1' }, { session: 's2' }), null);
t('a beat that names no loop session gives the session it ran in', carried({ next: NOW + 60e3, loop: null, session: 's1' }, { session: 's2' }), 's1');
t('with the tick a pass run by hand carried gone by, the loop is lost', carried({ next: null, tick: NOW - 60e3, loop: 's1' }, { session: 's2' }), null);

// ---- #1420: a pass run by hand records the loop's tick still to come, so it never reads as a stall
const ticked = (prev, opts) => B.loopTick(prev, { now: NOW, ...opts });
t('a pass run by hand carries the loop\'s next pass still to come as its tick', ticked({ next: NOW + 60e3 }), NOW + 60e3);
t('and a second such pass carries it on', ticked({ next: null, tick: NOW + 60e3 }), NOW + 60e3);
t('a tick gone by is not carried', ticked({ next: NOW - 60e3 }), null);
t('a pass given its next time (the loop\'s own) carries none', ticked({ next: NOW + 60e3 }, { next: NOW + 120e3 }), null);
t('stoppedAt reads the carried tick: live until PASS_GRACE_MS after it', B.stoppedAt({ at: NOW, next: null, tick: NOW + 28 * 60e3 }), NOW + 28 * 60e3 + B.PASS_GRACE_MS);
const handBeat = (pass, tickAt) => writeFileSync(BEAT,
  JSON.stringify({ queue: QUEUE, batch: 'loop-batch', pid: 1, at: iso(pass), pass: iso(pass), tick: iso(tickAt), session: 's2', loop: 's1' }));
handBeat(-16, 12); // the comment's case: a pass by hand at 14:32, the loop's tick at 15:00, read at 14:48
t('a beat a pass run by hand wrote reads its tick', B.lastBeat(STATE, QUEUE)?.tick, Date.parse(iso(12)));
hook('Stop');
t('the loop\'s session is not held to a tick it already has', out, '');
hook('PostToolUse');
t('nor told its loop is lost', out, '');
const NY = await import('../desk/bin/needs-you.mjs');
t('needs-you shows no stalled item 16 minutes after the pass run by hand, with the loop\'s tick to come', NY.collect({ word: 'loop' }).items.some((i) => i.kind === 'stalled'), false);
handBeat(-41, -25);
o = hook('PostToolUse');
t('with that tick gone by twice over, the loop reads lost', /loop lost its next tick/.test(ctx(o)), true);
t('and needs-you\'s stalled item names when it was due', /and the next was due at /.test(NY.collect({ word: 'loop' }).items.find((i) => i.kind === 'stalled')?.need ?? ''), true);
writeFileSync(join(STATE, 'loop-tick.json'), 'null'); // the AC2 checks below start untold

// ---- AC2: twice the interval with no pass, the session's next turn re-arms the loop and logs it
beat(-15, -5);
hook('PostToolUse');
t('AC2 under twice the interval (15 of 20 minutes): nothing injected', out, '');
beat(-36, -11);
o = hook('PostToolUse');
t('AC2 under twice a 25-minute interval but read stalled by needs-you: told already', /loop lost its next tick/.test(ctx(o)), true);
beat(-40, -25);
o = hook('PostToolUse');
t('AC2 past twice the interval: the turn is told the loop lost its next tick', /loop lost its next tick: no pass has run since \d\d:\d\d UTC, and none is scheduled/.test(ctx(o)), true);
t('AC2 and to re-arm it now: a pass, the next tick, and its record', /Re-arm it now, before you carry on: run a pass \(node ~\/\.claude\/desk\/bin\/pass\.mjs --json\)/.test(ctx(o)) && /queue\.mjs next-pass \+<seconds>/.test(ctx(o)), true);
t('AC2 being told is logged for that pass and session, the re-arm not yet', `${tick()?.pass} ${tick()?.session} ${!!tick()?.told_at} ${!!tick()?.rearmed_at}`, `${iso(-40)} s1 true false`);
hook('UserPromptSubmit');
t('AC2 once per pass', out, '');
hook('PostToolUse', 's2');
t('AC2 only the session that runs the batch is told', out, '');

// ---- AC3: needs-you's stalled item says the loop lost its next tick, and what the session did
const N = await import('../desk/bin/needs-you.mjs');
const need = () => N.collect({ word: 'loop' }).items.find((i) => i.kind === 'stalled')?.need ?? '';
t('AC3 told, not yet re-armed: the item says so', /The loop lost its next tick, and the session could not re-arm it yet: it was told to at \d{4}-\d\d-\d\d \d\d:\d\d UTC and has not recorded a next pass since: resume the session, or run \/desk-autopilot in loop$/.test(need()), true);
const run = (script, ...a) => spawnSync(process.execPath, [join(ROOT, 'desk', 'bin', script), ...a], { cwd: REPO, encoding: 'utf8', env: { ...process.env, DESK_REPO_DIR: REPO, CLAUDE_CODE_SESSION_ID: 's1' } });
beat(-30, null); // the pass the session ran to re-arm it
let r = run('queue.mjs', 'next-pass', '+600');
t('AC2 recording the next pass after it logs the re-arm, against that pass', `${r.status} ${/re-armed/.test(r.stdout)} ${!!tick()?.rearmed_at} ${tick()?.pass}`, `0 true true ${iso(-30)}`);
t('AC2 and names the session as the loop\'s', JSON.parse(readFileSync(BEAT, 'utf8')).loop, 's1');
t('AC3 re-armed, so not stalled: no item', need(), '');
beat(-30, -15);
t('AC3 re-armed, then lost again with no pass since: the item says so', /The loop lost its next tick, and the session re-armed it at \d{4}-\d\d-\d\d \d\d:\d\d UTC, but no pass has run since: /.test(need()), true);
r = run('loop-tick.mjs', 'could-not', 'the', 'session', 'is', 'mid-build');
t('AC3 could-not records why', `${r.status} ${tick()?.why}`, '0 the session is mid-build');
t('AC3 could not: the item says why', /The loop lost its next tick, and the session could not re-arm it: the session is mid-build: /.test(need()), true);
beat(-50, -35);
t('AC3 no turn since it was due: the item says it could not, and why', /the session could not re-arm it: it has taken no turn since \d{4}-\d\d-\d\d \d\d:\d\d UTC, when it was due to: /.test(need()), true);

// ---- AC2 with a short interval: a next pass recorded after a turn's check sets when it is lost
beat(-8, null);
hook('PostToolUse');
t('AC2 a pass with no next pass recorded yet, under the default 15 minutes: nothing injected', out, '');
beat(-8, -5); // next-pass recorded a 3-minute interval after that check, and it has gone by
o = hook('PostToolUse');
t('AC2 the cached check is dropped: lost at twice the 3-minute interval, not 15 minutes after the pass', /loop lost its next tick/.test(ctx(o)), true);

process.exit(fails ? 1 : 0);
