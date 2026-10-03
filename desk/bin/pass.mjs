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
import { batchIdle, waitingOnMerge, isHeld } from './batch-state.mjs';

let MAIN; let WORKTREES;
// Before anything reads the default branch: a batch base (queue.mjs set-batch base=…) becomes
// DESK_DEFAULT_BRANCH here, and setup-worktree, spawn-worker and the worker all inherit it.
try { E.applyBatchBase(); MAIN = E.repoRoot(); WORKTREES = E.worktreesDir(); } catch (e) { console.error(e.message); process.exit(4); }
const BIN = E.binDir();
const STATE = E.stateDir();
const QUEUE_FILE = E.queueFile();
const GH_REPO = E.ghRepo();
const DEFAULT_BRANCH = E.defaultBranch();
const DRY = !!process.env.AUTOPILOT_DRY_RUN;

if (!existsSync(QUEUE_FILE)) {
  console.error(`no queue at ${QUEUE_FILE} — run: node ${BIN}/queue.mjs init <batch-name>`);
  process.exit(1);
}

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
      if (pid !== process.pid) {
        console.error(`another orchestrator holds the lock (pid ${pid}, since ${since}).`);
        console.error(`if it is dead, remove ${LOCK}`);
        process.exit(1);
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
const queue = () => JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));

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
const report = { advanced: [], parked: [], done: [], failed: [], spawned: [], waiting: [], quiet: [], stalled: [] };
const uploadPerm = E.permission('pr-images');

