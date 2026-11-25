// The release watch, the safety net behind the auto-release (maintenance.mjs): every release install.sh
// installs (for the auto-release, the maintenance window or a person) is recorded in releases.jsonl beside
// its state by install.sh's record step (installed.mjs), and once that release's window ends (WINDOW_TICKETS
// tickets finished on it, or WINDOW_HOURS since it went in, whichever comes first) its tickets are
// weighed against the previous release's: fix tries per ticket, parked hours per ticket, post-merge
// reverts, and parks in an error class the previous release's tickets never parked in. A ticket counts
// for the release its last worker start ran on (spawn-worker.sh records each start's desk commit).
//
// The trips are the lever registry's (lever-registry.mjs): a post-merge revert of a ticket on the release
// trips it at once, as POST_MERGE_REVERT trips a lever; fix tries and parked hours trip past their
// guardrail's rate-ratio margin, and a new error class trips, each only once both releases have the
// registry's revert_min_per_arm tickets. A trip pins the previous release (the release folder install.sh
// kept for it, held from pruning while it may be needed, made current again, and what runs moved onto
// it), opens one revert PR reverting every merge between the two releases, and raises one needs-you
// item naming the merges, the metric and the evidence. The pin holds every auto-release and window
// update until main carries the revert PR's merge, or the PR is closed unmerged (the person kept the
// release). `desk-q rollback <commit>` does the same on demand. A rollback takes the auto-release's
// lock, so it never interleaves with an install.
//
// Its state is release-watch.json beside the auto-release's: each release judged, the pin, and when the
// rows were last read.
//
//   import { recordRelease, watchRelease, pinBlocks, rollBack, manualRollback } from './release-watch.mjs'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as E from './desk-env.mjs';
import { DECISION_RULE, GUARDRAILS, POST_MERGE_REVERT } from './lever-registry.mjs';
import { releases, makeLive, currentRelease, releaseCommit, holdReleases, restart as restartRunning } from './installed.mjs';
import { CLASSES, WAITING_CLASSES } from './failure-class.mjs';
import { writeJsonAtomic } from './dir-lock.mjs';
import { tryBorrowLock } from './borrow.mjs';
import { addAsk } from './asks.mjs';
import { allBatches } from './batches.mjs';
import { perTicket } from './phase0-report.mjs';
import { withOutcomes, outcomeIn, EVIDENCE_KEEP_DAYS } from './levers-evaluate.mjs';
import { readPostMerge } from './post-merge.mjs';

const HOUR_MS = 3_600_000;
export const WINDOW_TICKETS = 10;
export const WINDOW_HOURS = 72;
// The fewest tickets on each release before a guardrail is weighed; a hard trip needs none.
export const MIN_TICKETS = DECISION_RULE.revert_min_per_arm;
export const FIX_TRIES_MARGIN = GUARDRAILS['fix-tries-parks'].margin.max_rate_ratio;
export const PARKED_HOURS_MARGIN = GUARDRAILS['parked-hours'].margin.max_rate_ratio;
// The park classes that are errors: not a wait, a usage limit, or a park no rule could read.
export const ERROR_CLASSES = Object.freeze(CLASSES.filter((c) => ![...WAITING_CLASSES, 'quota', 'unclassified'].includes(c)));
// How often the rows are read while a release's window is open, and how far back they reach: a ticket
// counts for the release it last started on, however long it queued, so as far back as the lever
// evaluation reads.
export const CHECK_EVERY_MS = HOUR_MS;
const LOOKBACK_MS = EVIDENCE_KEEP_DAYS * 24 * HOUR_MS;
// A release recorded longer ago than this is never judged: its window, and the code it ran, are long gone.
const STALE_MS = 14 * 24 * HOUR_MS;

export const releasesFile = (dir) => join(dir, 'releases.jsonl');
export const watchFile = (dir) => join(dir, 'release-watch.json');
// The auto-release's lock (maintenance.mjs), so a rollback never interleaves with an install.
const RELEASE_LOCK = 'release.lock.d';
const takeReleaseLock = (dir) => { mkdirSync(dir, { recursive: true }); return tryBorrowLock({ dir, name: RELEASE_LOCK }); };
const short = (sha) => String(sha ?? '?').slice(0, 12);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: `${r.stderr ?? ''}`.trim() || r.error?.message || `exit ${r.status}` };
};
const lastLine = (s) => String(s ?? '').split('\n').filter(Boolean).pop() ?? '';

