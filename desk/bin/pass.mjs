#!/usr/bin/env node
// One orchestrator pass. Read state, advance it, report. Nothing else.
//
// This is deliberately a script rather than model instructions: the orchestrator's
// context must stay flat whether the batch has 2 tickets or 20, so the per-ticket
// detail lives here and only a summary reaches the conversation.
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, statSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import * as E from './desk-env.mjs';
import { batchIdle, waitingOnMerge, isHeld, spinePark, SPINE_APPROVAL_PREFIX, SPINE_SPECS_PREFIX, EXIT, crashShowsPerson, describeCrash, readQueue, Refusal } from './batch-state.mjs';
import { checkSpine, spineMerger, checkChild, ownedIds, ownedSpecs, specFilesAt, specsCommand, EXPECTED_FAIL, CHILD_SPECS_PREFIX } from './spine-check.mjs';
import { ANSWER_HEAD, collectAnswers } from './briefing.mjs';
import { workerMarkers } from './harvest.mjs';
import { incidentalGlobs, outOfScope, triagedScope, changedFiles, batchScopeTotals } from './scope-report.mjs';
import { ensureBaseWorktree, syncBase, openingCommit } from './base-sync.mjs';
import * as BL from './baseline.mjs';
import { renderLedger, replaceLedger, ledgerHash } from './ledger.mjs';

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
    if (isSpine(t)) parkSpine(t, pr);
    else if (ownsSpecs(t)) checkOwned(t, pr);
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
      if (isSpine(t)) parkSpine(t, Number(pr));
      else if (ownsSpecs(t)) checkOwned(t, Number(pr));
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
for (const t of eligible) {
  if (baseHold || !(attempts < slots)) break;
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
    // Before the answers: collectAnswers keeps everything from an answer heading to the sibling notes.
    ownedBrief(t, wt),
    baselineBrief(),
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
out.push(...baseLines);
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
// The promotion PR's body carries one row per child (ledger.mjs), rewritten whenever a row changes, a
// child merging into the base included. A body that cannot be read or written is reported and the
// batch carries on; nothing is recorded until a write succeeds, so the next pass tries again.
function updateLedger(qx) {
  const n = qx.promotion?.pr;
  if (n == null) return;
  for (const t of Object.values(qx.tickets)) if (t.state === 'done' && t.result?.pr != null) readPr(t.result.pr);
  const ledger = renderLedger(qx, prState);
  const hash = ledgerHash(ledger);
  if (qx.promotion.ledger === hash) return;
  const notUpdated = (why) => out.push(`promotion PR #${n}: ledger not updated, ${why}. The batch carries on; the next pass tries again`);
  const lastLine = (s) => s.split('\n').filter(Boolean).pop() ?? 'no output';
  if (DRY) { out.push(`promotion PR #${n} (dry run): would rewrite its ledger`); return; }
  const editPerm = E.permission('pr-edit');
  if (editPerm !== 'yes') { notUpdated(`since config §3 ${E.permissionKey('pr-edit')} is "${editPerm}"`); return; }
  const read = shOut('gh', ['pr', 'view', String(n), '--repo', GH_REPO, '--json', 'body']);
  let body = null;
  try { body = read.ok ? JSON.parse(read.out).body : null; } catch { /* reported below */ }
  if (typeof body !== 'string') { notUpdated(`since its body could not be read (${lastLine(read.out)})`); return; }
  const next = replaceLedger(body, ledger);
  if (next !== body) {
    const wrote = shOut('gh', ['pr', 'edit', String(n), '--repo', GH_REPO, '--body-file', '-'], { input: next, stdio: ['pipe', 'pipe', 'pipe'] });
    if (!wrote.ok) { notUpdated(`since its body could not be written (${lastLine(wrote.out)})`); return; }
    out.push(`promotion PR #${n}: ledger rewritten`);
  }
  q('set-batch', `promotion.ledger=${hash}`);
}
updateLedger(queue());

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
const idle = batchIdle(qEnd, prState) && !gatePending;
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
