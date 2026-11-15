// The machine's one screenshot upload queue, shared by every repo's pass: <DESK_HOME>/upload-queue.json.
//
// A pass never runs upload-images.mjs itself. It adds the ticket's upload as a job, then pumps the
// queue: under one run lock, so no two passes drive the signed-in browser profile at once, it runs
// jobs one after the other, from whichever repo was served longest ago, each capped (--max) at what
// UPLOAD_PACE leaves of this minute's and this hour's uploads in the machine's upload log. A job whose
// upload stalls (the uploader's exit 7) sets one back-off that stops every repo's uploads until it
// ends. A job left part done by the cap (exit 8) keeps its place; any other end is a result, which
// the pass of the queue that added it takes and records on its ticket. A job belongs to its ticket's
// round (`round`, the ticket's upload_round when it was added): a spawn of the ticket's next round
// waits while an upload of it is running (inFlight), then drops it (dropJob), and the pass records only
// results of the ticket's current round.
//
//   { jobs:    [{ queue, repo, root, key, round, pr, dir, approved, at }]   queue: that batch's queue.json
//     results: [{ ...job, code, out, done_at }]
//     served:  { [repo]: <when its last job started> }
//     backoff: { at, stalls, until, repo, pr } | null
//     running: { id, pr, pid, at } | null }   the job an upload is running now (inFlight)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive, lock, tryLock, unlock, writeJsonAtomic } from './dir-lock.mjs';
import { deskHome } from './desk-env.mjs';
import { UPLOAD_PACE } from './desk-design.mjs';
import { readUploadLog, uploadsBefore } from './upload-log.mjs';
import { EXIT_PACED, EXIT_THROTTLED, throttleMs } from './upload-batches.mjs';

export const uploadQueueFile = () => join(deskHome(), 'upload-queue.json');
export const EXIT_BUSY = 2;
const iso = (ms) => new Date(ms).toISOString();
export const jobId = (j) => `${j.queue}#${j.key}`;

export function readUploadQueue(file = uploadQueueFile()) {
  let q = null;
  try { q = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  return { jobs: Array.isArray(q?.jobs) ? q.jobs : [], results: Array.isArray(q?.results) ? q.results : [], served: q?.served ?? {}, backoff: q?.backoff ?? null, running: q?.running ?? null };
}
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
// Drops the job `queue`'s ticket `key` added, as its next round starts: that round adds its own.
export function dropJob(queue, key, { file = uploadQueueFile() } = {}) {
  return withQueue(file, (q) => {
    const before = q.jobs.length;
    q.jobs = q.jobs.filter((j) => !(j.queue === queue && j.key === key));
    return before - q.jobs.length;
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

// Runs the queue's jobs until it is empty, the pace is spent, an upload stalls or the profile is in
// use, each job at most once (`tried` holds the ids already run, across one pass's pumps).
// run(job, max) runs the uploader and returns { code, out }.
// -> { ran: [{ job, code }], stop: why it stopped short, or null }.
export function pump({ run, file = uploadQueueFile(), now = Date.now, uploadLog = () => readUploadLog(), tried = new Set() }) {
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
      const job = pickJob(q, tried);
      if (!job) break;
      const p = pace(uploadLog(), new Date(t));
      if (p.allow <= 0) { stop = `the upload pace is spent: ${p.why}`; break; }
      tried.add(jobId(job));
      withQueue(file, (w) => { w.served[job.repo] = iso(t); w.running = { id: jobId(job), pr: job.pr, pid: process.pid, at: iso(t) }; });
      let r;
      try { r = run(job, p.allow); } finally { withQueue(file, (w) => { w.running = null; }); }
      ran.push({ job, code: r.code });
      const end = now();
      stop = withQueue(file, (w) => {
        if (r.code === EXIT_THROTTLED) { w.backoff = backoffAfter(w.backoff, r.out, end, job); return backoffWhy(w.backoff); }
        if ([0, 4, EXIT_PACED].includes(r.code)) w.backoff = null;
        if (r.code === EXIT_PACED) return null;
        const i = w.jobs.findIndex((j) => jobId(j) === jobId(job) && String(j.pr) === String(job.pr) && j.dir === job.dir);
        if (i >= 0) w.jobs.splice(i, 1);
        w.results.push({ ...job, code: r.code, out: r.out, done_at: iso(end) });
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
