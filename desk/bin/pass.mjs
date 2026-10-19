#!/usr/bin/env node
// One orchestrator pass. Read state, advance it, report. Nothing else.
//
// This is deliberately a script rather than model instructions: the orchestrator's
// context must stay flat whether the batch has 2 tickets or 20, so the per-ticket
// detail lives here and only a summary reaches the conversation.
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as E from './desk-env.mjs';
import { batchIdle, waitingOnMerge, isHeld, EXIT, crashShowsPerson, describeCrash, readQueue, Refusal } from './batch-state.mjs';
import { ANSWER_HEAD, collectAnswers } from './briefing.mjs';
import { workerMarkers } from './harvest.mjs';
import { incidentalGlobs, outOfScope, triagedScope, changedFiles, batchScopeTotals } from './scope-report.mjs';

// The verdict is the exit code (EXIT): 0 something spawned, 10 nothing can spawn yet and nothing needs
// the person, 11 the person is needed (a parked or failed ticket, anything under WAITING ON YOU, a
// finished batch, or an error). With --json, stdout is one object carrying the same verdict.
const AS_JSON = process.argv.includes('--json');
const CODES = { go_on: EXIT.GO_ON, nothing_yet: EXIT.NOTHING_YET, show_person: EXIT.SHOW_PERSON, idle: EXIT.SHOW_PERSON, error: EXIT.SHOW_PERSON };
function verdict(status, message, fields = {}) {
  const code = CODES[status];
  if (AS_JSON) {
    console.log(JSON.stringify({ status, code, message, waiting: [], parked: [], notify: code === EXIT.SHOW_PERSON, release_due: [], stuck: [], ...fields }));
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
  const hb = join(STATE, 'orchestrators');
  mkdirSync(hb, { recursive: true });
  writeFileSync(join(hb, `${QUEUE_FILE.replace(/[^A-Za-z0-9]/g, '-')}.json`),
    JSON.stringify({ queue: QUEUE_FILE, batch: JSON.parse(readFileSync(QUEUE_FILE, 'utf8')).batch ?? null, pid: process.pid, at: new Date().toISOString() }));
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
const q = (...args) => sh('node', [join(BIN, 'queue.mjs'), ...args], { tolerant: true });
const queue = () => readQueue(QUEUE_FILE);

// ---- liveness ------------------------------------------------------------
let live = [];
try { live = JSON.parse(sh('claude', ['agents', '--json'], { tolerant: true }) || '[]'); }
catch { live = []; }
// A failed registry read must never look like "everything finished" — that would
// re-spawn work already in flight.
const registryOk = Array.isArray(live);
const liveSids = new Set((registryOk ? live : []).map((a) => a.sessionId));

const Q = queue();
const rows = Object.values(Q.tickets);
const notes = [];
const report = { advanced: [], parked: [], done: [], failed: [], spawned: [], waiting: [], quiet: [], stalled: [], personStalls: [], outOfScope: [] };

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
  const park = parkSupersededByDone ? undefined : lastPark?.[1];
  // A worker whose last word is DONE has finished, whether or not its session ever exits: one that
  // hangs after printing it must be recorded done, never left running and then parked as wedged.
  const done = park ? undefined : lastDone?.[1];

  // Log growth is the honest liveness signal: it comes from the harness, not from self-reporting.
  // It is not sufficient on its own — a hung `codex exec` emits a tool_progress heartbeat every 30s,
  // so a worker wedged for hours still grows its log. See references/orchestrator-recovery.md.
  const bytes = statSync(log).size;
  if (bytes > (t.log_bytes ?? 0)) {
    q('set', t.key, `log_bytes=${bytes}`, 'idle_passes=0');
  } else {
    const idle = (t.idle_passes ?? 0) + 1;
    q('set', t.key, `idle_passes=${idle}`);
    if (idle >= 6 && !done) {
      // Free the slot. The worker's session id survives, so it can be resumed later with
      // its context intact; leaving it wedged blocks the whole batch.
      const pid = (JSON.parse(sh('claude', ['agents', '--json'], { tolerant: true }) || '[]')
        .find((a) => a.sessionId === t.session_id) ?? {}).pid;
      if (pid) sh('kill', [String(pid)], { tolerant: true });
      q('park', t.key, `wedged — no output for ${idle} passes, worker stopped (session ${t.session_id}). Requeue it with queue.mjs requeue ${t.key} (desk-autopilot's orchestrator-recovery.md); never resume the session by hand, which would run it without the worker sandbox`);
      report.stalled.push(`${t.key}: no output for ${idle} passes — stopped and parked, slot freed`);
    } else if (idle >= 3) report.quiet.push(`${t.key}: quiet for ${idle} passes`);
  }
  for (const m of h.matchAll(/AUTOPILOT_NOTE:\s*(.+)/g)) notes.push(`- [${t.key}] ${m[1].trim()}`);

  // Screenshots the worker captured but cannot upload: one shared browser profile, so the
  // orchestrator does it, one PR at a time, and only once per ticket — and only where config §3
  // grants driving the signed-in browser. Otherwise surface it for the user once.
  // The worker prints an absolute path, but a `~/...` one must still work: node does not expand ~,
  // and an unexpanded path made the uploader exit on every pass.
  const imgDir = E.expandHome([...h.matchAll(/AUTOPILOT_IMAGES:\s*(\S+)/g)].pop()?.[1]);
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
  if (stillLive && done) {
    // Finished but hung: stop the session (it has nothing left to do) and record it below.
    const pid = live.find((a) => a.sessionId === t.session_id)?.pid;
    if (pid) sh('kill', [String(pid)], { tolerant: true });
    stopped = pid ? ` (session still live after DONE — stopped pid ${pid})` : ` (session still live after DONE, no pid to stop: session ${t.session_id})`;
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
  if (park) { q('park', t.key, park.trim()); report.parked.push(`${t.key}: ${park.trim()}`); }
  else if (done) {
    const cost = /notional=\$([\d.]+)/.exec(h)?.[1];
    if (cost) q('set', t.key, `cost=${cost}`);
    const pr = /pr=(\d+)/.exec(done)?.[1] ?? null;
    q('set', t.key, 'state=done', `result.summary=${done.trim().slice(0, 200)}`, ...(pr ? [`result.pr=${pr}`] : []));
    report.done.push(`${t.key}: ${done.trim()}${stopped}`);
    recordScope(t);
  } else {
    // No marker is not evidence of failure. A worker can do everything and exit without
    // announcing it. Ask GitHub what actually exists before believing the silence. An open PR
    // means a PR exists, NOT that the review posted or that it merged — verify those separately.
    const pr = sh('gh', ['pr', 'list', '--repo', GH_REPO, '--head', t.branch ?? '',
      '--state', 'open', '--json', 'number', '-q', '.[0].number'], { tolerant: true });
    if (/^\d+$/.test(pr)) {
      q('set', t.key, 'state=done', `result.pr=${pr}`, 'result.summary=completed without printing a marker');
      report.done.push(`${t.key}: PR #${pr} (no marker printed — PR exists on GitHub; verify review and merge state)`);
      recordScope(t);
    } else {
      q('set', t.key, 'state=failed');
      report.failed.push(`${t.key}: exited with no marker and no open PR on ${t.branch} — check ${log}`);
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
// A ticket keeps the tier it last ran on (a requeue after a park keeps the model; queue.mjs requeue
// raises it after a failure), and otherwise takes one from its triage record's lane and size.
const tierFor = (t) => {
  if (t.model_tier === 'standard' || t.model_tier === 'high') return t.model_tier;
  let size = null;
  try { size = JSON.parse(readFileSync(join(STATE, 'triage', `${t.key}.json`), 'utf8')).size ?? null; } catch { /* unsized: high */ }
  return E.modelTier({ lane: t.lane, size });
};

// Concurrency: the queue's field (the orchestrator's per-pass ladder decision), never above the
// cap from config §3b "Autopilot worker concurrency" (`<default> / <cap>`, default 2 / 3).
const { def: concDefault, cap: concCap } = E.concurrencyLimits();
const concurrency = Math.min(Number(fresh.concurrency ?? concDefault), concCap);

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
const slots = (overBudget || modelsBad || lowMemory || !maySpawn) ? 0 : concurrency - running.length;
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
const eligible = eligibleBase.filter((r) => !alreadyFinished(r));
if (!maySpawn && eligible.length) {
  personStall(`not spawning ${eligible.length} ticket(s): config §3 ${HEADLESS_KEY} is "${headlessPerm}"` +
    (headlessPerm === 'ask' ? ' — confirm the batch with the user, then run passes with AUTOPILOT_USER_APPROVED=1' : ' — run /desk-setup to grant it'));
}
// Say why a triaged ticket is not spawning: a silent refusal reads as slowness.
if (blockedByDone.length) {
  personStall(`not respawning (its worker already printed AUTOPILOT_DONE): ${blockedByDone.map((r) => r.key).join(', ')} — ` +
    `if the re-run is deliberate: node ${join(BIN, 'queue.mjs')} requeue <TICKET>`);
}

// Every attempt takes a slot, failed or not, so a fault every ticket shares costs at most `slots`
// tickets a pass; a slots that is not a number spawns nothing.
let attempts = 0;
for (const t of eligible) {
  if (!(attempts < slots)) break;
  // A ticket spawned earlier in this pass is running too: two that collide never start together.
  if (collidesWithRunning(t)) continue;
  attempts += 1;
  const wt = join(WORKTREES, t.key);
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

  // The briefing carries what a fresh `claude -p` cannot infer: who to ask, what sibling
  // tickets have learnt, and — critically — the answers the user has already given.
  // Compose it, never overwrite the answers: answer.mjs writes into this file, and clobbering it
  // silently sends the worker in without the answer it was blocked on.
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

  const brief = [
    `Orchestrator session name: ${orchestratorName()}`,
    `Answer file to wait on: ${answerFile}`,
    `Screenshot directory (print it as AUTOPILOT_IMAGES): ${join(STATE, 'images', t.key)}/`,
    '',
    priorAnswers && `These questions were put to the user before you started. Their answers are binding — do not re-ask them.\n\n${priorAnswers}`,
    existsSync(notesFile) ? `## What sibling workers in this batch have found\n\n${readFileSync(notesFile, 'utf8')}` : '',
  ].filter(Boolean).join('\n');
  // Hard cap regardless of cause: the system prompt is contract + briefing and must stay well
  // under MAX_ARG_STRLEN (128KB). Truncating costs a worker some context; exceeding the cap costs
  // it its entire existence.
  const MAX_BRIEF = 60000;
  writeFileSync(briefPath, brief.length > MAX_BRIEF
    ? `${brief.slice(0, MAX_BRIEF)}\n\n[briefing truncated to stay under the argv limit]`
    : brief);

  // Prove the generated permissions behave before committing a worker to this ticket.
  const pre = shOut('bash', [join(BIN, 'spawn-worker.sh'), t.key, wt, 'preflight'], {
    cwd: MAIN, env: { ...process.env, ...workerEnv, AUTOPILOT_PREFLIGHT: '1' },
  }).out;
  if (!/\[preflight\] pass/.test(pre)) {
    // spawn_failed: no worker ran, so a requeue does not read this as the model falling short.
    q('set', t.key, 'state=failed', 'spawn_failed=true');
    report.failed.push(`${t.key}: preflight failed, not spawned —\n${pre.split('\n').filter((l) => /FAIL|!!/.test(l)).join('\n') || pre.slice(-300)}`);
    continue;
  }

  const sid = E.uuid();

  // Assign a port nothing else holds. Two things make one unavailable: another ticket in this
  // batch already holds it (a worker's port is unbound until it starts a server, so a bind check
  // alone races), or something is listening on it. The floor is one above the user's own dev port
  // (E.workerPortFloor, shared with spawn-worker.sh; AUTOPILOT_PORT_FLOOR overrides).
  const taken = new Set(Object.values(queue().tickets).map((r) => Number(r.port)).filter(Boolean));
  let port = E.workerPortFloor();
  // eslint-disable-next-line no-await-in-loop
  while (taken.has(port) || await E.portInUse(port)) port += 1;

  // Reset the stall counters: a respawn after a log rotation starts a smaller log than the stored
  // size, and without this the stall killer shoots each fresh worker within a pass or two.
  // Clear the previous round's PR and image flags too: a stale result.pr sent this round's
  // screenshots to the last round's PR, and a stale images_uploaded=true stopped them uploading.
  // Every spawn is a fresh session, so the last round's log and park record move aside first:
  // spawn-worker.sh appends to the log, and a kept park file reads as this worker's question.
  E.rotateRound(t.key);
  q('set', t.key, 'state=running', `session_id=${sid}`, `worktree=${wt}`, `branch=${branch}`, 'stage=0/9',
    `port=${port}`, `database=${database}`, 'log_bytes=0', 'idle_passes=0',
    'result=null', 'images_uploaded=null', 'images_reported=null',
    // No tier at `default`: nothing ran on one, so a requeue has nothing to raise.
    `model_tier=${models.off ? 'null' : tier}`, `model=${model || 'default'}`, 'spawn_failed=null', 'out_of_scope=null');
  const spawned = shOut('bash', [join(BIN, 'spawn-worker.sh'), t.key, wt, sid, briefPath], {
    cwd: MAIN,
    env: { ...process.env, ...workerEnv, AUTOPILOT_PORT: String(port), ...(DRY ? { AUTOPILOT_DRY_RUN: '1' } : {}) },
  });
  if (!/\[spawn\] ticket=/.test(spawned.out)) {
    q('set', t.key, 'state=failed', 'session_id=null', 'port=null', 'spawn_failed=true');
    report.failed.push(`${t.key}: spawn refused — ${spawned.out.split('\n').slice(-3).join(' ')}`);
    continue;
  }
  report.spawned.push(`${t.key} port=${port} db=${database} model=${model || 'default'}`);
  runningKeys.add(t.key);
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
for (const [label, items] of [['spawned', report.spawned], ['advanced', report.advanced], ['done', report.done], ['failed', report.failed]]) {
  if (items.length) out.push(`${label}: ${items.join(' | ')}`);
}
if (report.outOfScope.length) out.push(`out of triaged scope (report only):\n  ${report.outOfScope.join('\n  ')}`);
if (incidentalBad) out.push(`scope: ${incidentalBad} — read as the default (lockfiles)`);
if (report.stalled.length) out.push(`STALLED:\n  ${report.stalled.join('\n  ')}`);
if (report.quiet.length) out.push(`quiet: ${report.quiet.join(', ')}`);
// Held tickets. Each finished blocker's PR is looked up once per pass, so a hold behind a PR that was
// closed unmerged, or a blocker that finished with no PR, surfaces instead of waiting for ever.
const qNow = queue();
const heldNow = Object.values(qNow.tickets).filter(isHeld);
const prStates = {};
for (const t of heldNow) {
  for (const p of String(t.held_by ?? '').split('|').filter(Boolean)) {
    const n = qNow.tickets[p]?.state === 'done' ? qNow.tickets[p]?.result?.pr : null;
    if (n != null && !(n in prStates)) prStates[n] = sh('gh', ['pr', 'view', String(n), '--repo', GH_REPO, '--json', 'state', '--jq', '.state'], { tolerant: true, stdio: ['ignore', 'pipe', 'ignore'] }) || null;
  }
}
const prState = (n) => prStates[n] ?? null;
const predsOf = (t) => String(t.held_by ?? '').split('|').filter(Boolean);
const releaseDue = heldNow.filter((t) => predsOf(t).length && predsOf(t).every((p) => qNow.tickets[p]?.state === 'done' && prState(qNow.tickets[p]?.result?.pr) === 'MERGED'));
const onMerge = heldNow.filter((t) => waitingOnMerge(qNow, t, prState) && !releaseDue.includes(t));
const stuck = heldNow.filter((t) => !waitingOnMerge(qNow, t, prState));
if (onMerge.length) out.push(`WAITING ON MERGE: ${onMerge.map((t) => `${t.key} (${predsOf(t).join(', ')})`).join(', ')}`);
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

if (report.waiting.length) out.push(`WAITING ON YOU:\n  ${report.waiting.join('\n  ')}`);

// Blocked-on-questions must be visible, or "no change this pass" reads as "idle" when it
// really means "nobody answered yet".
const blocked = all.filter((r) => r.state === 'triaged' && (r.open_questions ?? 0) > 0);
if (blocked.length) out.push(`BLOCKED ON ANSWERS: ${blocked.map((b) => `${b.key} (${b.open_questions})`).join(', ')}\n  answer with: node ${join(BIN, 'answer.mjs')} <TICKET> "<answer>"`);
const heldBack = all.filter((r) => r.state === 'triaged' && (r.open_questions ?? 0) === 0 && collidesWithRunning(r));
if (heldBack.length) out.push(`held back by a collision: ${heldBack.map((x) => x.key).join(', ')}`);
if (report.parked.length) out.push(`PARKED:\n  ${report.parked.join('\n  ')}`);
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
const parked = Object.values(qEnd.tickets).filter((t) => t.state === 'parked' && !isHeld(t)).map((t) => ({ key: t.key, question: t.park?.question ?? '' }));
const idle = batchIdle(qEnd, prState);
const status = idle ? 'idle' : (waiting.length || parked.length) ? 'show_person' : report.spawned.length ? 'go_on' : 'nothing_yet';
const lines = [];
const needsYou = [...parked.map((p) => p.key), ...waiting.map((x) => x.split(':')[0])];
if (needsYou.length) lines.push(`NOTIFY: ${needsYou.length} item(s) need you — ${[...new Set(needsYou)].join(', ')}`);
else if (idle) lines.push('NOTIFY: the batch is finished — nothing left to run');
lines.push(out.length ? out.join('\n') : 'no change this pass');
lines.push(`memory: vmmem=${E.usedGiB().toFixed(1)}G avail=${availGB.toFixed(1)}G${E.runnerSegment(LADDER)}`);
lines.push('');
lines.push(sh('node', [join(BIN, 'queue.mjs'), 'render'], { tolerant: true }));
if (idle) {
  lines.push('\nIDLE — every ticket is done, parked, or failed, and none is held waiting on a merge. Nothing left to spawn. "done" means a PR exists, not that it merged.');
  const sc = batchScopeTotals(Object.values(qEnd.tickets));
  lines.push(`scope: ${sc.tickets} of ${sc.checked} checked ticket(s) changed files outside their triaged scope, ${sc.files} file(s) in all (report only)`);
}
// exitCode, not exit(): a long report to a pipe must flush before the process ends.
process.exitCode = verdict(status, lines.join('\n'), {
  waiting, parked, release_due: releaseDue.map((t) => t.key), stuck: stuck.map((t) => t.key),
});
