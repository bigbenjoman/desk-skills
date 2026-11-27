// Cloud workers: where config §3b "Worker location" is `cloud`, a ticket that can run away from this
// computer is worked in a Claude Code cloud session instead of a local `claude -p` worker.
//
// What the CLI allows (tests/fixtures/cloud/, recorded with Claude Code 2.1.312): `claude --cloud
// "<description>"` starts a session whose first prompt is the description, prints its URL and
// returns at once. It refuses --print, so it is run under `script` for a terminal. The session works
// from GitHub, not this worktree, has no Jira access and none of the desk skills, so its prompt
// carries the ticket's text and everything it is to do. Nothing reports its tokens or cost, and it
// writes no local log: its result is the branch and PR it pushes, found on GitHub, and its wall time
// runs from the session's start to that PR.
//
// Nothing gives a cloud session an effort: no recording or doc shows `claude --cloud` passing --effort
// on, and local settings do not reach the session. So with the effort lever on, which promises each
// session an effort config names, no ticket runs in the cloud (CLOUD_NO_EFFORT).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lock, unlock, writeJsonAtomic } from './dir-lock.mjs';
import { repoStateOf } from './desk-env.mjs';
import { FAILED } from './gate.mjs';

export const CLOUD_NO_EFFORT = 'the effort lever is on, and a cloud session cannot be given an effort';

// A ticket runs locally when what it needs is on this computer only, and says why; otherwise in the
// cloud. The triage record decides: `renders` (Stage 5 screenshots need the browser lock and a local
// dev server), `needs_db` (a local database) and `needs_local` (anything else only here, such as
// stub binaries a check runs or a dev server). A record written before triage asked `needs_local`
// runs locally, so a ticket is never sent to the cloud on a question nobody answered. `feature` is the
// ticket's part in a feature batch, when it has one: the spine and a child owning acceptance specs
// are checked in a local worktree when they finish, so either runs locally. `effort` is whether the
// effort lever is on.
//   -> { where: 'local' | 'cloud', why: string | null }
export function placement(rec, location, { feature = null, effort = false } = {}) {
  if (location !== 'cloud') return { where: 'local', why: null };
  const why = [];
  if (effort) why.push(CLOUD_NO_EFFORT);
  if (feature) why.push(feature);
  if (rec?.lane === 'D' || rec?.renders === true) why.push('it renders: its screenshots need the browser lock and a local dev server');
  if (rec?.needs_db === true) why.push('it needs a local database');
  if (typeof rec?.needs_local === 'string' && rec.needs_local.trim()) why.push(rec.needs_local.trim());
  else if (rec?.needs_local === true) why.push('triage says it needs this computer');
  else if (!rec || !('needs_local' in rec)) why.push('its triage record does not say whether it needs this computer (re-run triage.sh to place it)');
  return why.length ? { where: 'local', why: why.join('; ') } : { where: 'cloud', why: null };
}

// Where a placed ticket runs, as the batch plan and a mid-batch admit both say it: `runs: <where>`, and
// why it stays local where placement gave a reason.
export const runsText = ({ where, why }) => `runs: ${where}${why ? ` — ${why}` : ''}`;

// Ticket `key`'s part in a feature batch that keeps it local, as placement's `feature` takes it, or null.
// `batch` is the feature batch's { spine, owners } (the owner table: criterion id -> ticket), or null
// outside feature mode.
export function featureRole(batch, key) {
  if (!batch) return null;
  if (key === batch.spine) return 'it is the feature spine, whose specs are checked in a local worktree before it parks for approval';
  return Object.values(batch.owners ?? {}).includes(key) ? 'it owns acceptance specs, which are checked in a local worktree when it finishes' : null;
}

