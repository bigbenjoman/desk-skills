#!/usr/bin/env node
// One orchestrator pass. Read state, advance it, report. Nothing else.
//
// This is deliberately a script rather than model instructions: the orchestrator's
// context must stay flat whether the batch has 2 tickets or 20, so the per-ticket
// detail lives here and only a summary reaches the conversation.
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, statSync, mkdirSync, openSync, closeSync, renameSync, readdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { uptime } from 'node:os';
import * as E from './desk-env.mjs';
import { batchIdle, batchSettled, batchConcurrency, waitingOnMerge, waitingOnPark, isHeld, spinePark, SPINE_APPROVAL_PREFIX, SPINE_SPECS_PREFIX, EXIT, crashShowsPerson, describeCrash, readQueue, Refusal, openQuestion, needsSession } from './batch-state.mjs';
import { checkSpine, spineMerger, checkChild, ownedIds, ownedSpecs, specFilesAt, specsCommand, EXPECTED_FAIL, CHILD_SPECS_PREFIX } from './spine-check.mjs';
import { ANSWER_HEAD, collectAnswers, capBriefing, MAX_BRIEF, BRIEF_CUT } from './briefing.mjs';
import { HANDOFF_STAGES, handoffStage, handoffPath, readHandoff, handoffTarget, branchCommits, renderHandoff,
  roundStage, resumeCheck, workerResumePath, answersSince, renderLastRound, renderNoResume } from './handoff.mjs';
import { workerMarkers, endedNormally } from './harvest.mjs';
import { parseDecision, parseCheck, decisionEntry, appendDecisions } from './decisions.mjs';
import { readRegister, lookup, parseInputs, refreshInputs, inputsHash } from './not-now.mjs';
import { checkinTimes, checkinRow, checkin, urgentParks, readDecisions, repos as digestRepos, digestDir } from './digest.mjs';
import { urgentPromotion, promotionRef } from './promotion.mjs';
import { incidentalGlobs, outOfScope, triagedScope, changedFiles, batchScopeTotals } from './scope-report.mjs';
import { batchCost, costTable, preflightLine } from './worker-cost.mjs';
import { ensureBaseWorktree, syncBase, openingCommit } from './base-sync.mjs';
import * as BL from './baseline.mjs';
import { renderLedger, syncLedger, ledgerHash } from './ledger.mjs';
import { usageLimit, resetText, limitName } from './usage-limit.mjs';
import { probeNow } from './usage-probe.mjs';
import { firstSpawnFromLogs, epicUnread, readHistory, buildHistory, ghMergedPrs, describe as describeHistory } from './desk-q-eta.mjs';
import { health } from './health.mjs';
import { readCloseouts } from './closeout.mjs';
import { parseClearsWhen, describeCond, checkCond } from './clears-when.mjs';
import { claimHours, transcriptOf, claimWorktree, uncommitted, claimQuestion } from './claims.mjs';
import { maintenance, stopForWindow } from './maintenance.mjs';
import { normaliseRollup, latestPerCheck, evaluateGate, parseFlaky, flakyWaiver, PR_FILES_JQ } from './gate.mjs';
import { undraftCall, undraftComment } from './undraft.mjs';
import { buildRecord, startBuild, markReran } from './check-build.mjs';
import { fixCall, fixBrief, fixTask, parseOperatorChecks, reviewFix, RERUN_COOLDOWN_S } from './fix-tries.mjs';
import { usagePace } from './usage-pace.mjs';
import { groupsNow } from './desk-q.mjs';
import { INTAKE_EVERY_MS } from './intake.mjs';
import { borrowSetting, borrowPlan, borrowedLine, otherBatches, otherQueues, machineBudget, machineCap, takeBorrowLock, beatFile, parseNext } from './borrow.mjs';

// The verdict is the exit code (EXIT): 0 something spawned, 10 nothing can spawn yet and nothing needs
// the person, 11 the person is needed (a parked or failed ticket, anything under WAITING ON YOU, a
// finished batch, or an error). With --json, stdout is one object carrying the same verdict.
const AS_JSON = process.argv.includes('--json');
const CODES = { go_on: EXIT.GO_ON, nothing_yet: EXIT.NOTHING_YET, show_person: EXIT.SHOW_PERSON, idle: EXIT.SHOW_PERSON, error: EXIT.SHOW_PERSON };
// The queue's `pass` record, for desk-q: who ran the last pass and when, what held its spawns, how many
// passes in a row have errored and the last error's first line, the last time a ticket started, merged
// or was released, and the tickets held and merged at that pass (a later pass that finds one no
// longer held counts it released, and one newly merged counts it merged). `session_at` is the last
// pass a session ran, kept through the supervisor's, so a session beside the supervisor shows. It is
// written once the queue reads, and never by a pass another orchestrator's lock refused.
let RECORDS = false;
function recordPass(f) {
  if (!RECORDS) return;
  try {
    const prev = readQueue(QUEUE_FILE).pass ?? {};
    const rec = { ...prev, at: PASS_AT, by: PASS_BY, ...(PASS_BY === 'session' ? { session_at: PASS_AT } : {}), ...f(prev) };
    execFileSync('node', [join(BIN, 'queue.mjs'), 'set-batch', `pass=${JSON.stringify(rec)}`], { stdio: 'ignore' });
  } catch { /* advisory: the verdict still goes out */ }
}
function verdict(status, message, fields = {}) {
  if (status === 'error') recordPass((prev) => ({ errors: (Number(prev.errors) || 0) + 1, error: String(message).trim().split('\n')[0] }));
  const code = CODES[status];
  if (AS_JSON) {
    console.log(JSON.stringify({ status, code, message, waiting: [], parked: [], notify: code === EXIT.SHOW_PERSON, push: [], release_due: [], stuck: [], on_park: [], ...fields }));
  } else if (status === 'error') console.error(message);
  else console.log(message);
  return code;
}
const refuse = (message) => process.exit(verdict('error', message));
crashShowsPerson((e) => verdict('error', e instanceof Refusal ? describeCrash(e) : `pass.mjs crashed: ${describeCrash(e)}`));

let MAIN; let WORKTREES;
// Before anything reads the default branch: a batch base (queue.mjs set-batch base=…) becomes
// DESK_DEFAULT_BRANCH here, and setup-worktree, spawn-worker and the worker all inherit it.
try { E.applyBatchBase(); MAIN = E.repoRoot(); WORKTREES = E.worktreesDir(); } catch (e) { refuse(e.message); }
const BIN = E.binDir();
const STATE = E.stateDir();
const QUEUE_FILE = E.queueFile();
const GH_REPO = E.ghRepo();
const DEFAULT_BRANCH = E.defaultBranch();
const DRY = !!process.env.AUTOPILOT_DRY_RUN;
// --next <+seconds | ISO time>: when the caller plans the pass after this one. The heartbeat records
// it, so desk-q counts the batch live through a wait longer than LIVE_MS.
const NEXT_AT = process.argv.indexOf('--next');
const NEXT = NEXT_AT < 0 ? null : parseNext(process.argv[NEXT_AT + 1]);
if (NEXT_AT >= 0 && NEXT == null) refuse(`--next wants +<seconds> or an ISO time, not "${process.argv[NEXT_AT + 1] ?? ''}"`);
// --by supervisor: the supervisor's tick started this pass; anything else is a session's.
const BY_AT = process.argv.indexOf('--by');
const PASS_BY = BY_AT < 0 ? 'session' : process.argv[BY_AT + 1];
if (!['supervisor', 'session'].includes(PASS_BY)) refuse(`--by wants supervisor or session, not "${PASS_BY ?? ''}"`);
const PASS_AT = new Date().toISOString();

if (!existsSync(QUEUE_FILE)) {
  refuse(`no queue at ${QUEUE_FILE} — run: node ${BIN}/queue.mjs init <batch-name>`);
}
// A corrupt queue refuses here, before the pass touches anything, rather than mid-pass as a stack.
try { readQueue(QUEUE_FILE); } catch (e) { refuse(describeCrash(e)); }
RECORDS = true;

// Headless workers cannot ask, so spawning needs the grant up front. Harvesting what is already
// running does not, so a revoked or unset grant stops spawns, never the report.
const headlessPerm = E.permission('autopilot-workers');
const HEADLESS_KEY = E.permissionKey('autopilot-workers');
const maySpawn = headlessPerm === 'yes' || (headlessPerm === 'ask' && !!process.env.AUTOPILOT_USER_APPROVED);
// Pushing a sync merge to the batch base is its own grant, unset meaning `ask`: one approval per
// batch, asked at Stage 3 and passed to every pass as AUTOPILOT_BASE_PUSH_APPROVED=1.
const basePushPerm = E.permissionOrUnset('batch-base-push') ?? 'ask';
const BASE_PUSH_KEY = E.permissionKey('batch-base-push');
const mayPushBase = basePushPerm === 'yes' || (basePushPerm === 'ask' && !!process.env.AUTOPILOT_BASE_PUSH_APPROVED);

// The orchestrator's own name, for the worker's briefing. Resolve it from this process's own
// session id, which Claude Code exports, and fall back to the env var. Nothing set the env var
// once, so every briefing said "nobody is listening" and told parked workers to give up.
function orchestratorName() {
  if (process.env.AUTOPILOT_ORCHESTRATOR) return process.env.AUTOPILOT_ORCHESTRATOR;
  try {
    const sid = process.env.CLAUDE_CODE_SESSION_ID;
    if (sid) {
      const live = JSON.parse(execFileSync('claude', ['agents', '--json'], { encoding: 'utf8' }));
      const me = Array.isArray(live) && live.find((a) => a.sessionId === sid);
      if (me?.name) return me.name;
    }
  } catch { /* fall through to the honest answer below */ }
  return '(unresolved — try ListAgents once before assuming nobody is listening)';
}

// Two orchestrators would both spawn against the same tickets. "Claim the queue" was documented
// and unenforced; this enforces it.
const LOCK = join(STATE, 'orchestrator.lock');
function claim() {
  mkdirSync(STATE, { recursive: true });
  if (existsSync(LOCK)) {
    try {
      const { pid, since } = JSON.parse(readFileSync(LOCK, 'utf8'));
      process.kill(pid, 0);                       // throws if that process is gone
      if (pid !== process.pid) {
        RECORDS = false;
        refuse(`another orchestrator holds the lock (pid ${pid}, since ${since}).\nif it is dead, remove ${LOCK}`);
      }
    } catch { /* stale lock from a dead process — take it */ }
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
}
claim();
process.on('exit', () => { try { if (JSON.parse(readFileSync(LOCK, 'utf8')).pid === process.pid) unlinkSync(LOCK); } catch { /* gone */ } });

// The lock only exists for the seconds a pass runs, so between passes a second batch's
// `queue.mjs init` could not see this orchestrator and reset the batch notes its workers still read.
// A heartbeat per queue file closes that window; queue.mjs treats one fresher than 15 minutes as live.
try {
  mkdirSync(join(STATE, 'orchestrators'), { recursive: true });
  writeFileSync(beatFile(STATE, QUEUE_FILE), JSON.stringify({
    queue: QUEUE_FILE, batch: JSON.parse(readFileSync(QUEUE_FILE, 'utf8')).batch ?? null, pid: process.pid, at: new Date().toISOString(),
    ...(NEXT == null ? {} : { next: new Date(NEXT).toISOString() }),
  }));
} catch { /* advisory */ }

const sh = (cmd, args, opts = {}) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim(); }
  catch (e) { return opts.tolerant ? '' : `ERROR: ${e.message}`; }
};
// Like sh, but keeps what the command printed when it fails — a refusal's reason is the report.
const shOut = (cmd, args, opts = {}) => {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim() }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message }; }
};
// A queue write that is refused (the queue locked past its wait, a bad value) goes in the report as
// a failure naming the ticket and the change: the pass carries on as if it had been made, so silence
// would hide a ticket whose recorded state is now wrong.
const q = (...args) => {
  const r = shOut('node', [join(BIN, 'queue.mjs'), ...args]);
  if (r.ok) return r.out;
  const change = args.slice(args[0] === 'set-batch' ? 1 : 2).join(' ');
  report.failed.push(`${args[0] === 'set-batch' ? 'batch' : args[1]}: queue write refused, not recorded — ${args[0]} ${change.length > 200 ? `${change.slice(0, 200)}…` : change} — ${r.out.split('\n').pop()}`);
  return '';
};
const queue = () => readQueue(QUEUE_FILE);

// ---- liveness ------------------------------------------------------------
// A failed registry read must never look like "everything finished" — that would
// re-spawn work already in flight — so a command that fails reads as no registry, not an empty one.
let live = null;
const registry = shOut('claude', ['agents', '--json']);
if (registry.ok) { try { live = JSON.parse(registry.out || '[]'); } catch { live = null; } }
const registryOk = Array.isArray(live);
const liveSids = new Set((registryOk ? live : []).map((a) => a.sessionId));

const Q = queue();
const rows = Object.values(Q.tickets);
const notes = [];
const report = { advanced: [], parked: [], done: [], failed: [], spawned: [], waiting: [], quiet: [], stalled: [], personStalls: [], outOfScope: [], paused: [], unrecognised: [], putOff: [], clears: [], inputs: [] };

// The "not now" register (not-now.mjs), read once a pass. An unreadable one puts nothing off, so every
// question is asked as it would be without one, and the person is told.
const REGISTER = readRegister(STATE);
if (!REGISTER.ok) report.waiting.push(`not-now register: unreadable (${REGISTER.why}), so every question is asked as usual. Fix or remove the file`);
// A park the person put off with the same inputs: it stays parked, and is not asked again.
const putOff = (t) => t.state === 'parked' && !!t.park?.question && !isHeld(t)
  && lookup(REGISTER, { question: t.park.question, inputs: t.park.inputs ?? {} }).status === 'put_off';

// The usage limit, any of them (usage-limit.mjs). A worker never gives up on one: the batch holds
// every spawn and resume, and a worker that ended its session at the limit stays running, paused, until
// the limit lifts: at its reset time, or sooner when the one probe call a held pass makes succeeds, as
// it does once the person switches subscription. A paused worker whose session is still live is quiet,
// not wedged, until this long after the reset; then the stall check runs as before.
const LIMIT_GRACE_MS = 30 * 60 * 1000;
let PROBE = null;
// At most one probe a pass, made only when something is held on the limit.
const probeOnce = () => (PROBE ??= probeNow());
const lifted = (l) => (l.resetsAt != null && Date.now() >= l.resetsAt * 1000) || probeOnce().ok;
const liftedHow = (l) => (l.resetsAt != null && Date.now() >= l.resetsAt * 1000 ? `its reset at ${resetText(l.resetsAt)} passed` : 'a probe call succeeded');
const untilText = (l) => (l.resetsAt != null ? ` until ${resetText(l.resetsAt)}` : '');
// The limits that hold this pass's spawns: each paused worker's, and the batch's own from a preflight
// the limit refused (the queue's usage_hold).
const usageHolds = [];

// Report only: the files a finished worker changed outside its triaged scope, kept on the ticket for
// the batch total. The ticket proceeds as it would anyway. A malformed §4 Incidental paths row is said
// once and read as its default rather than stopping the pass.
let incidental = incidentalGlobs(null);
let incidentalBad = null;
try { incidental = incidentalGlobs(E.configValues('incidental-paths')); } catch (e) { incidentalBad = e.message; }
function recordScope(t) {
  const scope = triagedScope(STATE, t.key);
  const changed = scope && t.worktree && existsSync(t.worktree) ? changedFiles(t.worktree, `origin/${DEFAULT_BRANCH}`) : null;
  if (!changed) return;
  const extra = outOfScope(changed, scope, incidental);
  q('set', t.key, `out_of_scope=${JSON.stringify(extra)}`);
  if (extra.length) report.outOfScope.push(`${t.key}: ${extra.join(', ')}`);
}
// A stall only the person can clear (a budget, a config row, a grant, a deliberate re-run), unlike low
// memory, which drains by itself.
const personStall = (line) => { report.stalled.push(line); report.personStalls.push(line); };
const uploadPerm = E.permission('pr-images');

// A feature spine that finishes is checked, then parked for the person rather than left done: its PR
// stays draft, and nothing held behind it is released until they approve it (queue.mjs approve).
const isSpine = (t) => Q.feature === true && Q.spine === t.key;
// §4 Acceptance specs: the spec directory and the command taking {ids}. Unset or unreadable, both are
// null, and each check names what is missing.
const acceptanceSpecs = () => {
  try {
    const s = E.configValues('acceptance-specs');
    if (s && !E.isNone(s)) return { specDir: s[0], cmd: s.find((x) => x.includes('{ids}')) ?? null };
  } catch { /* named where it is used */ }
  return { specDir: null, cmd: null };
};
function parkSpine(t, pr) {
  const { specDir } = acceptanceSpecs();
  const c = pr == null
    ? { ok: false, problems: ['it finished with no PR'] }
    : checkSpine({ worktree: t.worktree, base: DEFAULT_BRANCH, specDir, ids: Q.spine_ids });
  q('set', t.key, `spine_check=${JSON.stringify({ ok: c.ok, problems: c.problems, at: new Date().toISOString() })}`, 'approved=null', 'approved_at=null');
  const why = c.ok
    ? `${SPINE_APPROVAL_PREFIX}: PR #${pr} has one strict expected-fail spec per criterion and stays draft. Check each spec means what its criterion says, then approve it (queue.mjs approve ${t.key}) or send it back with a note (queue.mjs reject ${t.key} "<note>")`
    : `${SPINE_SPECS_PREFIX}: ${c.problems.join('; ')}. No approval until they are fixed: send it back with a note (queue.mjs reject ${t.key} "<what to fix>")`;
  q('park', t.key, why);
  report.parked.push(`${t.key}: ${why}`);
}

// A feature child that owns criteria (the queue's `owners`, recorded when plan-batch seeds) finishes
// with every spec it owns unmarked and passing, and no other child's spec changed; otherwise it parks
// naming the spec, and its PR stays draft. Only its own ids run here; the base gate runs them all.
// Children that own nothing run as before.
const ownsSpecs = (t) => Q.feature === true && !isSpine(t) && ownedIds(Q.owners, t.key).length > 0;
const SPEC_RUN_MS = 30 * 60 * 1000;
function checkOwned(t, pr) {
  if (pr == null) return;
  const { specDir, cmd } = acceptanceSpecs();
  // Under the test lock like any suite, in the child's worktree at the head it pushed.
  const run = (id) => {
    if (!cmd) return { ok: false, out: 'config §4 Acceptance specs has no command taking {ids}' };
    const command = specsCommand(cmd, id);
    return { ...shOut(join(BIN, 'with-lock.sh'), ['test', 'sh', '-c', command], { cwd: t.worktree, timeout: SPEC_RUN_MS }), command };
  };
  const c = checkChild({ worktree: t.worktree, base: DEFAULT_BRANCH, specDir, owners: Q.owners, key: t.key, run });
  q('set', t.key, `spec_check=${JSON.stringify({ ok: c.ok, problems: c.problems, at: new Date().toISOString() })}`);
  if (c.ok) return;
  const why = `${CHILD_SPECS_PREFIX}: ${c.problems.join('; ')}. PR #${pr} stays draft: send it back with what to fix (answer.mjs ${t.key} "<note>", then queue.mjs requeue ${t.key})`;
  q('park', t.key, why);
  report.parked.push(`${t.key}: ${why}`);
}

