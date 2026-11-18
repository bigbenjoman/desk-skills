#!/usr/bin/env node
// The levers controller's hard trips: every pass, in a repo whose levers row reads `auto`, a lever
// that did visible harm on one of its tickets is reverted there at once, with no statistics. Each trip
// is one the lever registry declares for that lever (lever-registry.mjs ENTRIES `trips`):
//
//   skipped-preflight-failure  a start that skipped its preflight on a matching fingerprint was refused
//                              a tool or permission the preflight checks (a write in its own worktree,
//                              a toolchain probe's command as written, desk-jira or `codex --version`
//                              where the preflight wants them OK, or a subagent), or could not find a
//                              probed binary at all
//   stale-wait                 a fix try the failure-class lever held as waiting is still waiting more
//                              than the trip's hours after what it waited for settled: every blocker in
//                              the batch merged, or the person's answer saved. A blocker outside the
//                              batch is lifted from the hold by the pass that reads it settled (Done
//                              and landed), so a ticket still held behind one is not waiting past it
//   post-merge-revert          post-merge.jsonl records a revert of the ticket's PR
//   own-step-error             the lever's own step exited non-zero: a `lever_step` line in the ticket's
//                              run record, or the worker's own call of that command in its log. An exit
//                              another of the lever's trips counts as a rate (codex's dead seats) is
//                              left to that trip
//   codex-dead-seats           more than the trip's rate of the last `calls` desk-codex finder and
//                              refuter calls across the lever's on-arm tickets died (exit 124 or 75),
//                              cited at the latest of them
//
// A trip counts only for a ticket on the lever's arm in its current state: drawn `on` under the trial
// running now, or, for an adopted or settled lever, admitted with it in its set since the trial it was
// kept from began (the latest unbroken run of trial, adopted and settled). Only a
// lever on trial, adopted or settled is reverted. A trip is one `trip` event in the repo's lever log
// (lever-log.mjs), actor `trip`, naming the ticket and the triggering record's file and 1-based line;
// a lever already reverted once in the repo is frozen instead, and that, or a step's own error, raises
// one needs_you event. Tickets keep their pins: only tickets admitted after the trip get the lever off.
//
// The records the trips read beyond post-merge.jsonl and the worker logs are lines in the ticket's run
// record, <state>/workers/<KEY>.runs.jsonl, beside spawn-worker.sh's start records:
//   {at, ticket, preflight: 'skipped', worktree, probes: [command], jira: bool, codex: bool}
//   {at, ticket, session?, lever_step: {lever, step, exit, error?}}
//   {at, ticket, fix_wait: {class, waiting, blockers: [KEY], pr, head}}
//
//   import { runTrips, findTrips, recordRun } from './levers-trips.mjs'
//   node levers-trips.mjs record-skip --state <dir> --ticket <KEY> --worktree <dir> [--probe <cmd>]... [--jira 1] [--codex 1]
//   node levers-trips.mjs record-step --state <dir> --ticket <KEY> --lever <name> --step <step> --exit <n> [--session <id>] [--error <text>]
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY, KEPT_STATES } from './lever-registry.mjs';
import { appendWith, read, stampAfter } from './lever-log.mjs';
import { leverStatesIn, trialId } from './levers-auto.mjs';
import { runsPath } from './findings.mjs';
import { postMergePath } from './post-merge.mjs';
import { readLogFile } from './harvest.mjs';
import { workerLogs } from './worker-cost.mjs';
import { WAITING_CLASSES } from './failure-class.mjs';
import { toolOutcomes, codexCalls } from './log-tool-calls.mjs';
import { priorRevertsOf, revertTarget, frozenText } from './levers-evaluate.mjs';
import { answerEntriesSince } from './handoff.mjs';
import { recordLeverDecision } from './lever-changes.mjs';
import { batchPaths } from './desk-env.mjs';
import { everyTicket } from './queue-store.mjs';

export const ACTOR = 'trip';
// The states a trip reverts from.
export const REVERTIBLE = Object.freeze(['trial', 'adopted', 'settled']);
const HOUR_MS = 3_600_000;
// The exit a shell gives a command it cannot find.
const NOT_FOUND = 127;
const WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = Object.freeze(['Agent', 'Task']);
const snake = (k) => k.replace(/-/g, '_');

