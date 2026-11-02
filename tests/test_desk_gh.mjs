// suite: desk-gh (the read-only gh api a worker may run)
// covers: desk/bin/desk-gh.mjs
// desk-gh read runs `gh api` only when its arguments cannot write: a GraphQL query, or a REST GET.
// A mutation, a non-GET method, --input, a file field or an unknown flag is refused with exit 1 and
// never reaches gh. A fake gh on PATH records what it was run with. Scratch directory only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeKeyword } from '../desk/bin/desk-gh.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'desk', 'bin', 'desk-gh.mjs');
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const T = mkdtempSync(join(tmpdir(), 'desk-gh-'));
const log = join(T, 'gh.log');
writeFileSync(join(T, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\necho '{"data":{}}'\n`);
chmodSync(join(T, 'gh'), 0o755);
const run = (...args) => {
  rmSync(log, { force: true });
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${T}:${process.env.PATH}` } });
  return { status: r.status, ran: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : null, err: r.stderr };
};

// AC5: a GraphQL query runs, as gh api with the arguments untouched.
const q = 'query($n: Int!) { repository(owner: "a", name: "b") { pullRequest(number: $n) { reviewThreads(first: 50) { nodes { isResolved } } } } }';
let r = run('read', 'graphql', '-f', `query=${q}`, '-F', 'n=12');
t('AC5 a graphql query runs', r.status, 0);
t('AC5 gh api gets the arguments as given', r.ran, ['api', 'graphql', '-f', `query=${q}`, '-F', 'n=12']);
t('AC5 the anonymous shorthand is a query', run('read', 'graphql', '-f', 'query={ viewer { login } }').status, 0);
t('AC5 a REST GET runs', run('read', 'repos/a/b/pulls/12/comments', '--paginate', '--jq', '.[].body').status, 0);
t('AC5 REST fields with -X GET run', run('read', '-X', 'GET', 'search/issues', '-f', 'q=repo:a/b is:open').status, 0);

// AC5: a mutation or a non-GET method is refused with exit 1, and gh never runs.
const refused = (name, ...args) => { const x = run('read', ...args); t(`AC5 refused: ${name}`, [x.status, x.ran, /refused/.test(x.err)], [1, null, true]); };
refused('a mutation', 'graphql', '-f', 'query=mutation { resolveReviewThread(input: {threadId: "x"}) { thread { id } } }');
refused('a named mutation after a comment', 'graphql', '-f', 'query=# read\nmutation M { addComment(input: {}) { clientMutationId } }');
refused('a mutation beside a query', 'graphql', '-f', 'query=query A { viewer { login } } mutation B { x }');
refused('a subscription', 'graphql', '-f', 'query=subscription { x }');
refused('-X POST', '-X', 'POST', 'repos/a/b/issues');
refused('--method=DELETE', '--method=DELETE', 'repos/a/b');
refused('-X PATCH on graphql', 'graphql', '-X', 'PATCH', '-f', 'query={ viewer { login } }');
refused('REST fields without -X GET (gh would POST)', 'repos/a/b/issues', '-f', 'title=x');
refused('--input', 'graphql', '--input', 'q.json');
refused('a field read from a file', 'graphql', '-F', 'query=@q.graphql');
refused('a method-override header', 'repos/a/b', '-H', 'X-HTTP-Method-Override: DELETE');
refused('an unknown flag', 'repos/a/b', '--verbose');
refused('graphql by a URL', 'https://api.github.com/graphql', '-f', 'query={ viewer { login } }');
refused('graphql with no query', 'graphql');
t('usage: anything but read is exit 2', run('graphql', '-f', 'query=x').status, 2);

// The keyword is refused wherever it stands: a comment or string GitHub's parser ends earlier than a
// scanner would cannot hide it.
refused('a mutation after a comment ended by a carriage return', 'graphql', '-f', 'query=# read\rmutation B { addStar(input: {}) { clientMutationId } }');
refused('a mutation after an escaped block-string quote', 'graphql', '-f',
  'query=query Q { node(id: """x\\""" y""") { id } } mutation M { deleteIssue(input: {}) { clientMutationId } }', '-f', 'operationName=M');
refused('the word inside a string argument', 'graphql', '-f', 'query={ search(query: "mutation {", type: ISSUE, first: 1) { issueCount } }');
t('a longer name holding the word is not the keyword', writeKeyword('{ viewer { mutationsAllowed: login } }'), null);
t('a subscription is found by name', writeKeyword('subscription { x }'), 'subscription');

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'desk-gh: all checks passed');
process.exit(fails ? 1 : 0);