// The briefing section that tells a child which specs it owns, or '' for a child that owns none.
function ownedBrief(t, wt) {
  if (!ownsSpecs(t)) return '';
  const { specDir, cmd } = acceptanceSpecs();
  const ids = ownedIds(Q.owners, t.key);
  const owned = specDir ? ownedSpecs(specFilesAt(wt, 'HEAD', specDir), ids) : ids.map((id) => ({ id, specs: [] }));
  const lines = owned.flatMap(({ id, specs }) => (specs.length
    ? specs.map((s) => `- ${id}: "${s.title}" in ${s.path}`)
    : [`- ${id}: no spec titled with it on ${DEFAULT_BRANCH}. Park naming it rather than writing one`]));
  return [
    '## Acceptance specs you own',
    '',
    `This batch builds an epic as one feature, and each of its acceptance specs has one owning child. You own ${ids.length}:`,
    '',
    ...lines,
    '',
    `For each one: remove the marker that makes it ${EXPECTED_FAIL}, and make it pass. Run these spec files with §4 Unit tests, capped and locked as for any suite, rather than the whole acceptance directory: another child owns every other spec there, and each of those is still expected to fail.`,
    'Change no acceptance spec you do not own. If yours cannot pass without changing one, park naming it and its criterion.',
    `When you finish, the pass runs only your specs${cmd ? ` (${ids.map((id) => `\`${specsCommand(cmd, id)}\``).join(', ')})` : ''} and parks the ticket, naming the spec, if one you own is still marked expected-fail or skipped, or fails, or if your branch changed a spec another child owns.`,
    '',
  ].join('\n');
}

// The calls a finished worker took on its own recommendation go to the decision log, one entry per
// call per run however often its log is read. A line the log cannot hold waits on the person, raw.
function logDecisions(t, log, pr) {
  let markers;
  try { markers = workerMarkers(readFileSync(log, 'utf8')); } catch { return; }
  const entries = [];
  const unreadable = new Set();
  for (const [k, v] of markers) {
    if (k !== 'AUTOPILOT_DECISION' && k !== 'AUTOPILOT_CHECKED') continue;
    const d = k === 'AUTOPILOT_CHECKED' ? parseCheck(v) : parseDecision(v);
    const what = k === 'AUTOPILOT_CHECKED' ? 'check' : 'decision';
    if (d.ok) entries.push(decisionEntry({ decision: d.check ?? d.decision, ticket: t.key, run: t.session_id, repo: GH_REPO, pr, source: 'worker' }));
    else if (!unreadable.has(v)) { unreadable.add(v); report.waiting.push(`${t.key}: unreadable ${what} (${d.why}), nothing logged: ${v}`); }
  }
  if (entries.length) appendDecisions(entries, STATE);
}

// A worker's park against the "not now" register: the inputs the question depends on, from the
// `AUTOPILOT_PARK_INPUTS: {json}` after its last park (none is {}), and lookup()'s verdict on them.
function againstRegister(t, question, log) {
  let raw = null;
  try {
    for (const [k, v] of workerMarkers(readFileSync(log, 'utf8'))) {
      if (k === 'AUTOPILOT_PARK') raw = null;
      else if (k === 'AUTOPILOT_PARK_INPUTS') raw = v;
    }
  } catch { /* no log, no inputs */ }
  const p = parseInputs(raw);
  // Logged, never waiting on the person: nobody can clear it, and the park itself is asked as usual.
  if (!p.ok) report.inputs.push(`${t.key}: unreadable park inputs (${p.why}), read as none: ${raw}`);
  const inputs = p.ok ? p.inputs : {};
  return { inputs, ...lookup(REGISTER, { question, inputs }) };
}

// What clears a worker's park, from the `AUTOPILOT_PARK_CLEARS_WHEN:` after its last park (clears-when.mjs).
// None given, or one that does not read, is none: the park waits for a person.
function clearsWhenOf(t, log) {
  let raw = null;
  try {
    for (const [k, v] of workerMarkers(readFileSync(log, 'utf8'))) {
      if (k === 'AUTOPILOT_PARK') raw = null;
      else if (k === 'AUTOPILOT_PARK_CLEARS_WHEN') raw = v;
    }
  } catch { /* no log, no condition */ }
  const p = parseClearsWhen(raw);
  if (!p.ok) report.clears.push(`${t.key}: unreadable clears-when (${p.why}), recorded as none`);
  return p.ok ? p.cond : { kind: 'none' };
}

// A session that handed off (AUTOPILOT_HANDOFF: 4b or 7) is queued to start that stage in a fresh
// session, ahead of new tickets, in the same worktree and on the same branch (spawnHandoff below). A
// stage no session starts at, a worktree or branch that is gone, or a handoff briefing that cannot be
// read parks it, naming which, and spawns nothing.
// In stage order: Object.keys lists an integer-like key (7) before '4b'.
const HANDOFF_ORDER = Object.keys(HANDOFF_STAGES).sort((a, b) => parseFloat(a) - parseFloat(b));
const FROM_ZERO = (t) => `To start it again from Stage 0 instead: queue.mjs set ${t.key} handoff_stage=null, then queue.mjs requeue ${t.key}`;
function handoffRefusal(t, stage) {
  const missing = handoffTarget({ worktree: t.worktree, branch: t.branch });
  if (missing) return `handoff to Stage ${stage}: ${missing}, so no session was spawned. ${FROM_ZERO(t)}`;
  const r = readHandoff(STATE, t.key);
  return r.ok ? null : `handoff to Stage ${stage}: ${r.why}, so no session was spawned. ${FROM_ZERO(t)}`;
}
function handedOff(t, said, { log, h, imgs, stopped }) {
  logDecisions(t, log, null);
  const stage = handoffStage(said);
  const parkIt = (why) => { q('park', t.key, why); report.parked.push(`${t.key}: ${why}`); };
  if (!stage) return parkIt(`handed off to "${said}", which no session starts at (only Stage ${HANDOFF_ORDER.join(' or ')}), so no session was spawned. ${FROM_ZERO(t)}`);
  const refused = handoffRefusal(t, stage);
  if (refused) return parkIt(refused);
  // The session's cost so far, added to the ticket's when its last session finishes.
  const cost = /notional=\$([\d.]+)/.exec(h)?.[1];
  q('set', t.key, 'state=triaged', 'handoff=pending', `handoff_stage=${stage}`,
    ...(cost ? [`handoff_cost=${(Number(cost) + (Number(t.handoff_cost) || 0)).toFixed(2)}`] : []), ...(imgs ? [`images_dir=${imgs}`] : []));
  report.advanced.push(`${t.key} handed off at the end of Stage ${HANDOFF_STAGES[stage]}: queued for a fresh session from Stage ${stage}${stopped}`);
  return undefined;
}

// A worker killed before it finished (no result event, no marker, no open PR) is resumed in its own
// session, worktree and branch by the spawn below, up to config §3b "Resume a killed worker (times)"
// per ticket. Unset is 2; anything but a whole number is said and read as 0, which marks a killed
// worker failed.
const RESUME_ROW = E.CONFIG_ROWS['resume-killed'].row;
const RESUME = (() => {
  const raw = E.configValue('resume-killed');
  if (raw == null || E.isNone(raw)) return { limit: raw == null ? 2 : 0, bad: null };
  if (/^\d+$/.test(String(raw).trim())) return { limit: Number(raw), bad: null };
  return { limit: 0, bad: `config §3b "${RESUME_ROW}" is "${raw}" — want a whole number; read as 0, so a killed worker is marked failed` };
})();
// When this computer last started, for telling a reboot from a crash. DESK_BOOT_TIME (ISO, or epoch
// seconds) stands in for it in tests.
const bootMs = (() => {
  const v = process.env.DESK_BOOT_TIME;
  if (v) return /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v);
  return Date.now() - uptime() * 1000;
})();
const REBOOT = 'the computer restarted after its last log write';
const killedBy = (log) => (statSync(log).mtimeMs < bootMs ? REBOOT : 'its process died while the computer stayed up');
// Where a killed worker's resume stops: off, or this ticket has had as many as the row allows.
const resumeRefusal = (t, why) => {
  const n = t.resumes ?? 0;
  if (RESUME.limit <= 0) return { fail: `Resuming is off (${RESUME.bad ?? `config §3b "${RESUME_ROW}" is 0`}), so it is marked failed` };
  if (n >= RESUME.limit) {
    return { park: `killed again (${why}) after ${n} resume(s), the most config §3b "${RESUME_ROW}" allows (${RESUME.limit}), so it is not resumed. ` +
      `Session ${t.session_id}, worktree ${t.worktree}. Requeue it for a fresh worker with queue.mjs requeue ${t.key}` };
  }
  return null;
};

// ---- advance running tickets --------------------------------------------
for (const t of rows.filter((r) => r.state === 'running')) {
  const log = join(STATE, 'logs', `${t.key}.log`);
  if (!existsSync(log)) continue;
  const h = sh('node', [join(BIN, 'harvest.mjs'), log], { tolerant: true });

  const stage = [...h.matchAll(/AUTOPILOT_STAGE:\s*(\S+)/g)].pop()?.[1];
  if (stage && stage !== t.stage) { q('set', t.key, `stage=${stage}`); report.advanced.push(`${t.key} → ${stage}`); }
  // A worker opens its draft PR at Stage 7 and carries on (review, Jira) before it prints DONE, and
  // only DONE records result.pr. From Stage 7 on, ask GitHub once a pass until the PR shows, and keep
  // it as draft_pr, so the status watch shows a PR opened while its worker still runs.
  if (t.draft_pr == null && t.branch && parseInt(stage ?? t.stage, 10) >= 7) {
    const opened = sh('gh', ['pr', 'list', '--repo', GH_REPO, '--head', t.branch,
      '--state', 'open', '--json', 'number', '-q', '.[0].number'], { tolerant: true });
    if (/^\d+$/.test(opened)) { q('set', t.key, `draft_pr=${opened}`); report.advanced.push(`${t.key} opened PR #${opened}`); }
  }

  // ORDER MATTERS, and getting it wrong re-parks finished tickets. A worker that parks, gets
  // answered, posts and exits leaves BOTH markers in the log. Taking the last PARK unconditionally
  // re-parks a completed ticket — the log is append-only and this function has no
  // notion of which markers it has already actioned, so a spent PARK reads exactly like a live one.
  // Whichever marker appears LAST is the one that describes how the worker actually ended.
  const lastPark = [...h.matchAll(/AUTOPILOT_PARK:\s*(.+)/g)].pop();
  const lastDone = [...h.matchAll(/AUTOPILOT_DONE:\s*(.+)/g)].pop();
  const parkSupersededByDone = lastPark && lastDone && lastDone.index > lastPark.index;
  // A handoff (AUTOPILOT_HANDOFF: 4b or 7) ends this session so the next stage starts in a fresh one.
  // It counts only as the last of the three: a session that hands off has neither parked nor finished.
  const lastHandoff = [...h.matchAll(/AUTOPILOT_HANDOFF:\s*(.+)/g)].pop();
  const handoffLast = !!lastHandoff && [lastPark, lastDone].every((m) => !m || lastHandoff.index > m.index);
  const handoff = handoffLast ? lastHandoff[1].trim() : undefined;
  const park = handoff || parkSupersededByDone ? undefined : lastPark?.[1];
  // A worker whose last word is DONE has finished, whether or not its session ever exits: one that
  // hangs after printing it must be recorded done, never left running and then parked as wedged.
  const done = park || handoff ? undefined : lastDone?.[1];
  for (const m of h.matchAll(/AUTOPILOT_NOTE:\s*(.+)/g)) notes.push(`- [${t.key}] ${m[1].trim()}`);

  // A worker at a usage limit (usage-limit.mjs decides; nothing here reads the event). Only a worker
  // that has neither parked nor finished, and has not answered since the limit, is acted on.
  const logText = readFileSync(log, 'utf8');
  const usage = usageLimit(logText);
  const limit = !park && !done && !handoff && usage.last?.kind === 'limit' && !usage.last.resumed ? usage.last : null;
  if (usage.unrecognised.length > (t.usage_unrecognised ?? 0)) {
    q('set', t.key, `usage_unrecognised=${usage.unrecognised.length}`);
    report.unrecognised.push(`${t.key}: ${usage.unrecognised.at(-1)}`);
  }
  for (const l of usage.limits.filter((x) => x.resumed)) {
    notes.push(`- [${t.key}] resumed after ${limitName(l.type)}${l.resetsAt != null ? ` (reset at ${resetText(l.resetsAt)})` : ''}`);
  }
  const pausedOnLimit = !!limit && (limit.resetsAt == null || Date.now() < limit.resetsAt * 1000 + LIMIT_GRACE_MS);
  // Kept below only while the ticket is still running once the loop is done.
  if (pausedOnLimit) usageHolds.push({ key: t.key, limit, was: t.usage_paused });
  else if (t.usage_paused) q('set', t.key, 'usage_paused=null');

  // Log growth is the honest liveness signal: it comes from the harness, not from self-reporting.
  // It is not sufficient on its own — a hung `codex exec` emits a tool_progress heartbeat every 30s,
  // so a worker wedged for hours still grows its log. See references/orchestrator-recovery.md.
  // Workers log no partial messages, so a long model turn writes nothing until its message ends, as a
  // long suite behind the test lock never did: six quiet passes is the margin for both.
  const bytes = statSync(log).size;
  let wedged = false;
  if (bytes > (t.log_bytes ?? 0)) {
    q('set', t.key, `log_bytes=${bytes}`, 'idle_passes=0');
  } else if (pausedOnLimit) {
    // Waiting for the reset is not a stall.
    if (t.idle_passes) q('set', t.key, 'idle_passes=0');
  } else {
    const idle = (t.idle_passes ?? 0) + 1;
    q('set', t.key, `idle_passes=${idle}`);
    if (idle >= 6 && !done && !handoff) {
      // Free the slot. The worker's session id survives, so it can be resumed later with
      // its context intact; leaving it wedged blocks the whole batch.
      const pid = (JSON.parse(sh('claude', ['agents', '--json'], { tolerant: true }) || '[]')
        .find((a) => a.sessionId === t.session_id) ?? {}).pid;
      if (pid) sh('kill', [String(pid)], { tolerant: true });
      wedged = true;
      q('park', t.key, `wedged — no output for ${idle} passes, worker stopped (session ${t.session_id}). Requeue it with queue.mjs requeue ${t.key} (desk-autopilot's orchestrator-recovery.md); never resume the session by hand, which would run it without the worker sandbox`);
      report.stalled.push(`${t.key}: no output for ${idle} passes — stopped and parked, slot freed`);
    } else if (idle >= 3) report.quiet.push(`${t.key}: quiet for ${idle} passes`);
  }

  // Screenshots the worker captured but cannot upload: one shared browser profile, so the
  // orchestrator does it, one PR at a time, and only once per ticket — and only where config §3
  // grants driving the signed-in browser. Otherwise surface it for the user once.
  // The worker prints an absolute path, but a `~/...` one must still work: node does not expand ~,
  // and an unexpanded path made the uploader exit on every pass.
  // A session started from a handoff may open the PR for screenshots an earlier session captured: the
  // directory that session printed is kept on the ticket (images_dir) when it hands off.
  const logImgDir = [...h.matchAll(/AUTOPILOT_IMAGES:\s*(\S+)/g)].pop()?.[1];
  const imgDir = E.expandHome(logImgDir ?? t.images_dir ?? undefined);
  // This round's log names the PR first: after a requeue, t.result.pr is the previous round's PR.
  const prNo = [...h.matchAll(/AUTOPILOT_DONE:[^\n]*pr=(\d+)/g)].pop()?.[1] ?? t.result?.pr;
  if (imgDir && prNo && !t.images_uploaded) {
    // A directory that is missing or holds no screenshot means no images, not a failed upload. A
    // running worker may still capture into it, so only a finished one is recorded as having none.
    let shots = [];
    try { shots = readdirSync(imgDir).filter((f) => E.SCREENSHOT_FILE.test(f)); } catch { /* missing */ }
    if (!shots.length) {
      if (done) q('set', t.key, 'images_uploaded=none');
    } else if (uploadPerm === 'yes' || process.env.DESK_UPLOAD_APPROVED) {
      const run = shOut('node', [join(BIN, 'upload-images.mjs'), String(prNo), imgDir]);
      const up = run.out;
      const doneLine = /done: (\d+) image\(s\) in the body, (\d+) placeholder\(s\) left/.exec(up);
      const tail = up.split('\n').slice(-2).join(' ');
      if (run.ok && doneLine && Number(doneLine[1]) > 0 && Number(doneLine[2]) === 0) {
        q('set', t.key, 'images_uploaded=true');
        report.advanced.push(`${t.key} images → #${prNo}`);
        // The worker leaves the PR in draft; the undraft step below takes it out once the review
        // checks in SKILL.md hold. Report evidence completeness so that decision has what it needs.
        report.advanced.push(`${t.key} #${prNo} evidence complete — still draft`);
      } else if (doneLine || /uploaded, but found no/.test(up)) {
        // The assets now exist on GitHub but the body is not finished (placeholders left, or none
        // matched). Re-uploading would duplicate them, so mark it partial — never uploaded=true —
        // keep the full output, and put it in front of the user.
        const saved = join(STATE, 'images', `${t.key}.upload.log`);
        try { mkdirSync(join(STATE, 'images'), { recursive: true }); writeFileSync(saved, `${up}\n`); } catch { /* best effort */ }
        q('set', t.key, 'images_uploaded=partial');
        report.waiting.push(`${t.key}: image upload to PR #${prNo} is INCOMPLETE — ${tail}. Fix the body's \`_drag <file>_\` cells by hand ` +
          `(tags saved in ${saved}); do not re-upload.`);
      } else {
        report.failed.push(`${t.key}: image upload did not complete — ${tail}`);
      }
    } else if (!t.images_reported) {
      q('set', t.key, 'images_reported=true');
      report.waiting.push(`${t.key}: screenshots for PR #${prNo} are in ${imgDir} — config §3 ${E.permissionKey('pr-images')} is "${uploadPerm}". ` +
        `Ask, then: DESK_UPLOAD_APPROVED=1 node ${join(BIN, 'upload-images.mjs')} ${prNo} ${imgDir}`);
    }
  }

  const stillLive = registryOk && t.session_id && liveSids.has(t.session_id);
  let stopped = '';
  if (stillLive && (done || handoff)) {
    // Finished (or handed off) but hung: stop the session (it has nothing left to do) and record it below.
    const pid = live.find((a) => a.sessionId === t.session_id)?.pid;
    if (pid) sh('kill', [String(pid)], { tolerant: true });
    const said = done ? 'DONE' : 'HANDOFF';
    stopped = pid ? ` (session still live after ${said} — stopped pid ${pid})` : ` (session still live after ${said}, no pid to stop: session ${t.session_id})`;
  } else if (stillLive) {
    // A worker sitting on an unanswered question is waiting, not working.
    const asked = openQuestion(STATE, t.key);
    if (asked) report.waiting.push(`${t.key}: ${asked}`);
    continue;
  }
  if (!registryOk) continue; // cannot tell — leave it alone rather than guess

  // Exited, or finished and stopped above. Decide what it was, from the markers read above.
  if (park) {
    q('park', t.key, park.trim());
    // The round a requeue's fresh spawn may resume (resumeRound). Only a worker's own park records
    // one: a stalled or failed worker starts again at Stage 0. Dated by the log's last write, so an
    // answer given before this pass saw the park still counts as its answer.
    q('set', t.key, `last_round=${JSON.stringify({ stage: stage ?? t.stage ?? null, question: park.trim(), at: statSync(log).mtime.toISOString() })}`);
    const reg = againstRegister(t, park.trim(), log);
    q('set', t.key, `park.inputs=${JSON.stringify(reg.inputs)}`, `park.clears_when=${JSON.stringify(clearsWhenOf(t, log))}`);
    if (reg.status === 'put_off') report.putOff.push(`${t.key}: ${park.trim()} (put off on ${reg.entry.at.slice(0, 10)})`);
    else report.parked.push(`${t.key}: ${park.trim()}${reg.status === 'changed' ? ` — ${reg.line}` : ''}`);
    logDecisions(t, log, null);
  }
  else if (handoff) handedOff(t, handoff, { log, h, imgs: logImgDir, stopped });
  else if (done) {
    // A ticket whose sessions handed off spent what each of them did.
    const cost = /notional=\$([\d.]+)/.exec(h)?.[1];
    if (cost) q('set', t.key, `cost=${(Number(cost) + (Number(t.handoff_cost) || 0)).toFixed(2)}`);
    const pr = /pr=(\d+)/.exec(done)?.[1] ?? null;
    logDecisions(t, log, pr);
    // A finished ticket sent back later (a spec check, a spine rejected) is rework: from Stage 0, not
    // the stage its last handoff named.
    q('set', t.key, 'state=done', 'handoff_stage=null', `result.summary=${done.trim().slice(0, 200)}`, ...(pr ? [`result.pr=${pr}`] : []));
    report.done.push(`${t.key}: ${done.trim()}${stopped}`);
    recordScope(t);
    if (isSpine(t)) parkSpine(t, pr);
    else if (ownsSpecs(t)) checkOwned(t, pr);
  } else {
    // No marker is not evidence of failure. A worker can do everything and exit without
    // announcing it. Ask GitHub what actually exists before believing the silence. An open PR
    // means a PR exists, NOT that the review posted or that it merged — verify those separately.
    const pr = sh('gh', ['pr', 'list', '--repo', GH_REPO, '--head', t.branch ?? '',
      '--state', 'open', '--json', 'number', '-q', '.[0].number'], { tolerant: true });
    logDecisions(t, log, /^\d+$/.test(pr) ? pr : null);
    if (/^\d+$/.test(pr)) {
      q('set', t.key, 'state=done', 'handoff_stage=null', `result.pr=${pr}`, 'result.summary=completed without printing a marker');
      report.done.push(`${t.key}: PR #${pr} (no marker printed — PR exists on GitHub; verify review and merge state)`);
      recordScope(t);
      if (isSpine(t)) parkSpine(t, Number(pr));
      else if (ownsSpecs(t)) checkOwned(t, Number(pr));
    } else if (limit && !wedged && t.session_id && t.resume_limits !== usage.limits.length) {
      // Exited at a usage limit: a headless worker ends its session there rather than waiting for the
      // reset. It stays running, reported paused, until the limit lifts, then is resumed in its own
      // session, never failed. Once per limit: a resume that ends before the model answers, with no
      // new rejection, leaves the same count of limits in the log, and is then handled as any other
      // exit below rather than resumed on every pass.
      if (lifted(limit)) {
        const why = `exited at ${limitName(limit.type)}, which lifted (${liftedHow(limit)})`;
        q('set', t.key, 'state=triaged', 'resume=usage', `resume_why=${why}`,
          `resume_limits=${usage.limits.length}`);
        report.advanced.push(`${t.key} ${why}: queued to resume in its own session`);
      }
    } else if (!wedged && !endedNormally(logText) && t.session_id) {
      // Killed mid-run: resumed in its own session by the spawn below, ahead of new tickets.
      const why = killedBy(log);
      const stop = resumeRefusal(t, why);
      // A log written in the last two minutes, since this computer started, is a worker the registry
      // has not caught up with, not a dead one: resuming it would put two processes on one session.
      if (why !== REBOOT && Date.now() - statSync(log).mtimeMs < 120_000) {
        report.quiet.push(`${t.key}: not in the session registry, but its log was written in the last 2 minutes — left running, checked again next pass`);
      } else if (stop?.fail) {
        q('set', t.key, 'state=failed');
        report.failed.push(`${t.key}: killed before it finished (${why}), with no marker and no open PR on ${t.branch}. ${stop.fail} — check ${log}`);
      } else if (stop?.park) {
        q('park', t.key, stop.park);
        report.parked.push(`${t.key}: ${stop.park}`);
      } else {
        q('set', t.key, 'state=triaged', 'resume=pending', `resume_why=${why}`);
        report.advanced.push(`${t.key} killed before it finished (${why}): queued to resume`);
      }
    } else {
      q('set', t.key, 'state=failed');
      report.failed.push(`${t.key}: exited with no marker and no open PR on ${t.branch}${limit ? `, last seen at ${limitName(limit.type)}${limit.resetsAt != null ? ` (resets ${resetText(limit.resetsAt)})` : ''}` : ''} — check ${log}`);
    }
  }
}

