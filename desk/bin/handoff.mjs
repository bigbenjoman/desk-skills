#!/usr/bin/env node
// A worker's handoff to a fresh session: at the end of Stage 4 it hands off to Stage 4b, and at the
// end of Stage 6 to Stage 7, so self-review and the PR stage each start on a short briefing rather
// than on a context that has grown through the build. Partway through any stage from Stage 3 on, it
// hands off when its context passes the handoff threshold (hooks/desk-handoff.py), and the fresh
// session starts that same stage again from the briefing. The worker writes $DESK_STATE/handoffs/<TICKET>.json
// with `handoff.mjs write` (below) and prints `AUTOPILOT_HANDOFF: <stage>`; pass.mjs reads the file, adds the branch and its commits
// from git, and spawns the next session with the rendered briefing in its first message.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSWER_HEAD, collectAnswers } from './briefing.mjs';
import { RESUME_STAGES, SAFE_ID, stateDir } from './desk-env.mjs';
import { prsNaming } from './recoveries.mjs';
import { execGit, REMOTE_GIT_MS } from './remote-git.mjs';

// The stages a session may start at after a handoff (those a resume starts at), and the stage each
// one follows.
const STAGE_ORDER = ['0', '1', '2', '3', '4', '4b', '5', '6', '7', '8', '9'];
export const HANDOFF_STAGES = Object.freeze(Object.fromEntries(RESUME_STAGES.map((s) => [s, STAGE_ORDER[STAGE_ORDER.indexOf(s) - 1]])));

// The stage a marker names ("4b", "4b/9", "7"), or null for one no session starts at.
export function handoffStage(v) {
  const s = /^\s*(?:stage\s+)?(4b|\d)(?:\/9)?\b/i.exec(String(v ?? ''))?.[1]?.toLowerCase();
  return s && Object.hasOwn(HANDOFF_STAGES, s) ? s : null;
}

// The value of the handoff-threshold lever this worker runs on, from its pin (DESK_LEVER_VALUES), or
// `config` with none: the value a mid-stage briefing records.
export function thresholdValue(env = process.env) {
  for (const w of String(env.DESK_LEVER_VALUES ?? '').split(/\s+/)) {
    const [k, v] = w.split('=');
    if (k === 'handoff-threshold' && v) return v;
  }
  return 'config';
}

export const handoffPath = (stateDir, key) => join(stateDir, 'handoffs', `${key}.json`);

const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);

// The text with every raw control character inside a string literal escaped, so a file written by
// hand with a tab or a newline in a string parses. Anything outside a string is left as it is.
export function escapeRawControls(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString && !escaped && ch < ' ') { out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue; }
    if (escaped) escaped = false;
    else if (inString && ch === '\\') escaped = true;
    else if (ch === '"') inString = !inString;
    out += ch;
  }
  return out;
}

// JSON.parse, and on its error a second try with raw control characters in strings escaped. A file
// neither reads throws the first error.
export function parseJsonLenient(text) {
  try { return JSON.parse(text); } catch (e) {
    try { return JSON.parse(escapeRawControls(text)); } catch { throw e; }
  }
}

// The worker's file, as { ok, data } with only the fields a briefing holds, or { ok: false, why },
// with `unreadable: true` when the file is there but is not JSON.
export function readHandoff(stateDir, key) {
  const path = handoffPath(stateDir, key);
  if (!existsSync(path)) return { ok: false, why: `its handoff briefing ${path} does not exist` };
  let d;
  try { d = parseJsonLenient(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, unreadable: true, why: `its handoff briefing ${path} is not JSON (${e.message})` }; }
  if (d?.ticket != null && String(d.ticket) !== key) return { ok: false, why: `its handoff briefing ${path} is for ${d.ticket}, not ${key}` };
  const criteria = list(d?.criteria);
  if (!criteria.length) return { ok: false, why: `its handoff briefing ${path} lists no acceptance criteria` };
  const back = String(d.handed_back?.note ?? '').trim();
  const left = list(d.left);
  return {
    ok: true,
    data: { criteria, lane: String(d.lane ?? '').trim() || 'not recorded', verification: list(d.verification), review: list(d.review), evidence: list(d.evidence),
      ...(back ? { handedBack: { note: back, at: d.handed_back.at ?? null } } : {}),
      ...(left.length ? { midStage: { left, context: d.context ?? null, threshold: d.threshold ?? null } } : {}) },
  };
}

