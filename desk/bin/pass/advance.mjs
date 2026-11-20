// The "advance running tickets" step of a pass, and "the usage limit" step after it, as decisions:
// each running worker's log is read, a live worker is told from a dead one, and the ticket moves to
// its next state; then the workers paused at a usage limit, and the batch's own hold, are settled.
//
// Each decision is a generator (pass/run-phase.mjs runSteps). A read only some cases make (a gh call,
// the usage probe, a park's clears-when) and a write whose result the decision goes on to use (the
// issue links it made, a lease refusal) is an action it yields, and what the action's handler returns
// is what the yield gives back. So every read and write runs only where it did before, in the same
// order, while the decision itself starts no process and writes nothing: a unit suite answers it with
// stubs. The handlers that do I/O are pass.mjs's.
//
// The advance snapshot, read for each running ticket as its turn comes:
//   t              the ticket, as the pass read the queue when it started
//   log            null where the ticket has no log yet (or runs in the cloud), else
//                  { path, h (harvest.mjs's output), raw (a Buffer), text, size, mtimeMs }
//   registry       the pass's session-registry read (pass/shared.mjs registryView)
//   now            the time, in ms
//   stateDir       the batch's state directory
//   upload         { allowed: §3 pr-images is yes or the person approved, perm: its value, key: its
//                  config key, command: the uploader to show the person }
//   resume         config §3b "Resume a killed worker (times)" (pass/shared.mjs resumeSetting)
//   bootMs         when this computer last started, in ms
//   read           { branch, checkout }: the live reads' branch and their clean checkout
//
// Actions, beside the shared `set` and `report` ({ type, key, ... }; "->" is what the handler returns):
//   cloud {key}                    advance a cloud session (no log here)
//   open-pr {key, branch}          -> the number of the open PR on branch, or '' (gh pr list)
//   note {line}                    a batch-notes line
//   hold {key, limit, was}         the worker is paused at `limit`, its usage_paused `was`
//   suite-wait {key, worktree}     -> the suite the worktree runs or waits for, or null
//   kill {key, pid}                stop the worker's process
//   park {key, question}           park the ticket
//   build-park {key, question}     -> the park waits only on a §4 Check builds check: {pr, head, checks, command}, or null
//   merge-park {key}               -> the park asks only who merges its PR: {call, pr, head, question, grant}, or null
//   shots {key, dir}               -> the screenshot files in dir ([] when missing)
//   cells {key, pr, shots}         -> how many of shots PR #pr's body still has a cell for, or null unread
//   upload {key, pr, dir}          put dir's screenshots in PR #pr's body
//   open-question {key}            -> the question a live worker is waiting on, or null
//   worker-head {key}              record the head the exited worker left
//   done {key, pr, summary, line, sets}   record the ticket done
//   settle-links {key}             -> the issue links the worker asked for that were not made
//   park-links {key, needs, pr}    park a done ticket on the links not made
//   live-read {key, question}      -> {reads, head} where the park asks only for §4 Live reads, or null
//   clears-when {key}              -> the park's clears-when
//   register {key, question, cond} -> the park against the "not now" register: {inputs, status, entry, line}
//   recommends {key, question}     -> the call the park recommends, or null
//   keep-links {key, needs, pr}    keep links not made as follow-on steps
//   decisions {key, pr}            log the calls the worker took
//   refuse-lease {key, question}   -> true where the park went back to a worker, told to name its lease
//   handoff {key, said, imgs, stopped}   queue the handed-off stage for a fresh session
//   lifted {key, limit}            -> whether the limit on the worker's login has lifted
//   exit-code {key}                -> the exit code spawn-worker.sh recorded, or null
//   fail {key, why, tail}          mark the ticket failed
import { expandHome, SCREENSHOT_FILE } from '../desk-env.mjs';
import { LIVE_READ, needsSession, unnamedForcePush } from '../batch-state.mjs';
import { endedNormally, followOnIn, workerEnd, budgetStop, hostFault } from '../harvest.mjs';
import { noteLine } from '../decisions.mjs';
import { usageLimit, resetText, limitName } from '../usage-limit.mjs';
import { wroteSince } from '../worker-cost.mjs';
import { crashOf } from '../undraft.mjs';
import { ticketShotDir } from '../evidence.mjs';
import { SUITE_WAIT_TEXT } from '../suite-wait.mjs';
import { QUIET_PASSES, WEDGE_PASSES, SUITE_WAIT_CEILING_MS, sameLogin, liftedHow, untilText, pausedOn, linksLine, linkSteps, parkFollowOn, resumeRefusal, set, say, runsInCloud } from './shared.mjs';

