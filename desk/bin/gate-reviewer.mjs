// Whether the outside reviewer a §4 State check of kind external reads (its gate reviewer, a bot such
// as a review app) has stopped reviewing across the repo, rather than one PR waiting on it. Each pass's
// fix-tries step reads that reviewer's reviews on every ready PR waiting for it; the pass records here,
// per reviewer login, the latest review it saw, how long each of its recent reviews took after the PR
// first waited on it, and which PRs wait now, in <repo state>/gate-reviewer.json:
//   { reviewers: { <login>: { last: ISO|null, lags: [minutes], waiting: { <pr>: { head, since, batch? } } } } }
// Down is: ready PRs waiting on it, none reviewed for longer than its threshold (four times its recent
// median lag, at least an hour), and no review from it in that time. The pass then puts one repo-level
// ask to the person in place of each PR's wait, and drops it on the reviewer's next review.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, lock, unlock } from './dir-lock.mjs';
import { addAsk, settleReviewer } from './asks.mjs';

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
export function update(rec, { seen = [], waits = [], now = Date.now(), batch = null, live = null }) {
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
      r.waiting[w.pr] = { head: w.head, since: had && had.head === w.head ? had.since : iso(now), ...(batch ? { batch } : {}) };
    }
  }
  return out;
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
export function reviewerStep(state, { seen = [], waits = [], now = Date.now(), owner = null, repo = '', dry = false, batch = null, live = null } = {}) {
  if (!seen.length && !waits.length && !hasRecord(state)) return [];
  // The record is the repo's, shared by its batches' passes: read, changed and written under its lock.
  let held = null;
  if (!dry) {
    try { mkdirSync(state, { recursive: true }); lock(`${fileOf(state)}.lock`); held = `${fileOf(state)}.lock`; } catch (e) {
      return [...waits.map((w) => w.line), `gate reviewer: its record could not be locked (${firstLine(e)}), so whether it is down is not known this pass`];
    }
  }
  try { return step(state, { seen, waits, now, owner, repo, dry, batch, live }); } finally { if (held) unlock(held); }
}
function step(state, { seen, waits, now, owner, repo, dry, batch, live }) {
  const lines = [];
  let rec;
  try { rec = update(readRecord(state), { seen, waits, now, batch, live }); } catch (e) {
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
