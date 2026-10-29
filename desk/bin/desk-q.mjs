#!/usr/bin/env node
// desk-q: every autopilot queue on this computer, from the files alone. It reads the repo configs,
// each repo's queue.json, its orchestrator heartbeats and its triage records. Repos are found on
// disk every run, so a newly set-up repo appears with no change here.
//
//   desk-q [--plain] [--all]             one line per batch: live first, then quiet ones that need you
//   desk-q [--plain] <repo>              that repo's unfinished tickets grouped by state, each group in spawn order
//   desk-q [--plain] <repo> show <KEY>   one ticket in full
//   desk-q ships [<repo>]                the Timeline: a bar per unfinished ticket from when it starts
//                                        to when it ships (`when` too), and in one repo with an epic, a bar
//                                        per epic first; with --plain, one line per ticket, then one per
//                                        epic with children in the queue
//   desk-q <repo> days, desk-q days      By day: the tickets grouped by the day they ship
//   desk-q costs                         every name's charge this month, from the cost cache
//   desk-q costs <repo>                  one repo's (or name's) charge this month by supplier
//   desk-q <repo> up|down|top|bottom <KEY>   move a ticket in the spawn order (queue.mjs move)
//   desk-q <repo> move <KEY> <n>         put it at position n of the unfinished tickets
//   desk-q <repo> workers <n>            the batch's worker count (queue.mjs set-batch), up to the cap
//   desk-q <repo> supervisor [on|off]    the repo's supervisor: its status, or install or uninstall it
//
// A repo is named by its short name or any unique prefix of it, which is its standing batch; a named
// batch (an epic's) has a row of its own and is named `<repo>:<name>`. In a terminal, without --plain,
// the same views open full-screen, with arrow keys, Enter and Esc, ←→, Tab or 1–5 for a place's Queue,
// Timeline, By day and Epics, and Costs on home and on a repo, and clicks on the breadcrumb, the tabs and the rows; piped output gets the plain text.
// The only queue writes are the move and workers commands, each a queue.mjs command against the queue
// of the repo named. The supervisor command runs that repo's supervisor.mjs install, uninstall or
// status, and changes no config row or approval. The one other write is a repo's <state>/eta.jsonl,
// which gains a ticket's first ship estimate the first time a live batch's forecast dates it.
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { expandHome, otherRepoEnv, batchPaths, deskConfigRoot, repoPortClaims, portClashes, repoConfigValue, repoConfigValues, isNone, repoPermission, mergeGrant, mergeDriverHolder, releaseCommand, concurrencyLimits, machineWhy, availableGiB, spawnGate, skillsDir, costsPath } from './desk-env.mjs';
import { isHeld, spinePark, readJsonOrRefuse, describeCrash, batchConcurrency, needsSession } from './batch-state.mjs';
import { RULES } from './machine.mjs';
import { LIVE_MS, lastBeat, liveBeat, machineCap } from './borrow.mjs';
import { lastStage } from './harvest.mjs';
import { listBatches } from './batches.mjs';
import { platform, runBySetting, supervisorAgent, supervisorRun, supervisorState as readSupervisorState, turnOn } from './run-by.mjs';
import { FAILED, evaluateGate, skippedOnly, SKIPPED_ON_DRAFT } from './gate.mjs';
import { FIX_TRIES_MAX, RERUNS_MAX, RERUN_COOLDOWN_S } from './fix-tries.mjs';
import { readHistory, recentHistory, sizeOf, forecast, epicsOf, durations, durationsFor, quantile, when, dayAndTime, nextCheckin, dayAt, calendarDays, HOUR, DAY, RUNS, MIN_HISTORY, WINDOW_DAYS,
  readEstimates, saveEstimates, hitRate, MIN_HITS } from './desk-q-eta.mjs';
import { pacingSetting, usagePace, stateDirs } from './usage-pace.mjs';
import { readUsage, probeDue, probe, usageDir, PROBE_EVERY_MS } from './usage-probe.mjs';
import { limitName } from './usage-limit.mjs';
import { startRefresh, readCache, chargesByName, forCosts, isFull } from './cost-cache.mjs';
import { readCosts, billingUrl, SUPPLIERS } from './costs.mjs';

export { LIVE_MS };
// Each state reads as a glyph and a word, so it holds without colour. The screen draws five, named
// by who moves the ticket next; the rest are reasons inside one of them: an untriaged ticket is
// ready, and one held outside the batch or whose worker stopped needs the user.
const GROUP_OF = { queued: 'ready', stuck: 'needs', failed: 'needs' };
const groupOf = (k) => GROUP_OF[k] ?? k;
// A reason key draws as its group: the same glyph, word and colour (STATE_SGR).
const byGroup = (m) => { for (const k of Object.keys(GROUP_OF)) m[k] = m[groupOf(k)]; return m; };
const LABEL = byGroup({ running: '● running', ready: '○ ready', merging: '▸ merging', waiting: '· waiting', needs: '◆ needs you', done: '✓ done' });
// The five shown states, in the order the Queue groups them.
const SHOWN = ['running', 'ready', 'merging', 'waiting', 'needs'];
const shownOf = (ks) => SHOWN.filter((g) => ks.some((k) => groupOf(k) === g));
// A state column: the longest label, "◆ needs you", and two spaces before the next column.
const STATE_W = 13;

const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
const rpad = (s, n) => { s = String(s ?? ''); return ' '.repeat(Math.max(0, n - s.length)) + s; };
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// A span as "4m", "3h 24m" or, from a day, "3d 4h".
const since = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor(m / 60) % 24}h`;
};
const ago = (ms) => (ms == null ? 'never' : ms < 60000 ? 'just now' : `${since(ms)} ago`);
// A span as `since` writes it, with a zero second unit dropped: "2h 5m", "3h", "1d 1h".
const span = (ms) => since(ms).replace(/ 0[mh]$/, '');
function wrap(s, w) {
  const out = []; let line = '';
  for (const word of String(s ?? '').split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > w) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// A title's leading tag ("autopilot: ", "Your day 7/14: "): its length with the space after it, and
// an id that drops any "n/m" count, so "Your day 7/14" and "Your day 8/14" are one tag.
const tagOf = (s) => {
  const m = /^([^:]{1,28}):\s+/.exec(s ?? '');
  return m ? { len: m[0].length, id: m[1].replace(/\s*\d+\s*\/\s*\d+\s*$/, '').trim().toLowerCase() } : null;
};

// Titles for one list: a tag that starts at least half of them is dropped, because it tells those
// rows apart from nothing. A tag fewer share stays.
export function titler(titles) {
  const n = {};
  for (const s of titles) { const g = tagOf(s); if (g) n[g.id] = (n[g.id] ?? 0) + 1; }
  return (s) => { const g = tagOf(s); return g && n[g.id] >= 2 && n[g.id] * 2 >= titles.length ? s.slice(g.len) : s ?? ''; };
}

// ---- reading ---------------------------------------------------------------------------------

// The state, as a key LABEL draws. `stuck` is held by open Jira blockers outside the batch while the
// plan's question on them is open: nothing in the batch moves it, and once the user confirms it can
// start without them it moves as any other ticket does. A held ticket is waiting when it moves without
// the user and needs them when it does not (holdOf). A done ticket's unmerged PR is merging or needs
// the user (prNeed). A queued ticket has not been triaged yet. `ctx` is the repo's holdContext;
// without one, nothing merges or lets a held ticket start by itself.
export const shownState = (q, t, ctx = NOBODY) => stateOf(q, t, ctx, new Set());
function stateOf(q, t, ctx, seen) {
  if (prRow(t)) return prNeed(q, t, ctx, null).k;
  if (['running', 'done', 'failed'].includes(t.state)) return t.state;
  if (outsideOf(t).length && (t.open_questions ?? 0) > 0) return 'stuck';
  if (isHeld(t)) return heldAsks(t) ? 'needs' : holdOf(q, t, ctx, seen).k;
  if (answeredPark(t, ctx)) return 'waiting';
  if (t.state === 'parked' || (t.open_questions ?? 0) > 0) return 'needs';
  return t.state === 'queued' ? 'queued' : 'ready';
}

const NOBODY = { releases: false, merges: false, reruns: false, live: false, stage: () => null, base: 'main', required: [], advisory: [] };
// A park the person answered through desk-needs-you whose requeue was left to the live session running
// the batch: it waits on that session, not on them, until the requeue clears the park. With passes
// stopped nothing will requeue it, so it needs them again.
const answeredPark = (t, ctx) => t?.state === 'parked' && !!t.park?.answered && ctx?.live === true;
const answeredText = (q) => `answered: waiting for ${q?.batch ? `session ${q.batch}` : 'the batch session'} to requeue it`;
export const keysOf = (s) => String(s ?? '').split('|').filter(Boolean);
// The open Jira blockers outside the batch the last pass recorded.
const outsideOf = (t) => (Array.isArray(t?.outside_blockers) ? t.outside_blockers : []);
// A held ticket with a question of its own: it needs the user for that, whatever its blockers do.
export const heldAsks = (t) => isHeld(t) && (t.open_questions ?? 0) > 0;
const outsideText = (t) => {
  const o = outsideOf(t);
  return o.length === 1 ? `held by ${o[0].key}, outside this batch: start anyway?` : `held by ${o.length} Jira tickets outside: start anyway?`;
};
// A ticket whose worker gave up: why, then what moves it.
const stoppedText = (t) => `worker stopped${t.park?.question ? `: ${t.park.question}` : ''} · requeue it`;
const releaseCmd = (key) => releaseCommand(key, 'node ~/.claude/desk/bin/queue.mjs');

// Who moves a batch on without the user: the merge driver, which alone releases a ticket whose blockers
// merged, running now or started by a supervisor running its passes. The supervisor starts it only
// where config §3, or the batch's approval, lets it merge (mergeGrant), so without that grant only a
// driver already running releases. `stage` is a running ticket's stage label.
function holdContext(r) {
  const driver = mergeDriverHolder(r.stateDir) != null;
  let granted = false;
  try { granted = mergeGrant(r.q, (id) => repoPermission(r.slug, id)).by != null; } catch { /* a grant that cannot be read is none */ }
  const releases = driver || (granted && r.live && (r.q?.supervised === true || r.q?.pass?.by === 'supervisor'));
  const stage = (key) => { const s = rowStage(r.stateDir, r.q.tickets[key], r.last); return s.label ?? s.stage; };
  // The base the pass sends a conflict's fix try against: the batch's own, else the repo's default.
  let base = typeof r.q?.base === 'string' ? r.q.base.trim() : '';
  if (!base) { try { base = String(repoConfigValue(r.slug, 'default-branch') ?? '').trim(); } catch { /* an unreadable row reads as main */ } }
  // What green means here, as the pass's fix tries read it (config §4 Required and Advisory checks).
  const list = (id) => { try { const v = repoConfigValues(r.slug, id); return v && !isNone(v) ? v : []; } catch { return []; } };
  // The merge driver reruns a red check only where §3 ci-rerun is yes, and a fix try waits for those reruns.
  let reruns = false;
  try { reruns = repoPermission(r.slug, 'ci-rerun') === 'yes'; } catch { /* a row that cannot be read is no */ }
  // With passes stopped nothing merges, but a PR the grant covers merges by itself once they resume.
  return { releases, merges: granted && (releases || !r.live), reruns, live: r.live, stage, base: base || 'main', required: list('required-checks'), advisory: list('advisory-checks') };
}

// What a held ticket waits on, as { k, text, act }: `waiting` when it moves without the user, `needs`
// when nothing moves until they act, which `text` names; `act` is the command to run, where one is.
// Behind several blockers, the first that needs the user speaks for the ticket.
export function holdOf(q, t, ctx = NOBODY, seen = new Set()) {
  // Neither the pass nor the merge driver lets a ticket start whose hold names no blocker.
  if (!keysOf(t.held_by).length) return { k: 'needs', text: 'held behind no recorded blocker: let it start', act: releaseCmd(t.key) };
  const open = unmergedBlockers(q, t);
  if (!open.length) {
    if (!keysOf(t.held_by).every((p) => prStatusOf(q.tickets?.[p])?.state === 'MERGED')) return { k: 'waiting', text: 'behind PRs the next pass reads' };
    return ctx.releases ? { k: 'waiting', text: 'starts at the next pass' } : { k: 'needs', text: 'every blocker merged: let it start', act: releaseCmd(t.key) };
  }
  seen.add(t.key);
  const each = open.map((b) => blockerHold(q, t.key, b, ctx, seen));
  seen.delete(t.key);
  return each.find((e) => e.k === 'needs') ?? (each.length === 1 ? each[0] : { k: 'waiting', text: `behind ${each.map((e) => e.name).join(', ')}` });
}

// One unmerged blocker of the held ticket `key`, as holdOf reads it, plus `name`: its PR or its key.
function blockerHold(q, key, b, ctx, seen) {
  const bt = q.tickets?.[b];
  if (!bt) return { k: 'needs', name: b, text: `${b} is not in this queue: let it start`, act: releaseCmd(key) };
  const n = bt.result?.pr;
  if (bt.state === 'done') {
    if (n == null) return { k: 'needs', name: b, text: `${b} finished with no PR: let it start`, act: releaseCmd(key) };
    const ps = prStatusOf(bt), pr = `#${n}`;
    if (ps.state === 'CLOSED') return { k: 'needs', name: pr, text: `${pr} was closed unmerged: let it start`, act: releaseCmd(key) };
    // Its first reason is enough: its page lists the checks. A PR that needs the user is their one
    // thing to do, on its own row, so the ticket behind it waits on it rather than counting twice.
    // `you` marks that wait: it ends only once the user has acted on the PR, so it has no date.
    const m = prNeed(q, bt, ctx, null);
    return m.k === 'needs' ? { k: 'waiting', name: pr, you: true, text: `behind ${pr}, which needs you` } : { k: 'waiting', name: pr, text: `behind ${pr}: ${m.segs[0][0]}` };
  }
  if (bt.state === 'running') return { k: 'waiting', name: b, text: `behind ${b} (running, stage ${ctx.stage(b) ?? '?'})` };
  if (seen.has(b) || holdsReach(q, b, key)) return { k: 'needs', name: b, text: `${b} is held behind this one: let one of them start`, act: releaseCmd(key) };
  const bk = groupOf(stateOf(q, bt, ctx, seen));
  return { k: 'waiting', name: b, text: bk === 'needs' ? `behind ${b}, which needs you` : `behind ${b}` };
}

const segText = (segs) => segs.map((s) => s[0]).join('');
const checksFailed = (n) => `${n} check${n === 1 ? '' : 's'} failed`;
const tryOf = (t) => `try ${(t.fix_tries?.length ?? 0) + 1} of ${FIX_TRIES_MAX}`;

// What a done ticket's unmerged PR needs, as { k, segs }: `merging` while it moves without the user
// (checks running, green where something merges it, a draft the pass is undrafting, a red check or a
// conflict the merge driver and the fix tries take on), `needs` when nothing moves until they act.
// `segs` is WHAT IT NEEDS after the PR number: the reason, then the command. With `now` null, an
// unfinished check's age is left out.
function prNeed(q, t, ctx = NOBODY, now = Date.now()) {
  const ps = prStatusOf(t);
  const needs = (...segs) => ({ k: 'needs', segs }), merging = (...segs) => ({ k: 'merging', segs });
  if (ps.state === 'CLOSED') return needs(['closed unmerged: requeue or drop it', null]);
  // What no fix try can move: a check only an operator fixes, or one still red after both tries.
  if (t.stuck) return needs([t.stuck.why, null]);
  if (ps.isDraft === true) return draftNeed(q, t, needs, merging);
  // The merge driver records a PR under §4 Merge holds and leaves it for a person to merge.
  if (String(t.merge_blocked ?? '').startsWith('merge hold:')) return needs(['merge hold: merge it', null]);
  // With both fix tries made the pass puts it to the person (fixCall), so it is theirs already.
  const triesLeft = (t.fix_tries?.length ?? 0) < FIX_TRIES_MAX;
  if (ps.mergeable === 'CONFLICTING' || ps.mergeState === 'DIRTY') {
    if (!triesLeft) return needs([`still in conflict with ${ctx.base} after ${FIX_TRIES_MAX} fix tries`, FAIL]);
    return merging([`merge conflict with ${ctx.base}`, FAIL], [` · the next pass sends it to a worker, ${tryOf(t)}`, null]);
  }
  const checks = ps.checks ?? [];
  // Red as the fix tries read it (evaluateGate): a failed advisory check holds nothing and gets no worker.
  const gate = evaluateGate(checks, { required: ctx.required ?? [], advisory: ctx.advisory ?? [] });
  const red = [...new Set(gate.failing.map((f) => f.name))];
  if (red.length) {
    // Only the merge driver reruns a red check, where §3 ci-rerun lets it, and a fix try waits for its
    // reruns: without both nothing moves. After both tries the pass records it stuck once the reruns
    // on the new head are spent (t.stuck, above), and until then the driver may still merge it.
    if (!ctx.merges || !ctx.reruns) return needs([checksFailed(red.length), FAIL], [' · fix or re-run it', null]);
    return merging([red.length > 2 ? `${checksFailed(red.length)}: ${red[0]} +${red.length - 1}` : `${red.join(', ')} failed`, FAIL], [` · ${rerunStep(ps, red, triesLeft, now)}`, null]);
  }
  // Not red and nothing running, yet not green: a required check that never reported or was skipped.
  // Nothing reruns or repairs that, so the merge driver never merges it.
  if (checks.length && (gate.state === 'absent' || gate.state === 'fail')) return needs([gate.reasons[0] ?? 'checks not green', FAIL], [' · fix the check or §4 Required checks', null]);
  const advisory = checks.filter(checkFailed).length;
  const done = checks.filter((c) => c.status === 'completed').length;
  if (checks.length && done === checks.length) {
    const all = advisory ? [`${checksFailed(advisory)}, advisory only`, WARN]
      : [checks.length === 1 ? '1 check passed' : `all ${checks.length} checks passed`, GOOD];
    return ctx.merges ? merging(all, [' · merges at the next pass', null]) : needs(all, [' · merge it', null]);
  }
  const progress = checks.length ? [runningCheck(checks, now), [` · ${done} of ${checks.length} done`, null]] : [['no checks reported yet', GREY]];
  return ctx.merges ? merging(...progress) : needs(...progress, [' · merge it once green', null]);
}

// Where the merge driver is with a red PR's reruns, from what the pass read of its files (pr_status
// reruns, per check at this head, and rerun_at, its last): the rerun it is on and when the next is due,
// or that they are spent and a fix try follows. It always names the rerun to come, so the count only
// moves when the driver reruns. With `now` null, a due time is left out.
function rerunStep(ps, red, triesLeft, now) {
  const tried = Math.max(0, ...red.map((n) => Number(ps.reruns?.[n]) || 0));
  if (tried >= RERUNS_MAX) return triesLeft ? 'reruns spent, a worker repairs it next' : 'reruns spent; no fix tries left';
  const due = tried ? Date.parse(ps.rerun_at ?? '') + RERUN_COOLDOWN_S * 1000 : NaN;
  const step = `rerun ${tried + 1} of ${RERUNS_MAX} ${now != null && due > now ? `at ${clock(due)}` : 'next'}`;
  return triesLeft ? step : `${step}; no fix tries left`;
}

// The unfinished check that started first, as [text, colour]: running or queued, and how long; one
// queued NO_RUNNER_MS with no runner reads as waiting for one.
function runningCheck(checks, now) {
  const open = checks.filter((c) => c.status !== 'completed').sort((a, b) => (startedMs(a) ?? Infinity) - (startedMs(b) ?? Infinity));
  const c = open[0], s = startedMs(c), age = s == null || now == null ? '' : `, ${since(Math.max(0, now - s))}`;
  if (!c.runner && s != null && now != null && now - s >= NO_RUNNER_MS) return [`${runnerOf(c.name)}: no runner${age}`, WARN];
  return [`${c.name} ${c.runner ? 'running' : 'queued'}${age}`, null];
}

// A draft PR: merging while the pass takes it out of draft (checks still running, or out of draft at
// its next pass), else what the person has to do first, as the pass recorded it (undraft.mjs).
function draftNeed(q, t, needs, merging) {
  const u = t.undraft;
  if (u?.call === 'rerun' || (u?.call === 'wait' && /^checks re-run/.test(u.why ?? ''))) return merging(['draft', null], [' · cancelled checks re-run, out of draft once green', null]);
  if (u?.call === 'wait') return merging(['draft', null], [` · ${/^checks/.test(u.why ?? '') ? 'checks running' : 'GitHub is still checking for conflicts'}, out of draft once green`, null]);
  if (u?.call === 'ready' || u?.call === 'failed') return merging(['draft', null], [' · out of draft at the next pass', null]);
  if (t.key === q?.spine) return needs(['draft', null], [' · feature spine: approve its specs', null]);
  // A pass from before skippedOnly recorded skipped checks as not green: its checks say otherwise.
  if (u?.call === 'person' && /^its checks are not green/.test(u.why ?? '') && skippedOnly(prStatusOf(t)?.checks)) return needs(['draft', null], [` · ${SKIPPED_ON_DRAFT}: undraft #${t.result.pr}`, null]);
  return needs(['draft', null], [` · ${draftWhy(u)}`, null]);
}

// Why the pass left a PR in draft, short enough for a row, then what to do.
function draftWhy(u) {
  const why = String(u?.why ?? '');
  const dirty = /not clean \(([^)]*)\)/.exec(why);
  if (dirty) {
    const counts = dirty[1].split(/\s+/).filter(Boolean).map((p) => { const [k, v] = p.split('='); return /^p\d$/i.test(k) ? `${v} ${k.toUpperCase()}` : `${v} ${k}`; });
    return `review not clean: ${counts.join(', ')}`;
  }
  if (/Clean review verdict is not set/.test(why)) return 'review verdict unreadable: set §4 Clean review verdict';
  if (/clean and green/.test(why)) return 'clean and green: undraft it';
  if (!u) return 'undraft it once it is reviewed';
  return `${why.replace(/^its? /, '')}: ${u.action ?? 'settle it'}`;
}

// Whether following holds from `from` reaches `key`: a cycle, at any depth, that nothing releases.
function holdsReach(q, from, key, seen = new Set()) {
  if (from === key) return true;
  const ft = q.tickets?.[from];
  if (seen.has(from) || !ft || !isHeld(ft)) return false;
  seen.add(from);
  return unmergedBlockers(q, ft).some((p) => holdsReach(q, p, key, seen));
}

// The PR state the last pass recorded for a done ticket's PR (pr_status), or null when none was read.
// Nothing here calls GitHub.
const prStatusOf = (t) => (t?.state === 'done' && t.result?.pr != null && t.pr_status?.pr === t.result.pr ? t.pr_status : null);
export const landing = (t) => prStatusOf(t)?.state === 'OPEN';
// How long an open PR's head and check results have gone unchanged, as the last pass read it
// (pr_status changed_at), once that is STALL_MS or more; else null. desk-q flags a Merging row that
// is, and the check-in digest lists it (stalledPrs).
export const STALL_MS = 2 * 60 * 60 * 1000;
export const STALL_FOR = span(STALL_MS);
const stalledFor = (t, now) => {
  const ps = prStatusOf(t), at = Date.parse(ps?.changed_at ?? '');
  return ps?.state === 'OPEN' && Number.isFinite(at) && now - at >= STALL_MS ? now - at : null;
};
// A done ticket whose PR the last pass read as open or closed unmerged. One merged, with no PR, or not
// read yet is done, as unmergedBlockers takes it.
const prRow = (t) => !t?.merged_at && ['OPEN', 'CLOSED'].includes(prStatusOf(t)?.state);
// The fix try a requeued ticket is on, until its worker finishes.
const fixOn = (t) => (t.fix && !t.fix.finished && t.state !== 'done' ? t.fix : null);

// A hold's blockers less those done with a PR that is merged. A PR the pass has not read yet is taken
// as merged or about to be; one it recorded open (landing) or closed still holds.
export const unmergedBlockers = (q, t) => String(t.held_by ?? '').split('|').filter(Boolean)
  .filter((p) => { const pt = q.tickets?.[p]; return !(pt?.state === 'done' && pt.result?.pr != null && !['OPEN', 'CLOSED'].includes(prStatusOf(pt)?.state)); });

export function triageOf(stateDir, key) {
  const p = join(stateDir, 'triage', `${key}.json`);
  if (!existsSync(p)) return null;
  try { return readJsonOrRefuse(p, `re-run triage.sh ${key}`); } catch { return { summary: '(triage record unreadable)' }; }
}
// A ticket's lane: the queue's, else its triage record's `tr`.
export const laneOf = (t, tr) => (t.lane && t.lane !== '?' ? t.lane : tr?.lane ?? '?');

// How much of a worker log's end is read for its stage: a log runs to several MB, and a marker
// further back than this is one the last pass has already put on the queue.
export const STAGE_TAIL = 256 * 1024;
const logStages = new Map();

