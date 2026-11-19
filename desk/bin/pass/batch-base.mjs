// The "batch base" step of a pass, and its "baseline checks", as decisions. A batch with a base keeps
// its own worktree for it (every pass makes sure it exists), and the default branch is merged into the
// base only before a pass that will spawn, so new workers start on a current tree. A sync that cannot
// run is reported; in feature mode it also holds this pass's spawns, since the feature's children are
// built and tested against the base as one. Outside feature mode it holds them only once the base lags
// the default branch by more than it may.
//
// Each decision is a generator (pass/run-phase.mjs runSteps): a read only some cases make (the base's
// lag, a fix try's log, origin's heads) and a write whose result it goes on to use (the sync, the end
// of a fix try) is an action it yields, and what the handler returns is what the yield gives back. It
// starts no process and writes nothing; the handlers that do are pass.mjs's.
//
// The base sync snapshot:
//   queue        the queue as the pass's spawn section read it
//   base, source the batch base, and the default branch it is synced from
//   willSpawn    this pass has slots and tickets to spawn
//   epicOn       an epic batch not in feature mode;  epicOpen  its epic PR is open
//   sliceBad     config §3b "Promotion slice size (children)" said as unreadable, or null
//   behindMax    how many commits behind the default branch a base outside feature mode may be and
//                still spawn while its sync is blocked
//   gateBusy     a base gate recorded as running still has its process
//   resumeHeld   why a fix try's worker may not resume this pass, or null
//   registry     the pass's session-registry read (pass/shared.mjs registryView)
//   fixKey       the base fix's key
//   fixRoom      a base worker may start this pass;  noFixRoom  why not, when it may not
//   conflictPerm config §3 pr-conflict-unreviewed
//   push         the base push grant: { perm, key, ok }
//   passBy, passAt   who runs the pass, and when it started
//   usageHold    the batch's usage hold as the pass found it, or null
//   repoLogin    the repo's own login: only a limit there holds the batch
//   baselineOn   config §4 Baseline checks is on
//   dry          a dry run
//   now          the time, in ms
//
// Actions, beside the shared `report` ({ type, ... }; "->" is what the handler returns):
//   base-line {line}            a line of the report's base section
//   set-batch {fields}          a batch-level queue write (queue.mjs set-batch)
//   behind                      -> how many commits origin's base is behind the default branch, fetched
//                               first, or null unread
//   worktree                    -> the base worktree, made where missing: { ok, path, made, why }
//   fix-log                     -> the running fix try's log: { raw, text, recent, bytes }
//   kill {pid}                  stop the fix try's worker
//   end-try {outcome, path, extra}  -> base_fix once its last try ends with `outcome`
//   fix-login {login}           -> the login the fix try's session lives in
//   lifted {limit, login}       -> whether the limit on that login has lifted
//   usage-hold {hold}           the batch's usage hold: { type, resetsAt, preflight, login }
//   usage-stop                  no more workers start this pass
//   origin-sha {branch}         -> origin's head of branch, or null
//   sync {path}                 -> base-sync.mjs syncBase's result for the base worktree
//   drop-ref {ref}              delete a kept ref
//   note-conflict {what, entry} -> a line where the conflict's files could not be recorded, else null
//   fetch                       fetch the base and the default branch
//   synced {state}              what the sync settled, for the rest of the pass: { bf, baseHold,
//                               baseLag, baseNotSynced, baseWt, baseFix, baseFixLive, baseFixResume,
//                               gateConflict }
//   baseline {path}             record the baseline checks in the base worktree (decideBaseline)
//   open-promotion {path, carry}    open the promotion or epic PR
//   next-promotion {path, promotion}  follow a merged promotion PR with the next one
import { workerMarkers, endedNormally } from '../harvest.mjs';
import { usageLimit, limitName } from '../usage-limit.mjs';
import { wroteSince } from '../worker-cost.mjs';
import { baseFixCall, baseFixOutcome, lockWaitPark, mergeTry, FIX_TRIES_MAX } from '../base-fix.mjs';
import { tries } from '../fix-tries.mjs';
import { epicDue, epicCarry } from '../batch-state.mjs';
import { behindPrs } from '../desk-q.mjs';
import { summary } from '../baseline.mjs';
import { QUIET_PASSES, WEDGE_PASSES, sameLogin, liftedHow, untilText, pausedOn, usageHeldText, tryWhat, tryNo } from './shared.mjs';