// ---- advance running tickets --------------------------------------------
for (const t of rows.filter((r) => r.state === 'running')) {
  const log = join(STATE, 'logs', `${t.key}.log`);
  if (!existsSync(log)) continue;
  const h = sh('node', [join(BIN, 'harvest.mjs'), log], { tolerant: true });

  const stage = [...h.matchAll(/AUTOPILOT_STAGE:\s*(\S+)/g)].pop()?.[1];
  if (stage && stage !== t.stage) { q('set', t.key, `stage=${stage}`); report.advanced.push(`${t.key} → ${stage}`); }

  // Log growth is the honest liveness signal: it comes from the harness, not from self-reporting.
  // It is not sufficient on its own — a hung `codex exec` emits a tool_progress heartbeat every 30s,
  // so a worker wedged for hours still grows its log. See references/orchestrator-recovery.md.
  const bytes = statSync(log).size;
  if (bytes > (t.log_bytes ?? 0)) {
    q('set', t.key, `log_bytes=${bytes}`, 'idle_passes=0');
  } else {
    const idle = (t.idle_passes ?? 0) + 1;
    q('set', t.key, `idle_passes=${idle}`);
    if (idle >= 6) {
      // Free the slot. The worker's session id survives, so it can be resumed later with
      // its context intact; leaving it wedged blocks the whole batch.
      const pid = (JSON.parse(sh('claude', ['agents', '--json'], { tolerant: true }) || '[]')
        .find((a) => a.sessionId === t.session_id) ?? {}).pid;
      if (pid) sh('kill', [String(pid)], { tolerant: true });
      q('park', t.key, `wedged — no output for ${idle} passes, worker stopped (session ${t.session_id}). Requeue it as desk-autopilot's orchestrator-recovery.md describes; never resume the session by hand, which would run it without the worker sandbox`);
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
  const prNo = t.result?.pr ?? [...h.matchAll(/AUTOPILOT_DONE:[^\n]*pr=(\d+)/g)].pop()?.[1];
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
  if (stillLive) {
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

  // Exited. Decide what it was.
  //
  // ORDER MATTERS, and getting it wrong re-parks finished tickets. A worker that parks, gets
  // answered, posts and exits leaves BOTH markers in the log. Taking the last PARK unconditionally
  // re-parks a completed ticket — the log is append-only and this function has no
  // notion of which markers it has already actioned, so a spent PARK reads exactly like a live one.
  // Whichever marker appears LAST is the one that describes how the worker actually ended.
  const lastPark = [...h.matchAll(/AUTOPILOT_PARK:\s*(.+)/g)].pop();
  const lastDone = [...h.matchAll(/AUTOPILOT_DONE:\s*(.+)/g)].pop();
  const parkSupersededByDone = lastPark && lastDone && lastDone.index > lastPark.index;
  const park = parkSupersededByDone ? undefined : lastPark?.[1];
  const done = lastDone?.[1];
  if (park) { q('park', t.key, park.trim()); report.parked.push(`${t.key}: ${park.trim()}`); }
  else if (done) {
    const cost = /notional=\$([\d.]+)/.exec(h)?.[1];
    if (cost) q('set', t.key, `cost=${cost}`);
    const pr = /pr=(\d+)/.exec(done)?.[1] ?? null;
    q('set', t.key, 'state=done', `result.summary=${done.trim().slice(0, 200)}`, ...(pr ? [`result.pr=${pr}`] : []));
    report.done.push(`${t.key}: ${done.trim()}`);
  } else {
    // No marker is not evidence of failure. A worker can do everything and exit without
    // announcing it. Ask GitHub what actually exists before believing the silence. An open PR
    // means a PR exists, NOT that the review posted or that it merged — verify those separately.
    const pr = sh('gh', ['pr', 'list', '--repo', GH_REPO, '--head', t.branch ?? '',
      '--state', 'open', '--json', 'number', '-q', '.[0].number'], { tolerant: true });
    if (/^\d+$/.test(pr)) {
      q('set', t.key, 'state=done', `result.pr=${pr}`, 'result.summary=completed without printing a marker');
      report.done.push(`${t.key}: PR #${pr} (no marker printed — PR exists on GitHub; verify review and merge state)`);
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
if (budgetBad) report.stalled.push(`${budgetBad} — not spawning until it is fixed`);
const overBudget = !!budgetBad || (cap > 0 && spent >= cap);
if (cap > 0 && spent >= cap) report.stalled.push(`batch budget reached: $${spent.toFixed(2)} of $${cap} — not spawning anything further`);

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
const slots = (overBudget || lowMemory || !maySpawn) ? 0 : concurrency - running.length;
const runningKeys = new Set(running.map((r) => r.key));

// A ticket whose log already carries AUTOPILOT_DONE has finished, whatever its state says. The
// orchestrator can requeue a parked ticket that in fact finished (answer.mjs only records the answer;
// un-parking is the orchestrator's decision), and this loop would spawn a SECOND worker onto a
// completed ticket. This is a guard, not the cure: markers are never consumed.
// Deliberate re-runs stay possible — rotate the log, or name the ticket:
//   AUTOPILOT_RERUN=<TICKET> node pass.mjs
const rerunAllowed = new Set((process.env.AUTOPILOT_RERUN ?? '').split(/[,\s]+/).filter(Boolean));

const alreadyFinished = (r) => {
  if (rerunAllowed.has(r.key)) return false;
  const log = join(STATE, 'logs', `${r.key}.log`);
  if (!existsSync(log)) return false;
  try { return /AUTOPILOT_DONE:/.test(readFileSync(log, 'latin1')); } catch { return false; }
};

const eligibleBase = all.filter((r) =>
  r.state === 'triaged' &&
  (r.open_questions ?? 0) === 0 &&
  !(r.collides_with ?? '').split('|').filter(Boolean).some((k) => runningKeys.has(k)));
const blockedByDone = eligibleBase.filter(alreadyFinished);
const eligible = eligibleBase.filter((r) => !alreadyFinished(r));
if (!maySpawn && eligible.length) {
  report.stalled.push(`not spawning ${eligible.length} ticket(s): config §3 ${HEADLESS_KEY} is "${headlessPerm}"` +
    (headlessPerm === 'ask' ? ' — confirm the batch with the user, then run passes with AUTOPILOT_USER_APPROVED=1' : ' — run /desk-setup to grant it'));
}
// Say why a triaged ticket is not spawning: a silent refusal reads as slowness.
if (blockedByDone.length) {
  report.stalled.push(`not respawning (log already has AUTOPILOT_DONE): ${blockedByDone.map((r) => r.key).join(', ')} — ` +
    'rotate the log or set AUTOPILOT_RERUN if the re-run is deliberate');
}

for (const t of eligible.slice(0, Math.max(0, slots))) {
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
  const workerEnv = { AUTOPILOT_BRANCH: branch, AUTOPILOT_DATABASE: database };

  // The briefing carries what a fresh `claude -p` cannot infer: who to ask, what sibling
  // tickets have learnt, and — critically — the answers the user has already given.
  // Compose it, never overwrite the answers: answer.mjs writes into this file, and clobbering it
  // silently sends the worker in without the answer it was blocked on.
  const notesFile = join(STATE, 'batch-notes.md');
  const answerFile = join(STATE, 'answers', `${t.key}.txt`);
  mkdirSync(join(STATE, 'briefings'), { recursive: true });
  const briefPath = join(STATE, 'briefings', `${t.key}.md`);
  const prior = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '';
  // Slice ONLY the answers, not the rest of the file. Running to end-of-file swallowed the
  // sibling-notes block appended below it, so every respawn folded another copy in; one briefing
  // reached 194KB and, riding in --append-system-prompt, blew Linux's 128KB single-argument cap
  // (MAX_ARG_STRLEN): "Argument list too long", and every new worker died instantly.
  const ANSWER_HEAD = '## Answer from the user';
  const sliceAnswers = (txt) => {
    const a = txt.slice(txt.indexOf(ANSWER_HEAD));
    const cut = a.indexOf('## What sibling workers');
    return cut > 0 ? a.slice(0, cut).trimEnd() : a.trimEnd();
  };
  const priorAnswers = prior.includes(ANSWER_HEAD)
    ? sliceAnswers(prior)
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
    q('set', t.key, 'state=failed');
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
  q('set', t.key, 'state=running', `session_id=${sid}`, `worktree=${wt}`, `branch=${branch}`, 'stage=0/9',
    `port=${port}`, `database=${database}`, 'log_bytes=0', 'idle_passes=0');
  const spawned = shOut('bash', [join(BIN, 'spawn-worker.sh'), t.key, wt, sid, briefPath], {
    cwd: MAIN,
    env: { ...process.env, ...workerEnv, AUTOPILOT_PORT: String(port), ...(DRY ? { AUTOPILOT_DRY_RUN: '1' } : {}) },
  });
  if (!/\[spawn\] ticket=/.test(spawned.out)) {
    q('set', t.key, 'state=failed', 'session_id=null', 'port=null');
    report.failed.push(`${t.key}: spawn refused — ${spawned.out.split('\n').slice(-3).join(' ')}`);
    continue;
  }
  report.spawned.push(`${t.key} port=${port} db=${database}`);
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

if (report.waiting.length) out.push(`WAITING ON YOU:\n  ${report.waiting.join('\n  ')}`);

// Blocked-on-questions must be visible, or "no change this pass" reads as "idle" when it
// really means "nobody answered yet".
const blocked = all.filter((r) => r.state === 'triaged' && (r.open_questions ?? 0) > 0);
if (blocked.length) out.push(`BLOCKED ON ANSWERS: ${blocked.map((b) => `${b.key} (${b.open_questions})`).join(', ')}\n  answer with: node ${join(BIN, 'answer.mjs')} <TICKET> "<answer>"`);
const heldBack = all.filter((r) => r.state === 'triaged' && (r.open_questions ?? 0) === 0 && (r.collides_with ?? '').split('|').filter(Boolean).some((k) => runningKeys.has(k)));
if (heldBack.length) out.push(`held back by a collision: ${heldBack.map((x) => x.key).join(', ')}`);
if (report.parked.length) out.push(`PARKED:\n  ${report.parked.join('\n  ')}`);
if (drift.length) out.push(`base drift: ${drift.join(', ')}`);
const needsHuman = [...report.waiting, ...report.parked];
if (needsHuman.length) console.log(`NOTIFY: ${needsHuman.length} ticket(s) need you — ${needsHuman.map((x) => x.split(':')[0]).join(', ')}`);
console.log(out.length ? out.join('\n') : 'no change this pass');
console.log(`memory: vmmem=${E.usedGiB().toFixed(1)}G avail=${availGB.toFixed(1)}G`);
console.log('');
console.log(sh('node', [join(BIN, 'queue.mjs'), 'render'], { tolerant: true }));

const idle = batchIdle(queue(), prState);
if (idle) console.log('\nIDLE — every ticket is done, parked, or failed, and none is held waiting on a merge. Nothing left to spawn. "done" means a PR exists, not that it merged.');
