// suite: pass phase: the batch base sync and its baseline checks (the decisions, run through the generator runner)
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideBaseSync, decideBaseline } from '../desk/bin/pass/batch-base.mjs';
import { registryView } from '../desk/bin/pass/shared.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const HEAD = 'a'.repeat(40);
const SRC = 'c'.repeat(40);
const WT = '/wt/feat-x';
const PUSH = { perm: 'yes', key: 'batch-base-push', ok: true };
const snap = (queue = {}, fields = {}) => ({
  queue: { tickets: {}, ...queue }, base: 'feat/x', source: 'main', willSpawn: true, epicOpen: false, sliceBad: null,
  behindMax: 20, gateBusy: false, resumeHeld: null, registry: registryView({ live: [] }), fixKey: 'BASE-feat-x', fixRoom: true,
  noFixRoom: 'memory: 2.0G available, under the 6G spawn gate', conflictPerm: 'yes', push: PUSH, passBy: 'session',
  passAt: '2026-11-18T12:00:00.000Z', usageHold: null, repoLogin: { dir: '/login' }, baselineOn: false, dry: false, now: NOW, ...fields,
});

// The runner with stub handlers: each read answers from `answers` (a value, or a function of the
// action), else from what a pass on a current base reads.
const READS = {
  behind: 3, worktree: { ok: true, path: WT, made: false }, sync: { ok: true, merged: 3 }, 'origin-sha': (a) => (a.branch === 'main' ? SRC : HEAD),
  'note-conflict': null, 'fix-log': { raw: Buffer.alloc(0), text: '', recent: false, bytes: 0 }, 'end-try': null, 'fix-login': { dir: '/login' }, lifted: false,
};
const WRITES = ['report', 'base-line', 'set-batch', 'kill', 'usage-hold', 'usage-stop', 'drop-ref', 'fetch', 'synced', 'baseline'];
function drive(decide, s, answers = {}, reads = READS, writes = WRITES) {
  const handlers = Object.fromEntries([...Object.keys(reads), ...writes].map((type) => [type, (a) => {
    const v = Object.hasOwn(answers, type) ? answers[type] : reads[type];
    return typeof v === 'function' ? v(a) : v;
  }]));
  const report = { failed: [] };
  const actions = runSteps({ name: 'batch base', snapshot: () => s, decide, handlers, report });
  if (report.failed.length) { fails++; console.log(`FAIL a handler was missing: ${j(report.failed)}`); }
  return actions;
}
const sync = (s, answers) => drive(decideBaseSync, s, answers);
const types = (as) => as.map((a) => a.type);
const lines = (as, type = 'base-line') => as.filter((a) => a.type === type).map((a) => a.line);
const waiting = (as) => as.filter((a) => a.type === 'report' && a.list === 'waiting').map((a) => a.line);
const state = (as) => as.find((a) => a.type === 'synced')?.state ?? 'no synced action';
const batchWrites = (as) => as.filter((a) => a.type === 'set-batch').flatMap((a) => a.fields);

// AC1: in feature mode, a sync that could not run is named, and holds this pass's spawns.
{
  const as = sync(snap({ feature: true }), { sync: { ok: false, reason: 'push', why: 'the push to feat/x was refused' } });
  t('AC1 a feature batch whose sync could not run gets a line naming the failure', j(waiting(as)),
    j(['base sync: the push to feat/x was refused — feature mode, so nothing spawns this pass']));
  t('AC1 and holds this pass\'s spawns', state(as).baseHold, true);
  t('the failure is what the parks waiting on the base are told', state(as).baseNotSynced, 'the push to feat/x was refused');
  t('feature mode holds even a base that is not behind', state(sync(snap({ feature: true }), { behind: 0, sync: { ok: false, why: 'x' } })).baseHold, true);
  const noWt = sync(snap({ feature: true }), { worktree: { ok: false, why: 'git worktree add failed' } });
  t('a base worktree that could not be made is a sync that could not run', j([waiting(noWt), state(noWt).baseHold, state(noWt).baseWt]),
    j([['base sync: git worktree add failed — feature mode, so nothing spawns this pass'], true, null]));
  t('and it runs no sync', types(noWt).includes('sync'), false);
}

