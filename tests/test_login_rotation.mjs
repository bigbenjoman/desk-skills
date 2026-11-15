// suite: the repo's subscription (a new session starts on it; a resume stays on its own login; a limit holds)
// login-choice.mjs with a fixed clock, then the real pass.mjs against a fake claude whose sign-in answers
// per config folder, a stub spawn-worker.sh that records the login each call was given, and each login's
// reading in its own probe log. A throwaway HOME: nothing reads this computer's logins.
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
for (const k of ['CLAUDE_CONFIG_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_WORKTREES_DIR', 'DESK_DEFAULT_BRANCH', 'DESK_SUBSCRIPTION',
  'DESK_BATCH', 'DESK_QUEUE', 'DESK_AUTOPILOT_STATE', 'DESK_CONFIG', 'CLAUDE_CODE_SESSION_ID', 'AUTOPILOT_DRY_RUN', 'AUTOPILOT_RERUN', 'AUTOPILOT_BATCH_BUDGET_USD', 'AUTOPILOT_START_STAGE', 'AUTOPILOT_TASK']) delete process.env[k];
Object.assign(process.env, { HOME: H, DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'), DESK_LOCK_DIR: join(T, 'locks'),
  DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'), DESK_USAGE_DIR: join(T, 'usage') });
mkdirSync(process.env.DESK_LOCK_DIR);
const { chooseLogin, loginRoom } = await import(join(BIN, 'login-choice.mjs'));

// ---- the choice the decider still makes (login-choice.mjs) ---------------------------------------
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
t('known room comes before unknown', pick(c('a', 'in rotation'), c('b', 'in rotation', reading(90, 90))), 'b');
t('a login with no reading comes before one at 100%', pick(c('a', 'in rotation', reading(100, 10)), c('b', 'in rotation')), 'b');
t('every login in rotation at 100%: standby', pick(c('a', 'in rotation', reading(100, 10)), c('b', 'in rotation', reading(5, 100)), c('s', 'standby', reading(10, 10))), 's');
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
// One line per call: ticket, session or `preflight`, the login it was given, and whether it resumes.
writeFileSync(join(bin, 'spawn-worker.sh'), `printf '%s|%s|%s|%s\\n' "$1" "$3" "\${AUTOPILOT_LOGIN_DIR-unset}" "\${AUTOPILOT_RESUME:+resume}" >> "${CALLS}"
ld="\${AUTOPILOT_LOGIN_DIR:-${H}/.claude}"
if [ "$3" = preflight ]; then
  if grep -qF "$ld " "${LIMITED}" 2>/dev/null; then echo "[preflight] usage-limit: the account is at its usage limit"; else echo "[preflight] pass"; fi
else echo "[spawn] ticket=$1"; fi\n`);
// Sign-in per folder: a folder's name is its account, and a signed-out folder answers loggedIn false.
// Every `auth` call is recorded.
const AUTHS = join(T, 'auths');
writeFileSync(join(W, 'stub', 'claude'), `#!/bin/sh
d="\${CLAUDE_CONFIG_DIR:-${H}/.claude}"
case "$1" in
  agents) echo '[]' ;;
  auth) echo "$d" >> "${AUTHS}"
    if grep -qx "$d" "${SIGNED_OUT}" 2>/dev/null; then echo '{"loggedIn":false}'; exit 1; fi
    printf '{"loggedIn":true,"email":"%s@example.com"}\\n' "$(basename "$d")" ;;
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
// `sub` is the repo's §3b Subscription row, left out when null.
const writeConfig = (sub, to = config) => writeFileSync(to, [
  '## 0. Repo', '| Field | Value |', '|---|---|', '| GitHub repo | `acme/widgets` |', '| Default branch | `main` |', '',
  '## 2. Paths', '| Field | Value |', '|---|---|', `| Primary repo root | \`${join(W, 'repo')}\` |`, `| Worktrees directory | \`${join(W, 'wt')}\` |`, '',
  '## 3. Permissions', '| Key | Capability | Recommended | Your setting |', '|---|---|---|---|', '| `autopilot-workers` | Run workers | `yes` | `yes` |', '',
  '## 3b. Cost and autonomy', '| Field | Recommended | Your setting |', '|---|---|---|', '| Autopilot worker concurrency | `3 / 3` | `3 / 3` |', '| Usage pacing headroom (points) | `5` | `off` |',
  ...(sub ? [`| Subscription | \`default\` | \`${sub}\` |`] : []), '',
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
// Each login's account, as its .claude.json records it, is `<name>@example.com`.
function writeSubs(logins) {
  const rows = logins.map(([n, r]) => `| \`claude\` | \`${n}\` | \`${n === 'default' ? '~/.claude' : `~/.claude-logins/${n}`}\` | \`${r}\` |`);
  writeFileSync(process.env.DESK_SUBSCRIPTIONS, `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.join('\n')}\n`);
}
function world(logins, tickets, { sub = null } = {}) {
  for (const p of [state, process.env.DESK_USAGE_DIR, CALLS, AUTHS, SIGNED_OUT, LIMITED, process.env.DESK_SUBSCRIPTIONS, join(H, '.claude-logins'), join(H, '.claude.json')]) rmSync(p, { recursive: true, force: true });
  mkdirSync(join(state, 'logs'), { recursive: true });
  mkdirSync(join(state, 'workers'), { recursive: true });
  mkdirSync(process.env.DESK_USAGE_DIR, { recursive: true });
  writeConfig(sub);
  if (logins) {
    writeSubs(logins);
    for (const [n, , five, week] of logins) {
      if (n !== 'default') mkdirSync(dirOf(n), { recursive: true });
      writeFileSync(n === 'default' ? join(H, '.claude.json') : join(dirOf(n), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${n}@example.com` } }));
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
const loginArg = (l) => l.split('|')[2];
const signOut = (dir) => writeFileSync(SIGNED_OUT, `${dir}\n`);
const addTicket = (key) => { const qd = JSON.parse(readFileSync(QF, 'utf8')); qd.tickets[key] = NEW(key); writeFileSync(QF, JSON.stringify(qd)); };
const { resetText } = await import(join(BIN, 'usage-limit.mjs'));
const DEF = join(H, '.claude');
const RESET = Math.round(Date.now() / 1000) + 7200;
const atLimit = (dir, at = RESET) => appendFileSync(LIMITED, `${dir} ${at ?? 'none'}\n`);
const batchOf = () => JSON.parse(readFileSync(QF, 'utf8'));
const TWO = { 'Y-1': NEW('Y-1'), 'Y-2': NEW('Y-2') };
// login-2 is the default and fuller; login-3 and login-4 are unused, with more room.
const THREE = [['login-2', 'default', 70, 70], ['login-3', 'unused', 10, 10], ['login-4', 'unused', 5, 5]];

// AC1: the repo follows the default; an unused login with more room is not chosen.
let env = world(THREE, fresh);
let out = pass(env);
t('AC1 the worker starts on the default subscription, not the roomier one', on('Y-1'), 'login-2');
t('AC1 its queue record names the subscription and its folder', `${row('Y-1').login.email} ${row('Y-1').login.config_dir}`, `login-2@example.com ${dirOf('login-2')}`);
t('AC1 spawn-worker.sh is given that folder', loginArg(calls('Y-1').at(-1)), dirOf('login-2'));
t('AC1 the report names the login', /Y-1 port=.* login=login-2;/.test(out), true);

// AC2, AC3: the repo's row pins login-3.
env = world(THREE, fresh, { sub: 'login-3@example.com' });
pass(env);
t('AC2 a pinned repo starts its worker on the pinned subscription', `${row('Y-1').state} ${on('Y-1')} ${loginArg(calls('Y-1').at(-1))}`, `running login-3 ${dirOf('login-3')}`);
t('AC3 and its preflight runs there', calls('Y-1')[0], `Y-1|preflight|${dirOf('login-3')}|`);

// AC4: DESK_SUBSCRIPTION wins over the row.
env = world(THREE, fresh, { sub: 'login-3@example.com' });
pass({ ...env, DESK_SUBSCRIPTION: 'login-4@example.com' });
t('AC4 DESK_SUBSCRIPTION wins over the row', `${on('Y-1')} ${loginArg(calls('Y-1')[0])} ${loginArg(calls('Y-1').at(-1))}`, `login-4 ${dirOf('login-4')} ${dirOf('login-4')}`);

// The default ~/.claude, from a pass on it: nothing is passed, and the row names it.
env = world([['default', 'default', 90, 90], ['b', 'unused', 10, 10]], fresh);
pass(env);
t('the default ~/.claude is named on the row, with no folder', `${on('Y-1')} ${row('Y-1').login.config_dir}`, 'default null');
t('and a pass on it leaves the worker where it is', loginArg(calls('Y-1').at(-1)), 'unset');
pass({ ...world([['default', 'default', 90, 90], ['b', 'unused', 10, 10]], fresh), CLAUDE_CONFIG_DIR: dirOf('b') });
t('from a pass on login b, the worker is sent to ~/.claude, an empty folder', loginArg(calls('Y-1').at(-1)), '');

// AC5: a worker that started on b resumes there, though the default is c now.
const RESUMING = (resume, extra = {}) => ({ 'K-1': { key: 'K-1', state: 'triaged', resume, resume_why: 'test', open_questions: 0, session_id: 'sess-1', branch: 'fix/K-1',
  worktree: join(W, 'wt', 'K-1'), login: { name: 'b', config_dir: dirOf('b') }, ...extra } });
mkdirSync(join(W, 'wt', 'K-1'), { recursive: true });
const MOVED = [['c', 'default', 10, 10], ['b', 'unused', 90, 90]];
for (const [why, how] of [['killed', 'pending'], ['maintenance', 'maintenance'], ['usage limit', 'usage']]) {
  env = world(MOVED, RESUMING(how));
  out = pass(env);
  t(`AC5 ${why}: it resumes its own session on b, not the new default`, calls('K-1').at(-1), `K-1|sess-1|${dirOf('b')}|resume`);
  t(`AC5 ${why}: the preflight runs there too`, calls('K-1')[0], `K-1|preflight|${dirOf('b')}|`);
  t(`AC5 ${why}: the report names the login`, /K-1 resumed .* login=b;/.test(out), true);
}
// A row from before rows named a login resumes on what spawn-worker.sh recorded.
env = world(MOVED, RESUMING('pending', { login: undefined }));
writeFileSync(join(state, 'workers', 'K-1.login.json'), JSON.stringify({ login: 'b', config_dir: dirOf('b') }));
pass(env);
t('a row with no login resumes on the recorded one', calls('K-1').at(-1), `K-1|sess-1|${dirOf('b')}|resume`);
// Signed out since: no session starts, and it parks with the sign-in command.
env = world(MOVED, RESUMING('pending'));
signOut(dirOf('b'));
pass(env);
t('a resume on a login signed out since starts nothing', calls('K-1').length, 0);
t('and parks naming the login and its sign-in', `${row('K-1').state} ${row('K-1').park.question.includes('its login b (~/.claude-logins/b) is signed out')} ${row('K-1').park.question.includes('CLAUDE_CONFIG_DIR=~/.claude-logins/b claude, then /login')}`, 'parked true true');

// AC6: the default changes while a worker runs; the next new worker starts on the new default.
env = world([['b', 'default', 10, 10], ['c', 'unused', 90, 90]], fresh);
pass(env);
t('AC6 before the change the worker starts on b', on('Y-1'), 'b');
writeSubs([['b', 'unused', 10, 10], ['c', 'default', 90, 90]]);
addTicket('Y-2');
pass(env);
t('AC6 after it the next new worker starts on c', `${row('Y-2').state} ${on('Y-2')} ${loginArg(calls('Y-2').at(-1))}`, `running c ${dirOf('c')}`);
t('AC6 and the running one is left on b', on('Y-1'), 'b');

// A session after a handoff is new, so it starts on the repo's subscription.
const HANDED = { 'H-1': { key: 'H-1', state: 'triaged', open_questions: 0, handoff: 'pending', handoff_stage: '4b', session_id: 'old', branch: 'fix/H-1', worktree: join(W, 'wt', 'H-1'), login: { name: 'default', config_dir: null } } };
spawnSync('git', ['init', '-q', '-b', 'fix/H-1', join(W, 'wt', 'H-1')], { env: gitEnv });
spawnSync('git', ['-C', join(W, 'wt', 'H-1'), 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
env = world([['default', 'unused', 10, 10], ['b', 'default', 90, 90]], HANDED);
mkdirSync(join(state, 'handoffs'), { recursive: true });
writeFileSync(join(state, 'handoffs', 'H-1.json'), JSON.stringify({ ticket: 'H-1', stage: '4b', criteria: ['x'], lane: 'A', verification: [], review: [], evidence: [] }));
pass(env);
t('a session after a handoff starts on the repo\'s subscription', `${row('H-1').state} ${on('H-1')}`, 'running b');

// AC7: the repo's subscription at its limit, another with room: one preflight learns it, then nothing.
env = world([['b', 'default', 10, 10], ['c', 'unused', 90, 90]], TWO);
atLimit(dirOf('b'));
out = pass(env);
t('AC7 the refused ticket keeps its place, and nothing else spawns or preflights', `${row('Y-1').state} ${row('Y-2').state} ${calls('Y-1').length} ${calls('Y-2').length}`, 'triaged triaged 1 0');
t('AC7 the hold is recorded with the reset time', JSON.stringify([batchOf().usage_hold?.preflight, batchOf().usage_hold?.resets_at]), JSON.stringify(['Y-1', RESET]));
t('AC7 nothing went to the other subscription', readFileSync(CALLS, 'utf8').includes(dirOf('c')), false);
t('AC7 the report says the batch holds', out.includes('Y-1: its preflight was refused at the 5-hour usage limit — not failed, and nothing else spawns until the limit lifts'), true);
out = pass(env);
t('AC7 a pass later it starts and preflights nothing', `${calls('Y-1').length} ${calls('Y-2').length} ${row('Y-1').state} ${row('Y-2').state}`, '1 0 triaged triaged');
t('AC7 and the hold reads with its reset', out.includes(`the 5-hour usage limit until ${resetText(RESET)} holds every spawn and resume`), true);
t('AC7 nothing is benched or moved', `${batchOf().benched ?? null} ${row('Y-1').login_move ?? null}`, 'null null');

// AC8, AC9: a worker whose session ended at b's limit, c with room.
const PAUSED = { key: 'K-2', state: 'running', open_questions: 0, session_id: 'sess-2', branch: 'fix/K-2', worktree: join(W, 'wt', 'K-2'), stage: '4/9', login: { name: 'b', config_dir: dirOf('b') } };
mkdirSync(join(W, 'wt', 'K-2'), { recursive: true });
const rejected = (at) => `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":${at}}}\n`;
env = world([['b', 'default', 10, 10], ['c', 'unused', 90, 90]], { 'K-2': PAUSED });
writeFileSync(join(state, 'logs', 'K-2.log'), rejected(RESET));
atLimit(dirOf('b'));
out = pass(env);
t('AC8 before the reset it stays paused, with no session started', `${row('K-2').state} ${on('K-2')} ${calls('K-2').length} ${row('K-2').login_move ?? null}`, 'running b 0 null');
t('AC8 and is reported paused', out.includes(`K-2 on the 5-hour usage limit until ${resetText(RESET)}`), true);
rmSync(LIMITED);
writeFileSync(join(state, 'logs', 'K-2.log'), rejected(Math.round(Date.now() / 1000) - 60));
pass(env);
t('AC9 after the reset it resumes its own session on b', calls('K-2').at(-1), `K-2|sess-2|${dirOf('b')}|resume`);

// A limit on a login that is no longer the repo's (the default moved from b to c) holds only the work
// on it: a worker paused there waits, a resume refused there waits, and new work starts on c.
env = world([['b', 'unused', 10, 10], ['c', 'default', 90, 90]], { 'K-2': PAUSED, 'Y-1': NEW('Y-1') });
writeFileSync(join(state, 'logs', 'K-2.log'), rejected(RESET));
atLimit(dirOf('b'));
out = pass(env);
t('a worker paused on a login no longer the repo\'s waits there', `${row('K-2').state} ${on('K-2')} ${calls('K-2').length}`, 'running b 0');
t('and new work still starts on the repo\'s subscription', `${row('Y-1').state} ${on('Y-1')} ${batchOf().usage_hold ?? null}`, 'running c null');
env = world([['b', 'unused', 10, 10], ['c', 'default', 90, 90]], { ...RESUMING('pending'), 'Y-1': NEW('Y-1') });
atLimit(dirOf('b'));
out = pass(env);
t('a resume refused on its own login waits for it, and the batch goes on', `${row('K-1').state} ${row('K-1').resume} ${row('Y-1').state} ${on('Y-1')} ${batchOf().usage_hold ?? null}`, 'triaged pending running c null');
t('and the report says it waits for that login', out.includes('K-1: its preflight was refused at the usage limit on its own login b, so it waits for that login'), true);

// AC11: the row names an email no login here is signed in to.
env = world(THREE, fresh, { sub: 'nobody@example.com' });
out = pass(env);
t('AC11 nothing starts', `${row('Y-1').state} ${calls('Y-1').length}`, 'triaged 0');
t('AC11 the stall names the row and the email', out.includes('this repo\'s config §3b "Subscription" row names nobody@example.com, which is not one of this computer\'s subscriptions'), true);
out = pass({ ...world(THREE, fresh), DESK_SUBSCRIPTION: 'nobody@example.com' });
t('AC11 from DESK_SUBSCRIPTION, the stall names that', out.includes('DESK_SUBSCRIPTION names nobody@example.com'), true);

// AC12: the repo's subscription signed out.
env = world([['b', 'default', 10, 10], ['c', 'unused', 90, 90]], fresh);
signOut(dirOf('b'));
out = pass(env);
t('AC12 nothing starts, on b or on c', `${row('Y-1').state} ${calls('Y-1').length}`, 'triaged 0');
t('AC12 the stall gives b\'s sign-in command', out.includes('is signed out, so nothing new starts for this repo') && out.includes('CLAUDE_CONFIG_DIR=~/.claude-logins/b claude, then /login'), true);

// AC13: repo A follows the default, which is at its limit, and holds; repo B, pinned to b with room,
// has its own config, queue and state, and starts on b while A's hold stands.
env = world([['default', 'default', 10, 10], ['b', 'unused', 90, 90]], fresh);
atLimit(DEF);
pass(env);
t('AC13 repo A, on the default at its limit, holds', `${row('Y-1').state} ${batchOf().usage_hold?.preflight}`, 'triaged Y-1');
const otherState = join(H, '.desk-autopilot', 'acme__other');
const otherQueue = join(process.env.DESK_HOME, 'repos', 'acme__other', 'queue.json');
const otherConfig = join(process.env.DESK_CONFIG_ROOT, 'repos', 'acme__other', 'config.md');
for (const d of [join(otherState, 'logs'), join(otherState, 'workers'), dirname(otherQueue), dirname(otherConfig)]) mkdirSync(d, { recursive: true });
writeConfig('b@example.com', otherConfig);
writeFileSync(otherQueue, JSON.stringify({ version: 1, batch: 'acme__other', tickets: { 'Z-1': NEW('Z-1') } }));
pass({ ...env, DESK_CONFIG: otherConfig, DESK_QUEUE: otherQueue, DESK_AUTOPILOT_STATE: otherState, AUTOPILOT_PORT_FLOOR: String(floor += 100) });
const other = JSON.parse(readFileSync(otherQueue, 'utf8'));
t('AC13 repo B, pinned to b with room, starts on it', `${other.tickets['Z-1'].state} ${other.tickets['Z-1'].login?.name} ${loginArg(calls('Z-1').at(-1))} ${other.usage_hold ?? null}`, `running b ${dirOf('b')} null`);
t('AC13 and repo A still holds', `${row('Y-1').state} ${batchOf().usage_hold?.preflight}`, 'triaged Y-1');

// AC14: one login and no subscriptions file: as before.
env = world(null, fresh);
out = pass(env);
t('AC14 it spawns on ~/.claude as before', `${row('Y-1').state} ${loginArg(calls('Y-1').at(-1))} ${on('Y-1')}`, 'running unset null');
t('AC14 no sign-in check', auths().length, 0);
t('AC14 the report names no login', /login=/.test(out), false);
env = world(null, RESUMING('pending', { login: undefined }));
pass(env);
t('AC14 a resume is as before', `${calls('K-1').at(-1)} ${auths().length}`, 'K-1|sess-1|unset|resume 0');
env = { ...world(null, RESUMING('pending', { login: undefined })), CLAUDE_CONFIG_DIR: join(T, 'own') };
mkdirSync(join(T, 'own'), { recursive: true });
pass(env);
t('AC14 a pass under its own config folder resumes a worker with no record on it', calls('K-1').at(-1), 'K-1|sess-1|unset|resume');
env = world([['default', 'default', 50, 50]], TWO);
atLimit(DEF);
out = pass(env);
t('AC14 one login at its limit: the batch holds on the preflight', JSON.stringify([batchOf().usage_hold?.preflight, batchOf().usage_hold?.resets_at, calls('Y-2').length]), JSON.stringify(['Y-1', RESET, 0]));

// ---- the pass's own model calls: the decider, triage and epic planning ----------------------------
// Each runs on a login that is not benched, chosen as a worker's is; with every login benched the
// decider starts nothing and the others run as the caller does; with one login, nothing changes.
const preset = (benched) => writeFileSync(QF, JSON.stringify({ ...batchOf(), benched }));
const benchRow = (name, at = RESET) => ({ login: name, config_dir: name === 'default' ? null : dirOf(name), type: 'five_hour', resets_at: at, since: '2026-11-07T00:00:00.000Z', by: 'X-1' });
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
// The pass benches nothing now, so a bench a pass from before left (one with no reset time included)
// is cleared by the next pass, and the decider starts again.
out = pass(env);
t('a pass clears a bench left from before the upgrade', batchOf().benched ?? null, null);
got = calling(env);
t('and the decider starts again', got.decider === 'none', false);
// DS-630 AC2: a ticket a pass from before left waiting to move off login b resumes its own session on b,
// though the repo's subscription is c, and the field is gone; one that is not waiting just loses it.
const WAITING = { ...RESUMING('x')['K-1'], resume: null, resume_why: null,
  login_move: { from: 'b', from_dir: dirOf('b'), stage: '4/9', type: 'five_hour', resets_at: RESET, at: '2026-11-07T00:00:00.000Z' } };
env = world(MOVED, { 'K-1': WAITING, 'D-1': { ...NEW('D-1'), state: 'done', login_move: { from: 'b', from_dir: dirOf('b') } } });
out = pass(env);
t('DS-630 AC2 the login_move is gone from the queue', `${row('K-1').login_move ?? null} ${row('D-1').login_move ?? null} ${row('D-1').state}`, 'null null done');
t('DS-630 AC2 it resumes its own session on the login it started on', calls('K-1').at(-1), `K-1|sess-1|${dirOf('b')}|resume`);
t('DS-630 AC2 the report says so', out.includes('K-1: no longer moved off login b: it resumes its own session there'), true);
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
