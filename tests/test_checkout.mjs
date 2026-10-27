// suite: desk-checkout collectors (window, repo scopes, Claude, GitHub and Jira activity)
// Runs the check-out scripts under skills/desk-checkout/scripts/ (window.py, desk_repos.py,
// claude_activity.py, github_activity.py, jira_activity.py) against a throwaway HOME, a scratch desk
// config root and fake `gh` and `desk-jira` on PATH: no real GitHub, Jira or ~/.claude.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const has = (name, text, part) => t(name, text.includes(part), true);
const lacks = (name, text, part) => t(name, text.includes(part), false);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(REPO, 'skills', 'desk-checkout', 'scripts');

const R = mkdtempSync(join(tmpdir(), 'desk-checkout-'));
const HOME = join(R, 'home');
const CFG = join(R, 'cfg');
const BIN = join(R, 'bin');
const FAKE = join(R, 'fake');
for (const d of [HOME, BIN, FAKE]) mkdirSync(d, { recursive: true });

// Four repos: app (the one the check-out is written from), lib (same check-out destination, so this
// check-out too, but read-own-work is ask), other (a different destination), side (a side project).
const config = (slug, rows, perms) => {
  mkdirSync(join(CFG, 'repos', slug), { recursive: true });
  writeFileSync(join(CFG, 'repos', slug, 'config.md'), [
    '## 0. Repo', '| Field | Value |', '|---|---|', `| GitHub repo | \`${slug.replace('__', '/')}\` |`, '',
    '## 2. Paths', '| Field | Value |', '|---|---|', `| Primary repo root | \`${join(R, slug)}\` |`, `| Worktrees directory | \`${join(R, `${slug}-worktrees`)}\` |`, '',
    '## 3. Permissions', '| Key | Capability | Recommended | Your setting |', '|---|---|---|---|',
    ...Object.entries(perms).map(([k, v]) => `| \`${k}\` | x | \`yes\` | \`${v}\` |`), '',
    '## 4. Project', '| Field | Value |', '|---|---|', ...Object.entries(rows).map(([k, v]) => `| ${k} | \`${v}\` |`), '',
  ].join('\n'));
};
const jira = (project, dest) => ({ Tracker: 'jira', 'Jira site': 'acme.atlassian.net', 'Jira project': project, 'Ticket key pattern': `${project}-[0-9]+`, Priority: 'customfield_10207', 'Check-out destination': dest });
config('acme__app', jira('APP', '#team'), { 'read-transcripts': 'yes', 'read-own-work': 'yes' });
config('acme__lib', jira('LIB', '#team'), { 'read-transcripts': 'yes', 'read-own-work': 'ask' });
config('acme__other', jira('OTH', '#elsewhere'), { 'read-transcripts': 'no', 'read-own-work': 'no' });
config('acme__side', { Tracker: 'none', 'Check-out destination': 'none' }, { 'read-transcripts': 'yes', 'read-own-work': 'yes' });

