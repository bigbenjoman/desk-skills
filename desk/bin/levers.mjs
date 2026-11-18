#!/usr/bin/env node
// Ben's own call on a lever in one repo, and the undo of a lever change, each one command:
//
//   levers decide <repo> <lever> off|trial   sets the lever by hand: one `override` event, actor ben,
//                                            in the repo's lever log, and one line in its decision log
//                                            with the same id
//   levers undo <repo> <lever>               reverses the lever's latest change there: desk's adopt is
//                                            turned off by hand; Ben's own call puts the lever back in
//                                            the state it had before it, with the needs-you items that
//                                            call cleared
//
// <repo> is the repo's name as desk-q shows it, or its slug. The override is read by admission and
// the levers view as any other (levers-auto.mjs leverStatesIn): `off` pins the lever off, `trial` puts it
// on trial with a fresh trial id. Exits 0 once recorded (or with nothing to undo), 2 on a refusal that
// writes nothing, 1 when the lever log could not be written.
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { batchPaths, configuredRepos, deskConfigRoot } from './desk-env.mjs';
import { REGISTRY } from './lever-registry.mjs';
import { appendWith, read } from './lever-log.mjs';
import { leverStatesIn } from './levers-auto.mjs';
import { CATEGORY, VALUES } from './lever-changes.mjs';
import { decisionsPath } from './decisions.mjs';

export const CHOICES = Object.freeze(['off', 'trial']);
const BY_HAND = 'ben';
const STATE_KINDS = Object.freeze(['transition', 'override', 'trip']);
// What spends a needs-you item in the levers view: a later change to its lever.
const SPENDS = Object.freeze(['transition', 'override', 'thaw', 'trip']);
const ADOPTED = Object.freeze(['adopted', 'settled']);

export class LeversRefusal extends Error {}
const refuse = (why) => { throw new LeversRefusal(why); };

const nameOf = (r) => String(r.ghRepo ?? r.slug).split('/').pop();

// The configured repo `want` names: its slug, its `owner/name` or its name, case aside. Refuses a name
// no repo has, naming the configured ones, and a name two share, naming both slugs.
export function resolveRepo(want, root = deskConfigRoot()) {
  const repos = configuredRepos(root);
  const w = String(want ?? '').trim().toLowerCase();
  const hits = repos.filter((r) => r.slug.toLowerCase() === w || String(r.ghRepo ?? '').toLowerCase() === w || nameOf(r).toLowerCase() === w);
  if (hits.length === 1) return { slug: hits[0].slug, ghRepo: hits[0].ghRepo ?? null, name: nameOf(hits[0]) };
  if (hits.length > 1) refuse(`levers: ${want} names ${hits.length} configured repos (${hits.map((r) => r.slug).join(', ')}): give the slug`);
  refuse(`levers: no configured repo is called ${want}; configured: ${repos.length ? repos.map((r) => `${nameOf(r)} (${r.slug})`).join(', ') : 'none (run /desk-setup in the repo)'}`);
}

function checkLever(lever) {
  if (!Object.hasOwn(REGISTRY, lever)) refuse(`levers: ${lever} is not a lever the registry declares; declared: ${Object.keys(REGISTRY).join(', ')}`);
}

const decisionId = (...parts) => createHash('sha256').update(['levers', ...parts].join('\0')).digest('hex').slice(0, 16);

// The time an event written now carries: never earlier than the log's latest, which is read in time
// order, so it replays after everything before it.
const stamp = (events, now) => {
  const last = Math.max(-Infinity, ...events.map((e) => Date.parse(e.at)).filter(Number.isFinite));
  return new Date(Math.max(now.getTime(), last)).toISOString();
};

// Appends one event built from the repo's log under its lock. `build(events)` returns the event, or
// {why} to write nothing and refuse, or null to write nothing. -> the event as written, or null.
function appendFrom(slug, build) {
  let why = null;
  let written;
  try {
    written = appendWith(slug, () => {
      const log = read(slug);
      // Admission reads a log with an unreadable line as no log at all, so an override there would never pin.
      if (log.bad.length) { why = `${slug}'s lever log has ${log.bad.length} unreadable line(s) (line ${log.bad.map((b) => b.line).join(', ')}), so admission would not read it: repair the log first`; return null; }
      const r = build(log.events);
      if (r?.why) { why = r.why; return null; }
      return r;
    });
  } catch (e) { throw new Error(`levers: ${slug}'s lever log refused it: ${e.message}`); }
  if (why) throw new Error(`levers: nothing written: ${why}`);
  return written;
}

function logDecision(state, entry) {
  mkdirSync(state, { recursive: true });
  appendFileSync(decisionsPath(state), `${JSON.stringify(entry)}\n`);
}

// Ben's call on `lever` in `repo`: `off` or `trial`. -> { event, entry, repo, text }
export function decide({ repo, lever, choice, configRoot = deskConfigRoot(), now = new Date() }) {
  const r = resolveRepo(repo, configRoot);
  checkLever(lever);
  if (!CHOICES.includes(choice)) refuse(`levers decide: the choice is ${CHOICES.join(' or ')}, not "${choice}"`);
  const event = appendFrom(r.slug, (events) => {
    const at = stamp(events, now);
    const s = leverStatesIn(events)[lever];
    return {
      kind: 'override', lever, actor: BY_HAND, reason_code: 'ben_override', at, from: s.state, to: choice,
      ...(VALUES.includes(choice) ? { value: choice } : {}), decision_id: decisionId(r.slug, lever, choice, at),
      reason: `set ${choice} by hand with levers decide (it was ${s.state})`,
    };
  });
  const state = batchPaths(r.slug).state;
  const entry = {
    id: event.decision_id, at: event.at, repo: r.ghRepo, ticket: null, question: `Is ${lever} ${choice} in ${r.name}?`,
    options: [choice, ...CHOICES.filter((c) => c !== choice)], chose: choice, category: CATEGORY, pr: null, source: 'levers', run: null,
    by: BY_HAND, slug: r.slug, lever,
  };
  logDecision(state, entry);
  return {
    event, entry, repo: r,
    text: `levers decide: override recorded in ${r.name}/levers.jsonl (${lever} → ${choice}, actor ${BY_HAND}, decision ${event.decision_id}) · decision logged in decisions.jsonl`,
  };
}

