#!/usr/bin/env node
// Standing intake: tickets a repo's config §3b "Intake query" finds are triaged and admitted into the
// running batch with no Stage 3 plan approval, where config §3 autopilot-workers is `yes`. What would
// need the person before a worker starts goes to the check-in digest instead, never to a question.
// The supervisor runs it each tick; it searches Jira at most every INTAKE_EVERY_MS.
//
//   node intake.mjs run [--json] [--force]   one intake now (--force: whether or not one is due)
//   node intake.mjs forget <TICKET>          take a ticket out of the register: the next intake triages it again
//   node intake.mjs admit <TICKET>... [--by <who>] [--front] [--json]
//                                            /desk-admit: the same checks on tickets the person names, now
//
// Each ticket the query finds, once (the register is <state>/intake.json):
//   - already in the queue or another batch, or already admitted or handed on: nothing;
//   - an epic: handed to the digest untriaged, pointing at /desk-admit, which plans it as a feature batch;
//   - a child of an epic whose feature batch is live: not admitted, the report naming that batch and
//     pointing at /desk-admit, which adds it there;
//   - triaged (triage.sh), then handed to the digest for lane C or D, a blocking lint finding (or a
//     lint that did not run), open triage questions (or Jira facts that could not be read), size L
//     or XL, or a blocker that is not done and not in the batch;
//   - otherwise admitted (queue.mjs admit --by intake), held behind every blocker in the batch in the
//     same write.
// With no queue, or one whose tickets are all done with no PR open, a batch is started for it
// (`standing-<time>`, handed to the supervisor at once). A batch not handed over, an empty one included
// (a session between `queue.mjs init` and its plan), is a session's and gets nothing until it is
// handed over; so does a batch on a base, whose tickets merge there.
// At most MAX_TRIAGE tickets are triaged a run, and the search reads one page of SEARCH_MAX; the
// report says when either leaves tickets for later.
//
// `admit` is the same gate for tickets named by hand: no search, no interval and no cap, every one
// triaged afresh, and what fails a check is refused back to the person (exit 11) rather than handed to
// the digest. It admits only into a batch the supervisor runs, or starts a standing one as intake does.
// An epic is reported as one to plan as its own feature batch beside the standing batch (the
// /desk-autopilot epic flow), unless a feature batch is already live; a child of an epic whose feature
// batch is live is admitted into that batch, held behind its blockers there and the unfinished
// children it collides with. The person naming it is the approval.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { isEpic } from './desk-q-eta.mjs';
import { designGap, needsPersonLane, readQueue as readQueueAt } from './batch-state.mjs';
import { belongsElsewhere, liveBatch, finished, prOpen, listBatches } from './batches.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const INTAKE_EVERY_MS = 15 * 60 * 1000;
export const MAX_TRIAGE = 3;
// Jira's largest page for a search returning fields; desk-jira search reads one page.
export const SEARCH_MAX = 100;
// A triage that fails this many runs in a row is handed on rather than paid for again.
export const TRIAGE_TRIES = 3;

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const lastLine = (r) => `${r.stderr ?? ''}${r.stdout ?? ''}${r.error?.message ?? ''}`.trim().split('\n').pop() || `exited ${r.status ?? r.signal}`;

// The query, or null when the row is unset, TODO or none: no intake runs.
export function intakeQuery(raw = E.configValue('intake-query')) {
  const v = String(raw ?? '').trim();
  return !v || /^todo\b/i.test(v) || E.isNone(v) ? null : v;
}

// ---- the register ------------------------------------------------------------------------------
// {last_run, tickets: {KEY: {at, outcome: admitted | handed | triage_failed | elsewhere, text, tries, batch}}}
// `batch` is the other batch an `elsewhere` ticket belongs to.
export const intakePath = (state) => join(state, 'intake.json');
export function readIntake(state) {
  const r = readJson(intakePath(state), null);
  return { last_run: r?.last_run ?? null, tickets: r?.tickets ?? {} };
}
const writeIntake = (state, r) => writeFileSync(intakePath(state), `${JSON.stringify(r, null, 2)}\n`);

