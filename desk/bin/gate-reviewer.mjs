// Whether the outside reviewer a §4 State check of kind external reads (its gate reviewer, a bot such
// as a review app) has stopped reviewing across the repo, rather than one PR waiting on it. Each pass's
// fix-tries step reads that reviewer's reviews on every ready PR waiting for it; the pass records here,
// per reviewer login, the latest review it saw, how long each of its recent reviews took after the PR
// first waited on it, and which PRs wait now, in <repo state>/gate-reviewer.json:
//   { reviewers: { <login>: { last: ISO|null, lags: [minutes], seeded?: ISO, waiting: { <pr>: { head, since, batch? } } } } }
// A reviewer new to the record is seeded from GitHub once (seedOf): its latest review on the repo, its
// recent lags, and when each PR waiting on it began waiting, so an outage already under way when the
// record starts reads as down at once, from when it began.
// Down is: ready PRs waiting on it, none reviewed for longer than its threshold (four times its recent
// median lag, at least an hour), and no review from it in that time. The pass then puts one repo-level
// ask to the person in place of each PR's wait, and drops it on the reviewer's next review.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, lock, unlock } from './dir-lock.mjs';
import { addAsk, settleReviewer } from './asks.mjs';
import { loginIn } from './gate.mjs';

export const FLOOR_MIN = 60;
export const LAGS_KEPT = 20;
const fileOf = (state) => join(state, 'gate-reviewer.json');
const iso = (ms) => new Date(ms).toISOString();

// The record, { reviewers: {} } where there is none or it cannot be read.
export function readRecord(state) {
  try { const r = JSON.parse(readFileSync(fileOf(state), 'utf8')); return r?.reviewers ? r : { reviewers: {} }; } catch { return { reviewers: {} }; }
}
export const writeRecord = (state, rec) => writeJsonAtomic(fileOf(state), rec);
export const hasRecord = (state) => existsSync(fileOf(state));

// The minutes a reviewer may go without a review while PRs wait before it reads as down: four times
// the median of its recent lags, at least FLOOR_MIN.
export function threshold(lags = []) {
  const xs = lags.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return FLOOR_MIN;
  const mid = xs.length >> 1;
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return Math.max(FLOOR_MIN, 4 * median);
}

// The record after one pass of `batch` (each batch's pass reads only its own PRs, so it replaces only
// its own waits; null is the standing batch): `seen`, the reviewer reads it made ({ login, pr, head,
// reviewedAtHead, last: ISO of its latest review on that PR, or null }), and `waits`, its PRs waiting on
// a reviewer ({ login, pr, head }). A PR waiting at the same head keeps when it began; one reviewed at
// the head it waited at adds its lag. -> a new record
// `live`, the repo's named batches that still exist (null: not read): a wait of a batch no longer among
// them, archived without a last pass, goes, as no pass of it will clear it.
// `began`, { <login>: { <pr>: ISO } } from seedOf: when each PR began waiting, read from GitHub, which a
// wait new to the record starts from, and which moves an earlier start back.
export function update(rec, { seen = [], waits = [], now = Date.now(), batch = null, live = null, began = {} }) {
  const mine = (w) => (w.batch ?? null) === batch;
  const gone = (w) => live != null && w.batch != null && !live.includes(w.batch);
  const out = { reviewers: { ...rec.reviewers } };
  const of = (login) => (out.reviewers[login] = { last: null, lags: [], waiting: {}, ...out.reviewers[login] });
  for (const x of seen) {
    const r = of(x.login);
    if (x.last && (!r.last || Date.parse(x.last) > Date.parse(r.last))) r.last = x.last;
    const w = r.waiting?.[x.pr];
    if (x.reviewedAtHead && w && w.head === x.head && x.last) {
      const lag = (Date.parse(x.last) - Date.parse(w.since)) / 60000;
      if (Number.isFinite(lag) && lag >= 0) r.lags = [...(r.lags ?? []), Math.round(lag)].slice(-LAGS_KEPT);
    }
  }
  for (const w of waits) of(w.login);
  for (const login of Object.keys(out.reviewers)) {
    const r = out.reviewers[login];
    const before = r.waiting ?? {};
    // Another batch's waits stay as its own last pass left them.
    r.waiting = Object.fromEntries(Object.entries(before).filter(([, w]) => !mine(w) && !gone(w)));
    for (const w of waits.filter((x) => x.login === login)) {
      const had = before[w.pr];
      const b = began[login]?.[w.pr] && Date.parse(began[login][w.pr]) <= now ? began[login][w.pr] : null;
      const since = had && had.head === w.head ? (b && Date.parse(b) < Date.parse(had.since) ? b : had.since) : b ?? iso(now);
      r.waiting[w.pr] = { head: w.head, since, ...(batch ? { batch } : {}) };
    }
  }
  return out;
}

