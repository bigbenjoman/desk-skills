// The pure helpers more than one phase of a pass uses, and the snapshot every phase starts from. Each
// takes what it reads as arguments: none starts a process, calls git, gh or Jira, or writes the queue.
// A helper that does any of those stays in pass.mjs as an action handler.
import { isNone, CONFIG_ROWS } from '../desk-env.mjs';
import { resetText, limitName } from '../usage-limit.mjs';
import { HANDOFF_STAGES } from '../handoff.mjs';
import { FOLLOW_ON_MAX } from '../harvest.mjs';
import { ownedIds } from '../spine-check.mjs';
import { evaluateGate, stateFailing, loginIn } from '../gate.mjs';
import { LIVE_READ_FORMS } from '../config-schema.mjs';

// ---- the snapshot ---------------------------------------------------------
// The session registry (claude-logins.mjs readRegistry) as a phase reads it. A failed read must never
// look like "everything finished", which would re-spawn work already in flight, so it reads as
// unread: `read` false, and `sessions` and `liveSids` null, never empty.
export function registryView(registry) {
  const read = Array.isArray(registry?.live);
  return {
    read,
    why: read ? null : registry?.why ?? null,
    sessions: read ? registry.live : null,
    liveSids: read ? new Set(registry.live.map((a) => a.sessionId)) : null,
  };
}

// What every phase's snapshot holds: the queue's tickets as the phase starts, the pass's one registry
// read (registryView), and the time. A phase adds what else it reads.
export const phaseSnapshot = ({ tickets, registry, now }) => ({ tickets, registry, now });

// ---- the shared actions --------------------------------------------------------
// The two actions every phase may return, each run by pass.mjs PHASE_HANDLERS: queue fields to set on a
// ticket, and a line for the pass's report list `list` (with no key where the line is the batch's).
export const set = (key, ...fields) => ({ type: 'set', key, fields });
export const say = (key, list, line) => ({ type: 'report', ...(key ? { key } : {}), list, line });

// ---- logins, subscriptions and usage holds ----------------------------------
// A paused worker whose session is still live is quiet, not wedged, until this long after the reset.
export const LIMIT_GRACE_MS = 30 * 60 * 1000;
// Passes with no log growth before a worker is reported quiet, and before it is stopped as wedged. Workers
// log no partial messages, so a long model turn or a suite behind the test lock writes nothing until it ends.
export const QUIET_PASSES = 3;
export const WEDGE_PASSES = 6;
// A worker past WEDGE_PASSES that is running its own suite under the test lock, or queued for it, is
// quiet, not wedged, until it has been held that way for this long.
export const SUITE_WAIT_CEILING_MS = 30 * 60 * 1000;
// A worker whose log grew only by the harness's tool_progress heartbeat, for one tool call running
// longer than this, is hung in that call and stopped as wedged.
export const TOOL_CALL_CEILING_MS = 30 * 60 * 1000;

// Whether `login` is the repo's own login `repoLogin`: only a limit there holds the batch.
export const sameLogin = (repoLogin, login) => !!repoLogin && !!login && login.dir === repoLogin.dir;
// How a limit lifted, once it has: its reset passed, else the probe call succeeded.
export const liftedHow = (l, now = Date.now()) => (l.resetsAt != null && now >= l.resetsAt * 1000 ? `its reset at ${resetText(l.resetsAt)} passed` : 'a probe call succeeded');
export const untilText = (l) => (l.resetsAt != null ? ` until ${resetText(l.resetsAt)}` : '');
// A worker waiting at a usage limit until it lifts (or the grace after its reset) is paused, not quiet.
// The limit passed in is one the worker has not answered since (usageLimit's `resumed` is false).
export const pausedOn = (limit, now = Date.now()) => !!limit && !limit.resumed && (limit.resetsAt == null || now < limit.resetsAt * 1000 + LIMIT_GRACE_MS);
// The batch's usage hold `h` ({ type, resetsAt }), in a line.
export const usageHeldText = (h) => `${limitName(h.type)}${untilText(h)} holds every spawn and resume, until it lifts or a probe call succeeds`;

