// suite: undraft (which §4 Clean review verdict values the pass can read a review against)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { undraftCall, buildPark, undraftComment, leftOver, verdictCarries, DESK_REVIEW_CLEAN, VERDICT_CHECK } from '../desk/bin/undraft.mjs';
import { untriggeredChecks } from '../desk/bin/gate.mjs';
import { render } from '../skills/desk-review/bin/verdict.mjs';
import { parseEvidenceRow, evidenceRecord, recordDispatch, runIdFrom, DISPATCH_GRACE_MS, missingShots, dragFiles, dragCells, runFailed, firstErrorLine, failureKey, evidenceFixPlan, fixTicket, readFixes, writeFixes } from '../desk/bin/evidence.mjs';
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

// A required check its workflow never runs on the PR's base is put to the person as the trigger to
// change, not a re-run.
const FEAT = 'feat/VPL-626-voice-pa-on-off-contacts';
const ciOn = (branches) => [{ file: '.github/workflows/ci.yml', text: `on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: ${branches}\njobs:\n  ci:\n    name: tests\n` }];
const read410 = [];
const basePr = (base, branches) => undraftCall(tk, { number: 770, head: HEAD, base, branch: 'feature/VPL-627', mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews: [review(marker(ALL_ZERO))], checks: [{ name: 'Vercel', status: 'completed', conclusion: 'success' }] },
  { perm: 'yes', localReview: '/code-review', clean: 'no findings', handle: 'ben', required: ['tests'], rerun: 'yes', reruns: () => 0, cooledDown: true,
    untriggered: (b, h, br) => { read410.push(`${b}@${h.slice(0, 3)} from ${br}`); return untriggeredChecks(['tests'], b, ciOn(branches), { branch: br }); } });
const u410 = basePr(FEAT, '[main, production]');
t('DS-410 AC1 the reason names the workflow trigger', u410?.why, `its checks are not green: required check "tests" never runs on PRs into ${FEAT} (workflow trigger: .github/workflows/ci.yml runs on pull requests only into main, production)`);
t('DS-410 AC1 the person is told the repo change, not a re-run', `${u410?.call} | ${/^add feat\/VPL-626-voice-pa-on-off-contacts \(or a pattern such as feat\/\*\*\) to the pull_request branches of the workflow that runs "tests"/.test(u410?.action ?? '')} | ${/fix or re-run/.test(u410?.action ?? '')}`, 'person | true | false');
t('DS-410 the workflows are read for the PR\'s base at its head, with its branch', read410[0], `${FEAT}@aaa from feature/VPL-627`);
const fixed410 = basePr(FEAT, "[main, 'feat/**']");
t('DS-410 negative control: a trigger that takes the base keeps today\'s call and words', `${fixed410?.call} | ${fixed410?.why} | ${fixed410?.action}`, 'checks | its checks are not green: required check "tests" has not reported | fix or re-run the checks on #770');
read410.length = 0;
const green410 = undraftCall(tk, { number: 770, head: HEAD, base: FEAT, mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews: [review(marker(ALL_ZERO))], checks: green },
  { perm: 'yes', localReview: '/code-review', clean: 'no findings', handle: 'ben', required: ['tests'], untriggered: () => { read410.push('read'); return {}; } });
t('DS-410 AC2 once the check reports green the PR is undrafted as today, with no workflow read', `${green410?.call} | ${read410.length}`, 'ready | 0');
// DS-416: one only the default branch's workflow runs on the base waits for the pass's base sync and
// reopen, and is not put to the person as a trigger to add.
const stalePr = (stale) => undraftCall(tk, { number: 771, head: HEAD, base: FEAT, baseHead: 'b1', branch: 'feature/VPL-627', mergeable: 'MERGEABLE', mergeState: 'DRAFT', body: '', reviews: [review(marker(ALL_ZERO))], checks: [{ name: 'Vercel', status: 'completed', conclusion: 'success' }] },
  { perm: 'yes', localReview: '/code-review', clean: 'no findings', handle: 'ben', required: ['tests'], rerun: 'yes', reruns: () => 0, cooledDown: true, untriggered: () => ({}), stale });
