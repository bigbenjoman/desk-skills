// suite: desk-codex (codex review calls: final message only, timed out, no stdin, model and effort per role)
// covers: desk/bin/desk-codex.mjs
// A fake codex on PATH records its argv and behaves as $T/mode says: answer (progress, then a final
// message), hang, read stdin, or fail. Scratch config and state only.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseCodexReview } from '../desk/bin/desk-env.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'desk', 'bin', 'desk-codex.mjs');

// Config §3b "Codex review".
const parse = (...items) => { try { return JSON.stringify(parseCodexReview(items)); } catch (e) { return e.message; } };
t('row unset: gpt-6.1-sol, finder at medium, refuter at low, 600s', parse(), '{"finder":{"model":"gpt-6.1-sol","effort":"medium"},"refuter":{"model":"gpt-6.1-sol","effort":"low"},"timeout":600}');
t('row none reads as unset', parse('none'), parse());
t('each role and the timeout set', parse('finder=a:high refuter=b:minimal timeout=90'), '{"finder":{"model":"a","effort":"high"},"refuter":{"model":"b","effort":"minimal"},"timeout":90}');
t('a role left out keeps its default', JSON.parse(parse('finder=a:high')).refuter, { model: 'gpt-6.1-sol', effort: 'low' });
t('an unknown effort is refused, naming it and the row', /Codex review.*unknown effort `turbo`/.test(parse('finder=a:turbo')), true);
t('an unknown role is refused', /unknown role `probe`/.test(parse('probe=a:low')), true);
t('a timeout that is not whole seconds is refused', /timeout `1.5`/.test(parse('timeout=1.5')), true);
t('a role named twice is refused', /`finder` is named twice/.test(parse('finder=a:low finder=b:low')), true);

const T = mkdtempSync(join(tmpdir(), 'desk-codex-'));
for (const d of ['bin', 'state']) mkdirSync(join(T, d), { recursive: true });
const fake = join(T, 'bin', 'codex');
writeFileSync(fake, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${T}/argv"
echo x >> "${T}/calls"
out=""; prev=""
for a in "$@"; do [ "$prev" = --output-last-message ] && out="$a"; prev="$a"; done
case "$(cat "${T}/mode")" in
  answer) echo "progress: reading files"; echo "tokens used: 42" >&2; printf 'FINAL ANSWER\\nsecond line\\n' > "$out" ;;
  probe) echo "progress"; echo CODEX_OK > "$out" ;;
  hang) echo $$ > "${T}/pid"; sleep 30 & echo $! > "${T}/sleep"; wait ;;
  stubborn) ( trap '' TERM; exec sleep 30 ) </dev/null >/dev/null 2>&1 & echo $! > "${T}/stubborn"; wait ;;
  long) head -c 300000 /dev/zero | tr '\\0' a > "$out" ;;
  stdin) if IFS= read -r line; then echo "STDIN:$line" > "$out"; else echo "NO STDIN" > "$out"; fi ;;
  fail) echo "You've hit your usage limit." >&2; exit 1 ;;
esac
`);
chmodSync(fake, 0o755);
const mode = (m) => writeFileSync(join(T, 'mode'), m);
const config = (name, levers, row = '') => {
  const p = join(T, `${name}.md`);
  writeFileSync(p, `## 0. Repo
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
| Phase 0 levers | \`none\` | ${levers} |
${row}
`);
  return p;
};
const ON = config('on', '`codex`', '| Codex review | `none` | `finder=m-find:medium refuter=m-ref:low timeout=2` |');
const OFF = config('off', '`none`');
const env = (cfg) => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete e[k];
  return { ...e, PATH: `${join(T, 'bin')}:${process.env.PATH}`, DESK_CONFIG: cfg, DESK_AUTOPILOT_STATE: join(T, 'state') };
};
const codex = (args, { cfg = ON, input } = {}) => {
  rmSync(join(T, 'calls'), { force: true });
  const start = Date.now();
  const r = spawnSync('node', [SCRIPT, ...args], { env: env(cfg), encoding: 'utf8', timeout: 30000, ...(input == null ? {} : { input }) });
  const calls = existsSync(join(T, 'calls')) ? readFileSync(join(T, 'calls'), 'utf8').trim().split('\n').length : 0;
  return { status: r.status, out: r.stdout, err: r.stderr, secs: (Date.now() - start) / 1000, calls };
};
const argv = () => readFileSync(join(T, 'argv'), 'utf8').trim().split('\n');
const record = join(T, 'state', 'codex-probe.json');
const alive = (pidFile) => { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0); return true; } catch { return false; } };