// The marks of AI attribution, hooks/deny-ai-attribution.py's BANNED, in the same order, with what each
// is. The hook is installed standalone, so it keeps its own copy: tests/test_cloud_worker.mjs holds the two equal.
export const ATTRIBUTION_MARKS = [
  [/co-authored-by\s*[:=][^\n"']*(claude|anthropic)/i, 'a Co-Authored-By trailer naming Claude or Anthropic'],
  [/claude-session\s*[:=]/i, 'a Claude-Session trailer'],
  [/generated with \[?claude code/i, 'a "Generated with Claude Code" footer'],
  [/noreply@anthropic\.com/i, 'noreply@anthropic.com'],
  [/claude\.ai\/code\/session_/i, 'a claude.ai/code/session_ link'],
  [/\u{1F916}/u, 'the robot emoji'],
];

// The commits in a PR (`gh pr view <n> --json commits`) none of whose authors has `author.email`
// (case aside): one line per commit naming it and who it was authored as, or [] with no email to match.
export function authorMismatches(view, author) {
  const want = String(author?.email ?? '').trim().toLowerCase();
  if (!want) return [];
  const out = [];
  for (const c of view?.commits ?? []) {
    const authors = c?.authors ?? [];
    if (!authors.length || authors.some((a) => String(a?.email ?? '').trim().toLowerCase() === want)) continue;
    const sha = String(c?.oid ?? '').slice(0, 7) || '(no sha)';
    out.push(`commit ${sha} authored as ${authors.map((a) => `${a?.name ?? ''} <${a?.email ?? ''}>`).join(', ')}, not ${author.name} <${author.email}>`);
  }
  return out;
}

// The attribution in a PR, from `gh pr view <n> --json body,commits,comments`: its commits' messages and
// authors' emails, its body and its comments. -> one line per mark found, naming where, or [].
export function attributionFound(view) {
  const found = [];
  const scan = (where, text) => {
    for (const [re, what] of ATTRIBUTION_MARKS) if (re.test(String(text ?? ''))) found.push(`${what} in ${where}`);
  };
  for (const c of view?.commits ?? []) {
    const sha = String(c?.oid ?? '').slice(0, 7) || '(no sha)';
    scan(`commit ${sha}'s message`, `${c?.messageHeadline ?? ''}\n${c?.messageBody ?? ''}`);
    scan(`commit ${sha}'s authors`, (c?.authors ?? []).map((a) => `${a?.name ?? ''} <${a?.email ?? ''}>`).join('\n'));
  }
  scan('the PR body', view?.body);
  (view?.comments ?? []).forEach((c, i) => scan(`comment ${i + 1}${c?.author?.login ? ` by ${c.author.login}` : ''}`, c?.body));
  return found;
}

// `text` without its lines that carry an attribution mark, and without the blank lines that leaves at its end.
export function stripAttribution(text) {
  const kept = String(text ?? '').split('\n').filter((l) => !ATTRIBUTION_MARKS.some(([re]) => re.test(l)));
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept.join('\n');
}

// Rewrites the commits on `head` that `base` lacks, oldest first, as `author`, each message through
// stripAttribution where `strip` (§5 forbids attribution): each keeps its own tree and dates, on its
// rewritten parents. `git(args, { env, input })` runs git in the repo and returns its stdout, throwing on
// failure. -> { head, n } once `git diff` finds the new head's tree the old one's, else { error }.
export function rewriteCommits(git, { head, base, author, strip = true }) {
  const shas = git(['rev-list', '--reverse', '--topo-order', head, '--not', base]).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!shas.length) return { error: `${head.slice(0, 7)} has no commits that ${base} lacks` };
  const done = new Map();
  for (const sha of shas) {
    const [tree, parents = '', aDate, cDate] = git(['log', '-1', '--format=%T%n%P%n%aI%n%cI', sha]).split('\n');
    const body = git(['log', '-1', '--format=%B', sha]);
    const msg = strip ? stripAttribution(body) : body.replace(/\n+$/, '');
    if (!msg.trim()) return { error: `commit ${sha.slice(0, 7)}'s message is nothing but attribution` };
    const env = { ...process.env, GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: aDate,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email, GIT_COMMITTER_DATE: cDate };
    const ps = parents.split(' ').filter(Boolean).flatMap((p) => ['-p', done.get(p) ?? p]);
    done.set(sha, git(['commit-tree', tree, ...ps], { env, input: `${msg}\n` }).trim());
  }
  const out = done.get(shas.at(-1));
  try { git(['diff', '--quiet', head, out]); } catch { return { error: `the rewrite of ${head.slice(0, 7)} would change its tree` }; }
  return { head: out, n: shas.length };
}

// The repo's §1 and §5 commit and PR rules, as the cloud session is to follow them. `rules` is
// { author: { name, email }, prTitle, prBody, mergeMethod, noAttribution }, each null or false where unset.
function rulesSection(rules) {
  const r = rules ?? {};
  const lines = [];
  if (r.author) {
    lines.push(`- Author every commit as \`${r.author.name} <${r.author.email}>\`: run \`git config user.name "${r.author.name}"\` and \`git config user.email "${r.author.email}"\` before your first commit. ` +
      'A PR with a commit authored as anyone else has its commits rewritten before it merges.');
  }
  if (r.prTitle) lines.push(`- PR title: \`${r.prTitle}\`.`);
  if (r.prBody) lines.push(`- PR body: ${r.prBody}.`);
  if (r.mergeMethod) lines.push(`- PRs here merge by ${r.mergeMethod}: write your commits for that.`);
  if (r.noAttribution) {
    lines.push(`- No AI attribution anywhere: in commit messages, commit authors, the PR title and body, and PR comments, add none of these: ${ATTRIBUTION_MARKS.map(([, what]) => what).join(', ')}. ` +
      'Your harness may add these by default: remove them before you push, and amend any commit that has one. A PR carrying any of them has them stripped and its commits rewritten before it merges.');
  }
  return lines.length ? ['', `## This repo's rules`, '', ...lines] : [];
}

// The cloud session's whole brief: it reads nothing from this computer.
export function cloudPrompt({ key, repo, base, branch, text, tests, rules }) {
  const run = tests?.length ? `Run ${tests.map((c) => `\`${c}\``).join(' and ')} before you push, and fix what fails.` : 'Run the repo\'s tests for what you change before you push, and fix what fails.';
  return [
    `Work ticket ${key} in ${repo}, unattended: nobody reads this session, so take every call yourself and say what you chose in the PR body.`,
    '',
    `1. Do the smallest change that meets the ticket's acceptance criteria below. ${run}`,
    // A change that branches on a value it never read the source of is the P0 a local review then finds.
    '2. Before you push: where your change branches on a value an API or server state sets (a status, flag, enum or role read from a response or a stored record), read where that value is set, the endpoint, handler or service that assigns it, and check your branch against every value it can set, not only the one the ticket names. If that source is not in this repository, say so in the PR body as a premise: which value, and why it could not be read.',
    `3. Commit on a branch named exactly \`${branch}\`, cut from \`${base}\`, and push it to origin.`,
    `4. Open a draft pull request from \`${branch}\` into \`${base}\` with ${key} in its title, and in its body what changed and how you tested it.`,
    '5. If you cannot finish, push what you have and open the draft PR anyway, with WIP in its title and what is left in its body. When you do finish, take both out: the PR counts as finished only once neither is there.',
    `6. Do not change the ticket in the tracker: you have no access to it, and the orchestrator updates it from your PR.`,
    ...rulesSection(rules),
    '',
    `## The ticket`,
    '',
    String(text ?? '').trim(),
  ].join('\n');
}

