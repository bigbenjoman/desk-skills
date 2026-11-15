// suite: upload queue (one machine-wide queue: order, the minute and hour pace, repo rotation, shared back-off)
// upload-queue.mjs with a fake uploader and a fake clock: nothing here opens a browser or calls GitHub.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueue, pump, takeResults, readUploadQueue, isQueued, pace, backoffAfter } from '../desk/bin/upload-queue.mjs';
import { uploadsBefore } from '../desk/bin/upload-log.mjs';
import { UPLOAD_PACE } from '../desk/bin/desk-design.mjs';
import { EXIT_PACED, EXIT_THROTTLED, THROTTLE_MS } from '../desk/bin/upload-batches.mjs';

let fails = 0;
const t = (name, got, want) => {
  const g = typeof got === 'string' ? got : JSON.stringify(got); const w = typeof want === 'string' ? want : JSON.stringify(want);
  const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`);
};
const ROOT = mkdtempSync(join(tmpdir(), 'upload-queue-'));
let n = 0;
const START = Date.parse('2026-11-15T10:00:00Z');

// A machine: its queue file, a clock, the upload log, and an uploader that sends `left[dir]` images at
// 5s each, up to the cap it is given, logging each as upload-images.mjs does.
function machine({ step = 5000 } = {}) {
  const m = { file: join(ROOT, `q-${n++}.json`), clock: START, log: [], left: {}, calls: [], code: {} };
  m.now = () => m.clock;
  m.run = (job, max) => {
    m.calls.push({ repo: job.repo, key: job.key, max });
    if (m.code[job.key]) return m.code[job.key](job);
    const k = Math.min(max, m.left[job.dir] ?? 0);
    for (let i = 0; i < k; i++) { m.clock += step; m.log.push({ at: new Date(m.clock).toISOString(), result: 'uploaded' }); }
    m.left[job.dir] -= k;
    return m.left[job.dir] > 0 ? { code: EXIT_PACED, out: 'paced' } : { code: 0, out: '[upload] done: 1 image(s) in the body, 0 placeholder(s) left' };
  };
  m.add = (repo, key, images, extra = {}) => {
    const dir = `/shots/${repo}/${key}/`;
    m.left[dir] = images;
    enqueue({ queue: `/q/${repo}.json`, repo, root: `/repos/${repo}`, key, pr: 1, dir, approved: false, ...extra }, { file: m.file, now: m.now });
  };
  m.pump = (opts = {}) => pump({ run: m.run, file: m.file, now: m.now, uploadLog: () => m.log, ...opts });
  return m;
}

// ---- AC1: two repos' uploads run one after the other, and a second pass never runs beside them ----
{
  const m = machine();
  m.add('acme/a', 'A-1', 2); m.add('acme/b', 'B-1', 2);
  let inner = null;
  m.code['A-1'] = (job) => { inner = pump({ run: m.run, file: m.file, now: m.now, uploadLog: () => m.log }); delete m.code['A-1']; return m.run(job, 6); };
  const r = m.pump();
  t('AC1 both repos\' uploads run in one pass, one after the other', r.ran.map((x) => `${x.job.repo} ${x.code}`), ['acme/a 0', 'acme/b 0']);
  t('AC1 a pass that comes while one is uploading runs nothing', inner.ran.length, 0);
  t('AC1 and says another pass holds the queue, not that the profile is in use', /another pass is uploading from the machine's upload queue \(pid \d+\)/.test(inner.stop), true);
  t('AC1 each finished job is a result for the queue that added it', takeResults('/q/acme/a.json', { file: m.file }).map((x) => `${x.key} ${x.code}`), ['A-1 0']);
  t('AC1 a queue takes only its own results', readUploadQueue(m.file).results.map((x) => x.key), ['B-1']);
  t('AC1 a finished job leaves the queue', readUploadQueue(m.file).jobs.length, 0);
  t('AC1 the run lock is released', m.pump().stop, null);
}

// ---- AC2: 400 images across three repos, a pass every 30s for two hours ---------------------------
// Each upload takes no time, so the minute's pace alone would let 360 through in the hour.
{
  const m = machine({ step: 0 });
  const per = { 'acme/a': [60, 60, 30], 'acme/b': [80, 50], 'acme/c': [40, 40, 40] };
  for (const [repo, sizes] of Object.entries(per)) sizes.forEach((s, i) => m.add(repo, `${repo.slice(-1)}-${i}`, s));
  for (let p = 0; p < 240; p++) { m.clock = START + p * 30_000; m.pump(); }
  const times = m.log.map((e) => Date.parse(e.at));
  const firstHour = times.filter((x) => x - times[0] < 3_600_000).length;
  const worstMinute = Math.max(...times.map((x) => times.filter((y) => y >= x && y - x < 60_000).length));
  const worstHour = Math.max(...times.map((x) => times.filter((y) => y >= x && y - x < 3_600_000).length));
  t('AC2 no more than 300 are uploaded in the first hour, though the minute\'s pace would allow 360', firstHour, UPLOAD_PACE.perHour);
  t('AC2 no minute has more than 6', worstMinute <= UPLOAD_PACE.perMinute, true);
  t('AC2 no hour, wherever it starts, has more than 300', worstHour <= UPLOAD_PACE.perHour, true);
  t('AC2 every image is uploaded in the end', m.log.length, 400);
  t('AC2 no call is given a cap over the minute\'s 6', Math.max(...m.calls.map((c) => c.max)), UPLOAD_PACE.perMinute);
  t('pace reads what the log leaves of the minute and the hour', pace(m.log, new Date(Date.parse(m.log[5].at) + 1)).allow, 0);
}

// ---- AC3: each repo gets a batch before any repo gets a second -----------------------------------
{
  const m = machine();
  for (const repo of ['acme/a', 'acme/b', 'acme/c']) for (const k of [1, 2]) m.add(repo, `${repo.slice(-1)}-${k}`, 6);
  m.add('acme/a', 'a-3', 6);
  for (let p = 0; p < 7; p++) { m.clock = START + p * 120_000; m.pump(); }
  t('AC3 consecutive passes take the repos in turn, each job a pass at the pace', m.calls.map((c) => c.key), ['a-1', 'b-1', 'c-1', 'a-2', 'b-2', 'c-2', 'a-3']);
  const m2 = machine();
  m2.add('acme/a', 'a-1', 1); m2.add('acme/a', 'a-2', 1); m2.add('acme/b', 'b-1', 1);
  m2.pump();
  t('AC3 within one pass too, a repo waiting goes before a second batch of one just served', m2.calls.map((c) => c.key), ['a-1', 'b-1', 'a-2']);
  const m3 = machine();
  m3.add('acme/a', 'a-1', 20); m3.add('acme/b', 'b-1', 20);
  for (let p = 0; p < 4; p++) { m3.clock = START + p * 120_000; m3.pump(); }
  t('AC3 a job the pace cut short keeps its place and its repo waits its turn', m3.calls.map((c) => c.key), ['a-1', 'b-1', 'a-1', 'b-1']);
}

// ---- AC4: a stall backs every repo off together ---------------------------------------------------
{
  const m = machine();
  m.add('acme/a', 'a-1', 6); m.add('acme/b', 'b-1', 6); m.add('acme/c', 'c-1', 6);
  const named = new Date(START + 15 * 60_000).toISOString();
  m.code['a-1'] = () => ({ code: EXIT_THROTTLED, out: `[upload] throttled: batch 1 filled no image for 180s (still waiting on x.png), which is GitHub's rate limit, so it stopped without retrying\n[upload] 0 image(s) uploaded this run are in /t.tags.json and their cells are filled; nothing is uploaded before ${named}` });
  const r = m.pump();
  t('AC4 a stall stops the pass there: no other repo is tried', m.calls.map((c) => c.key), ['a-1']);
  t('AC4 the back-off is the machine\'s, recorded in the queue', readUploadQueue(m.file).backoff.stalls, 1);
  t('AC4 the pass says why it stopped', r.stop.startsWith('an upload for acme/a #1 stalled at'), true);
  t('AC4 the stalled job keeps its place, with no result', `${isQueued(readUploadQueue(m.file), '/q/acme/a.json', 'a-1')} ${readUploadQueue(m.file).results.length}`, 'true 0');
  delete m.code['a-1'];
  m.clock = START + 10 * 60_000;
  const inside = m.pump();
  t('AC4 a pass inside the back-off attempts no repo\'s upload', `${m.calls.length} ${inside.ran.length}`, '1 0');
  t('AC4 and names when it ends', inside.stop.endsWith(`so no repo's upload runs before ${named}`), true);
  m.clock = START + 16 * 60_000;
  m.pump();
  t('AC4 once it ends, the queue goes on with the repo after the one that stalled', m.calls.slice(1).map((c) => c.key), ['b-1']);
  t('AC4 an upload that goes through clears the back-off', readUploadQueue(m.file).backoff, null);
  const b1 = backoffAfter(null, 'throttled: batch 1 filled no image', START, { repo: 'r', pr: 1 });
  const b2 = backoffAfter(b1, 'throttled: batch 2 filled no image', START, { repo: 'r', pr: 1 });
  t('AC4 stalls in a row double the back-off', `${b1.until} ${b2.until}`, `${new Date(START + THROTTLE_MS).toISOString()} ${new Date(START + 2 * THROTTLE_MS).toISOString()}`);
  const early = backoffAfter(b1, `throttled: GitHub's rate limit stalled an upload at x (1 in a row), so nothing is uploaded before ${named}`, START, { repo: 'r', pr: 1 });
  t('AC4 a run refused for its folder\'s earlier stall waits that out, without counting a stall', `${early.stalls} ${early.until}`, `1 ${named}`);
}

