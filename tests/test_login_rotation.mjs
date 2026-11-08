// suite: login rotation (a new session starts on the login with the most room; a resume stays on its own)
// login-choice.mjs with a fixed clock, then the real pass.mjs against a fake claude whose sign-in answers
// per config folder, a stub spawn-worker.sh that records the login each call was given, and each login's
// reading in its own probe log. A throwaway HOME: nothing reads this computer's logins.
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-login-rotation-'));
const H = join(T, 'home');
const dirOf = (name) => join(H, '.claude-logins', name);
for (const k of ['CLAUDE_CONFIG_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH',
  'DESK_BATCH', 'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'CLAUDE_CODE_SESSION_ID', 'AUTOPILOT_DRY_RUN', 'AUTOPILOT_RERUN', 'AUTOPILOT_BATCH_BUDGET_USD', 'AUTOPILOT_START_STAGE', 'AUTOPILOT_TASK']) delete process.env[k];
Object.assign(process.env, { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'), DESK_LOCK_DIR: join(T, 'locks'),
  DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_USAGE_DIR: join(T, 'usage') });
mkdirSync(process.env.DESK_LOCK_DIR);
const { chooseLogin, loginRoom } = await import(join(BIN, 'login-choice.mjs'));

// ---- the choice ----------------------------------------------------------------------------------
const NOW = 1_800_000_000_000;
const win = (pct) => ({ utilization: pct / 100, resetsAt: NOW / 1000 + 3600 });
const reading = (five, week) => ({ five_hour: five == null ? null : win(five), seven_day: week == null ? null : win(week), at: NOW, none: [] });
const NONE = { five_hour: null, seven_day: null, at: null, none: [] };
const c = (name, rule, r = NONE, running = 0) => ({ login: { name, rule }, reading: r, running });
const pick = (...cs) => chooseLogin(cs, NOW)?.name ?? null;

t('room is the smaller of the two windows', loginRoom(reading(30, 60), NOW).room, 40);
t('a window past its reset leaves all its room', loginRoom({ ...reading(100, 20), five_hour: { utilization: 1, resetsAt: NOW / 1000 - 1 } }, NOW).room, 80);
t('a subscription with no 5-hour window is judged on its weekly', loginRoom({ ...reading(null, 20), none: ['five_hour'] }, NOW).room, 80);
t('no reading is no known room', loginRoom(NONE, NOW).room, null);
t('the higher room wins', pick(c('a', 'in rotation', reading(10, 70)), c('b', 'in rotation', reading(60, 40))), 'b');
t('the lower weekly use breaks a tie on room', pick(c('b', 'in rotation', reading(30, 50)), c('a', 'in rotation', reading(50, 40))), 'a');
t('then the fewest workers running there', pick(c('a', 'in rotation', reading(50, 40), 2), c('b', 'in rotation', reading(50, 40), 1)), 'b');
t('and with nothing else between them, the listing order', pick(c('a', 'in rotation'), c('b', 'in rotation')), 'a');
t('AC3 known room comes before unknown', pick(c('a', 'in rotation'), c('b', 'in rotation', reading(90, 90))), 'b');
t('a login with no reading comes before one at 100%', pick(c('a', 'in rotation', reading(100, 10)), c('b', 'in rotation')), 'b');
t('AC4 every login in rotation at 100%: standby', pick(c('a', 'in rotation', reading(100, 10)), c('b', 'in rotation', reading(5, 100)), c('s', 'standby', reading(10, 10))), 's');
t('a standby login with no reading can take it too', pick(c('a', 'in rotation', reading(100, 10)), c('s', 'standby')), 's');
t('standby waits while a login in rotation has any room', pick(c('a', 'in rotation', reading(99, 10)), c('s', 'standby', reading(0, 0))), 'a');
t('standby waits while a login in rotation has no reading yet', pick(c('a', 'in rotation', reading(100, 10)), c('b', 'in rotation'), c('s', 'standby', reading(0, 0))), 'b');
t('with only standby logins usable, one takes it', pick(c('s', 'standby', reading(10, 10))), 's');
t('every login out: one in rotation, so the preflight meets the limit', pick(c('s', 'standby', reading(100, 10)), c('a', 'in rotation', reading(100, 10))), 'a');
t('no login usable: none', pick(), null);

// ---- the real pass -------------------------------------------------------------------------------
const W = join(T, 'w');
const bin = join(process.env.DESK_HOME, 'bin');
const CALLS = join(T, 'spawns');
const SIGNED_OUT = join(T, 'signed-out');
mkdirSync(bin, { recursive: true });
mkdirSync(join(W, 'stub'), { recursive: true });
mkdirSync(join(W, 'wt'), { recursive: true });
mkdirSync(join(H, '.claude'), { recursive: true });
for (const f of ['queue.mjs', 'harvest.mjs', 'desk-env.mjs', 'batch-state.mjs', 'briefing.mjs']) symlinkSync(join(BIN, f), join(bin, f));
writeFileSync(join(bin, 'setup-worktree.sh'), 'mkdir -p "$WT_DIR/$2"; echo "[setup-worktree] worktree=$WT_DIR/$2"; echo "[setup-worktree] branch=$3"\n');
// A folder listed in LIMITED, as `<folder> <reset epoch seconds | none>`, is at its usage limit: its
// preflight is refused and its probe rejected.
const LIMITED = join(T, 'limited');
// One line per spawn (not preflight): ticket, whether it was given a task, and its start stage.
const STARTS = join(T, 'starts');
// One line per call: ticket, session or `preflight`, the login it was given, and whether it resumes.
writeFileSync(join(bin, 'spawn-worker.sh'), `printf '%s|%s|%s|%s\\n' "$1" "$3" "\${AUTOPILOT_LOGIN_DIR-unset}" "\${AUTOPILOT_RESUME:+resume}" >> "${CALLS}"
[ "$3" = preflight ] || printf '%s|%s|%s\\n' "$1" "\${AUTOPILOT_TASK:+task}" "\${AUTOPILOT_START_STAGE-}" >> "${STARTS}"
ld="\${AUTOPILOT_LOGIN_DIR:-${H}/.claude}"
if [ "$3" = preflight ]; then
  if grep -qF "$ld " "${LIMITED}" 2>/dev/null; then echo "[preflight] usage-limit: the account is at its usage limit"; else echo "[preflight] pass"; fi
else echo "[spawn] ticket=$1"; fi\n`);
// Sign-in per folder: a folder's name is its account, or its .account file's, and a signed-out folder
// answers loggedIn false. Every `auth` call is recorded.
const AUTHS = join(T, 'auths');
writeFileSync(join(W, 'stub', 'claude'), `#!/bin/sh
d="\${CLAUDE_CONFIG_DIR:-${H}/.claude}"
case "$1" in
  agents) echo '[]' ;;
  auth) echo "$d" >> "${AUTHS}"
    if grep -qx "$d" "${SIGNED_OUT}" 2>/dev/null; then echo '{"loggedIn":false}'; exit 1; fi
    a="$(cat "$d/.account" 2>/dev/null || basename "$d")"; printf '{"loggedIn":true,"email":"%s@example.com"}\\n' "$a" ;;
  -p) lim="$(grep -F "$d " "${LIMITED}" 2>/dev/null | head -n 1 | cut -d' ' -f2)"
    if [ "$lim" = none ]; then echo '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour"}}'; echo '{"type":"result","is_error":true}'; exit 1; fi
    if [ -n "$lim" ]; then printf '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":%s}}\\n' "$lim"; echo '{"type":"result","is_error":true}'; exit 1; fi
    echo '{"type":"result","is_error":false}' ;;
esac
`);
chmodSync(join(W, 'stub', 'claude'), 0o755);
writeFileSync(join(W, 'stub', 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const slug = 'acme__widgets';
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(W, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n  email = t@example.com\n  name = t\n');
spawnSync('git', ['init', '-q', '-b', 'main', join(W, 'repo')], { env: gitEnv });
spawnSync('git', ['-C', join(W, 'repo'), 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
const state = join(H, '.desk-autopilot', slug);
const config = join(process.env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md');
mkdirSync(dirname(config), { recursive: true });
writeFileSync(config, [
  '## 0. Repo', '| Field | Value |', '|---|---|', '| GitHub repo | `acme/widgets` |', '| Default branch | `main` |', '',
  '## 2. Paths', '| Field | Value |', '|---|---|', `| Primary repo root | \`${join(W, 'repo')}\` |`, `| Worktrees directory | \`${join(W, 'wt')}\` |`, '',
  '## 3. Permissions', '| Key | Capability | Recommended | Your setting |', '|---|---|---|---|', '| `autopilot-workers` | Run workers | `yes` | `yes` |', '',
  '## 3b. Cost and autonomy', '| Field | Recommended | Your setting |', '|---|---|---|', '| Autopilot worker concurrency | `3 / 3` | `3 / 3` |', '| Usage pacing headroom (points) | `5` | `off` |', '',
].join('\n'));
const QF = join(process.env.DESK_HOME, 'repos', slug, 'queue.json');
mkdirSync(dirname(QF), { recursive: true });
let floor = 47100;
const row = (k) => JSON.parse(readFileSync(QF, 'utf8')).tickets[k];
const calls = (k) => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter((l) => l.startsWith(`${k}|`)) : []);
const auths = () => (existsSync(AUTHS) ? readFileSync(AUTHS, 'utf8').trim().split('\n').filter(Boolean) : []);
const event = (five, week) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
  five_hour: { utilization: five / 100, resetsAt: Math.round(Date.now() / 1000) + 3600 }, seven_day: { utilization: week / 100, resetsAt: Math.round(Date.now() / 1000) + 86400 } } } });

// `logins` is [name, rule, five, week]: `default` is ~/.claude, any other a folder under ~/.claude-logins.
function world(logins, tickets) {
  for (const p of [state, process.env.DESK_USAGE_DIR, CALLS, STARTS, AUTHS, SIGNED_OUT, LIMITED, process.env.DESK_SUBSCRIPTIONS, join(H, '.claude-logins')]) rmSync(p, { recursive: true, force: true });
  mkdirSync(join(state, 'logs'), { recursive: true });
  mkdirSync(join(state, 'workers'), { recursive: true });
  mkdirSync(process.env.DESK_USAGE_DIR, { recursive: true });
  if (logins) {
    const rows = logins.map(([n, r]) => `| \`claude\` | \`${n}\` | \`${n === 'default' ? '~/.claude' : `~/.claude-logins/${n}`}\` | \`${r}\` |`);
    writeFileSync(process.env.DESK_SUBSCRIPTIONS, `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.join('\n')}\n`);
    for (const [n, , five, week] of logins) {
      if (n !== 'default') mkdirSync(dirOf(n), { recursive: true });
      if (five != null) writeFileSync(join(process.env.DESK_USAGE_DIR, n === 'default' ? 'probe.log' : `probe.${n}.log`), `${event(five, week)}\n`);
    }
  }
  writeFileSync(QF, JSON.stringify({ version: 1, batch: slug, tickets }));
  return { ...gitEnv, PATH: `${join(W, 'stub')}:${process.env.PATH}`, DESK_CONFIG: config, DESK_QUEUE: QF, DESK_AUTOPILOT_STATE: state, WT_DIR: join(W, 'wt'),
    AUTOPILOT_MIN_AVAIL_GB: '0', AUTOPILOT_HEALTH_CHECKS: 'off', AUTOPILOT_ORCHESTRATOR: 'test', AUTOPILOT_PORT_FLOOR: String(floor += 100) };
}
const pass = (env) => { const r = spawnSync('node', [join(BIN, 'pass.mjs')], { env, cwd: join(W, 'repo'), encoding: 'utf8' }); return `${r.stdout}${r.stderr}`; };
const NEW = (key) => ({ key, state: 'triaged', open_questions: 0, branch: `fix/${key}` });
const fresh = { 'Y-1': NEW('Y-1') };
const on = (k) => row(k).login?.name ?? null;
const signOut = (dir) => writeFileSync(SIGNED_OUT, `${dir}\n`);

// AC1, AC2: two in rotation, B with more room.
let env = world([['default', 'in rotation', 70, 20], ['b', 'in rotation', 10, 30]], fresh);
let out = pass(env);
t('AC1 the worker spawns on the login with the most room', on('Y-1'), 'b');
t('AC1 its row names the login and its folder', row('Y-1').login.config_dir, dirOf('b'));
t('AC1 spawn-worker.sh is given that folder', calls('Y-1').at(-1).split('|')[2], dirOf('b'));
t('AC2 the preflight runs on it too', calls('Y-1')[0], `Y-1|preflight|${dirOf('b')}|`);
t('AC1 the report names the login', /Y-1 port=.* login=b;/.test(out), true);

// The default login wins: the pass's own, so nothing needs changing.
env = world([['default', 'in rotation', 10, 20], ['b', 'in rotation', 70, 30]], fresh);
pass(env);
t('the default login is named on the row, with no folder', `${on('Y-1')} ${row('Y-1').login.config_dir}`, 'default null');
t('and a pass on it leaves the worker where it is', calls('Y-1').at(-1).split('|')[2], 'unset');
// The same choice from a pass running on another login: the worker is sent back to the default.
pass({ ...world([['default', 'in rotation', 10, 20], ['b', 'in rotation', 70, 30]], fresh), CLAUDE_CONFIG_DIR: dirOf('b') });
t('from a pass on login B, the default login is an empty folder', calls('Y-1').at(-1).split('|')[2], '');

// Two workers in one pass with nothing between the logins: one each.
env = world([['default', 'in rotation'], ['b', 'in rotation']], { 'Y-1': NEW('Y-1'), 'Y-2': NEW('Y-2') });
pass(env);
t('two workers with nothing between the logins go one to each', [on('Y-1'), on('Y-2')].sort().join(), 'b,default');

// AC3: one in rotation has no reading.
env = world([['default', 'in rotation'], ['b', 'in rotation', 90, 90]], fresh);
pass(env);
t('AC3 it spawns on the login whose room is known', on('Y-1'), 'b');

// AC4: every login in rotation at 100%.
env = world([['default', 'in rotation', 100, 40], ['a', 'in rotation', 20, 100], ['s', 'standby', 30, 30]], fresh);
out = pass(env);
t('AC4 it spawns on the standby login', on('Y-1'), 's');
t('AC4 the pass report says it used standby', /Y-1 port=.* login=s \(standby: no login in rotation can take it\)/.test(out), true);
// The same with the reading days old: nothing has probed an unattended login, and its window has not reset.
const aged = (days) => { const at = new Date(Date.now() - days * 86400000); utimesSync(join(process.env.DESK_USAGE_DIR, 'probe.log'), at, at); };
env = world([['default', 'in rotation', 10, 100], ['s', 'standby', 30, 30]], fresh);
aged(2);
out = pass(env);
t('AC4 a login at 100% on a two-day-old reading: standby', on('Y-1'), 's');
t('AC4 the report says so', /login=s \(standby: no login in rotation can take it\)/.test(out), true);
// An old reading whose window has reset leaves that login its room.
env = world([['default', 'in rotation'], ['s', 'standby', 30, 30]], fresh);
writeFileSync(join(process.env.DESK_USAGE_DIR, 'probe.log'), `${event(10, 100).replace(/("seven_day":\{"utilization":1,"resetsAt":)\d+/, `$1${Math.round(Date.now() / 1000) - 3600}`)}\n`);
aged(2);
pass(env);
t('an old reading past its reset leaves the login in rotation', on('Y-1'), 'default');
// Over a week old, both windows have reset since: it says nothing, so the login reads as no reading.
env = world([['default', 'in rotation', 10, 100], ['s', 'standby', 30, 30]], fresh);
aged(8);
pass(env);
t('a reading over a week old is no reading', on('Y-1'), 'default');

// AC5: a login whose rule is off, whatever its room.
env = world([['default', 'in rotation', 90, 90], ['c', 'in rotation', 80, 80], ['b', 'off', 0, 0]], fresh);
pass(env);
t('AC5 it never spawns on a login whose rule is off', on('Y-1'), 'c');
env = world([['default', 'in rotation', 90, 90], ['b', 'off', 0, 0]], fresh);
pass(env);
t('AC5 with the other login off, the one left spawns as today', `${row('Y-1').state} ${calls('Y-1').at(-1).split('|')[2]}`, 'running unset');

// AC6: signed out, and a second name for an account already listed.
env = world([['default', 'in rotation', 90, 90], ['b', 'in rotation', 0, 0]], fresh);
signOut(dirOf('b'));
pass(env);
t('AC6 it never spawns on a signed-out login', on('Y-1'), 'default');
env = world([['b', 'in rotation', 90, 90], ['c', 'in rotation', 0, 0]], fresh);
writeFileSync(join(dirOf('c'), '.account'), 'b');
pass(env);
t('AC6 it never spawns on a second name for an account', on('Y-1'), 'b');

// No login can take it: the ticket waits, and a resume does not.
env = world([['b', 'in rotation', 10, 10]], { 'Y-1': NEW('Y-1') });
signOut(dirOf('b'));
out = pass(env);
t('with no usable login nothing spawns', `${row('Y-1').state} ${calls('Y-1').length}`, 'triaged 0');
t('and the report names the login and its sign-in', out.includes(`no Claude login can take new work — b is signed out (CLAUDE_CONFIG_DIR=~/.claude-logins/b claude, then /login)`), true);

// AC7 to AC11: a worker recorded on login B. Its worktree is kept and its session gone.
const RESUMING = (resume, extra = {}) => ({ 'K-1': { key: 'K-1', state: 'triaged', resume, resume_why: 'test', open_questions: 0, session_id: 'sess-1', branch: 'fix/K-1',
  worktree: join(W, 'wt', 'K-1'), login: { name: 'b', config_dir: dirOf('b') }, ...extra } });
mkdirSync(join(W, 'wt', 'K-1'), { recursive: true });
const BOTH = [['default', 'in rotation', 10, 10], ['b', 'in rotation', 90, 90]];
for (const [ac, how] of [['AC7 killed', 'pending'], ['AC8 maintenance', 'maintenance'], ['AC9 usage limit', 'usage']]) {
  env = world(BOTH, RESUMING(how));
  out = pass(env);
  t(`${ac}: it resumes its own session on login B, the fuller one`, calls('K-1').at(-1), `K-1|sess-1|${dirOf('b')}|resume`);
  t(`${ac}: the preflight runs there too`, calls('K-1')[0], `K-1|preflight|${dirOf('b')}|`);
  t(`${ac}: the report names the login`, /K-1 resumed .* login=b;/.test(out), true);
}

// AC10: signed out since.
env = world(BOTH, RESUMING('pending'));
signOut(dirOf('b'));
out = pass(env);
t('AC10 no session starts', calls('K-1').length, 0);
t('AC10 the worker is parked', `${row('K-1').state} ${row('K-1').resume}`, 'parked null');
t('AC10 the reason names the login and its sign-in command', row('K-1').park.question.includes('its login b (~/.claude-logins/b) is signed out') && row('K-1').park.question.includes('CLAUDE_CONFIG_DIR=~/.claude-logins/b claude, then /login'), true);

// AC11: its rule is off now.
env = world([['default', 'in rotation', 10, 10], ['b', 'off', 90, 90]], RESUMING('pending'));
pass(env);
t('AC11 a login since turned off still resumes its worker', calls('K-1').at(-1), `K-1|sess-1|${dirOf('b')}|resume`);

// A row from before rows named a login resumes on what spawn-worker.sh recorded.
env = world(BOTH, RESUMING('pending', { login: undefined }));
writeFileSync(join(state, 'workers', 'K-1.login.json'), JSON.stringify({ login: 'b', config_dir: dirOf('b') }));
pass(env);
t('a row with no login resumes on the recorded one', calls('K-1').at(-1), `K-1|sess-1|${dirOf('b')}|resume`);

// A handoff is a new session, so it chooses again.
const HANDED = { 'H-1': { key: 'H-1', state: 'triaged', open_questions: 0, handoff: 'pending', handoff_stage: '4b', session_id: 'old', branch: 'fix/H-1', worktree: join(W, 'wt', 'H-1'), login: { name: 'default', config_dir: null } } };
spawnSync('git', ['init', '-q', '-b', 'fix/H-1', join(W, 'wt', 'H-1')], { env: gitEnv });
spawnSync('git', ['-C', join(W, 'wt', 'H-1'), 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
env = world(BOTH.map(([n, r, f, w]) => [n, r, 100 - f, 100 - w]), HANDED);
mkdirSync(join(state, 'handoffs'), { recursive: true });
writeFileSync(join(state, 'handoffs', 'H-1.json'), JSON.stringify({ ticket: 'H-1', stage: '4b', criteria: ['x'], lane: 'A', verification: [], review: [], evidence: [] }));
out = pass(env);
t('a session after a handoff starts on the login with the most room', `${row('H-1').state} ${on('H-1')}`, 'running b');

// AC12: one login. Nothing is checked, nothing is passed and the row and report say nothing.
for (const [what, logins] of [['no file', null], ['a file with one login', [['default', 'in rotation', 50, 50]]]]) {
  env = world(logins, fresh);
  out = pass(env);
  t(`AC12 ${what}: it spawns as today`, `${row('Y-1').state} ${calls('Y-1').at(-1).split('|')[2]} ${on('Y-1')}`, 'running unset null');
  t(`AC12 ${what}: no sign-in check`, auths().length, 0);
  t(`AC12 ${what}: the report names no login`, /login=/.test(out), false);
  env = world(logins, RESUMING('pending', { login: undefined }));
  pass(env);
  t(`AC12 ${what}: a resume is as today`, `${calls('K-1').at(-1)} ${auths().length}`, 'K-1|sess-1|unset|resume 0');
}

// Under a config folder of the person's own with no file: the worker inherits it.
env = { ...world(null, RESUMING('pending', { login: undefined })), CLAUDE_CONFIG_DIR: join(T, 'own') };
mkdirSync(join(T, 'own'), { recursive: true });
pass(env);
t('AC12 a pass under its own config folder resumes a worker with no record on it', calls('K-1').at(-1), 'K-1|sess-1|unset|resume');

// ---- a login at its usage limit is benched ------------------------------------------------------
const { resetText } = await import(join(BIN, 'usage-limit.mjs'));
const DEF = join(H, '.claude');
const RESET = Math.round(Date.now() / 1000) + 7200;
const atLimit = (dir, at = RESET) => appendFileSync(LIMITED, `${dir} ${at ?? 'none'}\n`);
const batchOf = () => JSON.parse(readFileSync(QF, 'utf8'));
const preset = (benched) => writeFileSync(QF, JSON.stringify({ ...batchOf(), benched }));
const benchRow = (name, at = RESET) => ({ login: name, config_dir: name === 'default' ? null : dirOf(name), type: 'five_hour', resets_at: at, since: '2026-11-07T00:00:00.000Z', by: 'X-1' });
const TWO = { 'Y-1': NEW('Y-1'), 'Y-2': NEW('Y-2') };

// AC1, AC2: the preflight on the roomier login is refused; that login is benched, and the next ticket
// spawns on the other in the same pass.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 60, 60]], TWO);
atLimit(DEF);
out = pass(env);
t('AC1 a preflight refused at the limit benches its login until the reset', JSON.stringify([Object.keys(batchOf().benched ?? {}), batchOf().benched?.default?.resets_at]), JSON.stringify([['default'], RESET]));
t('AC1 the report names the login and the time', out.includes(`Y-1: its preflight on login default was refused at the 5-hour usage limit until ${resetText(RESET)}`), true);
t('AC1 the refused ticket keeps its place', row('Y-1').state, 'triaged');
t('AC2 the next ticket spawns on the other login', `${row('Y-2').state} ${on('Y-2')}`, 'running b');
t('AC2 the batch is not held', batchOf().usage_hold ?? null, null);
// The next pass: the bench is kept, so the ticket goes to the other login.
out = pass(env);
t('AC2 a pass later the benched login is still benched', Object.keys(batchOf().benched ?? {}).join(), 'default');
t('AC2 and the refused ticket spawns on the other login', `${row('Y-1').state} ${on('Y-1')}`, 'running b');
t('AC2 with no preflight on the benched login', calls('Y-1').filter((l) => l.includes('|preflight|') && l.endsWith('|unset|')).length, 1);

// AC1 for a worker: one that ended at the limit on login B benches B. With the other login open, it
// carries on there as a fresh session (the section below).
const PAUSED = { key: 'K-2', state: 'running', open_questions: 0, session_id: 'sess-2', branch: 'fix/K-2', worktree: join(W, 'wt', 'K-2'), login: { name: 'b', config_dir: dirOf('b') } };
mkdirSync(join(W, 'wt', 'K-2'), { recursive: true });
const rejected = `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":${RESET}}}\n`;
env = world([['default', 'in rotation', 60, 60], ['b', 'in rotation', 10, 10]], { 'K-2': PAUSED, 'Y-1': NEW('Y-1') });
writeFileSync(join(state, 'logs', 'K-2.log'), rejected);
atLimit(dirOf('b'));
out = pass(env);
t('AC1 a worker at the limit benches its login', batchOf().benched?.b?.resets_at, RESET);
t('AC1 the report names the login and the time', out.includes(`login b benched on the 5-hour usage limit until ${resetText(RESET)}`), true);
t('AC2 new work spawns on the other login, though B has more room', `${row('Y-1').state} ${on('Y-1')}`, 'running default');
t('AC8 the stopped worker moves to the other login, preflight and session', `${row('K-2').state} ${row('K-2').login.name} ${calls('K-2').length}`, 'running default 2');
t('AC2 nothing holds the batch', batchOf().usage_hold ?? null, null);

// AC8: a killed worker of a benched login waits to resume there, and is not moved.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 90, 90]], RESUMING('pending'));
preset({ b: benchRow('b') });
atLimit(dirOf('b'));
out = pass(env);
t('AC8 a resume on a benched login waits', `${row('K-1').state} ${row('K-1').resume} ${calls('K-1').length}`, 'triaged pending 0');
t('AC8 and says it waits for its own login', out.includes('K-1 resumes on its own login b once that is back'), true);

// AC3: every login in rotation benched, one on standby.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 10, 10], ['s', 'standby', 50, 50]], fresh);
preset({ default: benchRow('default'), b: benchRow('b') });
atLimit(DEF); atLimit(dirOf('b'));
out = pass(env);
t('AC3 it spawns on the standby login', `${row('Y-1').state} ${on('Y-1')}`, 'running s');
t('AC3 and the batch is not held', batchOf().usage_hold ?? null, null);

// AC4: every login benched, standby too. The hold names each reset, earliest first, none last.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 10, 10], ['s', 'standby', 50, 50]], fresh);
preset({ s: benchRow('s', null), b: benchRow('b', RESET + 3600), default: benchRow('default') });
atLimit(DEF); atLimit(dirOf('b'), RESET + 3600); atLimit(dirOf('s'), null);
out = pass(env);
t('AC4 nothing spawns', `${row('Y-1').state} ${calls('Y-1').length}`, 'triaged 0');
t('AC4 the batch holds on the first login back', JSON.stringify([batchOf().usage_hold?.type, batchOf().usage_hold?.resets_at]), JSON.stringify(['five_hour', RESET]));
t('AC4 the report names each reset', out.includes(`every Claude login is benched (default: the 5-hour usage limit until ${resetText(RESET)}; b: the 5-hour usage limit until ${resetText(RESET + 3600)}; s: the 5-hour usage limit, no reset time)`), true);
// The last open login's preflight refused: the batch holds there and then.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 60, 60]], TWO);
preset({ b: benchRow('b') });
atLimit(DEF); atLimit(dirOf('b'));
out = pass(env);
t('AC4 the last login refused holds the batch', `${batchOf().usage_hold != null} ${Object.keys(batchOf().benched ?? {}).sort().join()} ${row('Y-2').state} ${calls('Y-2').length}`, 'true b,default triaged 0');
t('AC4 and the report says every login is benched', out.includes('Every login is now benched, so nothing else spawns until one is back'), true);
// A pass after the first reset lifts the hold.
preset({ ...batchOf().benched, default: benchRow('default', Math.round(Date.now() / 1000) - 60) });
rmSync(LIMITED);
atLimit(dirOf('b'));
out = pass(env);
t('AC5 a reset passed lifts the hold', batchOf().usage_hold ?? null, null);

// AC5: a bench whose reset has passed is cleared, and the login takes spawns again.
env = world([['default', 'in rotation', 90, 90], ['b', 'in rotation', 10, 10]], fresh);
preset({ b: benchRow('b', Math.round(Date.now() / 1000) - 60), default: benchRow('default') });
atLimit(DEF);
out = pass(env);
t('AC5 the login is unbenched', Object.keys(batchOf().benched ?? {}).join(), 'default');
t('AC5 the report says it is back', out.includes('login b is back: the 5-hour usage limit lifted (its reset at'), true);
t('AC5 and it takes the spawn', `${row('Y-1').state} ${on('Y-1')}`, 'running b');

// AC6: a probe that succeeds before the reset unbenches the login.
env = world([['default', 'in rotation', 90, 90], ['b', 'in rotation', 10, 10]], fresh);
preset({ b: benchRow('b'), default: benchRow('default') });
atLimit(DEF);
out = pass(env);
t('AC6 a probe that succeeds unbenches the login', Object.keys(batchOf().benched ?? {}).join(), 'default');
t('AC6 the report says a probe call lifted it', out.includes('login b is back: the 5-hour usage limit lifted (a probe call succeeded)'), true);
t('AC6 and it takes the spawn', `${row('Y-1').state} ${on('Y-1')}`, 'running b');

// AC7: a limit with no reset time stays benched until a probe on it succeeds, and no time is guessed.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 60, 60]], fresh);
atLimit(DEF, null);
out = pass(env);
t('AC7 benched with no reset time', JSON.stringify(batchOf().benched?.default?.resets_at), 'null');
t('AC7 and the report names none', out.includes('Y-1: its preflight on login default was refused at the 5-hour usage limit — not failed'), true);
out = pass(env);
t('AC7 still benched a pass later, with the probe still refused', Object.keys(batchOf().benched ?? {}).join(), 'default');
rmSync(LIMITED);
out = pass(env);
t('AC7 unbenched once a probe succeeds', batchOf().benched ?? null, null);

// AC9: one login only. The hold and its report are today's, and nothing is benched.
env = world([['default', 'in rotation', 50, 50]], TWO);
atLimit(DEF);
out = pass(env);
t('AC9 one login: the batch holds on the preflight', JSON.stringify([batchOf().usage_hold?.preflight, batchOf().usage_hold?.resets_at]), JSON.stringify(['Y-1', RESET]));
t('AC9 one login: nothing is benched', batchOf().benched ?? null, null);
t('AC9 one login: the report is today\'s', out.includes('Y-1: its preflight was refused at the 5-hour usage limit — not failed, and nothing else spawns until the limit lifts'), true);
t('AC9 one login: nothing else spawns', calls('Y-2').length, 0);
// One usable login: a second listed but signed out. Its hold and report are today's too.
env = world([['default', 'in rotation', 50, 50], ['b', 'in rotation', 10, 10]], TWO);
signOut(dirOf('b'));
atLimit(DEF);
out = pass(env);
t('AC9 one usable login: the batch holds on the preflight', JSON.stringify([batchOf().usage_hold?.preflight, batchOf().usage_hold?.resets_at, batchOf().benched ?? null]), JSON.stringify(['Y-1', RESET, null]));
t('AC9 one usable login: the report is today\'s', out.includes('Y-1: its preflight was refused at the 5-hour usage limit — not failed, and nothing else spawns until the limit lifts'), true);
out = pass(env);
t('AC9 one usable login: a pass later it still holds, with nothing spawned', `${batchOf().usage_hold?.preflight} ${calls('Y-1').filter((l) => !l.includes('|preflight|')).length} ${calls('Y-2').length}`, 'Y-1 0 0');
t('AC9 one usable login: and the hold reads as today\'s', out.includes(`the 5-hour usage limit until ${resetText(RESET)} holds every spawn and resume`), true);
// A worker paused at the limit of a login that can no longer take work holds nothing: new work goes to
// the one usable login, which has room.
env = world([['default', 'in rotation', 60, 60], ['b', 'in rotation', 10, 10]], { 'K-2': PAUSED, 'Y-1': NEW('Y-1') });
writeFileSync(join(state, 'logs', 'K-2.log'), rejected);
signOut(dirOf('b'));
atLimit(dirOf('b'));
out = pass(env);
t('a worker paused on a login signed out since holds nothing', `${row('Y-1').state} ${on('Y-1')} ${batchOf().usage_hold ?? null}`, 'running default null');
t('and it carries on on the usable login (DS-467)', `${row('K-2').state} ${row('K-2').login.name}`, 'running default');
// The one usable login refused next: the batch holds, and a pass later it still does, with no second
// preflight. The stopped worker moves first, so its preflight is the one refused.
env = world([['default', 'in rotation', 60, 60], ['b', 'in rotation', 10, 10]], { 'K-2': PAUSED, 'Y-1': NEW('Y-1') });
writeFileSync(join(state, 'logs', 'K-2.log'), rejected);
signOut(dirOf('b'));
atLimit(dirOf('b')); atLimit(DEF);
pass(env);
t('with the one usable login refused too, the batch holds', `${row('Y-1').state} ${batchOf().usage_hold?.preflight} ${row('K-2').state} ${row('K-2').login.name}`, 'triaged K-2 running b');
pass(env);
t('a pass later it still holds, with no second preflight', `${batchOf().usage_hold != null} ${calls('K-2').length} ${calls('Y-1').length}`, 'true 1 0');

// ---- a worker stopped at one login's limit carries on on another ---------------------------------
// K-3 ended its session at login B's limit, at a stage, in a git worktree on its branch.
const WT3 = join(W, 'wt', 'K-3');
const STOPPED = (extra = {}) => ({ 'K-3': { key: 'K-3', state: 'running', open_questions: 0, session_id: 'sess-3', branch: 'fix/K-3', worktree: WT3, stage: '4/9',
  login: { name: 'b', config_dir: dirOf('b') }, ...extra } });
const brief3 = () => readFileSync(join(state, 'briefings', 'K-3.md'), 'utf8');
const resumeFile3 = () => join(state, 'resume', 'K-3.json');
function stopped(logins, extra, { resume = true } = {}) {
  rmSync(WT3, { recursive: true, force: true });
  spawnSync('git', ['init', '-q', '-b', 'fix/K-3', WT3], { env: gitEnv });
  writeFileSync(join(WT3, 'a.txt'), 'one\n');
  spawnSync('git', ['-C', WT3, 'add', 'a.txt'], { env: gitEnv });
  spawnSync('git', ['-C', WT3, 'commit', '-q', '-m', 'K-3 first step'], { env: gitEnv });
  const e = world(logins, STOPPED(extra));
  writeFileSync(join(state, 'logs', 'K-3.log'), rejected);
  if (resume) { mkdirSync(join(state, 'resume'), { recursive: true }); writeFileSync(resumeFile3(), JSON.stringify({ ticket: 'K-3', branch: 'fix/K-3' })); }
  atLimit(dirOf('b'));
  return e;
}
const ROOM = [['default', 'in rotation', 60, 60], ['b', 'in rotation', 10, 10]];
const spawnOf3 = () => calls('K-3').filter((l) => !l.includes('|preflight|'));

// AC1: from a round with a resume file, onto the login with room.
env = stopped(ROOM, { resumes: 1 });
out = pass(env);
t('DS-467 AC1 a fresh session starts on the other login', `${row('K-3').state} ${on('K-3')} ${spawnOf3().length}`, 'running default 1');
t('DS-467 AC1 it is a new session, not a resume of the old one', /^K-3\|(?!sess-3)[^|]+\|unset\|$/.test(spawnOf3()[0]), true);
t('DS-467 AC1 it starts from the round it was in', String(row('K-3').stage), '4');
t('DS-467 AC1 its briefing says it moved logins and resumes there', brief3().includes('## Moved logins: this session resumes at Stage 4') && brief3().includes('stopped at the 5-hour usage limit on login b'), true);
t('DS-467 AC1 the pass report says it moved logins', /K-3 port=.* login=default resumed at Stage 4, where its stopped session was, moved logins from b, at the 5-hour usage limit/.test(out), true);
t('DS-467 AC1 its login stays benched', Object.keys(batchOf().benched ?? {}).join(), 'b');
t('DS-467 AC1 and the move is spent', row('K-3').login_move ?? null, null);
// AC2: the move spends no resume try.
t('DS-467 AC2 the move is not one of its resume tries', row('K-3').resumes, 1);

// AC3: no resume file, a stage before Stage 3, or no stage at all: Stage 0, saying why.
for (const [what, extra, opts, why] of [
  ['with no resume file', {}, { resume: false }, `it left no resume file (${resumeFile3()})`],
  ['stopped at Stage 2', { stage: '2/9' }, {}, 'it stopped at Stage 2, before Stage 3, the first a session resumes at'],
  ['before its first recorded stage', { stage: undefined }, {}, 'it stopped before it recorded a stage'],
]) {
  env = stopped(ROOM, extra, opts);
  out = pass(env);
  t(`DS-467 AC3 ${what}: it moves and starts at Stage 0`, `${row('K-3').state} ${on('K-3')} ${row('K-3').stage}`, 'running default 0/9');
  t(`DS-467 AC3 ${what}: its briefing says why`, brief3().includes(`AUTOPILOT_STAGE: 0/9 triage (not resumed after moving logins: ${why})`), true);
  t(`DS-467 AC3 ${what}: so does the report`, out.includes(`from Stage 0 (not resumed after moving logins: ${why})`), true);
}

// AC4: uncommitted changes stay in the worktree, and the briefing names them.
env = stopped(ROOM);
writeFileSync(join(WT3, 'a.txt'), 'one\ntwo\n');
writeFileSync(join(WT3, 'new.txt'), 'new\n');
out = pass(env);
t('DS-467 AC4 the worktree keeps the changes', `${readFileSync(join(WT3, 'a.txt'), 'utf8')}${readFileSync(join(WT3, 'new.txt'), 'utf8')}`, 'one\ntwo\nnew\n');
t('DS-467 AC4 the briefing says they are there', brief3().includes('### Uncommitted changes in your worktree') && brief3().includes('- ` M a.txt`') && brief3().includes('- `?? new.txt`'), true);
t('DS-467 AC4 the report says it kept them', out.includes('keeping 2 uncommitted change(s)'), true);
// Untracked files under .claude/ are setup-worktree.sh's, not the stopped session's work.
env = stopped(ROOM);
mkdirSync(join(WT3, '.claude', 'agents'), { recursive: true });
writeFileSync(join(WT3, '.claude', 'settings.local.json.desk-disabled'), '{}\n');
writeFileSync(join(WT3, 'new.txt'), 'new\n');
out = pass(env);
t('DS-467 AC4 setup\'s .claude files are not named as kept work', `${brief3().includes('.claude')} ${brief3().includes('- `?? new.txt`')} ${out.includes('keeping 1 uncommitted change(s)')}`, 'false true true');

// A fix try with uncommitted edits moves too, and starts its task again rather than at its stage.
env = stopped(ROOM, { fix: { kind: 'review', try: 1, of: 2, pr: 7, finished: false } });
writeFileSync(join(WT3, 'a.txt'), 'one\ntwo\n');
out = pass(env);
const starts3 = () => (existsSync(STARTS) ? readFileSync(STARTS, 'utf8').trim().split('\n').filter((l) => l.startsWith('K-3|')) : []);
t('DS-467 a fix try with uncommitted edits is not held as a busy worktree', `${row('K-3').state} ${on('K-3')} ${out.includes('WORKTREE IN USE')}`, 'running default false');
t('DS-467 a moved fix try is given its task, at no stage', starts3().join(), 'K-3|task|');
t('DS-467 and its briefing says it starts its task again, naming its changes', brief3().includes('## Moved logins: this session starts its task again') && brief3().includes('- ` M a.txt`'), true);

// AC5: every other usable login benched. It waits, then resumes its own session once B is back.
env = stopped(ROOM);
preset({ default: benchRow('default') });
atLimit(DEF);
out = pass(env);
t('DS-467 AC5 with every other login benched it waits on its own', `${row('K-3').state} ${on('K-3')} ${calls('K-3').length} ${row('K-3').login_move ?? null}`, 'running b 0 null');
t('DS-467 AC5 and is reported paused there', out.includes('K-3 on the 5-hour usage limit until'), true);
rmSync(LIMITED);
atLimit(DEF);
preset({ ...batchOf().benched, b: benchRow('b', Math.round(Date.now() / 1000) - 60) });
writeFileSync(join(state, 'logs', 'K-3.log'), rejected.replace(String(RESET), String(Math.round(Date.now() / 1000) - 60)));
out = pass(env);
t('DS-467 AC5 once B is back it resumes its own session there, as today', calls('K-3').at(-1), `K-3|sess-3|${dirOf('b')}|resume`);

// AC6: the only login with room is on standby.
env = stopped([['default', 'in rotation', 60, 60], ['b', 'in rotation', 10, 10], ['s', 'standby', 30, 30]]);
preset({ default: benchRow('default') });
atLimit(DEF);
out = pass(env);
t('DS-467 AC6 it moves to the standby login', `${row('K-3').state} ${on('K-3')} ${spawnOf3().length}`, 'running s 1');
t('DS-467 AC6 the report says it used standby', /K-3 port=.* login=s \(standby: no login in rotation can take it\) resumed at Stage 4/.test(out), true);

// The login it moves to is refused at the limit too: it goes back to paused on its own login.
env = stopped(ROOM);
atLimit(DEF);
out = pass(env);
t('DS-467 a move refused on the other login goes back to waiting on its own', `${row('K-3').state} ${on('K-3')} ${spawnOf3().length} ${row('K-3').login_move ?? null}`, 'running b 0 null');
t('DS-467 and both logins are benched', Object.keys(batchOf().benched ?? {}).sort().join(), 'b,default');
t('DS-467 and the report says why it did not move', out.includes('K-3: not moved off login b, as login default was refused at the limit too'), true);

// A move left waiting a pass, whose own login is back since: it resumes its own session instead.
env = stopped(ROOM, { state: 'triaged', login_move: { from: 'b', from_dir: dirOf('b'), stage: '4/9', type: 'five_hour', resets_at: RESET, at: '2026-11-08T00:00:00.000Z' } });
rmSync(LIMITED);
out = pass(env);
t('DS-467 a waiting move whose login is back is dropped', `${row('K-3').login_move ?? null} ${spawnOf3().length}`, 'null 0');
t('DS-467 and the report says it resumes there', out.includes('K-3: not moved off login b, which is back: it resumes its own session there'), true);

// AC7: one login only. It is resumed exactly as today.
env = stopped([['default', 'in rotation', 50, 50]], { login: undefined });
rmSync(LIMITED);
atLimit(DEF);
out = pass(env);
t('DS-467 AC7 one login: it stays paused, as today', `${row('K-3').state} ${calls('K-3').length} ${row('K-3').login_move ?? null}`, 'running 0 null');
writeFileSync(join(state, 'logs', 'K-3.log'), rejected.replace(String(RESET), String(Math.round(Date.now() / 1000) - 60)));
rmSync(LIMITED);
out = pass(env);
t('DS-467 AC7 one login: once the limit lifts it resumes its own session', calls('K-3').at(-1), 'K-3|sess-3|unset|resume');

// ---- the pass's own model calls: the decider, triage and epic planning ----------------------------
// Each runs on a login that is not benched, chosen as a worker's is; with every login benched the
// decider starts nothing and the others run as the caller does; with one login, nothing changes.
const SEEN = join(T, 'decider-login');
const DECIDER_CLAUDE = join(W, 'stub', 'decider-claude');
writeFileSync(DECIDER_CLAUDE, `#!/bin/sh\nprintf '%s' "\${CLAUDE_CONFIG_DIR-unset}" > "${SEEN}"\n`, { mode: 0o755 });
// In a child with the world's environment, from the repo: the decider's spawn environment (or `none`
// when it started nothing), epic planning's headless environment, and call-login.mjs's answer for triage.
const calling = (env) => {
  rmSync(SEEN, { force: true });
  const js = `
    const { existsSync, readFileSync } = await import('node:fs');
    const { startDecider } = await import(${JSON.stringify(join(BIN, 'decider.mjs'))});
    const { headlessEnv } = await import(${JSON.stringify(join(BIN, 'epic-plan.mjs'))});
    const rec = startDecider({ state: ${JSON.stringify(state)}, slug: 'acme__widgets', bin: ${JSON.stringify(BIN)}, report: '', items: [], rules: '', cwd: process.cwd(), claude: ${JSON.stringify(DECIDER_CLAUDE)} });
    for (let i = 0; rec && !existsSync(${JSON.stringify(SEEN)}) && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
    const decider = rec ? readFileSync(${JSON.stringify(SEEN)}, 'utf8') : 'none';
    console.log(JSON.stringify({ decider, line: rec?.login ?? null, epic: headlessEnv(process.env).CLAUDE_CONFIG_DIR ?? 'unset' }));`;
  const r = spawnSync('node', ['--input-type=module', '-e', js], { env, cwd: join(W, 'repo'), encoding: 'utf8' });
  const d = spawnSync('node', [join(BIN, 'call-login.mjs'), 'dir'], { env, cwd: join(W, 'repo'), encoding: 'utf8' });
  try { return { ...JSON.parse(r.stdout.trim().split('\n').pop()), triage: d.stdout.trim() }; } catch { return { error: `${r.stdout}${r.stderr}` }; }
};

// AC1 to AC4: login A (the default) benched, B with room.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 60, 60]], {});
preset({ default: benchRow('default') });
let got = calling(env);
t('DS-468 AC1 the decider runs on login b', got.decider, dirOf('b'));
t('DS-468 AC1 its record names the login', got.line, 'b');
t('DS-468 AC2 AC3 triage and its challenge are pointed at login b', got.triage, dirOf('b'));
t('DS-468 AC4 epic planning\'s headless call runs on login b', got.epic, dirOf('b'));
// A bench in another of the repo's batches counts too: a login at its limit is at it everywhere.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 60, 60]], {});
const OTHER = join(dirname(QF), 'batches', 'EPIC-1', 'queue.json');
mkdirSync(dirname(OTHER), { recursive: true });
writeFileSync(OTHER, JSON.stringify({ version: 1, batch: 'EPIC-1', tickets: {}, benched: { default: benchRow('default') } }));
got = calling({ ...env, DESK_REPO_OVERRIDE: 'acme/widgets' });
t('DS-468 a bench in another batch steers the calls too', `${got.decider} ${got.triage}`, `${dirOf('b')} ${dirOf('b')}`);
rmSync(dirname(OTHER), { recursive: true, force: true });
// B benched and A, the caller's own, with room: the calls run as they always have.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 60, 60]], {});
preset({ b: benchRow('b') });
got = calling(env);
t('DS-468 with the caller\'s own login open, nothing is changed', `${got.decider} ${got.triage} ${got.epic}`, 'unset keep unset');
// A bench whose reset has passed benches nothing: the login with the most room is chosen again.
env = world([['default', 'in rotation', 90, 90], ['b', 'in rotation', 10, 10]], {});
preset({ b: benchRow('b', Math.round(Date.now() / 1000) - 60) });
got = calling(env);
t('DS-468 a bench past its reset is not a bench', got.decider, dirOf('b'));
// AC5 to AC7: every login in rotation and on standby benched.
env = world([['default', 'in rotation', 10, 10], ['b', 'in rotation', 60, 60], ['s', 'standby', 0, 0]], {});
preset({ default: benchRow('default'), b: benchRow('b'), s: benchRow('s', null) });
got = calling(env);
t('DS-468 AC5 every login benched: no decider starts', got.decider, 'none');
t('DS-468 AC6 triage runs as the caller does', got.triage, 'all');
t('DS-468 AC7 epic planning runs as the caller does', got.epic, 'unset');
// AC8: one login only.
env = world([['default', 'in rotation', 50, 50]], {});
preset({ default: benchRow('default') });
got = calling(env);
t('DS-468 AC8 one login: every call runs as today', `${got.decider} ${got.triage} ${got.epic}`, 'unset keep unset');
env = world(null, {});
got = calling(env);
t('DS-468 AC8 no subscriptions file: every call runs as today', `${got.decider} ${got.triage} ${got.epic}`, 'unset keep unset');

rmSync(T, { recursive: true, force: true });
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all checks passed');
