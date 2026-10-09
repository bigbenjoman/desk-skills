import { evaluateGate, normaliseRollup, parseHolds, matchHolds, globToRegExp, latestPerCheck } from '../desk/bin/gate.mjs';
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
