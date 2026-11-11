// suite: live-read (§4 Live reads: which parks the pass runs a read for, and how it records one)
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLiveReads, liveReadPark, readRecord, startRead, saveFixture, prepareCheckout, copyFixtures, repoStateOf, WORKTREE_FIXTURES } from '../desk/bin/live-read.mjs';
import { waitingOnRead, batchSettled } from '../desk/bin/batch-state.mjs';
import { shownState } from '../desk/bin/desk-q.mjs';
import { describeCond } from '../desk/bin/clears-when.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const row = parseLiveReads(['gateway-models: ./scripts/fetch-models.sh staging','numbers.v2: ./fetch numbers', '../x: cat /etc/passwd', 'no command']);
t('the row parses name: command items', row.reads.map((r) => r.name).join(' '), 'gateway-models numbers.v2');
t('a name that holds a path, or an item with no command, is an error', row.errors.length, 2);
const reads = row.reads;
const names = (q) => liveReadPark(q, reads)?.map((r) => r.name).join(' ') ?? null;

t('a park naming one entry and the not-reached tail asks for it',
  names('Need live read gateway-models for the recorded payload. Not reached: the PR, the Jira comment and the transition'), 'gateway-models');
t('two entries in one park ask for both', names('Need gateway-models and numbers.v2 run on the host.'), 'gateway-models numbers.v2');
t('a name matches whatever its case', names('Need GATEWAY-MODELS.'), 'gateway-models');
t('a name inside a longer word is not that entry', names('Need gateway-models-v2.'), null);
const dotted = parseLiveReads(['gateway: ./g', 'gateway.models: ./gm', 'models: ./m']).reads;
t('a dotted name is not also a shorter entry it starts or ends with',
  liveReadPark('Need gateway.models.', dotted)?.map((r) => r.name).join(' '), 'gateway.models');
t('while a full stop after a name still ends it', liveReadPark('Need gateway.', dotted)?.map((r) => r.name).join(' '), 'gateway');
t('a park naming no entry is left as it is', names('Which price should the plan show? Not reached: the PR'), null);
t('a question beside the entry is left for the person', names('Need gateway-models. Should the fallback model be gw-2?'), null);
t('a tail clause holding an ask is not the tail', names('Need gateway-models. Not reached: the PR, so confirm the fee'), null);
t('no entries in the row asks for nothing', liveReadPark('Need gateway-models.', []), null);

const dir = mkdtempSync(join(tmpdir(), 'desk-live-read-'));
const head = 'c'.repeat(40);
const wait = async (name) => { for (let i = 0; i < 100 && readRecord(dir, 'L-1', head, name)?.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 50)); return readRecord(dir, 'L-1', head, name); };
t('no read started at a head has no record', readRecord(dir, 'L-1', head, 'ok'), null);
startRead(dir, { key: 'L-1', head, name: 'ok', command: 'echo "{\\"a\\":1}"; echo noise >&2', cwd: dir });
startRead(dir, { key: 'L-1', head, name: 'bad', command: 'echo partial; echo "AccessDenied: no key" >&2; echo "at line 3" >&2; exit 2', cwd: dir });
const ok = await wait('ok');
const bad = await wait('bad');
t('a read that exits 0 records code 0', ok?.code, 0);
t('a failed read records its exit code', bad?.code, 2);
t('and its last error line, from stderr', bad?.error, 'at line 3');
const fx = join(dir, 'fixtures');
const saved = saveFixture(fx, 'L-1', 'ok', ok.out);
t('a saved fixture is <fixtures>/<KEY>/<name>.json, holding stdout only', `${saved === join(fx, 'L-1', 'ok.json')} ${readFileSync(saved, 'utf8').trim()}`, 'true {"a":1}');
t('a failed read saves nothing by itself', existsSync(join(fx, 'L-1', 'bad.json')), false);

