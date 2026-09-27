#!/usr/bin/env node
// The autopilot queue: the orchestrator's only piece of state.
//
// Lives outside any repo so worktree churn cannot take it. Single writer (the
// orchestrator); workers never touch it — their state is derived from their own
// logs plus `claude agents --json`. Created on first use; never shipped.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { queueFile, stateDir, skillsDir } from './desk-env.mjs';

const QUEUE = queueFile();
const STATES = ['queued', 'triaged', 'running', 'parked', 'done', 'failed'];

const empty = () => ({ version: 1, batch: null, concurrency: 2, tickets: {} });

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

const coerce = (v) => (v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v);

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
    if (!key) throw new Error('usage: queue.mjs add SV-XXX [type] [lane]');
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

  case 'set-batch': {
    for (const pair of args) {
      const i = pair.indexOf('=');
      if (i < 0) throw new Error(`expected key=value, got: ${pair}`);
      setPath(q, pair.slice(0, i), coerce(pair.slice(i + 1)));
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
    console.log(`batch ${q.batch ?? '-'}   concurrency ${q.concurrency}\n`);
    for (const t of rows) {
      const tail = t.state === 'parked' ? t.park?.question ?? ''
        : t.state === 'running' ? `stage ${t.stage ?? '?'}  port ${t.port ?? '-'}`
        : t.state === 'done' ? (t.result?.pr ? `PR #${t.result.pr}` : '')
        : '';
      console.log(`  ${t.state.toUpperCase().padEnd(8)} ${t.key.padEnd(9)} ${tail}`);
    }
    const parked = rows.filter((t) => t.state === 'parked').length;
    if (parked) console.log(`\n${parked} ticket(s) waiting on you.`);
    break;
  }

  default:
    console.log('usage: queue.mjs init|add|set|set-batch|park|front|drop|get|list|render');
    process.exit(cmd ? 1 : 0);
}
} catch (e) {
  console.error(`queue: ${e.message}`);
  process.exit(1);
}