const behind416 = { tests: `has not reported because ${FEAT} is behind main, whose copy of its workflow runs it on PRs into ${FEAT}: syncing ${FEAT} with main and reopening the PR starts it` };
const s416 = stalePr(() => ({ behind: behind416, reopen: {} }));
t('DS-416 a draft behind the default branch waits on the base sync, naming no workflow change', `${s416?.call} | ${s416?.why}`, `wait | its base ${FEAT} is to be synced or the PR reopened before CI runs: required check "tests" ${behind416.tests}`);
t('DS-416 negative control: with nothing stale it goes as before', stalePr(() => ({ behind: {}, reopen: {} }))?.call, 'checks');

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

// DS-402: a worker's park whose only blocker is a red §4 Check builds check is recorded done, so the pass builds it.
const s5 = doc('../skills/desk-autopilot/references/worker-contract-stage-5.md');
t('DS-402 AC1 the Stage 5 to 7 contract says a red Check builds check is finished DONE, not parked',
  /\*\*A red check §4 Check builds names\*\*[^]*?is not a\s+park, at Stage 6 or 7[^]*?print `AUTOPILOT_DONE`/.test(s5), true);
// VPL-603's park, as its worker printed it.
const P603 = 'PR #744 is open as a draft, but its Flows image check fails because ECR has no voicepa/flows-lambda:staging-tree-6bf03fb. Can someone run ./scripts/ensure-flows-image.sh';
const TESTS_OK = { name: 'tests', status: 'completed', conclusion: 'success' };
const prOf = (checks, more = {}) => ({ state: 'OPEN', isDraft: true, checks: [TESTS_OK, ...checks], ...more });
const bp = (question, pr, more = {}) => {
  let read = 0;
  const r = buildPark(question, () => { read++; return pr; }, { builds, rerun: 'yes', required: ['tests'], ...more });
  return { r, read };
};
const p603 = bp(P603, prOf([FLOWS]));
t('DS-402 AC2 VPL-603\'s park, its draft red only on "Flows image": recorded done with the build', `${p603.r?.checks} | ${p603.r?.command}`, 'Flows image | ./scripts/ensure-flows-image.sh');
t('DS-402 AC2 a park naming only the command counts too', bp('Can someone run ./scripts/ensure-flows-image.sh at the head?', prOf([FLOWS])).r?.checks?.join(), 'Flows image');
const LINT = { name: 'lint', status: 'completed', conclusion: 'failure', runId: 22 };
t('DS-402 AC3 a red check the row does not name beside it: parked as today', bp(P603, prOf([FLOWS, LINT])).r, null);
t('DS-402 AC2 a build-only park that names the steps it did not reach, as every park must, counts too',
  bp(`${P603}. Not reached: the review comment, the Jira comment and the transition to In Review`, prOf([FLOWS])).r?.checks?.join(), 'Flows image');
t('DS-402 AC3 a question that only mentions the remaining steps, beside the build: parked as today',
  bp(`${P603}. Before the remaining steps, should we delete the existing customer records or preserve them?`, prOf([FLOWS])).r, null);
t('DS-402 AC3 a not-reached tail that also asks something: parked as today',
  bp(`${P603}. Not reached: the Jira comment, so confirm the fee`, prOf([FLOWS])).r, null);
t('DS-402 AC2 a "Steps not reached" tail with the PR number and stage counts too',
  bp(`${P603}. Steps not reached: the review comment on PR #744 (stage 7), the Jira comment and transition`, prOf([FLOWS])).r?.checks?.join(), 'Flows image');
t('DS-402 AC3 a tail of only step words that is a question: parked as today',
  bp(`${P603}. Remaining steps: post the review or the transition?`, prOf([FLOWS])).r, null);
t('DS-402 AC2 a tail ending in a full stop counts too',
  bp(`${P603}. Not reached: the Jira comment and the transition.`, prOf([FLOWS])).r?.checks?.join(), 'Flows image');
t('DS-402 AC2 a tail naming self-review and desk-review, hyphens kept, counts too',
  bp(`${P603}. Not reached: self-review — the desk-review comment, the Jira comment and transition`, prOf([FLOWS])).r?.checks?.join(), 'Flows image');
t('DS-402 AC3 a park of only its not-reached steps, naming no build: parked as today',
  bp('Not reached: the Jira comment and the transition', prOf([FLOWS])).r, null);
