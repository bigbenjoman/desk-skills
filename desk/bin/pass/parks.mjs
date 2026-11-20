// Every park and hold a pass settles, as decisions: parks whose condition cleared (and those waiting on
// the base, after the base sync), person-step holds, date holds, outside blockers, outside holds, and
// merge holds on the person's steps. Each runs where its section of the pass runs, so each is its own
// decision, called there.
//
// A decision that needs a read only some cases make (a clears-when check, whether a blocker landed), or
// the result of a write, is a generator (pass/run-phase.mjs runSteps): it yields the read or write as an
// action, and what the action's handler returns is what the yield gives back. The rest are plain
// functions run by runPhase. None starts a process, calls git, gh or Jira, or writes the queue: the
// handlers that do are pass.mjs's.
//
// Actions, beside the shared `set` and `report` ({ type, key, ... }; "->" is what the handler returns):
//   merge-park {key, cond}        -> the park asks only who merges its PR: {call, pr, head, grant}, or null
//   check {key, cond}             -> the clears-when check (clears-when.mjs checkCond): {holds, note} or {error}
//   own-merged {key}              -> {pr: the ticket's own merged PR, or null}, or {error} where unread
//   tail-after-merge {key}        -> false where its after-merge steps were not requeued (tailAfterMerge)
//   write {key, fields}           -> whether the queue write was recorded
//   requeue {key}                 -> queue.mjs requeue's {ok, out}
//   lift-put-off {key, question}  -> not-now.mjs clearPutOff's {ok, why}
//   front {key}                   move the ticket to the front of the queue
//   park {key, question}          park the ticket
//   date-line {line}              a line of the report's date-hold list
//   epic-line {line}              a line of the report's epic list
//   read-blockers {keys}          -> {unread, why}: keys' blockers read from Jira into their triage records
//   triage {keys}                 -> each key's triage record, read again
//   epic-merged {key}             -> whether epic key's batch recorded its epic PR merged
//   other-repo {key}              -> whether key's Jira Repository is another configured repo
//   landed {key}                  -> intake.mjs landedOn(key) on the default branch
//   unpromoted {key, into}        -> intake.mjs unpromotedBase(key, into): the branch key merged into instead, and its promotion PR into `into`
//   landed-here {key}             -> whether key is in another configured repo, or landed on the default branch
import { isHeld, spinePark, leftPark, needsSession, mergedTailPr, holdsKept, stoppedHold, dateHeld, dateHoldOf, badLabelText, UNPROMOTED_AFTER_MS, promotionWords,
  HELD_PREFIX, LIVE_READ, personStep, triageGate, IDLE_RECHECK_MS, doneOnPr } from '../batch-state.mjs';
import { describeCond, recorded, restateLapsed, RESTATE_MS } from '../clears-when.mjs';
import { splitOwnEpic, closedUnlanded } from '../desk-q-eta.mjs';
import { keysOf } from '../desk-q.mjs';
import { INTAKE_EVERY_MS } from '../intake.mjs';
import { LINKS_MADE, ownWords, linkSteps, parkFollowOn, set, say } from './shared.mjs';

// ---- parks whose condition cleared ---------------------------------------------
// A park that recorded what clears it (clears-when.mjs) is checked each pass, and settled once that
// holds, as the recovery rules say and with no model: left for a person on lane C or a lane D
// parked at triage on its design, closed out where the ticket's own PR merged, requeued otherwise. A check that cannot run leaves the park as it is.
//
// A claimed ticket is released only by the claims loop, once its session is idle and its worktree
// clean, so a condition that holds never hands it to a worker under a live session. A ticket left in a
// finished feature batch is the person's to move, whatever its earlier park waited on.
const clearable = (t) => {
  const c = t.park?.clears_when;
  return !(t.state !== 'parked' || isHeld(t) || spinePark(t) || leftPark(t) || t.park?.claim?.session || !recorded(c) || c.kind === LIVE_READ);
};
// "base contains <branch>" is checked after the base sync, so the pass that syncs the base also
// requeues what waited on it ("parks waiting on the base").
const BASE_CONTAINS = 'base-contains';

