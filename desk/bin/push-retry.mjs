#!/usr/bin/env node
// A worker's push, retried while GitHub answers with a 5xx. A worker's Bash call stops at ten
// minutes, so one run stays inside that and a second run, `--more`, carries on with the long waits:
//   node push-retry.mjs [--more] [-u | --set-upstream | --force-with-lease[=<branch>:<sha>]] origin <branch>
// Exit 0 pushed; 75 GitHub still answers 5xx; anything else is git's own refusal, never retried.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describeCond } from './clears-when.mjs';

export const TRANSIENT_EXIT = 75;
const FIRST_WAITS = [30, 60, 120, 240];
const MORE_WAITS = [240, 240];
// No wait starts that, with a try as long as the last one after it, would end past this: a slow
// pre-push hook stays inside the Bash call's ten minutes.
const RUN_LIMIT_S = 570;

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

// A push that never got an answer: no network, or a remote that could not be reached. A 4xx is an
// answer, and so is git's "Could not read from remote", which also follows a revoked SSH key.
const UNREACHED = /^(?:ssh: |fatal: (?:unable to access (?!.*The requested URL returned error)|the remote end hung up))/m;
const HTTP_4XX = /RPC failed; HTTP 4\d\d\b/;
export function unreachedPush(out) {
  const s = String(out ?? '');
  return !HOOK_FAILED.test(s) && !HTTP_4XX.test(s) && UNREACHED.test(s);
}

const PINNED = /^--force-with-lease=([^:]+):([0-9a-f]{40})$/;

// {more, push} from the CLI's arguments, or null for any other shape: this runs only the pushes a
// worker's settings allow.
export function parseArgs(argv) {
  const a = [...argv];
  const more = a[0] === '--more';
  if (more) a.shift();
  const flag = ['-u', '--set-upstream', '--force-with-lease'].includes(a[0]) || PINNED.test(a[0] ?? '') ? [a.shift()] : [];
  if (a.length !== 2 || a[0] !== 'origin' || !a[1] || a[1].startsWith('-') || a[1].startsWith('+')) return null;
  const pinned = PINNED.exec(flag[0] ?? '');
  if (pinned && pinned[1] !== a[1]) return null;
  return { more, push: ['push', ...flag, ...a] };
}

// The condition a park on this push records. A lease push names the SHA it may overwrite, since a
// pass makes the push long after, when origin's tracking ref may have moved onto someone else's commit.
function parkCond(push, git) {
  const branch = push.at(-1);
  const lease = push[1] === '--force-with-lease'
    ? git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).out.trim()
    : PINNED.exec(push[1])?.[2];
  return describeCond({ kind: 'push-ok', branch, ...(/^[0-9a-f]{40}$/.test(lease ?? '') ? { lease } : {}) });
}

// git(args) → {status, out}; sleep(ms), now() and say(line) as the CLI gives them. → the exit code.
export async function pushWithRetry({ more, push }, { git, sleep, now, say }) {
  const waits = more ? MORE_WAITS : FIRST_WAITS;
  const began = now();
  for (let tries = 1; ; tries += 1) {
    const tried = now();
    const r = git(push);
    if (r.status === 0) return 0;
    if (!transientPush(r.out)) return r.status || 1;
    const secs = waits[tries - 1];
    const spent = Math.round((now() - began) / 1000);
    const last = Math.round((now() - tried) / 1000);
    if (secs == null || spent + secs + last > RUN_LIMIT_S) {
      // A first run cut short by slow tries waits out its limit, so the --more run's first try is
      // past ten minutes however long a try takes. Its waits may not fit: only a wait here can.
      const rest = !more && secs != null ? Math.max(0, RUN_LIMIT_S - spent) : 0;
      if (rest) {
        say(`push-retry: GitHub answered 5xx on try ${tries}, and another try would not fit this run: waiting ${rest}s before it ends`);
        await sleep(rest * 1000);
      }
      const again = ['node', process.argv[1], '--more', ...push.slice(1)].join(' ');
      say(more
        ? `push-retry: GitHub still answers 5xx after ${tries} tries in ${spent}s. Park with AUTOPILOT_PARK_CLEARS_WHEN: ${parkCond(push, git)}`
        : `push-retry: GitHub still answers 5xx after ${tries} tries in ${spent + rest}s. Run this next, with the same ten-minute timeout: ${again}`);
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
    console.error('usage: push-retry.mjs [--more] [-u | --set-upstream | --force-with-lease[=<branch>:<sha>]] origin <branch>');
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
