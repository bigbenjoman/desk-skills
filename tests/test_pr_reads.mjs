// suite: PR reads kept for one pass (DS-794: a pass's repeated gh pr view calls)
import { prReads, prViewOf, mayChangePr } from '../desk/bin/pr-reads.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const j = JSON.stringify;

// The shapes pass.mjs reads a PR in (readPrStatus, the undraft check, readPr, the base gate).
const view = (n, fields, ...more) => ['pr', 'view', String(n), '--repo', 'acme/w', '--json', fields, ...more];
t('a pr view is kept by repo and number', j(prViewOf(view(7, 'state,isDraft'))), j({ key: 'acme/w#7', fields: ['state', 'isDraft'], jq: null }));
t('a --jq of the one field asked for is kept', j(prViewOf(view(7, 'state', '--jq', '.state'))), j({ key: 'acme/w#7', fields: ['state'], jq: 'state' }));
t('any other --jq is not', prViewOf(view(7, 'state,isDraft', '--jq', '.state')), null);
t('a view with no --repo is not', prViewOf(['pr', 'view', '7', '--json', 'state']), null);
t('a pr list is not a view', prViewOf(['pr', 'list', '--repo', 'acme/w', '--head', 'b', '--json', 'number']), null);

t('a gh read changes no PR', [view(7, 'state'), ['pr', 'list', '--repo', 'a/b'], ['run', 'view', '1'], ['api', 'repos/a/b/pulls/7/files'], ['api', 'graphql', '-f', 'query=query { x }']].some((a) => mayChangePr('gh', a)), false);
t('a gh write may', [['pr', 'ready', '7'], ['pr', 'comment', '7'], ['pr', 'close', '7'], ['run', 'rerun', '1'], ['workflow', 'run', 'x.yml'],
  ['api', '-X', 'PATCH', 'repos/a/b/issues/comments/1'], ['api', 'graphql', '-f', 'query=mutation { resolveReviewThread }']].every((a) => mayChangePr('gh', a)), true);
t('a git push may, a git read does not', j([mayChangePr('git', ['-C', '/r', 'push', 'origin', 'b']), mayChangePr('git', ['-C', '/r', 'fetch', '-q', 'origin']), mayChangePr('git', ['rev-parse', 'HEAD'])]), j([true, false, false]));
t('a script may, desk-jira and lsof do not', j([mayChangePr('node', ['queue.mjs', 'requeue', 'A-1']), mayChangePr('desk-jira', ['get', 'A-1']), mayChangePr('lsof', ['-n'])]), j([true, false, false]));

// A pass: the status read, then reads asking for some of its fields, then a write.
const R = prReads();
const run = (args, out) => { const k = R.before('gh', args); if (k !== undefined) return { kept: true, out: k }; R.after('gh', args, out); return { kept: false, out }; };
const STATUS = 'state,isDraft,mergeStateStatus,headRefOid,statusCheckRollup';
const first = run(view(7, STATUS), j({ state: 'OPEN', isDraft: true, mergeStateStatus: 'DIRTY', headRefOid: 'abc', statusCheckRollup: [] }));
t('AC the first read runs', first.kept, false);
t('AC a later read of some of its fields is answered from it', j(run(view(7, 'state,isDraft'), 'not run')), j({ kept: true, out: j({ state: 'OPEN', isDraft: true }) }));
t('AC so is the base gate\'s --jq .state', j(run(view(7, 'state', '--jq', '.state'), 'not run')), j({ kept: true, out: 'OPEN' }));
t('a field not read yet is read', run(view(7, 'state,mergedAt'), j({ state: 'OPEN', mergedAt: null })).kept, false);
t('and is kept after', run(view(7, 'mergedAt'), 'not run').kept, true);
t('another PR is read', run(view(8, 'state'), j({ state: 'MERGED' })).kept, false);
t('another repo\'s PR of the same number is read', run(['pr', 'view', '7', '--repo', 'o/r', '--json', 'state'], j({ state: 'CLOSED' })).kept, false);
t('the body and comments are always read again', [run(view(7, 'headRefOid,body'), j({ headRefOid: 'abc', body: 'x' })), run(view(7, 'body'), j({ body: 'y' })), run(view(7, 'comments'), j({ comments: [] }))].every((x) => !x.kept), true);
t('a field the answer left out is left out from the kept read too', run(view(9, 'state,url'), j({ state: 'OPEN' })).kept || run(view(9, 'state,url'), 'not run').out, j({ state: 'OPEN' }));
t('an answer that is not JSON is not kept', run(view(10, 'state'), 'HTTP 502').kept || run(view(10, 'state'), 'again').kept, false);
t('a gh write drops what was kept', (R.before('gh', ['pr', 'ready', '7', '--repo', 'acme/w']), R.size), 0);
t('so the next read runs', run(view(7, 'state,isDraft'), j({ state: 'OPEN', isDraft: false })).kept, false);
run(view(7, 'state'), 'not run');
t('a read never drops anything', (R.before('gh', ['pr', 'list', '--repo', 'acme/w']), R.before('git', ['-C', '/r', 'fetch']), R.size), 1);
t('a push drops it', (R.before('git', ['-C', '/r', 'push', 'origin', 'b']), R.size), 0);
run(view(7, 'state'), j({ state: 'OPEN' }));
t('clear() drops it (a base sync pushes without sh)', (R.clear(), R.size), 0);

console.log(fails ? `${fails} FAILED` : 'all PR read checks passed');
process.exit(fails ? 1 : 0);
