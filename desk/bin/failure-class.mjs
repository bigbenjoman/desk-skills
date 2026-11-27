// Every park and every fix try records one failure class, whether or not the failure-class lever
// (config §3b Phase 0 levers) is on; with it on, a retry is spent only where one can help. A class is
// read by rule from what the pass already holds: a park's text (its question, which names its source:
// a hold, a check build, a usage limit, a triage size, a worker's own question), or a fix try's kind
// and what it quotes. The first rule that matches wins; a park no rule matches is unclassified, with
// the text it was read from kept as its evidence.
import { HELD_PREFIX, SPINE_APPROVAL_PREFIX, SPINE_SPECS_PREFIX, FEATURE_PLAN_PREFIX } from './batch-state.mjs';
import { CHILD_SPECS_PREFIX } from './spine-check.mjs';
import { blockersOf } from './queue-states.mjs';
import { normaliseLine } from './evidence.mjs';

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
const blockers = (t) => [...new Set(blockersOf(t))];
// A fix try's rules, in the order they are tried, each reading the try (fix-tries.mjs) and its ticket.
export const FIX_RULES = Object.freeze([
  { class: 'dependency wait', rule: 'its ticket is still held behind a blocker whose PR has not merged', test: (f, t) => blockers(t).length > 0, waiting: (f, t) => `waiting for ${blockers(t).join(', ')} to merge` },
  { class: 'missing decision', rule: 'every item it quotes asks for a product, design or copy call or a person\'s ruling', test: (f) => { const items = quotedItems(f); return items.length > 0 && items.every((x) => ASKS_PERSON.test(x)); }, waiting: () => 'waiting for a person\'s call on what it quotes' },
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
export const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const PASSED = new Set(['success']);
export function runsState(runs) {
  const done = (Array.isArray(runs) ? runs : []).filter((r) => String(r?.status ?? '').toLowerCase() === 'completed');
  if (done.some((r) => FAILED.has(String(r.conclusion ?? '').toLowerCase()))) return 'fail';
  return done.some((r) => PASSED.has(String(r.conclusion ?? '').toLowerCase())) ? 'pass' : null;
}

// A PR's red checks a worker would fix, against its base. A check red on the default branch at the
// PR's exact merge base too is base red, and so is one whose latest completed run on the default
// branch at or since that merge base fails (`latest`: the base went red after the PR branched). One
// whose latest state on the base cannot be read has its base state unknown and goes on to its fix as
// before. A base
// red hold ({ head, merge_base, checks, cleared, and `latest`, the held checks of the second kind,
// where there are any }, kept on the ticket as `base_red`) is read again only for its own head: a
// held check clears once the job's latest completed run on the default branch passes, and stays
// cleared at that head.
// A check is judged by the tests failing inside it where both sides can be read: a check red on the base
// too whose failing tests at this head (read.failingTests) include any the base's failing runs of that job
// (read.baseTests: at the merge base and, while it fails, its latest run, mergeBaseSides; or its latest
// run alone where only that is red) do not fail is not base red. It is the PR's own, goes to its fix try, and carries those tests as `own`. Where either side's
// tests are unread or the log names none (no failing test line or junit case: a crash, a timeout, a
// budget), the check is read by its name, as before. Junit artifacts are not downloaded: an artifact
// belongs to a run, not to the job a check is, so it cannot be tied to one shard's check; junit cases
// a job prints in its log are read (failingTestNames).
// read: { atMergeBase(name) -> 'fail' | 'pass' | null, mergeBase() -> sha | null, latestOnBase(name, { held }) -> 'fail' | 'pass' | null
//         (its newest completed run at or since the merge base; null unread or with none; `held` for
//         a check already held, which may read further back),
//         failingTests?(check) -> [test] | null (the check's failing tests at this head),
//         baseTests?(name, 'merge-base' | 'latest') -> [test] | null (the base's failing tests in that job there) }
// -> { red, latest (those of red that are not red at the merge base), unknown, mine (the checks a fix
//      try takes), record (the hold to keep, or null) }
export function baseSplit(failing, head, held, read) {
  const at = held?.head === head ? held : null;
  const cleared = [...(at?.cleared ?? [])];
  const red = [], latest = [], unknown = [], mine = [];
  for (const f of failing) {
    if (cleared.includes(f.name)) { mine.push(f); continue; }
    if (at?.checks?.includes(f.name)) {
      if (read.latestOnBase(f.name, { held: true }) === 'pass') { cleared.push(f.name); mine.push(f); } else { red.push(f); if (at.latest?.includes(f.name)) latest.push(f); }
      continue;
    }
    const state = read.atMergeBase(f.name);
    if (state === 'fail') { const own = ownTests(f, mergeBaseSides(f.name, read), read); if (own) mine.push({ ...f, own }); else red.push(f); continue; }
    const now = read.latestOnBase(f.name);
    if (now === 'fail') { const own = ownTests(f, ['latest'], read); if (own) mine.push({ ...f, own }); else { red.push(f); latest.push(f); } continue; }
    if (now == null) unknown.push(f);
    mine.push(f);
  }
  const checks = [...new Set([...(at?.checks ?? []).filter((x) => !cleared.includes(x)), ...red.map((f) => f.name)])];
  const late = checks.filter((x) => latest.some((f) => f.name === x) || at?.latest?.includes(x));
  const record = checks.length || cleared.length ? { class: 'base red', head, merge_base: at?.merge_base ?? read.mergeBase(), checks, cleared, ...(late.length ? { latest: late } : {}) } : null;
  return { red, latest, unknown, mine, record };
}

// The base runs a check red at the merge base is compared with. A PR's run tests its head merged onto
// the base as it stood then, so a test the base broke after the merge base fails there too: the job's
// latest run on the base is read beside the merge base's while it fails. With that run passing, the
// merge base's alone; with it unread, none (the check is read by its name).
function mergeBaseSides(name, read) {
  const now = read.latestOnBase(name);
  if (now === 'fail') return ['merge-base', 'latest'];
  return now === 'pass' ? ['merge-base'] : [];
}

// A check's failing tests at the PR's head that none of its job's failing runs on the base (`where`, each
// 'merge-base' or 'latest') fails, or null: none such, no run to compare, or any side unread or naming no
// test.
function ownTests(f, where, read) {
  if (!where.length) return null;
  const ours = read.failingTests?.(f) ?? null;
  if (!ours?.length) return null;
  const theirs = [];
  for (const w of where) {
    const t = read.baseTests?.(f.name, w) ?? null;
    if (!t?.length) return null;
    theirs.push(...t);
  }
  const own = ours.filter((x) => !theirs.includes(x));
  return own.length ? own : null;
}

// The tests a job's log names failing in its final run, once each, with GitHub's timestamp, colour codes,
// what follows the name (`: got …`, a duration) and what differs between runs (normaliseLine) taken out:
// - each runner `FAIL` line: tests/run.sh's `FAIL <name>: …`, Jest's and Vitest's `FAIL <file>`, also
//   behind a task prefix (turbo's `web:test: FAIL <file>`), and go's `--- FAIL: <test>`;
// - pytest's `FAILED <file>::<test>`;
// - each junit `<testcase>` holding a `<failure>` or `<error>` the log prints, as `<classname>.<name>`.
// Not read: a suite's own count line (`FAIL 2 check(s) failed`), which differs between runs and names no
// test, and tests/run.sh's `-- first run` of a suite it retried, up to its `-- retry` or the next suite:
// a failure its retry did not repeat is not a failing test of this run. [] for none or unread.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/;
const COUNT_LINE = /^\d+\s+(?:checks?|tests?|assertions?|specs?|suites?|cases?)(?:\(s\))?\s+(?:failed|failing)\b/i;
const FAIL_LINE = [
  /^\s*---\s+FAIL:\s+(\S+)/,
  /^\s*(?:[\w@./-]+(?::[\w./-]+)*:\s+)?FAILED\s+(\S+::\S+)/,
  /^\s*(?:[\w@./-]+(?::[\w./-]+)*:\s+)?FAIL\b:?\s+(.+)$/,
];
const DURATION = /\s+\(?[\d.]+ ?(?:ms|s|m)\)?\s*$/;
export function failingTestNames(log) {
  if (typeof log !== 'string') return [];
  const out = new Set();
  const lines = log.replace(ANSI, '').split('\n').map((l) => l.replace(STAMP, ''));
  let firstRun = false;
  for (const line of lines) {
    if (/^-- first run\s*$/.test(line)) { firstRun = true; continue; }
    if (/^-- retry\s*$/.test(line) || /^== /.test(line)) firstRun = false;
    if (firstRun) continue;
    const m = FAIL_LINE.map((re) => re.exec(line)).find(Boolean);
    if (!m) continue;
    const name = normaliseLine(m[1].split(/: /)[0].replace(DURATION, ''));
    if (name && !COUNT_LINE.test(name)) out.add(name);
  }
  for (const [, attrs, body] of lines.join('\n').matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (!/<(?:failure|error)\b/.test(body ?? '')) continue;
    const attr = (k) => new RegExp(`\\b${k}="([^"]*)"`).exec(attrs)?.[1] ?? '';
    const name = normaliseLine([attr('classname'), attr('name')].filter(Boolean).join('.'));
    if (name) out.add(name);
  }
  return [...out];
}

// The base red record a fix call leaves on its ticket (`c.base_red`, null to clear): it keeps the pass its
// hold began at (`since`, `at` for one new), so the person's base red item is aged from there, and one
// after a cleared hold (no checks left) begins anew. `held`: the call holds the PR on it, with no fix try.
export function keptHold(was, c, at) {
  if (!c.base_red) return c.base_red ?? null;
  return { ...c.base_red, since: (was?.checks?.length ? was.since : null) ?? at, held: c.call === 'held' };
}
