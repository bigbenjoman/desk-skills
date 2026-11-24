// suite: gate reviewer (an outside reviewer that stops reviewing across the repo is one ask, not a wait per PR)
// layer: L1
// covers: desk/bin/gate-reviewer.mjs
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import * as GR from '../desk/bin/gate-reviewer.mjs';
import { readAsks } from '../desk/bin/asks.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = JSON.stringify;
const T0 = Date.parse('2026-11-24T10:00:00Z');
const at = (min) => T0 + min * 60000;
const iso = (min) => new Date(at(min)).toISOString();
const BOT = 'agent-pullbot';
const wait = (pr, head = `h${pr}`) => ({ login: BOT, pr, head, line: `fix tries: PR #${pr} (T-${pr}) is out of draft: its "Review gate" check reads ${BOT}'s review, so it waits for ${BOT} to review the head` });

t('#1365 with no lags recorded, the threshold is the hour floor', GR.threshold([]), 60);
t('#1365 four times the median lag, at least an hour', `${GR.threshold([5, 9, 7])} ${GR.threshold([30, 40, 20])} ${GR.threshold([5, 6])}`, '60 120 60');

// A wait keeps when it began while the head stays; a review at that head records its lag.
let rec = GR.update({ reviewers: {} }, { waits: [wait(1)], now: at(0) });
rec = GR.update(rec, { waits: [wait(1)], now: at(5) });
t('#1365 a PR waiting at the same head keeps when it began', rec.reviewers[BOT].waiting[1].since, iso(0));
rec = GR.update(rec, { seen: [{ login: BOT, pr: 1, head: 'h1', reviewedAtHead: true, last: iso(7) }], waits: [], now: at(8) });
t('#1365 its review at that head records the lag, the latest review, and ends the wait', j([rec.reviewers[BOT].lags, rec.reviewers[BOT].last, rec.reviewers[BOT].waiting]), j([[7], iso(7), {}]));
rec = GR.update(rec, { waits: [wait(2)], now: at(10) });
rec = GR.update(rec, { waits: [wait(2, 'h2b')], now: at(20) });
t('#1365 a new head starts the wait again', rec.reviewers[BOT].waiting[2].since, iso(20));

// Down: PRs waiting longer than the threshold, and no review from it in that time.
const quiet = { reviewers: { [BOT]: { last: iso(0), lags: [5, 6, 7], waiting: { 3: { head: 'h3', since: iso(10) }, 4: { head: 'h4', since: iso(30) } } } } };
t('#1365 within the threshold it is not down', GR.verdict(quiet, BOT, at(60)).down, false);
const v = GR.verdict(quiet, BOT, at(80));
t('#1365 past it, with PRs waiting and no review since, it is down, naming them oldest first', j([v.down, v.since, v.prs, v.threshold]), j([true, iso(0), [3, 4], 60]));
t('#1365 with nothing waiting it is never down', GR.verdict({ reviewers: { [BOT]: { last: iso(0), lags: [], waiting: {} } } }, BOT, at(600)).down, false);
t('#1365 a recent review elsewhere keeps it up, however long one PR waits', GR.verdict({ reviewers: { [BOT]: { last: iso(70), lags: [], waiting: { 3: { head: 'h3', since: iso(0) } } } } }, BOT, at(80)).down, false);

const a = GR.downAsk(BOT, v, { repo: 'acme/widgets', owner: 'Sam Ops' });
t('#1365 the ask names the reviewer, since when, the PRs, and who runs it, with a message to send as it is',
  a.text.startsWith(`gate reviewer down: ${BOT} has posted no review since ${iso(0)} (over 60 minutes, four times its usual wait), and 2 ready PRs are waiting on it (#3, #4). Sam Ops runs it (§4 Infra and security owner): send this as it is: "Hi Sam Ops, ${BOT} has posted no review on acme/widgets since ${iso(0)}, and 2 ready PRs are waiting on it (#3, #4).`) && a.text.endsWith(`This clears itself on ${BOT}'s next review`), true);
t('#1365 with no owner named, the draft is for whoever runs it', GR.downAsk(BOT, v, { repo: 'acme/widgets' }).text.includes('Send whoever runs it this as it is: "agent-pullbot has posted'), true);