// The check-out is written from acme/app's main checkout.
const APP = join(R, 'acme__app');
mkdirSync(APP);
execFileSync('git', ['init', '-q', APP]);
execFileSync('git', ['-C', APP, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);

// A fake `gh` and `desk-jira`: canned JSON from $FAKE, keyed by their arguments, every call logged.
const fake = (name, body) => {
  const f = join(BIN, name);
  writeFileSync(f, `#!/usr/bin/env node
const { readFileSync, appendFileSync, existsSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DIR + '/calls.log', ${JSON.stringify(name)} + ' ' + (process.env.DESK_SLUG || '-') + ' ' + args.join(' ') + '\\n');
const out = (k) => { const f = process.env.FAKE_DIR + '/' + k + '.json'; if (!existsSync(f)) { console.error('no fake for ' + k); process.exit(1); } process.stdout.write(readFileSync(f, 'utf8')); };
${body}
`);
  chmodSync(f, 0o755);
};
fake('gh', `
if (args[0] === 'api' && args[1] === 'user') { console.log('me'); process.exit(0); }
if (args[0] === 'api' && args.includes('search/issues')) out(args.find((a) => a.startsWith('q=')).includes('reviewed-by') ? 'reviewed' : 'mine');
else if (args[0] === 'api') out(args[1].replace(/[^A-Za-z0-9]+/g, '_'));
else if (args[0] === 'pr' && args[1] === 'view') out('pr_' + args[4].replace('/', '_') + '_' + args[2]);
else process.exit(1);`);
fake('desk-jira', `
if (args[0] !== 'api') process.exit(1);
const path = args[1].split('?')[0];
out(path.replace(/[^A-Za-z0-9]+/g, '_'));`);
const put = (k, v) => writeFileSync(join(FAKE, `${k}.json`), JSON.stringify(v));

// The day under check-out: 26 Oct 2026, local time, as window.py reads it.
const DAY = '2026-10-26';
const at = (h, m = 0) => new Date(2026, 9, 26, h, m).toISOString();
const before = new Date(2026, 9, 20, 12).toISOString();
const jiraAt = (iso) => iso.replace('Z', '+0000');

const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/^(DESK_|JIRA_)/.test(k)) env[k] = v;
Object.assign(env, {
  HOME, PATH: `${BIN}:${process.env.PATH}`, FAKE_DIR: FAKE, PYTHONDONTWRITEBYTECODE: '1',
  DESK_CONFIG_ROOT: CFG, DESK_ENV_MJS: join(REPO, 'desk', 'bin', 'desk-env.mjs'), DESK_CHECKOUT_SIDE_REPOS: 'acme/side',
});
const py = (args) => spawnSync('python3', ['-B', ...args], { cwd: APP, env, encoding: 'utf8' });
const script = (name, ...args) => { const r = py([join(SCRIPTS, name), ...args]); if (r.status) console.log(r.stderr); return r; };
// A snippet with the scripts' directory importable, printing one JSON value.
const probe = (code) => {
  const r = py(['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(SCRIPTS)})\n${code}`]);
  if (r.status) { console.log(r.stderr); return null; }
  return JSON.parse(r.stdout);
};

// window.py: which day a check-out covers.
const win = probe(`import window
from datetime import datetime
tue = lambda h, m=0: datetime(2026, 10, 27, h, m)
day = lambda d, now: window.resolve(d, now)[0].date().isoformat()
s, e = window.resolve('2026-10-01', tue(12))
print(json.dumps({
  'early': day('auto', tue(9, 59)), 'late': day('auto', tue(10)), 'today': day('today', tue(9)),
  'yesterday': day('yesterday', tue(15)), 'monday': day('Monday', tue(12)), 'tuesday': day('tuesday', tue(12)),
  'date': s.date().isoformat(), 'hours': (e - s).total_seconds() / 3600, 'label': window.label(s)}))`);
t('window: auto before 10:00 is yesterday', win?.early, '2026-10-26');
t('window: auto from 10:00 is today', win?.late, '2026-10-27');
t('window: today', win?.today, '2026-10-27');
t('window: yesterday', win?.yesterday, '2026-10-26');
t('window: a weekday name is the most recent one before today', win?.monday, '2026-10-26');
t("window: today's own weekday name is a week back", win?.tuesday, '2026-10-20');
t('window: a date', win?.date, '2026-10-01');
t('window: the window is one whole day', win?.hours, 24);
t('window: the label', win?.label, 'Thursday 1 October 2026');

// desk_repos.py: every configured repo, scoped against the current one, read through desk-env.
const repos = probe(`import desk_repos as d
repos, cur = d.load_all(['acme__lib'])
by = {r.slug: r for r in repos}
print(json.dumps({
  'current': cur.slug, 'scopes': {r.slug: r.scope for r in repos},
  'gh': by['acme__other'].gh_repo, 'tracker': by['acme__app'].tracker,
  'ticket': bool(by['acme__app'].ticket_regex.search('fixes APP-12 today')),
  'not_ticket': bool(by['acme__app'].ticket_regex.search('XAPP-12')),
  'side_tracker': by['acme__side'].ticket_regex is None,
  'wt': (d.repo_for_path(${JSON.stringify(join(R, 'acme__app-worktrees', 'APP-12'))}, repos, cur) or by['acme__side']).slug,
  'elsewhere': d.repo_for_path(${JSON.stringify(R)}, repos, cur) is None,
  'named': d.scope_for_repo_name('ACME/Other', repos)[0], 'unknown': d.scope_for_repo_name('nobody/x', repos)[0],
  'ask_included': d.allowed(by['acme__lib'], 'read-own-work'),
  'ask': d.allowed(by['acme__app'], 'read-other-thing'),
  'no': d.allowed(by['acme__other'], 'read-own-work')}))`);
t('repos: the current repo is the cwd\'s', repos?.current, 'acme__app');
t('repos: scopes', JSON.stringify(repos?.scopes), JSON.stringify({ acme__app: 'this', acme__lib: 'this', acme__other: 'other', acme__side: 'side' }));
t('repos: owner/name from the config', repos?.gh, 'acme/other');
t('repos: tracker', repos?.tracker, 'jira');
t('repos: the ticket key pattern finds a key', repos?.ticket, true);
t('repos: and only a whole one', repos?.not_ticket, false);
t('repos: no tracker, no ticket pattern', repos?.side_tracker, true);
t('repos: a worktree belongs to its repo', repos?.wt, 'acme__app');
t('repos: a directory in no repo belongs to none', repos?.elsewhere, true);
t('repos: a GitHub name takes its repo\'s scope', repos?.named, 'other');
t('repos: an unknown GitHub name is not work for this check-out', repos?.unknown, 'none');
t('repos: ask, and the user agreed', JSON.stringify(repos?.ask_included), '[true,""]');
t('repos: an unset row is no', JSON.stringify(repos?.ask), '[false,"acme__app: §3 read-other-thing is no - skipped"]');
t('repos: no is skipped', JSON.stringify(repos?.no), '[false,"acme__other: §3 read-own-work is no - skipped"]');

// claude_activity.py: sessions under ~/.claude/projects, one block each.
const session = (id, cwd, entries) => {
  const dir = join(HOME, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify({ cwd, entrypoint: 'cli', ...e })).join('\n'));
};
const user = (ts, text) => ({ type: 'user', timestamp: ts, message: { content: text } });
const said = (ts, text, tools = []) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }, ...tools.map((input) => ({ type: 'tool_use', ...input }))] } });
session('aaaa1111-app', join(R, 'acme__app-worktrees', 'APP-12'), [
  { ...user(at(9), 'Please fix APP-12, the login redirect loop'), gitBranch: 'fix/APP-12-redirect' },
  said(at(9, 30), 'Fixed it.', [{ name: 'Edit', input: {} }, { name: 'Bash', input: { command: 'git commit -m "fix: stop the redirect loop"' } }]),
  said(at(10), 'Opened https://github.com/acme/app/pull/345 for APP-12.'),
  user(before, 'An old prompt from last week, outside the window'),
]);
session('bbbb2222-else', join(R, 'scratch'), [user(at(11), 'Reorganise my photo folders by year please'), said(at(11, 5), 'Done.', [{ name: 'Bash', input: { command: 'ls' } }])]);
session('cccc3333-other', join(R, 'acme__other'), [user(at(12), 'Work on OTH-7 in the other repo please'), said(at(12, 5), 'On it.', [{ name: 'Bash', input: { command: 'ls' } }])]);
session('dddd4444-self', APP, [
  user(at(16), 'Wrap up the docs for APP-40 before the end of day'),
  said(at(16, 5), 'Done.', [{ name: 'Edit', input: {} }]),
  { type: 'assistant', timestamp: at(17), message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'desk-checkout' } }] } },
  user(at(17, 1), 'SECRET-AFTER the check-out started, APP-99'),
]);
const claude = script('claude_activity.py', '--day', DAY);
t('claude: exits 0', claude.status, 0);
const co = claude.stdout;
has('claude: four sessions in the window, less the withheld one', co, '— 3 sessions');
has('claude: the worktree session is labelled with its worktree', co, 'acme__app (worktree APP-12)');
has('claude: its branch', co, 'branches: fix/APP-12-redirect');
has('claude: its ticket', co, 'tickets mentioned: APP-12');
has('claude: its commit', co, 'commits: fix: stop the redirect loop');
has('claude: the PR it opened', co, 'PRs acted on: #345');
has('claude: edits and bash counted', co, 'tool calls: 2 (file edits 1, bash 1)');
lacks('claude: a prompt before the window is left out', co, 'old prompt');
has('claude: a session in no repo is marked not work', co, 'NOT work for this check-out, session bbbb2222');
has('claude: a repo whose read-transcripts is no is withheld', co, '(1 session withheld: acme__other: §3 read-transcripts is no - skipped)');
lacks('claude: and none of it shows', co, 'OTH-7');
has('claude: the drafting session up to the skill load', co, 'APP-40');
lacks('claude: and nothing after it', co, 'SECRET-AFTER');
const tail = script('claude_activity.py', '--day', DAY, '--session', 'aaaa', '--tail', '1').stdout;
has('claude: --session prints the last replies in full', tail, 'Opened https://github.com/acme/app/pull/345 for APP-12.');
lacks('claude: only the last n', tail, 'Fixed it.');

