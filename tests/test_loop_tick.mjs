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
// beat(<last pass, minutes from now>, <next pass, minutes from now, or null>, <session>)
const beat = (pass, next, session = 's1') => writeFileSync(join(STATE, 'orchestrators', 'q.json'),
  JSON.stringify({ queue: QUEUE, batch: 'loop-batch', pid: 1, at: iso(pass), pass: iso(pass), ...(next == null ? {} : { next: iso(next) }), session }));
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

// ---- AC2: twice the interval with no pass, the session's next turn re-arms the loop and logs it
beat(-15, -5);
hook('PostToolUse');
t('AC2 under twice the interval (15 of 20 minutes): nothing injected', out, '');
beat(-40, -25);
o = hook('PostToolUse');
t('AC2 past twice the interval: the turn is told the loop lost its next tick', /loop lost its next tick: no pass has run since \d\d:\d\d UTC, twice its 15-minute interval/.test(ctx(o)), true);
t('AC2 and to re-arm it: a pass, the next tick, and its record', /re-arm it: run a pass \(node ~\/\.claude\/desk\/bin\/pass\.mjs --json\)/.test(ctx(o)) && /queue\.mjs next-pass \+<seconds>/.test(ctx(o)), true);
t('AC2 the re-arm is logged for that pass and session', `${tick()?.pass} ${tick()?.session} ${!!tick()?.rearmed_at}`, `${iso(-40)} s1 true`);
hook('UserPromptSubmit');
t('AC2 once per pass', out, '');
hook('PostToolUse', 's2');
t('AC2 only the session that runs the batch is told', out, '');

// ---- AC3: needs-you's stalled item says the loop lost its next tick, and what the session did
const N = await import('../desk/bin/needs-you.mjs');
const need = () => N.collect({ word: 'loop' }).items.find((i) => i.kind === 'stalled')?.need ?? '';
t('AC3 re-armed: the item says so', /The loop lost its next tick, and the session re-armed it at \d{4}-\d\d-\d\d \d\d:\d\d UTC, but no pass has run since: resume the session, or run \/desk-autopilot in loop$/.test(need()), true);
const r = spawnSync(process.execPath, [join(ROOT, 'desk', 'bin', 'loop-tick.mjs'), 'could-not', 'the', 'session', 'is', 'mid-build'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, DESK_REPO_DIR: REPO } });
t('AC3 could-not records why', `${r.status} ${tick()?.why}`, '0 the session is mid-build');
t('AC3 could not: the item says why', /The loop lost its next tick, and the session could not re-arm it: the session is mid-build: /.test(need()), true);
beat(-50, -35);
t('AC3 no turn since it was due: the item says it could not, and why', /the session could not re-arm it: it has taken no turn since \d{4}-\d\d-\d\d \d\d:\d\d UTC, when it was due to: /.test(need()), true);
beat(-60, -25);
t('AC3 not yet due: the item says when the session re-arms it', /the session re-arms it by itself on its first turn after \d{4}-\d\d-\d\d \d\d:\d\d UTC: /.test(need()), true);

process.exit(fails ? 1 : 0);
