// suite: codex login (desk-codex calls start on, and rotate across, Codex logins, benching one at its limit)
// covers: desk/bin/codex-login.mjs desk/bin/desk-codex.mjs
// A scratch HOME with ~/.codex and folders under ~/.codex-logins, each with its own rollout log in the
// shape Codex writes, and a fake codex on PATH that records the CODEX_HOME each call ran under. A folder
// holding a `signed-out` file fails `codex login status`. Nothing reads this computer's Codex folders.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'desk', 'bin', 'desk-codex.mjs');

const T = mkdtempSync(join(tmpdir(), 'desk-codex-login-'));
const H = join(T, 'home');
for (const d of ['bin', 'state', H]) mkdirSync(join(T, d), { recursive: true });
writeFileSync(join(T, 'bin', 'codex'), `#!/usr/bin/env bash
if [ "$1" = login ]; then echo x >> "${T}/statuses"; [ -e "\${CODEX_HOME:-$HOME/.codex}/signed-out" ] && exit 1; exit 0; fi
printf '%s' "\${CODEX_HOME-unset}" > "${T}/codex-home"
echo x >> "${T}/calls"
out=""; prev=""
for a in "$@"; do [ "$prev" = --output-last-message ] && out="$a"; prev="$a"; done
echo CODEX_OK > "$out"
`);
chmodSync(join(T, 'bin', 'codex'), 0o755);
const CFG = join(T, 'config.md');
writeFileSync(CFG, `## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`codex-review\` | Cross-vendor refutation | \`yes\` | \`yes\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Phase 0 levers | \`none\` | \`codex\` |
| Codex review | \`none\` | \`finder=m-find:medium refuter=m-ref:low timeout=5\` |
`);
const SUBS = join(T, 'subscriptions.md');
const env = () => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(DESK_|AUTOPILOT_)/.test(k) || ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY'].includes(k)) delete e[k];
  return { ...e, HOME: H, PATH: `${join(T, 'bin')}:${process.env.PATH}`, DESK_CONFIG: CFG, DESK_AUTOPILOT_STATE: join(T, 'state'),
    DESK_CONFIG_ROOT: join(H, '.config', 'desk'), DESK_SUBSCRIPTIONS: SUBS };
};
const read = (f) => (existsSync(join(T, f)) ? readFileSync(join(T, f), 'utf8') : null);
const count = (f) => (read(f) ?? '').split('\n').filter(Boolean).length;
const codex = (...args) => {
  for (const f of ['calls', 'statuses', 'codex-home']) rmSync(join(T, f), { force: true });
  const r = spawnSync('node', [SCRIPT, ...args], { env: env(), encoding: 'utf8', timeout: 30000 });
  const on = r.stderr.match(/on Codex login (\S+)/)?.[1] ?? null;
  return { status: r.status, out: r.stdout, err: r.stderr, on, home: read('codex-home'), calls: count('calls'), statuses: count('statuses') };
};

const now = Date.now();
const inHours = (h) => Math.floor((now + h * 3600 * 1000) / 1000);
const win = (used, minutes, resetH) => ({ used_percent: used, window_minutes: minutes, resets_at: inHours(resetH) });
const five = (used, resetH = 2) => win(used, 300, resetH);
const week = (used, resetH = 50) => win(used, 10080, resetH);
const DEFAULT = join(H, '.codex');
const dir = (name) => (name === 'default' ? DEFAULT : join(H, '.codex-logins', name));
// A login's folder and its newest reading: a token_count event with the windows given.
const reading = (name, primary, secondary = null) => {
  const d = join(dir(name), 'sessions', '2026', '11', '07');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'rollout-2026-11-07T10-00-00-a.jsonl'), `${JSON.stringify({ timestamp: new Date(now - 60000).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary, secondary, plan_type: 'pro', rate_limit_reached_type: null } } })}\n`);
};
const subs = (...rows) => writeFileSync(SUBS, ['| Tool | Name | Folder | Rule |', '|---|---|---|---|',
  ...rows.map(([name, rule]) => `| codex | ${name} | ${dir(name)} | ${rule} |`)].join('\n') + '\n');
const record = join(T, 'state', 'codex-probe.json');

