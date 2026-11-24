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
