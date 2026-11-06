// suite: claude logins (every reader of Claude state covers each login: registry, probe, transcripts)
// A fake claude whose `agents --json`, probe and sign-in answer per CLAUDE_CONFIG_DIR, under a scratch
// HOME with a second login at ~/.claude-logins/b: the registry read across logins and its failure, a
// worker's login from its login file, the maintenance stop, the spawn lookup's CLI, the claim's transcript,
// the check-out's session list, desk-q's probe scheduling and the pass's lift probe. Nothing reads
// this computer's logins.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-claude-logins-'));
const H = join(T, 'home');
const B = join(H, '.claude-logins', 'b');
mkdirSync(join(H, '.claude'), { recursive: true });
for (const k of ['CLAUDE_CONFIG_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_CONFIG', 'DESK_QUEUE', 'DESK_AUTOPILOT_STATE']) delete process.env[k];
Object.assign(process.env, { HOME: H, DESK_CONFIG_ROOT: join(H, '.config', 'desk'), DESK_SUBSCRIPTIONS: join(T, 'subscriptions.md'),
  DESK_USAGE_DIR: join(T, 'usage'), DESK_LOCK_DIR: join(T, 'locks') });
mkdirSync(process.env.DESK_LOCK_DIR);

// The fake claude: each folder's agents.json is its registry (a `broken` file fails the read), and a
// probe answers ok. Every call is logged with the folder it ran in.
const FB = join(T, 'bin');
const CALLS = join(T, 'calls');
mkdirSync(FB);
writeFileSync(join(FB, 'claude'), `#!/bin/sh
d="\${CLAUDE_CONFIG_DIR:-${H}/.claude}"
printf '%s|%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" "$1" >> "${CALLS}"
case "$1" in
  agents) [ -f "$d/broken" ] && { echo "registry unavailable" >&2; exit 1; }; cat "$d/agents.json" 2>/dev/null || echo '[]' ;;
  -p) echo '{"type":"system"}'; echo '{"type":"result","is_error":false}' ;;
esac
`);
chmodSync(join(FB, 'claude'), 0o755);
process.env.PATH = `${FB}:${process.env.PATH}`;
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : []);
const resetCalls = () => rmSync(CALLS, { force: true });
const agents = (dir, list) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'agents.json'), JSON.stringify(list)); };
const subscriptions = (rows) => writeFileSync(process.env.DESK_SUBSCRIPTIONS,
  `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n${rows.map(([n, f, r]) => `| \`claude\` | \`${n}\` | \`${f}\` | \`${r}\` |`).join('\n')}\n`);

const L = await import(join(BIN, 'claude-logins.mjs'));
const P = await import(join(BIN, 'usage-probe.mjs'));
const Q = await import(join(BIN, 'desk-q.mjs'));
const M = await import(join(BIN, 'maintenance.mjs'));
const C = await import(join(BIN, 'claims.mjs'));

// ---- AC14: one login behaves as today
agents(join(H, '.claude'), [{ sessionId: 'S-A', pid: 11 }]);
resetCalls();
const one = L.readRegistry();
t('AC14 one login: one registry read, with no CLAUDE_CONFIG_DIR', calls().join(), 'unset|agents');
t('AC14 one login: its sessions', one.live.map((a) => `${a.sessionId}:${a.pid}`).join(), 'S-A:11');
t('AC14 one login: its one probe is due, on the default login', Q.probesDue([], { now: Date.now() }).map((x) => x.login.name).join(), 'default');
// One login reached through CLAUDE_CONFIG_DIR: the header reads the log its probe writes.
const solo = { name: 'solo', configDir: join(T, 'solo') };
mkdirSync(process.env.DESK_USAGE_DIR, { recursive: true });
writeFileSync(P.loginProbeLog(process.env.DESK_USAGE_DIR, solo), `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
  five_hour: { utilization: 0.1, resetsAt: Math.round(Date.now() / 1000) + 3600 }, seven_day: { utilization: 0.2, resetsAt: Math.round(Date.now() / 1000) + 86400 } } } })}\n`);
process.env.CLAUDE_CONFIG_DIR = join(T, 'solo');
t('AC14 one login under CLAUDE_CONFIG_DIR: desk-q\'s header reads its own probe\'s log', Q.usageOf([], Date.now()).reading.at != null, true);
// A subscriptions path that cannot be read: desk-q's probe timer carries on, as no login named.
const subsPath = process.env.DESK_SUBSCRIPTIONS;
process.env.DESK_SUBSCRIPTIONS = T;
t('an unreadable subscriptions file: the probe is still due, as no login named', Q.probesDue([], { now: Date.now() }).map((x) => x.login).join(), '');
process.env.DESK_SUBSCRIPTIONS = subsPath;
delete process.env.CLAUDE_CONFIG_DIR;
rmSync(process.env.DESK_USAGE_DIR, { recursive: true, force: true });

// ---- AC1, AC6: a worker on login B is live, and the spawn lookup finds its pid
subscriptions([['default', '~/.claude', 'in rotation'], ['b', '~/.claude-logins/b', 'standby']]);
agents(B, [{ sessionId: 'S-B', pid: 22 }]);
resetCalls();
const two = L.readRegistry();
t('AC1 the registry is read once in each login\'s folder', calls().join(), `unset|agents,${B}|agents`);
t('AC1 a worker on login B is live, tagged with its login', two.live.map((a) => `${a.sessionId}:${a.login}`).join(), 'S-A:default,S-B:b');
const cli = spawnSync('node', [join(BIN, 'claude-logins.mjs'), 'agents'], { encoding: 'utf8' });
t('AC6 the spawn lookup\'s CLI lists login B\'s worker with its pid', JSON.parse(cli.stdout).find((a) => a.sessionId === 'S-B')?.pid, 22);
t('a folder under ~/.claude-logins the file does not list is read too', (() => {
  agents(join(H, '.claude-logins', 'c'), [{ sessionId: 'S-C', pid: 33 }]);
  const r = L.readRegistry().live.some((a) => a.sessionId === 'S-C');
  rmSync(join(H, '.claude-logins', 'c'), { recursive: true });
  return r;
})(), true);
t('the caller\'s own CLAUDE_CONFIG_DIR is read too', (() => {
  agents(join(T, 'elsewhere'), [{ sessionId: 'S-E', pid: 44 }]);
  return L.readRegistry({ env: { ...process.env, CLAUDE_CONFIG_DIR: join(T, 'elsewhere') } }).live.some((a) => a.sessionId === 'S-E');
})(), true);

// ---- AC2: one login's registry cannot be read
writeFileSync(join(B, 'broken'), '');
const failed = L.readRegistry();
t('AC2 one login failing fails the whole read', `${failed.ok} ${failed.live}`, 'false null');
t('AC2 the failure names the login', /claude login b .*registry unavailable/.test(failed.why), true);
t('AC2 the spawn lookup\'s CLI exits non-zero', spawnSync('node', [join(BIN, 'claude-logins.mjs'), 'agents']).status, 1);
rmSync(join(B, 'broken'));

// ---- AC3, AC5: stopping a worker on login B stops its process
const killed = [];
const marked = [];
M.stopForWindow({ key: 'W-1', session_id: 'S-B' }, { live: L.readRegistry().live, kill: (pid) => killed.push(pid), setQueue: (key, fields) => { marked.push(key, ...fields); return { ok: true }; } });
t('AC5 the maintenance stop kills login B\'s worker', killed.join(), '22');
t('AC5 and marks it to resume', marked.slice(0, 3).join(), 'W-1,state=triaged,resume=maintenance');

// ---- a worker's login, from the file spawn-worker.sh writes beside its settings
const S = join(T, 'state');
mkdirSync(join(S, 'workers'), { recursive: true });
t('a worker with no login file is on the default login', L.workerLoginDir(S, 'W-1'), null);
const event = execFileSync('node', [join(BIN, 'claude-logins.mjs'), 'login-event'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: B } });
writeFileSync(L.loginFile(S, 'W-1'), event);
t('spawn-worker\'s login file names login B', L.workerLoginDir(S, 'W-1'), B);
t('and reads back as login B', L.loginOf(L.workerLoginDir(S, 'W-1')).name, 'b');
writeFileSync(L.loginFile(S, 'W-1'), execFileSync('node', [join(BIN, 'claude-logins.mjs'), 'login-event'], { encoding: 'utf8' }));
t('the default folder\'s login file reads as the default', L.workerLoginDir(S, 'W-1'), null);
// ---- AC13: the lift probe for a hold on login B runs in B's folder and is kept as B's
resetCalls();
const lb = L.loginOf(B);
const p = P.probeNow({ login: lb });
t('AC13 the probe succeeds', p.ok, true);
t('AC13 it runs with login B\'s config folder', calls().join(), `${B}|-p`);
t('AC13 its reading is kept as B\'s', `${existsSync(P.loginProbeLog(process.env.DESK_USAGE_DIR, lb))} ${existsSync(join(process.env.DESK_USAGE_DIR, 'probe.log'))}`, 'true false');
t('AC13 B\'s log is not the default\'s', P.loginProbeLog(process.env.DESK_USAGE_DIR, lb) !== P.probeLog(process.env.DESK_USAGE_DIR), true);
resetCalls();
P.probeNow();
t('AC14 the default probe runs as before, into probe.log', `${calls().join()} ${existsSync(join(process.env.DESK_USAGE_DIR, 'probe.log'))}`, 'unset|-p true');
rmSync(process.env.DESK_USAGE_DIR, { recursive: true, force: true });

// ---- AC11, AC12: desk-q's scheduled probe, per login
const repos = (running) => [{ rows: running.map((key) => ({ k: 'running', t: { key } })), prs: [], stateDir: S, q: {} }];
const now = Date.now();
const due = (r) => Q.probesDue(r, { now }).map((x) => x.login.name).join() || 'none';
t('AC11 no worker running: the default and login B are each due', due(repos([])), 'default,b');
process.env.CLAUDE_CONFIG_DIR = B;
t('a desk-q started on login B probes B as its own, and the default as another login', due(repos([])), 'b,default');
delete process.env.CLAUDE_CONFIG_DIR;
writeFileSync(L.loginFile(S, 'W-1'), event);
t('AC12 a worker on login B: no probe on B, and the default holds as today', due(repos(['W-1'])), 'none');
rmSync(L.loginFile(S, 'W-1'));
t('AC11 a worker on the default only: login B is still probed', due(repos(['W-1'])), 'b');
mkdirSync(process.env.DESK_USAGE_DIR, { recursive: true });
writeFileSync(P.loginProbeLog(process.env.DESK_USAGE_DIR, lb), `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
  five_hour: { utilization: 0.1, resetsAt: Math.round(now / 1000) + 3600 }, seven_day: { utilization: 0.2, resetsAt: Math.round(now / 1000) + 86400 } } } })}\n`);
t('AC11 login B with a fresh reading of its own is not due', due(repos(['W-1'])), 'none');
resetCalls();
const keepAlive = setInterval(() => {}, 100); // the probe's child is unref'd, so nothing else holds the loop while it runs
let scheduled;
await new Promise((res) => { P.probe({ login: lb, claude: join(FB, 'claude'), now: now + 10 * 60000, done: res }).then((r) => { scheduled = r.ran; }); });
clearInterval(keepAlive);
const inUsage = (f) => join(process.env.DESK_USAGE_DIR, f);
t('AC11 the scheduled probe runs with login B\'s config folder', `${scheduled} ${calls().join()}`, `true ${B}|-p`);
t('AC11 its output and start time are kept as B\'s', `${readFileSync(inUsage('probe.b.log'), 'utf8').includes('"type":"result"')} ${existsSync(inUsage('probe.b.at'))} ${existsSync(inUsage('probe.log'))} ${existsSync(inUsage('probe.at'))}`, 'true true false false');

// ---- AC9: an idle claim on login B reads that session's own transcript
const tr = join(B, 'projects', '-repo', 'S-CLAIM.jsonl');
mkdirSync(dirname(tr), { recursive: true });
writeFileSync(tr, '{}\n');
t('AC9 the claimed session\'s transcript is found under login B', C.transcriptOf('S-CLAIM')?.path, tr);

// ---- AC10: /desk-checkout lists sessions from both logins
const def = join(H, '.claude', 'projects', '-repo', 'S-DEF.jsonl');
mkdirSync(dirname(def), { recursive: true });
writeFileSync(def, '{}\n');
const py = spawnSync('python3', ['-I', '-c', `import sys; sys.dont_write_bytecode = True; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'skills', 'desk-checkout', 'scripts'))})
import claude_activity as a, os
from datetime import datetime, timedelta
print(sorted(os.path.basename(f) for f in a.find_files(datetime.now() - timedelta(days=1))))`], { encoding: 'utf8', env: process.env });
t('AC10 both logins\' sessions are listed', py.stdout.trim(), "['S-CLAIM.jsonl', 'S-DEF.jsonl']");

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