t('DS-402 AC3 a park naming the build and asking something else beside it: parked as today',
  bp('Flows image is red, run ./scripts/ensure-flows-image.sh; also confirm whether the fee should be £5 or £10', prOf([FLOWS])).r, null);
t('DS-402 AC3 a park naming the build, then a question on its own line: parked as today',
  bp(`${P603}\nShould the copy say "Sign in" or "Log in"`, prOf([FLOWS])).r, null);
t('DS-402 AC3 a park naming no build check: the PR is never read', JSON.stringify(bp('Should the copy say "Sign in" or "Log in"?', prOf([FLOWS]))), '{"r":null,"read":0}');
t('DS-402 AC3 a PR out of draft: parked as today', bp(P603, prOf([FLOWS], { isDraft: false })).r, null);
t('DS-402 AC3 no open PR: parked as today', bp(P603, null).r, null);
t('DS-402 AC3 a check still running: parked as today', bp(P603, prOf([FLOWS, { name: 'lint', status: 'in_progress', conclusion: null }])).r, null);
t('DS-402 AC3 nothing red: parked as today', bp(P603, prOf([])).r, null);
for (const rerun of ['ask', 'no']) t(`DS-402 AC3 ci-rerun ${rerun}, so the pass builds nothing: parked as today`, bp(P603, prOf([FLOWS]), { rerun }).r, null);

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
  // An unbalanced backtick above the table must not pair with one below it and hide the real cell.
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

  // DS-415: a run that failed is the repo's to fix, once for every PR it fails the same way.
  const runDone = (conclusion, cells = 2) => ({ evidenceRun: () => ({ state: 'done', conclusion, url: 'https://x/actions/runs/7', runId: '7', cells }) });
  const failed = ev(EVB, runDone('failure'));
  t('DS-415 AC1 a run that failed is evidence-failed, not the person\'s', `${failed?.call} ${failed?.runId} ${failed?.workflow} ${failed?.conclusion}`, 'evidence-failed 7 pr-evidence.yml failure');
  t('DS-415 AC1 its why says it failed', failed?.why, 'its evidence workflow `pr-evidence.yml` failed at aaaaaaaaa (https://x/actions/runs/7) and left 2 screenshot cell(s)'.replace('aaaaaaaaa', HEAD.slice(0, 9)));
  t('DS-415 a run that succeeded but filled no cell is evidence-failed too', ev(EVB, runDone('success', 2))?.call, 'evidence-failed');
  t('DS-415 AC4 a run that succeeded and filled some cells is the person\'s, naming the cells left', `${ev(EVB, runDone('success', 3))?.call} ${/left 2 screenshot cell/.test(ev(EVB, runDone('success', 3))?.why)}`, 'person true');
  t('DS-415 a run with no id is the person\'s, as no log can be read', ev(EVB, { evidenceRun: () => ({ state: 'done', conclusion: 'failure', url: null, runId: null, cells: 2 }) })?.call, 'person');
  t('DS-415 the dispatch call carries the cells it was started for', ev(EVB)?.cells, 2);
  const cellsDir = mkdtempSync(join(tmpdir(), 'desk-evidence-'));
  recordDispatch(cellsDir, 740, HEAD, { workflow: 'pr-evidence.yml', out: 'https://github.com/o/r/actions/runs/9', cells: 2 });
  const cellsRec = evidenceRecord(cellsDir, 740, HEAD, () => ({ status: 'completed', conclusion: 'failure' }));
  t('DS-415 the record keeps its run id and cells', `${cellsRec?.runId} ${cellsRec?.cells} ${runFailed(cellsRec, 2)}`, '9 2 true');
  rmSync(cellsDir, { recursive: true, force: true });

  // The same failure on three PRs: a run log each, with its own run id, timestamps and SHA.
  const logOf = (id, sha, pr) => [
    `evidence\tSet up job\t2026-11-01T19:29:0${id}.1234567Z Current runner version: '2.320.0'`,
    `evidence\tShoot\t2026-11-01T19:29:1${id}.7654321Z \x1b[36;1mnode scripts/evidence.mjs --pr ${pr} --sha ${sha}\x1b[0m`,
    `evidence\tShoot\t2026-11-01T19:29:2${id}.0000000Z Error: did not set a _vercel_jwt cookie for the bypass secret (run 4119187706${id}, ${sha})`,
    `evidence\tShoot\t2026-11-01T19:29:2${id}.1000000Z ##[error]Process completed with exit code 1.`,
  ].join('\n');
  const lines = [['1', 'a1b2c3d4e5f6', 784], ['2', 'f00dfeed1234', 794], ['3', '0123456789abcdef0123456789abcdef01234567', 791]].map(([id, sha, pr]) => firstErrorLine(logOf(id, sha, pr)));
  t('DS-415 AC2 the first error line is the script\'s, not the runner\'s exit', lines[0], 'Error: did not set a _vercel_jwt cookie for the bypass secret (run 41191877061, a1b2c3d4e5f6)');
  t('DS-415 AC2 three runs of one failure share one key', new Set(lines.map((l) => failureKey('pr-evidence.yml', l))).size, 1);
  t('DS-415 AC2 the key is the workflow and the line, normalised', failureKey('pr-evidence.yml', lines[0]), 'pr-evidence.yml: Error: did not set a _vercel_jwt cookie for the bypass secret (run <n>, <sha>)');
  t('DS-415 another error is another key', failureKey('pr-evidence.yml', 'Error: page /x timed out') === failureKey('pr-evidence.yml', lines[0]), false);
  t('DS-415 another workflow is another key', failureKey('other.yml', lines[0]) === failureKey('pr-evidence.yml', lines[0]), false);
  t('DS-415 a log with no error line has none', firstErrorLine('job\tstep\t2026-11-01T00:00:00Z all good'), null);
  t('DS-415 the runner\'s ##[error] marker is taken off', firstErrorLine('j\ts\t2026-11-01T00:00:00Z ##[error]Process completed with exit code 1.'), 'Process completed with exit code 1.');

  const KEY = failureKey('pr-evidence.yml', lines[0]);
  const f = (n, head = HEAD) => ({ n, ticket: `VPL-${n}`, head, key: KEY, workflow: 'pr-evidence.yml', line: lines[0], run: String(n), url: null });
  const three = [f(784), f(794), f(791)];
  const none = evidenceFixPlan(three, {}, () => 'open');
  t('DS-415 AC2 three PRs failing the same way file one fix', `${none.file.length} ${none.file[0]?.prs.map((p) => p.n).join(',')}`, '1 784,794,791');
  t('DS-415 AC2 and none of them goes to the person', none.prs.map((p) => p.call).join(','), 'file,file,file');
  const fixes = { [KEY]: { fix: 'DS-900', prs: {} } };
  const waiting = evidenceFixPlan(three, fixes, () => 'open');
  t('DS-415 AC2 a fix already started: no other is filed and the PRs wait on it', `${waiting.file.length} ${waiting.prs.map((p) => `${p.call}:${p.fix}`).join(',')}`, '0 wait:DS-900,wait:DS-900,wait:DS-900');
  const merged = evidenceFixPlan(three, fixes, (k) => (k === 'DS-900' ? 'done' : 'open'));
  t('DS-415 AC3 once the fix is done, each waiting PR\'s run is started again', merged.prs.map((p) => p.call).join(','), 'rerun,rerun,rerun');
  const again = evidenceFixPlan([f(784)], { [KEY]: { fix: 'DS-900', prs: { 784: { head: HEAD, rerun: HEAD } } } }, () => 'done');
  t('DS-415 a run that fails the same way after the fix, at the head it was re-run at, is the person\'s', `${again.prs[0].call} ${/after DS-900 fixed it/.test(again.prs[0].why)}`, 'person true');
  t('DS-415 a new head after the fix is started again', evidenceFixPlan([f(784, OLD)], { [KEY]: { fix: 'DS-900', prs: { 784: { head: HEAD, rerun: HEAD } } } }, () => 'done').prs[0].call, 'rerun');
  const gone = evidenceFixPlan([f(784)], fixes, () => 'gone');
  t('DS-415 a fix that failed leaves the PR to the person', `${gone.prs[0].call} ${/DS-900, the fix started for it, failed/.test(gone.prs[0].why)}`, 'person true');
  const doneFix = { [KEY]: { fix: 'DS-900', done_at: '2026-11-02T10:00:00Z', prs: { 784: { head: HEAD, rerun: null } } } };
  const before = evidenceFixPlan([{ ...f(784), at: '2026-11-02T09:00:00Z' }], doneFix, () => 'done');
  t('DS-415 a run started before its fix was done is started again', `${before.file.length} ${before.prs[0].call}`, '0 rerun');
  const back = evidenceFixPlan([{ ...f(784, OLD), at: '2026-11-03T09:00:00Z' }, { ...f(794), at: '2026-11-03T09:05:00Z' }], doneFix, () => 'done');
  t('DS-415 a failure that comes back after its fix was done files a new fix, once, for every PR it fails', `${back.file.length} ${back.file[0]?.prs.map((p) => p.n).join(',')} ${back.prs.map((p) => p.call).join(',')}`, '1 784,794 file,file');
  const mixed = evidenceFixPlan([{ ...f(784), at: '2026-11-02T09:00:00Z' }, { ...f(794), at: '2026-11-03T09:05:00Z' }], doneFix, () => 'done');
  t('DS-415 a run from before the fix, read ahead of one from after it, joins the new fix rather than being started again under the old', `${mixed.file.length} ${mixed.file[0]?.prs.map((p) => p.n).join(',')} ${mixed.prs.map((p) => p.call).join(',')}`, '1 784,794 file,file');

  const ft = fixTicket({ workflow: 'pr-evidence.yml', line: lines[0], run: '41191877061', url: 'https://github.com/o/r/actions/runs/41191877061', prs: [{ n: 784, ticket: 'VPL-640' }, { n: 794, ticket: 'VPL-652' }] }, { repo: 'o/r', base: 'main', today: '2026-11-02' });
  t('DS-415 the fix ticket names the workflow and its error line', ft.summary.startsWith('evidence workflow pr-evidence.yml fails on every PR: Error: did not set a _vercel_jwt cookie'), true);
  t('DS-415 its body names the run and every PR waiting on it', ft.body.includes('https://github.com/o/r/actions/runs/41191877061') && ft.body.includes('#784 (VPL-640), #794 (VPL-652)'), true);
  t('DS-415 its body has every section of the Bug template', ['Problem', 'Where seen', 'Steps to reproduce', 'Diagnosis', 'Acceptance criteria', 'Verification', 'Design', 'Out of scope', 'Decisions', 'Build on'].every((h) => ft.body.includes(`\n## ${h}\n`) || ft.body.startsWith(`## ${h}\n`)), true);
  t('DS-415 AC5 its body tells the worker to park naming a setting only the person holds', /parks naming that setting and why/.test(ft.body), true);
  const fxDir = mkdtempSync(join(tmpdir(), 'desk-evidence-'));
  t('DS-415 no fixes recorded reads as none', JSON.stringify(readFixes(fxDir)), '{}');
  writeFixes(fxDir, fixes);
  t('DS-415 fixes round-trip', readFixes(fxDir)[KEY].fix, 'DS-900');
  rmSync(fxDir, { recursive: true, force: true });

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

