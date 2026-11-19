// suite: pass phase: evidence failures (filing one fix per shared failure, and what the drafts wait on)
import { runSteps } from '../desk/bin/pass/run-phase.mjs';
import { decideEvidenceFailures } from '../desk/bin/pass/evidence-failures.mjs';
import { failureKey } from '../desk/bin/evidence.mjs';
import { withNoIo } from './pass_phase_trap.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = (x) => JSON.stringify(x);

const AT = '2026-11-18T12:00:00.000Z';
const WF = 'pr-evidence.yml';
// A failed run's log, as gh run view --log-failed prints it: its own run id and time on the error line.
const logOf = (id) => [`evidence\tShoot\t2026-11-01T19:29:01.1Z node scripts/evidence.mjs`,
  `evidence\tShoot\t2026-11-01T19:29:1${id % 10}.1Z Error: did not set a _vercel_jwt cookie (run ${id}00000, ${id}abcdef0)`].join('\n');
const LINE = 'Error: did not set a _vercel_jwt cookie (run 980100000, 9801abcdef0)';
const KEY = failureKey(WF, LINE);
const item = (n, { log = logOf(9000 + n), conclusion = 'failure', at = '2026-11-01T19:28:00Z', undraft } = {}) => ({
  t: { key: `E-${n}`, ...(undraft ? { undraft } : {}) }, n, head: `h${n}`, cells: 2, rec: { call: 'evidence-failed', why: null, action: null, sha: `h${n}`, carried_from: null, pr: n },
  c: { call: 'evidence-failed', why: `its evidence run ${9000 + n} failed`, action: `look at run ${9000 + n}`, workflow: WF, runId: String(9000 + n), url: `https://x/runs/${9000 + n}`, conclusion, at },
  log,
});
const snap = (items, { fixes = {}, dry = false } = {}) => ({ items, fixes, at: AT, dry });

// The decision run with stub handlers: each yield answers from `answers` (a value, or a function of the
// action), else as a pass would with everything working: a fix open, admitted and filed as EV-1.
const ANSWERS = { 'fix-state': { st: 'open' }, admit: { ok: true }, file: { fix: 'EV-1' }, 'start-evidence': (a) => a.rec };
function drive(s, answers = {}) {
  const got = { ...ANSWERS, ...answers };
  const report = { failed: [], waiting: [] };
  const types = [...Object.keys(ANSWERS), 'out', 'report', 'save-undraft', 'write-fixes'];
  const handlers = Object.fromEntries(types.map((type) => [type, (a) => (typeof got[type] === 'function' ? got[type](a) : got[type])]));
  const acts = runSteps({ name: 'evidence failures', snapshot: () => s, decide: decideEvidenceFailures, handlers, report });
  if (report.failed.length) { fails++; console.log(`FAIL a handler was missing: ${j(report.failed)}`); }
  return acts;
}
const of = (acts, type) => acts.filter((a) => a.type === type);
const saved = (acts) => Object.fromEntries(of(acts, 'save-undraft').map((a) => [a.key, a.rec.call]));
const fixesOut = (acts) => of(acts, 'write-fixes').at(-1)?.fixes;

// AC1: two drafts failing the same way, with no fix recorded, file one fix naming both.
{
  const acts = drive(snap([item(801), item(802)]));
  const file = of(acts, 'file');
  t('AC1 one file-a-fix action', file.length, 1);
  t('AC1 it names both PRs', j(file[0]?.group.prs.map((p) => p.n)), '[801,802]');
  t('AC1 grouped on the workflow and the normalised first error line', file[0]?.group.key, KEY);
  t('AC1 once filed and admitted, both PRs wait on the fix, none goes to the person', j([saved(acts), of(acts, 'report').length]), j([{ 'E-801': 'evidence-fix', 'E-802': 'evidence-fix' }, 0]));
  t('AC1 the fix is recorded for the next pass', j(Object.keys(fixesOut(acts) ?? {}).map((k) => [k, fixesOut(acts)[k].fix, fixesOut(acts)[k].admitted])), j([[KEY, 'EV-1', true]]));
  t('AC1 the report says it was filed and admitted', of(acts, 'out')[0]?.line, `evidence: filed EV-1 to fix \`${KEY}\` for PR(s) #801, #802, admitted to the batch`);
}
t('failures with different error lines file one fix each',
  of(drive(snap([item(801), item(802, { log: 'x\tShoot\tError: something else broke' })])), 'file').length, 2);

