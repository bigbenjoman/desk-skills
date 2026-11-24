// suite: review misses (what the outside gate reviewer found after desk's clean verdict, and the review checks learned from it)
// layer: L1
// covers: desk/bin/review-misses.mjs
import { readFileSync, existsSync } from 'node:fs';
import { scratch } from './scratch.mjs';
import * as RM from '../desk/bin/review-misses.mjs';
import { renderPage } from '../desk/bin/levers-page.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = JSON.stringify;
const H = (h, m) => `2026-11-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const DESK = 'av-rx', BOT = 'agent-pullbot';
const CLEAN = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const CTX = { desk: DESK, external: BOT, clean: CLEAN };
const verdict = (sha, p1) => `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${sha} p0=0 p1=${p1} p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=1 -->\nreview`;
const review = (login, at, { body = '', oid = 'abc1234ff', comments = [], url = null } = {}) => ({ author: { login }, submittedAt: at, state: 'COMMENTED', body, url, commit: { oid }, comments: { nodes: comments } });
const pr = (n, reviews, merged = H(13, 0)) => ({ data: { repository: { pullRequest: { number: n, url: `https://github.com/o/r/pull/${n}`, mergedAt: merged, reviews: { nodes: reviews } } } } });
const inline = (path, line, body) => ({ path, line, body, url: `https://github.com/o/r/pull/7#discussion_${line}` });

// Desk calls abc1234 clean at 10:30; the bot reviews that head at 11:40 with an inline comment and a body
// finding; a bot review before desk's verdict, or of another head, is not a miss.
const p = pr(7, [
  review(BOT, H(10, 0), { comments: [inline('a.ts', 1, 'P1 before desk was done')] }),
  review(DESK, H(10, 30), { body: verdict('abc1234', 0) }),
  review(BOT, H(11, 40), { url: 'https://github.com/o/r/pull/7#pullrequestreview-9', body: '### P1 (1)\n- src/i18n.ts:4 copy is inline, not in the locale files', comments: [inline('src/api.ts', 12, '**P1** the server-set total is never traced to where it is read')] }),
  review(BOT, H(12, 0), { oid: 'ffff999', comments: [inline('b.ts', 2, 'another head')] }),
]);
const m = RM.missesOf(p, CTX);
t('#1375 AC1 each finding the gate reviewer posted at desk\'s clean head after that verdict is a miss, with its head and link',
  j(m.findings.map((f) => [f.head, f.text.slice(0, 13), f.link])),
  j([['abc1234ff', 'src/api.ts:12', 'https://github.com/o/r/pull/7#discussion_12'], ['abc1234ff', '- src/i18n.ts', 'https://github.com/o/r/pull/7#pullrequestreview-9']]));
t('#1375 AC1 a head desk never called clean has no misses', RM.missesOf(pr(8, [review(DESK, H(10, 30), { body: verdict('abc1234', 2) }), review(BOT, H(11, 0), { comments: [inline('a.ts', 1, 'x')] })]), CTX).findings.length, 0);
t('#1375 AC1 a PR not merged has no misses', RM.missesOf(pr(9, [], null), CTX), null);

// Classification: one model call for a PR's findings, stubbed here; an unknown kind is 'other'.
let prompt = '';
const stub = (reply) => (pr0) => { prompt = pr0; return reply; };
const kinds = RM.classify(m.findings, stub('Sure.\nKINDS: ["server-value", "made-up"]'));
t('#1375 AC1 each miss gets a kind from the fixed taxonomy, other where the model names none of it', j(kinds.map((k) => k.kind)), j(['server-value', 'other']));
t('#1375 the prompt lists every kind and every finding', j([Object.keys(RM.KINDS).every((k) => prompt.includes(k)), /1\. src\/api\.ts:12/.test(prompt)]), j([true, true]));
t('#1375 an unreadable reply classifies nothing, so the PR is read again', RM.classify(m.findings, stub('no idea')), null);

// The pass's step: misses logged per PR with PR, head, kind and link; a kind on two PRs is learned.
const S = scratch('review-misses-');
const tickets = { A: { merged_at: H(8, 0), merge: { pr: 7 } }, B: { merged_at: H(9, 0), merge: { pr: 8 } }, C: { merged_at: H(10, 0), merge: { pr: 9 } } };
const bodies = { 7: p, 8: pr(8, [review(DESK, H(10, 30), { body: verdict('abc1234', 0) }), review(BOT, H(11, 0), { comments: [inline('c.ts', 3, 'total set by the server is not traced')] })]), 9: pr(9, [review(DESK, H(10, 30), { body: verdict('abc1234', 0) })]) };
const gql = (q) => bodies[Number(/number:(\d+)/.exec(q)[1])];
const run = (pr0) => `KINDS: ${j(pr0.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => (/total|server/.test(l) ? 'server-value' : 'i18n')))}`;
const lines = RM.missesStep(S, { tickets, gql, run, ctx: CTX, repo: 'o/r', now: H(14, 0) });
const log = RM.readMisses(S);
t('#1375 AC1 each miss is recorded in the repo\'s review-misses log with its PR, head, kind and link',
  j(log.map((e) => [e.pr, e.misses.map((x) => [x.head, x.kind, !!x.link])])),
  j([[7, [['abc1234ff', 'server-value', true], ['abc1234ff', 'i18n', true]]], [8, [['abc1234ff', 'server-value', true]]], [9, []]]));