// A park whose unreadable clears-when no restate reached in time (a decider that never came, or a
// session that left it) is the person's: recorded none, so the digest and needs-you list it. Not while
// the batch is on a usage hold: no decider starts then (supervisor.mjs decide), and the supervisor
// restarts the hour for each one it could not hand a decider, so it lapses only once one could run.
//
// The snapshot: tickets, passAt (when the pass started, in ms), dry, usageHold (the queue's usage_hold).
export function decideLapsedRestates(s) {
  if (s.dry || s.usageHold) return [];
  return Object.values(s.tickets).filter((x) => x.state === 'parked' && restateLapsed(x.park?.clears_when, s.passAt)).flatMap((t) => [
    set(t.key, `park.clears_when=${JSON.stringify({ kind: 'none' })}`),
    say(t.key, 'clears', `${t.key}: unreadable clears-when "${t.park.clears_when.text}" not restated within ${RESTATE_MS / 60000} minutes: recorded as none, for the person`),
  ]);
}

// Each clearable park in turn: those on "base contains" where `onBase`, every other one where not.
//
// The snapshot: tickets, onBase, dry, putOff (the keys whose park the person put off with not-now).
export function* decideClears(s) {
  for (const t of Object.values(s.tickets)) {
    if (clearable(t) && (t.park.clears_when.kind === BASE_CONTAINS) === s.onBase) yield* settleClear(t, s);
  }
}
function* settleClear(t, s) {
  const c = t.park.clears_when;
  const cond = describeCond(c);
  // A lane left for a person never has its push made for it.
  if (c.kind === 'push-ok' && needsSession(t)) { yield say(t.key, 'clears', `${t.key}: "${cond}" not tried, since it is lane ${t.lane}: left parked for a person`); return; }
  // A merge question whose rows now let desk merge its green, clean PR (mergeParkOf) is done on it, as
  // the harvest records one: the undraft step and the merge driver take it from there.
  const merges = yield { type: 'merge-park', key: t.key, cond: c };
  if (merges?.call === 'done') {
    yield set(t.key, ...doneOnPr(merges.pr, { summary: `parked only on who merges PR #${merges.pr}, which desk now merges: recorded done` }),
      // Link steps alone (keepLinks) do not hold the park's words: those are added after them.
      ...(t.follow_on?.length > linkSteps(t.follow_on).length ? [] : [parkFollowOn(ownWords(t.park.question), t.follow_on)]), 'follow_on_comment=due');
    yield say(t.key, 'done', `${t.key}: PR #${merges.pr} recorded done, no longer parked: its park waited only on #${merges.pr} merging, #${merges.pr} is green with a clean review at ${String(merges.head).slice(0, 9)}, and desk may now undraft and merge it (${merges.grant})`);
    return;
  }
  const r = yield { type: 'check', key: t.key, cond: c };
  if (r.error) { yield say(t.key, 'clears', `${t.key}: could not check "${cond}" (${r.error}): left parked`); return; }
  // A condition that says how far it has got (an Actions run in progress) is reported as waited on.
  if (!r.holds) { if (r.note) yield say(t.key, 'clears', `${t.key}: waiting on "${cond}" (${r.note}): left parked`); return; }
  const what = r.note ? `${cond}, ${r.note}` : cond;
  // A done ticket parked only on links the pass did not make (parkLinks) goes back to done on its PR.
  if (c.kind === LINKS_MADE) {
    yield set(t.key, 'state=done', 'park=null', ...(c.pr ? [`result.pr=${c.pr}`] : []));
    yield say(t.key, 'done', `${t.key}: ${what}, each read on Jira: recorded done again${c.pr ? ` on PR #${c.pr}` : ''}, no longer parked`);
    return;
  }
  if (needsSession(t)) {
    yield say(t.key, 'clears', `${t.key}: "${what}" holds, but it is lane ${t.lane}: left parked for a person, never requeued for a headless worker`);
    return;
  }
  const own = yield { type: 'own-merged', key: t.key };
  if (own.error) {
    yield say(t.key, 'clears', `${t.key}: "${what}" holds, but whether its own PR merged could not be read (${own.error}): left parked`);
    return;
  }
  // Its own PR merged with its ticket not done in Jira: the after-merge steps are still to run. One whose
  // Jira could not be read is left parked, not recorded done.
  if (own.pr != null && own.pr === mergedTailPr(t) && (yield { type: 'tail-after-merge', key: t.key }) !== false) return;
  if (own.pr != null) {
    if (yield { type: 'write', key: t.key, fields: doneOnPr(own.pr, { summary: `closed out: ${what}, and its PR #${own.pr} merged` }) }) {
      yield say(t.key, 'clears', `${t.key}: "${what}" holds and its PR #${own.pr} merged: recorded done`);
    }
    return;
  }
  const wasPutOff = s.putOff.has(t.key);
  const rq = yield { type: 'requeue', key: t.key };
  // The next worker's briefing says what cleared the park (writeBrief), so it acts on the result.
  if (rq.ok) yield set(t.key, `cleared=${JSON.stringify({ what })}`);
  // A park put off with not-now that clears is no longer put off: the same question parked again is
  // asked, and desk-needs-you no longer lists it under Put off.
  let lifted = '';
  if (rq.ok && wasPutOff && !s.dry) {
    const cl = yield { type: 'lift-put-off', key: t.key, question: t.park.question };
    lifted = cl.ok ? ', its not-now entry lifted' : `, but its not-now entry could not be lifted (${cl.why})`;
  }
  yield say(t.key, 'clears', rq.ok ? `${t.key}: "${what}" holds: requeued${lifted}` : `${t.key}: "${what}" holds, but the requeue was refused (${String(rq.out).split('\n').pop()}): left parked`);
}

// ---- person-step holds ---------------------------------------------------
// Holds are set at admit, but what counts as the person's step can change after it (a Person-step or
// Person-input labels row set, a label added in Jira, a step named in ben_steps), so every pass reads
// each open blocker in no batch again (personStep) before spawning. A full hold (held_outside) on one
// that is now a step of the person's holding only the merge becomes a merge-only gate (merge_after), and
// a ticket with no hold left is released to spawn in this pass. The step decides here, not triage's
// blocker_needs call: a ticket is held outside on a blocker that is no input step only because triage
// called it 'build' (or `true`, written before the calls), so a call that outranked the step would keep
// every such ticket held. A step the build reads carries a Person-input label (personStep 'build'),
// which keeps the hold. The one way back: a not-yet-started ticket's merge-only gate on a blocker that
// has since gained a Person-input label becomes a full hold again (decidePersonInputs, read after).
//
// The snapshot of both: tickets, triage (each ticket's triage record by key, null where unread),
// stepLabels, inputLabels (config §4 Person-step and Person-input labels), dry.
const openOutside = (s, rec, p) => (s.tickets[p] ? null : (Array.isArray(rec?.blockers) ? rec.blockers : []).find((b) => b?.key === p && b.category !== 'done') ?? null);
const stepOf = (s, rec, p) => { const b = openOutside(s, rec, p); return b ? personStep(b, rec, s.stepLabels, s.inputLabels) : null; };
export function decidePersonSteps(s) {
  const out = [];
  for (const t of Object.values(s.tickets).filter((x) => isHeld(x) && x.held_outside)) {
    const rec = s.triage[t.key] ?? null;
    // Only keys still in held_by: a person's release (held_by=null) leaves held_outside behind, and a
    // stale key there is no hold to lift (a date hold set since would be released on it).
    const holding = keysOf(t.held_by);
    const steps = keysOf(t.held_outside).filter((p) => holding.includes(p) && stepOf(s, rec, p) === 'merge');
    if (!steps.length) continue;
    const what = steps.map((p) => `RECLASSIFIED ${t.key}: ${p} is a person step: build now, merge after`);
    if (s.dry) { out.push(...what.map((l) => dateLine(`${l} (dry run)`))); continue; }
    const by = holding.filter((p) => !steps.includes(p));
    const outside = keysOf(t.held_outside).filter((p) => !steps.includes(p));
    const mergeAfter = [...new Set([...keysOf(t.merge_after), ...steps])];
    if (by.length) out.push(set(t.key, `held_by=${by.join('|')}`, `held_outside=${outside.join('|') || 'null'}`, `merge_after=${mergeAfter.join('|')}`));
    else out.push(set(t.key, 'state=triaged', 'park=null', 'held_by=null', 'held_outside=null', `merge_after=${mergeAfter.join('|')}`), { type: 'front', key: t.key });
    out.push(...[...what, by.length ? `person-step hold: ${t.key}: still held behind ${by.join(', ')}` : `person-step hold: ${t.key}: RELEASED`].map(dateLine));
  }
  return out;
}
// Not yet started: triaged, or held, and never given a worktree. Read after decidePersonSteps' writes,
// so a ticket both change keeps the step just moved to its merge gate.
export function decidePersonInputs(s) {
  const out = [];
  for (const t of Object.values(s.tickets).filter((x) => keysOf(x.merge_after).length && !x.worktree && (x.state === 'triaged' || isHeld(x)))) {
    const rec = s.triage[t.key] ?? null;
    const inputs = keysOf(t.merge_after).filter((p) => stepOf(s, rec, p) === 'build');
    if (!inputs.length) continue;
    const line = `person-step hold: ${t.key}: ${inputs.join(', ')} now labelled as your input (config §4 Person-input labels), so the build waits for ${inputs.length === 1 ? 'it' : 'them'}: HELD again`;
    if (s.dry) { out.push(dateLine(`${line} (dry run)`)); continue; }
    const by = [...new Set([...keysOf(t.held_by), ...inputs])];
    const outside = [...new Set([...keysOf(t.held_outside), ...inputs])];
    const mergeAfter = keysOf(t.merge_after).filter((p) => !inputs.includes(p));
    const others = by.filter((p) => !inputs.includes(p));
    out.push({ type: 'park', key: t.key, question: `${HELD_PREFIX}: blocked by ${by.join(', ')} — starts once ${inputs.join(', ')} ${inputs.length === 1 ? 'is' : 'are'} Done in Jira${others.length ? ` and ${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} no longer holding it` : ''}` });
    // A date hold waits behind these, and is read again once they release it (queue.mjs hold).
    out.push(set(t.key, `held_by=${by.join('|')}`, `held_outside=${outside.join('|')}`, `merge_after=${mergeAfter.join('|') || 'null'}`, ...(dateHeld(t) ? ['held_label=null'] : [])));
    out.push(dateLine(line));
  }
  return out;
}

// ---- date holds ----------------------------------------------------------
// A triaged ticket whose triage record carries a blocked-until-YYYY-MM-DD label is held until that day
// on this machine's local date, then goes back to triaged in its place in the queue. One whose label's
// date cannot be read is held for the person, who fixes the label or lets it start. A held ticket is
// read against its labels on every pass, so a label fixed, moved or taken away moves its hold with it.
// held_label keeps the label a hold was for, and survives a release, so a ticket the person let start
// is not held on that label again.
//
// The snapshot: tickets, triage (as for person-step holds), today (batch-state.mjs localDay), dry.
export function decideDateHolds(s) {
  const holds = (h) => h && (h.bad || h.until > s.today);
  const out = [];
  for (const t of Object.values(s.tickets)) {
    const held = dateHeld(t);
    if (!held && t.state !== 'triaged') continue;
    const rec = s.triage[t.key] ?? null;
    // Labels not read yet (a triage running again, or its Jira read failed): a held ticket keeps the label
    // it was held on.
    const want = Array.isArray(rec?.labels) && !rec.facts_error ? dateHoldOf(rec.labels) : held;
    if (held && holds(want) && want.label === held.label) continue;
    if (held && !holds(want)) {
      if (s.dry) { out.push(dateLine(`date hold (dry run): ${t.key}: would release it`)); continue; }
      out.push(set(t.key, 'state=triaged', 'park=null', 'held_label=null'));
      out.push(dateLine(`date hold: ${t.key}: ${want ? `${want.until} has come` : 'no longer labelled blocked-until'}; RELEASED`));
      continue;
    }
    if (!holds(want) || (!held && t.held_label === want.label)) continue;
    const why = want.bad
      ? `${HELD_PREFIX}: ${badLabelText(want.label)}`
      : `${HELD_PREFIX}: blocked until ${want.until} (label ${want.label}) — starts on that date by itself`;
    if (s.dry) { out.push(dateLine(`date hold (dry run): ${t.key}: would hold it: ${why}`)); continue; }
    out.push({ type: 'park', key: t.key, question: why });
    out.push(set(t.key, `held_label=${want.label}`));
    if (held) out.push(dateLine(`date hold: ${t.key}: now held on its label ${want.label}`));
  }
  return out;
}

// ---- outside blockers ----------------------------------------------------
// The views of a triage record's blockers that the outside-blocker steps read, against the queue's
// `tickets` and the batch's `epic`.
// A link to the ticket's own epic, its parent epic or this batch's, never holds it: ticket-facts.mjs
// leaves it out of `blockers` (own_epic_blockers), and a record written before that is split here.
function blockerViews(tickets, epic) {
  const ownEpicSplit = (rec) => splitOwnEpic(rec?.blockers, rec?.epic?.key, epic);
  return {
    ownEpicOf: (rec) => [...new Set([...(Array.isArray(rec?.own_epic_blockers) ? rec.own_epic_blockers : []), ...ownEpicSplit(rec).own])],
    outsideOf: (rec) => (Array.isArray(rec?.blockers)
      ? ownEpicSplit(rec).blockers.filter((b) => !(b.key in tickets) && b.category !== 'done')
        .map((b) => ({ key: b.key, category: b.category, ...('assignee' in b ? { assignee: b.assignee } : {}) }))
      : null),
    // Its blockers Done under a resolution that ships nothing (closedUnlanded), in no batch or in this one
    // with no merged PR: no hold on one ever lifts by itself, so each link is raised once as a triage item
    // (wont_do_link, read by needs-you), and the record is read again while one is until the link is gone.
    // null when unread.
    wontDoOf: (rec) => (Array.isArray(rec?.blockers)
      ? ownEpicSplit(rec).blockers.filter((b) => !tickets[b.key]?.merged_at && closedUnlanded(b)).map((b) => b.key)
      : null),
    // A blocker in no batch read Done with no resolution or resolution date read (a record from before
    // they were, or a read that failed): read again once, or one closed without landing is never told from
    // one that landed, and how long one has been Done is never known.
    resolutionUnread: (rec) => Array.isArray(rec?.blockers)
      && ownEpicSplit(rec).blockers.some((b) => !(b.key in tickets) && b.category === 'done' && !('resolution' in b && 'resolved' in b)),
  };
}
// A ticket waiting to merge on the person's steps (merge_after).
const waitsOnStep = (t) => keysOf(t.merge_after).length > 0 && !t.merged_at;

// A ticket's open "is blocked by" links to tickets outside this queue, from its triage record's
// `blockers`, kept on the ticket as outside_blockers [{key, category, assignee?}] for desk-q and
// needs-you, `assignee` as ticket-facts.mjs read it (absent when it could not be). Of the tickets the
// blocker links step leaves out, only one that has some is read from Jira again here (read-blockers),
// at most once every INTAKE_EVERY_MS, so this reads Jira no more often than intake does. A read that
// fails leaves the record, and so the recorded blockers, as they were. A ticket waiting to merge on the
// person's steps (merge_after) is read while it waits, done or not and whether or not a step has since
// joined this queue.
//
// The snapshot: tickets, epic (the batch's), onJira (§4 Tracker is Jira), trackerKeys (the keys that
// are tracker keys), triage (as for person-step holds), now, dry.
export function* decideOutsideBlockers(s) {
  const { ownEpicOf, outsideOf, wontDoOf, resolutionUnread } = blockerViews(s.tickets, s.epic);
  const onTracker = Object.values(s.tickets).filter((t) => s.onJira && !(t.state === 'done' && !waitsOnStep(t)) && s.trackerKeys.has(t.key));
  const due = onTracker.filter((t) => (waitsOnStep(t) || keysOf(t.wont_do_link).length > 0 || resolutionUnread(s.triage[t.key] ?? null) || (t.outside_blockers ?? outsideOf(s.triage[t.key] ?? null) ?? []).length > 0)
    && !(t.outside_blockers_read && s.now - Date.parse(t.outside_blockers_read) < INTAKE_EVERY_MS)).map((t) => t.key);
  let triage = s.triage;
  if (due.length) {
    const { unread, why } = yield { type: 'read-blockers', keys: due };
    if (unread.length) yield epicLine(`outside blockers: not read, kept as they were and tried again in ${INTAKE_EVERY_MS / 60_000} minutes: ${why}`);
    triage = yield { type: 'triage', keys: onTracker.map((t) => t.key) };
  }
  for (const t of onTracker) {
    const rec = triage[t.key] ?? null;
    const now = outsideOf(rec);
    if (now && JSON.stringify(now) !== JSON.stringify(t.outside_blockers ?? null)) yield set(t.key, `outside_blockers=${JSON.stringify(now)}`);
    // Said once per link: own_epic_link records the links already reported.
    const own = ownEpicOf(rec);
    if (own.join('|') !== keysOf(t.own_epic_link).join('|')) {
      if (own.length) yield epicLine(`lint: ${t.key} is linked as blocked by its own epic ${own.join(', ')}, which is Done only once its children are: the link is ignored`);
      if (!s.dry) yield set(t.key, `own_epic_link=${own.join('|') || 'null'}`);
    }
    const wontDo = wontDoOf(rec);
    if (wontDo && wontDo.join('|') !== keysOf(t.wont_do_link).join('|')) {
      const fresh = wontDo.filter((k) => !keysOf(t.wont_do_link).includes(k));
      if (fresh.length) yield epicLine(`triage: ${t.key} is blocked by ${fresh.join(', ')}, closed without landing (${fresh.map((k) => rec.blockers.find((b) => b.key === k).resolution).join(', ')}): is the link still right? Raised once, in needs-you`);
      if (!s.dry) yield set(t.key, `wont_do_link=${wontDo.join('|') || 'null'}`);
    }
  }
}

// ---- outside holds -------------------------------------------------------
// A ticket admitted behind blockers in no batch (held_outside, also in held_by) waits until each is
// Done in Jira, as its triage record's `blockers` last read it, and its code is on this batch's base
// (landed, asked only of Done ones), or, where its Jira Repository is another configured repo, Done
// alone (plan-batch handed it there). Each such blocker is lifted from the hold, as is one the record
// no longer lists (its link was removed, so it blocks nothing), and one that is the ticket's own epic
// (ownEpicOf) at once; one admitted to this batch since is left in held_by as an ordinary hold,
// released when it merges here. One Done under a resolution that ships nothing is not Done here, even
// with no PR left to land: it stays, raised once (wont_do_link), until its link is removed. The merge driver never releases a
// ticket held outside its batch, so lifting the last blocker releases it here. A ticket parked at
// triage for its own reason (triagePark) loses only the hold: its park stays, and nothing spawns it.
// One Done for UNPROMOTED_AFTER_MS or more, by its record's `resolved`, whose code merged only into
// another branch is recorded on the ticket with that branch and its promotion PR (raiseUnpromoted), for
// the person to promote it or start without it; the hold stays.
//
// Whether a blocker landed reads GitHub, so a pass asks it once per blocker however many tickets wait
// on it, and for a ticket's blockers at most once every IDLE_RECHECK_MS (outside_read): a busy batch
// passes every tick, and an idle one rechecks on that interval (supervisor.mjs), so a blocker that
// lands is seen within it either way. Whether an epic landed through its epic PR reads the batches on
// disk, so it is asked once per pass; the GitHub read it makes for an archived batch whose merge
// nothing recorded keeps its answer in that archive (pass.mjs epicMerged) and so has its own interval.
//
// The snapshot: tickets, epic, triage (as for person-step holds), defaultBranch (the batch's base),
// repoDefault (the repo's default branch), now (in ms), dry.
export function* decideOutsideHolds(s) {
  const { tickets } = s;
  const { ownEpicOf } = blockerViews(tickets, s.epic);
  const answers = { landed: new Map(), 'epic-merged': new Map() };
  const unpromoted = new Map();
  for (const t of Object.values(tickets).filter((x) => holdsKept(x) && x.held_outside && !stoppedHold(x))) {
    const outside = keysOf(t.held_outside);
    const rec = s.triage[t.key] ?? null;
    const ownEpic = outside.filter((p) => !tickets[p] && ownEpicOf(rec).includes(p));
    const blockers = rec?.blockers;
    const done = new Set((blockers ?? []).filter((b) => b?.category === 'done' && !closedUnlanded(b)).map((b) => b.key));
    const unlinked = Array.isArray(blockers) ? outside.filter((p) => !tickets[p] && !ownEpic.includes(p) && !blockers.some((b) => b?.key === p)) : [];
    // `now` is when the supervisor started the pass (DESK_PASS_AT), the same clock its idle recheck
    // counts from, so the pass that recheck starts is a whole interval after the last read.
    const recent = !!t.outside_read && s.now - Date.parse(t.outside_read) < IDLE_RECHECK_MS;
    let read = false;
    // The answer for blocker p, asked only where no ticket asked it this pass, and whether it landed
    // only where this ticket's were not read within the interval; undefined when not asked. Only a
    // ticket that asked all its blockers moves its own clock: an answer another ticket fetched, picked
    // up while this one's are recent, would otherwise keep its unshared blockers from ever being asked.
    function* ask(type, p) {
      if (!answers[type].has(p)) { if (recent && type === 'landed') return undefined; answers[type].set(p, yield { type, key: p }); }
      if (type === 'landed' && !recent) read = true;
      return answers[type].get(p);
    }
    // An epic whose own batch (this one, or the batch named for it) landed its base through its epic
    // PR: the epic itself is never transitioned, so this is asked of a blocker not Done in Jira. One
    // Done is asked only whether it landed, which finds its epic PR too, so each blocker costs one read.
    const epicLanded = [];
    for (const p of outside) if (!tickets[p] && !ownEpic.includes(p) && !done.has(p) && (yield* ask('epic-merged', p))) epicLanded.push(p);
    // A blocker whose Jira Repository is another configured repo lands there, never on this base, so
    // Done in Jira alone lifts it.
    const awayDone = [];
    for (const p of outside) if (!tickets[p] && !ownEpic.includes(p) && !epicLanded.includes(p) && done.has(p) && (yield { type: 'other-repo', key: p })) awayDone.push(p);
    const landedNow = [];
    const away = {};
    for (const p of outside) {
      if (tickets[p] || ownEpic.includes(p) || epicLanded.includes(p) || awayDone.includes(p) || !done.has(p)) continue;
      const isLanded = yield* ask('landed', p);
      if (isLanded === true) { landedNow.push(p); continue; }
      // A read that failed, or one not asked because this ticket's were read within the interval,
      // keeps what was recorded.
      const kept = t.unpromoted?.[p];
      if (isLanded !== false) { if (kept) away[p] = kept; continue; }
      // Done a day or more with its code merged into another branch, never promoted: raised once, in needs-you.
      const since = Date.parse((blockers ?? []).find((b) => b?.key === p)?.resolved);
      if (!(s.now - since >= UNPROMOTED_AFTER_MS)) continue;
      // Read against the repo's default branch, which needs-you promotes into, never a named batch's base.
      if (!unpromoted.has(p)) unpromoted.set(p, yield { type: 'unpromoted', key: p, into: s.repoDefault });
      const u = unpromoted.get(p);
      // `promote` is the promotion PR the person asked for in needs-you, kept across reads.
      if (u) away[p] = { ...u, since: new Date(since).toISOString(), ...(kept?.promote != null ? { promote: kept.promote } : {}) };
      else if (kept) away[p] = kept;
    }
    yield* raiseUnpromoted(t, away, s);
    const lifted = [...ownEpic, ...epicLanded, ...awayDone, ...landedNow, ...unlinked];
    const left = outside.filter((p) => !tickets[p] && !lifted.includes(p));
    const stamp = read && !s.dry ? [`outside_read=${new Date(s.now).toISOString()}`] : [];
    if (left.length === outside.length) { if (stamp.length) yield set(t.key, ...stamp); continue; }
    const by = keysOf(t.held_by).filter((p) => !lifted.includes(p));
    const joined = outside.filter((p) => tickets[p]);
    const what = [ownEpic.length && `${ownEpic.join(', ')} its own epic, so its link is ignored`, epicLanded.length && `${epicLanded.join(', ')} landed on ${s.repoDefault} through its epic PR`,
      awayDone.length && `${awayDone.join(', ')} Done in Jira, in another repo`,
      landedNow.length && `${landedNow.join(', ')} Done and on ${s.defaultBranch}`, unlinked.length && `${unlinked.join(', ')} no longer linked as a blocker`,
      joined.length && `${joined.join(', ')} now in this batch`].filter(Boolean).join('; ');
    if (s.dry) { yield epicLine(`outside hold (dry run): ${t.key}: ${what}`); continue; }
    if (by.length) {
      yield set(t.key, `held_by=${by.join('|')}`, `held_outside=${left.join('|') || 'null'}`, ...(left.length ? stamp : ['outside_read=null']));
      yield epicLine(`outside hold: ${t.key}: ${what}; still held behind ${by.join(', ')}`);
    } else if (!isHeld(t)) {
      yield set(t.key, 'held_by=null', 'held_outside=null', 'outside_read=null');
      yield epicLine(`outside hold: ${t.key}: ${what}; hold lifted, and it stays parked: ${String(t.park.question).slice(0, 80)}`);
    } else {
      yield set(t.key, 'state=triaged', 'park=null', 'held_by=null', 'held_outside=null', 'outside_read=null');
      yield { type: 'front', key: t.key };
      yield epicLine(`outside hold: ${t.key}: ${what}; RELEASED`);
    }
  }
}

// What ticket `t` waits on that is merged only into another branch, as `unpromoted` {BLOCKER: {branch, pr,
// state, since}}, read by needs-you and desk-q: written when it changes, and said once per blocker when
// first recorded, so a pass that finds it again raises nothing.
function* raiseUnpromoted(t, away, s) {
  const was = t.unpromoted ?? {};
  const keys = Object.keys(away);
  const fresh = keys.filter((p) => !was[p]);
  for (const p of fresh) {
    const u = away[p];
    yield epicLine(`outside hold${s.dry ? ' (dry run)' : ''}: ${t.key}: ${p} Done since ${u.since.slice(0, 10)}, its code on ${u.branch} with ${promotionWords(u)}: raised once, in needs-you`);
  }
  if (s.dry || JSON.stringify(was) === JSON.stringify(away)) return;
  yield set(t.key, `unpromoted=${keys.length ? JSON.stringify(away) : 'null'}`);
}

// ---- merge holds on the person's steps -----------------------------------
// A ticket admitted with blockers in no batch that are the person's steps (merge_after) is built as any
// other, and the merge driver holds its PR. Each step is lifted once its triage record's `blockers`
// read it Done (a step has no code to land), or no longer list it; lifting the last lets the driver
// merge it, in the order the batch's own holds give. A blocker in no batch that triage called needed only
// to merge (triageGate) is another ticket's code, so it is lifted as an outside hold is: once Done and on
// this batch's base, or Done alone where its Jira Repository is another configured repo, and never while
// it is Done under a resolution that ships nothing (closedUnlanded), until its link is removed.
//
// The snapshot: tickets, triage, stepLabels, inputLabels (as for person-step holds), dry.
export function* decideMergeHolds(s) {
  const landed = new Map();
  for (const t of Object.values(s.tickets).filter(waitsOnStep)) {
    const steps = keysOf(t.merge_after);
    const rec = s.triage[t.key] ?? null;
    const blockers = rec?.blockers;
    if (!Array.isArray(blockers)) continue;
    const doneNow = [];
    for (const p of steps) {
      for (const b of blockers) {
        if (b?.key !== p || b.category !== 'done') continue;
        let lifts = !triageGate(b, rec, s.stepLabels, s.inputLabels);
        if (!lifts && !closedUnlanded(b)) {
          if (!landed.has(p)) landed.set(p, yield { type: 'landed-here', key: p });
          lifts = !!landed.get(p);
        }
        if (lifts) { doneNow.push(p); break; }
      }
    }
    const unlinked = steps.filter((p) => !blockers.some((b) => b?.key === p));
    const left = steps.filter((p) => !doneNow.includes(p) && !unlinked.includes(p));
    if (left.length === steps.length) continue;
    const what = [doneNow.length && `${doneNow.join(', ')} Done`, unlinked.length && `${unlinked.join(', ')} no longer linked as a blocker`].filter(Boolean).join('; ');
    if (s.dry) { yield epicLine(`merge hold (dry run): ${t.key}: ${what}`); continue; }
    yield set(t.key, `merge_after=${left.join('|') || 'null'}`);
    yield epicLine(`merge hold: ${t.key}: ${what}; ${left.length ? `still merges only after ${left.join(', ')}` : 'free to merge'}`);
  }
}

// The report's date-hold and epic lists.
const dateLine = (line) => ({ type: 'date-line', line });
const epicLine = (line) => ({ type: 'epic-line', line });