// What the digest lists: every ticket intake handed on, with why.
export const handedByIntake = (state) => Object.entries(readIntake(state).tickets)
  .filter(([, e]) => e.outcome === 'handed').map(([ticket, e]) => ({ ticket, text: e.text, at: e.at }));

// Why a triage record keeps its ticket from a worker, one reason each: [] admits it.
const lintBlocking = (r) => (r.lint ?? []).filter((f) => f.severity === 'blocking');
export function intakeReasons(r) {
  const out = [];
  if (needsPersonLane(r)) out.push(`lane ${r.lane}: ${r.lane === 'D' ? `${designGap(r)}; ` : ''}${String(r.lane_reason ?? 'needs a person').slice(0, 160)}`);
  if (r.lint_error) out.push(`lint did not run (${r.lint_error})`);
  for (const f of lintBlocking(r)) out.push(`lint (blocking): ${f.message}`);
  if (r.facts_error) out.push(`its Jira facts could not be read (${r.facts_error})`);
  const unknowns = r.unknowns ?? [];
  if (unknowns.length) out.push(`open question(s): ${unknowns.join(' · ')}`);
  const size = String(r.size ?? '').toUpperCase();
  if (['L', 'XL'].includes(size)) out.push(`size ${size}: it needs splitting before a worker takes it`);
  return out;
}

// Blockers not yet done, by key.
const openBlockers = (r) => (Array.isArray(r.blockers) ? r.blockers : []).filter((b) => b.category !== 'done').map((b) => b.key);

// ---- the batch ---------------------------------------------------------------------------------
export { prOpen };
// Free for a standing batch: no queue, or a finished one (batches.mjs). queue.mjs init --standing checks
// the same under its lock.
const free = (q) => !q || finished(q);
// Why no ticket may join this batch now: 'base', 'session' (not handed over), or null.
const closed = (b) => (!b || free(b) ? null : b.base ? 'base' : b.supervised !== true ? 'session' : null);
// Why intake admits nothing into this batch now, or null.
const waitFor = (b) => ({
  base: () => `intake: admits nothing while batch ${b.batch ?? '?'} runs on base ${b.base}: its tickets merge there, and intake's go to the default branch`,
  session: () => `intake: admits nothing while batch ${b.batch ?? '?'} is not handed over (queue.mjs set-batch supervised=true): it joins that batch once it is`,
}[closed(b)]?.() ?? null);
const readQueue = () => { const qf = E.queueFile(); return existsSync(qf) ? JSON.parse(readFileSync(qf, 'utf8')) : null; };

const queueCmdIn = (env, args) => spawnSync(process.execPath, [join(HERE, 'queue.mjs'), ...args], { encoding: 'utf8', env });
const queueCmd = (...args) => queueCmdIn(process.env, args);
// The environment that points queue.mjs and triage.sh at named batch `b` (listBatches), whatever this
// one pins: the batch's base comes from its queue, never this process's default branch.
const batchEnv = (b) => {
  const { DESK_DEFAULT_BRANCH: _pinned, ...env } = process.env;
  return { ...env, DESK_BATCH: b.name, DESK_QUEUE: b.queue, DESK_AUTOPILOT_STATE: b.state };
};
// The named batches that are live (listed, readable and not finished): feature batches, by name.
function liveFeatureBatches() {
  try { return listBatches().filter((b) => b.name && liveBatch(b.name)); } catch { return []; /* outside a repo there are none */ }
}

// ---- one run -----------------------------------------------------------------------------------
export function runIntake({ state = E.stateDir(), force = false, now = new Date() } = {}) {
  const query = intakeQuery();
  if (!query) return { ran: false, lines: [] };
  mkdirSync(state, { recursive: true });
  const reg = readIntake(state);
  if (!force && reg.last_run && now - Date.parse(reg.last_run) < INTAKE_EVERY_MS) return { ran: false, lines: [] };
  return withLock(state, now, () => intake({ state, query, reg, now }));
}

