#!/usr/bin/env node
// One orchestrator pass. Read state, advance it, report. Nothing else.
//
// This is deliberately a script rather than model instructions: the orchestrator's
// context must stay flat whether the batch has 2 tickets or 20, so the per-ticket
// detail lives here and only a summary reaches the conversation.
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, statSync, mkdirSync, openSync, closeSync, renameSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { uptime } from 'node:os';
import * as E from './desk-env.mjs';
import { batchIdle, batchConcurrency, waitingOnMerge, isHeld, spinePark, SPINE_APPROVAL_PREFIX, SPINE_SPECS_PREFIX, EXIT, crashShowsPerson, describeCrash, readQueue, Refusal } from './batch-state.mjs';
import { checkSpine, spineMerger, checkChild, ownedIds, ownedSpecs, specFilesAt, specsCommand, EXPECTED_FAIL, CHILD_SPECS_PREFIX } from './spine-check.mjs';
import { ANSWER_HEAD, collectAnswers, capBriefing, MAX_BRIEF, BRIEF_CUT } from './briefing.mjs';
import { HANDOFF_STAGES, handoffStage, handoffPath, readHandoff, handoffTarget, branchCommits, renderHandoff,
  roundStage, resumeCheck, answersSince, renderLastRound, renderNoResume } from './handoff.mjs';
import { workerMarkers, endedNormally } from './harvest.mjs';
import { parseDecision, parseCheck, decisionEntry, appendDecisions } from './decisions.mjs';
import { readRegister, lookup, parseInputs, refreshInputs, inputsHash } from './not-now.mjs';
import { checkinTimes, checkinRow, checkin, urgentParks, readDecisions, repos as digestRepos } from './digest.mjs';
import { incidentalGlobs, outOfScope, triagedScope, changedFiles, batchScopeTotals } from './scope-report.mjs';
import { batchCost, costTable, preflightLine } from './worker-cost.mjs';
import { ensureBaseWorktree, syncBase, openingCommit } from './base-sync.mjs';
import * as BL from './baseline.mjs';
import { renderLedger, syncLedger, ledgerHash } from './ledger.mjs';
import { usageLimit, resetText } from './usage-limit.mjs';
import { firstSpawnFromLogs, epicUnread } from './desk-q-eta.mjs';
import { health } from './health.mjs';
import { usagePace } from './usage-pace.mjs';
import { borrowSetting, borrowPlan, borrowedLine, otherBatches, otherQueues, machineBudget, machineCap, takeBorrowLock, beatFile, parseNext } from './borrow.mjs';