// ---- the profile in use, and the queue itself -----------------------------------------------------
{
  const m = machine();
  m.add('acme/a', 'a-1', 1); m.add('acme/b', 'b-1', 1);
  m.code['a-1'] = () => ({ code: 2, out: '[upload] the shared profile is in use — refusing:' });
  const r = m.pump();
  t('a profile in use (exit 2) stops the pass and is that ticket\'s result', `${m.calls.length} ${r.stop} ${takeResults('/q/acme/a.json', { file: m.file }).map((x) => x.code)}`, '1 the shared browser profile is in use 2');
  m.add('acme/b', 'b-1', 1);
  t('adding a queued ticket again keeps one job', readUploadQueue(m.file).jobs.filter((j) => j.key === 'b-1').length, 1);
  const at = readUploadQueue(m.file).jobs.find((j) => j.key === 'b-1').at;
  m.clock += 60_000;
  m.add('acme/b', 'b-1', 1, { pr: 2 });
  const moved = readUploadQueue(m.file).jobs.find((j) => j.key === 'b-1');
  t('a ticket that moves to a new PR moves its job, taking a new place in line', `${moved.pr} ${moved.at !== at}`, '2 true');
  t('uploadsBefore counts only what the log uploaded', uploadsBefore([{ at: new Date(START).toISOString(), result: 'throttled' }], new Date(START + 1)).uploads_last_minute, 0);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