// One intake at a time, by hand or not: two would triage, and admit, the same ticket twice.
function withLock(state, now, fn) {
  const lockFile = join(state, 'intake.lock');
  const holder = readJson(lockFile, null)?.pid;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  if (holder && holder !== process.pid && alive(holder)) return { ran: false, lines: [`intake: skipped, another intake is running (pid ${holder})`] };
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, since: now.toISOString() }));
  try { return fn(); }
  finally { try { if (readJson(lockFile, null)?.pid === process.pid) rmSync(lockFile); } catch { /* gone */ } }
}

// Blockers first: each round takes the tickets none of the rest still blocks (a cycle goes last, as found).
function blockersFirst(recs) {
  const order = [];
  for (let rest = Object.keys(recs); rest.length;) {
    const ready = rest.filter((k) => !openBlockers(recs[k]).some((b) => b !== k && rest.includes(b)));
    const take = ready.length ? ready : rest;
    order.push(...take);
    rest = rest.filter((k) => !take.includes(k));
  }
  return order;
}

// Run triage.sh for one ticket, in the batch `env` names: its record, or why there is none.
function triage(key, state, env = process.env) {
  const t = spawnSync(join(HERE, 'triage.sh'), [key], { encoding: 'utf8', env, maxBuffer: 64 << 20 });
  const rec = t.status === 0 ? readJson(join(state, 'triage', `${key}.json`), null) : null;
  return rec ? { rec } : { why: t.status === 0 ? 'triage wrote no record' : `triage failed: ${lastLine(t)}` };
}

// Every reason a triaged ticket stays out of this batch: [] admits it. A blocker the batch will not
// merge leaves nothing to release the ticket.
function reasonsAgainst(rec, tickets) {
  const reasons = intakeReasons(rec);
  for (const b of openBlockers(rec).filter((x) => !tickets[x] || tickets[x].state === 'failed')) reasons.push(`blocked by ${b}, which is not done and not in the batch: add it to the batch, or settle the link`);
  return reasons;
}

// A standing batch for intake's tickets, replacing the finished one found (or none): its name, or why not.
// queue.mjs re-checks under its lock that the queue is still the one found free, and hands the new
// batch to the supervisor in the same write.
function startStanding(cur, now) {
  const name = `standing-${now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`;
  const init = queueCmd('init', name, '--standing', '--if-batch', cur ? String(cur.batch) : 'none');
  return init.status === 0 ? { name } : { why: lastLine(init) };
}

// Admit one ticket that passed, held behind every blocker in the batch in the same write, so no pass
// sees it runnable first: the held blockers, or why queue.mjs refused.
function admitHeld(key, rec, tickets, by) {
  const held = openBlockers(rec).filter((b) => tickets[b]);
  const a = queueCmd('admit', key, '--by', by, ...(held.length ? ['--hold', held.join(',')] : []));
  return a.status === 0 ? { held } : { why: lastLine(a) };
}
const laneSize = (rec) => `lane ${rec.lane ?? '?'}${rec.size ? `, size ${rec.size}` : ''}`;
const heldText = (held) => (held.length ? `, held behind ${held.join(', ')}` : '');

// One triaged ticket into the batch, both paths: the queue read again whole (triage took minutes, and a
// session may have started its own batch meanwhile), the batch gate, the ticket's checks, a standing
// batch started where none is live, then the admit. Returns the one thing that happened:
// {unreadable}, {closed, cur}, {elsewhere}, {reasons}, {startFailed}, {admitFailed}, or {batch, held, started}.
// Without mayStart, a free batch is closed as 'free' rather than replaced.
function placeOne(key, rec, { started, by, now, mayStart = true }) {
  let cur;
  try { cur = readQueue(); } catch (e) { return { unreadable: `the queue at ${E.queueFile()} cannot be read (${e.message})` }; }
  if (closed(cur)) return { closed: closed(cur), cur };
  const away = belongsElsewhere(key, rec, E.queueFile());
  if (away) return { elsewhere: away };
  // A new batch keeps none of a finished one's tickets, so every open blocker is then outside it.
  const startNew = !started && free(cur);
  if (startNew && !mayStart) return { closed: 'free', cur };
  const tickets = startNew ? {} : cur?.tickets ?? {};
  const reasons = reasonsAgainst(rec, tickets);
  if (reasons.length) return { reasons };
  let batch = cur?.batch;
  if (startNew) {
    const st = startStanding(cur, now);
    if (!st.name) return { startFailed: st.why };
    batch = started = st.name;
  }
  const a = admitHeld(key, rec, tickets, by);
  return a.held ? { batch, held: a.held, started: startNew ? started : null } : { admitFailed: a.why, started: startNew ? started : null };
}

