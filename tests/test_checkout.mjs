// suite: desk-checkout collectors (window, repo scopes, Claude, GitHub, Jira and work-log activity)
// layer: L2
// Runs the check-out scripts under skills/desk-checkout/scripts/ (window.py, desk_repos.py,
// claude_activity.py, github_activity.py, jira_activity.py, worklog_activity.py) against a throwaway HOME, a scratch desk
// config root and fake `gh` and `desk-jira` on PATH: no real GitHub, Jira or ~/.claude.
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, utimesSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const has = (name, text, part) => t(name, text.includes(part), true);
const lacks = (name, text, part) => t(name, text.includes(part), false);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(REPO, 'skills', 'desk-checkout', 'scripts');

const R = scratch('desk-checkout-');
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
config('acme__app', jira('APP', '#team'), { 'read-transcripts': 'yes', 'read-own-work': 'yes', 'read-others': 'yes' });
config('acme__lib', jira('LIB', '#team'), { 'read-transcripts': 'yes', 'read-own-work': 'ask', 'read-others': 'ask' });
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
// #1666 a rate limit: a call whose arguments contain $FAKE_LIMIT_MATCH fails with GitHub's secondary
// limit for its first $FAKE_LIMIT_TIMES calls (counted in limit.count), with a Retry-After header
// under -i when $FAKE_RETRY_AFTER is set; -i prints a header block before the body, as gh api -i does.
if (process.env.FAKE_LIMIT_MATCH && args.join(' ').includes(process.env.FAKE_LIMIT_MATCH)) {
  const cf = process.env.FAKE_DIR + '/limit.count';
  const n = existsSync(cf) ? Number(readFileSync(cf, 'utf8')) : 0;
  if (n < Number(process.env.FAKE_LIMIT_TIMES)) {
    require('node:fs').writeFileSync(cf, String(n + 1));
    if (args.includes('-i')) process.stdout.write('HTTP/2.0 403 Forbidden\\r\\n' + (process.env.FAKE_RETRY_AFTER ? 'Retry-After: ' + process.env.FAKE_RETRY_AFTER + '\\r\\n' : '') + '\\r\\n{"message":"You have exceeded a secondary rate limit."}');
    process.stderr.write('gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)\\n');
    process.exit(1);
  }
}
if (args.includes('-i')) process.stdout.write('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n');
if (args[0] === 'api' && args[1] === 'user') { console.log('me'); process.exit(0); }
const q = args.find((a) => a.startsWith('q=')) || '';
const page = (args.find((a) => a.startsWith('page=')) || 'page=1').slice(5);
if (args[0] === 'api' && args.includes('search/issues') && q.includes('is:issue')) {
  // Issue searches by kind and page; a page or repo with no fake has no results.
  const k = (q.includes('commenter:') ? 'issues_commented' : q.includes('closed:>=') ? 'issues_closed_' + q.match(/repo:(\\S+)/)[1].replace('/', '_') : 'issues_mine') + (page === '1' ? '' : '_p' + page);
  if (existsSync(process.env.FAKE_DIR + '/' + k + '.json')) out(k); else process.stdout.write('{"items":[],"total_count":0}');
} else if (args[0] === 'api' && args.includes('search/issues') && q.includes('is:merged')) out('merged_' + q.match(/repo:(\\S+)/)[1].replace('/', '_'));
else if (args[0] === 'api' && args.includes('search/issues')) out(q.includes('reviewed-by') ? 'reviewed' : 'mine');
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

// #814: a second check-out of the same day starts where the previous one was posted.
const since = probe(`import window
from datetime import datetime
tue = lambda h, m=0: datetime(2026, 10, 27, h, m)
hm = lambda r: r[0].strftime('%Y-%m-%d %H:%M')
print(json.dumps({
  'whole': hm(window.resolve('today', tue(18))),
  'none': hm(window.resolve('today', tue(18), since='none')),
  'hhmm': hm(window.resolve('today', tue(18), since='15:45')),
  'iso': hm(window.resolve('today', tue(18), since=tue(16, 5).astimezone().isoformat())),
  'other_day': hm(window.resolve('today', tue(18), since=datetime(2026, 10, 26, 17).astimezone().isoformat())),
  'later_than_now': hm(window.resolve('today', tue(12), since='15:00')),
  'yesterday_hhmm': hm(window.resolve('yesterday', tue(18), since='12:30')),
  'utc_z': hm(window.resolve('today', tue(18), since=tue(16, 5).astimezone().astimezone(__import__('datetime').timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))),
  'none_upper': hm(window.resolve('today', tue(18), since='NONE')),
  'label': window.label(window.resolve('today', tue(18), since='12:30')[0]),
  'evening': hm(window.resolve('today', tue(18), since=datetime(2026, 10, 26, 22, 3).astimezone().isoformat(), since_for='2026-10-26')),
  'evening_label': window.label(*window.resolve('today', tue(18), since=datetime(2026, 10, 26, 22, 3).astimezone().isoformat(), since_for='2026-10-26')),
  'next_morning': hm(window.resolve('today', tue(18), since=tue(9).astimezone().isoformat(), since_for='2026-10-26')),
  'after_day': hm(window.resolve('yesterday', tue(18), since=tue(9).astimezone().isoformat()))}))`);
