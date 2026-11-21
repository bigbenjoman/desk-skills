// suite: post-merge watch (reverts and a red default branch within the watch, recorded once)
import { rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { postMergeScan, postMergeDue, readPostMerge, revertedPr, landedPr, gitLog, ghRuns, postMergePath } from '../desk/bin/post-merge.mjs';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const NOW = Date.parse('2026-11-13T12:00:00Z');
const H = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const tmp = scratch('post-merge-');

// A fixture repo whose main holds each ticket's merge and, later, the reverts.
const repo = join(tmp, 'repo');
const git = (args, when) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
  { encoding: 'utf8', env: { ...process.env, ...(when ? { GIT_AUTHOR_DATE: `@${when / 1000} +0000`, GIT_COMMITTER_DATE: `@${when / 1000} +0000` } : {}) } });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
let n = 0;
const commit = (subject, when) => { writeFileSync(join(repo, 'f'), String(n++)); git(['add', 'f']); git(['commit', '-q', '-m', subject], when); return git(['rev-parse', 'HEAD']).trim(); };
const mergedA = NOW - 3 * 24 * H;
const mergedD = NOW - 15 * 24 * H;
const shaD = commit('feat: D (#4)', mergedD);
const shaC = commit('Merge pull request #3 from o/c', NOW - 80 * H);
const shaA = commit('feat: A (#1)', mergedA);
const SHA_B = 'b'.repeat(40);
const revertA = commit('Revert "feat: A (#1)" (#9)', NOW - 2 * 24 * H);
const revertD = commit('Revert "feat: D (#4)"', NOW - H);

const queue = { tickets: {
  'T-A': { merged_at: iso(mergedA), result: { pr: 1 } },
  'T-B': { merged_at: iso(NOW - 40 * H), pr_status: { pr: 2, merge_commit: SHA_B } },
  'T-C': { merged_at: iso(NOW - 80 * H), result: { pr: 3 } },
  'T-D': { merged_at: iso(mergedD), result: { pr: 4 } },
  'T-E': { result: { pr: 5 } },
} };
// Each merge commit's runs: `runs(sha)` as the scan asks for them.
const runsAt = {
  [SHA_B]: [
    { id: 101, name: 'CI', url: 'https://example.com/r/101', conclusion: 'failure', created_at: iso(NOW - 30 * H) },   // T-B +10h
    { id: 102, name: 'CI', url: 'https://example.com/r/102', conclusion: 'success', created_at: iso(NOW - 35 * H) },   // T-B +5h, green
  ],
  [shaC]: [{ id: 103, name: 'CI', url: 'https://example.com/r/103', conclusion: 'failure', created_at: iso(NOW - 50 * H) }],   // T-C +30h
};
const runs = (sha) => runsAt[sha] ?? [];
const log = (since) => gitLog(repo, 'main', since);

t('subject: a squash revert names its PR', revertedPr('Revert "feat: A (#1)" (#9)'), 1);
t('subject: a merge-commit revert names its PR', revertedPr('Revert "Merge pull request #12 from o/b"'), 12);
t('subject: a revert of a revert reverts nothing', revertedPr('Revert "Revert "feat: A (#1)""'), null);
t('subject: an ordinary commit reverts nothing', revertedPr('feat: A (#1)'), null);
t('subject: a squash merge lands its PR', landedPr('feat: A (#1)'), 1);
t('subject: a merge commit lands its PR', landedPr('Merge pull request #12 from o/b'), 12);
t('subject: a revert lands no PR', landedPr('Revert "feat: A (#1)" (#9)'), null);

