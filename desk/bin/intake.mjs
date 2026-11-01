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
//   - done in Jira, as the search shows it: said once, and neither triaged nor admitted;
//   - an epic: triaged, and its feature batch started beside the standing batch with its plan drafted
//     and left for the person (epic-plan.mjs), one a run; handed to the digest when it cannot start,
//     and left for later while another feature batch is live;
//   - a child of an epic whose feature batch is live: not admitted, the report naming that batch and
//     pointing at /desk-admit, which adds it there;
//   - one whose files in scope are not on the standing batch's base but are on a running named batch's:
//     admitted there when the supervisor runs it, else pointed at /desk-admit as a child is; on two such
//     bases, handed to the digest to say which. One blocked by a ticket in another live batch is
//     routed to that batch the same way;
//   - triaged (triage.sh), then handed to the digest for lane C or D, a blocking lint finding (or a
//     lint that did not run), open triage questions (or Jira facts that could not be read), size L
//     or XL, or a blocker that failed in the batch. A question is open only on a reserved topic or
//     with no recommendation: each call triage took on its recommendation is logged as a decision
//     when the ticket is admitted (decisions.mjs triageCalls);
//   - otherwise admitted (queue.mjs admit --by intake), held in the same write behind every open
//     blocker in the batch, and every blocker in no batch until it is Done and its code is on the
//     batch's base (--hold-outside, lifted by pass.mjs); or, when it links a Claude Design canvas no
//     worker can read, parked on that instead, so Needs you names the artifact to snapshot or share.
// With no queue, or one whose tickets are all done with no PR open, a batch is started for it
// (`standing-<time>`, handed to the supervisor at once). A batch not handed over, an empty one included
// (a session between `queue.mjs init` and its plan), is a session's and gets nothing until it is
// handed over; so does a batch on a base, whose tickets merge there.
// At most MAX_TRIAGE tickets are triaged a run, and the search reads one page of SEARCH_MAX; the
// report says when either leaves tickets for later.
//
// `admit` is the same gate for tickets named by hand: no search, no interval and no cap, every one
// triaged afresh unless Jira has it done (then it is said so, exit 0), and what fails a check is refused back to the person (exit 11) rather than handed to
// the digest; so is one linking a Claude Design canvas with no snapshot, which the person's session
// snapshots first. It admits only into a batch the supervisor runs, or starts a standing one as intake does.
// An epic has its own feature batch started beside the standing batch and any other epic's, its plan
// drafted headless and left for the person in needs-you (epic-plan.mjs); without config §3
// autopilot-workers `yes` it is reported as one to plan in a session (the /desk-autopilot epic flow).
// Either way it is refused while its own feature batch is already live. A child of an epic whose feature
// batch is live is admitted into that batch, held behind its blockers there and the unfinished
// children it collides with. The person naming it is the approval. The open blockers in no batch of
// what it admits are printed as `admit next: <KEY>...`, for /desk-admit to admit with no question.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { isEpic } from './desk-q-eta.mjs';
import { designGap, designPark, needsPersonLane, unreadCanvases, readQueue as readQueueAt, keyPattern } from './batch-state.mjs';
import { belongsElsewhere, liveBatch, finished, prOpen, listBatches, slotFor } from './batches.mjs';
import { startEpic, clearAbandoned } from './epic-plan.mjs';
import { triageCalls, decisionEntry, appendDecisions } from './decisions.mjs';

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