function intake({ state, query, reg, now }) {
  const lines = [];
  const admitted = [];
  const handed = [];
  const done = (extra = {}) => ({ ran: true, lines, admitted, handed, ...extra });
  reg.last_run = now.toISOString();
  writeIntake(state, reg);

  const perm = E.permission('autopilot-workers');
  if (perm !== 'yes') {
    lines.push(`intake: admits nothing: standing intake needs config §3 ${E.permissionKey('autopilot-workers')} to be "yes" (it is "${perm}")`);
    return done();
  }

  let q;
  try { q = readQueue(); } catch (e) { lines.push(`intake: admits nothing: the queue at ${E.queueFile()} cannot be read (${e.message})`); return done(); }
  // A batch a session is still planning is the session's: intake joins it once it is handed over.
  if (waitFor(q)) { lines.push(waitFor(q)); return done(); }

  const r = spawnSync('desk-jira', ['search', query, String(SEARCH_MAX), '--json'], { encoding: 'utf8', env: process.env, maxBuffer: 64 << 20 });
  let found;
  try {
    if (r.status !== 0) throw new Error(lastLine(r));
    found = (JSON.parse(r.stdout).issues ?? []).filter((i) => typeof i?.key === 'string');
  } catch (e) {
    lines.push(`intake: admits nothing: the Jira search failed (${e.message}); the next intake tries again`);
    // Not a run that counts: the next tick searches again rather than waiting out the interval.
    reg.last_run = null;
    writeIntake(state, reg);
    return done();
  }
  // One page: a full one may hide matches past it, so every report says so rather than none.
  if (found.length >= SEARCH_MAX) lines.push(`intake: the search returned its limit of ${SEARCH_MAX} tickets: matches past them are not seen while these still match, so narrow the query`);
  const hand = (key, text) => {
    reg.tickets[key] = { at: now.toISOString(), outcome: 'handed', text };
    writeIntake(state, reg);
    handed.push(key);
    lines.push(`intake: handed ${key} to the digest: ${text}`);
  };
  // A ticket another batch holds is that batch's: never triaged, admitted or handed on here. One skipped
  // for its epic's feature batch is skipped while that batch is live. One that cannot be checked, because
  // another batch's queue cannot be read, waits for the next intake and is said to.
  const unchecked = new Map();
  const skipped = (e) => e?.outcome === 'elsewhere' && liveBatch(e.batch);
  const away = (k) => { const a = belongsElsewhere(k, null, E.queueFile()); if (a?.unreadable) unchecked.set(k, a.why); return a; };
  const isNew = (k) => E.SAFE_ID.test(k) && !q?.tickets?.[k] && !['admitted', 'handed'].includes(reg.tickets[k]?.outcome)
    && !skipped(reg.tickets[k]) && !away(k);
  // An epic is a feature batch's, with its spine and owner table approved first: never a worker's.
  for (const i of found.filter((x) => isNew(x.key) && isEpic(x.fields?.issuetype))) hand(i.key, `an epic: /desk-admit ${i.key} plans it as a feature batch beside the standing batch`);
  const fresh = found.map((i) => i.key).filter(isNew);
  for (const why of unchecked.values()) lines.push(`intake: not admitted: ${why}; the next intake tries again`);
  if (!fresh.length) return done();
  const triageNow = fresh.slice(0, MAX_TRIAGE);
  if (fresh.length > triageNow.length) lines.push(`intake: ${fresh.length - triageNow.length} more ticket(s) wait for the next intake (${fresh.slice(MAX_TRIAGE).join(', ')}): ${MAX_TRIAGE} are triaged a run`);

  // Triage every one first, so a blocker found in the same run is admitted before what it blocks.
  const recs = {};
  for (const key of triageNow) {
    const { rec, why } = triage(key, state);
    if (rec) { recs[key] = rec; continue; }
    const tries = (reg.tickets[key]?.tries ?? 0) + 1;
    if (tries >= TRIAGE_TRIES) {
      reg.tickets[key] = { at: now.toISOString(), outcome: 'handed', text: `${why} (${tries} intakes in a row)`, tries };
      handed.push(key);
      lines.push(`intake: handed ${key} to the digest: ${why}, ${tries} intakes in a row`);
    } else {
      reg.tickets[key] = { at: now.toISOString(), outcome: 'triage_failed', text: why, tries };
      lines.push(`intake: ${key} not admitted: ${why}; the next intake tries again`);
    }
  }
  writeIntake(state, reg);
  const order = blockersFirst(recs);
  let started = null;
  for (const key of order) {
    const rec = recs[key];
    const r = placeOne(key, rec, { started, by: 'intake', now });
    if (r.unreadable) { lines.push(`intake: admits nothing more: ${r.unreadable}`); return done({ started }); }
    if (r.closed) { lines.push(waitFor(r.cur)); return done({ started }); }
    if (r.elsewhere?.unreadable) { lines.push(`intake: not admitted: ${r.elsewhere.why}; the next intake tries again`); continue; }
    if (r.elsewhere) {
      const why = r.elsewhere.epic ? `${r.elsewhere.why}: /desk-admit ${key} adds it to that batch` : r.elsewhere.why;
      reg.tickets[key] = { at: now.toISOString(), outcome: 'elsewhere', batch: r.elsewhere.batch, text: why };
      writeIntake(state, reg);
      lines.push(`intake: ${key} not admitted: ${why}`);
      continue;
    }
    if (r.reasons) { hand(key, r.reasons.join('; ')); continue; }
    if (r.startFailed) {
      lines.push(`intake: admits nothing: a standing batch could not be started (${r.startFailed}); the next intake tries again`);
      reg.last_run = null;
      writeIntake(state, reg);
      return done({ started });
    }
    if (r.started) { started = r.started; lines.push(`intake: started standing batch ${started}, handed to the supervisor`); }
    if (r.admitFailed) { lines.push(`intake: ${key} not admitted: ${r.admitFailed}; the next intake tries again`); continue; }
    reg.tickets[key] = { at: now.toISOString(), outcome: 'admitted', text: `${laneSize(rec)}${heldText(r.held)}` };
    writeIntake(state, reg);
    admitted.push(key);
    lines.push(`intake: admitted ${key} by intake into batch ${r.batch ?? '?'} (${laneSize(rec)})${heldText(r.held)}`);
  }
  return done({ started });
}