// AC2: outside feature mode, the same sync is named and spawning carries on.
{
  const as = sync(snap(), { sync: { ok: false, reason: 'push', why: 'the push to feat/x was refused' } });
  t('AC2 a batch not in feature mode whose sync could not run gets the line', j(waiting(as)),
    j(['base sync: the push to feat/x was refused — spawning carries on from the base as it stands (feat/x is 3 commit(s) behind main, within the 20 it may lag)']));
  t('AC2 and does not hold spawns', j([state(as).baseHold, state(as).baseLag]), '[false,null]');
  const far = sync(snap(), { behind: 21, sync: { ok: false, why: 'refused' } });
  t('past the lag it may have, it holds them, and says why', j([waiting(far), state(far).baseHold, state(far).baseLag]),
    j([['base sync: refused — feat/x is 21 commit(s) behind main, more than the 20 it may lag and still spawn, so nothing spawns this pass'], true, 'feat/x is 21 commit(s) behind main, more than the 20 it may lag']));
  const unread = sync(snap(), { behind: null, sync: { ok: false, why: 'refused' } });
  t('a lag that could not be read holds nothing, and says it was not read', j([waiting(unread), state(unread).baseHold]),
    j([['base sync: refused — spawning carries on from the base as it stands (how far feat/x is behind main could not be read)'], false]));
}

