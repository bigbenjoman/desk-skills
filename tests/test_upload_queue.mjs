// suite: upload queue (one machine-wide queue: order, the minute and hour pace, repo rotation, shared back-off)
// upload-queue.mjs with a fake uploader and a fake clock: nothing here opens a browser or calls GitHub.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueue, pump, takeResults, readUploadQueue, isQueued, pace, backoffAfter, claimForSpawn, inFlight, signedIn } from '../desk/bin/upload-queue.mjs';
import { tryLock, unlock } from '../desk/bin/dir-lock.mjs';
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
  m.pump = (opts = {}) => pump({ run: m.run, file: m.file, now: m.now, uploadLog: () => m.log, login: () => ({ ok: true }), ...opts });
  return m;
}

// ---- AC1: two repos' uploads run one after the other, and a second pass never runs beside them ----
{
  const m = machine();
  m.add('acme/a', 'A-1', 2); m.add('acme/b', 'B-1', 2);
  let inner = null;
  m.code['A-1'] = (job) => { inner = pump({ run: m.run, file: m.file, now: m.now, uploadLog: () => m.log, login: () => ({ ok: true }) }); delete m.code['A-1']; return m.run(job, 6); };
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
  const stalled = readUploadQueue(m.file).results.map((x) => `${x.key} ${x.code} ${x.until}`);
  t('AC4 the stalled job leaves the queue as its pass\'s result, naming when the back-off ends', `${isQueued(readUploadQueue(m.file), '/q/acme/a.json', 'a-1')} ${stalled}`, `false a-1 ${EXIT_THROTTLED} ${named}`);
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
  m.add('acme/a', 'a-9', 1, { round: 'r1' });
  t('a ticket\'s next round drops the job its last round added, and only that one', `${claimForSpawn('/q/acme/a.json', 'a-9', { file: m.file })} ${isQueued(readUploadQueue(m.file), '/q/acme/a.json', 'a-9')} ${isQueued(readUploadQueue(m.file), '/q/acme/b.json', 'b-1')}`, 'null false true');
  let during = null; let claimed = null;
  m.add('acme/a', 'a-7', 1);
  m.code['a-7'] = (job) => { during = inFlight(readUploadQueue(m.file), '/q/acme/a.json', 'a-7'); claimed = claimForSpawn('/q/acme/a.json', 'a-7', { file: m.file }); delete m.code['a-7']; return m.run(job, 1); };
  m.clock += 120_000; m.pump();
  t('while a job\'s upload runs, the queue names it running, and no longer once it ends', `${during?.pr} ${inFlight(readUploadQueue(m.file), '/q/acme/a.json', 'a-7')}`, '1 null');
  t('a spawn while its last round\'s upload runs is told it is running, and drops nothing', claimed?.pr, 1);
  // A spawn drops the job after a pump has read the queue and picked it, but before the pump starts it.
  const m2 = machine();
  m2.add('acme/a', 'a-6', 1); m2.add('acme/b', 'b-6', 1);
  let dropped = false;
  m2.pump({ uploadLog: () => { if (!dropped) { dropped = true; claimForSpawn('/q/acme/a.json', 'a-6', { file: m2.file }); } return m2.log; } });
  t('a pump never starts a job a spawn dropped after the pump picked it, and runs the next', `${m2.calls.map((c) => c.key).join(',')} ${takeResults('/q/acme/a.json', { file: m2.file }).length}`, 'b-6 0');
  t('a running job whose pump has exited is not running', inFlight({ running: { id: '/q/acme/a.json#a-7', pr: 1, pid: 999999999 } }, '/q/acme/a.json', 'a-7'), null);
  t('a job carries the round that added it to its result', (() => { m.add('acme/a', 'a-8', 1, { round: 'r2' }); m.clock += 120_000; m.pump(); return takeResults('/q/acme/a.json', { file: m.file }).find((x) => x.key === 'a-8')?.round; })(), 'r2');
}

