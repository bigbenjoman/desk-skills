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

// What one parsed log event said: an assistant message's blocks through saidIn, or a result's text.
const saidBy = (d) => (d?.type === 'assistant' ? (d.message?.content ?? []).map(saidIn).filter((s) => s != null)
  : d?.type === 'result' && typeof d.result === 'string' ? [d.result] : []);

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

// The last PR body a worker wrote between AUTOPILOT_PR_BODY_BEGIN: and AUTOPILOT_PR_BODY_END:, in its
// own text (readLog's `texts`), without a code fence around it, or null when it wrote none.
export function prBodyIn(texts) {
  const re = /AUTOPILOT_PR_BODY_BEGIN:[^\n]*\n([\s\S]*?)\n[\s`>*#-]*AUTOPILOT_PR_BODY_END:/g;
  let body = null;
  for (const m of texts.join('\n').matchAll(re)) body = m[1];
  return body == null ? null : body.replace(/^```[a-z]*\n/, '').replace(/\n```\s*$/, '');
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const log = process.argv[2];
  const wantBody = process.argv.includes('--pr-body');
  if (!log) { console.error('usage: harvest.mjs <worker.log> [--pr-body]'); process.exit(1); }

  const { texts, said, result } = readLog(readLogFile(log));

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
    console.log(`state:  ${park ? 'PARKED' : done ? 'DONE' : result.is_error ? 'FAILED' : 'ENDED (no marker)'}`);
  } else {
    // No result event yet is the NORMAL state for a live worker. Exiting non-zero here made
    // pass.mjs (which runs this tolerantly) discard every marker until the worker finished,
    // so a running ticket sat at stage 0/9 and then jumped to done.
    console.log('\nresult: none yet — worker still running');
    console.log('state:  RUNNING');
  }
}
