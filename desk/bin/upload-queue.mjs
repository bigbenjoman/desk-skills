// The machine's one screenshot upload queue, shared by every repo's pass: <DESK_HOME>/upload-queue.json.
//
// A pass never runs upload-images.mjs itself. It adds the ticket's upload as a job, then pumps the
// queue: under one run lock, so no two passes drive the signed-in browser profile at once, it runs
// jobs one after the other, from whichever repo was served longest ago, each capped (--max) at what
// UPLOAD_PACE leaves of this minute's and this hour's uploads in the machine's upload log. A job whose
// upload stalls (the uploader's exit 7) sets one back-off that stops every repo's uploads until it
// ends, and its result carries the back-off's end (`until`), so its pass retries it no sooner. A job
// left part done by the cap (exit 8) keeps its place; any other end is a result, which the pass of
// the queue that added it takes and records on its ticket. A job belongs to its ticket's
// round (`round`, the ticket's upload_round when it was added): a spawn of the ticket's next round
// waits while an upload of it is running, or else drops it, in one step (claimForSpawn), a pump starts
// only a job still queued, and the pass records only results of the ticket's current round.
//
//   { jobs:    [{ queue, repo, root, key, round, pr, dir, approved, at }]   queue: that batch's queue.json
//     results: [{ ...job, code, out, until?, done_at }]   until: on a stall, when its back-off ends
//     served:  { [repo]: <when its last job started> }
//     backoff: { at, stalls, until, repo, pr } | null
//     running: { id, pr, pid, at } | null     the job an upload is running now (inFlight)
//     signin:  { at, why, mtime } | null }    GitHub refused the saved login (the uploader's exit 6),
//                                             until the session file is written again (signedIn)
//
// While the browser profile's saved GitHub login is not signed in (signedIn), no job runs, from any
// repo: every job keeps its place and spends no try, and one health item asks for the sign-in.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { alive, lock, tryLock, unlock, writeJsonAtomic } from './dir-lock.mjs';
import { browserProfile, deskHome } from './desk-env.mjs';
import { loginState } from './find-playwright.mjs';
import { UPLOAD_PACE } from './desk-design.mjs';
import { readUploadLog, uploadsBefore } from './upload-log.mjs';
import { EXIT_PACED, EXIT_THROTTLED, throttleMs } from './upload-batches.mjs';

export const uploadQueueFile = () => join(deskHome(), 'upload-queue.json');
export const EXIT_BUSY = 2;
export const EXIT_SIGNIN = 6;
const iso = (ms) => new Date(ms).toISOString();
export const jobId = (j) => `${j.queue}#${j.key}`;