// ---- the run record ---------------------------------------------------------------------------------
// Each line of a jsonl file that parses, with its 1-based line number: [{ line, rec }].
export function lines(file) {
  let body;
  try { body = readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  body.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try { const rec = JSON.parse(raw); if (rec && typeof rec === 'object') out.push({ line: i + 1, rec }); } catch { /* not a record */ }
  });
  return out;
}

// Appends one line to ticket `key`'s run record. Never throws: a record that cannot be written never
// stops a pass or a spawn. -> the line written, or null.
export function recordRun(state, key, fields, at = new Date().toISOString()) {
  try {
    const file = runsPath(state, key);
    mkdirSync(dirname(file), { recursive: true });
    const line = { at, ticket: key, ...fields };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    return line;
  } catch { return null; }
}

// A fix try held as waiting, once per head and class however many passes hold it.
export function recordWait(state, key, wait, at) {
  const last = lines(runsPath(state, key)).filter((l) => l.rec.fix_wait).at(-1)?.rec.fix_wait;
  if (last && last.head === wait.head && last.class === wait.class) return null;
  return recordRun(state, key, { fix_wait: wait }, at);
}

// ---- which tickets a lever's trips read ---------------------------------------------------------------
// When `lever`'s latest unbroken run of revertible states (trial, adopted, settled) began, so the trial
// an adopted lever was kept from counts with it: null when that run is the registry's initial trial. An
// undo that restores a state (levers undo) puts back the run as it stood before the call it undoes.
function liveSince(events, lever, registry) {
  const l = registry[lever];
  let live = l?.layer === 'low-risk' && !!l.trialled;
  let since = null;
  const before = new Map();
  for (const e of events) {
    if (!['transition', 'override', 'trip'].includes(e.kind) || e.lever !== lever || e.to == null) continue;
    before.set(e.id, { live, since });
    if (e.restores && before.has(e.undoes_event)) ({ live, since } = before.get(e.undoes_event));
    else if (REVERTIBLE.includes(e.to)) { if (!live) { live = true; since = e.at; } }
    else { live = false; since = null; }
  }
  return since;
}

// Whether queue ticket `t` is on `lever`'s arm in its state `s` in repo `slug`.
export function onArm(t, lever, s, slug, events, registry = REGISTRY) {
  const pin = t?.levers;
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) return false;
  if (s.state === 'trial') return pin.arms?.[lever] === 'on' && pin.trial_ids?.[lever] === trialId(slug, lever, s);
  if (KEPT_STATES.includes(s.state)) {
    if (!(pin.set ?? []).includes(lever)) return false;
    const since = liveSince(events, lever, registry);
    return since == null || Date.parse(pin.at) >= Date.parse(since);
  }
  return false;
}

// ---- reading a worker log ---------------------------------------------------------------------------
// Each of ticket `key`'s worker logs written since `since`, with what toolOutcomes reads from it; read
// once per `cache`, a Map one run of the trips shares.
function logOutcomes(state, key, since, cache = new Map()) {
  const k = `${state}|${key}|${since ?? ''}`;
  if (!cache.has(k)) {
    cache.set(k, workerLogs(state, key, since ?? null).sort().flatMap((file) => {
      let text;
      try { text = readLogFile(file); } catch { return []; }
      return toolOutcomes(text).map((o) => ({ ...o, file }));
    }));
  }
  return cache.get(k);
}

// A Bash command with any leading `cd <dir> &&` dropped and its spaces collapsed.
const bare = (cmd) => String(cmd ?? '').trim().replace(/^cd\s+\S+\s*&&\s*/, '').replace(/\s+/g, ' ');
// The binary a probe proves executes: its first word.
const binOf = (probe) => bare(probe).split(' ')[0];
const startsWithCommand = (cmd, stem) => !!stem && (cmd === stem || cmd.startsWith(`${stem} `));