// Why a triage record keeps its ticket from a worker, one reason each: [] admits it. A canvas no worker
// can read is not a lint reason as well: the ticket is admitted parked on it (designPark), which names it.
const lintBlocking = (r) => {
  const unread = unreadCanvases(r);
  return (r.lint ?? []).filter((f) => f.severity === 'blocking' && !(f.rule === 'design' && unread.some((u) => f.message.includes(u))));
};
export function intakeReasons(r) {
  const out = [];
  if (needsPersonLane(r)) out.push(`lane ${r.lane}: ${r.lane === 'D' ? `${designGap(r)}; ` : ''}${String(r.lane_reason ?? 'needs a person').slice(0, 160)}`);
  if (r.lint_error) out.push(`lint did not run (${r.lint_error})`);
  for (const f of lintBlocking(r)) out.push(`lint (blocking): ${f.message}`);
  if (r.facts_error) out.push(`its Jira facts could not be read (${r.facts_error})`);
  const { ask } = triageCalls(r);
  if (ask.length) out.push(`open question(s): ${ask.join(' · ')}`);
  const size = String(r.size ?? '').toUpperCase();
  if (['L', 'XL'].includes(size)) out.push(`size ${size}: it needs splitting before a worker takes it`);
  return out;
}

// Blockers not yet done, by key.
const openBlockers = (r) => (Array.isArray(r.blockers) ? r.blockers : []).filter((b) => b.category !== 'done').map((b) => b.key);

// Whether ticket `key`'s code is on `base`: true once a PR naming it has merged into `base`, or into
// another branch with its merge commit on origin/<base>, and when no PR is left to land (none, or only
// closed ones); false while one is open or merged only elsewhere; null when GitHub cannot be read.
export function landedOn(key, base) {
  let repo, root;
  try { repo = E.ghRepo(); root = E.repoRoot(); } catch { return null; }
  const r = spawnSync('gh', ['pr', 'list', '--repo', repo, '--state', 'all', '--search', key, '--limit', '50',
    '--json', 'number,state,title,headRefName,baseRefName,mergeCommit'], { encoding: 'utf8' });
  let prs;
  try { prs = r.status === 0 ? JSON.parse(r.stdout) : null; } catch { prs = null; }
  if (!Array.isArray(prs)) return null;
  const names = new RegExp(keyPattern(key));
  const mine = prs.filter((p) => names.test(`${p?.title ?? ''} ${p?.headRefName ?? ''}`));
  const reaches = (sha) => !!sha && spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', sha, `origin/${base}`], { stdio: 'ignore' }).status === 0;
  if (mine.some((p) => p.state === 'MERGED' && (p.baseRefName === base || reaches(p.mergeCommit?.oid)))) return true;
  return !mine.some((p) => p.state === 'OPEN' || p.state === 'MERGED');
}

// How a triaged ticket's blockers hold it in a batch holding `tickets`, on `base`: `held`, those in
// the batch not merged there, open in Jira or Done with a PR still to merge, released as they merge;
// `outside`, those in no batch, open or Done with their code not yet on `base`, lifted by the pass once
// each is both; `failed`, open ones that failed in the batch, which nothing releases.
function holdsFor(rec, tickets, base) {
  const out = { held: [], outside: [], failed: [] };
  for (const b of Array.isArray(rec.blockers) ? rec.blockers : []) {
    const t = tickets[b.key];
    if (t) {
      if (b.category !== 'done') out[t.state === 'failed' ? 'failed' : 'held'].push(b.key);
      else if (t.state !== 'failed' && !t.merged_at && !(t.state === 'done' && t.result?.pr == null)) out.held.push(b.key);
    } else if (b.category !== 'done' || landedOn(b.key, base) !== true) out.outside.push(b.key);
  }
  return out;
}

