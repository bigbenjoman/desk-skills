#!/usr/bin/env node
// The autopilot queue: the orchestrator's only piece of state.
//
// Lives outside any repo so worktree churn cannot take it. Single writer (the
// orchestrator); workers never touch it — their state is derived from their own
// logs plus `claude agents --json`. Created on first use; never shipped.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isHeld, waitingOnMerge } from './batch-state.mjs';
import { queueFile, stateDir, skillsDir, concurrencyLimits, SAFE_ID, BRANCH_NAME, configValue, repoRoot, rotateRound } from './desk-env.mjs';

// The batch's base branch (see batchBase() in desk-env.mjs). Empty or `none` clears it. It must be a
// real branch on origin, never the config's default (that is no override) and never a production
// branch: a batch merges into its base, and production only ever takes promotion PRs.
function setBase(q, v) {
  if (!v || /^none$/i.test(v)) { delete q.base; return; }
  if (!BRANCH_NAME.test(v) || v.includes('..') || v.endsWith('.lock')) throw new Error(`base: "${v}" is not a valid branch name`);
  if (/^(production|prod|release)$/i.test(v)) throw new Error(`base: refusing "${v}" — a batch never merges into a production branch`);
  const def = configValue('default-branch');
  if (def && v === def) { delete q.base; return; }
  let found = '';
  try { found = execFileSync('git', ['-C', repoRoot(), 'ls-remote', '--heads', 'origin', `refs/heads/${v}`], { encoding: 'utf8' }).trim(); }
  catch (e) { throw new Error(`base: could not ask origin for ${v} (${e.message.split('\n')[0]})`); }
  if (!found) throw new Error(`base: ${v} does not exist on origin — push it first`);
  q.base = v;
}

const QUEUE = queueFile();
const STATES = ['queued', 'triaged', 'running', 'parked', 'done', 'failed'];

// The starting concurrency is config §3b "Autopilot worker concurrency" (`<default> / <cap>`); the
// orchestrator's ladder changes it per pass with set-batch, and pass.mjs never exceeds the cap.
const empty = () => ({ version: 1, batch: null, concurrency: concurrencyLimits().def, tickets: {} });

function load() {
  if (!existsSync(QUEUE)) return empty();
  try {
    return JSON.parse(readFileSync(QUEUE, 'utf8'));
  } catch (e) {
    // A torn or hand-mangled queue must never read as "no tickets" — that would
    // silently re-spawn work that is already running.
    throw new Error(`queue at ${QUEUE} is unreadable (${e.message}). Fix or move it; refusing to continue.`);
  }
}

function save(q) {
  mkdirSync(dirname(QUEUE), { recursive: true });
  const tmp = `${QUEUE}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(q, null, 2)}\n`);
  renameSync(tmp, QUEUE); // atomic within the same filesystem
}

