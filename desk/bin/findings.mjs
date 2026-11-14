// The review findings log: one JSON line per review round in <state>/workers/<KEY>.findings.jsonl,
// for the levers evaluation to compare review quality between arms without reading any prose:
//
//   {"ticket", "round", "reviewer": "self"|"pr"|"audit", "head", "p0", "p1", "p2", "fixed",
//    "carried", "refuter_vendor", "run", "at"}
//
// A round's counts come only from the `AUTOPILOT_FINDINGS: <json>` line the reviewer printed, which
// desk-review's `verdict.mjs --findings` computes from the round's results file. A round the worker
// shows ending without one (a verdict marker it printed with no line for that head and round, or a
// Stage 4b it left with no line at all) writes no line: it goes in the ticket's run record,
// <state>/workers/<KEY>.runs.jsonl, as findings_missing, so a gap is never read as a clean round.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARKER, readLog } from './harvest.mjs';

export const REVIEWERS = ['self', 'pr', 'audit'];
const COUNTS = ['p0', 'p1', 'p2', 'fixed'];
const REFUTERS = ['claude', 'codex', 'mixed'];
// The verdict marker desk-review posts; its own fields are fixed by verdict.mjs render.
const VERDICT = /<!-- desk-review:verdict v=1 sha=([0-9a-f]{40}) [^>]*?\bround=(\d+) -->/g;

export const findingsPath = (state, key) => join(state, 'workers', `${key}.findings.jsonl`);
export const runsPath = (state, key) => join(state, 'workers', `${key}.runs.jsonl`);

// One printed line: {ok: true, line} or {ok: false, why}.
export function parseFindings(raw) {
  let d;
  try { d = JSON.parse(String(raw ?? '').trim()); } catch { return { ok: false, why: 'not JSON' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, why: 'not a JSON object' };
  if (!Number.isInteger(d.round) || d.round < 1) return { ok: false, why: 'round must be a whole number from 1' };
  if (!REVIEWERS.includes(d.reviewer)) return { ok: false, why: `reviewer must be one of ${REVIEWERS.join(', ')}` };
  if (!/^[0-9a-f]{7,40}$/.test(String(d.head ?? ''))) return { ok: false, why: 'head must be the reviewed SHA' };
  for (const k of COUNTS) if (!Number.isInteger(d[k]) || d[k] < 0) return { ok: false, why: `${k} must be a whole number` };
  if (d.fixed > d.p0 + d.p1 + d.p2) return { ok: false, why: 'fixed is more than the round found' };
  if (typeof d.carried !== 'boolean') return { ok: false, why: 'carried must be true or false' };
  if (d.refuter_vendor != null && !REFUTERS.includes(d.refuter_vendor)) return { ok: false, why: `refuter_vendor must be one of ${REFUTERS.join(', ')}, or null` };
  const { round, reviewer, head, p0, p1, p2, fixed, carried } = d;
  return { ok: true, line: { round, reviewer, head, p0, p1, p2, fixed, carried, refuter_vendor: d.refuter_vendor ?? null } };
}

// What a worker log's own words show of its review rounds, in order: `lines` it printed, `unreadable`
// [{why, raw}] it printed that do not read, and `missing` rounds that ended with no line, each
// {head, round} for a verdict marker or {reviewer: 'self', stage: <n>} for the n-th Stage 4b.
export function reviewRounds(logText) {
  const lines = [];
  const unreadable = [];
  const verdicts = [];
  const missing = [];
  let stage4b = 0;
  let open = null; // the Stage 4b being worked: {n, rounds}
  const unfinished = []; // each Stage 4b left with no round in it, and how many lines preceded its end
  const close = () => { if (open && !open.rounds) unfinished.push({ n: open.n, after: lines.length }); open = null; };
  for (const text of readLog(logText).said) {
    const events = [
      ...[...text.matchAll(MARKER)].map((m) => ({ at: m.index, kind: m[1], value: m[2] })),
      ...[...text.matchAll(VERDICT)].map((m) => ({ at: m.index, kind: 'verdict', head: m[1], round: Number(m[2]) })),
    ].sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kind === 'AUTOPILOT_STAGE') {
        const is4b = /^4b\b/i.test(e.value.trim());
        if (is4b && !open) open = { n: ++stage4b, rounds: 0 };
        else if (!is4b) close();
      } else if (e.kind === 'AUTOPILOT_DONE') close();
      else if (e.kind === 'AUTOPILOT_FINDINGS') {
        const p = parseFindings(e.value);
        if (!p.ok) { if (!unreadable.some((u) => u.raw === e.value)) unreadable.push({ why: p.why, raw: e.value }); continue; }
        lines.push(p.line);
        if (open) open.rounds++;
      } else if (e.kind === 'verdict') {
        if (!verdicts.some((v) => v.head === e.head && v.round === e.round)) verdicts.push({ head: e.head, round: e.round });
        if (open) open.rounds++;
      }
    }
  }
  // A self-review line printed just after the stage moved on still belongs to that Stage 4b.
  for (const s of unfinished) {
    if (!lines.slice(s.after).some((l) => l.reviewer === 'self')) missing.push({ reviewer: 'self', stage: s.n });
  }
  for (const v of verdicts) {
    if (!lines.some((l) => v.head.startsWith(l.head) && l.round === v.round)) missing.push(v);
  }
  return { lines, unreadable, missing };
}

const readJsonl = (path) => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
};
const lineKey = (l) => `${l.reviewer}|${l.head}|${l.round}`;
const noteKey = (n) => JSON.stringify([n.run ?? null, n.findings_missing ?? n.findings_unreadable]);

// Records what one worker log shows: its rounds' lines in the findings file and its missing or
// unreadable ones in the run record, each once however often the log is read. Never throws: a
// record that cannot be written never stops a pass. Returns {added, missing, unreadable}.
export function recordFindings(state, key, log, run = null, at = new Date().toISOString()) {
  try {
    const { lines, unreadable, missing } = reviewRounds(readFileSync(log, 'utf8'));
    mkdirSync(join(state, 'workers'), { recursive: true });
    const path = findingsPath(state, key);
    const seen = new Set(readJsonl(path).map(lineKey));
    const added = lines.filter((l) => !seen.has(lineKey(l)) && seen.add(lineKey(l)));
    if (added.length) appendFileSync(path, added.map((l) => `${JSON.stringify({ ticket: key, ...l, run, at })}\n`).join(''));
    const runs = runsPath(state, key);
    const noted = new Set(readJsonl(runs).filter((r) => r.findings_missing || r.findings_unreadable).map(noteKey));
    const notes = [
      ...missing.map((m) => ({ at, ticket: key, run, findings_missing: m })),
      ...unreadable.map((u) => ({ at, ticket: key, run, findings_unreadable: u })),
    ].filter((n) => !noted.has(noteKey(n)) && noted.add(noteKey(n)));
    if (notes.length) appendFileSync(runs, notes.map((n) => `${JSON.stringify(n)}\n`).join(''));
    return { added, missing, unreadable };
  } catch {
    return { added: [], missing: [], unreadable: [] };
  }
}
