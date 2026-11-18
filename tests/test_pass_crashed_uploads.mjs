// suite: pass phase: crashed uploads (the decision, and the runner every phase goes through)
import { runPhase } from '../desk/bin/pass/run-phase.mjs';
import { crashedUploadBodies, decideCrashedUploads } from '../desk/bin/pass/crashed-uploads.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const crash = (pr, extra = {}) => ({ pr, dir: `/state/images/${pr}/`, tries: 1, log: 'x', ...extra });
const ticket = (key, fields = {}) => ({ key, state: 'done', ...fields });
const snap = (tickets, { bodies = {}, allowed = true, uploaded = [] } = {}) => ({
  tickets: Object.fromEntries(tickets.map((x) => [x.key, x])), allowed, uploaded: new Set(uploaded), now: NOW, bodies,
});
const CELL = '_drag shot.png_';

// AC1: a crashed upload is tried again, and a ticket without one gets nothing.
{
  const s = snap([ticket('A', { result: { pr: 1 }, upload_crash: crash(1) }), ticket('B', { result: { pr: 2 } })], { bodies: { 1: { body: CELL } } });
  t('AC1 the crashed upload\'s PR body is the only one read', j(crashedUploadBodies(s)), '[1]');
  t('AC1 the crashed upload is tried again from its directory, and the ticket with none gets nothing', j(decideCrashedUploads(s)), j([{ type: 'upload', key: 'A', pr: '1', dir: '/state/images/1/' }]));
}
t('a crash on a draft PR with no result yet is tried again',
  j(decideCrashedUploads(snap([ticket('A', { draft_pr: 3, upload_crash: crash(3) })], { bodies: { 3: { body: CELL } } })).map((a) => a.type)), '["upload"]');

// What holds a crashed upload back.
const held = (name, tk, opts) => { const s = snap([tk], opts); t(name, j([decideCrashedUploads(s), crashedUploadBodies(s)]), '[[],[]]'); };
held('a running worker is left to finish, since it may still edit the body', ticket('A', { state: 'running', result: { pr: 1 }, upload_crash: crash(1) }));
held('an upload already run or recorded this pass is not tried again', ticket('A', { result: { pr: 1 }, upload_crash: crash(1) }), { uploaded: ['A'] });
held('DS-429 AC3 a spent upload is not tried again', ticket('A', { result: { pr: 1 }, upload_crash: crash(1, { tries: 2 }) }));
held('DS-674 AC3 a throttled upload is not tried again before its retry_after', ticket('A', { result: { pr: 1 }, upload_crash: crash(1, { throttled: '2026-11-17T13:00:00.000Z' }) }));
held('without §3 pr-images or the person\'s approval, nothing is tried', ticket('A', { result: { pr: 1 }, upload_crash: crash(1) }), { allowed: false });
t('the shared profile in use spent no try, so a busy crash past the tries is tried again',
  j(decideCrashedUploads(snap([ticket('A', { result: { pr: 1 }, upload_crash: crash(1, { tries: 2, busy: true }) })], { bodies: { 1: { body: CELL } } })).map((a) => a.type)), '["upload"]');
t('DS-674 AC3 once its retry_after has passed, the throttled upload is tried again',
  j(decideCrashedUploads(snap([ticket('A', { result: { pr: 1 }, upload_crash: crash(1, { tries: 2, throttled: '2026-11-17T11:00:00.000Z' }) })], { bodies: { 1: { body: CELL } } })).map((a) => a.type)), '["upload"]');

// What the PR and its body decide.
{
  const s = snap([ticket('A', { result: { pr: 5 }, upload_crash: crash(4) })]);
  t('a PR the ticket has moved off drops the record, without reading its body', j([decideCrashedUploads(s), crashedUploadBodies(s)]), j([[{ type: 'set', key: 'A', fields: ['upload_crash=null'] }], []]));
}
t('DS-429 a crashed upload whose body has no cell left is not uploaded again, and its record is cleared',
  j(decideCrashedUploads(snap([ticket('P-3', { result: { pr: 773 }, upload_crash: crash(773) })], { bodies: { 773: { body: '<img alt="p-3" src="https://github.com/user-attachments/assets/3">' } } }))),
  j([{ type: 'set', key: 'P-3', fields: ['upload_crash=null', 'images_uploaded=true'] }, { type: 'report', key: 'P-3', list: 'advanced', line: 'P-3 #773 has no screenshot cell left, so its crashed upload is not tried again' }]));
