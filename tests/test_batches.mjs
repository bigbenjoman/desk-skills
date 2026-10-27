// suite: batches (named batch slots per repo, and the batch that holds a ticket)
// desk-env's queue, state and default-branch resolution under DESK_BATCH, and batches.mjs listing and
// lookup, against fixture queues in a throwaway HOME and DESK_HOME. Each resolution runs in a child,
// because desk-env reads HOME once at load.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const T = mkdtempSync(join(tmpdir(), 'desk-batches-'));
const HOME = join(T, 'home');
const DESK_HOME = join(T, 'deskhome');
const SLUG = 'acme__widgets';
mkdirSync(HOME, { recursive: true });
const config = join(T, 'config.md');
writeFileSync(config, '## 0. Repo\n\n| Field | Value |\n|---|---|\n| Default branch | `main` |\n');

const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|AUTOPILOT_)/.test(k)));
Object.assign(base, { HOME, DESK_HOME, DESK_CONFIG: config, DESK_REPO_OVERRIDE: 'acme/widgets', DESK_MACHINE: join(T, 'none.md') });

// Runs `code` with desk-env imported as E and batches.mjs as B; -> { code, out, err }.
function run(env, code) {
  const src = `import * as E from '${join(BIN, 'desk-env.mjs')}'; import * as B from '${join(BIN, 'batches.mjs')}'; ${code}`;
  const r = spawnSync('node', ['--input-type=module', '-e', src], { encoding: 'utf8', env: { ...base, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const paths = (env) => run(env, 'console.log(JSON.stringify({ q: E.queueFile(), s: E.stateDir() }))');
const json = (r) => { try { return JSON.parse(r.out); } catch { return { err: r.err }; } };

const standingQ = join(DESK_HOME, 'repos', SLUG, 'queue.json');
const standingS = join(HOME, '.desk-autopilot', SLUG);
const namedQ = (n) => join(DESK_HOME, 'repos', SLUG, 'batches', n, 'queue.json');
const namedS = (n) => join(HOME, '.desk-autopilot', SLUG, 'batches', n);

// AC1: no batch named, today's paths and branch.
for (const [why, env] of [['unset', {}], ['empty', { DESK_BATCH: '' }]]) {
  const p = json(paths(env));
  t(`AC1 DESK_BATCH ${why}: queue`, p.q, standingQ);
  t(`AC1 DESK_BATCH ${why}: state`, p.s, standingS);
}
t('AC1 no batch: default branch from config', run({}, 'console.log(E.defaultBranch())').out, 'main');

// AC2: a named batch nests under the repo's own folders.
const x1 = json(paths({ DESK_BATCH: 'X-1' }));
t('AC2 X-1 queue', x1.q, namedQ('X-1'));
t('AC2 X-1 state', x1.s, namedS('X-1'));

// AC3: an explicit path wins over the batch.
const own = json(paths({ DESK_BATCH: 'X-1', DESK_QUEUE: join(T, 'q.json'), DESK_AUTOPILOT_STATE: join(T, 'st') }));
t('AC3 explicit DESK_QUEUE wins', own.q, join(T, 'q.json'));
t('AC3 explicit DESK_AUTOPILOT_STATE wins', own.s, join(T, 'st'));
const half = json(paths({ DESK_BATCH: 'X-1', DESK_QUEUE: join(T, 'q.json') }));
t('AC3 only the explicit one is overridden', `${half.q} ${half.s}`, `${join(T, 'q.json')} ${namedS('X-1')}`);

// AC4: an unsafe name is a config error naming it, before any file is touched. The script is
// queue.mjs init, which would otherwise write a queue.
for (const bad of ['../x', 'x/y', '.hidden', 'a..b', 'x y']) {
  const before = readdirSync(T).sort().join(',');
  const r = spawnSync('node', [join(BIN, 'queue.mjs'), 'init', 'b'], { encoding: 'utf8', env: { ...base, DESK_BATCH: bad } });
  t(`AC4 DESK_BATCH=${bad}: config error exit`, r.status, 4);
  t(`AC4 DESK_BATCH=${bad}: names the value`, r.stderr.includes(`"${bad}"`), true);
  t(`AC4 DESK_BATCH=${bad}: touches no file`, readdirSync(T).sort().join(','), before);
}
t('AC4 desk-env paths refuses too', spawnSync('node', [join(BIN, 'desk-env.mjs'), 'paths'], { encoding: 'utf8', env: { ...base, DESK_BATCH: '../x' } }).status, 4);

// AC5 and AC7 fixtures: a standing queue, X-1 and X-3 batches, an archived batch, and a stray
// directory with no queue.
const queue = (path, tickets, extra = {}) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, batch: 'b', tickets: Object.fromEntries(tickets.map((k) => [k, { key: k, state: 'ready' }])), ...extra }));
};
queue(standingQ, ['S-1', 'DUP-1']);
queue(namedQ('X-1'), ['X-2', 'DUP-1'], { base: 'feat/x' });
queue(namedQ('X-3'), ['X-4']);
queue(join(DESK_HOME, 'repos', SLUG, 'batches', '.done', 'X-0', 'queue.json'), ['OLD-1']);
queue(join(DESK_HOME, 'repos', SLUG, 'batches', '.done', 'queue.json'), ['OLD-2']);
mkdirSync(join(DESK_HOME, 'repos', SLUG, 'batches', 'empty'), { recursive: true });

