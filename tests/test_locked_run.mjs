// suite: locked-run (with-lock.sh bounds the Jest or turbo run it starts, holds installs to one slot, and logs a run's memory peak)
// layer: L2
// covers: desk/bin/run-bounds.mjs desk/bin/locked-run.mjs desk/bin/with-lock.sh desk/bin/leases.mjs desk/bin/desk-q.mjs desk/bin/machine.mjs
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { analyse, bound, unbounded } from '../desk/bin/run-bounds.mjs';
import { usedGiB } from '../desk/bin/locked-run.mjs';
import { readLog } from '../desk/bin/leases.mjs';
import { heaviestRuns } from '../desk/bin/desk-q.mjs';
import { propose, sizingSettingError } from '../desk/bin/machine.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'desk', 'bin', 'with-lock.sh');

// ---- the bound, as a function ------------------------------------------------------------------
const L = { jest: 4, turbo: 1 };
const scripts = { test: 'jest --ci', typecheck: 'turbo run typecheck', capped: 'jest --maxWorkers=2', both: 'jest && eslint .', lint: 'eslint .' };
const b = (ws) => bound(ws, L, { scripts }).words.join(' ');
t('#1526 AC1 a direct jest gets the test cap', b(['jest', 'src']), 'jest src --maxWorkers=4');
t('#1526 AC1 so does one behind env, a runner or VAR=value words', [b(['env', 'CI=1', 'jest']), b(['npx', 'jest']), b(['pnpm', 'exec', 'jest']), b(['NODE_OPTIONS=--x', 'jest'])],
  ['env CI=1 jest --maxWorkers=4', 'npx jest --maxWorkers=4', 'pnpm exec jest --maxWorkers=4', 'NODE_OPTIONS=--x jest --maxWorkers=4']);
t('#1526 AC1 a package.json script that starts jest gets it after the script', [b(['bun', 'run', 'test']), b(['pnpm', 'test']), b(['yarn', 'run', 'test', 'src/a.test.ts'])],
  ['bun run test --maxWorkers=4', 'pnpm test --maxWorkers=4', 'yarn run test src/a.test.ts --maxWorkers=4']);
t('#1526 AC1 npm takes it after --, once', [b(['npm', 'test']), b(['npm', 'run', 'test', '--', 'a.ts'])], ['npm test -- --maxWorkers=4', 'npm run test -- a.ts --maxWorkers=4']);
t('#1526 AC1 a cap already set, in the command or the script, is left alone', [b(['jest', '--maxWorkers=2']), b(['jest', '-w', '2']), b(['bun', 'run', 'test', '--maxWorkers=50%']), b(['bun', 'run', 'capped'])],
  ['jest --maxWorkers=2', 'jest -w 2', 'bun run test --maxWorkers=50%', 'bun run capped']);
t('#1526 AC2 turbo run gets its concurrency, directly or through a script', [b(['turbo', 'run', 'test']), b(['bun', 'run', 'typecheck'])], ['turbo run test --concurrency=1', 'bun run typecheck --concurrency=1']);
t('#1526 a bound goes in before the command\'s own --, which a flag after it does not count as set', [b(['turbo', 'run', 'test', '--', '--ci']), b(['jest', '--', 'a.test.ts']), b(['jest', '--', '--maxWorkers=2'])],
  ['turbo run test --concurrency=1 -- --ci', 'jest --maxWorkers=4 -- a.test.ts', 'jest --maxWorkers=4 -- --maxWorkers=2']);
t('#1526 sh -c bounds before its --, and leaves a quoted string it would have to rejoin alone', [bound(['sh', '-c', 'turbo run test -- --ci'], L, { scripts }).words[2], bound(['sh', '-c', 'jest -- "a b.test.ts"'], L, { scripts }).words[2]],
  ['turbo run test --concurrency=1 -- --ci', 'jest -- "a b.test.ts"']);
t('#1526 npm keeps flags before its -- for itself, so they set no bound', [b(['npm', 'test', '--maxWorkers=2']), b(['npm', 'test', '-w', 'web']), b(['npm', 'test', '--', '-w', '2'])],
  ['npm test --maxWorkers=2 -- --maxWorkers=4', 'npm test -w web -- --maxWorkers=4', 'npm test -- -w 2']);