// ---- the usage limit -----------------------------------------------------
// A paused worker holds the batch while it is still running once the loop is done. A preflight the
// limit refused holds it through the queue's usage_hold, kept across passes until the limit lifts. A
// hold whose limit has lifted holds nothing, and spawns and resumes go ahead as normal.
let USAGE_HOLD = null;
{
  const tickets = queue().tickets;
  for (const h of usageHolds.splice(0)) {
    if (tickets[h.key]?.state !== 'running') {
      if (tickets[h.key]?.usage_paused) q('set', h.key, 'usage_paused=null');
      continue;
    }
    usageHolds.push(h);
    report.paused.push(`${h.key} on ${limitName(h.limit.type)}${untilText(h.limit)}, then it resumes, or sooner once a probe call succeeds`);
    // desk-q reads this to show the ticket paused rather than at its stage.
    if (h.was?.type !== h.limit.type || h.was?.resets_at !== h.limit.resetsAt) {
      q('set', h.key, `usage_paused=${JSON.stringify({ type: h.limit.type, resets_at: h.limit.resetsAt })}`);
    }
  }
  const stored = queue().usage_hold;
  const pre = stored?.preflight ? { key: stored.preflight, limit: { type: stored.type ?? 'unknown', resetsAt: stored.resets_at ?? null } } : null;
  const holding = [...(pre ? [pre] : []), ...usageHolds].find((h) => !lifted(h.limit));
  if (holding) USAGE_HOLD = { type: holding.limit.type, resetsAt: holding.limit.resetsAt, preflight: pre && !lifted(pre.limit) ? pre.key : null };
  else if (pre) report.advanced.push(`${limitName(pre.limit.type)} lifted (${liftedHow(pre.limit)}): spawns and resumes go ahead`);
}

// ---- batch notes ---------------------------------------------------------
if (notes.length) {
  const path = join(STATE, 'batch-notes.md');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '# Batch notes\n\n';
  // Dedup against the file AND within this pass: harvest sees a note twice (once in the
  // assistant text, once echoed in the result), so filtering only against the file
  // appends every note in duplicate.
  const seen = new Set(existing.split('\n'));
  const freshNotes = [];
  for (const n of notes) { if (!seen.has(n)) { seen.add(n); freshNotes.push(n); } }
  if (freshNotes.length) appendFileSync(path, `${freshNotes.join('\n')}\n`);
}

// ---- interactive close-outs --------------------------------------------------
// A ticket an interactive session merged or moved to Done (closeout.mjs) is done here too, rather than
// left parked. A running one is its worker's until it ends. With its PR recorded, the merge is read
// below as any other. The note goes once the queue has the change; a note written for another queue
// file is left for it, and one older than the ticket's place in this queue is stale and goes unread.
for (const c of readCloseouts(STATE)) {
  if (c.queue && c.queue !== QUEUE_FILE) continue;
  const t = queue().tickets[c.ticket];
  const stale = t?.added_at && Date.parse(t.added_at) > Date.parse(c.at);
  const how = `closed out from an interactive session (${c.how === 'done' ? 'moved to Done' : 'merged'}${c.pr ? `, PR #${c.pr}` : ''})`;
  if (t?.state === 'running' && !stale) { report.advanced.push(`${t.key}: ${how} while its worker runs; recorded once the worker ends`); continue; }
  if (t && t.state !== 'done' && !stale) {
    const before = report.failed.length;
    q('set', t.key, 'state=done', 'park=null', 'handoff_stage=null', `result.summary=${how}`, ...(c.pr ? [`result.pr=${c.pr}`] : []));
    if (report.failed.length !== before) continue;
    report.done.push(`${t.key}: ${how}`);
  }
  try { unlinkSync(c.file); } catch { /* gone */ }
}

// ---- parks whose condition cleared ---------------------------------------------
// A park that recorded what clears it (clears-when.mjs) is checked each pass, and settled once that
// holds, as the recovery rules say and with no model: left for a person on lane C or a lane D
// parked at triage on its design, closed out where the ticket's own PR merged, requeued otherwise. A check that cannot run leaves the park as it is.
const clearsCache = new Map();
const cached = (key, read) => {
  if (!clearsCache.has(key)) { try { clearsCache.set(key, { v: read() }); } catch (e) { clearsCache.set(key, { e }); } }
  const c = clearsCache.get(key);
  if (c.e) throw c.e;
  return c.v;
};
const readOrThrow = (what, cmd, args) => {
  const r = shOut(cmd, args);
  if (!r.ok) throw new Error(`${what}: ${r.out.split('\n').pop()}`);
  return r.out;
};
const clearsRead = {
  pr: (n) => cached(`pr:${n}`, () => JSON.parse(readOrThrow(`gh pr view ${n}`, 'gh', ['pr', 'view', String(n), '--repo', GH_REPO, '--json', 'state,isDraft']))),
  ticket: (key) => cached(`ticket:${key}`, () => {
    const c = JSON.parse(readOrThrow(`desk-jira get ${key}`, 'desk-jira', ['get', key, '--json']))?.fields?.status?.statusCategory?.key;
    if (!c) throw new Error(`desk-jira get ${key}: no status category`);
    return c;
  }),
  variable: (name) => cached('variables', () => JSON.parse(readOrThrow('gh variable list', 'gh', ['variable', 'list', '--repo', GH_REPO, '--json', 'name'])))
    .some((v) => v?.name === name),
};
// The ticket's own PR, if it merged: the one it recorded, else a merged PR from its branch.
function ownMergedPr(t) {
  const known = [...new Set([t.result?.pr, t.draft_pr].filter((n) => n != null).map(Number))];
  for (const n of known) if (clearsRead.pr(n).state === 'MERGED') return n;
  if (known.length || !t.branch) return null;
  const n = readOrThrow(`gh pr list --head ${t.branch}`, 'gh', ['pr', 'list', '--repo', GH_REPO, '--head', t.branch, '--state', 'merged', '--json', 'number', '-q', '.[0].number']);
  return /^\d+$/.test(n) ? Number(n) : null;
}
for (const t of Object.values(queue().tickets)) {
  const c = t.park?.clears_when;
  // A claimed ticket is released only by the claims loop below, once its session is idle and its
  // worktree clean, so a condition that holds never hands it to a worker under a live session.
  if (t.state !== 'parked' || isHeld(t) || spinePark(t) || t.park?.claim?.session || !c || c.kind === 'none') continue;
  const what = describeCond(c);
  const r = checkCond(c, clearsRead);
  if (r.error) { report.clears.push(`${t.key}: could not check "${what}" (${r.error}): left parked`); continue; }
  if (!r.holds) continue;
  if (needsSession(t)) {
    report.clears.push(`${t.key}: "${what}" holds, but it is lane ${t.lane}: left parked for a person, never requeued for a headless worker`);
    continue;
  }
  let own;
  try { own = ownMergedPr(t); } catch (e) {
    report.clears.push(`${t.key}: "${what}" holds, but whether its own PR merged could not be read (${e.message}): left parked`);
    continue;
  }
  if (own != null) {
    const before = report.failed.length;
    q('set', t.key, 'state=done', 'park=null', 'handoff_stage=null', `result.summary=closed out: ${what}, and its PR #${own} merged`, `result.pr=${own}`);
    if (report.failed.length === before) report.clears.push(`${t.key}: "${what}" holds and its PR #${own} merged: recorded done`);
  } else {
    const rq = shOut('node', [join(BIN, 'queue.mjs'), 'requeue', t.key]);
    report.clears.push(rq.ok ? `${t.key}: "${what}" holds: requeued` : `${t.key}: "${what}" holds, but the requeue was refused (${rq.out.split('\n').pop()}): left parked`);
  }
}