// A file's last `bytes` as text, read at `size` (its length now unless given). Throws with no file.
function tailText(path, bytes, size = statSync(path).size) {
  const n = Math.min(bytes, size), buf = Buffer.alloc(n);
  let fd;
  try { fd = openSync(path, 'r'); readSync(fd, buf, 0, n, size - n); } finally { if (fd != null) closeSync(fd); }
  return buf.toString('utf8');
}

// A worker log's last stage marker (harvest.mjs lastStage), from its last STAGE_TAIL bytes only,
// or null with no log or no marker there. Kept until the log grows, so a refresh rereads nothing.
export function logStage(path) {
  let st;
  try { st = statSync(path); } catch { return null; }
  const hit = logStages.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.s;
  let text;
  try { text = tailText(path, STAGE_TAIL, st.size); } catch { return null; }
  // A read that starts mid-file starts mid-line: that line is not whole, so it is dropped.
  if (st.size > STAGE_TAIL) text = text.slice(text.indexOf('\n') + 1);
  const s = lastStage(text);
  if (logStages.size > 256) logStages.clear();
  logStages.set(path, { size: st.size, mtimeMs: st.mtimeMs, s });
  return s;
}

// A running ticket's stage: its worker's last marker, so it is never behind the worker, else the last
// pass's reading of the queue. `log` says which; `at` is when the worker said it, or the last pass.
function rowStage(stateDir, t, last) {
  const s = t.state === 'running' ? logStage(join(stateDir, 'logs', `${t.key}.log`)) : null;
  return s ? { ...s, log: true } : { stage: t.stage ?? null, label: t.stage ?? null, at: last, log: false };
}

// Every set-up repo's standing batch, with its queue where it has one, each followed by the repo's
// named batches. A queue that will not parse is reported on its batch rather than stopping the rest.
// `id` names the row: the repo's slug for its standing batch, `<slug>:<name>` for a named one, which
// `word` (`<repo>:<name>`) is typed as and `name` shows as `<repo> · <name> (<base>)`. `repo` is the
// repo's own name, which the repo-wide commands (the supervisor) take.
export function loadRepos(now = Date.now()) {
  const claims = repoPortClaims();
  const short = claims.map((c) => c.slug.split('__').slice(1).join('__') || c.slug);
  return claims.flatMap((c, i) => {
    const name = short.filter((n) => n === short[i]).length > 1 ? c.slug.replace('__', '/') : short[i];
    const limits = concurrencyLimits(repoConfigValue(c.slug, 'concurrency'));
    return listBatches(c.slug).map((b) => loadBatch(c, name, b.name, limits, now));
  });
}

function loadBatch(c, repoName, batch, limits, now) {
  const { state: stateDir, queue: queuePath } = batchPaths(c.slug, batch);
  const r = { name: repoName, repo: repoName, word: repoName, id: c.slug, slug: c.slug, batch, claim: c, stateDir, queuePath, cap: limits.cap, q: null, error: null };
  if (existsSync(queuePath)) {
    try { r.q = readJsonOrRefuse(queuePath, 'restore it, or start a new batch there'); } catch (e) { r.error = describeCrash(e); }
  }
  if (batch) {
    const base = typeof r.q?.base === 'string' && r.q.base.trim() ? ` (${r.q.base.trim()})` : '';
    Object.assign(r, { name: `${repoName} · ${batch}${base}`, word: `${repoName}:${batch}`, id: `${c.slug}:${batch}` });
  }
  const beat = lastBeat(stateDir, queuePath);
  r.last = beat?.at ?? null;
  r.next = beat?.next ?? null;
  r.live = liveBeat(beat, now);
  r.ctx = r.q ? holdContext(r) : NOBODY;
  const rows = Object.values(r.q?.tickets ?? {});
  // A row's place is queue.mjs's: its position among the unfinished tickets, where a failed one
  // keeps its slot and has no place.
  let place = 0;
  r.rows = rows.filter((t) => t.state !== 'done').map((t) => ({ t, k: shownState(r.q, t, r.ctx), pos: t.state === 'failed' ? null : ++place, st: rowStage(stateDir, t, r.last) }));
  r.places = place;
  // A done ticket whose PR has not merged has no place and no date: only the Queue shows it.
  r.prs = rows.filter(prRow).map((t) => ({ t, k: shownState(r.q, t, r.ctx), pos: null, pr: true, st: rowStage(stateDir, t, r.last) }));
  r.done = rows.length - r.rows.length - r.prs.length;
  r.workers = r.q ? batchConcurrency(r.q, limits).n : null;
  r.run = r.q ? whoRuns(r) : null;
  r.stall = r.q ? stallOf(r, now) : null;
  return r;
}

// Whether the batch is not yet finished: a ticket not done, or a PR not merged.
const unfinished = (r) => r.rows.length > 0 || r.prs.length > 0;

// Who runs the batch's passes: the supervisor once the batch was handed to it (the queue's
// `supervised`), else a session. `set` is the repo's "Batches run by" row, `unset` that it has none.
// `agent` is 'loaded' or 'off' for a handed-over batch not yet finished, read with one launchctl
// print per refresh, and `exit` the loaded agent's failed last run, when it cannot start. Off macOS
// there is no supervisor, so every batch is a session's.
function whoRuns(r) {
  if (platform() !== 'darwin') return { by: 'session', set: 'session', unset: false, agent: null, exit: null };
  let raw = null;
  try { raw = repoConfigValue(r.slug, 'batches-run-by'); } catch { /* a row that cannot be read is unset */ }
  const by = r.q.supervised === true ? 'supervisor' : 'session';
  const a = by === 'supervisor' && unfinished(r) ? supervisorAgent(r.slug) : null;
  return { by, set: runBySetting(raw).value, unset: !String(raw ?? '').trim(), agent: a ? (a.loaded ? 'loaded' : 'off') : null, exit: a?.exit ?? null };
}

// ---- a batch that has stopped moving -------------------------------------------------------------
// What the pass record (pass.mjs recordPass) and the supervisor's own files say about a batch whose
// passes run but move nothing, or cannot run:
//   noProgress  how long nothing started, merged or was released, once that is NO_PROGRESS_MS or more
//               while the last pass held something it could have started (`held`, its reason)
//   errors      { n, error } once ERROR_STREAK passes in a row have errored
//   sessionToo  a session ran a pass within LIVE_MS of a batch the loaded supervisor runs
//   cannotStart the loaded agent's failed last run, { code, why }, `why` its own log's last line
//   driver      { at, reason }: the merge driver the supervisor started stopped with a failure, or
//               could not start, and none runs now
//   oldCode     which of the supervisor and its running merge driver run older desk code than is installed
const NO_PROGRESS_MS = HOUR;
const ERROR_STREAK = 2;
export const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
// A file's last 4 KB as its non-blank lines, or none with no file.
const tailLines = (p) => { try { return tailText(p, 4096).split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; } };
export const timeOf = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : null; };
function stallOf(r, now) {
  const rec = r.q.pass && typeof r.q.pass === 'object' ? r.q.pass : {};
  const sup = r.run?.by === 'supervisor' ? readJson(join(r.stateDir, 'supervisor.json')) : null;
  const loaded = r.run?.agent === 'loaded';
  // With no progress recorded yet, the batch has had none since its first ticket was added.
  const from = timeOf(rec.progress_at) ?? Math.min(...Object.values(r.q.tickets ?? {}).map((t) => timeOf(t.added_at) ?? Infinity));
  const quiet = r.live && rec.held && Number.isFinite(from) && now - from >= NO_PROGRESS_MS ? now - from : null;
  const session = timeOf(rec.session_at ?? (rec.by === 'session' ? rec.at : null));
  const errors = Number(rec.errors) >= ERROR_STREAK ? { n: Number(rec.errors), error: String(rec.error ?? 'no error recorded') } : null;
  const cannotStart = loaded && r.run.exit ? { ...r.run.exit, why: tailLines(join(r.stateDir, 'supervisor.agent.log')).at(-1) ?? r.run.exit.why } : null;
  const holder = mergeDriverHolder(r.stateDir);
  let driver = null;
  if (sup && holder == null && unfinished(r)) {
    const d = sup.driver;
    let at = null;
    try { at = statSync(join(r.stateDir, 'merge-driver.log')).mtimeMs; } catch { /* no log */ }
    // A retry the supervisor started after a failure keeps its pid recorded once it dies too, so with
    // no driver running, failures alone say it stopped.
    if (d && (d.failures ?? 0) > 0) driver = { at, reason: String(d.reason ?? 'it wrote nothing to its log') };
    else {
      const last = tailLines(join(r.stateDir, 'supervisor.log')).filter((l) => l.includes('merge driver: ')).at(-1) ?? '';
      const m = /merge driver: could not start: (.*)/.exec(last);
      if (m) driver = { at: null, reason: m[1], start: true };
    }
  }
  const c = sup?.code;
  const oldCode = { supervisor: loaded && c?.supervisor?.old_code === true, driver: c?.driver?.old_code === true && holder != null && holder === c.driver.pid };
  return { noProgress: quiet, held: rec.held ?? null, errors, sessionToo: loaded && session != null && now - session < LIVE_MS, cannotStart, driver,
    oldCode: oldCode.supervisor || oldCode.driver ? oldCode : null };
}
// The batch's hold on a usage limit, as the last pass recorded it (pass.mjs usage_hold), in one
// sentence, or null with none. It lifts by itself, so it says what lifts it sooner.
export function usageHoldOf(r) {
  const h = r.q?.usage_hold;
  if (!h || typeof h !== 'object') return null;
  const n = Array.isArray(h.paused) ? h.paused.length : 0;
  return `held on ${limitName(h.type)}${h.resets_at != null ? ` until ${resetsWhen(h.resets_at)}` : ''}: nothing new starts` +
    `${n ? `, and ${n} paused worker${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''}` : ''}. It carries on by itself once the limit lifts`;
}
// A session runs a batch the repo sets to the supervisor: its next batch hands over at Stage 4.
const handsOver = (r) => r.run?.by === 'session' && r.run.set === 'supervisor';
const supervisorOff = (r) => r.run?.agent === 'off';

// How many of the repo's tickets and unmerged PRs are in a shown state.
const count = (r, k) => [...r.rows, ...(r.prs ?? [])].filter((x) => groupOf(x.k) === k).length;
// The repo's tickets and unmerged PRs in Needs you: what its count is, and what /desk-needs-you asks about.
export const needsRows = (r) => [...r.rows, ...(r.prs ?? [])].filter((x) => groupOf(x.k) === 'needs');
const attention = (r) => needsRows(r).length;
const hasBatch = (r) => r.q != null || r.error != null;

// Live batches first, freshest first; then quiet ones with something for the user (a ticket, a
// supervisor to turn back on or that cannot start, failing passes, or an unfinished batch to hand
// over), most first.
export function shownRepos(repos, all) {
  const b = repos.filter(hasBatch);
  const live = b.filter((r) => r.live).sort((a, c) => c.last - a.last);
  const quiet = b.filter((r) => !r.live && (all || r.error || attention(r) > 0 || supervisorOff(r) || r.stall?.cannotStart || r.stall?.errors || (handsOver(r) && unfinished(r))))
    .sort((a, c) => attention(c) - attention(a));
  return [...live, ...quiet];
}

// ---- ship dates --------------------------------------------------------------------------------

const MINUTE = 60_000;
const forecasts = new Map();

// The repo's forecast, or null with no batch. Worked out to the minute and kept, so the screen's
// 2-second reread runs the simulation again only when the queue, the history or the minute changes.
// A batch that is not live (liveBeat: no pass for LIVE_MS, and no next pass recorded that is still to
// come) is `paused` while it still has a ticket autopilot could move: its dates assume passes that are
// not happening, so they are not shown and not saved. With none left it is `idle`: nothing is late,
// the rest is the user's. A live forecast saves each ticket's first estimate (eta.jsonl);
// one dated at the next check-in (c) is a what-if, and saves nothing.
export function forecastOf(r, { now = Date.now(), checkin = false } = {}) {
  if (!r.q) return null;
  const at = Math.floor(now / MINUTE) * MINUTE;
  const history = recentHistory(readHistory(r.stateDir), at);
  const list = (s) => String(s ?? '').split('|').filter(Boolean);
  const ep = epicsOf(r.q.tickets ?? {}, Object.fromEntries(Object.keys(r.q.tickets ?? {}).map((k) => [k, triageOf(r.stateDir, k)])),
    { jira: /^jira\b/i.test(String(repoConfigValue(r.slug, 'tracker') ?? '').trim()) });
  // A ticket held behind a PR that needs the user waits on them, as one held outside the batch does,
  // so it is not run forward; nor is anything held behind it.
  const behindYou = (t) => isHeld(t) && unmergedBlockers(r.q, t).some((b) => blockerHold(r.q, t.key, b, r.ctx, new Set([t.key])).you);
  const rows = r.rows.map(({ t, k, st }) => ({ key: t.key, k: k === 'waiting' && behindYou(t) ? 'stuck' : k, size: sizeOf(r.stateDir, t.key), stage: st.stage, held: list(t.held_by), collides: list(t.collides_with), epic: ep.of[t.key] ?? null }));
  // An epic with nothing left to run has shipped, so it is not run forward.
  const open = Object.fromEntries(Object.values(ep.epics).filter((e) => e.queued || e.missing > 0).map((e) => [e.key, { missing: e.missing }]));
  const id = JSON.stringify([r.id, at, checkin, r.live, r.workers, rows, open, ep.unread, history.map((l) => [l.key, l.size, l.hours])]);
  if (!forecasts.has(id)) {
    if (forecasts.size > 64) forecasts.clear();
    const sizes = Object.fromEntries(rows.map((x) => [x.key, x.size]));
    const left = r.rows.some((x) => AUTOPILOT_STATES.includes(x.k));
    const F = { ...forecast({ rows, workers: r.workers, history, now: at, checkin, epics: open }), d: durations(history), sizes,
      paused: !r.live && left, idle: !r.live && !left, epics: ep.epics, of: ep.of, noEpic: ep.noEpic, unread: ep.unread };
    // A state directory desk-q cannot write to costs the saved estimate, never the screen.
    if (!F.none && r.live && !checkin) try { saveEstimates(r.stateDir, F.T, at); } catch { /* shown, not saved */ }
    forecasts.set(id, F);
  }
  return forecasts.get(id);
}

const SOON = MINUTE;
// The shown states a pass can still move on: anything else waits on the user.
const AUTOPILOT_STATES = ['running', 'ready', 'queued', 'waiting'];
const undatable = (F) => !F || F.none || F.paused || F.idle;
const etaOf = (F, key) => (undatable(F) ? null : F.T[key]);
// With passes stopped there are no dates, but a running worker carries on, so its row says so.
const startsCell = (F, x, now) => {
  if (F && !F.none && F.paused) return x.k === 'running' ? 'running' : '—';
  const e = etaOf(F, x.t.key);
  return !e ? '—' : e.start <= now + SOON ? (x.k === 'running' ? 'running' : 'now') : when(e.start, now);
};
const shipsCell = (F, x, now) => (undatable(F) ? '—' : F.T[x.t.key] ? when(F.T[x.t.key].likely, now) : 'no date');
const noHistory = (r, F) => `No ship estimate: ${r.name} has ${F.count} merged autopilot tickets in its history (the last ${WINDOW_DAYS} days), and estimates need ${MIN_HISTORY}.`;
// A stopped batch has no dates: the forecast assumes passes keep running.
const stoppedNote = (r, now) => (r.last == null ? 'no pass yet, so no dates until passes start' : `passes stopped ${ago(now - r.last)}, so no dates until they resume`);
export { needsSession };
function idleNote(r) {
  const you = attention(r);
  if (!you) return 'Nothing left for autopilot: every ticket is done.';
  const session = r.rows.filter((x) => x.k === 'needs' && needsSession(x.t)).length;
  return `Nothing left for autopilot: ${you} ticket${you === 1 ? ' needs' : 's need'} you`
    + `${session ? ` (${session} need${session === 1 ? 's' : ''} an interactive session)` : ''}.`;
}

// The forecast and hit-rate wording `desk-q ships` and the tabs' forecast line share.
const MERGED = ' merged tickets';
const CHECKIN_DATED = ' · tickets that need your answer dated at the next check-in';
const hitWords = (h) => ` shipped before their could-run-to time (last ${h.n} tickets)`;

// How often the repo's saved first estimates held, for a ships view's header.
function hitLine(r) {
  const h = hitRate(readEstimates(r.stateDir));
  return h.pct == null ? `No hit rate yet: ${h.n} merged ticket${h.n === 1 ? ' has' : 's have'} a saved first estimate, and a rate needs ${MIN_HITS}.`
    : `${h.pct}%${hitWords(h)}`;
}
const typical = (F, key) => quantile(durationsFor(F.d, F.sizes[key]).v, 0.5).toFixed(1);
const listed = (keys) => keys.join(', ');

// The blockers in this queue that the forecast could not date.
const undatedBlockers = (r, F, t) => String(t.held_by ?? '').split('|').filter((b) => r.q.tickets[b] && r.rows.some((y) => y.t.key === b) && !etaOf(F, b));

// Why a ticket has no date, short enough for a row.
function undatedWhy(r, F, x) {
  if (r.workers === 0) return 'workers set to 0: nothing starts';
  // Passes stopped: what each would be doing, without a date.
  if (F.paused && ['ready', 'waiting', 'queued'].includes(x.k)) return detail(r, x);
  if (x.k === 'needs') return isHeld(x.t) && !heldAsks(x.t) ? holdOf(r.q, x.t, r.ctx).text : `needs your answer · ~${typical(F, x.t.key)} h once answered`;
  if (x.k === 'stuck') return outsideText(x.t);
  if (x.k === 'failed') return stoppedText(x.t);
  const b = undatedBlockers(r, F, x.t);
  return b.length ? `after ${listed(b)}, which ${b.length > 1 ? 'have' : 'has'} no date` : '';
}

// When the repo's last dated ticket ships.
function queueDone(r, now, checkin) {
  const F = forecastOf(r, { now, checkin });
  return !F ? '' : F.idle ? 'nothing left' : F.none ? 'no history' : F.paused ? 'passes stopped' : F.clears ? when(F.clears, now) : 'no date yet';
}

// `desk-q ships [<repo>]`: one line per unfinished ticket, the form Claude reads.
export function shipsScreen(repos, slug, { now = Date.now(), checkin = false } = {}) {
  const s = etaScope(repos, slug, { now, checkin });
  if (!s.list.length) return nothingToDate;
  const out = [];
  const table = (r, F) => {
    out.push(`  ${pad('TICKET', 10)}${pad('STATE', STATE_W)}${pad('STARTS', 13)}SHIPS`);
    for (const x of r.rows) {
      out.push(`  ${pad(x.t.key, 10)}${pad(LABEL[x.k], STATE_W)}${pad(startsCell(F, x, now), 13)}${pad(shipsCell(F, x, now), 14)}${etaOf(F, x.t.key) ? '' : undatedWhy(r, F, x)}`.trimEnd());
    }
    if (!r.rows.length) out.push('  No unfinished tickets.');
  };
  for (const { r, F, note, stopped } of s.per) {
    if (out.length) out.push('');
    // Passes stopped: no dates, but the rows still say what is running.
    if (stopped) {
      const [pass, ...more] = passLines(r, now);
      out.push(`${r.name} · ${pass}`, ...more);
      table(r, stopped);
      continue;
    }
    if (note) { out.push(note); continue; }
    out.push(forecastLine(r.name, now, F.count, r.workers, checkin), passLines(r, now)[0], hitLine(r));
    table(r, F);
    out.push(`All done by: ${F.clears ? when(F.clears, now) : 'no ticket has a date yet'}${F.undated ? `, ${F.undated} with no date` : ''}.`);
    const epics = Object.values(F.epics);
    if (epics.length) {
      out.push('', `  ${pad('EPIC', 10)}${pad('TITLE', 32)}${pad('DONE', 7)}${pad('STARTS', 13)}SHIPS`);
      for (const e of epics) out.push(epicLine(r, F, e, now, checkin));
      if (F.noEpic) out.push(`Other work: ${F.noEpic} ticket${F.noEpic === 1 ? '' : 's'} with no epic.`);
    }
    if (F.unread) out.push(unreadLine(F.unread));
  }
  return out.join('\n');
}

// Why an epic has no date: its undated children, by what holds them.
function epicWhy(r, F, e, checkin) {
  if (F.paused) return 'no date while passes are stopped';
  if (r.workers === 0) return 'No date: workers set to 0, so nothing starts';
  const undated = r.rows.filter((x) => F.of[x.t.key] === e.key && !F.T[x.t.key]);
  const c = (k) => undated.filter((x) => x.k === k).length;
  const you = undated.filter((x) => groupOf(x.k) === 'needs').length;
  const why = you ? [`${you} need${you === 1 ? 's' : ''} you`] : [];
  const rest = undated.length - you;
  if (rest) why.push(`${rest} behind those`);
  return `No date: ${why.join(', ')}${c('needs') && !checkin ? ' · c: date them as if answered at the next check-in' : ''}`;
}

// One epic's line: key, title, children done of total, then STARTS and SHIPS, shipped, or why it has no date.
function epicLine(r, F, e, now, checkin) {
  const lead = `  ${pad(e.key, 10)}${pad(cut(e.summary, 30), 32)}${pad(`${e.done}/${e.total}`, 7)}`;
  if (!e.queued && !e.missing) return `${lead}${pad('—', 13)}shipped${e.shipped != null ? ` ${when(e.shipped, now)}` : ''}${e.missing == null ? ' · children not read' : ''}`;
  const d = F.E[e.key];
  if (!d) return `${lead}${pad('—', 13)}${epicWhy(r, F, e, checkin)}`;
  const running = r.rows.some((x) => F.of[x.t.key] === e.key && x.k === 'running');
  const starts = d.start == null ? '—' : d.start <= now + SOON ? (running ? 'running' : 'now') : when(d.start, now);
  return `${lead}${pad(starts, 13)}${pad(when(d.likely, now), 14)}${epicNote(e, d)}`.trimEnd();
}

// A dated epic's note: why it is provisional, else the child that sets its date.
const epicNote = (e, d) => (e.missing == null ? 'provisional: children not read' : e.missing ? `provisional: ${e.missing} not queued` : d.setBy ? `set by ${d.setBy}` : '');

// An epic's name as people say it: its summary up to the first colon or dash, else its key.
const epicShort = (e) => String(e?.summary ?? '').split(/:| — | - /)[0].trim() || e?.summary?.trim() || e?.key || '';
// The epics the forecast runs forward: a child unfinished, or one not queued yet.
// Tickets whose triage record predates epics (epicsOf `unread`): pass.mjs reads them from Jira.
const unreadLine = (n) => `Epics not read yet for ${n} ticket${n === 1 ? '' : 's'}: the next pass reads them from Jira.`;
const openEpics = (F) =>Object.values(F?.epics ?? {}).filter((e) => F.E && e.key in F.E);
// Provisional while some children are not queued, or the list of them could not be read.
const provisional = (e) => e.missing !== 0;
// "started" once a child is done or running.
const epicStarts = (r, F, e, d, now) => (e.done > 0 || r.rows.some((x) => F.of[x.t.key] === e.key && x.k === 'running') ? 'started'
  : d.start == null ? '—' : d.start <= now + SOON ? 'now' : when(d.start, now));
// Whether the epic still has an unfinished ticket in this repo's queue.
const epicIn = (r, F, key) => !!F?.epics?.[key] && r.rows.some((x) => F.of[x.t.key] === key);

// ---- Timeline and By day -----------------------------------------------------------------------

// What z cycles through on the Timeline, auto first.
export const ZOOMS = ['auto', 'hours', 'days', 'weeks'];
// A light terminal theme, from COLORFGBG's background: 7 and 9 to 15 are the light ANSI colours.
export const lightTheme = (v = process.env.COLORFGBG) => { const bg = Number(String(v ?? '').split(';').at(-1)); return bg === 7 || (bg >= 9 && bg <= 15); };
const LIGHT = lightTheme();
// A row's colour, as an SGR code, by its shown state; DIM and BOLD for the rails, group rows,
// headings, labels and secondary detail. Red is for failed checks only.
// Every label is a fixed grey rather than dim (SGR 2), whose shade each terminal picks: 256-colour
// 247 on a dark theme and 240 on a light one, each 4.5:1 or more on the window and the selected row.
const GREY = LIGHT ? '38;5;240' : '38;5;247';
const DIM = GREY, BOLD = '1', FAINT = '2';
// The six state colours. A dark theme draws One Dark's, in 24-bit where the terminal reports
// truecolor and the nearest 256-colour codes elsewhere; red and magenta are One Dark's brighter pair,
// so each is 4.5:1 or more on the window (#282C34) and the selected row. A light theme keeps the
// terminal's own 16.
const TRUECOLOR = ['truecolor', '24bit'].includes(process.env.COLORTERM);
const HUE = LIGHT ? { green: '32', cyan: '36', blue: '34', yellow: '33', magenta: '35', red: '31' }
  : TRUECOLOR ? { green: '38;2;152;195;121', cyan: '38;2;86;182;194', blue: '38;2;97;175;239', yellow: '38;2;229;192;123', magenta: '38;2;208;139;227', red: '38;2;240;124;132' }
    : { green: '38;5;108', cyan: '38;5;73', blue: '38;5;75', yellow: '38;5;180', magenta: '38;5;176', red: '38;5;210' };