t('#814 with no previous check-out, the window is the whole day', since?.whole, '2026-10-27 00:00');
t('#814 --since none covers the whole day', since?.none, '2026-10-27 00:00');
t('#814 --since takes HH:MM on the day', since?.hhmm, '2026-10-27 15:45');
t('#814 --since takes an ISO timestamp', since?.iso, '2026-10-27 16:05');
t('#1008 a check-out posted the evening before moves the window back to it', since?.other_day, '2026-10-26 17:00');
t('#1008 so a merge between that post and midnight is in it', since?.evening, '2026-10-26 22:03');
t('#1008 the label names the evening it starts from', since?.evening_label, 'Tuesday 27 October 2026, from Monday 26 October 22:03 (the previous check-out)');
t('#1008 one written the next morning for its own day covered only that day: the window starts at midnight', since?.next_morning, '2026-10-27 00:00');
t('#1008 a post after the day covered leaves that day whole', since?.after_day, '2026-10-26 00:00');
t('#814 a time not yet past leaves it whole', since?.later_than_now, '2026-10-27 00:00');
t('#814 HH:MM is on the day covered, not today', since?.yesterday_hhmm, '2026-10-26 12:30');
t('#814 a UTC timestamp ending in Z (as an API gives it) is read, not refused', since?.utc_z, '2026-10-27 16:05');
t('#814 none in any case covers the whole day', since?.none_upper, '2026-10-27 00:00');
t('#814 the label names where the window starts', since?.label, 'Tuesday 27 October 2026, from 12:30 (the previous check-out)');

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
  return join(dir, `${id}.jsonl`);
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
const skillLoad = (ts) => ({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'desk-checkout' } }] } });
session('dddd4444-self', APP, [
  user(at(16), 'Wrap up the docs for APP-40 before the end of day'),
  said(at(16, 5), 'Done.', [{ name: 'Edit', input: {} }]),
  skillLoad(at(17)),
  user(at(17, 1), 'SECRET-AFTER the check-out started, APP-99'),
]);
// The session that drafted a 15:00 check-out: real work first, then the skill load just before the post.
session('eeee5555-midday', APP, [
  user(at(13), 'Investigate the APP-50 flaky login test please'),
  said(at(13, 10), 'Fixed.', [{ name: 'Edit', input: {} }]),
  skillLoad(at(14, 55)),
  user(at(15, 5), 'MIDDAY-POSTED looks good, send it to the channel'),
  said(at(15, 6), 'Posted.', [{ name: 'Bash', input: { command: 'ls' } }]),
]);
// A session that drafted a check-out last week and was resumed for real work on the day.
session('ffff6666-resumed', APP, [
  skillLoad(before),
  user(at(14), 'Carry on with APP-60, the export bug, from where we left it'),
  said(at(14, 10), 'Done.', [{ name: 'Edit', input: {} }]),
]);
// A session that drafted the 09:00 check-out (for the day before) and was worked in after the 15:00 one.
session('gggg7777-morning', APP, [
  skillLoad(at(9)),
  user(at(15, 30), 'Now the APP-70 CSV import, please'),
  said(at(15, 40), 'Done.', [{ name: 'Edit', input: {} }]),
]);
// A load in another repo's session just after the midday draft's: another check-out, not this one's.
session('llll1212-otherco', join(R, 'acme__other'), [skillLoad(at(14, 58))]);
// A 16:30 check-out drafted in a session closed at 16:25, before the post, and one that drafted a
// check-out at 16:00 and was worked in after the 16:30 one.
const closed = session('jjjj1010-closed', APP, [skillLoad(at(16, 20)), user(at(16, 25), 'Save it as a draft, I will post it')]);
utimesSync(closed, new Date(at(16, 25)), new Date(at(16, 25)));
session('kkkk1111-fourpm', APP, [
  skillLoad(at(16)),
  user(at(17, 30), 'Back to APP-90, the invoice rounding'),
  said(at(17, 40), 'Done.', [{ name: 'Edit', input: {} }]),
]);
// The evening before: a morning check-out's session worked in after the 17:30 post, and the session that drafted that post.
const sun = (h, m = 0) => new Date(2026, 9, 25, h, m).toISOString();
session('hhhh8888-sunday', APP, [
  skillLoad(sun(9)),
  user(sun(18), 'Look at the APP-80 retry queue before bed'),
  said(sun(18, 10), 'Done.', [{ name: 'Edit', input: {} }]),
]);
session('iiii9999-sunpost', APP, [
  skillLoad(sun(17, 20)),
  user(sun(17, 35), 'EVENING-POSTED thanks, all sent'),
  said(sun(17, 36), 'Posted.', [{ name: 'Bash', input: { command: 'ls' } }]),
]);
const claude = script('claude_activity.py', '--day', DAY);
t('claude: exits 0', claude.status, 0);
const co = claude.stdout;
has('claude: six sessions in the window, less the withheld one', co, '— 5 sessions');
const after = script('claude_activity.py', '--day', DAY, '--since', '15:00').stdout;
lacks('#832 the session that drafted the earlier check-out is not listed after it', after, 'eeee5555');
lacks('#832 nor what it did once the skill loaded', after, 'MIDDAY-POSTED');
has('#832 a session that drafted an earlier check-out that day still lists its work after the previous one', after, 'APP-70');
has('#832 its work before the skill load is kept when the window covers it', co, 'APP-50');
lacks('#832 and still nothing after the load', co, 'MIDDAY-POSTED');
has('#832 a check-out drafted on an earlier day does not cut a session resumed since', co, 'APP-60');
const fourThirty = script('claude_activity.py', '--day', DAY, '--since', '16:30').stdout;
has('#832 a drafting session closed before its post is still the one cut, not an earlier drafter worked in since', fourThirty, 'APP-90');
const evening = script('claude_activity.py', '--day', DAY, '--since', new Date(2026, 9, 25, 17, 30).toISOString(), '--since-for', '2026-10-25').stdout;
lacks('#832 from a check-out posted the evening before, the session that drafted it is not listed', evening, 'EVENING-POSTED');
has('#832 but a session that drafted that morning\'s check-out lists its evening work', evening, 'APP-80');
has('#814 from a check-out posted at 15:00, only the work after it is listed, and the header says from when', after, `${'Monday 26 October 2026'}, from 15:00 (the previous check-out)`);
lacks('#814 work the earlier check-out covered is not listed again', after, 'photo folders');
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