// AC1: what is read is the final message, and nothing else.
mode('answer');
let r = codex(['refuter', 'Refute this finding: a.ts:1 drops the error']);
t('AC1 stdout is the final message alone, with no progress or log line', [r.status, r.out], [0, 'FINAL ANSWER\nsecond line\n']);
t('AC1 and nothing of codex on stderr', /progress|tokens used/.test(r.err), false);
t('every call is a read-only exec that skips the git check', argv().slice(0, 4), ['exec', '--sandbox', 'read-only', '--skip-git-repo-check']);
t('the prompt is passed after --, as one argument', argv().slice(-2), ['--', 'Refute this finding: a.ts:1 drops the error']);

// AC4: each role at the model and effort the row names.
const pair = (flag) => argv()[argv().indexOf(flag) + 1];
t('AC4 the refuter runs at its model and effort', [pair('-m'), pair('-c')], ['m-ref', 'model_reasoning_effort="low"']);
r = codex(['finder', '--cd', T, 'Read the review brief in b.txt']);
t('AC4 the finder runs at its model and effort', [r.status, pair('-m'), pair('-c')], [0, 'm-find', 'model_reasoning_effort="medium"']);
t('--cd is passed on to codex', pair('--cd'), T);
r = codex(['settings']);
t('AC4 settings prints what each role runs at, for the review record', r.out, 'finder=m-find:medium refuter=m-ref:low timeout=2\n');

// AC3: codex never reads input, even when the caller has some.
mode('stdin');
r = codex(['refuter', 'x'], { input: 'an answer typed at a prompt\n' });
t('AC3 codex reads no stdin', r.out, 'NO STDIN\n');

// AC2: a call still running at the timeout is ended, with what it started.
mode('hang');
r = codex(['finder', 'x']);
t('AC2 a hung call is ended at the timeout, exit 124', [r.status, r.secs < 10], [124, true]);
t('AC2 it says timed out, and prints no answer', [/timed out after 2s/.test(r.err), r.out], [true, '']);
t('AC2 codex and its children are gone', [alive(join(T, 'pid')), alive(join(T, 'sleep'))], [false, false]);
mode('stubborn');
r = codex(['finder', 'x']);
const gone = (pidFile) => { const end = Date.now() + 2000; while (alive(pidFile) && Date.now() < end) spawnSync('sleep', ['0.1']); return !alive(pidFile); };
t('AC2 a child that ignores the end signal is killed too, once codex has closed', [r.status, gone(join(T, 'stubborn'))], [124, true]);

// AC1: a final message larger than a pipe buffer reaches the caller whole.
mode('long');
r = codex(['refuter', 'x']);
t('AC1 a long final message is not cut short', [r.status, r.out.length], [0, 300001]);

// A failure passes codex's exit and its error through.
mode('fail');
r = codex(['refuter', 'x']);
t('a failed call exits with codex\'s code and names its error', [r.status, /usage limit/.test(r.err), r.out], [1, true, '']);

// AC5 and AC8: a passing probe under an hour old stands; a failure never does.
mode('probe');
rmSync(record, { force: true });
r = codex(['probe']);
t('with no record the probe runs', [r.status, r.out, r.calls], [0, 'CODEX_OK\n', 1]);
t('the probe names what each role runs at', /finder m-find at medium · refuter m-ref at low · timeout 2s/.test(r.err), true);
t('a pass is recorded', JSON.parse(readFileSync(record, 'utf8')).ok, true);
r = codex(['probe']);
t('AC5 a pass under an hour old: no new probe', [r.status, r.out, r.calls], [0, 'CODEX_OK\n', 0]);
writeFileSync(record, JSON.stringify({ ok: true, at: new Date(Date.now() - 61 * 60000).toISOString() }));
t('a pass over an hour old: the probe runs', codex(['probe']).calls, 1);
writeFileSync(record, JSON.stringify({ ok: false, at: new Date().toISOString() }));
r = codex(['probe']);
t('AC8 a failure under an hour old: the probe runs', [r.status, r.calls], [0, 1]);
mode('fail');
codex(['refuter', 'x']);
t('a failed call clears the pass', JSON.parse(readFileSync(record, 'utf8')).ok, false);
mode('probe');
t('so the next probe runs', codex(['probe']).calls, 1);

// AC7: with the lever off nothing runs through here.
r = codex(['probe'], { cfg: OFF });
t('AC7 lever off: refused, and codex is not run', [r.status, r.calls, /codex lever is off/.test(r.err)], [3, 0, true]);
t('a flag in the role\'s place is refused', codex(['-m', 'x', 'finder', 'y']).status, 2);
t('a second prompt is refused rather than passed on', codex(['finder', 'a', '--model', 'b']).status, 2);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'desk-codex: all checks passed');
process.exit(fails ? 1 : 0);