export function readWatch(dir) {
  try { return JSON.parse(readFileSync(watchFile(dir), 'utf8')) ?? {}; } catch { return {}; }
}
const writeWatch = (dir, s) => { mkdirSync(dir, { recursive: true }); writeJsonAtomic(watchFile(dir), s); };

// The record of one install: the commit before it, the commit installed, and how many
// merges to main it carried.
export function recordRelease(dir, { at, from, to, merges }, home = E.deskHome()) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(releasesFile(dir), `${JSON.stringify({ at: new Date(at).toISOString(), from, to, merges })}\n`);
  holdOpen(dir, +new Date(at), home);
}
// Keeps install.sh from pruning a release a rollback may still need: the one before each release not
// yet judged, and the pinned one.
function holdOpen(dir, now, home) {
  const s = readWatch(dir);
  const open = readReleases(dir).filter((r) => !s.judged?.[r.to] && now - Date.parse(r.at) < STALE_MS);
  try { holdReleases([...open.map((r) => r.from), ...(s.pinned ? [s.pinned.commit] : [])], home); } catch { /* the next record or watch writes it again */ }
}
export function readReleases(dir) {
  let body = '';
  try { body = readFileSync(releasesFile(dir), 'utf8'); } catch { return []; }
  return body.split('\n').flatMap((l) => { try { const r = JSON.parse(l); return r?.to && r.from && r.at ? [r] : []; } catch { return []; } });
}

// ---- which tickets a release holds ---------------------------------------------------------------------
// The desk commit a row's last recorded start ran on, or null.
const lastCommit = (r) => (r.start_records ?? []).filter((s) => s.desk_commit).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1)?.desk_commit ?? null;
// When a row finished: its merge, else its last start.
const finishedAt = (r) => Date.parse(r.merged_at ?? '') || Math.max(0, ...(r.start_records ?? []).map((s) => Date.parse(s.at) || 0));
// The first WINDOW_TICKETS rows whose outcome is in and whose last start ran on `commit`, in the order
// they finished.
export const ticketsOn = (rows, commit) => rows.filter((r) => outcomeIn(r) && lastCommit(r) === commit)
  .sort((a, b) => finishedAt(a) - finishedAt(b)).slice(0, WINDOW_TICKETS);

// Release `rel`'s window at `now`: closed once WINDOW_TICKETS of its tickets are in, or WINDOW_HOURS after
// it went in. -> { closed, tickets }
export function windowOf(rel, rows, now) {
  const tickets = ticketsOn(rows, rel.to);
  return { closed: tickets.length >= WINDOW_TICKETS || now - Date.parse(rel.at) >= WINDOW_HOURS * HOUR_MS, tickets };
}

