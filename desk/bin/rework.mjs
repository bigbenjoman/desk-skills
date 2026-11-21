// A ticket's rework: what its starts after the first cost, as a share of everything it cost, and why
// each of those starts happened. A start is one `claude -p` launch: a fresh session's round log, or a
// resume of the session inside it. Its cost is what claude -p reported for it (total_cost_usd, the
// split pricing worker-cost.mjs reads) plus the preflight before it, never a token sum, so a ticket's
// starts add up to its row's `cost`.
//
// A session after a handoff (AUTOPILOT_HANDOFF) carries on the start it follows and takes its cause:
// the first attempt's Stage 4b and Stage 7 sessions are not rework. Any other later start has one cause:
//   review round  a fix try for a review, its verdict, its feedback or its gaps
//   CI red        a fix try for red checks
//   conflict      a fix try for a conflict with the base
//   base fix      a fix try that syncs the branch with a base that moved (a check build behind it, a
//                 migration it renumbered)
//   killed        a resume, or a fresh round, after a worker that was killed, stopped or wedged
//   usage limit   a resume, or a fresh round, after a worker that ended at a usage limit
//   other         anything else: a park answered, a capture or protected-files try, an instruction
// with the failure class (failure-class.mjs) of the fix try or park beside it.
import { readLogFile, workerMarkers } from './harvest.mjs';
import { usageLimit } from './usage-limit.mjs';
import { parkClass, fixClass } from './failure-class.mjs';
import { logRound } from './worker-cost.mjs';

const CAUSES = Object.freeze(['review round', 'CI red', 'conflict', 'base fix', 'killed', 'usage limit', 'other']);
// A fix try's kind (fix-tries.mjs) as the cause of the start it sent.
const KIND_CAUSE = Object.freeze({
  review: 'review round', rereview: 'review round', feedback: 'review round', gaps: 'review round',
  checks: 'CI red', conflict: 'conflict', sync: 'base fix', renames: 'base fix',
});
const ENDS = new Set(['AUTOPILOT_PARK', 'AUTOPILOT_DONE', 'AUTOPILOT_HANDOFF']);

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
const deskLine = (d) => typeof d?.type === 'string' && d.type.startsWith('desk_');
const isInit = (d) => d?.type === 'system' && d.subtype === 'init';

// One log's starts, in order: a new start opens at each init event after the first, with the preflight
// and start lines written just before it. Each start: { at, stage, ran, preflight (the dollars its
// preflights reported), result (its last result's total_cost_usd, or null with none), end ({ kind, value } of the last park,
// done or handoff marker it printed, read as harvest reads markers, or null), limited (it was at a usage
// limit when it ended, as usage-limit.mjs reads one), text }.
function logStarts(text) {
  const groups = [];
  let cur = { lines: [], init: false };
  let tail = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    const d = parse(line);
    if (isInit(d) && cur.init) {
      groups.push(cur);
      cur = { lines: cur.lines.splice(tail), init: false };
      tail = 0;
    }
    if (isInit(d)) cur.init = true;
    cur.lines.push({ line, d });
    if (!deskLine(d)) tail = cur.lines.length;
  }
  groups.push(cur);
  return groups.map(({ lines }) => {
    const s = { at: null, stage: null, ran: false, preflight: 0, result: null, end: null, limited: false, text: lines.map((l) => l.line).join('\n') };
    for (const { d } of lines) {
      if (!deskLine(d)) s.ran = true;
      if (d?.type === 'desk_preflight') {
        if (typeof d.total_cost_usd === 'number') s.preflight += d.total_cost_usd;
        s.at ??= d.at ?? null;
      }
      if (d?.type === 'desk_spawn') { s.at = d.at ?? s.at; s.stage = d.stage ?? null; }
      if (d?.type === 'result') s.result = Number(d.total_cost_usd) || 0;
    }
    for (const [k, v] of workerMarkers(s.text)) if (ENDS.has(k)) s.end = { kind: k, value: String(v).trim() };
    const u = usageLimit(s.text);
    s.limited = u.last?.kind === 'limit' && !u.last.resumed;
    return s;
  });
}

// Each start's own cost inside one log. A resumed session's result events are running totals for the
// session (worker-cost.mjs logUsage reads the last as the log's cost), so a start costs the rise since
// the start before it. A log whose totals fall is not split: its last total goes to its first start.
// A total after a start that left none also holds that start's spend, so it is `unsplit`: what the
// later start cost alone is not known.
function splitCosts(starts) {
  const ran = starts.filter((s) => s.ran);
  const totals = ran.map((s) => s.result).filter((v) => v != null);
  const rising = totals.every((v, i) => i === 0 || v >= totals[i - 1]);
  let before = 0;
  let lost = false;
  for (const s of ran) {
    if (!rising) { s.run = s === ran[0] ? totals.at(-1) ?? 0 : 0; continue; }
    s.run = s.result == null ? 0 : s.result - before;
    s.unsplit = s.result != null && lost;
    if (s.result == null) lost = true;
    else before = s.result;
  }
}

