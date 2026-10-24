#!/usr/bin/env node
// Standing intake: tickets a repo's config §3b "Intake query" finds are triaged and admitted into the
// running batch with no Stage 3 plan approval, where config §3 autopilot-workers is `yes`. What would
// need the person before a worker starts goes to the check-in digest instead, never to a question.
// The supervisor runs it each tick; it searches Jira at most every INTAKE_EVERY_MS.
//
//   node intake.mjs run [--json] [--force]   one intake now (--force: whether or not one is due)
//   node intake.mjs forget <TICKET>          take a ticket out of the register: the next intake triages it again
//
// Each ticket the query finds, once (the register is <state>/intake.json):
//   - already in the queue, or already admitted or handed on: nothing;
//   - an epic: handed to the digest untriaged (a feature batch, planned in a session);
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
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { isEpic } from './desk-q-eta.mjs';

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
// {last_run, tickets: {KEY: {at, outcome: admitted | handed | triage_failed, text, tries}}}
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
  if (['C', 'D'].includes(r.lane)) out.push(`lane ${r.lane}: ${String(r.lane_reason ?? 'needs a person').slice(0, 160)}`);
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
// A PR whose state cannot be read counts as open.
export function prOpen(n) {
  let repo;
  try { repo = E.ghRepo(); } catch { return true; }
  const r = spawnSync('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'state', '--jq', '.state'], { encoding: 'utf8' });
  return !(r.status === 0 && ['MERGED', 'CLOSED'].includes(r.stdout.trim()));
}
// Free for a standing batch: no queue, or one whose every ticket is done with no PR still open. A failed
// ticket waits on the person, a queue with no tickets is a session's between `queue.mjs init` and its
// plan, and a batch on a base still has its gate and promotion to come: none of those is free.
// queue.mjs init --standing checks the same under its lock.
const free = (q) => {
  if (!q) return true;
  const rows = Object.values(q.tickets ?? {});
  return !q.base && rows.length > 0 && rows.every((t) => t.state === 'done') && !rows.some((t) => t.result?.pr != null && prOpen(t.result.pr));
};
// Why intake admits nothing into this batch now, or null.
const waitFor = (b) => (!b || free(b) ? null
  : b.base ? `intake: admits nothing while batch ${b.batch ?? '?'} runs on base ${b.base}: its tickets merge there, and intake's go to the default branch`
    : b.supervised !== true ? `intake: admits nothing while batch ${b.batch ?? '?'} is not handed over (queue.mjs set-batch supervised=true): it joins that batch once it is`
      : null);

const queueCmd = (...args) => spawnSync(process.execPath, [join(HERE, 'queue.mjs'), ...args], { encoding: 'utf8', env: process.env });

// ---- one run -----------------------------------------------------------------------------------
export function runIntake({ state = E.stateDir(), force = false, now = new Date() } = {}) {
  const query = intakeQuery();
  if (!query) return { ran: false, lines: [] };
  mkdirSync(state, { recursive: true });
  const reg = readIntake(state);
  if (!force && reg.last_run && now - Date.parse(reg.last_run) < INTAKE_EVERY_MS) return { ran: false, lines: [] };

  // One intake at a time: two would triage, and admit, the same ticket twice.
  const lockFile = join(state, 'intake.lock');
  const holder = readJson(lockFile, null)?.pid;
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  if (holder && holder !== process.pid && alive(holder)) return { ran: false, lines: [`intake: skipped, another intake is running (pid ${holder})`] };
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, since: now.toISOString() }));
  try { return intake({ state, query, reg, now }); }
  finally { try { if (readJson(lockFile, null)?.pid === process.pid) rmSync(lockFile); } catch { /* gone */ } }
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

  const qf = E.queueFile();
  const readQ = () => (existsSync(qf) ? JSON.parse(readFileSync(qf, 'utf8')) : null);
  let q;
  try { q = readQ(); } catch (e) { lines.push(`intake: admits nothing: the queue at ${qf} cannot be read (${e.message})`); return done(); }
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
  const isNew = (k) => E.SAFE_ID.test(k) && !q?.tickets?.[k] && !['admitted', 'handed'].includes(reg.tickets[k]?.outcome);
  // An epic is a feature batch's, with its spine and owner table approved first: never a worker's.
  for (const i of found.filter((x) => isNew(x.key) && isEpic(x.fields?.issuetype))) hand(i.key, 'an epic: run it as a feature batch in a session');
  const fresh = found.map((i) => i.key).filter(isNew);
  if (!fresh.length) return done();
  const triageNow = fresh.slice(0, MAX_TRIAGE);
  if (fresh.length > triageNow.length) lines.push(`intake: ${fresh.length - triageNow.length} more ticket(s) wait for the next intake (${fresh.slice(MAX_TRIAGE).join(', ')}): ${MAX_TRIAGE} are triaged a run`);

  // Triage every one first, so a blocker found in the same run is admitted before what it blocks.
  const recs = {};
  for (const key of triageNow) {
    const t = spawnSync(join(HERE, 'triage.sh'), [key], { encoding: 'utf8', env: process.env, maxBuffer: 64 << 20 });
    const rec = t.status === 0 ? readJson(join(state, 'triage', `${key}.json`), null) : null;
    if (rec) { recs[key] = rec; continue; }
    const why = t.status === 0 ? 'triage wrote no record' : `triage failed: ${lastLine(t)}`;
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
  // Blockers first: each round takes the tickets none of the rest still blocks (a cycle goes last, as found).
  const order = [];
  for (let rest = Object.keys(recs); rest.length;) {
    const ready = rest.filter((k) => !openBlockers(recs[k]).some((b) => b !== k && rest.includes(b)));
    const take = ready.length ? ready : rest;
    order.push(...take);
    rest = rest.filter((k) => !take.includes(k));
  }
  let started = null;
  for (const key of order) {
    const rec = recs[key];
    const reasons = intakeReasons(rec);
    // Read again, whole: triage took minutes, and a session may have started its own batch meanwhile.
    let cur;
    try { cur = readQ(); } catch (e) { lines.push(`intake: admits nothing more: the queue at ${qf} cannot be read (${e.message})`); return done({ started }); }
    if (waitFor(cur)) { lines.push(waitFor(cur)); return done({ started }); }
    // A new batch keeps none of a finished one's tickets, so every open blocker is then outside it. A
    // blocker the batch will not merge leaves nothing to release the ticket.
    const startNew = !started && free(cur);
    const tickets = startNew ? {} : cur?.tickets ?? {};
    const blockers = openBlockers(rec);
    const outside = blockers.filter((b) => !tickets[b] || tickets[b].state === 'failed');
    for (const b of outside) reasons.push(`blocked by ${b}, which is not done and not in the batch: add it to the batch, or settle the link`);
    if (reasons.length) { hand(key, reasons.join('; ')); continue; }

    if (startNew) {
      // queue.mjs re-checks under its lock that the queue is still the one found free, and hands the
      // new batch to the supervisor in the same write.
      const name = `standing-${now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`;
      const init = queueCmd('init', name, '--standing', '--if-batch', cur ? String(cur.batch) : 'none');
      if (init.status !== 0) {
        lines.push(`intake: admits nothing: a standing batch could not be started (${lastLine(init)}); the next intake tries again`);
        reg.last_run = null;
        writeIntake(state, reg);
        return done({ started });
      }
      started = name;
      cur = { batch: name };
      lines.push(`intake: started standing batch ${name}, handed to the supervisor`);
    }
    // Held in the same write as the admit, so no pass sees it runnable first.
    const held = blockers.filter((b) => tickets[b]);
    const a = queueCmd('admit', key, '--by', 'intake', ...(held.length ? ['--hold', held.join(',')] : []));
    if (a.status !== 0) { lines.push(`intake: ${key} not admitted: ${lastLine(a)}; the next intake tries again`); continue; }
    const hold = held.length ? `, held behind ${held.join(', ')}` : '';
    reg.tickets[key] = { at: now.toISOString(), outcome: 'admitted', text: `lane ${rec.lane ?? '?'}${rec.size ? `, size ${rec.size}` : ''}${hold}` };
    writeIntake(state, reg);
    admitted.push(key);
    lines.push(`intake: admitted ${key} by intake into batch ${cur.batch ?? '?'} (lane ${rec.lane ?? '?'}${rec.size ? `, size ${rec.size}` : ''})${hold}`);
  }
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
  } else if (cmd === 'forget' && rest[0] && E.SAFE_ID.test(rest[0])) {
    console.log(forget(rest[0]) ? `intake: ${rest[0]} forgotten: the next intake triages it again if the query still finds it` : `intake: ${rest[0]} is not in the register`);
  } else {
    console.error('usage: intake.mjs run [--json] [--force] | intake.mjs forget <TICKET>');
    process.exit(EXIT.SHOW_PERSON);
  }
}
