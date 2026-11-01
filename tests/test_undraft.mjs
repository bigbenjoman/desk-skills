// suite: undraft (which §4 Clean review verdict values the pass can read a review against)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { undraftCall, undraftComment, leftOver, verdictCarries, DESK_REVIEW_CLEAN, VERDICT_CHECK } from '../desk/bin/undraft.mjs';
import { parseEvidenceRow, evidenceRecord, recordDispatch, runIdFrom, DISPATCH_GRACE_MS, missingShots, dragFiles, dragCells } from '../desk/bin/evidence.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ALL_ZERO = 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0';
const CLEAN_TEXT = 'No findings. Nothing deferred or carried.';
const green = [{ name: 'tests', status: 'completed', conclusion: 'success' }];
const tk = { key: 'T-1' };
const marker = (counts, sha = HEAD) => `<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=${sha} ${counts} vendor=codex-cross round=1 -->\nclean`;
const review = (body, oid = HEAD, login = 'ben') => ({ author: { login }, body, commit: { oid } });
const call = (clean, reviews) => undraftCall(tk, { number: 701, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews, checks: green },
  { perm: 'yes', localReview: '/code-review', clean, handle: 'ben', required: ['tests'] });

// AC1: a plain-text row, and a desk-review verdict marker with every count desk-review writes at 0.
t('AC1 the counts read are every count desk-review writes', DESK_REVIEW_CLEAN, ALL_ZERO);
const zero = call('no findings', [review(marker(ALL_ZERO))]);
t('AC1 a clean marker under "no findings" is undrafted', zero?.call, 'ready');
t('AC1 it carries the marker it read', zero?.verdict?.sha, HEAD);
for (const k of ['p2', 'deferred', 'gaps', 'unrefuted', 'partial']) {
  t(`AC1 a marker with ${k}=1 alone is not`, call('no findings', [review(marker(ALL_ZERO.replace(`${k}=0`, `${k}=1`)))])?.why.includes(`${k}=1`), true);
}
t('AC1 a marker missing a count is not: the head is reviewed again (DS-316)', call('no findings', [review(marker('p0=0 p1=0 deferred=0 gaps=0'))])?.call, 'review');
const unread = marker('p0=0 p1=0 gaps=0').replace(/\nclean$/, `\n${CLEAN_TEXT}`);
t('AC1 nor read as a plain review under a heading stating the value', call('no findings', [review(unread)])?.why, 'its desk-review verdict marker is not one the review gate reads');
t('AC1 a marker for an older head is not', call('no findings', [review(marker(ALL_ZERO, OLD), OLD)])?.why.includes('not the head'), true);

// AC2: no marker, and the latest review at the head states the value.
const plain = call('no findings', [review(`## Code review\n\n**${CLEAN_TEXT}**`)]);
t('AC2 a review stating the value at the head, nothing left over, is undrafted', plain?.call, 'ready');
t('AC2 its verdict is the line stating the value', plain?.verdict, CLEAN_TEXT);
t('AC2 the comment quotes that line', undraftComment(plain.verdict, HEAD, 'no findings'),
  `Out of draft: the review posted on this head (\`${HEAD.slice(0, 12)}\`) is clean under §4 Clean review verdict (\`no findings\`).\n\n> \`${CLEAN_TEXT}\``);