// Why start `s` happened, given the start before it and the ticket's fix tries not yet matched to a
// start. -> { cause, class } or { handoff: true }.
function causeOf(s, prev, sameLog, t, unused) {
  if (sameLog || s.stage === 'resume') {
    return prev.limited ? { cause: 'usage limit', class: 'quota' } : { cause: 'killed', class: 'runner or resource' };
  }
  if (prev.end?.kind === 'AUTOPILOT_HANDOFF') return { handoff: true };
  const after = prev.at ? Date.parse(prev.at) : -Infinity;
  const upTo = s.at ? Date.parse(s.at) : Infinity;
  const fix = unused.filter((f) => { const at = Date.parse(f.at); return at > after && at <= upTo; }).at(-1);
  if (fix) {
    unused.splice(unused.indexOf(fix), 1);
    return { cause: KIND_CAUSE[fix.kind] ?? 'other', class: fix.class ?? fixClass(fix, t).class, kind: fix.kind ?? null };
  }
  if (prev.limited) return { cause: 'usage limit', class: 'quota' };
  if (prev.end?.kind === 'AUTOPILOT_PARK') {
    const c = parkClass(prev.end.value).class;
    return { cause: c === 'quota' ? 'usage limit' : c === 'runner or resource' ? 'killed' : 'other', class: c };
  }
  if (prev.result == null) return { cause: 'killed', class: 'runner or resource' };
  return { cause: 'other', class: null };
}

// A ticket's rework from its round logs (the files ticketFacts read, in any order) and its queue entry
// `t` (its fix_tries). -> { share, cost, by_cause, by_class, starts }: `cost` is the rework's dollars,
// `by_cause` and `by_class` split them, and `starts` lists every start after the first with its cause,
// class, cost (null where it left no result event) and whether it followed a handoff. `share` is the
// rework over the ticket's whole cost: 0 with no start after the first, null when a start's cost was
// not recorded, and over `total` where the row's cost is passed.
export function ticketRework(logs, t = {}, total = null) {
  const starts = [];
  let pending = 0;
  for (const file of [...logs].sort((a, b) => logRound(a) - logRound(b))) {
    let text = '';
    try { text = readLogFile(file); } catch { /* unreadable: no starts */ }
    const mine = logStarts(text);
    splitCosts(mine);
    const ran = mine.filter((s) => s.ran);
    const pre = mine.reduce((n, s) => n + s.preflight, 0);
    // A log of preflights alone was a spawn refused: its preflights belong to the start that follows.
    if (!ran.length) { pending += pre; continue; }
    ran.forEach((s, i) => {
      const before = i === 0 ? mine.slice(0, mine.indexOf(s)).reduce((n, x) => n + x.preflight, 0) + pending : 0;
      if (i === 0) pending = 0;
      starts.push({ ...s, first: i === 0, cost: s.run + s.preflight + before, known: s.result != null && !s.unsplit });
    });
  }
  if (starts.length && pending) starts.at(-1).cost += pending;
  const unused = [...(t.fix_tries ?? [])].filter((f) => f && !Number.isNaN(Date.parse(f.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const later = [];
  let carried = null;
  starts.forEach((s, i) => {
    if (i === 0) return;
    const c = causeOf(s, starts[i - 1], !s.first, t, unused);
    if (c.handoff) {
      if (carried) later.push({ at: s.at, cause: carried.cause, class: carried.class, cost: s.known ? s.cost : null, handoff: true });
      return;
    }
    carried = c;
    later.push({ at: s.at, cause: c.cause, class: c.class, cost: s.known ? s.cost : null, handoff: false, ...(c.kind ? { kind: c.kind } : {}) });
  });
  const by = (key) => {
    const out = {};
    for (const x of later) if (x.cost != null) out[x[key] ?? 'none'] = (out[x[key] ?? 'none'] ?? 0) + x.cost;
    return out;
  };
  const cost = later.reduce((n, x) => n + (x.cost ?? 0), 0);
  const whole = total ?? starts.reduce((n, s) => n + s.cost, 0);
  const share = !later.length ? 0 : later.some((x) => x.cost == null) ? null : whole > 0 ? cost / whole : 0;
  return { share, cost, by_cause: by('cause'), by_class: by('class'), starts: later };
}

// The rework over many per-ticket rows (phase0-report.mjs ticketRows), weighted by cost: the rework
// dollars over every dollar of the tickets whose cost and rework were both recorded. A ticket whose
// cost was not fully recorded, or whose rework was not (a row written before rework was, a start with
// no result event), is counted apart in `unknown` and in neither figure.
// -> { tickets, known, unknown: [key], cost, rework_cost, share, by_cause: { cause: { cost, share } }, by_class }
export function reworkSummary(rows) {
  const known = rows.filter((r) => r.cost_complete === true && Number.isFinite(r.cost) && typeof r.rework_share === 'number');
  const cost = known.reduce((n, r) => n + r.cost, 0);
  const sum = (key) => {
    const out = {};
    for (const r of known) for (const [k, v] of Object.entries(r[key] ?? {})) out[k] = (out[k] ?? 0) + v;
    return out;
  };
  const causes = sum('rework_by_cause');
  const reworkCost = known.reduce((n, r) => n + (r.rework_cost ?? 0), 0);
  return {
    tickets: rows.length, known: known.length, unknown: rows.filter((r) => !known.includes(r)).map((r) => r.key),
    cost, rework_cost: reworkCost, share: cost > 0 ? reworkCost / cost : known.length ? 0 : null,
    by_cause: Object.fromEntries(CAUSES.filter((c) => causes[c]).map((c) => [c, { cost: causes[c], share: cost > 0 ? causes[c] / cost : 0 }])),
    by_class: sum('rework_by_class'),
  };
}