// What `claude --cloud` printed, terminal noise removed: escape sequences (CSI, OSC, and two-byte
// ones such as ESC 7/ESC 8 and ESC ( B, which a start with no terminal of its own prints), carriage
// returns, what a backspace erases, such as the `^D` BSD script echoes when its input ends, and any
// control character left (SI among them).
const clean = (s) => {
  let out = String(s ?? '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '').replace(/\r/g, '');
  while (/[^\x08\n]\x08/.test(out)) out = out.replace(/[^\x08\n]\x08/g, '');
  return out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
};

// -> { session, url, title } from a start that worked, or { error } naming what the CLI said.
export function parseCloudStart(out) {
  const s = clean(out);
  const title = /^Created cloud session: (.*)$/m.exec(s)?.[1]?.trim();
  const url = /^View: (\S+)$/m.exec(s)?.[1];
  const session = /claude --teleport (session_\w+)/.exec(s)?.[1] ?? /\/(session_\w+)/.exec(url ?? '')?.[1];
  if (title != null && url && session) return { session, url, title };
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.find((l) => /\bError\b/.test(l));
  return { error: err ? err.slice(err.search(/\bError\b/)) : (lines.slice(-3).join(' ') || 'it printed nothing') };
}

// Starts one cloud session. `claude --cloud` will not run in print mode, so `script` gives it a
// terminal: BSD script takes the command as arguments, util-linux script a shell string, which
// reads the prompt from the environment rather than quoting it in. `name` is the session's display
// name (`--name` also names a new cloud session), so the person can tell which ones are finished.
// `env` is the login's (logins.mjs loginEnv): its CLAUDE_CONFIG_DIR picks the account the session
// starts under. A start that does not answer in `timeout` adds `timedOut: true`.
//   -> parseCloudStart's result
export function startCloud(prompt, { claude = 'claude', name = null, platform = process.platform, timeout = 120_000, env = process.env } = {}) {
  const args = platform === 'darwin' || platform.endsWith('bsd')
    ? ['-q', '/dev/null', claude, '--cloud', prompt, ...(name ? ['--name', name] : [])]
    : ['-q', '-e', '-c', `"$DESK_CLOUD_CLAUDE" --cloud "$DESK_CLOUD_PROMPT"${name ? ' --name "$DESK_CLOUD_NAME"' : ''}`, '/dev/null'];
  const r = spawnSync('script', args, {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, DESK_CLOUD_CLAUDE: claude, DESK_CLOUD_PROMPT: prompt, DESK_CLOUD_NAME: name ?? '' },
  });
  if (r.error?.code === 'ETIMEDOUT') return { error: `no answer in ${timeout / 1000}s`, timedOut: true };
  if (r.error) return { error: r.error.message };
  const got = parseCloudStart(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  return got.error && r.status ? { error: `${got.error} (exit ${r.status})` } : got;
}

// The PR a cloud session opened, from `gh pr list --json number,title,url,headRefName,createdAt,state`
// rows: on the branch it was told to use, else one with the key in its title, opened since it
// started. The first one opened is its result.
//   -> the row, or null
export function findCloudPr(prs, { key, branch, since }) {
  const from = Date.parse(since ?? '') || 0;
  const keyed = new RegExp(`(^|[^A-Za-z0-9-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`);
  const after = (prs ?? []).filter((p) => (Date.parse(p.createdAt) || 0) >= from);
  const pick = after.filter((p) => p.headRefName === branch).length ? after.filter((p) => p.headRefName === branch)
    : after.filter((p) => keyed.test(p.title ?? ''));
  return pick.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0] ?? null;
}

