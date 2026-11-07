// suite: linked issues (a GitHub issue closes once every Jira ticket linking it is done)
// linked-issues.mjs's closeLinkedIssues against a fake desk-jira and gh: each ticket's web links, a
// text search that also finds tickets which only mention the issue, statuses, issue states and merged PRs.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeLinkedIssues, issueOf, issueJql } from '../desk/bin/linked-issues.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const REPO = 'acme/widgets';
const url = (repo, n) => ({ object: { url: `https://github.com/${repo}/issues/${n}`, title: `issue ${n}` } });
const URL = (n) => `https://github.com/${REPO}/issues/${n}`;
// links: key -> remotelinks (or 'fail'); text: key -> the ticket's text, which the fake search matches
// against the phrases the JQL's text clauses name, skipping the key its `key !=` excludes;
// status: key -> [name, category]; more: the search reply carries a next page; issues: n -> state;
// prs: [{number, title, headRefName}].
function world({ links, text = {}, status, issues, prs = [], more = false }) {
  const calls = [];
  const ok = (v) => ({ ok: true, out: JSON.stringify(v), err: '' });
  const fields = (key) => ({ status: { name: status[key][0], statusCategory: { key: status[key][1] } } });
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'desk-jira' && args[0] === 'api') {
      const own = /issue\/([^/?]+)\?fields=status$/.exec(args[1]);
      if (own) return ok({ key: own[1], fields: fields(own[1]) });
      const key = /issue\/([^/]+)\/remotelink/.exec(args[1])[1];
      return links[key] === 'fail' ? { ok: false, out: '', err: 'HTTP 500' } : ok(links[key] ?? []);
    }
    if (cmd === 'desk-jira' && args[0] === 'search') {
      const not = /key != (\S+) /.exec(args[1])?.[1];
      const phrases = [...args[1].matchAll(/text ~ "\\"([^"\\]*)\\""/g)].map((m) => m[1]);
      const keys = Object.keys(text).filter((k) => k !== not && phrases.some((p) => text[k].includes(p)));
      return ok({ issues: keys.map((key) => ({ key, fields: fields(key) })), ...(more ? { nextPageToken: 'p2' } : {}) });
    }
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') return ok({ state: issues[args[2]] });
    if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'close') { issues[args[2]] = 'CLOSED'; return ok(''); }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok(prs.filter((p) => p.title.includes(args[args.indexOf('--search') + 1])));
    return { ok: false, out: '', err: `unexpected ${cmd} ${args.join(' ')}` };
  };
  return { run, calls, closes: () => calls.filter((c) => c.startsWith('gh issue close')) };
}
const go = (w, ticket, perm = 'yes') => closeLinkedIssues({ ticket, repo: REPO, project: 'DS', doneState: 'Done', perm, run: w.run });
const DONE = ['Done', 'done'], WIP = ['In Progress', 'indeterminate'];

// AC1: the only ticket linking the issue is done: it closes, naming the ticket and its merged PR. DS-7
// only mentions #10 in its text (no web link), and DS-10's PR is not DS-1's.
let w = world({
  links: { 'DS-1': [url(REPO, 10)], 'DS-7': [url(REPO, 11)] }, text: { 'DS-1': `fixes ${URL(10)}`, 'DS-7': 'see #10' },
  status: { 'DS-1': DONE, 'DS-7': WIP }, issues: { 10: 'OPEN' },
  prs: [{ number: 100, title: 'fix(x): DS-1 the fix', headRefName: 'fix/DS-1-x' }, { number: 101, title: 'feat: DS-10 other', headRefName: 'feat/DS-10' }],
});
let out = go(w, 'DS-1');
t('AC1 the issue is closed with a comment naming the ticket and its PR', w.closes().join('|'),
  "gh issue close 10 --repo acme/widgets --comment Closed by desk: every ticket filed for this issue is done: DS-1 (#100).");
t('AC1 the close is reported', out.join('|'), `${REPO}#10 closed: Closed by desk: every ticket filed for this issue is done: DS-1 (#100).`);
t('AC1 control: a ticket that only mentions the issue is read but does not hold it open', w.calls.includes('desk-jira api api/2/issue/DS-7/remotelink'), true);

// AC2 and AC3: two tickets link #20; it stays open, uncommented, until the second is done. DS-3's
// text names the issue's URL and DS-2's only #20, so each text clause of the JQL is needed by one.
const two = { links: { 'DS-2': [url(REPO, 20)], 'DS-3': [url(REPO, 20)] }, text: { 'DS-2': 'filed for #20', 'DS-3': `from ${URL(20)}` }, issues: { 20: 'OPEN' },
  prs: [{ number: 200, title: 'fix: DS-2 one', headRefName: 'fix/DS-2' }, { number: 300, title: 'fix: DS-3 two', headRefName: 'fix/DS-3' }] };
w = world({ ...two, status: { 'DS-2': DONE, 'DS-3': WIP } });
out = go(w, 'DS-2');
t('AC2 with one linking ticket still open, nothing is closed or commented', `${w.closes().length} ${w.calls.some((c) => c.includes('comment'))}`, '0 false');
t('AC2 the output names the ticket holding it open', out.join('|'), `${REPO}#20 left open: DS-3 is In Progress`);
w = world({ ...two, status: { 'DS-2': DONE, 'DS-3': DONE } });
out = go(w, 'DS-3');
t('AC3 once the second is done, it closes naming both tickets and their PRs', w.closes().join('|'),
  "gh issue close 20 --repo acme/widgets --comment Closed by desk: every ticket filed for this issue is done: DS-2 (#200), DS-3 (#300).");

// AC4: an issue in another repo is never touched; the same number in this repo would be.
w = world({ links: { 'DS-4': [url('other/repo', 40)] }, status: { 'DS-4': DONE }, issues: { 40: 'OPEN' } });
out = go(w, 'DS-4');
t('AC4 a link to another repo\'s issue reads, searches and closes nothing', `${out.length} ${w.calls.join('|')}`, '0 desk-jira api api/2/issue/DS-4/remotelink');
t('AC4 control: the same link in this repo is an issue here', `${issueOf('https://github.com/other/repo/issues/40', REPO)} ${issueOf('https://github.com/Acme/Widgets/issues/40#issuecomment-1', REPO)}`, 'null 40');

// AC5: short of yes, nothing is closed and the issue is named as ready to close.
for (const perm of ['ask', 'no', null]) {
  w = world({ links: { 'DS-5': [url(REPO, 50)] }, status: { 'DS-5': DONE }, issues: { 50: 'OPEN' }, prs: [{ number: 500, title: 'fix: DS-5', headRefName: 'fix/DS-5' }] });
  out = go(w, 'DS-5', perm);
  t(`AC5 gh-close-linked-issue ${perm ?? 'unset'}: nothing closed`, w.closes().length, 0);
  t(`AC5 gh-close-linked-issue ${perm ?? 'unset'}: named as ready to close`, out[0]?.startsWith(`${REPO}#50 is ready to close (config §3 gh-close-linked-issue is ${perm ?? 'unset'}): gh issue close 50`), true);
}

// An issue already closed is left alone; an unreadable web-link list closes nothing and says so.
w = world({ links: { 'DS-6': [url(REPO, 60)] }, status: { 'DS-6': DONE }, issues: { 60: 'CLOSED' } });
out = go(w, 'DS-6');
t('an already-closed issue gets no second close', `${w.closes().length} ${out[0]}`, `0 ${REPO}#60 already closed`);
w = world({ links: { 'DS-8': [url(REPO, 80)], 'DS-9': 'fail' }, text: { 'DS-9': '#80' }, status: { 'DS-8': DONE, 'DS-9': DONE }, issues: { 80: 'OPEN' } });
out = go(w, 'DS-8');
t('another ticket\'s unreadable web links hold the issue open', `${w.closes().length} ${out[0]}`, `0 ${REPO}#80 left open: DS-9's web links could not be read (HTTP 500)`);

// The search: the other tickets naming the issue's URL or #<n>, the ticket itself excluded.
t('the JQL searches the project for the URL and #<n>, excluding the ticket', issueJql('DS', 'DS-2', REPO, 20),
  'project = "DS" AND key != DS-2 AND (text ~ "\\"https://github.com/acme/widgets/issues/20\\"" OR text ~ "\\"#20\\"")');
// A search with a further page may hide an open linking ticket, so the issue stays open; the same
// world on one page closes it.
const paged = { links: { 'DS-11': [url(REPO, 110)], 'DS-12': [url(REPO, 110)] }, text: { 'DS-12': '#110' }, status: { 'DS-11': DONE, 'DS-12': DONE }, issues: { 110: 'OPEN' } };
w = world({ ...paged, more: true });
out = go(w, 'DS-11');
t('a search with more than one page closes nothing', `${w.closes().length} ${out[0]}`, `0 ${REPO}#110 left open: 100 or more tickets mention it, so not every ticket linking it could be checked`);
w = world(paged);
go(w, 'DS-11');
t('control: the same search on one page closes it', w.closes().length, 1);
// The ticket's own status comes from its own read, not the search: not Done there, nothing closes.
w = world({ links: { 'DS-13': [url(REPO, 130)] }, status: { 'DS-13': WIP }, issues: { 130: 'OPEN' } });
out = go(w, 'DS-13');
t('the ticket itself not Done holds the issue open', `${w.closes().length} ${out[0]} ${w.calls.includes('desk-jira api api/2/issue/DS-13?fields=status')}`, `0 ${REPO}#130 left open: DS-13 is In Progress true`);
// Merged PRs are matched to a key whole: DS-49-5's and DS-494's PRs are not DS-49's.
w = world({ links: { 'DS-49': [url(REPO, 49)] }, status: { 'DS-49': DONE }, issues: { 49: 'OPEN' },
  prs: [{ number: 490, title: 'fix: DS-49 x', headRefName: 'fix/DS-49-x' }, { number: 491, title: 'fix: DS-494', headRefName: 'fix/DS-494' }, { number: 492, title: 'fix: DS-49-5', headRefName: 'fix/DS-49-5-y' }] });
out = go(w, 'DS-49');
t('a PR is matched to a key whole', out[0], `${REPO}#49 closed: Closed by desk: every ticket filed for this issue is done: DS-49 (#490).`);

// The CLI does nothing in a repo with no Jira tracker.
const T = mkdtempSync(join(tmpdir(), 'desk-linked-'));
writeFileSync(join(T, 'config.md'), '## 0. Repo\n\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n\n## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Tracker | `none` |\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|AUTOPILOT_)/.test(k)));
const r = spawnSync('node', [join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'linked-issues.mjs'), 'DS-1', '--repo', REPO],
  { encoding: 'utf8', env: { ...env, HOME: T, DESK_CONFIG: join(T, 'config.md'), PATH: '/usr/bin:/bin:' + dirname(process.execPath) } });
t('with Tracker none the CLI prints nothing and exits 0', `${r.status} ${r.stdout}${r.stderr}`, '0 ');
rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'linked issues: all checks passed');
process.exit(fails ? 1 : 0);