export function readUploadQueue(file = uploadQueueFile()) {
  let q = null;
  try { q = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  return { jobs: Array.isArray(q?.jobs) ? q.jobs : [], results: Array.isArray(q?.results) ? q.results : [], served: q?.served ?? {}, backoff: q?.backoff ?? null, running: q?.running ?? null, signin: q?.signin ?? null };
}

export const SIGNIN_CMD = 'node ~/.claude/desk/bin/github-signin.mjs';
const mtimeOf = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
// The uploader's exit 6 when GitHub turned the saved login away, as against playwright or config missing.
const REFUSED = /GitHub no longer accepts|saved GitHub login.* expired|no saved GitHub login/;
// Whether the browser profile's saved GitHub login can upload: { ok, file, why }. Not while it is
// missing or past its expiry, nor while GitHub refused it (the queue's `signin`) and the session file
// has not been written since.
export function signedIn({ profile = browserProfile(), file = uploadQueueFile(), now = Date.now() } = {}) {
  const s = loginState(profile, now);
  if (s.status !== 'ok') return { ok: false, file: s.file, why: s.status === 'expired' ? `the GitHub login in ${s.file} expired at ${s.expiredAt}` : `no GitHub login in ${s.file}` };
  const r = readUploadQueue(file).signin;
  if (r && mtimeOf(s.file) <= r.mtime) return { ok: false, file: s.file, why: `GitHub turned away the saved login in ${s.file} at ${r.at}` };
  return { ok: true, file: s.file };
}
const signinWhy = (s) => `${s.why}, so no repo's screenshot upload runs until it is signed in: ${SIGNIN_CMD}`;
// fn(queue) changes the queue under its file lock, and the queue is saved after if it changed (so a
// pass with nothing to upload writes nothing); returns fn's result.
export function withQueue(file, fn, { waitMs = 10_000 } = {}) {
  const dir = `${file}.lock`;
  lock(dir, { waitMs, timeout: (pid) => new Error(`the upload queue ${file} is locked by pid ${pid ?? '?'} past the ${waitMs / 1000}s wait`) });
  try {
    const q = readUploadQueue(file);
    const was = JSON.stringify(q);
    const out = fn(q);
    if (JSON.stringify(q) !== was) writeJsonAtomic(file, q);
    return out;
  } finally { unlock(dir); }
}

// Adds a ticket's upload, or moves its job to a new PR or directory; one job per ticket per queue.
export function enqueue(job, { file = uploadQueueFile(), now = Date.now } = {}) {
  return withQueue(file, (q) => {
    const at = q.jobs.findIndex((j) => jobId(j) === jobId(job));
    if (at < 0) q.jobs.push({ ...job, at: iso(now()) });
    else q.jobs[at] = { ...q.jobs[at], ...job, at: String(q.jobs[at].pr) === String(job.pr) ? q.jobs[at].at : iso(now()) };
    return q.jobs.length;
  });
}
export const isQueued = (q, queue, key) => q.jobs.some((j) => j.queue === queue && j.key === key);
// The job of `queue`'s ticket `key` an upload is running now, or null; a pump that has exited is not running it.
export const inFlight = (q, queue, key) => (q.running && q.running.id === jobId({ queue, key }) && alive(q.running.pid) ? q.running : null);
// As `queue`'s ticket `key` is about to spawn its next round, in one step under the queue's lock: the
// running upload of its last round's job, which the spawn waits for, or else null with that job
// dropped (the new round adds its own), so no pump can start it beside the new worker (a pump starts
// only a job still queued).
export function claimForSpawn(queue, key, { file = uploadQueueFile() } = {}) {
  return withQueue(file, (q) => {
    const up = inFlight(q, queue, key);
    if (up) return up;
    q.jobs = q.jobs.filter((j) => !(j.queue === queue && j.key === key));
    return null;
  });
}

// How many images may go now: what UPLOAD_PACE leaves of the minute and the hour before `at`.
export function pace(entries, at) {
  const { uploads_last_minute: minute, uploads_last_hour: hour } = uploadsBefore(entries, at);
  const allow = Math.max(0, Math.min(UPLOAD_PACE.perMinute - minute, UPLOAD_PACE.perHour - hour));
  return { allow, minute, hour,
    why: `this machine has uploaded ${minute} image(s) in the last minute and ${hour} in the last hour, against a pace of ${UPLOAD_PACE.perMinute} a minute and ${UPLOAD_PACE.perHour} an hour` };
}

// The job to run next: from the repo whose last job started longest ago (a repo never served first),
// then the oldest. `skip` holds the ids already run this pump.
export function pickJob(q, skip = new Set()) {
  const served = (j) => q.served?.[j.repo] ?? '';
  return q.jobs.filter((j) => !skip.has(jobId(j)))
    .sort((a, b) => (served(a) < served(b) ? -1 : served(a) > served(b) ? 1 : String(a.at) < String(b.at) ? -1 : String(a.at) > String(b.at) ? 1 : 0))[0] ?? null;
}

// The back-off after an exit 7. A stall (a batch that filled nothing) is one more in a row, doubling
// the wait as the uploader's own does; a run refused for its folder's earlier stall only waits it out.
// Either way the back-off ends no sooner than the time the uploader named.
export function backoffAfter(prev, out, end, job) {
  const named = Date.parse(/nothing is uploaded before (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(out ?? '')?.[1] ?? '');
  const stalled = /throttled: batch \d+ filled no image/.test(out ?? '');
  const stalls = (prev?.stalls ?? 0) + (stalled ? 1 : 0);
  const until = Math.max(stalled || !Number.isFinite(named) ? end + throttleMs(Math.max(1, stalls)) : 0, Number.isFinite(named) ? named : 0);
  return { at: iso(end), stalls, until: iso(until), repo: job.repo, pr: job.pr };
}
export const backoffWhy = (b) => `an upload for ${b.repo} #${b.pr} stalled at ${b.at}, which is GitHub's rate limit, so no repo's upload runs before ${b.until}`;

// Runs the queue's jobs until it is empty, the pace is spent, an upload stalls, the profile is in
// use or its login is not signed in, each job at most once (`tried` holds the ids already run, across
// one pass's pumps). run(job, max) runs the uploader and returns { code, out }; login() is signedIn.
// -> { ran: [{ job, code }], stop: why it stopped short, or null }.
export function pump({ run, file = uploadQueueFile(), now = Date.now, uploadLog = () => readUploadLog(), tried = new Set(), login = () => signedIn({ file, now: now() }) }) {
  const runLock = `${file}.run`;
  const holder = tryLock(runLock);
  if (holder !== true) return { ran: [], stop: `another pass is uploading from the machine's upload queue (pid ${holder ?? '?'})` };
  const ran = [];
  let stop = null;
  try {
    for (;;) {
      const t = now();
      const q = readUploadQueue(file);
      if (Date.parse(q.backoff?.until ?? '') > t) { stop = backoffWhy(q.backoff); break; }
      if (!pickJob(q, tried)) break;
      let s;
      try { s = login(); } catch (e) { s = { ok: false, why: `the browser profile's GitHub login could not be read (${e.message})` }; }
      if (!s.ok) { stop = signinWhy(s); break; }
      if (q.signin) withQueue(file, (w) => { w.signin = null; });
      const job = pickJob(q, tried);
      if (!job) break;
      const p = pace(uploadLog(), new Date(t));
      if (p.allow <= 0) { stop = `the upload pace is spent: ${p.why}`; break; }
      tried.add(jobId(job));
      // Started only if it is still queued as picked: a spawn of its ticket's next round may have
      // dropped it (claimForSpawn) since the queue was read.
      const started = withQueue(file, (w) => {
        if (!w.jobs.some((j) => jobId(j) === jobId(job) && String(j.pr) === String(job.pr) && j.dir === job.dir)) return false;
        w.served[job.repo] = iso(t); w.running = { id: jobId(job), pr: job.pr, pid: process.pid, at: iso(t) };
        return true;
      });
      if (!started) continue;
      let r;
      try { r = run(job, p.allow); } finally { withQueue(file, (w) => { w.running = null; }); }
      ran.push({ job, code: r.code });
      const end = now();
      // GitHub turning the login away keeps the job queued, as the cap does, and stops every repo's
      // uploads till the session file is written again.
      const refused = r.code === EXIT_SIGNIN && REFUSED.test(r.out ?? '');
      stop = withQueue(file, (w) => {
        if (r.code === EXIT_THROTTLED) w.backoff = backoffAfter(w.backoff, r.out, end, job);
        if ([0, 4, EXIT_PACED].includes(r.code)) w.backoff = null;
        if (r.code === EXIT_PACED) return null;
        if (refused) {
          w.signin = { at: iso(end), why: String(r.out).trim().split('\n').at(-1) ?? '', mtime: mtimeOf(s.file) };
          return signinWhy({ why: `GitHub turned away the saved login in ${s.file} at ${iso(end)}` });
        }
        const i = w.jobs.findIndex((j) => jobId(j) === jobId(job) && String(j.pr) === String(job.pr) && j.dir === job.dir);
        if (i >= 0) w.jobs.splice(i, 1);
        w.results.push({ ...job, code: r.code, out: r.out, ...(r.code === EXIT_THROTTLED ? { until: w.backoff.until } : {}), done_at: iso(end) });
        if (r.code === EXIT_THROTTLED) return backoffWhy(w.backoff);
        return r.code === EXIT_BUSY ? 'the shared browser profile is in use' : null;
      });
      if (stop) break;
    }
  } finally { unlock(runLock); }
  return { ran, stop };
}

// Takes the results of the jobs `queue` (a batch's queue.json) added, oldest first. A result no pass
// has taken in a week is a batch that has gone, and is dropped.
export const RESULT_KEEP_MS = 7 * 24 * 60 * 60_000;
export function takeResults(queue, { file = uploadQueueFile(), now = Date.now } = {}) {
  return withQueue(file, (q) => {
    const mine = q.results.filter((r) => r.queue === queue);
    q.results = q.results.filter((r) => r.queue !== queue && !(now() - Date.parse(r.done_at) > RESULT_KEEP_MS));
    return mine;
  });
}
