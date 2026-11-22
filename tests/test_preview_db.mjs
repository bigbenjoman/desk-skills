// suite: preview database (a PR adding a migration gets a database branch and preview of its own)
// covers: desk/bin/preview-db.mjs skills/desk-autopilot/references/worker-contract-stage-5.md
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRecipe, dbName, fill, shellWord, addsMigration, upCall, runUp, stepError, readRecords, writeRecord, hasPreviewDb, teardownCalls, teardown,
  errorPageLine, checkShots, setAside, runCommand, TEARDOWN_TRIES, DB_NAME_MAX, REJECTED_DIR } from '../desk/bin/preview-db.mjs';
import { previewDbStepOf, TYPES } from '../desk/bin/config-schema.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

// ---- the recipe reader ----
const RECIPE = [
  'create: neonctl branches create --name {db} --parent staging',
  'migrate: DATABASE_URL="$(neonctl cs {db})" pnpm prisma migrate deploy',
  'seed: pnpm db:seed --url "${SEED_URL}"',
  'override: ./env.sh set {branch} {db}',
  'rebuild: ./env.sh redeploy {branch} --pr {pr}',
  'delete: ./env.sh unset {branch}',
  'delete: neonctl branches delete {db}',
];
const recipe = parseRecipe(RECIPE);
t('AC1 a full recipe reads as its steps, delete keeping both its items in order', Object.fromEntries(Object.entries(recipe.steps).map(([k, v]) => [k, v.length])),
  { create: 1, migrate: 1, seed: 1, override: 1, rebuild: 1, delete: 2 });
t('AC1 a shell ${…} is the shell\'s, not a placeholder', recipe.steps.seed, ['pnpm db:seed --url "${SEED_URL}"']);
t('seed is optional', parseRecipe(RECIPE.filter((i) => !i.startsWith('seed'))).errors, undefined);
t('AC5 unset is no recipe', parseRecipe(null), null);
t('AC5 none is no recipe', parseRecipe(['none']), null);
t('a missing needed step is an error naming it', parseRecipe(RECIPE.filter((i) => !/^(delete|rebuild)/.test(i))).errors, ['no rebuild, delete step']);
t('an unknown step is an error', parseRecipe([...RECIPE, 'teardown: x']).errors?.length, 1);
t('an unknown placeholder is an error (negative control: {db} is fine)', [previewDbStepOf('create: x {name}'), previewDbStepOf('create: x {db}')?.step], [null, 'create']);
t('the config type refuses a bad item and reads a good one', [TYPES['preview-db'].parse('nope').error != null, TYPES['preview-db'].parse('delete: x {pr}').value],
  [true, { step: 'delete', cmd: 'x {pr}' }]);

// ---- the per-branch naming ----
t('AC1 the database branch is named after the PR branch', dbName('feat/DS-550-migration-pr'), 'feat-ds-550-migration-pr');
t('two branches differing only past the cut get different names', (() => {
  const a = dbName(`feat/${'x'.repeat(80)}-a`), b = dbName(`feat/${'x'.repeat(80)}-b`);
  return [a.length <= DB_NAME_MAX, b.length <= DB_NAME_MAX, a !== b];
})(), [true, true, true]);
t('a short name is not hashed (negative control)', dbName('fix/a'), 'fix-a');
t('a branch with no letter or digit has no name', dbName('///'), null);
t('a value the shell would read is quoted', [shellWord('feat/a'), shellWord("a'b;rm -rf x")], ['feat/a', "'a'\\''b;rm -rf x'"]);
t('placeholders fill, a shell ${…} stays', fill('x {branch} {db} {pr} ${branch}', { branch: 'f/a b', db: 'f-a', pr: '9' }), "x 'f/a b' f-a 9 ${branch}");

// ---- which PR adds a migration ----
t('a PR adding a migration file adds one', addsMigration('src/a.ts\nprisma/migrations/2026_x/migration.sql\n'), true);
t('a PR adding none does not (negative control)', addsMigration('src/a.ts\ndocs/migrate.md\n'), false);

// ---- the worker's up ----
const view = { headRefName: 'feat/a', state: 'OPEN', isCrossRepository: false };
const added = 'db/migrations/0001_x.sql';
const up = (over = {}) => upCall({ argv: ['feat/a', '42'], view, recipe, allowed: true, added, ...over });
t('AC1 up runs create, migrate, seed, override and rebuild in order, filled', up().plan.map((p) => `${p.step}: ${p.cmd}`), [
  'create: neonctl branches create --name feat-a --parent staging',
  'migrate: DATABASE_URL="$(neonctl cs feat-a)" pnpm prisma migrate deploy',
  'seed: pnpm db:seed --url "${SEED_URL}"',
  'override: ./env.sh set feat/a feat-a',
  'rebuild: ./env.sh redeploy feat/a --pr 42',
]);
t('AC5 no recipe: refused, so the evidence step runs as before', up({ recipe: null }).refused, 'no §4 Preview database recipe: the evidence step runs as it does without one');
t('§3 not yes: refused naming the row', up({ allowed: false }).refused, '§3 worker-preview-db is not yes');
t('another branch\'s PR is refused', up({ view: { ...view, headRefName: 'feat/b' } }).refused, 'PR #42 is not feat/a\'s own PR');
t('a closed PR is refused', up({ view: { ...view, state: 'CLOSED' } }).refused, 'PR #42 is closed');
t('a PR adding no migration is refused', up({ added: 'src/a.ts' }).refused, 'feat/a adds no migration, so its preview needs no database of its own');
t('a PR number that is not digits is refused', up({ argv: ['feat/a', '4*'] }).refused, '"4*" is not a PR number');
t('an earlier up\'s database is deleted first', up({ prior: { pr: '42', branch: 'feat/a', db: 'feat-a', steps: ['create'] } }).plan.slice(0, 3).map((p) => p.step),
  ['delete', 'delete', 'create']);