// What endTry kept of the last try, for its report line.
const keptNote = (x) => (!x?.kept ? '' : x.kept.ref ? `; its unpushed ${String(x.kept.sha).slice(0, 12)} is kept on ${x.kept.ref}`
  : `; its unpushed ${String(x.kept.sha).slice(0, 12)} could not be kept on a ref (${x.kept.error})`);

// ---- batch base ------------------------------------------------------------
export function* decideBaseSync(s) {
  const { queue: q, base: BASE, source: SOURCE, fixKey: KEY } = s;
  let bf = q.base_fix ?? null;
  let baseHold = false;
  let baseLag = null;
  let baseNotSynced = null;
  let baseFix = null;
  let baseFixLive = false;
  let baseFixResume = null;
  let gateConflict = null;
  // plan-batch records the decision on the queue when it seeds; feature.json alone can name a spine
  // for a batch that runs as an ordinary one.
  const featureMode = q.feature === true;
  if (featureMode && s.sliceBad) yield say('waiting', s.sliceBad);
  // An open child PR whose required check the default branch's workflow runs on the base, but the
  // base's does not (pr_status.behind, from the last pass), gets CI only once the base is synced, so the
  // base syncs even with nothing to spawn. So does an open epic PR, which merges into the default branch.
  const staleCI = behindPrs(q);
  // A base behind the default branch syncs on every pass, spawning or not: a batch whose every ticket
  // is held spawns nothing, and a park waiting on "base contains <branch>" would otherwise wait for
  // ever. Read from origin as fetched now; a fetch that fails reads the refs as they were.
  // null when the count cannot be read (a ref never fetched): unknown, never reported as 0.
  const behindBy = yield { type: 'behind' };
  const behindNow = behindBy > 0;
  const wantSync = s.willSpawn || staleCI.length > 0 || s.epicOpen || behindNow;
  // A sync that does not land holds spawns in feature mode, and otherwise once the base lags too far.
  // A lag that cannot be read holds nothing outside feature mode, and the note says it was not read.
  const lag = behindBy === null ? `how far ${BASE} is behind ${SOURCE} could not be read` : `${BASE} is ${behindBy} commit(s) behind ${SOURCE}`;
  const lagHolds = !featureMode && behindBy !== null && behindBy > s.behindMax;
  const syncHolds = featureMode || lagHolds;
  const holdNote = featureMode ? 'feature mode, so nothing spawns this pass'
    : lagHolds ? `${lag}, more than the ${s.behindMax} it may lag and still spawn, so nothing spawns this pass`
      : `spawning carries on from the base as it stands (${lag}${behindBy === null ? '' : `, within the ${s.behindMax} it may lag`})`;
  const holdSpawns = () => {
    if (!syncHolds) return;
    baseHold = true;
    if (lagHolds) baseLag = `${lag}, more than the ${s.behindMax} it may lag`;
  };
  function* blocked(why) {
    baseNotSynced = why;
    yield say('waiting', `base sync: ${why} — ${holdNote}`);
    holdSpawns();
  }
  // Held as a blocked sync is, but a worker's to clear, not the person's.
  function* heldForFix(why) {
    baseNotSynced = why;
    yield baseLine(`base sync: ${why} — ${syncHolds ? holdNote.replace('nothing spawns', 'nothing else spawns') : holdNote}`);
    holdSpawns();
  }
  const wt = yield { type: 'worktree' };
  if (wt.ok && wt.made) yield baseLine(`base worktree for ${BASE} made at ${wt.path}`);
  // A try's worker that has finished leaves its outcome on the try. One whose last word is a park or a
  // done has finished whether or not its session exits, and one quiet for six passes is wedged: either
  // is stopped, as a ticket's worker is, so the try ends and the next conflict at this head goes to the
  // person. Otherwise the registry unread, or a log written in the last two minutes that has not ended,
  // reads as still at it.
  // A try's worker resumes, after the usage limit or the maintenance window, only when a ticket's
  // resume would: nothing holds spawns (pacing aside, which never holds a fix) and memory allows.
  const { resumeHeld, registry: reg } = s;
  if (bf?.running && bf.resume === 'maintenance') {
    // Stopped for the maintenance window with its session kept: the same try, resumed once the window
    // is done, never ended or counted as spent.
    baseFixLive = true;
    const ended = 'stopped for the maintenance window';
    if (!resumeHeld) baseFixResume = { wt: wt.ok ? wt.path : null, why: wt.ok ? null : wt.why, ended, clear: { resume: null } };
    else yield say('paused', `${KEY}: ${ended}; it resumes once nothing holds spawns (${resumeHeld})`);
  } else if (bf?.running) {
    const { raw, text, recent, bytes } = yield { type: 'fix-log' };
    const markers = workerMarkers(text);
    const said = markers.some(([k]) => k === 'AUTOPILOT_DONE' || k === 'AUTOPILOT_PARK');
    // At a usage limit it has not answered since, as a ticket's worker: never stopped or failed for it,
    // and while it waits for the limit to lift it is paused, not quiet.
    const usage = !said ? usageLimit(text) : null;
    const atLimit = usage?.last?.kind === 'limit' && !usage.last.resumed ? usage.last : null;
    const paused = pausedOn(atLimit, s.now);
    const idle = wroteSince(raw, bf.log_bytes ?? 0) || paused ? 0 : (bf.idle_passes ?? 0) + 1;
    const sidLive = reg.read && reg.liveSids.has(bf.running);
    const exited = reg.read && !sidLive && !(recent && !endedNormally(text));
    // A headless worker ends its session at the limit rather than waiting for it to lift. As a ticket's
    // worker: held until the limit lifts, then resumed in its own session (resumeBaseFix), never ended
    // as no marker. Once per limit: a resume that ends before the model answers, with no new rejection,
    // leaves the same count of limits in the log, and then ends the try as any other exit.
    const awaitsLift = exited && !!atLimit && bf.resume_limits !== usage.limits.length;
    const outcome = awaitsLift ? null
      : idle >= WEDGE_PASSES && !said ? `was stopped as wedged, with no output for ${idle} passes`
        : reg.read && (said || exited) ? baseFixOutcome(markers)
          : null;
    if (outcome) {
      const pid = (reg.read ? reg.sessions : []).find((a) => a.sessionId === bf.running)?.pid;
      if (pid && !s.dry) yield { type: 'kill', pid };
      const lockWait = said && lockWaitPark(markers);
      bf = yield { type: 'end-try', outcome, path: wt.ok ? wt.path : null, extra: lockWait ? { lock_wait: true } : {} };
      const ended = bf.tries[bf.tries.length - 1];
      yield baseLine(`base ${tryWhat(ended)}: try ${tryNo(bf)} of ${FIX_TRIES_MAX} on ${BASE} ${outcome}${pid ? ` (session still live, stopped pid ${pid})` : ''}${keptNote(ended)}${lockWait ? '; it waited only on the busy test lock, so it spends no try' : ''}`);
    } else {
      baseFixLive = true;
      if (idle !== (bf.idle_passes ?? 0) || bytes !== (bf.log_bytes ?? 0)) {
        bf = { ...bf, log_bytes: bytes, idle_passes: idle };
        if (!s.dry) yield setBatch(`base_fix=${JSON.stringify(bf)}`);
      }
      // Resumed once its limit lifts (its reset passed, or the pass's one probe call succeeded) and
      // nothing else holds spawns: another limit, the maintenance window, the budget, memory.
      const from = yield { type: 'fix-login', login: bf.login };
      const up = awaitsLift && (yield { type: 'lifted', limit: atLimit, login: from });
      const ended = up ? `exited at ${limitName(atLimit.type)}, which lifted (${liftedHow(atLimit, s.now)})` : null;
      // Until then it waits on its own login, whose folder holds its transcript.
      if (up && !resumeHeld) baseFixResume = { wt: wt.ok ? wt.path : null, why: wt.ok ? null : wt.why, ended, clear: { resume_limits: usage.limits.length } };
      else if (up) yield say('paused', `${KEY}: ${ended}; it resumes once nothing holds spawns (${resumeHeld})`);
      else if (paused || awaitsLift) {
        yield say('paused', `${KEY} on ${limitName(atLimit.type)}${untilText(atLimit)}, then it resumes, or sooner once a probe call succeeds`);
        // On the repo's login its limit holds the batch, as a paused ticket's worker does.
        if (sameLogin(s.repoLogin, from) && !(yield { type: 'lifted', limit: atLimit, login: from })) {
          if (!s.usageHold) {
            const hold = { type: atLimit.type, resetsAt: atLimit.resetsAt, preflight: null, login: from };
            yield { type: 'usage-hold', hold };
            yield say('stalled', `${KEY}: ${usageHeldText(hold)}`);
          }
          yield { type: 'usage-stop' };
        }
      }
      else if (idle >= QUIET_PASSES) yield say('quiet', `${KEY}: quiet for ${idle} passes`);
    }
  }
  const originSha = (branch) => ({ type: 'origin-sha', branch });
  // A conflict, met by the sync or by the base gate. A fix worker takes it where §3 lets one: -> { line }
  // for the report. What no worker may take, or what its tries left, is the person's: -> { person }.
  function* conflicted(files, check = null) {
    const head = yield originSha(BASE);
    const source = yield originSha(SOURCE);
    const c = baseFixCall(bf, { head, source, files, perm: s.conflictPerm, alive: baseFixLive, push: s.push, check });
    const said = check
      ? `merging ${SOURCE} into ${BASE} fails §4 Merged-tree check (${check.command}), nothing pushed. Its output: ${check.output.replace(/\n/g, ' / ')}`
      : `merging ${SOURCE} into ${BASE} conflicts, nothing pushed. Conflicting files: ${files?.length ? files.join(', ') : 'not listed'}`;
    const what = tryWhat({ check });
    const Try = `${what[0].toUpperCase()}${what.slice(1)}`;
    if (c.call === 'person' || c.call === 'stuck') return { person: `${said}. ${c.why[0].toUpperCase()}${c.why.slice(1)}: resolve it by hand in ${wt.path} and push` };
    if (c.call === 'wait') return { line: `${said}. ${Try} try ${c.try?.try ?? '?'} of ${FIX_TRIES_MAX} is resolving it (session ${bf.running}); the base is synced once it pushes` };
    if (!s.fixRoom) return { line: `${said}. ${Try} try ${c.fix.try} of ${c.fix.of} starts once a worker may (none may this pass: ${s.noFixRoom})` };
    baseFix = { wt: wt.path, fix: c.fix };
    return { line: `${said}. ${Try} try ${c.fix.try} of ${c.fix.of} starts this pass in ${wt.path}` };
  }
  // A slice gate runs in the base worktree while children still spawn: nothing else touches it until
  // the gate is done, and spawns carry on from origin's base as it stands.
  const { gateBusy } = s;
  let metConflict = false;
  if (!wt.ok) {
    if (wantSync) yield* blocked(wt.why);
    else yield say('waiting', `base worktree: ${wt.why}`);
  } else if (wantSync && gateBusy) {
    baseNotSynced = `skipped while the base gate runs in ${wt.path}`;
    yield baseLine(`base sync: ${baseNotSynced}; spawning carries on from ${BASE} as it stands`);
  } else if (wantSync && baseFixLive) {
    // The worktree is the fix worker's until it ends.
    metConflict = true;
    const last = bf.tries[bf.tries.length - 1];
    const line = !mergeTry(last) ? `${tryWhat(last)} try ${last.try} is working in ${wt.path} (session ${bf.running}); the base is synced once it ends`
      : `${tryWhat(last)} try ${tryNo(bf)} of ${FIX_TRIES_MAX} is merging ${SOURCE} into ${BASE} in ${wt.path} (session ${bf.running}); the base is synced once it pushes`;
    yield* heldForFix(line);
    gateConflict = { worker: true, line };
  } else if (wantSync) {
    const sync = yield { type: 'sync', path: wt.path };
    const ciNote = staleCI.length ? `, and syncing it starts CI on ${staleCI.join(', ')}, whose required checks only ${SOURCE}'s workflow runs on ${BASE}` : '';
    // A base that syncs is no longer in conflict, so a later conflict starts its tries afresh. The epic
    // PR's review tries and the promotion PR's check tries are kept: they count per head.
    const conflictTries = (bf?.tries ?? []).filter(mergeTry);
    if (sync.ok && !sync.dry && conflictTries.length && !s.dry) {
      yield baseLine(`base conflict fix: ${BASE} is current with ${SOURCE} again, after ${tries(conflictTries.filter((x) => !x.lock_wait).length)}`);
      for (const x of conflictTries) if (x.kept?.ref) yield { type: 'drop-ref', ref: x.kept.ref };
      const kept = bf.tries.filter((x) => !mergeTry(x));
      bf = kept.length ? { tries: kept, running: null, port: null } : null;
      yield setBatch(`base_fix=${bf ? JSON.stringify(bf) : 'null'}`);
    }
    if (sync.ok && sync.dry) yield baseLine(`base sync (dry run): would merge ${sync.merged} commit(s) from ${SOURCE} into ${BASE}; nothing pushed`);
    else if (sync.ok && sync.merged) yield baseLine(`base sync: merged ${sync.merged} commit(s) from ${SOURCE} into ${BASE} and pushed${sync.retried ? ' (the first push was refused as non-fast-forward: fetched, merged again, retried once)' : ''}${sync.hookSkipped ? `; the pre-push hook could not run its checks in the base worktree (${sync.hookSkipped}, an environment failure, not a failing check), so it was pushed without them and CI checks it` : ''}${staleCI.length ? `; ${staleCI.join(', ')} ${staleCI.length === 1 ? 'is' : 'are'} reopened so CI runs` : ''}`);
    else if (sync.ok) yield baseLine(`base sync: ${BASE} already has everything on ${SOURCE}`);
    else if (sync.reason === 'conflict' || sync.reason === 'check') {
      metConflict = true;
      if (sync.reason === 'conflict') {
        const head = yield originSha(BASE);
        const source = yield originSha(SOURCE);
        const noted = yield { type: 'note-conflict', what: `the base ${BASE}`, entry: { files: sync.files, ticket: KEY, pr: null, head, source } };
        if (noted) yield baseLine(noted);
      }
      const c = yield* conflicted(sync.files, sync.check ?? null);
      if (c.person) yield* blocked(c.person);
      if (c.line) yield* heldForFix(c.line);
      gateConflict = { worker: !!c.line, line: c.line ?? c.person, said: !c.line };
    } else if (sync.reason === 'permission') {
      const why = `${BASE} is ${sync.merged} commit(s) behind ${SOURCE} and config §3 ${s.push.key} is "${s.push.perm}", so it was not synced${ciNote}`;
      if (s.push.perm === 'ask' && s.passBy === 'supervisor') {
        // No session is there to ask, so the batch is asked once, as one needs-you item; the approval
        // it records on the queue is passed to every later pass by the supervisor.
        if (!q.base_push_ask && !s.dry) yield setBatch(`base_push_ask=${JSON.stringify({ since: s.passAt, base: BASE, source: SOURCE })}`);
        baseNotSynced = why;
        yield baseLine(`base sync: ${why}: asked once for the batch in /desk-needs-you (its base-push item) — ${holdNote}`);
        holdSpawns();
      } else {
        yield* blocked(`${why}${s.push.perm === 'ask' ? ': ask once for the batch, then run passes with AUTOPILOT_BASE_PUSH_APPROVED=1' : ''}`);
      }
    } else yield* blocked(sync.why);
    // The ask is settled once the base is current, its push is granted, or the row no longer asks.
    if (q.base_push_ask && (sync.ok || s.push.ok || s.push.perm !== 'ask') && !s.dry) yield setBatch('base_push_ask=null');
  }
  // The base gate met a conflict at the head origin's base is still at: the same fix worker takes it,
  // and the gate runs again once the base moves.
  const g = q.gate;
  if (wt.ok && !metConflict && !gateBusy && g?.state === 'failed' && Array.isArray(g.conflict)) {
    yield { type: 'fetch' };
    if (baseFixLive) {
      gateConflict = { worker: true, line: `conflict fix try ${tryNo(bf)} of ${FIX_TRIES_MAX} is resolving it (session ${bf.running})` };
    } else if (g.sha && g.sha === (yield originSha(BASE))) {
      const c = yield* conflicted(g.conflict, g.tree_check ?? null);
      gateConflict = c.line ? { worker: true, line: c.line } : { worker: false, line: c.person };
    }
  }
  // The base worktree is a running fix worker's, or about to be, so nothing else works in it this pass.
  const fixOwns = baseFixLive || baseFix != null;
  yield { type: 'synced', state: { bf, baseHold, baseLag, baseNotSynced, baseWt: wt.ok ? wt.path : null, baseFix, baseFixLive, baseFixResume, gateConflict } };
  if (wt.ok && s.willSpawn && !gateBusy && !baseHold && !fixOwns && s.baselineOn) yield { type: 'baseline', path: wt.path };
  if (wt.ok && featureMode && !fixOwns && q.promotion == null) yield { type: 'open-promotion', path: wt.path };
  else if (wt.ok && featureMode && !fixOwns && q.promotion?.pr != null && !gateBusy) yield { type: 'next-promotion', path: wt.path, promotion: q.promotion };
  // An epic batch not in feature mode opens its epic PR once every child has merged into the base, and
  // tries again each pass until one is open.
  // Each one opened after an earlier merged keeps that merge as `since`, and every earlier merge in
  // `merged`, through a retry too: needs-you ages a child's follow-on steps from the epic PR that
  // promoted it (needs-you.mjs outAt), so a reopen must not drop one.
  const ep = q.promotion;
  if (wt.ok && s.epicOn && !fixOwns && epicDue(q) && (ep?.pr == null || ep.merged_at)) yield { type: 'open-promotion', path: wt.path, carry: epicCarry(ep) };
}