// Why a worker that is not in the registry, and ended with no marker and no result, stopped.
export const REBOOT = 'the computer restarted after its last log write';
const DIED = 'its process died while the computer stayed up';
// A log written this recently is a worker the registry has not caught up with, not a dead one.
const FRESH_LOG_MS = 120_000;
const exitText = (code) => (code == null ? 'exit code not recorded' : `exit code ${code}`);

// How the worker's log says it ended, from its harvested output `h`: each marker read so that the last
// one written describes it, and `t` for the reboot stops already acted on.
export function logMarkers(h, t) {
  // ORDER MATTERS, and getting it wrong re-parks finished tickets. A worker that parks, gets
  // answered, posts and exits leaves BOTH markers in the log. Taking the last PARK unconditionally
  // re-parks a completed ticket — the log is append-only and this function has no
  // notion of which markers it has already actioned, so a spent PARK reads exactly like a live one.
  // Whichever marker appears LAST is the one that describes how the worker actually ended.
  const lastPark = [...h.matchAll(/AUTOPILOT_PARK:\s*(.+)/g)].pop();
  const lastDone = [...h.matchAll(/AUTOPILOT_DONE:\s*(.+)/g)].pop();
  const parkSupersededByDone = lastPark && lastDone && lastDone.index > lastPark.index;
  // A handoff (AUTOPILOT_HANDOFF: 4b or 7) ends this session so the next stage starts in a fresh one.
  // It counts only as the last marker: a session that hands off has neither parked nor finished.
  const lastHandoff = [...h.matchAll(/AUTOPILOT_HANDOFF:\s*(.+)/g)].pop();
  // A stop for a planned reboot (AUTOPILOT_REBOOT) is resumed by the pass after the boot, never parked.
  // It counts only as the last of the four, and only once: a resumed session keeps this log, so the
  // stops already acted on (reboot_stops) are spent. A session that already printed DONE has finished.
  const reboots = [...h.matchAll(/AUTOPILOT_REBOOT:[ \t]*(.*)/g)];
  const lastReboot = reboots.length > (t.reboot_stops ?? 0) && !lastDone ? reboots.at(-1) : null;
  const reboot = lastReboot && [lastPark, lastHandoff].every((m) => !m || lastReboot.index > m.index)
    ? (lastReboot[1].trim() || 'no reason given') : undefined;
  const handoffLast = !reboot && !!lastHandoff && [lastPark, lastDone].every((m) => !m || lastHandoff.index > m.index);
  const handoff = handoffLast ? lastHandoff[1].trim() : undefined;
  const park = handoff || reboot || parkSupersededByDone ? undefined : lastPark?.[1];
  // A worker whose last word is DONE has finished, whether or not its session ever exits: one that
  // hangs after printing it must be recorded done, never left running and then parked as wedged.
  const done = park || handoff || reboot ? undefined : lastDone?.[1];
  return { park, done, handoff, reboot, reboots: reboots.length };
}

// ---- advance running tickets --------------------------------------------
// One running ticket's turn: its actions, in the order the pass carries them out.
// An environment park: the worker parked or stopped (`verb`) when the computer could not run commands.
function* hostPark(t, fault, verb) {
  const question = `environment: ${fault} — this computer could not run commands when its worker ${verb}, so nothing about the ticket changed. Free the space, then requeue it with queue.mjs requeue ${t.key}`;
  yield { type: 'park', key: t.key, question };
  yield say(t.key, 'parked', `${t.key}: ${question}`);
}

