// One `codex exec` call, run the way every desk caller runs it: stdin closed, so it never waits on a
// terminal; its final message read from its --output-last-message file, never from the progress it
// prints; the model and effort on the command line, so ~/.codex/config.toml's own never apply; and at
// the timeout, ended with its whole process group (SIGTERM, then SIGKILL after KILL_GRACE_MS).
//
// desk-codex.mjs (the review's read-only calls) and bench-arm3.mjs (the bench's implementation runs)
// both call codexExec. A synchronous caller runs this file instead, with the call as JSON on stdin:
//   node codex-exec.mjs   < {"args": [...], "last": "<file>", "cwd": "<dir>", "timeout": <seconds>}
// and reads one JSON line back: {"code", "timedOut", "message", "tail", "error"}.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const KILL_GRACE_MS = 5000;
const EXIT_FOR = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

// The exec arguments. `config` items are extra `-c key=value` overrides, after the effort.
export function execArgs({ sandbox, cd = null, model, effort, last, prompt, config = [] }) {
  return ['exec', '--sandbox', sandbox, '--skip-git-repo-check', ...(cd ? ['--cd', cd] : []),
    '-m', model, '-c', `model_reasoning_effort="${effort}"`, ...config.flatMap((c) => ['-c', c]),
    '--output-last-message', last, '--', prompt];
}

// Runs codex with `args` (whose --output-last-message is `last`).
//   -> Promise<{ code, timedOut, message, tail, error }>: `tail` is the end of codex's stderr, `error`
//      why it did not start (code 127), else null.
export function codexExec({ args, last, env = process.env, cwd = undefined, timeout }) {
  return new Promise((resolve) => {
    const child = spawn('codex', args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true, env, cwd });
    let tail = '';
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; group('SIGTERM'); setTimeout(() => group('SIGKILL'), KILL_GRACE_MS).unref(); }, timeout * 1000);
    const handlers = Object.keys(EXIT_FOR).map((sig) => [sig, () => { group('SIGKILL'); process.exit(128 + EXIT_FOR[sig]); }]);
    for (const [sig, h] of handlers) process.on(sig, h);
    let settled = false;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [sig, h] of handlers) process.off(sig, h);
      resolve(r);
    };
    child.on('error', (e) => settle({ code: 127, timedOut: false, message: '', tail, error: e.message }));
    child.on('close', (code, signal) => {
      // codex itself has closed, but a descendant that ignored the SIGTERM would outlive the grace
      // timer, which is unref'd: end the group now.
      if (timedOut) group('SIGKILL');
      let message = '';
      try { message = readFileSync(last, 'utf8'); } catch { /* no final message */ }
      settle({ code: code ?? (signal ? 128 : 1), timedOut, message, tail, error: null });
    });
  });
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  let call;
  try {
    call = JSON.parse(readFileSync(0, 'utf8'));
    if (!Array.isArray(call.args) || typeof call.last !== 'string' || !(Number(call.timeout) > 0)) throw new Error('want {"args": [...], "last": "<file>", "timeout": <seconds>}');
  } catch (e) {
    console.error(`codex-exec: ${e.message}`);
    process.exit(2);
  }
  codexExec({ ...call, timeout: Number(call.timeout) }).then((r) => { process.stdout.write(`${JSON.stringify(r)}\n`); });
}
