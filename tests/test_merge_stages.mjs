// suite: merge stages (a merged PR's time split into desk review, undraft, external review and merge)
// layer: L1
// covers: desk/bin/merge-stages.mjs
import { scratch } from './scratch.mjs';
import * as MS from '../desk/bin/merge-stages.mjs';
import { outagesAfter } from '../desk/bin/gate-reviewer.mjs';
import { renderPage } from '../desk/bin/levers-page.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = JSON.stringify;
const H = (h, m) => `2026-11-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const DESK = 'av-rx', BOT = 'agent-pullbot';
const CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const verdict = (sha, p1) => `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${sha} p0=0 p1=${p1} p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=1 -->\nreview`;
const pr = ({ ready = [H(11, 0)], reviews = [], checks = [], merged = H(13, 0) } = {}) => ({ data: { repository: { pullRequest: {
  number: 7, createdAt: H(9, 0), mergedAt: merged,
  timelineItems: { nodes: ready.map((createdAt) => ({ createdAt })) },
  reviews: { nodes: reviews.map(([login, at, body = '']) => ({ author: { login }, submittedAt: at, body, commit: { oid: 'abc' } })) },
  commits: { nodes: [{ commit: { oid: 'abc', statusCheckRollup: { contexts: { nodes: checks } } } }] },
} } } });

// Opened 09:00; desk's first round 09:30 not clean, its second 10:30 clean; undrafted 11:00; the bot
// reviews 11:40 and again 12:10; tests green 12:40; merged 13:00.
const p = pr({
  reviews: [[DESK, H(9, 30), verdict('abc1234', 1)], [DESK, H(10, 30), verdict('abc1234', 0)], [BOT, H(11, 40)], [BOT, H(12, 10)]],
  checks: [{ __typename: 'CheckRun', name: 'tests', completedAt: H(12, 40), conclusion: 'SUCCESS' }, { __typename: 'CheckRun', name: 'lint', completedAt: H(12, 20), conclusion: 'SKIPPED' }],
});
const s = MS.stagesOf(p, { desk: DESK, external: BOT, clean: CLEAN });
t('#1378 desk review runs from the PR opening to its clean verdict, round by round, each marked clean or not',
  j([s.desk.minutes, s.desk.rounds.map((r) => [r.minutes, r.clean])]), j([90, [[30, false], [60, true]]]));
t('#1378 undraft is the clean verdict to the PR leaving draft', s.undraft, 30);
t('#1378 the external review splits into the wait for its first review and the re-reviews after it',
  j([s.external.wait, s.external.rereviews, s.external.rounds, s.external.outage]), j([40, 30, 2, false]));
t('#1378 merge is the last required check green to the merge', s.merge, 20);
t('#1378 a repo with no outside reviewer has no external stage', MS.stagesOf(p, { desk: DESK, external: null, clean: CLEAN }).external, null);
t('#1378 a PR not merged has no stages', MS.stagesOf(pr({ merged: null }), { desk: DESK, clean: CLEAN }), null);
t('#1378 a PR never in draft has no undraft, and its desk rounds run to the merge', j((({ undraft, desk }) => [undraft, desk.rounds.length])(MS.stagesOf(pr({ ready: [], reviews: [[DESK, H(9, 30), verdict('abc1234', 0)]] }), { desk: DESK, clean: CLEAN }))), j([null, 1]));

// Desk's review runs locally before the PR opens: it starts at the worker's last Stage 4b session.
{
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const W = scratch('merge-stages-local-');
  mkdirSync(join(W, 'workers'), { recursive: true });
  writeFileSync(join(W, 'workers', 'T-7.runs.jsonl'), [{ at: H(7, 0), ticket: 'T-7', session: 'a', stage: '0' }, { at: H(8, 0), ticket: 'T-7', session: 'b', stage: '4b' }, { at: H(9, 30), ticket: 'T-7', session: 'c', stage: '4b' }].map((x) => JSON.stringify(x)).join('\n'));
  writeFileSync(join(W, 'workers', 'T-7.findings.jsonl'), [{ ticket: 'T-7', round: 1, reviewer: 'self', head: 'h1' }, { ticket: 'T-7', round: 2, reviewer: 'self', head: 'h1' }, { ticket: 'T-7', round: 1, reviewer: 'pr', head: 'h2' }].map((x) => JSON.stringify(x)).join('\n'));
  const local = MS.localReview(W, 'T-7');
  t('#1378 the review desk ran before the PR is read from the batch: its Stage 4b starts and self-review rounds', j(local), j({ starts: [H(8, 0), H(9, 30)], rounds: 2 }));
  const sl = MS.stagesOf(p, { desk: DESK, external: BOT, clean: CLEAN, local });
  t('#1378 desk review then starts at the last Stage 4b session before the PR opened, not at the opening',
    j([sl.desk.minutes, sl.desk.local, sl.desk.rounds[0].start]), j([150, { start: H(8, 0), rounds: 2 }, H(8, 0)]));
  t('#1378 with no worker records it starts at the PR opening', j(MS.localReview(join(W, 'none'), 'T-7')), j({ starts: [], rounds: null }));
}

// A gate-reviewer outage (gate-reviewer.mjs outagesAfter) over the wait marks it.
const outages = outagesAfter([], { [BOT]: H(10, 0) }, Date.parse(H(11, 5)));
t('#1378 a reviewer read as down opens an outage from its last review', j(outages), j([{ login: BOT, from: H(10, 0), to: null }]));
const closed = outagesAfter(outages, {}, Date.parse(H(11, 50)));
t('#1378 and back up, the outage closes then', closed[0].to, new Date(H(11, 50)).toISOString());
t('#1378 still down, the open outage is kept, not opened again', outagesAfter(outages, { [BOT]: H(10, 0) }, Date.parse(H(11, 20))).length, 1);
const so = MS.stagesOf(p, { desk: DESK, external: BOT, clean: CLEAN, outages: closed });
t('#1378 an external wait inside a reviewer outage is marked', so.external.outage, true);

// The summary: median and p75 per stage, the outage's wait left out of the external medians.
const e = (desk, undraft, wait, rere, merge, outage = false) => ({ pr: Math.random(), desk: { minutes: desk }, undraft, external: { wait, rereviews: rere, outage }, merge });
const sum = MS.summary([e(60, 10, 30, 0, 5), e(120, 20, 50, 20, 15), e(90, 30, 40, 10, 10), e(100, 40, 600, 0, 20, true)]);
t('#1378 each stage has its median and p75', j([sum.stages.desk.median, sum.stages.desk.p75, sum.stages.undraft.median]), j([95, 105, 25]));
t('#1378 a wait inside an outage is left out of the external medians and counted', j([sum.stages.external_wait.n, sum.stages.external_wait.median, sum.outage]), j([3, 40, 1]));
t('#1378 the line names each stage\'s median and p75, and the waits left out',
  MS.stagesLine(sum), 'merge time by stage over 4 merged PRs (median / p75): desk review 1.6h / 1.8h · undraft 25m / 33m · external review wait 40m / 45m · external re-reviews 10m / 15m · merge 13m / 16m; 1 external wait inside a reviewer outage left out');
t('#1378 with nothing recorded there is no line', MS.stagesLine(MS.summary([])), null);

// What a pass reads: merged tickets with no stages yet, oldest first, a few at a time; the record keeps
// the latest line per PR.
const tickets = { A: { merged_at: H(12, 0), merge: { pr: 1 } }, B: { merged_at: H(10, 0), result: { pr: 2 } }, C: { merged_at: H(11, 0), merge: { pr: 3 } }, D: { state: 'running' }, E: { merged_at: H(9, 0), merge: { pr: 4 } }, F: { merged_at: H(8, 0), merge: { pr: 5 } } };
t('#1378 a pass reads merged tickets with no stages, oldest merge first, three at most', j(MS.due(tickets, [{ pr: 5 }])), j([{ key: 'E', pr: 4 }, { key: 'B', pr: 2 }, { key: 'C', pr: 3 }]));
const S = scratch('merge-stages-');
MS.recordStages(S, { key: 'A', pr: 1, merge: 5 });
MS.recordStages(S, { key: 'A', pr: 1, merge: 7 });
MS.recordStages(S, { key: 'B', pr: 2, merge: 3 });
t('#1378 the record keeps the latest line per PR', j(MS.readStages(S).map((x) => [x.pr, x.merge])), j([[1, 7], [2, 3]]));

// The levers report shows the stages per repo, and nothing where none are recorded.
const view = (repos) => ({ v: 1, generated_at: H(13, 0), tz: 'UTC', repos: [], baseline: null, line: { state: 'today' },
  panels: { status: {}, waiting: { items: [] }, cost: {}, guardrails: {}, board: { levers: [] }, changes: {}, overhead: {}, data_quality: {}, trends: { metrics: {} }, merge_stages: { repos } } });
let page = '';
try { page = renderPage(view([{ name: 'desk-skills', ...sum }])); } catch (err) { page = `threw: ${err.message}`; }
t('#1378 the levers report has a merge-time-by-stage table per repo, with the outage note',
  j([/Merge time by stage/.test(page), /desk-skills · 4 merged PRs/.test(page), /<th scope="row">desk review<\/th><td>1.6h<\/td><td>1.8h<\/td>/.test(page), /1 external review wait inside a gate reviewer outage/.test(page)]), j([true, true, true, true]));
let bare = '';
try { bare = renderPage(view([])); } catch (err) { bare = `threw: ${err.message}`; }
t('#1378 with no stages recorded the report has no such section', /Merge time by stage/.test(bare) || /^threw/.test(bare), false);

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