// DS-808 AC4: a refused push that holds every spawn is recorded for needs-you, and cleared once it does not.
{
  const refused = { ok: false, reason: 'push', why: 'the push to feat/x was refused: ! [remote rejected] feat/x -> feat/x (protected branch hook declined)' };
  const CMD = `git -C ${WT} fetch -q origin && git -C ${WT} merge --no-edit origin/main && git -C ${WT} push origin HEAD:refs/heads/feat/x || git -C ${WT} reset -q --hard origin/feat/x`;
  const stuck = { base: 'feat/x', source: 'main', behind: 61, frozen: 4, why: refused.why, path: WT, cmd: CMD };
  const far = sync(snap({}, { frozen: 4 }), { behind: 61, sync: refused });
  t('DS-808 AC4 past the lag, a refused push records the frozen base for needs-you', j(batchWrites(far)), j([`base_sync_stuck=${JSON.stringify({ since: '2026-11-18T12:00:00.000Z', ...stuck })}`]));
  t('DS-808 a later pass with the same refusal writes nothing', batchWrites(sync(snap({ base_sync_stuck: { since: 'x', ...stuck } }, { frozen: 4 }), { behind: 61, sync: refused })).length, 0);
  t('DS-808 one that changed keeps when it began', JSON.parse(batchWrites(sync(snap({ base_sync_stuck: { since: 'x', ...stuck } }, { frozen: 5 }), { behind: 61, sync: refused }))[0].slice('base_sync_stuck='.length)).since, 'x');
  t('DS-808 within the lag it records nothing', batchWrites(sync(snap({}, { frozen: 4 }), { sync: refused })).length, 0);
  // A sync that could not fetch the base is recorded too, with no push command.
  const noBase = { ok: false, reason: 'error', why: "could not fetch feat/x and main from origin: fatal: couldn't find remote ref refs/heads/feat/x" };
  const lost = { base: 'feat/x', source: 'main', behind: null, frozen: 2, why: noBase.why, path: WT };
  t('DS-965 AC1 a feature batch whose base is gone from origin records it for needs-you', j(batchWrites(sync(snap({ feature: true }, { frozen: 2 }), { behind: null, sync: noBase }))),
    j([`base_sync_stuck=${JSON.stringify({ since: '2026-11-18T12:00:00.000Z', ...lost })}`]));
  t('DS-965 AC1 so does one past the lag', JSON.parse(batchWrites(sync(snap({}, { frozen: 4 }), { behind: 61, sync: noBase }))[0].slice('base_sync_stuck='.length)).why, noBase.why);
  t('DS-965 AC2 the record is cleared once the base syncs', j(batchWrites(sync(snap({ feature: true, base_sync_stuck: { since: 'x', ...lost } })))), j(['base_sync_stuck=null']));
  t('DS-965 AC3 a fetch failure within the lag records nothing', batchWrites(sync(snap({}, { frozen: 4 }), { sync: noBase })).length, 0);
  const unmerged = { ok: false, reason: 'missing', last: HEAD, why: 'feat/x is missing on origin, and its last known head aaaaaaaaaaaa is not in main, so it was not recreated: push that commit back to feat/x on origin, or end the batch' };
  t('DS-965 AC1 a base missing on origin and not merged holds every spawn, so it is recorded with no command',
    j(batchWrites(sync(snap({}, { frozen: 2 }), { behind: null, sync: unmerged }))),
    j([`base_sync_stuck=${JSON.stringify({ since: '2026-11-18T12:00:00.000Z', ...lost, why: unmerged.why })}`]));
  const noWt = { ok: false, path: WT, why: "could not fetch feat/x from origin: fatal: couldn't find remote ref refs/heads/feat/x" };
  t('DS-965 AC1 a base worktree that could not be made, its base gone from origin, is recorded with no command',
    j(batchWrites(sync(snap({ feature: true }, { frozen: 2 }), { behind: null, worktree: noWt }))),
    j([`base_sync_stuck=${JSON.stringify({ since: '2026-11-18T12:00:00.000Z', ...lost, why: noWt.why })}`]));
  t('DS-965 AC3 one within the lag records nothing', batchWrites(sync(snap({}, { frozen: 2 }), { worktree: noWt })).length, 0);
  const notGranted = sync(snap({}, { frozen: 2, push: { perm: 'no', key: 'batch-base-push', ok: false } }), { behind: null, sync: { ok: false, reason: 'permission', merged: 0, recreate: { last: HEAD, at: SRC } } });
  t('DS-965 AC1 a merged-and-deleted base whose push back is not granted is recorded with no command',
    JSON.parse(batchWrites(notGranted)[0].slice('base_sync_stuck='.length)).why,
    'feat/x is missing on origin, and its last known head aaaaaaaaaaaa is in main (merged, then deleted), and config §3 batch-base-push is "no", so it was not recreated at main\'s head cccccccccccc');
  t('DS-965 and one asked for in needs-you as the base-push item is not recorded twice',
    batchWrites(sync(snap({}, { frozen: 2, passBy: 'supervisor', push: { perm: 'ask', key: 'batch-base-push', ok: false } }), { behind: null, sync: { ok: false, reason: 'permission', merged: 0, recreate: { last: HEAD, at: SRC } } })).some((w) => w.startsWith('base_sync_stuck=')), false);
  t('DS-808 the record is cleared once the base syncs', j(batchWrites(sync(snap({ base_sync_stuck: { since: 'x', ...stuck } })))), j(['base_sync_stuck=null']));
  t('DS-808 a dry run writes nothing', batchWrites(sync(snap({}, { frozen: 4, dry: true }), { behind: 61, sync: refused })).length, 0);
  const made = sync(snap(), { worktree: { ok: true, path: WT, made: true, env: { copied: ['.env'], missing: ['apps/web/.env'] } } });
  t('DS-808 AC1 a made base worktree says which env files it was given', lines(made)[0],
    `base worktree for feat/x made at ${WT}; §4 Env files copied in (.env), with every §4 Database URL variable blanked; §4 Env files not copied (apps/web/.env): not in the primary checkout, or not ignored by git`);
  t('DS-808 one made earlier says only what it was given now', lines(sync(snap(), { worktree: { ok: true, path: WT, made: false, env: { copied: ['.env'], missing: ['x'] } } }))[0],
    `base worktree for feat/x at ${WT}: §4 Env files copied in (.env), with every §4 Database URL variable blanked`);
  t('DS-808 and nothing when it lacked none', lines(sync(snap(), { worktree: { ok: true, path: WT, made: false, env: { copied: [], missing: ['x'] } } }))[0], 'base sync: merged 3 commit(s) from main into feat/x and pushed');
}