// github_activity.py: the user's PRs that moved on the day, grouped by scope.
const pr = (repo, number, title, extra = {}) => ({ repository_url: `https://api.github.com/repos/${repo}`, number, title, state: 'open', created_at: before, user: { login: 'me' }, pull_request: {}, ...extra });
put('mine', { items: [
  pr('acme/app', 10, 'Fix the redirect', { created_at: at(9), state: 'closed', closed_at: at(15), pull_request: { merged_at: at(15) } }),
  pr('acme/other', 11, 'Other thing', { created_at: at(9) }),
  pr('nobody/x', 12, 'A pushed PR'),
  pr('acme/app', 13, 'Untouched today'),
  pr('acme/side', 14, 'Side work', { created_at: at(10) }),
] });
put('repos_nobody_x_pulls_12_commits', [
  { author: { login: 'me' }, commit: { committer: { date: at(11) }, message: 'more work' } },
  { author: { login: 'me' }, commit: { committer: { date: at(11) }, message: 'Merge branch main' } },
  { author: { login: 'me' }, commit: { committer: { date: before }, message: 'older' } },
]);
put('repos_acme_app_pulls_13_commits', []);
put('repos_acme_side_pulls_14_commits', []);
put('pr_nobody_x_12', { reviewDecision: 'APPROVED', isDraft: false, statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }] });
put('pr_acme_side_14', { reviewDecision: 'REVIEW_REQUIRED', isDraft: true, statusCheckRollup: [{ name: 'lint', conclusion: 'FAILURE' }] });
put('reviewed', { items: [pr('acme/app', 20, 'Alice\'s change', { user: { login: 'alice' } }), pr('acme/app', 21, 'Reviewed last week', { user: { login: 'bob' } })] });
put('repos_acme_app_pulls_20_reviews', [{ user: { login: 'me' }, state: 'CHANGES_REQUESTED', submitted_at: at(14) }, { user: { login: 'carol' }, state: 'APPROVED', submitted_at: at(14) }]);
put('repos_acme_app_pulls_21_reviews', [{ user: { login: 'me' }, state: 'APPROVED', submitted_at: before }]);
const github = script('github_activity.py', '--day', DAY);
t('github: exits 0', github.status, 0);
const go = github.stdout;
has('github: the header names the user and the day', go, '# GitHub activity for me, Monday 26 October 2026');
has('github: opened and merged on the day', go, '## This check-out PRs (1)\n- acme/app#10 Fix the redirect — opened; merged');
has('github: a side project, with its state', go, '## Side project PRs (1)\n- acme/side#14 Side work — opened; draft, review required, failing: lint');
has('github: pushed commits, less merges and older ones', go, '- nobody/x#12 A pushed PR — 1 commit pushed; approved, checks green');
lacks('github: a PR nothing happened to is left out', go, 'Untouched today');
has('github: a review given on the day', go, "## Reviews you gave (1)\n- acme/app#20 Alice's change (by alice) — you: changes requested");
lacks('github: a review from before the day is left out', go, 'Reviewed last week');
has('github: a repo whose read-own-work is no is skipped, and said', go, '## Skipped by permission\n- acme__other: §3 read-own-work is no - skipped');
lacks('github: and none of it shows', go, 'Other thing');

