// The "base gate" step of a pass, as a decision. A feature-mode batch is checked on its base before its
// promotion PR leaves draft: desk/bin/base-gate.mjs, started by the pass in the background because the
// base's suites can outlast one pass, and read back from the queue's `gate` on later passes. It runs on
// a slice: once §3b's slice size of children have merged into the base since the last promotion (and
// since the last gate), once a child labelled `milestone` merges, and once every child has merged, the
// last slice, which the epic close-out follows. A slice gate waits on no other child: a parked or
// failed one is named as not in the slice, and still stops the last. A failed gate runs again whenever
// the base moves. While the gate waits on merges or runs, the batch is not idle.
//
// The decision is a generator (pass/run-phase.mjs runSteps): a read only some cases make (a triage
// label, a PR's state, the base's head) and a write whose result it goes on to use (the queue flush the
// gate's start waits on, the gate's pid) is an action it yields, and what the handler returns is what
// the yield gives back. It starts no process and writes nothing; the handlers that do are pass.mjs's.
//
// The snapshot:
//   queue      the queue as the step starts: its tickets, promotion, gate, base_push_ask and approved
//   alive      the gate recorded as running still has its process
//   baseFix    a base conflict fix worker holds the base worktree, running or about to start
//   conflict   what became of a conflict the gate met ({ line, worker, said }), or null
//   settled    every ticket has settled (batch-state.mjs batchSettled)
//   driverLive a merge driver is running
//   slice      config §3b's promotion slice size
//   base, source, repo   the batch base, the branch it promotes to, and the GitHub repo
//   log        the gate's log file
//   dry        a dry run
//   now        the time, in ms
//
// Actions, beside the shared `report` ({ type, ... }; "->" is what the handler returns):
//   set-batch {fields}     a batch-level queue write (queue.mjs set-batch)
//   out {line}             a line of the pass's report
//   milestone {key}        -> whether the ticket's triage record is labelled milestone
//   pr-state {pr}          -> the PR's state as gh has it, or null unread
//   base-head              -> origin's head of the base, fetched first, or null
//   pr-draft {pr}          -> { state, isDraft } of the PR, or null unread
//   undo-ready {pr}        -> { ok, out } from putting the PR back to draft
//   flush                  -> the queue flush's result: { ok, conflicts }
//   start-gate             -> the pid of the base gate started in the background
//   pending {pending}      the last action: whether the gate keeps the batch from being idle
import { BASE_RED_MS, baseRedWait } from './deadlines.mjs';

export function* decideBaseGate(s) {
  const pending = yield* gate(s);
  yield { type: 'pending', pending };
}

// A gate's slice, in a line.
export const sliceLabel = (sl) => (sl ? `slice ${sl.n}: ${sl.keys.length} of ${sl.of} children${sl.last ? ', the last' : ''}` : null);