t('#1526 npm passing a second -- on to the script gets nothing', [b(['npm', 'test', '--', '--', 'a.test.ts']), b(['npm', 'test', '--', '--', '--maxWorkers=2'])],
  ['npm test -- -- a.test.ts', 'npm test -- -- --maxWorkers=2']);
t('#1526 a script holding --, or another runner given --, gets nothing', [bound(['bun', 'run', 'dashed'], L, { scripts: { dashed: 'turbo run test -- --ci' } }).added, b(['pnpm', 'test', '--', 'x'])], [[], 'pnpm test -- x']);
t('#1526 AC2 a concurrency already set is left alone', b(['turbo', 'run', 'test', '--concurrency=4']), 'turbo run test --concurrency=4');
t('#1526 a script that is not one simple command, bun test, or another tool gets nothing', [b(['bun', 'run', 'both']), b(['bun', 'test']), b(['bun', 'run', 'lint']), b(['pytest', '-x']), b(['turbo', 'test'])],
  ['bun run both', 'bun test', 'bun run lint', 'pytest -x', 'turbo test']);
t('#1526 sh -c with one simple command is bounded inside its string', bound(['sh', '-c', 'bun run test'], L, { scripts }).words, ['sh', '-c', 'bun run test --maxWorkers=4']);
t('#1526 sh -c with a compound string is left alone', bound(['sh', '-c', 'jest && true'], L, { scripts }).words, ['sh', '-c', 'jest && true']);
t('#1526 no limit for the tool adds nothing', bound(['turbo', 'run', 'test'], { jest: 4, turbo: null }, { scripts }).added, []);
t('#1526 analyse names the script a run goes through', analyse(['bun', 'run', 'test'], { scripts })?.via, 'test');
t('#1526 AC4 unbounded proposes the default bounds with no limits', unbounded('turbo run lint', { root: null }), { tool: 'turbo', why: 'starts turbo run with no --concurrency', bounded: 'turbo run lint --concurrency=1' });

// ---- the machine profile row -------------------------------------------------------------------
const hw = { 'cpu-cores': '16', 'performance-cores': '16', 'efficiency-cores': '0', 'memory-gb': '32', wsl: 'yes' };
t('#1526 AC2 the proposal sets turbo-concurrency to 1', propose(hw).find((r) => r.key === 'turbo-concurrency')?.value, '1');
t('#1526 AC2 a hand-set turbo-concurrency is checked', [sizingSettingError('turbo-concurrency', '2'), sizingSettingError('turbo-concurrency', '0') != null], [null, true]);