// ---- claims by idle sessions ---------------------------------------------------
// A ticket an interactive session claimed (queue.mjs park --claimed-by) goes back to the workers once
// that session's transcript has been still past config §3b "Release idle claims after (hours)", counted
// from the claim at the latest, and its worktree holds no uncommitted change: one push names it. With
// uncommitted changes it stays claimed, and its park says so once, which the digest shows as new.
const CLAIMS = claimHours();
const claimPush = [];
if (CLAIMS.bad) report.waiting.push(`${CLAIMS.bad} — no claim is released until it is fixed`);
for (const t of CLAIMS.hours > 0 ? Object.values(queue().tickets) : []) {
  const c = t.park?.claim;
  if (t.state !== 'parked' || !c?.session) continue;
  // Held, a spine awaiting its person, or a lane C or D parked at triage: never a headless worker's,
  // however idle the session (as the clears-when loop above).
  if (isHeld(t) || spinePark(t) || needsSession(t)) continue;
  const tr = transcriptOf(c.session);
  if (!tr) { report.clears.push(`${t.key}: claimed by session ${c.session}, whose transcript is gone: left claimed`); continue; }
  const since = Math.max(tr.mtimeMs, Date.parse(c.at) || 0);
  if (Date.now() - since <= CLAIMS.hours * 3600e3) continue;
  const idle = `session ${c.session} has been idle since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  let wt = null, dirty = [];
  try { wt = claimWorktree(t); dirty = wt ? uncommitted(wt) : []; } catch (e) {
    report.clears.push(`${t.key}: ${idle}, but its worktree ${wt ?? ''} could not be read (${String(e.message).split('\n')[0]}): left claimed`);
    continue;
  }
  if (dirty.length) {
    if (c.dirty_at) continue;
    const files = dirty.length > 5 ? `${dirty.slice(0, 5).join(', ')} and ${dirty.length - 5} more` : dirty.join(', ');
    const why = `claimed by session ${c.session}, which has been idle past ${CLAIMS.hours}h, but its worktree ${wt} has uncommitted changes (${files}): commit or discard them, or say who carries on`;
    // A park of the ticket's own keeps its question in front, where the requeue guards read it.
    const was = t.park.question;
    q('set', t.key, `park.question=${was && was !== claimQuestion(c.session) ? `${was}; ${why}` : why}`, `park.since=${new Date().toISOString()}`, `park.claim.dirty_at=${new Date().toISOString()}`);
    report.parked.push(`${t.key}: ${why}`);
    continue;
  }
  const rq = shOut('node', [join(BIN, 'queue.mjs'), 'requeue', t.key]);
  if (!rq.ok) { report.clears.push(`${t.key}: ${idle}, but the requeue was refused (${rq.out.split('\n').pop()}): left claimed`); continue; }
  report.clears.push(`${t.key}: ${idle}, and its worktree is clean: back to the workers, branch ${t.branch ?? 'none recorded'} kept`);
  claimPush.push({ key: `claim:${E.repoSlug()}:${t.key}:${c.at}`, text: `desk ${E.repoSlug()}: ${t.key} went back to the workers, since session ${c.session}, which claimed it, has been idle past ${CLAIMS.hours}h` });
}

// ---- maintenance window ------------------------------------------------------
// The weekly window (maintenance.mjs), one per computer, holds every spawn, resumes included, while it
// drains, updates and restarts. A worker still running at its drain limit is stopped with its session
// kept, and queued to resume once the window is done.
const MAINT = await maintenance({
  selfQueue: QUEUE_FILE,
  running: Object.values(queue().tickets).filter((t) => t.state === 'running'),
  stop: (t) => stopForWindow(t, {
    live: registryOk ? live : null,
    kill: (pid) => sh('kill', [String(pid)], { tolerant: true }),
    setQueue: (key, fields) => {
      const before = report.failed.length;
      q('set', key, ...fields);
      return report.failed.length === before ? { ok: true } : { ok: false, why: report.failed.at(-1) };
    },
  }),
});

// ---- spawn ---------------------------------------------------------------
const fresh = queue();
const all = Object.values(fresh.tickets);
const running = all.filter((r) => r.state === 'running');

// Batch budget: the queue's `budget_usd`, else $AUTOPILOT_BATCH_BUDGET_USD, else config §3b, else none.
// A positive number of USD or none/off/no cap. Anything else ("25 USD") holds every spawn rather than
// reading as no cap: a typo must never silently remove a guard. Spend is reported only when a cap exists.
const spent = all.reduce((n, r) => n + (Number(r.cost) || 0), 0);
let cap = 0;
let budgetBad = null;
try {
  const b = fresh.budget_usd != null ? E.parseBudget(fresh.budget_usd, 'the queue\'s budget_usd') : E.batchBudget();
  cap = b.off ? 0 : b.usd;
} catch (e) { budgetBad = e.message; }
if (budgetBad) personStall(`${budgetBad} — not spawning until it is fixed`);
const overBudget = !!budgetBad || (cap > 0 && spent >= cap);
if (cap > 0 && spent >= cap) personStall(`batch budget reached: $${spent.toFixed(2)} of $${cap} — not spawning anything further`);

// Config §3b "Worker models": each worker runs on its ticket's tier, or on the session default
// when the row is `default`. A malformed row holds every spawn, the way a malformed budget does.
let models = { off: true };
let modelsBad = null;
try { models = E.workerModels(); } catch (e) { modelsBad = e.message; }
if (modelsBad) personStall(`${modelsBad} — not spawning until it is fixed`);
// §3b "Check-in times": when the digest goes out. A row that does not read holds spawns, since the
// questions a new worker parks would have no check-in to reach.
let CHECKIN;
try { CHECKIN = checkinTimes(checkinRow()); } catch (e) { CHECKIN = { ok: false, why: e.message }; }
if (!CHECKIN.ok) personStall(`${CHECKIN.why} — not spawning until it is fixed`);
// The health watchdog (health.mjs): a required sign-in or the free disk failing holds every new spawn.
// Running workers carry on; the report names each failure and its fix, and the push names it once.
const HEALTH = await health({ state: STATE });
for (const s of HEALTH.stalls) personStall(s);
// Weekly usage pacing (usage-pace.mjs): new spawns hold while 7-day usage is ahead of an even pace by
// more than §3b "Usage pacing headroom (points)". That drains as the week goes on; a row that does not
// read holds every spawn until it is fixed, as a malformed budget does.
const PACE = usagePace();
if (PACE.bad) personStall(`${PACE.bad} — not spawning until it is fixed`);
else if (PACE.hold) report.stalled.push(`${PACE.line} (${running.length} running carry on; fix tries still start)`);
// A ticket keeps the tier it last ran on (a requeue after a park keeps the model; queue.mjs requeue
// raises it after a failure), and otherwise takes one from its triage record's lane and size.
const tierFor = (t) => {
  if (t.model_tier === 'standard' || t.model_tier === 'high') return t.model_tier;
  let size = null;
  try { size = JSON.parse(readFileSync(join(STATE, 'triage', `${t.key}.json`), 'utf8')).size ?? null; } catch { /* unsized: high */ }
  return E.modelTier({ lane: t.lane, size });
};

// Concurrency: the queue's field (the orchestrator's per-pass ladder decision, or a count the user
// set), never above the cap from config §3b "Autopilot worker concurrency" (`<default> / <cap>`,
// default 2 / 3). The report says whose number it is.
const CONC = batchConcurrency(fresh, E.concurrencyLimits());
const concurrency = CONC.n;

// Memory gate. Weighing only budget and concurrency would leave the whole memory ladder resting on
// the orchestrator remembering to apply it between passes — and its context is deliberately flat,
// so it forgets, and a session restart forgets for certain. Gate on "room to
// start something" (Linux MemAvailable; macOS free+inactive+purgeable), never on the footprint
// figure. This only ever DELAYS a spawn by one pass; it never kills anything.
// AUTOPILOT_MIN_AVAIL_GB overrides; 0 disables.
// The thresholds are config §3b "Spawn gate (available memory)": above `start` a new worker may start;
// between `hold` and `start` nothing new starts; below `hold` the batch is meant to run at `dropTo`
// workers, so nothing new starts until it has drained to that. AUTOPILOT_MIN_AVAIL_GB overrides
// `start` (0 disables the gate).
const GATE = E.spawnGate();
const MIN_AVAIL_GB = GATE.start;
const availGB = E.availableGiB();
const lowMemory = MIN_AVAIL_GB > 0 && availGB < MIN_AVAIL_GB;
if (lowMemory) {
  report.stalled.push(availGB < GATE.hold
    ? `memory: ${availGB.toFixed(1)}G available, under the ${GATE.hold}G floor — §3b says drop to ${GATE.dropTo} worker(s); ` +
      `holding spawns (${running.length} running; a worker mid-suite will drain)`
    : `memory: ${availGB.toFixed(1)}G available, in the §3b hold band (${GATE.hold}–${GATE.start}G) — holding spawns this pass ` +
      `(${running.length} running; a worker mid-suite will drain)`);
}
const runningKeys = new Set(running.map((r) => r.key));
const collidesWithRunning = (r) => (r.collides_with ?? '').split('|').filter(Boolean).some((k) => runningKeys.has(k));

// A ticket whose worker already printed AUTOPILOT_DONE has finished, whatever its state says. The
// orchestrator can requeue a parked ticket that in fact finished (answer.mjs only records the answer;
// un-parking is the orchestrator's decision), and this loop would spawn a SECOND worker onto a
// completed ticket. This is a guard, not the cure: markers are never consumed.
// A deliberate re-run is `queue.mjs requeue <TICKET>`, which moves the log aside; naming the ticket
// here does the same at spawn: AUTOPILOT_RERUN=<TICKET> node pass.mjs
const rerunAllowed = new Set((process.env.AUTOPILOT_RERUN ?? '').split(/[,\s]+/).filter(Boolean));

const alreadyFinished = (r) => {
  if (rerunAllowed.has(r.key)) return false;
  const log = join(STATE, 'logs', `${r.key}.log`);
  if (!existsSync(log)) return false;
  // Only what the worker printed, read the way harvest reads it: a tool call or tool result that
  // quotes the marker (a grep for it, say) is not the worker finishing.
  try { return workerMarkers(readFileSync(log, 'utf8')).some(([k]) => k === 'AUTOPILOT_DONE'); } catch { return false; }
};

const eligibleBase = all.filter((r) =>
  r.state === 'triaged' &&
  (r.open_questions ?? 0) === 0 &&
  !collidesWithRunning(r));
const blockedByDone = eligibleBase.filter(alreadyFinished);
// A killed worker waiting to resume, and a session handed off to its next stage, go ahead of every
// new ticket.
const toResume = (r) => ['pending', 'usage', 'maintenance'].includes(r.resume);
const toHandoff = (r) => r.handoff === 'pending';
const goesFirst = (r) => toResume(r) || toHandoff(r);
const eligible = eligibleBase.filter((r) => !alreadyFinished(r)).sort((a, b) => goesFirst(b) - goesFirst(a));
if (!maySpawn && eligible.length) {
  personStall(`not spawning ${eligible.length} ticket(s): config §3 ${HEADLESS_KEY} is "${headlessPerm}"` +
    (headlessPerm === 'ask' ? ' — confirm the batch with the user, then run passes with AUTOPILOT_USER_APPROVED=1' : ' — run /desk-setup to grant it'));
}
// Say why a triaged ticket is not spawning: a silent refusal reads as slowness.
if (blockedByDone.length) {
  personStall(`not respawning (its worker already printed AUTOPILOT_DONE): ${blockedByDone.map((r) => r.key).join(', ')} — ` +
    `if the re-run is deliberate: node ${join(BIN, 'queue.mjs')} requeue <TICKET>`);
}

// ---- slots, and borrowing ----------------------------------------------------
// Up to the batch's own number, as always. With config §3b "Borrow idle workers" on, the machine's
// free slots are counted, from every repo's queue, and the workers started under one lock every
// repo's pass shares, so two passes cannot both take the last slot: its own number as far as the
// machine has room, then above it up to the §3b cap into slots no other live batch has first claim
// on (borrow.mjs). Either way, with a machine profile its worker cap is a hard limit across every
// repo (machineBudget), counted under the same lock when it can be taken.
const BORROW = borrowSetting();
const MACHINE_CAP = machineCap();
const PACE_HELD = '7-day usage ahead of pace holds every spawn';
const usageHeldText = (h) => `${limitName(h.type)}${untilText(h)} holds every spawn and resume, until it lifts or a probe call succeeds`;
if (USAGE_HOLD) report.stalled.push(`${usageHeldText(USAGE_HOLD)} (probe: ${PROBE?.why ?? 'not run'})`);
const held = MAINT.hold ? 'the maintenance window holds every spawn' : USAGE_HOLD ? usageHeldText(USAGE_HOLD) : overBudget ? 'the batch budget holds every spawn' : modelsBad ? 'config §3b "Worker models" holds every spawn'
  : !CHECKIN.ok ? 'config §3b "Check-in times" holds every spawn'
  : HEALTH.failing.length ? `a failing health check (${HEALTH.failing.join(', ')}) holds every spawn`
  : !maySpawn ? `config §3 ${HEADLESS_KEY} is "${headlessPerm}"`
  : PACE.bad ? `config §3b "${E.CONFIG_ROWS['usage-pacing'].row}" holds every spawn`
  : PACE.hold ? PACE_HELD : null;
// Pacing holds new tickets, never a fix try: its PR is already out and stalls until the try runs, so
// it starts within the worker count as any spawn does.
const spawnable = held === PACE_HELD ? eligible.filter((r) => r.fix && !r.fix.finished) : eligible;
const spawnHeld = held === PACE_HELD && spawnable.length ? null : held;
let borrowLock = null;
let others = [];
let lockWhy = null;
if ((BORROW.on || MACHINE_CAP != null) && concurrency > 0 && spawnable.length && !spawnHeld && !lowMemory) {
  const l = await takeBorrowLock();
  if (l.ok) {
    borrowLock = l;
    process.on('exit', l.release);
  } else lockWhy = l.why;
}
// Read under the lock when it was taken; without it the count may race another pass, and says so.
const otherRepos = MACHINE_CAP != null || borrowLock ? otherQueues({ self: QUEUE_FILE }) : [];
if (borrowLock && BORROW.on) others = otherBatches({ self: QUEUE_FILE, queues: otherRepos });
const plan = borrowPlan({
  on: BORROW.on, share: concurrency, cap: E.concurrencyLimits().cap, running: running.length, wanted: spawnable.length,
  others, machine: MACHINE_CAP, memory: { avail: availGB, start: MIN_AVAIL_GB }, held: spawnHeld, lock: lockWhy,
});
const MACHINE = machineBudget({ running: running.length, wanted: Math.min(plan.slots, spawnable.length), machine: MACHINE_CAP, queues: otherRepos });
const slots = MAINT.hold ? 0 : Math.min(plan.slots, MACHINE.room);
const machineLine = MACHINE.line + (MACHINE_CAP != null && lockWhy ? ` (counted without the lock: ${lockWhy})` : '');
const CEILING = E.memoryCeiling();

// ---- batch base ------------------------------------------------------------
// A batch with a base keeps its own worktree for it (every pass makes sure it exists), and the default
// branch is merged into the base only before a pass that will spawn, so new workers start on a current
// tree. A sync that cannot run is reported; in feature mode it also holds this pass's spawns, since
// the feature's children are built and tested against the base as one.
const BASE = E.batchBase();
const SOURCE = E.configValue('default-branch');
// Config §3b "Promotion slice size (children)": how many children merge into the base between base
// gates in feature mode. Unset is 8; anything but a whole number from 5 to 10 is said and read as 8.
const SLICE_ROW = E.CONFIG_ROWS['promotion-slice'].row;
const SLICE = (() => {
  const raw = E.configValue('promotion-slice');
  if (raw == null) return { size: 8, bad: null };
  const n = /^\d+$/.test(String(raw).trim()) ? Number(raw) : NaN;
  if (n >= 5 && n <= 10) return { size: n, bad: null };
  return { size: 8, bad: `config §3b "${SLICE_ROW}" is "${raw}" — want a whole number from 5 to 10; read as 8` };
})();
// A base gate recorded as running whose process is still alive.
const gateAlive = (g) => {
  if (g?.state !== 'running' || !g.pid) return false;
  try { process.kill(g.pid, 0); return true; } catch { return false; }
};
const baseLines = [];
let baseHold = false;
const baselineSetting = E.configValue('baseline-checks');
const baselineOn = /^on$/i.test(String(baselineSetting ?? '').trim());
if (BASE && SOURCE && BASE !== SOURCE) {
  // plan-batch records the decision on the queue when it seeds; feature.json alone can name a spine
  // for a batch that runs as an ordinary one.
  const featureMode = fresh.feature === true;
  if (featureMode && SLICE.bad) report.waiting.push(SLICE.bad);
  const willSpawn = slots > 0 && spawnable.length > 0;
  const blocked = (why) => {
    report.waiting.push(`base sync: ${why} — ${featureMode ? 'feature mode, so nothing spawns this pass' : 'spawning carries on from the base as it stands'}`);
    if (featureMode) baseHold = true;
  };
  const wt = ensureBaseWorktree({ main: MAIN, worktrees: WORKTREES, base: BASE });
  if (wt.ok && wt.made) baseLines.push(`base worktree for ${BASE} made at ${wt.path}`);
  // A slice gate runs in the base worktree while children still spawn: nothing else touches it until
  // the gate is done, and spawns carry on from origin's base as it stands.
  const gateBusy = gateAlive(fresh.gate);
  if (!wt.ok) {
    if (willSpawn) blocked(wt.why);
    else report.waiting.push(`base worktree: ${wt.why}`);
  } else if (willSpawn && gateBusy) {
    baseLines.push(`base sync: skipped while the base gate runs in ${wt.path}; spawning carries on from ${BASE} as it stands`);
  } else if (willSpawn) {
    const s = syncBase({ path: wt.path, base: BASE, branch: SOURCE, push: mayPushBase, dry: DRY });
    if (s.ok && s.dry) baseLines.push(`base sync (dry run): would merge ${s.merged} commit(s) from ${SOURCE} into ${BASE}; nothing pushed`);
    else if (s.ok && s.merged) baseLines.push(`base sync: merged ${s.merged} commit(s) from ${SOURCE} into ${BASE} and pushed${s.retried ? ' (the first push was refused as non-fast-forward: fetched, merged again, retried once)' : ''}`);
    else if (s.ok) baseLines.push(`base sync: ${BASE} already has everything on ${SOURCE}`);
    else if (s.reason === 'conflict') blocked(`merging ${SOURCE} into ${BASE} conflicts, nothing pushed. Conflicting files: ${s.files.join(', ')}. Resolve it by hand in ${wt.path} and push`);
    else if (s.reason === 'permission') {
      blocked(`${BASE} is ${s.merged} commit(s) behind ${SOURCE} and config §3 ${BASE_PUSH_KEY} is "${basePushPerm}", so it was not synced` +
        (basePushPerm === 'ask' ? ': ask once for the batch, then run passes with AUTOPILOT_BASE_PUSH_APPROVED=1' : ''));
    } else blocked(s.why);
  }
  if (wt.ok && willSpawn && !gateBusy && !baseHold && baselineOn) recordBaseline(wt.path);
  if (wt.ok && featureMode && fresh.promotion == null) openPromotion(wt.path);
  else if (wt.ok && featureMode && fresh.promotion?.pr != null && !gateBusy) nextPromotion(wt.path, fresh.promotion);
}

// A promotion PR that merged into the default branch while children are still to merge into the base
// is followed by the next one, opened as the first was, and the count toward the next slice starts
// from that merge. The ledger comment is written afresh on the new PR by the next ledger update.
function nextPromotion(path, p) {
  if ((p.merged ?? []).some((m) => m.pr === p.pr)) return;
  const raw = sh('gh', ['pr', 'view', String(p.pr), '--repo', GH_REPO, '--json', 'state,mergedAt'], { tolerant: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let v;
  try { v = JSON.parse(raw); } catch { return; }
  if (v?.state !== 'MERGED') return;
  const slice = p.slice ?? 1;
  const merged = [...(p.merged ?? []), { pr: p.pr, slice, merged_at: v.mergedAt ?? null }];
  // The last promotion is the one every child had merged into the base before: a child merged after it
  // still has to be promoted.
  const at = v.mergedAt ? Date.parse(v.mergedAt) : null;
  if (Object.values(fresh.tickets).every((t) => t.merged_at && at != null && Date.parse(t.merged_at) <= at)) {
    if (!DRY) q('set-batch', `promotion.merged=${JSON.stringify(merged)}`);
    return;
  }
  baseLines.push(`promotion PR #${p.pr} (slice ${slice}) merged into ${SOURCE}`);
  if (DRY) { baseLines.push(`promotion PR (dry run): would open the next one, ${BASE} → ${SOURCE}`); return; }
  q('set-batch', 'gate=null');
  openPromotion(path, { slice: slice + 1, since: v.mergedAt ?? new Date().toISOString(), merged });
}

// ---- promotion PR ----------------------------------------------------------
// A feature-mode batch opens its promotion PR (base → default branch) as a draft on its first pass, so
// the feature has one PR to be reviewed by as it is built. It is tried once and recorded on the queue
// as `promotion` ({pr, url} or {pr: null, why}): a refusal is reported and the batch carries on
// without it. The base gate marks it ready; merging it is the person's.
function openPromotion(path, carry = {}) {
  const epic = fresh.epic ?? null;
  const title = `${epic ?? 'Feature'}: promote ${BASE} to ${SOURCE}${carry.slice ? ` (slice ${carry.slice})` : ''}`;
  if (DRY) { baseLines.push(`promotion PR (dry run): would open ${BASE} → ${SOURCE} as a draft, titled "${title}"`); return; }
  const record = (p) => q('set-batch', `promotion=${JSON.stringify({ ...carry, ...p, at: new Date().toISOString() })}`);
  const notOpened = (why) => {
    record({ pr: null, why });
    report.waiting.push(`promotion PR: not opened — ${why}. The batch carries on without it: open it by hand ` +
      `(gh pr create --repo ${GH_REPO} --draft --base ${SOURCE} --head ${BASE} --title "${title}"), then record it: queue.mjs set-batch promotion.pr=<number>`);
  };
  const prUrl = (n) => `https://github.com/${GH_REPO}/pull/${n}`;
  const existing = sh('gh', ['pr', 'list', '--repo', GH_REPO, '--head', BASE, '--base', SOURCE, '--state', 'open', '--json', 'number', '--jq', '.[0].number'], { tolerant: true });
  if (/^\d+$/.test(existing)) {
    record({ pr: Number(existing), url: prUrl(existing) });
    baseLines.push(`promotion PR #${existing} (${BASE} → ${SOURCE}) was already open: recorded`);
    return;
  }
  const openPerm = E.permission('pr-open');
  if (openPerm !== 'yes') { notOpened(`config §3 ${E.permissionKey('pr-open')} is "${openPerm}"`); return; }
  const c = openingCommit({ path, base: BASE, branch: SOURCE, push: mayPushBase, message: `${epic ?? 'feature'}: open the promotion PR for ${BASE}` });
  if (!c.ok) {
    notOpened(c.reason === 'permission'
      ? `${BASE} has no commits beyond ${SOURCE}, and the empty commit a PR needs is a push config §3 ${BASE_PUSH_KEY} ("${basePushPerm}") does not grant${basePushPerm === 'ask' ? ' without AUTOPILOT_BASE_PUSH_APPROVED=1' : ''}`
      : c.why);
    return;
  }
  const body = [
    `Promotion PR for ${epic ?? 'this feature'}: everything the batch merges into \`${BASE}\`, landing on \`${SOURCE}\` as one feature.`,
    '',
    `It stays draft while the batch runs. Each time ${SLICE.size} children have merged into \`${BASE}\` since the last promotion, a child labelled \`milestone\` merges, or the last child merges, the base gate merges \`${SOURCE}\` in and runs every acceptance spec and the repo's Typecheck, Lint and Unit tests there, and marks it ready only when they pass. Merging it is a person's call; once it merges, the next promotion PR opens for the children still to come.`,
  ].join('\n');
  const made = shOut('gh', ['pr', 'create', '--repo', GH_REPO, '--draft', '--base', SOURCE, '--head', BASE, '--title', title, '--body', body]);
  const url = /https?:\/\/\S+\/pull\/\d+/.exec(made.out)?.[0];
  if (!made.ok || !url) { notOpened(`gh pr create failed: ${made.out.split('\n').filter(Boolean).pop() ?? 'no output'}`); return; }
  const n = Number(/\/pull\/(\d+)/.exec(url)[1]);
  record({ pr: n, url });
  baseLines.push(`promotion PR #${n} opened as a draft, ${BASE} → ${SOURCE}${c.pushed ? ` (after an empty commit pushed to ${BASE}, which had none beyond ${SOURCE})` : ''}: ${url}`);
}

// ---- baseline checks -------------------------------------------------------
// With config §4 Baseline checks on, the base's Typecheck and Lint errors are recorded in the base
// worktree before a pass spawns, whenever the base has moved since the last record, so workers fail
// only on errors they add (baseline.mjs). A base that cannot be recorded leaves no baseline at all:
// workers then run the full checks rather than compare against an older base.
// Workers branch from origin's base, so a base worktree that a failed sync left behind it is not
// recorded either.
function recordBaseline(path) {
  const head = sh('git', ['-C', path, 'rev-parse', 'HEAD'], { tolerant: true });
  const origin = sh('git', ['-C', path, 'rev-parse', `origin/${BASE}`], { tolerant: true });
  const prior = BL.readBaseline(STATE);
  if (head && head === origin && prior && prior.base === BASE && prior.sha === head) return;
  if (DRY) { baseLines.push(`baseline (dry run): would record ${BASE} at ${head.slice(0, 12)}`); return; }
  const drop = (why) => {
    try { unlinkSync(BL.baselineFile(STATE)); } catch { /* none recorded */ }
    report.waiting.push(`baseline: not recorded for ${BASE} at ${head.slice(0, 12) || '?'}: ${why} — workers run the full Typecheck and Lint`);
  };
  if (!head) return drop(`could not read the base worktree's HEAD in ${path}`);
  if (head !== origin) return drop(`the base worktree ${path} is not at origin's ${BASE} (${origin.slice(0, 12) || 'unreadable'}), which workers start from`);
  if (sh('git', ['-C', path, 'status', '--porcelain'], { tolerant: true })) return drop(`the base worktree ${path} has uncommitted changes`);
  const items = (id) => { const v = E.configValues(id); return v && !E.isNone(v) ? v.map(E.parseCommandItem) : []; };
  const pre = E.configValue('command-prefix');
  const prefix = pre && !E.isNone(pre) ? pre.trim() : '';
  const run = (lock, { dir, cmd }) => BL.runItem({ bin: BIN, root: path, dir, cmd, lock, prefix });
  let list;
  try { list = { typecheck: items('typecheck-cmd'), lint: items('lint-cmd') }; } catch (e) { return drop(e.message); }
  // The base worktree is a plain checkout, so it gets the dependencies the checks need.
  for (const it of (() => { try { return items('install-cmd'); } catch { return []; } })()) {
    const r = run('nolock', it);
    if (r.code !== 0) { restore(path); return drop(`config §4 Install (${it.cmd}) failed there with exit ${r.code}`); }
  }
  const b = BL.recordBaseline({ stateDir: STATE, root: path, base: BASE, sha: head, items: list, run: ({ name, ...it }) => run(E.lockFor(BL.CHECKS[name]), it) });
  const changed = restore(path);
  baseLines.push(`baseline: recorded ${BASE} at ${head.slice(0, 12)}: ${BL.summary(b)}${changed ? ' (the checks changed files in the base worktree; put back)' : ''}`);
}
// An install or a lint fixer can write to the base worktree, and the next sync refuses a dirty one.
function restore(path) {
  if (!sh('git', ['-C', path, 'status', '--porcelain'], { tolerant: true })) return false;
  sh('git', ['-C', path, 'checkout', '-q', '--', '.'], { tolerant: true });
  sh('git', ['-C', path, 'clean', '-fdq'], { tolerant: true });
  return true;
}
const baselineBrief = () => {
  const a = BL.activeBaseline({ setting: baselineSetting, base: BASE && BASE !== SOURCE ? BASE : null, stateDir: STATE });
  if (!a.on) return '';
  return [
    '## Baseline checks',
    '',
    `This batch's base, ${a.b.base}, has errors recorded at ${a.b.sha.slice(0, 12)}: ${BL.summary(a.b)}.`,
    'Run `desk-env baseline typecheck` and `desk-env baseline lint` in place of §4 Typecheck and Lint, from your worktree. Each runs the same commands under the same locks and fails only on errors your branch adds, in any file, naming each one. A `FULL` line means the comparison could not read that output, and that check ran in full.',
    'Do not fix a recorded error your ticket does not need. CI and the pre-push hook still run the full checks, so a base with existing errors stays red there.',
    '',
  ].join('\n');
};

