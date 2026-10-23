// A worker's handoff to a fresh session: at the end of Stage 4 it hands off to Stage 4b, and at the
// end of Stage 6 to Stage 7, so self-review and the PR stage each start on a short briefing rather
// than on a context that has grown through the build. The worker writes $DESK_STATE/handoffs/<TICKET>.json
// and prints `AUTOPILOT_HANDOFF: <stage>`; pass.mjs reads the file, adds the branch and its commits
// from git, and spawns the next session with the rendered briefing in its system prompt.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// The stages a session may start at, and the stage each one follows.
export const HANDOFF_STAGES = { '4b': '4', 7: '6' };

// The stage a marker names ("4b", "4b/9", "7"), or null for one no session starts at.
export function handoffStage(v) {
  const s = /^\s*(?:stage\s+)?(4b|7)(?:\/9)?\b/i.exec(String(v ?? ''))?.[1]?.toLowerCase();
  return s ?? null;
}

export const handoffPath = (stateDir, key) => join(stateDir, 'handoffs', `${key}.json`);

const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);

// The worker's file, as { ok, data } with only the fields a briefing holds, or { ok: false, why }.
export function readHandoff(stateDir, key) {
  const path = handoffPath(stateDir, key);
  if (!existsSync(path)) return { ok: false, why: `its handoff briefing ${path} does not exist` };
  let d;
  try { d = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, why: `its handoff briefing ${path} is not JSON (${e.message})` }; }
  if (d?.ticket != null && String(d.ticket) !== key) return { ok: false, why: `its handoff briefing ${path} is for ${d.ticket}, not ${key}` };
  const criteria = list(d?.criteria);
  if (!criteria.length) return { ok: false, why: `its handoff briefing ${path} lists no acceptance criteria` };
  return {
    ok: true,
    data: { criteria, lane: String(d.lane ?? '').trim() || 'not recorded', verification: list(d.verification), review: list(d.review), evidence: list(d.evidence) },
  };
}

// null when the session can start in this worktree on this branch, else what is missing.
export function handoffTarget({ worktree, branch }) {
  if (!worktree || !existsSync(worktree)) return `its worktree ${worktree ?? '(none recorded)'} no longer exists`;
  if (!branch) return 'no branch is recorded for it';
  const git = (...a) => { try { return execFileSync('git', ['-C', worktree, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  if (git('rev-parse', '--verify', '-q', `refs/heads/${branch}`) == null) return `its branch ${branch} no longer exists`;
  const on = git('branch', '--show-current');
  if (on !== branch) return `its worktree ${worktree} is on ${on || 'a detached HEAD'}, not its branch ${branch}`;
  return null;
}

// The branch's own commits, oldest first, as `<sha> <subject>`.
export function branchCommits(worktree, base) {
  try {
    return execFileSync('git', ['-C', worktree, 'log', '--reverse', '--format=%h %s', `${base}..HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
}

// The briefing: the ticket key, its acceptance criteria, the branch and its commits, the lane, the
// verification results, the self-review findings so far and the evidence paths, and nothing else.
export function renderHandoff({ key, stage, data, branch, worktree, base, commits }) {
  const items = (xs, none) => (xs.length ? xs.map((x) => `- ${x}`) : [`- ${none}`]);
  return [
    `## Handoff: this session starts at Stage ${stage}`,
    '',
    `An earlier session of this ticket finished Stages 0 to ${HANDOFF_STAGES[stage]} and ended so that this one starts fresh. This is everything it handed on.`,
    '',
    '### Ticket',
    '',
    key,
    '',
    '### Acceptance criteria',
    '',
    ...items(data.criteria, 'none recorded'),
    '',
    '### Branch and its commits',
    '',
    `\`${branch}\` in ${worktree}. Its commits since \`${base}\`:`,
    '',
    ...items(commits, 'none'),
    '',
    '### Lane',
    '',
    data.lane,
    '',
    '### Verification results',
    '',
    ...items(data.verification, 'none recorded'),
    '',
    '### Self-review findings so far',
    '',
    ...items(data.review, 'none yet'),
    '',
    '### Evidence captured',
    '',
    ...items(data.evidence, 'none'),
    '',
  ].join('\n');
}