// When the base syncs, and what a sync that lands says.
{
  const as = sync(snap());
  t('a pass that will spawn syncs: lag, worktree, sync, then what it settled', j(types(as)), j(['behind', 'worktree', 'sync', 'base-line', 'synced']));
  t('a sync that merged says so', lines(as)[0], 'base sync: merged 3 commit(s) from main into feat/x and pushed');
  t('the base worktree is kept for the rest of the pass', state(as).baseWt, WT);
  t('nothing to spawn and a current base syncs nothing', types(sync(snap({}, { willSpawn: false }), { behind: 0 })).includes('sync'), false);
  t('a base behind syncs with nothing to spawn', types(sync(snap({}, { willSpawn: false }))).includes('sync'), true);
  t('so does an open epic PR', types(sync(snap({}, { willSpawn: false, epicOpen: true }), { behind: 0 })).includes('sync'), true);
  const stale = { key: 'T-1', state: 'done', result: { pr: 7 }, pr_status: { pr: 7, state: 'OPEN', behind: { tests: true } } };
  const ci = sync(snap({ tickets: { 'T-1': stale } }, { willSpawn: false }), { behind: 0 });
  t('so does a child PR whose CI waits on the base', types(ci).includes('sync'), true);
  t('and the sync line says it reopens it', lines(ci)[0], 'base sync: merged 3 commit(s) from main into feat/x and pushed; PR #7 is reopened so CI runs');
  t('a made base worktree is said first', lines(sync(snap(), { worktree: { ok: true, path: WT, made: true } }))[0], `base worktree for feat/x made at ${WT}`);
  t('a base already current says so', lines(sync(snap(), { sync: { ok: true, merged: 0 } }))[0], 'base sync: feat/x already has everything on main');
  t('a dry run says what it would merge', lines(sync(snap({}, { dry: true }), { sync: { ok: true, dry: true, merged: 2 } }))[0],
    'base sync (dry run): would merge 2 commit(s) from main into feat/x; nothing pushed');
  const gate = sync(snap({}, { gateBusy: true }));
  t('a running base gate skips the sync, and spawning carries on', j([types(gate).includes('sync'), lines(gate), state(gate).baseHold]),
    j([false, [`base sync: skipped while the base gate runs in ${WT}; spawning carries on from feat/x as it stands`], false]));
  t('an unreadable slice size is said in feature mode only', j([waiting(sync(snap({ feature: true }, { sliceBad: 'slice bad' }))), waiting(sync(snap({}, { sliceBad: 'slice bad' })))]), '[["slice bad"],[]]');
}

// A conflict the sync meets.
{
  const conflict = { ok: false, reason: 'conflict', files: ['src/a.ts'] };
  const as = sync(snap(), { sync: conflict });
  t('its files go on the conflict record, with origin\'s heads read in order', j(as.filter((a) => ['origin-sha', 'note-conflict'].includes(a.type))), j([
    { type: 'origin-sha', branch: 'feat/x' }, { type: 'origin-sha', branch: 'main' },
    { type: 'note-conflict', what: 'the base feat/x', entry: { files: ['src/a.ts'], ticket: 'BASE-feat-x', pr: null, head: HEAD, source: SRC } },
    { type: 'origin-sha', branch: 'feat/x' }, { type: 'origin-sha', branch: 'main' },
  ]));
  t('a fix worker takes it this pass', j(state(as).baseFix), j({ wt: WT, fix: { try: 1, of: 2, head: HEAD, source: SRC, files: ['src/a.ts'] } }));
  t('and the line says so', lines(as).at(-1), `base sync: merging main into feat/x conflicts, nothing pushed. Conflicting files: src/a.ts. Conflict fix try 1 of 2 starts this pass in ${WT} — spawning carries on from the base as it stands (feat/x is 3 commit(s) behind main, within the 20 it may lag)`);
  t('the base gate is told a worker has it', j(state(as).gateConflict), j({ worker: true, line: `merging main into feat/x conflicts, nothing pushed. Conflicting files: src/a.ts. Conflict fix try 1 of 2 starts this pass in ${WT}`, said: false }));
  t('a record that could not be written is said', lines(sync(snap(), { sync: conflict, 'note-conflict': 'conflicts: not recorded' }))[0], 'conflicts: not recorded');
  const room = sync(snap({}, { fixRoom: false }), { sync: conflict });
  t('with no room for a worker, the try waits, saying why', j([lines(room).at(-1).includes('Conflict fix try 1 of 2 starts once a worker may (none may this pass: memory: 2.0G available, under the 6G spawn gate)'), state(room).baseFix]), '[true,null]');
  const person = sync(snap({ feature: true }, { conflictPerm: 'ask' }), { sync: conflict });
  t('one no worker may take goes to the person, and holds a feature batch', j([waiting(person), state(person).baseHold]), j([[
    `base sync: merging main into feat/x conflicts, nothing pushed. Conflicting files: src/a.ts. Config §3 pr-conflict-unreviewed is "ask", so no worker resolves it: resolve it by hand in ${WT} and push — feature mode, so nothing spawns this pass`], true]));
  t('and the base gate is told it was said', j(state(person).gateConflict), j({ worker: false, line: `merging main into feat/x conflicts, nothing pushed. Conflicting files: src/a.ts. Config §3 pr-conflict-unreviewed is "ask", so no worker resolves it: resolve it by hand in ${WT} and push`, said: true }));
  const check = sync(snap(), { sync: { ok: false, reason: 'check', check: { command: 'make check', output: 'a\nb' } } });
  t('a merged-tree check that fails is a merged-tree fix, with no conflict record', j([types(check).includes('note-conflict'), lines(check).at(-1).startsWith('base sync: merging main into feat/x fails §4 Merged-tree check (make check), nothing pushed. Its output: a / b. Merged-tree fix try 1 of 2 starts this pass')]), '[false,true]');
}