const parked = { key: 'L-1', state: 'parked', park: { question: 'Need gateway-models.', clears_when: { kind: 'live-read', reads: ['gateway-models'], head } } };
const other = { key: 'L-2', state: 'parked', park: { question: 'Which price?', clears_when: { kind: 'none' } } };
t('a park on its live reads waits on the pass', waitingOnRead(parked), true);
t('any other park does not', waitingOnRead(other), false);
t('desk-q shows it waiting while passes run', shownState({ tickets: { 'L-1': parked } }, parked, { live: true }), 'waiting');
t('and needing the person with passes stopped, since nothing runs it', shownState({ tickets: { 'L-1': parked } }, parked, { live: false }), 'needs');
t('a batch with a park on its live reads is not settled', batchSettled({ tickets: { 'L-1': parked, 'L-2': other } }, () => null), false);
t('the condition reads as the reads it waits on', describeCond(parked.park.clears_when), 'live read gateway-models finished');

t('a saved fixture is mode 0644', (statSync(saved).mode & 0o777).toString(8), '644');
t('a done read records how much it printed', ok.bytes, '{"a":1}\n'.length);

// The pass's own checkout (prepareCheckout): cloned from origin, brought to its default branch.
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
const origin = join(dir, 'origin.git');
const src = join(dir, 'src');
git('init', '-q', '--bare', '-b', 'main', origin);
git('init', '-q', '-b', 'main', src);
git('-C', src, 'remote', 'add', 'origin', origin);
writeFileSync(join(src, 'a.txt'), 'one\n');
git('-C', src, 'add', '-A'); git('-C', src, 'commit', '-q', '-m', 'one'); git('-C', src, 'push', '-q', 'origin', 'main');
const co = join(dir, 'checkout');
const first = prepareCheckout(co, { origin, branch: 'main' });
t('a first run clones origin and stands at its default branch', `${first.ok} ${first.sha === git('-C', src, 'rev-parse', 'HEAD')}`, 'true true');
writeFileSync(join(src, 'a.txt'), 'two\n');
git('-C', src, 'commit', '-q', '-am', 'two'); git('-C', src, 'push', '-q', 'origin', 'main');
const second = prepareCheckout(co, { origin, branch: 'main' });
t('a later run fetches, and stands detached at the new commit', `${second.sha === git('-C', src, 'rev-parse', 'HEAD')} ${git('-C', co, 'rev-parse', '--abbrev-ref', 'HEAD')} ${readFileSync(join(co, 'a.txt'), 'utf8').trim()}`, 'true HEAD two');
writeFileSync(join(co, '.env'), 'X=1\n');
const dirty = prepareCheckout(co, { origin, branch: 'main' });
t('a checkout something wrote into is not used, and not wiped', `${dirty.ok} ${/is not clean \(\.env\)/.test(dirty.why)} ${existsSync(join(co, '.env'))}`, 'false true true');
rmSync(join(co, '.env'));
const lost = prepareCheckout(co, { origin: join(dir, 'gone.git'), branch: 'main' });
t('nor is one whose fetch fails', `${lost.ok} ${/fetching origin's main/.test(lost.why)}`, 'false true');
t('nor one with no origin to clone from', prepareCheckout(join(dir, 'none'), { origin: '', branch: 'main' }).ok, false);
git('-C', co, 'remote', 'set-url', 'origin', join(dir, 'gone.git'));
t('the origin given is fetched, not the one the clone recorded', prepareCheckout(co, { origin, branch: 'main' }).ok, true);