const state = join(tmp, 'state');
const r1 = postMergeScan({ state, queue, log, runs, now: NOW });
const recs = readPostMerge(state);
const of = (ticket, kind) => recs.filter((r) => r.ticket === ticket && r.kind === kind);
t('AC1 ticket A gets one revert record', of('T-A', 'revert').length, 1);
t('AC1 naming the reverting commit', of('T-A', 'revert')[0]?.commit, revertA);
t('AC2 ticket B gets one red_main record', of('T-B', 'red_main').length, 1);
t('AC2 naming the run', of('T-B', 'red_main')[0]?.run?.id, 101);
t('AC3 a run failing 30 hours after ticket C merged records nothing', of('T-C', 'red_main').length, 0);
t('AC4 a PR merged 15 days ago and reverted today records nothing', recs.filter((r) => r.ticket === 'T-D').length, 0);
t('AC4 though the revert is on main', log(iso(mergedD)).some((c) => c.sha === revertD), true);
t('a ticket with no merge time is not watched', recs.filter((r) => r.ticket === 'T-E').length, 0);
t('the scan is recorded complete', recs.filter((r) => r.kind === 'scan').map((r) => r.complete).join(), 'true');
t('the pass line names what was recorded', /T-A reverted by .*T-B red main in run 101/.test(r1.line), true);

const again = postMergeScan({ state, queue, log, runs, now: NOW + H });
t('a scan within a day of the last does not run', again.ran, false);
const before = readFileSync(postMergePath(state), 'utf8');
const r2 = postMergeScan({ state, queue, log, runs, now: NOW + 25 * H });
t('AC5 the next day\'s scan writes no second record', r2.written.length, 0);
t('AC5 only its scan line is added', readFileSync(postMergePath(state), 'utf8').slice(before.length).trim().split('\n').map((l) => JSON.parse(l).kind).join(), 'scan');

