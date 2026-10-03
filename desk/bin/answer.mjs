#!/usr/bin/env node
// Answer a ticket's open question — either a triage unknown (before it is spawned)
// or a live worker's paused question (while it waits).
//
// It RECORDS the answer; it never changes a ticket's state. A parked ticket stays parked: whether
// it resumes, is requeued, or is finished by hand is the orchestrator's decision (the autopilot
// skill and orchestrator-recovery.md), because a park can be a lane C/D ticket that must not run
// unattended at all, and un-parking here once sent exactly such a ticket to a headless worker.
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { stateDir, binDir, queueFile, SAFE_ID } from './desk-env.mjs';
import { isHeld, HELD_PREFIX } from './batch-state.mjs';

const STATE = stateDir();
const QUEUE = join(binDir(), 'queue.mjs');

const [ticket, ...rest] = process.argv.slice(2);
const text = rest.join(' ').trim();
if (!ticket || !text) {
  console.error('usage: answer.mjs <TICKET> "<the answer>"');
  process.exit(1);
}
if (!SAFE_ID.test(ticket) || ticket.includes('..')) {
  console.error(`'${ticket}' is not usable as a ticket id (letters, digits, . _ - only; no ..)`);
  process.exit(2);
}

mkdirSync(join(STATE, 'answers'), { recursive: true });
mkdirSync(join(STATE, 'briefings'), { recursive: true });

const stamp = new Date().toISOString();
// Is a worker actually live for this ticket right now? Only then does the mailbox make sense.
let waiting = false;
let sessionId = null;
let parkedReason = null;
try {
  const Q0 = JSON.parse(readFileSync(queueFile(), 'utf8'));
  const sid = Q0.tickets?.[ticket]?.session_id;
  sessionId = sid ?? null;
  const park = Q0.tickets?.[ticket]?.park;
  if (park) parkedReason = (park.question ?? JSON.stringify(park)).slice(0, 300);
  if (sid) {
    const live = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' }));
    waiting = Array.isArray(live) && live.some((a) => a.sessionId === sid);
  }
} catch { waiting = false; }

// The answers/ file is a mailbox for a worker that is WAITING RIGHT NOW. Writing it when
// nobody is waiting leaves a stale file that satisfies the next worker's wait instantly,
// so its very first wait reads as answered. Triage answers go to the briefing only.
//
// A parked worker exits almost at once (it cannot block under dontAsk), so an answer that
// needs a human routinely arrives after the worker has gone. That is not a delivery failure
// to retry; the work is simply nobody's until the orchestrator picks it up. Say so loudly:
// a one-line "(no worker waiting)" reads as though it had been handled.
//
// A RUNNING (not parked) worker does not poll the mailbox either — use SendMessage for it.
if (waiting) {
  writeFileSync(join(STATE, 'answers', `${ticket}.txt`), `${text}\n`);
  console.log(`(worker for ${ticket} is live — mailbox written. It only reads the mailbox while parked; if it is working, SendMessage it instead and delete the file.)`);
} else {
  console.log(
    sessionId
      ? `(worker for ${ticket} has EXITED — nothing received this answer)`
      : `(no worker running for ${ticket} — recorded in the briefing, not the mailbox)`,
  );
  if (parkedReason && !parkedReason.startsWith(HELD_PREFIX)) {   // a held ticket releases by itself
    console.log(
      `\n!! ${ticket} is parked and no worker will act on this answer.\n` +
        '   THE ORCHESTRATOR MUST COMPLETE THE PARKED STEP ITSELF, or requeue the ticket\n' +
        '   (see references/orchestrator-recovery.md). Do not assume answering was enough.\n' +
        `   Parked on: ${parkedReason}`,
    );
  }
}

// The briefing is what a future or resumed worker actually reads, so the answer has to
// survive there too — the answers file is consumed and deleted by the worker.
const brief = join(STATE, 'briefings', `${ticket}.md`);
const entry = `\n## Answer from the user (${stamp})\n\n${text}\n`;
if (existsSync(brief)) appendFileSync(brief, entry);
else writeFileSync(brief, `# Briefing for ${ticket}\n${entry}`);

// A triaged ticket's questions are its triage unknowns: clearing the count is what makes it eligible
// to spawn, and answering them is exactly what the user was asked to do. A parked ticket is left
// parked, with its park intact, for the orchestrator to decide.
try {
  const Q = existsSync(queueFile()) ? JSON.parse(readFileSync(queueFile(), 'utf8')) : { tickets: {} };
  if (Q.tickets?.[ticket]) {
    const st = Q.tickets[ticket].state;
    if (isHeld(Q.tickets[ticket])) {
      // Held behind a Jira blocker: the answer settles its questions, and the hold stays, so it
      // still starts only once the blocker's PR has merged (release_chain, or the sanctioned release).
      execFileSync('node', [QUEUE, 'set', ticket, 'open_questions=0'], { stdio: 'ignore' });
      console.log(`${ticket}: answered. It is held — it releases when ${String(Q.tickets[ticket].held_by ?? '?').split('|').join(', ')} merge${String(Q.tickets[ticket].held_by ?? '').includes('|') ? '' : 's'}.`);
    } else if (st === 'triaged' || st === 'queued') {
      execFileSync('node', [QUEUE, 'set', ticket, 'open_questions=0'], { stdio: 'ignore' });
      console.log(`${ticket}: answered.`);
    } else if (st === 'parked') {
      console.log(`${ticket}: answer recorded in its briefing. It is STILL PARKED — the orchestrator decides whether it ` +
        'resumes, is requeued (`queue.mjs set <TICKET> state=triaged park=null`), or is finished by hand. A lane C or D ' +
        'park is never requeued for a headless worker.');
    } else {
      console.log(`${ticket}: answer recorded (state ${st}).`);
    }
  } else {
    console.log(`${ticket}: answer recorded (not in the queue yet — it will be read at spawn).`);
  }
} catch (e) {
  console.error(`answer recorded, but the queue could not be updated: ${e.message}`);
  process.exit(1);
}
