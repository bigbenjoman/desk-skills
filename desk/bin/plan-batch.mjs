#!/usr/bin/env node
// Turn a set of triage records into a batch plan: admission, collisions, Jira dependencies, and the
// one batch of questions to put to the user before any code is written. Offline: it reads only the
// triage records (with the facts ticket-facts.mjs merged into them) and, for an epic batch,
// $DESK_STATE/expansion.json from expand-parent.mjs and the feature plan the orchestrator drafts into
// $DESK_STATE/feature.json.
// Exits 0 when every ticket can start with nothing to put to the person first, or 11 (show the
// person) when one needs them before Stage 3 (`needs_person`) and on any refusal or error: EXIT in
// batch-state.mjs. With --json, stdout is one object: status (go_on | show_person | error), code,
// message (the plan), needs_person ({ticket, why, detail}; why is question, lint,
// challenge_inconclusive, challenge_not_run, parked or feature_plan) and notify.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { laneUnchecked, lanePark, EXIT, crashShowsPerson, describeCrash, readTriage, readJsonOrRefuse } from './batch-state.mjs';
import { stateDir, binDir, queueFile, jiraName, githubHandle, configValue, configValues, isNone, batchBase, permission, ticketKind, SAFE_ID } from './desk-env.mjs';

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
const holdWhy = {};    // ticket -> blocker -> what makes it one (a Jira link, or the feature plan)
const holdBehind = (t, p, why) => {
  if (t === p) return;
  const w = (holdWhy[t] ??= {});
  if (!w[p]) (preds[t] ??= []).push(p);
  w[p] = w[p] ? `${w[p]}; ${why}` : why;
};
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
      if (br && admittedKeys.has(k)) holdBehind(t, k, 'Jira link');
      else if (br) {
        const why = !ours.includes(br) ? `assigned to ${br.assignee}` : sizeParked(br) ? `parked: size ${br.size}` : `parked: lane ${br.lane}`;
        ask(t, `${t} is blocked by ${k}, which this batch will not build (${why}): finish ${k} first, or confirm ${t} can start without it`);
      } else if (b.category === 'done') note(t, `blocker ${k} is done`);
      else ask(t, `${t} is blocked by ${k} (${b.category === 'indeterminate' ? 'in progress' : 'not started'}), which is not in this batch: add ${k} to the batch, or confirm ${t} can start without it`);
    }
  }
}

// Feature mode: an epic run on a batch base, in a repo whose §4 Acceptance specs names the spec
// directory and a command taking {ids}, with numbered criteria read by expand-parent. A spine child
// lands one expected-fail spec per criterion and every other child is held behind it; each criterion
// has one owning child, held behind every other child that contributes to it. The orchestrator drafts
// the spine and the owner table into feature.json at Stage 2; the spine is filed once the person
// approves it at Stage 3 and is planned with the rest. An ordinary batch says nothing about it.
//   {epic, spine: <KEY> | null, draft: "<the spine ticket as drafted>", owners: {<id>: <KEY>},
//    contributors: {<id>: [<KEY>]}, untestable: {<id>: {why, close_out: true once agreed}}}
const featurePath = join(STATE, 'feature.json');
const featureQs = [];  // questions on the epic's feature plan
const tableHolds = new Set();  // `<owner>><contributor>`: holds the owner table made
const feature = (() => {
  if (!batchEpic) return null;
  const off = (why) => ({ on: false, why });
  let base; let specs;
  try { base = batchBase(); specs = configValues('acceptance-specs'); } catch (e) { return off(e.message); }
  if (!base) return off('the batch has no base branch (queue.mjs set-batch base=<branch>), so each child merges to the default branch on its own');
  if (!specs) return off('config §4 Acceptance specs is unset (run /desk-setup, or set it to `none`)');
  if (isNone(specs)) return off('config §4 Acceptance specs is none');
  if (!specs.some((s) => s.includes('{ids}'))) return off('config §4 Acceptance specs has no command taking {ids}');
  const criteria = expansion?.parent === batchEpic ? expansion.criteria : null;
  if (!Array.isArray(criteria)) return off(`the criteria of ${batchEpic} were not read: re-run expand-parent.mjs ${batchEpic}`);
  if (!criteria.length) return off(`${batchEpic} has no numbered criteria (DoD or AC ids)`);
  let plan = existsSync(featurePath) ? readJsonOrRefuse(featurePath, `rewrite it for ${batchEpic}`) : null;
  const stale = plan && plan.epic !== batchEpic ? `feature.json is for ${plan.epic ?? 'no epic'}, not ${batchEpic}` : null;
  if (stale) plan = null;
  const spine = plan?.spine ?? null;
  const sr = spine ? byKey[spine] : null;
  if (sr && !admittedKeys.has(spine)) {
    const why = !ours.includes(sr) ? `assigned to ${sr.assignee}` : sizeParked(sr) ? `size ${String(sr.size).toUpperCase()}` : `lane ${sr.lane}`;
    return off(`the spine ${spine} is parked at triage (${why}), so feature mode stops for this batch and its children run as an ordinary batch`);
  }
  return { on: true, base, specs, criteria, plan, stale, spine, filed: !!sr };
})();

