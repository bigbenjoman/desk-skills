#!/usr/bin/env node
// Answer a ticket's open question — either a triage unknown (before it is spawned)
// or a live worker's paused question (while it waits).
//
// It RECORDS the answer; it never changes a ticket's state. A parked ticket stays parked: whether
// it resumes, is requeued, or is finished by hand is the orchestrator's decision (the autopilot
// skill and orchestrator-recovery.md), because a park can be a lane C/D ticket that must not run
// unattended at all, and un-parking here once sent exactly such a ticket to a headless worker.
// Exits 0 once the answer is recorded, or 11 (show the person) on any refusal or error: EXIT in
// batch-state.mjs.
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { stateDir, binDir, queueFile, configValue, SAFE_ID } from './desk-env.mjs';
import { isHeld, HELD_PREFIX, EXIT, crashShowsPerson, readQueue, refusedStep, neverStep, grantFor } from './batch-state.mjs';
import { NOT_NOW, putOffEntry, addPutOff, clearPutOff, notNowPath } from './not-now.mjs';
import { useTicketBatch } from './batches.mjs';

crashShowsPerson();
const QUEUE = join(binDir(), 'queue.mjs');

const [ticket, ...args] = process.argv.slice(2);
// --approve says outright that the answer approves the step its park asks for (batch-state.mjs grantFor).
const approveFlag = args[0] === '--approve';
const rest = approveFlag ? args.slice(1) : args;
const text = rest.join(' ').trim();
if (!ticket || !text) {
  console.error('usage: answer.mjs <TICKET> [--approve] "<the answer>"');
  process.exit(EXIT.SHOW_PERSON);
}
if (!SAFE_ID.test(ticket) || ticket.includes('..')) {
  console.error(`'${ticket}' is not usable as a ticket id (letters, digits, . _ - only; no ..)`);
  process.exit(EXIT.SHOW_PERSON);
}
// The answer goes to the batch holding the ticket, and the queue.mjs it runs follows (DESK_BATCH).
useTicketBatch(ticket);
const STATE = stateDir();

mkdirSync(join(STATE, 'answers'), { recursive: true });
mkdirSync(join(STATE, 'briefings'), { recursive: true });

const stamp = new Date().toISOString();
const putOffAnswer = NOT_NOW.test(text);
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
  // A held ticket releases by itself, and a put-off one waits for its inputs to change.
  if (parkedReason && !parkedReason.startsWith(HELD_PREFIX) && !putOffAnswer) {
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

// A "not now" answer to a park puts its question off: it goes in the register with the inputs it
// depends on, and is not asked again until they change (not-now.mjs). Any other answer to it ends an
// earlier deferral, so the same question parked again is asked. Only a park is put off: a running
// worker's question is not in the queue yet, and triage unknowns are cleared by any answer.
try {
  const t = existsSync(queueFile()) ? readQueue(queueFile()).tickets?.[ticket] : null;
  const question = t?.state === 'parked' && t.park?.question && !isHeld(t) ? t.park.question : null;
  if (putOffAnswer && question) {
    let by = null;
    try { by = configValue('name') ?? null; } catch { /* outside a repo */ }
    addPutOff(putOffEntry({ question, ticket, inputs: t.park.inputs ?? {}, by, at: stamp }), STATE);
    console.log(`${ticket}: put off in ${notNowPath(STATE)}; it is not asked again until its inputs change.`);
  } else if (putOffAnswer) {
    console.log(`${ticket}: "not now", but it has no parked question to put off, so nothing went in the register.`);
  } else if (question && clearPutOff(question, STATE).ok) {
    console.log(`${ticket}: answered, so its question is no longer put off.`);
  }
} catch (e) {
  console.error(`${ticket}: answer recorded in the briefing, but the not-now register was not updated: ${e.message}`);
}

// An answer approving the step a park was refused records it as the ticket's one-off grant, which the
// next worker's settings allow as that exact command (worker-settings.mjs). A step no worker is ever
// allowed gets no grant: a requeue would only park it again, so it is a session's.
try {
  const t = existsSync(queueFile()) ? readQueue(queueFile()).tickets?.[ticket] : null;
  if (t?.state === 'parked' && !isHeld(t) && !putOffAnswer && refusedStep(t.park?.question)) {
    const remoteSha = (branch) => {
      if (!t.worktree) return null;
      try { return execFileSync('git', ['-C', t.worktree, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch { return null; }
    };
    const g = grantFor({ t, text, approve: approveFlag, remoteSha });
    if (g.grant) {
      execFileSync('node', [QUEUE, 'set', ticket, `grant=${JSON.stringify(g.grant)}`], { stdio: 'ignore' });
      console.log(`${ticket}: approved once: its next worker may run \`git push --force-with-lease=${g.grant.branch}:${g.grant.lease} origin ${g.grant.branch}\`, and nothing wider.`);
    } else if (neverStep(t.park?.question)) {
      console.log(`${ticket}: ${g.why}: do not requeue it for a worker. Open an interactive session and run /desk-ticket ${ticket}.`);
    } else {
      console.log(`${ticket}: no grant recorded (${g.why}).`);
    }
  }
} catch (e) {
  console.error(`${ticket}: answer recorded in the briefing, but its grant was not: ${e.message}`);
}

// A triaged ticket's questions are its triage unknowns: clearing the count is what makes it eligible
// to spawn, and answering them is exactly what the user was asked to do. A parked ticket's count
// clears too, but it is left parked, with its park intact, for the orchestrator to decide.
try {
  const Q = existsSync(queueFile()) ? readQueue(queueFile()) : { tickets: {} };
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
      // The count is not the park: a parked ticket stays parked, but its questions are answered, so
      // a re-laned ticket can be requeued (queue.mjs requeue refuses open questions).
      execFileSync('node', [QUEUE, 'set', ticket, 'open_questions=0'], { stdio: 'ignore' });
      if (putOffAnswer) {
        console.log(`${ticket}: put off. It stays parked and is not asked again until its inputs change ` +
          '(or `digest.mjs ask-again` clears it): do not requeue it or do the parked step.');
      } else {
        console.log(`${ticket}: answer recorded in its briefing. It is STILL PARKED — the orchestrator decides whether it ` +
          'resumes, is requeued (`queue.mjs requeue <TICKET>`), or is finished by hand. A lane C or D ' +
          'park is never requeued for a headless worker.');
      }
    } else {
      console.log(`${ticket}: answer recorded (state ${st}).`);
    }
  } else {
    console.log(`${ticket}: answer recorded (not in the queue yet — it will be read at spawn).`);
  }
} catch (e) {
  console.error(`answer recorded, but the queue could not be updated: ${e.message}`);
  process.exit(EXIT.SHOW_PERSON);
}