// The verdict is the exit code (EXIT): 0 something spawned, 10 nothing can spawn yet and nothing needs
// the person, 11 the person is needed (a parked or failed ticket, anything under WAITING ON YOU, a
// finished batch, or an error). With --json, stdout is one object carrying the same verdict.
const AS_JSON = process.argv.includes('--json');
const CODES = { go_on: EXIT.GO_ON, nothing_yet: EXIT.NOTHING_YET, show_person: EXIT.SHOW_PERSON, idle: EXIT.SHOW_PERSON, error: EXIT.SHOW_PERSON };
function verdict(status, message, fields = {}) {
  const code = CODES[status];
  if (AS_JSON) {
    console.log(JSON.stringify({ status, code, message, waiting: [], parked: [], notify: code === EXIT.SHOW_PERSON, push: [], release_due: [], stuck: [], ...fields }));
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

if (!existsSync(QUEUE_FILE)) {
  refuse(`no queue at ${QUEUE_FILE} — run: node ${BIN}/queue.mjs init <batch-name>`);
}
// A corrupt queue refuses here, before the pass touches anything, rather than mid-pass as a stack.
try { readQueue(QUEUE_FILE); } catch (e) { refuse(describeCrash(e)); }

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
      if (pid !== process.pid) refuse(`another orchestrator holds the lock (pid ${pid}, since ${since}).\nif it is dead, remove ${LOCK}`);
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
const report = { advanced: [], parked: [], done: [], failed: [], spawned: [], waiting: [], quiet: [], stalled: [], personStalls: [], outOfScope: [], paused: [], unrecognised: [], putOff: [] };

// The "not now" register (not-now.mjs), read once a pass. An unreadable one puts nothing off, so every
// question is asked as it would be without one, and the person is told.
const REGISTER = readRegister(STATE);
if (!REGISTER.ok) report.waiting.push(`not-now register: unreadable (${REGISTER.why}), so every question is asked as usual. Fix or remove the file`);
// A park the person put off with the same inputs: it stays parked, and is not asked again.
const putOff = (t) => t.state === 'parked' && !!t.park?.question && !isHeld(t)
  && lookup(REGISTER, { question: t.park.question, inputs: t.park.inputs ?? {} }).status === 'put_off';

// The 5-hour usage limit. Claude Code waits for the reset and then carries on, which spends the next
// usage window: config §3 autopilot-usage-resume decides whether a worker may, and anything but `yes`
// stops it at the limit. A paused worker is quiet, not wedged, until this long after the reset; then
// the stall check runs as before.
const usagePerm = E.permission('autopilot-usage-resume');
const USAGE_KEY = E.permissionKey('autopilot-usage-resume');
const mayResumeOnLimit = usagePerm === 'yes';
const LIMIT_GRACE_MS = 30 * 60 * 1000;

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
  if (!p.ok) report.waiting.push(`${t.key}: unreadable park inputs (${p.why}), read as none: ${raw}`);
  const inputs = p.ok ? p.inputs : {};
  return { inputs, ...lookup(REGISTER, { question, inputs }) };
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

  // A worker at the 5-hour usage limit (usage-limit.mjs decides; nothing here reads the event). Only
  // a worker that has neither parked nor finished is acted on.
  const logText = readFileSync(log, 'utf8');
  const usage = usageLimit(logText);
  const limit = !park && !done && !handoff && usage.last?.kind === 'limit' ? usage.last : null;
  if (usage.unrecognised.length > (t.usage_unrecognised ?? 0)) {
    q('set', t.key, `usage_unrecognised=${usage.unrecognised.length}`);
    report.unrecognised.push(`${t.key}: ${usage.unrecognised.at(-1)}`);
  }
  if (mayResumeOnLimit) {
    for (const l of usage.limits.filter((x) => x.resumed)) {
      notes.push(`- [${t.key}] resumed after the 5-hour usage limit reset at ${resetText(l.resetsAt)} (config §3 ${USAGE_KEY} is "yes")`);
    }
  }
  if (limit && !mayResumeOnLimit) {
    // Stopping needs the registry: without it the worker would resume while recorded as parked.
    if (!registryOk) continue;
    const isLive = liveSids.has(t.session_id);
    const pid = live.find((a) => a.sessionId === t.session_id)?.pid;
    if (pid) sh('kill', [String(pid)], { tolerant: true });
    const stop = !isLive ? 'its session had already ended' : pid ? `the worker was stopped (pid ${pid})` : `no pid to stop: stop session ${t.session_id} by hand`;
    // A worker can resume before any pass sees it paused. It is stopped all the same, so it spends
    // no more of the next window, and the reason says it had resumed.
    const why = limit.resumed
      ? `reached the 5-hour usage limit, which reset ${resetText(limit.resetsAt)}, and resumed into the next usage window before a pass saw it. ` +
        `Config §3 ${USAGE_KEY} is "${usagePerm}", so it goes no further: ${stop}. Requeue it with queue.mjs requeue ${t.key}`
      : `paused on the 5-hour usage limit, which resets ${resetText(limit.resetsAt)}. Config §3 ${USAGE_KEY} is "${usagePerm}", so it does not resume into the next usage window: ${stop}. ` +
        `After the reset, requeue it with queue.mjs requeue ${t.key}`;
    q('park', t.key, why);
    report.parked.push(`${t.key}: ${why}`);
    continue;
  }
  const pausedOnLimit = !!limit && !limit.resumed && Date.now() < limit.resetsAt * 1000 + LIMIT_GRACE_MS;
  if (pausedOnLimit) report.paused.push(`${t.key} until ${resetText(limit.resetsAt)}, then it resumes (config §3 ${USAGE_KEY} is "yes")`);

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
    if (uploadPerm === 'yes' || process.env.DESK_UPLOAD_APPROVED) {
      const run = shOut('node', [join(BIN, 'upload-images.mjs'), String(prNo), imgDir]);
      const up = run.out;
      const doneLine = /done: (\d+) image\(s\) in the body, (\d+) placeholder\(s\) left/.exec(up);
      const tail = up.split('\n').slice(-2).join(' ');
      if (run.ok && doneLine && Number(doneLine[1]) > 0 && Number(doneLine[2]) === 0) {
        q('set', t.key, 'images_uploaded=true');
        report.advanced.push(`${t.key} images → #${prNo}`);
        // The worker leaves the PR in draft; undrafting is the orchestrator's, after the review
        // checks in SKILL.md. Report evidence completeness so that decision has what it needs.
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
    const parkFile = join(STATE, 'parks', `${t.key}.json`);
    if (existsSync(parkFile) && !existsSync(join(STATE, 'answers', `${t.key}.txt`))) {
      try {
        const p = JSON.parse(readFileSync(parkFile, 'utf8'));
        if (p.question) report.waiting.push(`${t.key}: ${p.question}`);
      } catch { /* a half-written park file is not an error */ }
    }
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
    q('set', t.key, `park.inputs=${JSON.stringify(reg.inputs)}`);
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
      report.failed.push(`${t.key}: exited with no marker and no open PR on ${t.branch}${limit ? `, last seen at the 5-hour usage limit (resets ${resetText(limit.resetsAt)})` : ''} — check ${log}`);
    }
  }
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
else if (PACE.hold) report.stalled.push(`${PACE.line} (${running.length} running carry on)`);
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
// While the runner VM runs, its machine-profile memory is a fixed reservation held back from
// `avail` (less what the VM already holds, which `avail` has already lost): CI can fill it at any
// moment, so the ladder reads the rest. Without a runner nothing is held back.
const GATE = E.spawnGate();
const MIN_AVAIL_GB = GATE.start;
const LADDER = E.ladderMemory();
const availGB = LADDER.avail;
const gateGB = LADDER.gate;
const reserved = LADDER.reservation ? ` after the runner's ${LADDER.reservation.heldGiB.toFixed(1)}G held back` : '';
const lowMemory = MIN_AVAIL_GB > 0 && gateGB < MIN_AVAIL_GB;
if (lowMemory) {
  report.stalled.push(gateGB < GATE.hold
    ? `memory: ${gateGB.toFixed(1)}G available${reserved}, under the ${GATE.hold}G floor — §3b says drop to ${GATE.dropTo} worker(s); ` +
      `holding spawns (${running.length} running; a worker mid-suite will drain)`
    : `memory: ${gateGB.toFixed(1)}G available${reserved}, in the §3b hold band (${GATE.hold}–${GATE.start}G) — holding spawns this pass ` +
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
const toResume = (r) => r.resume === 'pending';
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
const held = overBudget ? 'the batch budget holds every spawn' : modelsBad ? 'config §3b "Worker models" holds every spawn'
  : !CHECKIN.ok ? 'config §3b "Check-in times" holds every spawn'
  : HEALTH.failing.length ? `a failing health check (${HEALTH.failing.join(', ')}) holds every spawn`
  : PACE.bad ? `config §3b "${E.CONFIG_ROWS['usage-pacing'].row}" holds every spawn`
  : PACE.hold ? '7-day usage ahead of pace holds every spawn'
  : !maySpawn ? `config §3 ${HEADLESS_KEY} is "${headlessPerm}"` : null;
let borrowLock = null;
let others = [];
let lockWhy = null;
if ((BORROW.on || MACHINE_CAP != null) && concurrency > 0 && eligible.length && !held && !lowMemory) {
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
  on: BORROW.on, share: concurrency, cap: E.concurrencyLimits().cap, running: running.length, wanted: eligible.length,
  others, machine: MACHINE_CAP, memory: { avail: gateGB, start: MIN_AVAIL_GB }, held, lock: lockWhy,
});
const MACHINE = machineBudget({ running: running.length, wanted: Math.min(plan.slots, eligible.length), machine: MACHINE_CAP, queues: otherRepos });
const slots = Math.min(plan.slots, MACHINE.room);
const machineLine = MACHINE.line + (MACHINE_CAP != null && lockWhy ? ` (counted without the lock: ${lockWhy})` : '');
const CEILING = E.memoryCeiling();

// ---- batch base ------------------------------------------------------------
// A batch with a base keeps its own worktree for it (every pass makes sure it exists), and the default
// branch is merged into the base only before a pass that will spawn, so new workers start on a current
// tree. A sync that cannot run is reported; in feature mode it also holds this pass's spawns, since
// the feature's children are built and tested against the base as one.
const BASE = E.batchBase();
const SOURCE = E.configValue('default-branch');
const baseLines = [];
let baseHold = false;
const baselineSetting = E.configValue('baseline-checks');
const baselineOn = /^on$/i.test(String(baselineSetting ?? '').trim());
if (BASE && SOURCE && BASE !== SOURCE) {
  // plan-batch records the decision on the queue when it seeds; feature.json alone can name a spine
  // for a batch that runs as an ordinary one.
  const featureMode = fresh.feature === true;
  const willSpawn = slots > 0 && eligible.length > 0;
  const blocked = (why) => {
    report.waiting.push(`base sync: ${why} — ${featureMode ? 'feature mode, so nothing spawns this pass' : 'spawning carries on from the base as it stands'}`);
    if (featureMode) baseHold = true;
  };
  const wt = ensureBaseWorktree({ main: MAIN, worktrees: WORKTREES, base: BASE });
  if (wt.ok && wt.made) baseLines.push(`base worktree for ${BASE} made at ${wt.path}`);
  if (!wt.ok) {
    if (willSpawn) blocked(wt.why);
    else report.waiting.push(`base worktree: ${wt.why}`);
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
  if (wt.ok && willSpawn && !baseHold && baselineOn) recordBaseline(wt.path);
  if (wt.ok && featureMode && fresh.promotion == null) openPromotion(wt.path);
}

// ---- promotion PR ----------------------------------------------------------
// A feature-mode batch opens its promotion PR (base → default branch) as a draft on its first pass, so
// the feature has one PR to be reviewed by as it is built. It is tried once and recorded on the queue
// as `promotion` ({pr, url} or {pr: null, why}): a refusal is reported and the batch carries on
// without it. The base gate marks it ready; merging it is the person's.
function openPromotion(path) {
  const epic = fresh.epic ?? null;
  const title = `${epic ?? 'Feature'}: promote ${BASE} to ${SOURCE}`;
  if (DRY) { baseLines.push(`promotion PR (dry run): would open ${BASE} → ${SOURCE} as a draft, titled "${title}"`); return; }
  const record = (p) => q('set-batch', `promotion=${JSON.stringify({ ...p, at: new Date().toISOString() })}`);
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
    `It stays draft while the batch runs. Once every child has merged into \`${BASE}\`, the base gate merges \`${SOURCE}\` in and runs every acceptance spec and the repo's Typecheck, Lint and Unit tests there, and marks it ready only when they pass. Merging it is a person's call.`,
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
// Ports held by running workers in every other repo's queue. Two repos' worker blocks can meet, and a
// worker's port is unbound until it starts a server, so probing cannot see one another repo's pass has
// just handed out. Only running tickets hold one. A queue that will not parse is named in the report
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
// a running worker in another repo's queue holds it (two repos' worker blocks can meet), or something
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
  return { failure, cost };
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
// was spawned with.
async function resumeKilled(t) {
  const n = (t.resumes ?? 0) + 1;
  // spawn_failed: no worker ran, so a requeue does not read this as the model falling short.
  const fail = (why) => {
    q('set', t.key, 'state=failed', 'resume=null', 'port=null', 'spawn_failed=true');
    report.failed.push(`${t.key}: killed before it finished, and could not be resumed: ${why}`);
  };
  // The row may have changed while it waited for a slot.
  const stop = resumeRefusal(t, t.resume_why ?? 'reboot or crash');
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
  if (pre.failure) { logPreflight(t.key, pre.cost); return fail(`preflight failed —\n${pre.failure}`); }
  const port = await freePort(t);
  const briefPath = join(STATE, 'briefings', `${t.key}.md`);
  const prompt = `Your previous run of this session was killed before it finished (${t.resume_why ?? 'reboot or crash'}). ` +
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
  report.spawned.push(`${t.key} resumed after it was killed (${n} of ${RESUME.limit}) — ${t.resume_why ?? 'reboot or crash'}; session ${t.session_id} port=${port}; ${preflightNote(pre.cost)}`);
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
    `Screenshot directory (print it as AUTOPILOT_IMAGES): ${join(STATE, 'images', t.key)}/`,
    '',
    // Before the answers: collectAnswers keeps everything from an answer heading to the sibling
    // notes, or to the end of the file, so nothing but answers may follow one.
    h,
    ownedBrief(t, wt),
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
// resume file that records another (resumeCheck). A round that cannot be resumed is said in the
// briefing, and the worker starts at Stage 0. Returns { stage, brief, line }: stage null for Stage 0.
function resumeRound(t, { wt, kept, branch }) {
  const round = t.last_round;
  const stage = roundStage(round?.stage);
  if (!stage || !kept) return { stage: null, brief: '', line: '' };
  const r = resumeCheck({ worktree: wt, key: t.key, branch });
  if (!r.ok) {
    return { stage: null, brief: renderNoResume({ round: { stage }, why: r.why }), line: ` from Stage 0 (not resumed from Stage ${stage}: ${r.why})` };
  }
  const briefPath = join(STATE, 'briefings', `${t.key}.md`);
  const answers = answersSince(existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '', round.at);
  const base = `origin/${DEFAULT_BRANCH}`;
  const brief = renderLastRound({ key: t.key, round: { ...round, stage }, answers, branch, worktree: wt, base, commits: branchCommits(wt, base) });
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
  if (pre.failure) { logPreflight(t.key, pre.cost); return fail(`preflight failed —\n${pre.failure}`); }
  const sid = E.uuid();
  const port = await freePort(t);
  E.rotateRound(t.key);
  const logBytes = logPreflight(t.key, pre.cost);
  q('set', t.key, 'state=running', `session_id=${sid}`, `stage=${stage}`, `port=${port}`, `log_bytes=${logBytes}`, 'idle_passes=0',
    'handoff=null', 'last_round=null', `model_tier=${models.off ? 'null' : tier}`, `model=${model || 'default'}`, 'resume=null', 'resume_why=null', 'resumes=null');
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

for (const t of eligible) {
  if (baseHold || !(attempts < slots)) break;
  // A ticket spawned earlier in this pass is running too: two that collide never start together.
  if (collidesWithRunning(t)) continue;
  attempts += 1;
  if (toResume(t)) {
    // eslint-disable-next-line no-await-in-loop
    await resumeKilled(t);
    continue;
  }
  if (toHandoff(t)) {
    // eslint-disable-next-line no-await-in-loop
    await spawnHandoff(t);
    continue;
  }
  const wt = join(WORKTREES, t.key);
  // Read before setup-worktree.sh, which makes a worktree that is not there: a round left in one the
  // requeue removed for a fresh branch is not resumed.
  const kept = existsSync(wt);
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
  q('set', t.key, 'state=running', `session_id=${sid}`, `worktree=${wt}`, `branch=${branch}`, `stage=${resumed.stage ?? '0/9'}`, 'last_round=null',
    `port=${port}`, `database=${database}`, `log_bytes=${logBytes}`, 'idle_passes=0',
    'result=null', 'images_uploaded=null', 'images_reported=null',
    // No tier at `default`: nothing ran on one, so a requeue has nothing to raise.
    `model_tier=${models.off ? 'null' : tier}`, `model=${model || 'default'}`, 'spawn_failed=null', 'out_of_scope=null', 'usage_unrecognised=null',
    // A fresh session has not been resumed, and starts at Stage 0 rather than from a handoff.
    'resume=null', 'resume_why=null', 'resumes=null',
    'handoff=null', 'handoff_stage=null', 'handoff_cost=null', 'images_dir=null');
  // A ticket first spawned before spawned_at was recorded keeps its earliest round's start: that
  // round's log was moved aside above, and the history measures from it.
  const now = new Date().toISOString();
  const earlier = t.spawned_at ? null : firstSpawnFromLogs(STATE, t.key);
  const spawnedAt = earlier && Date.parse(earlier) < Date.parse(now) ? earlier : now;
  const spawned = shOut('bash', [join(BIN, 'spawn-worker.sh'), t.key, wt, sid, briefPath], {
    cwd: MAIN,
    env: { ...process.env, ...workerEnv, AUTOPILOT_PORT: String(port), ...(resumed.stage ? { AUTOPILOT_START_STAGE: resumed.stage } : {}),
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
  report.spawned.push(`${t.key} port=${port} db=${database} model=${model || 'default'}${resumed.line}; ${preflightNote(pre.cost)}`);
  runningKeys.add(t.key);
}
// Every worker started under the lock is recorded running in this queue, so other passes count it.
borrowLock?.release();
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
const stuck = heldNow.filter((t) => !waitingOnMerge(qNow, t, prState));
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
const merger = spineMerger();
for (const t of Object.values(qNow.tickets).filter((r) => r.approved === true && r.state === 'done' && r.result?.pr != null)) {
  const n = t.result.pr;
  if (merger.driver) continue;
  if (readPr(n) === 'MERGED') continue;
  report.waiting.push(`${t.key}: SPINE APPROVED — merge PR #${n} once it is green (${merger.rows}, so no merge driver merges it); what is held behind it is released once it merges`);
}
// The merge driver releases these on its next loop. Where it is not running, the release is yours:
// queue.mjs set <TICKET> state=triaged park=null held_by=null, then queue.mjs front <TICKET>.
// A live merge driver releases these on its next loop, so they only need you when it is not running.
const driverPid = Number((() => { try { return readFileSync(join(STATE, 'merge-driver.lock.d', 'pid'), 'utf8').trim(); } catch { return ''; } })());
const driverLive = (() => { if (!driverPid) return false; try { process.kill(driverPid, 0); return true; } catch { return false; } })();
for (const t of releaseDue) {
  if (driverLive) out.push(`release due: ${t.key} (every blocker merged; the merge driver releases it on its next loop)`);
  else report.waiting.push(`${t.key}: RELEASE DUE — every blocker merged (${predsOf(t).join(', ')}) and no merge driver is running: release it (queue.mjs set ${t.key} state=triaged park=null held_by=null, then queue.mjs front ${t.key})`);
}
for (const t of stuck) report.waiting.push(`${t.key}: STUCK — held behind ${predsOf(t).join(', ') || 'no recorded blocker'}, which cannot merge on its own (failed, parked, no PR, or a closed PR): decide whether it waits, is released, or is dropped`);
// A failed ticket waits on the person until it is requeued or dropped. This pass's failures are
// printed under `failed:` with their reason, and reach the verdict's `waiting` from there.
const failedThisPass = new Set(report.failed.map((x) => x.split(':')[0]));
for (const t of Object.values(qNow.tickets).filter((r) => r.state === 'failed' && !failedThisPass.has(r.key))) {
  report.waiting.push(`${t.key}: FAILED — requeue it (queue.mjs requeue ${t.key}), finish it by hand, or drop it`);
}

// ---- base gate -------------------------------------------------------------
// A feature-mode batch whose children have all merged into the base is checked as a whole before its
// promotion PR leaves draft: base-gate.mjs, started here in the background because the base's suites
// can outlast one pass, and read back from the queue's `gate` on later passes. It runs again whenever
// the base moves after a run. A parked or failed child means the feature is not complete: the gate
// does not run and the report names each one. While the gate waits on merges or runs, the batch is
// not idle.
const GATE_LOG = join(STATE, 'logs', 'base-gate.log');
function baseGate(qx) {
  const tickets = Object.values(qx.tickets);
  const stopped = tickets.filter((t) => ['parked', 'failed'].includes(t.state));
  if (stopped.length) {
    report.waiting.push(`BASE GATE: not run, since ${stopped.length} child(ren) did not finish: ${stopped.map((t) => `${t.key} (${t.state === 'failed' ? 'failed' : `parked: ${String(t.park?.question ?? '').slice(0, 80)}`})`).join(', ')}. ` +
      `The base is checked once every child has merged into ${BASE}${qx.promotion?.pr ? `; promotion PR #${qx.promotion.pr} stays draft` : ''}`);
    return false;
  }
  // A child that finished with no PR, or whose PR was closed unmerged, can never merge: the person
  // decides, and nothing waits on it. One whose PR is still open is waited for.
  const noPr = tickets.filter((t) => t.result?.pr == null);
  const closed = tickets.filter((t) => t.result?.pr != null && readPr(t.result.pr) === 'CLOSED');
  const open = tickets.filter((t) => t.result?.pr != null && !['MERGED', 'CLOSED'].includes(readPr(t.result.pr)));
  if (noPr.length || closed.length || open.length) {
    const never = [...noPr.map((t) => `${t.key} (finished with no PR)`), ...closed.map((t) => `${t.key} (PR #${t.result.pr} closed without merging)`)];
    if (never.length) report.waiting.push(`BASE GATE: not run, since ${never.join(', ')} cannot merge into ${BASE}: requeue or drop ${never.length > 1 ? 'them' : 'it'}`);
    if (open.length) {
      const list = open.map((t) => `${t.key} (PR #${t.result.pr})`).join(', ');
      if (driverLive) out.push(`BASE GATE: waits on ${list} merging into ${BASE}`);
      else report.waiting.push(`BASE GATE: waits on ${list} merging into ${BASE}, and no merge driver is running: merge them`);
    }
    return open.length > 0 && !never.length;
  }

  sh('git', ['-C', MAIN, 'fetch', '-q', 'origin', `refs/heads/${BASE}:refs/remotes/origin/${BASE}`], { tolerant: true });
  const head = sh('git', ['-C', MAIN, 'rev-parse', '--verify', '-q', `origin/${BASE}`], { tolerant: true }) || null;
  let g = qx.gate ?? null;
  if (g?.state === 'running') {
    const alive = (() => { try { return g.pid ? (process.kill(g.pid, 0), true) : false; } catch { return false; } })();
    if (alive) { out.push(`BASE GATE: running on ${BASE} since ${g.started} (pid ${g.pid}); log ${GATE_LOG}`); return true; }
    g = { ...g, state: 'failed', finished: new Date().toISOString(), failures: [`the gate stopped without a result (pid ${g.pid ?? '?'}): see ${GATE_LOG}`] };
    q('set-batch', `gate=${JSON.stringify(g)}`);
  }
  if (!g || (g.sha && head && g.sha !== head)) {
    if (DRY) { out.push(`BASE GATE (dry run): would start on ${BASE}`); return false; }
    q('set-batch', `gate=${JSON.stringify({ state: 'running', pid: null, started: new Date().toISOString(), sha: head })}`);
    mkdirSync(join(STATE, 'logs'), { recursive: true });
    const fd = openSync(GATE_LOG, 'a');
    const child = spawn(process.execPath, [join(BIN, 'base-gate.mjs')], { cwd: MAIN, detached: true, stdio: ['ignore', fd, fd], env: process.env });
    child.unref();
    closeSync(fd);
    q('set-batch', `gate.pid=${child.pid}`);
    out.push(`BASE GATE: started on ${BASE}${g ? ` again (it moved since the last run, at ${String(g.sha).slice(0, 12)})` : ''} (pid ${child.pid}): merges ${SOURCE} in, then runs every acceptance spec and the repo's Typecheck, Lint and Unit tests there; log ${GATE_LOG}`);
    return true;
  }

  const at = `${BASE} at ${String(g.sha ?? '?').slice(0, 12)}`;
  if (g.state === 'passed') {
    const link = qx.promotion?.url ?? (g.pr != null ? `https://github.com/${GH_REPO}/pull/${g.pr}` : null);
    if (g.pr == null) {
      report.waiting.push(`BASE GATE: passed on ${at}, but the batch has no promotion PR to mark ready (${qx.promotion?.why ?? 'none was recorded'}): open one from ${BASE} to ${SOURCE}`);
    } else if (g.ready) {
      out.push(`BASE GATE: passed on ${at}: every acceptance spec, Typecheck, Lint and Unit tests. Promotion PR #${g.pr} is ready for review: ${link} (merging it is yours)`);
    } else {
      report.waiting.push(`BASE GATE: passed on ${at}, but promotion PR #${g.pr} is still draft: ${g.note ?? 'it was not marked ready'}. ${link}`);
    }
    const co = g.close_out;
    out.push(co == null ? `close-out: the epic's criteria could not be read, so check every one per criterion`
      : co.length ? `close-out: check only ${co.join(', ')} per criterion, which no spec covers; every other criterion's spec passed on ${BASE}`
        : `close-out: every criterion has a spec that passed on ${BASE}, so no per-criterion check is needed`);
  } else {
    for (const f of g.failures ?? []) report.waiting.push(`BASE GATE: ${f}`);
    report.waiting.push(`BASE GATE: failed on ${at}${g.pr != null ? `, so promotion PR #${g.pr} stays draft` : ''}. Fix it on ${BASE}: the gate runs again once ${BASE} moves, or now with queue.mjs set-batch gate=null`);
  }
  return false;
}
const featureBase = qNow.feature === true && BASE && SOURCE && BASE !== SOURCE && Object.keys(qNow.tickets).length > 0;
const gatePending = featureBase && batchIdle(qNow, prState) ? baseGate(qNow) : false;

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
if (report.putOff.length) out.push(`put off, so not asked again until their inputs change (the digest lists them):\n  ${report.putOff.join('\n  ')}`);
if (drift.length) out.push(`base drift: ${drift.join(', ')}`);

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
if (CHECKIN.ok && !DRY) {
  const d = await checkin({ times: CHECKIN.times, self: SLUG, list: digestRepos({ self: { slug: SLUG, state: STATE, queue: QUEUE_FILE } }) });
  if (d.status === 'sent') lines.push(`check-in ${d.slot}: ${d.questions} question(s), ${d.decisions} decision(s) — ${d.page}${d.push ? '' : ' (nothing new: no push)'}`);
  if (d.push) push.unshift(d.push);
}
push.push(...HEALTH.push);
for (const p of push) lines.push(`PUSH: ${p.text}`);
lines.push(out.length ? out.join('\n') : 'no change this pass');
lines.push(HEALTH.line);
lines.push(PACE.line);
lines.push(`memory: vmmem=${E.usedGiB().toFixed(1)}G avail=${availGB.toFixed(1)}G${E.runnerSegment(LADDER)}`);
lines.push(CEILING.line);
lines.push(CONC.line);
lines.push(machineLine);
if (BORROW.bad) lines.push(`borrowing: ${BORROW.bad}`);
if (borrowLine) lines.push(borrowLine);
lines.push('');
lines.push(sh('node', [join(BIN, 'queue.mjs'), 'render'], { tolerant: true }));
if (idle) {
  lines.push('\nIDLE — every ticket is done, parked, or failed, and none is held waiting on a merge. Nothing left to spawn. "done" means a PR exists, not that it merged.');
  const sc = batchScopeTotals(Object.values(qEnd.tickets));
  lines.push(`scope: ${sc.tickets} of ${sc.checked} checked ticket(s) changed files outside their triaged scope, ${sc.files} file(s) in all (report only)`);
  const resumed = Object.values(qEnd.tickets).filter((t) => t.resumes > 0);
  if (resumed.length) lines.push(`resumed after a kill: ${resumed.map((t) => `${t.key} ${t.resumes} time(s) (${t.state})`).join(', ')}`);
  const cost = batchCost(STATE, Object.values(qEnd.tickets));
  if (cost.length) lines.push(costTable(cost));
}
// exitCode, not exit(): a long report to a pipe must flush before the process ends.
process.exitCode = verdict(status, lines.join('\n'), {
  waiting, parked, push, release_due: releaseDue.map((t) => t.key), stuck: stuck.map((t) => t.key),
});