// AC2: a run whose log cannot be read waits, and nothing is filed for it.
{
  const acts = drive(snap([item(801, { log: null })]));
  t('AC2 nothing is filed', of(acts, 'file').length, 0);
  t('AC2 the PR waits', j(of(acts, 'save-undraft').map((a) => [a.key, a.rec.call, a.rec.why])), j([['E-801', 'wait', "its evidence run 9801 failed; its run's log is read at the next pass"]]));
  t('AC2 and the report says the next pass reads it', of(acts, 'out')[0]?.line, "undraft: PR #801 (E-801) stays draft for now: its evidence run 9801 failed, and its run's log could not be read; the next pass tries again");
}
t('AC2 an unreadable log leaves the readable one filed for on its own',
  j(of(drive(snap([item(801, { log: null }), item(802)])), 'file').map((a) => a.group.prs.map((p) => p.n))), '[[802]]');
t('a run that succeeded but filled no cell is keyed on its workflow alone',
  of(drive(snap([item(801, { conclusion: 'success', log: '' })])), 'file')[0]?.group.key, failureKey(WF, null));

// AC3: a fix filed but refused admission: the lowest PR is the person's, naming the others, which wait.
{
  const acts = drive(snap([item(803), item(801), item(802)]), { file: { fix: 'EV-1', why: 'not admitted EV-1: batch ev is run by a session' } });
  const items = of(acts, 'report');
  t('AC3 one person item', items.length, 1);
  t('AC3 on the lowest PR, naming the others', items[0]?.line,
    `E-801: DRAFT — PR #801 stays draft: its evidence run 9801 failed: "${LINE}"; EV-1 was filed to fix it for the repo but not admitted (not admitted EV-1: batch ev is run by a session): /desk-admit EV-1. PR(s) #802, #803 fail the same way and wait on this. Look at run 9801`);
  t('AC3 the others wait on it', j(saved(acts)), j({ 'E-803': 'evidence-fix', 'E-801': 'person', 'E-802': 'evidence-fix' }));
  t('AC3 and say so', of(acts, 'out').filter((a) => a.line.startsWith('undraft:')).map((a) => a.line).join(' | '),
    `undraft: PR #803 (E-803) stays draft: its evidence run 9803 failed: "Error: did not set a _vercel_jwt cookie (run 980300000, 9803abcdef0)"; EV-1 fixes it once PR #801's item is settled | undraft: PR #802 (E-802) stays draft: its evidence run 9802 failed: "Error: did not set a _vercel_jwt cookie (run 980200000, 9802abcdef0)"; EV-1 fixes it once PR #801's item is settled`);
  t('AC3 the refused fix is kept with its reason', j([fixesOut(acts)?.[KEY]?.admitted, fixesOut(acts)?.[KEY]?.admit_error]), j([false, 'not admitted EV-1: batch ev is run by a session']));
}
{
  const acts = drive(snap([item(801), item(802)]), { file: { why: 'desk-jira create was refused (no grant)' } });
  t('no fix could be filed: one person item on the lowest PR, and nothing recorded',
    j([of(acts, 'report').length, saved(acts), Object.keys(fixesOut(acts))]), j([1, { 'E-801': 'person', 'E-802': 'evidence-fix' }, []]));
  t('and the report says why', of(acts, 'out')[0]?.line, `evidence: no fix filed for \`${KEY}\`: desk-jira create was refused (no grant)`);
}