const mean = (rows, f) => {
  const v = rows.map(f).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
// One release's figures over its tickets.
export function figures(tickets) {
  const errorParks = {};
  for (const r of tickets) for (const [c, n] of Object.entries(r.parks_by_class ?? {})) if (ERROR_CLASSES.includes(c) && n > 0) errorParks[c] = (errorParks[c] ?? 0) + n;
  return {
    tickets: tickets.length,
    fix_tries: mean(tickets, (r) => r.fix_tries),
    parked_hours: mean(tickets, (r) => r.parked_hours),
    reverts: tickets.filter((r) => r.reverts > 0).map((r) => `${r.slug ? `${r.slug} ` : ''}${r.key}`),
    error_parks: errorParks,
  };
}
const label = (m) => `${m.tickets} ticket(s), fix tries ${m.fix_tries?.toFixed(2) ?? 'none recorded'}, parked hours ${m.parked_hours?.toFixed(1) ?? 'none recorded'}, `
  + `${m.reverts.length} reverted, error parks ${Object.entries(m.error_parks).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}`;

// Release `rel`'s figures beside the previous release's, and the trips among them.
//   -> { now: figures, before: figures, trips: [{ metric, why }], note }
export function compare(rel, rows) {
  const now = figures(ticketsOn(rows, rel.to));
  const before = figures(ticketsOn(rows, rel.from));
  const trips = [];
  if (now.reverts.length) trips.push({ metric: POST_MERGE_REVERT.id, why: `${now.reverts.join(', ')} ${now.reverts.length > 1 ? 'were' : 'was'} reverted after merging, a hard trip whatever the sample` });
  const enough = now.tickets >= MIN_TICKETS && before.tickets >= MIN_TICKETS;
  if (enough) {
    const ratio = (key, margin, what) => {
      if (!(before[key] > 0) || now[key] == null) return;
      const x = now[key] / before[key];
      if (x > margin) trips.push({ metric: key.replace('_', '-'), why: `${what} per ticket rose from ${before[key].toFixed(2)} to ${now[key].toFixed(2)}, ${x.toFixed(2)}x, past the ${margin}x margin` });
    };
    ratio('fix_tries', FIX_TRIES_MARGIN, 'fix tries');
    ratio('parked_hours', PARKED_HOURS_MARGIN, 'parked hours');
    const fresh = Object.keys(now.error_parks).filter((c) => !before.error_parks[c]);
    if (fresh.length) trips.push({ metric: 'new-error-class-parks', why: `its tickets parked in ${fresh.map((c) => `${c} (${now.error_parks[c]})`).join(', ')}, a class the previous release's tickets never parked in` });
  }
  const note = enough ? null : `the guardrails were not weighed, ${now.tickets} and ${before.tickets} ticket(s) against the ${MIN_TICKETS} each needs; the hard trips were read`;
  return { now, before, trips, note };
}

// ---- the rows -------------------------------------------------------------------------------------------
// Every configured repo's per-ticket rows admitted since `since`, each with its parked hours, and its
// `reverts`: post-merge.jsonl's revert records for it.
export function machineRows({ since, now = Date.now(), configRoot = E.deskConfigRoot() } = {}) {
  const out = [];
  for (const c of E.configuredRepos(configRoot)) {
    try {
      const batches = allBatches(c.slug);
      const { rows } = withOutcomes(perTicket({ slug: c.slug, batches, since, until: now, ci: false, repo: c.ghRepo }).rows, batches, now);
      const reverts = new Map();
      for (const b of batches) for (const x of readPostMerge(b.state)) if (x.kind === 'revert') reverts.set(`${b.name ?? ''}|${x.ticket}`, (reverts.get(`${b.name ?? ''}|${x.ticket}`) ?? 0) + 1);
      out.push(...rows.map((r) => ({ ...r, reverts: reverts.get(`${r.batch ?? ''}|${r.key}`) ?? 0 })));
    } catch { /* a repo that cannot be read adds no rows */ }
  }
  return out;
}

// ---- rolling back ----------------------------------------------------------------------------------------
// The kept release whose commit is `commit` (a full sha, or a prefix of 7 or more), or null.
export function releaseOf(commit, home = E.deskHome()) {
  const want = String(commit ?? '');
  if (want.length < 7) return null;
  return releases(home).find((r) => releaseCommit(r.name, r.info).startsWith(want)) ?? null;
}

// Main's commits from `from` to `to`, newest first, each { sha, subject, merge }: what a revert undoes.
export function mergesBetween(src, from, to) {
  const r = run('git', ['-C', src, 'log', '--first-parent', '--format=%H%x09%P%x09%s', `${from}..${to}`]);
  if (!r.ok) return null;
  return r.out.split('\n').filter(Boolean).map((l) => {
    const [sha, parents, ...subject] = l.split('\t');
    return { sha, subject: subject.join('\t'), merge: parents.trim().split(' ').length > 1 };
  });
}

// One branch off origin/main reverting each of `merges` (newest first), pushed, and a PR opened from it.
// The work runs in a worktree of its own, so the checkout's main is never touched.
//   -> { ok: true, pr, url, branch } | { ok: false, why }
export function openRevertPr({ src, dir, tripped, merges, title, body }) {
  const branch = `revert/desk-release-${short(tripped)}`;
  const wt = join(dir, `revert-${short(tripped)}`);
  const git = (...a) => run('git', ['-C', src, ...a]);
  const inWt = (...a) => run('git', ['-C', wt, ...a]);
  const fetched = git('fetch', '-q', 'origin', 'main');
  if (!fetched.ok) return { ok: false, why: `git fetch failed in ${src}: ${lastLine(fetched.err)}` };
  rmSync(wt, { recursive: true, force: true });
  git('worktree', 'prune');
  const add = git('worktree', 'add', '-q', '-B', branch, wt, 'refs/remotes/origin/main');
  if (!add.ok) return { ok: false, why: `could not make a worktree for ${branch}: ${lastLine(add.err)}` };
  try {
    for (const m of merges) {
      const r = inWt('revert', '--no-edit', ...(m.merge ? ['-m', '1'] : []), m.sha);
      if (!r.ok) { inWt('revert', '--abort'); return { ok: false, why: `${short(m.sha)} does not revert cleanly on origin/main: ${lastLine(r.err || r.out)}` }; }
    }
    const push = inWt('push', '-q', '-u', 'origin', branch);
    if (!push.ok) return { ok: false, why: `git push of ${branch} failed: ${lastLine(push.err)}` };
    const made = run('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body], { cwd: wt });
    const url = /https:\/\/\S+\/pull\/\d+/.exec(made.out)?.[0];
    if (!made.ok || !url) return { ok: false, why: `${branch} was pushed, but gh pr create failed (${lastLine(made.err || made.out)})` };
    return { ok: true, pr: Number(url.split('/').pop()), url, branch };
  } finally {
    git('worktree', 'remove', '--force', wt);
  }
}

// The needs-you state folder for the desk-skills repo the checkout `src` is a clone of, else `fallback`:
// by default the standing batch's of the repo this runs in, or null outside one.
const ownState = () => { try { return E.batchPaths(E.repoSlug()).state; } catch { return null; } };
export function fyiState(src, fallback = ownState()) {
  const ownerRepo = E.ownerRepoFromUrl(run('git', ['-C', src, 'config', '--get', 'remote.origin.url']).out);
  return ownerRepo ? E.batchPaths(E.slugOf(ownerRepo)).state : fallback;
}

// Rolls back release `tripped` to `previous`: pins the previous release where install.sh kept it, opens one
// revert PR for every merge between them, and raises one needs-you item. `metric` and `evidence` say why.
// The pin is kept in the watch state. -> { lines, pinned, pr }
export function rollBack({ dir, src, tripped, previous, metric, evidence, home = E.deskHome(), restart = restartRunning, state = fyiState(src), now = Date.now() }) {
  const lines = [];
  const merges = mergesBetween(src, previous, tripped);
  const named = merges?.length ? merges.map((m) => `${short(m.sha)} ${m.subject}`).join('; ') : `the merges between ${short(previous)} and ${short(tripped)} (not read from ${src})`;

  // The pin: the kept release made current, and every merge driver and supervisor moved onto it.
  let pinned = null;
  const rel = releaseOf(previous, home);
  if (!rel) lines.push(`release watch: the previous release ${short(previous)} is not among the releases install.sh keeps, so it could not be pinned`);
  else {
    try {
      if (currentRelease(home) !== rel.name) {
        makeLive(rel, home);
        for (const l of restart()) lines.push(`release watch: ${l}`);
      }
      pinned = releaseCommit(rel.name, rel.info);
      lines.push(`release watch: pinned the previous release ${short(pinned)} (${rel.name})`);
    } catch (e) { lines.push(`release watch: could not pin ${rel.name}: ${e.message}`); }
  }

  const title = `revert: roll back desk release ${short(tripped)}`;
  const body = [`The release watch rolled back desk release ${short(tripped)} to ${short(previous)}.`, '',
    `Metric: ${metric}`, `Evidence: ${evidence}`, '', 'Reverts every merge between the two releases:', ...(merges ?? []).map((m) => `- ${short(m.sha)} ${m.subject}`), '',
    'Merge this to bring main back to the previous release; close it unmerged to keep the release, which lifts the pin.'].join('\n');
  const pr = merges?.length ? openRevertPr({ src, dir, tripped, merges, title, body }) : { ok: false, why: merges ? 'there is no merge between them to revert' : `git log ${short(previous)}..${short(tripped)} failed in ${src}` };
  lines.push(pr.ok ? `release watch: opened revert PR #${pr.pr} (${pr.url})` : `release watch: no revert PR opened: ${pr.why}`);

  const s = readWatch(dir);
  // A revert PR an earlier rollback of the same release opened is still the one the pin waits for.
  const earlier = s.pinned?.tripped === tripped ? s.pinned.pr ?? null : null;
  if (pinned) s.pinned = { commit: pinned, tripped, pr: pr.ok ? pr.pr : earlier, at: new Date(now).toISOString() };
  writeWatch(dir, s);
  holdOpen(dir, now, home);

  const text = `desk release ${short(tripped)} rolled back on ${metric}: ${evidence}. `
    + `${pinned ? `The previous release ${short(pinned)} is pinned` : `The previous release ${short(previous)} could not be pinned`}; `
    + `${pr.ok ? `revert PR #${pr.pr} reverts` : `no revert PR was opened (${pr.why}) for`} ${named}. `
    + (pr.ok ? 'Merge it to keep the rollback, or close it unmerged to keep the release.' : `Revert those merges by hand${pinned ? ', then run desk-q rollback --unpin' : ''}.`);
  if (state) {
    try { addAsk(state, text, now); lines.push(`release watch: raised a needs-you item: ${text}`); }
    catch (e) { lines.push(`release watch: could not raise the needs-you item (${e.message}): ${text}`); }
  } else lines.push(`release watch: no repo to raise the needs-you item in: ${text}`);
  return { lines, pinned, pr: pr.ok ? pr.pr : null };
}

// ---- the pass's step -----------------------------------------------------------------------------------
// Judges each recorded release whose window has closed, once, and rolls back the first that trips. The
// rows are read at most every CHECK_EVERY_MS, and not at all while a pin holds. -> { lines }
export function watchRelease({ dir, src, at = new Date(), rowsFor = machineRows, home = E.deskHome(), ...rest }) {
  const now = +at;
  if (!src || !existsSync(src)) return { lines: [] };
  const s0 = readWatch(dir);
  const open = readReleases(dir).filter((r) => !s0.judged?.[r.to] && now - Date.parse(r.at) < STALE_MS);
  if (!open.length || s0.pinned) return { lines: [] };
  if (now - Date.parse(s0.checked_at ?? '') < CHECK_EVERY_MS) return { lines: [] };
  const lock = takeReleaseLock(dir);
  if (!lock.ok) return { lines: [] };
  try {
    const s = readWatch(dir);
    s.checked_at = new Date(now).toISOString();
    s.judged ??= {};
    writeWatch(dir, s);
    const since = now - LOOKBACK_MS;
    const rows = rowsFor({ since, now });
    const lines = [];
    for (const rel of open.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      if (!windowOf(rel, rows, now).closed) continue;
      const c = compare(rel, rows);
      const verdict = c.trips.length ? 'tripped' : 'clean';
      s.judged[rel.to] = { at: new Date(now).toISOString(), from: rel.from, verdict, now: c.now, before: c.before, trips: c.trips, ...(c.note ? { note: c.note } : {}) };
      writeWatch(dir, s);
      lines.push(`release watch: desk ${short(rel.from)} -> ${short(rel.to)} ${verdict}: ${label(c.now)}; before it ${label(c.before)}${c.note ? `; ${c.note}` : ''}`);
      if (!c.trips.length) continue;
      // A release recorded after the tripped one carries its merges: the rollback covers it.
      for (const later of open.filter((r) => Date.parse(r.at) > Date.parse(rel.at))) {
        s.judged[later.to] = { at: new Date(now).toISOString(), from: later.from, verdict: 'superseded', note: `rolled back with ${short(rel.to)}` };
      }
      writeWatch(dir, s);
      const t = c.trips[0];
      const evidence = c.trips.map((x) => x.why).join('; ');
      lines.push(...rollBack({ dir, src, tripped: rel.to, previous: rel.from, metric: t.metric, evidence: `${evidence} (${label(c.now)}, against ${label(c.before)})`, now, home, ...rest }).lines);
      break;
    }
    holdOpen(dir, now, home);
    return { lines };
  } finally { lock.release(); }
}

// Whether the pin holds the auto-release's install of `to`: a reason, or null. The pin lifts once main
// carries the revert PR's merge (and `to` has it), or the PR was closed unmerged.
export function pinBlocks({ dir, src, to }) {
  const s = readWatch(dir);
  const p = s.pinned;
  if (!p) return null;
  const held = `desk is pinned to ${short(p.commit)} after release ${short(p.tripped)} was rolled back`;
  if (!p.pr) return `${held}, with no revert PR to wait for: run desk-q rollback --unpin once the release is fixed`;
  const v = run('gh', ['pr', 'view', String(p.pr), '--json', 'state,mergeCommit'], { cwd: src });
  let pr = null;
  try { pr = JSON.parse(v.out); } catch { /* read below */ }
  if (!v.ok || !pr?.state) return `${held}; revert PR #${p.pr} could not be read (${lastLine(v.err)})`;
  const lift = () => { delete s.pinned; writeWatch(dir, s); return null; };
  if (pr.state === 'CLOSED') return lift();
  if (pr.state !== 'MERGED') return `${held}, until revert PR #${p.pr} merges or is closed`;
  const sha = pr.mergeCommit?.oid;
  if (sha && run('git', ['-C', src, 'merge-base', '--is-ancestor', sha, to]).ok) return lift();
  return `${held}; revert PR #${p.pr} merged, and ${short(to)} does not carry it yet`;
}

// `desk-q rollback <commit>`: rolls back the release installed at `commit` to the release before it, as
// a trip does. `--unpin` lifts a pin. -> { code, text }
export function manualRollback(argv, { dir, src, home = E.deskHome(), now = Date.now(), ...rest }) {
  const [arg] = argv.filter((a) => a !== '--plain');
  const usage = 'usage: desk-q rollback <commit> | desk-q rollback --unpin';
  if (!arg) return { code: 2, text: usage };
  if (arg === '--unpin') {
    const s = readWatch(dir);
    if (!s.pinned) return { code: 0, text: 'nothing to unpin: no release is pinned' };
    const was = s.pinned;
    delete s.pinned;
    writeWatch(dir, s);
    return { code: 0, text: `unpinned ${short(was.commit)}: the auto-release installs main again once its check passes` };
  }
  // A commit is named by 7 or more hex digits, so a typo never matches some other release.
  if (!/^[0-9a-f]{7,40}$/i.test(arg)) return { code: 2, text: `${usage}  (<commit>: 7 to 40 hex digits)` };
  const want = arg.toLowerCase();
  if (!src || !existsSync(src)) return { code: 1, text: `nothing rolled back: no desk-skills checkout (${src ?? `${join(home, 'source-checkout')} names none`})` };
  const lock = takeReleaseLock(dir);
  if (!lock.ok) return { code: 1, text: `nothing rolled back: a pass is checking or installing desk-skills (${lock.why ?? `pid ${lock.holder ?? '?'}`}); run it again in a minute` };
  try {
    const list = releases(home);
    const rel = releaseOf(want, home);
    const recorded = readReleases(dir).filter((r) => r.to.startsWith(want)).at(-1);
    const tripped = recorded?.to ?? (rel ? releaseCommit(rel.name, rel.info) : null);
    const before = rel ? list[list.findIndex((r) => r.name === rel.name) - 1] : null;
    const previous = recorded?.from ?? (before ? releaseCommit(before.name, before.info) : null);
    if (!tripped || !previous) {
      const kept = list.map((r) => short(releaseCommit(r.name, r.info))).join(', ') || 'none';
      return { code: 1, text: `nothing rolled back: ${arg} is not a release with one before it (releases kept: ${kept})` };
    }
    const s = readWatch(dir);
    if (s.pinned?.tripped === tripped) {
      return { code: 1, text: `nothing rolled back: release ${short(tripped)} is already rolled back, with ${short(s.pinned.commit)} pinned${s.pinned.pr ? ` until revert PR #${s.pinned.pr} merges or is closed` : ''}` };
    }
    s.judged = { ...(s.judged ?? {}), [tripped]: { at: new Date(now).toISOString(), from: previous, verdict: 'rolled back by hand' } };
    writeWatch(dir, s);
    const r = rollBack({ dir, src, tripped, previous, metric: 'asked by hand', evidence: `desk-q rollback ${arg}`, home, now, ...rest });
    return { code: r.pinned || r.pr ? 0 : 1, text: r.lines.join('\n') };
  } finally { lock.release(); }
}
