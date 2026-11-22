// suite: gate (one definition of green)
// layer: L2
import { evaluateGate, normaliseRollup, parseHolds, matchHolds, promotionHolds, keyChanged, readKeyedFiles, globToRegExp, latestPerCheck, branchMatches, untriggeredChecks, staleTriggers, baseUntriggered, readWorkflows, parseStateChecks, stateFailing, parseFlaky, flakyWaiver, failureNotes, notesIn, parseCodeowners, codeOwnersOf, codeOwnerHolds, isCodeOwnerHold, holdKind, holdNeedsPerson, agentLast, NO_REASON, UNREAD_FILES } from '../desk/bin/gate.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectAnswers, capNotes, ANSWER_HEAD, SIBLING_HEAD, MAX_NOTES } from '../desk/bin/briefing.mjs';
import { gateReviewersIn } from '../desk/bin/desk-env.mjs';
import { scratch } from './scratch.mjs';
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
// AC7: the row setup proposes, read by the reader the reviewer check uses, is the workflow's login list.
const gateStep = /\*\*Gate reviewers\.\*\*(.*?)(?= - \*\*)/.exec(setup)?.[1] ?? '';
const workflowLogins = /`PULLBOT_REVIEWERS: "([^"]+)"`/.exec(gateStep)?.[1]?.split(/[\s,]+/) ?? [];
const proposed = [...gateStep.matchAll(/`` `([^`]+)` ``/g)].map((m) => m[1]);
t('DS-577 AC7 setup step 1 proposes §4 Gate reviewers that read as the verdict job\'s login list',
  JSON.stringify([workflowLogins, gateReviewersIn(proposed)]), JSON.stringify([['agent-pullbot'], ['agent-pullbot']]));
t('DS-577 a login that begins with any or todo is a login; a TODO note is not',
  JSON.stringify([gateReviewersIn(['anya-bot']), gateReviewersIn(['todo-bot']), gateReviewersIn(['TODO: ask']), gateReviewersIn(['Any'])]), '[["anya-bot"],["todo-bot"],null,null]');
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
const brief = ['Answer file to wait on: x', '', 'These questions were put to the user before you started.', '',
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
t('#737 external names the reviewer login', sc(['🔐 Review gate: external agent-pullbot']), JSON.stringify({ checks: [{ name: '🔐 Review gate', kind: 'external', login: 'agent-pullbot' }], errors: [] }));
t('#737 external with no login is an error', parseStateChecks(['🔐 Review gate: external']).errors.length, 1);
t('#737 a failing external check carries its login', JSON.stringify(stateFailing([{ name: '🔐 Review gate' }], parseStateChecks(['🔐 Review gate: external agent-pullbot']).checks)), JSON.stringify([{ name: '🔐 Review gate', kind: 'external', login: 'agent-pullbot' }]));
t('DS-422 stateFailing keeps only the state checks, with their kinds', JSON.stringify(stateFailing([{ name: 'tests', runId: '1' }, { name: '🔐 Review gate', runId: '2' }], parseStateChecks(['🔐 Review gate: approval']).checks)),
  JSON.stringify([{ name: '🔐 Review gate', runId: '2', kind: 'approval' }]));
{
  const gateRow = parseStateChecks(['🔐 Review gate: approval', '🏁 CI gate']).checks;
  const kindOf = (line, name = '🔐 Review gate') => stateFailing([{ name, runId: '2' }], gateRow, () => line)[0]?.kind ?? null;
  t('DS-583 AC1 a check listed as approval whose line says no review is at the head takes kind verdict', kindOf('No PullBot review at f93b2f8a0 yet'), 'verdict');
  t('DS-583 AC1 so does one whose verdict is for an older head', kindOf('The latest desk-review verdict is at 135ce1536, not the head f93b2f8a0. Review this head.'), 'verdict');
  t('DS-583 AC3 one asking an approval for protected files keeps kind approval',
    kindOf('Approval required — 2 protected file(s): `packages/db/prisma/schema.prisma`, `apps/web/package.json`'), 'approval');
  t('DS-583 AC3 so does one asking an approval at the head', kindOf('It touches `package.json` with a `feat` change. One approval at the head from someone with write access clears it.'), 'approval');
  t('DS-583 AC4 one whose line could not be read keeps its §4 kind', `${kindOf(null)} ${kindOf(undefined)}`, 'approval approval');
  t('DS-583 a verdict that is there and not clean keeps kind approval', kindOf('The desk-review verdict at f93b2f8a0 is not clean: p1=1.'), 'approval');
  t('DS-583 a bare state check is never given a kind by its line', kindOf('No PullBot review at f93b2f8a0 yet', '🏁 CI gate'), null);
}
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
t('DS-585 the ask-category words a hold reason names are decisions.mjs ASK_TERMS, none lost from before', JSON.stringify(['the stripe webhook', 'billing', 'payments page', 'invoices', 'refunds', 'prices', 'spending cap', 'budgets', 'costs', 'contract', 'legal copy', 'compliance', 'regulator', 'cookie policy', 'privacy', 'GDPR', 'licensing', 'production', 'prod', 'credentials', 'secrets', 'api-key', 'tokens', 'passwords', 'a paid plan'].map(holdNeedsPerson)), JSON.stringify(Array(25).fill(true)));
t('DS-585 and an agent check still is not a person\'s step', holdNeedsPerson('lint and unit tests must pass'), false);
const factsAndCopy = ['launch/**: Ben confirms the launch date first', 'marketing/**: the client signs off the wording', 'sms/**: SMS template text, each message is billed',
  'content/**: design review by Sam before merging', 'partners/**: ask the partner for their logo'];
t('DS-503 AC3 a fact only the person holds, or copy that costs, stays a person\'s', kinds(factsAndCopy), factsAndCopy.map(() => 'person').join());
t('DS-503 a reason desk wrote itself (no reason given, the PR\'s files unreadable) is a person\'s, never a config gap',
  `${kinds(['legacy/**'])} ${holdKind({ why: UNREAD_FILES })} ${holdKind({ why: `${NO_REASON} (scripts could not be compared, so held)` })}`, 'person person person');
const order = [{ glob: 'a', why: 'read the bot comment' }, { glob: 'b', why: 'legal sign-off' }, { glob: 'c', why: 'x', routine: './c.sh' }, { glob: 'd', why: 'read the dry-run' }, { glob: 'e', why: 'y', routine: './e.sh' }];
t('DS-503 agentLast puts a person\'s hold before an agent\'s, so the merge driver\'s note names the person\'s step', agentLast(order).map((h) => h.glob).join(''), 'bcead');
const ciRows = [...setup.matchAll(/\| `` `([^`]+)` `` \|/g)].map((m) => m[1]).filter((x) => /^[^:]+: changes /.test(x));
t('DS-503 AC3 every hold on the checks desk-setup proposes stays a person\'s', `${ciRows.length > 5} ${kinds(ciRows)}`, `true ${ciRows.map(() => 'person').join()}`);
t('DS-503 negative control: a check with no ask-class word is an agent\'s', kinds(['claude.md: house rules', 'e2e/**: read the dry-run comment the docs bot posts']), 'agent,agent');
t('DS-503 AC1 desk-setup sorts each proposed hold with hold-kind and gives an agent\'s a routine', /gate\.mjs hold-kind/.test(setup) && /\*\*`agent`\*\*: .*Write it a routine/.test(setup), true);
// The CLI desk-setup and desk-update run: items given, else the config's §4 Merge holds.
const gtmp = scratch('gate-503-');
const gconf = join(gtmp, 'config.md');
writeFileSync(gconf, `## 4. Tracker, tools and team\n\n| Field | Value |\n|---|---|\n| Merge holds | \`${dryRun}\`, \`content/legal/**: legal copy sign-off\`, \`db/**: check the plan; desk runs: ./plan.sh\` |\n`);
const gcli = (args) => spawnSync(process.execPath, [new URL('../desk/bin/gate.mjs', import.meta.url).pathname, 'hold-kind', ...args], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: gconf } });
t('DS-503 AC2 hold-kind names the config\'s hold an agent can check but no routine clears', gcli([]).stdout,
  `agent\t${dryRun}\nperson\tcontent/legal/**: legal copy sign-off\nroutine\tdb/**: check the plan; desk runs: ./plan.sh\n`);