// A cloud session's display name: one per ticket, as a local worker's (spawn-worker.sh).
export const cloudName = (ghRepo, key) => `${String(ghRepo ?? '').split('/').pop()}-ticket-${key}`;

// A cloud ticket's cost, wherever it is shown: Claude Code reports no tokens or cost for a cloud
// session, and no OpenTelemetry collector is set up to read them, so it is named unknown with its
// session URL beside it, never left out and never $0.
export const CLOUD_COST_UNKNOWN = 'cost unknown (cloud)';
export const CLOUD_COST_WHY = 'Claude Code reports no tokens or cost for a cloud session, and no OpenTelemetry collector is set up for one, so its cost is unknown: its session URL is beside it.';

// A cloud ticket's ETA, as time from its session's start: its saved first estimate's span from start
// to ship (desk-q-eta.mjs eta.jsonl), or with none, `typicalH`, the forecast's typical slot time for
// its size (desk-q-eta.mjs typicalSlotHours). The estimate's span is used, not its `ships` time, so a
// ticket that waited in the queue or under pacing before its session started is not due already.
//   -> { ms, from: 'estimate' | 'typical' }, or null with neither
export function cloudEta({ estimate = null, typicalH = null }) {
  const span = Date.parse(estimate?.ships ?? '') - Date.parse(estimate?.starts ?? '');
  if (span > 0) return { ms: span, from: 'estimate' };
  return typicalH > 0 ? { ms: typicalH * 3_600_000, from: 'typical' } : null;
}

