// suite: check-build (§4 Check builds: where a build runs, what it is given, and the head's checkout)
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBuild, buildRecord, anyRunning, prepareTree, pruneTrees } from '../desk/bin/check-build.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'desk-check-build-')));
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
const origin = join(dir, 'origin.git');
const src = join(dir, 'src');
git('init', '-q', '--bare', '-b', 'main', origin);
git('init', '-q', '-b', 'main', src);
git('-C', src, 'remote', 'add', 'origin', origin);
writeFileSync(join(src, 'build.sh'), 'echo main\n'); writeFileSync(join(src, '.gitignore'), '.env\n');
git('-C', src, 'add', '-A'); git('-C', src, 'commit', '-q', '-m', 'main'); git('-C', src, 'push', '-q', 'origin', 'main');
git('-C', src, 'checkout', '-q', '-b', 'fix/X-1');
writeFileSync(join(src, 'build.sh'), 'echo branch\n');
git('-C', src, 'commit', '-q', '-am', 'branch'); git('-C', src, 'push', '-q', 'origin', 'fix/X-1');
const head = git('-C', src, 'rev-parse', 'HEAD');
writeFileSync(join(src, '.env'), 'SECRET=1\n'); writeFileSync(join(src, 'helper.sh'), 'echo worker\n');

// prepareTree: a clean, detached checkout of the PR's head, one per PR, reset before each build.
const tree = join(dir, 'check-trees', '781');
const made = prepareTree(tree, { origin, head, branch: 'fix/X-1', base: 'main' });
t('AC3 a first run clones origin and stands detached at the head', `${made.ok} ${git('-C', tree, 'rev-parse', 'HEAD') === head} ${git('-C', tree, 'rev-parse', '--abbrev-ref', 'HEAD')}`, 'true true HEAD');
t('AC3 it holds the head\'s files', readFileSync(join(tree, 'build.sh'), 'utf8').trim(), 'branch');
t('AC4 and nothing the worker left uncommitted or ignored in its worktree', `${existsSync(join(tree, '.env'))} ${existsSync(join(tree, 'helper.sh'))}`, 'false false');
t('the default branch is fetched beside it, for a build that compares against it', git('-C', tree, 'rev-parse', 'refs/remotes/origin/main') === git('-C', src, 'rev-parse', 'main'), true);
writeFileSync(join(tree, '.env'), 'X=1\n'); writeFileSync(join(tree, 'build.sh'), 'echo changed\n'); mkdirSync(join(tree, 'out'));
writeFileSync(join(tree, 'out', 'image.tar'), 'x');
const again = prepareTree(tree, { origin, head, branch: 'fix/X-1', base: 'main' });
t('AC4 a later run resets it: what a build wrote there is gone', `${again.ok} ${existsSync(join(tree, '.env'))} ${existsSync(join(tree, 'out'))} ${readFileSync(join(tree, 'build.sh'), 'utf8').trim()}`, 'true false false branch');
// A head on no branch origin has is fetched by its SHA.
git('-C', src, 'checkout', '-q', '-b', 'fix/X-2', 'main');
writeFileSync(join(src, 'b.txt'), 'b\n'); git('-C', src, 'add', 'b.txt'); git('-C', src, 'commit', '-q', '-m', 'two');
const unpushed = git('-C', src, 'rev-parse', 'HEAD');
const lost = prepareTree(join(dir, 'check-trees', '782'), { origin, head: unpushed, branch: 'fix/X-2', base: 'main' });
t('AC6 a head origin does not have makes no checkout, and says why', `${lost.ok} ${/fetching the head .* from origin into .* failed/.test(lost.why)}`, 'false true');
t('AC6 nor does a gone origin', prepareTree(join(dir, 'check-trees', '783'), { origin: join(dir, 'gone.git'), head, branch: 'fix/X-1', base: 'main' }).ok, false);
t('nor no origin at all', prepareTree(join(dir, 'check-trees', '784'), { origin: '', head, branch: 'fix/X-1', base: 'main' }).ok, false);
t('nor a head that is not a SHA', prepareTree(join(dir, 'check-trees', '785'), { origin, head: 'main', branch: 'fix/X-1', base: 'main' }).ok, false);
git('-C', src, 'push', '-q', 'origin', 'fix/X-2');
const seeded = prepareTree(join(dir, 'check-trees', '786'), { origin, seed: tree, head: unpushed, branch: 'fix/X-2', base: 'main' });
t('a checkout cloned from a local seed still fetches its head from origin', `${seeded.ok} ${existsSync(join(dir, 'check-trees', '786', 'b.txt'))}`, 'true true');