export function* decideAdvance(s) {
  const { t, log, registry } = s;
  if (runsInCloud(t) && t.cloud) { yield { type: 'cloud', key: t.key }; return; }
  if (!log) return;
  const { h } = log;
  const live = registry.read && !!t.session_id && registry.liveSids.has(t.session_id);
  const pidOf = () => registry.sessions.find((a) => a.sessionId === t.session_id)?.pid;

  const stage = [...h.matchAll(/AUTOPILOT_STAGE:\s*(\S+)/g)].pop()?.[1];
  if (stage && stage !== t.stage) yield* setAndSay(t.key, [`stage=${stage}`], 'advanced', `${t.key} → ${stage}`);
  // A worker opens its draft PR at Stage 7 and carries on (review, Jira) before it prints DONE, and
  // only DONE records result.pr. From Stage 7 on, ask GitHub once a pass until the PR shows, and keep
  // it as draft_pr, so the status watch shows a PR opened while its worker still runs.
  if (t.draft_pr == null && t.branch && parseInt(stage ?? t.stage, 10) >= 7) {
    const opened = yield { type: 'open-pr', key: t.key, branch: t.branch };
    if (/^\d+$/.test(opened)) yield* setAndSay(t.key, [`draft_pr=${opened}`], 'advanced', `${t.key} opened PR #${opened}`);
  }

  const { park, done, handoff, reboot, reboots } = logMarkers(h, t);
  for (const m of h.matchAll(/AUTOPILOT_NOTE:\s*(.+)/g)) yield { type: 'note', line: noteLine(t.key, m[1]) };

  // A worker at a usage limit (usage-limit.mjs decides; nothing here reads the event). Only a worker
  // that has neither parked nor finished, and has not answered since the limit, is acted on.
  const usage = usageLimit(log.text);
  const limit = !park && !done && !handoff && !reboot && usage.last?.kind === 'limit' && !usage.last.resumed ? usage.last : null;
  if (usage.unrecognised.length > (t.usage_unrecognised ?? 0)) {
    yield* setAndSay(t.key, [`usage_unrecognised=${usage.unrecognised.length}`], 'unrecognised', `${t.key}: ${usage.unrecognised.at(-1)}`);
  }
  for (const l of usage.limits.filter((x) => x.resumed)) {
    yield { type: 'note', line: `- [${t.key}] resumed after ${limitName(l.type)}${l.resetsAt != null ? ` (reset at ${resetText(l.resetsAt)})` : ''}` };
  }
  const pausedOnLimit = pausedOn(limit, s.now);
  // Kept by the usage-limit step only while the ticket is still running once every ticket has had its turn.
  if (pausedOnLimit) yield { type: 'hold', key: t.key, limit, was: t.usage_paused };
  else if (t.usage_paused) yield set(t.key, 'usage_paused=null');

  // Log growth is the honest liveness signal: it comes from the harness, not from self-reporting.
  // It is not sufficient on its own — a hung `codex exec` emits a tool_progress heartbeat every 30s
  // until the harness moves the call to the background at 600s, so for those ten minutes log growth
  // overstates liveness. See references/orchestrator-recovery.md.
  // Workers log no partial messages, so a long model turn writes nothing until its message ends: six
  // quiet passes is the margin for it. A suite under the test lock, or a wait for it, is read from the
  // worktree's processes instead, up to SUITE_WAIT_CEILING_MS.
  let wedged = false;
  if (wroteSince(log.raw, t.log_bytes ?? 0)) {
    yield set(t.key, `log_bytes=${log.size}`, 'idle_passes=0', ...(t.suite_wait_since != null ? ['suite_wait_since=null'] : []));
  } else if (pausedOnLimit) {
    // Waiting for the reset is not a stall.
    if (t.idle_passes) yield set(t.key, 'idle_passes=0');
  } else {
    const idle = (t.idle_passes ?? 0) + 1;
    const stall = idle >= WEDGE_PASSES && !done && !handoff && !reboot;
    // Held since the first pass that found it so; the ceiling counts from then.
    const waitOn = stall ? yield { type: 'suite-wait', key: t.key, worktree: t.worktree } : null;
    const since = waitOn ? (t.suite_wait_since ?? s.now) : null;
    const overCeiling = since != null && s.now - since > SUITE_WAIT_CEILING_MS;
    yield set(t.key, `idle_passes=${idle}`, ...(since !== (t.suite_wait_since ?? null) ? [`suite_wait_since=${since}`] : []));
    if (waitOn && !overCeiling) {
      yield say(t.key, 'quiet', `${t.key}: quiet for ${idle} passes, ${SUITE_WAIT_TEXT[waitOn]}`);
    } else if (stall && registry.read) {
      // With no registry the worker cannot be stopped, so it is left for the next pass, never parked as stopped.
      // Free the slot. The worker's session id survives, so it can be resumed later with
      // its context intact; leaving it wedged blocks the whole batch.
      const pid = pidOf();
      if (pid) yield { type: 'kill', key: t.key, pid };
      wedged = true;
      const why = overCeiling
        ? `no output for ${idle} passes, ${SUITE_WAIT_TEXT[waitOn]} for over the ${SUITE_WAIT_CEILING_MS / 60000}-minute ceiling`
        : `no output for ${idle} passes`;
      yield { type: 'park', key: t.key, question: `wedged — ${why}, worker stopped (session ${t.session_id}). Requeue it with queue.mjs requeue ${t.key} (desk-autopilot's orchestrator-recovery.md); never resume the session by hand, which would run it without the worker sandbox` };
      yield say(t.key, 'stalled', `${t.key}: ${why} — stopped and parked, slot freed`);
    } else if (idle >= QUIET_PASSES) yield say(t.key, 'quiet', `${t.key}: quiet for ${idle} passes`);
  }

  // Screenshots the worker captured but cannot upload: one shared browser profile, so the
  // orchestrator does it, one PR at a time, and only once per ticket — and only where config §3
  // grants driving the signed-in browser. Otherwise surface it for the user once.
  // The worker prints an absolute path, but a `~/...` one must still work: node does not expand ~,
  // and an unexpanded path made the uploader exit on every pass.
  // A session started from a handoff may open the PR for screenshots an earlier session captured: the
  // directory that session printed is kept on the ticket (images_dir) when it hands off.
  const logImgDir = [...h.matchAll(/AUTOPILOT_IMAGES:\s*(\S+)/g)].pop()?.[1];
  // Where neither names one, the directory every worker is briefed to capture into (the spawn's
  // "Screenshot directory"), since a worker can save its screenshots there and never print the marker
  // (KAN-629: five PNGs, five rounds, no AUTOPILOT_IMAGES, and its cells went to the person).
  const namedImgDir = expandHome(logImgDir ?? t.images_dir ?? undefined);
  const imgDir = namedImgDir ?? ticketShotDir(t, s.stateDir);
  // A park that waits only on a check §4 Check builds names, once its worker has exited (buildParkOf):
  // recorded done below, so its screenshots go to its PR here as a DONE worker's do.
  // A park made after the computer could not run commands (hostFault) is an environment park, so its
  // words are never read as a build-only or merge-only park, nor as its lane.
  const fault = park && !wedged ? hostFault(log.text) : null;
  const built = park && !fault && !wedged && registry.read && !(t.session_id && registry.liveSids.has(t.session_id))
    ? yield { type: 'build-park', key: t.key, question: park.trim() } : null;
  // A park asking only who merges its green, clean PR (mergeParkOf): done where desk may merge it, else
  // the merge question naming the row that keeps desk from it.
  const merging = park && !fault && !built && !wedged && registry.read && !(t.session_id && registry.liveSids.has(t.session_id))
    ? yield { type: 'merge-park', key: t.key } : null;
  const mergeOnly = merging?.call === 'done' ? merging : null;
  // This round's log names the PR first: after a requeue, t.result.pr is the previous round's PR.
  const prNo = [...h.matchAll(/AUTOPILOT_DONE:[^\n]*pr=(\d+)/g)].pop()?.[1] ?? (built ? String(built.pr) : null) ?? (mergeOnly ? String(mergeOnly.pr) : null) ?? t.result?.pr;
  if (imgDir && prNo && !t.images_uploaded) {
    // A directory that is missing or holds no screenshot means no images, not a failed upload. A
    // running worker may still capture into it, so only a finished one is recorded as having none.
    const shots = (yield { type: 'shots', key: t.key, dir: imgDir }).filter((f) => SCREENSHOT_FILE.test(f));
    const finished = done || built || mergeOnly;
    if (!shots.length) {
      if (finished) yield set(t.key, 'images_uploaded=none');
    } else if (!namedImgDir && (crashOf(t, prNo) || !(finished && (yield { type: 'cells', key: t.key, pr: prNo, shots })))) {
      // The briefed directory, unnamed this round, is uploaded only once its worker is finished (with no
      // marker, nothing says its screenshots are all taken) and only while the PR's body still has a
      // `_drag <file>_` cell naming one of them. It keeps every round's screenshots and the uploader
      // sends the whole directory, so a later round's PR whose cells were filled would get each asset
      // again. A body that could not be read waits for the undraft step, which reads it again. An
      // upload of it that crashed is the crashed-uploads step's, which keeps to UPLOAD_TRIES.
    } else if (s.upload.allowed) {
      yield { type: 'upload', key: t.key, pr: prNo, dir: imgDir };
    } else if (!t.images_reported) {
      yield* setAndSay(t.key, ['images_reported=true'], 'waiting', `${t.key}: screenshots for PR #${prNo} are in ${imgDir} — config §3 ${s.upload.key} is "${s.upload.perm}". ` +
        `Ask, then: DESK_UPLOAD_APPROVED=1 node ${s.upload.command} ${prNo} ${imgDir}`);
    }
  }

  let stopped = '';
  if (live && (done || handoff || reboot)) {
    // Finished (or handed off, or stopped for a reboot) but hung: stop the session (it has nothing left to do) and record it below.
    const pid = pidOf();
    if (pid) yield { type: 'kill', key: t.key, pid };
    const said = done ? 'DONE' : handoff ? 'HANDOFF' : 'REBOOT';
    stopped = pid ? ` (session still live after ${said} — stopped pid ${pid})` : ` (session still live after ${said}, no pid to stop: session ${t.session_id})`;
  } else if (live) {
    // A worker sitting on an unanswered question is waiting, not working.
    const asked = yield { type: 'open-question', key: t.key };
    if (asked) yield say(t.key, 'waiting', `${t.key}: ${asked}`);
    return;
  }
  if (!registry.read) return; // cannot tell — leave it alone rather than guess
  // The head its worker left: a later fix try pushes commits up to it rather than hold them (busyWorktree).
  yield { type: 'worker-head', key: t.key };

  // Exited, or finished and stopped above. Decide what it was, from the markers read above.
  // A park waiting only on a check §4 Check builds names (built, read above) is done: the undraft step builds it.
  if (reboot) {
    // Its session, branch, worktree and unpushed commits are kept, and it is not counted as a kill:
    // the spawn resumes it once the computer has restarted, or once no restart came in time (rebootReady).
    yield* setAndSay(t.key, ['state=triaged', 'resume=reboot', `resume_why=stopped for a planned reboot (${reboot})`,
      `reboot_stops=${reboots}`, `reboot_stop_at=${new Date(log.mtimeMs).toISOString()}`],
    'advanced', `${t.key} stopped for a planned reboot (${reboot}): queued to resume in its own session after the restart${stopped}`);
  } else if (built) {
    const checks = built.checks.map((x) => `"${x}"`).join(', ');
    yield {
      type: 'done', key: t.key, pr: String(built.pr), summary: `parked only on ${checks}, which §4 Check builds clears: recorded done`,
      line: `PR #${built.pr} recorded done, not parked: its park waited only on ${checks} red at ${String(built.head).slice(0, 9)}, which §4 Check builds clears, so the undraft step runs \`${built.command}\`. Steps its park named as not reached (a tracker comment or transition) are left undone. The park: ${park.trim()}${stopped}`,
      // The screenshot directory the worker printed, for the undraft step's missing-shot check (shotsOf).
      sets: logImgDir ? [`images_dir=${logImgDir}`] : [],
    };
    yield* linksOnDone(t, built.pr);
  } else if (mergeOnly) {
    // The park's own words are kept as its follow-on: the steps it named for after the merge are listed
    // for the person once the PR merges (needs-you), never a reason to hold it.
    const n = mergeOnly.pr;
    yield {
      type: 'done', key: t.key, pr: String(n), summary: `parked only on who merges PR #${n}, which desk merges: recorded done`,
      line: `PR #${n} recorded done, not parked: its park waited only on #${n} merging, and #${n} is green with a clean review at ${String(mergeOnly.head).slice(0, 9)}, so the undraft step takes it out of draft and the merge driver merges it (${mergeOnly.grant}). What the park said is kept as a follow-on, listed for you once #${n} merges. The park: ${park.trim()}${stopped}`,
      sets: [parkFollowOn(park, t.follow_on), 'follow_on_comment=due', ...(logImgDir ? [`images_dir=${logImgDir}`] : [])],
    };
    yield* linksOnDone(t, n);
  } else if (fault) {
    // The computer could not run commands (no space or no inodes left), so the worker's park says
    // nothing about its ticket: an environment park, requeued once the host is healthy, never a lane.
    // Its own words are not quoted, so a "lane C" said then is never read as its lane.
    yield* hostPark(t, fault, 'parked');
  } else if (park) {
    // Without the rows that let desk merge it, a merge-only park is the merge question, naming them.
    // The links the worker asked for are made now; any not made join its question, and its follow-ons
    // below (keep-links).
    const question = park.trim();
    const linkNeeds = yield { type: 'settle-links', key: t.key };
    const asked = `${merging?.call === 'ask' ? `${merging.question}. The park: ${question}` : question}${linkNeeds.length ? `. ${linksLine(linkNeeds)}` : ''}`;
    yield { type: 'park', key: t.key, question: asked };
    // The exact text a gated write waits on, which the worker keeps in its park file (approve), is kept
    // with the park, so it is relayed from there rather than dug out of the log.
    yield { type: 'park-approve', key: t.key, question };
    // The round a requeue's fresh spawn may resume (resumeRound). Only a worker's own park records
    // one: a stalled or failed worker starts again at Stage 0. Dated by the log's last write, so an
    // answer given before this pass saw the park still counts as its answer.
    yield set(t.key, `last_round=${JSON.stringify({ stage: stage ?? t.stage ?? null, question, at: new Date(log.mtimeMs).toISOString() })}`);
    // A park asking only for §4 Live reads waits on the pass, which starts them in its "live reads"
    // section and settles it there.
    const read = wedged ? null : yield { type: 'live-read', key: t.key, question };
    const cleared = read ? { kind: LIVE_READ, ...read } : yield { type: 'clears-when', key: t.key, question };
    const reg = yield { type: 'register', key: t.key, question, cond: cleared };
    const recommends = yield { type: 'recommends', key: t.key, question };
    // A merge question keeps the park's words as its follow-on too, so a merge by hand still lists them.
    yield set(t.key, `park.inputs=${JSON.stringify(reg.inputs)}`, `park.clears_when=${JSON.stringify(cleared)}`,
      ...(recommends ? [`park.recommends=${JSON.stringify(recommends)}`] : []), ...(merging?.call === 'ask' ? [parkFollowOn(park, t.follow_on)] : []));
    yield { type: 'keep-links', key: t.key, needs: linkNeeds.map((n) => n.why), pr: t.result?.pr };
    // Before the requeue, which moves this round's log aside.
    yield { type: 'decisions', key: t.key, pr: null };
    if (!wedged && !read && !needsSession({ ...t, park: { question } }) && unnamedForcePush({ question, inputs: reg.inputs }, t.branch)
      && (yield { type: 'refuse-lease', key: t.key, question })) return;
    if (read) yield say(t.key, 'clears', `${t.key}: parked only on §4 Live reads ${read.reads.join(', ')} at ${read.head.slice(0, 9)}: each runs from the pass's clean checkout of origin/${s.read.branch} (${s.read.checkout}), never the ticket's worktree; requeued once they finish. The park: ${question}`);
    else if (reg.status === 'put_off') yield say(t.key, 'putOff', `${t.key}: ${question} (put off on ${reg.entry.at.slice(0, 10)})`);
    else yield say(t.key, 'parked', `${t.key}: ${asked}${reg.status === 'changed' ? ` — ${reg.line}` : ''}`);
  } else if (handoff) yield { type: 'handoff', key: t.key, said: handoff, imgs: logImgDir, stopped };
  else if (done) {
    const pr = /pr=(\d+)/.exec(done)?.[1] ?? null;
    // A finished ticket sent back later (a spec check, a spine rejected) is rework: from Stage 0, not
    // the stage its last handoff named.
    // A capture try's said= names each screen it could not take and why: kept whole (result.done.said), as
    // the summary's 200 characters cut all but the first few (fix-tries.mjs captureTry). Written as JSON,
    // so a said= opening with a bracket is never parsed by queue.mjs as JSON and refused.
    const said = /\bsaid=(.*)$/.exec(done.trim())?.[1]?.trim();
    // Steps that wait on the merge (follow_on=), kept for needs-you once the PR merges.
    const follow = followOnIn(done);
    if (follow.error) yield say(t.key, 'inputs', `${t.key}: unreadable follow_on on its DONE marker (${follow.error}), nothing kept: ${done.trim()}`);
    yield { type: 'done', key: t.key, pr, summary: done.trim(), line: `${done.trim()}${stopped}`, sets: [
      ...(said ? [`result.done=${JSON.stringify({ said: said.slice(0, 2000) })}`] : []),
      ...(follow.steps.length ? [`follow_on=${JSON.stringify([...linkSteps(t.follow_on), ...follow.steps])}`] : []),
    ] };
    yield* linksOnDone(t, pr);
  } else if (limit && !wedged && t.session_id && t.resume_limits !== usage.limits.length) {
    // Exited at a usage limit, PR open or not: a headless worker ends its session there rather than
    // waiting for the reset, often mid-edit. It stays running, reported paused, until the limit lifts,
    // then is resumed in its own session on its own login, never failed, taken as done or started on
    // another login. Once per limit: a resume that
    // ends before the model answers, with no new rejection, leaves the same count of limits in the log,
    // and is then handled as any other exit below rather than resumed on every pass.
    if (yield { type: 'lifted', key: t.key, limit }) {
      const why = `exited at ${limitName(limit.type)}, which lifted (${liftedHow(limit, s.now)})`;
      yield* setAndSay(t.key, ['state=triaged', 'resume=usage', `resume_why=${why}`, `resume_limits=${usage.limits.length}`],
        'advanced', `${t.key} ${why}: queued to resume in its own session`);
    }
  } else {
    // Stopped at the per-worker budget, often with its work done and not yet committed: resumed once
    // in its own session (budget_resumed names it) with a small allowance to commit, push and finish
    // its stage. A second stop in that session parks, naming the budget and the worktree.
    if (!wedged && t.session_id && budgetStop(log.text)) {
      if (t.budget_resumed !== t.session_id) {
        yield* setAndSay(t.key, ['state=triaged', 'resume=budget', 'resume_why=stopped at its per-worker budget', `budget_resumed=${t.session_id}`],
          'advanced', `${t.key} stopped at its per-worker budget: queued to resume once, to commit, push and finish its stage`);
        return;
      }
      const why = `stopped at its per-worker budget again after one resume to finish. Its worktree ${t.worktree ?? '(none recorded)'} may hold work it did not commit: commit and push it there, or raise config §3b "Autopilot per-worker budget (USD)" and requeue it with queue.mjs requeue ${t.key}`;
      yield { type: 'park', key: t.key, question: why };
      yield say(t.key, 'parked', `${t.key}: ${why}`);
      return;
    }
    // Killed mid-run, PR open or not: resumed in its own session by the spawn, ahead of new
    // tickets, unless config §3b refuses another resume.
    const killed = !wedged && !endedNormally(log.text) && t.session_id ? (log.mtimeMs < s.bootMs ? REBOOT : DIED) : null;
    const stop = killed ? resumeRefusal(s.resume, t, killed) : null;
    // A log written in the last two minutes, since this computer started, is a worker the registry
    // has not caught up with, not a dead one: resuming it would put two processes on one session.
    if (killed && killed !== REBOOT && s.now - log.mtimeMs < FRESH_LOG_MS) {
      yield say(t.key, 'quiet', `${t.key}: not in the session registry, but its log was written in the last 2 minutes — left running, checked again next pass`);
      return;
    }
    if (killed && !stop) {
      yield* setAndSay(t.key, ['state=triaged', 'resume=pending', `resume_why=${killed}`], 'advanced', `${t.key} killed before it finished (${killed}): queued to resume`);
      return;
    }
    // No marker is not evidence of failure. A worker can do everything and exit without
    // announcing it. Ask GitHub what actually exists before believing the silence. An open PR
    // means a PR exists, NOT that the review posted or that it merged — verify those separately.
    const pr = yield { type: 'open-pr', key: t.key, branch: t.branch ?? '' };
    const prOpen = /^\d+$/.test(pr);
    // A fix that holds the merge is the exception: the person's instruction, or a migration rename try.
    // An open PR says nothing about whether it was carried out, and done would close the fix that holds
    // the merge (merge-driver.sh instruction_held) and, for a rename, spend its one try (renamesFix).
    const held = !t.fix?.finished && ['instruction', 'renames'].includes(t.fix?.kind) ? t.fix.kind : null;
    if (prOpen && !held) {
      yield { type: 'done', key: t.key, pr, summary: 'completed without printing a marker', line: `PR #${pr} (no marker printed — PR exists on GitHub; verify review and merge state)`, sets: [] };
    } else {
      yield { type: 'decisions', key: t.key, pr: null };
      if (prOpen) {
        const why = held === 'renames'
          ? `its worker ended with no marker, so the migrations PR #${pr} names may not be updated to their base's new names (${(t.fix.renames ?? []).map((r) => `${r.old} → ${r.new}`).join(', ') || 'see its fix'}), and the PR stays held from merging. Requeue it for a new worker on the same renames — check ${log.path}`
          : `its worker ended with no marker, so your instruction on PR #${pr} may not be carried out, and the PR stays held from merging. Requeue it for a new worker on the same instruction — check ${log.path}`;
        yield { type: 'park', key: t.key, question: why };
        yield say(t.key, 'parked', `${t.key}: ${why}`);
      } else if (stop?.fail) {
        const code = yield { type: 'exit-code', key: t.key };
        yield { type: 'fail', key: t.key, why: `killed before it finished (${killed}), with no marker and no open PR on ${t.branch} (${workerEnd(log.text)}, ${exitText(code)}). ${stop.fail}`, tail: ` — check ${log.path}` };
      } else if (stop?.park) {
        yield { type: 'park', key: t.key, question: stop.park };
        yield say(t.key, 'parked', `${t.key}: ${stop.park}`);
      } else if (hostFault(log.text)) {
        // Stopped when the computer could not run commands: the host's fault, not the ticket's.
        yield* hostPark(t, hostFault(log.text), 'stopped');
      } else {
        const code = yield { type: 'exit-code', key: t.key };
        yield { type: 'fail', key: t.key, why: `exited with no marker and no open PR on ${t.branch}${limit ? `, last seen at ${limitName(limit.type)}${limit.resetsAt != null ? ` (resets ${resetText(limit.resetsAt)})` : ''}` : ''} (${workerEnd(log.text)}, ${exitText(code)})`, tail: ` — check ${log.path}` };
      }
    }
  }
}

