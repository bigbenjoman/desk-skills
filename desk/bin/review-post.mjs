#!/usr/bin/env node
// Posts a review report to a PR as one COMMENTED review, from the account desk posts verdicts from:
//
//   review-post.mjs <pr> --repo <owner/name> --body-file <report> [--comment]
//
// With §4 Review account set (`<login>: <gh config directory>`), gh runs with GH_CONFIG_DIR set to
// that directory here, never through a command prefix, so the review is that login's. Unset or `none`,
// plain gh posts it as the §1 GitHub handle. Refused with exit 1, posting nothing: --approve,
// --request-changes or any other flag, a PR that is not a number, a --repo other than §0 GitHub repo,
// a malformed row, and a config directory that does not exist.
// Usage is exit 2; otherwise gh's own exit status.
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reviewAccount, ghRepo } from './desk-env.mjs';

const USAGE = 'usage: review-post.mjs <pr> --repo <owner/name> --body-file <report> [--comment]';
const VERDICTS = new Set(['--approve', '-a', '--request-changes', '-r']);
const VALUED = { '--repo': 'repo', '-R': 'repo', '--body-file': 'bodyFile', '-F': 'bodyFile' };

// -> { pr, repo, bodyFile } or { refused } (exit 1) or { usage } (exit 2).
export function parseArgs(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (VERDICTS.has(flag)) return { refused: `${flag}: only a comment review is allowed` };
    if (flag === '--comment' || flag === '-c') continue;
    if (flag in VALUED) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (!v) return { usage: `${flag} needs a value` };
      o[VALUED[flag]] = v;
    } else if (a.startsWith('-')) return { refused: `${flag} is not a flag review-post takes` };
    else if (o.pr != null) return { usage: `a second PR "${a}"` };
    else o.pr = a;
  }
  if (o.pr == null || !o.repo || !o.bodyFile) return { usage: 'needs a PR, --repo and --body-file' };
  // gh reads an empty PR as the current branch's, so only a PR number is taken.
  if (!/^[1-9]\d*$/.test(o.pr)) return { usage: `the PR "${o.pr}" is not a PR number` };
  return o;
}

// The gh call and its environment: { args, env, as } or { refused }. `own` is §0 GitHub repo: a review
// goes on this repo's PRs only.
export function postCall({ pr, repo, bodyFile }, account, own, env = process.env) {
  if (!own || repo.toLowerCase() !== own.toLowerCase()) return { refused: `--repo ${repo} is not this repo (${own ?? '§0 GitHub repo unread'})` };
  const args = ['pr', 'review', pr, '--repo', repo, '--comment', '--body-file', bodyFile];
  if (!account) return { args, env, as: 'the §1 GitHub handle' };
  let dir = false;
  try { dir = statSync(account.dir).isDirectory(); } catch { /* missing */ }
  if (!dir) return { refused: `§4 Review account names ${account.dir} as ${account.login}'s gh config directory, and it does not exist: sign the account in with GH_CONFIG_DIR=${account.dir} gh auth login` };
  // A token in the environment outranks GH_CONFIG_DIR, and would post as whoever owns it.
  const { GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN, ...rest } = env;
  return { args, env: { ...rest, GH_CONFIG_DIR: account.dir }, as: account.login };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  if (o.usage) { console.error(`review-post: ${o.usage}\n${USAGE}`); process.exit(2); }
  if (o.refused) { console.error(`review-post: refused, nothing posted: ${o.refused}`); process.exit(1); }
  let account, own;
  try { account = reviewAccount(); own = ghRepo(); } catch (e) { console.error(`review-post: refused, nothing posted: ${e.message}`); process.exit(1); }
  const call = postCall(o, account, own);
  if (call.refused) { console.error(`review-post: refused, nothing posted: ${call.refused}`); process.exit(1); }
  const r = spawnSync('gh', call.args, { stdio: 'inherit', env: call.env });
  if (r.error) { console.error(`review-post: ${r.error.message}`); process.exit(1); }
  if (r.status === 0) console.error(`review-post: posted a COMMENTED review on ${o.pr} as ${call.as}`);
  process.exit(r.status ?? 1);
}