// A fix already filed.
const filedFix = (extra = {}) => ({ [KEY]: { workflow: WF, line: LINE, run: '9801', url: 'u', fix: 'EV-1', at: '2026-11-01T20:00:00Z', admitted: true, prs: {}, ...extra } });
{
  const acts = drive(snap([item(801), item(802)], { fixes: filedFix() }));
  t('an open fix: the PRs wait on it, and nothing is filed or admitted', j([of(acts, 'file').length, of(acts, 'admit').length, saved(acts)]), j([0, 0, { 'E-801': 'evidence-fix', 'E-802': 'evidence-fix' }]));
  t('and each PR is recorded against the fix', j(fixesOut(acts)[KEY].prs), j({ 801: { ticket: 'E-801', head: 'h801', rerun: null }, 802: { ticket: 'E-802', head: 'h802', rerun: null } }));
}
{
  const acts = drive(snap([item(801)], { fixes: filedFix() }), { 'fix-state': { st: 'lost' } });
  t('a fix in no batch is admitted again', j(of(acts, 'admit').map((a) => a.fix)), '["EV-1"]');
  t('and once admitted the PR waits on it', j([saved(acts), fixesOut(acts)[KEY].admitted, fixesOut(acts)[KEY].admit_error]), j([{ 'E-801': 'evidence-fix' }, true, undefined]));
}
t('a fix in no batch that admission refuses again is the person\'s',
  j(saved(drive(snap([item(801)], { fixes: filedFix() }), { 'fix-state': { st: 'lost' }, admit: { ok: false, why: 'no' } }))), j({ 'E-801': 'person' }));
{
  const acts = drive(snap([item(801), item(802)], { fixes: filedFix() }), { 'fix-state': { st: 'done', at: '2026-11-02T10:00:00Z' }, 'start-evidence': (a) => (a.n === 802 ? { ...a.rec, call: 'person' } : a.rec) });
  t('a done fix starts each PR\'s run again at its head', j(of(acts, 'start-evidence').map((a) => [a.n, a.head, a.c.workflow, a.c.cells])), j([[801, 'h801', WF, 2], [802, 'h802', WF, 2]]));
  t('its done time is kept', fixesOut(acts)[KEY].done_at, '2026-11-02T10:00:00Z');
  t('only a run that started counts as run again', j(fixesOut(acts)[KEY].prs), j({ 801: { ticket: 'E-801', head: 'h801', rerun: 'h801' }, 802: { ticket: 'E-802', head: 'h802', rerun: null } }));
}
t('a done fix read from the record asks nothing of the tracker',
  of(drive(snap([item(801)], { fixes: filedFix({ done_at: '2026-11-02T10:00:00Z' }) }), { 'fix-state': () => { throw new Error('asked'); } }), 'fix-state').length, 0);
t('a run that fails the same way after the fix is the person\'s',
  j(saved(drive(snap([item(801)], { fixes: filedFix({ done_at: '2026-11-02T10:00:00Z', prs: { 801: { ticket: 'E-801', head: 'h801', rerun: 'h801' } } }) })))), j({ 'E-801': 'person' }));
t('a fix that failed leaves the PR to the person',
  j(saved(drive(snap([item(801)], { fixes: filedFix() }), { 'fix-state': { st: 'gone' } }))), j({ 'E-801': 'person' }));
t('a failure back after its fix was done files a new one',
  of(drive(snap([item(801, { at: '2026-11-03T00:00:00Z' })], { fixes: filedFix({ done_at: '2026-11-02T10:00:00Z' }) })), 'file').length, 1);

// A dry run files, admits and writes nothing.
{
  const acts = drive(snap([item(801), item(802)], { dry: true }));
  t('a dry run files and writes nothing', j([of(acts, 'file').length, of(acts, 'write-fixes').length]), '[0,0]');
  t('and says what it would file', of(acts, 'out')[0]?.line, `undraft (dry run): would file and admit one fix for \`${KEY}\`, for PR(s) #801, #802`);
  t('a dry run admits no lost fix', of(drive(snap([item(801)], { fixes: filedFix(), dry: true }), { 'fix-state': { st: 'lost' } }), 'admit').length, 0);
}
{
  const fixes = filedFix();
  drive(snap([item(801)], { fixes }), { 'fix-state': { st: 'done' } });
  t('the snapshot\'s fixes are not changed by the decision', j(fixes), j(filedFix()));
}

// AC5: the decision starts no process, calls no git, gh or Jira, and writes nothing, the queue included.
{
  const { out, threw, calls } = withNoIo(() => {
    const steps = decideEvidenceFailures(snap([item(801), item(802), item(803, { log: null })], { fixes: {} }));
    const acts = [];
    for (let r = steps.next(); !r.done;) {
      acts.push(r.value);
      r = steps.next(r.value.type === 'file' ? { fix: 'EV-1', why: 'refused' } : undefined);
    }
    return acts;
  });
  t('AC5 the decision returns its actions', j(out?.map((a) => `${a.key ?? ''}:${a.type}`)), j([':out', 'E-803:save-undraft', ':file', ':out', 'E-801:report', 'E-801:save-undraft', ':out', 'E-802:save-undraft', ':write-fixes']));
  t('AC5 and starts no process and writes no file on the way', j([threw, calls]), '[null,[]]');
}

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('all passed');
