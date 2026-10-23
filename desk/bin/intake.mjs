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
//   - otherwise admitted (queue.mjs admit --by intake), and held behind every blocker in the batch.
// With no live batch, one is started for it (`standing-<time>`, handed to the supervisor at once).
// A batch still being planned in a session (not handed over) gets nothing until it is handed over.
// At most MAX_TRIAGE tickets are triaged a run; the rest wait for the next one, and the report says so.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { isEpic } from './desk-q-eta.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const INTAKE_EVERY_MS = 15 * 60 * 1000;
export const MAX_TRIAGE = 3;
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
// A batch is live while any ticket is still to finish, or done with a PR still open.
function prOpen(n) {
  let repo;
  try { repo = E.ghRepo(); } catch { return true; }
  const r = spawnSync('gh', ['pr', 'view', String(n), '--repo', repo, '--json', 'state', '--jq', '.state'], { encoding: 'utf8' });
  return !(r.status === 0 && ['MERGED', 'CLOSED'].includes(r.stdout.trim()));
}
export function batchLive(q) {
  const rows = Object.values(q?.tickets ?? {});
  return rows.some((t) => !['done', 'failed'].includes(t.state)) || rows.some((t) => t.state === 'done' && t.result?.pr != null && prOpen(t.result.pr));
}

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
  let q = null;
  if (existsSync(qf)) {
    try { q = JSON.parse(readFileSync(qf, 'utf8')); } catch (e) { lines.push(`intake: admits nothing: the queue at ${qf} cannot be read (${e.message})`); return done(); }
  }
  // A batch a session is still planning is the session's: intake joins it once it is handed over.
  const live = q && batchLive(q);
  if (live && q.supervised !== true) {
    lines.push(`intake: admits nothing while batch ${q.batch ?? '?'} is not handed over (queue.mjs set-batch supervised=true): it joins that batch once it is`);
    return done();
  }

  const r = spawnSync('desk-jira', ['search', query, '50', '--json'], { encoding: 'utf8', env: process.env, maxBuffer: 64 << 20 });
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
  const inQueue = () => { try { return JSON.parse(readFileSync(qf, 'utf8')).tickets ?? {}; } catch { return {}; } };

  let started = null;
  for (const key of order) {
    const rec = recs[key];
    const reasons = intakeReasons(rec);
    // A blocker this batch will not merge leaves nothing to release it.
    const tickets = inQueue();
    const blockers = openBlockers(rec);
    const outside = blockers.filter((b) => !tickets[b] || tickets[b].state === 'failed');
    for (const b of outside) reasons.push(`blocked by ${b}, which is not done and not in the batch: add it to the batch, or settle the link`);
    if (reasons.length) { hand(key, reasons.join('; ')); continue; }

    if (!started && !(Object.keys(tickets).length && batchLive({ tickets }))) {
      const name = `standing-${now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')}`;
      const init = queueCmd('init', name, '--standing');
      const set = init.status === 0 ? queueCmd('set-batch', 'supervised=true', 'standing=true') : init;
      if (set.status !== 0) {
        lines.push(`intake: admits nothing: a standing batch could not be started (${lastLine(set)}); the next intake tries again`);
        reg.last_run = null;
        writeIntake(state, reg);
        return done();
      }
      started = name;
      lines.push(`intake: started standing batch ${name}, handed to the supervisor`);
    }
    const a = queueCmd('admit', key, '--by', 'intake');
    if (a.status !== 0) { lines.push(`intake: ${key} not admitted: ${lastLine(a)}; the next intake tries again`); continue; }
    // Read again: a standing batch started above holds none of the finished batch's tickets.
    const inBatch = inQueue();
    const held = blockers.filter((b) => inBatch[b]);
    let hold = '';
    if (held.length) {
      const h = queueCmd('hold', key, ...held);
      hold = h.status === 0 ? `, held behind ${held.join(', ')}` : `; holding it behind ${held.join(', ')} failed (${lastLine(h)})`;
    }
    reg.tickets[key] = { at: now.toISOString(), outcome: 'admitted', text: `lane ${rec.lane ?? '?'}${rec.size ? `, size ${rec.size}` : ''}${hold}` };
    writeIntake(state, reg);
    admitted.push(key);
    lines.push(`intake: admitted ${key} by intake into batch ${started ?? q?.batch ?? '?'} (lane ${rec.lane ?? '?'}${rec.size ? `, size ${rec.size}` : ''})${hold}`);
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
