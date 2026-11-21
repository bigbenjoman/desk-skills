// One `codex exec` call, run the way every desk caller runs it: stdin closed, so it never waits on a
// terminal; its final message read from its --output-last-message file, never from the progress it
// prints; the model and effort on the command line, so ~/.codex/config.toml's own never apply; and at
// the timeout, ended with its whole process group (SIGTERM, then SIGKILL after KILL_GRACE_MS).
//
// desk-codex.mjs (the review's read-only calls) and bench-arm3.mjs (the bench's implementation runs)
// both call codexExec. A synchronous caller runs this file instead, with the call as JSON on stdin:
//   node codex-exec.mjs   < {"args": [...], "last": "<file>", "cwd": "<dir>", "timeout": <seconds>}
// and reads one JSON line back: {"code", "timedOut", "message", "tail", "error"}.
//
// A review's finder or refuter call with the codex lever off runs this file's review form, the one
// form a worker may run, since its codex arguments are fixed here and never read from the caller:
//   node codex-exec.mjs review [--cd <dir>] <prompt>
// `codex exec --sandbox read-only --skip-git-repo-check`, at ~/.codex/config.toml's model and effort,
// ended at config §3b Codex review's timeout. Stdout is codex's final message alone. Exit: codex's own,
// 124 timed out (`codex-exec: timed out after <n>s` on stderr: the review records the seat as died,
// "timed out"), 127 codex did not start, 1 no final message, 2 usage.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KILL_GRACE_MS = 5000;
const EXIT_FOR = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

// The exec arguments. `config` items are extra `-c key=value` overrides, after the effort. With no
// model, neither model nor effort is passed, so ~/.codex/config.toml's apply.
export function execArgs({ sandbox, cd = null, model = null, effort, last, prompt, config = [] }) {
  return ['exec', '--sandbox', sandbox, '--skip-git-repo-check', ...(cd ? ['--cd', cd] : []),
    ...(model ? ['-m', model, '-c', `model_reasoning_effort="${effort}"`] : []), ...config.flatMap((c) => ['-c', c]),
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

// A review call's `[--cd <dir>] <prompt>`, for this file's review form and desk-codex's roles: a --cd
// that is not a directory exits 2, and anything but one non-empty prompt runs `usage`.
export function cdAndPrompt(rest, say, usage) {
  let cd = null;
  if (rest[0] === '--cd') {
    cd = rest[1];
    try { if (!cd || !statSync(cd).isDirectory()) throw new Error(); } catch { say(`--cd ${cd ?? ''} is not a directory`); process.exit(2); }
    rest = rest.slice(2);
  }
  if (rest.length !== 1 || !rest[0].trim()) usage();
  return { cd, prompt: rest[0] };
}

// One read-only review call, its final message read from a scratch file removed afterwards. With no
// model, ~/.codex/config.toml's model and effort apply. -> codexExec's result.
export async function readOnlyCall({ prompt, cd = null, model = null, effort, env, timeout }) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-review-'));
  const last = join(dir, 'last-message.txt');
  try { return await codexExec({ args: execArgs({ sandbox: 'read-only', cd, model, effort, last, prompt }), last, env, timeout }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

// A review call's outcome, as a CLI reports it: the final message on stdout, why it failed on stderr
// (`label` after each reason), and the exit code: 127 not started, 124 timed out, codex's own, 1 an
// answer `refuse` turns down (by default an empty one). Sets process.exitCode, never process.exit: a
// pipe write on macOS is asynchronous, and exiting at once would cut a long final message short.
//   -> whether codex answered
export function reportCall({ code, timedOut, message, tail, error }, { say, timeout, label = '', refuse = (m) => (m.trim() ? null : 'with no final message') }) {
  const at = label ? ` (${label})` : '';
  if (error) { say(`codex did not start: ${error}`); process.exitCode = 127; return false; }
  if (timedOut) { say(`timed out after ${timeout}s${at}`); process.exitCode = 124; return false; }
  if (message) process.stdout.write(message.endsWith('\n') ? message : `${message}\n`);
  if (code !== 0) { say(`codex exited ${code}${at}: ${tail.trim().split('\n').slice(-5).join(' | ') || 'no error text'}`); process.exitCode = code; return false; }
  const why = refuse(message);
  if (why) { say(`codex answered ${why}${at}`); process.exitCode = 1; return false; }
  process.exitCode = 0;
  return true;
}

// The review form: a read-only call whose arguments only this file sets.
async function review(rest) {
  const say = (m) => process.stderr.write(`codex-exec: ${m}\n`);
  const { cd, prompt } = cdAndPrompt(rest, say, () => { say('usage: codex-exec.mjs review [--cd <dir>] <prompt>'); process.exit(2); });
  let timeout;
  try { timeout = (await import('./desk-env.mjs')).codexReview().timeout; } catch (e) { say(e.message); process.exit(2); }
  reportCall(await readOnlyCall({ prompt, cd, timeout }), { say, timeout });
}

if (isMain && process.argv[2] === 'review') review(process.argv.slice(3));
else if (isMain) {
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