const carried = call('no findings', [review('No findings.\n\n- Deferred: rename the helper (follow-up DS-300)\n- Carried from round 2: the retry cap')]);
t('AC2 deferred or carried items keep it draft', carried?.call, 'person');
t('AC2 and the reason names each one', carried?.why.includes('"Deferred: rename the helper (follow-up DS-300)"') && carried?.why.includes('"Carried from round 2: the retry cap"'), true);
t('AC2 and the action is to settle them', carried?.action, 'settle the findings or gaps on #701');
t('AC2 "no findings, one deferred" is still left over', leftOver('No blocking findings, one deferred to DS-300').length, 1);
t('AC2 "deferred: none" is not left over', leftOver('Deferred: none\nCarried: 0\nnothing to defer').length, 0);
t('AC2 "deferred: no timeout…" defers an item', leftOver('Deferred: no timeout on outbound requests\nCarried: 0 retries for transient failures').length, 2);
t('AC2 a deferral named "no …" keeps it draft', call('no findings', [review(`${CLEAN_TEXT}\nDeferred: no timeout on outbound requests`)])?.call, 'person');
t('AC2 a review stating it at an older commit is not read', call('no findings', [review(CLEAN_TEXT, OLD)])?.why.includes(`is for ${OLD.slice(0, 9)}, not the head`), true);
t('AC2 nor one with no commit recorded: it goes to a review worker (DS-316)', call('no findings', [review(CLEAN_TEXT, '')])?.call, 'review');
t('AC2 a review that does not state it is not clean', call('no findings', [review('Two issues, see inline.')])?.why.includes('does not open a line with "no findings"'), true);
t('AC2 nor one that only mentions it beside a finding', call('no findings', [review('Correctness: 1 finding, null deref at x.js:10\nSecurity: no findings. Nothing deferred or carried.')])?.call, 'person');
t('AC2 nor one that goes on to name a finding', call('no findings', [review(`${CLEAN_TEXT}\n\nCorrectness: 1 finding at x.js:10`)])?.why.includes('"Correctness: 1 finding at x.js:10"'), true);
t('AC2 nor "no findings in the docs"', call('no findings', [review('No findings in the docs; nothing deferred.')])?.call, 'person');
t('AC2 nor one silent on what is deferred or carried', call('no findings', [review('No findings.')])?.why.includes('not that nothing is deferred or carried'), true);
t('AC2 under "clean", "not clean" is not clean', call('clean', [review('Not clean. Nothing deferred.')])?.call, 'person');
t('AC2 only the handle\'s own review counts', call('no findings', [review(CLEAN_TEXT, HEAD, 'someone')])?.call, 'review');
t('AC2 an empty review (a reply to an inline comment) does not hide the verdict', call('no findings', [review(CLEAN_TEXT), review('')])?.call, 'ready');
t('AC2 a later review at the head that reports findings wins', call('no findings', [review(CLEAN_TEXT), review('2 findings, see inline.')])?.call, 'person');
// DS-281: and its P0 is a findings call for a fix worker, as under key=value counts.
t('AC2 the latest verdict wins over an earlier clean one', call('no findings', [review(CLEAN_TEXT), review(marker('p0=1 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'))])?.call, 'findings');
t('AC2 a marker with only a P2 under "no findings" is the person\'s', call('no findings', [review(marker(ALL_ZERO.replace('p2=0', 'p2=1')))])?.call, 'person');

// AC3: key=value counts read as before; a review with no marker is no verdict.
t('AC3 key=value counts still undraft a clean marker', call('p0=0 p1=0 gaps=0', [review(marker(ALL_ZERO))])?.call, 'ready');
t('AC3 but not a marker the review gate rejects: the head is reviewed again (DS-316)', call('p0=0 p1=0 gaps=0', [review(marker('p0=0 p1=0 deferred=0 gaps=0'))])?.call, 'review');
t('AC3 and still ignore a plain review', call('p0=0 p1=0 gaps=0', [review(CLEAN_TEXT)])?.why, 'no desk-review verdict is posted on it');

// AC4: unset or not filled in.
for (const clean of [null, '', 'TODO (how the local review says clean)', 'none']) {
  const c = call(clean, [review(marker(ALL_ZERO))]);
  t(`AC4 ${JSON.stringify(clean)} is the person's, set with /desk-setup`, `${c?.call} ${c?.action}`, 'person set it with /desk-setup');
}

// DS-323 AC3: checks a workflow skips on a draft are not "not green": once the rest holds, the person undrafts it.
const withChecks = (checks, reviews) => undraftCall(tk, { number: 701, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews, checks },
  { perm: 'yes', localReview: '/code-review', clean: 'no findings', handle: 'ben', required: ['tests'] });
const skippedTests = [{ name: 'tests', status: 'completed', conclusion: 'skipped' }, { name: 'lint', status: 'completed', conclusion: 'success' }];
const sk = withChecks(skippedTests.map((c) => ({ ...c, conclusion: 'skipped' })), [review(marker(ALL_ZERO))]);
t('DS-323 AC3 a clean draft whose every check was skipped is the person\'s to undraft', `${sk?.call} | ${sk?.why} | ${sk?.action}`, 'person | CI does not run on a draft, so its checks were skipped | undraft #701');
// A skipped required check passes, as branch protection counts it, so beside a success the draft is green.
t('DS-329 AC1 a clean draft whose required check was skipped beside a passing one undrafts', withChecks(skippedTests, [review(marker(ALL_ZERO))])?.call, 'ready');
t('DS-323 AC3 one whose review is not clean says that instead', withChecks(skippedTests.map((c) => ({ ...c, conclusion: 'skipped' })), [review(marker(ALL_ZERO.replace('gaps=0', 'gaps=2')))])?.why.includes('gaps=2'), true);
t('DS-323 AC3 a failed check beside a skipped one is still not green', withChecks([...skippedTests, { name: 'build', status: 'completed', conclusion: 'failure' }], [review(marker(ALL_ZERO))])?.why.startsWith('its checks are not green'), true);