// AC9: one Codex login: codex runs as it always has, with no login checked and no CODEX_HOME set.
reading('default', five(70), week(10));
let r = codex('refuter', 'x');
t('AC9 one login: the call runs, on the caller\'s environment', [r.status, r.calls, r.home], [0, 1, 'unset']);
t('AC9 one login: no sign-in check and no login named', [r.statuses, r.on], [0, null]);
r = codex('probe');
t('AC9 one login: the probe records no login', [r.status, JSON.parse(readFileSync(record, 'utf8')).login], [0, undefined]);

// AC1: two logins in rotation: the one with the most room, named for the review record.
reading('login-2', five(20), week(10));
subs(['default', 'in rotation'], ['login-2', 'in rotation']);
r = codex('refuter', 'x');
t('AC1 the call runs on the login with the most room, with CODEX_HOME set for it', [r.status, r.home, r.on], [0, dir('login-2'), 'login-2']);
reading('default', five(5), week(10));
r = codex('finder', 'x');
t('AC1 and on the default login with no CODEX_HOME once it has more', [r.status, r.home, r.on], [0, 'unset', 'default']);

// AC2: a plan with no 5-hour window is ranked on its weekly window alone.
reading('default', five(10), week(60));
reading('login-2', week(30));
r = codex('refuter', 'x');
t('AC2 a weekly-only login at 30% beats one at 10% (5h) and 60% (week)', r.on, 'login-2');

// AC3: a login at its limit is benched until that window resets.
reading('login-2', five(100, 3), week(5));
reading('default', five(80), week(80));
r = codex('refuter', 'x');
t('AC3 a login at its limit is not used while it lasts', [r.status, r.on], [0, 'default']);
reading('login-2', five(100, -1), week(5));
r = codex('refuter', 'x');
t('AC3 once its reset has passed it is used again', r.on, 'login-2');

// AC4: every login in rotation benched: the one on standby.
reading('login-2', five(100, 3), week(5));
reading('default', five(40), week(100, 20));
reading('spare', five(50), week(50));
subs(['default', 'in rotation'], ['login-2', 'in rotation'], ['spare', 'standby']);
r = codex('refuter', 'x');
t('AC4 every login in rotation benched: the call runs on standby', [r.status, r.home, r.on], [0, dir('spare'), 'spare']);
reading('login-2', five(30), week(5));
t('AC4 standby is not used while a login in rotation has room', codex('refuter', 'x').on, 'login-2');

// AC5: every login benched: no call, and the earliest reset named for the dead seat.
reading('login-2', five(100, 3), week(5));
reading('spare', five(100, 1), week(5));
r = codex('finder', 'x');
t('AC5 every login benched: exit 75 and codex is not run', [r.status, r.calls, r.out], [75, 0, '']);
t('AC5 the reason names the earliest reset', r.err.includes(`the earliest to reset is spare, at ${new Date(inHours(1) * 1000).toISOString()}`), true);
r = codex('probe');
t('AC5 the probe says the same rather than probing', [r.status, r.calls], [75, 0]);

// AC6: a login whose rule is off, or which is signed out, is never used, whatever its room.
reading('default', five(60), week(10));
reading('login-2', five(1), week(1));
reading('spare', five(1), week(1));
writeFileSync(join(dir('spare'), 'signed-out'), '');
subs(['default', 'in rotation'], ['login-2', 'off'], ['spare', 'in rotation']);
r = codex('refuter', 'x');
t('AC6 off and signed-out logins are passed over for one with less room', [r.status, r.on], [0, 'default']);
subs(['default', 'off'], ['login-2', 'off'], ['spare', 'in rotation']);
r = codex('refuter', 'x');
t('AC6 with none usable no call runs', [r.status, r.calls, /no Codex login is signed in/.test(r.err)], [75, 0, true]);
rmSync(join(dir('spare'), 'signed-out'));

// AC8: the probe runs on the login the next call would use, and a pass on another does not stand.
subs(['default', 'in rotation'], ['login-2', 'in rotation']);
reading('login-2', five(10), week(10));
rmSync(record, { force: true });
r = codex('probe');
t('AC8 the probe runs on the login the next call would use', [r.status, r.out, r.home, r.on], [0, 'CODEX_OK\n', dir('login-2'), 'login-2']);
t('AC8 the pass is recorded for that login', JSON.parse(readFileSync(record, 'utf8')).login, 'login-2');
t('AC8 a pass under an hour old on the same login stands', [codex('probe').calls], [0]);
reading('default', five(1), week(1));
r = codex('probe');
t('AC8 a pass on another login does not: the probe runs on the new one', [r.calls, r.on], [1, 'default']);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'codex login: all checks passed');
process.exit(fails ? 1 : 0);
