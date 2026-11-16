// suite: codex login (desk-codex calls run on the Codex default and never move to another login)
// covers: desk/bin/codex-login.mjs desk/bin/desk-codex.mjs
// A scratch HOME with ~/.codex and folders under ~/.codex-logins, each with its own rollout log in the
// shape Codex writes, and a fake codex on PATH that records the CODEX_HOME each call ran under. A folder
// holding a `signed-out` file fails `codex login status`, and one holding `at-limit` fails each call as
// Codex does at a usage limit. Nothing reads this computer's Codex folders.
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
if [ -e "\${CODEX_HOME:-$HOME/.codex}/at-limit" ]; then echo "You've hit your usage limit." >&2; exit 1; fi
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
// `reached` is Codex's rate_limit_reached_type: it puts a window under 100% at its limit.
const reading = (name, primary, secondary = null, reached = null) => {
  const d = join(dir(name), 'sessions', '2026', '11', '07');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'rollout-2026-11-07T10-00-00-a.jsonl'), `${JSON.stringify({ timestamp: new Date(now - 60000).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: { primary, secondary, plan_type: 'pro', rate_limit_reached_type: reached } } })}\n`);
};
const subs = (...rows) => writeFileSync(SUBS, ['| Tool | Name | Folder | Rule |', '|---|---|---|---|',
  ...rows.map(([name, rule]) => `| codex | ${name} | ${dir(name)} | ${rule} |`)].join('\n') + '\n');
const record = join(T, 'state', 'codex-probe.json');

// AC4: one Codex login and no subscriptions file: codex runs on ~/.codex as it always has, with no
// login checked and no CODEX_HOME set.
reading('default', five(70), week(10));
let r = codex('refuter', 'x');
t('AC4 one login: the call runs, on the caller\'s environment', [r.status, r.calls, r.home], [0, 1, 'unset']);
t('AC4 one login: no sign-in check and no login named', [r.statuses, r.on], [0, null]);
r = codex('probe');
t('AC4 one login: the probe records no login', [r.status, JSON.parse(readFileSync(record, 'utf8')).login], [0, undefined]);
// What a sole login at its limit gives today: codex runs and fails with its own error.
writeFileSync(join(DEFAULT, 'at-limit'), '');
const sole = codex('refuter', 'x');
rmSync(join(DEFAULT, 'at-limit'));
t('one login at its limit: codex runs and fails with its own error', [sole.status, sole.calls, /usage limit/.test(sole.err)], [1, 1, true]);

// The subscriptions file's rule holds for a sole login too: off runs nothing, default and unused run
// on the caller's environment as before.
subs(['default', 'off']);
r = codex('refuter', 'x');
t('sole login off: exit 75, codex is not run, and the reason says the default is off', [r.status, r.calls, /the Codex default, default, is off/.test(r.err)], [75, 0, true]);
r = codex('probe');
t('sole login off: the probe refuses with the same reason rather than standing on its last pass', [r.status, r.calls, /the Codex default, default, is off/.test(r.err)], [75, 0, true]);
for (const rule of ['default', 'unused']) {
  subs(['default', rule]);
  r = codex('refuter', 'x');
  t(`sole login ${rule}: the call runs on the caller's environment, with no sign-in check`, [r.status, r.calls, r.home, r.statuses, r.on], [0, 1, 'unset', 0, null]);
}
// A sole listed login whose folder is gone: its rule still decides, ~/.codex being found does not.
subs(['gone', 'off']);
r = codex('refuter', 'x');
t('sole login off, its folder gone: exit 75 and codex is not run', [r.status, r.calls], [75, 0]);
subs(['gone', 'default']);
r = codex('refuter', 'x');
t('the default\'s folder gone: exit 75, and the call does not move to ~/.codex', [r.status, r.calls, /the Codex default, gone, is not signed in/.test(r.err)], [75, 0, true]);
subs(['default', 'off'], ['gone', 'in rotation']);
r = codex('refuter', 'x');
t('the one login found is off, another row in rotation has no folder: exit 75 and codex is not run', [r.status, r.calls], [75, 0]);
writeFileSync(SUBS, `| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| claude | default | ${join(H, '.claude')} | default |\n`);
r = codex('refuter', 'x');
t('a file listing only Claude logins: the sole Codex login runs on the caller\'s environment as before', [r.status, r.calls, r.home], [0, 1, 'unset']);
rmSync(SUBS);