// The issue links a ticket recorded done asked for: made, and any not made park it (park-links).
function* linksOnDone(t, pr) {
  const needs = yield { type: 'settle-links', key: t.key };
  yield { type: 'park-links', key: t.key, needs, pr };
}

// ---- the usage limit -----------------------------------------------------
// A paused worker holds the batch while it is still running once every ticket has had its turn. A
// preflight the limit refused holds it through the queue's usage_hold, kept across passes until the
// limit lifts. A hold whose limit has lifted holds nothing, and spawns and resumes go ahead as normal.
// Nothing moves to another subscription: a worker waits for its own login's limit, and the batch for
// the repo's.
//
// The snapshot:
//   tickets    the queue's tickets, by key
//   holds      the workers the advance step found paused: { key, limit, was, login }
//   stored     the queue's usage_hold, or null
//   preLogin   the login a stored preflight hold ran on
//   repoLogin  the repo's own login: only a limit there holds the batch
//   now        the time, in ms
//
// Actions, beside `set` and `report`:
//   keep-holds {keys}          the paused workers' holds still running, which hold the pass's spawns
//   lifted {limit, login}      -> whether the limit on that login has lifted
//   usage-hold {hold}          the batch's hold: { type, resetsAt, preflight, login }
export function* decideUsageLimit(s) {
  // A ticket a pass from before this left waiting to move to another login (`login_move`) resumes its own
  // session on its own login instead, as one that exited at the limit does; the field goes from every ticket.
  for (const t of Object.values(s.tickets)) {
    if (t.login_move == null) continue;
    const from = t.login_move.from ?? 'its own';
    const waiting = t.state === 'triaged' && !!t.session_id;
    yield set(t.key, 'login_move=null', ...(waiting ? ['resume=usage', `resume_why=was waiting to move off login ${from}, which desk no longer does`] : []));
    if (waiting) yield say(t.key, 'advanced', `${t.key}: no longer moved off login ${from}: it resumes its own session there`);
  }
  const holds = [];
  for (const h of s.holds) {
    if (s.tickets[h.key]?.state !== 'running') {
      if (s.tickets[h.key]?.usage_paused) yield set(h.key, 'usage_paused=null');
      continue;
    }
    holds.push(h);
  }
  yield { type: 'keep-holds', keys: holds.map((h) => h.key) };
  for (const h of holds) {
    yield say(h.key, 'paused', `${h.key} on ${limitName(h.limit.type)}${untilText(h.limit)}, then it resumes, or sooner once a probe call succeeds`);
    // desk-q reads this to show the ticket paused rather than at its stage.
    if (h.was?.type !== h.limit.type || h.was?.resets_at !== h.limit.resetsAt) {
      yield set(h.key, `usage_paused=${JSON.stringify({ type: h.limit.type, resets_at: h.limit.resetsAt })}`);
    }
  }
  const stored = s.stored;
  const pre = stored?.preflight ? { key: stored.preflight, limit: { type: stored.type ?? 'unknown', resetsAt: stored.resets_at ?? null }, login: s.preLogin } : null;
  let holding = null;
  for (const h of [...(pre ? [pre] : []), ...holds]) {
    if (sameLogin(s.repoLogin, h.login) && !(yield { type: 'lifted', limit: h.limit, login: h.login })) { holding = h; break; }
  }
  if (holding) yield { type: 'usage-hold', hold: { type: holding.limit.type, resetsAt: holding.limit.resetsAt, preflight: holding === pre ? pre.key : null, login: holding.login } };
  else if (pre && !sameLogin(s.repoLogin, pre.login)) yield say(null, 'advanced', `${limitName(pre.limit.type)} on login ${pre.login.name} no longer holds the batch, as this repo's subscription is another: spawns go ahead`);
  else if (pre) yield say(null, 'advanced', `${limitName(pre.limit.type)} lifted (${liftedHow(pre.limit, s.now)}): spawns and resumes go ahead`);
}

function* setAndSay(key, fields, list, line) { yield set(key, ...fields); yield say(key, list, line); }