// DS-330: a draft whose red checks were all cancelled or timed out is re-run where §3 ci-rerun is yes.
const rerunPr = (checks, more = {}) => undraftCall(tk, { number: 701, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews: [review(marker(ALL_ZERO))], checks: [{ name: 'types', status: 'completed', conclusion: 'success' }, ...checks] },
  { perm: 'yes', localReview: '/code-review', clean: 'no findings', handle: 'ben', required: ['tests'], rerun: 'yes', reruns: () => 0, cooledDown: true, ...more });
const cancelled = [{ name: 'tests', status: 'completed', conclusion: 'cancelled', runId: 11 }, { name: 'lint', status: 'completed', conclusion: 'timed_out', runId: 12 }];
const rr = rerunPr(cancelled);
t('DS-330 AC1 a cancelled and a timed-out run are re-run', `${rr?.call} ${rr?.runs.join(',')}`, 'rerun 11,12');
t('DS-330 AC1 with the gate as rerun.sh reads it', JSON.stringify(rr?.gate), '{"pending":[],"failedRuns":["11","12"],"reasons":["required check \\"tests\\" is cancelled","\\"lint\\" timed_out"],"failing":[{"name":"tests","runId":"11"},{"name":"lint","runId":"12"}]}');
const running = rerunPr([...cancelled, { name: 'build', status: 'in_progress', conclusion: null, runId: 11 }]);
t('DS-330 AC1 while another check still runs it waits, spending no rerun', `${running?.call} | ${running?.why}`, 'wait | checks still running (build) beside cancelled or timed-out ones, re-run once they finish');
// A red check no rerun or build clears takes the failed-check path: a checks call, for a fix worker (DS-316).
t('DS-330 AC2 a failure beside a cancelled check of the same name is not re-run', rerunPr([{ name: 'tests', status: 'completed', conclusion: 'failure', runId: 15 }, cancelled[0]])?.call, 'checks');
t('DS-330 AC1 and not put to the person', rr?.action, undefined);
t('DS-330 AC1 within the last rerun\'s cooldown it waits', rerunPr(cancelled, { cooledDown: false })?.call, 'wait');
t('DS-330 AC1 one rerun spent leaves another', rerunPr(cancelled, { reruns: () => 1 })?.call, 'rerun');
const again = rerunPr([{ name: 'tests', status: 'completed', conclusion: 'failure', runId: 13 }], { reruns: () => 1 });
t('DS-330 AC2 a rerun that fails takes the failed-check path', `${again?.call} | ${again?.why}`, 'checks | its checks are not green: required check "tests" is failure');
t('DS-330 AC2 so does a cancel beside a failure', rerunPr([cancelled[0], { name: 'build', status: 'completed', conclusion: 'failure', runId: 14 }])?.call, 'checks');
const spent = rerunPr(cancelled, { reruns: (name) => (name === 'tests' ? 2 : 1) });
t('DS-330 AC3 two reruns spent: the failed-check path, with the conclusion', `${spent?.call} | ${spent?.why}`, 'checks | its checks are not green: required check "tests" is cancelled; "lint" timed_out, still after 2 reruns at this head');
for (const rerun of ['ask', 'no', undefined]) {
  const c = rerunPr(cancelled, { rerun });
  t(`DS-330 AC4 ci-rerun ${rerun}: nothing is re-run, and no fix worker spends a try on it`, `${c?.call} | ${c?.why}`, 'person | its checks are not green: required check "tests" is cancelled; "lint" timed_out');
}
t('DS-330 a cancelled check with no run id has nothing to re-run', rerunPr([{ name: 'tests', status: 'completed', conclusion: 'cancelled' }])?.call, 'person');

