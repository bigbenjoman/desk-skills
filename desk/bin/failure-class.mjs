// With the failure-class lever on (config §3b Phase 0 levers), every park and every fix try records one
// failure class before anything retries it, so a retry is spent only where one can help. A class is
// read by rule from what the pass already holds: a park's text (its question, which names its source:
// a hold, a check build, a usage limit, a triage size, a worker's own question), or a fix try's kind
// and what it quotes. The first rule that matches wins; a park no rule matches is unclassified, with
// the text it was read from kept as its evidence.
import { HELD_PREFIX, SPINE_APPROVAL_PREFIX, SPINE_SPECS_PREFIX, FEATURE_PLAN_PREFIX } from './batch-state.mjs';
import { CHILD_SPECS_PREFIX } from './spine-check.mjs';

export const CLASSES = Object.freeze(['base red', 'runner or resource', 'application defect', 'missing decision', 'agent mistake', 'dependency wait', 'quota', 'unclassified']);
// A fix try of one of these classes waits rather than spawns: no worker can supply what it waits for.
export const WAITING_CLASSES = Object.freeze(['missing decision', 'dependency wait']);

const starts = (...prefixes) => (text) => prefixes.some((p) => text.startsWith(p));
const matches = (re) => (text) => re.test(text);

// A park's rules, in the order they are tried. `rule` is what the class means for a park, as the spec
// and a person reading the record see it.
export const PARK_RULES = Object.freeze([
  { class: 'dependency wait', rule: 'held behind a blocker until its PR merges', test: starts(HELD_PREFIX) },
  { class: 'missing decision', rule: 'a spine or feature plan waiting on the person to approve it or answer it', test: starts(SPINE_APPROVAL_PREFIX, FEATURE_PLAN_PREFIX) },
  { class: 'application defect', rule: 'acceptance specs a spine or child PR left undone or failing', test: starts(SPINE_SPECS_PREFIX, CHILD_SPECS_PREFIX) },
  { class: 'quota', rule: 'a usage limit, a budget or a spend cap stopped it', test: matches(/\busage limit\b|\bbudget\b|\bspend cap\b|\bout of (?:usage|credits)\b|\brate[- ]limit/i) },
  { class: 'runner or resource', rule: 'the machine or the runner failed it: a wedged or killed worker, a worktree that would not set up, a cloud session that did not start, memory, disk or a service it could not reach', test: matches(/^wedged\b|^killed (?:again|before)\b|worktree setup failed|cloud worker did not start|\bnot reachable\b|could not be reached|\bout of memory\b|\bOOM\b|\bENOSPC\b|\bdisk (?:full|floor)\b|\brunner\b/i) },
  { class: 'base red', rule: 'a check red on the default branch too, not only on the PR', test: matches(/\bred on (?:the )?(?:base|default branch|main|origin\/[\w./-]+)\b|\b(?:main|the base|the default branch) is red\b/i) },
  { class: 'agent mistake', rule: 'the worker broke its own contract: it ended with no marker, left stray commits or files, or never posted what it had to', test: matches(/\bno marker\b|\bstray (?:commit|file|sha)s?\b|\bstage section missing\b|\b(?:never|did not) (?:post|push|open)(?:ed)?\b/i) },
  { class: 'dependency wait', rule: 'waiting on another PR, ticket, run or live read, which a pass sees settle', test: matches(/\bwait(?:s|ing)? (?:on|for) (?:PR\s*#?\d+|#\d+|[A-Z][A-Z0-9]*-\d+|run \d+)|\bblocked by [A-Z][A-Z0-9]*-\d+|^need live read\b/i) },
  { class: 'missing decision', rule: "a question only a person answers: a ruling, an approval or sign-off, a product, design or copy call, a lane C or D plan, a size or a link to fix, or a step the config does not grant", test: matches(/^(?:lane [CD]\b|size |dependency cycle:|design not snapshotted)|\b(?:approve|approval|sign[- ]?off|your (?:call|answer|ruling))\b|\b(?:product|design|copy|legal|pricing) (?:call|decision|question|ruling)\b|\b(?:refused|denied|not granted|does not grant)\b|\?\s*$/i) },
  { class: 'application defect', rule: 'the code is wrong: a P0 or P1, a red check or failing test, a typecheck or build that fails, a conflict with its base', test: matches(/\bP[01]\b|\bconflicts? with\b|\bstill red\b|\bred check|\bfailing (?:spec|test|check)s?\b|\btests? fail|\b(?:typecheck|build) (?:fail|error)/i) },
]);
export const UNCLASSIFIED_RULE = 'no rule matched';

// A park's class, as the fields its record keeps: { class, class_rule }, and for an unclassified one
// the text it was read from, as `evidence`, kept even if the question is later rewritten.
export function parkClass(question) {
  const text = String(question ?? '').trim();
  const hit = PARK_RULES.find((r) => r.test(text));
  return hit ? { class: hit.class, class_rule: hit.rule } : { class: 'unclassified', class_rule: UNCLASSIFIED_RULE, evidence: text };
}

// Whether a red check's error lines class it runner or resource: one of them reads so under the park
// rules, which cost a check so classed one rerun at most.
export const runnerOrResource = (lines) => (lines ?? []).some((l) => parkClass(l).class === 'runner or resource');

// An item a fix try quotes (a gap, a thread, a finding) that only a person can settle.
const ASKS_PERSON = /\b(?:product|design|copy|legal|pricing) (?:call|decision|question|ruling)\b|\bneeds? (?:a |the )?(?:person|user|owner|product owner|PO)(?:'s)? (?:call|decision|ruling|answer)\b|\bask (?:the )?(?:person|user|product owner)\b/i;
const quotedItems = (f) => [...(f.gaps ?? []), ...(f.findings ?? []).map((x) => x.text), ...(f.threads ?? []).map((x) => x.text)].map(String);

// A ticket's blockers while it is held: `held_by`, which every release clears and which also lists the
// blockers outside the batch. Never `held_outside` alone: a person's release leaves it behind.
const blockers = (t) => [...new Set(String(t?.held_by ?? '').split('|').filter(Boolean))];
// A fix try's rules, in the order they are tried, each reading the try (fix-tries.mjs) and its ticket.
export const FIX_RULES = Object.freeze([
  { class: 'dependency wait', rule: 'its ticket is still held behind a blocker whose PR has not merged', test: (f, t) => blockers(t).length > 0, waiting: (f, t) => `waiting for ${blockers(t).join(', ')} to merge` },
  { class: 'missing decision', rule: 'every item it quotes asks for a product, design or copy call or a person\'s ruling', test: (f) => { const items = quotedItems(f); return items.length > 0 && items.every((x) => ASKS_PERSON.test(x)); }, waiting: () => 'waiting for a person\'s call on what it quotes' },
  { class: 'runner or resource', rule: 'the errors of every red check it takes name the runner or a resource, not the code', test: (f) => f.kind === 'checks' && Boolean(f.rerun_note) },
  { class: 'agent mistake', rule: 'a worker left no review verdict, or no screenshots, at its head', test: (f) => f.kind === 'rereview' || f.kind === 'capture' },
  { class: 'application defect', rule: 'the code on its branch needs changing: a red check, a review finding or gap, review feedback, a conflict or a sync with its base, or a call the person sent back', test: () => true },
]);

// A fix try's class, as the fields its record keeps: { class, class_rule }, and for a class that
// waits, `waiting`: what it waits for.
export function fixClass(f, t) {
  const hit = FIX_RULES.find((r) => r.test(f, t));
  return { class: hit.class, class_rule: hit.rule, ...(hit.waiting ? { waiting: hit.waiting(f, t) } : {}) };
}

// A job's check runs at one commit (the REST check-runs list, [{ status, conclusion }]) as that job's
// state there: 'fail', 'pass', or null when it has no completed run.
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const PASSED = new Set(['success']);
export function runsState(runs) {
  const done = (Array.isArray(runs) ? runs : []).filter((r) => String(r?.status ?? '').toLowerCase() === 'completed');
  if (done.some((r) => FAILED.has(String(r.conclusion ?? '').toLowerCase()))) return 'fail';
  return done.some((r) => PASSED.has(String(r.conclusion ?? '').toLowerCase())) ? 'pass' : null;
}

// A PR's red checks a worker would fix, against its base. A check red on the default branch at the
// PR's exact merge base too is base red; one with no completed run there has its base state unknown
// and goes on to its fix as before. A base red hold ({ head, merge_base, checks, cleared }, kept on
// the ticket as `base_red`) is read again only for its own head: a held check clears once the job's
// latest completed run on the default branch passes, and stays cleared at that head.
// read: { atMergeBase(name) -> 'fail' | 'pass' | null, mergeBase() -> sha | null, latestOnBase(name) -> 'fail' | 'pass' | null }
// -> { red, unknown, mine (the checks a fix try takes), record (the hold to keep, or null) }
export function baseSplit(failing, head, held, read) {
  const at = held?.head === head ? held : null;
  const cleared = [...(at?.cleared ?? [])];
  const red = [], unknown = [], mine = [];
  for (const f of failing) {
    if (cleared.includes(f.name)) { mine.push(f); continue; }
    if (at?.checks?.includes(f.name)) {
      if (read.latestOnBase(f.name) === 'pass') { cleared.push(f.name); mine.push(f); } else red.push(f);
      continue;
    }
    const state = read.atMergeBase(f.name);
    if (state === 'fail') red.push(f);
    else { if (state == null) unknown.push(f); mine.push(f); }
  }
  const checks = [...new Set([...(at?.checks ?? []).filter((x) => !cleared.includes(x)), ...red.map((f) => f.name)])];
  const record = checks.length || cleared.length ? { class: 'base red', head, merge_base: at?.merge_base ?? read.mergeBase(), checks, cleared } : null;
  return { red, unknown, mine, record };
}
