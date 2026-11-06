#!/usr/bin/env node
// A worker's push, retried while GitHub answers with a 5xx. A worker's Bash call stops at ten
// minutes, so one run stays inside that and a second run, `--more`, carries on with the long waits:
//   node push-retry.mjs [--more] [-u | --set-upstream | --force-with-lease] origin <branch>
// Exit 0 pushed; 75 GitHub still answers 5xx; anything else is git's own refusal, never retried.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const TRANSIENT_EXIT = 75;
const FIRST_WAITS = [30, 60, 120, 240];
const MORE_WAITS = [240, 240];
// Past this no wait starts, which leaves a slow pre-push hook room inside the Bash call's ten minutes.
const RUN_LIMIT_S = 540;

const REASON = '(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)';
// Only the lines git and the remote write: a failing pre-push check can print anything.
const GIT_5XX = [
  new RegExp(`^\\s*! \\[remote rejected\\].*\\((?:(?:HTTP )?5\\d\\d\\b[^)]*|${REASON})\\)\\s*$`, 'i'),
  /^(?:fatal|error): .*(?:RPC failed; HTTP 5\d\d\b|The requested URL returned error: 5\d\d\b)/i,
  new RegExp(`^remote: .*\\b${REASON}`, 'i'),
];
const HOOK_FAILED = /^pre-push: FAIL\b/m;

// Did this refused push fail on a server error, rather than on a check, a rule or the branch's history?
export function transientPush(out) {
  const s = String(out ?? '');
  return !HOOK_FAILED.test(s) && s.split('\n').some((l) => GIT_5XX.some((re) => re.test(l)));
}

// {more, push} from the CLI's arguments, or null for any other shape: this runs only the pushes a
// worker's settings allow.
export function parseArgs(argv) {
  const a = [...argv];
  const more = a[0] === '--more';
  if (more) a.shift();
  const flag = ['-u', '--set-upstream', '--force-with-lease'].includes(a[0]) ? [a.shift()] : [];
  if (a.length !== 2 || a[0] !== 'origin' || !a[1] || a[1].startsWith('-') || a[1].startsWith('+')) return null;
  return { more, push: ['push', ...flag, ...a] };
}

// git(args) → {status, out}; sleep(ms), now() and say(line) as the CLI gives them. → the exit code.
export async function pushWithRetry({ more, push }, { git, sleep, now, say }) {
  const waits = more ? MORE_WAITS : FIRST_WAITS;
  const began = now();
  for (let tries = 1; ; tries += 1) {
    const r = git(push);
    if (r.status === 0) return 0;
    if (!transientPush(r.out)) return r.status || 1;
    const secs = waits[tries - 1];
    const spent = Math.round((now() - began) / 1000);
    if (secs == null || spent + secs > RUN_LIMIT_S) {
      const again = ['node', process.argv[1], '--more', ...push.slice(1)].join(' ');
      say(more
        ? `push-retry: GitHub still answers 5xx after ${tries} tries in ${spent}s. Park with AUTOPILOT_PARK_CLEARS_WHEN: git ${push.filter((p) => !/^-u$|^--set-upstream$/.test(p)).join(' ')} succeeds`
        : `push-retry: GitHub still answers 5xx after ${tries} tries in ${spent}s. Run this next, with the same ten-minute timeout: ${again}`);
      return TRANSIENT_EXIT;
    }
    say(`push-retry: GitHub answered 5xx on try ${tries}, trying again in ${secs}s`);
    await sleep(secs * 1000);
  }
}

function isMain() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error('usage: push-retry.mjs [--more] [-u | --set-upstream | --force-with-lease] origin <branch>');
    process.exit(2);
  }
  const git = (a) => {
    const r = spawnSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  process.exitCode = await pushWithRetry(args, { git, sleep: (ms) => wait(ms), now: Date.now, say: (l) => console.error(l) });
}