// DS-330: the pass reruns through rerun.sh, the merge driver's own rerun, against a fake gh.
const tmp = mkdtempSync(join(tmpdir(), 'undraft-rerun-'));
mkdirSync(join(tmp, 'bin'));
writeFileSync(join(tmp, 'bin', 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${tmp}/gh.log"\n`, { mode: 0o755 });
const rerunSh = (perm) => spawnSync('bash', [fileURLToPath(new URL('../desk/bin/rerun.sh', import.meta.url)), join(tmp, 'sd'), 'o/r', '701', HEAD], {
  input: JSON.stringify({ gate: rr.gate }), encoding: 'utf8', env: { ...process.env, PATH: `${join(tmp, 'bin')}:${process.env.PATH}`, ...(perm ? { RERUN_PERM: perm } : {}) },
});
const read = (f) => { try { return readFileSync(join(tmp, f), 'utf8'); } catch { return ''; } };
rerunSh(undefined);
t('DS-330 AC4 rerun.sh with no RERUN_PERM reruns nothing', read('gh.log'), '');
const ran = rerunSh('yes');
t('DS-330 AC1 rerun.sh reruns each run with --failed', read('gh.log'), 'run rerun 11 --repo o/r --failed\nrun rerun 12 --repo o/r --failed\n');
t('DS-330 AC1 and records it in the driver\'s files', `${read(`sd/reruns-701-${HEAD}`)}|${read(`sd/reruns-ok-701-${HEAD}`)}|${/^\d+\n$/.test(read('sd/cooldown-701'))}`, 'tests\nlint\n|tests\nlint\n|true');
t('DS-330 AC1 rerun.sh exits 0', ran.status, 0);
rerunSh('yes');
t('DS-330 AC1 a second rerun inside the cooldown is not made', read('gh.log').split('\n').filter(Boolean).length, 2);
rmSync(tmp, { recursive: true, force: true });

// DS-327: a draft red only on checks §4 Check builds names gets that build, once per head, then a re-run.
const FLOWS = { name: 'Flows image', status: 'completed', conclusion: 'failure', runId: 21 };
const builds = [{ name: 'Flows image', command: './scripts/ensure-flows-image.sh' }];
const buildPr = (checks, built = null, more = {}) => rerunPr([{ name: 'tests', status: 'completed', conclusion: 'success' }, ...checks], { builds, built: (h) => (h === HEAD ? built : null), ...more });
const b0 = buildPr([FLOWS]);
t('DS-327 AC1 no build at this head yet: build it', `${b0?.call} | ${b0?.command} | ${b0?.checks} | ${b0?.runs}`, 'build | ./scripts/ensure-flows-image.sh | Flows image | 21');
t('DS-327 AC1 while it runs it waits', buildPr([FLOWS], { state: 'running', command: b0.command })?.why, `its check build \`./scripts/ensure-flows-image.sh\` is running at ${HEAD.slice(0, 9)}, then "Flows image" is re-run`);
const ok = { state: 'done', command: b0.command, code: 0, tail: 'pushed', reran: null };
t('DS-327 AC1 once it succeeded, the check is re-run', `${buildPr([FLOWS], ok)?.call} ${buildPr([FLOWS], ok)?.runs}`, 'rebuilt 21');
t('DS-327 AC1 while the re-run runs, it waits as any running check does', buildPr([{ ...FLOWS, status: 'in_progress', conclusion: null }], { ...ok, reran: { ok: true } })?.call, 'wait');
const failed = buildPr([FLOWS], { ...ok, code: 3, tail: 'step 7 / no Docker context' });
t('DS-327 AC2 a failed build is the person\'s, with the command, its exit code and its last lines', `${failed?.call} | ${failed?.why} | ${failed?.action}`,
  `person | its check build \`./scripts/ensure-flows-image.sh\` exited 3 at ${HEAD.slice(0, 9)}: step 7 / no Docker context | fix the build, run it at the head of #701, then re-run "Flows image"`);
t('DS-327 AC2 a build stopped before it wrote a code says so', buildPr([FLOWS], { ...ok, code: null, tail: '' })?.why, `its check build \`./scripts/ensure-flows-image.sh\` stopped before it finished at ${HEAD.slice(0, 9)}`);
const refused = buildPr([FLOWS], { ...ok, reran: { ok: false, out: 'run 21: HTTP 403' } });
t('DS-327 AC2 a refused re-run is the person\'s', `${refused?.call} | ${refused?.action}`, 'person | re-run "Flows image" on #701');
const still = buildPr([FLOWS], { ...ok, reran: { ok: true, out: '' } });
t('DS-327 AC3 still red after the build and its re-run: the person, naming the check', `${still?.call} | ${still?.why}`,
  `person | "Flows image" is still red at ${HEAD.slice(0, 9)} after its check build \`./scripts/ensure-flows-image.sh\` ran and the check was re-run`);
t('DS-327 AC3 a build at another head is not this head\'s', buildPr([FLOWS], null, { built: (h) => (h === OLD ? ok : null) })?.call, 'build');
t('DS-327 AC4 a red check the row does not name beside it is handled as before', buildPr([FLOWS, { name: 'lint', status: 'completed', conclusion: 'failure', runId: 22 }])?.why,
  'its checks are not green: "Flows image" failure; "lint" failure');
t('DS-327 AC4 so is any red check with no row', buildPr([FLOWS], null, { builds: [] })?.call, 'checks');
t('DS-327 a named check still pending beside another waits', buildPr([FLOWS, { name: 'lint', status: 'in_progress', conclusion: null }])?.call, 'wait');
for (const rerun of ['ask', 'no']) t(`DS-327 ci-rerun ${rerun}: nothing is built`, buildPr([FLOWS], null, { rerun })?.call, 'checks');

// DS-327 AC5: /desk-setup proposes the row from the instructions, and the row is a config row.
const doc = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
t('DS-327 AC5 setup step 1 proposes §4 Check builds, not prose only', /\*\*Check builds\.\*\*[\s\S]*propose it for §4 Check builds[\s\S]*Never leave it as prose only/.test(doc('../skills/desk-setup/references/step-1-detect.md')), true);
t('DS-327 AC5 the config template has the row', /^\| Check builds \| /m.test(doc('../desk-config.md')), true);
const cbDir = mkdtempSync(join(tmpdir(), 'desk-check-builds-'));
writeFileSync(join(cbDir, 'config.md'), '## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Check builds | `Flows image: ./scripts/ensure-flows-image.sh` |\n');
const cbList = spawnSync('node', [fileURLToPath(new URL('../desk/bin/desk-env.mjs', import.meta.url)), 'list', 'check-builds'],
  { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: join(cbDir, 'config.md'), DESK_MACHINE: join(cbDir, 'none.md'), HOME: cbDir } });
t('DS-327 AC5 desk-env reads the row as check-builds', `${cbList.status} ${cbList.stdout.trim()}`, '0 Flows image: ./scripts/ensure-flows-image.sh');
rmSync(cbDir, { recursive: true, force: true });

// Evidence workflow: screenshot cells a repo's own workflow fills are started there, not put to the person.
{
  const EVB = 'Before | After\n_drag a-before.png_ | _drag a-after.png_\n\n```evidence\na-before.png | before | /x | 1280\n```\n';
  const ev = (body, cfgX = {}) => undraftCall(tk, { number: 740, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body, reviews: [review(marker(ALL_ZERO))], checks: green },
    { perm: 'yes', localReview: '/desk-review', clean: 'p0=0 p1=0 gaps=0', handle: 'ben', required: ['tests'], evidence: { workflow: 'pr-evidence.yml' }, ...cfgX });
  const start = ev(EVB);
  t('EV cells left with an evidence block start the workflow', `${start?.call} ${start?.workflow}`, 'evidence pr-evidence.yml');
  t('EV it says how many cells', start?.why.startsWith('2 screenshot cell(s) left'), true);
  t('EV while it runs, the PR waits', ev(EVB, { evidenceRun: () => ({ state: 'running', url: null }) })?.call, 'wait');
  const after = ev(EVB, { evidenceRun: () => ({ state: 'done', conclusion: 'success', url: 'https://x/actions/runs/1' }) });
  t('EV cells still left after the run are the person\'s', after?.call, 'person');
  t('EV and the person is told how to re-run it', after?.action.includes('gh workflow run pr-evidence.yml -f pr=740'), true);
  t('EV no evidence block: the person uploads them, as before', ev('_drag a.png_')?.action, 'upload the screenshots to #740');
  t('EV no §4 row: the person uploads them, as before', ev(EVB, { evidence: null })?.action, 'upload the screenshots to #740');
  t('EV a local upload left partial is the person\'s, whatever the row', undraftCall({ key: 'T-1', images_uploaded: 'partial' }, { number: 740, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: EVB, reviews: [review(marker(ALL_ZERO))], checks: green },
    { perm: 'yes', localReview: '/desk-review', clean: 'p0=0 p1=0 gaps=0', handle: 'ben', required: ['tests'], evidence: { workflow: 'pr-evidence.yml' } })?.call, 'person');
  t('EV cells filled: it is undrafted', ev(EVB.replace(/_drag \S+_/g, '![x](https://img/x.png)'))?.call, 'ready');
  t('EV red checks come first: no run while a check is red', ev(EVB, {})?.call === 'evidence' && undraftCall(tk, { number: 740, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: EVB, reviews: [review(marker(ALL_ZERO))], checks: [{ name: 'tests', status: 'completed', conclusion: 'failure' }] },
    { perm: 'yes', localReview: '/desk-review', clean: 'p0=0 p1=0 gaps=0', handle: 'ben', required: ['tests'], evidence: { workflow: 'pr-evidence.yml' } })?.call === 'checks', true);

  // DS-379: cells whose file was never taken go to a capture worker, where the evidence workflow does not fill them.
  const shots = (have) => (body) => missingShots(body, have);
  const cap = ev('_drag a-before.png_ | _drag a-after.png_ | _drag a-after.png_', { evidence: null, missingShots: shots(['a-before.png']) });
  t('DS-379 AC1 a cell with no screenshot file is a capture call, naming each file once', `${cap?.call} ${cap?.files.join(',')}`, 'capture a-after.png');
  t('DS-379 AC1 its why names the files', cap?.why, '1 screenshot(s) in its body were never taken: a-after.png');
  t('DS-379 AC1 a partial upload whose left cells have no file goes to capture too', undraftCall({ key: 'T-1', images_uploaded: 'partial' }, { number: 740, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '_drag a.png_', reviews: [review(marker(ALL_ZERO))], checks: green },
    { perm: 'yes', localReview: '/desk-review', clean: 'p0=0 p1=0 gaps=0', handle: 'ben', required: ['tests'], missingShots: shots([]) })?.call, 'capture');
  t('DS-379 AC4 every file taken but the upload not approved: the person uploads them, as before', undraftCall({ key: 'T-1', images_reported: true }, { number: 740, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '_drag a.png_', reviews: [review(marker(ALL_ZERO))], checks: green },
    { perm: 'yes', localReview: '/desk-review', clean: 'p0=0 p1=0 gaps=0', handle: 'ben', required: ['tests'], missingShots: shots(['a.png']) })?.action, 'upload the screenshots to #740');
  t('DS-379 an evidence workflow that fills the cells comes before a capture worker', ev(EVB, { missingShots: shots([]) })?.call, 'evidence');
  t('DS-379 a review not clean comes before a capture worker', undraftCall(tk, { number: 740, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '_drag a.png_', reviews: [review(marker(ALL_ZERO.replace('p2=0', 'p2=1')))], checks: green },
    { perm: 'yes', localReview: '/desk-review', clean: ALL_ZERO, handle: 'ben', required: ['tests'], missingShots: shots([]) })?.call !== 'capture', true);
  t('DS-379 dragFiles reads each cell\'s file once, in order', dragFiles('_drag b.png_ x _drag a.jpg_ _drag b.png_').join(','), 'b.png,a.jpg');
  // DS-381: #348's own body named the cell in backticks, and that held it for screenshots it never needed.
  const prose = 'A body whose `_drag <file>_` cells had no file went to the person, and ``_drag <file>_`` too.';
  t('DS-381 AC1 a cell named in a code span is not a cell', dragCells(prose), 0);
  t('DS-381 AC1 nor a file to capture', dragFiles(prose).length, 0);
  const named = undraftCall(tk, { number: 740, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: prose, reviews: [review(marker(ALL_ZERO))], checks: green },
    { perm: 'yes', localReview: '/desk-review', clean: 'p0=0 p1=0 gaps=0', handle: 'ben', required: ['tests'], missingShots: shots([]) });
  t('DS-381 AC1 a body that only names the cell sends no capture worker', named?.call !== 'capture', true);
  t('DS-381 AC1 nor asks the person for screenshots', /screenshot/.test(named?.why ?? ''), false);
  t('DS-381 AC2 a real cell beside prose is still a cell', dragCells(`${prose}\n| _drag after.png_ |`), 1);
  t('DS-381 AC3 a cell in a fenced block is not listed; the real one is', dragFiles('| _drag before.png_ |\n```md\n| _drag example.png_ |\n```\n').join(','), 'before.png');
  // #348 round 7: an unbalanced backtick above the table paired with one below it and hid the real cell.
  const tail = '\n| _drag after.png_ |\n\nthen ``code`` below';
  t('DS-379 a lone backtick in prose does not hide a real cell', dragCells('a stray ` here' + tail), 1);
  t('DS-379 nor does the four-backtick form around three backticks', dragCells('write it as ```` ``` ```` here' + tail), 1);
  t('DS-379 nor a run with no partner of its own length', dragCells('an unclosed `` run' + tail), 1);
  t('DS-379 a span still hides a cell on its own line', dragCells('see ``_drag x.png_`` and `_drag y.png_`'), 0);

  t('EV row: a workflow file', JSON.stringify(parseEvidenceRow(['pr-evidence.yml'])), '{"workflow":"pr-evidence.yml"}');
  t('EV row: none is off', parseEvidenceRow(['none']), null);
  t('EV row: unset is off', parseEvidenceRow(null), null);
  t('EV row: not a workflow file is refused', !!parseEvidenceRow(['run the screenshots'])?.errors, true);
  t('EV run id from gh workflow run', runIdFrom('https://github.com/o/r/actions/runs/41191877067\n'), '41191877067');
  const evDir = mkdtempSync(join(tmpdir(), 'desk-evidence-'));
  t('EV nothing recorded at a head reads as none', evidenceRecord(evDir, 740, HEAD, () => null), null);
  recordDispatch(evDir, 740, HEAD, { workflow: 'pr-evidence.yml', out: 'https://github.com/o/r/actions/runs/9' });
  t('EV a run not completed is running', evidenceRecord(evDir, 740, HEAD, () => ({ status: 'in_progress' }))?.state, 'running');
  t('EV an unreadable run is running', evidenceRecord(evDir, 740, HEAD, () => null)?.state, 'running');
  const doneRec = evidenceRecord(evDir, 740, HEAD, (id) => (id === '9' ? { status: 'completed', conclusion: 'success' } : null));
  t('EV a completed run is done, with its url', `${doneRec?.state} ${doneRec?.conclusion} ${doneRec?.url}`, 'done success https://github.com/o/r/actions/runs/9');
  t('EV another head has its own record', evidenceRecord(evDir, 740, OLD, () => null), null);
  const at = new Date(0).toISOString();
  recordDispatch(evDir, 741, HEAD, { workflow: 'pr-evidence.yml', out: '', at });
  t('EV no run id: running within the grace', evidenceRecord(evDir, 741, HEAD, () => null, Date.parse(at) + DISPATCH_GRACE_MS - 1)?.state, 'running');
  t('EV no run id: done after it', evidenceRecord(evDir, 741, HEAD, () => null, Date.parse(at) + DISPATCH_GRACE_MS)?.state, 'done');
  rmSync(evDir, { recursive: true, force: true });

  t('EV setup step 1 proposes §4 Evidence workflow', /\*\*Evidence workflow\.\*\*[\s\S]*propose it for §4 Evidence workflow/.test(doc('../skills/desk-setup/references/step-1-detect.md')), true);
  t('EV the config template has the row', /^\| Evidence workflow \| /m.test(doc('../desk-config.md')), true);
  const evCfg = mkdtempSync(join(tmpdir(), 'desk-evidence-cfg-'));
  writeFileSync(join(evCfg, 'config.md'), '## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Evidence workflow | `pr-evidence.yml` |\n');
  const evList = spawnSync('node', [fileURLToPath(new URL('../desk/bin/desk-env.mjs', import.meta.url)), 'list', 'evidence-workflow'],
    { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: join(evCfg, 'config.md'), DESK_MACHINE: join(evCfg, 'none.md'), HOME: evCfg } });
  t('EV desk-env reads the row as evidence-workflow', `${evList.status} ${evList.stdout.trim()}`, '0 pr-evidence.yml');
  rmSync(evCfg, { recursive: true, force: true });
}