// AC1/AC4: the steps run in order and stop at the first failure, which is named and quoted.
const call = up();
const recs = [];
const ok = runUp({ call, repo: 'acme/w', run: () => ({ ok: true, code: 0, out: '' }), record: (r) => recs.push(r), now: () => 'T' });
t('AC1 every step runs and the record names them', [ok, recs.at(-1)], [{ ok: true, done: ['create', 'migrate', 'seed', 'override', 'rebuild'] },
  { pr: '42', branch: 'feat/a', db: 'feat-a', repo: 'acme/w', at: 'T', steps: ['create', 'migrate', 'seed', 'override', 'rebuild'] }]);
const recs2 = [];
const failRun = (cmd) => (cmd.includes('migrate') ? { ok: false, code: 1, out: 'Applying 0001_x\nError: P3018 relation "users" already exists\n' } : { ok: true, code: 0, out: '' });
const bad = runUp({ call, repo: 'acme/w', run: failRun, record: (r) => recs2.push(r), now: () => 'T' });
t('AC4 a failed step is named with its command and quoted error', [bad.ok, bad.step, bad.cmd, bad.error],
  [false, 'migrate', 'DATABASE_URL="$(neonctl cs feat-a)" pnpm prisma migrate deploy', 'Error: P3018 relation "users" already exists']);
t('AC4 the database is recorded before create runs and after it, so the pass still deletes it', recs2.map((r) => r.steps), [[], ['create']]);
const recs3 = [];
const none = runUp({ call, repo: 'acme/w', run: () => ({ ok: false, code: 2, out: 'boom' }), record: (r) => recs3.push(r) });
t('a create that fails part-way is still recorded, so what it made is deleted', [none.step, recs3.map((r) => [r.db, r.steps])], ['create', [['feat-a', []]]]);
const recs4 = [];
const resetCall = up({ prior: { pr: '42', branch: 'feat/a', db: 'feat-a', steps: [] } });
const reset = runUp({ call: resetCall, repo: 'acme/w', run: (c) => (c.includes('delete') ? { ok: false, code: 1, out: 'Error: branch not found' } : { ok: true, code: 0, out: '' }), record: (r) => recs4.push(r) });
t('a reset delete that finds nothing does not stop up', [reset.ok, reset.done], [true, ['create', 'migrate', 'seed', 'override', 'rebuild']]);
t('an up with no earlier record runs no reset (negative control)', up().plan.some((p) => p.step === 'delete'), false);
t('an error with no error word quotes the last lines', stepError('a\nb\nc\nd'), 'b / c / d');
t('a real command runs through sh, and its failure is read', [runCommand('echo hi', { cwd: '.', timeout: 5000 }).ok, runCommand('exit 3', { cwd: '.', timeout: 5000 }).code], [true, 3]);