// startBuild: the command runs in the cwd it is given, never the tree, and gets the head only as data.
const builds = join(dir, 'check-builds');
const co = join(dir, 'live-read-checkout');
mkdirSync(co);
const base = 'b'.repeat(40);
startBuild(builds, { n: 781, head, command: 'pwd -P; echo "head=$DESK_CHECK_HEAD"; echo "tree=$DESK_CHECK_TREE"', checks: ['Flows image'], cwd: co, tree, base });
const wait = async (n, h) => { for (let i = 0; i < 100 && buildRecord(builds, n, h)?.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 50)); return buildRecord(builds, n, h); };
const rec = await wait(781, head);
const log = readFileSync(join(builds, `781-${head}.log`), 'utf8').trim().split('\n');
t('AC2 the build runs in the cwd it is given (the pass\'s default-branch checkout)', log[0], co);
t('AC3 its environment has DESK_CHECK_HEAD, the head\'s SHA', log[1], `head=${head}`);
t('AC3 and DESK_CHECK_TREE, the head\'s checkout', log[2], `tree=${tree}`);
const json = JSON.parse(readFileSync(join(builds, `781-${head}.json`), 'utf8'));
t('AC2 its record names that cwd, the default branch commit, the head and the tree', `${json.cwd === co} ${json.base === base} ${json.head === head} ${json.tree === tree}`, 'true true true true');
t('it ended 0', rec.code, 0);

// anyRunning and pruneTrees: a running build keeps its PR's checkout; a closed PR's goes.
const slow = 'f'.repeat(40);
startBuild(builds, { n: 786, head: slow, command: 'sleep 2', checks: ['x'], cwd: co, tree: join(dir, 'check-trees', '786'), base });
t('a build still running is seen running, by its PR', `${anyRunning(builds)} ${anyRunning(builds, '786-')} ${anyRunning(builds, '781-')}`, 'true true false');
const failed = pruneTrees(join(dir, 'check-trees'), builds, (n) => n === '781');
t('a kept PR\'s checkout stays, and so does one a build still runs in', `${failed.length} ${existsSync(tree)} ${existsSync(join(dir, 'check-trees', '786'))}`, '0 true true');
t('a closed PR\'s checkout is removed', existsSync(join(dir, 'check-trees', '782')) || existsSync(join(dir, 'check-trees', '783')), false);
await wait(786, slow);
pruneTrees(join(dir, 'check-trees'), builds, () => false);
t('once its build ends, the closed PR\'s checkout goes too', `${existsSync(tree)} ${existsSync(join(dir, 'check-trees', '786'))}`, 'false false');

// AC7: every place that describes a check build says where it runs and what it is given.
const root = join(import.meta.dirname, '..');
for (const [f, start] of [['desk-config.md', /\| Check builds \|/], ['skills/desk-setup/references/step-1-detect.md', /\*\*Check builds\.\*\*/], ['skills/desk-autopilot/references/merging.md', /\*\*A draft red only on checks §4 Check builds names gets their build from the pass\*\*/]]) {
  const text = readFileSync(join(root, f), 'utf8');
  const at = text.search(start);
  const para = at < 0 ? '' : text.slice(at).split(/\n\s*\n|\n- \*\*|\n\| /)[0].replace(/\s+/g, ' ');
  t(`AC7 ${f}: a check build runs from a clean checkout of the default branch, given DESK_CHECK_TREE, never in the ticket's worktree`,
    `${para.length > 0} ${/clean checkout of (?:origin's )?(?:the )?default branch/.test(para)} ${/DESK_CHECK_TREE/.test(para)} ${/(?<!never (?:the )?)(?:in|from) the ticket's worktree/.test(para)}`, 'true true true false');
}

rmSync(dir, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'check-build: all checks passed');
process.exit(fails ? 1 : 0);