// DS-316: a verdict for an older head is read at the head when only clean merges of the base came since.
const withCarry = (reviews, carry, clean = 'p0=0 p1=0 gaps=0', checks = green) => undraftCall(tk, { number: 701, head: HEAD, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews, checks, carry },
  { perm: 'yes', localReview: '/desk-review', clean, handle: 'ben', required: ['tests'] });
const older = [review(marker(ALL_ZERO, OLD), OLD)];
const cr = withCarry(older, (sha) => sha === OLD);
t('DS-316 AC1 a verdict that carries to the head undrafts it, saying where from', `${cr?.call} ${cr?.carried === OLD}`, 'ready true');
const crComment = undraftComment(cr.verdict, HEAD, 'p0=0 p1=0 gaps=0', cr.carried);
t('DS-316 AC1 its comment names the commit reviewed and the head it holds on', crComment.includes(`posted on \`${OLD.slice(0, 12)}\` is clean`) && crComment.includes(`holds on this head (\`${HEAD.slice(0, 12)}\`): every commit since is a clean merge of the base`), true);
t('DS-316 AC1 under a plain-text row too', `${withCarry(older, () => true, 'no findings')?.call} ${withCarry(older, () => true, 'no findings')?.carried === OLD}`, 'ready true');
t('DS-316 a carried verdict with a P1 is that head\'s findings', withCarry([review(marker(ALL_ZERO.replace('p1=0', 'p1=1'), OLD), OLD)], () => true)?.call, 'findings');
const nc = withCarry(older, () => false);
t('DS-316 AC2 a verdict that does not carry sends the head to a review worker', `${nc?.call} | ${nc?.action} | ${nc?.carried}`, 'review | review #701 at its head | undefined');
let asked = 0;
withCarry([review(marker(ALL_ZERO))], () => { asked++; return true; });
t('DS-316 a verdict at the head asks for no carry', asked, 0);
const rc = withCarry([review(marker(ALL_ZERO))], undefined, 'p0=0 p1=0 gaps=0', [{ name: 'tests', status: 'completed', conclusion: 'failure', runId: '77' }]);
t('DS-316 AC4 a red required check is a checks call, with the failing check', `${rc?.call} ${rc?.failing?.[0]?.name} ${rc?.failing?.[0]?.runId}`, 'checks tests 77');
// desk-gate's verdict check reads only a verdict on the head, so no code fix turns it green.
const gateRed = { name: VERDICT_CHECK, status: 'completed', conclusion: 'failure', runId: '78' };
const gc = withCarry(older, (sha) => sha === OLD, 'p0=0 p1=0 gaps=0', [...green, gateRed]);
t('DS-316 a carried verdict whose verdict check is red goes to a review worker, saying where from', `${gc?.call} | ${gc?.carried === OLD} | ${gc?.action}`, 'review | true | review #701 at its head');
t('DS-316 and its reason names the check and the carry', gc?.why, `its desk-review verdict check reads only a verdict posted on the head, and its verdict is carried from ${OLD.slice(0, 9)}`);
t('DS-316 a stale verdict whose verdict check is red goes to a review worker, not a fix worker', withCarry(older, () => false, 'p0=0 p1=0 gaps=0', [...green, gateRed])?.call, 'review');
const both = withCarry(older, () => true, 'p0=0 p1=0 gaps=0', [{ ...green[0], conclusion: 'failure', runId: '77' }, gateRed]);
t('DS-316 beside a red code check, only the code check goes to the fix worker', `${both?.call} ${both?.failing?.map((f) => f.name).join(',')}`, 'checks tests');