t('a cell inside code is not a cell left',
  j(decideCrashedUploads(snap([ticket('A', { result: { pr: 1 }, upload_crash: crash(1) })], { bodies: { 1: { body: '```\n_drag shot.png_\n```' } } })).map((a) => a.type)), '["set","report"]');
t('a body that could not be read waits for the next pass, naming why',
  j(decideCrashedUploads(snap([ticket('A', { result: { pr: 1 }, upload_crash: crash(1) })], { bodies: { 1: { body: null, why: 'HTTP 502' } } }))),
  j([{ type: 'report', key: 'A', list: 'failed', line: 'A: the crashed upload to PR #1 waits for the next pass, since its body could not be read (HTTP 502)' }]));

// AC5: the decision starts no process, calls no git, gh or Jira, and writes nothing, the queue included.
{
  const { out, threw, calls } = withNoIo(() => {
    const s = snap([ticket('A', { result: { pr: 1 }, upload_crash: crash(1) }), ticket('B', { result: { pr: 5 }, upload_crash: crash(4) }), ticket('C', { result: { pr: 6 }, upload_crash: crash(6) })], { bodies: { 1: { body: CELL }, 6: { body: null, why: 'x' } } });
    return [crashedUploadBodies(s), decideCrashedUploads(s)];
  });
  t('AC5 the decision returns its actions', j(out?.[1].map((a) => `${a.key}:${a.type}`)), '["A:upload","B:set","C:report"]');
  t('AC5 and starts no process and writes no file on the way', j([threw, calls]), '[null,[]]');
}

// The runner.
{
  const done = [];
  const report = { failed: [], advanced: [] };
  runPhase({
    name: 'test',
    snapshot: () => ({}),
    decide: () => [{ type: 'one', key: 'A' }, { type: 'teleport', key: 'B' }, { type: 'two' }, { type: 'toString', key: 'C' }],
    handlers: { one: (a) => done.push(`one:${a.key}`), two: () => done.push('two') },
    report,
  });
  t('AC2 an action with no handler is skipped and the rest are carried out, in order', j(done), '["one:A","two"]');
  t('AC2 the report\'s failed line names each one not carried out', j(report.failed), j([
    'B: the test step has no handler for its "teleport" action, so that action was not carried out',
    'C: the test step has no handler for its "toString" action, so that action was not carried out']));
}
{
  const done = [];
  runPhase({ name: 'test', snapshot: () => ({}), decide: () => [{ type: 'one', key: 'A' }, { type: 'one', key: 'B' }], handlers: { one: (a) => done.push(a.key) }, report: { failed: [] }, skip: (a) => a.key === 'A' });
  t('an action skip() names is left out, the rest carried out', j(done), '["B"]');
}

// AC3: a phase's snapshot is read when it runs, so it shows what the phases before it changed.
{
  const store = { A: ticket('A', { result: { pr: 1 } }) };
  const report = { failed: [], advanced: [] };
  const handlers = { set: (a) => { for (const f of a.fields) { const [k, v] = f.split(/=(.*)/s); store[a.key][k] = JSON.parse(v); } } };
  const read = () => ({ tickets: structuredClone(store), allowed: true, uploaded: new Set(), now: NOW, bodies: { 1: { body: CELL } } });
  const before = decideCrashedUploads(read());
  runPhase({ name: 'first', snapshot: read, decide: () => [{ type: 'set', key: 'A', fields: [`upload_crash=${j(crash(1))}`] }], handlers, report });
  const second = runPhase({ name: 'crashed uploads', snapshot: read, decide: decideCrashedUploads, handlers: { ...handlers, upload: () => {} }, report });
  t('AC3 before the first phase ran, the crashed uploads phase had nothing to do', j(before), '[]');
  t('AC3 run after it, the phase\'s snapshot shows the crash it recorded', j(second.map((a) => `${a.key}:${a.type}`)), '["A:upload"]');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