// A cloud session that may be stuck, quiet or stopped on an error. Nothing reads a cloud session's state
// back (a session that stopped on "Claude Code hit an error" shows only as a claude.ai notification), so
// both look the same from here: no PR and no push. In two steps, so it is sent one retry follow-up
// (CLOUD_RETRY_MSG) before it is flagged:
// - `retry`: past its start plus its ETA (cloudEta), no PR, and no push for a margin of CLOUD_STALL_SHARE
//   of that ETA, with no retry sent since its last push;
// - flagged (`retry: false`): a retry was sent, and it is past its start plus its ETA plus the margin,
//   with no push within the margin since the retry.
// A push after the retry starts it over. `lastPush` is when its branch's head commit was made, or null
// with no branch on origin (or none read yet: a caller reads it only once this says something without
// it, as a push can only make it less so). `retried` is when its retry was sent, or null. With no ETA it
// is never called stuck.
//   -> null, or { retry, due, last, margin } with `due` the start plus ETA plus margin (ms), `last` the
//      latest of the start, the push and the retry (ms), `margin` in ms
export const CLOUD_STALL_SHARE = 0.5;
export function cloudStall({ started, eta, lastPush = null, retried = null, now = Date.now() }) {
  const from = Date.parse(started ?? '');
  if (!Number.isFinite(from) || !(eta?.ms > 0)) return null;
  const margin = eta.ms * CLOUD_STALL_SHARE;
  const due = from + eta.ms + margin;
  const pushed = Date.parse(lastPush ?? '');
  const last = Number.isFinite(pushed) && pushed > from ? pushed : from;
  const sent = Date.parse(retried ?? '');
  if (!Number.isFinite(sent) || sent < last) {
    if (now <= from + eta.ms || now - last <= margin) return null;
    return { retry: true, due, last, margin };
  }
  if (now <= due || now - sent <= margin) return null;
  return { retry: false, due, last: sent, margin };
}

// The one follow-up a quiet cloud session is sent before it is flagged: it restarts a session that
// stopped on an error, and a session still working reads it after its turn.
export const CLOUD_RETRY_MSG = 'desk has seen no push or PR from this session past its expected time. If you stopped on an error, retry the step that failed and carry on with the ticket from where you were; if you are still working, carry on. Either way, push and open the draft PR as your brief says.';

// What `claude -p "<msg>" --cloud <session> --output-format json` printed (tests/fixtures/cloud/
// send-json.json): it queues the message and returns without waiting for a reply.
//   -> { ok: true } once the CLI says it queued it to that session, else { error }
export function parseCloudSend(out, session) {
  const s = clean(out).trim();
  let j = null;
  try { j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { j = null; }
  if (j?.ok === true && (!session || j.session_id === session)) return { ok: true };
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.find((l) => /\bError\b/.test(l));
  return { error: err ? err.slice(err.search(/\bError\b/)) : j ? `it answered ${JSON.stringify(j).slice(0, 200)}` : (lines.slice(-3).join(' ') || 'it printed nothing') };
}

// Sends `msg` to cloud session `session` as a follow-up. Print mode takes a follow-up to an existing
// session, so no terminal is needed. -> parseCloudSend's result
export function sendCloud(session, msg, { claude = 'claude', timeout = 60_000, env = process.env } = {}) {
  if (!/^session_\w+$/.test(String(session ?? ''))) return { error: 'its session id was not recorded' };
  const r = spawnSync(claude, ['-p', msg, '--cloud', session, '--output-format', 'json'], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], env });
  if (r.error) return { error: r.error.code === 'ETIMEDOUT' ? `no answer in ${timeout / 1000}s` : r.error.message };
  const got = parseCloudSend(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, session);
  return got.error && r.status ? { error: `${got.error} (exit ${r.status})` } : got;
}