// Seeding from GitHub. A cold seed reads the repo's most recently updated PRs, SEED_PRS a page, until
// it has the reviewer's latest review (a review updates its PR, so one no older than the oldest PR read
// is the latest), or SEED_PAGES pages.
export const SEED_PRS = 50;
export const SEED_PAGES = 4;
const PR_FIELDS = 'number createdAt updatedAt commits(last:1){nodes{commit{committedDate}}} timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT],last:20){nodes{... on ReadyForReviewEvent{createdAt}}} reviews(last:50){nodes{author{login} submittedAt}}';
// The GraphQL query for a seed ($owner, $name; with `cold` $q, seedSearch's, and with `after` $after):
// each of `prs`, and with `cold` a page of the repo's most recently updated PRs too.
export function seedQuery(prs, cold, after = false) {
  const each = prs.map((n) => `p${Number(n)}: pullRequest(number:${Number(n)}){${PR_FIELDS}}`).join(' ');
  const recent = cold ? `recent: search(query:$q,type:ISSUE,first:${SEED_PRS}${after ? ',after:$after' : ''}){pageInfo{hasNextPage endCursor} nodes{... on PullRequest{${PR_FIELDS}}}} ` : '';
  return `query($owner:String!,$name:String!${cold ? ',$q:String!' : ''}${cold && after ? ',$after:String!' : ''}){${recent}repository(owner:$owner,name:$name){${each || 'id'}}}`;
}
// A seed for `login` in `repo` read through `gql(query, vars)` (the payload, or null unread): seedOf's
// result over every page read, or null where a page could not be read.
export function seedRead(gql, repo, login, prs, cold) {
  const nodes = [];
  let named = null;
  let after = null;
  let complete = !cold;
  for (let page = 0; page < (cold ? SEED_PAGES : 1); page++) {
    const p = gql(seedQuery(page ? [] : prs, cold, !!after), { ...(cold ? { q: seedSearch(repo) } : {}), ...(after ? { after } : {}) });
    if (!p?.data) return null;
    if (!page) named = p.data.repository ?? {};
    if (!cold) break;
    const r = p.data.recent ?? {};
    nodes.push(...(r.nodes ?? []).filter((n) => n?.number));
    const floor = nodes.map((n) => n.updatedAt).filter(Boolean).sort()[0];
    const last = seedOf({ data: { recent: { nodes } } }, login).last;
    if (!r.pageInfo?.hasNextPage || (last && floor && Date.parse(last) >= Date.parse(floor))) { complete = true; break; }
    after = r.pageInfo.endCursor;
  }
  return seedOf({ data: { recent: { nodes, complete }, repository: named } }, login);
}
export const seedSearch = (repo) => `repo:${repo} is:pr sort:updated-desc`;