// ---- base fix tries -----------------------------------------------------------
// What a base_fix try is for: a conflict, a merge §4 Merged-tree check failed, the epic PR's review
// (kind `review`), or the promotion PR's red checks (kind `checks`).
export const tryWhat = (x) => (x?.kind === 'review' ? 'epic PR review' : x?.kind === 'checks' ? 'promotion PR check' : x?.check ? 'merged-tree fix' : 'conflict fix');
// The last try's number, which a try that waited only on the test lock leaves for the next one too.
export const tryNo = (rec) => rec.tries[rec.tries.length - 1]?.try ?? rec.tries.length;

// Why PR `p` ({ pr, branch, author }) is not ticket `t`'s own, or null when it is: a PR on a branch
// other than the one its worker made, or one opened by an account other than desk's (`logins`, the §1
// GitHub handle and its review account, comma-joined, as E.verdictLogins gives them, read by gate.mjs
// loginIn). A field not read is not held against it.
export function notOwnPr(t, p, logins) {
  const at = p?.branch, mine = t?.branch;
  if (at && mine && at !== mine) return `PR #${p.pr} is on branch ${at}, not ${t.key}'s branch ${mine}`;
  if (p?.author && String(logins ?? '').trim() && !loginIn(p.author, logins)) return `PR #${p.pr} was opened by ${p.author}, not by ${String(logins).split(',').map((x) => x.trim()).join(' or ')}`;
  return null;
}
// How a not-its-own park's question starts: foreignQuestion writes it, foreignParkPr reads it back.
const foreignLead = (n) => `its PR #${n} is not its own: `;
// The lead holds no character a pattern reads specially but the group put in for the number.
const FOREIGN_LEAD = new RegExp(`^${foreignLead('(\\d+)')}`);
// The PR a not-its-own park (foreignQuestion) names, or null for any other question.
export const foreignParkPr = (question) => Number(FOREIGN_LEAD.exec(String(question ?? ''))?.[1]) || null;
// The park a ticket gets when PR #n, not its own (notOwnPr's `why`), was taken or reported as its result.
export const foreignQuestion = (n, why) => `${foreignLead(n)}${why}. desk takes as a ticket's result only a PR on the branch its worker made, opened by desk's account, so nothing is done to #${n}: no fix or review try, undraft, reopen or merge. If #${n} already holds this ticket's work, take the ticket out of the batch; otherwise requeue it so a worker makes it on its own branch`;
// A merged PR's merge commit as gh reads it (`mergeCommit`), or null where GitHub names none.
export const mergeOid = (v) => (/^[0-9a-f]{40}$/.test(String(v?.mergeCommit?.oid ?? '')) ? v.mergeCommit.oid : null);

// The queue's subscription_off value to write, or null when it stands as `was`: the repo's row pinned
// to a subscription set off (`repoSub`, desk-env thisRepoSubscription) is recorded from `at`, and
// dropped once the pin resolves again. DESK_SUBSCRIPTION naming one is not recorded: the row is what
// the person is told to move.
export function subscriptionOffWrite(was, repoSub, at) {
  const off = repoSub.off && repoSub.fix === 'the row' ? { email: repoSub.email, login: repoSub.off.name } : null;
  if (!(off ? was?.email !== off.email || was?.login !== off.login : was)) return null;
  return off ? JSON.stringify({ since: at, ...off }) : 'null';
}

// ---- scope and specs ---------------------------------------------------------
// A feature spine is the queue's `spine` in feature mode.
export const isSpineOf = (q, t) => q.feature === true && q.spine === t.key;
// A feature child that owns criteria (the queue's `owners`, recorded when plan-batch seeds).
export const ownsSpecsOf = (q, t) => q.feature === true && !isSpineOf(q, t) && ownedIds(q.owners, t.key).length > 0;
// The time an owned-spec run may take.
export const SPEC_RUN_MS = 30 * 60 * 1000;
// §4 Acceptance specs, from the row's values: the spec directory and the command taking {ids}. Unset,
// both are null, and each check names what is missing.
export function acceptanceSpecsOf(row) {
  if (row && !isNone(row)) return { specDir: row[0], cmd: row.find((x) => x.includes('{ids}')) ?? null };
  return { specDir: null, cmd: null };
}

