// A git call that reaches a remote, bounded so a hung remote cannot hold a pass for as long as git
// hangs. Every limit sits inside the read-only repo refresh's, itself well inside the supervisor's
// limit on a pass. Once one call runs out, later remote calls in the same process fail at once, so a
// hung remote costs a pass one limit, not one per call.
import { execFileSync } from 'node:child_process';
import { READ_REPO_REFRESH_MS } from './read-repos.mjs';

export const REMOTE_GIT_MS = Math.min(120000, READ_REPO_REFRESH_MS);
// A push runs the repo's pre-push hook first, which can take minutes, so it gets the whole refresh limit.
export const PUSH_GIT_MS = READ_REPO_REFRESH_MS;
const REMOTE = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);
let hung = null;

// The subcommand, when git's arguments reach a remote, else null.
export function remoteSub(cmd, args) {
  if (cmd !== 'git') return null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-C' || args[i] === '-c') { i += 1; continue; }
    if (!args[i].startsWith('-')) return REMOTE.has(args[i]) ? args[i] : null;
  }
  return null;
}

// Why remote calls are no longer tried in this process, or null.
export const remoteHung = () => hung;
export const markRemoteHung = (why) => { hung ??= why; };

// execFileSync, bounded when it reaches a remote. A call that ran out, or was not tried because one
// already had, throws with `unreached: true`: it got no answer, so it says nothing about the remote's.
export function execGit(cmd, args, opts = {}) {
  const sub = remoteSub(cmd, args);
  if (!sub) return execFileSync(cmd, args, opts);
  const unreached = (message) => Object.assign(new Error(message), { stdout: '', stderr: '', unreached: true });
  if (hung) throw unreached(`not tried: ${hung}`);
  const ms = sub === 'push' ? PUSH_GIT_MS : REMOTE_GIT_MS;
  try { return execFileSync(cmd, args, { timeout: ms, ...opts }); }
  catch (e) {
    if (e.code !== 'ETIMEDOUT') throw e;
    markRemoteHung(`git ${sub} ran past its ${ms / 1000} seconds earlier in this run`);
    throw unreached(`git ${sub} ran past its ${ms / 1000} seconds`);
  }
}