// jira_activity.py: what the user did in each in-scope repo's Jira project.
put('api_3_myself', { accountId: 'me-id', displayName: 'Me Person' });
const issue = (key, summary, extra = {}) => ({ key, fields: { summary, status: { name: 'In Progress' }, assignee: { displayName: 'Me Person' }, created: jiraAt(before), creator: { accountId: 'me-id' }, labels: [], customfield_10207: { value: 'P2' }, ...extra } });
put('api_3_search_jql', { issues: [issue('APP-1', 'A new bug', { created: jiraAt(at(9)), status: { name: 'To Do' } }), issue('APP-2', 'Started work'), issue('APP-3', 'Not mine')], isLast: true });
const history = (who, ts, field, from, to, extra = {}) => ({ author: { accountId: who, displayName: who === 'me-id' ? 'Me Person' : 'Sam Smith' }, created: jiraAt(ts), items: [{ field, fromString: from, toString: to, ...extra }] });
put('api_3_issue_APP_1_changelog', { values: [], isLast: true });
put('api_3_issue_APP_2_changelog', { values: [
  history('me-id', at(9), 'status', 'To Do', 'In Progress'),
  history('me-id', at(10), 'assignee', null, 'Me Person'), history('me-id', at(10, 5), 'assignee', 'Me Person', null),
  history('me-id', at(10, 10), 'Rank', 'a', 'b', { fieldtype: 'custom' }),
  history('sam-id', at(15), 'status', 'In Progress', 'Done'),
], isLast: true });
put('api_3_issue_APP_3_changelog', { values: [history('sam-id', at(9), 'status', 'To Do', 'Done')], isLast: true });
const comment = (who, ts, text) => ({ author: { accountId: who }, created: jiraAt(ts), body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
put('api_3_issue_APP_1_comment', { comments: [] });
put('api_3_issue_APP_2_comment', { comments: [comment('me-id', at(11), 'Looks good to me'), comment('me-id', before, 'An old comment')] });
put('api_3_issue_APP_3_comment', { comments: [comment('sam-id', at(11), 'Not by me')] });
const jiraOut = script('jira_activity.py', '--day', DAY);
t('jira: exits 0', jiraOut.status, 0);
const jo = jiraOut.stdout;
has('jira: the header names the user, project and repo', jo, '# Jira activity for Me Person in APP (acme__app), Monday 26 October 2026');
has('jira: a ticket raised on the day, with its grade', jo, '## Raised (1)\n### individually (1)\n- APP-1 [To Do · Me Person · P2] A new bug');
has('jira: a status move', jo, '- APP-2 [In Progress · Me Person · P2] Started work\n    · status: To Do → In Progress');
lacks('jira: an assign-then-unassign nets to nothing', jo, 'assignee:');
lacks('jira: Rank moves are not reported', jo, 'Rank');
has('jira: a comment on the day', jo, '    · commented: Looks good to me');
lacks('jira: a comment from before the day is left out', jo, 'An old comment');
has('jira: what someone else did after, on your ticket', jo, '    · then Sam: In Progress → Done');
lacks('jira: a ticket only others touched is left out', jo, 'Not mine');
has('jira: a same-destination repo at ask is not read without --include', jo, '- acme__lib: §3 read-own-work is ask - pass --include acme__lib once the user agrees');
has('jira: a repo with a different destination is named, not queried', jo, '- not queried (different check-out destination): acme__other');
const calls = readFileSync(join(FAKE, 'calls.log'), 'utf8').split('\n').filter((l) => l.startsWith('desk-jira '));
t('jira: every request went through desk-jira as acme__app', calls.every((l) => l.startsWith('desk-jira acme__app api ')), true);
t('jira: the search is limited to the project', calls.some((l) => decodeURIComponent(l.replace(/\+/g, ' ')).includes('project = APP AND (')), true);

t('nothing wrote a __pycache__ into the skill', existsSync(join(SCRIPTS, '__pycache__')), false);
rmSync(R, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
