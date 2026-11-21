#!/usr/bin/env node
// A worker's push, retried while GitHub answers with a 5xx. A worker's Bash call stops at ten
// minutes, so one run stays inside that and a second run, `--more`, carries on with the long waits:
//   node push-retry.mjs [--more] [-u | --set-upstream | --force-with-lease[=<branch>:<sha>]] origin <branch>
// Exit 0 pushed; 75 GitHub still answers 5xx; 76 the preview-build slot is taken; anything else is
// git's own refusal, never retried.
// Each run takes the preview-build slot first (desk-env preview-slot: a push starts a preview build
// where §4 Vercel names a team, and builds on a shared builder kill each other), waiting for none: a
// wait here would come out of the one ten-minute call a slow push needs. One a wait already took for
// this repo's branch on its §4 Vercel team (labelled `a push of <owner/repo>:<branch>`) is used. Taken
// by another build, it exits 76 naming that wait, to run in a call of its own, before this same push
// again. A push that fails gives its slot
// back, since it started no build; one that succeeds renews it from then, as `the build of <branch>`,
// so it covers the build however long the push took.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describeCond } from './clears-when.mjs';

export const TRANSIENT_EXIT = 75;
const FIRST_WAITS = [30, 60, 120, 240];
const MORE_WAITS = [240, 240];
// No wait starts that, with a try as long as the last one after it, would end past this: a slow
// pre-push hook stays inside the Bash call's ten minutes.
const RUN_LIMIT_S = 570;
export const SLOT_BUSY_EXIT = 76;
// The wait run in its own call before a push the slot refused: inside the ten minutes with room to spare.
const SLOT_WAIT_S = 540;

const REASON = '(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)';
// Only the lines git and the remote write: a failing pre-push check can print anything.
const GIT_5XX = [
  new RegExp(`^\\s*! \\[remote rejected\\].*\\((?:(?:HTTP )?5\\d\\d\\b[^)]*|${REASON})\\)\\s*$`, 'i'),
  /^(?:fatal|error): .*(?:RPC failed; HTTP 5\d\d\b|The requested URL returned error: 5\d\d\b)/i,
  new RegExp(`^remote: .*\\b${REASON}`, 'i'),
];
const HOOK_FAILED = /^pre-push: FAIL\b.*$/m;

// Did this refused push fail on a server error, rather than on a check, a rule or the branch's history?
export function transientPush(out) {
  const s = String(out ?? '');
  return !HOOK_FAILED.test(s) && s.split('\n').some((l) => GIT_5XX.some((re) => re.test(l)));
}

// A pre-push hook that could not run its checks, rather than one a check failed: what it lacked, as
// `turbo` (command not found), `DATABASE_URL` (environment variable not set) or `node_modules`
// (packages not installed), or null. A shell names a
// missing command in one of three forms: bash `turbo: command not found`, dash `sh: 1: turbo: not
// found`, zsh `zsh: command not found: turbo`.
const NOT_FOUND = [
  /^\s*(?:\S+: )*(?:line \d+: )?([^\s:]+): command not found\s*$/m,
  /^\s*\S+: \d+: ([^\s:]+): not found\s*$/m,
  /^\s*\S+: command not found: (\S+)\s*$/m,
];
// pnpm's warning before it runs a script whose packages were never installed. It comes before every
// script there, a check that ran and failed on the code included, so on its own it proves nothing:
// it is an environment failure only beside node's own error for a package it could not load. A path
// node could not load ('./x', '/abs/x.js', 'file:…') is the code's own missing file: a failing check.
const NO_PACKAGES = /\bnode_modules missing\b/;
const NOT_LOADED = /\bCannot find (?:module|package) '([^']+)'/g;
const isPackage = (spec) => !/^(?:\.{1,2}(?:[/\\]|$)|[/\\]|[A-Za-z]:[/\\]|file:)/.test(spec);
const packageNotLoaded = (s) => [...s.matchAll(NOT_LOADED)].some((m) => isPackage(m[1]));
// An environment variable the hook's check needs and the worktree's env files do not set: Prisma's
// forms for one unset and one blank (a base worktree's §4 Database URL variables are blanked), and a
// shell's `set -u`.
const NO_ENV_VAR = [
  /\bCannot resolve environment variable: ([A-Za-z_][A-Za-z0-9_]*)/,
  /\bEnvironment variable not found: ([A-Za-z_][A-Za-z0-9_]*)/,
  /\benvironment variable `([A-Za-z_][A-Za-z0-9_]*)` resolved to an empty string/i,
  /^\s*(?:\S+: )*(?:line \d+: )?([A-Za-z_][A-Za-z0-9_]*): (?:unbound variable|parameter not set)\s*$/m,
];
export function hookEnvFailure(out) {
  const s = String(out ?? '');
  if (!HOOK_FAILED.test(s)) return null;
  for (const re of NOT_FOUND) {
    const m = re.exec(s);
    if (m) return `\`${m[1]}\` (command not found)`;
  }
  for (const re of NO_ENV_VAR) {
    const m = re.exec(s);
    if (m) return `\`${m[1]}\` (environment variable not set)`;
  }
  return NO_PACKAGES.test(s) && packageNotLoaded(s) ? '`node_modules` (packages not installed)' : null;
}

