// A merged PR's time from opening to merge, split by stage, read from its timeline on GitHub once it
// has merged: desk's own review (from its worker's Stage 4b session starting, as the batch's spawn
// records have it, or the PR opening where no worker ran one, to its clean verdict, with the rounds
// posted on the PR each from the last one),
// desk's clean verdict to undraft, undraft to the outside gate reviewer's first review (the wait) and
// on to its last (the re-reviews), and the last required check green to the merge. Each merged PR's
// stages are one line of <state>/merge-stages.jsonl, and one merge_stages event in the ticket ledger
// where the ledger lever is on:
// (or { key, pr, unmerged: true, recorded } for a ticket's PR GitHub reads as not merged, so it is not read again)
//   { key, pr, opened, merged, recorded, desk: { minutes, local: { start, rounds } | null,
//     rounds: [{ start, end, minutes, clean }] },
//     undraft, external: { login, wait, rereviews, rounds, outage } | null, merge }  (minutes, or null)
// A wait for the outside reviewer that overlaps an outage gate-reviewer.mjs recorded for it is marked
// `outage` and left out of the medians, so a reviewer being down does not read as a slow stage.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { quantile } from './quantile.mjs';
import { loginIn } from './gate.mjs';
import { parseVerdict, verdictAt } from './undraft.mjs';

export const STAGES = Object.freeze(['desk', 'undraft', 'external_wait', 'external_rereviews', 'merge']);
export const STAGE_NAMES = Object.freeze({ desk: 'desk review', undraft: 'undraft', external_wait: 'external review wait', external_rereviews: 'external re-reviews', merge: 'merge' });
// How many merged PRs a pass reads from GitHub at most.
export const PER_PASS = 3;
const fileOf = (state) => join(state, 'merge-stages.jsonl');
const ms = (iso) => Date.parse(iso ?? '');
const mins = (from, to) => {
  const m = (ms(to) - ms(from)) / 60000;
  return Number.isFinite(m) && m >= 0 ? Math.round(m * 10) / 10 : null;
};

// The GraphQL query for PR `n`'s timeline ($owner, $name).
export const stagesQuery = (n) => `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${Number(n)}){number createdAt mergedAt timelineItems(itemTypes:[READY_FOR_REVIEW_EVENT],last:20){nodes{... on ReadyForReviewEvent{createdAt}}} reviews(last:100){nodes{author{login} submittedAt body commit{oid}}} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{__typename ... on CheckRun{name completedAt conclusion} ... on StatusContext{context createdAt state}}}}}}}}}}`;

// Whether a review's body is a clean desk-review verdict under the §4 Clean review verdict `clean`:
// true, false, or null for a body with no verdict marker.
function cleanOf(body, clean) {
  const v = parseVerdict(body ?? '');
  return v ? verdictAt(v, v.sha, clean).clean : null;
}

// The overlap of [from, to] with any of `login`'s outages ({ login, from, to: ISO|null }).
const inOutage = (outages, login, from, to) => (outages ?? []).some((o) => o?.login === login
  && ms(o.from) < (ms(to) || Infinity) && (o.to == null || ms(o.to) > ms(from)));