// Every attempt takes a slot, failed or not, so a fault every ticket shares costs at most `slots`
// tickets a pass; a slots that is not a number spawns nothing.
let attempts = 0;
// Ports held by running workers in every other batch's queue, this repo's other batches included. Two
// batches' worker blocks can meet, and a worker's port is unbound until it starts a server, so probing
// cannot see one another batch's pass has just handed out. Only running tickets hold one. A queue that will not parse is named in the report
// and skipped, never a hold.
const unreadableQueues = new Set();
function otherQueuePorts() {
  const ports = new Set();
  for (const { q: other, error } of otherQueues({ self: QUEUE_FILE })) {
    if (error) { unreadableQueues.add(error); continue; }
    for (const r of Object.values(other.tickets ?? {})) if (r?.state === 'running' && Number(r.port) > 0) ports.add(Number(r.port));
  }
  return ports;
}
// Assign a port nothing else holds. Three things make one unavailable: another ticket in this batch
// already holds it (a worker's port is unbound until it starts a server, so a bind check alone races),
// a running worker in another batch's queue holds it (two batches' worker blocks can meet), or something
// is listening on it. The floor is one above the user's own dev port (E.workerPortFloor, shared with
// spawn-worker.sh; AUTOPILOT_PORT_FLOOR overrides). A resumed worker keeps its own port if it is free.
async function freePort(own = null) {
  const taken = new Set([...Object.values(queue().tickets).filter((r) => r.key !== own?.key).map((r) => Number(r.port)).filter(Boolean), ...otherQueuePorts()]);
  if (Number(own?.port) > 0 && !taken.has(Number(own.port)) && !(await E.portInUse(Number(own.port)))) return Number(own.port);
  let port = E.workerPortFloor();
  while (taken.has(port) || await E.portInUse(port)) port += 1;
  return port;
}

// Prove the generated permissions behave before committing a worker to a ticket: `failure` is null on
// a pass, else what failed. §3b Worker models' finder and text models are proved too, on every
// preflight, so a value the CLI rejects stops the ticket before any worker of it runs. `cost` is the
// preflight call's { usd, turns }, each null when it reported none.
function preflight(key, wt, workerEnv) {
  const pre = shOut('bash', [join(BIN, 'spawn-worker.sh'), key, wt, 'preflight'], {
    cwd: MAIN,
    env: { ...process.env, ...workerEnv, AUTOPILOT_FINDER_MODEL: models.finder ?? '', AUTOPILOT_TEXT_MODEL: models.text ?? '', AUTOPILOT_PREFLIGHT: '1' },
  }).out;
  const m = /\[preflight\] cost=(\S+) turns=(\S+)/.exec(pre);
  const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const cost = { usd: num(m?.[1]), turns: num(m?.[2]) };
  const failure = /\[preflight\] pass/.test(pre) ? null : `${pre.split('\n').filter((l) => /FAIL|!!/.test(l)).join('\n') || pre.slice(-300)}\n${preflightNote(cost)}`;
  // A call refused at the usage limit (spawn-worker.sh says so): nothing about the worker failed.
  return { failure, cost, limit: !!failure && /^\[preflight\] usage-limit/m.test(pre) };
}
// A preflight the usage limit refused holds the batch: the ticket keeps its place and state, and
// nothing else spawns or preflights this pass. The probe names the limit where it can.
let usageStop = false;
function preflightHitLimit(t, cost) {
  logPreflight(t.key, cost);
  const l = probeOnce().limit ?? { type: 'unknown', resetsAt: null };
  USAGE_HOLD ??= { type: l.type, resetsAt: l.resetsAt, preflight: t.key };
  USAGE_HOLD.preflight ??= t.key;
  usageStop = true;
  report.stalled.push(`${t.key}: its preflight was refused at ${limitName(USAGE_HOLD.type)} — not failed, and nothing else spawns until the limit lifts`);
}
const preflightNote = ({ usd, turns }) =>
  `preflight ${usd == null ? 'cost unknown' : `$${usd.toFixed(2)}`}, ${turns == null ? 'turns unknown' : `${turns} turn(s)`}`;
// Into the log the worker is about to write, so the batch report counts it with that run; a failed
// one goes into the log as it stands, and the next spawn moves it aside with that round. Returns the
// log's size, the stall check's starting point: the line is not the worker's output.
const logPreflight = (key, cost) => {
  const log = join(STATE, 'logs', `${key}.log`);
  mkdirSync(join(STATE, 'logs'), { recursive: true });
  appendFileSync(log, preflightLine(cost));
  return statSync(log).size;
};
const spawnRefusal = (out) => (/\[spawn\] ticket=/.test(out) ? null : `spawn refused — ${out.split('\n').slice(-3).join(' ')}`);

// A killed worker resumes in its own session, worktree, branch and log, through spawn-worker.sh and
// so inside the worker sandbox, with AUTOPILOT_RESUME as its next prompt. Its briefing is the one it
// was spawned with. A worker that exited at the usage limit (resume=usage) resumes the same way, but
// was not killed: it is not counted against config §3b "Resume a killed worker (times)". Nor is one the
// maintenance window stopped at its drain limit (resume=maintenance).
async function resumeKilled(t) {
  const usage = t.resume === 'usage';
  const maint = t.resume === 'maintenance';
  const n = (t.resumes ?? 0) + (usage || maint ? 0 : 1);
  const ended = usage ? 'exited at the usage limit' : maint ? 'stopped for the maintenance window' : 'killed before it finished';
  // spawn_failed: no worker ran, so a requeue does not read this as the model falling short.
  const fail = (why) => {
    q('set', t.key, 'state=failed', 'resume=null', 'port=null', 'spawn_failed=true');
    report.failed.push(`${t.key}: ${ended}, and could not be resumed: ${why}`);
  };
  // The row may have changed while it waited for a slot.
  const stop = usage || maint ? null : resumeRefusal(t, t.resume_why ?? 'reboot or crash');
  if (stop?.fail) return fail(stop.fail);
  if (stop?.park) {
    q('set', t.key, 'resume=null');
    q('park', t.key, stop.park);
    report.parked.push(`${t.key}: ${stop.park}`);
    return undefined;
  }
  if (!t.worktree || !existsSync(t.worktree)) return fail(`its worktree ${t.worktree ?? '(none recorded)'} is gone. Requeue it for a fresh worker with queue.mjs requeue ${t.key}`);
  const model = t.model && t.model !== 'default' ? t.model : '';
  const workerEnv = { AUTOPILOT_BRANCH: t.branch ?? '', AUTOPILOT_DATABASE: t.database ?? 'none', AUTOPILOT_MODEL: model };
  const pre = preflight(t.key, t.worktree, workerEnv);
  if (pre.limit) return preflightHitLimit(t, pre.cost);
  if (pre.failure) { logPreflight(t.key, pre.cost); return fail(`preflight failed —\n${pre.failure}`); }
  const port = await freePort(t);
  const briefPath = join(STATE, 'briefings', `${t.key}.md`);
  const prompt = `Your previous run of this session ${usage ? 'ended' : maint ? 'was stopped before it finished' : 'was killed before it finished'} (${t.resume_why ?? 'reboot or crash'}). ` +
    `Carry on with ticket ${t.key} from where you stopped, in your worktree ${t.worktree} on branch ${t.branch}. ` +
    'A command may have been cut off part way: check git status, git log and any server or suite you had running before you go on, and redo only what did not finish. ' +
    `Your dev-server port is ${port} — never use ${E.configValue('dev-port') ?? 'the user\'s own port'}. The worker contract in your system prompt still binds.`;
  const log = join(STATE, 'logs', `${t.key}.log`);
  logPreflight(t.key, pre.cost);
  q('set', t.key, 'state=running', 'resume=null', `resumes=${n}`, `port=${port}`, 'idle_passes=0',
    `log_bytes=${existsSync(log) ? statSync(log).size : 0}`);
  const spawned = shOut('bash', [join(BIN, 'spawn-worker.sh'), t.key, t.worktree, t.session_id, ...(existsSync(briefPath) ? [briefPath] : [])], {
    cwd: MAIN,
    env: { ...process.env, ...workerEnv, AUTOPILOT_PORT: String(port), AUTOPILOT_RESUME: prompt, ...(DRY ? { AUTOPILOT_DRY_RUN: '1' } : {}) },
  });
  const refused = spawnRefusal(spawned.out);
  if (refused) return fail(refused);
  report.spawned.push(`${t.key} resumed ${usage ? 'after the usage limit lifted' : maint ? 'after the maintenance window' : `after it was killed (${n} of ${RESUME.limit})`} — ${t.resume_why ?? 'reboot or crash'}; session ${t.session_id} port=${port}; ${preflightNote(pre.cost)}`);
  runningKeys.add(t.key);
}

// The briefing carries what a fresh `claude -p` cannot infer: who to ask, what sibling tickets have
// learnt, and — critically — the answers the user has already given. Compose it, never overwrite the
// answers: answer.mjs writes into this file, and clobbering it silently sends the worker in without the
// answer it was blocked on. A session started from a handoff gets the handoff briefing in place of the
// sibling notes: what it needs is what the session before it did, and paying for the notes again is
// what the handoff saves. A round resumed after a park keeps the notes: it may still be building.
function writeBrief(t, wt, handoff = '', { notes = !handoff } = {}) {
  const notesFile = join(STATE, 'batch-notes.md');
  const answerFile = join(STATE, 'answers', `${t.key}.txt`);
  mkdirSync(join(STATE, 'briefings'), { recursive: true });
  const briefPath = join(STATE, 'briefings', `${t.key}.md`);
  const prior = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '';
  // Keep ONLY the answers, not the rest of the file, but keep EVERY answer section: answer.mjs
  // appends after the sibling-notes block, so a requeue's answer sits below it (collectAnswers).
  // Running to end-of-file swallowed the notes, so every respawn folded another copy in; one briefing
  // reached 194KB and, riding in --append-system-prompt, blew Linux's 128KB single-argument cap
  // (MAX_ARG_STRLEN): "Argument list too long", and every new worker died instantly.
  const priorAnswers = prior.includes(ANSWER_HEAD)
    ? collectAnswers(prior)
    : existsSync(answerFile)
      ? `${ANSWER_HEAD}\n\n${readFileSync(answerFile, 'utf8')}`
      : '';
  const parts = (h) => [
    `Orchestrator session name: ${orchestratorName()}`,
    `Answer file to wait on: ${answerFile}`,
    `Screenshot directory (print it as AUTOPILOT_IMAGES once it holds your screenshots; captured none, print nothing): ${join(STATE, 'images', t.key)}/`,
    '',
    // Before the answers: collectAnswers keeps everything from an answer heading to the sibling
    // notes, or to the end of the file, so nothing but answers may follow one.
    h,
    ownedBrief(t, wt),
    fixBrief(t),
    baselineBrief(),
    priorAnswers && `These questions were put to the user before you started. Their answers are binding — do not re-ask them.\n\n${priorAnswers}`,
    notes && existsSync(notesFile) ? `## What sibling workers in this batch have found\n\n${readFileSync(notesFile, 'utf8')}` : '',
  ].filter(Boolean).join('\n');
  // An oversized handoff briefing is cut, with the note, before the answers that follow it, so a cut
  // never drops a binding answer. The whole briefing is capped either way (capBriefing).
  const room = Math.max(0, MAX_BRIEF - parts('').length - BRIEF_CUT.length - 4);
  writeFileSync(briefPath, capBriefing(parts(handoff.length > room ? capBriefing(handoff, room) : handoff)));
  return briefPath;
}

// A requeued ticket whose worker parked at Stage 3 or later resumes at the stage that round reached,
// with its summary in the briefing, when its worktree was kept, is on the queue's branch, and has no
// resume file (the worker's in the state dir, or one in the worktree) that records another (resumeCheck). A round that cannot be resumed is said in the
// briefing, and the worker starts at Stage 0. Returns { stage, brief, line }: stage null for Stage 0.
function resumeRound(t, { wt, kept, branch }) {
  const round = t.last_round;
  const stage = roundStage(round?.stage);
  if (!stage || !kept) return { stage: null, brief: '', line: '' };
  const r = resumeCheck({ worktree: wt, key: t.key, branch, stateDir: STATE });
  if (!r.ok) {
    return { stage: null, brief: renderNoResume({ round: { stage }, why: r.why, path: r.path }), line:` from Stage 0 (not resumed from Stage ${stage}: ${r.why})` };
  }
  const briefPath = join(STATE, 'briefings', `${t.key}.md`);
  const answers = answersSince(existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '', round.at);
  const base = `origin/${DEFAULT_BRANCH}`;
  const brief = renderLastRound({ key: t.key, round: { ...round, stage }, answers, branch, worktree: wt, base, commits: branchCommits(wt, base), resumePath: r.path });
  return { stage, brief, line: ` resumed at Stage ${stage}, where its last round parked` };
}

// A session that handed off is followed by a fresh one, with a new session id, in the same worktree and
// on the same branch, starting at the stage it named with the handoff briefing in its system prompt.
// Its log starts as a round of its own, so the batch report adds every session's tokens and cost.
async function spawnHandoff(t) {
  // queue.mjs stores a stage of 7 as a number.
  const stage = t.handoff_stage == null ? '' : String(t.handoff_stage);
  const parkIt = (why) => { q('set', t.key, 'handoff=null'); q('park', t.key, why); report.parked.push(`${t.key}: ${why}`); };
  if (!HANDOFF_STAGES[stage]) return parkIt(`handed off to "${stage}", which no session starts at, so no session was spawned. ${FROM_ZERO(t)}`);
  // The worktree may have gone while it waited for a slot.
  const refused = handoffRefusal(t, stage);
  if (refused) return parkIt(refused);
  const { data } = readHandoff(STATE, t.key);
  const commits = branchCommits(t.worktree, `origin/${DEFAULT_BRANCH}`);
  const briefPath = writeBrief(t, t.worktree, renderHandoff({ key: t.key, stage, data, branch: t.branch, worktree: t.worktree, base: `origin/${DEFAULT_BRANCH}`, commits }));
  // The ticket's tier as the fresh spawn reads it, so a tier a requeue raised reaches this session too.
  // A Stage 7 session runs on §3b Worker models' text model where one is set; the tier is kept, so a
  // requeue raises the same tier it would have.
  const tier = tierFor(t);
  const model = stage === '7' && models.text ? models.text : models.off ? '' : models[tier];
  const workerEnv = { AUTOPILOT_BRANCH: t.branch, AUTOPILOT_DATABASE: t.database ?? 'none', AUTOPILOT_MODEL: model };
  const fail = (why) => {
    q('set', t.key, 'state=failed', 'handoff=null', 'session_id=null', 'port=null', 'spawn_failed=true');
    report.failed.push(`${t.key}: handed off to Stage ${stage}, and the new session could not be spawned: ${why}`);
  };
  const pre = preflight(t.key, t.worktree, workerEnv);
  if (pre.limit) return preflightHitLimit(t, pre.cost);
  if (pre.failure) { logPreflight(t.key, pre.cost); return fail(`preflight failed —\n${pre.failure}`); }
  const sid = E.uuid();
  const port = await freePort(t);
  E.rotateRound(t.key);
  const logBytes = logPreflight(t.key, pre.cost);
  q('set', t.key, 'state=running', `session_id=${sid}`, `stage=${stage}`, `port=${port}`, `log_bytes=${logBytes}`, 'idle_passes=0',
    'handoff=null', 'last_round=null', `model_tier=${models.off ? 'null' : tier}`, `model=${model || 'default'}`, 'resume=null', 'resume_why=null', 'resumes=null', 'resume_limits=null', 'usage_paused=null');
  const spawned = shOut('bash', [join(BIN, 'spawn-worker.sh'), t.key, t.worktree, sid, briefPath], {
    cwd: MAIN,
    env: { ...process.env, ...workerEnv, AUTOPILOT_PORT: String(port), AUTOPILOT_START_STAGE: stage, ...(DRY ? { AUTOPILOT_DRY_RUN: '1' } : {}) },
  });
  const spawnRefused = spawnRefusal(spawned.out);
  if (spawnRefused) return fail(spawnRefused);
  report.spawned.push(`${t.key} fresh session from Stage ${stage} (handed off) port=${port} model=${model || 'default'}; ${preflightNote(pre.cost)}`);
  runningKeys.add(t.key);
  return undefined;
}