// ---- the cleanup on merge and close (AC3) ----
const state = scratch('preview-db-');
writeRecord(state, { pr: '42', branch: 'feat/a', db: 'feat-a', steps: ['create'] });
writeRecord(state, { pr: '43', branch: 'feat/b', db: 'feat-b', steps: ['create'] });
writeRecord(state, { pr: '44', branch: 'feat/c', db: 'feat-c', steps: ['create'] });
const records = readRecords(state);
const acts = teardownCalls({ records, recipe, states: { 42: 'MERGED', 43: 'CLOSED', 44: 'OPEN' } });
t('AC3 a merged and a closed PR are torn down, an open one is not', acts.map((a) => [a.type, a.pr, a.why]), [['teardown', '42', '#42 merged'], ['teardown', '43', '#43 closed']]);
t('AC3 the delete steps are filled for that PR', acts[0].cmds, ['./env.sh unset feat/a', 'neonctl branches delete feat-a']);
t('a PR whose state cannot be read is left (negative control)', teardownCalls({ records, recipe, states: {} }), []);
t('a closed PR the pass still owes a reopen keeps its database and override', teardownCalls({ records, recipe, states: { 42: 'MERGED', 43: 'CLOSED' }, owed: ['43'] }).map((a) => a.pr), ['42']);
t('a merged PR is torn down even with a reopen marker left (negative control)', teardownCalls({ records, recipe, states: { 42: 'MERGED' }, owed: [42] }).map((a) => a.pr), ['42']);
t('AC2 hasPreviewDb reads the record by PR number', [hasPreviewDb(state, 43), hasPreviewDb(state, '45')], [true, false]);
const s5 = readFileSync(new URL('../skills/desk-autopilot/references/worker-contract-stage-5.md', import.meta.url), 'utf8');
t('AC2 the contract keeps a preview-database PR off the evidence workflow', /never through §4 Evidence workflow/.test(s5), true);
t('a recipe gone from the config is the person\'s', teardownCalls({ records: records.slice(0, 1), recipe: null, states: { 42: 'MERGED' } }).map((a) => [a.type, a.list]), [['report', 'failed']]);
const ran = [];
const r42 = teardown(acts[0], { state, run: (c) => { ran.push(c); return { ok: true, code: 0, out: '' }; }, now: () => 'T' });
t('AC3 both deletes ran and the record is gone', [ran, existsSync(acts[0].rec.file)], [['./env.sh unset feat/a', 'neonctl branches delete feat-a'], false]);
t('AC3 the pass logs what it removed', [r42.list, r42.line], ['done', 'removed preview database feat-a and the preview override for feat/a (#42 merged): `./env.sh unset feat/a`, `neonctl branches delete feat-a`']);
t('AC3 and removed.log holds it', JSON.parse(readFileSync(join(state, 'preview-db', 'removed.log'), 'utf8').trim()),
  { at: 'T', pr: '42', branch: 'feat/a', db: 'feat-a', why: '#42 merged', ran: ['./env.sh unset feat/a', 'neonctl branches delete feat-a'] });
// A failing delete still runs the other, keeps the record, and is the person's after the last try.
let a43 = acts[1];
const ran43 = [];
const failFirst = (c) => { ran43.push(c); return c.includes('unset') ? { ok: false, code: 1, out: 'Error: not authorised' } : { ok: true, code: 0, out: '' }; };
let r43 = teardown(a43, { state, run: failFirst });
t('a failed delete still runs the rest and is tried again', [ran43.length, r43.list, existsSync(a43.rec.file)], [2, 'advanced', true]);
for (let i = 2; i <= TEARDOWN_TRIES; i++) {
  a43 = teardownCalls({ records: readRecords(state), recipe, states: { 43: 'CLOSED' } })[0];
  r43 = teardown(a43, { state, run: failFirst });
}
t('after the last try it is the person\'s, set aside', [r43.list, existsSync(a43.rec.file), existsSync(join(state, 'preview-db', '43.failed.json'))], ['failed', false, true]);
t('a set-aside record is not read again', readRecords(state).map((r) => r.pr), ['44']);

// ---- the error-page check (AC2) ----
t('AC2 a Next.js crash page is an error page', errorPageLine('Application error: a server-side exception has occurred (see the server logs)'), 'Application error: a server-side exception has occurred (see the server logs)');
t('AC2 a missing table is an error page', errorPageLine('Invalid `prisma.user.findMany()` invocation:\nThe table `public.Thing` does not exist in the current database.') != null, true);
t('AC2 a Postgres missing column is an error page', errorPageLine('error: column "plan_id" of relation "users" does not exist') != null, true);
t('AC2 a Vercel crash is an error page', errorPageLine('500: INTERNAL_SERVER_ERROR\nCode: FUNCTION_INVOCATION_FAILED') != null, true);
t('AC2 a 404 split over two lines, as Next.js renders it, is an error page', errorPageLine('404\nThis page could not be found.'), '404 | This page could not be found.');
t('AC2 a 404 on one line is an error page', errorPageLine('404 | This page could not be found.'), '404 | This page could not be found.');
t('a 404 count beside an unrelated line is not one (negative control)', errorPageLine('Requests\n404\nEverything is fine'), null);
t('a page mentioning errors is not one (negative control)', errorPageLine('Settings\nNo errors in the last 24 hours\nEmail is required\nError rate: 0%'), null);
const shots = scratch('preview-shots-');
writeFileSync(join(shots, 'after-home.png'), 'png'); writeFileSync(join(shots, 'after-home.txt'), 'Welcome back\nYour plans');
writeFileSync(join(shots, 'after-plans.png'), 'png'); writeFileSync(join(shots, 'after-plans.txt'), 'Application error: a client-side exception has occurred');
writeFileSync(join(shots, 'before-home.png'), 'png');
const results = checkShots(shots);
t('AC2 each shot is read against its page text', results.map((r) => [r.shot, r.call]), [['after-home.png', 'ok'], ['after-plans.png', 'error'], ['before-home.png', 'no-text']]);
setAside(shots, results);
t('AC2 the error page is moved aside, so it is not posted; the good one stays', [readdirSync(shots).filter((f) => f.endsWith('.png')).sort(), readdirSync(join(shots, REJECTED_DIR)).sort()],
  [['after-home.png', 'before-home.png'], ['after-plans.png', 'after-plans.txt']]);

console.log(fails ? `FAILED: ${fails}` : 'all passed');
process.exit(fails ? 1 : 0);
