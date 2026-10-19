#!/usr/bin/env node
// Turn a set of triage records into a batch plan: admission, collisions, Jira dependencies, and the
// one batch of questions to put to the user before any code is written. Offline: it reads only the
// triage records (with the facts ticket-facts.mjs merged into them) and, for an epic batch,
// $DESK_STATE/expansion.json from expand-parent.mjs.
// Exits 0 when every ticket can start with nothing to put to the person first, or 11 (show the
// person) when one needs them before Stage 3 (`needs_person`) and on any refusal or error: EXIT in
// batch-state.mjs. With --json, stdout is one object: status (go_on | show_person | error), code,
// message (the plan), needs_person ({ticket, why, detail}; why is question, lint,
// challenge_inconclusive, challenge_not_run or parked) and notify.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { laneUnchecked, lanePark, EXIT, crashShowsPerson, describeCrash, readTriage, readJsonOrRefuse } from './batch-state.mjs';
import { stateDir, binDir, queueFile, jiraName, githubHandle, configValue, permission, ticketKind, SAFE_ID } from './desk-env.mjs';

const AS_JSON = process.argv.includes('--json');
const plan = [];
const say = (s) => (AS_JSON ? plan.push(s) : console.log(s));
function verdict(status, message, needsPerson = []) {
  const code = status === 'go_on' ? EXIT.GO_ON : EXIT.SHOW_PERSON;
  if (AS_JSON) console.log(JSON.stringify({ status, code, message, needs_person: needsPerson, notify: code === EXIT.SHOW_PERSON }));
  else if (status === 'error') console.error(message);
  return code;
}
const refuse = (message) => process.exit(verdict('error', message));
crashShowsPerson((e) => verdict('error', describeCrash(e)));
const STATE = stateDir();
const QUEUE = join(binDir(), 'queue.mjs');
const tickets = process.argv.slice(2).filter((a) => a !== '--json');
if (!tickets.length) refuse('usage: plan-batch.mjs [--json] <TICKET> [<TICKET> ...]');

const records = [];
for (const t of tickets) {
  if (!SAFE_ID.test(t) || t.includes('..')) refuse(`'${t}' is not usable as a ticket id`);
  if (!existsSync(join(STATE, 'triage', `${t}.json`))) refuse(`missing triage record for ${t} — run triage.sh ${t}`);
  records.push(readTriage(STATE, t));
}

// Ownership boundary, the ticket equivalent of desk-clearance's "only your own PRs".
// Someone else's ticket is reported, never worked — they may already be on it, and a
// surprise branch against their ticket is worse than doing nothing. Jira reports the
// assignee by display name, so the owner is config §1's Jira display name. No default:
// a wrong name would admit someone else's tickets. With config §4 Tracker `none` a ticket is either
// a GitHub issue (`issue-<n>`), whose assignee is a GitHub login and is tested against config §1's
// GitHub handle (logins are case-insensitive), or a plain description, which has no assignee.
const noTracker = /^none\b/i.test(configValue('tracker') ?? '');
let OWNER;
try { OWNER = noTracker ? githubHandle() : jiraName(); } catch (e) { refuse(e.message); }
const isOwner = (a) => (noTracker ? String(a).toLowerCase() === OWNER.toLowerCase() : a === OWNER);
const notOurs = records.filter((r) => r.assignee && !isOwner(r.assignee));
const ours = records.filter((r) => !r.assignee || isOwner(r.assignee));

// Admission. C and D park at triage: both need a person before any code. C needs an agreed
// plan or a product answer, and D a design build checked against its frame. A ticket sized L or XL
// parks too: it is to be split, not run whole. Those parks always win over a dependency hold, so a
// release can never send one to a headless worker.
const laneOk = (r) => ['A', 'B', 'E'].includes(r.lane);
const sizeParked = (r) => laneOk(r) && ['L', 'XL'].includes(String(r.size ?? '').toUpperCase());
const parked = ours.filter((r) => ['C', 'D'].includes(r.lane));
// A C or D whose challenge could not read the code is shown as unchecked and asked about.
const unchecked = parked.filter(laneUnchecked);
const failedReads = (r) => (r.lane_challenge?.failed_reads ?? []).join('; ') || 'none listed';
const sized = ours.filter(sizeParked);
let admitted = ours.filter((r) => laneOk(r) && !sizeParked(r));

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

