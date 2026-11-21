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
// on trial with a fresh trial id. An undo back to an earlier state names it in `restores`, so a trial keeps its trial
// id and an adopt its holdback. Both refuse a lever the repo's Phase 0 levers row does not leave to
// `auto`, since admission never reads the lever log for it. A run that wrote its override but not its
// decision line is finished by running it again, not repeated. Exits 0 once recorded (or with nothing
// to undo), 2 on a refusal that writes nothing, 1 when a log could not be written.
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { batchPaths, configuredRepos, deskConfigRoot, leverRow, repoConfigValues, rowStates } from './desk-env.mjs';
import { auditP0Replay } from './levers-audit.mjs';
import { KEPT_STATES, REGISTRY } from './lever-registry.mjs';
import { appendChecked, isStateChange, spendsNeedsYou, stampAfter as stamp } from './lever-log.mjs';
import { leverStatesIn } from './levers-auto.mjs';
import { CATEGORY, VALUES, recordLeverDecision } from './lever-changes.mjs';
import { appendDecisions } from './decisions.mjs';
import { readDecisions } from './digest.mjs';
import { resolveRepo as resolveShown, shortName, shownNames, Usage } from './desk-q.mjs';

export const CHOICES = Object.freeze(['off', 'trial']);
const BY_HAND = 'ben';

export class LeversRefusal extends Error {}
const refuse = (why) => { throw new LeversRefusal(why); };

// The configured repo `want` names, as desk-q resolves its repos (desk-q.mjs resolveRepo, over each
// repo's name as desk-q shows it), or by its GitHub `owner/name`. Refuses a name no repo has, naming the
// configured ones, and a name two share, naming both slugs.
export function resolveRepo(want, root = deskConfigRoot()) {
  const repos = configuredRepos(root);
  const names = shownNames(repos.map((r) => r.slug));
  const rows = repos.map((r, i) => ({ slug: r.slug, ghRepo: r.ghRepo, name: names[i], word: names[i], id: r.slug, batch: null }));
  const w = String(want ?? '').trim();
  const lw = w.toLowerCase();
  const pick = (r) => ({ slug: r.slug, ghRepo: r.ghRepo, name: r.name });
  const byGh = rows.filter((r) => String(r.ghRepo).toLowerCase() === lw);
  if (byGh.length === 1) return pick(byGh[0]);
  const sharing = rows.filter((r) => shortName(r.slug).toLowerCase() === lw && r.name.toLowerCase() !== lw);
  if (sharing.length > 1) refuse(`levers: ${w} names ${sharing.length} configured repos (${sharing.map((r) => r.slug).join(', ')}): give the slug`);
  if (!rows.length) refuse(`levers: no configured repo is called ${w}; configured: none (run /desk-setup in the repo)`);
  try { return pick(resolveShown(rows, w)); } catch (e) {
    // desk-q's own words for a prefix two names share; for no match, the configured repos by name and slug.
    if (e instanceof Usage) refuse(rows.some((r) => r.name.toLowerCase().startsWith(lw)) ? `levers: ${e.message}`
      : `levers: no configured repo is called ${w}; configured: ${rows.map((r) => `${r.name} (${r.slug})`).join(', ')}`);
    throw e;
  }
}

function checkLever(lever) {
  if (!Object.hasOwn(REGISTRY, lever)) refuse(`levers: ${lever} is not a lever the registry declares; declared: ${Object.keys(REGISTRY).join(', ')}`);
}

// Admission reads the lever log only for a lever the repo's Phase 0 levers row leaves to `auto`
// (levers-auto.mjs assignPin), so a call on any other would change nothing it does.
function checkRow(r, lever, root) {
  let items = null;
  try { items = repoConfigValues(r.slug, 'levers', root); } catch { items = null; }
  const row = leverRow(items);
  if (row.on.includes(lever)) refuse(`levers: ${lever} is named in ${r.name}'s Phase 0 levers row, so it is on for every ticket whatever its lever log says; take it out of the row first`);
  if (!row.auto) refuse(`levers: ${r.name}'s Phase 0 levers row is not auto, so admission never reads its lever log and this would change nothing; add auto to the row first`);
}

const decisionId = (...parts) => createHash('sha256').update(['levers', ...parts].join('\0')).digest('hex').slice(0, 16);

// Every id the repo's decision log holds.
function loggedIds(state) {
  const { taken, checks, overrides } = readDecisions(state);
  return new Set([...taken, ...checks, ...overrides].map((d) => d.id));
}

// The lever's latest state change in `events`, or undefined.
const latestChange = (events, lever) => events.filter((e) => isStateChange(e, lever)).at(-1);