// #1646 --window-turns: a session that ran through the day is listed turn by turn, not by its end alone.
session('mmmm1313-long', APP, [
  user(at(1), 'Run the orchestrator for the APP batch please'),
  said(at(1, 5), 'Started.', [{ name: 'Bash', input: { command: 'ls' } }]),
  said(at(2), 'EARLY-RESULT batch planned with 4 tickets'),
  user(at(12), 'How is it going with APP-200 and the rest?'),
  said(at(12, 5), `MIDDAY-REPLY ${'x'.repeat(800)} REPLY-TAIL`),
  user(at(22), 'Wrap up for the night and summarise'),
  said(at(22, 10), 'All merged.'),
]);
const plain = script('claude_activity.py', '--day', DAY).stdout;
lacks('#1646 without --window-turns a long session shows only its end', plain, 'EARLY-RESULT');
const turns = script('claude_activity.py', '--day', DAY, '--window-turns');
t('#1646 --window-turns: exits 0', turns.status, 0);
const wt = turns.stdout;
has('#1646 a session spanning more than half the window is listed turn by turn', wt, "turns in the window (3; a long session, so each prompt with Claude's final reply):");
has('#1646 each prompt in the window, with its time', wt, `  - ${new Date(at(1)).toTimeString().slice(0, 5)} asked: Run the orchestrator for the APP batch please`);
has("#1646 with Claude's final reply of that turn, not its first", wt, '    replied: EARLY-RESULT batch planned with 4 tickets');
lacks('#1646 an earlier reply in the same turn is not the final one', wt, 'replied: Started.');
has('#1646 a long reply is cut', wt, `replied: MIDDAY-REPLY ${'x'.repeat(486)}…`);
lacks('#1646 past the reply limit', wt, 'REPLY-TAIL');
has('#1646 the last turn too', wt, 'replied: All merged.');
has('#1646 a short session is still summarised by its end', wt, 'ended with: Opened https://github.com/acme/app/pull/345 for APP-12.');
const small = script('claude_activity.py', '--day', DAY, '--window-turns', '--turn-threshold', '10').stdout;
t('#1646 a session over the size threshold is listed turn by turn too', small.includes('asked: Please fix APP-12, the login redirect loop\n    replied: Opened'), true);

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
// Merged PRs in the window per repo, split by author; one merged before the window is not counted.
put('merged_acme_app', { items: [
  pr('acme/app', 10, 'Fix the redirect', { state: 'closed', pull_request: { merged_at: at(15) } }),
  pr('acme/app', 30, 'Alice merged', { state: 'closed', user: { login: 'alice' }, pull_request: { merged_at: at(11) } }),
  pr('acme/app', 31, 'Bob merged', { state: 'closed', user: { login: 'bob' }, pull_request: { merged_at: at(12) } }),
  pr('acme/app', 32, 'Merged last week', { state: 'closed', pull_request: { merged_at: before } }),
] });
put('merged_acme_side', { items: [pr('acme/side', 40, 'Side merged', { state: 'closed', pull_request: { merged_at: at(16) } })] });
// #1646 issues: yours (two pages, 150 found), others' you commented on (a capped search), and others'
// closed in a repo read, kept only where you closed them.
const iss = (repo, number, title, extra = {}) => ({ repository_url: `https://api.github.com/repos/${repo}`, number, title, state: 'open', created_at: before, updated_at: at(9), user: { login: 'me' }, labels: [], comments: 0, ...extra });
const filler = (from, n) => Array.from({ length: n }, (_, i) => iss('acme/app', from + i, `Old issue ${from + i}`));
put('issues_mine', { total_count: 150, items: [iss('acme/app', 1, 'Login loop', { created_at: at(9), labels: [{ name: 'bug' }] }), ...filler(1002, 99)] });
put('issues_mine_p2', { total_count: 150, items: [
  ...filler(1101, 47),
  iss('acme/app', 148, 'Mine closed by someone else', { state: 'closed', closed_at: at(15) }),
  iss('acme/app', 149, 'Elsewhere', { repository_url: 'https://api.github.com/repos/acme/other', created_at: at(9) }),
  iss('acme/app', 150, 'checkout: collect more sources', { created_at: at(10) }),
] });
put('repos_acme_app_issues_148', { closed_by: { login: 'sam' } });
put('issues_commented', { total_count: 1200, items: [
  iss('acme/app', 70, 'Flaky export', { user: { login: 'alice' }, comments: 2, labels: [{ name: 'chore' }] }),
  iss('acme/app', 71, 'Commented last week', { user: { login: 'alice' }, comments: 1 }),
] });
put('repos_acme_app_issues_70_comments', [{ user: { login: 'me' }, created_at: at(11) }, { user: { login: 'me' }, created_at: at(12) }, { user: { login: 'alice' }, created_at: at(12) }]);
put('repos_acme_app_issues_71_comments', [{ user: { login: 'me' }, created_at: before }]);
put('issues_closed_acme_app', { total_count: 2, items: [
  iss('acme/app', 80, 'Bob\'s bug', { user: { login: 'bob' }, state: 'closed', closed_at: at(16), labels: [{ name: 'bug' }] }),
  iss('acme/app', 81, 'Closed by Carol', { user: { login: 'bob' }, state: 'closed', closed_at: at(16) }),
] });
put('repos_acme_app_issues_80', { closed_by: { login: 'me' } });
put('repos_acme_app_issues_81', { closed_by: { login: 'carol' } });
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
has('github: a repo whose read-own-work is no is skipped, and said', go, '## Skipped by permission\n- acme__lib: §3 read-own-work is ask - pass --include acme__lib once the user agrees\n- acme__other: §3 read-own-work is no - skipped');
lacks('github: and none of it shows', go, 'Other thing');
has('#1534 merged PRs in the window are counted per repo, yours and everyone\'s', go, '## Merged PRs in the window, by author (yours / everyone\'s)\n- acme/app: 1 mine / 3 all\n');
has('#1534 everyone\'s count needs read-others; without it only yours is given', go, '- acme/side: 1 mine / all not counted (acme__side: §3 read-others is no - skipped) [Side project]');
has('#1534 and the read-others no is listed with what was skipped', go, '- acme__other: §3 read-own-work is no - skipped\n- acme__side: §3 read-others is no - skipped');
lacks('#1534 a repo whose read-own-work is no is not counted', go, '- acme/other:');
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);
has('#1646 issues are grouped by scope, repo and label', go, `## This check-out issues (4)\n### acme/app (4)\n#### label: bug (2)\n- #1 Login loop [open, created ${hhmm(at(9))}] — you: opened\n- #80 Bob's bug [closed, closed ${hhmm(at(16))}] — you: closed\n#### label: chore (1)\n- #70 Flaky export [open, created 20 Oct ${hhmm(before)}] — you: commented ×2\n`);
has('#1646 with no label, by the title\'s prefix', go, `#### theme: checkout (1)\n- #150 checkout: collect more sources [open, created ${hhmm(at(10))}] — you: opened`);
lacks('#1646 an issue of yours nothing happened to is left out', go, 'Old issue');
lacks('#1646 one closed by someone else, with nothing of yours that day, is left out', go, 'Mine closed by someone else');
lacks('#1646 another person\'s issue someone else closed is left out', go, 'Closed by Carol');
lacks('#1646 a comment before the window does not count', go, 'Commented last week');
lacks('#1646 an issue in a repo whose read-own-work is no is left out', go, 'Elsewhere');
has('#1646 a search past its cap says so', go, '## Searches cut short\n- issues you commented on (capped: 2 of 1200 found)');
lacks('#1646 a search paged to its end is not called capped', go, 'your issues (capped');
const issueCalls = readFileSync(join(FAKE, 'calls.log'), 'utf8').split('\n').filter((l) => l.includes('is:issue author:me'));
t('#1646 the search pages past 100 results', issueCalls.some((l) => l.includes('page=2')), true);
t('#1646 and stops at a short page', issueCalls.some((l) => l.includes('page=3')), false);
t('#1646 a closed-issue search runs only in repos read', readFileSync(join(FAKE, 'calls.log'), 'utf8').includes('repo:acme/other -author:me closed'), false);
const ghCalls = readFileSync(join(FAKE, 'calls.log'), 'utf8').split('\n').filter((l) => l.includes('is:merged'));
t('#1534 without read-others the search asks only for your PRs', ghCalls.some((l) => l.includes('repo:acme/side') && l.includes('author:me')), true);
t('#1534 with it, everyone\'s', ghCalls.some((l) => l.includes('repo:acme/app') && !l.includes('author:')), true);
// read-others has its own consent: --include, given for read-own-work, does not grant it, and a
// side repo with no desk config has no read-others row, so only the user's PRs are counted there.
put('merged_acme_lib', { items: [
  pr('acme/lib', 50, 'Lib merged', { state: 'closed', pull_request: { merged_at: at(13) } }),
  pr('acme/lib', 51, 'Dana merged', { state: 'closed', user: { login: 'dana' }, pull_request: { merged_at: at(13) } }),
] });
put('merged_solo_proj', { items: [pr('solo/proj', 60, 'Solo merged', { state: 'closed', pull_request: { merged_at: at(14) } })] });
const ghRun = (...args) => {
  const from = readFileSync(join(FAKE, 'calls.log'), 'utf8').split('\n').length - 1;
  const r = spawnSync('python3', ['-B', join(SCRIPTS, 'github_activity.py'), '--day', DAY, ...args], { cwd: APP, env: { ...env, DESK_CHECKOUT_SIDE_REPOS: 'acme/side,solo/proj' }, encoding: 'utf8' });
  if (r.status) console.log(r.stderr);
  return { ...r, merged: readFileSync(join(FAKE, 'calls.log'), 'utf8').split('\n').slice(from).filter((l) => l.includes('is:merged')) };
};
const lib = ghRun('--include', 'acme__lib');
t('#1534 --include alone: exits 0', lib.status, 0);
has('#1534 --include alone does not count everyone\'s, and says which flag would', lib.stdout, '- acme/lib: 1 mine / all not counted (acme__lib: §3 read-others is ask - pass --include-others acme__lib once the user agrees)');
has('#1534 the read-others ask is listed with what was skipped', lib.stdout, '- acme__lib: §3 read-others is ask - pass --include-others acme__lib once the user agrees');
t('#1534 --include alone searches only your PRs there', lib.merged.some((l) => l.includes('repo:acme/lib') && l.includes('author:me')), true);
has('#1534 a side repo with no desk config: only yours', lib.stdout, '- solo/proj: 1 mine / all not counted (no desk config) [Side project]');
t('#1534 and its search asks only for your PRs', lib.merged.every((l) => !l.includes('repo:solo/proj') || l.includes('author:me')), true);
const libOthers = ghRun('--include', 'acme__lib', '--include-others', 'acme__lib');
has('#1534 --include-others counts everyone\'s', libOthers.stdout, '- acme/lib: 1 mine / 2 all');
t('#1534 --include-others searches every author there', libOthers.merged.some((l) => l.includes('repo:acme/lib') && !l.includes('author:')), true);