// The base push grant.
{
  const ask = { perm: 'ask', key: 'batch-base-push', ok: false };
  const sup = sync(snap({}, { push: ask, passBy: 'supervisor' }), { sync: { ok: false, reason: 'permission', merged: 3 } });
  t('a supervised pass asks once for the batch', j(batchWrites(sup)), j([`base_push_ask=${JSON.stringify({ since: '2026-11-18T12:00:00.000Z', base: 'feat/x', source: 'main' })}`]));
  t('and says so', lines(sup)[0], 'base sync: feat/x is 3 commit(s) behind main and config §3 batch-base-push is "ask", so it was not synced: asked once for the batch in /desk-needs-you (its base-push item) — spawning carries on from the base as it stands (feat/x is 3 commit(s) behind main, within the 20 it may lag)');
  t('once', batchWrites(sync(snap({ base_push_ask: { since: 'x' } }, { push: ask, passBy: 'supervisor' }), { sync: { ok: false, reason: 'permission', merged: 3 } })).length, 0);
  t('a session pass says how to approve it', waiting(sync(snap({}, { push: ask }), { sync: { ok: false, reason: 'permission', merged: 3 } }))[0].includes(': ask once for the batch, then run passes with AUTOPILOT_BASE_PUSH_APPROVED=1 — '), true);
  const gone = { ok: false, reason: 'permission', merged: 0, recreate: { last: 'a'.repeat(40), at: 'b'.repeat(40) } };
  t('a gone base asks to recreate it', j(batchWrites(sync(snap({}, { push: ask, passBy: 'supervisor' }), { sync: gone }))),
    j([`base_push_ask=${JSON.stringify({ since: '2026-11-18T12:00:00.000Z', base: 'feat/x', source: 'main', recreate: true })}`]));
  t('and an ask raised while it was behind is turned into one, keeping its age', j(batchWrites(sync(snap({ base_push_ask: { since: 'x' } }, { push: ask, passBy: 'supervisor' }), { sync: gone }))),
    j([`base_push_ask=${JSON.stringify({ since: 'x', base: 'feat/x', source: 'main', recreate: true })}`]));
  t('the ask is settled once the base syncs',j(batchWrites(sync(snap({ base_push_ask: { since: 'x' } })))), j(['base_push_ask=null']));
}

