// suite: usage probe shared (a pass's probe joins the per-login probe lock and stamp desk-q's probe uses)
// layer: L2
// usage-probe.mjs probeShared, each call in its own node process as two passes would make it, against a
// stub claude that takes a second to answer and logs each call with its login folder, under a scratch
// usage directory and lock directory. Nothing reads this computer's logins or usage.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, existsSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const MOD = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'usage-probe.mjs')).href;
const T = scratch('desk-usage-probe-shared-');
const USAGE = join(T, 'usage');
const LOCKS = join(T, 'locks');
const CALLS = join(T, 'calls');
mkdirSync(LOCKS);
mkdirSync(join(T, 'bin'));
const CLAUDE = join(T, 'bin', 'claude');
writeFileSync(CLAUDE, `#!/bin/sh
printf '%s\\n' "\${CLAUDE_CONFIG_DIR-unset}" >> "${CALLS}"
sleep 1
echo '{"type":"system"}'
echo '{"type":"result","is_error":false}'
`);
chmodSync(CLAUDE, 0o755);
const login = (name) => ({ tool: 'claude', name, configDir: join(T, 'home', `.claude-logins/${name}`) });
const B = login('b');
const C = login('c');
const env = { ...process.env, HOME: join(T, 'home'), DESK_USAGE_DIR: USAGE, DESK_LOCK_DIR: LOCKS };
for (const k of ['CLAUDE_CONFIG_DIR', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_STATE', 'DESK_CONFIG', 'DESK_QUEUE']) delete env[k];

// One pass's probe, in a process of its own.  -> its answer
const CHILD = `const P = await import(${JSON.stringify(MOD)}); console.log(JSON.stringify(P.probeShared(JSON.parse(process.argv[1]))));`;
const pass = (l, { timeoutMs = 10000 } = {}) => new Promise((res) => {
  const c = spawn(process.execPath, ['--input-type=module', '-e', CHILD, JSON.stringify({ dir: USAGE, lockDir: LOCKS, claude: CLAUDE, login: l, timeoutMs, pollMs: 100 })], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.on('exit', () => { try { res(JSON.parse(out)); } catch { res({ error: out }); } });
});
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean) : []);
const reset = () => { rmSync(USAGE, { recursive: true, force: true }); rmSync(CALLS, { force: true }); mkdirSync(USAGE); };
const stamp = (l, at) => writeFileSync(join(USAGE, `probe.${l.name}.at`), String(at));
const log = (l) => join(USAGE, `probe.${l.name}.log`);
const OK_LOG = '{"type":"system"}\n{"type":"result","is_error":false}\n';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ---- AC1: two passes on one login reaching the probe together make one call, and both judge on it
reset();
const both = await Promise.all([pass(B), pass(B)]);
t('AC1 one probe call is made for the login', calls().length, 1);
t('AC1 both passes judge the limit lifted on its reading', both.map((r) => r.ok).join(), 'true,true');
t('AC1 one of them on the other\'s probe', both.filter((r) => r.shared).length, 1);

// ---- AC2: desk-q started a probe of the login 20 s ago: the pass waits for its answer and judges on it
reset();
stamp(B, Date.now() - 20000);
const waiting = pass(B);
await sleep(700);
writeFileSync(log(B), OK_LOG);
const r2 = await waiting;
t('AC2 the pass makes no probe call', calls().length, 0);
t('AC2 and judges on that probe\'s answer', `${r2.ok} ${r2.shared}`, 'true true');

// ---- AC3: a probe started under a minute ago that never answers: the hold stays, and the report says so
reset();
writeFileSync(log(B), OK_LOG);
utimesSync(log(B), new Date(Date.now() - 600000), new Date(Date.now() - 600000));
stamp(B, Date.now() - 20000);
const began = Date.now();
const r3 = await pass(B, { timeoutMs: 1500 });
t('AC3 the pass makes no probe call', calls().length, 0);
t('AC3 it waits the full time limit', Date.now() - began >= 1500, true);
t('AC3 the hold stays, an older reading not taken for the answer', r3.ok, false);
t('AC3 its report says the shared probe gave no answer', /^the shared probe of login b, started \d+s ago by another pass or desk-q, gave no answer within 2s$/.test(r3.why), true);

// ---- AC4: passes on two logins probe their own, neither waiting on the other
reset();
const two = await Promise.all([pass(B), pass(C)]);
t('AC4 each login gets its own probe call', calls().sort().join(), [B.configDir, C.configDir].sort().join());
t('AC4 neither judges on the other\'s', two.map((r) => `${r.ok} ${r.shared ?? false}`).join(), 'true false,true false');

// ---- AC5: the last probe started over a minute ago: the pass probes as before and stamps the start
reset();
stamp(B, Date.now() - 61000);
const before = Date.now();
const r5 = await pass(B);
t('AC5 the pass probes the login', `${calls().join()} ${r5.ok} ${r5.shared ?? false}`, `${B.configDir} true false`);
const at = Number(readFileSync(join(USAGE, 'probe.b.at'), 'utf8'));
t('AC5 and writes its start stamp, before the answer', at >= before && at < Date.now() - 900, true);

// ---- A pass with no reading joins a probe of its login still running (started under a minute ago, no
// log since), and otherwise probes at most once per PROBE_EVERY_MS from the last start
const { noReadingProbeDue, PROBE_EVERY_MS } = await import(MOD);
const due = () => noReadingProbeDue({ dir: USAGE, login: B });
reset();
t('no reading: never probed, so it probes', due(), true);
stamp(B, Date.now() - 20000);
t('no reading: a probe started 20s ago and still running is joined, not skipped', due(), true);
writeFileSync(log(B), OK_LOG);
t('no reading: one started 20s ago that has logged its answer is not repeated', due(), false);
stamp(B, Date.now() - 120000);
rmSync(log(B));
t('no reading: one started 2 minutes ago is not repeated', due(), false);
stamp(B, Date.now() - PROBE_EVERY_MS - 1000);
t('no reading: one older than PROBE_EVERY_MS is', due(), true);

console.log(fails ? `${fails} FAILED` : 'all usage probe shared checks passed');
process.exit(fails ? 1 : 0);