// #1666 a rate-limited gh call waits and retries; one still limited fails naming the limit and when
// to retry; a failed optional search is skipped, said in its section, and the run goes on.
const limited = (match, times, extra = {}) => {
  rmSync(join(FAKE, 'limit.count'), { force: true });
  return spawnSync('python3', ['-B', join(SCRIPTS, 'github_activity.py'), '--day', DAY], { cwd: APP, encoding: 'utf8',
    env: { ...env, FAKE_LIMIT_MATCH: match, FAKE_LIMIT_TIMES: String(times), DESK_GH_BACKOFF_BASE: '0.01', DESK_GH_BACKOFF_TOTAL: '0.05', ...extra } });
};
const once = limited('is:pr author:me', 1, { FAKE_RETRY_AFTER: '0' });
t('#1666 a secondary limit, then success: exits 0', once.status, 0);
has('#1666 it waited as Retry-After said', once.stderr, "gh: GitHub's secondary rate limit; waiting 0s, then retrying");
has('#1666 and the retried search was read', once.stdout, '- acme/app#10 Fix the redirect — opened; merged');
const twice = limited('is:pr author:me', 2);
t('#1666 with no Retry-After, exponential backoff: exits 0', twice.status, 0);
has('#1666 the first wait is the base', twice.stderr, 'waiting 0.01s');
has('#1666 the next doubles', twice.stderr, 'waiting 0.02s');
has('#1666 and the search was read', twice.stdout, '- acme/app#10 Fix the redirect');
const stuck = limited('is:pr author:me', 99);
t('#1666 a persistent limit on a required search fails', stuck.status, 1);
has('#1666 naming the limit and the tries', stuck.stderr, "gh search failed for 'is:pr author:me updated:>=2026-10-26': GitHub's secondary rate limit, still hit after 3 tries over 0s; retry after ");
has('#1666 and when to retry', stuck.stderr, '(in 60s)');
const noReviews = limited('reviewed-by', 99);
t('#1666 a failed reviews search does not end the run', noReviews.status, 0);
has('#1666 the reviews section says it was skipped and why', noReviews.stdout, "## Reviews you gave (0)\nskipped, not read (GitHub's secondary rate limit, still hit after 3 tries");
has('#1666 the rest is still there', noReviews.stdout, '- acme/app: 1 mine / 3 all');
const noMerged = limited('is:merged', 99);
t('#1666 a failed merged-count search does not end the run', noMerged.status, 0);
has('#1666 its line says it was skipped and why', noMerged.stdout, "- acme/app: skipped, not counted (GitHub's secondary rate limit, still hit after 3 tries");
has('#1666 reviews still read', noMerged.stdout, "- acme/app#20 Alice's change (by alice) — you: changes requested");
const noIssues = limited('commenter:', 99);
has('#1666 a failed issue search is skipped and said', noIssues.stdout, "- issues you commented on: skipped, not read (GitHub's secondary rate limit");
const notLimit = probe(`import github_activity as g; print(json.dumps([g.rate_limit("gh: Not Found (HTTP 404)"), g.rate_limit("gh: API rate limit exceeded for user ID 1. (HTTP 403)"), g.rate_limit("gh: too many requests rate limit (HTTP 429)"), g.rate_limit("gh: Resource not accessible by integration (HTTP 403)")]))`);
t('#1666 only a 403 or 429 naming a rate limit is one, and which', JSON.stringify(notLimit), '[null,"primary","primary",null]');
const reset = probe(`import github_activity as g, time; h, b = g.split_headers("HTTP/2.0 403 Forbidden\\nX-Ratelimit-Reset: %d\\n\\n{}" % (time.time() + 30)); print(json.dumps([27 < g.wait_for(h, "primary") <= 30, g.wait_for(h, "secondary"), b]))`);
t('#1666 a primary limit waits for its reset header', JSON.stringify(reset), '[true,null,"{}"]');