const state6 = join(tmp, 'state6');
const r6 = postMergeScan({ state: state6, queue, log, runs: () => { throw new Error('gh: HTTP 502'); }, now: NOW });
const recs6 = readPostMerge(state6);
t('AC6 an unreadable run list writes no red_main record', recs6.filter((r) => r.kind === 'red_main').length, 0);
t('AC6 and records the scan as incomplete', recs6.find((r) => r.kind === 'scan')?.complete, false);
t('AC6 saying why', /runs not read: #\d+ at [0-9a-f]{12}: gh: HTTP 502/.test(recs6.find((r) => r.kind === 'scan')?.why), true);
t('AC6 the revert is still recorded from the log', recs6.filter((r) => r.kind === 'revert').length, 1);
t('AC6 the pass line says the scan was incomplete', /scan incomplete/.test(r6.line), true);

let asked = null; const shas = [];
postMergeScan({ state: join(tmp, 'state7'), queue, log: (since) => { asked = since; return log(since); }, runs: (sha) => { shas.push(sha); return []; }, now: NOW });
t('the log is read from an hour before the earliest watched merge', asked, iso(mergedD - H));
t('each watched merge\'s runs are read on its merge commit: recorded, or found in the log by its PR', shas.sort().join(), [SHA_B, shaA, shaC, shaD].sort().join());

// A merge whose merge commit is neither recorded nor on the default branch: its runs are not read, and the scan says so.
const state10 = join(tmp, 'state10');
const lost = { tickets: { ...queue.tickets, 'T-F': { merged_at: iso(NOW - 10 * H), result: { pr: 6 } } } };
const r10 = postMergeScan({ state: state10, queue: lost, log, runs, now: NOW });
t('a merge with no merge commit found leaves the scan incomplete, naming its PR', readPostMerge(state10).find((r) => r.kind === 'scan')?.why, 'default-branch runs not read: #6: no merge commit on the default branch');
t('the other merges\' runs are still read', r10.written.filter((r) => r.kind === 'red_main').map((r) => r.ticket).join(), 'T-B');
const state11 = join(tmp, 'state11');
postMergeScan({ state: state11, queue, log, runs: (sha) => { if (sha === shaC) throw new Error('gh: HTTP 502'); return runs(sha); }, now: NOW });
t('one merge\'s runs not read is said with its PR and commit', readPostMerge(state11).find((r) => r.kind === 'scan')?.why, `default-branch runs not read: #3 at ${shaC.slice(0, 12)}: gh: HTTP 502`);

// A busy default branch: 1,200 runs in the window, two of them on the watched merge's commit. The API is
// asked for that commit's runs only, so the watch reads them whole and records the failure.
const busy = Array.from({ length: 1200 }, (_, i) => ({ id: 5000 + i, name: 'CI', html_url: `https://example.com/r/${5000 + i}`, conclusion: 'failure', created_at: iso(NOW - 30 * H + i * 1000), head_sha: i % 600 === 7 ? SHA_B : 'f'.repeat(40), head_branch: 'main' }));
const calls = [];
const api = (args) => {
  calls.push(args.join(' '));
  const u = new URL(`https://api.github.com/${args[1]}`);
  const hit = busy.filter((r) => r.head_sha === u.searchParams.get('head_sha') && r.head_branch === u.searchParams.get('branch'));
  const per = Number(u.searchParams.get('per_page'));
  return JSON.stringify({ total_count: hit.length, workflow_runs: hit.slice(0, per) });
};
t('the branch has more than 1000 runs', busy.length > 1000, true);
const state12 = join(tmp, 'state12');
const r12 = postMergeScan({ state: state12, queue: { tickets: { 'T-B': queue.tickets['T-B'] } }, log, runs: (sha) => ghRuns('o/r', 'main', sha, api), now: NOW });
t('the watched merge\'s failed runs are recorded', r12.written.map((r) => r.run.id).join(), '5007,5607');
t('and the scan is complete', readPostMerge(state12).find((r) => r.kind === 'scan')?.complete, true);
t('the pass line names them', r12.line, 'post-merge watch: T-B red main in run 5007, T-B red main in run 5607');
t('one API call, for that commit on the default branch', calls.join('|'), `api repos/o/r/actions/runs?head_sha=${SHA_B}&branch=main&per_page=100`);
const many = (args) => JSON.stringify({ total_count: 150, workflow_runs: busy.slice(0, 100) });
let threw = null; try { ghRuns('o/r', 'main', SHA_B, many); } catch (e) { threw = e.message; }
t('a commit with more runs than one page throws rather than read as complete', threw, `150 runs on ${SHA_B.slice(0, 12)}, more than one page read`);

// The supervisor runs a pass on an idle batch when a scan falls due, so the watch outlives the batch's last pass.
t('a scan is due with no scan yet and a merge watched', postMergeDue({ state: join(tmp, 'state8'), queue, now: NOW }), true);
t('a scan is not due within a day of the last', postMergeDue({ state, queue, now: NOW + 26 * H }), false);
t('a scan is due a day after the last', postMergeDue({ state, queue, now: NOW + 50 * H }), true);
t('a scan is not due once every merge is past the watch', postMergeDue({ state, queue, now: mergedA + 17 * 24 * H }), false);

// A merged ticket is archived within a pass of its merge (queue-store.mjs archiveDone): it is still watched.
const { attachArchive, archiveDone } = await import('../desk/bin/queue-store.mjs');
const qf = join(tmp, 'queue.json');
const live = { tickets: { 'T-A': { key: 'T-A', state: 'done', merged_at: iso(mergedA), result: { pr: 1 } } } };
const movedA = archiveDone(qf, live);
writeFileSync(qf, JSON.stringify(live));
const archivedQueue = attachArchive(JSON.parse(readFileSync(qf, 'utf8')), qf);
t('the ticket was archived, out of the live tickets', `${movedA} ${Object.keys(archivedQueue.tickets).length}`, 'T-A 0');
t('a scan is due for an archived merge', postMergeDue({ state: join(tmp, 'state9'), queue: archivedQueue, now: NOW }), true);
postMergeScan({ state: join(tmp, 'state9'), queue: archivedQueue, log, runs: () => [], now: NOW });
t('an archived ticket\'s revert inside the watch is recorded', readPostMerge(join(tmp, 'state9')).filter((r) => r.kind === 'revert').map((r) => r.ticket).join(), 'T-A');

rmSync(tmp, { recursive: true, force: true });
if (fails) { console.log(`${fails} failed`); process.exit(1); }