// Dependencies from Jira "is blocked by" links (ticket-facts.mjs). A blocker in the batch holds its
// successor until the blocker's PR merges (merge-driver.sh release_chain releases anything parked
// "held by orchestrator" once every --deps predecessor has merged). Anything the batch cannot settle
// by itself is a question, never a silent "no blockers": a blocker outside the batch that is not
// done, a blocker the batch will not build (parked, or someone else's), and a link list that was
// never read. An epic's container stories hand their links to the subtasks that replaced them.
const expansionPath = join(STATE, 'expansion.json');
// Only the expansion of this batch's own epic (queue.mjs set-batch epic=<KEY>): a file left by an
// earlier epic must not reshape an unrelated batch.
const batchEpic = (() => { try { return JSON.parse(readFileSync(queueFile(), 'utf8')).epic ?? null; } catch { return null; } })();
const expansion = existsSync(expansionPath)
  ? readJsonOrRefuse(expansionPath, `re-run expand-parent.mjs ${batchEpic ?? '<epic>'}`)
  : null;
const containers = expansion && batchEpic && expansion.parent === batchEpic ? (expansion.containers ?? {}) : {};
const containerOf = {};
for (const [c, v] of Object.entries(containers)) for (const sub of v.subtasks ?? []) containerOf[sub] = c;
const byKey = Object.fromEntries(records.map((r) => [r.ticket, r]));
const admittedKeys = new Set(admitted.map((r) => r.ticket));
const added = {};      // ticket -> questions plan-batch adds
const notes = {};      // ticket -> plan lines
const preds = {};      // ticket -> in-batch blockers it is held behind
const ask = (t, q) => (added[t] ??= []).push(q);
const note = (t, n) => (notes[t] ??= []).push(n);
let otherLinks = 0;

for (const r of admitted) {
  const t = r.ticket;
  if (r.facts_error) { ask(t, `dependencies could not be read (${r.facts_error}): check its Jira links, then answer to let it start`); continue; }
  if (r.links === 'n/a' || ticketKind(t).kind !== 'tracker') continue;
  if (!Array.isArray(r.blockers)) { ask(t, 'dependencies were never read for this ticket (its triage record has no link facts): re-run triage, or confirm it has no blockers'); continue; }
  otherLinks += r.other_links ?? 0;
  const list = [...r.blockers, ...(containerOf[t] ? containers[containerOf[t]].blocked_by ?? [] : [])];
  const seen = new Set();
  for (const b of list) {
    // A blocker that is a container means every one of its subtasks that is in this batch.
    const inner = containers[b.key] ? (containers[b.key].subtasks ?? []).filter((k) => byKey[k]) : [];
    for (const k of inner.length ? inner : [b.key]) {
      if (k === t || seen.has(k)) continue;
      seen.add(k);
      const br = byKey[k];
      if (br && admittedKeys.has(k)) (preds[t] ??= []).push(k);
      else if (br) {
        const why = !ours.includes(br) ? `assigned to ${br.assignee}` : sizeParked(br) ? `parked: size ${br.size}` : `parked: lane ${br.lane}`;
        ask(t, `${t} is blocked by ${k}, which this batch will not build (${why}): finish ${k} first, or confirm ${t} can start without it`);
      } else if (b.category === 'done') note(t, `blocker ${k} is done`);
      else ask(t, `${t} is blocked by ${k} (${b.category === 'indeterminate' ? 'in progress' : 'not started'}), which is not in this batch: add ${k} to the batch, or confirm ${t} can start without it`);
    }
  }
}

