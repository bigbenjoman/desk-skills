// The spawn loop's choices, as a per-ticket step: pass.mjs calls it for each candidate in turn, and it
// ends in one verdict for that ticket: skip, record-done, park (the slot taken), park-ask, hand-away or start.
//
// The step is a generator (pass/run-phase.mjs runSteps). A read only some candidates reach (gh, git,
// the triage record), and a locked write whose result it goes on to use (the upload claim, the
// read-only repos' refresh, the worktree setup), is an action it yields, and what the handler returns
// is what the yield gives back. So each runs only where, and in the order, the loop ran it before,
// while the step itself starts no process and writes nothing. Starting the worker is the runner's,
// after a `start` verdict.
//
// The snapshot, read as the candidate's turn comes:
//   t          the ticket
//   at         the pass's start time, an ISO string
//   dry        a dry run: nothing recorded where the loop records nothing on one
//   stop       the loop is stopped: the batch base holds it, or the usage limit was met this pass
//   attempts   the slots taken so far this pass, and `slots` how many it has
//   rerun      t is named in AUTOPILOT_RERUN, so a PR shipped elsewhere does not count
//   resume     t is a killed worker waiting to resume, and `handoff` a session handed off to its next stage
//   dbDown     a worktree setup earlier this pass found the local database down
//   dbUp       the database health check answered on this pass
//   fetchLimit the seconds a worktree setup's git fetch is given
//
// Actions, beside the shared `set` and `report` ({ type, key, ... }; "->" is what the handler returns):
//   file-budget {key}    -> true where a file it names is at its per-file budget, counting the tickets
//                           running now, those started earlier this pass included (pass.mjs collidesWithRunning)
//   fix-try-stale {key}  -> true where its fix try ended with no worker (pass.mjs fixTryStale)
//   shipped {key}        -> { pr, branch, mergedAt } or { jira: true } where it shipped outside its worker, else null
//   fresh {key}          -> true where it starts from Stage 0, with no session, fix try or PR in this repo behind it
//   placement {key}      -> its triage record's placement in another repo, or null
//   rows-needed {key}    -> the park line asking for a config row it needs that the config lacks, or null
//   busy {key}           -> why its worktree is held, or null (pushing its last worker's commits first)
//   busy-held {key}      the worktree is held this pass
//   lock-queue {key}     -> true where the test-lock queue holds it
//   lock-queue-held {key} the test-lock queue held it
//   claim-upload {key}   -> { ok: true, up }: up its last round's upload still running, else null and the
//                           job dropped; { ok: false, why } where the upload queue could not be read
//   read-repos {}        -> the read-only repos that could not be refreshed, once a pass: [{ repo, why }]
//   login {key}          -> the login a new session starts on (pass.mjs repoLogin), or null
//   take-slot {key}      one of the pass's slots is taken
//   setup {key}          -> the worktree setup: { wt, kept, renamed, hung } where origin was found hung
//                           before it, else { wt, kept, renamed, ok, exitOk, out, retried }
//   remote-hung {why}    origin is marked hung for the rest of the pass
//   db-down {why}        the local database's health check is marked failing
// The verdict, last:
//   skip {key, stop?}                         nothing more for it; `stop` ends the loop
//   record-done {key, how, pr, mergedAt, line, dropStatus?} record it done, shipped outside its worker;
//                                             dropStatus: its PR status is another repo's PR of that number
//   park {key, line}                          park it
//   park-ask {key, line}                      park it with a question for the person, no slot taken
//   hand-away {key, placement}                admit it in the repo its code is in
//   start {key, how, pick?, setup?}           start it: `how` is resume, handoff, cloud or local

import { set, say, runsInCloud } from './shared.mjs';