// An override of Ben's whose decision line was never written: the run that wrote it stopped short.
const unfinished = (e, logged) => e?.kind === 'override' && e.actor === BY_HAND && !!e.decision_id && !logged.has(e.decision_id);

// Ben's latest call on the lever in `events`, an override by hand with a decision id, while nothing but
// trips changed the lever after it: a trip its undo's own replay wrote, or one a pass wrote since, would
// otherwise hide an undo whose decision line was never written from the run that finishes it. Any
// other change since (desk's adopt) is the latest change, and this run undoes that instead.
function latestCall(events, lever) {
  const changes = events.filter((e) => isStateChange(e, lever));
  const k = changes.findLastIndex((e) => e.kind === 'override' && e.actor === BY_HAND && !!e.decision_id);
  return k >= 0 && changes.slice(k + 1).every((e) => e.kind === 'trip') ? changes[k] : undefined;
}

// Appends what `build` returns from the repo's log under its lock (lever-log.mjs appendChecked). -> the
// event (or events) as written, or null; throws on a refusal, which writes nothing.
function appendFrom(slug, build) {
  let r;
  try { r = appendChecked(slug, build); } catch (e) { throw new Error(`levers: ${slug}'s lever log refused it: ${e.message}`); }
  if (r.why) throw new Error(`levers: nothing written: ${r.why}`);
  return r.event;
}

function logDecision(state, entry) {
  try { appendDecisions([entry], state); } catch (e) {
    throw new Error(`levers: the override is in the lever log as decision ${entry.id}, but its decision line was not written (${e.message}): run the same command again to finish it`);
  }
}

// Ben's call on `lever` in `repo`: `off` or `trial`. -> { event, entry, repo, text }
export function decide({ repo, lever, choice, configRoot = deskConfigRoot(), now = new Date() }) {
  const r = resolveRepo(repo, configRoot);
  checkLever(lever);
  if (!CHOICES.includes(choice)) refuse(`levers decide: the choice is ${CHOICES.join(' or ')}, not "${choice}"`);
  checkRow(r, lever, configRoot);
  const state = batchPaths(r.slug).state;
  let pending = null;
  const written = appendFrom(r.slug, (events) => {
    const last = latestChange(events, lever);
    if (unfinished(last, loggedIds(state)) && last.undoes_event == null && last.to === choice) { pending = last; return null; }
    const at = stamp(events, now);
    const s = leverStatesIn(events)[lever];
    return {
      kind: 'override', lever, actor: BY_HAND, reason_code: 'ben_override', at, from: s.state, to: choice,
      ...(VALUES.includes(choice) ? { value: choice } : {}), decision_id: decisionId(r.slug, lever, choice, at),
      reason: `set ${choice} by hand with levers decide (it was ${s.state})`,
    };
  });
  const event = written ?? pending;
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
    && !events.slice(k + 1, i).some((x) => spendsNeedsYou(e, x)));
}

// The adopt a kept state stands on: the transition itself for an adopt, the latest adopt before it for
// a settle (lever-changes.mjs logs the adopt call against the adopt).
function adoptOf(events, kept) {
  if (kept.to !== 'settled') return kept;
  return events.slice(0, events.indexOf(kept)).filter((e) => e.kind === 'transition' && e.lever === kept.lever && e.to === 'adopted').at(-1) ?? kept;
}