// ---- by hand -----------------------------------------------------------------------------------
// /desk-admit: the person names the tickets. The same checks as intake, run now on every one, with
// what fails them refused back to the person instead of handed to the digest. A ticket admitted this
// way is recorded in the register as admitted, so intake never takes it again.
export function admitByHand(keys, { state = E.stateDir(), by = 'hand', front = false, now = new Date() } = {}) {
  mkdirSync(state, { recursive: true });
  return withLock(state, now, () => byHand([...new Set(keys)], { state, by, front, now }));
}

// Admit a child of `epic` into that epic's live feature batch, triaged again there: on the batch's
// base, where the spine and the other children have added files, and into its state, where queue.mjs
// reads it. Held behind the spine until it is done (as plan-batch holds every child it seeds), its
// blockers there, and every unfinished ticket there whose files it shares, so it waits for their PRs
// to merge. -> {batch, held, rec} or {why}.
function joinFeature(key, epic, { by }) {
  const b = liveFeatureBatches().find((x) => x.name === epic);
  if (!b) return { why: `its epic ${epic}'s feature batch is no longer live: run /desk-admit ${key} again` };
  const t = triage(key, b.state, batchEnv(b));
  if (!t.rec) return { why: `${t.why} in feature batch ${epic}: fix it and run /desk-admit ${key} again` };
  let fq;
  try { fq = readQueueAt(b.queue); } catch (e) { return { why: `feature batch ${epic}'s queue cannot be read (${e.message})` }; }
  const tickets = fq.tickets ?? {};
  const reasons = reasonsAgainst(t.rec, tickets);
  if (reasons.length) return { why: reasons.join('; ') };
  const spine = fq.feature === true && fq.spine && fq.spine !== key && tickets[fq.spine] && tickets[fq.spine].state !== 'done' ? [fq.spine] : [];
  const holds = [...new Set([...spine, ...openBlockers(t.rec).filter((x) => tickets[x])])];
  const a = queueCmdIn(batchEnv(b), ['admit', key, '--by', by, '--hold-collisions', ...(holds.length ? ['--hold', holds.join(',')] : [])]);
  if (a.status !== 0) return { why: lastLine(a) };
  let held = holds;
  try { held = String(readQueueAt(b.queue).tickets?.[key]?.held_by ?? '').split('|').filter(Boolean); } catch { /* admitted: say the holds asked for */ }
  return { batch: b, held, rec: t.rec };
}