// Whether a refused or failed call `o` is one the preflight `rec` (a skip record) checks. The preflight
// proves a write in the worktree, the Agent tool, each probe command as written (`pnpm --version`, never
// `pnpm dlx …`, which the settings refuse on purpose), `desk-jira` and `codex --version`: so a refusal of
// one of those, or a probed binary the shell cannot find at all.
export function preflightChecks(o, rec) {
  if (WRITE_TOOLS.includes(o.tool)) {
    const path = o.input?.file_path ?? o.input?.notebook_path;
    return !!o.denied && typeof path === 'string' && !!rec.worktree && (path === rec.worktree || path.startsWith(`${rec.worktree}/`));
  }
  if (AGENT_TOOLS.includes(o.tool)) return !!o.denied;
  if (o.tool !== 'Bash') return false;
  const cmd = bare(o.input?.command);
  const probes = [...(rec.probes ?? []), ...(rec.codex ? ['codex --version'] : [])].map(bare).filter(Boolean);
  if (o.denied) return probes.includes(cmd) || (!!rec.jira && startsWithCommand(cmd, 'desk-jira'));
  if (o.exit !== NOT_FOUND) return false;
  return [...probes.map(binOf), ...(rec.jira ? ['desk-jira'] : [])].some((b) => startsWithCommand(cmd, b) && notFound(b).test(o.text ?? ''));
}
// The shell's words for binary `bin` itself missing (zsh, bash, sh), so a 127 from another command on
// the line, or from inside the binary, is not read as the binary missing.
function notFound(bin) {
  const b = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`command not found: ${b}(?:\\s|$)|(?:^|[\\s:])${b}: (?:command )?not found`);
}

// The pattern of a lever's own step as a worker calls it, or null for a step no worker runs: the
// step's first word as a program or script (any path before it, `.mjs` optional), then the rest.
export function stepPattern(step) {
  const words = String(step ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words[0] === 'the') return null;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = esc(words[0].replace(/\.mjs$/, ''));
  return new RegExp(`(?:^|[\\s/])${head}(?:\\.mjs)?${words.slice(1).map((w) => `\\s+${esc(w)}`).join('')}(?:\\s|$)`);
}