// verdictCarries, against a real repository: the reviewed commit A, the base merged in to make B.
const dir = mkdtempSync(join(tmpdir(), 'undraft-carry-'));
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (args) => { try { return { ok: true, out: g(...args) }; } catch (e) { return { ok: false, out: String(e.stderr ?? '') }; } };
const put = (file, text) => writeFileSync(join(dir, file), text);
const commit = (msg) => { g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
const carries = (from, head) => verdictCarries({ from, head, base: 'main', git });
g('init', '-q', '-b', 'main');
put('a.txt', 'one\ntwo\nthree\n'); const BASE = commit('base');
g('checkout', '-q', '-b', 'pr');
put('b.txt', 'pr work\n'); const A = commit('pr work');
g('checkout', '-q', 'main'); put('c.txt', 'other\n'); commit('main moves');
g('checkout', '-q', 'pr'); g('merge', '-q', '--no-edit', 'main'); const B = g('rev-parse', 'HEAD');
t('DS-316 AC1 a clean merge of the base carries the verdict', carries(A, B), true);
t('DS-316 AC1 from an abbreviated sha too', carries(A.slice(0, 9), B), true);
put('b.txt', 'pr work, changed\n'); const C = commit('own change');
t('DS-316 AC2 an own commit since is not a carry', carries(A, C), false);
t('DS-316 nor a head the reviewed commit is not under', carries(C, B), false);
g('checkout', '-q', 'main'); put('d.txt', 'more\n'); commit('main again');
g('checkout', '-q', '-b', 'pr2', B); g('merge', '-q', '--no-commit', 'main'); put('b.txt', 'slipped in\n'); g('add', '-A'); g('commit', '-q', '--no-edit');
t('DS-316 a base merge that adds a change of its own is not a carry', carries(A, g('rev-parse', 'HEAD')), false);
g('checkout', '-q', '-b', 'pr3', A); put('a.txt', 'one\nTWO pr\nthree\n'); const A3 = commit('pr edits a');
g('checkout', '-q', 'main'); put('a.txt', 'one\nTWO main\nthree\n'); commit('main edits a');
g('checkout', '-q', 'pr3'); git(['merge', '-q', '--no-edit', 'main']); put('a.txt', 'one\nTWO both\nthree\n'); g('add', '-A'); g('commit', '-q', '--no-edit');
t('DS-316 a base merge that resolved a conflict is not a carry', carries(A3, g('rev-parse', 'HEAD')), false);
g('checkout', '-q', '-b', 'side', A); put('e.txt', 'side\n'); commit('side');
g('checkout', '-q', '-b', 'pr4', A); g('merge', '-q', '--no-ff', '--no-edit', 'side');
t('DS-316 a merge of a branch that is not the base is not a carry', carries(A, g('rev-parse', 'HEAD')), false);
g('checkout', '-q', 'main'); g('merge', '-q', '--no-ff', '--no-edit', 'pr');
t('DS-316 a head whose first parents pass the reviewed commit by is not a carry', carries(A, g('rev-parse', 'HEAD')), false);
// Its only commit since is a clean merge of the base, but its first parent is older than the reviewed commit.
g('checkout', '-q', '-b', 'pr5', BASE); g('merge', '-q', '--no-ff', '--no-edit', 'main');
t('DS-316 a clean base merge onto a commit before the reviewed one is not a carry', carries(A, g('rev-parse', 'HEAD')), false);
rmSync(dir, { recursive: true, force: true });

process.exit(fails ? 1 : 0);
