#!/usr/bin/env node
// Read a worker's stream-json log and print what the orchestrator needs: the
// AUTOPILOT_* markers and the final result. Never print the whole log — that is
// how the orchestrator's context stops being O(1).
import { readFileSync, realpathSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// A worker log's text: a finished round is moved aside gzipped (`<KEY>.log.round<n>.gz`).
export const readLogFile = (path) => (path.endsWith('.gz') ? gunzipSync(readFileSync(path)) : readFileSync(path)).toString('utf8');

// Workers wrap markers in backticks, bullets or headings often enough that a strict
// line-start grep silently finds nothing. Be tolerant about the decoration, strict
// about the marker itself.
export const MARKER = /^[\s`>*#-]*(AUTOPILOT_[A-Z_]+):[ \t]*(.*?)[\s`]*$/gm;

// A Bash command that opens by echoing a stage: `echo "AUTOPILOT_STAGE: 4/9 verify"; <command>`.
// STAGE only, and only as the command's start: DONE, PARK and IMAGES must stay in the worker's text.
const ECHO_STAGE = /^\s*echo\s+(["'])AUTOPILOT_STAGE:[ \t]*([^"'\n]*?)\s*\1/;

// What one content block of an assistant message says: a text block's text, a stage echoed at the
// start of a Bash command as its marker line, or nothing.
export function saidIn(c) {
  if (c?.type === 'text' && typeof c.text === 'string') return c.text;
  const m = c?.type === 'tool_use' && c.name === 'Bash' && typeof c.input?.command === 'string'
    && c.input.command.match(ECHO_STAGE);
  return m ? `AUTOPILOT_STAGE: ${m[2]}` : null;
}

// A session's final result text with a DONE marker that ends it, as a sentence of its own after other
// words on its line, moved to a line of its own: its last word is that it finished. A marker that is
// quoted, mentioned mid-sentence or followed by more text is left where it is, and is not read.
const resultSaid = (s) => s.trimEnd().replace(/([.!?])[ \t]+(?=AUTOPILOT_DONE:[^\n`]*$)/, '$1\n');

// What one parsed log event said: an assistant message's blocks through saidIn, or a result's text.
const saidBy = (d) => (d?.type === 'assistant' ? (d.message?.content ?? []).map(saidIn).filter((s) => s != null)
  : d?.type === 'result' && typeof d.result === 'string' ? [resultSaid(d.result)] : []);

// Only what the worker itself said: its text blocks and its final result (`texts`). Tool inputs
// and tool results are never read, so a grep for a marker, or a file that quotes one, is not the
// worker printing it. The one exception is a stage the worker echoed at the start of a Bash
// command: `said` is `texts` with those stages interleaved in log order, for reading markers.
export function readLog(logText) {
  const texts = [];
  const said = [];
  let result = null;
  for (const line of logText.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'assistant') {
      for (const c of d.message?.content ?? []) if (c.type === 'text') texts.push(c.text);
    } else if (d.type === 'result') {
      result = d;
      if (typeof d.result === 'string') texts.push(d.result);
    }
    said.push(...saidBy(d));
  }
  return { texts, said, result };
}

// [name, value] for every marker the worker printed, in order. The one reading of markers:
// harvest prints these, and pass.mjs's respawn check tests them, so the two cannot disagree.
export function markersIn(texts) {
  const markers = [];
  for (const t of texts) for (const m of t.matchAll(MARKER)) markers.push([m[1], m[2]]);
  return markers;
}

export const workerMarkers = (logText) => markersIn(readLog(logText).said);

// The last stage the worker said, through saidBy and markersIn as readLog's `said` is, so desk-q and
// pass.mjs never disagree: `stage` is the marker's first word, as pass.mjs stores it ("4/9"),
// `label` the whole marker ("4/9 verify"), `at` the time of the event that said it (or null).
// Only lines naming a stage are parsed, so a log's tail reads in a few milliseconds.
export function lastStage(logText) {
  let last = null;
  for (const line of logText.split('\n')) {
    if (!line.includes('AUTOPILOT_STAGE')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    for (const [k, v] of markersIn(saidBy(d))) {
      // The stage is the first run of non-space, pass.mjs's `AUTOPILOT_STAGE:\s*(\S+)`.
      const stage = k === 'AUTOPILOT_STAGE' ? /\S+/.exec(v)?.[0] : null;
      if (stage) last = { stage, label: v.trim(), at: Date.parse(d.timestamp ?? '') || null };
    }
  }
  return last;
}

// A session that ended on its own closes its last turn with a result event; one that was killed (a
// reboot, a crash, a kill) stops mid-turn. Bookkeeping the CLI writes after a result (a
// command_lifecycle event, say) is not a turn, so only turn events after the last result count.
// Lines that are not JSON (stderr) are skipped.
const TURN_EVENTS = new Set(['assistant', 'user', 'stream_event', 'system']);
export function endedNormally(logText) {
  const lines = logText.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d?.type === 'result') return true;
    if (TURN_EVENTS.has(d?.type)) return false;
  }
  return false;
}

// The result subtype the CLI ends a session with once it passes --max-budget-usd.
export const BUDGET_STOP = 'error_max_budget_usd';
// Whether the session ended on the per-worker budget: its last turn closed with a result of that
// subtype. A session with no ceiling (`budget` off) passed none, so its error is any other error.
export function budgetStopped(logText, budget) {
  if (!budget?.usd || !endedNormally(logText)) return false;
  const { result } = readLog(logText);
  return !!result?.is_error && result.subtype === BUDGET_STOP;
}

// How a worker that printed no marker ended, in a phrase: that its session wrote nothing after desk's
// own lines (`desk_*` events, before and around the launch), else its session's error, else the last
// line it said, else the last line of its log that was not an event (the CLI's own error).
export const NO_OUTPUT = 'ended after its preflight with no output';
export function workerEnd(logText) {
  let events = 0, said = null, result = null, stray = null;
  for (const line of logText.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { stray = line.trim(); continue; }
    if (String(d?.type ?? '').startsWith('desk_')) continue;
    events += 1;
    if (d?.type === 'result') result = d;
    for (const s of saidBy(d)) if (s.trim()) said = s;
  }
  const quote = (s) => { const l = s.trim().split('\n').filter((x) => x.trim()).pop().trim(); return `"${l.length > 200 ? `${l.slice(0, 199)}…` : l}"`; };
  if (!events) return stray ? `${NO_OUTPUT} from its session; the last line of its log: ${quote(stray)}` : NO_OUTPUT;
  const last = said ? `its last line: ${quote(said)}` : stray ? `the last line of its log: ${quote(stray)}` : 'it said nothing';
  return result?.is_error ? `its session ended in error (${result.subtype ?? 'error'}); ${last}` : last;
}

// The last PR body a worker wrote between AUTOPILOT_PR_BODY_BEGIN: and AUTOPILOT_PR_BODY_END:, in its
// own text (readLog's `texts`), without a code fence around it, or null when it wrote none.
export function prBodyIn(texts) {
  const re = /AUTOPILOT_PR_BODY_BEGIN:[^\n]*\n([\s\S]*?)\n[\s`>*#-]*AUTOPILOT_PR_BODY_END:/g;
  let body = null;
  for (const m of texts.join('\n').matchAll(re)) body = m[1];
  return body == null ? null : body.replace(/^```[a-z]*\n/, '').replace(/\n```\s*$/, '');
}

// The steps a DONE marker names as waiting on its PR's merge: `follow_on=` then a one-line JSON array of
// {"step": "<one line>", "row": "<the §3 key it needs>", "after": "<gate>"} (row null where none says),
// before any said=, which runs to the line's end. -> { steps, error }: steps [] with no follow_on=, and
// with an error naming why where one is there but does not read.
export const FOLLOW_ON_MAX = 500;
// What a step waits on before needs-you lists it: the merge (the default, kept as no `after`), its merge
// commit on the default branch (`main`), or on config §4 "Promotion ref" (`production`).
const FOLLOW_GATES = ['merge', 'main', 'production'];
const gateOf = (after) => (after == null || after === 'merge' ? {} : { after });
export function followOnIn(done) {
  const s = String(done ?? '');
  const at = s.search(/\bfollow_on=/);
  if (at < 0) return { steps: [], error: null };
  const rest = s.slice(at + 'follow_on='.length);
  if (!rest.startsWith('[')) return { steps: [], error: 'not a JSON array' };
  let list = null;
  // The array ends at the first `]` that closes a whole JSON value.
  for (let i = rest.indexOf(']'); i >= 0 && list == null; i = rest.indexOf(']', i + 1)) {
    try { list = JSON.parse(rest.slice(0, i + 1)); } catch { /* not closed yet */ }
  }
  if (!Array.isArray(list)) return { steps: [], error: 'not a JSON array' };
  const bad = list.find((x) => typeof x?.step !== 'string' || !x.step.trim() || (x.row != null && typeof x.row !== 'string'));
  if (bad !== undefined) return { steps: [], error: `an entry is not {"step": "…", "row": "…"}: ${JSON.stringify(bad)}` };
  const badGate = list.find((x) => x.after != null && !FOLLOW_GATES.includes(x.after));
  if (badGate !== undefined) return { steps: [], error: `an entry's "after" is not one of ${FOLLOW_GATES.join(', ')}: ${JSON.stringify(badGate)}` };
  return { steps: list.map((x) => ({ step: x.step.trim().slice(0, FOLLOW_ON_MAX), row: x.row?.trim() || null, ...gateOf(x.after) })), error: null };
}
// A queue entry whose follow-on steps wait on the person: its PR merged, steps kept, none said run yet.
// Two follow-on steps are the same step by their text and gate (`after`, none for the merge).
export const sameStep = (a, b) => a?.step === b?.step && (a?.after ?? 'merge') === (b?.after ?? 'merge');
// Settling steps `ran` of follow-on list `followOn` at time `at`: { left, fields }, `left` the steps
// kept and `fields` the queue set that records it (follow_on=<left>, or follow_on_done=<at> once none
// is left; none where no step of `ran` is there).
export function settleSteps(followOn, ran, at) {
  const all = followOn ?? [];
  const left = all.filter((s) => !ran.some((x) => sameStep(s, x)));
  const fields = left.length === all.length ? [] : left.length ? [`follow_on=${JSON.stringify(left)}`] : [`follow_on_done=${at}`];
  return { left, fields };
}
export const followOnPending = (t) => !!t?.merged_at && !t.follow_on_done && Array.isArray(t.follow_on) && t.follow_on.length > 0;
// A kept PR status naming criteria its review left for after the merge that the pass has not made
// follow-on steps of yet for PR `n` (pass.mjs post_merge_read).
export const postMergeOwed = (t, n = t?.result?.pr) => (t?.pr_status?.post_merge ?? []).length > 0 && String(t.post_merge_read ?? '') !== String(n);
// A merged ticket the pass still owes those steps: its batch is not finished, nor is it archived or
// dropped by a new batch, until the pass has added them. Only a done ticket's PR is read (pass.mjs), so
// a requeued one owes nothing until it is done again.
export const postMergeUnmade = (t) => t?.state === 'done' && !!t.merged_at && t.result?.pr != null && Number(t.pr_status?.pr) === Number(t.result.pr) && postMergeOwed(t);

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const log = process.argv[2];
  const wantBody = process.argv.includes('--pr-body');
  if (!log) { console.error('usage: harvest.mjs <worker.log> [--pr-body]'); process.exit(1); }

  const logText = readLogFile(log);
  const { texts, said, result } = readLog(logText);

  // --pr-body prints only the last body a worker wrote between AUTOPILOT_PR_BODY_BEGIN: and
  // AUTOPILOT_PR_BODY_END:, verbatim, and exits 3 when there is none.
  if (wantBody) {
    const body = prBodyIn(texts);
    if (body == null) { console.error('no AUTOPILOT_PR_BODY_BEGIN:/END: block in the log'); process.exit(3); }
    process.stdout.write(`${body}\n`);
    process.exit(0);
  }

  const markers = markersIn(said);

  if (markers.length) {
    console.log('markers:');
    for (const [k, v] of markers) console.log(`  ${k}: ${v}`);
  } else {
    console.log('markers: none found');
  }

  if (result) {
    console.log(`\nresult: error=${result.is_error} turns=${result.num_turns} notional=$${(result.total_cost_usd ?? 0).toFixed(2)}`);
    const park = markers.find(([k]) => k === 'AUTOPILOT_PARK');
    const done = markers.find(([k]) => k === 'AUTOPILOT_DONE');
    let budget = null;
    if (!park && !done && result.subtype === BUDGET_STOP) {
      try { budget = (await import('./desk-env.mjs')).workerBudget(); } catch { /* unreadable: any other error */ }
    }
    const stopped = !park && !done && budgetStopped(logText, budget);
    console.log(`state:  ${park ? 'PARKED' : done ? 'DONE' : stopped ? 'BUDGET STOP' : result.is_error ? 'FAILED' : 'ENDED (no marker)'}`);
  } else {
    // No result event yet is the NORMAL state for a live worker. Exiting non-zero here made
    // pass.mjs (which runs this tolerantly) discard every marker until the worker finished,
    // so a running ticket sat at stage 0/9 and then jumped to done.
    console.log('\nresult: none yet — worker still running');
    console.log('state:  RUNNING');
  }
}