// A cycle can never release, so everything on one is parked for the user to fix the links. Every
// strongly connected group of two or more (Tarjan) is a cycle; a plain depth-first search misses a
// ticket that reaches the cycle only through a node it has already finished.
const onCycle = new Map();
{
  let n = 0; const idx = {}; const low = {}; const on = new Set(); const stack = [];
  const strong = (t) => {
    idx[t] = low[t] = n++; stack.push(t); on.add(t);
    for (const p of preds[t] ?? []) {
      if (idx[p] === undefined) { strong(p); low[t] = Math.min(low[t], low[p]); }
      else if (on.has(p)) low[t] = Math.min(low[t], idx[p]);
    }
    if (low[t] === idx[t]) {
      const group = [];
      let x;
      do { x = stack.pop(); on.delete(x); group.push(x); } while (x !== t);
      if (group.length > 1) { const label = `${group.reverse().join(' ↔ ')}`; for (const g of group) onCycle.set(g, label); }
    }
  };
  for (const r of admitted) if (idx[r.ticket] === undefined) strong(r.ticket);
}
for (const [t] of onCycle) delete preds[t];
for (const [t, ps] of Object.entries(preds)) {
  const bad = ps.filter((p) => onCycle.has(p));
  for (const p of bad) ask(t, `${t} is blocked by ${p}, which is on a dependency cycle: fix the Jira links first`);
  preds[t] = ps.filter((p) => !onCycle.has(p));
  if (!preds[t].length) delete preds[t];
}
admitted = admitted.filter((r) => !onCycle.has(r.ticket));
const held = (t) => !!preds[t]?.length;
const depsArg = Object.entries(preds).map(([t, ps]) => `${t}:${ps.join(',')}`).join(' ');

// Spawn order: blockers before what they block; otherwise the order the tickets were named in.
const order = [];
{
  const done = new Set(); const pending = [...ours];
  while (pending.length) {
    const i = pending.findIndex((r) => (preds[r.ticket] ?? []).every((p) => done.has(p)));
    const [r] = pending.splice(i < 0 ? 0 : i, 1);
    order.push(r); done.add(r.ticket);
  }
}

// What a ticket that needs a database will actually get, from the same rules setup-worktree.sh applies.
const localDb = (configValue('local-db') ?? '').trim();
const DB_NOTE = !localDb
  ? 'config §4 Local database is unset, so no per-ticket database is made and its database variables are blanked — a database-backed check will park'
  : /^none\b/i.test(localDb)
    ? 'config §4 Local database is none, so it gets NO database: every §4 Database URL variable is blanked in its worktree, and a database-backed check parks'
    : !/^postgres container\s+\S+$/i.test(localDb)
      ? `config §4 Local database is "${localDb}", which is not \`postgres container <name>\`, so no per-ticket database is made and its database variables are blanked — a database-backed check will park`
      : permission('db-per-ticket') !== 'yes'
        ? `config §3 db-per-ticket is ${permission('db-per-ticket')}, so no per-ticket database is made and its database variables are blanked — a database-backed check will park`
        : 'its own per-ticket database will be created in the local Postgres, or the worktree is not set up';

const collidesWith = (t) => collisions.flatMap((c) => (c.a === t ? [c.b] : c.b === t ? [c.a] : []));
// desk-jira lint's blocking findings (ticket-facts.mjs): each is something a worker would park on.
const lintBlocking = (r) => (r.lint ?? []).filter((f) => f.severity === 'blocking');

say(`\nBATCH PLAN — ${records.length} ticket(s)\n${'='.repeat(60)}`);
if (notOurs.length) {
  say('\nNOT YOURS — excluded from the batch:');
  for (const r of notOurs) say(`  ${r.ticket}: assigned to ${r.assignee}`);
}

const ticketVerdict = (r) => (laneUnchecked(r) ? `PARK (lane ${r.lane}, UNCHECKED — the challenge could not read the code; confirm or re-lane)`
  : ['C', 'D'].includes(r.lane) ? `PARK (lane ${r.lane} — run manually)`
  : sizeParked(r) ? `PARK (size ${String(r.size).toUpperCase()} — split it before batching)`
  : onCycle.has(r.ticket) ? `PARK (dependency cycle: ${onCycle.get(r.ticket)})`
  : held(r.ticket) ? `HELD (blocked by ${preds[r.ticket].join(', ')} — starts once their PRs merge)`
  : 'ADMIT');