// #1666 issues with neither a label nor a `prefix:` are themed by a shared #NNNN, then a shared title
// word, before `other`.
const themed = probe(`import github_activity as g
iss = lambda n, title, body="", labels=(): {"number": n, "title": title, "body": body, "labels": [{"name": l} for l in labels]}
print(json.dumps(g.themes([
  iss(1, "Cloud worker loses its slot"), iss(2, "Cloud session never reports back"),
  iss(3, "Checkout collector dies on a rate limit", "Follows #1646"), iss(4, "Grouping files most under other", "Part of #1646"),
  iss(1646, "Collect more sources"), iss(5, "Queue stalls overnight"), iss(6, "Queue order ignores priority"),
  iss(7, "Tidy the README"), iss(8, "ci: shard the suites"), iss(9, "Cloud thing", labels=["bug"]),
])))`);
t('#1666 a shared title word names a theme', themed['1'], 'theme: cloud');
t('#1666 for each issue sharing it', themed['2'], 'theme: cloud');
t('#1666 a #NNNN two issues reference names a theme', themed['3'], 'theme: #1646');
t('#1666 the issue referenced joins it', themed['1646'], 'theme: #1646');
t('#1666 and the other referencing it', themed['4'], 'theme: #1646');
t('#1666 another shared word', `${themed['5']} ${themed['6']}`, 'theme: queue theme: queue');
t('#1666 an issue sharing nothing is other', themed['7'], 'theme: other');
t('#1666 a prefix still wins', themed['8'], 'theme: ci');
t('#1666 and a label', themed['9'], 'label: bug');

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