// The needs-you items for `lever` still listed just before event `i` of `events`, which that event spent.
function spentBy(events, i, lever) {
  return events.slice(0, i).filter((e, k) => e.kind === 'needs_you' && e.lever === lever
    && !events.slice(k + 1, i).some((x) => SPENDS.includes(x.kind) && x.lever === lever));
}

// Reverses `lever`'s latest change in `repo`. -> { event, entry, relisted, repo, text } (event null
// with nothing to undo)
export function undo({ repo, lever, configRoot = deskConfigRoot(), now = new Date() }) {
  const r = resolveRepo(repo, configRoot);
  checkLever(lever);
  let nothing = null;
  let undone = null;
  let restored = null;
  let relist = [];
  const event = appendFrom(r.slug, (events) => {
    const changes = events.filter((e) => STATE_KINDS.includes(e.kind) && e.lever === lever && e.to != null);
    const last = changes.at(-1);
    const at = stamp(events, now);
    const id = decisionId('undo', r.slug, lever, at);
    const cur = leverStatesIn(events)[lever];
    if (last?.kind === 'override' && last.actor === BY_HAND) {
      const i = events.indexOf(last);
      restored = leverStatesIn(events.slice(0, i))[lever];
      undone = last;
      relist = spentBy(events, i, lever);
      const to = restored.state === 'overridden' ? restored.value : restored.state;
      return {
        kind: 'override', lever, actor: BY_HAND, reason_code: 'ben_override', at, from: cur.state, to,
        ...(VALUES.includes(to) ? { value: to } : {}), decision_id: id, ...(last.decision_id ? { undoes: last.decision_id } : {}),
        reason: `undid ${last.decision_id ? `decision ${last.decision_id}` : 'the last change by hand'} with levers undo: back to ${to}`,
      };
    }
    if (last && last.kind === 'transition' && ADOPTED.includes(last.to)) {
      undone = last;
      return {
        kind: 'override', lever, actor: BY_HAND, reason_code: 'ben_override', at, from: cur.state, to: 'off', value: 'off', decision_id: id,
        reason: `turned off by hand with levers undo, reversing desk's ${last.to === 'settled' ? 'settled adopt' : 'adopt'}`,
      };
    }
    const ever = changes.some((e) => (e.kind === 'transition' && ADOPTED.includes(e.to)) || e.kind === 'override');
    nothing = ever
      ? `${lever}'s latest change in ${r.name} is desk's ${last.to}, not an adopt or your own call, so there's nothing to undo.`
      : `${lever} has never been adopted in ${r.name}, so there's nothing to undo.`;
    return null;
  });
  if (!event) return { event: null, entry: null, relisted: [], repo: r, text: nothing };

  // The items Ben's call cleared are listed again, after the undo that brings them back.
  const relisted = [];
  for (const n of relist) {
    const { v, id, at, repo: _repo, ...rest } = n;
    const e = appendFrom(r.slug, (events) => ({ ...rest, at: stamp(events, now), relisted_from: id }));
    if (e) relisted.push(e);
  }

  const state = batchPaths(r.slug).state;
  // An adopt desk logged as a taken call is overridden by this undo, so the digest stops offering it.
  const adoptCall = undone.kind === 'transition' ? readTaken(state).find((d) => d.lever_event === undone.id) : null;
  const entry = {
    id: event.decision_id, at: event.at, repo: r.ghRepo, ticket: null, question: `Is ${lever} ${event.to} in ${r.name}?`,
    ...(adoptCall
      ? { override_of: adoptCall.id, was: adoptCall.chose, chose: 'off' }
      : { options: [event.to, event.from], chose: event.to, category: CATEGORY, pr: null, source: 'levers', run: null }),
    by: BY_HAND, slug: r.slug, lever, ...(event.undoes ? { undoes: event.undoes } : {}),
  };
  logDecision(state, entry);
  const text = undone.kind === 'transition'
    ? `Turned off ${lever} in ${r.name}. It stays off until you set it back.`
    : `Put ${lever} back to ${event.to} in ${r.name}, undoing your decision ${event.undoes ?? '(no id)'}.${relisted.length ? ` Its needs-you item${relisted.length === 1 ? ' is' : 's are'} listed again.` : ''}`;
  return { event, entry, relisted, repo: r, text };
}

// The taken calls in a decision log, unreadable lines skipped.
function readTaken(state) {
  let body = '';
  try { body = readFileSync(decisionsPath(state), 'utf8'); } catch { return []; }
  return body.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((d) => d?.id && !d.override_of);
}

const USAGE = 'usage: levers decide <repo> <lever> off|trial · levers undo <repo> <lever>';

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const [cmd, repo, lever, choice, ...extra] = process.argv.slice(2);
  const ok = !extra.length && repo && lever && ((cmd === 'decide' && choice) || (cmd === 'undo' && choice == null));
  if (!ok) { console.error(USAGE); process.exit(2); }
  try {
    const r = cmd === 'decide' ? decide({ repo, lever, choice }) : undo({ repo, lever });
    console.log(r.text);
  } catch (e) {
    console.error(e.message);
    process.exit(e instanceof LeversRefusal ? 2 : 1);
  }
}