for (const r of order) {
  const co = collidesWith(r.ticket);
  say(`\n${r.ticket}  lane ${r.lane}  size ${r.size ?? '-'}  ${ticketVerdict(r)}`);
  say(`  ${r.summary}`);
  say(`  branch: ${r.branch}`);
  if (r.needs_db) say(`  ! needs a database — ${DB_NOTE}`);
  if (co.length) say(`  ! collides with ${co.join(', ')} — must run sequentially`);
  for (const pa of r.prior_art ?? []) say(`  ! prior art: ${pa}`);
  for (const f of lintBlocking(r)) say(`  ! lint (blocking): ${f.message}`);
  if (r.lint_error) say(`  ! lint did not run: ${r.lint_error}`);
  if (r.lane_original) say(`  ~ lane ${r.lane_original} -> ${r.lane} at challenge: ${r.lane_challenge?.reason ?? ''}`);
  for (const n of notes[r.ticket] ?? []) say(`  ~ ${n}`);
}

const linted = ours.filter((r) => lintBlocking(r).length || r.lint_error);
if (linted.length) {
  say(`\n${'='.repeat(60)}\nLINT — ${linted.length} ticket(s) a worker would park on; fix each ticket (desk-jira lint <KEY>) before spawning:`);
  for (const r of linted) say(`  ${r.ticket}: ${r.lint_error ? `lint did not run (${r.lint_error})` : `${lintBlocking(r).length} blocking finding(s)`}`);
}
if (sized.length) {
  say(`\n${'='.repeat(60)}\nPARKED ON SIZE (${sized.length}) — L and XL are split before they are batched:`);
  for (const r of sized) say(`  ${r.ticket}: size ${String(r.size).toUpperCase()}`);
}
if (parked.length) {
  say(`\n${'='.repeat(60)}\nPARKED AT TRIAGE (${parked.length}) — lanes C and D need a person, not run unattended:`);
  for (const r of parked) {
    say(`  ${r.ticket}: ${r.lane_reason}`);
    // A park is only trustworthy if the challenge actually ran. UNAVAILABLE means
    // it did not, so the lane is one unreviewed opinion — say so rather than let
    // it read as double-checked.
    const c = r.lane_challenge;
    if (!c) say('      (no challenge recorded)');
    else if (c.verdict === 'CONFIRM') say(`      challenge CONFIRMED: ${c.reason ?? ''}`);
    else if (laneUnchecked(r)) say(`      ! challenge INCONCLUSIVE — lane is unchecked, reads failed: ${failedReads(r)}`);
    else say(`      ! challenge did not run (${c.reason ?? ''}) — lane is unreviewed`);
  }
}

for (const r of unchecked) {
  ask(r.ticket, `lane ${r.lane} is unchecked: its challenge could not read the code (${failedReads(r)}). Confirm lane ${r.lane}, or re-lane it to A, B or E`);
}
const qsOf = (r) => [...(r.unknowns ?? []), ...(added[r.ticket] ?? [])];
// A parked ticket's own unknowns wait for whoever works it; only its lane question is asked now.
const questions = [
  ...admitted.flatMap((r) => qsOf(r).map((u) => ({ ticket: r.ticket, q: u }))),
  ...unchecked.flatMap((r) => (added[r.ticket] ?? []).map((u) => ({ ticket: r.ticket, q: u }))),
];
say(`\n${'='.repeat(60)}`);
if (questions.length) {
  say(`QUESTIONS — ${questions.length} across ${new Set(questions.map((q) => q.ticket)).size} ticket(s).`);
  say('Answer these before spawning; nothing is built until they are settled.\n');
  questions.forEach((q, i) => say(`  ${i + 1}. [${q.ticket}] ${q.q}`));
} else {
  say('QUESTIONS — none. Every admitted ticket can start immediately.');
}

if (collisions.length) {
  say(`\nCOLLISIONS — ${collisions.length}:`);
  for (const c of collisions) say(`  ${c.a} ~ ${c.b}: ${c.shared.join(', ')}`);
}