// DS-317 AC3: a verdict whose only gap the person accepted, as verdict.mjs prints it, re-posted at the
// head after the one that counted the gap, is clean, and the pass undrafts the PR.
const acSeats = [{ role: 'correctness', vendor: 'claude', status: 'ran' }, { role: 'codex', vendor: 'codex', status: 'ran' }];
const acRound = (o) => render({ sha: HEAD, round: 1, skipped_files: 0, seats: acSeats, findings: [], ...o });
const acGap = review(acRound({ gaps: 1 }));
const acAccepted = review(`${acRound({ gaps: 0, accepted: [{ gap: 'AC3', by: 'ben', at: '2026-10-29', url: 'https://github.com/acme/shop/pull/701#issuecomment-1' }] })}\n\n### Accepted gaps\n- AC3: accepted by \`ben\` on 2026-10-29`);
t('DS-317 AC3 the gap counted at the head keeps it draft', call(DESK_REVIEW_CLEAN, [acGap])?.why.includes('gaps=1'), true);
const acReady = call(DESK_REVIEW_CLEAN, [acGap, acAccepted]);
t('DS-317 AC3 then accepted at the same head, it is undrafted', acReady?.call, 'ready');
t('DS-317 AC3 reading gaps=0', acReady?.verdict?.gaps, '0');
t('DS-317 AC3 under a plain-text row too', call('no findings', [acGap, acAccepted])?.call, 'ready');

process.exit(fails ? 1 : 0);