// ---- DS-675: the saved GitHub login not signed in pauses every repo's uploads ---------------------
{
  const m = machine();
  const profile = join(ROOT, 'profile');
  const session = `${profile}.github-session.json`;
  const save = (expires) => writeFileSync(session, JSON.stringify({ user: 't', cookies: [{ name: 'user_session', domain: 'github.com', expires }] }));
  const login = () => signedIn({ profile, file: m.file, now: m.clock });
  const SIGNIN = 'node ~/.claude/desk/bin/github-signin.mjs';
  m.add('acme/a', 'a-1', 1); m.add('acme/a', 'a-2', 1); m.add('acme/b', 'b-1', 1);
  save(START / 1000 - 60);
  const r = m.pump({ login });
  t('DS-675 AC1 an expired login: no upload is attempted, from any repo', `${m.calls.length} ${r.ran.length}`, '0 0');
  t('DS-675 AC1 every job keeps its place and spends no try', `${readUploadQueue(m.file).jobs.length} ${readUploadQueue(m.file).results.length}`, '3 0');
  t('DS-675 AC1 the pass says why, naming the sign-in command', r.stop, `the GitHub login in ${session} expired at ${new Date(START - 60_000).toISOString()}, so no repo's screenshot upload with that login runs until it is signed in: ${SIGNIN}`);
  writeFileSync(session, '{}');
  t('DS-675 no saved login at all pauses them too', m.pump({ login }).stop, `no GitHub login in ${session}, so no repo's screenshot upload with that login runs until it is signed in: ${SIGNIN}`);
  save(START / 1000 + 86_400);
  m.pump({ login });
  t('DS-675 AC2 signed in again, the next pass resumes the queue', m.calls.map((c) => c.key), ['a-1', 'b-1', 'a-2']);
  // GitHub turns away a login whose saved file still reads unexpired: the uploader's exit 6.
  // acme/b was served longer ago, so its job goes first.
  m.add('acme/a', 'a-3', 1); m.add('acme/b', 'b-2', 1);
  const results = readUploadQueue(m.file).results.length;
  m.code['b-2'] = () => ({ code: 6, out: `[upload] the saved GitHub login has expired: GitHub no longer accepts ${session}.\n[upload] sign in with: ${SIGNIN}` });
  m.clock += 120_000;
  const refused = m.pump({ login });
  t('DS-675 a login GitHub turns away stops the pass, keeps the job and tries no other repo', `${m.calls.slice(3).map((c) => c.key)} ${isQueued(readUploadQueue(m.file), '/q/acme/b.json', 'b-2')} ${readUploadQueue(m.file).results.length - results}`, 'b-2 true 0');
  t('DS-675 and says so, naming the sign-in command', /^GitHub turned away the saved login in .* so no repo's screenshot upload with that login runs until it is signed in: node ~\/\.claude\/desk\/bin\/github-signin\.mjs$/.test(refused.stop), true);
  delete m.code['b-2'];
  m.clock += 120_000;
  t('DS-675 the next pass tries nothing while the session file is unwritten', `${m.pump({ login }).ran.length} ${login().ok}`, '0 false');
  save(START / 1000 + 86_400);
  utimesSync(session, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  m.clock += 120_000;
  m.pump({ login });
  t('DS-675 signed in again (the file written since), the queue resumes and the refusal is cleared', `${m.calls.slice(4).map((c) => c.key).join(',')} ${JSON.stringify(readUploadQueue(m.file).signin)}`, 'a-3,b-2 {}');
  // A repo with its own §2 profile: its login expired holds only the jobs that upload with it.
  const own = join(ROOT, 'own');
  writeFileSync(`${own}.github-session.json`, JSON.stringify({ user: 'o', cookies: [{ name: 'user_session', domain: 'github.com', expires: START / 1000 - 60 }] }));
  m.add('acme/b', 'b-3', 1, { profile: own }); m.add('acme/a', 'a-4', 1);
  m.clock += 120_000;
  const mixed = m.pump({ login: (job) => signedIn({ profile: job.profile ?? profile, file: m.file, now: m.clock }) });
  t('DS-675 another login expired holds only its own jobs', `${m.calls.slice(6).map((c) => c.key).join(',')} ${isQueued(readUploadQueue(m.file), '/q/acme/b.json', 'b-3')}`, 'a-4 true');
  t('DS-675 and the pass names that login', mixed.stop.startsWith(`the GitHub login in ${own}.github-session.json expired`), true);
}

// ---- DS-790: GitHub's PR page changed (exit 7 naming it) pauses every repo's uploads till desk is installed again
{
  const m = machine();
  let installed = '/desk/releases/aaa/bin';
  const install = () => installed;
  const CHANGED = "[upload] GitHub's PR page changed: no comment composer found by role, placeholder or legacy id";
  m.add('acme/a', 'a-1', 1); m.add('acme/b', 'b-1', 1);
  m.code['a-1'] = () => ({ code: EXIT_THROTTLED, out: `[upload] #1 opening the PR\n${CHANGED}` });
  const r = m.pump({ install });
  const q1 = readUploadQueue(m.file);
  t('DS-790 AC1 a page change stops the pass there: no other repo is tried', m.calls.map((c) => c.key), ['a-1']);
  t('DS-790 AC1 the job keeps its place and spends no try: no result, no rate-limit back-off', `${isQueued(q1, '/q/acme/a.json', 'a-1')} ${q1.results.length} ${q1.backoff}`, 'true 0 null');
  t('DS-790 AC1 the queue records the pause for the machine, under the install that found it', `${q1.page?.repo} ${q1.page?.pr} ${q1.page?.install} ${q1.page?.why}`, `acme/a 1 ${installed} ${CHANGED.slice('[upload] '.length)}`);
  t('DS-790 AC1 the pass says the uploader is broken, not rate limited', r.stop.startsWith("desk's screenshot uploader is broken: GitHub's PR page changed"), true);
  delete m.code['a-1'];
  m.clock += 60 * 60_000;
  const still = m.pump({ install });
  t('DS-790 AC1 a later pass under the same install runs no repo\'s upload', `${m.calls.length} ${still.ran.length} ${still.stop === r.stop}`, '1 0 true');
  installed = '/desk/releases/bbb/bin';
  m.code['b-1'] = () => ({ code: EXIT_THROTTLED, out: CHANGED });
  m.clock += 120_000;
  const again = m.pump({ install });
  t('DS-790 AC4 desk installed again but the composer still missing: one try, then paused under the new install', `${m.calls.slice(1).map((c) => c.key)} ${readUploadQueue(m.file).page?.install} ${readUploadQueue(m.file).page?.repo}`, `b-1 ${installed} acme/b`);
  t('DS-790 AC4 and that pass says so', again.stop.startsWith("desk's screenshot uploader is broken: GitHub's PR page changed"), true);
  delete m.code['b-1'];
  installed = '/desk/releases/ccc/bin';
  m.clock += 120_000;
  m.pump({ install });
  const q4 = readUploadQueue(m.file);
  t('DS-790 AC4 installed again and the upload finds the composer: the pause clears and the queue goes on', `${m.calls.slice(2).map((c) => c.key).join(',')} ${q4.page} ${q4.jobs.length}`, 'a-1,b-1 null 0');
  // A rate-limit stall is still exit 7's back-off, and sets no pause.
  m.add('acme/a', 'a-2', 1);
  m.code['a-2'] = () => ({ code: EXIT_THROTTLED, out: '[upload] throttled: batch 1 filled no image for 180s, which is GitHub\'s rate limit' });
  m.clock += 120_000;
  m.pump({ install });
  const q5 = readUploadQueue(m.file);
  t('DS-790 a rate-limit exit 7 still backs off and is its job\'s result, with no pause', `${q5.backoff?.stalls} ${q5.results.at(-1)?.key} ${q5.page}`, '1 a-2 null');
}
// AC5: exit 6 is untouched: GitHub refusing the login still holds the job and sets no page pause.
{
  const m = machine();
  m.add('acme/a', 'a-1', 1);
  m.code['a-1'] = () => ({ code: 6, out: '[upload] the saved GitHub login has expired: GitHub no longer accepts /p.github-session.json.' });
  const r = m.pump({ login: () => ({ ok: true, file: '/p.github-session.json' }), install: () => '/x' });
  const q = readUploadQueue(m.file);
  t('DS-790 AC5 an exit 6 still records the sign-in refusal and keeps the job, with no page pause', `${Object.keys(q.signin)} ${isQueued(q, '/q/acme/a.json', 'a-1')} ${q.page} ${r.stop.startsWith('GitHub turned away the saved login')}`, '/p.github-session.json true null true');
}

// ---- the lock: a dead holder's lock is cleared, a live one's is not --------------------------------
{
  const dir = join(ROOT, 'held.lock');
  mkdirSync(dir); writeFileSync(join(dir, 'pid'), '999999999\n');
  t('a lock whose holder has exited is cleared and taken', tryLock(dir), true);
  unlock(dir);
  mkdirSync(dir); writeFileSync(join(dir, 'pid'), `${process.ppid}\n`);
  t('a lock a live process holds is not taken, and names its holder', tryLock(dir), process.ppid);
  unlock(dir);
  t('and is never released by a process that does not hold it', existsSync(dir), true);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