if (depsArg) {
  say(`\nDEPENDENCIES — from Jira links (held tickets start once every blocker's PR merges):`);
  for (const [t, ps] of Object.entries(preds)) say(`  ${t} held: blocked by ${ps.join(', ')}`);
  say(`--deps "${depsArg}"`);
  say('Pass it to merge-driver.sh, joined with any collision chain (one entry per successor, predecessors unioned).');
}
const unsized = ours.filter((r) => laneOk(r) && !r.size).map((r) => r.ticket);
if (unsized.length) say(`\n! no size on ${unsized.length} ticket(s): ${unsized.join(', ')} — they run on their lane; size them (desk-jira's scale) so anything L or bigger is split`);
if (otherLinks) say(`\n! ${otherLinks} Jira link(s) of another type ignored — only Blocks ("is blocked by") is honoured`);

// Seed the queue in spawn order: blockers first, then the order the tickets were named in (pass
// gates first). A ticket that collides with another is marked so the spawn loop will not run them
// together. Park precedence: lane, size, cycle, then the dependency hold.
if (process.env.AUTOPILOT_WRITE_QUEUE) {
  for (const r of order) {
    const t = r.ticket;
    execFileSync('node', [QUEUE, 'add', t, r.type ?? 'Bug', r.lane], { stdio: 'ignore' });
    const runnable = admitted.includes(r) && !held(t);
    const sets = [
      `lane=${r.lane}`, `branch=${r.branch}`,
      `state=${runnable ? 'triaged' : 'parked'}`,
      `collides_with=${collidesWith(t).join('|') || 'null'}`,
      `open_questions=${laneOk(r) ? qsOf(r).length : (r.unknowns ?? []).length}`,
      `held_by=${held(t) ? preds[t].join('|') : 'null'}`,
    ];
    execFileSync('node', [QUEUE, 'set', t, ...sets], { stdio: 'ignore' });
    const park = lanePark(r)
      ?? (sizeParked(r) ? `size ${String(r.size).toUpperCase()} — split it before batching`
      : onCycle.has(t) ? `dependency cycle: ${onCycle.get(t)} — fix the Jira links`
      : held(t) ? `held by orchestrator: blocked by ${preds[t].join(', ')} (Jira link) — starts once their PRs merge`
      : null);
    if (park) execFileSync('node', [QUEUE, 'park', t, park], { stdio: 'ignore' });
  }
  say('\nqueue seeded.');
}

// ---- verdict -------------------------------------------------------------
// Everything the person settles before Stage 3, so the orchestrator branches on this rather than on
// the plan's wording: each question, each ticket a worker would park on for its lint, each lane C or D
// park whose challenge did not confirm it, and each park (lane, size, cycle; a hold is not one).
const cycled = ours.filter((r) => onCycle.has(r.ticket));
const needsPerson = [
  ...questions.map((q) => ({ ticket: q.ticket, why: 'question', detail: q.q })),
  ...linted.map((r) => ({ ticket: r.ticket, why: 'lint',
    detail: r.lint_error ? `lint did not run (${r.lint_error})` : `${lintBlocking(r).length} blocking finding(s): fix the ticket (desk-jira lint ${r.ticket})` })),
  ...parked.filter((r) => r.lane_challenge?.verdict !== 'CONFIRM').map((r) => (laneUnchecked(r)
    ? { ticket: r.ticket, why: 'challenge_inconclusive', detail: `lane ${r.lane} is unchecked, reads failed: ${failedReads(r)}` }
    : { ticket: r.ticket, why: 'challenge_not_run', detail: `lane ${r.lane} is unreviewed: ${r.lane_challenge?.reason ?? 'no challenge recorded'}` })),
  ...[...parked, ...sized, ...cycled].map((r) => ({ ticket: r.ticket, why: 'parked', detail: ticketVerdict(r) })),
];
if (needsPerson.length) say(`\nNEEDS YOU BEFORE STAGE 3: ${needsPerson.length} item(s) — ${[...new Set(needsPerson.map((n) => n.ticket))].join(', ')}`);
// exitCode, not exit(): a long plan to a pipe must flush before the process ends.
process.exitCode = verdict(needsPerson.length ? 'show_person' : 'go_on', plan.join('\n'), needsPerson);