// At a Slack channel destination with §3 slack-draft yes, the hand-over saves the draft, says where it
// went, and copies to the clipboard only when the draft cannot be saved, saying why.
const skill = readFileSync(join(REPO, 'skills/desk-checkout/SKILL.md'), 'utf8');
has('#819 each PR\'s state is read again when its line is written', skill, '**Read each PR\'s state again as you\n  write its line** (`gh pr view <n> --repo <owner/name> --json state,isDraft,mergedAt,reviewDecision`)');
has('#818 the hand-over saves it with slack_send_message_draft', skill, '`slack_send_message_draft`');
has('#818 by default, not as an offer', skill, 'the default, not something to offer');
has('#818 a private channel is found too', skill, '`channel_types` `public_channel,private_channel`');
has('#1008 the window starts where the previous check-out ended, the evening before included', skill, 'their window then starts where that check-out stopped, the evening before\nincluded, so nothing posted between it and midnight drops out');
lacks('the post no longer says its window under the header', skill, 'Since my 12:00 check-out:');
has('the header never says the window', skill, 'It never says the\n  window: no `since …` in it and no `Since my … check-out` line under it');
has('the window is said to the user, not in the post', skill, 'Say the window in your one line to the user, never in the post (step 4).');
has('a day only when posted on a later day than the work', skill, 'Add a day\n  only when the post is made on a later day than the work, naming the day the work happened');
has('every figure covers the post\'s window', skill, '**Every count or figure covers the post\'s window**, from the previous post onwards (step 1), not\n  since midnight');
has('figures are filtered on the window start', skill, 'Compute each one from its source, with timestamps\n  filtered on the window start');
has('Check before posting names each figure\'s query and window', skill, 'Each count or figure in the post, with the query and window behind it');
has('a setting is read from its source before its timing is stated', skill, '**A setting, config row or other change that is not a PR is read from its source too**');
has('a change in effect is never from tomorrow', skill, 'a change already in effect is in the past\n  or present tense ("now 20%, since today"), never "from tomorrow"');
has('an unreadable setting goes under Check before posting', skill, 'If the source cannot be read,\n  name the claim under **Check before posting** with why.');
const style = readFileSync(join(REPO, 'skills/desk-checkout/references/style.md'), 'utf8');
has('style: no window qualifier in the header', style, 'Never a window qualifier such as\n  `(since yesterday\'s post)`');
has('#1471 style: never a ticket as the user last left it', style, 'Don\'t describe a ticket as the user last left it.');
has('#1471 style: never from the next deploy unread', style, 'Don\'t write "from the next deploy" without reading the latest production deploy.');
lacks('style: the day is no longer added just for posting late', style, 'with the day when posting late or for another day');
has('#1008 the collectors are given when it was posted and the day it covered', skill, '`--since <the time it\nwas posted, as an ISO timestamp>` and `--since-for <the day it covered, YYYY-MM-DD, as its header or\ndate names it>`');
has('#818 and says where it went', skill, 'Say "Saved as a draft in #name, not sent"');
has('#818 the clipboard is the fallback, said with its reason', skill, '"No draft saved (<why>); copied to the clipboard"');
has('#816 a drafted channel update is settled by reading the channel', skill, 'Read the channel or thread after the draft\'s time to see');
has('#816 it is asked only when no read can settle it', skill, 'Only when no read can (no Slack connector, or §3 bars that channel)');
has('#816 every check a read can answer is run before handing over', skill, '**Check before posting**: only what no read settles. Before handing over, run every check a\n  read §3 grants can answer');
lacks('#816 an unread channel is no longer handed over by default', skill, 'If Slack can\'t confirm they posted one');
has('#830 an unread channel names the Slack role under Missing sources', skill, 'saying why,\n  and name the Slack role under Missing sources with its fix.');
has('#830 a Slack row that is not yes bars the read', skill, 'is not `yes`; an `ask` row\n  bars it only once the user says no to the read');
has('#830 a missing permission\'s fix is the row and /desk-setup', skill, 'for a permission, the §3 row to set to `yes`\n  with `/desk-setup`');
lacks('#818 a draft no longer waits for the user to ask', skill, 'only if they ask');
has('#817 work a batch did is reported as ordinary items', skill, '**Work a batch did is the person\'s work, reported the same way.**');
has('#817 never the tooling that ran it', skill, 'Never what ran\nit: no "the autopilot", "a worker" or "the batch" in the post, unless the user asks for that.');
has('#829 a batch\'s own sessions are never items', skill, 'A triage, preflight or worker session is evidence\n  for the ticket it worked, never work in its own right');
has('#829 a parked ticket with no PR needs a Jira or GitHub change that day', skill, '**A ticket a worker parked with no PR** gets an item only if Jira or GitHub shows a change to it\n  that day');
has('#829 described by that change, not by the session', skill, 'and the item says what that change was. A session\n  alone is not a change.');
has('#829 DESK_CHECKOUT_NAME_BATCH names the batch in one line', skill, 'set `DESK_CHECKOUT_NAME_BATCH=1`');
has('#829 that line names the items by key', skill, 'Then one line after\n  the substantive work names the items a batch built by key');
has('#819 the read wins over the collector\'s', skill, 'That read wins over the collector\'s: `MERGED` is `(merged)`, an open PR no longer a draft is\n  `(in review)`');
has('#819 only isDraft true is a draft', skill, 'only `isDraft` true is\n  a draft');
has('#819 a failed read keeps the collector\'s state and says so', skill, 'If that read fails, use the collector\'s state and name the PR under **Check before\n  posting** as read earlier in the run.');
has('#819 Check before posting lists it', skill, 'each PR whose state could not be\n  read again when its line was written');
has('#819 only in a repo the GitHub collector was allowed to read', skill, 'Read only in a repo the GitHub collector read (its\n  `read-own-work` `yes`, or `ask` and the user agreed)');
has('#819 and never in any other repo', skill, 'Never read a PR in any other repo: its\n  state stays as its source gave it.');
has('#1471 step 3 sends each ticket and deploy claim to be read again', skill, '**Read each ticket again as you write its bullet, with every PR naming its key, and the latest\n  deploy before any deploy claim**: `references/current-state.md` says how.');
has('#1471 one no read settled goes under Check before posting', skill, 'each ticket or deploy claim no read settled.');
has('#1647 items are built by outcome, not ticket', skill, 'then build **one item per outcome**, not per ticket or source');
has('#1647 substantive work is every item that changed something', skill, '**Substantive work**: every item that changed something, biggest first');
lacks('#1647 no longer the few things that mattered most', skill, 'the few things that mattered most');
has('#1647 the sources line points at sources.md and names the new collectors', skill, '`references/sources.md` covers the newer collectors: `worklog_activity.py`,\n`claude_activity.py --window-turns`, issues in `github_activity.py`.');
const items = readFileSync(join(REPO, 'skills/desk-checkout/references/items.md'), 'utf8');
has('#1647 an umbrella ticket is split by outcome', items, '**Split an umbrella.**');
has('#1647 each item names its ticket', items, '**Each item names its ticket where there is one**');
has('#1647 work with no ticket is an item', items, 'Work no ticket names is an item in its own right when a source shows it changed something.');
has('#1647 ranked by the change, not the ticket', items, '## Rank by the change, not the ticket');
for (const signal of ['1. Security, production or launch-blocking.', '2. Unblocked others or a pipeline.', '3. Shipped or merged.', '4. User- or team-facing.', '5. Fixed a recurring failure.', '6. A milestone in a plan.']) has(`#1647 impact signal: ${signal}`, items, signal);
has('#1647 only MERGED is shipped', items, 'is a PR whose state is `MERGED`');
has('#1647 a PR closed unmerged is not shipped', items, 'A PR `CLOSED` without merging (the collector\'s\n  `closed unmerged`) is not shipped');
has('#1647 equal treatment above the line', items, 'Every item above the\nline gets the same treatment, whatever its source or ticket');
has('#1647 the line is defined', items, 'The line is between items, which changed something, and everything else');
has('#1647 the highest signal ranks first, so security leads', items, 'An item ranks by the highest signal it has, so anything security, production or launch-blocking\nleads whatever else is merged that day');
lacks('#1647 a count of signals never outranks a higher signal', items, 'An item with more signals goes higher');
has('#1647 never every PR in a large group', items, 'Never list every PR in a large group');
has('#1647 the quiet-day rule moved here', items, 'a quiet day is five\nlines, and that\'s fine');
has('#1647 style: the worked example splits an umbrella ticket', style, 'Three separate things moved under the launch-readiness ticket ABC-1700:');
has('#1647 style: a ticketless setting is its own item', style, 'Branch protection on the payments paths now needs two, in effect since 15:00.');
const current = readFileSync(join(REPO, 'skills/desk-checkout/references/current-state.md'), 'utf8');
has('#1471 each ticket is read again as its bullet is written', current, '**Read each ticket again as you write its bullet, with every PR naming its key.**');
has('#1471 its status is read from its tracker', current, '`desk-jira get <KEY>` for that ticket\'s repo');
has('#1471 another repo\'s ticket is read from that repo\'s checkout', current, '`DESK_REPO_DIR=<its main checkout> desk-jira get <KEY>`');
lacks('#1471 never DESK_SLUG for desk-jira, which ignores it', current, '`DESK_SLUG=<slug>`');
has('#1471 with every PR naming its key, any author, open or merged', current, 'gh pr list --repo <owner/name> --state all --search "<KEY>" --json number,title,author,state,isDraft,mergedAt');
has('#1471 the bullet states what those reads show', current, 'The bullet states what those reads show.');
has('#1471 a teammate\'s fix is named or the ticket left out', current, 'is said as that, naming who and which PR\n("Sam fixed it in #1540 (merged), now in Review"), or left out.');
has('#1471 and its ask is dropped', current, 'Any ask in its bullet is\ndropped, and so is any claim that PR settles');
has('#1471 a failed ticket read goes under Check before posting', current, 'name the ticket under **Check before posting** as last\nseen by them.');
has('#1471 a deploy claim is read from the latest production deploy', current, '**is read from\nthe latest production deploy first**');
has('#1471 GitHub deployments first', current, '1. Its newest successful GitHub deployment to production.');
has('#1471 a newer failed or unfinished deployment is skipped', current, 'Take the first whose latest status is `success`: a newer one that failed or is still\n   queued or in progress is skipped, never compared.');
lacks('#1471 never only the single newest deployment', current, 'per_page=1`, then');
has('#1471 then the default branch\'s deploy workflow', current, '2. With no successful deployment found, the newest successful run of the deploy workflow on the\n   repo\'s default branch');
has('#1471 a merge the latest deploy contains is live, never from the next deploy', current, 'Then its line says it is live and since when, never "from the next deploy"');
has('#1471 an unread deploy goes under Check before posting', current, 'the line says only that it merged, and the deploy claim goes\nunder **Check before posting** with why');

