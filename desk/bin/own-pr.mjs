// A worker's command that acts on its own open PR (evidence.mjs dispatch, preview-db.mjs up) is
// allowed by its settings with the branch fixed and the PR number free, so the command itself checks
// that the number is a PR number and that the PR is that branch's own, open and from this repo.
import { execFileSync } from 'node:child_process';

export const isPrNumber = (pr) => /^[1-9]\d*$/.test(String(pr ?? ''));

// gh pr view's { headRefName, headRefOid, state, isCrossRepository } for PR `pr` in `repo`, or null
// when it could not be read.
export function readPrView(repo, pr) {
  if (!repo || !isPrNumber(pr)) return null;
  try {
    return JSON.parse(execFileSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefName,headRefOid,state,isCrossRepository'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return null; }
}

// Why PR `pr` is not `branch`'s own open PR (`view` as readPrView gives it), or null when it is.
export function ownOpenPrRefusal(branch, pr, view) {
  if (!view) return `PR #${pr} could not be read`;
  if (view.headRefName !== branch || view.isCrossRepository) return `PR #${pr} is not ${branch}'s own PR`;
  if (view.state !== 'OPEN') return `PR #${pr} is ${String(view.state).toLowerCase()}`;
  return null;
}
