// suite: post-merge watch (reverts and a red default branch within the watch, recorded once)
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { postMergeScan, postMergeDue, readPostMerge, revertedPr, gitLog, postMergePath } from '../desk/bin/post-merge.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const NOW = Date.parse('2026-11-13T12:00:00Z');
const H = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();
const tmp = mkdtempSync(join(tmpdir(), 'post-merge-'));

// A fixture repo whose main holds each ticket's merge and, later, the reverts.
const repo = join(tmp, 'repo');
const git = (args, when) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
  { encoding: 'utf8', env: { ...process.env, ...(when ? { GIT_AUTHOR_DATE: `@${when / 1000} +0000`, GIT_COMMITTER_DATE: `@${when / 1000} +0000` } : {}) } });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
let n = 0;
const commit = (subject, when) => { writeFileSync(join(repo, 'f'), String(n++)); git(['add', 'f']); git(['commit', '-q', '-m', subject], when); return git(['rev-parse', 'HEAD']).trim(); };
const mergedA = NOW - 3 * 24 * H;
const mergedD = NOW - 15 * 24 * H;
commit('feat: D (#4)', mergedD);
commit('feat: A (#1)', mergedA);
const revertA = commit('Revert "feat: A (#1)" (#9)', NOW - 2 * 24 * H);
const revertD = commit('Revert "feat: D (#4)"', NOW - H);

const queue = { tickets: {
  'T-A': { merged_at: iso(mergedA), result: { pr: 1 } },
  'T-B': { merged_at: iso(NOW - 40 * H), pr_status: { pr: 2 } },
  'T-C': { merged_at: iso(NOW - 80 * H), result: { pr: 3 } },
  'T-D': { merged_at: iso(mergedD), result: { pr: 4 } },
  'T-E': { result: { pr: 5 } },
} };
const runs = [
  { id: 101, name: 'CI', url: 'https://example.com/r/101', conclusion: 'failure', created_at: iso(NOW - 30 * H) },   // T-B +10h
  { id: 102, name: 'CI', url: 'https://example.com/r/102', conclusion: 'success', created_at: iso(NOW - 35 * H) },   // T-B +5h, green
  { id: 103, name: 'CI', url: 'https://example.com/r/103', conclusion: 'failure', created_at: iso(NOW - 50 * H) },   // T-C +30h
];
const log = (since) => gitLog(repo, 'main', since);

t('subject: a squash revert names its PR', revertedPr('Revert "feat: A (#1)" (#9)'), 1);
t('subject: a merge-commit revert names its PR', revertedPr('Revert "Merge pull request #12 from o/b"'), 12);
t('subject: a revert of a revert reverts nothing', revertedPr('Revert "Revert "feat: A (#1)""'), null);
t('subject: an ordinary commit reverts nothing', revertedPr('feat: A (#1)'), null);

const state = join(tmp, 'state');
const r1 = postMergeScan({ state, queue, log, runs: () => runs, now: NOW });
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

const again = postMergeScan({ state, queue, log, runs: () => runs, now: NOW + H });
t('a scan within a day of the last does not run', again.ran, false);
const before = readFileSync(postMergePath(state), 'utf8');
const r2 = postMergeScan({ state, queue, log, runs: () => runs, now: NOW + 25 * H });
t('AC5 the next day\'s scan writes no second record', r2.written.length, 0);
t('AC5 only its scan line is added', readFileSync(postMergePath(state), 'utf8').slice(before.length).trim().split('\n').map((l) => JSON.parse(l).kind).join(), 'scan');

const state6 = join(tmp, 'state6');
const r6 = postMergeScan({ state: state6, queue, log, runs: () => { throw new Error('gh: HTTP 502'); }, now: NOW });
const recs6 = readPostMerge(state6);
t('AC6 an unreadable run list writes no red_main record', recs6.filter((r) => r.kind === 'red_main').length, 0);
t('AC6 and records the scan as incomplete', recs6.find((r) => r.kind === 'scan')?.complete, false);
t('AC6 saying why', /runs not read: gh: HTTP 502/.test(recs6.find((r) => r.kind === 'scan')?.why), true);
t('AC6 the revert is still recorded from the log', recs6.filter((r) => r.kind === 'revert').length, 1);
t('AC6 the pass line says the scan was incomplete', /scan incomplete/.test(r6.line), true);

let asked = null;
postMergeScan({ state: join(tmp, 'state7'), queue, log, runs: (since) => { asked = since; return []; }, now: NOW });
t('the runs are read from the earliest watched merge', asked, iso(mergedD));

// The supervisor runs a pass on an idle batch when a scan falls due, so the watch outlives the batch's last pass.
t('a scan is due with no scan yet and a merge watched', postMergeDue({ state: join(tmp, 'state8'), queue, now: NOW }), true);
t('a scan is not due within a day of the last', postMergeDue({ state, queue, now: NOW + 26 * H }), false);
t('a scan is due a day after the last', postMergeDue({ state, queue, now: NOW + 50 * H }), true);
t('a scan is not due once every merge is past the watch', postMergeDue({ state, queue, now: mergedA + 17 * 24 * H }), false);

rmSync(tmp, { recursive: true, force: true });
if (fails) { console.log(`${fails} failed`); process.exit(1); }
