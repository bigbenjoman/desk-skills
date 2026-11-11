// suite: gate (one definition of green)
import { evaluateGate, normaliseRollup, parseHolds, matchHolds, promotionHolds, keyChanged, readKeyedFiles, globToRegExp, latestPerCheck, branchMatches, untriggeredChecks, staleTriggers, baseUntriggered, readWorkflows, parseStateChecks, stateFailing, parseCodeowners, codeOwnersOf, codeOwnerHolds, isCodeOwnerHold, holdKind, holdNeedsPerson } from '../desk/bin/gate.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { collectAnswers, capNotes, ANSWER_HEAD, SIBLING_HEAD, MAX_NOTES } from '../desk/bin/briefing.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const cr = (name, status, conclusion, runId) => ({ name, status, conclusion, detailsUrl: runId ? `https://github.com/o/r/actions/runs/${runId}/job/1` : '' });
const req = ['Lint, Type Check & Build', 'Verify script sign-off'];
const G = (nodes, o = {}) => evaluateGate(normaliseRollup(nodes), { required: req, ...o });
t('all required success', G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SUCCESS')]).state, 'pass');
t('DS-329 AC1 a required check skipped by its job\'s if: passes, as branch protection counts it', G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SKIPPED')]).state, 'pass');
for (const c of ['FAILURE', 'CANCELLED', 'TIMED_OUT']) {
  t(`DS-329 AC2 a required check that ended ${c.toLowerCase()} is still not green`, G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', c)]).state, 'fail');
}
t('every required check skipped, nothing succeeded', G([cr(req[0], 'COMPLETED', 'SKIPPED'), cr(req[1], 'COMPLETED', 'SKIPPED')]).state, 'fail');
t('every check skipped, none required', evaluateGate(normaliseRollup([cr('a', 'COMPLETED', 'SKIPPED'), cr('b', 'COMPLETED', 'SKIPPED')])).state, 'fail');
t('early pass before CI queues (required absent)', G([cr('Vercel', 'COMPLETED', 'SUCCESS')]).state, 'absent');
t('required queued', G([cr(req[0], 'QUEUED', null), cr(req[1], 'COMPLETED', 'SUCCESS')]).state, 'pending');
t('non-required failing blocks', G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SUCCESS'), cr('e2e', 'COMPLETED', 'FAILURE', 9)]).state, 'fail');
t('advisory failing allowed', G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SUCCESS'), cr('e2e', 'COMPLETED', 'FAILURE')], { advisory: ['e2e'] }).state, 'pass');
t('non-required running blocks', G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SUCCESS'), cr('x', 'IN_PROGRESS', null)]).state, 'pending');
t('run in flight blocks', G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SUCCESS')], { runs: [{ name: 'CI', status: 'queued' }] }).state, 'pending');
t('no checks at all', evaluateGate([]).state, 'absent');
t('status context success', evaluateGate(normaliseRollup([{ context: 'ci/x', state: 'SUCCESS' }])).state, 'pass');
t('status context pending', evaluateGate(normaliseRollup([{ context: 'ci/x', state: 'PENDING' }])).state, 'pending');
t('failing runId', G([cr(req[0], 'COMPLETED', 'FAILURE', 42), cr(req[1], 'COMPLETED', 'SUCCESS')]).failing[0].runId, '42');
t('neutral required', G([cr(req[0], 'COMPLETED', 'NEUTRAL'), cr(req[1], 'COMPLETED', 'SUCCESS')]).state, 'fail');
const holds = parseHolds(['backend/**: build and push Lambda images first (./scripts/build-lambda-images-local.sh)', 'claude.md: house rules', 'none']);
t('hold split on first ": "', holds[0].why, 'build and push Lambda images first (./scripts/build-lambda-images-local.sh)');
t('hold match', matchHolds(['backend/app/x.py', 'frontend/a.ts'], holds).map((h) => h.glob).join(','), 'backend/**');
t('hold basename any depth', matchHolds(['docs/claude.md'], holds).length, 1);
t('no hold', matchHolds(['backendish/x', 'frontend/backend.ts'], holds).length, 0);
t('DS-411 a hold names no routine unless the item does', JSON.stringify(holds.map((h) => h.routine)), '[null,null]');
const routined = parseHolds(['prisma/migrations/**: apply it to staging and production first; desk runs: ./scripts/apply.sh --both', 'db/**: ; desk runs: ./a.sh', 'x/**: runs; desk runs:']);
t('DS-411 `; desk runs: <command>` is the routine, and the reason stops before it', JSON.stringify(routined.map((h) => [h.why, h.routine])),
  JSON.stringify([['apply it to staging and production first', './scripts/apply.sh --both'], ['(no reason given in §4 Merge holds)', './a.sh'], ['runs; desk runs:', null]]));
t('DS-411 a matched hold keeps its routine', matchHolds(['prisma/migrations/1/m.sql'], routined).map((h) => h.routine).join(), './scripts/apply.sh --both');
const kids = [
  { key: 'T-1', merged_at: '2026-10-01T10:00:00Z', result: { pr: 11 }, promotion_hold: 'deploys infra — infra/**, 1 file(s), e.g. infra/a.tf' },
  { key: 'T-2', merged_at: '2026-10-03T10:00:00Z', result: { pr: 12 }, promotion_hold: 'build the images first — backend/**, 2 file(s), e.g. backend/x.py' },
  { key: 'T-3', merged_at: '2026-10-03T11:00:00Z', result: { pr: 13 } },
  { key: 'T-4', result: { pr: 14 }, promotion_hold: 'not merged yet' },
];
t('DS-377 the holds children carried into the base name each child and its PR', promotionHolds(kids).join(' | '), 'T-1 (#11): deploys infra — infra/**, 1 file(s), e.g. infra/a.tf | T-2 (#12): build the images first — backend/**, 2 file(s), e.g. backend/x.py');
t('DS-377 only children merged since the last promotion merged carry a hold to the next', promotionHolds(kids, '2026-10-02T00:00:00Z').map((l) => l.split(' ')[0]).join(','), 'T-2');
// Holds on what CI checks things with. The defaults /desk-setup proposes, then fixture diffs.
const ciHolds = parseHolds(['.github/**: changes CI, which decides what a merge is checked against', '.githooks/**: changes the pre-push hook',
  'package.json#scripts: changes the commands CI runs', 'tsconfig*.json: changes the typecheck', 'eslint.config.*: changes lint', 'vitest.config.*: changes the tests']);
t('keyed hold parsed', JSON.stringify([ciHolds[2].glob, ciHolds[2].path, ciHolds[2].key]), '["package.json#scripts","package.json","scripts"]');
t('plain hold has no key', ciHolds[0].key, null);
const pkg = (scripts, deps) => JSON.stringify({ name: 'app', scripts, dependencies: deps }, null, 2);
const before = pkg({ test: 'vitest run', lint: 'eslint .' }, { react: '19.0.0' });
const heldBy = (files, contents, hs = ciHolds) => matchHolds(files, hs, contents).map((h) => h.glob).join(',');
t('workflow edit held', heldBy(['.github/workflows/ci.yml'], new Map()), '.github/**');
t('scripts edit held', heldBy(['package.json'], new Map([['package.json', { before, after: pkg({ test: 'vitest run --passWithNoTests', lint: 'eslint .' }, { react: '19.0.0' }) }]])), 'package.json#scripts');
const bump = new Map([['package.json', { before, after: pkg({ test: 'vitest run', lint: 'eslint .' }, { react: '19.1.0' }) }]]);
t('version-only bump with lockfile not held', heldBy(['package.json', 'pnpm-lock.yaml'], bump), '');
t('opt-in lockfile hold', heldBy(['package.json', 'pnpm-lock.yaml'], bump, [...ciHolds, ...parseHolds(['pnpm-lock.yaml: dependency changes need a person'])]), 'pnpm-lock.yaml');
t('nested package.json scripts held', heldBy(['apps/web/package.json'], new Map([['apps/web/package.json', { before, after: pkg({ test: 'jest' }, { react: '19.0.0' }) }]])), 'package.json#scripts');
t('scripts added to a new package.json held', heldBy(['package.json'], new Map([['package.json', { before: null, after: before }]])), 'package.json#scripts');
t('tsconfig, lint and test config held', heldBy(['tsconfig.base.json', 'eslint.config.mjs', 'packages/a/vitest.config.ts'], new Map()), 'tsconfig*.json,eslint.config.*,vitest.config.*');
const unread = matchHolds(['package.json'], ciHolds);
t('unread keyed file held, saying why', unread.length === 1 && unread[0].why.endsWith('(scripts could not be compared, so held)'), true);
t('unparseable JSON counts as changed', keyChanged('{', before, 'scripts'), true);
t('dotted key', keyChanged(before, pkg({ test: 'vitest run', lint: 'eslint . --fix' }, {}), 'scripts.test'), false);
// readKeyedFiles reads at the merge base and the head; a 404 is an absent file, any other failure leaves it unread.
const calls = [];
const fakeGh = (files) => (args) => {
  calls.push(args.join(' '));
  if (args[1].includes('/compare/')) return 'a'.repeat(40) + '\n';
  const m = /contents\/(.+)\?ref=(\w+)$/.exec(args.at(-1));
  const v = files[`${decodeURIComponent(m[1])}@${m[2] === 'a'.repeat(40) ? 'base' : 'head'}`];
  if (v === 404) throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' });
  if (v === 500) throw Object.assign(new Error('x'), { stderr: 'gh: Server Error (HTTP 500)' });
  return v;
};
const read = await readKeyedFiles({ repo: 'o/r', base: 'main', head: 'b'.repeat(40), files: ['package.json', 'apps/x/package.json', 'src/a.ts'], holds: ciHolds,
  run: fakeGh({ 'package.json@base': before, 'package.json@head': before, 'apps/x/package.json@base': 404, 'apps/x/package.json@head': 500 }) });
t('read at merge base and head', JSON.stringify(read.get('package.json')), JSON.stringify({ before, after: before }));
t('server error leaves the file unread', read.has('apps/x/package.json'), false);
t('only keyed-hold files read', calls.some((c) => c.includes('src/a.ts')), false);
t('unchanged scripts not held', heldBy(['package.json'], read), '');
t('nothing to read, no gh call', (await readKeyedFiles({ repo: 'o/r', base: 'main', head: 'x', files: ['a.ts'], holds: ciHolds, run: () => { throw new Error('called'); } })).size, 0);
// A code-owner hold is met where the base's CODEOWNERS gives every held file to the merging account.
const own = (p, f) => codeOwnersOf(parseCodeowners(p), f).join(' ');
t('DS-413 CODEOWNERS last match wins', own('* @a\nsrc/ @b\n', 'src/x.ts'), '@b');
t('DS-413 CODEOWNERS a trailing / owns a directory anywhere', own('apps/ @a', 'web/apps/x.ts'), '@a');
t('DS-413 CODEOWNERS a leading / anchors', own('/docs/ @a', 'web/docs/x.md'), '');
t('DS-413 CODEOWNERS docs/* does not own nested files', own('docs/* @a', 'docs/a/b.md'), '');
t('DS-413 CODEOWNERS a bare name owns a directory of that name', own('frontend @a # note', 'frontend/src/a.ts'), '@a');
t('DS-413 CODEOWNERS a pattern with no owners leaves the path unowned', own('* @a\nsrc/gen/\n', 'src/gen/x.ts'), '');
const coHold = (files) => matchHolds(files, parseHolds(['frontend/**: CODEOWNERS path, needs your code-owner approval', 'content/legal/**: legal copy sign-off']));
const coGh = (text, seen = []) => (args) => {
  seen.push(args.at(-1));
  const m = /contents\/(.+)\?ref=main$/.exec(args.at(-1));
  if (text[m?.[1]] === undefined) throw Object.assign(new Error('x'), { stderr: 'gh: Not Found (HTTP 404)' });
  if (text[m[1]] === 500) throw Object.assign(new Error('x'), { stderr: 'gh: Server Error (HTTP 500)' });
  return text[m[1]];
};
const co = (files, text, merger = 'BigBenjoman', seen) => codeOwnerHolds(coHold(files), { repo: 'o/r', base: 'main', merger, run: coGh(text, seen) });
const seen413 = [];
const mine = await co(['frontend/a.ts', 'frontend/b/c.ts'], { CODEOWNERS: '* @bigbenjoman\n' }, 'BigBenjoman', seen413);
t('DS-413 AC1 every owner the merging account: the code-owner hold is met', `${mine.held.length} ${mine.satisfied.map((h) => h.glob).join()}`, '0 frontend/**');
t('DS-413 AC1 CODEOWNERS read from the base, .github/ first, then the root', seen413.join(' '), 'repos/o/r/contents/.github/CODEOWNERS?ref=main repos/o/r/contents/CODEOWNERS?ref=main');
const other = await co(['frontend/a.ts', 'frontend/b/c.ts'], { '.github/CODEOWNERS': '* @bigbenjoman\nfrontend/b/ @bigbenjoman @alice @acme/web\n' });
t('DS-413 AC2 another owner keeps it held, naming that owner\'s approval', `${other.satisfied.length} ${other.held[0]?.why}`,
  '0 CODEOWNERS path, needs your code-owner approval (code-owner approval from @alice, @acme/web)');
t('DS-413 a held file no pattern owns stays held', (await co(['frontend/a.ts'], { CODEOWNERS: 'backend/ @bigbenjoman' })).held[0]?.why,
  'CODEOWNERS path, needs your code-owner approval (CODEOWNERS names no owner for frontend/a.ts, so held)');
t('DS-413 an unreadable CODEOWNERS stays held', (await co(['frontend/a.ts'], { '.github/CODEOWNERS': 500, CODEOWNERS: '* @bigbenjoman' })).held[0]?.why,
  'CODEOWNERS path, needs your code-owner approval (CODEOWNERS could not be read, so held)');
t('DS-413 no CODEOWNERS stays held', (await co(['frontend/a.ts'], {})).held.length, 1);
const legal = await co(['content/legal/terms.md', 'frontend/a.ts'], { CODEOWNERS: '* @bigbenjoman' });
t('DS-413 negative control: a hold whose reason is not a code-owner approval is never met by CODEOWNERS', `${legal.held.map((h) => h.why).join()} | ${legal.satisfied.map((h) => h.glob).join()}`, 'legal copy sign-off | frontend/**');
t('DS-413 no merger, nothing read and nothing met', (await codeOwnerHolds(coHold(['frontend/a.ts']), { repo: 'o/r', base: 'main', merger: null, run: () => { throw new Error('called'); } })).held.length, 1);
t('DS-413 the reason is matched as a code-owner approval in any spelling', ['needs codeowner review', 'Code owner approval', 'code-owners'].every((why) => isCodeOwnerHold({ why })) && !isCodeOwnerHold({ why: 'owner sign-off' }), true);
// /desk-setup's Merge holds step, read against what the merge driver does with the holds it proposes.
const setup = readFileSync(new URL('../skills/desk-setup/references/step-1-detect.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
const setupHold = (re) => parseHolds([re.exec(setup)?.[1] ?? 'missing: missing'])[0];
const soleHeld = await codeOwnerHolds(matchHolds(['pricing/plans.ts'], parseHolds(['pricing/**: code-owner approval'])), { repo: 'o/r', base: 'main', merger: 'BigBenjoman', run: coGh({ CODEOWNERS: '* @bigbenjoman' }) });
t('DS-424 AC1 a code-owner approval hold on a path only the merging account owns holds nothing, so setup does not propose it', `${soleHeld.held.length} ${soleHeld.satisfied.map((h) => h.glob).join()}`, '0 pricing/**');
const policy = /ask what policy the path stands for \("([^"]+)"\)/.exec(setup)?.[1];
t('DS-424 AC2 the example policy reason is not read as a code-owner approval', Boolean(policy) && !isCodeOwnerHold({ why: policy }), true);
const policyHeld = await codeOwnerHolds(matchHolds(['pricing/plans.ts'], parseHolds([`pricing/**: ${policy}`])),{ repo: 'o/r', base: 'main', merger: 'BigBenjoman', run: coGh({ CODEOWNERS: '* @bigbenjoman' }) });
t('DS-424 AC2 so a policy hold on a path the merging account alone owns stays held', `${policyHeld.held.length} ${policyHeld.satisfied.length}`, '1 0');
const theirs = setupHold(/e\.g\. `` `([^`]+)` ``\. The merge driver holds it/);
t('DS-424 AC3 setup may still propose a code-owner approval hold on a path someone else owns', `${theirs.glob} | ${isCodeOwnerHold(theirs)}`, 'billing/** | true');
const theirsHeld = await codeOwnerHolds(matchHolds(['billing/x.ts'], [theirs]), { repo: 'o/r', base: 'main', merger: 'BigBenjoman', run: coGh({ CODEOWNERS: '* @bigbenjoman\nbilling/ @acme/finance' }) });
t('DS-424 AC3 and the merge driver holds it, naming that owner', theirsHeld.held[0]?.why, 'code-owner approval from @acme/finance (code-owner approval from @acme/finance)');
t('glob *', globToRegExp('apps/*/alembic/**').test('apps/api/alembic/versions/1.py'), true);
t('glob * no slash', globToRegExp('apps/*/x').test('apps/a/b/x'), false);
t('gh-checks bucket skipping', evaluateGate(normaliseRollup([{ name: 'a', bucket: 'skipping', state: 'SKIPPED' }]), { required: ['a'] }).state, 'fail');
// A check that failed, then passed in a later workflow run on the same head (bigbenjoman/pr-ninja#532:
// Diff Sanity Scan, run 37890847605 failed, 37891018360 passed after a close/reopen).
const run = (name, conclusion, runId, startedAt, workflowName = 'Validate PRs') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, startedAt, workflowName, detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/1` });
const superseded = [
  run(req[0], 'SUCCESS', 37891018360, '2026-10-09T05:57:01Z'),
  run(req[1], 'FAILURE', 37890847605, '2026-10-09T05:54:55Z'),
  run(req[1], 'SUCCESS', 37891018360, '2026-10-09T05:57:01Z'),
];
t('superseded failure ignored', G(superseded).state, 'pass');
t('superseded run not listed to rerun', G(superseded).failing.length, 0);
const regressed = [run(req[0], 'SUCCESS', 2, '2026-10-09T05:57:01Z'), run(req[1], 'SUCCESS', 1, '2026-10-09T05:54:55Z'), run(req[1], 'FAILURE', 2, '2026-10-09T05:57:01Z')];
t('later failure still fails', G(regressed).state, 'fail');
t('later failure runId', G(regressed).failing[0].runId, '2');
const requeued = [run(req[0], 'SUCCESS', 2, '2026-10-09T05:57:01Z'), run(req[1], 'FAILURE', 1, '2026-10-09T05:54:55Z'), { name: req[1], status: 'QUEUED', conclusion: null, workflowName: 'Validate PRs', detailsUrl: 'https://github.com/o/r/actions/runs/3/job/1' }];
t('queued rerun supersedes old failure', G(requeued).state, 'pending');
t('same name, other workflow kept', latestPerCheck(normaliseRollup([run('build', 'SUCCESS', 1, '2026-10-09T05:00:00Z', 'A'), run('build', 'FAILURE', 2, '2026-10-09T05:01:00Z', 'B')])).length, 2);

// A required check whose workflow never runs on the PR's base: ci.yml runs only on PRs into main and
// production, and on pushes to main.
const ciYml = (branches) => [
  'name: CI', '', 'on:', '  push:', '    branches: [main]', '  pull_request:', `    branches: ${branches} # PRs only`, '',
  'jobs:', '  lint:', '    name: "Lint, Type Check & Build"', '    runs-on: ubuntu-latest', '    steps:', '      - name: Checkout', '        uses: actions/checkout@v4',
].join('\n');
const signoff = ['name: Script Sign-off', 'on:', '  pull_request:', '    branches-ignore:', "      - 'release/**'", 'jobs:', '  verify-script-sign-off:', '    name: Verify script sign-off', '    runs-on: ubuntu-latest'].join('\n');
const FEAT = 'feat/VPL-626-voice-pa-on-off-contacts';
const wfs = (branches) => [{ file: '.github/workflows/ci.yml', text: ciYml(branches) }, { file: '.github/workflows/signoff.yml', text: signoff }];
const HEADB = 'feature/VPL-627-voice-pa-contacts-file';
const U = (required, base, workflows, branch = HEADB) => untriggeredChecks(required, base, workflows, { branch });
const lintOn = (on) => [{ file: 'w.yml', text: `${on}\njobs:\n  lint:\n    runs-on: x\n` }];
t('DS-410 branch filters: * stops at /, ** does not, ! takes back', [branchMatches(['feat/*'], FEAT), branchMatches(['feat/*'], 'feat/a/b'), branchMatches(['feat/**'], 'feat/a/b'), branchMatches(['**', '!feat/**'], FEAT), branchMatches(['main'], 'feat/main')].join(','), 'true,false,true,false,false');
t('DS-410 a pattern that does not compile counts as matching', branchMatches(['feat/[a'], FEAT), true);
const never = U(req, FEAT, wfs('[main, production]'));
t('DS-410 the check whose workflow runs only into main and production is untriggered on a feature base', JSON.stringify(Object.keys(never)), JSON.stringify([req[0]]));
t('DS-410 its reason names the workflow trigger', never[req[0]], `never runs on PRs into ${FEAT} (workflow trigger: .github/workflows/ci.yml runs on pull requests only into main, production)`);
t('DS-410 negative control: the same workflow on a PR into main is not untriggered', JSON.stringify(U(req, 'main', wfs('[main, production]'))), '{}');
t("DS-410 negative control: once the trigger takes 'feat/**', nothing is untriggered", JSON.stringify(U(req, FEAT, wfs("[main, production, 'feat/**']"))), '{}');
t('DS-410 a branches-ignore filter that leaves the base out runs there', JSON.stringify(U(['Verify script sign-off'], FEAT, wfs('[main]'))), '{}');
t('DS-410 a check no workflow reports (an app) is left out', JSON.stringify(U(['Vercel'], FEAT, wfs('[main]'))), '{}');
t('DS-410 a workflow with no pull_request trigger says so', U(['lint'], FEAT, lintOn('on:\n  push:\n    branches: [main]')).lint, `never runs on PRs into ${FEAT} (workflow trigger: w.yml has no pull_request trigger)`);
// Shapes it must not blame: each either runs on the base or does not read, so counts as running.
t('DS-410 a multi-line flow branch list is read, and does not throw', JSON.stringify([U(['lint'], FEAT, lintOn('on:\n  pull_request:\n    branches: [\n      main,\n      production\n    ]')), U(['lint'], 'main', lintOn('on:\n  pull_request:\n    branches: [\n      main,\n    ]'))]), JSON.stringify([{ lint: `never runs on PRs into ${FEAT} (workflow trigger: w.yml runs on pull requests only into main, production)` }, {}]));
t('DS-410 an indentless branch list is read', Object.keys(U(['lint'], 'main', lintOn('on:\n  pull_request:\n    branches:\n    - main'))).length, 0);
t('DS-410 an indentless on: event list counts pull_request as unfiltered', Object.keys(U(['lint'], FEAT, lintOn('on:\n- push\n- pull_request'))).length, 0);
t('DS-410 an inline on: list counts pull_request as unfiltered', Object.keys(U(['lint'], FEAT, lintOn('on: [push, pull_request]'))).length, 0);
t('DS-410 a flow-mapping on: does not read, so counts as running', Object.keys(U(['lint'], FEAT, lintOn('on: { pull_request: { branches: [main] } }'))).length, 0);
t('DS-410 a branch pattern with a [class] does not read, so counts as running', Object.keys(U(['lint'], FEAT, lintOn("on:\n  pull_request:\n    branches: ['release/v[0-9]', main]"))).length, 0);
t('DS-410 pull_request_target takes its trigger from the base, so counts as running', Object.keys(U(['lint'], FEAT, lintOn('on:\n  pull_request_target:\n    branches: [main]'))).length, 0);
t('DS-410 a reusable workflow runs on its caller\'s PRs', Object.keys(U(['lint'], FEAT, lintOn('on:\n  workflow_call:'))).length, 0);
t('DS-410 a push to the PR\'s branch reports on its head', Object.keys(U(['lint'], FEAT, lintOn('on:\n  push:\n    branches: [\'feature/**\']\n  pull_request:\n    branches: [main]'))).length, 0);
t('DS-410 with no head branch to test, a filtered push counts as running', Object.keys(U(['lint'], FEAT, lintOn('on:\n  push:\n    branches: [main]'), null)).length, 0);
t('DS-410 a matrix leg is its job\'s', Object.keys(U(['lint (node 20)'], FEAT, lintOn('on:\n  pull_request:\n    branches: [main]'))).join(), 'lint (node 20)');
const seen = [cr('Label PR', 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SUCCESS'), cr('Vercel', 'COMPLETED', 'SUCCESS')];
const g410 = G(seen, { untriggered: never });
t('DS-410 AC1 the gate reason names the workflow trigger, not "has not reported"', g410.reasons[0], `required check "${req[0]}" ${never[req[0]]}`);
t('DS-410 AC1 the gate lists the untriggered check', JSON.stringify([g410.state, g410.untriggered]), JSON.stringify(['absent', [req[0]]]));
t('DS-410 negative control: with no untriggered map the reason is unchanged', G(seen).reasons[0], `required check "${req[0]}" has not reported`);
t('DS-410 AC2 once the check reports green, the gate passes as before', G([...seen, cr(req[0], 'COMPLETED', 'SUCCESS')], { untriggered: never }).state, 'pass');
const wcalls = [];
const wfGh = (args) => {
  wcalls.push(args.join(' '));
  if (args[1].endsWith('/contents/.github/workflows?ref=abc')) return '.github/workflows/ci.yml\n.github/workflows/README.md\n.github/workflows/gone.yaml';
  if (args.at(-1).includes('gone.yaml')) throw new Error('HTTP 500');
  return ciYml('[main]');
};
const readWf = readWorkflows({ repo: 'o/r', ref: 'abc', run: wfGh });
t('DS-410 readWorkflows reads the yaml files at the ref, leaving out one it cannot read', JSON.stringify(readWf.map((w) => w.file)), JSON.stringify(['.github/workflows/ci.yml']));
t('DS-410 readWorkflows reads nothing when the directory cannot be listed', readWorkflows({ repo: 'o/r', ref: 'x', run: () => { throw new Error('404'); } }).length, 0);

// A base cut before main added 'feat/**' to the trigger: the head's copy and the base's copy lack it,
// main's has it.
const stale = (atBase, atDefault) => staleTriggers(never, FEAT, { branch: HEADB, defaultBranch: 'main', atBase, atDefault });
const s416 = stale(wfs('[main, production]'), wfs("[main, production, 'feat/**']"));
t('DS-416 a check only the default branch\'s workflow runs on the base is behind, not untriggered', JSON.stringify([Object.keys(s416.behind), s416.untriggered, s416.reopen]), JSON.stringify([[req[0]], {}, {}]));
const g416 = G(seen, { untriggered: { ...s416.untriggered, ...s416.behind } });
t('DS-416 AC1 the gate reason says the base is behind the default branch, which runs the check', g416.reasons[0],
  `required check "${req[0]}" has not reported because ${FEAT} is behind main, whose copy of its workflow runs it on PRs into ${FEAT}: syncing ${FEAT} with main and reopening the PR starts it`);
t('DS-416 AC1 the reason names no workflow change', /trigger|add /.test(g416.reasons[0]), false);
const r416 = stale(wfs("[main, production, 'feat/**']"), wfs("[main, production, 'feat/**']"));
t('DS-416 once the base has the trigger, the check is to reopen', JSON.stringify([Object.keys(r416.reopen), r416.behind, r416.untriggered]), JSON.stringify([[req[0]], {}, {}]));
const n416 = stale(wfs('[main, production]'), wfs('[main, production]'));
t('DS-416 AC5 a check neither copy runs keeps the DS-410 trigger reason', JSON.stringify(n416), JSON.stringify({ untriggered: never, behind: {}, reopen: {} }));
t('DS-416 AC5 its gate reason still names the workflow trigger', G(seen, { untriggered: n416.untriggered }).reasons[0], `required check "${req[0]}" ${never[req[0]]}`);
t('DS-416 a copy that does not read blames nothing on the base', JSON.stringify(stale([], [])), JSON.stringify({ untriggered: never, behind: {}, reopen: {} }));

// At a batch's admission there is no head yet: its children's branches are cut from the base.
const atAdmit = (atBase, atDefault, branches = [HEADB]) => baseUntriggered(req, FEAT, { branches, defaultBranch: 'main', atBase, atDefault });
t('DS-412 AC1 a check neither copy of its workflow runs on the base is named, with its workflow file', JSON.stringify(atAdmit(wfs('[main, production]'), wfs('[main, production]'))), JSON.stringify(never));
t('DS-412 a check only the default branch\'s copy runs is left to the base sync', JSON.stringify(atAdmit(wfs('[main, production]'), wfs("[main, production, 'feat/**']"))), '{}');
t('DS-412 AC3 negative control: a base the workflow triggers on names nothing', JSON.stringify(atAdmit(wfs("[main, 'feat/**']"), wfs("[main, 'feat/**']"))), '{}');
t('DS-412 a copy that does not read names nothing', JSON.stringify(atAdmit([], [])), '{}');
t('DS-412 a default branch copy that does not read refuses nothing, though the base\'s lacks the trigger', JSON.stringify(atAdmit(wfs('[main, production]'), [])), '{}');
t('DS-412 a default branch copy missing the check\'s workflow refuses nothing', JSON.stringify(atAdmit(wfs('[main, production]'), lintOn('on: [pull_request]'))), '{}');
t('DS-412 on the default branch itself, the base\'s copy alone decides', JSON.stringify(baseUntriggered(req, 'main', { branches: [HEADB], defaultBranch: 'main', atBase: wfs('[production]'), atDefault: [] })), JSON.stringify(untriggeredChecks(req, 'main', wfs('[production]'), { branch: HEADB })));
const lintPush = lintOn("on:\n  push:\n    branches: ['feature/**']\n  pull_request:\n    branches: [main]");
t('DS-412 a push trigger on one child\'s branch does not excuse another child', Object.keys(baseUntriggered(['lint'], FEAT, { branches: ['feature/a', 'fix/b'], atBase: lintPush, atDefault: lintPush })).join(), 'lint');

// Briefing answers survive a requeue: answer.mjs appends below the sibling-notes block.
const brief = ['Orchestrator session name: x', '', 'These questions were put to the user before you started.', '',
  `${ANSWER_HEAD} (2026-10-09T04:40Z)`, '', 'credits from the homepage list', '',
  `${SIBLING_HEAD} in this batch have found`, '', '## MEMORY', 'cap tests', '',
  `${ANSWER_HEAD} (2026-10-09T05:30Z)`, '', 'BINDING FIX ROUND: + VAT beside each price', ''].join('\n');
const kept = collectAnswers(brief);
t('first answer kept', kept.includes('credits from the homepage list'), true);
t('answer after sibling notes kept', kept.includes('BINDING FIX ROUND'), true);
t('sibling notes not folded in', kept.includes('## MEMORY'), false);
t('stable on respawn', collectAnswers(`${ANSWER_HEAD} (a)\n\nx\n\n${kept}\n\n${SIBLING_HEAD}\n\nnotes`).split(ANSWER_HEAD).length - 1, 3);
t('no answers', collectAnswers('just notes'), '');

// The sibling-notes block is capped: the header stays, the newest entries stay, the file is named.
const header = '# Batch notes\n\n## MEMORY — mandatory\n\nHEADER-RULE cap the runner\n\n';
const notesOf = (n) => header + Array.from({ length: n }, (_, i) => `- [X-${i + 1}] note ${i + 1} padded to a realistic length\n`).join('');
const P = '/state/batch-notes.md';
t('DS-362 AC3 notes below the cap unchanged', capNotes(notesOf(3), P, 1000), notesOf(3));
const at = notesOf(20);
t('DS-362 AC3 notes exactly at the cap unchanged', capNotes(at, P, at.length), at);
const cut = capNotes(notesOf(600), P, 4000);
t('DS-362 AC1 notes above the cap cut within it', cut.length <= 4000, true);
t('DS-362 AC2 the header kept', cut.startsWith(header), true);
t('DS-362 AC2 the newest entry kept', cut.includes('- [X-600] note 600 '), true);
t('DS-362 AC2 the oldest entry cut', cut.includes('- [X-1] note 1 '), false);
t('DS-362 AC2 the full file named', cut.trimEnd().endsWith(`every note is in ${P}: grep it]`), true);
t('DS-362 a header over the cap is cut within it', capNotes(`${'x'.repeat(5000)}\n- [X-1] y\n`, P, 1000).length <= 1000, true);
t('DS-362 MAX_NOTES is the default cap', capNotes(notesOf(1000), P).length <= MAX_NOTES, true);

// DS-422: §4 State checks.
const sc = (items) => JSON.stringify(parseStateChecks(items));
t('DS-422 unset is desk-gate.yml\'s two state jobs', sc(null), JSON.stringify({ checks: [{ name: 'desk-review verdict', kind: 'verdict' }, { name: 'protected-path approval', kind: 'approval' }], errors: [] }));
t('DS-422 kinds and a bare check', sc(['🌿 Local Adversarial Code Review: verdict', '🔐 Review gate: approval', '🏁 CI gate']),
  JSON.stringify({ checks: [{ name: '🌿 Local Adversarial Code Review', kind: 'verdict' }, { name: '🔐 Review gate', kind: 'approval' }, { name: '🏁 CI gate', kind: null }], errors: [] }));
t('DS-422 a check name may hold ": "', sc(['Gate: title: approval']), JSON.stringify({ checks: [{ name: 'Gate: title', kind: 'approval' }], errors: [] }));
t('DS-422 none names none', sc(['none']), JSON.stringify({ checks: [], errors: [] }));
t('DS-422 an unknown kind is an error, never a guess', parseStateChecks(['Review gate: approve']).errors.join(), '`Review gate: approve`');
t('DS-422 stateFailing keeps only the state checks, with their kinds', JSON.stringify(stateFailing([{ name: 'tests', runId: '1' }, { name: '🔐 Review gate', runId: '2' }], parseStateChecks(['🔐 Review gate: approval']).checks)),
  JSON.stringify([{ name: '🔐 Review gate', runId: '2', kind: 'approval' }]));
// ---- DS-503: a hold whose step an agent can check is told from one only a person takes.
const kinds = (items) => parseHolds(items).map(holdKind).join();
const dryRun = 'frontend/e2e/**: skim the Confluence Sync dry-run comment first (AGENTS.md)';
t('DS-503 AC1 a hold asking for a bot comment to be read is an agent\'s check', kinds([dryRun]), 'agent');
t('DS-503 AC1 with its routine named, it is a routine hold', kinds([`${dryRun}; desk runs: bash ~/routines/confluence-dry-run.sh`]), 'routine');
const askClass = ['content/legal/**: legal copy sign-off', 'src/billing/**: touches billing', 'prisma/migrations/**: apply the migration to staging and production first',
  'infra/**: cdk deploy the stack', 'auth/**: rotate the OAuth client secret', 'pricing/**: pricing changes are signed off by finance', 'backend/**: build and push Lambda images first',
  'copy/**: customer emails, whose length is what they cost', 'pnpm-lock.yaml: dependency changes are merged by a person'];
t('DS-503 AC3 a hold in an ask class, or a sign-off, deploy or push, stays a person\'s', kinds(askClass), askClass.map(() => 'person').join());
t('DS-503 AC3 `person only` in the reason forces a person\'s hold', kinds(['docs/**: read the docs preview; person only']), 'person');
t('DS-503 AC3 so does a code-owner approval', holdNeedsPerson('CODEOWNERS path, needs your code-owner approval'), true);
const ciRows = [...setup.matchAll(/\| `` `([^`]+)` `` \|/g)].map((m) => m[1]).filter((x) => /^[^:]+: changes /.test(x));
t('DS-503 AC3 every hold on the checks desk-setup proposes stays a person\'s', `${ciRows.length > 5} ${kinds(ciRows)}`, `true ${ciRows.map(() => 'person').join()}`);
t('DS-503 negative control: a check with no ask-class word is an agent\'s', kinds(['claude.md: house rules', 'e2e/**: read the dry-run comment the docs bot posts']), 'agent,agent');
t('DS-503 AC1 desk-setup sorts each proposed hold with hold-kind and gives an agent\'s a routine', /gate\.mjs hold-kind/.test(setup) && /\*\*`agent`\*\*: .*Write it a routine/.test(setup), true);
// The CLI desk-setup and desk-update run: items given, else the config's §4 Merge holds.
const gtmp = mkdtempSync(join(tmpdir(), 'gate-503-'));
const gconf = join(gtmp, 'config.md');
writeFileSync(gconf, `## 4. Tracker, tools and team\n\n| Field | Value |\n|---|---|\n| Merge holds | \`${dryRun}\`, \`content/legal/**: legal copy sign-off\`, \`db/**: check the plan; desk runs: ./plan.sh\` |\n`);
const gcli = (args) => spawnSync(process.execPath, [new URL('../desk/bin/gate.mjs', import.meta.url).pathname, 'hold-kind', ...args], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: gconf } });
t('DS-503 AC2 hold-kind names the config\'s hold an agent can check but no routine clears', gcli([]).stdout,
  `agent\t${dryRun}\nperson\tcontent/legal/**: legal copy sign-off\nroutine\tdb/**: check the plan; desk runs: ./plan.sh\n`);
t('DS-503 AC1 hold-kind sorts the items it is given', gcli(['a/**: legal sign-off', 'b/**: read the bot comment']).stdout, 'person\ta/**: legal sign-off\nagent\tb/**: read the bot comment\n');
const update = readFileSync(new URL('../skills/desk-update/references/repo-drift.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
t('DS-503 AC2 desk-update proposes a routine for each agent line hold-kind prints', /gate\.mjs hold-kind/.test(update) && /\*\*Each `agent` line gets a routine proposed\*\*/.test(update), true);
rmSync(gtmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