// ---- the batch ---------------------------------------------------------------------------------
export { prOpen };
// Free for a standing batch: no queue, or a finished one (batches.mjs). queue.mjs init --standing checks
// the same under its lock.
const free = (q) => !q || finished(q);
// Why no ticket may join this batch now: 'base', 'session' (not handed over), or null.
const closed = (b) => (!b || free(b) ? null : b.base ? 'base' : b.supervised !== true ? 'session' : null);
// Where move-batch.mjs would move standing batch `b` on a base, or null: in a named batch, or with no slot.
const moveTo = (b) => {
  if (E.batchName() || !b?.base) return null;
  const s = slotFor(b);
  return s.why ? null : s.by === 'epic' ? `epic ${s.name}'s own slot` : `its own slot ${s.name}, named after its branch`;
};
// Why intake admits nothing into this batch now, or null.
const waitFor = (b) => ({
  base: () => `intake: admits nothing while batch ${b.batch ?? '?'} runs on base ${b.base}: its tickets merge there, and intake's go to the default branch${moveTo(b) ? `. Move it to ${moveTo(b)} to free the standing slot: node ${join(HERE, 'move-batch.mjs')}` : ''}`,
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
// Whether live named batch `name` is handed to the supervisor.
function handedOver(name) {
  const b = liveFeatureBatches().find((x) => x.name === name);
  try { return !!b && readQueueAt(b.queue).supervised === true; } catch { return false; }
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

// Every reason a triaged ticket stays out of this batch, given its holds (holdsFor): [] admits it. A
// blocker that failed in the batch leaves nothing to release the ticket.
function reasonsAgainst(rec, holds) {
  const reasons = intakeReasons(rec);
  for (const b of holds.failed) reasons.push(`blocked by ${b}, which failed in the batch: requeue or drop it, or settle the link`);
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

// queue.mjs admit's arguments for a ticket's holds (holdsFor).
const holdArgs = ({ held, outside }) => [...(held.length ? ['--hold', held.join(',')] : []), ...(outside.length ? ['--hold-outside', outside.join(',')] : [])];
// Admit one ticket that passed, held behind its blockers (holdsFor) in the same write, so no pass sees
// it runnable first: {held, outside}, or why queue.mjs refused. One whose design no worker can read is
// admitted parked on it, its holds kept for when it is requeued (queue.mjs admit).
function admitHeld(key, holds, by) {
  const a = queueCmd('admit', key, '--by', by, ...holdArgs(holds));
  return a.status === 0 ? { held: holds.held, outside: holds.outside } : { why: lastLine(a) };
}
// The register entry for an epic whose feature batch was started, so intake never takes it again.
const epicEntry = (s, by, now) => ({ at: now.toISOString(), outcome: 'admitted', batch: s.batch,
  text: `feature batch ${s.batch} started, ${s.children.length} ${s.children.length === 1 ? 'child' : 'children'} held behind its plan, by ${by}` });
function noteEpic(state, key, s, by, now) {
  const reg = readIntake(state);
  reg.tickets[key] = epicEntry(s, by, now);
  writeIntake(state, reg);
}
const laneSize = (rec) => `lane ${rec.lane ?? '?'}${rec.size ? `, size ${rec.size}` : ''}${rec.verify_only ? ', verify-only' : ''}`;
// How an admitted ticket is held, from its placement's {held, outside, base}. `refused`, blockers this
// call did not admit, are named as such.
const heldText = ({ held = [], outside = [], base = null }, refused = new Set()) => `${held.length ? `, held behind ${held.join(', ')}` : ''}${outside.length
  ? `, waiting for ${outside.map((k) => (refused.has(k) ? `${k} (not admitted in this call)` : k)).join(', ')}, outside the batch, until ${outside.length === 1 ? 'it is' : 'each is'} Done and on ${base ?? 'its base'}` : ''}`;

// Logs each call the triage record took on its recommendation to the decision log in `state`, the
// state of the batch the ticket joined, for the check-in digest: ", took N call(s) …", or ''.
function logTaken(key, rec, state) {
  const { taken } = triageCalls(rec);
  if (!taken.length) return '';
  let repo = null;
  try { repo = E.ghRepo(); } catch { /* outside a repo: logged without one */ }
  appendDecisions(taken.map((decision) => decisionEntry({ decision, ticket: key, run: 'triage', repo, source: 'triage' })), state);
  return `, took ${taken.length} call(s) on triage's recommendation (logged)`;
}

// The ticket's Jira status name when its status category is done, else null. Only a tracker key is
// read, and a read that fails is not done here: triage reads the ticket and reports it.
function doneInJira(key) {
  const k = E.ticketKind(key);
  if (!k.ok || k.kind !== 'tracker') return null;
  const r = spawnSync('desk-jira', ['get', key, '--json'], { encoding: 'utf8', env: process.env, maxBuffer: 64 << 20 });
  if (r.status !== 0) return null;
  try {
    const s = JSON.parse(r.stdout)?.fields?.status;
    return s?.statusCategory?.key === 'done' ? String(s.name || 'Done') : null;
  } catch { return null; }
}
// A search result whose status category is done: its status name, or null.
const doneInSearch = (issue) => (issue?.fields?.status?.statusCategory?.key === 'done' ? String(issue.fields.status.name || 'Done') : null);

// Whether `path` is on origin's `base`, as the passes fetch it.
const onBase = (base, path) => spawnSync('git', ['-C', E.repoRoot(), 'cat-file', '-e', `origin/${base}:${path}`], { stdio: 'ignore' }).status === 0;
// The running batch on another base that has files the ticket names and its own base `own` lacks: one
// such batch is where it joins, {route, supervised, why}; two are a question, {reasons}; none, null.
function baseRoute(key, rec, own) {
  const files = [...new Set((rec.files_in_scope ?? []).map(String).filter(Boolean))];
  let missing;
  try { missing = files.filter((f) => !onBase(own, f)); } catch { return null; /* outside a repo there are no bases */ }
  if (!missing.length) return null;
  const hits = liveFeatureBatches().flatMap((b) => {
    let bq;
    try { bq = readQueueAt(b.queue); } catch { return []; }
    const on = bq.base && bq.base !== own ? missing.filter((f) => onBase(bq.base, f)) : [];
    return on.length ? [{ name: b.name, base: bq.base, on, supervised: bq.supervised === true }] : [];
  });
  const where = (h) => `batch ${h.name}'s base ${h.base}`;
  if (hits.length > 1) return { reasons: [`it names files not on ${own} that are on ${hits.map((h) => `${where(h)} (${h.on.join(', ')})`).join(' and on ')}: say which batch it joins`] };
  const h = hits[0];
  return h ? { route: h.name, batch: h.name, supervised: h.supervised, why: `${key} names ${h.on.join(', ')}, which ${h.on.length === 1 ? 'is' : 'are'} on ${where(h)} and not on ${own}: it joins that batch` } : null;
}
// The other live batch holding a blocker of the ticket that has not merged or failed there: one such
// batch is where it joins, so it waits on the blocker where the blocker's code lands, {route,
// supervised, why}; two are a question, {reasons}; none, null.
function blockerRoute(key, rec) {
  const keys = (Array.isArray(rec.blockers) ? rec.blockers : []).map((b) => b.key);
  if (!keys.length) return null;
  const own = resolvePath(E.queueFile());
  const hits = liveFeatureBatches().filter((b) => resolvePath(b.queue) !== own).flatMap((b) => {
    let bq;
    try { bq = readQueueAt(b.queue); } catch { return []; }
    const on = keys.filter((k) => bq.tickets?.[k] && !bq.tickets[k].merged_at && bq.tickets[k].state !== 'failed');
    return on.length ? [{ name: b.name, on, supervised: bq.supervised === true }] : [];
  });
  if (hits.length > 1) return { reasons: [`it is blocked by ${hits.map((h) => `${h.on.join(', ')} in batch ${h.name}`).join(' and by ')}: say which batch it joins`] };
  const h = hits[0];
  return h ? { route: h.name, batch: h.name, supervised: h.supervised, why: `${key} is blocked by ${h.on.join(', ')}, in batch ${h.name}: it joins that batch` } : null;
}

// One triaged ticket into the batch, both paths: the queue read again whole (triage took minutes, and a
// session may have started its own batch meanwhile), the batch gate, the ticket's checks, a standing
// batch started where none is live, then the admit. Returns the one thing that happened:
// {unreadable}, {closed, cur}, {elsewhere}, {reasons}, {startFailed}, {admitFailed}, or {batch, base, held, outside, started}.
// Without mayStart, a free batch is closed as 'free' rather than replaced.
function placeOne(key, rec, { started, by, now, mayStart = true }) {
  let cur;
  try { cur = readQueue(); } catch (e) { return { unreadable: `the queue at ${E.queueFile()} cannot be read (${e.message})` }; }
  if (closed(cur)) return { closed: closed(cur), cur };
  const away = belongsElsewhere(key, rec, E.queueFile());
  if (away) return { elsewhere: away };
  const base = cur?.base ?? (E.configValue('default-branch') || 'main');
  const route = baseRoute(key, rec, base) ?? blockerRoute(key, rec);
  if (route?.reasons) return { reasons: route.reasons };
  if (route) return { elsewhere: route };
  // A new batch keeps none of a finished one's tickets, so every open blocker is then outside it.
  const startNew = !started && free(cur);
  if (startNew && !mayStart) return { closed: 'free', cur };
  const holds = holdsFor(rec, startNew ? {} : cur?.tickets ?? {}, base);
  const reasons = reasonsAgainst(rec, holds);
  if (reasons.length) return { reasons };
  let batch = cur?.batch;
  if (startNew) {
    const st = startStanding(cur, now);
    if (!st.name) return { startFailed: st.why };
    batch = started = st.name;
  }
  const a = admitHeld(key, holds, by);
  return a.held ? { batch, base, held: a.held, outside: a.outside, started: startNew ? started : null } : { admitFailed: a.why, started: startNew ? started : null };
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
  // One routed to a session-run batch by its files waits only until that batch is handed over: then the
  // next intake triages it again and joins it there, as the standing batch's own gate does.
  const skipped = (e) => e?.outcome === 'elsewhere' && liveBatch(e.batch) && !(e.handover && handedOver(e.batch));
  const away = (k) => { const a = belongsElsewhere(k, null, E.queueFile()); if (a?.unreadable) unchecked.set(k, a.why); return a; };
  const isNew = (k) => E.SAFE_ID.test(k) && !q?.tickets?.[k] && !['admitted', 'handed'].includes(reg.tickets[k]?.outcome)
    && !skipped(reg.tickets[k]) && !away(k);
  // A feature batch whose start was cut off is discarded, and its epic handed on rather than started
  // again into the same timeout.
  for (const a of clearAbandoned()) hand(a.batch, `an epic, and ${a.text}`);
  // An epic is a feature batch's, never a worker's: one a run has its batch started, and its plan
  // drafted and left for the person, beside the standing batch and any other epic's.
  const epicKeys = found.filter((x) => isEpic(x.fields?.issuetype)).map((x) => x.key).filter(isNew);
  for (const [n, key] of epicKeys.entries()) {
    if (liveFeatureBatches().some((b) => b.name === key)) {
      const text = `an epic, and its feature batch ${key} is already running: its children join that batch`;
      reg.tickets[key] = { at: now.toISOString(), outcome: 'elsewhere', batch: key, text };
      writeIntake(state, reg);
      lines.push(`intake: ${key} not admitted: ${text}`);
      continue;
    }
    if (n > 0) { lines.push(`intake: epic ${key} waits for the next intake: one epic's feature batch is started a run`); continue; }
    const t = triage(key, state);
    if (!t.rec) { lines.push(`intake: epic ${key} not admitted: ${t.why}; the next intake tries again`); continue; }
    const s = startEpic(key, t.rec, { by: 'intake' });
    if (s.why) { hand(key, `an epic, and its feature batch was not started: ${s.why}`); continue; }
    reg.tickets[key] = epicEntry(s, 'intake', now);
    writeIntake(state, reg);
    lines.push(...s.lines.map((l) => `intake: ${l}`));
  }
  // A ticket the search shows done is neither triaged nor admitted, and is said once; one reopened
  // since is taken as any other.
  const candidates = found.filter((i) => !epicKeys.includes(i.key) && isNew(i.key));
  for (const i of candidates.filter((x) => doneInSearch(x) && reg.tickets[x.key]?.outcome !== 'done')) {
    const text = `already done in Jira (${doneInSearch(i)}): nothing triaged or admitted`;
    reg.tickets[i.key] = { at: now.toISOString(), outcome: 'done', text };
    writeIntake(state, reg);
    lines.push(`intake: ${i.key} ${text}`);
  }
  const fresh = candidates.filter((i) => !doneInSearch(i)).map((i) => i.key);
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
    // A ticket whose files are on another running batch's base joins that batch, where the supervisor runs it.
    if (r.elsewhere?.route && r.elsewhere.supervised) {
      const j = joinFeature(key, r.elsewhere.route, { by: 'intake' });
      if (j.why) { hand(key, `${r.elsewhere.why}, but it was not admitted there: ${j.why}`); continue; }
      reg.tickets[key] = { at: now.toISOString(), outcome: 'admitted', batch: r.elsewhere.route, text: `${laneSize(j.rec)}${heldText(j)}${j.took}, into batch ${r.elsewhere.route}` };
      writeIntake(state, reg);
      admitted.push(key);
      lines.push(`intake: admitted ${key} by intake into batch ${r.elsewhere.route} (${laneSize(j.rec)})${heldText(j)}${j.took}: ${r.elsewhere.why}`);
      continue;
    }
    // One a session runs is the session's until it is handed over (closed's 'session'): it waits for that.
    if (r.elsewhere?.route) {
      const why = `${r.elsewhere.why}, once a session hands batch ${r.elsewhere.route} to the supervisor (queue.mjs set-batch supervised=true): /desk-admit ${key} adds it now`;
      reg.tickets[key] = { at: now.toISOString(), outcome: 'elsewhere', batch: r.elsewhere.route, handover: true, text: why };
      writeIntake(state, reg);
      lines.push(`intake: ${key} not admitted yet: ${why}`);
      continue;
    }
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
    const parked = designPark(rec) ? `, parked: ${designPark(rec)}` : '';
    const took = logTaken(key, rec, state);
    reg.tickets[key] = { at: now.toISOString(), outcome: 'admitted', text: `${laneSize(rec)}${heldText(r)}${took}${parked}` };
    writeIntake(state, reg);
    admitted.push(key);
    lines.push(`intake: admitted ${key} by intake into batch ${r.batch ?? '?'} (${laneSize(rec)})${heldText(r)}${took}${parked}`);
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

// Admit a ticket into the live named batch `epic` (its epic's feature batch, or the batch whose base has
// its files), triaged again there: on the batch's
// base, where the spine and the other children have added files, and into its state, where queue.mjs
// reads it. Held behind the spine until it is done (as plan-batch holds every child it seeds), its
// blockers there, and every unfinished ticket there whose files it shares, so it waits for their PRs
// to merge, and its blockers in no batch until each is Done and on the batch's base.
// -> {batch, base, held, outside, rec} or {why}.
function joinFeature(key, epic, { by }) {
  const b = liveFeatureBatches().find((x) => x.name === epic);
  if (!b) return { why: `batch ${epic} is no longer live: run /desk-admit ${key} again` };
  const t = triage(key, b.state, batchEnv(b));
  if (!t.rec) return { why: `${t.why} in feature batch ${epic}: fix it and run /desk-admit ${key} again` };
  let fq;
  try { fq = readQueueAt(b.queue); } catch (e) { return { why: `feature batch ${epic}'s queue cannot be read (${e.message})` }; }
  const base = fq.base ?? (E.configValue('default-branch') || 'main');
  const holds = holdsFor(t.rec, fq.tickets ?? {}, base);
  const reasons = reasonsAgainst(t.rec, holds);
  if (reasons.length) return { why: reasons.join('; ') };
  // queue.mjs adds the spine and an epic still waiting on its drafted plan (--hold-spine).
  const a = queueCmdIn(batchEnv(b), ['admit', key, '--by', by, '--hold-spine', '--hold-collisions', ...holdArgs(holds)]);
  if (a.status !== 0) return { why: lastLine(a) };
  let held = holds.held;
  try { held = String(readQueueAt(b.queue).tickets?.[key]?.held_by ?? '').split('|').filter((k) => k && !holds.outside.includes(k)); } catch { /* admitted: say the holds asked for */ }
  return { batch: b, base, held, outside: holds.outside, rec: t.rec, took: logTaken(key, t.rec, b.state) };
}

function byHand(keys, { state, by, front, now }) {
  const lines = [];
  const admitted = [];
  const refused = [];
  // Epics to plan as a feature batch beside the standing batch in a session (the /desk-autopilot epic
  // flow), and epics whose feature batch was started here, their plans waiting in needs-you.
  const plan = [];
  const epics = [];
  const refuse = (key, text) => { refused.push(key); lines.push(`not admitted ${key}: ${text}`); };
  const done = (extra = {}) => ({ ran: true, lines, admitted, refused, plan, epics, ...extra });
  // Starting a standing batch has no plan approval, so it needs what standing intake needs.
  const mayStart = E.permission('autopilot-workers') === 'yes';
  // Why the tickets have nowhere to go, or null: nothing is triaged for a batch they cannot join.
  const said = (code, b) => ({
    base: () => (moveTo(b)
      ? `batch ${b.batch ?? '?'} runs on base ${b.base} in the standing slot: move it to ${moveTo(b)} (node ${join(HERE, 'move-batch.mjs')}), then admit these again`
      : `batch ${b.batch ?? '?'} runs on base ${b.base}: run /desk-autopilot for these in a session`),
    session: () => `batch ${b.batch ?? '?'} is run by a session, not the supervisor: send these tickets to that session (ListAgents names it) and let it admit them`,
    free: () => `no batch is live, and starting one without a plan approval needs config §3 ${E.permissionKey('autopilot-workers')} to be "yes" (it is "${E.permission('autopilot-workers')}"): run /desk-autopilot ${keys.join(' ')}`,
  }[code]?.() ?? null);
  const nowhere = (b) => said(closed(b) ?? (free(b) && !mayStart ? 'free' : null), b);
  let q;
  try { q = readQueue(); } catch (e) { lines.push(`admits nothing: the queue at ${E.queueFile()} cannot be read (${e.message})`); return done({ refused: keys }); }
  const why = nowhere(q);
  if (why) { lines.push(`admits nothing: ${why}`); return done({ refused: keys }); }
  // A feature batch whose start was cut off would read as live, and hold its own epic.
  for (const a of clearAbandoned()) lines.push(a.text);

  // Triage every one first, so a blocker named in the same call is admitted before what it blocks.
  const recs = {};
  for (const key of keys) {
    if (!E.SAFE_ID.test(key)) { refuse(key, 'not a ticket id'); continue; }
    if (q?.tickets?.[key]) { lines.push(`${key} is already in batch ${q.batch ?? '?'} (${q.tickets[key].state})`); continue; }
    const doneAs = doneInJira(key);
    if (doneAs) { lines.push(`${key} is already done in Jira (${doneAs}): nothing triaged or admitted`); continue; }
    const away = belongsElsewhere(key, null, E.queueFile());
    if (away) { refuse(key, away.why); continue; }
    const t = triage(key, state);
    if (!t.rec) { refuse(key, `${t.why}: fix it and run /desk-admit ${key} again`); continue; }
    if (isEpic({ name: t.rec.type })) {
      // Each epic runs as its own feature batch, beside the standing batch and any other epic's.
      if (liveFeatureBatches().some((b) => b.name === key)) { refuse(key, `an epic, and its feature batch ${key} is already running: admit its children, which join that batch`); continue; }
      // Without a standing grant for headless workers, a session plans it with the person.
      if (!mayStart) {
        plan.push(key);
        lines.push(`plan ${key} as a feature batch beside the standing batch: /desk-autopilot ${key}`);
        continue;
      }
      const s = startEpic(key, t.rec, { by });
      if (s.why) { refuse(key, `an epic, and its feature batch was not started: ${s.why}`); continue; }
      noteEpic(state, key, s, by, now);
      epics.push(key);
      lines.push(...s.lines);
      continue;
    }
    // A design no worker can read is snapshotted by the person's session before the admit, never after.
    const unread = needsPersonLane(t.rec) ? [] : unreadCanvases(t.rec);
    if (unread.length) { refuse(key, `design not snapshotted: ${unread.join(', ')}: snapshot it into ${join(state, 'designs', key)}/ and record it (desk-design write), or have it shared with this subscription, then run /desk-admit ${key} again`); continue; }
    recs[key] = t.rec;
  }
  let started = null;
  const next = new Set();
  for (const key of blockersFirst(recs)) {
    let rec = recs[key];
    let r = placeOne(key, rec, { started, by, now, mayStart });
    if (r.started) { started = r.started; lines.push(`started standing batch ${started}, handed to the supervisor`); }
    // A child of an epic whose feature batch is live joins that batch, and so does a ticket whose files
    // are on another running batch's base: the standing queue is untouched.
    let feature = null;
    let took = null;
    const joinTo = r.elsewhere?.epic ?? r.elsewhere?.route;
    if (joinTo) {
      const j = joinFeature(key, joinTo, { by });
      const why = r.elsewhere.epic ? `${key} is a child of epic ${joinTo}, but not admitted into its feature batch` : `${r.elsewhere.why}, but it was not admitted there`;
      r = j.why ? { admitFailed: `${why}: ${j.why}` } : j;
      feature = j.batch ?? null;
      rec = j.rec ?? rec;
      took = j.took ?? null;
    }
    const fail = r.unreadable ?? (r.closed && said(r.closed, r.cur)) ?? r.elsewhere?.why ?? r.reasons?.join('; ')
      ?? (r.startFailed && `a standing batch could not be started (${r.startFailed})`) ?? r.admitFailed;
    if (fail) { refuse(key, fail); continue; }
    took ??= logTaken(key, rec, state);
    const reg = readIntake(state);
    reg.tickets[key] = { at: now.toISOString(), outcome: 'admitted', text: `${laneSize(rec)}${heldText(r)}${took}, by ${by}` };
    writeIntake(state, reg);
    admitted.push(key);
    lines.push(`admitted ${key} by ${by} into ${feature ? `feature batch ${feature.name}` : `batch ${r.batch ?? '?'}`} (${laneSize(rec)})${heldText(r, new Set(refused))}${took}`);
    const open = new Set(openBlockers(rec));
    for (const b of r.outside ?? []) if (open.has(b) && !keys.includes(b)) next.add(b);
    if (front) {
      const f = feature ? queueCmdIn(batchEnv(feature), ['front', key]) : queueCmd('front', key);
      lines.push(f.status === 0 ? f.stdout.trim() : `${key} not moved to the front: ${lastLine(f)}`);
    }
  }
  if (admitted.length || epics.length) lines.push(`the supervisor's next tick picks ${admitted.length + epics.length === 1 ? 'it' : 'them'} up`);
  // Open blockers in no batch are admitted next, by the same command, with no question: the person
  // naming what they block is the approval.
  if (next.size) lines.push(`admit next: ${[...next].join(' ')} (open blockers in no batch)`);
  return done({ started, next: [...next] });
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