if (feature?.on && feature.plan) {
  const { criteria, plan, spine } = feature;
  const ids = new Set(criteria.map((c) => c.id));
  const child = (k) => admittedKeys.has(k) && k !== spine;
  const owners = plan.owners ?? {};
  const contributors = plan.contributors ?? {};
  const untestable = plan.untestable ?? {};
  for (const id of new Set([...Object.keys(owners), ...Object.keys(contributors), ...Object.keys(untestable)])) {
    if (!ids.has(id)) featureQs.push(`${id} in feature.json is not one of ${batchEpic}'s criteria (${[...ids].join(', ')}): fix the owner table`);
  }
  for (const { id } of criteria) {
    const o = owners[id];
    const u = untestable[id];
    if (o && !child(o)) featureQs.push(`${id}'s owner ${o} is not a child this batch builds${o === spine ? ' (the spine writes the spec, a child makes it pass)' : ''}: name another owner`);
    else if (!o && u && u.close_out !== true) featureQs.push(`${id} cannot be written as a test (${(typeof u === 'string' ? u : u.why) || 'no reason given'}): leave it to the epic close-out check?`);
    else if (!o && !u) featureQs.push(`${id} has no owner: name the child whose PR makes its spec pass`);
    for (const p of contributors[id] ?? []) {
      if (!child(p)) featureQs.push(`${id}'s contributor ${p} is not a child this batch builds: drop it from the table or add it to the batch`);
      else if (o && child(o)) { holdBehind(o, p, `${id}: completes what ${p} contributes`); tableHolds.add(`${o}>${p}`); }
    }
  }
  if (feature.filed) for (const r of admitted) if (r.ticket !== spine) holdBehind(r.ticket, spine, 'feature spine');
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
// A cycle through a feature-plan hold keeps the queue unseeded: one through an owner-table hold is the
// table's to fix; one through the spine hold alone is the spine's Jira links to a child.
const tableCycles = new Set();
const spineCycles = new Set();
for (const [t, label] of onCycle) {
  for (const p of preds[t] ?? []) {
    if (onCycle.get(p) !== label) continue;
    if (tableHolds.has(`${t}>${p}`)) tableCycles.add(label);
    else if (p === feature?.spine && feature.filed) spineCycles.add(label);
  }
}
for (const label of tableCycles) featureQs.push(`the owner table makes a dependency cycle (${label}): change an owner or a contributor in feature.json`);
for (const label of spineCycles) {
  if (!tableCycles.has(label)) featureQs.push(`the spine ${feature.spine} is on a dependency cycle (${label}) through its Jira links to a child: drop the link, or choose another spine`);
}
const cycleFix = (label) => (tableCycles.has(label) ? 'fix the owner table in feature.json, or the Jira links' : 'fix the Jira links');
for (const [t] of onCycle) delete preds[t];
for (const [t, ps] of Object.entries(preds)) {
  const bad = ps.filter((p) => onCycle.has(p));
  for (const p of bad) ask(t, `${t} is blocked by ${p}, which is on a dependency cycle: ${cycleFix(onCycle.get(p))} first`);
  preds[t] = ps.filter((p) => !onCycle.has(p));
  if (!preds[t].length) delete preds[t];
}
admitted = admitted.filter((r) => !onCycle.has(r.ticket));
const held = (t) => !!preds[t]?.length;
const heldBy = (t) => preds[t].map((p) => `${p} (${holdWhy[t][p]})`).join(', ');
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

if (feature && !feature.on) say(`\n${'='.repeat(60)}\nFEATURE MODE — off: ${feature.why}`);
if (feature?.on) {
  const { criteria, plan, spine, base, specs } = feature;
  say(`\n${'='.repeat(60)}\nFEATURE MODE — on: ${batchEpic} on base ${base}, ${criteria.length} criteria, specs ${specs.map((s) => `\`${s}\``).join(' ')}`);
  if (!plan) say(`  no feature plan yet${feature.stale ? ` (${feature.stale})` : ''}: draft the spine ticket and the owner table into ${featurePath}, then re-run plan-batch`);
  else {
    if (feature.filed) say(`  spine ${spine}: lands first, and every other child is held behind it`);
    else {
      say(`  spine${spine ? ` ${spine}` : ''}: ${spine ? 'not in this batch: triage it and plan it with the rest' : 'not filed yet; filed under the epic through desk-jira once approved at Stage 3'}. Drafted:`);
      for (const l of String(plan.draft ?? '(no draft in feature.json)').split('\n')) say(`    | ${l}`);
    }
    const width = Math.max(9, ...criteria.map((c) => c.id.length));
    say(`  ${'criterion'.padEnd(width)}  ${'owner'.padEnd(10)}  held behind`);
    for (const { id, text } of criteria) {
      const o = plan.owners?.[id];
      const u = plan.untestable?.[id];
      const who = o ?? (u?.close_out === true ? 'close-out' : u ? 'close-out?' : '?');
      const behind = o ? (plan.contributors?.[id] ?? []).filter((p) => p !== o).join(', ') : '';
      say(`  ${id.padEnd(width)}  ${who.padEnd(10)}  ${behind || '-'}   ${text.length > 70 ? `${text.slice(0, 67)}...` : text}`);
    }
  }
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
  ...featureQs.map((u) => ({ ticket: batchEpic, q: u })),
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
  say(`\nDEPENDENCIES — from Jira links${feature?.on ? ' and the feature plan' : ''} (held tickets start once every blocker's PR merges):`);
  for (const [t, ps] of Object.entries(preds)) say(`  ${t} held: blocked by ${heldBy(t)}`);
  say(`--deps "${depsArg}"`);
  say('Pass it to merge-driver.sh, joined with any collision chain (one entry per successor, predecessors unioned).');
}
const unsized = ours.filter((r) => laneOk(r) && !r.size).map((r) => r.ticket);
if (unsized.length) say(`\n! no size on ${unsized.length} ticket(s): ${unsized.join(', ')} — they run on their lane; size them (desk-jira's scale) so anything L or bigger is split`);
if (otherLinks) say(`\n! ${otherLinks} Jira link(s) of another type ignored — only Blocks ("is blocked by") is honoured`);

// Seed the queue in spawn order: blockers first, then the order the tickets were named in (pass
// gates first). A ticket that collides with another is marked so the spawn loop will not run them
// together. Park precedence: lane, size, cycle, then the dependency hold.
// In feature mode nothing is seeded until the spine is filed and planned and the owner table is
// settled: seeded without them, every child would start with nothing held behind the spine.
const featureUnsettled = feature?.on && (!feature.filed || featureQs.length)
  ? (!feature.plan ? `no feature plan: draft the spine and the owner table into ${featurePath}`
    : !feature.filed ? 'the spine is not filed and planned: file it once approved, triage it, set its key as spine in feature.json and plan it with the rest'
      : `${featureQs.length} question(s) on the owner table: settle them in feature.json`)
  : null;
if (process.env.AUTOPILOT_WRITE_QUEUE && featureUnsettled) refuse(`feature mode is on for ${batchEpic}, so the queue is not seeded: ${featureUnsettled}, then re-run plan-batch`);
if (process.env.AUTOPILOT_WRITE_QUEUE) {
  // pass.mjs reads this decision rather than re-deriving it from feature.json, which can name the
  // epic and a spine in a batch that runs as an ordinary one (a spine parked at triage, say).
  // The spine and the criterion ids it owes a spec for go with it: pass.mjs checks the finished spine
  // against them before it parks for the person's approval.
  const spineIds = feature?.on ? feature.criteria.map((c) => c.id).filter((id) => feature.plan.owners?.[id] || !feature.plan.untestable?.[id]) : null;
  execFileSync('node', [QUEUE, 'set-batch', `feature=${feature?.on === true}`, `spine=${feature?.on ? feature.spine : 'null'}`,
    `spine_ids=${spineIds ? JSON.stringify(spineIds) : 'null'}`], { stdio: 'ignore' });
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
      : onCycle.has(t) ? `dependency cycle: ${onCycle.get(t)} — ${cycleFix(onCycle.get(t))}`
      : held(t) ? `held by orchestrator: blocked by ${heldBy(t)} — starts once their PRs merge`
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
  ...(feature?.on && !feature.filed ? [{ ticket: batchEpic, why: 'feature_plan',
    detail: feature.plan ? 'approve the drafted spine and owner table, then file the spine under the epic and plan it with the rest' : `draft the spine and the owner table into ${featurePath}, then re-run plan-batch` }] : []),
];
if (needsPerson.length) say(`\nNEEDS YOU BEFORE STAGE 3: ${needsPerson.length} item(s) — ${[...new Set(needsPerson.map((n) => n.ticket))].join(', ')}`);
// exitCode, not exit(): a long plan to a pipe must flush before the process ends.
process.exitCode = verdict(needsPerson.length ? 'show_person' : 'go_on', plan.join('\n'), needsPerson);
