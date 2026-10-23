// A worker's handoff to a fresh session: at the end of Stage 4 it hands off to Stage 4b, and at the
// end of Stage 6 to Stage 7, so self-review and the PR stage each start on a short briefing rather
// than on a context that has grown through the build. The worker writes $DESK_STATE/handoffs/<TICKET>.json
// and prints `AUTOPILOT_HANDOFF: <stage>`; pass.mjs reads the file, adds the branch and its commits
// from git, and spawns the next session with the rendered briefing in its system prompt.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ANSWER_HEAD, collectAnswers } from './briefing.mjs';

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

// A respawn after the worker's own park resumes at the stage that round reached, from Stage 3 on: the
// stages before it only read the ticket and the code again. pass.mjs records `last_round` on the queue
// when a worker parks and reads it at the next fresh spawn. A stage before 3, or a stage it cannot
// read, starts at Stage 0.
export const RESUME_STAGES = ['3', '4', '4b', '5', '6', '7', '8', '9'];

// "4/9" or "4b" as the stage a session starts at, or null for one before Stage 3 or none.
export function roundStage(v) {
  const s = /^\s*(4b|\d)(?:\/9)?\b/i.exec(String(v ?? ''))?.[1]?.toLowerCase();
  return RESUME_STAGES.includes(s) ? s : null;
}

export const resumeFilePath = (worktree, key) => join(worktree, '.claude', `desk-ticket-${key}.json`);

// Whether the round can be resumed in this worktree: { ok: true } or { ok: false, why }. The worktree
// must be on the queue's branch, and desk-ticket's resume file, where there is one, must record it. A
// worker's `.claude/` is write-protected, so most worktrees have no resume file.
export function resumeCheck({ worktree, key, branch }) {
  const missing = handoffTarget({ worktree, branch });
  if (missing) return { ok: false, why: missing };
  const path = resumeFilePath(worktree, key);
  if (!existsSync(path)) return { ok: true };
  let d;
  try { d = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, why: `its resume file ${path} is not JSON (${e.message})` }; }
  if (!d?.branch) return { ok: false, why: `its resume file ${path} records no branch` };
  if (String(d.branch) !== branch) return { ok: false, why: `its resume file is for branch ${d.branch}, not the queue's ${branch}` };
  return { ok: true };
}

// The answers recorded in a briefing since `since` (ISO), oldest first: each answer.mjs section's
// text, its heading being `## Answer from the user (<ISO time>)`.
export function answersSince(brief, since) {
  const t0 = Date.parse(since ?? '');
  return collectAnswers(brief).split(ANSWER_HEAD).slice(1)
    .map((s) => /^ \(([^)]+)\)\n([\s\S]*)$/.exec(s))
    .filter((m) => m && Date.parse(m[1]) >= t0)
    .map((m) => m[2].trim())
    .filter(Boolean);
}

// The last round's summary: the stage it reached, the park question and its answer, and the branch
// and its commits.
export function renderLastRound({ key, round, answers, branch, worktree, base, commits }) {
  const items = (xs, none) => (xs.length ? xs.map((x) => `- ${x}`) : [`- ${none}`]);
  return [
    `## Last round: this session resumes at Stage ${round.stage}`,
    '',
    `The last round of ${key} reached Stage ${round.stage} and parked. This session starts at Stage ${round.stage} rather than Stage 0: ` +
      `do not redo the stages before it. Check git status and git log in your worktree, and read your resume file ${resumeFilePath(worktree, key)} where there is one.`,
    '',
    '### Park question',
    '',
    round.question || 'not recorded',
    '',
    '### Its answer',
    '',
    ...items(answers, 'none recorded since it parked'),
    '',
    '### Branch and its commits',
    '',
    `\`${branch}\` in ${worktree}. Its commits since \`${base}\`:`,
    '',
    ...items(commits, 'none'),
    '',
  ].join('\n');
}

// A respawn that could have resumed but does not: it starts at Stage 0 and says why in its first line.
export function renderNoResume({ round, why }) {
  return [
    '## Last round: not resumed, this session starts at Stage 0',
    '',
    `The last round reached Stage ${round.stage} and parked, but it is not resumed: ${why}. Start at Stage 0, and do not resume from a resume file in the worktree. ` +
      'Your first stage line says why, as:',
    '',
    `AUTOPILOT_STAGE: 0/9 triage (not resumed from Stage ${round.stage}: ${why})`,
    '',
  ].join('\n');
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
