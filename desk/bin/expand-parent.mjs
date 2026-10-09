#!/usr/bin/env node
// Expand an epic into the keys an autopilot batch runs. Deterministic: no model.
//
//   expand-parent.mjs <EPIC>              an epic's open children
//   expand-parent.mjs <STORY> --subtasks  a story's open subtasks, only when the user asked for that
//
// stdout: the batch keys, one per line, in Jira rank order. stderr: what was dropped and why.
// Writes $DESK_STATE/expansion.json ({parent, containers: {<story>: {subtasks, blocked_by}}}) so
// plan-batch can carry a container's Blocks links over to the subtasks that replace it.
//
// Exit: 0 keys printed · 3 nothing open under it · 4 not an epic (run it as an ordinary ticket) ·
// 1/2 a read failed or the argument is unusable. A failure never prints an empty batch.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { stateDir, ticketKind } from './desk-env.mjs';

const [key, ...flags] = process.argv.slice(2);
const subtasks = flags.includes('--subtasks');
if (!key || flags.some((f) => f !== '--subtasks')) { console.error('usage: expand-parent.mjs <EPIC> | <STORY> --subtasks'); process.exit(2); }
if (!/^[A-Z][A-Z0-9]*-[0-9]+$/.test(key)) { console.error(`'${key}' is not an issue key`); process.exit(2); }

const jira = (...args) => {
  try { return JSON.parse(execFileSync('desk-jira', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })); }
  catch (e) {
    const why = String(e.stderr ?? e.message ?? e).trim().split('\n').pop();
    console.error(`desk-jira ${args.join(' ')} failed: ${why}`);
    process.exit(1);
  }
};
const say = (s) => console.error(s);
const category = (i) => i.fields?.status?.statusCategory?.key ?? 'new';
const isSubtask = (i) => i.fields?.issuetype?.subtask === true;
// Only a Story is a container. A Bug or Task with subtasks (QA, checklist) is work in itself: run as
// itself, it builds its own change; replaced by its subtasks, that change would never be built.
const isStory = (i) => !isSubtask(i) && /story/i.test(i.fields?.issuetype?.name ?? '');
const blockersOf = (i) => (i.fields?.issuelinks ?? [])
  .filter((l) => l.inwardIssue && /blocked by/i.test(l.type?.inward ?? ''))
  .map((l) => ({ key: l.inwardIssue.key, category: l.inwardIssue.fields?.status?.statusCategory?.key ?? 'new' }));

// A previous run's file must never outlive it: plan-batch would apply another epic's containers.
rmSync(join(stateDir(), 'expansion.json'), { force: true });

// 1. Only an epic expands by itself; a story only when the user asked (a bug or story with QA or
// checklist subtasks named on its own must still run as itself, as it always has).
const top = jira('get', key, '--json');
const level = top.fields?.issuetype?.hierarchyLevel;
const typeName = top.fields?.issuetype?.name ?? '?';
if (!(level === 1 || (subtasks && isStory(top)))) {
  say(`${key} is a ${typeName}, not an epic${subtasks ? ' or a story' : ''}: run it as an ordinary ticket`);
  process.exit(4);
}

// 2–4. Keep this repo's open (not started) children; replace a container by its open subtasks.
const keys = [];
const containers = {};
for (const c of jira('children', key, '--json')) {
  const k = ticketKind(c.key);
  if (!k.ok || k.kind !== 'tracker') { say(`  drop ${c.key}: not this repo's key`); continue; }
  const cat = category(c);
  const inProgress = `  drop ${c.key}: in progress (it may already have a PR) — name it explicitly to include it`;
  if (cat === 'done') { say(`  drop ${c.key}: done`); continue; }
  // A story is read for its subtasks whatever its own status. An In Progress story is the usual
  // home of open subtasks (some of its work under way, the rest not started), and dropping it
  // before this read made every one of them vanish from the batch without a line in the report.
  if (!subtasks && isStory(c)) {
    const subs = jira('children', c.key, '--json');
    const open = [];
    for (const s of subs) {
      const sk = ticketKind(s.key);
      if (!sk.ok || sk.kind !== 'tracker') say(`  drop ${s.key} (subtask of ${c.key}): not this repo's key`);
      else if (category(s) === 'done') say(`  drop ${s.key} (subtask of ${c.key}): done`);
      else if (category(s) === 'indeterminate') say(`  drop ${s.key} (subtask of ${c.key}): in progress — name it explicitly to include it`);
      else open.push(s);
    }
    if (open.length) {
      containers[c.key] = { subtasks: open.map((s) => s.key), blocked_by: blockersOf(c) };
      say(`  ${c.key}${cat === 'indeterminate' ? ' (in progress)' : ''} → ${open.map((s) => s.key).join(' ')} (its open subtasks)`);
      keys.push(...open.map((s) => s.key));
      continue;
    }
    // No open subtask: an In Progress story is dropped as before (it may already have a PR).
    if (cat === 'indeterminate') { say(inProgress); continue; }
    if (subs.some((s) => category(s) === 'indeterminate')) {
      // Running the story whole would rebuild what its subtasks are already building.
      say(`  drop ${c.key}: its subtasks are under way and none is open — finish those first`);
      continue;
    }
  }
  if (cat === 'indeterminate') { say(inProgress); continue; }
  keys.push(c.key);
}

if (!keys.length) { say(`nothing open under ${key}`); process.exit(3); }
mkdirSync(stateDir(), { recursive: true });
writeFileSync(join(stateDir(), 'expansion.json'), `${JSON.stringify({ parent: key, containers }, null, 2)}\n`);
say(`${key}: ${keys.length} ticket(s)`);
console.log(keys.join('\n'));