// The line a refused push is quoted by: a hook's FAIL line where its check failed, which names the
// check, and otherwise git's or the remote's first line.
export function refusalLine(out) {
  const s = String(out ?? '').replace(/^To .*$/m, '');
  const failed = HOOK_FAILED.exec(s)?.[0];
  const env = hookEnvFailure(s);
  if (env) return `the pre-push hook could not run its checks here: ${env}, an environment failure, not a failing check (${failed.trim()})`;
  return (failed ?? s.split('\n').map((l) => l.trim()).find(Boolean) ?? '').trim();
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
// slot.take() → { id } of the preview-build lease taken or already waited for (none where there is
// nothing to take), { busy } naming who holds it, or { why } it could not be read; slot.give(id)
// releases one and slot.keep(id) renews it for the build.
// The label a wait for this push's slot takes, naming the repo: the lease store is the machine's, so two
// repos' branches of one name never hand each other a slot.
export const slotLabel = (branch, repo = '') => `a push of ${repo ? `${repo}:` : ''}${branch}`;
export async function pushWithRetry({ more, push }, { git, sleep, now, say, slot = null }) {
  const waits = more ? MORE_WAITS : FIRST_WAITS;
  const began = now();
  const held = slot ? slot.take() : {};
  if (held.busy) {
    say(`push-retry: the preview-build slot is taken (${held.busy}), so nothing was pushed. Run this in a call of its own, with the same ten-minute timeout: desk-env preview-slot --wait ${SLOT_WAIT_S} '${held.label ?? slotLabel(push.at(-1))}'. It waits for that build and holds the slot for this push; then run this same push again: node ${process.argv[1]} ${push.slice(1).join(' ')}. If the wait exits 75 (still taken), run it again.`);
    return SLOT_BUSY_EXIT;
  }
  if (held.why) say(`push-retry: ${held.why}: pushing anyway`);
  const code = await tryPush({ more, push, waits, began }, { git, sleep, now, say });
  if (held.id) (code === 0 ? slot.keep : slot.give)(held.id);
  return code;
}
async function tryPush({ more, push, waits, began }, { git, sleep, now, say }) {
  for (let tries = 1; ; tries += 1) {
    const tried = now();
    const r = git(push);
    if (r.status === 0) return 0;
    if (!transientPush(r.out)) {
      if (hookEnvFailure(r.out)) say(`push-retry: ${refusalLine(r.out)}`);
      return r.status || 1;
    }
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
    console.error('usage: push-retry.mjs [--slot <lease id>|none] [--more] [-u | --set-upstream | --force-with-lease[=<branch>:<sha>]] origin <branch>');
    process.exit(2);
  }
  const git = (a) => {
    const r = spawnSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const deskEnv = (a) => spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'desk-env.mjs'), ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const branch = args.push.at(-1);
  const repo = /^GH_REPO='([^']*)'/m.exec(deskEnv(['where']).stdout ?? '')?.[1] ?? '';
  const team = (deskEnv(['list', 'vercel']).stdout ?? '').split('\n')[0]?.trim() ?? '';
  const label = slotLabel(branch, repo);
  const leases = () => (deskEnv(['lease', 'list', '--json']).stdout ?? '').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const slot = {
    take: () => {
      const waited = leases().find((l) => l.kind === 'preview-build' && l.key === team && l.label === label);
      if (waited) return { id: waited.id };
      const r = deskEnv(['preview-slot', '--wait', '0', label]);
      if (r.status === 0) return { id: (r.stdout ?? '').split('\n').find((l) => /^L-\w+$/.test(l.trim()))?.trim() ?? null };
      const said = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').pop() || `exit ${r.status}`;
      return r.status === 3 ? { busy: said, label } : { why: `the preview-build slot was not taken (${said})` };
    },
    give: (id) => { deskEnv(['lease', 'release', id]); },
    keep: (id) => {
      const l = leases().find((x) => x.id === id);
      if (l) deskEnv(['lease', 'renew', id, 'preview-build', l.key, '--ttl', String(l.ttl), '--no-owner', '--label', `the build of ${branch}`]);
    },
  };
  process.exitCode = await pushWithRetry(args, { git, sleep: (ms) => wait(ms), now: Date.now, say: (l) => console.error(l), slot });
}