// One merged PR's stages from a stagesQuery payload. `desk`: desk's verdict logins (loginIn's form);
// `external`: the outside reviewer's login, or null where no §4 State check of kind external names one;
// `clean`: §4 Clean review verdict; `outages`: gate-reviewer.mjs's. -> the record (without key and
// recorded), or null for a PR not merged.
// `local`: localReview's { starts, rounds } for the ticket, the review desk ran before the PR opened.
// `required`: §4 Required checks, the checks whose last passing run starts the merge stage (with none,
// every check counts).
export function stagesOf(payload, { desk, external = null, clean, outages = [], local = null, required = [] }) {
  const p = payload?.data?.repository?.pullRequest;
  if (!p?.mergedAt) return null;
  const opened = p.createdAt, merged = p.mergedAt;
  // The worker's last Stage 4b session to start before the PR opened is where desk's review began.
  const localStart = (local?.starts ?? []).filter((t) => ms(t) <= ms(opened)).sort().at(-1) ?? null;
  const reviewFrom = localStart ?? opened;
  const ready = (p.timelineItems?.nodes ?? []).map((e) => e?.createdAt).filter((t) => t && ms(t) <= ms(merged)).sort().at(-1) ?? null;
  const reviews = (p.reviews?.nodes ?? []).filter((r) => r?.submittedAt).sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt));
  // Desk's rounds: its reviews up to the undraft (or the merge, for a PR never in draft).
  const mine = reviews.filter((r) => loginIn(r.author?.login, desk) && ms(r.submittedAt) <= ms(ready ?? merged));
  const rounds = mine.map((r, i) => {
    const start = i ? mine[i - 1].submittedAt : reviewFrom;
    return { start, end: r.submittedAt, minutes: mins(start, r.submittedAt), clean: cleanOf(r.body, clean) };
  });
  const verdict = [...rounds].reverse().find((r) => r.clean) ?? rounds.at(-1) ?? null;
  const theirs = external && ready ? reviews.filter((r) => loginIn(r.author?.login, external) && ms(r.submittedAt) >= ms(ready) && ms(r.submittedAt) <= ms(merged)) : [];
  const ext = external && ready ? {
    login: external,
    wait: theirs.length ? mins(ready, theirs[0].submittedAt) : null,
    rereviews: theirs.length ? mins(theirs[0].submittedAt, theirs.at(-1).submittedAt) : null,
    rounds: theirs.length,
    outage: inOutage(outages, external, ready, theirs[0]?.submittedAt ?? merged),
  } : null;
  // The last required green: the newest of each required check's latest passing run on the head that
  // merged (success or skipped, as the gate counts one; neutral does not pass a required check).
  const want = (required ?? []).filter((x) => x && !/^none$/i.test(x));
  const latest = new Map();
  for (const c of p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []) {
    const name = c?.__typename === 'StatusContext' ? c.context : c?.name;
    const at = c?.__typename === 'StatusContext' ? c.createdAt : c?.completedAt;
    const ok = c?.__typename === 'StatusContext' ? c.state === 'SUCCESS' : ['SUCCESS', 'SKIPPED'].includes(c?.conclusion);
    if (!name || !ok || !at || ms(at) > ms(merged) || (want.length && !want.includes(name))) continue;
    if (!latest.has(name) || ms(at) > ms(latest.get(name))) latest.set(name, at);
  }
  const green = want.length && want.some((n) => !latest.has(n)) ? null : [...latest.values()].sort().at(-1) ?? null;
  return {
    pr: p.number, opened, merged,
    desk: { minutes: verdict ? mins(reviewFrom, verdict.end) : null, local: localStart ? { start: localStart, rounds: local?.rounds ?? null } : null, rounds },
    undraft: ready && verdict ? mins(verdict.end, ready) : null,
    external: ext,
    merge: green ? mins(green, merged) : null,
  };
}

// What a batch's state records of the review desk ran on ticket `key` before its PR: { starts (each
// Stage 4b session's start, from <state>/workers/<key>.runs.jsonl), rounds (its self-review rounds,
// from <key>.findings.jsonl, or null with none recorded) }.
export function localReview(state, key) {
  const lines = (f) => { try { return readFileSync(join(state, 'workers', f), 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };
  const starts = lines(`${key}.runs.jsonl`).filter((r) => String(r?.stage) === '4b' && r.at).map((r) => r.at);
  const self = lines(`${key}.findings.jsonl`).filter((r) => r?.reviewer === 'self');
  return { starts, rounds: self.length ? new Set(self.map((r) => `${r.head}:${r.round}`)).size : null };
}

// Every recorded line, the latest per PR. A line that does not read is skipped.
export function readStages(state) {
  let text = '';
  try { text = readFileSync(fileOf(state), 'utf8'); } catch { return []; }
  const byPr = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e?.pr != null) byPr.set(Number(e.pr), e); } catch { /* skipped */ }
  }
  return [...byPr.values()];
}
export function recordStages(state, entry) {
  mkdirSync(dirname(fileOf(state)), { recursive: true });
  appendFileSync(fileOf(state), `${JSON.stringify(entry)}\n`);
}