// The pass's step: one ask in place of each PR's wait, replaced as it changes, gone on the next review.
const S = scratch('gate-reviewer-');
GR.writeRecord(S, quiet);
let lines = GR.reviewerStep(S, { waits: [wait(3, 'h3'), wait(4, 'h4')], now: at(80), repo: 'acme/widgets' });
t('#1365 down: one line in place of each PR\'s wait', j([lines.length, lines[0].startsWith(`gate reviewer: ${BOT} reads as down: no review since ${iso(0)}`), lines.some((l) => l.startsWith('fix tries:'))]), j([1, true, false]));
let asks = readAsks(S);
t('#1365 and one repo-level ask for it', j(asks.map((x) => [x.settles, x.login])), j([['reviewer', BOT]]));
GR.reviewerStep(S, { waits: [wait(3, 'h3'), wait(4, 'h4'), wait(5)], now: at(90), repo: 'acme/widgets' });
asks = readAsks(S);
t('#1365 a third PR waiting replaces the ask, still one', j([asks.length, /3 ready PRs are waiting on it \(#3, #4, #5\)/.test(asks[0].text)]), j([1, true]));
lines = GR.reviewerStep(S, { seen: [{ login: BOT, pr: 3, head: 'h3', reviewedAtHead: true, last: iso(95) }], waits: [wait(4, 'h4'), wait(5)], now: at(96), repo: 'acme/widgets' });
t('#1365 its next review drops the ask, and the PRs still waiting are reported each as before',
  j([readAsks(S).length, lines.filter((l) => l.startsWith('fix tries:')).length, lines.some((l) => /^needs-you: ask \d+ dropped, as the gate reviewer it named reviews again/.test(l))]), j([0, 2, true]));
t('#1365 that review records its lag from when PR #3 began waiting', GR.readRecord(S).reviewers[BOT].lags.at(-1), 85);
// A clean review, its check green at the head, is the reviewer at work: it clears the ask, though another PR still waits.
const C = scratch('gate-reviewer-clean-');
GR.writeRecord(C, quiet);
GR.reviewerStep(C, { waits: [wait(3, 'h3'), wait(4, 'h4')], now: at(80) });
const cl = GR.reviewerStep(C, { seen: [{ login: BOT, pr: 3, head: 'h3', reviewedAtHead: true, last: iso(95) }], waits: [wait(4, 'h4')], now: at(96) });
t('#1365 a clean review of one PR clears the ask, and the other PR\'s wait is its own line again', j([readAsks(C).length, cl.filter((l) => l.startsWith('fix tries: PR #4')).length]), j([0, 1]));
// Each batch's pass replaces only its own waits: the standing batch's pass with nothing waiting leaves a
// named batch's waits, and the reviewer still reads as down from them.
let mb = GR.update({ reviewers: {} }, { waits: [wait(6)], now: at(0), batch: 'X-1' });
mb = GR.update(mb, { waits: [wait(7)], now: at(0) });
mb = GR.update(mb, { waits: [], now: at(90) });
t('#1365 a batch\'s pass with nothing waiting leaves another batch\'s waits', j(Object.keys(mb.reviewers[BOT].waiting)), j(['6']));
t('#1365 and the reviewer reads as down from them', j([GR.verdict(mb, BOT, at(90)).down, GR.verdict(mb, BOT, at(90)).prs]), j([true, [6]]));
mb = GR.update(mb, { waits: [], now: at(91), batch: 'X-1' });
t('#1365 that batch\'s own pass with nothing waiting clears them', j(mb.reviewers[BOT].waiting), '{}');
let ar = GR.update({ reviewers: {} }, { waits: [wait(8)], now: at(0), batch: 'X-2' });
ar = GR.update(ar, { waits: [], now: at(120), live: ['X-1'] });
t('#1365 a batch archived without a last pass has its waits dropped by the next pass, so the reviewer is not read as down from them', j([ar.reviewers[BOT].waiting, GR.verdict(ar, BOT, at(120)).down]), j([{}, false]));

// Seeded from GitHub: a record that starts while the reviewer is already down reads as down at once,
// from its last review. Its last review on the repo was at 09:46, and PR #9 left draft at 12:38; the
// record starts at 14:17.
const H = (h, m) => `2026-11-24T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const pr = (number, { created, ready = [], reviews = [], commit = null }) => ({ number, createdAt: created,
  commits: { nodes: commit ? [{ commit: { committedDate: commit } }] : [] },
  timelineItems: { nodes: ready.map((createdAt) => ({ createdAt })) },
  reviews: { nodes: reviews.map(([login, submittedAt]) => ({ author: { login }, submittedAt })) } });
const payload = { data: {
  recent: { nodes: [
    pr(9, { created: H(11, 0), ready: [H(12, 38)], commit: H(12, 30) }),
    pr(7, { created: H(8, 0), ready: [H(9, 0)], reviews: [[BOT, H(9, 6)], ['sam', H(9, 30)]] }),
    pr(8, { created: H(9, 37), reviews: [[BOT, H(9, 46)]] }),
  ] },
  repository: { p9: pr(9, { created: H(11, 0), ready: [H(12, 38)], commit: H(12, 30) }) } } };
const sd = GR.seedOf(payload, BOT);
t('#1370 a seed reads the reviewer\'s latest review on the repo', sd.last, H(9, 46));
t('#1370 its lags, from each PR\'s ready time (or its opening, never drafted) to its first review', j(sd.lags), j([6, 9]));
t('#1370 and when each waiting PR began waiting: the latest of its ready time, head commit and last review', sd.began[9], new Date(H(12, 38)).toISOString());
t('#1370 the query reads the recent PRs only when cold, and each waiting PR by number', j([/recent: search/.test(GR.seedQuery([9], true)), /recent: search/.test(GR.seedQuery([9], false)), /p9: pullRequest\(number:9\)/.test(GR.seedQuery([9], false))]), j([true, false, true]));
// A cold seed reads further pages until it has the reviewer's latest review: one no older than the
// oldest PR read (a review updates its PR), or none left to read.
const upd = (p, updatedAt) => ({ ...p, updatedAt });
const pages = [
  { nodes: [upd(pr(20, { created: H(13, 0) }), H(14, 0)), upd(pr(21, { created: H(13, 5) }), H(13, 50))], pageInfo: { hasNextPage: true, endCursor: 'c1' } },
  { nodes: [upd(pr(8, { created: H(9, 37), reviews: [[BOT, H(9, 46)]] }), H(9, 46))], pageInfo: { hasNextPage: true, endCursor: 'c2' } },
  { nodes: [upd(pr(5, { created: H(7, 0), reviews: [[BOT, H(7, 5)]] }), H(7, 5))], pageInfo: { hasNextPage: false } },
];
const gqlCalls = [];
const gql = (q, vars) => { gqlCalls.push(vars.after ?? null); return { data: { recent: pages[gqlCalls.length - 1], repository: {} } }; };
const rd = GR.seedRead(gql, 'acme/widgets', BOT, [], true);
t('#1370 a cold seed reads on past PRs updated since, and stops at the page holding its latest review', j([rd.last, gqlCalls]), j([H(9, 46), [null, 'c1']]));
const endless = () => ({ data: { recent: { nodes: [upd(pr(30, { created: H(13, 0) }), H(13, 30))], pageInfo: { hasNextPage: true, endCursor: 'x' } }, repository: {} } });
t('#1370 with its latest review past the pages it reads, its last review is unknown: no other activity stands in for it', GR.seedRead(endless, 'acme/widgets', BOT, [], true).last, null);
t('#1370 a page GitHub cannot answer is no seed', GR.seedRead(() => null, 'acme/widgets', BOT, [9], true), null);
// A PR showing only its latest reviews, none of the reviewer's, has its earlier ones read until one is.
const busy = () => { const b = { ...pr(40, { created: H(8, 0), reviews: [['sam', H(13, 10)], ['kim', H(13, 20)]] }), updatedAt: H(13, 20) }; b.reviews.pageInfo = { hasPreviousPage: true, startCursor: 'r1' }; return b; };
const older = { r1: { pageInfo: { hasPreviousPage: true, startCursor: 'r0' }, nodes: [{ author: { login: 'sam' }, submittedAt: H(11, 0) }] }, r0: { pageInfo: { hasPreviousPage: false }, nodes: [{ author: { login: BOT }, submittedAt: H(10, 15) }] } };
const bq = [];
const bgql = (q, vars) => {
  if (vars.before) { bq.push(vars.before); return { data: { repository: { pullRequest: { reviews: older[vars.before] } } } }; }
  return { data: { recent: { nodes: [busy()], pageInfo: { hasNextPage: false } }, repository: { p40: busy() } } };
};
const bs = GR.seedRead(bgql, 'acme/widgets', BOT, [40], true);
t('#1370 a PR whose reviews are cut off, none shown the reviewer\'s, has its earlier reviews read until one is', j([bs.last, bs.began[40], bq]), j([H(10, 15), new Date(H(10, 15)).toISOString(), ['r1', 'r0', 'r1', 'r0']]));
t('#1370 no other author\'s review stands in: earlier reviews that cannot be read are no seed', GR.seedRead((q, vars) => (vars.before ? null : bgql(q, vars)), 'acme/widgets', BOT, [40], true), null);
const stale = () => ({ data: { recent: { nodes: [upd(pr(31, { created: H(6, 0), reviews: [[BOT, H(6, 30)]] }), H(13, 40)), upd(pr(32, { created: H(13, 0) }), H(13, 30))], pageInfo: { hasNextPage: true, endCursor: 'x' } }, repository: {} } });
t('#1370 nor does an older review read before the pages ran out, as a later one may sit on a PR not read', GR.seedRead(stale, 'acme/widgets', BOT, [], true).last, null);
const SD = scratch('gate-reviewer-seed-');
const calls = [];
const seed = (login, prs, cold) => { calls.push([login, prs, cold]); return sd; };
const now = Date.parse(H(14, 17));
let sl = GR.reviewerStep(SD, { waits: [wait(9, 'h9')], now, repo: 'acme/widgets', seed });
t('#1370 a cold record seeded from GitHub reads as down on its first pass, since the last review', j([sl.some((l) => l.startsWith(`gate reviewer: ${BOT} reads as down: no review since ${H(9, 46)}`)), readAsks(SD).length]), j([true, 1]));
t('#1370 the waiting PR\'s wait starts when it left draft, not when the pass first saw it', GR.readRecord(SD).reviewers[BOT].waiting[9].since, new Date(H(12, 38)).toISOString());
GR.reviewerStep(SD, { waits: [wait(9, 'h9'), wait(10)], now: now + 60000, repo: 'acme/widgets', seed });
t('#1370 seeded once: the next pass reads GitHub only for a PR new to its waits', j(calls.map((c) => [c[1], c[2]])), j([[[9], true], [[10], false]]));
const SU = scratch('gate-reviewer-seedunknown-');
const ul = GR.reviewerStep(SU, { waits: [wait(9, 'h9')], now, seed: () => ({ last: null, lags: [], began: { 9: new Date(H(12, 38)).toISOString() } }) });
t('#1370 with its last review unknown, it still reads as down at once, from when the PR began waiting', ul.some((l) => l.startsWith(`gate reviewer: ${BOT} reads as down: no review since ${new Date(H(12, 38)).toISOString()}`)), true);
const SF = scratch('gate-reviewer-seedfail-');
const fl = GR.reviewerStep(SF, { waits: [wait(9, 'h9')], now, seed: () => null });
t('#1370 a seed GitHub cannot answer says so, and the record goes on what the passes see', j([fl.some((l) => /could not be read from GitHub/.test(l)), GR.readRecord(SF).reviewers[BOT].waiting[9].since, GR.readRecord(SF).reviewers[BOT].seeded ?? null]), j([true, new Date(now).toISOString(), null]));
// A record from before seeding (no `seeded`) is seeded on its next pass, moving an observed start back.
const OLD = scratch('gate-reviewer-old-');
GR.writeRecord(OLD, { reviewers: { [BOT]: { last: null, lags: [], waiting: { 9: { head: 'h9', since: H(14, 17) } } } } });
GR.reviewerStep(OLD, { waits: [wait(9, 'h9')], now: now + 120000, seed: () => sd });
t('#1370 a record written before seeding is seeded on its next pass, its wait moved back to when it began', j([GR.readRecord(OLD).reviewers[BOT].last, GR.readRecord(OLD).reviewers[BOT].waiting[9].since]), j([H(9, 46), new Date(H(12, 38)).toISOString()]));

const D = scratch('gate-reviewer-dry-');
GR.writeRecord(D, quiet);
GR.reviewerStep(D, { waits: [wait(3, 'h3'), wait(4, 'h4')], now: at(80), dry: true });
t('#1365 a dry run records no ask and leaves the record', j([readAsks(D).length, GR.readRecord(D).reviewers[BOT].waiting[3].since]), j([0, iso(10)]));
t('#1365 a repo with no record and nothing seen or waiting does nothing', j(GR.reviewerStep(join(S, 'none'), {})), '[]');

// Who runs it: §4 Infra and security owner, a People row no other script reads, read as get --json reads it.
{
  const { writeFileSync } = await import('node:fs');
  const C = join(scratch('gate-reviewer-cfg-'), 'config.md');
  writeFileSync(C, '## 4. People\n| Field | Value |\n|---|---|\n| Infra and security owner | `Sam Ops` |\n');
  process.env.DESK_CONFIG = C;
  const E = await import('../desk/bin/desk-env.mjs');
  t('#1365 the owner is read from §4 Infra and security owner', E.declaredValue('infra-owner'), 'Sam Ops');
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