// A base fix try's worker.
{
  const running = { tries: [{ try: 1, head: HEAD, files: ['src/a.ts'] }], running: 'sid-fix', port: 3299, log_bytes: 10, idle_passes: 0 };
  const maint = sync(snap({ base_fix: { ...running, resume: 'maintenance' } }));
  t('one stopped for the maintenance window resumes once nothing holds spawns', j(state(maint).baseFixResume), j({ wt: WT, why: null, ended: 'stopped for the maintenance window', clear: { resume: null } }));
  t('and holds the base worktree, so the sync waits for it', lines(maint)[0], `base sync: conflict fix try 1 of 2 is merging main into feat/x in ${WT} (session sid-fix); the base is synced once it pushes — spawning carries on from the base as it stands (feat/x is 3 commit(s) behind main, within the 20 it may lag)`);
  t('held, it is reported paused', sync(snap({ base_fix: { ...running, resume: 'maintenance' } }, { resumeHeld: 'low memory' })).find((a) => a.list === 'paused')?.line,
    'BASE-feat-x: stopped for the maintenance window; it resumes once nothing holds spawns (low memory)');
  const done = '{"type":"assistant","message":{"content":[{"type":"text","text":"AUTOPILOT_DONE: pushed"}]}}\n';
  const ended = { ...running, tries: [{ ...running.tries[0], outcome: 'finished: pushed' }], running: null, port: null };
  const fin = sync(snap({ base_fix: running }, { registry: registryView({ live: [{ sessionId: 'sid-fix', pid: 4321 }] }) }),
    { 'fix-log': { raw: Buffer.from(done), text: done, recent: false, bytes: done.length }, 'end-try': ended });
  t('one that printed DONE is stopped and its try ended', j(fin.filter((a) => ['kill', 'end-try'].includes(a.type))), j([{ type: 'kill', pid: 4321 }, { type: 'end-try', outcome: 'finished: pushed', path: WT, extra: {} }]));
  t('and said', lines(fin)[0], 'base conflict fix: try 1 of 2 on feat/x finished: pushed (session still live, stopped pid 4321)');
  t('then the base syncs again', types(fin).includes('sync'), true);
  t('a dry run stops no process', types(sync(snap({ base_fix: running }, { dry: true, registry: registryView({ live: [{ sessionId: 'sid-fix', pid: 4321 }] }) }),
    { 'fix-log': { raw: Buffer.from(done), text: done, recent: false, bytes: done.length }, 'end-try': ended })).includes('kill'), false);
  const live = sync(snap({ base_fix: running }, { registry: registryView({ live: [{ sessionId: 'sid-fix', pid: 4321 }] }) }));
  t('one still at it, with a quiet log, has its idle count kept', j(batchWrites(live)), j([`base_fix=${JSON.stringify({ ...running, log_bytes: 0, idle_passes: 1 })}`]));
  t('and the record kept for the rest of the pass', state(live).bf.idle_passes, 1);
  t('an unread registry reads it as still at it, never ended', j([types(sync(snap({ base_fix: running }, { registry: registryView({ why: 'x' }) }))).includes('end-try'), state(sync(snap({ base_fix: running }, { registry: registryView({ why: 'x' }) }))).baseFixLive]), '[false,true]');
}

// A conflict the base gate met.
{
  const gate = { state: 'failed', sha: HEAD, conflict: ['src/b.ts'] };
  const as = sync(snap({ gate }, { willSpawn: false }), { behind: 0 });
  t('at the head origin\'s base is still at, a fix worker takes it', j([types(as).includes('fetch'), state(as).gateConflict.worker, state(as).baseFix?.fix.files]), j([true, true, ['src/b.ts']]));
  t('once the base moved, nothing', state(sync(snap({ gate: { ...gate, sha: 'd'.repeat(40) } }, { willSpawn: false }), { behind: 0 })).gateConflict, null);
}

// What runs in the base worktree after the sync.
{
  t('the baseline is recorded before a pass that spawns, with the record settled first', j(types(sync(snap({}, { baselineOn: true }))).slice(-2)), j(['synced', 'baseline']));
  t('not with Baseline checks off', types(sync(snap())).includes('baseline'), false);
  t('nor when the sync holds spawns', types(sync(snap({ feature: true }, { baselineOn: true }), { sync: { ok: false, why: 'x' } })).includes('baseline'), false);
  // The promotion or epic PR it opens next is tests/test_pass_promotion_pr.mjs's.
}