for (const t of spawnable) {
  if (baseHold || !(attempts < slots)) break;
  // A ticket spawned earlier in this pass is running too: two that collide never start together.
  if (collidesWithRunning(t)) continue;
  attempts += 1;
  if (toResume(t)) {
    // eslint-disable-next-line no-await-in-loop
    await resumeKilled(t);
    if (usageStop) break;
    continue;
  }
  if (toHandoff(t)) {
    // eslint-disable-next-line no-await-in-loop
    await spawnHandoff(t);
    if (usageStop) break;
    continue;
  }
  const wt = join(WORKTREES, t.key);
  // Read before setup-worktree.sh, which makes a worktree that is not there: a round left in one the
  // requeue removed for a fresh branch is not resumed.
  const kept = existsSync(wt);
  // A queued branch no worker could push (a convention placeholder left in at triage) is replaced
  // from the key and summary before setup-worktree.sh cuts it.
  let renamed = '';
  if (!kept && t.branch && E.branchProblem(t.branch)) {
    let summary = null;
    try { summary = JSON.parse(readFileSync(join(STATE, 'triage', `${t.key}.json`), 'utf8')).summary; } catch { /* key only */ }
    const fixed = E.branchFor({ key: t.key, type: t.type, summary, from: t.branch });
    renamed = ` (branch ${t.branch ?? 'none'} was unusable: ${E.branchProblem(t.branch)}; now ${fixed})`;
    q('set', t.key, `branch=${fixed}`);
    t.branch = fixed;
  }
  // --for-worker: the human's own .claude/settings.local.json never reaches a worker's worktree.
  // The exit code is the verdict, never the directory's existence: setup-worktree.sh removes a
  // worktree it could not finish, and a half-built one must not get a worker.
  const setupRun = shOut('bash', [join(BIN, 'setup-worktree.sh'), '--for-worker', t.key, t.branch], { cwd: MAIN });
  const setup = setupRun.out;
  const setupWt = [...setup.matchAll(/\[setup-worktree\] worktree=(.+)/g)].pop()?.[1]?.trim();
  if (!setupRun.ok || setupWt !== wt || !existsSync(wt)) {
    const why = setup.split('\n').filter((l) => /FAIL|WARNING|failed/.test(l)).slice(-3).join(' ') || setup.slice(-200);
    q('park', t.key, `worktree setup failed, not spawned — ${why}`);
    report.parked.push(`${t.key}: worktree setup failed, not spawned — ${why}`);
    continue;
  }
  // The branch this ticket's PR must come from: recorded so the merge driver matches the PR by
  // branch, never by a fuzzy key search.
  const branch = [...setup.matchAll(/\[setup-worktree\] branch=(\S+)/g)].pop()?.[1] ?? t.branch;
  // setup-worktree.sh names the per-ticket database it created, or says `none` (every database
  // variable blanked). One source, never re-derived here.
  const database = [...setup.matchAll(/\[setup-worktree\] database=(\S+)/g)].pop()?.[1] ?? 'none';
  // The preflight runs on the worker's own model, so a model the CLI rejects fails it here.
  const tier = tierFor(t);
  const model = models.off ? '' : models[tier];
  const workerEnv = { AUTOPILOT_BRANCH: branch, AUTOPILOT_DATABASE: database, AUTOPILOT_MODEL: model };

  const resumed = resumeRound(t, { wt, kept, branch });
  const briefPath = writeBrief(t, wt, resumed.brief, { notes: true });

  const pre = preflight(t.key, wt, workerEnv);
  if (pre.limit) { preflightHitLimit(t, pre.cost); break; }
  if (pre.failure) {
    logPreflight(t.key, pre.cost);
    // spawn_failed: no worker ran, so a requeue does not read this as the model falling short.
    q('set', t.key, 'state=failed', 'spawn_failed=true');
    report.failed.push(`${t.key}: preflight failed, not spawned —\n${pre.failure}`);
    continue;
  }

  const sid = E.uuid();

  // eslint-disable-next-line no-await-in-loop
  const port = await freePort();

  // Reset the stall counters: a respawn after a log rotation starts a smaller log than the stored
  // size, and without this the stall killer shoots each fresh worker within a pass or two.
  // Clear the previous round's PR and image flags too: a stale result.pr sent this round's
  // screenshots to the last round's PR, and a stale images_uploaded=true stopped them uploading.
  // Every spawn is a fresh session, so the last round's log and park record move aside first:
  // spawn-worker.sh appends to the log, and a kept park file reads as this worker's question.
  E.rotateRound(t.key);
  const logBytes = logPreflight(t.key, pre.cost);
  // A worker starting at Stage 0 writes its own handoff briefing; an earlier round's must not stand in for it.
  if (existsSync(handoffPath(STATE, t.key))) renameSync(handoffPath(STATE, t.key), `${handoffPath(STATE, t.key)}.old`);
  // So does its resume file: desk-ticket resumes from one it finds, and this round was not resumed.
  if (!resumed.stage && existsSync(workerResumePath(STATE, t.key))) renameSync(workerResumePath(STATE, t.key), `${workerResumePath(STATE, t.key)}.old`);
  q('set', t.key, 'state=running', `session_id=${sid}`, `worktree=${wt}`, `branch=${branch}`, `stage=${resumed.stage ?? '0/9'}`, 'last_round=null',
    `port=${port}`, `database=${database}`, `log_bytes=${logBytes}`, 'idle_passes=0',
    'result=null', 'draft_pr=null', 'images_uploaded=null', 'images_reported=null',
    // No tier at `default`: nothing ran on one, so a requeue has nothing to raise.
    `model_tier=${models.off ? 'null' : tier}`, `model=${model || 'default'}`, 'spawn_failed=null', 'out_of_scope=null', 'usage_unrecognised=null',
    // A fresh session has not been resumed, and starts at Stage 0 rather than from a handoff.
    'resume=null', 'resume_why=null', 'resumes=null', 'resume_limits=null', 'usage_paused=null',
    'handoff=null', 'handoff_stage=null', 'handoff_cost=null', 'images_dir=null');
  // A ticket first spawned before spawned_at was recorded keeps its earliest round's start: that
  // round's log was moved aside above, and the history measures from it.
  const now = new Date().toISOString();
  const earlier = t.spawned_at ? null : firstSpawnFromLogs(STATE, t.key);
  const spawnedAt = earlier && Date.parse(earlier) < Date.parse(now) ? earlier : now;
  const spawned = shOut('bash', [join(BIN, 'spawn-worker.sh'), t.key, wt, sid, briefPath], {
    cwd: MAIN,
    env: { ...process.env, ...workerEnv, AUTOPILOT_PORT: String(port), ...(resumed.stage ? { AUTOPILOT_START_STAGE: resumed.stage } : {}),
      // A fix try's worker is given the fix as its task, in place of working the ticket from Stage 0.
      ...(t.fix && !t.fix.finished && !resumed.stage ? { AUTOPILOT_TASK: fixTask(t) } : {}),
      ...(DRY ? { AUTOPILOT_DRY_RUN: '1' } : {}) },
  });
  const refused = spawnRefusal(spawned.out);
  if (refused) {
    q('set', t.key, 'state=failed', 'session_id=null', 'port=null', 'spawn_failed=true');
    report.failed.push(`${t.key}: ${refused}`);
    continue;
  }
  // The first spawn is kept across requeues: the eta history measures spawn to merge from it.
  if (!t.spawned_at) q('set', t.key, `spawned_at=${spawnedAt}`);
  report.spawned.push(`${t.key} port=${port} db=${database} model=${model || 'default'}${renamed}${resumed.line}${t.fix && !t.fix.finished ? (t.fix.kind === 'gaps' ? ` (the person's call on PR #${t.fix.pr}'s review gaps)` : ` (fix try ${t.fix.try} of ${t.fix.of} on PR #${t.fix.pr})`) : ''}; ${preflightNote(pre.cost)}`);
  runningKeys.add(t.key);
}
// Every worker started under the lock is recorded running in this queue, so other passes count it.
borrowLock?.release();
// The batch's hold on the usage limit, for desk-q, needs-you and the next pass: one record, kept from
// the first pass that held until the one that finds it lifted.
{
  const was = queue().usage_hold;
  if (USAGE_HOLD) {
    const rec = { since: was?.since ?? PASS_AT, type: USAGE_HOLD.type, resets_at: USAGE_HOLD.resetsAt, preflight: USAGE_HOLD.preflight ?? null,
      paused: usageHolds.map((h) => h.key) };
    q('set-batch', `usage_hold=${JSON.stringify(rec)}`);
  } else if (was) q('set-batch', 'usage_hold=null');
}
const borrowLine = borrowedLine(plan, { share: concurrency, running: running.length, spawned: report.spawned.length });

// ---- epics ---------------------------------------------------------------
// A triage record written before ticket-facts.mjs recorded `epic` has no such key, and a ticket
// already triaged is not triaged again, so desk-q would read it as having no epic for good. Read the
// epic alone for each unfinished one (ticket-facts.mjs --epic); a record whose `epic` is null was
// looked up and has none, and is left alone. A read that fails is tried again next pass.
const epicLines = [];
const onJira = /^jira\b/i.test(String(E.configValue('tracker') ?? '').trim());
const unreadEpics = Object.values(queue().tickets).filter((t) => {
  if (!onJira || t.state === 'done') return false;
  const k = E.ticketKind(t.key);
  if (!k.ok || k.kind !== 'tracker') return false;
  try { return epicUnread(JSON.parse(readFileSync(join(STATE, 'triage', `${t.key}.json`), 'utf8'))); } catch { return false; }
}).map((t) => t.key);
if (unreadEpics.length) {
  const r = shOut('node', [join(BIN, 'ticket-facts.mjs'), '--epic', ...unreadEpics], { timeout: 120_000 });
  const missed = r.out.split('\n').filter((l) => / epic NOT READ: /.test(l));
  epicLines.push(`epics: read for ${unreadEpics.length - missed.length} of ${unreadEpics.length} triage record(s) written before epics were recorded`
    + (missed.length ? ` — not read, tried again next pass: ${missed.map((l) => l.replace(/^\[facts\]\s*/, '')).join(' | ')}` : r.ok ? '' : ` — ${r.out.split('\n').pop()}`));
}

// ---- outside blockers ----------------------------------------------------
// A ticket's open "is blocked by" links to tickets outside this queue, from its triage record's
// `blockers`, kept on the ticket as outside_blockers [{key, category}] for desk-q. Only a ticket that
// has some is read from Jira again (ticket-facts.mjs --blockers), at most once every INTAKE_EVERY_MS,
// so this reads Jira no more often than intake does. A read that fails leaves the record, and so the
// recorded blockers, as they were.
const qB = queue();
const triageRec = (key) => { try { return JSON.parse(readFileSync(join(STATE, 'triage', `${key}.json`), 'utf8')); } catch { return null; } };
const outsideOf = (rec) => (Array.isArray(rec?.blockers)
  ? rec.blockers.filter((b) => !(b.key in qB.tickets) && b.category !== 'done').map((b) => ({ key: b.key, category: b.category }))
  : null);
const onTracker = Object.values(qB.tickets).filter((t) => {
  if (!onJira || t.state === 'done') return false;
  const k = E.ticketKind(t.key);
  return k.ok && k.kind === 'tracker';
});
const blockersDue = onTracker.filter((t) => (t.outside_blockers ?? outsideOf(triageRec(t.key)) ?? []).length > 0
  && !(t.outside_blockers_read && Date.now() - Date.parse(t.outside_blockers_read) < INTAKE_EVERY_MS)).map((t) => t.key);
if (blockersDue.length) {
  const r = shOut('node', [join(BIN, 'ticket-facts.mjs'), '--blockers', ...blockersDue], { timeout: 120_000 });
  const missed = r.out.split('\n').filter((l) => / blockers NOT READ: /.test(l));
  if (missed.length || !r.ok) epicLines.push(`outside blockers: not read, kept as they were and tried again in ${INTAKE_EVERY_MS / 60_000} minutes: ${missed.map((l) => l.replace(/^\[facts\]\s*/, '')).join(' | ') || r.out.split('\n').pop()}`);
  const readAt = new Date().toISOString();
  for (const key of blockersDue) q('set', key, `outside_blockers_read=${readAt}`);
}
for (const t of onTracker) {
  const now = outsideOf(triageRec(t.key));
  if (now && JSON.stringify(now) !== JSON.stringify(t.outside_blockers ?? null)) q('set', t.key, `outside_blockers=${JSON.stringify(now)}`);
}

// ---- base drift ----------------------------------------------------------
const drift = [];
for (const t of Object.values(queue().tickets)) {
  if (!t.worktree || !existsSync(t.worktree)) continue;
  const behind = sh('git', ['-C', t.worktree, 'rev-list', '--count', `HEAD..origin/${DEFAULT_BRANCH}`], { tolerant: true });
  if (/^\d+$/.test(behind) && Number(behind) > 0) drift.push(`${t.key} is ${behind} behind ${DEFAULT_BRANCH}`);
}

// ---- report --------------------------------------------------------------
const out = [];
if (!registryOk) out.push('! could not read the session registry — no ticket was advanced this pass');
out.push(...baseLines);
out.push(...MAINT.lines);
for (const [label, items] of [['spawned', report.spawned], ['advanced', report.advanced], ['done', report.done], ['failed', report.failed]]) {
  if (items.length) out.push(`${label}: ${items.join(' | ')}`);
}
if (report.outOfScope.length) out.push(`out of triaged scope (report only):\n  ${report.outOfScope.join('\n  ')}`);
if (incidentalBad) out.push(`scope: ${incidentalBad} — read as the default (lockfiles)`);
for (const why of unreadableQueues) out.push(`ports: ${why} — its running workers' ports were not skipped`);
out.push(...epicLines);
if (report.paused.length) out.push(`paused on the usage limit: ${report.paused.join(' | ')}`);
for (const u of report.unrecognised) out.push(`unrecognised usage-limit event: ${u} — not read as a pause, so the stall check applies as before`);
if (report.stalled.length) out.push(`STALLED:\n  ${report.stalled.join('\n  ')}`);
if (report.quiet.length) out.push(`quiet: ${report.quiet.join(', ')}`);
// A worker count of 0 is a pause, not a finished batch: say what is waiting behind it.
if (concurrency <= 0 && eligible.length) {
  out.push(`paused: new spawns are paused by the batch's worker count (concurrency ${concurrency}); ${eligible.length} triaged ticket(s) wait. ` +
    `Resume with node ${join(BIN, 'queue.mjs')} set-batch concurrency=<n> concurrency_by=user`);
}
// Held tickets. Each finished blocker's PR is looked up once per pass, so a hold behind a PR that was
// closed unmerged, or a blocker that finished with no PR, surfaces instead of waiting for ever.
const qNow = queue();
const heldNow = Object.values(qNow.tickets).filter(isHeld);
const prStates = {};
// Each done ticket's PR is read once a pass, its state, draft, review decision, mergeable state and
// checks in one call, and kept on the ticket as pr_status for desk-q, which makes no network call of
// its own. A PR recorded merged or closed is not read again, unless it merged and the ticket has no
// merged_at yet.
const PR_FINAL = ['MERGED', 'CLOSED'];
function readPrStatus(n) {
  const raw = sh('gh', ['pr', 'view', String(n), '--repo', GH_REPO, '--json', 'state,url,mergedAt,isDraft,reviewDecision,mergeable,mergeStateStatus,headRefOid,statusCheckRollup'], { tolerant: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v?.state) return null;
  // gh writes a time GitHub has not set as the zero time, 0001-01-01.
  const time = (s) => (s && !s.startsWith('0001-') ? s : null);
  const checks = latestPerCheck(normaliseRollup(v.statusCheckRollup)).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, started: time(c.startedAt), completed: time(c.completedAt), runner: c.status !== 'queued', runId: c.runId ?? null }));
  return {
    pr: n, state: v.state, url: v.url ?? null, merged_at: time(v.mergedAt),
    isDraft: v.isDraft ?? null, reviewDecision: v.reviewDecision || null, mergeable: v.mergeable ?? null,
    mergeState: v.mergeStateStatus ?? null, head: v.headRefOid ?? null,
    checks, at: new Date().toISOString(),
  };
}
const DRIVER_DIR = join(STATE, 'merge-driver');
const BUILD_DIR = join(STATE, 'check-builds');
const buildRow = parseOperatorChecks(E.configValues('check-builds'));
const driverLines = (f) => { try { return readFileSync(join(DRIVER_DIR, f), 'utf8').split('\n'); } catch { return []; } };
// The driver's rerun record for PR n at head, as undraftCall and fixCall read it: the reruns tried per
// check, and whether the last rerun has had its cooldown.
const driverReruns = (n, head) => ({
  reruns: (name) => driverLines(`reruns-${n}-${head}`).filter((l) => l === name).length,
  cooledDown: Date.now() / 1000 - (Number(driverLines(`cooldown-${n}`)[0]) || 0) >= RERUN_COOLDOWN_S,
});
// What desk-q reads of a PR without a network call, beyond GitHub's own: the reruns the merge driver
// tried per check at this head and when it last reran one (its reruns-<n>-<sha> and cooldown-<n>), and
// when the head or a check result last changed, kept from the last read while neither has.
function withHistory(s, was) {
  const seen = (x) => JSON.stringify([x?.head ?? null, (x?.checks ?? []).map((c) => [c.name, c.status, c.conclusion]).sort()]);
  const reruns = {};
  if (s.head) for (const l of driverLines(`reruns-${s.pr}-${s.head}`)) if (l) reruns[l] = (reruns[l] ?? 0) + 1;
  const last = Number(driverLines(`cooldown-${s.pr}`)[0]) || 0;
  const kept = was?.pr === s.pr && was.changed_at && seen(was) === seen(s);
  return { ...s, reruns, rerun_at: last ? new Date(last * 1000).toISOString() : null, changed_at: kept ? was.changed_at : s.at };
}
// A merge is recorded here whoever made it, the merge driver or anyone else: merged_at on the ticket
// and its eta-history line (queue.mjs merged keeps the first merge time and appends a key once).
const merges = [];
const drafts = [];
const undrafted = [];
for (const t of Object.values(qNow.tickets)) {
  // A fix try is over once its worker has finished: later spawns are no longer that try's.
  if (t.state === 'done' && t.fix && !t.fix.finished && !DRY) { q('set', t.key, `fix.finished=${PASS_AT}`); t.fix.finished = PASS_AT; }
  const n = t.state === 'done' ? t.result?.pr : null;
  if (n == null) continue;
  let s = null;
  if (t.pr_status?.pr === n && PR_FINAL.includes(t.pr_status.state)) {
    prStates[n] = t.pr_status.state;
    if (t.pr_status.state !== 'MERGED' || t.merged_at) continue;
    if (t.pr_status.merged_at) s = t.pr_status;
  } else if (n in prStates) continue;
  if (!s) {
    s = readPrStatus(n);
    if (!s) continue;
    s = withHistory(s, t.pr_status);
    prStates[n] = s.state;
    q('set', t.key, `pr_status=${JSON.stringify(s)}`);
    if (s.state === 'OPEN' && s.isDraft === true) drafts.push({ t, s });
    if (s.state === 'OPEN' && s.isDraft === false) undrafted.push({ t, s });
  }
  if (s.state === 'MERGED' && !t.merged_at && !DRY) {
    const rec = q('merged', t.key, ...(s.merged_at ? [s.merged_at] : []));
    if (rec) merges.push(`${t.key} (PR #${n}): ${rec.split('\n').join('; ')}`);
  }
}
for (const m of merges) out.push(`merge recorded: ${m}`);