function* gate(s) {
  const { queue: qx, base: BASE, source: SOURCE, repo: GH_REPO, log: GATE_LOG } = s;
  const tickets = Object.values(qx.tickets);
  const p = qx.promotion ?? {};
  let g = qx.gate ?? null;
  if (g?.state === 'running') {
    if (s.alive) { yield out(`BASE GATE: running on ${BASE}${g.slice ? ` (${sliceLabel(g.slice)})` : ''} since ${g.started} (pid ${g.pid}); log ${GATE_LOG}`); return true; }
    g = { ...g, state: 'failed', finished: new Date(s.now).toISOString(), failures: [`the gate stopped without a result (pid ${g.pid ?? '?'}): see ${GATE_LOG}`] };
    yield setBatch(`gate=${JSON.stringify(g)}`);
  }
  // The base worktree is a base conflict fix worker's while it runs: the gate waits for it.
  if (s.baseFix) {
    yield out(`BASE GATE: waits on the conflict fix worker on ${BASE}${s.conflict?.line ? `: ${s.conflict.line}` : ''}`);
    return true;
  }

  // This promotion's children: merged into the base since the last promotion PR merged.
  const since = p.since ? Date.parse(p.since) : null;
  const merged = tickets.filter((t) => t.merged_at && (since == null || Date.parse(t.merged_at) > since));
  const covered = new Set(g?.slice?.keys ?? []);
  const uncovered = merged.filter((t) => !covered.has(t.key));
  const milestones = [];
  for (const t of uncovered) if (yield { type: 'milestone', key: t.key }) milestones.push(t);

  // The last slice needs every child merged. A child that finished with no PR, or whose PR was closed
  // unmerged, can never merge: the person decides, and nothing waits on it. One whose PR is still open
  // is waited for.
  const stopped = tickets.filter((t) => ['parked', 'failed'].includes(t.state));
  const stoppedList = stopped.map((t) => `${t.key} (${t.state === 'failed' ? 'failed' : `parked: ${String(t.park?.question ?? '').slice(0, 80)}`})`).join(', ');
  let complete = false;
  let waits = false;
  // The lines on the last slice, said only where the gate does not start. Each is built as it is said,
  // so it reads the gate as the redraft below leaves it.
  const lastLines = [];
  if (s.settled) {
    if (stopped.length) {
      lastLines.push(() => waiting(`BASE GATE: ${g ? 'the last slice is ' : ''}not run, since ${stopped.length} child(ren) did not finish: ${stoppedList}. ` +
        `The base is checked ${g ? 'as a whole ' : ''}once every child has merged into ${BASE}${p.pr && !g?.ready ? `; promotion PR #${p.pr} stays draft` : ''}`));
    } else {
      const state = new Map();
      for (const t of tickets) if (t.result?.pr != null) state.set(t.key, yield { type: 'pr-state', pr: t.result.pr });
      const noPr = tickets.filter((t) => t.result?.pr == null);
      const closed = tickets.filter((t) => t.result?.pr != null && state.get(t.key) === 'CLOSED');
      const open = tickets.filter((t) => t.result?.pr != null && !['MERGED', 'CLOSED'].includes(state.get(t.key)));
      const never = [...noPr.map((t) => `${t.key} (finished with no PR)`), ...closed.map((t) => `${t.key} (PR #${t.result.pr} closed without merging)`)];
      if (never.length) lastLines.push(() => waiting(`BASE GATE: not run, since ${never.join(', ')} cannot merge into ${BASE}: requeue or drop ${never.length > 1 ? 'them' : 'it'}`));
      if (open.length) {
        const list = open.map((t) => `${t.key} (PR #${t.result.pr})`).join(', ');
        lastLines.push(() => s.driverLive ? out(`BASE GATE: waits on ${list} merging into ${BASE}`)
          : waiting(`BASE GATE: waits on ${list} merging into ${BASE}, and no merge driver is running: merge them`));
      }
      complete = !never.length && !open.length;
      waits = open.length > 0 && !never.length;
    }
  }
  const due = complete || uncovered.length >= s.slice || milestones.length > 0;
  if (!g && !due) {
    for (const l of lastLines) yield l();
    if (!lastLines.length) yield out(`BASE GATE: the next slice runs once ${s.slice - uncovered.length} more child(ren) merge into ${BASE} (${uncovered.length} of ${s.slice} so far), a milestone child merges, or the last child merges`);
    return waits;
  }

  const head = yield { type: 'base-head' };
  const moved = !!(g?.sha && head && g.sha !== head);
  // A promotion PR holds whatever has merged into the base, so once a child no gate covered merges, or
  // a gate fails, it is put back to draft until the next slice's gate passes, however it left draft
  // (the gate, or the person). A refused undo is reported and tried again next pass.
  let undoFailed = false;
  if (g && g.pr != null && !g.redrafted && ((g.state === 'passed' && uncovered.length) || g.state === 'failed') && !s.dry) {
    const v = yield { type: 'pr-draft', pr: g.pr };
    const r = !v ? { ok: false, out: 'it could not be read' } : v.state !== 'OPEN' || v.isDraft ? { ok: true } : yield { type: 'undo-ready', pr: g.pr };
    if (r.ok) {
      g = { ...g, ready: false, redrafted: true, note: null };
      yield setBatch(`gate=${JSON.stringify(g)}`);
    } else {
      undoFailed = true;
      yield waiting(`BASE GATE: promotion PR #${g.pr} holds ${g.state === 'failed' ? 'a base whose gate failed' : `${uncovered.map((t) => t.key).join(', ')}, which no gate has covered`}, and could not go back to draft (${r.out.split('\n').pop()}): gh pr ready ${g.pr} --repo ${GH_REPO} --undo. The next pass tries again`);
    }
  }
  const outside = () => (!complete && stopped.length ? [out(`BASE GATE: not in this slice: ${stoppedList}`)] : []);
  // A base sync asked in /desk-needs-you and not yet approved: the gate's own sync would be refused the
  // same way, so it waits for the approval rather than failing into the waiting list each pass.
  if (qx.base_push_ask && qx.approved?.base_push !== true) {
    yield out(`BASE GATE: waits on the base sync, asked once for the batch in /desk-needs-you (its base-push item)`);
    return true;
  }
  if (!g || (moved && (g.state === 'failed' || due))) {
    if (s.dry) { yield out(`BASE GATE (dry run): would start on ${BASE}`); return false; }
    const slice = { n: p.slice ?? 1, keys: merged.map((t) => t.key), of: tickets.length, last: complete };
    yield setBatch(`gate=${JSON.stringify({ state: 'running', pid: null, started: new Date(s.now).toISOString(), sha: head, slice })}`);
    // base-gate.mjs reads the gate's sha from the file as it starts, so the gate is in the file first;
    // refused, no gate starts, and the next pass tries again.
    const gateWrite = yield { type: 'flush' };
    if (!gateWrite.ok || gateWrite.conflicts.some((c) => c.ticket == null && c.field === 'gate')) {
      yield out(`BASE GATE: not started on ${BASE}: its record could not be written to the queue (see the failures above); the next pass tries again`);
      return true;
    }
    const pid = yield { type: 'start-gate' };
    yield setBatch(`gate.pid=${pid}`);
    yield { type: 'flush' };
    const why = complete ? '' : milestones.length ? `, since milestone ${milestones.map((t) => t.key).join(', ')} merged` : `, since ${uncovered.length} children merged since the last ${g ? 'gate' : 'promotion'}`;
    yield out(`BASE GATE: started on ${BASE}${g ? ` again (it moved since the last run, at ${String(g.sha).slice(0, 12)})` : ''} for ${sliceLabel(slice)}${why} (pid ${pid}): merges ${SOURCE} in, then runs every acceptance spec and the repo's Typecheck, Lint and Unit tests there; log ${GATE_LOG}${g?.redrafted ? `. Promotion PR #${g.pr} is back in draft until it passes` : ''}`);
    yield* outside();
    return true;
  }

  const at = `${BASE} at ${String(g.sha ?? '?').slice(0, 12)}${g.slice ? ` (${sliceLabel(g.slice)})` : ''}`;
  if (!complete) { for (const l of lastLines) yield l(); yield* outside(); }
  if (g.state === 'passed') {
    const link = qx.promotion?.url ?? (g.pr != null ? `https://github.com/${GH_REPO}/pull/${g.pr}` : null);
    if (g.pr == null) {
      yield waiting(`BASE GATE: passed on ${at}, but the batch has no promotion PR to mark ready (${qx.promotion?.why ?? 'none was recorded'}): open one from ${BASE} to ${SOURCE}`);
    } else if (g.ready && !undoFailed) {
      yield out(`BASE GATE: passed on ${at}: every acceptance spec, Typecheck, Lint and Unit tests. Promotion PR #${g.pr} is ready for review: ${link} (merging it is yours)`);
    } else if (g.redrafted) {
      yield out(`BASE GATE: passed on ${at}, and ${uncovered.length} child(ren) no gate has covered merged into ${BASE} since, so promotion PR #${g.pr} is in draft until the next slice's gate passes: ${link}`);
    } else if (!undoFailed) {
      yield waiting(`BASE GATE: passed on ${at}, but promotion PR #${g.pr} is still draft: ${g.note ?? 'it was not marked ready'}. ${link}`);
    }
    // The epic's close-out follows the last slice only.
    if (complete) {
      const co = g.close_out;
      yield out(co == null ? `close-out: the epic's criteria could not be read, so check every one per criterion`
        : co.length ? `close-out: check only ${co.join(', ')} per criterion, which no spec covers; every other criterion's spec passed on ${BASE}`
          : `close-out: every criterion has a spec that passed on ${BASE}, so no per-criterion check is needed`);
    }
  } else if (Array.isArray(g.conflict) && s.conflict && !s.conflict.worker) {
    // No fix worker may take the conflict, or its tries are spent: put to the person once, by the base
    // sync where it met it too.
    const line = `BASE GATE: failed on ${at}${g.pr != null && !undoFailed ? `, so promotion PR #${g.pr} stays draft` : ''}: ${s.conflict.line}`;
    yield s.conflict.said ? out(line) : waiting(line);
  } else if (Array.isArray(g.conflict) && s.conflict) {
    yield out(`BASE GATE: failed on ${at}, since ${g.tree_check ? `merging ${SOURCE} fails the merged-tree check on` : `${SOURCE} conflicts with`} ${BASE}: ${s.conflict.line}. The gate runs again once ${BASE} moves`);
    return true;
  } else {
    for (const f of g.failures ?? []) yield waiting(`BASE GATE: ${f}`);
    yield waiting(`BASE GATE: failed on ${at}${g.pr != null && !undoFailed ? `, so promotion PR #${g.pr} stays draft` : ''}. Fix it on ${BASE}: the gate runs again once ${BASE} moves, or now with queue.mjs set-batch gate=null`);
  }
  return waits;
}

// ---- the red base ----------------------------------------------------------
// A red base (base-red.mjs: the merge driver's record of its base failing a §4 Required check) is a
// condition of the batch, kept as the queue's `base_red` { branch, check, since, deadline, merges,
// escalated? } for as long as the spell lasts, and not copied onto the PRs it holds: its line names them,
// and each keeps only its own hold, the checks red at its merge base (fix-tries.mjs againstBase). Its one line is
// said on the pass that first records the spell, and not again; past its deadline it is escalated once
// (pass/deadlines.mjs baseRedWait). It is cleared once the driver reads the base green, and left as it
// is while the base cannot be read: the driver's record gone stale says nothing about the base now.
//
// The snapshot:
//   recorded   the queue's `base_red`, or null
//   red        the driver's live record (base-red.mjs liveBaseRed), or null
//   known      whether the base's state is known: false when the driver's record is there but stale
//   line       the red base's one line for the batch (base-red.mjs batchLine), with `red`
//   repairWait the WAITING ON YOU line for a repair that needs the person (it could not be admitted or
//              dropped, or it merged with the base still red), or null
//   at, dry    the pass's time (ISO), and a dry run
// Actions: set-batch {fields}, notice {line} (the line for the report's RED BASE), and the shared report.
export function decideBaseRed(s) {
  const was = s.recorded ?? null;
  if (!s.red) return was && s.known && !s.dry ? [setBatch('base_red=null')] : [];
  const acts = [];
  const same = was?.branch === s.red.branch && was.since === s.red.since;
  // The checks failing and the merges named are the driver's as it reads them now; the spell's start,
  // deadline and escalation are the batch's own.
  const live = { check: s.red.checks.map((c) => c.name).join(', '), merges: (s.red.merges ?? []).map((m) => ({ pr: m.pr, ticket: m.ticket ?? null })) };
  const rec = same ? { ...was, ...live }
    : { branch: s.red.branch, check: live.check, since: s.red.since, deadline: new Date(Date.parse(s.red.since) + BASE_RED_MS).toISOString(), merges: live.merges };
  if (!same) acts.push({ type: 'notice', line: s.line });
  const { rec: next, line } = baseRedWait(rec, s.at);
  if (line) acts.push(waiting(line));
  // A repair that needs the person is said on every pass after the notice, which already names it.
  if (same && s.repairWait) acts.push(waiting(s.repairWait));
  if (!s.dry && JSON.stringify(next) !== JSON.stringify(was)) acts.unshift(setBatch(`base_red=${JSON.stringify(next)}`));
  return acts;
}

const out = (line) => ({ type: 'out', line });
const waiting = (line) => ({ type: 'report', list: 'waiting', line });
const setBatch = (...fields) => ({ type: 'set-batch', fields });