function byHand(keys, { state, by, front, now }) {
  const lines = [];
  const admitted = [];
  const refused = [];
  // Epics to plan as a feature batch beside the standing batch: the /desk-autopilot epic flow.
  const plan = [];
  const refuse = (key, text) => { refused.push(key); lines.push(`not admitted ${key}: ${text}`); };
  const done = (extra = {}) => ({ ran: true, lines, admitted, refused, plan, ...extra });
  // Starting a standing batch has no plan approval, so it needs what standing intake needs.
  const mayStart = E.permission('autopilot-workers') === 'yes';
  // Why the tickets have nowhere to go, or null: nothing is triaged for a batch they cannot join.
  const said = (code, b) => ({
    base: () => (b.epic && !E.batchName()
      ? `batch ${b.batch ?? '?'} runs on base ${b.base} in the standing slot: move it to epic ${b.epic}'s own slot (node ${join(HERE, 'move-batch.mjs')}), then admit these again`
      : `batch ${b.batch ?? '?'} runs on base ${b.base}: run /desk-autopilot for these in a session`),
    session: () => `batch ${b.batch ?? '?'} is run by a session, not the supervisor: send these tickets to that session (ListAgents names it) and let it admit them`,
    free: () => `no batch is live, and starting one without a plan approval needs config §3 ${E.permissionKey('autopilot-workers')} to be "yes" (it is "${E.permission('autopilot-workers')}"): run /desk-autopilot ${keys.join(' ')}`,
  }[code]?.() ?? null);
  const nowhere = (b) => said(closed(b) ?? (free(b) && !mayStart ? 'free' : null), b);
  let q;
  try { q = readQueue(); } catch (e) { lines.push(`admits nothing: the queue at ${E.queueFile()} cannot be read (${e.message})`); return done({ refused: keys }); }
  const why = nowhere(q);
  if (why) { lines.push(`admits nothing: ${why}`); return done({ refused: keys }); }

  // Triage every one first, so a blocker named in the same call is admitted before what it blocks.
  const recs = {};
  for (const key of keys) {
    if (!E.SAFE_ID.test(key)) { refuse(key, 'not a ticket id'); continue; }
    if (q?.tickets?.[key]) { lines.push(`${key} is already in batch ${q.batch ?? '?'} (${q.tickets[key].state})`); continue; }
    const away = belongsElsewhere(key, null, E.queueFile());
    if (away) { refuse(key, away.why); continue; }
    const t = triage(key, state);
    if (!t.rec) { refuse(key, `${t.why}: fix it and run /desk-admit ${key} again`); continue; }
    if (isEpic({ name: t.rec.type })) {
      // A repo runs one feature batch at a time, beside the standing batch.
      const live = liveFeatureBatches();
      if (live.length) { refuse(key, `an epic, and feature batch ${live.map((b) => b.name).join(', ')} is already running: a repo runs one feature batch at a time, so plan ${key} once it finishes`); continue; }
      plan.push(key);
      lines.push(`plan ${key} as a feature batch beside the standing batch: /desk-autopilot ${key}`);
      continue;
    }
    recs[key] = t.rec;
  }
  let started = null;
  for (const key of blockersFirst(recs)) {
    let rec = recs[key];
    let r = placeOne(key, rec, { started, by, now, mayStart });
    if (r.started) { started = r.started; lines.push(`started standing batch ${started}, handed to the supervisor`); }
    // A child of an epic whose feature batch is live joins that batch: the standing queue is untouched.
    let feature = null;
    if (r.elsewhere?.epic) {
      const j = joinFeature(key, r.elsewhere.epic, { by });
      r = j.why ? { admitFailed: `${key} is a child of epic ${r.elsewhere.epic}, but not admitted into its feature batch: ${j.why}` } : { held: j.held };
      feature = j.batch ?? null;
      rec = j.rec ?? rec;
    }
    const fail = r.unreadable ?? (r.closed && said(r.closed, r.cur)) ?? r.elsewhere?.why ?? r.reasons?.join('; ')
      ?? (r.startFailed && `a standing batch could not be started (${r.startFailed})`) ?? r.admitFailed;
    if (fail) { refuse(key, fail); continue; }
    const reg = readIntake(state);
    reg.tickets[key] = { at: now.toISOString(), outcome: 'admitted', text: `${laneSize(rec)}${heldText(r.held)}, by ${by}` };
    writeIntake(state, reg);
    admitted.push(key);
    lines.push(`admitted ${key} by ${by} into ${feature ? `feature batch ${feature.name}` : `batch ${r.batch ?? '?'}`} (${laneSize(rec)})${heldText(r.held)}`);
    if (front) {
      const f = feature ? queueCmdIn(batchEnv(feature), ['front', key]) : queueCmd('front', key);
      lines.push(f.status === 0 ? f.stdout.trim() : `${key} not moved to the front: ${lastLine(f)}`);
    }
  }
  if (admitted.length) lines.push(`the supervisor's next tick picks ${admitted.length === 1 ? 'it' : 'them'} up`);
  return done({ started });
}