// ---- link and build parks ----------------------------------------------------
export const LINKS_HEAD = 'Issue links not made: ';
export const linksLine = (needs) => `${LINKS_HEAD}${needs.map((n) => n.why ?? n).join('; ')}`;
// The clears-when kind of a park that waits only on links a person can make.
export const LINKS_MADE = 'links-made';
// A park question without the links line the pass adds to it, which its link steps already hold.
export const ownWords = (question) => String(question ?? '').split(`. ${LINKS_HEAD}`)[0];
// A link the pass could not make, kept as a follow-on step under §3 jira-edit.
export const LINK_STEP = 'Issue link not made: ';
export const linkSteps = (steps) => (Array.isArray(steps) ? steps : []).filter((s) => String(s?.step ?? '').startsWith(LINK_STEP));
// A park's own words, kept as the one follow-on step a merge-only park leaves for after its merge, after
// any link steps an earlier round kept (`had`, the ticket's follow_on).
export const parkFollowOn = (park, had) => `follow_on=${JSON.stringify([...linkSteps(had), { step: park.trim().slice(0, FOLLOW_ON_MAX), row: null }])}`;
// What green means here, from config §4 Required and Advisory checks' values: unset or `none` is none.
export function gateListsOf({ required, advisory }) {
  const list = (v) => (v && !isNone(v) ? v : []);
  return { required: list(required), advisory: list(advisory) };
}
// Whether PR status s is held by a failing reviewer check (`reviewer`, health.mjs: the account desk posts
// verdicts from is not one §4 Gate reviewers counts, or cannot be read): red only on a §4 State check of
// kind verdict (`stateChecks`), with nothing pending, under `gate` (gateListsOf). A review or fix try
// there posts a verdict the gate does not count. Undraft and the fix tries both read it.
export function reviewerGated(s, { reviewer, gate, stateChecks }) {
  if (!reviewer || s?.state !== 'OPEN') return false;
  const g = evaluateGate(s.checks ?? [], gate);
  if (g.state !== 'fail' || g.pending.length) return false;
  const verdict = new Set(stateFailing(g.failing, stateChecks).filter((f) => f.kind === 'verdict').map((f) => f.name));
  return verdict.size > 0 && g.failing.every((f) => verdict.has(f.name));
}

// ---- fix tries ---------------------------------------------------------------
// The files a PR conflicts on, from `git merge-tree --write-tree --name-only` output `o` (its first line
// is the tree), or null when git could not say (o null) or named none.
export function conflictFilesIn(o) {
  const files = o?.split('\n').slice(1).filter(Boolean) ?? [];
  return files.length ? files : null;
}
// What a fix try's record on the ticket keeps beside its try, kind and head: a review try what it quoted,
// so a later review can tell a finding it cleared from one that survived it; a protected-files try the
// files it judged, so none is sent to a worker twice; a renames try its renames; a conflict try the base
// it was read against.
export const fixTryQuote = (f) => (f.kind === 'review' ? { ...(f.findings?.length ? { findings: f.findings } : {}), ...(f.gaps?.length ? { gaps: f.gaps } : {}) }
  : f.kind === 'protected' ? { paths: f.paths } : f.kind === 'renames' ? { renames: f.renames }
    : f.kind === 'conflict' && f.base_sha ? { base_sha: f.base_sha, merge_base: f.merge_base } : {});