function ticket(q, key) {
  const t = q.tickets[key];
  if (!t) throw new Error(`no such ticket in the queue: ${key}`);
  return t;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let node = obj;
  for (const part of parts.slice(0, -1)) {
    if (node[part] == null || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

// A value opening with { or [ is JSON: stored as a string, a later `result.pr=…` would replace it with
// an empty object and lose the rest. Invalid JSON is an error rather than that string.
function coerce(v) {
  if (/^\s*[[{]/.test(v)) {
    try { return JSON.parse(v); } catch (e) { throw new Error(`not valid JSON: ${v} (${e.message})`); }
  }
  return v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v;
}

// Is another orchestrator (a second batch) live right now? Its per-batch notes must survive our init.
// The pass lock only covers the seconds a pass runs, so also read the heartbeats pass.mjs writes per
// queue file: one for a different queue, fresher than 15 minutes, is a live batch between passes.
const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;
function liveOrchestrator() {
  try {
    const { pid } = JSON.parse(readFileSync(join(stateDir(), 'orchestrator.lock'), 'utf8'));
    if (pid !== process.pid) { process.kill(pid, 0); return `pid ${pid}`; }
  } catch { /* no live pass right now */ }
  try {
    const dir = join(stateDir(), 'orchestrators');
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      const hb = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (hb.queue !== QUEUE && Date.now() - Date.parse(hb.at) < HEARTBEAT_FRESH_MS) return `batch ${hb.batch ?? '?'} on ${hb.queue}, last pass ${hb.at}`;
    }
  } catch { /* advisory */ }
  return null;
}

const [, , cmd, ...args] = process.argv;

try {
const q = cmd === 'init' ? empty() : load(); // init must be able to repair a corrupt queue

switch (cmd) {
  case 'init': {
    const fresh = empty();
    fresh.batch = args[0] ?? new Date().toISOString().slice(0, 16);
    save(fresh);
    // Batch notes record what workers learnt about *this* configuration. Carrying them
    // across batches propagates claims that a config change has since made false.
    //
    // But the resource rules are NOT a per-batch finding, and blanking them here is how a batch
    // ends up with workers that never learnt about the Jest cap or the test lock — pass.mjs folds
    // this file into every briefing, so a wipe is silent and total, and an uncapped worker can
    // take the VM to 18GB through that gap. So: back up, reset, then re-seed the
    // canonical header from the skill, which is version-controlled and edited in one place.
    // And never truncate under a live second batch: its workers still read this file.
    try {
      const state = stateDir();
      mkdirSync(state, { recursive: true });
      const notes = join(state, 'batch-notes.md');
      const header = join(skillsDir(), 'desk-autopilot', 'references', 'batch-notes-header.md');
      const seed = existsSync(header) ? `\n${readFileSync(header, 'utf8').trimEnd()}\n` : '';
      if (!seed) console.error(`WARNING: batch-notes header not found at ${header} — workers will not inherit the memory rules`);
      const other = liveOrchestrator();
      if (existsSync(notes) && other) {
        const cur = readFileSync(notes, 'utf8');
        if (seed && !cur.includes('## MEMORY')) writeFileSync(notes, `${cur.trimEnd()}\n${seed}`);
        console.error(`NOTE: another orchestrator (${other}) is live — batch-notes.md kept, not reset`);
      } else {
        if (existsSync(notes) && readFileSync(notes, 'utf8').trim()) {
          const bak = `${notes}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          copyFileSync(notes, bak);
          console.log(`batch notes backed up to ${bak}`);
        }
        writeFileSync(notes, `# Batch notes\n${seed}\n`);
      }
    } catch { /* notes are advisory; never fail init over them */ }
    console.log(`queue initialised at ${QUEUE}`);
    break;
  }

  case 'add': {
    const [key, type = 'Bug', lane = '?'] = args;
    if (!key) throw new Error('usage: queue.mjs add <TICKET> [type] [lane]');
    // The key names files (logs, parks, briefings, worker settings): never a path.
    if (!SAFE_ID.test(key) || key.includes('..')) throw new Error(`'${key}' is not usable as a ticket id (letters, digits, . _ - only; no ..)`);
    if (q.tickets[key]) { console.log(`${key} already in the queue (${q.tickets[key].state}) — not re-adding`); break; }
    q.tickets[key] = {
      key, type, lane, state: 'queued',
      worktree: null, branch: null, database: null, port: null,
      session_id: null, pid: null, base_sha: null, stage: null,
      park: null, log: null, result: null,
      added_at: new Date().toISOString(),
    };
    save(q);
    console.log(`added ${key}`);
    break;
  }

  // Hold a ticket behind blockers (a dependency added mid-batch, or a collision chain), recorded so
  // pass.mjs keeps the batch alive and the merge driver releases it once every blocker has merged.
  case 'hold': {
    const [key, ...blockers] = args;
    const preds = blockers.flatMap((b) => b.split(/[,|]/)).filter(Boolean);
    if (!key || !preds.length) throw new Error('usage: queue.mjs hold <TICKET> <BLOCKER> [<BLOCKER> ...]');
    const t = ticket(q, key);
    for (const p of preds) { ticket(q, p); if (p === key) throw new Error(`${key} cannot be held behind itself`); }
    if (t.state === 'parked' && !isHeld(t)) throw new Error(`${key} is parked for its own reason (${t.park?.question ?? '?'}): a hold would let a release send it to a worker`);
    if (['running', 'done', 'failed'].includes(t.state)) throw new Error(`${key} is ${t.state}: too late to hold it`);
    // A release sets state=triaged, so only a ticket that is triaged (or already held) may be held.
    if (t.state === 'queued') throw new Error(`${key} has not been triaged: triage it and \`queue.mjs admit\` it before holding it`);
    const all = [...new Set([...String(t.held_by ?? '').split('|').filter(Boolean), ...preds])];
    t.held_by = all.join('|');
    t.state = 'parked';
    t.park = { question: `held by orchestrator: blocked by ${all.join(', ')} — starts once their PRs merge`, since: new Date().toISOString() };
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(`${key} held behind ${all.join(', ')}`);
    break;
  }

  // Add one triaged ticket mid-batch, from its triage record, the way plan-batch seeds one: a blocker
  // the user asked to add, a split-off child. Never re-run plan-batch with AUTOPILOT_WRITE_QUEUE for
  // this: it resets every ticket's state.
  case 'admit': {
    const [key] = args;
    if (!key || !SAFE_ID.test(key) || key.includes('..')) throw new Error('usage: queue.mjs admit <TICKET>   (after triage.sh <TICKET>)');
    if (q.tickets[key]) throw new Error(`${key} is already in the queue (${q.tickets[key].state})`);
    const recPath = join(stateDir(), 'triage', `${key}.json`);
    if (!existsSync(recPath)) throw new Error(`no triage record for ${key}: run triage.sh ${key} first`);
    const r = JSON.parse(readFileSync(recPath, 'utf8'));
    const size = String(r.size ?? '').toUpperCase();
    const park = ['C', 'D'].includes(r.lane) ? `lane ${r.lane} — ${String(r.lane_reason ?? 'needs a person').slice(0, 160)}`
      : ['L', 'XL'].includes(size) ? `size ${size} — split it before batching` : null;
    const unknowns = (r.unknowns ?? []).length + (r.facts_error ? 1 : 0);
    // The collision check plan-batch makes, against every ticket still to finish: two tickets that
    // touch one file never run at once.
    const mine = new Set(r.files_in_scope ?? []);
    const collides = [];
    for (const [k, other] of Object.entries(q.tickets)) {
      if (['done', 'failed'].includes(other.state)) continue;
      const op = join(stateDir(), 'triage', `${k}.json`);
      if (!existsSync(op)) continue;
      const files = JSON.parse(readFileSync(op, 'utf8')).files_in_scope ?? [];
      if (files.some((f) => mine.has(f))) {
        collides.push(k);
        other.collides_with = [...new Set([...String(other.collides_with ?? '').split('|').filter(Boolean), key])].join('|');
      }
    }
    q.tickets[key] = {
      key, type: r.type ?? 'Bug', lane: r.lane, state: park ? 'parked' : 'triaged',
      worktree: null, branch: r.branch ?? null, database: null, port: null,
      session_id: null, pid: null, base_sha: null, stage: null,
      park: park ? { question: park, since: new Date().toISOString() } : null, log: null, result: null,
      collides_with: collides.join('|') || null, open_questions: unknowns, held_by: null,
      added_at: new Date().toISOString(),
    };
    save(q);
    console.log(`admitted ${key}: ${park ?? `triaged${unknowns ? `, ${unknowns} question(s) open` : ''}`}${r.blockers?.length ? ` — its own Jira blockers (${r.blockers.map((b) => b.key).join(', ')}) are not applied: hold it with queue.mjs hold if they are in this batch` : ''}`);
    break;
  }

  case 'set': {
    const [key, ...pairs] = args;
    const t = ticket(q, key);
    for (const p of pairs) {
      const i = p.indexOf('=');
      if (i < 0) throw new Error(`expected key=value, got: ${p}`);
      const k = p.slice(0, i);
      const v = coerce(p.slice(i + 1));
      if (k === 'state' && !STATES.includes(v)) throw new Error(`bad state "${v}" (want: ${STATES.join('|')})`);
      setPath(t, k, v);
    }
    t.updated_at = new Date().toISOString();
    save(q);
    console.log(`${key}: ${pairs.join(' ')}`);
    break;
  }

  case 'park': {
    const [key, ...rest] = args;
    const t = ticket(q, key);
    t.state = 'parked';
    t.park = { question: rest.join(' '), since: new Date().toISOString() };
    save(q);
    console.log(`${key} parked`);
    break;
  }

  // Send a ticket back for another worker: every field a requeue needs, not one of them left to a hand
  // edit that fails silently. The last round's log, park record and mailbox move aside to one
  // `.round<n>`, so pass.mjs neither refuses it as finished nor reports an old question as the new
  // worker's. The branch is kept: the merge driver finds the ticket's PR by it.
  case 'requeue': {
    const [key] = args;
    if (!key) throw new Error('usage: queue.mjs requeue <TICKET>');
    const t = ticket(q, key);
    if (t.state === 'running') throw new Error(`${key} is running: stop its worker first, or it gets a second one`);
    if (isHeld(t)) throw new Error(`${key} is held behind ${String(t.held_by ?? '?').split('|').join(', ')}: release it rather than requeue it`);
    if (['C', 'D'].includes(t.lane)) throw new Error(`${key} is lane ${t.lane}, which is never requeued for a headless worker. Only if the user rules the lane wrong: queue.mjs set ${key} lane=<A, B or E>, then requeue`);
    const moved = rotateRound(key, { answers: true });
    Object.assign(t, { state: 'triaged', open_questions: 0, park: null, session_id: null, pid: null, idle_passes: 0, log_bytes: 0, updated_at: new Date().toISOString() });
    q.tickets = { [key]: t, ...Object.fromEntries(Object.entries(q.tickets).filter(([k]) => k !== key)) };
    save(q);
    console.log(`${key} requeued at the front of the spawn order${moved.length ? `; moved aside: ${moved.join(', ')}` : ''}`);
    break;
  }

  case 'set-batch': {
    for (const pair of args) {
      const i = pair.indexOf('=');
      if (i < 0) throw new Error(`expected key=value, got: ${pair}`);
      const k = pair.slice(0, i); const v = pair.slice(i + 1).trim();
      if (k === 'base') { setBase(q, v); continue; }
      setPath(q, k, coerce(v));
    }
    save(q);
    console.log(`batch: ${args.join(' ')}`);
    break;
  }

  // pass.mjs spawns eligible tickets in `.tickets` key order, so a released chain head has to move
  // to the front or it waits behind every independent ticket.
  case 'front': {
    const key = args[0];
    const t = ticket(q, key);
    q.tickets = { [key]: t, ...Object.fromEntries(Object.entries(q.tickets).filter(([k]) => k !== key)) };
    save(q);
    console.log(`${key} moved to the front of the spawn order`);
    break;
  }

  case 'drop': {
    const key = args[0];
    ticket(q, key);
    delete q.tickets[key];
    save(q);
    console.log(`dropped ${key} from the batch`);
    break;
  }

  case 'get':
    console.log(JSON.stringify(ticket(q, args[0]), null, 2));
    break;

  case 'list':
    console.log(JSON.stringify(q, null, 2));
    break;

  case 'render': {
    const rows = Object.values(q.tickets);
    if (!rows.length) { console.log('queue is empty'); break; }
    const order = { parked: 0, running: 1, triaged: 2, queued: 3, failed: 4, done: 5 };
    rows.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
    console.log(`batch ${q.batch ?? '-'}   concurrency ${q.concurrency}${q.epic ? `   epic ${q.epic}` : ''}${q.base ? `   base ${q.base}` : ''}\n`);
    for (const t of rows) {
      const stuck = isHeld(t) && !waitingOnMerge(q, t);
      const label = stuck ? 'STUCK' : isHeld(t) ? 'HELD' : t.state.toUpperCase();
      const tail = stuck ? `held behind ${String(t.held_by ?? '?').split('|').join(', ')}, which will not merge on its own (failed or parked): decide what happens to it`
        : isHeld(t) ? `until ${String(t.held_by ?? '?').split('|').join(', ')} merge${(t.open_questions ?? 0) > 0 ? ` · ${t.open_questions} question(s) open` : ''}`
        : t.state === 'parked' ? t.park?.question ?? ''
        : t.state === 'running' ? `stage ${t.stage ?? '?'}  port ${t.port ?? '-'}`
        : t.state === 'done' ? (t.result?.pr ? `PR #${t.result.pr}` : '')
        : '';
      console.log(`  ${label.padEnd(8)} ${t.key.padEnd(9)} ${tail}`);
    }
    const parked = rows.filter((t) => t.state === 'parked' && !(isHeld(t) && waitingOnMerge(q, t))).length;
    if (parked) console.log(`\n${parked} ticket(s) waiting on you.`);
    break;
  }

  default:
    console.log('usage: queue.mjs init|add|admit|hold|set|set-batch|park|requeue|front|drop|get|list|render');
    process.exit(cmd ? 1 : 0);
}
} catch (e) {
  console.error(`queue: ${e.message}`);
  process.exit(1);
}