// #1646 worklog_activity.py: the person's work logs (§3b Check-out work logs) and desk's own records.
const appCfg = join(CFG, 'repos', 'acme__app', 'config.md');
const cfgText = readFileSync(appCfg, 'utf8') + ['', '## 3b. Cost and autonomy', '| Field | Recommended | Your setting |', '|---|---|---|', '| Check-out work logs | `none` | `~/notes/worklog.md` `~/notes/daily/*.txt` |', '',
  '## 1. You', '| Field | Value | Notes |', '|---|---|---|', '| GitHub handle | `me-person` | who opens the PRs |', ''].join('\n');
writeFileSync(appCfg, cfgText);
mkdirSync(join(HOME, 'notes', 'daily'), { recursive: true });
writeFileSync(join(HOME, 'notes', 'worklog.md'), [
  '# Work log', '## 2026-10-25', '- 17:00 SUNDAY-LOG out of the window',
  '## 2026-10-26', '- 09:15 Set up the cloud environment', '- Fixed the logins', '- 2026-10-26T14:30 Tuned the throughput settings',
  // A time no clock shows is an entry with no time, never a crash; a single-digit hour with an offset is read.
  '- 2026-10-26 24:00 MIDNIGHT-LOG wrapped up', '- 2:75 BAD-MINUTE-LOG', '- 2026-10-26T9:05Z ZULU-LOG paired on the review',
  '## 2026-10-27', '- 08:00 NEXT-DAY-LOG out of the window',
].join('\n'));
const plainLog = join(HOME, 'notes', 'daily', 'plain.txt');
writeFileSync(plainLog, 'Untimed notes\nPLAIN-LAST line');
utimesSync(plainLog, new Date(at(18)), new Date(at(18)));
const oldLog = join(HOME, 'notes', 'daily', 'old.txt');
writeFileSync(oldLog, 'OLD-NOTES nothing timed');
utimesSync(oldLog, new Date(before), new Date(before));
// A config write in the window changed one row (the backup holds the copy from before it); an older
// backup, from before the window, is not read as a change on the day.
const bakNew = `${appCfg}.bak-2026-10-26`;
writeFileSync(bakNew, cfgText.replace('`customfield_10207`', '`customfield_10100`').replace('`me-person`', '`old-person`'));
utimesSync(bakNew, new Date(at(12)), new Date(at(12)));
const bakOld = `${appCfg}.bak-2026-10-20`;
writeFileSync(bakOld, cfgText.replace('`#team`', '`#old-team`'));
utimesSync(bakOld, new Date(before), new Date(before));
const state = join(HOME, '.desk-autopilot');
mkdirSync(join(state, 'acme__app', 'batches', 'b1'), { recursive: true });
mkdirSync(join(state, 'digest'), { recursive: true });
writeFileSync(join(state, 'acme__app', 'levers.jsonl'), [
  { at: at(11), kind: 'transition', lever: 'codex', from: 'trial', to: 'adopted', reason: 'cheaper per ticket' },
  { at: at(11), kind: 'assign', ticket: 'APP-9', reason: 'drawn' },
  { at: before, kind: 'override', lever: 'memory', to: 'overridden', value: 'on', reason: 'OLD-LEVER' },
].map((e) => JSON.stringify(e)).join('\n'));
writeFileSync(join(state, 'acme__app', 'batches', 'b1', 'decisions.jsonl'), [
  { id: 'd1', at: at(13), ticket: 'APP-12', question: 'Which copy for the button?', options: ['Save', 'Done'], chose: 'Save', category: 'wording' },
  { id: 'd2', at: before, ticket: 'APP-1', question: 'OLD-DECISION', options: ['a', 'b'], chose: 'a', category: 'design' },
].map((e) => JSON.stringify(e)).join('\n'));
writeFileSync(join(state, 'digest', 'answered.json'), JSON.stringify({ 'acme__app/APP-5/abc123': at(16), 'acme__lib/LIB-1/def456': at(16), 'acme__app/APP-6/old': before }));
const wl = script('worklog_activity.py', '--day', DAY);
t('#1646 worklog: exits 0', wl.status, 0);
const wo = wl.stdout;
has('#1646 worklog: the header names the window', wo, '# Work logs and desk records, Monday 26 October 2026');
const zulu = hhmm(new Date(Date.UTC(2026, 9, 26, 9, 5)).toISOString());
has('#1646 worklog: timed, untimed and ISO-stamped entries in the window', wo, '### ~/notes/worklog.md (5)\n');
has('#1646 worklog: a timed entry', wo, '- 09:15 Set up the cloud environment\n');
has('#1646 worklog: an ISO-stamped entry', wo, '- 14:30 Tuned the throughput settings\n');
has('#1646 worklog: an untimed entry under its date', wo, '- (no time) Fixed the logins\n');
has('#1646 worklog: a single-digit hour with an offset is read', wo, `- ${zulu} ZULU-LOG paired on the review\n`);
has('#1646 worklog: 24:00 is an entry on its date with no time', wo, '- (no time) MIDNIGHT-LOG wrapped up\n');
lacks('#1646 worklog: a minute out of range is no entry', wo, 'BAD-MINUTE-LOG');
has('#1646 worklog: a Value changed in a Field | Value | Notes table is a fact', wo, `- ${hhmm(at(12))} config §1 "GitHub handle": \`old-person\` → \`me-person\` (source: config.md.bak-2026-10-26 vs config.md)`);
lacks('#1646 worklog: an entry the day before is left out', wo, 'SUNDAY-LOG');
lacks('#1646 worklog: an entry the day after is left out', wo, 'NEXT-DAY-LOG');
has('#1646 worklog: a file with no times falls back to its modified time', wo, `### ~/notes/daily/plain.txt (no timestamped lines; modified ${hhmm(at(18))}, in the window, so its last lines)\n  Untimed notes\n  PLAIN-LAST line`);
lacks('#1646 worklog: one modified outside the window is left out', wo, 'OLD-NOTES');
has('#1646 worklog: a config backup diff is one fact, with its source', wo, `- ${hhmm(at(12))} config §4 "Priority": \`customfield_10100\` → \`customfield_10207\` (source: config.md.bak-2026-10-26 vs config.md)`);
lacks('#1646 worklog: a backup from before the window is not a change on the day', wo, 'old-team');
has('#1646 worklog: a lever change', wo, `- ${hhmm(at(11))} lever codex transition: trial → adopted — cheaper per ticket (source: levers.jsonl)`);
lacks('#1646 worklog: a ticket\'s lever draw is not a change', wo, 'APP-9');
lacks('#1646 worklog: a lever change before the window is left out', wo, 'OLD-LEVER');
has('#1646 worklog: a logged decision, from a batch\'s log', wo, `- ${hhmm(at(13))} decision taken: APP-12: Which copy for the button?: chose Save [wording] (source: batches/b1/decisions.jsonl)`);
lacks('#1646 worklog: a decision before the window is left out', wo, 'OLD-DECISION');
has('#1646 worklog: a needs-you item answered', wo, `- ${hhmm(at(16))} needs-you item answered: APP-5 (source: digest answered.json)`);
lacks('#1646 worklog: another repo\'s answer, or one before the window, is left out', wo, 'LIB-1');
lacks('#1646 worklog: and one before the window', wo, 'APP-6');
has('#1646 worklog: a same-destination repo at ask is skipped and said', wo, '## Skipped by permission\n- acme__lib: §3 read-own-work is ask - pass --include acme__lib once the user agrees');
lacks('#1646 worklog: a repo with a different check-out is not read', wo, 'acme__other');
const sources = readFileSync(join(REPO, 'skills/desk-checkout/references/sources.md'), 'utf8');
for (const name of ['github_activity.py', 'worklog_activity.py', 'claude_activity.py', '--window-turns', 'Check-out work logs', 'read-own-work', 'read-transcripts']) has(`#1646 sources.md names ${name}`, sources, name);

t('nothing wrote a __pycache__ into the skill', existsSync(join(SCRIPTS, '__pycache__')), false);
rmSync(R, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