// ---- the trips --------------------------------------------------------------------------------------
// Each finds the records on one ticket that trip `lever`, oldest first: [{ file, line, error?, why }].
export const DETECTORS = Object.freeze({
  'post-merge-revert': ({ state, t }) => lines(postMergePath(state))
    .filter((l) => l.rec.kind === 'revert' && l.rec.ticket === t.key)
    .map((l) => ({ file: postMergePath(state), line: l.line, why: `its PR${l.rec.pr ? ` #${l.rec.pr}` : ''} was reverted after merging${l.rec.commit ? ` (${String(l.rec.commit).slice(0, 12)})` : ''}` })),

  'own-step-error': ({ state, t, lever, trip, cache, registry = REGISTRY }) => {
    const file = runsPath(state, t.key);
    // Exits a rate trip of the lever counts (a dead codex seat) do not trip it one at a time.
    const rated = new Set((registry[lever]?.trips ?? []).flatMap((x) => x.exits ?? []));
    const counts = (exit) => exit != null && Number(exit) !== 0 && !rated.has(Number(exit));
    const recorded = lines(file).filter((l) => l.rec.lever_step?.lever === lever && counts(l.rec.lever_step.exit))
      .map((l) => {
        const s = l.rec.lever_step;
        const error = `${s.step ?? trip.step} exited ${s.exit}${s.error ? `: ${s.error}` : ''}`;
        return { file, line: l.line, error, why: error };
      });
    const re = stepPattern(trip.step);
    const called = re ? logOutcomes(state, t.key, t.levers?.at, cache).filter((o) => o.tool === 'Bash' && !o.denied && counts(o.exit) && re.test(bare(o.input?.command)))
      .map((o) => {
        const error = `${trip.step} exited ${o.exit}${o.text ? `: ${o.text.slice(0, 200)}` : ''}`;
        return { file: o.file, line: o.line, error, why: error };
      }) : [];
    return [...recorded, ...called];
  },

  'skipped-preflight-failure': ({ state, t, cache }) => {
    const runs = lines(runsPath(state, t.key));
    const starts = runs.filter((l) => l.rec.session && l.rec.at);
    // Each skipped preflight's start: the first start recorded at or after the skip.
    const skipped = runs.filter((l) => l.rec.preflight === 'skipped' && l.rec.at).flatMap((l) => {
      const start = starts.find((s) => Date.parse(s.rec.at) >= Date.parse(l.rec.at));
      return start ? [{ rec: l.rec, session: start.rec.session }] : [];
    });
    if (!skipped.length) return [];
    return logOutcomes(state, t.key, t.levers?.at, cache).flatMap((o) => {
      const skip = skipped.find((s) => s.session === o.session);
      if (!skip || !preflightChecks(o, skip.rec)) return [];
      const what = o.tool === 'Bash' ? `\`${bare(o.input?.command).slice(0, 120)}\`` : o.tool;
      return [{ file: o.file, line: o.line, why: `its start skipped the preflight and ${o.denied ? 'was refused' : 'could not find the binary of'} ${what}, which the preflight checks` }];
    });
  },

  'stale-wait': ({ state, t, queue, now, trip }) => {
    // A wait is held on a done ticket's open PR (pass.mjs applyFix); merged or failed, it waits no more.
    if (t.merged_at || t.state === 'failed') return [];
    const file = runsPath(state, t.key);
    const last = lines(file).filter((l) => l.rec.fix_wait && l.rec.at).at(-1);
    if (!last || !WAITING_CLASSES.includes(last.rec.fix_wait.class)) return [];
    const since = Date.parse(last.rec.at);
    // A fix try made after the wait was recorded ended it.
    if ((t.fix_tries ?? []).some((f) => Date.parse(f.at) > since)) return [];
    const w = last.rec.fix_wait;
    // Only while the PR it was held on is still the ticket's and not closed: a PR closed unmerged
    // leaves the ticket done (pass.mjs), and a closed PR owed its reopen still counts as open.
    if (w.pr == null || String(w.pr) !== String(t.result?.pr)) return [];
    const closed = String(t.pr_status?.pr) === String(w.pr) && t.pr_status?.state === 'CLOSED';
    if (closed && String(t.reopening ?? '') !== String(w.pr)) return [];
    let settled = null;
    let what = null;
    if (w.class === 'dependency wait') {
      // Still waiting means still held behind one of them.
      const held = String(t.held_by ?? '').split('|').filter(Boolean);
      const merged = (w.blockers ?? []).map((k) => queue?.tickets?.[k]?.merged_at ?? null);
      if (merged.length && merged.every(Boolean) && (w.blockers ?? []).some((k) => held.includes(k))) { settled = Math.max(...merged.map((m) => Date.parse(m))); what = `${w.blockers.join(', ')} merged`; }
    } else {
      // The person's answer: the first one saved to the ticket's briefing since the wait (answer.mjs
      // saveAnswer), or the mailbox, written only while a worker waits.
      let brief = '';
      try { brief = readFileSync(join(state, 'briefings', `${t.key}.md`), 'utf8'); } catch { /* no briefing */ }
      const stamps = answerEntriesSince(brief, last.rec.at).map((a) => Date.parse(a.at));
      try { stamps.push(statSync(join(state, 'answers', `${t.key}.txt`)).mtimeMs); } catch { /* no mailbox */ }
      const after = stamps.filter((m) => Number.isFinite(m) && m > since);
      if (after.length) { settled = Math.min(...after); what = 'the person answered'; }
    }
    if (settled == null || !(now - settled > trip.hours * HOUR_MS)) return [];
    return [{ file, line: last.line, why: `it has waited (${w.class}: ${w.waiting}) more than ${trip.hours} hours since ${what} on ${new Date(settled).toISOString().slice(0, 16)}Z` }];
  },
});

// Each of ticket `key`'s desk-codex review calls in its worker logs since `since`, oldest first; read once
// per `cache`.
function codexCallsOf(state, key, since, cache = new Map()) {
  const k = `codex|${state}|${key}|${since ?? ''}`;
  if (!cache.has(k)) {
    cache.set(k, workerLogs(state, key, since ?? null).sort().flatMap((file) => {
      let text;
      try { text = readLogFile(file); } catch { return []; }
      return codexCalls(text).map((c) => ({ ...c, file, ticket: key }));
    }));
  }
  return cache.get(k);
}

// Trips read as a rate over the calls of every on-arm ticket, in their admission order. Each returns
// the record to cite, { ticket, file, line, why }, or null.
export const RATE_DETECTORS = Object.freeze({
  'codex-dead-seats': ({ state, tickets, trip, cache }) => {
    const calls = tickets.flatMap((t) => codexCallsOf(state, t.key, t.levers?.at, cache)).filter((c) => c.exit != null);
    const last = calls.slice(-trip.calls);
    if (last.length < trip.calls) return null;
    const dead = last.filter((c) => trip.exits.includes(c.exit)).length;
    if (!(dead / last.length > trip.rate)) return null;
    const at = last.at(-1);
    return { ticket: at.ticket, file: at.file, line: at.line, why: `${dead} of its last ${last.length} codex calls died (exit ${trip.exits.join(' or ')}), over the ${Math.round(trip.rate * 100)}% a trip allows` };
  },
});

// The first trip each lever in `states` (each lever's state in the repo's row, desk-env leverStates)
// meets among the queue's tickets, given the repo's lever log events: [{ lever, trip, ticket, file,
// line, error, why, from }]. A lever the row does not leave to `auto`, or not on trial, adopted or
// settled, has none; nor does a record a trip event already cites.
export function findTrips({ slug, state, queue, states, events, now = Date.now(), registry = REGISTRY }) {
  const byLever = leverStatesIn(events, registry);
  // One record can trip each lever its ticket was on, so a citation is per lever.
  const cited = new Set(events.filter((e) => e.kind === 'trip').map((e) => `${e.lever}|${e.evidence_file}|${e.evidence_line}`));
  const found = [];
  const cache = new Map();
  for (const [lever, reg] of Object.entries(registry)) {
    if (states?.[lever] !== 'auto') continue;
    const s = byLever[lever];
    if (!REVERTIBLE.includes(s.state)) continue;
    // Archived tickets too: a merged one is archived within a pass, and its revert can come days later.
    const tickets = Object.values(everyTicket(queue)).filter((t) => onArm(t, lever, s, slug, events, registry))
      .sort((a, b) => String(a.levers?.at ?? '').localeCompare(String(b.levers?.at ?? '')));
    let hit = null;
    // A rate trip reads the lever's calls across every on-arm ticket at once.
    for (const trip of reg.trips) {
      const detect = RATE_DETECTORS[trip.id];
      if (!detect || hit) continue;
      let r = null;
      try { r = detect({ state, tickets, trip, cache }); } catch { r = null; }
      if (r && !cited.has(`${lever}|${r.file}|${r.line}`)) hit = { lever, trip: trip.id, from: s.state, from_id: s.id, ...r };
    }
    for (const t of hit ? [] : tickets) {
      for (const trip of reg.trips) {
        const detect = DETECTORS[trip.id];
        if (!detect) continue;
        let recs = [];
        try { recs = detect({ state, t, queue, lever, trip, now, cache, registry }); } catch { recs = []; }
        const r = recs.find((x) => !cited.has(`${lever}|${x.file}|${x.line}`));
        if (r) { hit = { lever, trip: trip.id, ticket: t.key, from: s.state, from_id: s.id, ...r }; break; }
      }
      if (hit) break;
    }
    if (hit) found.push(hit);
  }
  return found;
}

// Reverts each lever a trip found, under the lever log's lock, while the lever is still in the state
// the trip was read in. A trip carrying `defect` (the defect it found, in a sentence) raises one
// needs_you naming it whether or not the revert froze the lever. -> the events written.
// Each trip is logged as a taken call in the repo's own decision log (`decisionsState`), for the digest.
export function applyTrips({ slug, name = slug, repo = null, decisionsState = batchPaths(slug).state, trips, registry = REGISTRY, now = Date.now() }) {
  const written = [];
  const at = new Date(now).toISOString();
  for (const x of trips) {
    const lines = appendWith(slug, () => {
      const evs = tripEvents({ events: read(slug).events, name, x, at, registry });
      return evs.length ? evs : null;
    });
    if (!lines) continue;
    written.push(...lines);
    recordLeverDecision([lines[0]], { slug, repo, state: decisionsState });
  }
  return written;
}

// The events trip `x` writes on the lever log `events` (read under its lock): the trip, then its
// needs_you where it froze the lever or names an error or a defect. None while the lever is no longer in
// the state `x.from` the trip was read in, or, where `x` carries `from_id`, no longer in that same run of
// it (leverStatesIn's `id`: a fresh trial levers decide started since has a new one, and a trial an undo
// restored keeps its own), or once a trip cites the same evidence.
//   -> [event] (applyTrips appends them; the caller logs the trip's decision)
export function tripEvents({ events, name, x, at, registry = REGISTRY }) {
  const s = leverStatesIn(events, registry)[x.lever];
  if (s.state !== x.from) return [];
  if (Object.hasOwn(x, 'from_id') && (s.id ?? null) !== (x.from_id ?? null)) return [];
  if (events.some((y) => y.kind === 'trip' && y.lever === x.lever && y.evidence_file === x.file && y.evidence_line === x.line)) return [];
  // Stamped no earlier than what the log already holds (lever-log.mjs stampAfter): a trip read before a
  // levers undo restored the lever, and written after it, would otherwise replay before the restore.
  at = stampAfter(events, at);
  const e = {
    kind: 'trip', lever: x.lever, from: s.state, to: revertTarget(priorRevertsOf(events, x.lever)), actor: ACTOR, reason_code: snake(x.trip), at,
    reason: `${x.trip} on ${x.ticket}: ${x.why} (${x.file}:${x.line})`, trip: x.trip, ticket: x.ticket,
    evidence_file: x.file, evidence_line: x.line, ...(x.error ? { error: x.error } : {}),
  };
  const frozen = e.to === 'frozen';
  if (!(frozen || x.error || x.defect)) return [e];
  const detail = x.error ?? x.defect;
  return [e, {
    kind: 'needs_you', lever: x.lever, actor: ACTOR, reason_code: frozen ? 'frozen_second_revert' : x.error ? 'own_step_error' : snake(x.trip), at, ticket: x.ticket,
    evidence_file: x.file, evidence_line: x.line,
    reason: frozen
      ? frozenText(x.lever, name, `${x.trip} on ${x.ticket}${detail ? `: ${detail}` : ''}`)
      : x.error
        ? `${x.lever} was reverted in ${name}: its own step failed on ${x.ticket}: ${x.error}`
        : `${x.lever} was reverted in ${name}: ${x.why} on ${x.ticket}, a defect that merged: ${x.defect}`,
  }];
}

// The trips as a pass runs them, for its batch state folder and queue. -> { events, line }, `line`
// null when nothing tripped.
export function runTrips({ slug, name = slug, repo = null, state, queue, states, now = Date.now(), registry = REGISTRY }) {
  if (!Object.values(states ?? {}).includes('auto')) return { events: [], line: null };
  const log = read(slug);
  // A log that does not parse is the assignment's to report; nothing is reverted on a partial read.
  if (log.bad.length) return { events: [], line: null };
  const trips = findTrips({ slug, state, queue, states, events: log.events, now, registry });
  const events = applyTrips({ slug, name, repo, trips, registry, now });
  const changed = events.filter((e) => e.kind === 'trip');
  return { events, line: changed.length ? `levers trips: ${changed.map((e) => `${e.lever} ${e.from} → ${e.to} (${e.trip} on ${e.ticket})`).join(', ')}` : null };
}

// ---- the command line ---------------------------------------------------------------------------------
function opts(argv) {
  const o = { probe: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '');
    if (!k || argv[i + 1] == null) throw new Error(`${argv[i]} wants a value`);
    if (k === 'probe') o.probe.push(argv[i + 1]); else o[k] = argv[i + 1];
  }
  return o;
}
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    const o = opts(rest);
    if (!o.state || !o.ticket || !existsSync(o.state)) throw new Error('--state <existing dir> and --ticket <KEY> are required');
    const yes = (v) => v === '1' || v === 'yes' || v === 'true';
    let line;
    if (cmd === 'record-skip') {
      line = recordRun(o.state, o.ticket, { preflight: 'skipped', worktree: o.worktree ?? null, probes: o.probe.filter(Boolean), jira: yes(o.jira), codex: yes(o.codex) });
    } else if (cmd === 'record-step') {
      if (!Object.hasOwn(REGISTRY, o.lever) || !o.step || !/^\d+$/.test(String(o.exit))) throw new Error('--lever <registry lever> --step <step> --exit <n> are required');
      line = recordRun(o.state, o.ticket, { ...(o.session ? { session: o.session } : {}), lever_step: { lever: o.lever, step: o.step, exit: Number(o.exit), ...(o.error ? { error: o.error } : {}) } });
    } else throw new Error(`unknown command ${cmd ?? '(none)'}`);
    if (!line) throw new Error('the run record could not be written');
  } catch (e) {
    console.error(`levers-trips: ${e.message}\nusage: levers-trips.mjs record-skip|record-step --state <dir> --ticket <KEY> …`);
    process.exit(2);
  }
}