// What a seed query's payload says of `login`: { last (its latest review read), lags (minutes from each
// recent PR's ready time to its first review after it, oldest first), began ({ <pr>: ISO }, when each
// PR queried by number began waiting: the latest of its ready time, its head commit, and that
// reviewer's last review on it) }.
export function seedOf(payload, login) {
  const d = payload?.data ?? {};
  const reviews = (p) => (p.reviews?.nodes ?? []).filter((r) => r?.submittedAt && loginIn(r.author?.login, login)).map((r) => r.submittedAt).sort();
  const readies = (p) => (p.timelineItems?.nodes ?? []).map((e) => e?.createdAt).filter(Boolean).sort();
  const recent = (d.recent?.nodes ?? []).filter((p) => p?.number);
  const named = Object.entries(d.repository ?? {}).filter(([k, p]) => /^p\d+$/.test(k) && p?.number).map(([, p]) => p);
  // Pages read without reaching its latest review: none came after the oldest PR read was last updated,
  // so that is when it last reviewed at the latest, which understates the quiet rather than overstating it.
  const found = [...recent, ...named].flatMap(reviews).sort().at(-1) ?? null;
  const floor = d.recent?.complete === false ? recent.map((p) => p.updatedAt).filter(Boolean).sort()[0] ?? null : null;
  const last = [found, floor].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null;
  const lags = [];
  for (const p of recent) {
    const first = reviews(p)[0];
    if (!first) continue;
    const ready = readies(p).filter((t) => t <= first).at(-1) ?? p.createdAt;
    const lag = (Date.parse(first) - Date.parse(ready)) / 60000;
    if (Number.isFinite(lag) && lag >= 0) lags.push({ at: first, lag: Math.round(lag) });
  }
  const began = {};
  for (const p of named) {
    const ts = [readies(p).at(-1) ?? p.createdAt, p.commits?.nodes?.[0]?.commit?.committedDate, reviews(p).at(-1)].map((t) => Date.parse(t)).filter(Number.isFinite);
    if (ts.length) began[p.number] = iso(Math.max(...ts));
  }
  return { last, lags: lags.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-LAGS_KEPT).map((x) => x.lag), began };
}

// The record with each reviewer that PRs wait on seeded where it needs it, through `seed(login, prs,
// cold)` (seedOf's result, or null unread): one not yet seeded is read cold, with every PR waiting on it;
// one seeded already, only for the PRs new to its waits. -> { rec, began, lines }
export function seeded(rec, waits, seed, now = Date.now()) {
  const out = { reviewers: { ...rec.reviewers } };
  const began = {};
  const lines = [];
  for (const login of [...new Set(waits.map((w) => w.login))]) {
    const r = out.reviewers[login];
    const cold = !r?.seeded;
    const prs = waits.filter((w) => w.login === login && (cold || !r.waiting?.[w.pr])).map((w) => w.pr);
    if (!cold && !prs.length) continue;
    let s = null;
    try { s = seed(login, prs, cold); } catch { s = null; }
    if (!s) { lines.push(`gate reviewer: ${login}'s reviews could not be read from GitHub, so its record goes on what the passes saw`); continue; }
    began[login] = s.began ?? {};
    if (!cold) continue;
    const last = [r?.last, s.last].filter(Boolean).sort().at(-1) ?? null;
    out.reviewers[login] = { last, lags: r?.lags?.length ? r.lags : s.lags ?? [], waiting: r?.waiting ?? {}, seeded: iso(now) };
  }
  return { rec: out, began, lines };
}

// Whether `login` reads as down: { down, since (its last review, else when the oldest wait began),
// prs (the PRs waiting, oldest first), threshold (minutes) }.
export function verdict(rec, login, now = Date.now()) {
  const r = rec.reviewers?.[login];
  const waiting = Object.entries(r?.waiting ?? {}).map(([pr, w]) => ({ pr: Number(pr), since: w.since })).sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const t = threshold(r?.lags);
  if (!waiting.length) return { down: false, since: r?.last ?? null, prs: [], threshold: t };
  const oldest = Date.parse(waiting[0].since);
  const quiet = r.last ? Math.min(now - Date.parse(r.last), now - oldest) : now - oldest;
  return { down: quiet > t * 60000, since: r.last ?? waiting[0].since, lastSeen: !!r.last, prs: waiting.map((w) => w.pr), threshold: t };
}