const STATE_SGR = byGroup({ running: HUE.green, merging: HUE.cyan, ready: HUE.blue, waiting: HUE.yellow, needs: HUE.magenta });
// The Notices colours: a warning yellow, what needs the user magenta (bold for a count to act on).
// The band, when nothing can run, is bold and reversed on red.
const WARN = HUE.yellow, YOU = HUE.magenta, YOU_BOLD = `1;${HUE.magenta}`, BAND = `1;7;${HUE.red}`;
// A PR number's cyan, and its checks: passed green, failed red.
const PR_SGR = STATE_SGR.merging, GOOD = HUE.green, FAIL = HUE.red;
// A line of coloured runs that is not a row: a heading, a ticket page's line, a legend.
const segLine = (segs) => segRow(null, segs, null);
const bold = (s) => segLine([[s, BOLD]]);
const dim = (s) => segLine([[s, DIM]]);
const dmy = (t) => dayAndTime(t).slice(0, -6);
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The Timeline's scale, from how far away the last could-run-to time is: hours up to 2 days, days
// up to 21, weeks beyond; `zoom` other than auto overrides it. Ticks are labelled local times.
export function scaleFor(dur, now, zoom = 'auto') {
  const id = zoom !== 'auto' ? zoom : dur <= 2 * DAY ? 'hours' : dur <= 21 * DAY ? 'days' : 'weeks';
  const ticks = [];
  let span;
  if (id === 'hours') {
    span = Math.min(48, Math.max(12, Math.ceil(dur / HOUR / 6) * 6)) * HOUR;
    const h0 = Math.ceil((now - dayAt(now, 0)) / (6 * HOUR)) * 6;
    for (let h = h0, t; (t = dayAt(now, 0, h)) < now + span; h += 6) {
      ticks.push({ t, label: new Date(t).getHours() === 0 ? dmy(t).slice(0, 3) : dayAndTime(t).slice(-5) });
    }
  } else if (id === 'days') {
    const days = Math.min(28, Math.max(3, Math.ceil(dur / DAY) + 1));
    span = days * DAY;
    for (let i = 1, t; (t = dayAt(now, i)) < now + span; i++) ticks.push({ t, label: dmy(t).split(' ').slice(0, 2).join(' ') });
  } else {
    const weeks = Math.min(16, Math.max(3, Math.ceil(dur / 7 / DAY) + 1));
    span = weeks * 7 * DAY;
    const monday = (8 - new Date(now).getDay()) % 7 || 7;
    for (let i = monday, t; (t = dayAt(now, i)) < now + span; i += 7) ticks.push({ t, label: dmy(t).split(' ').slice(1).join(' ') });
  }
  return { id, span, ticks };
}

// One row drawn in coloured runs: `segs` is [text, SGR code or null] pairs, `line` their plain text.
// Trailing blanks are trimmed across runs, as a plain row's are.
const segRow = (id, segs, open) => {
  while (segs.length > 1 && !segs.at(-1)[0].trim()) segs.pop();
  const last = segs.at(-1);
  if (last) last[0] = last[0].trimEnd();
  return { id, segs, line: segs.map((s) => s[0]).join(''), open };
};

// The repos a ships view dates: one repo, or every repo with a batch. `per` holds each in order with
// its forecast, or a note saying why it has none; `items` is every unfinished ticket of the dated ones,
// and undated of the paused ones, or with `epic`, of that epic only. `head` is the Queue's header
// then the forecast line; a paused batch's reason and fix are one amber note each in `stopped`, the
// other reasons plain lines in `notes`. With `width`, each line is wrapped to it.
function etaScope(repos, slug, { now, checkin, epic = null, width = null, pinUsage = false }) {
  const list = slug ? repos.filter((r) => r.id === slug) : repos.filter(hasBatch);
  const per = list.map((r) => {
    if (r.error) return { r, note: `${r.name} · queue unreadable: ${r.error}` };
    if (!r.q) return { r, note: `${r.name} · no autopilot batch yet, so nothing to date.` };
    const F = forecastOf(r, { now, checkin });
    if (F.idle) return { r, note: `${r.name} · ${idleNote(r)}` };
    return F.none ? { r, note: `${r.name} · ${noHistory(r, F)}` } : F.paused ? { r, note: `${r.name} · ${stoppedNote(r, now)}.`, stopped: F } : { r, F };
  });
  const fit = (s) => (width == null ? [s] : wrap(s, width));
  const dated = per.filter((p) => p.F);
  const notes = per.filter((p) => p.note && !p.stopped).flatMap((p) => fit(p.note));
  const items = per.filter((p) => p.F || p.stopped).flatMap(({ r, F, stopped }) => {
    const G = F ?? stopped;
    return r.rows.filter((x) => !epic || G.of[x.t.key] === epic).map((x) => ({ r, F: G, x, e: etaOf(G, x.t.key) }));
  });
  // One repo's view adds its hit rate; every repo's leaves it to each repo's own. An epic's names it.
  const ep = epic ? dated[0]?.F.epics[epic] : null;
  const wrapped = (l) => (width == null ? [l] : barWrap(l, width));
  const head = [...tabHead(repos, slug, now, solidBars(width), pinUsage), ...(dated.length ? [forecastSegs(now, dated.reduce((a, d) => a + d.F.count, 0), checkin, ep, slug ? list[0] : null)] : [])].flatMap(wrapped);
  const w = Math.max(12, ...per.map((p) => p.r.name.length + 2));
  const stopped = noteLines(per.filter((p) => p.stopped).map(({ r }) => ({ tag: `▲ ${r.name}`, sgr: WARN, text: [[`${stoppedNote(r, now)}. `, null], [`${resumeLine(r)}.`, BOLD]] })), w, width);
  return { list, per, notes, items, head, stopped };
}

// A ships view's header: the Queue's, one repo's state counts and who runs it, or every repo's
// needs-you and machine lines.
function tabHead(repos, slug, now, solid, pinUsage) {
  if (!slug) return overviewHead(repos, shownRepos(repos, false), { now, solid, pinUsage });
  const r = repos.find((x) => x.id === slug);
  return r?.q ? [countsLine(r), passHead(r, now)[0], ...(pinUsage ? [] : [usageLine(usageOf(repos, now, [r]), { now, solid })])] : [];
}

// A ships view's forecast line, labels grey and figures bright: from when, over how many runs and
// merged tickets, then with one repo, its hit rate.
function forecastSegs(now, count, checkin, ep, r) {
  const h = r ? hitRate(readEstimates(r.stateDir)) : null;
  return segLine([['forecast  ', GREY], ['from ', GREY], [clock(now), null], [' · ', GREY], [RUNS.toLocaleString('en-GB'), BOLD], [' runs over ', GREY], [String(count), BOLD], [MERGED, GREY],
    ...(ep ? [[` · ${ep.key}: `, GREY], [`${ep.done} of ${ep.total}`, BOLD], [' children done', GREY]] : []),
    ...(checkin ? [[CHECKIN_DATED, GREY]] : []),
    ...(!h ? [] : [BAR, ['hit rate  ', GREY], ...(h.pct == null ? [['none yet', null], [`: ${h.n} of the ${MIN_HITS} saved estimates it needs`, GREY]]
      : [[`${h.pct}%`, BOLD], [hitWords(h), GREY]])])]);
}

// A ships view's key line: each entry a list of coloured runs, split by a grey bar. Narrower than the
// line, it breaks between entries, each further line indented under the first; `more` are grey lines
// under it.
function keyLine(entries, width, more = []) {
  const len = (segs) => segs.reduce((a, [s]) => a + s.length, 0);
  const out = [];
  for (const e of entries) {
    const line = out.at(-1);
    if (!line) out.push([['key ', GREY], ['  ', null], ...e]);
    else if (width == null || len(line) + 3 + len(e) <= width) line.push(BAR, ...e);
    else out.push([['      ', null], ...e]);
  }
  return [...out, ...more.map((s) => [['      ', null], [s, GREY]])].map(segLine);
}
// Each shown state's glyph and word in its colour.
const statesKey = (ks) => ks.flatMap((k, i) => [...(i ? [['  ', null]] : []), [LABEL[k], STATE_SGR[k] ?? null]]);
// A bar's could-run-to part, and its swatch: a dimmer shade of the bar's own colour on screen; with no
// colour to tell them apart, as in plain output and under NO_COLOR, ░.
const lateOf = (sgr) => (sgr == null || sgr === BOLD ? FAINT : `2;${sgr}`);
const solidBars = (width) => width != null && !process.env.NO_COLOR;

// `desk-q ships`' first line: the forecast line's runs, the repo's name and workers added.
const forecastLine = (name, now, count, workers, checkin) => `${name} · forecast from ${dayAndTime(now)} · ${RUNS.toLocaleString('en-GB')} runs over ${count}${MERGED}`
  + ` · ${workers} workers${checkin ? CHECKIN_DATED : ''}`;

// A ticket row's key and state, the state in its colour.
const ticketLead = (i, indent) => [[`${indent}${pad(i.x.t.key, 10)}`, null], [pad(LABEL[i.x.k], STATE_W), STATE_SGR[i.x.k]]];
// With passes stopped, a running row has no STARTS column here to say so, so its stage stands in.
const why = (i) => capital(i.F.paused && i.x.k === 'running' ? `stage ${i.x.st.label ?? '?'} · dated again at the next pass` : undatedWhy(i.r, i.F, i.x)) || 'No date yet';
// An undated row's reason in the `cell` columns its dates would take, two of them the gap before the
// title. A longer one borrows up to half of the title's `tw` and is cut beyond that, so the row keeps
// to the width; the ticket screen has it in full. Returns the cell and the title's width left.
const whyCell = (s, cell, tw) => {
  const n = Math.min(Math.max(s.length + 2, cell), cell + Math.floor(tw / 2));
  return [cut(s, n - 2).padEnd(n), tw - (n - cell)];
};
// A ticket opened from an epic's views keeps the epic, so Esc and the breadcrumb lead back to it.
const openTicket = (i, epic = null) => ({ kind: 'ticket', slug: i.r.id, key: i.x.t.key, ...(epic ? { epic } : {}) });
const summaryOf = (i) => triageOf(i.r.stateDir, i.x.t.key)?.summary ?? '';
const nothingToDate = 'No repo here has an autopilot batch, so there is nothing to date.';

// The label columns before a Timeline bar, the STARTS and SHIPS after it (behind its end mark), and
// the gap before TITLE.
const TL_LEAD = 2 + 10 + STATE_W + 1, TL_TAIL = 2 + 13 + 12, TL_GAP = 2, TL_BAR = 64;
// By epic, the name and children-done columns before the bar, and the note after SHIPS.
const EP_NAME = 27, EP_LEAD = 2 + EP_NAME + 5 + 1, EP_NOTE = '  provisional'.length;

// One bar per ticket from STARTS to SHIPS, shaded on to its could-run-to time, sorted by ship time,
// each row ending in its title; every repo's view groups them under a row per repo. `width` null is the plain
// output. The bar and the title share what the row has left, the bar taking at most TL_BAR.
// One repo with an open epic is by feature instead: a bar per epic from its first child's start to its
// last child's ship, then the tickets in no epic under "Other work", each led by its title. `epic` keeps
// to that epic's tickets.
function timelineParts(repos, slug, { now = Date.now(), width = null, checkin = false, zoom = 'auto', epic = null, pinUsage = false } = {}) {
  const s = etaScope(repos, slug, { now, checkin, epic, width, pinUsage });
  if (!s.list.length) return { head: [nothingToDate], rows: [], foot: [] };
  if (!s.items.length && s.notes.length) return { head: [...s.head, ...(s.head.length ? [''] : []), ...s.notes], rows: [], foot: [] };
  const F0 = slug && !epic ? s.per[0]?.F : null;
  const epics = openEpics(F0).map((e) => ({ e, d: F0.E[e.key] })).sort((a, b) => (a.d?.likely ?? Infinity) - (b.d?.likely ?? Infinity));
  const byEpic = epics.length > 0;
  const items = byEpic ? s.items.filter((i) => !i.F.of[i.x.t.key]) : s.items;
  const lead = byEpic ? EP_LEAD : TL_LEAD;
  const spare = width == null ? null : width - lead - TL_TAIL - (byEpic ? EP_NOTE : TL_GAP);
  const cw = width == null ? TL_BAR : Math.max(12, Math.min(TL_BAR, byEpic ? spare : Math.ceil(spare / 2)));
  const tw = width == null ? 60 : Math.max(1, spare - cw);
  const tt = titler(items.map(summaryOf));
  const title = (i) => [`${' '.repeat(TL_GAP)}${cut(tt(summaryOf(i)), tw)}`, null];
  const dated = items.filter((i) => i.e).sort((a, b) => a.e.likely - b.e.likely);
  const undated = items.filter((i) => !i.e);
  const ends = [...dated.map((i) => i.e.late), ...epics.filter((x) => x.d).map((x) => x.d.late)];
  const sc = scaleFor((ends.length ? Math.max(...ends) : now + DAY) - now, now, zoom);
  const col = (t) => Math.floor(((t - now) / sc.span) * cw);
  const rails = new Set();
  if (sc.id === 'hours' || (sc.id === 'days' && sc.span <= 8 * DAY)) for (let c = nextCheckin(now); c != null && c < now + sc.span; c = nextCheckin(c)) rails.add(col(c));
  const lab = Array(cw).fill(' '), tick = Array(cw).fill('─');
  for (const { t, label } of sc.ticks) {
    const c = col(t);
    if (c < 5 || c >= cw) continue;
    tick[c] = '┬';
    if (c + label.length <= cw && lab.slice(Math.max(0, c - 1), c + label.length + 1).every((ch) => ch === ' ')) [...label].forEach((ch, j) => { lab[c + j] = ch; });
  }
  for (const c of rails) if (c >= 0 && c < cw) tick[c] = '▾';
  tick[0] = '├';
  [...'now'].forEach((ch, j) => { lab[j] = ch; });
  const ind = ' '.repeat(lead);
  const solid = solidBars(width);
  const head = [...s.head, '', `Scale: ${sc.id}${zoom === 'auto' ? ' (auto)' : ''}${width == null ? '' : ' · z to change'}`, ''];
  if (s.items.length) head.push(segLine([[`${ind}${lab.join('')}  `, null], [`${pad('STARTS', 13)}${byEpic ? 'SHIPS' : `${pad('SHIPS', 12 + TL_GAP)}TITLE`}`, BOLD]]), `${ind}${tick.join('')}`);
  // Each run of bar glyphs is one segment, so it is coloured once and cut as a whole.
  const bar = (e, sgr) => {
    const a = Math.max(0, col(e.start)), b = Math.max(a, col(e.likely)), c = Math.max(b, col(e.late));
    const out = [];
    for (let j = 0; j < cw; j++) {
      const [ch, k] = j >= a && j <= b ? ['█', sgr] : j > b && j <= c ? (solid ? ['█', lateOf(sgr)] : ['░', sgr]) : [rails.has(j) ? '┆' : ' ', DIM];
      if (out.length && out.at(-1)[1] === k) out.at(-1)[0] += ch; else out.push([ch, k]);
    }
    out.push(c >= cw ? ['▸', sgr] : [' ', null]);
    return out;
  };
  const rows = [];
  if (byEpic) {
    const r = s.per[0].r;
    for (const { e, d } of epics) {
      const name = [[`  ${pad(cut(epicShort(e), EP_NAME - 1), EP_NAME)}`, null], [rpad(`${e.done}/${e.total}`, 5), DIM], [' ', null]];
      const open = { kind: 'epic', slug: r.id, epic: e.key };
      if (!d) { rows.push(segRow(`${r.id}${e.key}`, [...name, [epicWhy(r, F0, e, checkin), whyColour(F0)]], open)); continue; }
      const sgr = provisional(e) ? STATE_SGR.waiting : BOLD;
      rows.push(segRow(`${r.id}${e.key}`, [...name, ...bar({ start: d.start ?? now, likely: d.likely, late: d.late }, sgr),
        [` ${pad(epicStarts(r, F0, e, d, now), 13)}${pad(when(d.likely, now), 12)}`, null], ...(provisional(e) ? [['  provisional', sgr]] : [])], open));
    }
    if (items.length) rows.push(segRow(`${r.id}other`, [['  Other work', BOLD], [` · ${items.length} ticket${items.length === 1 ? '' : 's'} with no epic`, DIM]], null));
  }
  // By epic, a ticket is led by its title and has no TITLE column.
  const tlead = (i) => (byEpic ? [[`    ${pad(cut(tt(summaryOf(i)) || i.x.t.key, 16), 17)}`, null], [pad(LABEL[i.x.k], STATE_W), STATE_SGR[i.x.k]]] : ticketLead(i, '  '));
  const tail = (i) => (byEpic ? [] : [title(i)]);
  for (const r of slug ? s.list : [...new Set(s.items.map((i) => i.r))]) {
    const mine = (list) => list.filter((i) => i.r === r);
    if (!slug) {
      const n = mine(s.items).length;
      rows.push(segRow(`repo ${r.id}`, [[`  ${r.name}`, BOLD], [` · ${n} ticket${n === 1 ? '' : 's'}`, DIM]], { kind: 'timeline', slug: r.id }));
    }
    for (const i of mine(dated)) {
      const sgr = STATE_SGR[i.x.k];
      rows.push(segRow(`${r.id}${i.x.t.key}`, [...tlead(i), [' ', null], ...bar(i.e, sgr), [` ${pad(startsCell(i.F, i.x, now), 13)}${pad(shipsCell(i.F, i.x, now), 12)}`, null], ...tail(i)], openTicket(i, epic)));
    }
    // An undated row's reason takes the bar's and the dates' place, so its title lines up when it fits.
    for (const i of mine(undated)) {
      const [cell, left] = byEpic ? [width == null ? why(i) : cut(why(i), width - 22 - STATE_W), 0] : whyCell(why(i), cw + TL_TAIL + TL_GAP, tw);
      const title = byEpic ? [] : [[cut(tt(summaryOf(i)), left), null]];
      rows.push(segRow(`${r.id}${i.x.t.key}`, [...tlead(i), [' ', null], [cell, STATE_SGR[i.x.k]], ...title], openTicket(i, epic)));
    }
  }
  const foot = [...(s.notes.length ? ['', ...s.notes] : []), ...(s.stopped.length ? ['', ...s.stopped] : [])];
  // One key line: each bar part's swatch in its colour, the check-in rails, then each shown state.
  const shown = shownOf(items.map((i) => i.x.k));
  const late = (sgr) => (solid ? ['█', lateOf(sgr)] : ['░', sgr]);
  const rail = [['┆', DIM], [' check-ins 08:00 and 17:00', null]];
  const dates = 'within a week: day and time; beyond a week, the date';
  if (!s.items.length) foot.push('', 'Nothing unfinished here.');
  else if (byEpic) {
    foot.push('', ...keyLine([[['█', BOLD], [' first child starts to last child ships  ', null], late(BOLD), [' could run to', null]], [['n/m children done', null]],
      [['█', STATE_SGR.waiting], [' provisional epic', null]], rail, ...(shown.length ? [statesKey(shown)] : [])], width, [`enter on an epic shows its tickets · ${dates}`]));
  } else {
    const sgr = STATE_SGR[shown.find((k) => STATE_SGR[k]) ?? 'running'];
    foot.push('', ...keyLine([[['█', sgr], [' starts to ships  ', null], late(sgr), [' could run to (1 run in 5 is later)', null]], rail, ...(shown.length ? [statesKey(shown)] : [])], width, [dates]));
  }
  return { head, rows, foot };
}

// An undated epic's reason: grey while passes are stopped, since nothing there needs the user.
const whyColour = (F) => (F.paused ? GREY : STATE_SGR.needs);

export const timelineScreen = (repos, slug, opts) => joined(timelineParts(repos, slug, opts));

// The day a ship time falls in: today, tomorrow, each day to 6 days out, then the week by its Monday.
export function shipDay(t, now) {
  const d = calendarDays(t, now);
  if (d <= 0) return `Today · ${dmy(t)}`;
  if (d === 1) return `Tomorrow · ${dmy(t)}`;
  if (d < 7) return dmy(t);
  return `Week of ${dmy(dayAt(t, -((new Date(t).getDay() + 6) % 7)))}`;
}

// Tickets grouped by the day they ship, undated ones last under "No date yet", each with its STARTS,
// SHIPS and title; an undated one says why in place of its dates.
function daysParts(repos, slug, { now = Date.now(), width = null, checkin = false, epic = null, pinUsage = false } = {}) {
  const s = etaScope(repos, slug, { now, checkin, epic, width, pinUsage });
  if (!s.list.length) return { head: [nothingToDate], rows: [], foot: [] };
  if (!s.items.length && s.notes.length) return { head: [...s.head, ...(s.head.length ? [''] : []), ...s.notes], rows: [], foot: [] };
  const all = !slug;
  const groups = new Map();
  const add = (g, i) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); };
  for (const i of s.items.filter((y) => y.e).sort((a, b) => a.e.likely - b.e.likely)) add(shipDay(i.e.likely, now), i);
  for (const i of s.items.filter((y) => !y.e)) add('No date yet', i);
  const lead = 4 + (all ? 12 : 0) + 10 + STATE_W + 27;
  const tw = width == null ? 60 : Math.max(1, width - lead);
  const tt = titler(s.items.map(summaryOf));
  const head = [...s.head, ''];
  if (s.items.length) head.push(bold(`    ${all ? pad('', 12) : ''}${pad('TICKET', 10)}${pad('STATE', STATE_W)}${pad('STARTS', 13)}${pad('SHIPS', 14)}TITLE`));
  const rows = [];
  for (const [g, list] of groups) {
    rows.push(segRow(`day ${g}`, [[`  ${g}`, BOLD], [` · ${list.length} ticket${list.length === 1 ? '' : 's'}`, DIM]], null));
    for (const i of list) {
      const [cell, left] = i.e ? [`${pad(startsCell(i.F, i.x, now), 13)}${pad(shipsCell(i.F, i.x, now), 12)}  `, tw] : whyCell(why(i), 27, tw);
      const title = cut(tt(summaryOf(i)), left);
      rows.push(segRow(`${i.r.id}${i.x.t.key}`, [...ticketLead(i, `    ${all ? pad(i.r.name, 12) : ''}`), [cell, i.e ? null : STATE_SGR[i.x.k]], [title, null]], openTicket(i, epic)));
    }
  }
  const foot = [...(s.notes.length ? ['', ...s.notes] : []), ...(s.stopped.length ? ['', ...s.stopped] : [])];
  const shown = shownOf(s.items.map((i) => i.x.k));
  foot.push('', ...(s.items.length ? keyLine([statesKey(shown), [['grouped by ship date: day by day for a week, then week by week', GREY]]], width) : ['Nothing unfinished here.']));
  return { head, rows, foot };
}

export const daysScreen = (repos, slug, opts) => joined(daysParts(repos, slug, opts));

// The Epics view: each open epic, soonest first, with a bar of its children done, queued and not
// queued yet, its SHIPS and the child that sets it. Enter opens the epic.
const EP_BAR = 16;
function epicsParts(repos, slug, { now = Date.now(), checkin = false, width = null, pinUsage = false } = {}) {
  const s = etaScope(repos, slug, { now, checkin, width, pinUsage });
  if (!s.list.length) return { head: [nothingToDate], rows: [], foot: [] };
  const all = !slug;
  // A paused batch's epics are listed undated, under its note.
  const list = s.per.filter((p) => p.F || p.stopped).flatMap(({ r, F, stopped }) => openEpics(F ?? stopped).map((e) => ({ r, F: F ?? stopped, e, d: F ? F.E[e.key] : null })))
    .sort((a, b) => (a.d?.likely ?? Infinity) - (b.d?.likely ?? Infinity));
  const head = [...s.head, ''];
  if (list.length) head.push(bold(`  ${all ? pad('REPO', 12) : ''}${pad('EPIC', 10)}${pad('TITLE', 36)}${pad('CHILDREN', EP_BAR + 7)}  SHIPS`));
  // The children bar is solid on screen, not-yet-queued children grey; with no colour, □ tells them apart.
  const notYet = solidBars(width) ? '■' : '□';
  const rows = list.map(({ r, F, e, d }) => {
    const done = Math.round((e.done / e.total) * EP_BAR);
    const queued = e.queued ? Math.min(EP_BAR - done, Math.max(1, Math.round((e.queued / e.total) * EP_BAR))) : 0;
    const date = d ? [[pad(when(d.likely, now), 14), null], [epicNote(e, d), provisional(e) ? STATE_SGR.waiting : DIM]] : [[epicWhy(r, F, e, checkin), whyColour(F)]];
    const n = `${e.done}/${e.total}`;
    return segRow(`${r.id}${e.key}`, [[`  ${all ? pad(r.name, 12) : ''}${pad(e.key, 10)}${pad(cut(e.summary, 34), 36)}`, null],
      ['■'.repeat(done), STATE_SGR.running], ['■'.repeat(queued), STATE_SGR.waiting], [notYet.repeat(EP_BAR - done - queued), DIM],
      [` ${' '.repeat(Math.max(0, 6 - n.length))}`, null], [String(e.done), BOLD], [`/${e.total}`, DIM], ['  ', null], ...date], { kind: 'epic', slug: r.id, epic: e.key });
  });
  const foot = [...(s.notes.length ? ['', ...s.notes] : []), ...(s.stopped.length ? ['', ...s.stopped] : [])];
  // A record from before epics were recorded is not "no epic": until a pass reads it, say so instead.
  const unread = s.per.reduce((n, p) => n + ((p.F ?? p.stopped)?.unread ?? 0), 0);
  if (unread) foot.push('', unreadLine(unread));
  else if (s.per.some((p) => p.F || p.stopped) && !list.length) foot.push('', 'No queued ticket here belongs to an epic.');
  // Each swatch in the colour its bar uses.
  if (list.length) foot.push('', ...keyLine([[['■', STATE_SGR.running], [' done  ', null], ['■', STATE_SGR.waiting], [' in the queue  ', null], [notYet, DIM],
    [' not queued yet (date is provisional)', null]], [['an epic ships when its last child merges', GREY]]], width));
  return { head, rows, foot };
}