// ---- handoffs and resumes --------------------------------------------------
// What a session stopped at the per-worker budget gets on top of that budget, once, to commit, push
// and finish its stage (resume=budget).
export const BUDGET_RESUME_USD = 5;
export const WORKER_BUDGET_ROW = `config §${CONFIG_ROWS['worker-budget'].section} "${CONFIG_ROWS['worker-budget'].row}"`;
// The stages a session hands off to, in stage order: Object.keys lists an integer-like key (7) before '4b'.
export const HANDOFF_ORDER = Object.keys(HANDOFF_STAGES).sort((a, b) => parseFloat(a) - parseFloat(b));
export const FROM_ZERO = (t) => `To start it again from Stage 0 instead: queue.mjs set ${t.key} handoff_stage=null, then queue.mjs requeue ${t.key}`;
// Config §3b "Resume a killed worker (times)", from its raw value and row name: unset is 2; anything but
// a whole number is said (`bad`) and read as 0, which marks a killed worker failed.
export function resumeSetting(raw, row) {
  if (raw == null || isNone(raw)) return { row, limit: raw == null ? 2 : 0, bad: null };
  if (/^\d+$/.test(String(raw).trim())) return { row, limit: Number(raw), bad: null };
  return { row, limit: 0, bad: `config §3b "${row}" is "${raw}" — want a whole number; read as 0, so a killed worker is marked failed` };
}
// Where a killed worker's resume stops, under `resume` (resumeSetting): off, or this ticket has had as
// many as the row allows. Null when it may resume.
export function resumeRefusal(resume, t, why) {
  const n = t.resumes ?? 0;
  if (resume.limit <= 0) return { fail: `Resuming is off (${resume.bad ?? `config §3b "${resume.row}" is 0`}), so it is marked failed` };
  if (n >= resume.limit) {
    return { park: `killed again (${why}) after ${n} resume(s), the most config §3b "${resume.row}" allows (${resume.limit}), so it is not resumed. ` +
      `Session ${t.session_id}, worktree ${t.worktree}. Requeue it for a fresh worker with queue.mjs requeue ${t.key}` };
  }
  return null;
}
// When this computer last started, in ms: `stamp` (DESK_BOOT_TIME, ISO or epoch seconds, which stands
// in for it in tests), else `now` less `uptimeS` seconds.
export function bootTime(stamp, now, uptimeS) {
  if (stamp) return /^\d+$/.test(stamp) ? Number(stamp) * 1000 : Date.parse(stamp);
  return now - uptimeS * 1000;
}
// A worker stopped for a planned reboot (resume=reboot) waits for the computer to restart after its
// stop, or, when none comes, for `drainMins` (config §3b "Maintenance drain limit (minutes)", `drainRow`)
// from the stop, then resumes anyway. -> {why} once it may resume, else {wait}.
export function rebootReady(t, { bootMs, drainMins, drainRow, now = Date.now() }) {
  const at = Date.parse(t.reboot_stop_at ?? '');
  const stop = (t.resume_why ?? 'stopped for a planned reboot').replace(/^stopped/, 'it stopped');
  if (!Number.isFinite(at) || bootMs > at) {
    return { why: `the computer restarted at ${new Date(bootMs).toISOString().replace(/\.\d+Z$/, 'Z')} after ${stop}` };
  }
  const until = at + drainMins * 60000;
  if (now >= until) return { why: `no reboot was seen within ${drainMins} min (config §3b "${drainRow}") of when ${stop}` };
  return { wait: `${stop.replace(/^it /, '')}, resumed after the computer restarts, or at ${new Date(until).toISOString().replace(/\.\d+Z$/, 'Z')} if it does not` };
}

// ---- live reads --------------------------------------------------------------
// The report's waiting line for a config §4 Live reads row that does not parse (live-read.mjs
// parseLiveReads), or null when it parses.
export const liveReadsUnparsed = (readRow) => (readRow.errors.length
  ? `live reads: none run this pass, since config §4 Live reads does not parse: ${readRow.errors.join(', ')} (want ${LIVE_READ_FORMS}). Run /desk-setup`
  : null);