const list = run({}, "console.log(B.listBatches().map((b) => b.name ?? '-').join(' '))");
t('AC5 standing first, then named, archived left out', list.out, '- X-1 X-3');
const listed = json(run({}, 'console.log(JSON.stringify(B.listBatches()[1]))'));
t('AC5 a named batch lists its queue and state', `${listed.queue} ${listed.state}`, `${namedQ('X-1')} ${namedS('X-1')}`);
t('AC5 listing ignores DESK_BATCH', run({ DESK_BATCH: 'X-1' }, "console.log(B.listBatches().map((b) => b.name ?? '-').join(' '))").out, '- X-1 X-3');

// AC6: a named batch's base is the default branch; an exported DESK_DEFAULT_BRANCH still wins.
t('AC6 X-1 default branch is its base', run({ DESK_BATCH: 'X-1' }, 'console.log(E.defaultBranch())').out, 'feat/x');
t('AC6 desk-env get default-branch agrees',
  spawnSync('node', [join(BIN, 'desk-env.mjs'), 'get', 'default-branch'], { encoding: 'utf8', env: { ...base, DESK_BATCH: 'X-1' } }).stdout.trim(), 'feat/x');
t('AC6 a batch with no base keeps the config', run({ DESK_BATCH: 'X-3' }, 'console.log(E.defaultBranch())').out, 'main');
t('AC6 exported DESK_DEFAULT_BRANCH wins', run({ DESK_BATCH: 'X-1', DESK_DEFAULT_BRANCH: 'other' }, 'console.log(E.defaultBranch())').out, 'other');
t('AC6 the standing batch never reads the queue base', run({}, 'console.log(E.defaultBranch())').out, 'main');

// AC7: the batch holding a key.
const holding = (key) => run({}, `const b = B.batchHolding('${key}'); console.log(b ? (b.name ?? '-') : 'none')`);
t('AC7 X-2 is in X-1', holding('X-2').out, 'X-1');
t('AC7 S-1 is in the standing batch', holding('S-1').out, '-');
t('AC7 a key in no batch', holding('NOPE-1').out, 'none');
t('AC7 an archived batch does not hold its keys', holding('OLD-1').out, 'none');
const dup = holding('DUP-1');
t('AC7 a key in two batches fails', dup.code !== 0, true);
t('AC7 the failure names both', /the standing batch, X-1/.test(dup.err), true);
const cli = spawnSync('node', [join(BIN, 'batches.mjs'), 'holding', 'X-4'], { encoding: 'utf8', env: base });
t('AC7 CLI holding', `${cli.status} ${cli.stdout.trim()}`, '0 X-3');
t('AC7 CLI no batch exits 3', spawnSync('node', [join(BIN, 'batches.mjs'), 'holding', 'NOPE-1'], { encoding: 'utf8', env: base }).status, 3);

if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
