// suite: batches (named batch slots per repo, and the batch that holds a ticket)
// desk-env's queue, state and default-branch resolution under DESK_BATCH, and batches.mjs listing and
// lookup, against fixture queues in a throwaway HOME and DESK_HOME. Each resolution runs in a child,
// because desk-env reads HOME once at load.
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
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
t('AC7 X-4 is in X-3', holding('X-4').out, 'X-3');

// A ticket is in one batch at most, and a live epic's child joins no other batch. queue.mjs
// and plan-batch.mjs run on the fixtures above, with triage records in their own state folder.
const STATE = join(T, 'triage-state');
mkdirSync(join(STATE, 'triage'), { recursive: true });
const rec = (key, extra = {}) => writeFileSync(join(STATE, 'triage', `${key}.json`),
  JSON.stringify({ ticket: key, type: 'Story', lane: 'A', size: 'S', files_in_scope: [`src/${key}.js`], unknowns: [], blockers: [], ...extra }));
const cli = (script, args, env = {}) => {
  const r = spawnSync('node', [join(BIN, script), ...args], { encoding: 'utf8', env: { ...base, DESK_AUTOPILOT_STATE: STATE, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const read = (path) => readFileSync(path, 'utf8');
rec('X-2'); rec('S-1'); rec('C-1', { epic: { key: 'X-3', summary: 'a feature' } }); rec('N-1');

let before = read(standingQ);
let r = cli('queue.mjs', ['admit', 'X-2']);
t('DS-307 AC1 the standing batch refuses a key in X-1', r.code !== 0 && r.out.includes('X-2 is in batch X-1'), true);
t('DS-307 AC1 the standing queue is unchanged', read(standingQ), before);
r = cli('queue.mjs', ['add', 'X-2']);
t('DS-307 add refuses it too', r.code !== 0 && r.out.includes('X-2 is in batch X-1') && read(standingQ) === before, true);
before = read(namedQ('X-1'));
r = cli('queue.mjs', ['admit', 'S-1'], { DESK_BATCH: 'X-1' });
t('DS-307 a named batch refuses a key in the standing batch', r.code !== 0 && r.out.includes('S-1 is in the standing batch') && read(namedQ('X-1')) === before, true);

before = read(standingQ);
r = cli('queue.mjs', ['admit', 'C-1']);
t('DS-307 AC4 a live epic\'s child is refused naming its feature batch', r.code !== 0 && r.out.includes('C-1 is a child of epic X-3, whose feature batch X-3 is running'), true);
t('DS-307 AC4 the standing queue is unchanged', read(standingQ), before);
r = cli('queue.mjs', ['admit', 'C-1'], { DESK_BATCH: 'X-3' });
t('DS-307 the child is not refused by its own feature batch', r.code === 0 && JSON.parse(read(namedQ('X-3'))).tickets['C-1']?.state, 'triaged');

r = cli('queue.mjs', ['admit', 'N-1']);
t('DS-307 AC6 a ticket in no other batch is admitted as before', r.code === 0 && JSON.parse(read(standingQ)).tickets['N-1']?.state, 'triaged');

// plan-batch seeds only with AUTOPILOT_WRITE_QUEUE set and an owner to admit for, so the seeding is real.
// It seeds through DESK_HOME's bin.
symlinkSync(BIN, join(DESK_HOME, 'bin'));
const seedConfig = join(T, 'seed-config.md');
writeFileSync(seedConfig, `${read(config)}\n## 1. Who you are\n\n| Field | Value |\n|---|---|\n| GitHub handle | \`me\` |\n| Jira display name | \`Me\` |\n\n## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Tracker | \`jira\` |\n| Ticket key pattern | \`[A-Z]+-[0-9]+\` |\n| Local database | \`none\` |\n`);
const seed = (keys) => cli('plan-batch.mjs', keys, { DESK_CONFIG: seedConfig, AUTOPILOT_WRITE_QUEUE: '1' });
before = read(standingQ);
r = seed(['X-2']);
t('DS-307 AC5 a plan seeding a key another batch holds is refused naming it', r.code !== 0 && r.out.includes('X-2 is in batch X-1'), true);
t('DS-307 AC5 nothing was seeded', read(standingQ), before);
rec('P-1');
r = seed(['P-1']);
t('DS-307 AC5 the same plan seeds a key no other batch holds', JSON.parse(read(standingQ)).tickets['P-1']?.state, 'triaged');

// A finished batch (every ticket done) is still listed, since nothing archives it, but holds nothing.
mkdirSync(dirname(namedQ('F-1')), { recursive: true });
writeFileSync(namedQ('F-1'), JSON.stringify({ version: 1, batch: 'F-1', tickets: { 'F-2': { key: 'F-2', state: 'done' } } }));
rec('F-2'); rec('F-3', { epic: { key: 'F-1', summary: 'a shipped feature' } });
r = cli('queue.mjs', ['admit', 'F-2']);
t('DS-307 a done ticket in a finished batch may join another', r.code === 0 && JSON.parse(read(standingQ)).tickets['F-2']?.state, 'triaged');
r = cli('queue.mjs', ['admit', 'F-3']);
t('DS-307 a child of an epic whose feature batch finished is admitted', r.code === 0 && JSON.parse(read(standingQ)).tickets['F-3']?.state, 'triaged');
// A feature batch on a base still has its promotion to come, so it holds its epic's children.
mkdirSync(dirname(namedQ('G-1')), { recursive: true });
writeFileSync(namedQ('G-1'), JSON.stringify({ version: 1, batch: 'G-1', base: 'feat/g', tickets: { 'G-2': { key: 'G-2', state: 'done' } } }));
rec('G-3', { epic: { key: 'G-1', summary: 'a feature awaiting promotion' } });
before = read(standingQ);
r = cli('queue.mjs', ['admit', 'G-3']);
t('DS-307 a feature batch done but unpromoted keeps its epic\'s child', r.code !== 0 && r.out.includes('G-3 is a child of epic G-1') && read(standingQ) === before, true);

// Another batch's queue that cannot be read refuses the key naming it, never a crash.
mkdirSync(dirname(namedQ('Z-1')), { recursive: true });
writeFileSync(namedQ('Z-1'), '{ not json');
before = read(standingQ);
rec('Z-2');
r = cli('queue.mjs', ['admit', 'Z-2']);
t('DS-307 an unreadable batch refuses the key, naming that batch', r.code !== 0 && r.out.includes('Z-2 cannot be checked against batch Z-1') && read(standingQ) === before, true);
const away = run({}, "console.log(JSON.stringify(B.belongsElsewhere('Z-2')))");
t('DS-307 belongsElsewhere returns it rather than throwing', away.code === 0 && json(away).unreadable, true);

// `--batch <name>` on a command names its batch as DESK_BATCH does.
const qcli = (args, env = {}) => {
  const r = spawnSync('node', [join(BIN, 'queue.mjs'), ...args], { encoding: 'utf8', env: { ...base, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const x1Render = qcli(['render'], { DESK_BATCH: 'X-1' });
t('DS-303 AC1 DESK_BATCH=X-1 renders X-1', x1Render.code === 0 && x1Render.out.includes('X-2') && !x1Render.out.includes('S-1'), true);
for (const args of [['render', '--batch', 'X-1'], ['--batch', 'X-1', 'render'], ['render', '--batch=X-1']]) {
  t(`DS-303 AC1 queue.mjs ${args.join(' ')} renders X-1's queue`, qcli(args).out, x1Render.out);
}
t('DS-303 AC1 no --batch still renders the standing queue', qcli(['render']).out.includes('S-1'), true);
t('DS-303 AC1 the same name both ways is fine', qcli(['render', '--batch', 'X-1'], { DESK_BATCH: 'X-1' }).out, x1Render.out);
const setOut = qcli(['--batch', 'X-3', 'set', 'X-4', 'note=hi']);
t('DS-303 AC1 the other arguments parse as before', setOut.code === 0 && JSON.parse(readFileSync(namedQ('X-3'), 'utf8')).tickets['X-4'].note, 'hi');
t('DS-303 AC1 an unsafe --batch is refused as DESK_BATCH is', qcli(['render', '--batch', '../x']).code, 4);
t('DS-303 AC1 --batch with no name is refused', qcli(['render', '--batch']).code, 4);

// AC2: two names, one each way or two flags, exit naming both and write nothing (init would write a queue).
for (const [why, args, env, names] of [
  ['DESK_BATCH and --batch', ['init', 'b', '--batch', 'NEW-2'], { DESK_BATCH: 'NEW-1' }, ['NEW-1', 'NEW-2']],
  ['two --batch flags', ['--batch', 'NEW-1', 'init', 'b', '--batch=NEW-2'], {}, ['NEW-1', 'NEW-2']],
]) {
  const before = readdirSync(join(DESK_HOME, 'repos', SLUG, 'batches')).sort().join(',');
  const r = qcli(args, env);
  t(`DS-303 AC2 ${why}: config error exit`, r.code, 4);
  t(`DS-303 AC2 ${why}: names both`, names.every((n) => r.err.includes(`"${n}"`)), true);
  t(`DS-303 AC2 ${why}: writes nothing`, readdirSync(join(DESK_HOME, 'repos', SLUG, 'batches')).sort().join(','), before);
}

// The shell side: desk_take_batch takes --batch out of a script's arguments and exports it.
const ENV_SH = join(BIN, 'desk-env.sh');
const sh = (args, env = {}) => {
  const src = `. '${ENV_SH}' || exit 9; desk_take_batch "$@" || exit $?; set -- \${DESK_ARGS[@]+"\${DESK_ARGS[@]}"}; desk_load_paths || exit 8; printf '%s|%s|%s\\n' "$DESK_BATCH" "$DESK_QUEUE" "$*"`;
  const r = spawnSync('bash', ['-c', src, 'sh', ...args], { encoding: 'utf8', env: { ...base, DESK_REPO_ROOT: T, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
t('DS-303 shell --batch is taken out and exported', sh(['--for-worker', '--batch', 'X-1', 'T-1', 'fix/T-1']).out, `X-1|${namedQ('X-1')}|--for-worker T-1 fix/T-1`);
t('DS-303 shell --batch=<name> too', sh(['T-1', '--batch=X-1']).out, `X-1|${namedQ('X-1')}|T-1`);
t('DS-303 shell arguments after -- are left alone', sh(['T-1', '--', '--batch', 'X-1']).out, `|${standingQ}|T-1 -- --batch X-1`);
t('DS-303 shell no --batch keeps the standing batch', sh(['T-1']).out, `|${standingQ}|T-1`);
t('DS-303 shell other arguments keep their spaces and quotes', sh(["it's a", '--batch', 'X-1', '$HOME']).out, `X-1|${namedQ('X-1')}|it's a $HOME`);
const shBoth = sh(['--batch', 'B'], { DESK_BATCH: 'A' });
t('DS-303 AC2 shell DESK_BATCH and --batch: refused', shBoth.code, 4);
t('DS-303 AC2 shell names both', shBoth.err.includes('"A"') && shBoth.err.includes('"B"'), true);
t('DS-303 shell --batch with no name is refused', sh(['T-1', '--batch']).code, 4);

// AC3, the merge driver: `--batch X-1` writes its log in X-1's state folder, not the standing one.
const mdConfig = join(T, 'config-md.md');
writeFileSync(mdConfig, '## 0. Repo\n\n| Field | Value |\n|---|---|\n| Default branch | `main` |\n\n## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Tracker | `jira` |\n| Ticket key pattern | `X-[0-9]+` |\n');
const md = spawnSync('bash', [join(BIN, 'merge-driver.sh'), '--tickets', 'X-2', '--batch', 'X-1', '--log'], { encoding: 'utf8', env: { ...base, DESK_CONFIG: mdConfig, DESK_REPO_ROOT: T } });
const mdLog = (dir) => { try { return readFileSync(join(dir, 'merge-driver.log'), 'utf8'); } catch { return null; } };
t('DS-303 AC3 merge-driver.sh --batch X-1 logs to X-1 state', /merge driver exited/.test(mdLog(namedS('X-1')) ?? ''), true);
t('DS-303 AC3 and not to the standing state', mdLog(standingS), null);
t('DS-303 AC3 merge-driver.sh takes its other arguments as before', md.status, 1);

// A command about one ticket acts on the batch that holds it: answer.mjs, closeout.mjs, queue.mjs's
// ticket subcommands and spine-review.mjs, with no batch named and no explicit queue or state path.
const ticketCli = (script, args, env = {}) => {
  const r = spawnSync('node', [join(BIN, script), ...args], { encoding: 'utf8', env: { ...base, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const has = (path) => { try { readFileSync(path); return true; } catch { return false; } };
mkdirSync(dirname(namedQ('Y-1')), { recursive: true });
writeFileSync(namedQ('Y-1'), JSON.stringify({ version: 1, batch: 'Y-1', tickets: {
  'Y-2': { key: 'Y-2', state: 'triaged', open_questions: 1 },
  'Y-3': { key: 'Y-3', state: 'running' },
  'Y-4': { key: 'Y-4', state: 'triaged' },
} }));
const y1 = () => JSON.parse(read(namedQ('Y-1'))).tickets;

// A batch whose queue cannot be read may be the one holding the key, so the command refuses naming it.
r = ticketCli('answer.mjs', ['Y-2', 'too soon']);
t('DS-304 an unreadable batch refuses the answer, naming its queue', r.code !== 0 && r.out.includes(namedQ('Z-1')) && !has(join(standingS, 'briefings', 'Y-2.md')) && !has(join(namedS('Y-1'), 'briefings', 'Y-2.md')), true);
writeFileSync(namedQ('Z-1'), JSON.stringify({ version: 1, batch: 'Z-1', tickets: {} }));

r = ticketCli('answer.mjs', ['Y-2', 'use the blue one']);
t('DS-304 AC1 an answer for Y-2 goes to Y-1\'s state', r.code === 0 && read(join(namedS('Y-1'), 'briefings', 'Y-2.md')).includes('use the blue one'), true);
t('DS-304 AC1 and not the standing batch\'s', has(join(standingS, 'briefings', 'Y-2.md')), false);
t('DS-304 AC1 Y-1\'s queue shows Y-2 answered', y1()['Y-2'].open_questions, 0);
r = ticketCli('closeout.mjs', ['Y-3', '--pr', '7']);
t('DS-304 AC1 a close-out for Y-3 is noted in Y-1\'s state', r.code === 0 && JSON.parse(read(join(namedS('Y-1'), 'closed-out', 'Y-3.json'))).queue, namedQ('Y-1'));
r = ticketCli('queue.mjs', ['set', 'Y-4', 'note=found']);
t('DS-304 AC1 queue.mjs set acts on Y-1', r.code === 0 && y1()['Y-4'].note, 'found');
t('DS-304 AC1 queue.mjs get reads Y-1', JSON.parse(ticketCli('queue.mjs', ['get', 'Y-4']).out).note, 'found');

r = ticketCli('answer.mjs', ['S-1', 'standing answer']);
t('DS-304 AC2 a standing ticket\'s answer is stored as today', r.code === 0 && read(join(standingS, 'briefings', 'S-1.md')).includes('standing answer'), true);
r = ticketCli('closeout.mjs', ['S-1']);
t('DS-304 AC2 a standing ticket\'s close-out is stored as today', r.code === 0 && JSON.parse(read(join(standingS, 'closed-out', 'S-1.json'))).queue, standingQ);

const queues = () => [standingQ, namedQ('X-1')].map(read).join('\n');
const qBefore = queues();
for (const [script, args] of [['answer.mjs', ['DUP-1', 'an answer']], ['closeout.mjs', ['DUP-1']], ['queue.mjs', ['set', 'DUP-1', 'note=x']]]) {
  r = ticketCli(script, args);
  t(`DS-304 AC3 ${script} for a key in two batches exits naming both`, r.code !== 0 && /the standing batch, X-1/.test(r.out), true);
}
t('DS-304 AC3 no queue was written', queues(), qBefore);
t('DS-304 AC3 no briefing or close-out was written', [standingS, namedS('X-1')].some((d) => has(join(d, 'briefings', 'DUP-1.md')) || has(join(d, 'closed-out', 'DUP-1.json'))), false);

r = ticketCli('answer.mjs', ['--batch', 'X-3', 'Y-4', 'flagged']);
t('DS-304 AC4 --batch wins: the answer goes to X-3', r.code === 0 && has(join(namedS('X-3'), 'briefings', 'Y-4.md')) && !has(join(namedS('Y-1'), 'briefings', 'Y-4.md')), true);
const y1Before = read(namedQ('Y-1'));
r = ticketCli('queue.mjs', ['set', 'Y-4', 'note=env'], { DESK_BATCH: 'X-3' });
t('DS-304 AC4 DESK_BATCH wins: Y-4 is not looked up', r.code !== 0 && read(namedQ('Y-1')) === y1Before, true);
r = ticketCli('queue.mjs', ['set', 'Y-4', 'note=path'], { DESK_QUEUE: standingQ });
t('DS-304 AC4 an explicit DESK_QUEUE wins too', r.code !== 0 && read(namedQ('Y-1')) === y1Before, true);

r = ticketCli('answer.mjs', ['NOPE-1', 'later']);
t('DS-304 AC5 a ticket in no batch is answered in the standing state', r.code === 0 && r.out.includes('not in the queue yet') && has(join(standingS, 'briefings', 'NOPE-1.md')), true);
r = ticketCli('closeout.mjs', ['NOPE-1']);
t('DS-304 AC5 a ticket in no batch writes no close-out', r.code === 0 && r.out === '' && !has(join(standingS, 'closed-out', 'NOPE-1.json')), true);

// spine-review reads the spine's own feature batch: past its spine check, to the config's missing spec directory.
mkdirSync(dirname(namedQ('S-5')), { recursive: true });
writeFileSync(namedQ('S-5'), JSON.stringify({ version: 1, batch: 'S-5', feature: true, spine: 'S-6', tickets: { 'S-6': { key: 'S-6', state: 'parked' } } }));
r = ticketCli('spine-review.mjs', ['brief', 'S-6']);
t('DS-304 spine-review finds the spine in its feature batch', r.out.includes('S-6: config §4 Acceptance specs names no spec directory'), true);

if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