export function* decideSpawn(s) {
  const { t } = s;
  const key = t.key;
  const skip = { type: 'skip', key };
  const wait = (line) => say(key, 'waiting', `${key}: ${line}`);
  if (s.stop || !(s.attempts < s.slots)) return yield { ...skip, stop: true };
  // A ticket spawned earlier in this pass is running too, so it fills a place in the per-file budget.
  if (yield { type: 'file-budget', key }) return yield skip;
  if (yield { type: 'fix-try-stale', key }) return yield skip;
  // Shipped outside its worker: recorded done without taking a slot, and nothing spawns.
  const shipped = s.rerun ? null : yield { type: 'shipped', key };
  if (shipped) {
    const how = shipped.pr != null ? `PR #${shipped.pr} merged from ${shipped.branch}` : 'done in Jira with no PR';
    return yield { type: 'record-done', key, how, pr: shipped.pr ?? null, mergedAt: shipped.mergedAt ?? null, ...(shipped.dropStatus ? { dropStatus: true } : {}),
      line: `${key}: ${how}, outside its worker: recorded done, no worker spawned` };
  }
  // Its code wholly in another repo by its triage record: handed over without taking a slot. Whether it
  // starts fresh is read here, not in the snapshot: the fix-try check above can finish its fix try.
  const fresh = yield { type: 'fresh', key };
  const away = fresh ? yield { type: 'placement', key } : null;
  if (away) return yield { type: 'hand-away', key, placement: away };
  // A row it needs that the config lacks is asked for now, not after its PR opens, without taking a slot.
  const needs = fresh ? yield { type: 'rows-needed', key } : null;
  if (needs) return yield { type: 'park-ask', key, line: needs };
  // Held without taking a slot: another ticket may spawn in its place.
  const busy = yield { type: 'busy', key };
  if (busy) {
    yield { type: 'busy-held', key };
    if (!s.dry && t.worktree_busy?.why !== busy) yield set(key, `worktree_busy=${JSON.stringify({ why: busy, at: s.at })}`);
    yield wait(`WORKTREE IN USE — ${busy}, so no worker was spawned. The next pass looks again`);
    return yield skip;
  }
  // Held without taking a slot: a resume at a stage that runs no suite may still start in its place.
  if (yield { type: 'lock-queue', key }) {
    yield { type: 'lock-queue-held', key };
    return yield skip;
  }
  // Its last round's upload running in the machine's upload queue (another repo's pass may be running
  // it) edits the PR body the next round's worker edits too: that round waits until it ends. Otherwise
  // the job is dropped by the claim, in the same locked step, so no pump can start it before the worker runs.
  if (!s.resume && !s.handoff && !runsInCloud(t)) {
    const claim = yield { type: 'claim-upload', key };
    if (!claim.ok) {
      yield wait(`the machine's upload queue could not be read to drop its last round's upload (${claim.why}), so no worker was spawned. The next pass looks again`);
      return yield skip;
    }
    // Nothing for the person to do: it waits for the next pass, so it notifies nobody.
    if (claim.up) {
      yield say(key, 'waits', `${key}: its last round's upload to PR #${claim.up.pr} is running in the machine's upload queue, so its next round's worker waits for it to end. The next pass looks again`);
      return yield skip;
    }
  }
  if (!runsInCloud(t)) {
    const failures = yield { type: 'read-repos' };
    if (failures.length) {
      const failure = `read-only repo could not be refreshed, so no worker was spawned to read a stale copy — ${failures.map((f) => `${f.repo}: ${f.why}`).join('; ')}`;
      // A requeue starts a parked ticket's session afresh, so a killed worker's waits for the next pass.
      if (s.resume) {
        yield wait(`${failure}. Its session is kept, and the next pass tries again`);
        return yield skip;
      }
      // Takes the slot its worker would have: a bad refresh parks no more tickets than the pass would have started.
      yield { type: 'take-slot', key };
      yield set(key, 'handoff=null');
      return yield { type: 'park', key, line: `${failure}. Once it is reachable: queue.mjs requeue ${key}` };
    }
  }
  // A new session starts on the repo's subscription; a resumed one has its own, so it still goes ahead.
  const needsLogin = !s.resume && (s.handoff || !runsInCloud(t));
  const pick = needsLogin ? yield { type: 'login', key } : null;
  if (needsLogin && !pick) return yield skip;
  yield { type: 'take-slot', key };
  if (s.resume) return yield { type: 'start', key, how: 'resume' };
  if (s.handoff) return yield { type: 'start', key, how: 'handoff', pick };
  if (runsInCloud(t)) return yield { type: 'start', key, how: 'cloud' };
  // An earlier setup in this pass found the local database down: no other worktree is set up on it.
  if (s.dbDown) {
    yield wait('held, the local database is not answering (health); it spawns on the first pass it answers');
    return yield skip;
  }
  return yield* afterSetup(s, pick, yield { type: 'setup', key });
}

// The verdict on a local ticket once its worktree setup has run.
function* afterSetup(s, pick, setup) {
  const { t } = s;
  const key = t.key;
  const skip = { type: 'skip', key };
  // A remote that did not answer is the machine's, not the ticket's: it stays queued for the next pass.
  const remoteDown = (why) => say(key, 'waiting', `${key}: held, origin did not answer (${why}); it spawns on a pass origin answers`);
  if (setup.hung) {
    yield remoteDown(setup.hung);
    return yield skip;
  }
  const fetchHung = !setup.ok && /FAIL: git fetch origin did not answer within \d+s/.exec(setup.out)?.[0];
  if (fetchHung) {
    yield { type: 'remote-hung', why: `git fetch ran past its ${s.fetchLimit} seconds earlier in this run` };
    yield remoteDown(fetchHung.replace(/^FAIL: /, ''));
    return yield skip;
  }
  if (!setup.ok) {
    const why = `${setup.retried}${whyOf(setup.out)}`;
    // The local database not answering is the machine's, not the ticket's: it stays queued, and the
    // database health check is marked failing so the hold starts now and lifts once it answers.
    const pgDown = setup.out.split('\n').find((l) => /FAIL: cannot reach Postgres in container/.test(l));
    // Unless the database check answered on this pass, and this ticket waited on it before: then the
    // container is up and setup still cannot use it (a role it lacks, say), which waiting will not fix.
    if (setup.exitOk === false && pgDown && !(s.dbUp && t.db_wait)) {
      if (!s.dry) yield set(key, `db_wait=${s.at}`);
      yield { type: 'db-down', why: pgDown.replace(/^.*?FAIL: /, '').trim() };
      yield say(key, 'waiting', `${key}: worktree setup could not reach the local database, so it stays queued and spawns on the first pass the database answers`);
      return yield skip;
    }
    const answered = pgDown ? ' (the local database check passes, so waiting for it will not clear this)' : '';
    return yield { type: 'park', key, line: `worktree setup failed, not spawned — ${why}${answered}` };
  }
  if (t.db_wait && !s.dry) yield set(key, 'db_wait=null');
  return yield { type: 'start', key, how: 'local', pick, setup };
}

// The lines of setup-worktree.sh's output that say why it failed, else its tail.
export const whyOf = (out) => out.split('\n').filter((l) => /FAIL|WARNING|failed|cannot lock ref/.test(l)).slice(-3).join(' ') || out.slice(-200);