const md = existsSync(RM.learnedPath(S)) ? readFileSync(RM.learnedPath(S), 'utf8') : '';
t('#1375 AC2 a kind missed on two PRs is a checklist line in the file desk-review reads, citing those PRs',
  j([/- \[ \] \*\*server-value\*\*: Trace every value/.test(md), /\[#7\]\(https:\/\/github\.com\/o\/r\/pull\/7\), \[#8\]/.test(md)]), j([true, true]));
t('#1375 AC2 a kind missed on one PR only is not learned', /\*\*i18n\*\*/.test(md), false);
t('#1375 AC2 the pass reports the check it learned', lines.some((l) => /learned 1 new review check\(s\) \(server-value\)/.test(l)), true);
t('#1375 a PR already logged is not read again', RM.missesStep(S, { tickets, gql: () => { throw new Error('read'); }, run, ctx: CTX, now: H(15, 0) }).filter((l) => /could not be read/.test(l)).length, 0);
t('#1375 a repo with no outside reviewer reads nothing', j(RM.missesStep(scratch('review-misses-none-'), { tickets, gql, run, ctx: { ...CTX, external: null } })), j([]));

// AC3: learned lines only add checks. A line stays once learned, its PRs only grow, its wording is fixed
// per kind (no reviewer text reaches it), and the file says the bar wins.
const learned = RM.readLearned(S);
t('#1375 AC3 a later regeneration with fewer recurring kinds keeps every learned line', j(RM.merged(learned, {}, H(16, 0)).lines), j(learned.lines));
t('#1375 AC3 a regeneration adds PRs to a line, never drops one', j(RM.merged(learned, { 'server-value': [12] }, H(16, 0)).lines['server-value']), j([7, 8, 12]));
t('#1375 AC3 the learned bar keeps when it began', RM.merged(learned, { i18n: [1, 2] }, H(17, 0)).since, H(14, 0));
const evil = RM.renderLearned({ since: H(14, 0), lines: { 'server-value': [7, 8], other: [1, 2] } });
t('#1375 AC3 every line is a check from the fixed wording, none for other, and the file says it never relaxes the bar',
  j([evil.split('\n').filter((l) => l.startsWith('- [ ]')).length, /None removes, softens or\s+reclassifies anything there: where a line seems to, the bar wins/.test(evil)]), j([1, true]));
t('#1375 AC3 a finding\'s own text never reaches the learned bar', /never traced to where it is read/.test(md), false);

// AC4: external re-reviews per PR and undraft-to-approval time, before and after the learned bar.
const st = (n, opened, rounds, wait, rereviews) => ({ pr: n, opened, external: { rounds, wait, rereviews } });
const ba = RM.beforeAfter([st(1, H(9, 0), 3, 60, 120), st(2, H(10, 0), 2, 30, 30), st(3, H(15, 0), 1, 20, 0), st(4, H(16, 0), 2, 40, 20), { pr: 5, unread: true }], H(14, 0));
t('#1375 AC4 re-reviews per PR and undraft-to-approval median split at the learned bar\'s start', j(ba), j({ since: H(14, 0), before: { prs: 2, rereviews: 1.5, approval: 120 }, after: { prs: 2, rereviews: 0.5, approval: 40 } }));
t('#1375 AC4 with no learned bar there is no comparison', RM.beforeAfter([st(1, H(9, 0), 1, 1, 0)], null), null);
const view = (repos) => ({ v: 1, generated_at: H(13, 0), tz: 'UTC', repos: [], baseline: null, line: { state: 'today' },
  panels: { status: {}, waiting: { items: [] }, cost: {}, guardrails: {}, board: { levers: [] }, changes: {}, overhead: {}, data_quality: {}, trends: { metrics: {} }, merge_stages: { repos } } });
const stages = { desk: { n: 0 }, undraft: { n: 0 }, external_wait: { n: 0 }, external_rereviews: { n: 0 }, merge: { n: 0 } };
let page = '';
try { page = renderPage(view([{ name: 'desk-skills', prs: 4, stages, outage: 0, learned: ba }])); } catch (err) { page = `threw: ${err.message}`; }
t('#1375 AC4 the levers report shows re-reviews per PR and undraft to approval before and after the learned bar',
  j([/learned review bar since 2026-11-24/.test(page), /<th scope="row">Before<\/th><td>2<\/td><td>1.5<\/td><td>2h<\/td>/.test(page), /<th scope="row">After<\/th><td>2<\/td><td>0.5<\/td><td>40m<\/td>/.test(page)]), j([true, true, true]));

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
