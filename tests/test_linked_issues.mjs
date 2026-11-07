// suite: linked issues (a GitHub issue closes once every Jira ticket linking it is done)
// linked-issues.mjs's closeLinkedIssues against a fake desk-jira and gh: each ticket's web links, a
// text search that also finds tickets which only mention the issue, statuses, issue states and merged PRs.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeLinkedIssues, issueOf, namesKey } from '../desk/bin/linked-issues.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const REPO = 'acme/widgets';
const url = (repo, n) => ({ object: { url: `https://github.com/${repo}/issues/${n}`, title: `issue ${n}` } });
// links: key -> remotelinks (or 'fail'); hits: issue -> keys the text search finds besides the ticket;
// status: key -> [name, category]; issues: n -> state; prs: [{number, title, headRefName}].
function world({ links, hits = {}, status, issues, prs = [] }) {
  const calls = [];
  const ok = (v) => ({ ok: true, out: JSON.stringify(v), err: '' });
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (cmd === 'desk-jira' && args[0] === 'api') {
      const key = /issue\/([^/]+)\/remotelink/.exec(args[1])[1];
      return links[key] === 'fail' ? { ok: false, out: '', err: 'HTTP 500' } : ok(links[key] ?? []);
    }
    if (cmd === 'desk-jira' && args[0] === 'search') {
      const ticket = /key = (\S+) OR/.exec(args[1])[1], n = Number(/issues\/(\d+)/.exec(args[1])[1]);
      return ok({ issues: [ticket, ...(hits[n] ?? [])].map((key) => ({ key, fields: { status: { name: status[key][0], statusCategory: { key: status[key][1] } } } })) });
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
  links: { 'DS-1': [url(REPO, 10)], 'DS-7': [url(REPO, 11)] }, hits: { 10: ['DS-7'] },
  status: { 'DS-1': DONE, 'DS-7': WIP }, issues: { 10: 'OPEN' },
  prs: [{ number: 100, title: 'fix(x): DS-1 the fix', headRefName: 'fix/DS-1-x' }, { number: 101, title: 'feat: DS-10 other', headRefName: 'feat/DS-10' }],
});
let out = go(w, 'DS-1');
t('AC1 the issue is closed with a comment naming the ticket and its PR', w.closes().join('|'),
  "gh issue close 10 --repo acme/widgets --comment Closed by desk: every ticket filed for this issue is done: DS-1 (#100).");
t('AC1 the close is reported', out.join('|'), `${REPO}#10 closed: Closed by desk: every ticket filed for this issue is done: DS-1 (#100).`);
t('AC1 control: a ticket that only mentions the issue is read but does not hold it open', w.calls.includes('desk-jira api api/2/issue/DS-7/remotelink'), true);

// AC2 and AC3: two tickets link #20; it stays open, uncommented, until the second is done.
const two = { links: { 'DS-2': [url(REPO, 20)], 'DS-3': [url(REPO, 20)] }, hits: { 20: ['DS-3'] }, issues: { 20: 'OPEN' },
  prs: [{ number: 200, title: 'fix: DS-2 one', headRefName: 'fix/DS-2' }, { number: 300, title: 'fix: DS-3 two', headRefName: 'fix/DS-3' }] };
w = world({ ...two, status: { 'DS-2': DONE, 'DS-3': WIP } });
out = go(w, 'DS-2');
t('AC2 with one linking ticket still open, nothing is closed or commented', `${w.closes().length} ${w.calls.some((c) => c.includes('comment'))}`, '0 false');
t('AC2 the output names the ticket holding it open', out.join('|'), `${REPO}#20 left open: DS-3 is In Progress`);
w = world({ ...two, hits: { 20: ['DS-2'] }, status: { 'DS-2': DONE, 'DS-3': DONE } });
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
w = world({ links: { 'DS-8': [url(REPO, 80)], 'DS-9': 'fail' }, hits: { 80: ['DS-9'] }, status: { 'DS-8': DONE, 'DS-9': DONE }, issues: { 80: 'OPEN' } });
out = go(w, 'DS-8');
t('another ticket\'s unreadable web links hold the issue open', `${w.closes().length} ${out[0]}`, `0 ${REPO}#80 left open: DS-9's web links could not be read (HTTP 500)`);
t('a PR is matched to a key whole', `${namesKey('DS-49', 'fix: DS-494')} ${namesKey('DS-49', 'fix/DS-49-x')}`, 'false true');

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