// The baseline checks.
const BL_READS = { heads: { head: HEAD, origin: HEAD }, dirty: false, install: 0, restore: false, record: { checks: { typecheck: [{ ok: true, count: 2 }], lint: [] } } };
const BL_WRITES = ['report', 'base-line', 'drop-baseline'];
const baseline = (fields = {}, answers = {}) => drive(decideBaseline, {
  base: 'feat/x', path: WT, prior: { base: 'feat/x', sha: 'e'.repeat(40) }, checks: { typecheck: [{ dir: '.', cmd: 'tsc' }], lint: [] }, checksError: null, install: [], dry: false, ...fields,
}, answers, BL_READS, BL_WRITES);
{
  const moved = baseline({}, { heads: { head: HEAD, origin: 'f'.repeat(40) } });
  t('AC3 a base that moved but could not be recorded leaves no baseline', j([types(moved).includes('drop-baseline'), types(moved).includes('record')]), '[true,false]');
  t('AC3 and says workers run the full checks', j(waiting(moved)), j([`baseline: not recorded for feat/x at aaaaaaaaaaaa: the base worktree ${WT} is not at origin's feat/x (ffffffffffff), which workers start from — workers run the full Typecheck and Lint`]));
  t('an unread HEAD is one that could not be recorded', waiting(baseline({}, { heads: { head: '', origin: HEAD } }))[0], `baseline: not recorded for feat/x at ?: could not read the base worktree's HEAD in ${WT} — workers run the full Typecheck and Lint`);
  t('so is a dirty worktree', waiting(baseline({}, { dirty: true }))[0].includes(`: the base worktree ${WT} has uncommitted changes — `), true);
  t('and checks that do not parse', waiting(baseline({ checks: null, checksError: 'bad item' }))[0].includes(': bad item — '), true);
  const inst = baseline({ install: [{ dir: '.', cmd: 'npm ci' }] }, { install: 1 });
  t('an Install that fails is put back, and records nothing', j(types(inst)), j(['heads', 'dirty', 'install', 'restore', 'drop-baseline', 'report']));
  t('saying which', waiting(inst)[0].includes(': config §4 Install (npm ci) failed there with exit 1 — '), true);
  const rec = baseline({ install: [{ dir: '.', cmd: 'npm ci' }] }, { restore: true });
  t('a base that moved is recorded at its head, then put back', j(types(rec)), j(['heads', 'dirty', 'install', 'record', 'restore', 'base-line']));
  t('the record is of the parsed checks', j(rec.find((a) => a.type === 'record')), j({ type: 'record', checks: { typecheck: [{ dir: '.', cmd: 'tsc' }], lint: [] }, sha: HEAD }));
  t('and said', lines(rec)[0].startsWith('baseline: recorded feat/x at aaaaaaaaaaaa: ') && lines(rec)[0].endsWith(' (the checks changed files in the base worktree; put back)'), true);
  t('a base recorded at its head already is left as it is', j(types(baseline({ prior: { base: 'feat/x', sha: HEAD } }))), j(['heads']));
  t('a dry run says it would record', j(lines(baseline({ dry: true }))), j(['baseline (dry run): would record feat/x at aaaaaaaaaaaa']));
}

// AC5: the decisions start no process, call no git, gh or Jira, and write nothing, the queue included.
{
  const { out, threw, calls } = withNoIo(() => [
    sync(snap({ feature: true }), { sync: { ok: false, why: 'refused' } }),
    sync(snap(), { sync: { ok: false, reason: 'conflict', files: ['src/a.ts'] } }),
    sync(snap({ base_fix: { tries: [{ try: 1, head: HEAD }], running: 'sid-fix', log_bytes: 0 } }), { 'end-try': { tries: [{ try: 1, head: HEAD, outcome: 'ended with no marker' }], running: null, port: null } }),
    baseline({}, { heads: { head: HEAD, origin: 'f'.repeat(40) } }),
    baseline(),
  ].map(types));
  t('AC5 the decisions return their actions', j(out?.map((x) => x.length > 0)), '[true,true,true,true,true]');
  t('AC5 and start no process and write no file on the way', j([threw, calls]), '[null,[]]');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