// The ask for a reviewer that reads as down, and a message the person can send as it is. `owner`: who
// runs it, from §4 Infra and security owner, or null. -> { text, draft }
export function downAsk(login, v, { repo, owner = null } = {}) {
  const prs = v.prs.map((n) => `#${n}`).join(', ');
  const n = v.prs.length;
  const when = v.lastSeen ? `since ${v.since}` : `since ${v.since}, when the oldest PR began waiting on it`;
  const draft = `${owner ? `Hi ${owner}, ` : ''}${login} has posted no review on ${repo} ${when}, and ${n} ready PR${n === 1 ? ' is' : 's are'} waiting on it (${prs}). It usually reviews well within ${Math.round(v.threshold / 4)} minutes. Could you check whether it is running?`;
  const text = `gate reviewer down: ${login} has posted no review ${when} (over ${v.threshold} minutes, four times its usual wait), and ${n} ready PR${n === 1 ? ' is' : 's are'} waiting on it (${prs}). ${owner ? `${owner} runs it (§4 Infra and security owner): send` : 'Send whoever runs it'} this as it is: "${draft}". This clears itself on ${login}'s next review`;
  return { text, draft };
}

// One pass's step, after its fix tries: the record updated with `seen` and `waits`, each reviewer that
// reads as down put to the person as one ask in `state` (the repo's), replacing the last pass's for it,
// in place of each PR's wait line, and the ask of one that no longer reads as down (its next review
// seen, or nothing waiting on it) dropped. A dry run writes nothing. -> the pass's report lines
// `seed`: seeded's reader, or null to read nothing from GitHub.
export function reviewerStep(state, { seen = [], waits = [], now = Date.now(), owner = null, repo = '', dry = false, batch = null, live = null, seed = null } = {}) {
  if (!seen.length && !waits.length && !hasRecord(state)) return [];
  // The record is the repo's, shared by its batches' passes: read, changed and written under its lock.
  let held = null;
  if (!dry) {
    try { mkdirSync(state, { recursive: true }); lock(`${fileOf(state)}.lock`); held = `${fileOf(state)}.lock`; } catch (e) {
      return [...waits.map((w) => w.line), `gate reviewer: its record could not be locked (${firstLine(e)}), so whether it is down is not known this pass`];
    }
  }
  try { return step(state, { seen, waits, now, owner, repo, dry, batch, live, seed }); } finally { if (held) unlock(held); }
}
function step(state, { seen, waits, now, owner, repo, dry, batch, live, seed }) {
  const lines = [];
  let rec;
  try {
    const sd = seed ? seeded(readRecord(state), waits, seed, now) : { rec: readRecord(state), began: {}, lines: [] };
    lines.push(...sd.lines);
    rec = update(sd.rec, { seen, waits, now, batch, live, began: sd.began });
  } catch (e) {
    return [...waits.map((w) => w.line), `gate reviewer: its record could not be read (${firstLine(e)}), so whether it is down is not known this pass`];
  }
  const down = new Set();
  for (const login of Object.keys(rec.reviewers)) {
    const v = verdict(rec, login, now);
    if (!v.down) continue;
    down.add(login);
    const { text } = downAsk(login, v, { repo, owner });
    lines.push(`gate reviewer: ${login} reads as down: no review since ${v.since}, over its ${v.threshold}-minute threshold, while ${v.prs.length} ready PR(s) wait on it (${v.prs.map((n) => `#${n}`).join(', ')}): on the needs-you list in place of each PR's wait`);
    if (dry) continue;
    try {
      // The last pass's ask for it goes where this one says something else (more PRs waiting).
      settleReviewer(state, (a) => a.login === login && a.text !== text);
      addAsk(state, text, now, { settles: 'reviewer', login });
    } catch (e) { lines.push(`gate reviewer: the ask for ${login} could not be recorded (${firstLine(e)})`); }
  }
  for (const w of waits) if (!down.has(w.login)) lines.push(w.line);
  if (dry) return lines;
  try {
    for (const a of settleReviewer(state, (x) => !down.has(x.login))) lines.push(`needs-you: ask ${a.id} dropped, as the gate reviewer it named reviews again or nothing waits on it`);
  } catch (e) { lines.push(`gate reviewer: its asks could not be rechecked (${firstLine(e)})`); }
  try { writeRecord(state, rec); } catch (e) { lines.push(`gate reviewer: its record could not be written (${firstLine(e)})`); }
  return lines;
}
const firstLine = (e) => String(e?.message ?? e).split('\n')[0];