// Reverses `lever`'s latest change in `repo`. -> { event, entry, relisted, repo, text } (event null
// with nothing to undo)
export function undo({ repo, lever, configRoot = deskConfigRoot(), now = new Date() }) {
  const r = resolveRepo(repo, configRoot);
  checkLever(lever);
  checkRow(r, lever, configRoot);
  const state = batchPaths(r.slug).state;
  let nothing = null;
  let undone = null;
  let adopt = null;
  let relisted = [];
  let pending = null;
  let replays = 0;
  let pendingReplay = [];
  const written = appendFrom(r.slug, (events) => {
    const own = latestCall(events, lever);
    // An undo whose decision line was never written is finished, not undone in its turn.
    if (unfinished(own, loggedIds(state)) && own.undoes_event != null) {
      pending = own;
      undone = events.find((e) => e.id === own.undoes_event) ?? null;
      adopt = undone?.kind === 'transition' ? adoptOf(events, undone) : null;
      relisted = events.filter((e) => e.kind === 'needs_you' && e.relisted_by === own.decision_id);
      pendingReplay = events.filter((e) => e.replayed_by === own.decision_id);
      return null;
    }
    const last = latestChange(events, lever);
    const at = stamp(events, now);
    const id = decisionId('undo', r.slug, lever, at);
    const cur = leverStatesIn(events)[lever];
    if (last?.kind === 'override' && last.actor === BY_HAND) {
      const i = events.indexOf(last);
      const restored = leverStatesIn(events.slice(0, i))[lever];
      undone = last;
      // Back to an earlier call by hand, pinned to its value again; back to a plain state (a lever that
      // was simply off, or paused) with no value, so it reads as that state and is not pinned.
      const to = restored.state === 'overridden' ? restored.value : restored.state;
      const override = {
        kind: 'override', lever, actor: BY_HAND, reason_code: 'ben_override', at, from: cur.state, to,
        ...(restored.state === 'overridden' ? { value: to } : {}), restores: { id: restored.id, at: restored.at },
        decision_id: id, undoes_event: last.id, ...(last.decision_id ? { undoes: last.decision_id } : {}),
        reason: `undid ${last.decision_id ? `decision ${last.decision_id}` : 'the last change by hand'} with levers undo: back to ${to}`,
      };
      // The items Ben's call cleared are listed again, after the undo that brings them back, in the same write.
      const relist = spentBy(events, i, lever).map(({ v, id: itemId, at: _at, repo: _repo, ...rest }) => ({ ...rest, at, relisted_from: itemId, relisted_by: id }));
      // A trial the undo restores answers a blind audit P0 recorded while it was off, in this same write.
      // Each carries the undo's decision id, so a run finishing this undo logs the trip's decision too.
      const replay = auditP0Replay({ slug: r.slug, name: r.name, events: [...events, override], states: rowStates(repoConfigValues(r.slug, 'levers', configRoot)), at })
        .map((e) => ({ ...e, replayed_by: id }));
      replays = replay.length;
      return [override, ...relist, ...replay];
    }
    if (last && last.kind === 'transition' && KEPT_STATES.includes(last.to)) {
      undone = last;
      adopt = adoptOf(events, last);
      return {
        kind: 'override', lever, actor: BY_HAND, reason_code: 'ben_override', at, from: cur.state, to: 'off', value: 'off',
        decision_id: id, undoes_event: last.id,
        reason: `turned off by hand with levers undo, reversing desk's ${last.to === 'settled' ? 'settled adopt' : 'adopt'}`,
      };
    }
    const ever = events.some((e) => e.lever === lever && ((e.kind === 'transition' && KEPT_STATES.includes(e.to)) || e.kind === 'override'));
    nothing = ever
      ? `${lever}'s latest change in ${r.name} is desk's ${last.to}, not an adopt or your own call, so there's nothing to undo.`
      : `${lever} has never been adopted in ${r.name}, so there's nothing to undo.`;
    return null;
  });
  if (!written && !pending) return { event: null, entry: null, relisted: [], repo: r, text: nothing };
  if (!written) replays = pendingReplay.length;
  const lines = written ? [written].flat() : [pending, ...relisted, ...pendingReplay];
  const replayed = lines.splice(lines.length - replays, replays);
  const [event, ...items] = lines;

  // An adopt desk logged as a taken call is overridden by this undo, so the digest stops offering it.
  const adoptCall = adopt ? readDecisions(state).taken.find((d) => d.lever_event === adopt.id || d.lever_event === undone.id) : null;
  const entry = {
    id: event.decision_id, at: event.at, repo: r.ghRepo, ticket: null, question: `Is ${lever} ${event.to} in ${r.name}?`,
    ...(adoptCall
      ? { override_of: adoptCall.id, was: adoptCall.chose, chose: 'off' }
      : { options: [event.to, event.from], chose: event.to, category: CATEGORY, pr: null, source: 'levers', run: null }),
    by: BY_HAND, slug: r.slug, lever, ...(event.undoes ? { undoes: event.undoes } : {}),
  };
  logDecision(state, entry);
  recordLeverDecision(replayed.filter((e) => e.kind === 'trip'), { slug: r.slug, repo: r.ghRepo, state });
  const text = undone?.kind === 'transition'
    ? `Turned off ${lever} in ${r.name}. It stays off until you set it back.`
    : `Put ${lever} back to ${event.to} in ${r.name}, undoing your decision ${event.undoes ?? '(no id)'}.${items.length ? ` Its needs-you item${items.length === 1 ? ' is' : 's are'} listed again.` : ''}${replayed.length ? ' A blind audit found a P0 on its trial while it was off, so that trial is reverted now.' : ''}`;
  return { event, entry, relisted: items, replayed, repo: r, text };
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