// More than one Codex login: every call runs on the default, named for the review record.
reading('codex-2', five(60), week(70));
r = codex('refuter', 'x');
t('AC4 a second folder but no subscriptions file: still one login, the caller\'s environment', [r.status, r.home, r.on, r.statuses], [0, 'unset', null, 0]);

// AC1: codex-2 the default, codex-3 unused with more room: the call runs on codex-2's folder.
reading('codex-3', five(5), week(5));
subs(['codex-2', 'default'], ['codex-3', 'unused']);
r = codex('refuter', 'x');
t('AC1 the call runs on the default\'s folder, with CODEX_HOME set for it', [r.status, r.calls, r.home, r.on], [0, 1, dir('codex-2'), 'codex-2']);
subs(['default', 'default'], ['codex-2', 'unused'], ['codex-3', 'unused']);
r = codex('finder', 'x');
t('AC1 a default of ~/.codex runs with no CODEX_HOME, and is named', [r.status, r.home, r.on], [0, 'unset', 'default']);
subs(['codex-2', 'in rotation'], ['codex-3', 'in rotation']);
r = codex('refuter', 'x');
t('AC1 a file in the older rules: the call runs on the default logins list shows, its first in rotation', [r.status, r.home, r.on], [0, dir('codex-2'), 'codex-2']);

// AC2: codex-2, the default, at its weekly limit and codex-3 with room: the call stays on codex-2 and
// fails as a sole login at its limit does.
subs(['codex-2', 'default'], ['codex-3', 'unused']);
reading('codex-2', five(40), week(100, 20), 'secondary');
writeFileSync(join(dir('codex-2'), 'at-limit'), '');
r = codex('refuter', 'x');
t('AC2 the default at its limit: the call runs on it, not on codex-3', [r.calls, r.home, r.on], [1, dir('codex-2'), 'codex-2']);
t('AC2 and the seat\'s result is a sole login\'s at its limit', [r.status, /usage limit/.test(r.err), r.out], [sole.status, true, sole.out]);
rmSync(record, { force: true });
r = codex('probe');
t('AC2 the probe runs on the default at its limit too, and fails', [r.status, r.calls, r.on], [1, 1, 'codex-2']);
rmSync(join(dir('codex-2'), 'at-limit'));

// AC3: codex-3 made the default with desk-env logins default: the next call runs on codex-3.
const made = spawnSync('node', [join(root, 'desk', 'bin', 'desk-env.mjs'), 'logins', 'default', 'codex', 'codex-3'], { env: env(), cwd: T, encoding: 'utf8' });
t('AC3 desk-env logins default codex codex-3 succeeds', made.status, 0);
r = codex('refuter', 'x');
t('AC3 the next call runs on codex-3', [r.status, r.home, r.on], [0, dir('codex-3'), 'codex-3']);
writeFileSync(record, JSON.stringify({ ok: true, at: new Date().toISOString(), login: 'codex-2' }));
r = codex('probe');
t('AC3 the probe runs on codex-3 and records it, a pass on codex-2 not standing',[r.status, r.calls, r.on, JSON.parse(readFileSync(record, 'utf8')).login], [0, 1, 'codex-3', 'codex-3']);
t('a pass under an hour old on the default stands', codex('probe').calls, 0);

// A default that is signed out or off runs no call, and the call does not move to another login.
writeFileSync(join(dir('codex-3'), 'signed-out'), '');
r = codex('refuter', 'x');
t('a signed-out default: exit 75, codex is not run, and the reason names it', [r.status, r.calls, /the Codex default, codex-3, is not signed in/.test(r.err)], [75, 0, true]);
rmSync(join(dir('codex-3'), 'signed-out'));
subs(['codex-2', 'off'], ['codex-3', 'off']);
r = codex('refuter', 'x');
t('every Codex row off: exit 75 and codex is not run', [r.status, r.calls, /is off/.test(r.err)], [75, 0, true]);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'codex login: all checks passed');
process.exit(fails ? 1 : 0);
