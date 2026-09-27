#!/usr/bin/env node
// Turn a set of triage records into a batch plan: admission, collisions, and the
// one batch of questions to put to the user before any code is written.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { stateDir, binDir, jiraName } from './desk-env.mjs';

const STATE = stateDir();
const QUEUE = join(binDir(), 'queue.mjs');
const tickets = process.argv.slice(2);
if (!tickets.length) { console.error('usage: plan-batch.mjs SV-XXX [SV-YYY ...]'); process.exit(1); }

const records = [];
for (const t of tickets) {
  const p = join(STATE, 'triage', `${t}.json`);
  if (!existsSync(p)) { console.error(`missing triage record for ${t} — run triage.sh ${t}`); process.exit(1); }
  records.push(JSON.parse(readFileSync(p, 'utf8')));
}

// Ownership boundary, the ticket equivalent of desk-clearance's "only your own PRs".
// Someone else's ticket is reported, never worked — they may already be on it, and a
// surprise branch against their ticket is worse than doing nothing. Jira reports the
// assignee by display name, so the owner is config §1's Jira display name. No default:
// a wrong name would admit someone else's tickets.
let OWNER;
try { OWNER = jiraName(); } catch (e) { console.error(e.message); process.exit(4); }
const notOurs = records.filter((r) => r.assignee && r.assignee !== OWNER);
const ours = records.filter((r) => !r.assignee || r.assignee === OWNER);

// Admission. C and D park at triage: both need a person before any code. C needs an agreed
// plan or a product answer, and D a design build checked against its frame.
const admitted = ours.filter((r) => ['A', 'B', 'E'].includes(r.lane));
const parked = ours.filter((r) => ['C', 'D'].includes(r.lane));

// Collision detection. Two tickets that touch the same file cannot run concurrently:
// they would conflict on the file, and worse, each is blind to a helper the other just
// added — a duplicate by this repo's own rules.
const collisions = [];
for (let i = 0; i < admitted.length; i++) {
  for (let j = i + 1; j < admitted.length; j++) {
    const a = new Set(admitted[i].files_in_scope ?? []);
    const shared = (admitted[j].files_in_scope ?? []).filter((f) => a.has(f));
    if (shared.length) collisions.push({ a: admitted[i].ticket, b: admitted[j].ticket, shared });
  }
}

const collidesWith = (t) => collisions.flatMap((c) => (c.a === t ? [c.b] : c.b === t ? [c.a] : []));

console.log(`\nBATCH PLAN — ${records.length} ticket(s)\n${'='.repeat(60)}`);
if (notOurs.length) {
  console.log('\nNOT YOURS — excluded from the batch:');
  for (const r of notOurs) console.log(`  ${r.ticket}: assigned to ${r.assignee}`);
}

for (const r of ours) {
  const admit = ['A', 'B', 'E'].includes(r.lane);
  const co = collidesWith(r.ticket);
  console.log(`\n${r.ticket}  lane ${r.lane}  ${admit ? 'ADMIT' : `PARK (lane ${r.lane} — run manually)`}`);
  console.log(`  ${r.summary}`);
  console.log(`  branch: ${r.branch}`);
  if (r.admin_api) console.log('  ! touches admin API — the Stop hook will require an openapi:gen');
  if (r.needs_db) console.log('  ! needs a database — its own per-ticket DB will be provisioned');
  if (co.length) console.log(`  ! collides with ${co.join(', ')} — must run sequentially`);
  for (const pa of r.prior_art ?? []) console.log(`  ! prior art: ${pa}`);
  if (r.lane_original) console.log(`  ~ lane ${r.lane_original} -> ${r.lane} at challenge: ${r.lane_challenge?.reason ?? ''}`);
}

if (parked.length) {
  console.log(`\n${'='.repeat(60)}\nPARKED AT TRIAGE (${parked.length}) — lanes C and D need a person, not run unattended:`);
  for (const r of parked) {
    console.log(`  ${r.ticket}: ${r.lane_reason}`);
    // A park is only trustworthy if the challenge actually ran. UNAVAILABLE means
    // it did not, so the lane is one unreviewed opinion — say so rather than let
    // it read as double-checked.
    const c = r.lane_challenge;
    if (!c) console.log('      (no challenge recorded)');
    else if (c.verdict === 'CONFIRM') console.log(`      challenge CONFIRMED: ${c.reason ?? ''}`);
    else console.log(`      ! challenge did not run (${c.reason ?? ''}) — lane is unreviewed`);
  }
}

const questions = admitted.flatMap((r) => (r.unknowns ?? []).map((u) => ({ ticket: r.ticket, q: u })));
console.log(`\n${'='.repeat(60)}`);
if (questions.length) {
  console.log(`QUESTIONS — ${questions.length} across ${new Set(questions.map((q) => q.ticket)).size} ticket(s).`);
  console.log('Answer these before spawning; nothing is built until they are settled.\n');
  questions.forEach((q, i) => console.log(`  ${i + 1}. [${q.ticket}] ${q.q}`));
} else {
  console.log('QUESTIONS — none. Every admitted ticket can start immediately.');
}

if (collisions.length) {
  console.log(`\nCOLLISIONS — ${collisions.length}:`);
  for (const c of collisions) console.log(`  ${c.a} ~ ${c.b}: ${c.shared.join(', ')}`);
}

// Seed the queue in argument order, which is spawn order: pass gates (the tickets most others
// wait on) first. A ticket that collides with another is marked so the spawn loop will not run
// them together.
if (process.env.AUTOPILOT_WRITE_QUEUE) {
  for (const r of ours) {
    execFileSync('node', [QUEUE, 'add', r.ticket, r.type ?? 'Bug', r.lane], { stdio: 'ignore' });
    const sets = [
      `lane=${r.lane}`, `branch=${r.branch}`,
      `state=${['A', 'B', 'E'].includes(r.lane) ? 'triaged' : 'parked'}`,
      `collides_with=${collidesWith(r.ticket).join('|') || 'null'}`,
      `open_questions=${(r.unknowns ?? []).length}`,
    ];
    execFileSync('node', [QUEUE, 'set', r.ticket, ...sets], { stdio: 'ignore' });
    if (['C', 'D'].includes(r.lane)) {
      execFileSync('node', [QUEUE, 'park', r.ticket, `lane ${r.lane} — ${r.lane_reason?.slice(0, 160) ?? 'needs a person'}`], { stdio: 'ignore' });
    }
  }
  console.log('\nqueue seeded.');
}
