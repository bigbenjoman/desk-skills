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
import { spawnSync } from 'node:child_process';

// A ticket runs locally when what it needs is on this computer only, and says why; otherwise in the
// cloud. The triage record decides: `renders` (Stage 5 screenshots need the browser lock and a local
// dev server), `needs_db` (a local database) and `needs_local` (anything else only here, such as
// stub binaries a check runs or a dev server). A record written before triage asked `needs_local`
// runs locally, so a ticket is never sent to the cloud on a question nobody answered.
//   -> { where: 'local' | 'cloud', why: string | null }
export function placement(rec, location) {
  if (location !== 'cloud') return { where: 'local', why: null };
  const why = [];
  if (rec?.lane === 'D' || rec?.renders === true) why.push('it renders: its screenshots need the browser lock and a local dev server');
  if (rec?.needs_db === true) why.push('it needs a local database');
  if (typeof rec?.needs_local === 'string' && rec.needs_local.trim()) why.push(rec.needs_local.trim());
  else if (rec?.needs_local === true) why.push('triage says it needs this computer');
  else if (!rec || !('needs_local' in rec)) why.push('its triage record does not say whether it needs this computer (re-run triage.sh to place it)');
  return why.length ? { where: 'local', why: why.join('; ') } : { where: 'cloud', why: null };
}

// The cloud session's whole brief: it reads nothing from this computer.
export function cloudPrompt({ key, repo, base, branch, text, tests }) {
  const run = tests?.length ? `Run ${tests.map((c) => `\`${c}\``).join(' and ')} before you push, and fix what fails.` : 'Run the repo\'s tests for what you change before you push, and fix what fails.';
  return [
    `Work ticket ${key} in ${repo}, unattended: nobody reads this session, so take every call yourself and say what you chose in the PR body.`,
    '',
    `1. Do the smallest change that meets the ticket's acceptance criteria below. ${run}`,
    `2. Commit on a branch named exactly \`${branch}\`, cut from \`${base}\`, and push it to origin.`,
    `3. Open a draft pull request from \`${branch}\` into \`${base}\` with ${key} in its title, and in its body what changed and how you tested it.`,
    '4. If you cannot finish, push what you have and open the draft PR anyway, with what is left in its body.',
    `5. Do not change the ticket in the tracker: you have no access to it, and the orchestrator updates it from your PR.`,
    '',
    `## The ticket`,
    '',
    String(text ?? '').trim(),
  ].join('\n');
}

// What `claude --cloud` printed, terminal noise removed: escape sequences, carriage returns, and
// what a backspace erases, such as the `^D` BSD script echoes when its input ends.
const clean = (s) => {
  let out = String(s ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  while (/[^\x08\n]\x08/.test(out)) out = out.replace(/[^\x08\n]\x08/g, '');
  return out.replace(/\x08/g, '');
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
// reads the prompt from the environment rather than quoting it in.
//   -> parseCloudStart's result
export function startCloud(prompt, { claude = 'claude', platform = process.platform, timeout = 120_000, env = process.env } = {}) {
  const args = platform === 'darwin' || platform.endsWith('bsd')
    ? ['-q', '/dev/null', claude, '--cloud', prompt]
    : ['-q', '-e', '-c', `"$DESK_CLOUD_CLAUDE" --cloud "$DESK_CLOUD_PROMPT"`, '/dev/null'];
  const r = spawnSync('script', args, {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, DESK_CLOUD_CLAUDE: claude, DESK_CLOUD_PROMPT: prompt },
  });
  if (r.error) return { error: r.error.code === 'ETIMEDOUT' ? `no answer in ${timeout / 1000}s` : r.error.message };
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

// Session start to PR, in ms, or null while there is no PR.
export const cloudWall = (cloud) => {
  const ms = Date.parse(cloud?.pr_at ?? '') - Date.parse(cloud?.started ?? '');
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};