// ---- with-lock.sh, on fixture commands ---------------------------------------------------------
const S = scratch('locked-run-');
const bin = join(S, 'bin'), app = join(S, 'app'), locks = join(S, 'locks'), leases = join(S, 'leases');
for (const d of [bin, app, locks, leases]) mkdirSync(d, { recursive: true });
for (const tool of ['bun', 'turbo', 'eslint']) {
  writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*"\n`);
  chmodSync(join(bin, tool), 0o755);
}
writeFileSync(join(app, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
const profile = join(S, 'machine.md');
writeFileSync(profile, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `test-cap` | `4` | test |\n| `turbo-concurrency` | `1` | test |\n');
const env = (extra = {}) => {
  const e = { ...process.env, HOME: S, PATH: `${bin}:${process.env.PATH}`, DESK_LOCK_DIR: locks, DESK_LEASE_DIR: leases, DESK_MACHINE: profile,
    DESK_CONFIG: join(S, 'no-config.md'), DESK_RUN_PEAK: 'off', ...extra };
  for (const k of ['DESK_TEST_LOCK_SLOTS', 'DESK_LOCK_HELD', 'DESK_EXIT_KEY', 'TEST_JOB_TOKENS', 'DESK_AUTOPILOT_WORKER']) if (!(k in extra)) delete e[k];
  return e;
};
const wl = (args, extra) => spawnSync('bash', [script, ...args], { cwd: app, env: env(extra), encoding: 'utf8' });

let r = wl(['test', '--', 'bun', 'run', 'test']);
t('#1526 AC1 a fixture `bun run test` whose script is jest starts with --maxWorkers=4', [r.status, r.stdout.trim()], [0, 'bun run test --maxWorkers=4']);
t('#1526 AC1 and with-lock.sh says it added the cap', r.stderr.includes('with-lock.sh: added --maxWorkers=4 to bound Jest, the test cap'), true);
r = wl(['test', '--', 'turbo', 'run', 'test']);
t('#1526 AC2 a fixture `turbo run test` starts with --concurrency=1', r.stdout.trim(), 'turbo run test --concurrency=1');
r = wl(['tsc', '--', 'turbo', 'run', 'typecheck', '--concurrency=3']);
t('#1526 AC2 a typecheck that sets its own concurrency runs as given', r.stdout.trim(), 'turbo run typecheck --concurrency=3');
r = wl(['browser', '--', 'turbo', 'run', 'test']);
t('#1526 a browser run is never bounded', r.stdout.trim(), 'turbo run test');

// AC3: the install lock is one slot, whatever the test lock's slots.
const go = join(S, 'go'), started = join(S, 'started');
const first = spawn('bash', [script, 'install', '--', 'sh', '-c', `: > "${started}"; while [ ! -f "${go}" ]; do sleep 0.05; done; echo "$DESK_LOCK_CLASS"`], { cwd: app, env: env({ DESK_TEST_LOCK_SLOTS: '3' }) });
let firstOut = '';
first.stdout.on('data', (c) => { firstOut += c; });
const firstDone = new Promise((res) => first.on('exit', res));
for (let i = 0; i < 200 && !existsSync(started); i++) spawnSync('sleep', ['0.05']);
r = wl(['install', '--timeout', '0', '--', 'true'], { DESK_TEST_LOCK_SLOTS: '3' });
t('#1526 AC3 a second install waits while one holds the install lock', [r.status, /gave up waiting for the install lock/.test(r.stderr)], [75, true]);
writeFileSync(go, '');
await firstDone;
t('#1526 AC3 the install ran under the install lock', firstOut.trim(), 'install');

// AC5: a measured run logs its peak against its ticket and step, and keeps its exit status.
r = wl(['test', '--', 'sh', '-c', 'sleep 0.2; exit 3'], { DESK_RUN_PEAK: 'on', DESK_PEAK_SAMPLE_MS: '20', DESK_EXIT_KEY: 'T-1526' });
t('#1526 AC5 a measured run exits with its command\'s status', r.status, 3);
r = wl(['tsc', '--', 'eslint', '.'], { DESK_RUN_PEAK: 'on', DESK_PEAK_SAMPLE_MS: '20' });
t('#1526 AC5 and passes its output through', r.stdout.trim(), 'eslint .');
const peaks = readLog({ dir: leases }).peaks;
const seen = peaks.map((e) => [e.ticket, e.step, e.class, e.code, typeof e.peak_rss_gb, e.worktree]);
const reads = usedGiB() != null;
t('#1526 AC5 each measured run is one release line with its ticket, step, exit and peak', seen,
  reads ? [['T-1526', 'test', 'test', 3, 'number', realpathSync(app)], [null, 'lint', 'tsc', 0, 'number', realpathSync(app)]] : []);
r = wl(['test', '--', 'true']);
t('#1526 AC5 an unmeasured run logs no peak', readLog({ dir: leases }).peaks.length, peaks.length);
t('#1526 AC5 usedGiB reads MemTotal less MemAvailable', usedGiB('MemTotal: 4194304 kB\nMemFree: 1 kB\nMemAvailable: 1048576 kB\n'), 3);

// desk-q's note names the heaviest runs of the last day, heaviest first.
const now = Date.parse('2026-11-26T12:00:00Z');
const at = (h) => new Date(now - h * 3600e3).toISOString();
const note = heaviestRuns([
  { at: at(1), ticket: 'SV-1', step: 'test', peak_rss_gb: 9.5 }, { at: at(2), ticket: null, worktree: '/w/SV-2', step: 'tsc', peak_rss_gb: 14.4 },
  { at: at(3), ticket: 'SV-3', step: 'lint', peak_rss_gb: 3.1 }, { at: at(4), ticket: 'SV-4', step: 'test', peak_rss_gb: 2 }, { at: at(30), ticket: 'SV-5', step: 'test', peak_rss_gb: 20 },
], now);
t('#1526 AC5 desk-q names the three heaviest locked runs of the last day', note?.replace(/ at \d\d:\d\d/g, ''), 'Heaviest locked runs today: SV-2 typecheck 14.4 GB, SV-1 test run 9.5 GB, SV-3 lint run 3.1 GB.');
t('#1526 AC5 and nothing with no runs', heaviestRuns([], now), null);

console.log(fails ? `locked-run: ${fails} failed` : 'locked-run: all passed');
process.exitCode = fails ? 1 : 0;