// A review try (kind rereview) reviews its PR's head and changes no file.
export const reviewOnlyTry = (t) => Boolean(t?.fix && !t.fix.finished && t.fix.kind === 'rereview');
// A cloud ticket runs in the cloud until its PR is read (advanceCloud records result.pr and
// cloud.pr_at), and its branch is then on origin. A fix try of a kind the session can work from what
// the PR shows (CLOUD_FIX_KINDS) goes back to that session (cloudFixRoute), or to a new cloud session
// on the PR's branch where it is gone, and runs in the cloud while it is out (`cloud.fix`, fixInCloud).
// Any other work after the PR, another kind of fix try or a rework, is a local worker's on that branch
// at origin's tip (setup-worktree.sh with DESK_BRANCH_FROM_ORIGIN), which pushes there. cloud.pr_at
// outlives the local spawn, which clears result; a new cloud start resets it.
export const cloudPrHere = (t) => t?.location === 'cloud' && (t.result?.pr != null || t.cloud?.pr_at != null);
// The fix tries a cloud session takes on its own PR: review findings and gaps, red checks and a
// reviewer's threads, each of which the PR shows it. A conflict, a sync, a person's call and the
// review and capture tries need this computer.
export const CLOUD_FIX_KINDS = ['review', 'checks', 'feedback'];
// A fix try out to a cloud session: `cloud.fix`, on a session not recorded abandoned. A stopped session
// (queue.mjs stopCloud) keeps its `cloud.fix`, which a requeue keeps too, and a local worker started on
// the try after it must not count as running in the cloud.
export const fixInCloud = (t) => t?.location === 'cloud' && Boolean(t.cloud?.fix) && !t.cloud.abandoned_at;
export const runsInCloud = (t) => t?.location === 'cloud' && (!cloudPrHere(t) || fixInCloud(t));
// A cloud session that may still push to its PR's branch: recorded, and not recorded abandoned.
export const cloudSessionLive = (t) => Boolean(t?.cloud?.session) && !t.cloud.abandoned_at;
// The session a local start of ticket `t` must wait on, or null: an unfinished fix try that writes to its
// cloud PR's branch (any but a review or capture try), while that PR's session is not among `archived`
// (cloud-worker.mjs readArchived). Recorded abandoned is not enough: nothing here can end a cloud
// session, so until the person archives it, it may still push to the branch. -> its URL or id
export function cloudArchiveWait(t, archived) {
  const f = t?.fix, s = t?.cloud?.session;
  if (!cloudPrHere(t) || !f || f.finished || ['rereview', 'capture'].includes(f.kind) || !s || archived.has(s)) return null;
  return t.cloud.url ?? s;
}
// Where a cloud ticket's unfinished fix try on its PR goes, decided as its turn in the spawn loop comes:
// 'send' to its live session (cloud-worker.mjs sendCloud), 'new' for a new cloud session on the PR's
// branch where it has none, or null for a local worker: not a cloud PR's, a kind no session takes, a
// resume or handoff (which run here), or with the effort lever on (`effort`), which no cloud session
// can be given.
export function cloudFixRoute(t, { effort = false } = {}) {
  const f = t?.fix;
  if (!cloudPrHere(t) || !f || f.finished || !CLOUD_FIX_KINDS.includes(f.kind)) return null;
  if (toResume(t) || toHandoff(t) || effort) return null;
  return cloudSessionLive(t) ? 'send' : 'new';
}
// Pinned to this computer (queue.mjs set <KEY> location=local, or `local <KEY>`; the pass pins a cloud
// ticket whose session went idle on a WIP PR, pass.mjs cloudUnfinished): placement at start never
// sends it to the cloud. Its work goes on from its cloud PR's branch where it has one (fromCloudPr).
export const pinnedLocal = (t) => t?.location === 'local';
// A local worker's branch is checked out from origin, never cut afresh from the base: a cloud ticket's
// PR is read (cloudPrHere), or its cloud session opened one (cloud.pr_at) before it was moved local,
// whether or not the pin has been cleared since (location=auto).
export const fromCloudPr = (t) => cloudPrHere(t) || t?.cloud?.pr_at != null;
// A worker running on this computer. A cloud session (cloud-worker.mjs) runs away from it, so it holds
// no local slot and the maintenance window neither waits for one nor stops it, in any repo, a fix try
// sent to one included; a review try on a cloud ticket's PR runs here.
export const runningHere = (t) => t?.state === 'running' && !runsInCloud(t);
// A killed worker waiting to resume, and a session handed off to its next stage (both run here).
export const toResume = (r) => ['pending', 'usage', 'maintenance', 'reboot', 'budget'].includes(r.resume);
export const toHandoff = (r) => r.handoff === 'pending';
// The tickets a `|`-separated queue field names.
export const keysOf = (s) => String(s ?? '').split('|').filter(Boolean);
// A ticket placed at the front of the queue that is a new start, as far as its own record says: the pass's
// atFront adds what only the pass knows (not running, its worker not finished), and desk-q reads the rest.
export const placedFront = (t) => !!t?.placed && t.state === 'triaged' && !toHandoff(t) && !toResume(t) && !reviewOnlyTry(t)
  && (t.open_questions ?? 0) === 0 && keysOf(t.cycle_link).length === 0;
// A ticket that can run in a cloud session: its triage record needs nothing this computer has (admission
// writes cloud_ok; a ticket admitted before that carries location=cloud), no PR of its is read yet, and
// it has not started on this computer (its work is then in a local worktree, and stays there). Where it
// runs is decided when it starts (placeAtStart), not at admission. One pinned to this computer
// (pinnedLocal) is not, whatever triage's `runs:` said, until `location=auto` clears the pin.
export const cloudAble = (t) => (t?.cloud_ok === true || t?.location === 'cloud') && !cloudPrHere(t)
  && !pinnedLocal(t) && t.cloud?.pr_at == null && t.result?.pr == null && t.start_place?.where !== 'local';
