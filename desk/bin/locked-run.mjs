// What with-lock.sh does to the command it runs under the test lock: it bounds the command's workers,
// and on WSL it measures the guest's memory while the command runs.
//
//   node locked-run.mjs bound <lock> -- <command...>   # the command's words, NUL-separated, with
//                                                      # run-bounds.mjs's bound added where it needs one
//   node locked-run.mjs run <lock> -- <command...>     # runs the command as a child and logs its
//                                                      # guest memory peak in the lease log
//
// Jest's bound is the test cap (config §3b, else the machine profile's test-cap), turbo's the
// profile's turbo-concurrency, 1 on WSL where that row is unset; each says so on stderr when added.
//
// The run's peak is the guest's used memory (MemTotal - MemAvailable, the reading `desk-env mem`
// calls avail), sampled every second, logged once the command exits as a `release` line in the lease
// log with the ticket (the worker's DESK_EXIT_KEY) and the step (test, tsc or lint) it ran.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bound } from './run-bounds.mjs';

const GIB = 2 ** 30;
const whole = (v) => (/^\d+$/.test(String(v ?? '').trim()) && Number(v) >= 1 ? Number(v) : null);

// Whether this computer runs WSL: config §2 "Running on WSL?" where a config reads, else its kernel.
function onWsl(E) {
  try { return E.isWSL(); } catch { /* no config here */ }
  try { return /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8')); } catch { return false; }
}
// -> { jest, turbo }, each a whole number or null.
export async function limits() {
  const E = await import('./desk-env.mjs');
  let cap = null;
  try { cap = whole(E.configValue('test-cap')); } catch { /* no config here */ }
  cap ??= whole(E.machineValue('test-cap'));
  return { jest: cap, turbo: whole(E.machineValue('turbo-concurrency')) ?? (onWsl(E) ? 1 : null) };
}

// The guest's used memory now in GiB, or null where /proc/meminfo does not read.
export function usedGiB(text = null) {
  try {
    const m = Object.fromEntries((text ?? readFileSync('/proc/meminfo', 'utf8')).split('\n').map((l) => /^(\w+):\s+(\d+)/.exec(l)).filter(Boolean).map((x) => [x[1], Number(x[2]) * 1024]));
    return m.MemTotal && m.MemAvailable != null ? (m.MemTotal - m.MemAvailable) / GIB : null;
  } catch { return null; }
}
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

// Runs `ws` as a child with this process's stdio and the lock's descriptor (fd 9, where flock holds
// it), so the child keeps the lock if this process is killed; samples the guest's used memory until
// it exits, passing signals on, then logs the peak. -> the exit code to leave with.
async function runMeasured(lock, ws) {
  // with-lock.sh says when it holds fd 9 (DESK_RUN_FD9=1). An fstat here cannot tell: node opens
  // descriptors of its own at start (kqueue and pipes on macOS), so fd 9 can be node's, and passing
  // that on makes spawn fail with EBADF before the command runs.
  const fd9 = process.env.DESK_RUN_FD9 === '1';
  delete process.env.DESK_RUN_FD9;
  const stdio = ['inherit', 'inherit', 'inherit', ...(fd9 ? [null, null, null, null, null, null, 9] : [])];
  const every = whole(process.env.DESK_PEAK_SAMPLE_MS) ?? 1000;
  const t0 = Date.now();
  const start = usedGiB();
  let peak = start;
  const sample = () => { const u = usedGiB(); if (u != null && (peak == null || u > peak)) peak = u; };
  const timer = setInterval(sample, every);
  const child = spawn(ws[0], ws.slice(1), { stdio });
  for (const sig of Object.keys(SIGNALS).filter((s) => s !== 'SIGKILL')) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  const code = await new Promise((res) => {
    child.on('error', (e) => { console.error(`with-lock.sh: ${ws[0]}: ${e.message}`); res(127); });
    child.on('exit', (c, s) => res(c ?? 128 + (SIGNALS[s] ?? 0)));
  });
  clearInterval(timer);
  sample();
  let step = lock;
  try { if (lock === 'tsc' && (await import('./slot-lease.mjs')).isLint(ws)) step = 'lint'; } catch { /* a typecheck, as far as it reads */ }
  const { logEvent } = await import('./leases.mjs');
  logEvent({ event: 'release', kind: 'slot', key: step, class: lock, step, ticket: process.env.DESK_EXIT_KEY || null,
    worktree: process.cwd(), cmd: ws.join(' ').slice(0, 160), secs: Math.round((Date.now() - t0) / 1000), code,
    start_gb: round1(start), peak_rss_gb: round1(peak) });
  return code;
}

async function cli(argv) {
  const [sub, lock, sep, ...ws] = argv;
  if (!['bound', 'run'].includes(sub) || !lock || sep !== '--' || !ws.length) {
    console.error('usage: locked-run.mjs bound|run <lock> -- <command...>'); return 2;
  }
  if (sub === 'run') return runMeasured(lock, ws);
  const r = bound(ws, await limits());
  for (const x of r.added) console.error(`with-lock.sh: added ${x.flag} to bound ${x.tool === 'jest' ? 'Jest, the test cap' : 'turbo run, the machine profile\'s turbo-concurrency'}`);
  process.stdout.write(r.words.map((w) => `${w}\0`).join(''));
  return 0;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exitCode = await cli(process.argv.slice(2));