// The merged tickets of `tickets` (queue tickets) whose PR has no line recorded, oldest merge first:
// { key, pr }. A pass reads PER_PASS of them at most, moving past any it cannot read.
export function due(tickets, recorded) {
  const have = new Set(recorded.map((e) => Number(e.pr)));
  return Object.entries(tickets ?? {})
    .map(([key, t]) => ({ key, pr: Number(t?.merge?.pr ?? t?.result?.pr), at: t?.merged_at }))
    .filter((x) => x.at && Number.isInteger(x.pr) && !have.has(x.pr))
    .sort((a, b) => ms(a.at) - ms(b.at)).map(({ key, pr }) => ({ key, pr }));
}

// Each stage's { n, median, p75 } in minutes over `entries`, and how many external waits were left
// out as inside a reviewer outage.
export function summary(all) {
  // A PR read as never merged (`unmerged`, a ticket's PR that is not the one that merged) has no stages.
  const entries = all.filter((e) => !e.unmerged);
  const vals = { desk: [], undraft: [], external_wait: [], external_rereviews: [], merge: [] };
  let outage = 0;
  for (const e of entries) {
    vals.desk.push(e.desk?.minutes);
    vals.undraft.push(e.undraft);
    vals.merge.push(e.merge);
    // An outage is over the wait for the reviewer's first review; the re-reviews after it still count.
    if (e.external?.outage) outage += 1; else vals.external_wait.push(e.external?.wait);
    vals.external_rereviews.push(e.external?.rereviews);
  }
  const stages = Object.fromEntries(STAGES.map((s) => {
    const xs = vals[s].filter(Number.isFinite);
    return [s, { n: xs.length, median: quantile(xs, 0.5), p75: quantile(xs, 0.75) }];
  }));
  return { prs: entries.length, stages, outage };
}

export const fmt = (m) => (m == null ? '—' : m >= 90 ? `${Math.round(m / 6) / 10}h` : `${Math.round(m)}m`);

// The summary as one line, or null with nothing recorded.
export function stagesLine(s) {
  if (!s?.prs) return null;
  const parts = STAGES.filter((k) => s.stages[k].n).map((k) => `${STAGE_NAMES[k]} ${fmt(s.stages[k].median)} / ${fmt(s.stages[k].p75)}`);
  const out = s.outage ? `; ${s.outage} external wait${s.outage === 1 ? '' : 's'} inside a reviewer outage left out` : '';
  return `merge time by stage over ${s.prs} merged PR${s.prs === 1 ? '' : 's'} (median / p75): ${parts.join(' · ') || 'no stage read yet'}${out}`;
}

// One pass's step: the merged tickets of `tickets` with no line yet, oldest first, PER_PASS read through
// `gql(query)` (a payload, or null unread), each recorded in `state`'s merge-stages.jsonl. `ledger(key,
// pr, entry)`, where the ledger lever is on, appends its event under an id fixed by the PR and throws on
// a failed write: the PR is then left due, so a retry writes it once. An unread PR is tried again next
// pass, after the rest; one read as never merged is marked and never read again. `ctx`: stagesOf's
// options, and `local(key)` for localReview. -> the pass's report lines.
export function stagesStep(state, { tickets, gql, ledger = null, ctx = {}, local = () => null, now = new Date().toISOString() }) {
  const lines = [];
  let reads = 0;
  for (const { key, pr } of due(tickets, readStages(state))) {
    if (reads >= PER_PASS) break;
    reads += 1;
    let payload = null;
    try { payload = gql(stagesQuery(pr)); } catch { payload = null; }
    if (!payload?.data) { lines.push(`merge stages: PR #${pr} (${key}) could not be read from GitHub; the next pass tries again`); continue; }
    const st = stagesOf(payload, { ...ctx, local: local(key) });
    const entry = st ? { key, ...st, pr, recorded: now } : { key, pr, unmerged: true, recorded: now };
    if (ledger && st) {
      try { ledger(key, pr, entry); } catch (e) { lines.push(`merge stages: PR #${pr} (${key}) could not be added to the ticket ledger (${String(e?.message ?? e).split('\n')[0]}); the next pass tries again`); continue; }
    }
    try { recordStages(state, entry); } catch (e) { lines.push(`merge stages: PR #${pr} (${key}) could not be recorded (${String(e?.message ?? e).split('\n')[0]})`); }
  }
  return lines;
}