// A lane C or D ticket the person handed back once its session step was done (queue.mjs handback, from
// desk-needs-you's resume): the handoff briefing it starts at Stage 4b on. An earlier handoff's
// criteria, verification, review and evidence are kept; with none, the session reads the criteria
// from the ticket. Written to the ticket's handoff briefing path; returns that path.
export function writeHandback(stateDir, { key, lane, note, at = new Date().toISOString() }) {
  const was = readHandoff(stateDir, key);
  const prior = was.ok ? was.data : null;
  const path = handoffPath(stateDir, key);
  mkdirSync(join(stateDir, 'handoffs'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    ticket: key,
    criteria: prior?.criteria ?? [`Not handed on: read them from ${key} at the start of Stage 4b`],
    lane: `${lane ?? 'not recorded'}, handed back by the person once the step that needed a session was done: do not park on the lane again`,
    verification: prior?.verification ?? [],
    review: prior?.review ?? [],
    evidence: prior?.evidence ?? [],
    handed_back: { note, at },
  }, null, 2)}\n`);
  return path;
}

// A handoff briefing that is not JSON even with its control characters escaped, moved aside to
// `<path>.unreadable` and replaced by one that tells the session to read the criteria from the ticket,
// so the stage still starts. Returns the path the unreadable file was kept at.
export function replaceUnreadable(stateDir, { key, stage }) {
  const path = handoffPath(stateDir, key);
  const kept = `${path}.unreadable`;
  renameSync(path, kept);
  writeFileSync(path, `${JSON.stringify({
    ticket: key,
    stage,
    criteria: [`Not handed on: the earlier session's handoff briefing could not be read (kept as ${kept}), so read them from ${key} at the start of Stage ${stage}`],
    lane: 'not recorded: read it from your resume file',
    verification: [],
    review: [],
    evidence: [],
  }, null, 2)}\n`);
  return kept;
}

const WRITE_USAGE = `usage: handoff.mjs write <TICKET> --stage <${RESUME_STAGES.join('|')}> --criterion <text> [--criterion <text> …] [--lane <text>] ` +
  '[--verification <text> …] [--review <text> …] [--evidence <path> …] [--left <text> … --context <percent>]';
const WRITE_LISTS = { '--criterion': 'criteria', '--verification': 'verification', '--review': 'review', '--evidence': 'evidence', '--left': 'left' };

// `handoff.mjs write`'s arguments as the briefing it writes, or { error }. Each flag takes the next
// argument whole, whatever it starts with; the list flags repeat. `--left` makes it a mid-stage
// handoff: what is left of the stage, with the context share it handed off at (`--context`) and the
// handoff-threshold value the worker ran on (`env`'s DESK_LEVER_VALUES, `config` with none).
export function handoffFromArgs(args, env = process.env) {
  const [key, ...rest] = args;
  if (!key || key.startsWith('--')) return { error: WRITE_USAGE };
  if (!SAFE_ID.test(key) || key.includes('..')) return { error: `'${key}' is not usable as a ticket id (letters, digits, . _ - only; no ..)` };
  const d = { ticket: key, stage: null, criteria: [], lane: '', verification: [], review: [], evidence: [], left: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) return { error: `${flag} needs a value. ${WRITE_USAGE}` };
    if (WRITE_LISTS[flag]) d[WRITE_LISTS[flag]].push(value);
    else if (flag === '--stage') d.stage = value;
    else if (flag === '--lane') d.lane = value;
    else if (flag === '--context') d.context = value;
    else return { error: `unknown argument ${flag}. ${WRITE_USAGE}` };
  }
  const stage = handoffStage(d.stage);
  if (!stage || String(d.stage).trim().toLowerCase() !== stage) return { error: `--stage takes ${RESUME_STAGES.join(', ')}, not ${d.stage == null ? 'nothing' : `'${d.stage}'`}` };
  d.stage = stage;
  if (!d.criteria.some((c) => c.trim())) return { error: 'a criterion is required: pass --criterion <text> once for each acceptance criterion, verbatim' };
  if (!d.left.length && d.context != null) return { error: '--context goes with --left: a mid-stage handoff says what is left of the stage' };
  if (d.left.length) {
    const pct = Number(String(d.context ?? '').trim().replace(/%$/, ''));
    if (!(pct > 0 && pct <= 100)) return { error: `--context takes the context share the handoff fired at, a percentage, not ${d.context == null ? 'nothing' : `'${d.context}'`}` };
    d.context = pct;
    d.threshold = thresholdValue(env);
  } else delete d.left;
  return { data: d };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd !== 'write') { console.error(WRITE_USAGE); process.exit(2); }
  const got = handoffFromArgs(args);
  if (got.error) { console.error(got.error); process.exit(2); }
  const dir = stateDir();
  const path = handoffPath(dir, got.data.ticket);
  mkdirSync(join(dir, 'handoffs'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(got.data, null, 2)}\n`);
  console.log(`wrote ${path}: ${got.data.criteria.length} criteria, for Stage ${got.data.stage}${got.data.left ? `, mid-stage at ${got.data.context}% (handoff-threshold ${got.data.threshold})` : ''}`);
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