// ---- Costs -------------------------------------------------------------------------------------

export const NO_COST_SOURCES = 'No cost sources set up. /desk-setup costs adds them.';
export const NO_COST_READING = 'No cost reading yet. desk-q reads them in the background.';
const SUPPLIER_LABEL = { github: 'GitHub', vercel: 'Vercel', aws: 'AWS', neon: 'Neon' };
const usd = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// "October, 1–26" while the month runs, "September" once it is read in full.
function monthText(p) {
  const month = new Date(Date.UTC(p.year, p.month - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  return isFull(p) ? month : `${month}, 1–${Number(p.to.slice(8))}`;
}

// A figure not read today: its supplier, the day of its last good reading and how many days back.
const daysAgo = (n) => `${n} day${n === 1 ? '' : 's'} ago`;
const dayMonth = (t) => dmy(t).split(' ').slice(1).join(' ');
function staleReads(x, now) {
  return (x.reads ?? []).filter((r) => r.at != null && calendarDays(r.at, now) < 0)
    .map((r) => ({ ...r, days: -calendarDays(r.at, now), failedToday: r.failedAt != null && r.failedAt > r.at && calendarDays(r.failedAt, now) === 0 }))
    .sort((a, b) => b.days - a.days);
}
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// What a row's figure leaves out, one tag: a bill that can't be read, a figure not read today, use
// AWS credits covered, a name with no repo, CI minutes GitHub discounted in full, a Neon org on the
// free plan.
function costTag(x, { now, suppliersOf, repoless }) {
  if (x.cantRead?.text) return [`◌ ${x.cantRead.text}`, GREY];
  if (x.cantRead) return [`◌ can't read: billed to ${SUPPLIER_LABEL[x.cantRead.supplier]} account ${x.cantRead.account}`, GREY];
  const stale = staleReads(x, now)[0];
  if (stale) return [`◌ ${SUPPLIER_LABEL[stale.supplier]} last read ${dayMonth(stale.at)}, ${daysAgo(stale.days)}`, GREY];
  if (x.credits > 0) return [`▲ credits covered ${usd(x.credits)}`, WARN];
  if (repoless.has(x.name)) return [`${andList(suppliersOf(x.name).map((s) => SUPPLIER_LABEL[s]))} only, no repo in desk`, GREY];
  if (x.free) return ['public, so its CI is free', GREY];
  if (x.freePlan) return ['Neon on the free plan', GREY];
  return null;
}

// The bill `o` opens for a name: its largest supplier's, else the first it is billed by.
function billOf(x, { costs }) {
  const mine = costs.entries.filter((e) => e.name === x.name);
  const top = Object.entries(x.by ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? SUPPLIERS.find((s) => mine.some((e) => e.supplier === s));
  return top ? billingUrl(top, { team: mine.find((e) => e.supplier === top)?.team }) : null;
}

// Every name's charge this month, most first, then shared and the total, under a line with the total
// by supplier. A name the cost sources list with no figure reads –. A row ends in what its figure
// leaves out, the total in how many figures were not read today, and a note under them says each.
function costsParts(repos, { now = Date.now(), costs = readCosts(costsPath()), cache = readCache(), pinUsage = false, width = null } = {}) {
  const foot = pinUsage ? [] : ['', usageLine(usageOf(repos, now, shownRepos(repos, false)), { now })];
  if (!costs.exists || !costs.entries.length) return { head: [NO_COST_SOURCES], rows: [], foot };
  const c = chargesByName({ cache: forCosts(cache, costs), names: [...new Set(costs.entries.map((e) => e.name))] });
  if (!c) return { head: [NO_COST_READING], rows: [], foot };
  const charged = segLine([['charged ', GREY], [usd(c.total), BOLD], [` in ${monthText(c.period)}`, GREY],
    ...c.suppliers.flatMap((s, i) => [i ? [' · ', GREY] : BAR, [`${SUPPLIER_LABEL[s.supplier]} `, GREY], [usd(s.total), BOLD]])]);
  const lines = [...c.names, ...(c.shared == null ? [] : [{ name: 'shared', total: c.shared }])];
  const nw = Math.max(14, ...lines.map((x) => x.name.length + 1));
  const aw = Math.max(10, usd(c.total).length + 3);
  const suppliersOf = (name) => SUPPLIERS.filter((s) => costs.entries.some((e) => e.name === name && e.supplier === s));
  const repoless = new Set(costs.entries.filter((e) => !costs.entries.some((o) => o.name === e.name && o.repo)).map((e) => e.name));
  const sharedTag = c.sharedParts.length ? [c.sharedParts.map((p) => `${SUPPLIER_LABEL[p.supplier]} ${p.label} ${usd(p.total)}`).join(' · '), GREY] : null;
  const rows = lines.map((x) => {
    const tag = x.name === 'shared' ? sharedTag : costTag(x, { now, suppliersOf, repoless });
    const open = x.name === 'shared' ? null : { kind: 'costs', ...costPlace(repos, costs, x.name) };
    const r = segRow(`cost ${x.name}`, [[`  ${pad(x.name, nw)}`, null], x.total == null ? [rpad('–', aw), GREY] : [rpad(usd(x.total), aw), null], ...(tag ? [['  ', null], tag] : [])], open);
    return { ...r, bill: x.name === 'shared' ? null : billOf(x, { costs }) };
  });
  const stale = c.names.filter((x) => x.total != null).flatMap((x) => staleReads(x, now).map((r) => ({ ...r, name: x.name })));
  const most = Math.max(0, ...stale.map((r) => r.days));
  const includes = stale.length ? [['  ', null], [`includes ${stale.length} bill${stale.length === 1 ? '' : 's'} from ${stale.every((r) => r.days === most) ? '' : 'up to '}${daysAgo(most)}`, GREY]] : [];
  const notes = [
    ...(c.credits > 0 ? [{ tag: '▲ credits', sgr: WARN, text: [[`AWS credits are covering ${usd(c.credits)} of use. It becomes a charge when they run out.`, null]] }] : []),
    ...stale.map((r) => ({ tag: `◌ ${r.name}`, sgr: GREY, text: [[r.failedToday
      ? `Its ${SUPPLIER_LABEL[r.supplier]} bill couldn't be read today, so this shows the ${dayMonth(r.at)} figure. desk-q tries again every hour.`
      : `Its ${SUPPLIER_LABEL[r.supplier]} bill hasn't been read yet today, so this shows the ${dayMonth(r.at)} figure.`, null]] })),
  ];
  return { head: [charged, '', bold(`  ${pad('REPO', nw)}${rpad('CHARGED', aw)}`)], rows,
    foot: [segLine([[`  ${pad('total', nw)}`, GREY], [rpad(usd(c.total), aw), BOLD], ...includes]), ...(notes.length ? ['', ...noteLines(notes, nw, width)] : []), ...foot] };
}

export const costsScreen = (repos, opts) => joined(costsParts(repos, opts));

// Where a name's charges open: its repo's place where desk has the repo, else a place of its own.
function costPlace(repos, costs, name) {
  const slug = costs.entries.find((e) => e.name === name && e.repo)?.repo;
  return repos.some((r) => r.id === slug) ? { name, slug } : { name, slug: null };
}
// The name a repo's costs are listed under, or null with none.
const costNameOf = (costs, slug) => costs.entries.find((e) => e.repo === slug)?.name ?? null;
// A cost name, else a repo by its name, for `desk-q costs <word>`.
function costWord(repos, word) {
  const costs = readCosts(costsPath());
  const name = costs.entries.find((e) => e.name.toLowerCase() === word.toLowerCase())?.name;
  if (name) return costPlace(repos, costs, name);
  const r = resolveRepo(repos, word);
  return { name: costNameOf(costs, r.slug), slug: r.id, label: r.repo };
}

export const noCostSourcesFor = (repo) => `No cost sources for ${repo}. /desk-setup costs adds them.`;
// What each supplier bills a name for, one phrase each.
const SUPPLIER_FOR = { github: 'CI minutes', vercel: 'hosting and builds', aws: 'hosting and CI runners', neon: 'Postgres' };
const SUPPLIER_W = 10, FOR_W = 24;

// What a supplier's figure leaves out: a bill that can't be read, a figure not read today, use AWS
// credits covered, CI minutes GitHub discounted in full, a Neon org on the free plan.
function supplierTag(x, s, now) {
  if (x.cantRead?.supplier === s) return [x.cantRead.text ? `◌ ${x.cantRead.text}` : `◌ can't read: billed to account ${x.cantRead.account}`, GREY];
  const stale = staleReads(x, now).find((r) => r.supplier === s);
  if (stale) return [`◌ last read ${dayMonth(stale.at)}, ${daysAgo(stale.days)}`, GREY];
  if (s === 'aws' && x.credits > 0) return ['▲ on credits', WARN];
  if (s === 'github' && x.free) return ['public, so its CI is free', GREY];
  if (s === 'neon' && x.freePlan) return ['free plan', GREY];
  return null;
}

// One name's charge this month by supplier, most first, then the total, under the line with the
// name's total. A supplier the cost sources list with no figure reads –. `label` names the repo when
// it has no cost sources.
function supplierParts(repos, name, { now = Date.now(), costs = readCosts(costsPath()), cache = readCache(), pinUsage = false, width = null, label = name } = {}) {
  const foot = pinUsage ? [] : ['', usageLine(usageOf(repos, now, shownRepos(repos, false)), { now })];
  const mine = costs.entries.filter((e) => e.name === name);
  if (!mine.length) return { head: [noCostSourcesFor(label)], rows: [], foot };
  const c = chargesByName({ cache: forCosts(cache, costs), names: [name] });
  if (!c) return { head: [NO_COST_READING], rows: [], foot };
  const x = c.names.find((n) => n.name === name);
  const money = (n) => (n == null ? '–' : usd(n));
  const aw = Math.max(11, money(x.total).length + 3);
  const list = SUPPLIERS.filter((s) => mine.some((e) => e.supplier === s)).map((s) => ({ s, total: x.by[s] ?? null }))
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  const rows = list.map(({ s, total }) => {
    const tag = supplierTag(x, s, now);
    const r = segRow(`supplier ${SUPPLIER_LABEL[s]}`, [[`  ${pad(SUPPLIER_LABEL[s], SUPPLIER_W)}${pad(SUPPLIER_FOR[s], FOR_W)}`, null],
      [rpad(money(total), aw), total == null ? GREY : null], ...(tag ? [['  ', null], tag] : [])], null);
    return { ...r, bill: billingUrl(s, { team: mine.find((e) => e.supplier === s)?.team }) };
  });
  const charged = segLine([['charged ', GREY], [money(x.total), BOLD], [` to ${name} in ${monthText(c.period)}`, GREY]]);
  const notes = x.credits > 0 ? [{ tag: '▲ credits', sgr: WARN, text: [[`AWS credits covered ${usd(x.credits)}. Without them, ${name} would have been charged ${
    usd((Math.round((x.total ?? 0) * 100) + Math.round(x.credits * 100)) / 100)}.`, null]] }] : [];
  return { head: [charged, '', bold(`  ${pad('SUPPLIER', SUPPLIER_W)}${pad('FOR', FOR_W)}${rpad('CHARGED', aw)}`)], rows,
    foot: [segLine([[`  ${pad('total', SUPPLIER_W + FOR_W)}`, GREY], [rpad(money(x.total), aw), BOLD]]), ...(notes.length ? ['', ...noteLines(notes, 14, width)] : []), ...foot] };
}

export const supplierScreen = (repos, name, opts) => joined(supplierParts(repos, name, opts));

// The screens' header note on tickets that need the user's answer.
const parkedBadge = (checkin) => (checkin ? 'Tickets that need your answer dated at the next check-in · c to undo'
  : 'Tickets that need your answer have no date · c: date them as if answered at the next check-in');

// ---- screens ---------------------------------------------------------------------------------

// The memory one worker takes at its heaviest: the profile writes it into the cap's reason
// (machine.mjs propose), else the rule the profile is sized by.
function workerGB() {
  const m = /(\d+(?:\.\d+)?) GB per worker/.exec(machineWhy('autopilot-concurrency') ?? '');
  return m ? Number(m[1]) : RULES.workerHeavyGB;
}

// Each pass gates on its own repo's §3b "Spawn gate", so the machine's is the highest of them.
const gateGiB = (repos) => Math.max(...repos.map((r) => spawnGate(repoConfigValue(r.slug, 'spawn-gate')).start), spawnGate(null).start);

// LAST PASS: who runs the batch while passes run on time, "● supervisor · 4m ago" or "● session ·
// 4m ago" in green, amber when a session runs a batch the repo sets to the supervisor; red at once
// when the batch was handed to a supervisor that is not loaded; stopped, how long since the last
// pass, yellow under a day and red beyond. Live but not moving, in amber: a session running passes
// beside the supervisor, or passes that held everything for NO_PROGRESS_MS.
const LAST_W = 26;
// ALL DONE BY fits "passes stopped".
const QD_W = 14;
function lastPass(r, now) {
  const age = r.last == null ? null : now - r.last;
  if (supervisorOff(r)) return [`✕ supervisor off${age == null ? '' : ` · ${since(age)}`}`, FAIL];
  if (r.live && r.stall?.sessionToo) return ['▲ supervisor + session', WARN];
  if (r.live && r.stall?.noProgress != null) return [`▲ no progress ${since(r.stall.noProgress)}`, WARN];
  if (r.live) return [`${handsOver(r) ? '▲' : '●'} ${r.run?.by ?? 'session'} · ${ago(age)}`, handsOver(r) ? WARN : STATE_SGR.running];
  if (r.last == null) return ['■ never', WARN];
  return [`■ stopped · ${since(age)}`, age >= DAY ? FAIL : WARN];
}

const allowedBy = (r) => Math.min(r.workers, r.cap);
const liveAllowed = (repos) => repos.filter((r) => r.live && r.q).reduce((a, r) => a + allowedBy(r), 0);

// How many more workers this machine could start: the smaller of the machine cap less the running
// workers, and the free memory above the spawn gate at `perWorker` GB each.
export function headroom({ running, cap, avail, gate, perWorker }) {
  const byMemory = Math.max(0, Math.floor((avail - gate) / perWorker));
  return cap == null ? byMemory : Math.max(0, Math.min(cap - running, byMemory));
}

// Ready tickets beyond the batch's free slots: they start only as its running workers finish.
const unslotted = (r) => r.rows.filter((x) => x.k === 'ready').length - Math.max(0, r.workers - count(r, 'running'));

// Each screen is built as head lines, selectable rows and foot lines. The plain output joins them;
// the interactive screen draws the rows with a selection and opens a row's `open` view on Enter.
// A head or foot line is a string, or a line of coloured runs (segLine) printed as its plain text.
const textOf = (l) => (typeof l === 'string' ? l : l.line);
const joined = (s) => [...s.head, ...s.rows, ...s.foot].map(textOf).join('\n');

// Header segments are split by a grey bar.
const BAR = [' │ ', GREY];
// "◆ 3 tickets need you", bold magenta, or grey when none do.
const needsYou = (you) => (you ? [`◆ ${you} ticket${you === 1 ? ' needs' : 's need'} you`, YOU_BOLD] : ['◆ nothing needs you', GREY]);

// The overview's first line: how many tickets need the user, then each repo's share, most first;
// labels grey, figures bright. The count is followed by how long the oldest question has waited,
// from when it parked, else from when it was added.
function needsLine(list, now) {
  const ok = list.filter((r) => !r.error);
  const you = ok.reduce((a, r) => a + count(r, 'needs'), 0);
  const per = ok.filter((r) => count(r, 'needs')).sort((a, c) => count(c, 'needs') - count(a, 'needs'))
    .flatMap((r, i) => [...(i ? [[' · ', GREY]] : []), [`${r.name} `, GREY], [String(count(r, 'needs')), BOLD]]);
  const waited = ok.flatMap((r) => r.rows.filter((x) => x.k === 'needs').map((x) => timeOf(x.t.park?.since ?? x.t.added_at))).filter((t) => t != null);
  const oldest = waited.length ? [['  oldest ', GREY], [since(Math.max(0, now - Math.min(...waited))), null]] : [];
  return segLine([needsYou(you), ...(you ? [...oldest, BAR, ...per] : [])]);
}

// The overview's second line: workers running, the machine cap and the room it leaves, free memory.
function machineLine(running, cap, room, avail) {
  return segLine([[`● ${running} worker${running === 1 ? '' : 's'} running`, running ? STATE_SGR.running : GREY], BAR,
    ...(cap == null ? [['no machine cap (/desk-setup writes a machine profile)', GREY]] : [['machine cap ', GREY], [String(cap), BOLD]]),
    [' · ', GREY], ['room for ', GREY], [`${room} more`, BOLD], BAR, [`${avail.toFixed(1)} GiB`, BOLD], [' free', GREY]]);
}

// The usage reading every header shows: the newest of both windows, how many workers run in every
// repo here, and which of the `shown` repos weekly pace holds new workers in (usage-pace.mjs, each
// repo by its own §3b row, so a repo set to off is never held). A pass reads the same worker logs and
// probe output (newestUsage), so the hold is judged on the 7-day figure shown.
export function usageOf(repos, now, shown = repos) {
  const reading = readUsage({ dirs: stateDirs({ self: usageDir() }), now });
  const pace = (r) => usagePace({ setting: pacingSetting(repoConfigValue(r.slug, 'usage-pacing')), usage: reading.seven_day, now });
  const heldBy = shown.filter((r) => r.q && !r.error && ((p) => p.hold && !p.bad)(pace(r))).map((r) => r.name);
  return { reading, running: repos.reduce((a, r) => a + count(r, 'running'), 0), held: heldBy.length > 0, heldBy };
}

// The usage line: a bar for the 5-hour and the 7-day window, each with its reset time; green under
// 60%, amber to 84% or for a 7-day window while weekly pace holds new workers, red from 85%. A window
// whose reset has passed reads 0% without a call. With no worker running, a reading over
// PROBE_EVERY_MS old carries its time. On screen the bars are solid, the unused part in TRACK; in plain
// text and under NO_COLOR it is ·.
const USAGE_BAR = 10;
// The unused part of a bar, a graphic rather than text: 256-colour 239, or 250 on a light theme.
const TRACK = LIGHT ? '38;5;250' : '38;5;239';
export const PACE_NOTE = '▲ ahead of pace: no new workers until it slows';
// The note names the repos it holds: "▲ pranicuk ahead of pace: …".
const paceNote = (heldBy) => (heldBy?.length ? PACE_NOTE.replace('▲ ', `▲ ${heldBy.join(', ')} `) : PACE_NOTE);
const usageSgr = (pct, held) => (pct >= 85 ? FAIL : pct >= 60 || held ? WARN : GOOD);
const resetText = (t, now) => (calendarDays(t, now) === 0 ? clock(t) : `${new Date(t).toLocaleDateString('en-GB', { weekday: 'short' })} ${clock(t)}`);
function windowSegs(label, w, now, held, solid) {
  if (!w) return [[`${label} no reading`, GREY]];
  const t = w.resetsAt * 1000, reset = t <= now;
  const pct = reset ? 0 : Math.round(w.utilization * 100);
  const used = Math.min(USAGE_BAR, Math.round((pct * USAGE_BAR) / 100));
  const sgr = usageSgr(pct, held && !reset);
  return [[`${label} `, GREY], ['█'.repeat(used), sgr], [(solid ? '█' : '·').repeat(USAGE_BAR - used), solid ? TRACK : GREY], [` ${pct}%`, sgr],
    [reset ? ` · reset ${clock(t)}` : ` ${resetText(t, now)}`, null]];
}
export function usageLine({ reading, running, held, heldBy }, { now, solid = false }) {
  if (reading.at == null) return segLine([['Claude usage  no reading yet', GREY]]);
  const segs = [['Claude usage  ', GREY], ...windowSegs('5h', reading.five_hour, now, false, solid), [' · ', GREY], ...windowSegs('7d', reading.seven_day, now, held, solid)];
  if (running === 0 && now - reading.at > PROBE_EVERY_MS) segs.push([`  as of ${clock(reading.at)}`, GREY]);
  if (held) segs.push([`  ${paceNote(heldBy)}`, WARN]);
  return segLine(segs.filter(([s]) => s));
}

// The red bands, one for each reason no pass can run: a batch handed to a supervisor that is not
// loaded, a loaded one that cannot start, or passes that keep failing.
const band = (text) => segLine([[` ✕ ${text}`, BAND]]);
const bandsOf = (r) => [
  ...(supervisorOff(r) ? [band(`${r.name}: the supervisor is off, so no passes run. Run: desk-q ${r.repo} supervisor on`)] : []),
  ...(r.stall?.cannotStart ? [band(`${r.name}: the supervisor cannot start (exit ${r.stall.cannotStart.code}): ${r.stall.cannotStart.why ?? 'it logged nothing'}`)] : []),
  ...(r.stall?.errors ? [band(`${r.name}: the last ${r.stall.errors.n} passes errored: ${r.stall.errors.error}`)] : []),
];

// The amber notes for a batch that runs but does not move, each with its fix where there is one.
function stallNotes(r) {
  const s = r.stall, tag = `▲ ${r.name}`;
  if (!s) return [];
  const note = (text, fix) => ({ tag, sgr: WARN, text: [[text, null], ...(fix ? [[fix, BOLD]] : [])] });
  const out = [];
  const u = usageHoldOf(r);
  if (u) out.push(note(`${u}. `, 'Switch subscription to lift it sooner.'));
  if (s.noProgress != null && !u) out.push(note(`nothing started or merged for ${since(s.noProgress)}. Last pass: ${s.held}.`));
  if (s.sessionToo) out.push(note('a session is also running this supervised batch. Close the session, or run: ', `desk-q ${r.repo} supervisor off`));
  if (s.driver) {
    const what = s.driver.start ? 'the merge driver could not start' : `the merge driver stopped${s.driver.at == null ? '' : ` at ${clock(s.driver.at)}`}`;
    const reason = s.driver.reason.replace(/^FAIL:\s*/, '').replace(/\.$/, '');
    const fix = /signed out/i.test(reason) ? 'Run gh auth login.' : null;
    out.push(note(`${what}: ${reason}.${fix ? ' ' : ''}`, fix));
  }
  if (s.oldCode) {
    const who = s.oldCode.supervisor && s.oldCode.driver ? 'the supervisor and its merge driver run' : s.oldCode.supervisor ? 'the supervisor runs' : 'the merge driver runs';
    out.push(note(`${who} old desk code. `, 'Run ./install.sh in desk-skills.'));
  }
  return out;
}

// The overview's notes, one per line under a grey "note": a glyph and what it names in its colour,
// then the text.
// With `width`, a note's text wraps between words, each further line indented under its first.
function noteLines(notes, w, width = null) {
  const lead = 4 + 2 + w + 1;
  return notes.flatMap((n, i) => (width == null ? [n.text] : wrapSegs(n.text, Math.max(12, width - lead))).map((text, j) =>
    segLine(j ? [[' '.repeat(lead), null], ...text] : [[i ? '    ' : 'note', GREY], ['  ', null], [pad(n.tag, w + 1), n.sgr], ...text])));
}

// Coloured runs broken between words into lines of at most `w` columns, each word keeping its run's colour.
function wrapSegs(segs, w) {
  const out = [[]];
  let len = 0;
  for (const [s, k] of segs) {
    for (const word of s.split(/(?<= )/)) {
      if (len && len + word.trimEnd().length > w) { out.push([]); len = 0; }
      if (!len && !word.trim()) continue;
      const line = out.at(-1);
      if (line.length && line.at(-1)[1] === k) line.at(-1)[0] += word; else line.push([word, k]);
      len += word.length;
    }
  }
  return out;
}

// The note for a session-run batch the repo sets to the supervisor: running, its next batch hands
// over; stopped, how to resume it, which hands it over.
function handOverNote(r) {
  const text = r.live ? 'set to the supervisor, but a session runs this batch. Its next batch hands over.'
    : `${r.last == null ? 'no pass yet' : 'passes stopped'}. To resume: run /desk-autopilot in ${r.name}; it hands the batch to the supervisor at Stage 4.`;
  return { tag: `▲ ${r.name}`, sgr: WARN, text: [[text, null]] };
}

const needsYouSkill = () => existsSync(join(skillsDir(), 'desk-needs-you', 'SKILL.md'));

// Every repo's header: a band for each batch no pass can run, what needs the user, the machine, then
// usage.
function overviewHead(repos, list, { now = Date.now(), solid = false, avail = availableGiB(), cap = machineCap(), gate = gateGiB(repos), perWorker = workerGB(), pinUsage = false } = {}) {
  const running = repos.reduce((a, r) => a + count(r, 'running'), 0);
  return [...list.flatMap(bandsOf), needsLine(list, now), machineLine(running, cap, headroom({ running, cap, avail, gate, perWorker }), avail),
    ...(pinUsage ? [] : [usageLine(usageOf(repos, now, list), { now, solid })])];
}

// Home's table, widest first. With a `width` it sheds what it can until a row fits: the "ready with
// no free slot" count moves into the notes, LAST PASS and ALL DONE BY narrow to their longest cells,
// then DONE goes, then MERGING, whose counts move into the notes. DONE counts merged tickets only.
const NUM_COLS = [['RUN', 'running', 4], ['READY', 'ready', 7], ['MERGING', 'merging', 9], ['WAIT', 'waiting', 6], ['NEEDS YOU', 'needs', 11], ['DONE', 'done', 6]];
function homeLayout(list, w, width, now, checkin) {
  const ok = list.filter((r) => !r.error);
  // A repo's batches share its cap: the first of them on screen shows it, the rest say they share it.
  const capOf = (r) => { const in1 = ok.filter((x) => x.slug === r.slug); return in1.length < 2 ? `cap ${r.cap}` : in1[0] === r ? `cap ${r.cap}, shared` : 'cap shared'; };
  const workers = (r, slot) => `  ${r.workers} (${capOf(r)})${slot && unslotted(r) > 0 ? ` · ${unslotted(r)} ready with no free slot` : ''}`;
  const lastFit = Math.max(24, ...ok.map((r) => lastPass(r, now)[0].length + 2)), qdFit = Math.max(12, ...ok.map((r) => queueDone(r, now, checkin).length));
  const wide = { lastW: LAST_W, qdW: QD_W, drop: [] }, fit = { lastW: lastFit, qdW: qdFit, slot: false };
  const steps = [{ ...wide, slot: true }, { ...wide, slot: false }, { ...fit, drop: [] }, { ...fit, drop: ['DONE'] }, { ...fit, drop: ['DONE', 'MERGING'] }];
  const span = (l) => 2 + w + l.lastW + NUM_COLS.filter(([h]) => !l.drop.includes(h)).reduce((a, c) => a + c[2], 0) + 2 + l.qdW;
  const fits = (l) => span(l) + Math.max(9, ...ok.map((r) => workers(r, l.slot).length)) <= width;
  const l = width == null ? steps[0] : steps.find(fits) ?? steps.at(-1);
  return { ...l, cols: NUM_COLS.filter(([h]) => !l.drop.includes(h)), workers: (r) => workers(r, l.slot) };
}

function overviewParts(repos, { all = false, now = Date.now(), avail = availableGiB(), cap = machineCap(), gate = gateGiB(repos), perWorker = workerGB(), interactive = false, checkin = false, width = null, badge = '', pinUsage = false } = {}) {
  const list = shownRepos(repos, all);
  const none = repos.filter((r) => !repos.some((x) => x.slug === r.slug && hasBatch(x)));
  // REPO fits the names with a row; with a width, only those on screen.
  const w = Math.max(14, ...(width == null ? repos : [...list, ...(all ? none : [])]).map((r) => r.name.length + 2));
  const lay = homeLayout(list, w, width, now, checkin);
  const head = [
    ...overviewHead(repos, list, { now, solid: interactive && !process.env.NO_COLOR, avail, cap, gate, perWorker, pinUsage }),
    '',
    bold(`  ${pad('REPO', w)}${pad('LAST PASS', lay.lastW)}${lay.cols.map(([h, , cw]) => rpad(h, cw)).join('')}  ${pad('ALL DONE BY', lay.qdW)}  WORKERS`),
  ];
  const rows = [], foot = [];
  const row = (r, line) => rows.push({ id: r.id, line, open: { kind: 'repo', slug: r.id } });
  for (const r of list) {
    if (r.error) { row(r, `  ${pad(r.name, w)}queue unreadable: ${r.error}`); continue; }
    const [last, lastSgr] = lastPass(r, now);
    // Each state count in its state's colour, a zero dim; DONE in the text colour.
    const n = ([, k, cw]) => { const c = k === 'done' ? r.done : count(r, k); return [rpad(c, cw), c ? (k === 'done' ? null : STATE_SGR[k]) : DIM]; };
    const qd = queueDone(r, now, checkin);
    rows.push(segRow(r.id, [[`  ${pad(r.name, w)}`, null], [pad(last, lay.lastW), lastSgr], ...lay.cols.map(n),
      ['  ', null], [pad(qd, lay.qdW), ['passes stopped', 'no history'].includes(qd) ? DIM : null], [lay.workers(r), null]], { kind: 'repo', slug: r.id }));
  }
  if (all) for (const r of none) row(r, `  ${pad(r.name, w)}${pad('no batch', lay.lastW + lay.cols.reduce((a, c) => a + c[2], 0) + 2 + lay.qdW)}  cap ${r.cap}`);
  if (!list.length && !(all && none.length)) foot.push('  No batch is live, and no quiet batch needs you.');
  if (!all && none.length) {
    const more = `${none.length} more set up with no batch: ${none.map((r) => r.name).join(', ')}. ${interactive ? 'Press a to list them.' : 'desk-q --all lists them.'}`;
    foot.push('', ...(width == null ? [[[more, DIM]]] : wrapSegs([[more, DIM]], Math.max(12, width - 2))).map((segs) => segLine([['  ', null], ...segs])));
  }
  const notes = [...list.filter((r) => !r.error).flatMap(stallNotes), ...list.filter((r) => !r.error && handsOver(r) && (r.live || unfinished(r))).map(handOverNote)];
  const seen = new Set();
  // Ports are claimed per repo, so each repo is checked once, as its standing batch.
  const standing = repos.filter((r) => !r.batch);
  for (const r of standing) {
    for (const c of portClashes(r.claim, standing.map((x) => x.claim))) {
      const o = standing.find((x) => x.slug === c.slug);
      const pair = [r.name, o.name].sort();
      if (seen.has(pair.join())) continue;
      seen.add(pair.join());
      notes.push({ tag: '▲ ports', sgr: WARN, text: [[`${pair.join(' + ')} share ${Math.max(r.claim.port, c.port)}–${Math.min(r.claim.last, c.last)}. Two batches there at once can get the same worker port.`, null]] });
    }
  }
  // What a narrow table left out: merging counts, in cyan, then ready tickets with no free slot.
  const ok = list.filter((r) => !r.error);
  if (lay.drop.includes('MERGING')) {
    for (const r of ok.filter((x) => count(x, 'merging'))) {
      const m = count(r, 'merging');
      notes.push({ tag: `▸ ${r.name}`, sgr: STATE_SGR.merging, text: [[`${m} PR${m === 1 ? '' : 's'} merging. Its screen lists ${m === 1 ? 'it' : 'them'}.`, null]] });
    }
  }
  if (!lay.slot) for (const r of ok.filter((x) => unslotted(x) > 0)) notes.push({ tag: `  ${r.name}`, sgr: GREY, text: [[`${unslotted(r)} ready with no free slot: ${unslotted(r) === 1 ? 'it starts' : 'they start'} as its running workers finish.`, null]] });
  const you = list.filter((r) => !r.error).reduce((a, r) => a + count(r, 'needs'), 0);
  if (you && needsYouSkill()) notes.push({ tag: '◆ needs you', sgr: YOU, text: [['/desk-needs-you', BOLD], [`, in a Claude session, asks you about ${you === 1 ? 'the 1 ticket' : `all ${you}`}.`, null]] });
  const unset = new Set(repos.filter((r) => r.run?.unset).map((r) => r.slug)).size;
  if (unset) {
    notes.push({ tag: '  setup', sgr: GREY, text: [[`${unset} repo${unset === 1 ? ' has' : 's have'} no "Batches run by" setting, so ${unset === 1 ? 'it runs' : 'they run'} in a session. `, GREY],
      ['/desk-setup', BOLD], [' sets it.', GREY]] });
  }
  if (badge) notes.push({ tag: '  dates', sgr: GREY, text: [[badge, null]] });
  if (notes.length) foot.push('', ...noteLines(notes, w, width));
  return { head, rows, foot };
}

export const overview = (repos, opts) => joined(overviewParts(repos, opts));

const clock = (t) => new Date(t).toTimeString().slice(0, 5);
// A usage limit's reset, epoch seconds: the time today, else the day and time.
const resetsWhen = (s) => (new Date(s * 1000).toDateString() === new Date().toDateString() ? clock(s * 1000) : dayAndTime(s * 1000));
// The interactive screen's `clock` is its time source, so the breadcrumb's time is read through this.
const hhmm = clock;

// When the batch's passes run, for a header: the next one while live, else that they have stopped,
// what that means for its workers, and how to start them again.
function passLines(r, now) {
  if (r.live) {
    const next = r.next == null ? '' : r.next > now ? ` · next pass ${clock(r.next)}` : ` · next pass due ${clock(r.next)}`;
    return [`orchestrator live, last pass ${ago(now - r.last)}${next}`];
  }
  return [r.last == null ? 'no pass yet' : `passes stopped ${ago(now - r.last)} (last pass ${clock(r.last)}${r.next != null ? `, next was due ${clock(r.next)}` : ''})`, ...stoppedLines(r)];
}

// What stopped passes mean for the batch's workers, and how to start them again.
function stoppedLines(r) {
  return ['Running workers carry on, but nothing new starts and stages are not updated.', `To resume: ${resumeOf(r)}.`];
}
export const resumeOf = (r) => (supervisorOff(r) ? `desk-q ${r.repo} supervisor on`
  : r.run?.by === 'supervisor' ? `check the supervisor with node ~/.claude/desk/bin/supervisor.mjs status, in ${r.name}`
    : `run /desk-autopilot in ${r.name}${handsOver(r) ? '; it hands the batch to the supervisor at Stage 4' : ''}`);
// The same, as a sentence of its own: a bare command follows "Run:".
const resumeLine = (r) => (supervisorOff(r) ? `Run: ${resumeOf(r)}` : capital(resumeOf(r)));

// The supervisor log's last line, or null with no log: its last 4 KB is read.
const supervisorLogLine = (r) => tailLines(join(r.stateDir, 'supervisor.log')).at(-1) ?? null;

// A repo screen's second header line: who runs the batch (or that passes stopped, or the supervisor is
// off), the last pass, the workers against the batch's count and cap, and the batch. With passes
// stopped or the supervisor off, what that means and how to resume follow, and a loaded supervisor's
// last log line says why it is not passing.
function passHead(r, now) {
  const [cell, sgr] = lastPass(r, now);
  const on = r.live && !supervisorOff(r);
  const next = r.next == null ? [] : on ? [[r.next > now ? ' · next pass ' : ' · next pass due ', GREY], [clock(r.next), null]] : [[', next was due ', GREY], [clock(r.next), null]];
  const last = r.last == null ? [['no pass yet', GREY]] : [['last pass ', GREY], [on ? ago(now - r.last) : clock(r.last), null], ...next];
  const line = segLine([[on ? cell.split(' · ')[0] : cell, sgr], ['  ', null], ...last, BAR,
    ['workers ', GREY], [`${count(r, 'running')} of ${r.workers}`, BOLD], [' · cap ', GREY], [String(r.cap), BOLD], BAR, [`batch ${r.q.batch ?? '-'}`, GREY]]);
  if (on) return [line];
  const log = r.run?.agent === 'loaded' ? supervisorLogLine(r) : null;
  return [line, ...(supervisorOff(r) ? ['The supervisor is off, so no passes run.'] : []), ...stoppedLines(r), ...(log ? [`Supervisor's last log line: ${log}`] : [])];
}

// A line of segments split by BAR, broken between segments where it is wider than `width`.
function barWrap(line, width) {
  if (line.line.length <= width) return [line];
  const len = (segs) => segs.reduce((a, [s]) => a + s.length, 0);
  const out = [];
  for (const g of line.segs.reduce((gs, s) => { if (s === BAR) gs.push([]); else gs.at(-1).push(s); return gs; }, [[]])) {
    const cur = out.at(-1);
    if (cur && len(cur) + BAR[0].length + len(g) <= width) cur.push(BAR, ...g); else out.push([...g]);
  }
  return out.map(segLine);
}

// A repo screen's first header line: what needs the user, each state's count in its colour, then
// the merged tickets left off the list.
function countsLine(r) {
  const segs = [needsYou(count(r, 'needs'))];
  for (const k of SHOWN.filter((g) => g !== 'needs')) if (count(r, k)) segs.push(['  ', null], [`${LABEL[k][0]} ${count(r, k)} ${k}`, STATE_SGR[k]]);
  return segLine([...segs, BAR, [`✓ ${r.done} done`, null], [', not shown', GREY]]);
}

// Why a ready ticket has not started: its batch's worker slots, a running ticket it collides with,
// or the pass that will start it.
function readyWhy(r, t) {
  if (r.workers === 0) return 'workers set to 0';
  const busy = count(r, 'running');
  if (busy >= r.workers) return `waits for a worker (${busy} of ${r.workers} busy)`;
  const clash = String(t.collides_with ?? '').split('|').filter((c) => r.q.tickets?.[c]?.state === 'running');
  if (clash.length) return `waits for ${clash.join(', ')} to finish`;
  return r.live ? 'starts at the next pass' : 'starts when passes resume';
}

// A running ticket's stage: "stage 4/9 verify since 06:38" from its worker's log; with no marker
// there, the last pass's reading, which the worker may be further on from.
function runningStage(r, x) {
  const { st } = x;
  const p = x.t?.usage_paused;
  if (p) return `paused on ${limitName(p.type)}${p.resets_at != null ? ` until ${resetsWhen(p.resets_at)}` : ''}, then resumes by itself`;
  if (st.log) return `stage ${st.label}${st.at == null ? '' : ` since ${clock(st.at)}`}`;
  return `stage ${st.label ?? '?'} ${r.last == null ? 'as of an unknown pass' : `as of ${clock(r.last)}`}`;
}

// An open PR's checks, as the last pass read them (pr_status). A check queued this long with
// no runner reads as stalled for want of one.
const NO_RUNNER_MS = 10 * MINUTE;
const checkFailed = (c) => c.status === 'completed' && FAILED.has(c.conclusion);
const startedMs = (c) => Date.parse(c.started ?? '') || null;
// "tests (macos-latest)" waits for a macOS runner; a check with no runner label is named itself.
const OS_NAMES = [[/macos/i, 'macOS'], [/windows/i, 'Windows'], [/ubuntu|linux/i, 'Linux']];
const runnerOf = (name) => {
  const m = /\(([^)]*)\)\s*$/.exec(name);
  return (m && OS_NAMES.find(([re]) => re.test(m[1]))?.[1]) ?? name;
};
// An unmerged PR's WHAT IT NEEDS: its number, then prNeed's reason and command. With passes stopped
// its checks are as old as the last pass, so it says when they were read, and is grey.
function prSegs(r, t, now) {
  const lead = [[`#${t.result.pr}`, PR_SGR], [' · ', null]];
  if (r.live) {
    // A Merging PR with no change for STALL_MS keeps its first reason and says so, which a 52-column
    // row has room for; the rest is moving nothing.
    const m = prNeed(r.q, t, r.ctx, now), stall = m.k === 'merging' ? stalledFor(t, now) : null;
    return [...lead, ...(stall != null ? [m.segs[0], [` · no change for ${span(stall)}`, null]] : m.segs)];
  }
  return [...lead, [`as of ${clock(Date.parse(prStatusOf(t).at))}: ${segText(prNeed(r.q, t, r.ctx, null).segs)}`, GREY]];
}

// A ticket on a fix try: its PR, what is wrong with it, and that a worker repairs it, running or next.
function fixSegs(f, running) {
  const what = f.kind === 'conflict' ? `merge conflict with ${f.base}` : f.checks ? checksFailed(f.checks.length + (f.not_mine?.length ?? 0)) : f.what;
  const who = running ? 'a worker' : 'next free worker';
  if (f.kind === 'gaps') return [[`#${f.pr}`, PR_SGR], [' · ', null], [what, WARN], [` · ${who} carries out your call`, null]];
  return [[`#${f.pr}`, PR_SGR], [' · ', null], [what, FAIL], [` · ${who} repairs it, try ${f.try} of ${f.of}`, null]];
}

const prOf = (r, key) => (landing(r.q.tickets?.[key]) ? `#${r.q.tickets[key].result.pr}` : null);
export const prUrl = (r, t) => { const ps = prStatusOf(t); return ps.url ?? `https://github.com/${r.slug.replace('__', '/')}/pull/${ps.pr}`; };
// A finished check's run time: "7m 35s".
const took = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : since(ms); };

// A landing PR's checks, one line each, then when they were read and how to open the PR: `g` on the
// screen, the URL in plain output.
function checkLines(r, t, now, plain) {
  const ps = prStatusOf(t);
  const lead = ' '.repeat(14);
  const lines = (ps.checks ?? []).map((c) => {
    const s = startedMs(c), e = Date.parse(c.completed ?? '') || null, age = s == null ? '' : ` ${since(Math.max(0, now - s))}`;
    const [glyph, gk, what, wk] = checkFailed(c) ? ['✕', FAIL, 'failed', FAIL]
      : c.status === 'completed' ? (c.conclusion === 'success' ? ['✓', GOOD, `passed${s && e ? ` in ${took(e - s)}` : ''}`, DIM] : ['·', DIM, c.conclusion ?? 'done', DIM])
        : c.runner ? ['●', null, `running${age}`, null]
          : s != null && now - s >= NO_RUNNER_MS ? ['◌', WARN, `queued${age}, no runner yet`, WARN] : ['◌', null, `queued${age}`, null];
    return segRow(null, [[`${lead}${pad(glyph, 3)}`, gk], [pad(cut(c.name, 25), 26), null], [what, wk]], null);
  });
  if (!lines.length) lines.push(segLine([[`${lead}no checks reported yet`, DIM]]));
  const read = `${lead}checked by the last pass, ${ago(now - Date.parse(ps.at))} · `;
  lines.push(segLine(plain ? [[`${read}${prUrl(r, t)}`, DIM]] : [[read, DIM], ['g', BOLD], [` open #${ps.pr} on GitHub`, null]]));
  return lines;
}

// The PR `g` opens on a ticket's page: its own while landing, else the selected blocker's, else its
// first landing blocker's.
export function prToOpen(r, key, sel = null) {
  const t = r.q?.tickets?.[key];
  if (!t) return null;
  const held = unmergedBlockers(r.q, t);
  const k = [key, ...(held.includes(sel) ? [sel] : []), ...held].find((b) => landing(r.q.tickets[b]));
  return k ? { pr: r.q.tickets[k].result.pr, url: prUrl(r, r.q.tickets[k]) } : null;
}

// WHAT IT NEEDS in coloured runs. A held ticket says what it waits on (holdOf).
function needSegs(r, x, now = Date.now()) {
  const { t, k } = x;
  if (x.pr) return prSegs(r, t, now);
  if (k === 'stuck') return [[outsideText(t), null]];
  // One with a question of its own needs the user for that, whatever it is held behind.
  if (heldAsks(t)) return [[`${t.open_questions} triage question(s) open: answer them`, null]];
  if (isHeld(t)) return holdOf(r.q, t, r.ctx).text.split(/(#\d+)/).filter(Boolean).map((s) => [s, /^#\d+$/.test(s) ? PR_SGR : null]);
  const f = fixOn(t);
  if (f && groupOf(k) !== 'needs') return fixSegs(f, k === 'running');
  if (k === 'running') return [[runningStage(r, x), null]];
  if (answeredPark(t, r.ctx)) return [[answeredText(r.q), null]];
  if (k === 'ready') return [[readyWhy(r, t), null]];
  if (k === 'needs' && claimOf(t)) return [[`claimed by session ${claimOf(t).session}`, null]];
  if (k === 'needs') return [[t.state === 'parked' ? (t.park?.question ?? 'parked') : `${t.open_questions} triage question(s) open: answer them`, null]];
  if (k === 'failed') return [[stoppedText(t), null]];
  if (k === 'queued') return [['triaging', null]];
  return [['', null]];
}
const detail = (r, x) => needSegs(r, x).map((s) => s[0]).join('');
export { detail as needText };
// An interactive session's claim on a parked ticket (queue.mjs park --claimed-by). Once a pass finds
// uncommitted work behind it, the park's question says what to do, so the claim is no longer the news.
const claimOf = (t) => (t.state === 'parked' && t.park?.claim?.session && !t.park.claim.dirty_at ? t.park.claim : null);

// How long a row in Merging or Needs you has been in that group, as the pass stamped it (`group`), or
// null: for any other group, or when the stamp is of another group because no pass has run since.
function inGroup(x, now) {
  const g = groupOf(x.k), at = Date.parse(x.t.group?.at ?? '');
  return ['merging', 'needs'].includes(g) && x.t.group?.g === g && Number.isFinite(at) ? Math.max(0, now - at) : null;
}

// Each unfinished ticket's and unmerged PR's group, as a running pass reads the batch, for it to stamp
// when a row entered its group (`group` on the ticket): the age STARTS shows, and the digest's stalled PRs.
export function groupsNow({ slug, stateDir, queuePath, q, now = Date.now() }) {
  const r = { slug, stateDir, queuePath, q, live: true, last: now };
  const ctx = holdContext(r);
  return Object.fromEntries(Object.entries(q?.tickets ?? {}).filter(([, t]) => t.state !== 'done' || prRow(t)).map(([key, t]) => [key, groupOf(shownState(q, t, ctx))]));
}

// One repo's PRs the last pass put in Merging (`group`) whose head and check results have gone
// unchanged for STALL_MS, longest first, for the check-in digest: {ticket, pr, url, for, check}, where
// `check` is the reason their row leads with. The pass put them in Merging, so something merges and
// reruns them, and they are worded as Merging words them.
export function stalledPrs({ slug, stateDir, queuePath, q, now = Date.now() }) {
  const r = { slug, stateDir, queuePath, q, live: true, last: now };
  const ctx = { ...holdContext(r), merges: true, reruns: true };
  return Object.entries(q?.tickets ?? {}).filter(([, t]) => prRow(t) && t.group?.g === 'merging')
    .map(([key, t]) => ({ key, t, ms: stalledFor(t, now) })).filter((x) => x.ms != null)
    .sort((a, b) => b.ms - a.ms)
    .map(({ key, t, ms }) => ({ ticket: key, pr: t.result.pr, url: prStatusOf(t).url ?? null, for: span(ms), check: prNeed(q, t, ctx, null).segs[0][0] }));
}

// A waiting ticket whose every blocker left is landing starts after their PRs merge.
function afterPrs(r, x) {
  const open = x.k === 'waiting' ? unmergedBlockers(r.q, x.t) : [];
  return open.length && open.every((b) => prOf(r, b)) ? `after ${open.map((b) => prOf(r, b)).join(', ')}` : null;
}

// Coloured runs cut to `max` columns as `cut` would, then padded to `w`.
function fitSegs(segs, max, w) {
  const len = segs.reduce((a, [s]) => a + s.length, 0);
  let room = len > max ? max - 1 : len;
  const out = [];
  for (const [s, k] of segs) { if (room <= 0) break; out.push([s.slice(0, room), k]); room -= s.length; }
  if (len > max) out.push(['…', null]);
  out.push([' '.repeat(Math.max(0, w - Math.min(len, max))), null]);
  return out;
}

// WHAT IT NEEDS takes NEED_W while the title keeps TITLE_MIN; narrower than that, the title is cut
// first, then the reason, down to NEED_MIN ("waits for a worker (12 of 12 busy)").
const NEED_W = 52, NEED_MIN = 36, TITLE_MIN = 12;
// The columns before TITLE on a ticket row, less WHAT IT NEEDS.
const ROW_LEAD = 2 + 4 + 2 + 10 + STATE_W + 13 + 14;
// A repo's Queue in groups, each in queue order: what autopilot is moving first, then what needs the user.
const GROUPS = [['Running', 'running'], ['Ready', 'ready'], ['Merging', 'merging'], ['Waiting', 'waiting'], ['Needs you', 'needs']];

// `width` is the terminal's: titles take what the row has left, rather than a fixed 60. `epic` keeps
// to that epic's tickets, each keeping its place in the whole queue. A group's heading is a row with
// no id, which the selection steps over. `title` leads with the place and time, as the interactive
// screen's breadcrumb does.
function repoParts(r, { now = Date.now(), width = null, checkin = false, epic = null, title = false, usage = null, pinUsage = false } = {}) {
  const none = { rows: [], foot: [] };
  if (r.error) return { head: [`${r.name} · queue unreadable: ${r.error}`], ...none };
  if (!r.q) return { head: [`${r.name} · set up, no autopilot batch yet · cap ${r.cap} · ports ${r.claim.port}–${r.claim.last}`, '', 'Nothing to show until a batch starts. Run /desk-autopilot in that repo to start one.'], ...none };
  const nw = width == null ? NEED_W : Math.max(NEED_MIN, Math.min(NEED_W, width - ROW_LEAD - TITLE_MIN));
  const tw = width == null ? 60 : Math.max(1, width - ROW_LEAD - nw);
  const F = forecastOf(r, { now, checkin });
  const ep = epic ? F.epics[epic] : null;
  const head = [
    ...(title ? [`desk-q › ${r.name} · ${clock(now)}`] : []),
    ...(ep ? [`${ep.key} · ${ep.summary} · ${ep.done} of ${ep.total} children done`] : []),
    countsLine(r),
    ...passHead(r, now),
    ...(pinUsage ? [] : [usageLine(usage ?? usageOf([r], now), { now, solid: solidBars(width) })]),
  ];
  // Wrapped to the terminal, so how to resume passes is never cut.
  const fit = head.flatMap((s) => (width == null ? [s] : typeof s === 'string' ? wrap(s, width) : barWrap(s, width)));
  fit.push('', bold(`  ${rpad('#', 4)}  ${pad('TICKET', 10)}${pad('STATE', STATE_W)}${pad('WHAT IT NEEDS', nw)}${pad('STARTS', 13)}${pad('SHIPS', 14)}TITLE`));
  const rows0 = [...r.rows, ...r.prs];
  const list = epic ? rows0.filter((x) => F.of[x.t.key] === epic) : rows0;
  const summary = (x) => summaryOf({ r, x });
  const tt = titler(list.map(summary));
  // A ticket with a PR open has started and has no ship date of its own. One in Merging or Needs you
  // says how long it has been there instead, amber for a Merging PR with no change for STALL_MS.
  const starts = (x) => { const a = afterPrs(r, x), g = inGroup(x, now); return g != null ? `for ${span(g)}` : x.pr ? 'started' : a ? cut(a, 12) : startsCell(F, x, now); };
  const startsSgr = (x) => (r.live && groupOf(x.k) === 'merging' && inGroup(x, now) != null && stalledFor(x.t, now) != null ? WARN : null);
  const ships = (x) => (x.pr ? '—' : shipsCell(F, x, now));
  const row = (x) => segRow(x.t.key, [
    [`  ${rpad(x.pos == null ? '-' : `${x.t.placed ? '*' : ''}${x.pos}`, 4)}  ${pad(x.t.key, 10)}`, null], [pad(LABEL[x.k], STATE_W), STATE_SGR[x.k]],
    // A PR's detail runs to one space before STARTS, so "#164 · tests (macos-latest): no runner, 14m ·
    // 1 of 2 done" keeps as much as it can.
    ...fitSegs(needSegs(r, x, now), nw - (x.pr ? 1 : 2), nw),
    [pad(starts(x), 13), startsSgr(x)], [`${pad(ships(x), 14)}${cut(tt(summary(x)), tw)}`, null],
  ], { kind: 'ticket', slug: r.id, key: x.t.key, ...(epic ? { epic } : {}) });
  const rows = GROUPS.flatMap(([name, k]) => {
    const g = list.filter((x) => groupOf(x.k) === k);
    return g.length ? [segRow(null, [[`  ${name}`, BOLD], [` · ${g.length}`, GREY]], null), ...g.map(row)] : [];
  });
  const foot = !list.length ? ['  No unfinished tickets.'] : ['', ...stateKey(list, width)];
  if (list.some((x) => x.t.placed)) foot.push('', '* placed by you: letting it start or a requeue leaves it where it is');
  return { head: fit, rows, foot };
}

// What each shown state means, for the key line under a Queue.
const MEANS = { running: 'holds a worker', ready: 'next free worker takes it', merging: 'merges by itself once green', waiting: 'moves by itself',
  needs: 'nothing moves until you act' };
// The key line: each state on screen in its colour, its meaning grey. Narrower than the line, it
// breaks between states, each further line indented under the first.
const stateKey = (list, width) => keyLine(shownOf(list.map((x) => x.k)).map((k) => [[LABEL[k], STATE_SGR[k]], [`: ${MEANS[k]}`, GREY]]), width);

export const repoScreen = (r, opts) => joined(repoParts(r, { ...opts, title: true }));

const logPath =(r, key) => join(r.stateDir, 'logs', `${key}.log`);

// The ticket page's label column.
const FIELD_W = 10;
// The blockers a ticket page lists before a shows them all, and the lines Why lane and the file list
// take before y and f show them in full.
const BLOCKERS_SHOWN = 6, FOLD_LINES = 2;
// The rail the page's first lines sit on, in the ticket's state colour.
const RAIL = '▌ ';
// A Jira status category, as Jira names it.
const JIRA_CATEGORY = { new: 'To Do', indeterminate: 'In Progress', done: 'Done' };
const answerCmd = (key) => `node ~/.claude/desk/bin/answer.mjs ${key} "…"`;

// What a ticket page leads with: whether it moves without the user and, if not, what would. `lead`
// introduces `cmds`, the commands that move it, each drawn alone on its own line so it copies whole.
function moveOf(r, row, k, t, h, now) {
  const q = t.park?.question;
  // A held ticket with a question of its own is moved by its answer, not by its blockers.
  const asks = heldAsks(t);
  if (asks) h = null;
  if (!row) return { text: k === 'done' ? 'Done: nothing left to move.' : `${capital(k)}.` };
  const f = fixOn(t);
  if (k === 'running') return { text: `Moves without you: a worker is on it, ${f ? `${segText(fixSegs(f, true))}, ` : ''}${runningStage(r, row)}.` };
  if (row.pr) {
    const m = segText(prSegs(r, t, now).slice(2));
    return { text: m ? `${groupOf(k) === 'needs' ? 'Needs you' : 'Moves without you'}: PR #${t.result.pr}, ${m}.` : `PR #${t.result.pr}.` };
  }
  if (k === 'stuck') {
    const n = outsideOf(t).length;
    return { text: `Will not start on its own. ${n} Jira ticket${n === 1 ? '' : 's'} outside this batch must be done first, and nothing in this batch moves it.`,
      lead: `If it can start without them, say so, in ${r.name}:`, cmds: [answerCmd(t.key)] };
  }
  // A fix worker that parked or gave up leaves its try open: the ticket needs the user, as its row says.
  if (f && groupOf(k) !== 'needs') {
    if (!r.live) return { text: `Will not move until passes resume: ${segText(fixSegs(f, false))}.`, lead: `${capital(resumeOf(r))}.` };
    return { text: `Moves without you: ${segText(fixSegs(f, false))}.` };
  }
  // With passes stopped nothing new starts and no held ticket starts, so only resuming them moves it.
  if (!r.live && (['ready', 'queued'].includes(k) || h?.k === 'waiting')) {
    const text = `Will not move until passes resume${h ? `: ${h.text}` : ''}.`;
    return supervisorOff(r) ? { text, lead: 'Run:', cmds: [resumeOf(r)] } : { text, lead: `${capital(resumeOf(r))}.` };
  }
  if (h) {
    if (h.k === 'waiting') return { text: `Moves without you: ${h.text}.` };
    return { text: `Needs you. ${capital(h.text)}.`, ...(h.act ? { lead: `Run, in ${r.name}:`, cmds: h.act.split(/, then /) } : {}) };
  }
  if (answeredPark(t, r.ctx)) return { text: `Moves without you: ${answeredText(r.q)}, and a worker picks it up from there.` };
  if (k === 'needs' && claimOf(t)) {
    if (needsSession(t)) return { text: `Claimed by session ${claimOf(t).session}, which works it. It is lane ${t.lane}, so it stays with a person however long that session is idle${q ? `: ${q}` : '.'}` };
    return { text: `Claimed by session ${claimOf(t).session}, which works it. Once that session has been idle past config §3b "Release idle claims after (hours)", with nothing uncommitted in its worktree, a pass sends it back to the workers.` };
  }
  if (k === 'needs') {
    if (needsSession(t)) return { text: q ? `Needs your answer: ${q}` : 'Needs you: it is lane C or D.', lead: `Only an interactive session takes it on. Open one in ${r.name}:`, cmds: [`/desk-ticket ${t.key}`] };
    const n = t.open_questions ?? 0;
    return { text: q && t.state === 'parked' && !asks ? `Needs your answer: ${q}` : `Needs you: triage left ${n} question${n === 1 ? '' : 's'} open.`,
      lead: `Answer, in ${r.name}, and the orchestrator decides whether to requeue it:`, cmds: [answerCmd(t.key)] };
  }
  if (k === 'failed') return { text: `Needs you: its worker stopped${q ? `: ${q}` : '.'}`, lead: `Requeue it, in ${r.name}, or drop it:`, cmds: [`node ~/.claude/desk/bin/queue.mjs requeue ${t.key}`] };
  if (k === 'queued') return { text: 'Moves without you: it is being triaged.' };
  if (r.workers === 0) return { text: 'Will not start: workers are set to 0. Raise them with +.' };
  return { text: `Moves without you: it ${readyWhy(r, t)}.` };
}

// One blocker in the batch, as a row: its glyph and key in its state's colour, then, where it needs
// the user, what to do with the action bold, else its state and its title or its PR's checks.
function blockerRow(r, key, b, kw, now) {
  const bt = r.q.tickets[b];
  if (!bt) return segRow(null, [[`  ◆ ${pad(b, kw)}  `, YOU_BOLD], ['not in this queue: ', null], ['let it start', BOLD]], null);
  const bk = shownState(r.q, bt, r.ctx);
  const bh = blockerHold(r.q, key, b, r.ctx, new Set([key]));
  const open = { kind: 'ticket', slug: r.id, key: b };
  // A PR that needs the user is theirs to move, so it reads as its action, as a blocker that needs them does.
  const m = bh.you ? prNeed(r.q, bt, r.ctx, null) : null;
  const text = bh.k === 'needs' ? bh.text : m ? `${bh.name}: ${m.segs[0][0]}${m.segs.length > 1 ? m.segs.at(-1)[0] : ''}` : null;
  if (text) {
    const at = text.lastIndexOf(': ');
    return segRow(b, [[`  ◆ ${pad(b, kw)}  `, YOU_BOLD], [text.slice(0, at + 2), null], [text.slice(at + 2), BOLD]], open);
  }
  const what = prRow(bt) ? prSegs(r, bt, now) : [[cut(triageOf(r.stateDir, b)?.summary ?? '', 70), null]];
  return segRow(b, [[`  ${LABEL[bk][0]} ${pad(b, kw)}  `, STATE_SGR[bk] ?? null], [pad(LABEL[bk].slice(2), STATE_W - 2), STATE_SGR[bk] ?? null], ...what], open);
}

// Flags from triage and the last pass that bear on whether to let the ticket run.
function warningsOf(t, tr, lane) {
  const out = [];
  if (tr.facts_error) out.push(`Triage could not read its Jira links (${tr.facts_error}), so blockers outside the batch may be missing.`);
  for (const l of tr.lint ?? []) if (l?.severity === 'blocking') out.push(`Triage's ticket check: ${l.message}`);
  const c = tr.lane_challenge;
  if (c?.verdict && c.verdict !== 'CONFIRM') out.push(`Triage's lane check did not confirm lane ${lane} (${String(c.verdict).toLowerCase()}): ${c.reason ?? 'no reason recorded'}`);
  if ((t.open_questions ?? 0) > 0) for (const u of tr.unknowns ?? []) out.push(`Open from triage: ${u?.question ?? u}`);
  const extra = Array.isArray(t.out_of_scope) ? t.out_of_scope : [];
  if (extra.length) out.push(`Its branch changes ${extra.length} file${extra.length === 1 ? '' : 's'} outside its triaged scope: ${extra.join(', ')}.`);
  if (t.spec_check?.ok === false) out.push(`The last pass found its acceptance specs not done: ${(t.spec_check.problems ?? []).join('; ') || 'no detail recorded'}.`);
  if (t.spawn_failed) out.push('Its last worker did not start, so no worker ran.');
  return out;
}

// The ticket page's Starts and Ships. A ticket the forecast cannot date says what it waits for, and
// Ships reads "no date", with the reason where it is not the hold the page leads with.
function timingFields(r, F, x, h, now) {
  const { t, k } = x;
  const e = F && !undatable(F) ? F.T[t.key] : null;
  if (e) {
    const { v, own } = durationsFor(F.d, F.sizes[t.key]);
    const size = F.sizes[t.key], n = F.d.bySize[size]?.length ?? 0;
    // Drawn from the whole history, the line still says how many of this size it holds, or that triage gave none.
    const of = own ? '' : size === 'unknown' ? ' (triage recorded no size)' : ` (${n} of size ${size}${n ? ', too few to use alone' : ''})`;
    return [
      ['Starts', [[e.start <= now + SOON ? (k === 'running' ? 'running now' : 'now') : when(e.start, now), null]]],
      ['Ships', [[when(e.likely, now), BOLD], [`  could run to ${when(e.late, now)} (1 run in 5 is later)`, DIM]]],
      ['Based on', [[`${v.length} merged ${own ? `size ${size} ` : ''}tickets in ${r.name}${of} · typical ${quantile(v, 0.5).toFixed(1)} h spawn to merge, 4 in 5 within ${quantile(v, 0.8).toFixed(1)} h`, DIM]]],
    ];
  }
  const open = h ? unmergedBlockers(r.q, t).map((b) => blockerHold(r.q, t.key, b, r.ctx, new Set([t.key]))) : [];
  const prs = open.map((b) => b.name).filter((n) => /^#\d+$/.test(n));
  const starts = k === 'running' ? 'running now' : k === 'stuck' ? 'not until its outside blockers are done'
    // Once its PRs merge, a pass lets the ticket start only where something moves holds (holdOf).
    : h && (h.k === 'needs' || open.some((b) => b.you)) ? (open.length && prs.length === open.length
      ? (r.ctx.releases ? `at the next pass after ${listed(prs)} ${prs.length > 1 ? 'merge' : 'merges'}` : `once ${listed(prs)} ${prs.length > 1 ? 'merge' : 'merges'} and you let it start`)
      : 'not until you act')
      : h ? (open.length ? `after ${listed(open.map((b) => b.name))} ${open.length > 1 ? 'merge' : 'merges'}`
        : r.ctx.releases ? 'at the next pass' : 'once the next pass reads its PRs merged and you let it start')
        : k === 'needs' ? 'once you answer it' : k === 'failed' ? 'once it is requeued' : r.workers === 0 ? 'not until workers are raised'
          : F?.paused ? 'when passes resume' : '—';
  const b = F && !undatable(F) ? undatedBlockers(r, F, t) : [];
  const why = !F ? null : F.idle ? idleNote(r) : F.none ? noHistory(r, F) : F.paused ? `${capital(stoppedNote(r, now))}.`
    : h || ['stuck', 'running', 'failed'].includes(k) ? null : r.workers === 0 ? 'Workers are set to 0, so nothing starts.'
      : k === 'needs' ? 'Press c to date it as if answered at the next check-in.' : b.length ? `Until ${listed(b)} ${b.length > 1 ? 'have dates' : 'has a date'}.` : null;
  return [['Starts', [[starts, null]]], ['Ships', [['no date', null], ...(why ? [[`  ${why}`, DIM]] : [])]]];
}

// `jiraUrl` adds the Jira line the interactive screen opens with o. `open` is the interactive screen's
// set of what a, y and f unfold ('a' blockers, 'y' why lane, 'f' files); null, as in plain output,
// shows all of it. `can` says which of them has more to show.
function ticketParts(r, key, { width = null, jiraUrl = null, now = Date.now(), checkin = false, open = null } = {}) {
  const t = r.q.tickets[key];
  const k = shownState(r.q, t, r.ctx);
  const row = r.rows.find((x) => x.t.key === key) ?? r.prs.find((x) => x.t.key === key);
  const tr = triageOf(r.stateDir, key) ?? {};
  const pos = r.rows.find((x) => x.t.key === key)?.pos;
  const lane = laneOf(t, tr);
  const ww = width == null ? 96 : Math.max(20, Math.min(96, width - 2));
  const shows = (id) => open == null || open.has(id);
  const can = { a: false, y: false, f: false };
  const h = isHeld(t) ? holdOf(r.q, t, r.ctx) : null;
  // The key bold, the state in its colour, the facts after it grey; then the title, then on the rail
  // whether it moves without the user, any command alone on its own line.
  const head = [
    segLine([[key, BOLD], ['  ', null], [LABEL[k], STATE_SGR[k] ?? null], BAR,
      [[t.type ?? tr.type, `size ${tr.size ?? '?'}`, `lane ${lane}`, pos != null ? `position ${pos} of ${r.places}${t.placed ? ' (placed by you)' : ''}` : null].filter(Boolean).join(' · '), DIM]]),
    ...(tr.summary ? wrap(tr.summary, ww).map(bold) : ['(no triage record: title unknown)']),
    '',
  ];
  const mv = moveOf(r, row, k, t, h, now);
  const rail = (s) => wrap(s, ww - RAIL.length).map((l) => segLine([[RAIL, STATE_SGR[k] ?? null], [l, null]]));
  head.push(...rail(mv.text), ...(mv.lead ? rail(mv.lead) : []));
  if (mv.cmds) head.push('', ...mv.cmds.map((c) => ({ ...segLine([[c, BOLD]]), whole: true })));
  head.push('');
  const rows = [], out = [];
  // Blockers, by who has to act: merged ones counted green, then each still open in the batch, then
  // each open in Jira outside it, grey with its status.
  const held = keysOf(t.held_by), outside = outsideOf(t);
  if (held.length || outside.length) {
    const unmerged = unmergedBlockers(r.q, t);
    const merged = held.filter((b) => !unmerged.includes(b));
    const kw = Math.max(8, ...[...held, ...outside.map((o) => o.key)].map((s) => s.length));
    const total = held.length + outside.length;
    head.push(segLine([['Blockers', BOLD], [`  ${total}${!outside.length ? ', all in this batch' : !held.length ? ', all outside it' : ` · ${held.length} in this batch, ${outside.length} open outside it`}`, DIM]]));
    const fits = Math.max(0, BLOCKERS_SHOWN - unmerged.length);
    can.a = merged.length > 0 || outside.length > fits;
    if (merged.length) {
      head.push(segLine([[`  ✓ ${merged.length}`, GOOD], [` ${outside.length ? 'in this batch ' : ''}merged`, null], ...(open && !shows('a') ? [['  · a shows them', DIM]] : [])]));
      if (shows('a')) for (const b of merged) rows.push(segRow(b, [[`  ✓ ${pad(b, kw)}  `, GOOD], [cut(triageOf(r.stateDir, b)?.summary ?? '', 70), null]], { kind: 'ticket', slug: r.id, key: b }));
    }
    for (const b of unmerged) {
      rows.push(blockerRow(r, key, b, kw, now));
      const bt = r.q.tickets[b];
      if (bt && landing(bt)) rows.push(...checkLines(r, bt, now, width == null));
    }
    const room = shows('a') ? outside.length : fits;
    for (const o of outside.slice(0, room)) out.push(segLine([[`  ◌ ${pad(o.key, kw)}  ${JIRA_CATEGORY[o.category] ?? o.category}`, GREY]]));
    if (outside.length > room) out.push(segLine([[`    … ${outside.length - room} more outside this batch`, GREY], ['  · a shows all', DIM]]));
    out.push('');
  }
  if (row?.pr && prStatusOf(t)) out.push(bold(`Checks on #${t.result.pr}:`), ...checkLines(r, t, now, width == null), '');
  const warnings = warningsOf(t, tr, lane);
  if (warnings.length) {
    out.push(bold('Warnings'));
    for (const w of warnings) wrap(w, ww - 4).forEach((l, i) => out.push(segLine([[i ? '    ' : '  ▲ ', WARN], [l, null]])));
    out.push('');
  }
  // The tickets waiting on this one, each with its state, so acting here shows what it unblocks.
  const holds = r.rows.filter((x) => x.t.key !== key && keysOf(x.t.held_by).includes(key));
  if (holds.length) {
    const each = holds.flatMap((x, i) => [...(i ? [[', ', null]] : []), [`${LABEL[x.k][0]} ${x.t.key}`, STATE_SGR[x.k] ?? null], [` (${LABEL[x.k].slice(2)})`, DIM]]);
    out.push(segLine([['Holding up', DIM], ['  ', null], ...each, [` ${holds.length === 1 ? 'waits' : 'wait'} on this ticket`, null]]), '');
  }
  // Each field's label grey in a column of its own. One too long for the line wraps under its value,
  // in its first run's colour; a branch or a path is kept whole.
  const field = (label, segs, whole = false) => {
    const text = segs.map((s) => s[0]).join('');
    if (whole || FIELD_W + text.length <= ww) return out.push(segLine([[pad(label, FIELD_W), DIM], ...segs]));
    wrap(text, ww - FIELD_W).forEach((l, i) => out.push(segLine([[pad(i ? '' : label, FIELD_W), DIM], [l, i ? DIM : segs[0][1]]])));
  };
  if (row && !row.pr) { for (const [label, segs] of timingFields(r, forecastOf(r, { now, checkin }), row, h, now)) field(label, segs); out.push(''); }
  // The PR's fix try and what no fix try can move, as the last pass recorded them on the ticket.
  const stuck = t.stuck && !t.merged_at ? t.stuck : null;
  if (t.fix?.kind === 'gaps') field('Your call', [[t.fix.what, null]]);
  else if (t.fix) field('Fix try', [[`${t.fix.try} of ${t.fix.of} · ${t.fix.what}`, null]]);
  if (stuck) field('For you', [[stuck.why, WARN]]);
  if (t.fix || stuck) out.push('');
  // Why lane and the file list fold to FOLD_LINES, from `short` (lines that leave room for the note
  // on the last one shown), and that last line says how much more there is and how to unfold it.
  const folded = (id, lines, short, more) => {
    if (lines.length <= FOLD_LINES) return lines.map((l) => dim(l));
    can[id] = true;
    if (shows(id)) return lines.map((l) => dim(l));
    const shown = short.slice(0, FOLD_LINES).map((l) => dim(l));
    shown[FOLD_LINES - 1] = segLine([[short[FOLD_LINES - 1], DIM], [`  … ${more(short.length - FOLD_LINES)} · ${id} shows all`, DIM]]);
    return shown;
  };
  if (tr.lane_reason) out.push(bold(`Why lane ${lane}`), ...folded('y', wrap(tr.lane_reason, ww), wrap(tr.lane_reason, ww - 28), (n) => `${n} more line${n === 1 ? '' : 's'}`), '');
  const files = (tr.files_in_scope ?? []).map((f) => `  ${f}`);
  if (files.length) out.push(segLine([['Files in scope', BOLD], [` · ${files.length}`, DIM]]), ...folded('f', files, files, (n) => `${n} more`), '');
  if (t.collides_with) out.push(segLine([['Never runs with ', BOLD], [String(t.collides_with).split('|').join(', '), DIM]]));
  const branch = t.branch ?? tr.branch;
  if (branch) field('Branch', [[branch, DIM]], true);
  field('Open', width == null ? [['log ', null], [logPath(r, key), DIM]]
    : [['l', BOLD], [' log', null], ...(jiraUrl ? [['  ·  ', null], ['o', BOLD], [' Jira  ', null], [jiraUrl.replace(/^https?:\/\//, ''), DIM]] : [])], true);
  while (out.at(-1) === '') out.pop();
  return { head, rows, foot: out, can };
}

export const ticketScreen = (r, key, opts) => joined(ticketParts(r, key, opts));

// ---- the command -------------------------------------------------------------------------------

class Usage extends Error {}

// Exact name first, then a unique prefix of the short name; owner/name and the slug match too. A
// repo's name is its standing batch; a named batch is `<repo>:<name>`, its `word`.
export function resolveRepo(repos, word) {
  const w = word.toLowerCase();
  const exact = repos.filter((r) => [r.name, r.word, r.id, ...(r.batch ? [] : [r.slug, r.slug.replace('__', '/')])].some((n) => n?.toLowerCase() === w));
  if (exact.length === 1) return exact[0];
  const hits = repos.filter((r) => r.name.toLowerCase().startsWith(w));
  if (hits.length === 1) return hits[0];
  // A prefix of one repo's name is that repo, its standing batch.
  const only = hits.filter((r) => !r.batch);
  if (only.length === 1 && hits.every((r) => r.slug === only[0].slug)) return only[0];
  if (hits.length) throw new Usage(`"${word}" matches ${hits.map((r) => r.word).join(' and ')}. Type more of the name.`);
  throw new Usage(`No repo "${word}". Set up here: ${repos.map((r) => r.word).join(', ')}.`);
}

const MOVES = ['up', 'down', 'top', 'bottom', 'move'];
const SHIPS = ['ships', 'when'];
const VERBS = ['show', ...MOVES, 'workers', 'supervisor', 'ships', 'days'];
const isWrite = (v) => v.kind === 'move' || v.kind === 'workers';
// A command that prints a line rather than opening a view.
const isCommand = (v) => isWrite(v) || v.kind === 'supervisor';
// The view a ships or days word names.
const etaView = (word, slug) => ({ kind: word.toLowerCase() === 'days' ? 'days' : 'timeline', slug });

// What the words name: a view, or a move or workers change. The one-shot command line and the
// screen's ":" prompt read the same words.
function target(repos, words) {
  const [repoWord, verb, keyWord, ...extra] = words.filter((a) => !a.startsWith('--'));
  if (!repoWord) return { kind: 'overview', all: words.includes('--all') };
  if (repoWord.toLowerCase() === 'costs') {
    if (keyWord) throw new Usage(`Unknown command "${words.filter((a) => !a.startsWith('--')).join(' ')}". Try desk-q costs [<repo>].`);
    return verb ? { kind: 'costs', ...costWord(repos, verb) } : { kind: 'costs' };
  }
  // `ships [<repo>]` and `days [<repo>]` read before a repo name, and `<repo> ships` after one.
  if ([...SHIPS, 'days'].includes(repoWord.toLowerCase())) {
    if (keyWord) throw new Usage(`Unknown command "${words.filter((a) => !a.startsWith('--')).join(' ')}". Try desk-q ${repoWord.toLowerCase()} [<repo>].`);
    return etaView(repoWord, verb ? resolveRepo(repos, verb).id : null);
  }
  const r = resolveRepo(repos, repoWord);
  if (!verb) return { kind: 'repo', slug: r.id };
  const unknown = () => new Usage(`Unknown command "${[verb, keyWord, ...extra].filter(Boolean).join(' ')}". Verbs: ${VERBS.join(', ')}.`);
  if ([...SHIPS, 'days'].includes(verb)) { if (keyWord) throw unknown(); return etaView(verb, r.id); }
  if (!VERBS.includes(verb)) throw unknown();
  // The supervisor is the repo's, not its batch's, so a repo with no batch has one too.
  if (verb === 'supervisor') {
    if (extra.length || (keyWord != null && !['on', 'off'].includes(keyWord.toLowerCase()))) throw new Usage(`On, off or its status? desk-q ${r.repo} supervisor [on|off].`);
    return { kind: 'supervisor', slug: r.slug, op: keyWord?.toLowerCase() ?? 'status' };
  }
  if (r.error) throw new Usage(`${r.name}: queue unreadable: ${r.error}`);
  if (!r.q) throw new Usage(`${r.name} has no batch yet.`);
  if (verb === 'workers') {
    if (keyWord == null) throw new Usage(`How many? desk-q ${r.word} workers <n>.`);
    if (extra.length) throw unknown();
    return { kind: 'workers', slug: r.id, n: keyWord };
  }
  if (!keyWord) throw new Usage(`Which ticket? desk-q ${r.word} ${verb} <KEY>${verb === 'move' ? ' <n>' : ''}.`);
  const key = [keyWord, keyWord.toUpperCase()].find((k) => r.q.tickets?.[k]);
  if (!key) throw new Usage(`${keyWord} isn't in ${r.name}'s queue.`);
  if (verb === 'move') {
    if (extra.length !== 1) throw new Usage(`Which position? desk-q ${r.word} move ${key} <n>.`);
    return { kind: 'move', slug: r.id, key, verb, to: extra[0] };
  }
  if (extra.length) throw unknown();
  return verb === 'show' ? { kind: 'ticket', slug: r.id, key } : { kind: 'move', slug: r.id, key, verb };
}

// ---- changes -----------------------------------------------------------------------------------

const QUEUE_MJS = join(dirname(fileURLToPath(import.meta.url)), 'queue.mjs');

// Every change is a queue.mjs command, which takes the queue's lock. Its queue and state directory
// are the named repo's, passed explicitly: left to itself, queue.mjs picks the repo it is run in.
// A command that reads the repo's config or GitHub repo also needs `at`, its checkout (checkoutOf).
// { ok, code, out, err, why }: its stdout and stderr, and on a non-zero exit why it failed.
export function queueRun(r, args, at = { env: process.env }) {
  try {
    const out = execFileSync(process.execPath, [QUEUE_MJS, ...args], { cwd: at.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...at.env, DESK_QUEUE: r.queuePath, DESK_AUTOPILOT_STATE: r.stateDir } });
    return { ok: true, code: 0, out, err: '', why: '' };
  } catch (e) {
    const err = String(e.stderr ?? '').trim().replace(/^queue: /, '');
    return { ok: false, code: e.status ?? null, out: String(e.stdout ?? ''), err, why: err || describeCrash(e) };
  }
}
function queueCmd(r, args) {
  const q = queueRun(r, args);
  if (!q.ok) throw new Usage(q.why);
}

// Positions are queue.mjs's (loadRepos), so a place here is the place passed on.
function moveTicket(r, key, verb, to) {
  const x = r.rows.find((y) => y.t.key === key);
  if (!x) throw new Usage(`${key} is done: only unfinished tickets have a place in the spawn order.`);
  const i = x.pos, last = r.places;
  if (x.k === 'running') throw new Usage(`${key} is running, so its position no longer matters. Nothing moved.`);
  if (x.k === 'failed') throw new Usage(`${key}'s worker stopped, so it has no place in the spawn order until it is requeued. Nothing moved.`);
  let n;
  if (verb === 'move') {
    if (!/^\d+$/.test(to) || Number(to) < 1 || Number(to) > last) throw new Usage(`Position ${to} is out of range: give 1 to ${last}. Nothing moved.`);
    n = Number(to);
  } else n = { up: i - 1, down: i + 1, top: 1, bottom: last }[verb];
  if (n < 1 || n > last || n === i) throw new Usage(`${key} is already at position ${i}. Nothing moved.`);
  queueCmd(r, ['move', key, String(n)]);
  const why = answeredPark(x.t, r.ctx) ? ` It is ${answeredText(r.q)}, then starts from here.`
    : x.k === 'waiting' ? ` It still waits on ${unmergedBlockers(r.q, x.t).join(', ') || 'its blockers'}, then starts from here.`
    : x.k === 'stuck' ? ` It is still held outside this batch: moving it does not start it.`
      : x.k === 'needs' ? ' It still needs you first.' : x.k === 'queued' ? ' It still waits for triage.' : '';
  return `${key} → position ${n} of ${last}, placed by you.${why}`;
}

// Above the repo's cap is refused, with what raising the cap would take; above the machine's total
// goes ahead with a warning, since the memory gate still holds back spawns.
function setWorkers(repos, r, word) {
  const n = /^\d+$/.test(word) ? Number(word) : NaN;
  if (!Number.isInteger(n)) throw new Usage(`Workers must be a whole number from 0 to ${r.cap}. Nothing changed.`);
  const total = liveAllowed(repos.filter((x) => x !== r)) + n;
  const cap = machineCap();
  if (n > r.cap) {
    const block = { slug: r.slug, port: r.claim.port, last: r.claim.port + n };
    const standing = repos.filter((x) => !x.batch);
    const clash = portClashes(block, standing.map((x) => x.claim)).map((c) => `${standing.find((x) => x.slug === c.slug).name} (${c.port}–${c.last})`);
    throw new Usage(`${r.repo}'s cap is ${r.cap}, so ${n} workers is refused: nothing changed. `
      + `A cap of ${n} is an edit to §3b "Autopilot worker concurrency" in ${join(deskConfigRoot(), 'repos', r.slug, 'config.md')}. `
      + `It would hold ports ${block.port} to ${block.last}, ${clash.length ? `overlapping ${clash.join(' and ')}` : 'clear of every other repo'}, `
      + `and live batches would then allow ${total} against this machine's ${cap ?? '? (no machine profile)'}.`);
  }
  const was = r.workers;
  queueCmd(r, ['set-batch', `concurrency=${n}`, 'concurrency_by=user']);
  return `${r.name}: workers ${was} → ${n} (cap ${r.cap}), set by you. The next pass uses it.`
    + (n === 0 ? ' No new workers start, and running ones finish.' : '')
    + (cap != null && total > cap ? ` Live batches now allow ${total}, over this machine's ${cap}: allowed, and the memory gate holds new workers below ${gateGiB(repos)} GiB free.` : '');
}

// One confirmation line, or a Usage refusal that says what to do instead.
function apply(repos, v) {
  const r = repos.find((x) => x.id === v.slug);
  if (v.kind === 'supervisor') return supervisor(r, v.op);
  return v.kind === 'workers' ? setWorkers(repos, r, v.n) : moveTicket(r, v.key, v.verb, v.to);
}

// ---- the supervisor ----------------------------------------------------------------------------

export const NEEDS_LAUNCHD = 'The supervisor needs macOS launchd, so it cannot run on this computer. Nothing changed.';

// The named repo's own checkout, { cwd, env }, so a child run there acts as that repo (its slug,
// config and GitHub repo) and not as the one this process runs in. `doing` ends the refusal.
export function checkoutOf(r, doing) {
  const root = expandHome(repoConfigValue(r.slug, 'repo-root') ?? '');
  if (!root || /^(TODO|none)$/i.test(root)) throw new Usage(`${r.name}'s config has no §2 Primary repo root, so desk-q cannot find the repo to ${doing} in. Nothing changed.`);
  if (!existsSync(root)) throw new Usage(`${r.name}'s §2 Primary repo root, ${root}, does not exist here. Nothing changed.`);
  return { cwd: root, env: { ...otherRepoEnv(), DESK_REPO_DIR: root, DESK_REPO_ROOT: root } };
}

// supervisor.mjs, run in the named repo's own checkout, so its slug, state and queue are that repo's.
function supervisorRunner(r) {
  const { cwd, env } = checkoutOf(r, 'run its supervisor');
  return (sub, args) => supervisorRun(sub, args, { cwd, env: { ...env, DESK_AUTOPILOT_STATE: r.stateDir, DESK_QUEUE: r.queuePath } });
}

function supervisorState(r, run = supervisorRunner(r)) {
  const s = readSupervisorState(run);
  if (!s.state) throw new Usage(`${r.name}: could not read the supervisor's status: ${s.err}`);
  return s;
}

// `on` and `off` say what changed in one line; a refusal or a failure says nothing changed.
function supervisor(r, op) {
  if (platform() !== 'darwin') {
    if (op === 'status') return `${r.name}: no supervisor. ${NEEDS_LAUNCHD.replace(' Nothing changed.', '')}`;
    throw new Usage(NEEDS_LAUNCHD);
  }
  const run = supervisorRunner(r);
  const was = supervisorState(r, run);
  if (op === 'status') {
    const state = { loaded: `on: installed and loaded, a pass every ${was.every}s`,
      installed: `installed but not loaded, so no passes run. Turn it on: desk-q ${r.name} supervisor on`,
      none: `off: not installed. Turn it on: desk-q ${r.name} supervisor on` }[was.state];
    return `${r.name}: the supervisor is ${state}.\n${was.last ? `Last log line: ${was.last}` : 'No supervisor log yet.'}`;
  }
  if (op === 'on') {
    if (was.state === 'loaded') return `${r.name}: the supervisor is already on, a pass every ${was.every}s. Nothing changed.`;
    const s = turnOn(was, run);
    if (s.code !== 0) {
      throw new Usage(`${r.name}: the supervisor could not be turned on: ${s.err}. It is ${was.state === 'none' ? 'still off' : 'still installed but not loaded'}.`);
    }
    const every = /every (\d+)s/.exec(s.out.join(' '))?.[1];
    return `${r.name}: supervisor on. It runs a pass ${every ? `every ${every}s ` : ''}and at login, for a batch handed over at Stage 4.`;
  }
  if (was.state === 'none') return `${r.name}: the supervisor is already off. Nothing changed.`;
  const s = run('uninstall');
  if (s.code !== 0) throw new Usage(`${r.name}: the supervisor could not be turned off: ${s.err}. It is still ${was.state === 'loaded' ? 'on' : 'installed'}.`);
  return `${r.name}: supervisor off. No further passes run, and running workers carry on to their end (so does a merge driver it started).`;
}

function checkFlags(argv) {
  const unknown = argv.filter((a) => a.startsWith('--') && !['--plain', '--all', '--help'].includes(a));
  if (unknown.length) throw new Usage(`Unknown option ${unknown.join(' ')}. Options: --plain, --all.`);
}

function loadOrRefuse(now) {
  const repos = loadRepos(now);
  if (!repos.length) throw new Usage('No repo is set up for desk on this machine. Run /desk-setup in a repo first.');
  return repos;
}

export function run(argv, { now = Date.now() } = {}) {
  if (argv.includes('--help')) return 'usage: desk-q [--plain] [--all] | desk-q [--plain] <repo> [show <KEY>] | desk-q ships|days [<repo>] | desk-q costs [<repo>]\n'
    + '       desk-q <repo> up|down|top|bottom <KEY> | desk-q <repo> move <KEY> <n> | desk-q <repo> workers <n>\n'
    + '       desk-q <repo> supervisor [on|off]';
  checkFlags(argv);
  const repos = loadOrRefuse(now);
  const v = target(repos, argv);
  if (v.kind === 'supervisor') return apply(repos, v);
  if (v.kind === 'overview') return overview(repos, { all: v.all, now });
  // Piped, the Timeline is drawn as plain text; --plain asks for the one-line-per-ticket list instead.
  if (v.kind === 'timeline') return argv.includes('--plain') ? shipsScreen(repos, v.slug, { now }) : timelineScreen(repos, v.slug, { now });
  if (v.kind === 'days') return daysScreen(repos, v.slug, { now });
  if (v.kind === 'costs') return v.name !== undefined ? supplierScreen(repos, v.name, { now, label: v.label ?? v.name }) : costsScreen(repos, { now });
  if (isWrite(v)) {
    const said = apply(repos, v);
    const after = loadOrRefuse(now);
    return `${said}\n\n${repoScreen(after.find((x) => x.id === v.slug), { now, usage: usageOf(after, now, after.filter((x) => x.id === v.slug)) })}`;
  }
  const r = repos.find((x) => x.id === v.slug);
  return v.kind === 'repo' ? repoScreen(r, { now, usage: usageOf(repos, now, [r]) }) : ticketScreen(r, v.key, { now });
}

// ---- the interactive screen --------------------------------------------------------------------

export const REFRESH_MS = 2000;
const LOG_LINES = 40;
const MOVE_KEYS = 'shift+↑↓ move · t top · b bottom · + − workers';
// The question before the supervisor goes off, in the terminal's own text colour with its keys bold.
export const askLine = (name) => segLine([[`Turn off the supervisor for ${name}? Running workers finish.  `, null], ['y', BOLD], [' / ', null], ['n', BOLD]]);
const ESC = '\x1b[';
// Mouse reporting in SGR form (1000 + 1006), so a click on the breadcrumb, a tab or a row arrives
// as ESC [ < button ; column ; row M.
const ENTER_SCREEN = `${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`;
export const LEAVE_SCREEN = `${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`;
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL_MS = 30;
const REVERSE = '7';
// The views every place but a ticket has, in the order Tab and the number keys take them. An epic
// has every one but Epics and Costs, and a name whose repo isn't set up here has only Costs.
export const VIEWS = [['queue', 'Queue'], ['timeline', 'Timeline'], ['days', 'By day'], ['epics', 'Epics'], ['costs', 'Costs']];
const VIEW_KEYS = '←→ or 1–5 view';
export const REORDER_HERE = 'Reorder on the Queue view (press 1). The dates follow.';
// An epic's Queue hides the tickets a move steps past, so the order is set on the repo's.
export const REORDER_IN_REPO = "Reorder on the repo's Queue (esc, then 1). The dates follow.";
export const NO_EPICS_HERE = "An epic has no Epics view: you're already in one.";
export const NO_COSTS_HERE = "An epic has no Costs view: its repo's is esc, then 5.";
export const onlyCosts = (name) => `${name} isn't set up in desk here, so it has only Costs.`;

function jiraUrlFor(slug, key) {
  const site = repoConfigValue(slug, 'jira-site');
  if (!site || /^none$/i.test(site)) return null;
  return `https://${site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/browse/${key}`;
}

function systemOpener(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const p = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
}

// Log text can carry a worker's own escape codes; only printable text reaches the screen.
const printable = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '');

// The selected row's background: on a dark theme 256-colour 236, a tint dark enough that grey 247 and
// every state colour keep 4.5:1 on it; on a light theme 254, on which grey 240 keeps it.
const SELECT_BG = LIGHT ? '48;5;254' : '48;5;236';
// What undoes each code that sets more than a colour; a colour alone is undone by 39, and a dimmed
// colour by 22;39.
const OFF = { [BOLD]: '22', [FAINT]: '22', [REVERSE]: '27', [YOU_BOLD]: '22;39', [BAND]: '22;27;39' };
// Under NO_COLOR, grey is drawn faint, bold magenta bold and the band reversed.
const NO_COLOR_AS = { [GREY]: FAINT, [YOU_BOLD]: BOLD, [BAND]: REVERSE };

// A row cut to `w` columns as `cut` would, `›` in its first column when selected, then each coloured
// run wrapped in its SGR code. Each code is undone on its own (22 or 39), so a selected row's
// background holds across the runs, and its erase to the end of the line (ESC [K, which the
// terminal fills with the current background) carries the tint across the full width.
// NO_COLOR drops the colours and keeps bold, faint and reverse, and selects in reverse video.
function paint(x, w, selected) {
  const plain = !!process.env.NO_COLOR;
  let segs = (x.segs ?? [[x.line, null]]).map(([s, k]) => [s, k]);
  if (selected) segs[0][0] = `›${segs[0][0].slice(1)}`;
  if (x.line.length > w) {
    const kept = [];
    let room = w - 1;
    for (const [s, k] of segs) { if (room <= 0) break; kept.push([s.slice(0, room), k]); room -= s.length; }
    segs = [...kept, ['…', null]];
  }
  const out = segs.map(([s, k0]) => {
    const k = plain ? NO_COLOR_AS[k0] ?? k0 : k0;
    return k && s && !(plain && ![BOLD, FAINT, REVERSE].includes(k)) ? `${ESC}${k}m${s}${ESC}${OFF[k] ?? (k.startsWith(`${FAINT};`) ? '22;39' : '39')}m` : s;
  }).join('');
  if (!selected) return out;
  return plain ? `${ESC}7m${out}${ESC}27m` : `${ESC}${SELECT_BG}m${out}${ESC}K${ESC}49m`;
}
// A line already erased to its end in the selection's tint; another erase would clear the tint.
const tinted = (l) => l.endsWith(`${ESC}K${ESC}49m`);
// A screen row a command too wide for the terminal runs on into (draw).
const SPILL = Symbol('spill');

// A row the selection can land on: a heading row has no id.
const pickable = (x) => x?.id != null;
// The next selectable row from `i` in direction `d` (1 or -1), or null with none that way.
function step(rows, i, d) {
  for (let j = i + d; j >= 0 && j < rows.length; j += d) if (pickable(rows[j])) return j;
  return null;
}

// A keys line, each key bold: "↑↓ select · enter open · q quit". One wider than the terminal goes on
// two, "move" (select, open, view, back, scroll) then "act" (the rest), each breaking between keys
// rather than losing the last ones.
const KEY = /^(←→ or 1–5|\+ −|\S+) (.+)$/;
const MOVES_ON = /^(select|open(?! the bill)|view|back|scroll)\b/;
function keyLines(s, w) {
  const items = s.split(' · ').map((k) => { const m = KEY.exec(k); return m ? [m[1], m[2]] : [k, '']; });
  const text = (list) => list.map(([k, d]) => (d ? `${k} ${d}` : k)).join(' · ');
  const line = (lead, list) => segLine([[lead, DIM], ...list.flatMap(([k, d], i) => [...(i ? [[' · ', null]] : []), [k, BOLD], [d ? ` ${d}` : '', null]])]);
  if (text(items).length <= w) return [line('', items)];
  return [['move  ', items.filter(([, d]) => MOVES_ON.test(d))], ['act   ', items.filter(([, d]) => !MOVES_ON.test(d))]].flatMap(([lead, list]) => {
    const out = [];
    let cur = [];
    for (const it of list) {
      if (cur.length && lead.length + text([...cur, it]).length > w) { out.push(line(out.length ? ' '.repeat(lead.length) : lead, cur)); cur = []; }
      cur.push(it);
    }
    if (cur.length) out.push(line(out.length ? ' '.repeat(lead.length) : lead, cur));
    return out;
  });
}

// Labels joined by `sep`, each with the columns it covers (from, up to end), so a click's column
// finds its label.
function spans(parts, sep) {
  let at = 0;
  return parts.map((p, i) => { const from = at + (i ? sep.length : 0); at = from + p.label.length; return { ...p, from, end: at }; });
}

// A Timeline or By day view names its place by repo, or every repo, as the screen does.
// A name's Costs are its repo's place, or with no repo in desk a place of their own.
const placeOf = (v) => (v.kind === 'timeline' || v.kind === 'days'
  ? { place: v.slug ? { kind: 'repo', slug: v.slug } : { kind: 'overview', all: false }, tab: v.kind }
  : v.kind === 'costs' ? { place: v.slug ? { kind: 'repo', slug: v.slug } : v.name ? { kind: 'cost', name: v.name } : { kind: 'overview', all: false }, tab: 'costs' }
    : { place: v, tab: null });

// The full-screen view is a place (every repo, a repo, an epic, a ticket) and, for every place but a
// ticket, a view of it: Queue, Timeline, By day or Epics. Tab, 1–4, w and a click on the tab line change the view
// and keep the place; Enter, Esc and a click on the breadcrumb change the place and keep the view.
// ↑↓ select, : takes a command, q quits. Rereads the queues every REFRESH_MS, keeping the selection
// on the same repo or ticket.
export function interactive({
  input = process.stdin, output = process.stdout, start = { kind: 'overview', all: false },
  opener = systemOpener, exit = (c) => process.exit(c), refreshMs = REFRESH_MS, clock = Date.now,
  probeMs = PROBE_EVERY_MS, probeWith = probe, costWith = startRefresh,
} = {}) {
  let repos = loadOrRefuse(clock());
  // On a screen too tall to fit, `scroll` is its first line shown when it has no rows to select,
  // and how far past the selection it shows when it has.
  // `tab`: the view, one of VIEWS, kept across every change of place.
  // `checkin`: tickets waiting on the user are dated as if answered at the next check-in (c).
  // `zoom`: the Timeline's scale, z cycling it; back to auto whenever the place changes.
  // `layout`: where the last draw put the breadcrumb, the tabs and the rows, for a click to find them.
  // `ask`: a change waiting on y or n, shown in place of the keys; nothing else acts until it is answered.
  // `unfold`: what a, y and f show in full on a ticket's page; folded again whenever the place changes.
  let view = null, tab = 'queue', sel = 0, selId = null, scroll = null, msg = '', cmd = null, ask = null, screen = null, done = false, timer = null, probeTimer = null, checkin = false, zoom = 'auto', layout = null;
  let unfold = new Set();
  const stack = [];
  const width = () => Math.max(20, output.columns || 80);
  const height = () => Math.max(5, output.rows || 24);
  // A place's `slug` is its batch row's id: the repo's slug for its standing batch.
  const repoOf = (slug) => repos.find((r) => r.id === slug);
  const hasTabs = () => ['overview', 'repo', 'epic', 'cost'].includes(view.kind);
  const tabOk = (id) => (view.kind === 'cost' ? id === 'costs' : view.kind !== 'epic' || !['epics', 'costs'].includes(id));
  // The supplier screen: Costs on a repo's place or a name's own.
  const bySupplier = () => tab === 'costs' && ['repo', 'cost'].includes(view.kind);
  const costName = () => (view.kind === 'cost' ? view.name : costNameOf(readCosts(costsPath()), repoOf(view.slug)?.slug));
  // A view the new place lacks gives way to its nearest: Costs to the Queue, Epics to the Timeline.
  const keepTab = () => { if (!tabOk(tab)) tab = tab === 'costs' ? 'queue' : 'timeline'; };
  const epicFacts = () => { const r = repoOf(view.slug); return r?.q ? forecastOf(r, { now: clock(), checkin }) : null; };
  // The parked note is shown while any ticket in view waits on the user, or c is on.
  const badge = (rs) => (checkin || rs.some((r) => count(r, 'needs') > 0) ? parkedBadge(checkin) : '');

  // The breadcrumb's parts, each with the place a click on it goes to; the last is where you are.
  function crumbParts() {
    const r = view.slug ? repoOf(view.slug) : null;
    const parts = [{ label: 'desk-q', to: { kind: 'overview', all: false } }];
    // A repo's Costs sit under home's: "desk-q › costs › voicepa".
    if (bySupplier()) return spans([...parts, { label: 'costs', to: { kind: 'costs' } }, { label: view.kind === 'cost' ? view.name : r?.name ?? view.slug, to: null }], ' › ');
    if (view.slug) parts.push({ label: r?.name ?? view.slug, to: { kind: 'repo', slug: view.slug } });
    if (view.epic) parts.push({ label: cut(epicShort(epicFacts()?.epics?.[view.epic] ?? { key: view.epic }), 40), to: { kind: 'epic', slug: view.slug, epic: view.epic } });
    if (view.key) parts.push({ label: view.key, to: { kind: 'ticket', slug: view.slug, key: view.key, ...(view.epic ? { epic: view.epic } : {}) } });
    if (view.kind === 'log') parts.push({ label: 'log', to: null });
    if (view.kind === 'overview' && tab === 'costs') parts.push({ label: 'costs', to: null });
    return spans(parts, ' › ');
  }

  // "1 Queue  2 Timeline  3 By day  4 Epics", the view shown in reverse video and one this place
  // lacks dimmed.
  const tabParts = () => spans(VIEWS.map(([id, label], i) => ({ label: `${i + 1} ${label}`, id })), '  ');

  function build() {
    const now = clock();
    const w = width();
    const r = view.slug ? repoOf(view.slug) : null;
    const esc = view.kind === 'overview' ? '' : 'esc back · ';
    const cmdKeys = `: command · ${esc}q quit`;
    if (view.slug && !r) return { head: ['That repo is no longer set up here.'], rows: [], foot: [], keys: cmdKeys };
    keepTab();
    // The Claude usage line is pinned above the keys, not in the header: every repo shown on home,
    // one repo's own, or none for a repo with no batch.
    const claude = (shown) => (shown ? { usage: usageLine(usageOf(repos, now, shown), { now, solid: !process.env.NO_COLOR }) } : {});
    const own = r?.q && !r.error ? [r] : null;
    if (view.kind === 'epic' && !epicIn(r, epicFacts(), view.epic)) return { head: [`${view.epic} has no unfinished tickets in ${r.name}'s queue.`], rows: [], foot: [], keys: cmdKeys };
    // Costs carry the Claude usage line but none of home's batch lines.
    if (bySupplier()) return { badge: '', ...supplierParts(repos, costName(), { now, pinUsage: true, width: w, label: r?.repo }), ...claude(shownRepos(repos, false)), keys: `↑↓ select · ${VIEW_KEYS} · o open the bill · ${cmdKeys}` };
    if (tab === 'costs') return { badge: '', ...costsParts(repos, { now, pinUsage: true, width: w }), ...claude(shownRepos(repos, false)), keys: `↑↓ select · enter open · ${VIEW_KEYS} · o open the bill · ${cmdKeys}` };
    if (tab !== 'queue' && hasTabs()) {
      const tl = tab === 'timeline';
      const opts = { now, width: w, checkin, zoom, epic: view.epic ?? null, pinUsage: true };
      const parts = tl ? timelineParts : tab === 'days' ? daysParts : epicsParts;
      return { badge: badge(r ? [r] : repos), ...parts(repos, view.slug ?? null, opts), ...claude(r ? own : shownRepos(repos, false)),
        keys: `↑↓ select · enter open · ${VIEW_KEYS} · ${tl ? 'z scale · ' : ''}c parked dates · ${cmdKeys}` };
    }
    if (view.kind === 'overview') {
      // Home's parked note goes in its notes, not on the tab line, where a 100-column terminal cuts it.
      return { badge: '', ...overviewParts(repos, { all: view.all, now, interactive: true, checkin, width: w, badge: badge(repos), pinUsage: true }), ...claude(shownRepos(repos, view.all)),
        keys: `↑↓ select · enter open · ${VIEW_KEYS} · a ${view.all ? 'hide repos with no batch' : 'all repos'} · c parked dates · s supervisor · ${cmdKeys}` };
    }
    if (view.kind === 'repo') return { badge: badge([r]), ...repoParts(r, { now, width: w, checkin, pinUsage: true }), ...claude(own), keys: `↑↓ select · enter open · ${VIEW_KEYS} · ${r.q ? `${MOVE_KEYS} · c parked dates · ` : ''}${cmdKeys}` };
    if (view.kind === 'epic') return { badge: badge([r]), ...repoParts(r, { now, width: w, checkin, epic: view.epic, pinUsage: true }), ...claude(own), keys: `↑↓ select · enter open · ${VIEW_KEYS} · c parked dates · ${cmdKeys}` };
    if (!r.q?.tickets?.[view.key]) return { head: [`${view.key} is no longer in ${r.name}'s queue.`], rows: [], foot: [], keys: cmdKeys };
    if (view.kind === 'log') {
      const p = logPath(r, view.key);
      const lines = readFileSync(p, 'utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      const last = lines.slice(-LOG_LINES).map(printable);
      const k = shownState(r.q, r.q.tickets[view.key], r.ctx);
      return { head: [segLine([[view.key, BOLD], ['  ', null], [LABEL[k], STATE_SGR[k] ?? null]]), dim(`Last ${last.length} lines of ${p}`), ''], rows: [], foot: last, keys: '↑↓ scroll · esc back · q quit', bottom: true };
    }
    const jira = jiraUrlFor(r.slug, view.key);
    const s = ticketParts(r, view.key, { width: w, jiraUrl: jira, now, checkin, open: unfold });
    const pr = prToOpen(r, view.key, selId);
    const fold = [['a', 'blockers'], ['y', 'why lane'], ['f', 'files']].filter(([k]) => s.can[k]).map(([k, d]) => `${k} ${unfold.has(k) ? `fold ${d}` : d} · `).join('');
    const keys = `${s.rows.some(pickable) ? '↑↓ select a blocker · enter open it · ' : ''}${fold}${MOVE_KEYS} · l log · ${jira ? 'o Jira · ' : ''}${pr ? `g open #${pr.pr} · ` : ''}c parked dates · ${cmdKeys}`;
    return { badge: badge([r]), ...s, keys };
  }

  function draw() {
    if (done) return;
    try { screen = build(); } catch (e) { screen = { head: [`Could not draw this screen: ${describeCrash(e)}`], rows: [], foot: [], keys: 'esc back · q quit' }; }
    const { rows } = screen;
    if (selId != null) { const i = rows.findIndex((x) => x.id === selId); if (i >= 0) sel = i; }
    sel = Math.max(0, Math.min(sel, rows.length - 1));
    // A heading is never selected: the selection goes on to the row below it, else the one above.
    if (rows[sel] && !pickable(rows[sel])) sel = step(rows, sel, 1) ?? step(rows, sel, -1) ?? sel;
    selId = rows[sel]?.id ?? null;
    const w = width(), h = height();
    const fit = (l) => (typeof l === 'string' ? cut(l, w) : paint(l, w, false));
    // The breadcrumb and the tab line stay at the top while the rest scrolls. A ticket has no tab
    // line, so its parked note follows the breadcrumb. The breadcrumb's last part, where you are, is
    // bold and the parts above it dim.
    const cp = crumbParts();
    const crumbs = segLine([...cp.flatMap((p, i) => [...(i ? [[' › ', DIM]] : []), [p.label, i === cp.length - 1 ? BOLD : DIM]]), [' · ', DIM], [hhmm(clock()), null]]);
    const pinned = [];
    if (hasTabs()) {
      const segs = tabParts().flatMap((p, i) => [...(i ? [['  ', null]] : []), [p.label, p.id === tab ? REVERSE : tabOk(p.id) ? null : DIM]]);
      // A parked note too long to follow the tabs goes on its own line below them, so its key is kept.
      const tabsWide = segs.map((s) => s[0]).join('').length;
      const own = screen.badge && tabsWide + 4 + screen.badge.length > w;
      if (screen.badge && !own) segs.push([`    ${screen.badge}`, null]);
      pinned.push(fit(crumbs), paint({ segs, line: segs.map((s) => s[0]).join('') }, w, false), ...(own ? [fit(screen.badge)] : []));
    } else pinned.push(fit(screen.badge ? segLine([...crumbs.segs, [`    ${screen.badge}`, null]]) : crumbs));
    // A command to copy (`whole`) wider than the terminal is not cut: it runs on into the rows below,
    // which the terminal wraps it onto, so a copy takes it whole. Each row it runs on to is a SPILL.
    const lay = (l) => {
      if (!l?.whole || l.line.length <= w) return [fit(l)];
      const n = Math.ceil(l.line.length / w);
      return [{ full: paint(l, Infinity, false), cut: fit(l), n }, ...Array(n - 1).fill(SPILL)];
    };
    const head = screen.head.flatMap(lay);
    const body = ['', ...head, ...rows.map((x, i) => paint(x, w, i === sel && pickable(x))), ...screen.foot.flatMap(lay)];
    // A message can be longer than the line (a refused raise says what raising the cap takes). The
    // Claude usage line stays put above it and the keys, a blank line between.
    const status = [...(screen.usage ? [fit(screen.usage), ''] : []), ...[...wrap(msg, w), ...(ask ? [askLine(ask.name)] : cmd != null ? [`:${cmd}`] : keyLines(screen.keys, w))].filter(Boolean).map(fit)];
    const room = Math.max(1, h - status.length - pinned.length);
    const first = 1 + head.length;
    let top = 0;
    if (body.length > room) {
      const max = body.length - room;
      const clamp = (n) => Math.max(0, Math.min(max, n));
      if (rows.length) {
        // Centred on the selection; `scroll` is how far ↓ on the last row has read on past it.
        const base = clamp(first + sel - Math.floor(room / 2));
        top = clamp(base + (scroll ?? 0));
        scroll = top - base;
      } else top = scroll = clamp(scroll ?? (screen.bottom ? max : 0));
    } else if (rows.length) scroll = 0;
    const shown = body.slice(top, top + room);
    while (shown.length < room) shown.push('');
    layout = { pinned: pinned.length, top, room, first, rows: rows.length };
    // A whole line is written in full only where every row it runs on to is shown, else cut; a SPILL
    // whose line scrolled off is a blank row.
    const out = [];
    for (let i = 0; i < shown.length; i++) {
      const l = shown[i];
      if (l === SPILL) out.push('');
      else if (typeof l === 'object') {
        const runOn = shown.slice(i + 1, i + l.n);
        const whole = runOn.length === l.n - 1 && runOn.every((s) => s === SPILL);
        out.push(whole ? l.full : l.cut);
        if (whole) i += l.n - 1;
      } else out.push(l);
    }
    output.write(`${ESC}H${[...pinned, ...out, ...status].map((l) => (tinted(l) ? l : `${l}${ESC}K`)).join('\r\n')}${ESC}J`);
  }

  // A new place pushes the one you were on, so Esc comes back to it with its selection; the view
  // stays whatever it is. A Timeline or By day row opening a repo opens that repo's same view, and an
  // Epics row opens its epic's Timeline.
  function go(v) {
    const p = placeOf(v);
    stack.push({ view, sel, selId, tab });
    view = p.place; if (p.tab) tab = p.tab;
    keepTab();
    sel = 0; selId = null; scroll = null; msg = ''; zoom = 'auto'; unfold = new Set();
  }
  // The selection comes back only to the view it was made on: another view's rows are other rows.
  // Up from a repo's Costs, home's Costs select that repo's row.
  function back() {
    const p = stack.pop();
    const name = bySupplier() ? costName() : null;
    if (p) { view = p.view; keepTab(); if (p.tab === tab) ({ sel, selId } = p); else { sel = 0; selId = null; } }
    if (name && view.kind === 'overview' && tab === 'costs') { sel = 0; selId = `cost ${name}`; }
    scroll = null; msg = ''; zoom = 'auto'; unfold = new Set();
  }
  // A place reached directly (the command line, :, the breadcrumb) gets the places above it to Esc to.
  function goPlace(v) {
    const p = placeOf(v);
    if (p.tab) tab = p.tab;
    stack.length = 0;
    const up = (u) => stack.push({ view: u, sel: 0, selId: null, tab });
    const { kind, slug, epic, key } = p.place;
    if (kind !== 'overview') up({ kind: 'overview', all: false });
    if (['epic', 'ticket', 'log'].includes(kind)) up({ kind: 'repo', slug });
    if (epic && kind !== 'epic') up({ kind: 'epic', slug, epic });
    if (kind === 'log') up({ kind: 'ticket', slug, key, ...(epic ? { epic } : {}) });
    view = p.place; sel = 0; selId = null; scroll = null; msg = ''; zoom = 'auto'; unfold = new Set();
    keepTab();
  }
  // A view this place lacks leaves the view as it is and says why.
  function setTab(id) {
    if (!tabOk(id)) { msg = view.kind === 'cost' ? onlyCosts(view.name) : id === 'costs' ? NO_COSTS_HERE : NO_EPICS_HERE; return; }
    tab = id; sel = 0; selId = null; scroll = null; msg = '';
  }

  // A left click on the breadcrumb goes to that place, on the tab line to that view, on a row
  // selects and opens it. The wheel moves the selection as the arrows do.
  function onMouse(b, x, y) {
    if (done || !layout || cmd != null || ask) return;
    if (b === 64 || b === 65) return onKey(undefined, { name: b === 64 ? 'up' : 'down' });
    if ((b & ~(4 | 8 | 16)) !== 0) return;
    const col = x - 1, line = y - 1;
    const hit = (parts) => parts.find((p) => col >= p.from && col < p.end);
    if (line === 0) {
      const parts = crumbParts(), p = hit(parts);
      if (!p || p === parts.at(-1) || !p.to) return;
      goPlace(p.to);
    } else if (line === 1 && hasTabs()) {
      const p = hit(tabParts());
      if (!p) return;
      setTab(p.id);
    } else {
      const i = line - layout.pinned + layout.top - layout.first;
      if (line < layout.pinned || line >= layout.pinned + layout.room || i < 0 || i >= layout.rows || !pickable(screen.rows[i])) return;
      sel = i; selId = screen.rows[i]?.id ?? null;
      const o = screen.rows[i]?.open;
      if (o) go(o);
    }
    draw();
  }

  // Mouse reports are taken out of the input before readline reads it for keys, which would
  // otherwise split one into stray keypresses. A read ending in what may be the start of one (ESC,
  // ESC [, ESC [ < …) waits for the next read; with none within PARTIAL_MS it goes on to readline
  // as keys, so a lone Esc still arrives.
  const keys = new PassThrough();
  let partial = '', flush = null;
  function onData(chunk) {
    clearTimeout(flush);
    let s = partial + String(chunk);
    const cutAt = s.search(/\x1b(\[(<[\d;]*)?)?$/);
    partial = cutAt >= 0 ? s.slice(cutAt) : '';
    if (cutAt >= 0) s = s.slice(0, cutAt);
    const clicks = [];
    s = s.replace(MOUSE, (_, b, x, y, m) => { if (m === 'M') clicks.push([Number(b), Number(x), Number(y)]); return ''; });
    if (s) keys.write(s);
    for (const c of clicks) onMouse(...c);
    if (partial) flush = setTimeout(() => { const p = partial; partial = ''; if (!done) keys.write(p); }, PARTIAL_MS);
  }

  function finish(code) {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearInterval(probeTimer);
    clearTimeout(flush);
    input.removeListener('data', onData);
    keys.removeListener('keypress', onKey);
    output.removeListener?.('resize', draw);
    if (input.isTTY) input.setRawMode(false);
    input.pause?.();
    output.write(LEAVE_SCREEN);
    exit(code);
  }

  // A change, then the queues reread so the screen shows it; the message stays until the next view.
  function act(v) {
    try { msg = apply(repos, v); } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); }
    try { repos = loadOrRefuse(clock()); } catch (e) { msg = `${msg} Could not reread the queues: ${describeCrash(e)}`; }
  }

  function runCommand(line) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    try {
      checkFlags(words);
      const v = target(repos, words);
      if (v.kind === 'supervisor') act(v);
      else if (isWrite(v)) {
        // A change typed anywhere lands on that repo's Queue, with the moved ticket selected.
        if (!(view.kind === 'repo' && view.slug === v.slug && tab === 'queue')) { goPlace({ kind: 'repo', slug: v.slug }); tab = 'queue'; }
        if (v.key) selId = v.key;
        act(v);
      } else if (v.kind === 'overview' && view.kind === 'overview') { view = { ...view, all: v.all }; msg = ''; } else goPlace(v);
    } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); }
  }

  function onKey(str, key = {}) {
    if (done) return;
    if (key.ctrl && key.name === 'c') return finish(130);
    const rows = screen?.rows ?? [];
    if (cmd != null) {
      if (key.name === 'return' || key.name === 'enter') { const line = cmd; cmd = null; runCommand(line); }
      else if (key.name === 'escape') cmd = null;
      else if (key.name === 'backspace') cmd = cmd.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') cmd += str;
      return draw();
    }
    if (ask) {
      if (str === 'y') { const v = ask.v; ask = null; act(v); }
      else if (str === 'n' || key.name === 'escape') { ask = null; msg = ''; }
      else return;
      return draw();
    }
    // On a repo's Queue the selected ticket moves; on a ticket's screen, that ticket. On a Timeline
    // or By day nothing moves: the order is set on the Queue, and the dates follow from it.
    const queueView = (view.kind === 'repo' && tab === 'queue') || view.kind === 'ticket';
    const moveVerb = key.shift && key.name === 'up' ? 'up' : key.shift && key.name === 'down' ? 'down' : str === 't' ? 'top' : str === 'b' ? 'bottom' : null;
    const viewNo = VIEWS.findIndex((_, i) => str === String(i + 1));
    if (hasTabs() && key.name === 'tab') {
      const ok = VIEWS.filter(([id]) => tabOk(id));
      const i = ok.findIndex(([id]) => id === tab);
      setTab(ok[(i + (key.shift ? -1 : 1) + ok.length) % ok.length][0]);
    } else if (hasTabs() && (key.name === 'left' || key.name === 'right')) {
      // ← and → follow the tab bar and stop at its ends; Tab wraps.
      const ok = VIEWS.filter(([id]) => tabOk(id));
      const next = ok[ok.findIndex(([id]) => id === tab) + (key.name === 'left' ? -1 : 1)];
      if (next) setTab(next[0]);
    } else if (hasTabs() && viewNo >= 0) setTab(VIEWS[viewNo][0]);
    else if (hasTabs() && str === 'w') setTab('timeline');
    else if (view.kind === 'epic' && moveVerb) msg = REORDER_IN_REPO;
    else if (hasTabs() && tab !== 'queue' && moveVerb) msg = REORDER_HERE;
    else if (queueView && moveVerb) {
      const k = view.kind === 'ticket' ? view.key : rows[sel]?.id;
      if (k && repoOf(view.slug)?.q) act({ kind: 'move', slug: view.slug, key: k, verb: moveVerb });
    } else if (queueView && (str === '+' || str === '-')) {
      const r = repoOf(view.slug);
      if (r?.q) act({ kind: 'workers', slug: r.id, n: String(r.workers + (str === '+' ? 1 : -1)) });
      else msg = `${r?.name ?? view.slug} has no batch yet.`;
    } else if ((key.name === 'up' || key.name === 'down') && !rows.length) scroll = (scroll ?? 0) + (key.name === 'up' ? -1 : 1);
    else if (key.name === 'up' && scroll > 0) scroll -= 1;
    else if (key.name === 'down' && step(rows, sel, 1) == null) scroll = (scroll ?? 0) + 1;
    else if (key.name === 'up' || key.name === 'down') { sel = step(rows, sel, key.name === 'up' ? -1 : 1) ?? sel; selId = rows[sel]?.id ?? null; }
    else if (key.name === 'return' || key.name === 'enter') { const o = rows[sel]?.open; if (o) go(o); }
    else if (key.name === 'escape') back();
    else if (str === 'q') return finish(0);
    else if (str === ':') { cmd = ''; msg = ''; }
    else if (str === 'a' && view.kind === 'overview' && tab === 'queue') view = { ...view, all: !view.all };
    else if (['a', 'y', 'f'].includes(str) && view.kind === 'ticket' && screen?.can?.[str]) { if (!unfold.delete(str)) unfold.add(str); msg = ''; }
    else if (str === 's' && view.kind === 'overview' && tab === 'queue') {
      // Turning off asks first; turning on does not. The supervisor is the repo's: its standing batch's row.
      const r = repoOf(repoOf(rows[sel]?.id)?.slug);
      if (!r) return;
      const v = { kind: 'supervisor', slug: r.slug };
      let state = null;
      if (platform() !== 'darwin') msg = NEEDS_LAUNCHD;
      else { try { ({ state } = supervisorState(r)); } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); } }
      if (state === 'loaded') { ask = { name: r.repo, v: { ...v, op: 'off' } }; msg = ''; }
      else if (state) act({ ...v, op: 'on' });
    }
    else if (str === 'z' && hasTabs() && tab === 'timeline') { zoom = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length]; msg = ''; }
    else if (str === 'c' && view.kind !== 'log') {
      checkin = !checkin;
      msg = checkin ? 'Tickets that need your answer are now dated as if answered at the next check-in (08:00 or 17:00).' : 'Tickets that need your answer have no date until you answer them.';
    }
    else if (str === 'l' && view.kind === 'ticket') {
      const r = repoOf(view.slug);
      if (r && existsSync(logPath(r, view.key))) go({ ...view, kind: 'log' });
      else msg = `${view.key} has no log yet.`;
    } else if (str === 'o' && (bySupplier() || (view.kind === 'overview' && tab === 'costs'))) {
      const x = rows[sel];
      if (!x?.bill) msg = x ? `No billing page to open for ${x.id.replace(/^(cost|supplier) /, '')}.` : 'No row to open the bill of.';
      else { try { opener(x.bill); msg = `Opened ${x.bill}`; } catch (e) { msg = `Could not open ${x.bill}: ${describeCrash(e)}`; } }
    } else if (str === 'o' && view.kind === 'ticket') {
      const url = jiraUrlFor(repoOf(view.slug)?.slug ?? view.slug, view.key);
      if (!url) msg = `No Jira site in ${repoOf(view.slug)?.name ?? view.slug}'s config, so there is nothing to open.`;
      else { try { opener(url); msg = `Opened ${url}`; } catch (e) { msg = `Could not open ${url}: ${describeCrash(e)}`; } }
    } else if (str === 'g' && view.kind === 'ticket') {
      const r = repoOf(view.slug);
      const pr = r ? prToOpen(r, view.key, selId) : null;
      if (!pr) msg = `${view.key} has no PR in CI to open.`;
      else { try { opener(pr.url); msg = `Opened ${pr.url}`; } catch (e) { msg = `Could not open ${pr.url}: ${describeCrash(e)}`; } }
    } else return;
    draw();
  }

  goPlace(start);
  emitKeypressEvents(keys);
  if (input.isTTY) input.setRawMode(true);
  keys.on('keypress', onKey);
  input.on('data', onData);
  input.resume?.();
  output.on?.('resize', draw);
  output.write(ENTER_SCREEN);
  timer = setInterval(() => {
    try { repos = loadOrRefuse(clock()); } catch (e) { msg = `Could not reread the queues: ${describeCrash(e)}`; }
    draw();
  }, refreshMs);
  // Only while this screen is open: the usage probe, when no worker anywhere keeps the reading fresh,
  // and the cost cache's reading, workers or not.
  probeTimer = setInterval(() => {
    const now = clock();
    const running = repos.reduce((a, r) => a + count(r, 'running'), 0);
    if (probeDue({ running, reading: readUsage({ now }), now })) probeWith({ now, done: () => { if (!done) draw(); } }).catch(() => {});
    try { costWith({ now }); } catch { /* the next check tries again */ }
  }, probeMs);
  draw();
  return { finish };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  try {
    // A terminal on both ends gets the screen; anything piped, --plain and a change typed in the
    // shell get the plain output.
    let start = null;
    if (process.stdin.isTTY && process.stdout.isTTY && !argv.includes('--plain') && !argv.includes('--help')) {
      checkFlags(argv);
      start = target(loadOrRefuse(Date.now()), argv);
    }
    if (start && !isCommand(start)) {
      const ui = interactive({ start });
      process.on('SIGTERM', () => ui.finish(143));
      process.on('SIGHUP', () => ui.finish(129));
    } else console.log(run(argv));
  } catch (e) { console.error(e instanceof Usage ? e.message : describeCrash(e)); process.exit(1); }
}