t('DS-503 AC1 hold-kind sorts the items it is given', gcli(['a/**: legal sign-off', 'b/**: read the bot comment']).stdout, 'person\ta/**: legal sign-off\nagent\tb/**: read the bot comment\n');
const update = readFileSync(new URL('../skills/desk-update/references/repo-drift.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
t('DS-503 AC2 desk-update proposes a routine for each agent line hold-kind prints', /gate\.mjs hold-kind/.test(update) && /\*\*Each `agent` line gets a routine proposed\*\*/.test(update), true);
rmSync(gtmp, { recursive: true, force: true });
// DS-647: each pending check carries its run, so a check build's re-run waits only on its own run.
{
  const g = evaluateGate([
    { name: 'tests', status: 'completed', conclusion: 'success', runId: 1 },
    { name: 'Flows image', status: 'completed', conclusion: 'failure', runId: 21 },
    { name: 'Lint', status: 'in_progress', conclusion: null, runId: 31 },
    { name: 'e2e', status: 'queued', conclusion: null },
  ], { required: ['tests', 'Lint'], runs: [{ name: 'Deploy', status: 'in_progress', databaseId: 41 }] });
  t('DS-647 the gate lists each pending check with its run, null where none is named', JSON.stringify(g.running),
    '[{"name":"Lint","runId":31},{"name":"e2e","runId":null},{"name":"run Deploy","runId":41}]');
  t('DS-647 running matches pending one for one', g.running.map((r) => r.name).join(',') === g.pending.join(','), true);
}
// DS-662: the test lock's queue, counted machine-wide from a faked process list.
{
  const { lockWaiters, lockQueue } = await import('../desk/bin/suite-wait.mjs');
  const procs = [
    { pid: 11, ppid: 1, args: '/bin/bash /h/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh' }, // a mkdir holder
    { pid: 12, ppid: 11, args: 'bash tests/run.sh' },
    { pid: 21, ppid: 1, args: '/bin/bash /h/.claude/desk/bin/with-lock.sh tsc --cwd . -- pnpm typecheck' }, // waits, polling
    { pid: 22, ppid: 21, args: 'sleep 2' },
    { pid: 31, ppid: 1, args: 'bash /other/repo/desk/bin/with-lock.sh test -- pnpm test' }, // another repo's, waiting
    { pid: 41, ppid: 1, args: 'flock /tmp/desk-test.lock bash tests/run.sh' }, // a flock holder: it has a child
    { pid: 42, ppid: 41, args: 'bash tests/run.sh' },
    { pid: 51, ppid: 1, args: 'flock /tmp/desk-test.lock pnpm test' }, // a flock waiter: no child yet
    { pid: 61, ppid: 1, args: 'claude -p Run ~/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh' }, // a prompt quoting it
    { pid: 71, ppid: 1, args: '/bin/bash /h/.claude/desk/bin/with-lock.sh browser -- node shot.mjs' }, // another lock
  ];
  const holders = new Set([11, 12]);
  t('DS-662 waiters: every unheld with-lock test|tsc wrapper and childless flock, whatever the worktree', lockWaiters({ procs, holders }), 3);
  t('DS-662 waiters: none when ps cannot be read', lockWaiters({ procs: null, holders }), null);
  // A light suite (§4 Suite weight) waits on the light lock, which holds no heavy run back: not counted.
  const light = [...procs, { pid: 81, ppid: 1, args: '/bin/bash /h/.claude/desk/bin/with-lock.sh light --cwd . -- bash tests/run.sh' },
    { pid: 91, ppid: 1, args: 'flock /tmp/desk-light.lock bash tests/run.sh' }];
  t('a run waiting on the light lock is no waiter on the test lock', lockWaiters({ procs: light, holders }), 3);
  // But a worker's suite on the light lock is still running or waiting: it is never taken for wedged.
  const { suiteWait } = await import('../desk/bin/suite-wait.mjs');
  const wt = '/w/T-1';
  const at = (procs, cwds) => suiteWait(wt, { procs, cwds, holders: new Set() });
  const runs = [{ pid: 100, ppid: 1, args: 'flock /tmp/desk-light.lock bash tests/run.sh' }, { pid: 101, ppid: 100, args: 'bash tests/run.sh' }];
  t('a light suite running in the worktree is its suite', at(runs, [{ pid: 100, cwd: wt }]), 'suite');
  t('one waiting for the light lock is waiting on its lock', at([{ pid: 110, ppid: 1, args: 'bash /h/.claude/desk/bin/with-lock.sh light -- bash tests/run.sh' }], [{ pid: 110, cwd: wt }]), 'lock');
  t('and a light holder its holder file names is its suite', suiteWait(wt, { procs: [{ pid: 120, ppid: 1, args: 'bash tests/run.sh' }], cwds: [{ pid: 120, cwd: wt }], holders: new Set([120]) }), 'suite');
  t('DS-662 AC1 a queue at slots x factor is deep, naming its depth', JSON.stringify(lockQueue({ waiting: 4, slots: 2, factor: 2, counts: new Map([['a', 4]]), self: 'a' })),
    JSON.stringify({ deep: true, holds: true, room: 0, share: 4, own: 4, unread: false, waiting: 4, at: 4, line: "test lock queue: 4 run(s) waiting on its 2 slot(s), at or over the hold at 2 x 2 = 4; runs by repo: a 4; this repo's share ceil(4 / 1) = 4, 4 its own" }));
  t('DS-662 AC3 a queue below it holds nothing', lockQueue({ waiting: 3, slots: 2, factor: 2, counts: new Map(), self: 'a' }).deep, false);
  const unread = lockQueue({ waiting: null, slots: 1, factor: 2 });
  t('DS-662 AC5 a queue not read holds nothing and says so', `${unread.deep} ${unread.unread} ${unread.line}`, 'false true test lock queue: not read (ps could not be read), so workers start as they would without it');
}
// Each repo gets a share of a deep queue on the test lock, so one busy repo cannot stall the rest.
{
  const { lockRunsByRepo, lockQueue } = await import('../desk/bin/suite-wait.mjs');
  const w = (pid) => ({ pid, ppid: 1, args: 'bash /h/.claude/desk/bin/with-lock.sh test --cwd . -- pnpm test' });
  // Repo a: one holder in a worktree and 9 waiters; repo b: one waiter in a subdirectory; repo c: one
  // waiter in its main checkout; and one waiter in no configured repo.
  const procs = [w(11), ...[21, 22, 23, 24, 25, 26, 27, 28, 29].map(w), w(31), w(41), w(51)];
  const holders = new Set([11]);
  const cwds = [{ pid: 11, cwd: '/u/a-wt/A-1' }, ...[21, 22, 23, 24, 25, 26, 27, 28, 29].map((pid) => ({ pid, cwd: '/u/a-wt/A-2' })),
    { pid: 31, cwd: '/u/b-wt/B-1/src' }, { pid: 41, cwd: '/u/c' }, { pid: 51, cwd: '/tmp/x' }];
  const held = [{ pid: 11, cwd: '/u/a-wt/A-1', args: procs[0].args, seconds: 60 }];
  const repos = [{ name: 'a', dirs: ['/u/a', '/u/a-wt'] }, { name: 'b', dirs: ['/u/b', '/u/b-wt'] }, { name: 'c', dirs: ['/u/c', '/u/c-wt'] }];
  const counts = lockRunsByRepo(repos, { procs, holders, cwds, held });
  t('a repo\'s runs are those holding or waiting in its main checkout or worktrees; the rest are other\'s',
    JSON.stringify([...counts].sort()), JSON.stringify([['a', 10], ['b', 1], ['c', 1], ['other', 1]]));
  t('a checkout whose name starts another\'s is not inside it', lockRunsByRepo([{ name: 'a', dirs: ['/u/a'] }], { procs: [w(61)], holders: new Set(), cwds: [{ pid: 61, cwd: '/u/ab' }] }).get('a'), undefined);
  t('whose runs they are is unknown when working directories cannot be read', lockRunsByRepo(repos, { procs, holders, cwds: null, held }), null);
  // Three repos on the lock (a 10, b 1, c 1), so each one's share of a hold at 3 x 2 = 6 is 2.
  const three = new Map([['a', 10], ['b', 1], ['c', 1]]);
  const q = (self, c = three, waiting = 11) => lockQueue({ waiting, slots: 3, factor: 2, counts: c, self });
  const none = new Map([['a', 10], ['c', 1]]);
  t('DoD1 a repo with no run on a deep queue, three repos active, may start its share of 2',
    `${q('b', none).share} ${q('b', none).room} ${q('b', none).holds}`, '2 2 false');
  t('DoD2 the repo whose runs fill the queue is held', `${q('a').room} ${q('a').holds}`, '0 true');
  t('DoD3 a repo with one run under its share of 2 may start 1', `${q('b').room} ${q('b').holds}`, '1 false');
  t('DoD3 and one at its share is held', q('b', new Map([['a', 10], ['b', 2], ['c', 1]])).holds, true);
  t('DoD4 the line names each active repo\'s runs, most first, and the share', q('b').line,
    "test lock queue: 11 run(s) waiting on its 3 slot(s), at or over the hold at 3 x 2 = 6; runs by repo: a 10, b 1, c 1; this repo's share ceil(6 / 3) = 2, 1 its own");
  t('DoD5 below the hold, a pass may start the hold less those waiting', `${q('a', three, 4).room} ${q('a', three, 4).holds} ${q('a', three, 6).holds}`, '2 false true');
  t('a deep queue whose runs cannot be placed gives no room, and says so', `${q('b', null).room} ${q('b', null).line.includes('whose runs they are is unknown')}`, '0 true');
  t('below the hold, unplaced runs still give the hold less those waiting', q('b', null, 2).room, 4);
}
// Who holds the test lock is named, whatever the repo, so a batch held behind it shows what it waits on.
{
  const { lockHolderRuns, holdersText, lockQueue, etimeSeconds } = await import('../desk/bin/suite-wait.mjs');
  const procs = [
    { pid: 11, ppid: 1, args: '/bin/bash /h/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh' }, // a mkdir holder and its command
    { pid: 12, ppid: 11, args: 'bash tests/run.sh' },
    { pid: 41, ppid: 1, args: 'flock /tmp/desk-test.lock pnpm test' }, // a flock holder, queued 20 min before its command started
    { pid: 42, ppid: 41, args: 'pnpm test' },
    { pid: 51, ppid: 1, args: 'flock /tmp/desk-test.lock pnpm test' }, // a waiter
    { pid: 61, ppid: 1, args: 'vim notes.md' }, // a reused pid a stale flock holder file still names
  ];
  const now = Date.parse('2026-11-20T12:00:00Z');
  const ages = new Map([[11, 2530], [12, 2529], [41, 3900], [42, 2700], [51, 30], [61, 60]]);
  const stamps = new Map([[11, now - 2529000], [12, now - 2529000], [61, now - 600000]]);
  const cwds = [{ pid: 11, cwd: '/home/u/code/repo-a' }, { pid: 41, cwd: '/home/u/code/wt/B-1' }, { pid: 61, cwd: '/home/u' }];
  const runs = lockHolderRuns({ procs, holders: new Set([11, 12, 61]), cwds, ages, stamps, now });
  t('a holder is named once, not with its command beside it; a waiter and a reused pid not at all', runs.map((r) => r.pid).join(','), '11,41');
  t('its age is from its holder file, or a flock\'s command, both made once the lock is taken, not its wait', runs.map((r) => r.seconds).join(','), '2529,2700');
  // A holder that exec'd into its command (a slotted flock): its file, not its youngest subprocess.
  const execd = [{ pid: 70, ppid: 1, args: 'bash tests/run.sh' }, { pid: 71, ppid: 70, args: 'bash tests/test_x.sh' }];
  t('an exec\'d holder with subprocesses is aged from its holder file', lockHolderRuns({ procs: execd, holders: new Set([70]), cwds: [], ages: new Map([[70, 2520], [71, 5]]), stamps: new Map([[70, now - 2400000]]), now })[0]?.seconds, 2400);
  const home = process.env.HOME;
  process.env.HOME = '/home/u';
  try {
    t('each with where it runs and how long its run has gone', holdersText(runs),
      '~/code/repo-a: /bin/bash /h/.claude/desk/bin/with-lock.sh test --cwd . -- bash tests/run.sh, held 42m; ~/code/wt/B-1: flock /tmp/desk-test.lock pnpm test, held 45m');
  } finally { process.env.HOME = home; }
  t('one whose directory and age cannot be read is named by its pid', holdersText(lockHolderRuns({ procs, holders: new Set(), cwds: null, ages: null, now }).slice(0, 1)), 'pid 41: flock /tmp/desk-test.lock pnpm test, held for an unknown time');
  t('a file-named pid whose age cannot be read names nobody', lockHolderRuns({ procs, holders: new Set([11, 12]), cwds, ages: null, stamps, now }).map((r) => r.pid).join(','), '41');
  t('no holders when ps cannot be read', lockHolderRuns({ procs: null, holders: new Set(), cwds, ages, stamps, now }).length, 0);
  t('the queue line names them', lockQueue({ waiting: 2, slots: 1, factor: 2, held: runs.slice(1), counts: new Map([['b', 3]]), self: 'b' }).line, `test lock queue: 2 run(s) waiting on its 1 slot(s), at or over the hold at 1 x 2 = 2; runs by repo: b 3; this repo's share ceil(2 / 1) = 2, 3 its own; held by ${holdersText(runs.slice(1))}`);
  t('and with none held, says nothing of holders', lockQueue({ waiting: 0, slots: 1, factor: 2, counts: new Map(), self: 'b' }).line.includes('held by'), false);
  t('ps elapsed times read in seconds', [etimeSeconds('05:07'), etimeSeconds('01:00:00'), etimeSeconds('2-00:00:01'), etimeSeconds('x')].join(','), '307,3600,172801,');
  // DS-924: the light lock's holders apart from the test lock's, for a run waiting on the light lock.
  const light = [...procs, { pid: 80, ppid: 1, args: 'flock /tmp/desk-light.lock bash tests/related.sh' }, { pid: 81, ppid: 80, args: 'bash tests/related.sh' }];
  t('DS-924 a run waiting on the light lock is told its holders and not the test lock\'s',
    [lockHolderRuns({ procs: light, holders: new Set(), cwds, ages, now, locks: 'light' }).map((r) => r.pid).join(','),
      lockHolderRuns({ procs: light, holders: new Set(), cwds, ages, now }).map((r) => r.pid).join(',')].join(' '), '80 41');
  // DS-924: whether a run is already inside a slot, so tests/related.sh takes no second one.
  const { inSlot } = await import('../desk/bin/suite-wait.mjs');
  const slot = (pid, list = light) => inSlot(pid, { procs: list, holders: new Set([11, 12, 61]), ages, stamps, now });
  t('DS-924 a run a current holder file names is in its slot', slot(12), true);
  t('DS-924 a run a stale holder file names by a reused pid is not', slot(61), false);
  t('DS-924 a run a test or light flock(1) runs as its child is in its slot, though no file names it', [slot(42), slot(81)].join(','), 'true,true');
  t('DS-924 a waiting flock, a run beside the holders and an unlisted pid are not', [slot(51), slot(70, [...light, ...execd]), slot(99), inSlot(12, { procs: null, holders: new Set([12]) })].join(','), 'false,false,false,false');
}
// DS-909 AC12: with the slot kind on, a suite holds a slot lease and leaves no holder file, and the pass
// reads the worktree as it did from the holder file with the kind off.
{
  const { lockHolders, lockHolderStamps, lockHolderRuns, suiteWait } = await import('../desk/bin/suite-wait.mjs');
  const tmp = scratch('gate-leases-');
  const was = process.env.DESK_LEASE_DIR;
  process.env.DESK_LEASE_DIR = join(tmp, 'leases');
  try {
    const off = join(tmp, 'off'), on = join(tmp, 'on');
    for (const d of [off, on, process.env.DESK_LEASE_DIR]) mkdirSync(d, { recursive: true });
    writeFileSync(join(off, 'desk-test.lock.pid'), '200\n');
    const wt = '/w/T-2', now = Date.now();
    const procs = [{ pid: 200, ppid: 1, args: 'bash tests/run.sh' }, // a suite: the command with-lock.sh exec'd into
      { pid: 210, ppid: 1, args: '/bin/bash /h/.claude/desk/bin/with-lock.sh tsc --cwd . -- pnpm typecheck' }, // waits for a slot
      { pid: 211, ppid: 210, args: 'node /h/.claude/desk/bin/slot-lease.mjs take tsc --pid 210 -- pnpm typecheck' }];
    const read = (dir, list) => [String(suiteWait(wt,{ procs: list, cwds: list.map((p) => ({ pid: p.pid, cwd: wt })), holders: lockHolders(dir, { locks: 'both' }) })),
      lockHolderRuns({ procs: list, holders: lockHolders(dir), cwds: [], ages: new Map([[200, 60]]), stamps: lockHolderStamps(dir), now }).map((r) => r.pid).join(',')].join(' ');
    const lease = (key, pool, pid) => ({ id: `L-${pid}`, kind: 'slot', key, pool, units: 1, owner: { pid, start: 'x' }, label: `${key} ${wt}: bash tests/run.sh`,
      ttl: 600, acquired: new Date(now - 30_000).toISOString(), expires: new Date(now + 570_000).toISOString() });
    const kindOff = read(off, procs.slice(0, 1));
    writeFileSync(join(process.env.DESK_LEASE_DIR, 'leases.json'), JSON.stringify({ leases: [lease('test', 'slot:heavy', 200)] }));
    t('DS-909 AC12 a suite holding a slot lease reads as running its suite, as its holder file did', read(on, procs.slice(0, 1)), kindOff);
    t('DS-909 AC12 and it is that suite', kindOff, 'suite 200');
    t('DS-909 AC12 a wrapper waiting on the lease reads as waiting on the lock', suiteWait(wt, { procs: procs.slice(1), cwds: [{ pid: 210, cwd: wt }], holders: lockHolders(on, { locks: 'both' }) }), 'lock');
    writeFileSync(join(process.env.DESK_LEASE_DIR, 'leases.json'), JSON.stringify({ leases: [lease('browser', 'slot:browser', 200)] }));
    t('DS-909 AC12 a browser slot lease holds no test lock', read(on, procs.slice(0, 1)), 'null ');
    writeFileSync(join(process.env.DESK_LEASE_DIR, 'leases.json'), JSON.stringify({ leases: [lease('light', 'slot:light', 200)] }));
    t('DS-909 AC12 a light slot lease is its suite, though not a test lock holder', read(on, procs.slice(0, 1)), 'suite ');
    writeFileSync(join(process.env.DESK_LEASE_DIR, 'leases.json'), '{not json');
    t('DS-909 AC12 an unreadable store leaves the holder files read as before', read(off, procs.slice(0, 1)), kindOff);
  } finally {
    if (was === undefined) delete process.env.DESK_LEASE_DIR; else process.env.DESK_LEASE_DIR = was;
    rmSync(tmp, { recursive: true, force: true });
  }
}
// ---- #831: a §4 Known flaky checks item naming one test inside a check
{
  const row = parseFlaky(['`Integration: tests/orders.test.ts > retries a timed-out order`'.slice(1, -1), 'e2e: e2e/**', 'Unit: > no file', 'Unit: a b > two words']);
  t('#831 the per-test form parses to its check, its file as its path and its test', JSON.stringify(row.flaky[0]), JSON.stringify({ name: 'Integration', paths: ['tests/orders.test.ts'], test: { file: 'tests/orders.test.ts', title: 'retries a timed-out order' } }));
  t('#831 the whole-check form beside it is unchanged', JSON.stringify(row.flaky[1]), JSON.stringify({ name: 'e2e', paths: ['e2e/**'] }));
  t('#831 a per-test item with no file, or a file with a space, is an error', row.errors.join(' '), '`Unit: > no file` `Unit: a b > two words`');
  const whole = parseFlaky(['Run e2e tests: e2e/** playwright.config.ts', 'Lint:']);
  t('DS-869 AC1 a whole-check item reads as its check and both globs', JSON.stringify(whole.flaky), JSON.stringify([{ name: 'Run e2e tests', paths: ['e2e/**', 'playwright.config.ts'] }]));
  t('DS-869 AC2 an item with no glob is an error and waives nothing', `${whole.errors.join(' ')} ${whole.flaky.some((f) => f.name === 'Lint')}`, '`Lint:` false');
  const checks = normaliseRollup([cr('test', 'COMPLETED', 'SUCCESS', 1), cr('Integration', 'COMPLETED', 'FAILURE', 9)]);
  const listed = { path: 'tests/orders.test.ts', title: 'tests/orders.test.ts > retries a timed-out order', message: 'AssertionError: expected 200 to be 504' };
  const other = { path: 'tests/orders.test.ts', title: 'tests/orders.test.ts > totals an order', message: 'AssertionError: expected 3 to be 4' };
  const W = (notes, files = ['src/x.ts'], flaky = row.flaky.slice(0, 1)) => flakyWaiver(checks, { required: ['test'], flaky, files, notes: () => notes });
  t('#831 only the listed test failing: waived', W([listed])?.applies, true);
  t('DS-820 AC1 a waiver names the listed test it waives', JSON.stringify(W([listed])?.tests), JSON.stringify([{ check: 'Integration', file: 'tests/orders.test.ts', title: 'retries a timed-out order' }]));
  t('#831 the test as the whole title, its file as ./path, counts too', W([{ ...listed, path: './tests/orders.test.ts', title: 'retries a timed-out order' }])?.applies, true);
  t('#831 so does one after a describe path in another reporter\'s separator', W([{ ...listed, title: 'orders › retries a timed-out order' }])?.applies, true);
  t('#831 a sibling test whose name starts with the listed one is not it', W([listed, { ...listed, title: 'tests/orders.test.ts > retries a timed-out order twice' }])?.reason, 'tests');
  t('#831 nor is a test nested under it', W([{ ...listed, title: 'tests/orders.test.ts > retries a timed-out order > after a refund' }])?.reason, 'tests');
  t('#831 a message quoting the listed name names nothing', W([{ path: 'tests/orders.test.ts', title: 'tests/orders.test.ts > totals an order', message: 'expected retries a timed-out order to be called' }])?.reason, 'tests');
  t('#831 an annotation with no title names no test', W([{ path: 'tests/orders.test.ts', title: null, message: 'FAIL retries a timed-out order' }])?.reason, 'tests');
  const beside = W([listed, other]);
  t('#831 a listed test beside a failure in another test: not waived, naming it', `${beside?.applies} ${beside?.reason} ${beside?.lines}`, 'false tests tests/orders.test.ts > totals an order: AssertionError: expected 3 to be 4');
  t('#831 a longer test name holding the listed one does not count', W([{ ...listed, title: 'tests/orders.test.ts > retries a timed-out orders' }])?.reason, 'tests');
  t('#831 the listed title in another file does not count', W([{ ...listed, path: 'tests/carts.test.ts' }])?.reason, 'tests');
  const touched = W([listed], ['src/x.ts', 'tests/orders.test.ts']);
  t('#831 a PR changing the listed test\'s file: not waived', `${touched?.applies} ${touched?.reason}`, 'false paths');
  t('#831 a check with no failure annotation is never waived', W([])?.reason, 'tests');
  t('#831 annotations that could not be read: not waived', W(undefined)?.reason, 'annotations');
  t('#831 as many as GitHub keeps for a step, which may have dropped another test\'s: not waived', W(Array(10).fill(listed))?.reason, 'annotations');
  t('#831 one fewer is read as the whole list', W(Array(9).fill(listed))?.applies, true);
  t('#831 a whole-check item for the same check waives it without its annotations', W(undefined, ['src/x.ts'], [...row.flaky.slice(0, 1), { name: 'Integration', paths: ['src/integration/**'] }])?.applies, true);
  t('#831 failureNotes keeps path and title beside the line, exit-code lines aside', JSON.stringify(failureNotes([{ annotation_level: 'failure', path: 'a.ts', title: 'a > b', message: 'boom\nstack' }, { annotation_level: 'failure', message: 'Process completed with exit code 1.' }, { annotation_level: 'warning', message: 'w' }])),
    JSON.stringify([{ path: 'a.ts', title: 'a > b', message: 'boom' }]));
  const kept = checks.map((c) => (c.name === 'Integration' ? { ...c, error_notes: [listed] } : c));
  const f = { name: 'Integration', runId: '9' };
  t('#831 notesIn reads the error_notes the pass kept', JSON.stringify(notesIn(kept)(f)), JSON.stringify([listed]));
  t('#831 notesIn is undefined where a run kept none', notesIn(checks)(f), undefined);
}
{
  // DS-989 AC3 AC4: a PR's file list is read once per head SHA, and again for a new head or once it is
  // older than the cache's 30 minutes; a read that fails is not kept.
  const { prFilesAt } = await import('../desk/bin/gate.mjs');
  const { openCache, CACHE_MS } = await import('../desk/bin/read-cache.mjs');
  const path = join(scratch('gate-files-'), 'pr-files.json');
  let reads = 0, fail = false;
  const read = () => { reads++; if (fail) throw new Error('HTTP 502'); return ['a.ts', `b${reads}.ts`]; };
  const at = (now, head = 'h1') => prFilesAt({ cache: openCache(path, { now }), repo: 'Acme/Widgets', n: '7', head, read });
  const t0 = Date.parse('2026-11-22T10:00:00Z');
  const first = JSON.stringify(at(t0));
  t('DS-989 AC3 a PR\'s file list at an unchanged head is read once across loops', JSON.stringify([at(t0 + 60_000), at(t0 + CACHE_MS), reads]), JSON.stringify([JSON.parse(first), JSON.parse(first), 1]));
  t('DS-989 AC4 a new head reads afresh', JSON.stringify([at(t0 + 60_000, 'h2'), reads]), JSON.stringify([['a.ts', 'b2.ts'], 2]));
  t('DS-989 AC4 a list older than 30 minutes reads afresh', JSON.stringify([at(t0 + CACHE_MS + 1), reads]), JSON.stringify([['a.ts', 'b3.ts'], 3]));
  fail = true;
  let threw = false;
  try { at(t0 + 60_000, 'h3'); } catch { threw = true; }
  fail = false;
  t('DS-989 a failed read throws and keeps nothing, so the next loop reads again', JSON.stringify([threw, at(t0 + 60_000, 'h3').length, reads]), JSON.stringify([true, 2, 5]));
  t('DS-989 with no cache file every call reads', JSON.stringify([prFilesAt({ cache: openCache(null), repo: 'a/b', n: '7', head: 'h1', read }).length, prFilesAt({ cache: openCache(null), repo: 'a/b', n: '7', head: 'h1', read }).length, reads]), JSON.stringify([2, 2, 7]));
}
process.exit(fails ? 1 : 0);