// The ticket's own open PR as { number, head, recorded }, or null. Its recorded PR (`pr`) when that one
// is open, read by its number, else the one open PR whose title or head branch names `key`; a fork's PR
// is never its own. `recorded` says which, since an unrecorded one is only a PR naming the ticket;
// `naming: false` reads only the recorded one. Its read is bounded as a remote git call is.
export function openPrOf({ key, pr = null, repo, worktree, naming: byName = true }) {
  const gh = (...a) => {
    try {
      return JSON.parse(execFileSync('gh', [...a, ...(repo ? ['--repo', repo] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: REMOTE_GIT_MS, ...(worktree && existsSync(worktree) ? { cwd: worktree } : {}) }) || 'null');
    } catch { return null; }
  };
  const ownOpen = (p) => p?.headRefName && !p.isCrossRepository && (p.state == null || p.state === 'OPEN');
  const as = (p, recorded) => ({ number: Number(p.number), head: String(p.headRefName), recorded });
  if (pr != null) {
    const v = gh('pr', 'view', String(pr), '--json', 'number,state,headRefName,isCrossRepository');
    if (ownOpen(v)) return as(v, true);
  }
  if (!byName) return null;
  let naming;
  try {
    naming = prsNaming(repo, 'open', key, { fields: 'title,isCrossRepository', inTitle: true, search: false, limit: 500, ...(worktree && existsSync(worktree) ? { cwd: worktree } : {}) }).filter(ownOpen);
  } catch { return null; }
  return naming.length === 1 ? as(naming[0], false) : null;
}

// Brings origin's copy of the PR's head into the worktree, as refs/remotes/origin/<head>: null once
// fetched, else why not. Kept apart from repointToPr so the network call runs before the queue lock, and
// bounded (execGit), since a pass's requeue waits on it.
export function fetchPrHead({ worktree, pr }) {
  if (!pr?.head || !worktree || !existsSync(worktree)) return null;
  try {
    execGit('git',['-C', worktree, 'fetch', '-q', 'origin', `+refs/heads/${pr.head}:refs/remotes/origin/${pr.head}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (e) { return String(e.stderr || e.message).trim().split('\n').pop(); }
}

// A worktree whose queued branch is not its open PR's head (or is its head's name, but missing), moved
// onto that head as fetched (fetchPrHead): checked out, a local copy behind the PR fast-forwarded, and
// the queued branch, where it still exists, renamed to a backup ref. Returns { branch, backup } once on
// the PR's head; { why, ahead } when the queued branch (or a detached HEAD) holds commits the PR's head
// does not, `ahead` listing them; { why } when anything else stops it, before any change; and null when
// there is nothing to move to.
export function repointToPr({ worktree, branch, pr, fetchError = null }) {
  if (!pr?.head || !worktree || !existsSync(worktree)) return null;
  const run = (...a) => { try { return { ok: true, out: execFileSync('git', ['-C', worktree, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; } catch (e) { return { ok: false, out: String(e.stderr ?? e.message).trim() }; } };
  const has = (ref) => run('rev-parse', '--verify', '-q', ref).ok;
  const last = (r) => r.out.split('\n').pop();
  const on = run('branch', '--show-current').out;
  if (pr.head === branch && has(`refs/heads/${branch}`)) return null;
  const remote = `refs/remotes/origin/${pr.head}`;
  if (fetchError || !has(remote)) return { why: `its open PR #${pr.number} is on ${pr.head}, which could not be fetched (${fetchError ?? 'no copy of it from origin'})` };
  const hasQueued = branch !== pr.head && has(`refs/heads/${branch}`);
  const keep = [...(hasQueued ? [`refs/heads/${branch}`] : []), ...(on ? [] : ['HEAD'])];
  if (keep.length) {
    const extra = run('log', '--format=%h %s', ...keep, '--not', remote);
    if (!extra.ok) return { why: `its open PR #${pr.number} is on ${pr.head}, and the commits not on it could not be listed (${last(extra)})` };
    if (extra.out) return { why: `its open PR #${pr.number} is on ${pr.head}, but ${hasQueued ? `its branch ${branch}` : 'its detached HEAD'} has commits that are not on it, so it was not re-pointed: ${extra.out.split('\n').join('; ')}`, ahead: extra.out };
  }
  // A local copy of the PR's head must hold everything the PR does, or the worker reviews stale code:
  // behind it is fast-forwarded below, and diverged from it is refused here, before anything moves.
  const local = has(`refs/heads/${pr.head}`);
  const behind = local && !run('merge-base', '--is-ancestor', remote, `refs/heads/${pr.head}`).ok;
  if (behind && !run('merge-base', '--is-ancestor', `refs/heads/${pr.head}`, remote).ok) {
    const own = run('log', '--format=%h %s', `refs/heads/${pr.head}`, '--not', remote).out.split('\n').join('; ');
    return { why: `its open PR #${pr.number} is on ${pr.head}, but the local ${pr.head} has diverged from it, so it was not re-pointed: ${own}` };
  }
  if (on !== pr.head || behind) {
    const dirty = run('status', '--porcelain', '--untracked-files=no');
    if (!dirty.ok || dirty.out) return { why: `its open PR #${pr.number} is on ${pr.head}, but its worktree ${worktree} has uncommitted changes, so it was not re-pointed` };
  }
  // One step each way, so a failure leaves the worktree where it was: a local copy behind the PR is
  // reset to it as it is checked out (it holds nothing the PR lacks), and one already checked out is
  // fast-forwarded in place.
  if (on !== pr.head) {
    const moved = !local || behind ? run('checkout', '-q', '-B', pr.head, remote) : run('checkout', '-q', pr.head);
    if (!moved.ok) return { why: `its open PR #${pr.number} is on ${pr.head}, which its worktree could not be moved onto (${last(moved)})` };
  } else if (behind) {
    const ff = run('merge', '-q', '--ff-only', remote);
    if (!ff.ok) return { why: `its open PR #${pr.number} is on ${pr.head}, and its worktree is on it, but could not be brought up to the PR (${last(ff)})` };
  }
  if (!hasQueued) return { branch: pr.head, backup: null };
  let backup = `desk-backup/${branch}`;
  for (let n = 2; run('rev-parse', '--verify', '-q', `refs/heads/${backup}`).ok; n++) backup = `desk-backup/${branch}-${n}`;
  const renamed = run('branch', '-m', branch, backup);
  return { branch: pr.head, backup: renamed.ok ? backup : branch };
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
// "4/9" or "4b" as the stage a session starts at, or null for one before Stage 3 or none.
export function roundStage(v) {
  const s = /^\s*(4b|\d)(?:\/9)?\b/i.exec(String(v ?? ''))?.[1]?.toLowerCase();
  return RESUME_STAGES.includes(s) ? s : null;
}

export const resumeFilePath = (worktree, key) => join(worktree, '.claude', `desk-ticket-${key}.json`);

// A worker's resume file. The harness write-protects a worktree's `.claude/`, so a worker keeps its
// resume file in the state dir, where its settings let it write this one file.
export const workerResumePath = (stateDir, key) => join(stateDir, 'resume', `${key}.json`);

// Whether the round can be resumed in this worktree: { ok: true, path } or { ok: false, why, path }. The
// worktree must be on the queue's branch, and desk-ticket's resume file, where there is one, must record
// it: the worker's in the state dir first, else one in the worktree's `.claude/`. `path` is the file
// read, or the worker's own when there is none, so a briefing names the file that was checked.
export function resumeCheck({ worktree, key, branch, stateDir }) {
  const missing = handoffTarget({ worktree, branch });
  if (missing) return { ok: false, why: missing, path: null };
  const found = [workerResumePath(stateDir, key), resumeFilePath(worktree, key)].find((p) => existsSync(p));
  if (!found) return { ok: true, path: workerResumePath(stateDir, key) };
  const no = (why) => ({ ok: false, why, path: found });
  let d;
  try { d = parseJsonLenient(readFileSync(found, 'utf8')); } catch (e) { return no(`its resume file ${found} is not JSON (${e.message})`); }
  if (!d?.branch) return no(`its resume file ${found} records no branch`);
  if (String(d.branch) !== branch) return no(`its resume file is for branch ${d.branch}, not the queue's ${branch}`);
  return { ok: true, path: found };
}

// The answers recorded in a briefing since `since` (ISO), oldest first: each answer.mjs section's
// text, its heading being `## Answer from the user (<ISO time>)`.
export const answersSince = (brief, since) => answerEntriesSince(brief, since).map((a) => a.text);

// The same answers with their times: [{at, text}], `at` as the heading gives it.
export function answerEntriesSince(brief, since) {
  const t0 = Date.parse(since ?? '');
  return collectAnswers(brief).split(ANSWER_HEAD).slice(1)
    .map((s) => /^ \(([^)]+)\)\n([\s\S]*)$/.exec(s))
    .filter((m) => m && Date.parse(m[1]) >= t0)
    .map((m) => ({ at: m[1], text: m[2].trim() }))
    .filter((a) => a.text);
}

// The last round's summary: the stage it reached, the park question and its answer, and the branch
// and its commits.
export function renderLastRound({ key, round, answers, branch, worktree, base, commits, resumePath }) {
  const items = (xs, none) => (xs.length ? xs.map((x) => `- ${x}`) : [`- ${none}`]);
  return [
    `## Last round: this session resumes at Stage ${round.stage}`,
    '',
    `The last round of ${key} reached Stage ${round.stage} and parked. This session starts at Stage ${round.stage} rather than Stage 0: ` +
      `do not redo the stages before it. Check git status and git log in your worktree, and read your resume file ${resumePath} where there is one.`,
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
export function renderNoResume({ round, why, path }) {
  return [
    '## Last round: not resumed, this session starts at Stage 0',
    '',
    `The last round reached Stage ${round.stage} and parked, but it is not resumed: ${why}. Start at Stage 0, and do not resume from ${path ? `its resume file ${path}` : 'a resume file in the worktree'}. ` +
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
    ...(data.handedBack
      ? ['This ticket needed an interactive session, and the person did that step and handed it back to a worker. What they did, in their words:', '',
        `> ${data.handedBack.note.split('\n').join('\n> ')}`, '',
        'Self-review the branch as it stands, then finish the ticket from there (evidence, the PR, Jira). This is everything handed on.']
      : data.midStage
        ? [`An earlier session of this ticket finished Stages 0 to ${HANDOFF_STAGES[stage]} and handed off partway through Stage ${stage}, as its context passed the handoff threshold ` +
          `(${data.midStage.context ?? '?'}% used; handoff-threshold ${data.midStage.threshold ?? 'config'}). Carry on with Stage ${stage} from what is left below: do not redo the stages before it, ` +
          'and check git status and git log first, since its work so far is on the branch. This is everything it handed on.']
        : [`An earlier session of this ticket finished Stages 0 to ${HANDOFF_STAGES[stage]} and ended so that this one starts fresh. This is everything it handed on.`]),
    '',
    ...(data.midStage ? [`### Left of Stage ${stage}`, '', ...items(data.midStage.left, 'not recorded'), ''] : []),
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