export function forget(key, state = E.stateDir()) {
  const reg = readIntake(state);
  if (!reg.tickets[key]) return false;
  delete reg.tickets[key];
  writeIntake(state, reg);
  return true;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const { EXIT, crashShowsPerson, describeCrash } = await import('./batch-state.mjs');
  const [cmd, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  crashShowsPerson((e) => (json ? console.log(JSON.stringify({ ran: false, error: describeCrash(e), lines: [`intake: failed: ${describeCrash(e)}`] })) : console.error(`intake: ${describeCrash(e)}`)));
  if (cmd === 'run') {
    const r = runIntake({ force: rest.includes('--force') });
    if (json) console.log(JSON.stringify(r));
    else console.log(r.lines.length ? r.lines.join('\n') : r.ran ? 'intake: nothing new' : 'intake: not run (no §3b Intake query, or not due)');
  } else if (cmd === 'admit' && rest.filter((a) => !a.startsWith('--')).length > (rest.includes('--by') ? 1 : 0)) {
    const byAt = rest.indexOf('--by');
    const by = byAt >= 0 ? rest[byAt + 1] : 'hand';
    if (!E.SAFE_ID.test(by ?? '')) { console.error('intake: --by wants a name with no spaces'); process.exit(EXIT.SHOW_PERSON); }
    const keys = rest.filter((a, i) => !a.startsWith('--') && !(byAt >= 0 && i === byAt + 1));
    const r = admitByHand(keys, { by, front: rest.includes('--front') });
    if (json) console.log(JSON.stringify(r));
    else console.log(r.lines.join('\n'));
    if (r.ran === false || r.refused.length) process.exitCode = EXIT.SHOW_PERSON;
  } else if (cmd === 'forget' && rest[0] && E.SAFE_ID.test(rest[0])) {
    console.log(forget(rest[0]) ? `intake: ${rest[0]} forgotten: the next intake triages it again if the query still finds it` : `intake: ${rest[0]} is not in the register`);
  } else {
    console.error('usage: intake.mjs run [--json] [--force] | intake.mjs forget <TICKET> | intake.mjs admit <TICKET>... [--by <who>] [--front] [--json]');
    process.exit(EXIT.SHOW_PERSON);
  }
}