// ---- baseline checks -------------------------------------------------------
// With config §4 Baseline checks on, the base's Typecheck and Lint errors are recorded in the base
// worktree before a pass spawns, whenever the base has moved since the last record, so workers fail
// only on errors they add (baseline.mjs). A base that cannot be recorded leaves no baseline at all:
// workers then run the full checks rather than compare against an older base.
// Workers branch from origin's base, so a base worktree that a failed sync left behind it is not
// recorded either.
//
// The snapshot:
//   base, path   the batch base, and its worktree
//   prior        the baseline last recorded (baseline.mjs readBaseline), or null
//   checks       config §4 Typecheck and Lint's items ({ typecheck, lint }), or null where they do
//                not parse;  checksError  why not
//   install      config §4 Install's items ([] where they do not parse)
//   dry          a dry run
//
// Actions, beside the shared `report` ("->" is what the handler returns):
//   heads              -> { head, origin }: the base worktree's HEAD and origin's base there ('' unread)
//   base-line {line}   a line of the report's base section
//   drop-baseline      remove the recorded baseline
//   dirty              -> whether the base worktree has uncommitted changes
//   install {item}     -> the exit code of an Install item run there
//   restore            -> whether the base worktree had changes, now put back
//   record {checks, sha}  -> the baseline recorded (baseline.mjs recordBaseline)
export function* decideBaseline(s) {
  const { base: BASE, path, prior } = s;
  const { head, origin } = yield { type: 'heads' };
  if (head && head === origin && prior && prior.base === BASE && prior.sha === head) return;
  if (s.dry) { yield baseLine(`baseline (dry run): would record ${BASE} at ${head.slice(0, 12)}`); return; }
  function* drop(why) {
    yield { type: 'drop-baseline' };
    yield say('waiting', `baseline: not recorded for ${BASE} at ${head.slice(0, 12) || '?'}: ${why} — workers run the full Typecheck and Lint`);
  }
  if (!head) { yield* drop(`could not read the base worktree's HEAD in ${path}`); return; }
  if (head !== origin) { yield* drop(`the base worktree ${path} is not at origin's ${BASE} (${origin.slice(0, 12) || 'unreadable'}), which workers start from`); return; }
  if (yield { type: 'dirty' }) { yield* drop(`the base worktree ${path} has uncommitted changes`); return; }
  if (!s.checks) { yield* drop(s.checksError); return; }
  // The base worktree is a plain checkout, so it gets the dependencies the checks need.
  for (const it of s.install) {
    const code = yield { type: 'install', item: it };
    if (code !== 0) { yield { type: 'restore' }; yield* drop(`config §4 Install (${it.cmd}) failed there with exit ${code}`); return; }
  }
  const b = yield { type: 'record', checks: s.checks, sha: head };
  const changed = yield { type: 'restore' };
  yield baseLine(`baseline: recorded ${BASE} at ${head.slice(0, 12)}: ${summary(b)}${changed ? ' (the checks changed files in the base worktree; put back)' : ''}`);
}

const say = (list, line) => ({ type: 'report', list, line });
const baseLine = (line) => ({ type: 'base-line', line });
const setBatch = (...fields) => ({ type: 'set-batch', fields });