// A ticket the spawn loop may start in a cloud session, taking one of §3b "Cloud sessions at once" and
// no local slot: a resume or handoff of one runs here.
export const startsInCloud = (t) => cloudAble(t) && !toResume(t) && !toHandoff(t);

// Where a ticket starts, decided as its turn in the spawn loop comes: -> { where, why }, where 'cloud',
// 'local' or null (it waits; `full` then says which kind it waits for).
//   able        it may start in the cloud (startsInCloud)
//   cloudRoom   a cloud session is free this pass; cloudRunning / cloudLimit the count it says
//   localRoom   a local slot is free this pass
//   localSpare  a local slot stayed free for the whole of the last pass (the batch's local_free_at)
//   reserve     local-only tickets still to come in this pass's order: the local slots they would take
//   free        local slots still free this pass (slots - attempts)
//   personUse   the person is using this computer (person-use.mjs)
// Cloud first: a cloud-able ticket goes to the cloud while its cap has room. Local slots go first to
// local-only tickets: a cloud-able one takes one only with the cloud full, a local slot free for the
// whole last pass, one free now beyond those the local-only tickets still to come want, and the person
// not using the computer.
export function placeAtStart({ able, cloudRoom, localRoom, localSpare = false, reserve = 0, free = 0, personUse = false, cloudRunning = null, cloudLimit = null }) {
  if (!able) return localRoom ? { where: 'local', why: 'it must run on this computer' } : { where: null, why: 'waits for a local slot', full: 'local' };
  const count = cloudLimit != null ? ` (${cloudRunning} of ${cloudLimit} running, §3b "Cloud sessions at once")` : '';
  if (cloudRoom) return { where: 'cloud', why: `cloud first: a cloud session is free${count}` };
  if (personUse) return { where: null, why: `you're using this computer, so it goes only to the cloud, which is full${count}`, full: 'cloud' };
  if (localRoom && localSpare && free > reserve) return { where: 'local', why: `the cloud is full${count}, and a local slot stayed free all last pass` };
  return { where: null, why: `waits for a cloud session${count}; local slots go first to tickets that must run here`, full: 'cloud' };
}
// The slot a fresh ticket's priority hold weighs (spawn-order.mjs priorityHold), as placeAtStart places
// it now: -> { where, free, pending }, or null where it starts nowhere this pass (decideSpawn says so, and
// priority holds nothing that would not start anyway). `ahead` the tickets the spawn loop has still to
// read; `local` and `cloud` the local slots and cloud sessions still free; `localSpare` and `personUse`
// as placeAtStart's. `pending` the fresh tickets ahead that may want that slot: for a cloud start the
// cloud-able ones, for a local start any, as a cloud-able one may fall back to it. One counted that then
// goes elsewhere costs only a deferral (spawn-order.mjs deferringOrder). `able` and `slotless` are the
// pass's own reads, as decideSpawn's: `able` a ticket placed as cloud-able (startsInCloud, and in the pass
// a fix try whose cloud session is gone), `slotless` one that takes no slot of either kind (in the pass a
// fix try sent to its live session, or one waiting on that session's archive), so neither the reserve nor
// `pending` counts it, and a slotless `t` weighs no slot.
export function priorityPool(t, ahead, { local, cloud, localSpare = false, personUse = false, able = startsInCloud, slotless = () => false }) {
  if (slotless(t)) return null;
  const place = placeAtStart({ able: able(t), cloudRoom: cloud > 0, localRoom: local > 0, localSpare,
    reserve: ahead.filter((x) => !able(x) && !slotless(x)).length, free: local, personUse });
  if (place.where == null) return null;
  const toCloud = place.where === 'cloud';
  const pending = ahead.filter((x) => x.key !== t.key && !toResume(x) && !toHandoff(x) && !slotless(x) && (!toCloud || able(x)));
  return { where: place.where, free: toCloud ? cloud : local, pending: new Set(pending.map((x) => x.key)) };
}
// The `failed=` field pass.mjs markFailed sets on a failed ticket: why, when, and the error subtype its
// session ended with where there is one, which the ticket ledger's failed event records.
export const failedField = (why, { subtype = null, at = new Date().toISOString() } = {}) =>
  `failed=${JSON.stringify({ why: String(why).replace(/\s+/g, ' ').trim().slice(0, 600), at, ...(subtype ? { subtype } : {}) })}`;
