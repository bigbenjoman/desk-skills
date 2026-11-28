// suite: issue close (a §4 Tracker none ticket's GitHub issue closes once its PR merged, keyword or not)
// layer: L2
// issue-close.mjs's closeTicketIssue against a fake gh: the PR's state and the issues its closing
// keywords name, the issue's state (GitHub's keyword closing it a moment after the merge), and the close.
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { closeTicketIssue, WAIT_TRIES } from '../desk/bin/issue-close.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const REPO = 'acme/widgets';
// pr: { state, closes: [n] } or 'fail'; issue: the state each read gives in turn (the last repeats),
// or 'fail'; close: whether gh issue close succeeds.
function world({ pr, issue, close = true }) {
  const calls = [], sleeps = [];
  let reads = 0;
  const ok = (v) => ({ ok: true, out: JSON.stringify(v), err: '' });
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    if (args[0] === 'pr' && args[1] === 'view') return pr === 'fail' ? { ok: false, out: '', err: 'HTTP 502' }
      : ok({ state: pr.state, closingIssuesReferences: (pr.closes ?? []).map((number) => ({ number })) });
    if (args[0] === 'issue' && args[1] === 'view') return issue === 'fail' ? { ok: false, out: '', err: 'HTTP 404' } : ok({ state: issue[Math.min(reads++, issue.length - 1)] });
    if (args[0] === 'issue' && args[1] === 'close') return close ? ok('') : { ok: false, out: '', err: 'HTTP 403' };
    return { ok: false, out: '', err: `unexpected ${cmd} ${args.join(' ')}` };
  };
  return { run, calls, sleeps, sleep: (ms) => sleeps.push(ms), closes: () => calls.filter((c) => c.startsWith('gh issue close')) };
}
const go = (w, { ticket = 'issue-12', pr = 140, perm = 'yes' } = {}) => closeTicketIssue({ ticket, pr, repo: REPO, perm, run: w.run, sleep: w.sleep });

// AC2: merged into a base GitHub's keyword does not act on (no closing reference), issue still open.
let w = world({ pr: { state: 'MERGED', closes: [] }, issue: ['OPEN'] });
let out = go(w);
t('AC2 the issue the keyword did not close is closed with a "Merged in" comment', w.closes(), [`gh issue close 12 --repo ${REPO} --comment Merged in #140.`]);
t('AC2 and the close is reported', out, [`${REPO}#12 closed: Merged in #140. (its closing keyword did not close it; §3 gh-issue-close)`]);
t('AC2 with no closing reference nothing is waited for', w.sleeps.length, 0);

// AC4: the keyword fired: GitHub closed the issue a moment after the merge, so desk closes nothing.
w = world({ pr: { state: 'MERGED', closes: [12] }, issue: ['OPEN', 'CLOSED'] });
out = go(w);
t('AC4 the keyword closing it a moment later is waited for', w.sleeps.length, 1);
t('AC4 and nothing is closed or commented', w.closes(), []);
t('AC4 and it reads as already closed', out, [`${REPO}#12 already closed`]);
w = world({ pr: { state: 'MERGED', closes: [12] }, issue: ['OPEN'] });
out = go(w);
t('AC4 a keyword that never fires is waited for, then the issue is closed', [w.sleeps.length, w.closes().length], [WAIT_TRIES - 1, 1]);

// The squash that dropped the keyword: the PR lists another issue, not this one.
w = world({ pr: { state: 'MERGED', closes: [99] }, issue: ['OPEN'] });
go(w);
t('a closing reference to another issue is not waited for', [w.sleeps.length, w.closes().length], [0, 1]);

// §3 gh-issue-close short of yes: named as ready to close, nothing done.
for (const perm of ['ask', 'no', null]) {
  w = world({ pr: { state: 'MERGED' }, issue: ['OPEN'] });
  out = go(w, { perm });
  t(`AC2 gh-issue-close ${perm ?? 'unset'}: nothing closed`, w.closes().length, 0);
  t(`AC2 gh-issue-close ${perm ?? 'unset'}: named as ready to close with its command`, out[0], `${REPO}#12 is ready to close, PR #140 merged without closing it (config §3 gh-issue-close is ${perm ?? 'unset'}): gh issue close 12 --repo ${REPO} --comment 'Merged in #140.'`);
}

// Every PR state gh gives (OPEN, CLOSED, MERGED) and every issue state (OPEN, CLOSED).
for (const state of ['OPEN', 'CLOSED']) {
  w = world({ pr: { state }, issue: ['OPEN'] });
  t(`a PR that is ${state} leaves the issue open`, [go(w)[0], w.closes().length], [`${REPO}#12 left open: PR #140 is ${state.toLowerCase()}, not merged`, 0]);
}
w = world({ pr: { state: 'MERGED' }, issue: ['CLOSED'] });
t('an issue already closed is left as it is', [go(w), w.closes().length], [[`${REPO}#12 already closed`], 0]);
w = world({ pr: 'fail', issue: ['OPEN'] });
t('a PR that cannot be read closes nothing', [go(w)[0], w.closes().length], [`${REPO}#12 left open: PR #140 could not be read (HTTP 502)`, 0]);
w = world({ pr: { state: 'MERGED' }, issue: 'fail' });
t('an issue that cannot be read closes nothing', [go(w)[0], w.closes().length], [`${REPO}#12 left open: its state could not be read (HTTP 404)`, 0]);
w = world({ pr: { state: 'MERGED' }, issue: ['OPEN'], close: false });
t('a refused close says how to close it by hand', go(w)[0], `${REPO}#12 not closed: HTTP 403 — close it by hand: gh issue close 12 --repo ${REPO} --comment 'Merged in #140.'`);
w = world({ pr: { state: 'MERGED' }, issue: ['OPEN'] });
t('any other ticket key does nothing', [go(w, { ticket: 'DS-12' }), w.calls.length], [[], 0]);

// The CLI does nothing in a repo with a Jira tracker, where issue-<n> is not a ticket.
const T = scratch('desk-issue-close-');
writeFileSync(join(T, 'config.md'), '## 0. Repo\n\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n\n## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `DS-[0-9]+` |\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|AUTOPILOT_)/.test(k)));
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'issue-close.mjs');
const cli = (args) => spawnSync('node', [bin, ...args], { encoding: 'utf8', env: { ...env, HOME: T, DESK_CONFIG: join(T, 'config.md'), PATH: '/usr/bin:/bin:' + dirname(process.execPath) } });
let r = cli(['issue-12', '--pr', '140', '--repo', REPO]);
t('with a Jira tracker the CLI prints nothing and exits 0', `${r.status} ${r.stdout}${r.stderr}`, '0 ');
r = cli(['issue-12', '--repo', REPO]);
t('the CLI wants --pr', r.status, 2);
rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'issue close: all checks passed');
process.exit(fails ? 1 : 0);
