import { evaluateGate, normaliseRollup, parseHolds, matchHolds, keyChanged, readKeyedFiles, globToRegExp, latestPerCheck } from '../desk/bin/gate.mjs';
import { collectAnswers, ANSWER_HEAD, SIBLING_HEAD } from '../desk/bin/briefing.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const cr = (name, status, conclusion, runId) => ({ name, status, conclusion, detailsUrl: runId ? `https://github.com/o/r/actions/runs/${runId}/job/1` : '' });
const req = ['Lint, Type Check & Build', 'Verify script sign-off'];
const G = (nodes, o = {}) => evaluateGate(normaliseRollup(nodes), { required: req, ...o });
t('all required success', G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SUCCESS')]).state, 'pass');
t('required skipped', G([cr(req[0], 'COMPLETED', 'SUCCESS'), cr(req[1], 'COMPLETED', 'SKIPPED')]).state, 'fail');
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
process.exit(fails ? 1 : 0);