// ---- undraft -------------------------------------------------------------
// Each done ticket's draft PR leaves draft under Stage 7's own rules (undraft.mjs), whoever runs the
// pass, so a supervised batch does not stall on its first draft. One it may not undraft is recorded
// on the ticket as `undraft` and put to the person; a gh pr ready that fails is kept in the pass
// record and tried again next pass, since the PR is still a draft.
const undraftErrors = [];
// What green means here, config §4 Required and Advisory checks: for undrafting and for READY TO MERGE.
const gateLists = () => {
  const list = (id) => { const v = E.configValues(id); return v && !E.isNone(v) ? v : []; };
  return { required: list('required-checks'), advisory: list('advisory-checks') };
};
if (drafts.length) {
  const permKey = E.permissionKey('pr-ready');
  const cfg = {
    perm: E.permission('pr-ready'), permKey, approved: qNow.approved?.undraft === true, rerun: E.permission('ci-rerun'),
    localReview: E.configValue('local-review'), clean: E.configValue('clean-verdict'), judgement: E.permission('autopilot-judgement'),
    handle: (() => { try { return E.githubHandle(); } catch { return null; } })(),
    ...gateLists(), builds: buildRow.checks,
  };
  if (buildRow.errors.length) out.push(`undraft: no check builds this pass, since config §4 Check builds does not parse: ${buildRow.errors.join(', ')} (want \`<check>: <command>\`). Run /desk-setup`);
  const notesFile = join(STATE, 'batch-notes.md');
  for (const { t, s } of drafts) {
    const n = s.pr;
    const raw = sh('gh', ['pr', 'view', String(n), '--repo', GH_REPO, '--json', 'headRefOid,mergeable,mergeStateStatus,body,reviews,statusCheckRollup'], { tolerant: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let v;
    try { v = JSON.parse(raw); } catch { v = null; }
    if (!v || typeof v !== 'object') { out.push(`undraft: PR #${n} (${t.key}) could not be read; the next pass tries again`); continue; }
    const spine = t.key === qNow.spine || t.spine_check != null || t.approved === true;
    const c = undraftCall(t, { number: n, head: v.headRefOid, mergeState: v.mergeStateStatus, mergeable: v.mergeable, body: v.body, reviews: v.reviews, checks: latestPerCheck(normaliseRollup(v.statusCheckRollup)) }, { ...cfg, spine, ...driverReruns(n, v.headRefOid), built: (head) => buildRecord(BUILD_DIR, n, head) });
    if (!c) continue;
    let rec = { call: c.call, why: c.why ?? null, action: c.action ?? null, sha: v.headRefOid ?? null };
    // A P0 or P1 in the review at its head, or under §3 autopilot-judgement yes a gap, goes back to a
    // fix worker, which reviews its new head again.
    // An interactive desk-review posts its P0s and P1s inline: unread, they leave only the body's.
    const comments = () => {
      const r = reviewComments(c.reviewId);
      if (r.error) out.push(`undraft: PR #${n} (${t.key}): its review's inline comments could not be read (${r.error}), so only its body's findings count`);
      return r.comments;
    };
    const rf = c.call === 'findings' ? reviewFix(t, { pr: n, head: v.headRefOid, verdict: c.verdict, body: c.review, comments }, { judgement: cfg.judgement }) : null;
    if (rf) applyFix(t, n, v.headRefOid, rf);
    else if (c.call === 'wait') out.push(`undraft: PR #${n} (${t.key}) stays draft for now: ${c.why}`);
    else if (c.call === 'rerun' && DRY) out.push(`undraft (dry run): would re-run run(s) ${c.runs.join(', ')} on PR #${n} (${t.key}): ${c.why}`);
    else if (c.call === 'rerun') rerunDraft(t, n, v.headRefOid, c);
    else if (c.call === 'build') rec = startCheckBuild(t, n, v.headRefOid, c, rec);
    else if (c.call === 'rebuilt') rec = rerunBuilt(t, n, v.headRefOid, c, rec);
    else if (c.call === 'person' || c.call === 'findings') report.waiting.push(`${t.key}: DRAFT — PR #${n} stays draft: ${c.why}. ${c.action[0].toUpperCase()}${c.action.slice(1)}`);
    else if (DRY) out.push(`undraft (dry run): would mark PR #${n} (${t.key}) ready at ${String(v.headRefOid).slice(0, 12)}`);
    else {
      const r = shOut('gh', ['pr', 'ready', String(n), '--repo', GH_REPO]);
      if (r.ok) {
        out.push(`undrafted: PR #${n} (${t.key}) at ${String(v.headRefOid).slice(0, 12)}; the merge driver merges it once it is green`);
        const said = shOut('gh', ['pr', 'comment', String(n), '--repo', GH_REPO, '--body', undraftComment(c.verdict, v.headRefOid, cfg.clean)]);
        if (!said.ok) out.push(`undraft: PR #${n} (${t.key}) left draft, but its comment was not posted (${said.out.split('\n').pop()})`);
        if (c.note) {
          if (!existsSync(notesFile)) writeFileSync(notesFile, '# Batch notes\n\n');
          appendFileSync(notesFile, `${c.note}\n`);
        }
      } else {
        const why = r.out.split('\n').pop();
        undraftErrors.push(`${t.key}: gh pr ready ${n} failed: ${why}`);
        out.push(`undraft: PR #${n} (${t.key}) could not leave draft (${why}); the next pass tries again`);
        rec = { ...rec, call: 'failed', why };
      }
    }
    const was = t.undraft ?? {};
    if (!DRY && ['call', 'why', 'action', 'sha'].some((k) => (was[k] ?? null) !== rec[k])) q('set', t.key, `undraft=${JSON.stringify({ ...rec, at: PASS_AT })}`);
  }
}

// A draft red only on checks §4 Check builds names gets their build, on the host, in the ticket's
// worktree moved on to the PR's head (check-build.mjs). Where it cannot start, the draft is the person's.
function startCheckBuild(t, n, head, c, rec) {
  if (DRY) { out.push(`undraft (dry run): would run \`${c.command}\` for PR #${n} (${t.key}) at ${String(head).slice(0, 12)}: ${c.why}`); return rec; }
  const dir = buildDir(t, head);
  let pid = null;
  let failed = dir.why ?? null;
  if (!failed) {
    try { pid = startBuild(BUILD_DIR, { n, head, command: c.command, checks: c.checks, cwd: dir.cwd }); } catch (e) { failed = e.message; }
  }
  if (!failed) {
    out.push(`undraft: PR #${n} (${t.key}) stays draft: ${c.why} (started in ${dir.cwd}, pid ${pid})`);
    return rec;
  }
  const why = `its check build \`${c.command}\` could not start: ${failed}`;
  const action = `run \`${c.command}\` at the head of #${n}, then re-run ${c.checks.map((x) => `"${x}"`).join(', ')}`;
  report.waiting.push(`${t.key}: DRAFT — PR #${n} stays draft: ${why}. ${action[0].toUpperCase()}${action.slice(1)}`);
  return { ...rec, call: 'person', why, action };
}
// The ticket's worktree at the PR's head: moved on to it when it is behind and clean, never otherwise.
function buildDir(t, head) {
  const wt = t.worktree;
  if (!wt || !existsSync(wt)) return { why: `the ticket's worktree (${wt ?? 'none recorded'}) is not there` };
  const at = shOut('git', ['-C', wt, 'rev-parse', 'HEAD']);
  if (at.ok && at.out === head) return { cwd: wt };
  const st = shOut('git', ['-C', wt, 'status', '--porcelain']);
  if (!st.ok || st.out) return { why: `its worktree ${wt} is not at the head and has uncommitted changes` };
  const moved = shOut('git', ['-C', wt, 'fetch', '-q', 'origin', head]).ok && shOut('git', ['-C', wt, 'merge', '--ff-only', '-q', head]).ok;
  return moved ? { cwd: wt } : { why: `its worktree ${wt} is at ${at.out.slice(0, 9)} and could not be moved on to the head` };
}
// A check build that succeeded: its checks' runs re-run with --failed, once per head. Not rerun.sh,
// whose cap and cooldown are for flaky runs: these were red for want of the build.
function rerunBuilt(t, n, head, c, rec) {
  if (DRY) { out.push(`undraft (dry run): would re-run run(s) ${c.runs.join(', ') || '(none)'} on PR #${n} (${t.key}): ${c.why}`); return rec; }
  const refused = c.runs.length ? [] : ['no run id was reported for it'];
  for (const id of c.runs) {
    const r = shOut('gh', ['run', 'rerun', id, '--repo', GH_REPO, '--failed']);
    if (!r.ok) refused.push(`run ${id}: ${r.out.split('\n').pop()}`);
  }
  markReran(BUILD_DIR, n, head, { ok: !refused.length, out: refused.join('; ') });
  if (!refused.length) {
    out.push(`undraft: PR #${n} (${t.key}) stays draft: ${c.why} (run(s) ${c.runs.join(', ')})`);
    return rec;
  }
  const checks = c.checks.map((x) => `"${x}"`).join(', ');
  const why = `its check build ran at ${String(head).slice(0, 9)}, but the re-run of ${checks} was refused: ${refused.join('; ')}`;
  const action = `re-run ${checks} on #${n}`;
  report.waiting.push(`${t.key}: DRAFT — PR #${n} stays draft: ${why}. ${action[0].toUpperCase()}${action.slice(1)}`);
  return { ...rec, call: 'person', why, action };
}

// A draft's cancelled or timed-out runs, re-run by the merge driver's own rerun (rerun.sh), so the
// driver and the pass keep one record, cap and cooldown per head.
function rerunDraft(t, n, head, c) {
  const r = shOut('bash', [join(BIN, 'rerun.sh'), DRIVER_DIR, GH_REPO, String(n), head], { input: JSON.stringify({ gate: c.gate }), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RERUN_PERM: E.permission('ci-rerun') } });
  const said = r.out.split('\n').filter(Boolean).join('; ');
  out.push(`undraft: PR #${n} (${t.key}) stays draft: ${c.why}${said ? ` (${said})` : ''}`);
}

// A review's inline comments as fix-tries.mjs inlineFindings reads them, by the review's GraphQL node
// id (gh pr view's `id`), as { comments } or { comments: null, error }.
function reviewComments(id) {
  if (!id) return { comments: null, error: 'the review has no id' };
  const query = 'query($id: ID!) { node(id: $id) { ... on PullRequestReview { comments(first: 100) { nodes { path line originalLine body } } } } }';
  const r = shOut('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `id=${id}`, '--jq', '.data.node.comments.nodes']);
  let nodes;
  try { nodes = r.ok ? JSON.parse(r.out) : null; } catch { nodes = null; }
  if (!Array.isArray(nodes)) return { comments: null, error: r.ok ? 'gh api graphql returned no comments list' : r.out.split('\n').pop() };
  return { comments: nodes.map((x) => ({ path: x.path, line: x.line ?? x.originalLine ?? null, body: x.body })) };
}

// ---- fix tries -----------------------------------------------------------
// A ready PR the merge driver cannot merge, red after its two reruns or in conflict with its base,
// goes back to a fix worker on the same branch, at most twice (fix-tries.mjs). What no worker can
// fix, a §4 Checks workers can't fix check or a third failure, is recorded on the ticket as `stuck`
// and put to the person. The driver's per-head rerun record is read from its state directory.
const operatorRow = parseOperatorChecks(E.configValues('operator-checks'));
if (operatorRow.errors.length && undrafted.length) {
  out.push(`fix tries: none this pass, since config §4 Checks workers can't fix does not parse: ${operatorRow.errors.join(', ')} (want \`<check>: <what fixes it>\`). Run /desk-setup`);
}
const flakyRow = parseFlaky(E.configValues('flaky-checks'));
// The files a PR conflicts on, as git works them out against the base; null when it cannot.
function conflictFiles(branch) {
  if (!branch) return null;
  if (!shOut('git', ['-C', MAIN, 'fetch', '-q', 'origin', DEFAULT_BRANCH, branch]).ok) return null;
  let o;
  try { o = execFileSync('git', ['-C', MAIN, 'merge-tree', '--write-tree', '--name-only', '--no-messages', `origin/${DEFAULT_BRANCH}`, `origin/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { o = e.status === 1 ? String(e.stdout ?? '') : null; }
  const files = o?.split('\n').slice(1).filter(Boolean) ?? [];
  return files.length ? files : null;
}
for (const { t, s } of operatorRow.errors.length ? [] : undrafted) {
  const n = s.pr;
  const ctx = {
    repo: GH_REPO, base: DEFAULT_BRANCH, ...gateLists(), operator: operatorRow.checks,
    ...driverReruns(n, s.head),
    // Waived only as the driver waives: every name listed, and the PR touching none of their paths.
    waived: (names) => {
      if (flakyRow.errors.length || !names.every((x) => flakyRow.flaky.some((f) => f.name === x))) return false;
      const files = sh('gh', ['api', '--paginate', `repos/${GH_REPO}/pulls/${n}/files?per_page=100`, '--jq', PR_FILES_JQ], { tolerant: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return !!files && flakyWaiver(s.checks, { ...gateLists(), flaky: flakyRow.flaky, files: files.split('\n').filter(Boolean) })?.applies === true;
    },
    conflictFiles: () => conflictFiles(t.branch),
  };
  const c = fixCall(t, s, ctx);
  if (!c) { if (t.stuck && !DRY) q('set', t.key, 'stuck=null'); continue; }
  applyFix(t, n, s.head, c);
}
// A fixCall or reviewFix answer, carried out: `stuck` is recorded on the ticket and put to the person,
// `requeue` sends the ticket back for its fix try and appends the try to `fix_tries`.
function applyFix(t, n, head, c) {
  if (c.call === 'stuck') {
    report.waiting.push(`${t.key}: STUCK — PR #${n}: ${c.why}`);
    if (!DRY && (t.stuck?.why !== c.why || t.stuck?.head !== head)) q('set', t.key, `stuck=${JSON.stringify({ why: c.why, pr: n, head, at: PASS_AT })}`);
    return;
  }
  const f = c.fix;
  if (DRY) { out.push(`fix try (dry run): would requeue ${t.key} for try ${f.try} of ${f.of} on PR #${n} — ${f.what}`); return; }
  // The try is written first, so the spawn that follows the requeue reads it; a refused requeue takes it back.
  q('set', t.key, `fix=${JSON.stringify({ ...f, at: PASS_AT })}`);
  const rq = shOut('node', [join(BIN, 'queue.mjs'), 'requeue', t.key]);
  if (!rq.ok) {
    q('set', t.key, 'fix=null');
    report.waiting.push(`${t.key}: STUCK — PR #${n} ${f.what}, and its fix try could not be requeued (${rq.out.split('\n').pop()})`);
    return;
  }
  q('set', t.key, `fix_tries=${JSON.stringify([...(t.fix_tries ?? []), { try: f.try, head: f.head, kind: f.kind, what: f.what, at: PASS_AT }])}`, 'stuck=null');
  out.push(`fix try ${f.try} of ${f.of}: ${t.key} requeued for PR #${n} — ${f.what}`);
}
// A repo with no history yet gets it built once, the same as desk-q-eta.mjs build; later merges append.
if (!DRY && readHistory(STATE) === null) {
  const built = buildHistory({ state: STATE, queue: queue(), mergedPrs: () => ghMergedPrs(GH_REPO) });
  out.push(`eta history built: ${describeHistory(built).split('\n').join('; ')}`);
}
const readPr = (n) => {
  if (!(n in prStates)) prStates[n] = sh('gh', ['pr', 'view', String(n), '--repo', GH_REPO, '--json', 'state', '--jq', '.state'], { tolerant: true, stdio: ['ignore', 'pipe', 'ignore'] }) || null;
  return prStates[n];
};
for (const t of heldNow) {
  for (const p of String(t.held_by ?? '').split('|').filter(Boolean)) {
    const n = qNow.tickets[p]?.state === 'done' ? qNow.tickets[p]?.result?.pr : null;
    if (n != null) readPr(n);
  }
}
const prState = (n) => prStates[n] ?? null;
const predsOf = (t) => String(t.held_by ?? '').split('|').filter(Boolean);
const releaseDue = heldNow.filter((t) => predsOf(t).length && predsOf(t).every((p) => qNow.tickets[p]?.state === 'done' && prState(qNow.tickets[p]?.result?.pr) === 'MERGED'));
// Held behind a spine the person has still to approve (or send back) waits on that, not on a merge.
const spinesOf = (t) => predsOf(t).filter((p) => spinePark(qNow.tickets[p]));
const onApproval = heldNow.filter((t) => spinesOf(t).length && waitingOnMerge(qNow, t, prState));
const onMerge = heldNow.filter((t) => waitingOnMerge(qNow, t, prState) && !releaseDue.includes(t) && !onApproval.includes(t));
// Held behind a failed or parked ticket waits on the person's answer there, which is asked once.
const parksOf = new Map(heldNow.map((t) => [t, waitingOnPark(qNow, t, prState)]).filter(([, p]) => p));
const onPark = [...parksOf.keys()];
const stuck = heldNow.filter((t) => !waitingOnMerge(qNow, t, prState) && !parksOf.has(t));
if (onPark.length) out.push(`WAITING ON A PARK: ${onPark.map((t) => `${t.key} (${parksOf.get(t).join(', ')})`).join(', ')}: answered there, not asked again`);
if (onApproval.length) out.push(`WAITING ON APPROVAL: ${onApproval.map((t) => `${t.key} (spine ${spinesOf(t).join(', ')})`).join(', ')}`);
if (onMerge.length) out.push(`WAITING ON MERGE: ${onMerge.map((t) => `${t.key} (${predsOf(t).join(', ')})`).join(', ')}`);
for (const t of Object.values(qNow.tickets).filter((r) => spinePark(r) === 'approval')) {
  report.waiting.push(`${t.key}: SPINE APPROVAL — PR #${t.result?.pr ?? '?'} lands a strict expected-fail spec per criterion and stays draft. ` +
    `Review them read-only first (node ${join(BIN, 'spine-review.mjs')} brief ${t.key}), then put one question per spec to the person (spine-review.mjs questions ${t.key} <reply>): approved, node ${join(BIN, 'queue.mjs')} approve ${t.key}; rejected, node ${join(BIN, 'queue.mjs')} reject ${t.key} "<their note>"`);
}
for (const t of Object.values(qNow.tickets).filter((r) => spinePark(r) === 'specs')) {
  report.waiting.push(`${t.key}: SPINE SPECS — ${(t.spine_check?.problems ?? []).join('; ') || 'the check failed'}. No approval is offered: ` +
    `send it back with what to fix, node ${join(BIN, 'queue.mjs')} reject ${t.key} "<note>"`);
}
// An approved spine merges under the batch's merge rules: the merge driver where §3 grants it, else
// the person.
const merger = spineMerger(qNow);
for (const t of Object.values(qNow.tickets).filter((r) => r.approved === true && r.state === 'done' && r.result?.pr != null)) {
  const n = t.result.pr;
  if (merger.driver) continue;
  if (readPr(n) === 'MERGED') continue;
  report.waiting.push(`${t.key}: SPINE APPROVED — merge PR #${n} once it is green (${merger.rows}, so no merge driver merges it); what is held behind it is released once it merges`);
}
// Out of draft and green with no merge driver to merge it (config §3, or the batch declined at Stage 3):
// the person merges it, so it is put to them, and handed to the check-in digest under a supervisor.
// Review feedback holds it as it would hold the driver (§3 merge-feedback-first, strict unless `no`):
// changes requested are put first, and the person checks the threads, which this pass does not read.
if (!merger.driver && undrafted.length) {
  const gateCfg = gateLists();
  const feedbackFirst = E.permissionOrUnset('merge-feedback-first') !== 'no';
  for (const { t, s } of undrafted) {
    if (t.approved === true || s.mergeable === 'CONFLICTING') continue;
    if (evaluateGate(s.checks, gateCfg).state !== 'pass') continue;
    if (feedbackFirst && s.reviewDecision === 'CHANGES_REQUESTED') {
      report.waiting.push(`${t.key}: CHANGES REQUESTED — PR #${s.pr} is out of draft and green, but changes are requested on it, and no merge driver merges it (${merger.rows}): work the feedback first, then merge it yourself`);
      continue;
    }
    report.waiting.push(`${t.key}: READY TO MERGE — PR #${s.pr} is out of draft and green, and no merge driver merges it (${merger.rows}): merge it yourself${feedbackFirst ? ' once no review thread is left unresolved' : ''}, pinned to its head (gh pr merge ${s.pr} --repo ${GH_REPO} --match-head-commit <sha>)`);
  }
}
// A live merge driver releases these on its next loop, so they only need you when it is not running.
const driverLive = E.mergeDriverHolder(STATE) != null;
for (const t of releaseDue) {
  if (driverLive) out.push(`release due: ${t.key} (every blocker merged; the merge driver releases it on its next loop)`);
  else report.waiting.push(`${t.key}: RELEASE DUE — every blocker merged (${predsOf(t).join(', ')}) and no merge driver is running: release it (${E.releaseCommand(t.key)})`);
}
for (const t of stuck) report.waiting.push(`${t.key}: STUCK — held behind ${predsOf(t).join(', ') || 'no recorded blocker'}, which cannot merge on its own (no PR, a closed PR, or not in the batch): decide whether it waits, is released, or is dropped`);
// A failed ticket waits on the person until it is requeued or dropped. This pass's failures are
// printed under `failed:` with their reason, and reach the verdict's `waiting` from there.
const failedThisPass = new Set(report.failed.map((x) => x.split(':')[0]));
for (const t of Object.values(qNow.tickets).filter((r) => r.state === 'failed' && !failedThisPass.has(r.key))) {
  report.waiting.push(`${t.key}: FAILED — requeue it (queue.mjs requeue ${t.key}), finish it by hand, or drop it`);
}

// ---- base gate -------------------------------------------------------------
// A feature-mode batch is checked on its base before its promotion PR leaves draft: base-gate.mjs,
// started here in the background because the base's suites can outlast one pass, and read back from
// the queue's `gate` on later passes. It runs on a slice: once §3b's slice size of children have
// merged into the base since the last promotion (and since the last gate), once a child labelled
// `milestone` merges, and once every child has merged, the last slice, which the epic close-out
// follows. A slice gate waits on no other child: a parked or failed one is named as not in the slice,
// and still stops the last. A failed gate runs again whenever the base moves. While the gate waits on
// merges or runs, the batch is not idle.
const GATE_LOG = join(STATE, 'logs', 'base-gate.log');
const isMilestone = (key) => (triageRec(key)?.labels ?? []).some((l) => /^milestone$/i.test(String(l).trim()));
const sliceLabel = (s) => (s ? `slice ${s.n}: ${s.keys.length} of ${s.of} children${s.last ? ', the last' : ''}` : null);
function baseGate(qx) {
  const tickets = Object.values(qx.tickets);
  const p = qx.promotion ?? {};
  let g = qx.gate ?? null;
  if (g?.state === 'running') {
    if (gateAlive(g)) { out.push(`BASE GATE: running on ${BASE}${g.slice ? ` (${sliceLabel(g.slice)})` : ''} since ${g.started} (pid ${g.pid}); log ${GATE_LOG}`); return true; }
    g = { ...g, state: 'failed', finished: new Date().toISOString(), failures: [`the gate stopped without a result (pid ${g.pid ?? '?'}): see ${GATE_LOG}`] };
    q('set-batch', `gate=${JSON.stringify(g)}`);
  }

  // This promotion's children: merged into the base since the last promotion PR merged.
  const since = p.since ? Date.parse(p.since) : null;
  const merged = tickets.filter((t) => t.merged_at && (since == null || Date.parse(t.merged_at) > since));
  const covered = new Set(g?.slice?.keys ?? []);
  const uncovered = merged.filter((t) => !covered.has(t.key));
  const milestones = uncovered.filter((t) => isMilestone(t.key));

  // The last slice needs every child merged. A child that finished with no PR, or whose PR was closed
  // unmerged, can never merge: the person decides, and nothing waits on it. One whose PR is still open
  // is waited for.
  const stopped = tickets.filter((t) => ['parked', 'failed'].includes(t.state));
  const stoppedList = stopped.map((t) => `${t.key} (${t.state === 'failed' ? 'failed' : `parked: ${String(t.park?.question ?? '').slice(0, 80)}`})`).join(', ');
  let complete = false;
  let waits = false;
  const lastLines = [];
  if (batchSettled(qx, prState)) {
    if (stopped.length) {
      lastLines.push(() => report.waiting.push(`BASE GATE: ${g ? 'the last slice is ' : ''}not run, since ${stopped.length} child(ren) did not finish: ${stoppedList}. ` +
        `The base is checked ${g ? 'as a whole ' : ''}once every child has merged into ${BASE}${p.pr && !g?.ready ? `; promotion PR #${p.pr} stays draft` : ''}`));
    } else {
      const noPr = tickets.filter((t) => t.result?.pr == null);
      const closed = tickets.filter((t) => t.result?.pr != null && readPr(t.result.pr) === 'CLOSED');
      const open = tickets.filter((t) => t.result?.pr != null && !['MERGED', 'CLOSED'].includes(readPr(t.result.pr)));
      const never = [...noPr.map((t) => `${t.key} (finished with no PR)`), ...closed.map((t) => `${t.key} (PR #${t.result.pr} closed without merging)`)];
      if (never.length) lastLines.push(() => report.waiting.push(`BASE GATE: not run, since ${never.join(', ')} cannot merge into ${BASE}: requeue or drop ${never.length > 1 ? 'them' : 'it'}`));
      if (open.length) {
        const list = open.map((t) => `${t.key} (PR #${t.result.pr})`).join(', ');
        lastLines.push(() => (driverLive ? out.push(`BASE GATE: waits on ${list} merging into ${BASE}`)
          : report.waiting.push(`BASE GATE: waits on ${list} merging into ${BASE}, and no merge driver is running: merge them`)));
      }
      complete = !never.length && !open.length;
      waits = open.length > 0 && !never.length;
    }
  }
  const due = complete || uncovered.length >= SLICE.size || milestones.length > 0;
  if (!g && !due) {
    for (const l of lastLines) l();
    if (!lastLines.length) out.push(`BASE GATE: the next slice runs once ${SLICE.size - uncovered.length} more child(ren) merge into ${BASE} (${uncovered.length} of ${SLICE.size} so far), a milestone child merges, or the last child merges`);
    return waits;
  }

  sh('git', ['-C', MAIN, 'fetch', '-q', 'origin', `refs/heads/${BASE}:refs/remotes/origin/${BASE}`], { tolerant: true });
  const head = sh('git', ['-C', MAIN, 'rev-parse', '--verify', '-q', `origin/${BASE}`], { tolerant: true }) || null;
  const moved = !!(g?.sha && head && g.sha !== head);
  // A promotion PR holds whatever has merged into the base, so once a child no gate covered merges, or
  // a gate fails, it is put back to draft until the next slice's gate passes, however it left draft
  // (the gate, or the person). A refused undo is reported and tried again next pass.
  let undoFailed = false;
  if (g && g.pr != null && !g.redrafted && ((g.state === 'passed' && uncovered.length) || g.state === 'failed') && !DRY) {
    let v = null;
    try { v = JSON.parse(sh('gh', ['pr', 'view', String(g.pr), '--repo', GH_REPO, '--json', 'state,isDraft'], { tolerant: true, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* reported below */ }
    const r = !v ? { ok: false, out: 'it could not be read' } : v.state !== 'OPEN' || v.isDraft ? { ok: true } : shOut('gh', ['pr', 'ready', String(g.pr), '--repo', GH_REPO, '--undo']);
    if (r.ok) {
      g = { ...g, ready: false, redrafted: true, note: null };
      q('set-batch', `gate=${JSON.stringify(g)}`);
    } else {
      undoFailed = true;
      report.waiting.push(`BASE GATE: promotion PR #${g.pr} holds ${g.state === 'failed' ? 'a base whose gate failed' : `${uncovered.map((t) => t.key).join(', ')}, which no gate has covered`}, and could not go back to draft (${r.out.split('\n').pop()}): gh pr ready ${g.pr} --repo ${GH_REPO} --undo. The next pass tries again`);
    }
  }
  const outside = () => { if (!complete && stopped.length) out.push(`BASE GATE: not in this slice: ${stoppedList}`); };
  if (!g || (moved && (g.state === 'failed' || due))) {
    if (DRY) { out.push(`BASE GATE (dry run): would start on ${BASE}`); return false; }
    const slice = { n: p.slice ?? 1, keys: merged.map((t) => t.key), of: tickets.length, last: complete };
    q('set-batch', `gate=${JSON.stringify({ state: 'running', pid: null, started: new Date().toISOString(), sha: head, slice })}`);
    mkdirSync(join(STATE, 'logs'), { recursive: true });
    const fd = openSync(GATE_LOG, 'a');
    const child = spawn(process.execPath, [join(BIN, 'base-gate.mjs')], { cwd: MAIN, detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.unref();
    closeSync(fd);
    q('set-batch', `gate.pid=${child.pid}`);
    const why = complete ? '' : milestones.length ? `, since milestone ${milestones.map((t) => t.key).join(', ')} merged` : `, since ${uncovered.length} children merged since the last ${g ? 'gate' : 'promotion'}`;
    out.push(`BASE GATE: started on ${BASE}${g ? ` again (it moved since the last run, at ${String(g.sha).slice(0, 12)})` : ''} for ${sliceLabel(slice)}${why} (pid ${child.pid}): merges ${SOURCE} in, then runs every acceptance spec and the repo's Typecheck, Lint and Unit tests there; log ${GATE_LOG}${g?.redrafted ? `. Promotion PR #${g.pr} is back in draft until it passes` : ''}`);
    outside();
    return true;
  }

  const at = `${BASE} at ${String(g.sha ?? '?').slice(0, 12)}${g.slice ? ` (${sliceLabel(g.slice)})` : ''}`;
  if (!complete) { for (const l of lastLines) l(); outside(); }
  if (g.state === 'passed') {
    const link = qx.promotion?.url ?? (g.pr != null ? `https://github.com/${GH_REPO}/pull/${g.pr}` : null);
    if (g.pr == null) {
      report.waiting.push(`BASE GATE: passed on ${at}, but the batch has no promotion PR to mark ready (${qx.promotion?.why ?? 'none was recorded'}): open one from ${BASE} to ${SOURCE}`);
    } else if (g.ready && !undoFailed) {
      out.push(`BASE GATE: passed on ${at}: every acceptance spec, Typecheck, Lint and Unit tests. Promotion PR #${g.pr} is ready for review: ${link} (merging it is yours)`);
    } else if (g.redrafted) {
      out.push(`BASE GATE: passed on ${at}, and ${uncovered.length} child(ren) no gate has covered merged into ${BASE} since, so promotion PR #${g.pr} is in draft until the next slice's gate passes: ${link}`);
    } else if (!undoFailed) {
      report.waiting.push(`BASE GATE: passed on ${at}, but promotion PR #${g.pr} is still draft: ${g.note ?? 'it was not marked ready'}. ${link}`);
    }
    // The epic's close-out follows the last slice only.
    if (complete) {
      const co = g.close_out;
      out.push(co == null ? `close-out: the epic's criteria could not be read, so check every one per criterion`
        : co.length ? `close-out: check only ${co.join(', ')} per criterion, which no spec covers; every other criterion's spec passed on ${BASE}`
          : `close-out: every criterion has a spec that passed on ${BASE}, so no per-criterion check is needed`);
    }
  } else {
    for (const f of g.failures ?? []) report.waiting.push(`BASE GATE: ${f}`);
    report.waiting.push(`BASE GATE: failed on ${at}${g.pr != null && !undoFailed ? `, so promotion PR #${g.pr} stays draft` : ''}. Fix it on ${BASE}: the gate runs again once ${BASE} moves, or now with queue.mjs set-batch gate=null`);
  }
  return waits;
}
const featureBase = qNow.feature === true && BASE && SOURCE && BASE !== SOURCE && Object.keys(qNow.tickets).length > 0;
const gatePending = featureBase ? baseGate(queue()) : false;

// ---- promotion ledger ------------------------------------------------------
// The promotion PR carries one comment with one row per child (ledger.mjs), rewritten whenever a row
// changes, a child merging into the base included. The PR body is never touched. A comment that cannot
// be read or written is reported and the batch carries on; nothing is recorded until a write
// succeeds, so the next pass tries again.
function updateLedger(qx) {
  const n = qx.promotion?.pr;
  if (n == null) return;
  for (const t of Object.values(qx.tickets)) if (t.state === 'done' && t.result?.pr != null) readPr(t.result.pr);
  const ledger = renderLedger(qx, prState);
  const hash = ledgerHash(ledger);
  if (qx.promotion.ledger === hash) return;
  const notUpdated = (why) => out.push(`promotion PR #${n}: ledger not updated, ${why}. The batch carries on; the next pass tries again`);
  if (DRY) { out.push(`promotion PR #${n} (dry run): would rewrite its ledger comment`); return; }
  const editPerm = E.permission('pr-edit');
  if (editPerm !== 'yes') { notUpdated(`since config §3 ${E.permissionKey('pr-edit')} is "${editPerm}"`); return; }
  const gh = (args, input) => shOut('gh', args, input == null ? {} : { input, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = syncLedger({ n, repo: GH_REPO, ledger, gh });
  if (!done.ok) { notUpdated(`since ${done.why}`); return; }
  if (done.action !== 'unchanged') out.push(`promotion PR #${n}: ledger comment ${done.action}`);
  q('set-batch', `promotion.ledger=${hash}`);
}
updateLedger(queue());

// A taken call the person overrode from the digest (digest.mjs override) is listed once, on the next
// pass, for the orchestrator to act on: the work may need redoing to the new choice.
function reportOverrides() {
  const seenFile = join(STATE, 'overrides-reported.json');
  let seen = [];
  try { seen = JSON.parse(readFileSync(seenFile, 'utf8')); } catch { /* none reported yet */ }
  const fresh = [];
  for (const e of readDecisions(STATE).overrides) {
    if (seen.includes(e.id)) continue;
    fresh.push(e.id);
    report.waiting.push(`${e.ticket}: decision overridden — "${e.question}" is now "${e.chose}" (was "${e.was}"), by ${e.by} at ${e.at}`);
  }
  if (fresh.length && !DRY) writeFileSync(seenFile, `${JSON.stringify([...seen, ...fresh])}\n`);
}
reportOverrides();

if (report.waiting.length) out.push(`WAITING ON YOU:\n  ${report.waiting.join('\n  ')}`);

// Blocked-on-questions must be visible, or "no change this pass" reads as "idle" when it
// really means "nobody answered yet".
const blocked = all.filter((r) => r.state === 'triaged' && (r.open_questions ?? 0) > 0);
if (blocked.length) out.push(`BLOCKED ON ANSWERS: ${blocked.map((b) => `${b.key} (${b.open_questions})`).join(', ')}\n  answer with: node ${join(BIN, 'answer.mjs')} <TICKET> "<answer>"`);
const heldBack = all.filter((r) => r.state === 'triaged' && (r.open_questions ?? 0) === 0 && collidesWithRunning(r));
if (heldBack.length) out.push(`held back by a collision: ${heldBack.map((x) => x.key).join(', ')}`);
const resumeWaits = Object.values(qNow.tickets).filter((r) => r.state === 'triaged' && toResume(r));
if (resumeWaits.length) out.push(`waiting to resume (killed; resumed ahead of new tickets when a slot frees): ${resumeWaits.map((r) => `${r.key} (${r.resume_why})`).join(', ')}`);
// A put-off park whose `pr-head` or `config:<id>` input has changed since is asked again, saying what
// changed: the refreshed inputs go on the park, where the verdict below and the digest read them.
for (const t of Object.values(queue().tickets)) {
  if (!putOff(t)) continue;
  const now = refreshInputs(t.park.inputs ?? {}, {
    prHead: () => (t.branch ? sh('git', ['ls-remote', 'origin', `refs/heads/${t.branch}`], { tolerant: true }).split(/\s/)[0] || null : null),
    config: (id) => { try { return E.configValue(id); } catch { return null; } },
  });
  if (inputsHash(now) === inputsHash(t.park.inputs ?? {})) continue;
  q('set', t.key, `park.inputs=${JSON.stringify(now)}`);
  report.parked.push(`${t.key}: ${t.park.question} — ${lookup(REGISTER, { question: t.park.question, inputs: now }).line}`);
}
if (report.parked.length) out.push(`PARKED:\n  ${report.parked.join('\n  ')}`);
if (report.clears.length) out.push(`clears-when:\n  ${report.clears.join('\n  ')}`);
if (report.inputs.length) out.push(`park inputs:\n  ${report.inputs.join('\n  ')}`);
if (report.putOff.length) out.push(`put off, so not asked again until their inputs change (the digest lists them):\n  ${report.putOff.join('\n  ')}`);
if (drift.length) out.push(`base drift: ${drift.join(', ')}`);

// ---- groups --------------------------------------------------------------
// Each row's group as desk-q shows it, and the pass that first found it there, kept on the ticket as
// `group` ({g, at}): desk-q's STARTS says how long a row has sat in it, and the digest lists a Merging
// PR with no change for two hours. Read after this pass's own writes, so a spawn or a fix try counts now.
if (!DRY) {
  let groups = {};
  const qg = queue();
  try { groups = groupsNow({ slug: E.repoSlug(), stateDir: STATE, queuePath: QUEUE_FILE, q: qg }); }
  catch (e) { out.push(`groups: not recorded this pass (${describeCrash(e).split('\n')[0]})`); }
  for (const [key, g] of Object.entries(groups)) if (qg.tickets[key]?.group?.g !== g) q('set', key, `group=${JSON.stringify({ g, at: PASS_AT })}`);
}

// ---- verdict -------------------------------------------------------------
// Everything that waits on the person: this pass's failures, WAITING ON YOU, the stalls only they can
// clear, unanswered questions, and every ticket parked for its own reason (a hold is not one: it
// releases by itself).
const qEnd = queue();
const waiting = [
  ...report.failed,
  ...report.waiting,
  ...report.personStalls,
  ...blocked.map((b) => `${b.key}: ${b.open_questions} question(s) open — answer with answer.mjs ${b.key} "<answer>"`),
];
const parked = Object.values(qEnd.tickets).filter((t) => t.state === 'parked' && !isHeld(t) && !putOff(t)).map((t) => ({ key: t.key, question: t.park?.question ?? '' }));
const idle = batchIdle(qEnd, prState) && !gatePending;
const status = idle ? 'idle' : (waiting.length || parked.length) ? 'show_person' : report.spawned.length ? 'go_on' : 'nothing_yet';
const lines = [];
const needsYou = [...parked.map((p) => p.key), ...waiting.map((x) => x.split(':')[0])];
if (needsYou.length) lines.push(`NOTIFY: ${needsYou.length} item(s) need you — ${[...new Set(needsYou)].join(', ')}`);
else if (idle) lines.push('NOTIFY: the batch is finished — nothing left to run');
// What is pushed now, as against shown in the session: the check-in digest once a slot has passed (one
// pass on the machine builds it), and a park reading production broken. Nothing else interrupts.
const SLUG = E.repoSlug();
const push = urgentParks(parked, SLUG);
// A merged fix for a production breakage asks to promote at once, not at the day's last check-in.
const PROMOTION_REF = promotionRef(E.configValue('promotion-ref')).ref;
if (!DRY && PROMOTION_REF) {
  const merged = Object.values(qEnd.tickets).map((t) => (t.state === 'done' ? t.result?.pr : null)).filter((n) => n != null && prState(n) === 'MERGED');
  try {
    const u = urgentPromotion({
      inputs: { slug: SLUG, root: E.repoRoot(), ghRepo: GH_REPO, def: E.configValue('default-branch') ?? 'main', ref: PROMOTION_REF, staging: E.configValues('staging') },
      state: STATE, dir: digestDir(), merged,
    });
    if (u) push.push(u.push);
  } catch (e) { lines.push(`promotion: the production-broken check could not run: ${e.message}`); }
}
if (CHECKIN.ok && !DRY) {
  const d = await checkin({ times: CHECKIN.times, self: SLUG, list: digestRepos({ self: { slug: SLUG, batch: E.batchName(), state: STATE, queue: QUEUE_FILE, self: true } }) });
  if (d.status === 'sent') lines.push(`check-in ${d.slot}: ${d.questions} question(s), ${d.decisions} decision(s) — ${d.page}${d.push ? '' : ' (nothing new: no push)'}`);
  if (d.push) push.unshift(d.push);
}
push.push(...HEALTH.push, ...claimPush);
push.push(...(MAINT.push ?? []));
for (const p of push) lines.push(`PUSH: ${p.text}`);
lines.push(out.length ? out.join('\n') : 'no change this pass');
lines.push(HEALTH.line);
lines.push(PACE.line);
lines.push(`memory: vmmem=${E.usedGiB().toFixed(1)}G avail=${availGB.toFixed(1)}G`);
lines.push(CEILING.line);
lines.push(CONC.line);
lines.push(machineLine);
if (BORROW.bad) lines.push(`borrowing: ${BORROW.bad}`);
if (borrowLine) lines.push(borrowLine);
lines.push('');
lines.push(sh('node', [join(BIN, 'queue.mjs'), 'render'], { tolerant: true }));
if (idle) {
  lines.push('\nIDLE — every ticket is done, parked, or failed, none is held waiting on a merge, and every done ticket\'s PR is merged or closed (or it finished with no PR). Nothing left to spawn or merge.');
  const sc = batchScopeTotals(Object.values(qEnd.tickets));
  lines.push(`scope: ${sc.tickets} of ${sc.checked} checked ticket(s) changed files outside their triaged scope, ${sc.files} file(s) in all (report only)`);
  const resumed = Object.values(qEnd.tickets).filter((t) => t.resumes > 0);
  if (resumed.length) lines.push(`resumed after a kill: ${resumed.map((t) => `${t.key} ${t.resumes} time(s) (${t.state})`).join(', ')}`);
  const cost = batchCost(STATE, Object.values(qEnd.tickets));
  if (cost.length) lines.push(costTable(cost));
}
// Why nothing spawned while something could have: the first hold that applied this pass.
const heldWhy = report.spawned.length || !eligible.length ? null
  : held ?? (baseHold ? 'the batch base sync holds every spawn'
  : lowMemory ? `memory: ${availGB.toFixed(1)}G available, under the ${MIN_AVAIL_GB}G spawn gate`
  : MACHINE.room <= 0 ? `the machine budget: ${MACHINE.line}`
  : concurrency <= 0 ? `the batch's worker count is ${concurrency}` : null);
const heldEnd = Object.values(qEnd.tickets).filter(isHeld).map((t) => t.key);
const mergedEnd = Object.values(qEnd.tickets).filter((t) => t.merged_at).map((t) => t.key);
recordPass((prev) => {
  const released = (prev.held_tickets ?? []).some((k) => qEnd.tickets[k] && !heldEnd.includes(k));
  // A merge is progress once, in the pass that first finds it merged, whoever recorded it: a merge
  // time later than the previous pass's start would count again a merge that pass already recorded.
  const merged = merges.length > 0 || (Array.isArray(prev.merged_tickets) && mergedEnd.some((k) => !prev.merged_tickets.includes(k)));
  const moved = report.spawned.length > 0 || merged || released;
  return { held: heldWhy, errors: 0, error: null, progress_at: moved ? PASS_AT : prev.progress_at ?? null, held_tickets: heldEnd, merged_tickets: mergedEnd, undraft_errors: undraftErrors };
});
// exitCode, not exit(): a long report to a pipe must flush before the process ends.
process.exitCode = verdict(status, lines.join('\n'), {
  waiting, parked, push, release_due: releaseDue.map((t) => t.key), stuck: stuck.map((t) => t.key),
  on_park: onPark.map((t) => t.key),
});