// A ticket's fixtures, copied into its worktree (copyFixtures): from a named batch's state and the
// repo state above it, where a person saves them.
const repoState = join(dir, 'state');
const batchState = join(repoState, 'batches', 'epic-1');
mkdirSync(join(repoState, 'fixtures', 'F-1'), { recursive: true });
mkdirSync(join(batchState, 'fixtures', 'F-1'), { recursive: true });
writeFileSync(join(repoState, 'fixtures', 'F-1', 'post.json'), '{"post":1}');
writeFileSync(join(repoState, 'fixtures', 'F-1', 'reply.json'), '{"from":"repo"}');
writeFileSync(join(batchState, 'fixtures', 'F-1', 'reply.json'), '{"from":"batch"}');
writeFileSync(join(repoState, 'fixtures', 'F-1', 'big.json'), 'x'.repeat(21));
writeFileSync(join(repoState, 'fixtures', 'F-1', 'a\\b.json'), '{}');
symlinkSync(join(src, 'a.txt'), join(repoState, 'fixtures', 'F-1', 'link.json'));
mkdirSync(join(repoState, 'fixtures', 'F-1', 'sub'));
const cp = copyFixtures({ state: batchState, key: 'F-1', worktree: src, max: 20 });
const into = join(src, WORKTREE_FIXTURES, 'F-1');
t('a ticket\'s fixtures are copied into <worktree>/.desk-fixtures/<KEY>/', `${cp.dir === into} ${cp.copied.join(' ')} ${readFileSync(join(into, 'post.json'), 'utf8')}`, 'true reply.json post.json {"post":1}');
t('a name in both folders is copied from the batch\'s', readFileSync(join(into, 'reply.json'), 'utf8'), '{"from":"batch"}');
t('the copies stay out of git status', git('-C', src, 'status', '--porcelain'), '');
const why = Object.fromEntries(cp.refused.map((r) => [r.name, r.why]));
t('a file over the copy limit is not copied, saying why', `${existsSync(join(into, 'big.json'))} ${why['big.json']}`, 'false it is 21 bytes, over the 20-byte copy limit');
t('nor a name holding a path separator', `${existsSync(join(into, 'a\\b.json'))} ${why['a\\b.json']}`, 'false its name holds a path separator');
t('nor a symlink or a folder', `${existsSync(join(into, 'link.json'))} ${why['link.json']} ${why.sub}`, 'false it is a symlink it is not a file');
copyFixtures({ state: batchState, key: 'F-1', worktree: src, max: 20 });
const excl = readFileSync(join(src, '.git', 'info', 'exclude'), 'utf8');
t('a second copy adds no second exclude line', excl.split('\n').filter((l) => l === `/${WORKTREE_FIXTURES}/`).length, 1);
t('a ticket with no fixtures folder copies nothing', `${copyFixtures({ state: batchState, key: 'F-2', worktree: src })} ${existsSync(join(src, WORKTREE_FIXTURES, 'F-2'))}`, 'null false');
copyFixtures({ state: repoState, key: 'F-1', worktree: join(dir, 'wt2') });
t('the standing batch reads its own state only', readFileSync(join(dir, 'wt2', WORKTREE_FIXTURES, 'F-1', 'reply.json'), 'utf8'), '{"from":"repo"}');
t('the repo state of a named batch\'s', `${repoStateOf(batchState) === repoState} ${repoStateOf(repoState) === repoState}`, 'true true');

// Every place that describes §4 Live reads says where the command runs: a clean checkout of the
// default branch, never the ticket's worktree.
const root = join(import.meta.dirname, '..');
for (const f of ['desk-config.md', 'skills/desk-setup/references/step-1-detect.md', 'skills/desk-autopilot/references/worker-contract-stage-3.md', 'skills/desk-autopilot/SKILL.md', 'skills/desk-autopilot/references/orchestrator-recovery.md']) {
  const text = readFileSync(join(root, f), 'utf8');
  const at = text.search(/\*\*Live reads\.\*\*|\| Live reads \||\| §4 "Live reads" \||§4 Live reads entries \(|is a §4 Live reads entry/);
  const para = at < 0 ? '' : text.slice(at).split(/\n\s*\n|\n- \*\*|\n\| /)[0].replace(/\s+/g, ' ');
  t(`${f}: Live reads run from a clean checkout of the default branch, never the ticket's worktree`,
    `${para.length > 0} ${/clean checkout of the default branch/.test(para)} ${/(?<!never (?:the )?|never your )(?:in|from) (?:the ticket's|its|your) worktree/.test(para)}`, 'true true false');
}

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'live-read: all checks passed');
process.exit(fails ? 1 : 0);
