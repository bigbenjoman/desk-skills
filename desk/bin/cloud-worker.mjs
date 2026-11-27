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
    '5. If you cannot finish, push what you have and open the draft PR anyway, with what is left in its body.',
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
