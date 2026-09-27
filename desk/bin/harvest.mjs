#!/usr/bin/env node
// Read a worker's stream-json log and print what the orchestrator needs: the
// AUTOPILOT_* markers and the final result. Never print the whole log — that is
// how the orchestrator's context stops being O(1).
import { readFileSync } from 'node:fs';

const log = process.argv[2];
const wantBody = process.argv.includes('--pr-body');
if (!log) { console.error('usage: harvest.mjs <worker.log> [--pr-body]'); process.exit(1); }

// Workers wrap markers in backticks, bullets or headings often enough that a strict
// line-start grep silently finds nothing. Be tolerant about the decoration, strict
// about the marker itself.
const MARKER = /^[\s`>*#-]*(AUTOPILOT_[A-Z_]+):[ \t]*(.*?)[\s`]*$/gm;

const texts = [];
let result = null;

for (const line of readFileSync(log, 'utf8').split('\n')) {
  let d;
  try { d = JSON.parse(line); } catch { continue; }
  if (d.type === 'assistant') {
    for (const c of d.message?.content ?? []) if (c.type === 'text') texts.push(c.text);
  } else if (d.type === 'result') {
    result = d;
    if (typeof d.result === 'string') texts.push(d.result);
  }
}

// --pr-body prints only the last body a worker wrote between AUTOPILOT_PR_BODY_BEGIN: and
// AUTOPILOT_PR_BODY_END:, verbatim, and exits 3 when there is none.
if (wantBody) {
  const all = texts.join('\n');
  const re = /AUTOPILOT_PR_BODY_BEGIN:[^\n]*\n([\s\S]*?)\n[\s`>*#-]*AUTOPILOT_PR_BODY_END:/g;
  let body = null;
  for (const m of all.matchAll(re)) body = m[1];
  if (body == null) { console.error('no AUTOPILOT_PR_BODY_BEGIN:/END: block in the log'); process.exit(3); }
  process.stdout.write(`${body.replace(/^```[a-z]*\n/, '').replace(/\n```\s*$/, '')}\n`);
  process.exit(0);
}

const markers = [];
for (const t of texts) for (const m of t.matchAll(MARKER)) markers.push([m[1], m[2]]);

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
