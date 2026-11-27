// Runs a command for at most a number of milliseconds, then stops it. It goes inside with-lock.sh, so the
// time it counts starts once the lock is held: a timeout on with-lock.sh itself also counts the wait for
// the lock, and a run that waited behind other suites is stopped before its own tests finish (DS-1053).
//
//   with-lock.sh test --cwd <dir> -- node run-for.mjs <ms> -- sh -c '<command>'
//
// Exits with the command's code, or with 124, having said so on stderr, when the time ran out. The
// command runs in a process group of its own, all of which is stopped: TERM, then KILL 10 s later. A
// TERM, INT or HUP sent to this process (with-lock.sh's caller watch) is passed on to that group.
// with-lock.sh bounds a Jest or `turbo run` it starts (locked-run.mjs bound), and cannot see past this
// wrapper, so under the test, tsc or light lock the bound is added here instead.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bound } from './run-bounds.mjs';
import { limits } from './locked-run.mjs';
import { RUN_FOR_STOPPED, stoppedLine } from './baseline.mjs';

async function cli(argv) {
  const [ms, sep, ...given] = argv;
  if (!/^\d+$/.test(ms ?? '') || sep !== '--' || !given.length) {
    console.error('usage: run-for.mjs <ms> -- <command...>');
    return 2;
  }
  let ws = given;
  if (['test', 'tsc', 'light'].includes(process.env.DESK_LOCK_HELD)) {
    const r = bound(given, await limits());
    for (const x of r.added) console.error(`with-lock.sh: added ${x.flag} to bound ${x.tool === 'jest' ? 'Jest, the test cap' : 'turbo run, the machine profile\'s turbo-concurrency'}`);
    ws = r.words;
  }
  const c = spawn(ws[0], ws.slice(1), { stdio: 'inherit', detached: true });
  const stop = (sig) => { try { process.kill(-c.pid, sig); } catch { /* the group is gone */ } };
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    stop('SIGTERM');
    setTimeout(() => stop('SIGKILL'), 10_000).unref();
  }, Number(ms));
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { stop(s); setTimeout(() => stop('SIGKILL'), 10_000).unref(); });
  return new Promise((resolve) => {
    c.on('error', (e) => { clearTimeout(timer); console.error(`run-for.mjs: ${e.message}`); resolve(127); });
    c.on('exit', (code, sig) => {
      clearTimeout(timer);
      if (!late) return resolve(code ?? 128 + (constants.signals[sig] ?? 0));
      stop('SIGKILL');
      console.error(stoppedLine(ms));
      resolve(RUN_FOR_STOPPED);
    });
  });
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(await cli(process.argv.slice(2)));