// ---- an unfinished cloud PR ------------------------------------------------------------------------
// A session that cannot finish opens its draft anyway, marked as cloudPrompt's step 5 asks: WIP, or what
// is left. `pr` is { title, body }. -> the first mark found, or null for a PR that reads finished.
const UNFINISHED_MARKS = [
  [/(^|[^A-Za-z])WIP([^A-Za-z]|$)/, 'WIP'],
  [/\bwhat(?: is|'s|’s) (?:still )?left\b/i, 'what is left'],
  [/\b(?:cannot|can't|can’t|could not|couldn't|couldn’t) finish\b/i, 'could not finish'],
];
export function unfinishedMark(pr) {
  const text = `${pr?.title ?? ''}\n${pr?.body ?? ''}`;
  return UNFINISHED_MARKS.find(([re]) => re.test(text))?.[1] ?? null;
}

// An unfinished PR's session is sent a follow-up once CI on its head has settled, and again after
// CLOUD_IDLE_WAIT_MS with no push since; CLOUD_IDLE_FOLLOWUPS sent with no push, and that wait past the
// last, it is parked. A push starts the count over.
export const CLOUD_IDLE_FOLLOWUPS = 2;
export const CLOUD_IDLE_WAIT_MS = 3_600_000;

// What to do with an unfinished PR this pass. `prior` is the ticket's `cloud.unfinished` ({ pr, head,
// pushed_at, sent, sent_at }) or null; `head` the PR's head SHA; `pushedAt` when that commit was made;
// `checks` its checks (gate.mjs latestPerCheck). With no checks at all, CI counts as settled once the
// wait has passed since the push.
//   -> { act: 'wait' | 'send' | 'park', why, record } with `record` the `cloud.unfinished` to keep
export function cloudIdle({ prior = null, pr, head, pushedAt, checks = [], now = Date.now() }) {
  const same = prior?.head === head && prior?.pr === pr;
  const record = same ? { ...prior } : { pr, head, pushed_at: pushedAt ?? null, sent: 0, sent_at: null };
  const sentAt = Date.parse(record.sent_at ?? '');
  const quiet = (from) => Number.isFinite(from) && now - from > CLOUD_IDLE_WAIT_MS;
  if (record.sent >= CLOUD_IDLE_FOLLOWUPS) {
    return quiet(sentAt) ? { act: 'park', why: `no push since ${record.sent} follow-ups, the last at ${record.sent_at}`, record }
      : { act: 'wait', why: `follow-up ${record.sent} of ${CLOUD_IDLE_FOLLOWUPS} sent at ${record.sent_at}`, record };
  }
  if (record.sent > 0) {
    return quiet(sentAt) ? { act: 'send', why: `no push since follow-up ${record.sent}, sent at ${record.sent_at}`, record }
      : { act: 'wait', why: `follow-up ${record.sent} of ${CLOUD_IDLE_FOLLOWUPS} sent at ${record.sent_at}`, record };
  }
  if (checks.some((c) => c.status !== 'completed')) return { act: 'wait', why: 'CI is still running on its head', record };
  if (!checks.length && !quiet(Date.parse(record.pushed_at ?? ''))) return { act: 'wait', why: 'no checks on its head yet', record };
  return { act: 'send', why: checks.length ? 'CI on its head has finished' : 'no checks ran on its head', record };
}

// The follow-up an unfinished PR's session is sent, with the check results on its head.
export function cloudFollowUpMsg({ pr, head, mark, checks = [] }) {
  const failed = checks.filter((c) => FAILED.has(c.conclusion));
  const ran = checks.length
    ? `CI on ${String(head ?? '').slice(0, 7)} has finished: ${failed.length ? `${failed.map((c) => `${c.name} ${c.conclusion}`).join(', ')}; ` : ''}${checks.length - failed.length} of ${checks.length} passed.`
    : `No checks ran on ${String(head ?? '').slice(0, 7)}.`;
  return `desk reads PR #${pr} as unfinished (${mark}). ${ran} Carry on with the ticket from where you were: fix what failed, push, ` +
    'and when it is finished take WIP and what is left out of the PR title and body, and say there what changed and how you tested it. If you cannot finish, say why in the PR body.';
}

// Session start to PR, in ms, or null while there is no PR.
export const cloudWall = (cloud) => {
  const ms = Date.parse(cloud?.pr_at ?? '') - Date.parse(cloud?.started ?? '');
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

// ---- finished cloud sessions, to archive ---------------------------------------------------------
// Nothing on this computer can end or archive a cloud session (`claude stop` and `rm` act on local
// background sessions only), so a finished one stays in the person's claude.ai/code list until they
// archive it there. needs-you lists each batch's finished sessions as one item, and its done records
// them (`sessions`) in one file for the repo, in the standing batch's state folder, which archiving a
// named batch never moves; each is then asked about once. A named batch archived before that hands its
// unrecorded ones to the same file (`pending`), under the same lock, since an archived batch is no
// longer listed: the standing batch's item lists them. `stateDir` is any batch's state folder.
const archivedPath = (stateDir) => join(repoStateOf(stateDir), 'cloud-archived.json');
const readFile = (stateDir) => {
  try { const f = JSON.parse(readFileSync(archivedPath(stateDir), 'utf8')); return f && typeof f === 'object' ? f : {}; } catch { return {}; }
};

// The session ids the person has said are archived, as a Set; none when the file is missing or unreadable.
export const readArchived = (stateDir) => { const f = readFile(stateDir); return new Set(Array.isArray(f.sessions) ? f.sessions : []); };
// The finished sessions an archived named batch handed here, as finishedCloud rows.
export const readPending = (stateDir) => { const f = readFile(stateDir); return Array.isArray(f.pending) ? f.pending.filter((d) => d?.session && d.url) : []; };

// Changes the file under its lock: `change(f)` mutates { sessions, pending }.
function update(stateDir, change) {
  const file = archivedPath(stateDir), held = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  lock(held);
  try {
    let f = {};
    if (existsSync(file)) {
      try { f = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} cannot be read (${e.message}); fix or remove it first`); }
    }
    f.sessions = Array.isArray(f.sessions) ? f.sessions : [];
    f.pending = Array.isArray(f.pending) ? f.pending : [];
    change(f);
    writeJsonAtomic(file, f);
  } finally { unlock(held); }
}

// Records `sessions` as archived, and takes them off what was handed here.
export function recordArchived(stateDir, sessions) {
  update(stateDir, (f) => {
    f.sessions = [...new Set([...f.sessions, ...sessions])];
    f.pending = f.pending.filter((d) => !sessions.includes(d?.session));
  });
}

// Hands finished sessions (finishedCloud rows) to `stateDir`, each once.
export function handOver(stateDir, rows) {
  if (!rows.length) return;
  update(stateDir, (f) => {
    const have = new Set([...f.sessions, ...f.pending.map((d) => d?.session)]);
    f.pending.push(...rows.filter((d) => !have.has(d.session)));
  });
}

// The batch's finished cloud sessions not yet archived, oldest first: each ticket worked in the cloud
// whose PR has merged (a live ticket with `merged_at`), or that the queue archived, which it does once
// a done ticket's PR has merged or closed, and any `pending` handed here. `tickets` are the live ones,
// `archived` the archive's, `done` the sessions recorded archived.
//   -> [{ key, session, name, url, at }]
export function finishedCloud(tickets, archived, done = new Set(), pending = []) {
  const rows = [
    ...Object.values(tickets ?? {}).filter((t) => t?.state === 'done' && t.merged_at),
    ...Object.values(archived ?? {}),
  ].filter((t) => t?.location === 'cloud' && t.cloud?.session && t.cloud.url)
    .map((t) => ({ key: t.key, session: t.cloud.session, name: t.cloud.name ?? null, url: t.cloud.url, at: t.merged_at ?? t.cloud.pr_at ?? t.cloud.started ?? null }));
  const seen = new Set(done);
  return [...rows, ...pending].filter((d) => !seen.has(d.session) && seen.add(d.session))
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}
