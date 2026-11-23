// suite: live-read (§4 Live reads: which parks the pass runs a read for, and how it records one)
// layer: L2
import { readFileSync, writeFileSync, existsSync, rmSync, statSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseLiveReads, liveReadPark, readRecord, startRead, saveFixture, prepareCheckout, copyFixtures, WORKTREE_FIXTURES, estimateOf, capRefusal, spentOn, logSpend, spendFile } from '../desk/bin/live-read.mjs';
import { repoStateOf } from '../desk/bin/desk-env.mjs';
import { waitingOnRead, batchSettled } from '../desk/bin/batch-state.mjs';
import { shownState } from '../desk/bin/desk-q.mjs';
import { describeCond } from '../desk/bin/clears-when.mjs';
import { scratch } from './scratch.mjs';
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

// A paid entry carries both its caps after the name; the park gives its estimate beside the name.
const paidRow = parseLiveReads(['gateway-chat [£0.10/call, £2/day]: ./scripts/chat.sh', 'half [£0.10/call]: ./h', 'zero [£0/call, £2/day]: ./z', 'odd [ten pence]: ./o', 'gateway-models: ./gm']);
t('DS-574 a paid entry parses to its name, command and caps', JSON.stringify(paidRow.reads[0]), JSON.stringify({ name: 'gateway-chat', command: './scripts/chat.sh', caps: { call: 0.1, day: 2 } }));
t('DS-574 a free entry has no caps', paidRow.reads[1].caps, null);
t('DS-574 AC5 a bracket missing a cap, with a £0 cap, or not in the cap form is refused', paidRow.errors.length, 3);
t('DS-574 AC5 the refusal says both caps are needed', paidRow.errors[0].includes('a paid call takes both caps'), true);
const paid = paidRow.reads[0];
t('DS-574 a park naming a paid entry with its estimate asks for it', liveReadPark('need live read gateway-chat (est £0.03). Not reached: the PR', paidRow.reads)?.map((r) => r.name).join(' '), 'gateway-chat');
t('DS-574 the estimate is read from beside the name', estimateOf('need live read gateway-chat (est £0.03). Not reached: the PR', 'gateway-chat'), 0.03);
t('DS-574 a park with no estimate in that form gives none', estimateOf('need live read gateway-chat, about 3p', 'gateway-chat'), null);
t('DS-574 AC1 a call within both caps may run', capRefusal(paid, 0.03, 0), null);
t('DS-574 AC2 one over the per-call cap is refused naming its estimate', capRefusal(paid, 0.12, 0), 'live read gateway-chat is estimated at £0.12, over its £0.10/call cap');
t('DS-574 AC3 one once the day\'s spend reached the daily cap is refused naming the spend so far', capRefusal(paid, 0.03, 2), 'live read gateway-chat has spent £2.00 today of its £2.00/day cap, so a call estimated at £0.03 would pass it');
t('DS-574 a call that just fits the daily cap may run', capRefusal(paid, 0.03, 1.97), null);
t('DS-574 a paid call with no estimate is refused', capRefusal(paid, null, 0)?.includes('the park gave no estimate for it, as `gateway-chat (est £0.03)`'), true);
t('DS-574 a free read is never capped', capRefusal(paidRow.reads[1], null, 99), null);
t('DS-574 AC3 an estimate of nothing is refused, so a day at its cap cannot run one more', capRefusal(paid, 0, 2)?.includes('an estimate of £0.00, which is no cost'), true);
t('DS-574 so is one under a ten-thousandth of a pound', capRefusal(paid, 0.00001, 0)?.includes('which is no cost'), true);
const twice = parseLiveReads(['gateway-chat [£0.10/call, £2/day]: ./a', 'Gateway-Chat: ./b']);
t('DS-574 a name given twice, in any case, is refused, so one park cannot run two calls', `${twice.reads.length} ${twice.errors[0]?.includes('another entry is already named Gateway-Chat')}`, '1 true');
{
  const sd = scratch('desk-live-spend-');
  const f = spendFile(sd);
  t('DS-574 the spend log is the repo state\'s, shared by its batches', spendFile(join(sd, 'batches', 'b1')), f);
  t('DS-574 nothing logged is nothing spent', spentOn(f, 'gateway-chat', '2026-11-22'), 0);
  for (const [day, name, est] of [['2026-11-22', 'gateway-chat', 0.03], ['2026-11-22', 'gateway-chat', 0.07], ['2026-11-21', 'gateway-chat', 1], ['2026-11-22', 'other', 1]]) logSpend(f, { day, name, est });
  t('DS-574 a day\'s spend sums that entry\'s calls on that day only', spentOn(f, 'gateway-chat', '2026-11-22'), 0.1);
  rmSync(sd, { recursive: true, force: true });
}

const dir = scratch('desk-live-read-');
const head = 'c'.repeat(40);
const wait = async (name) => { for (let i = 0; i < 100 && readRecord(dir, 'L-1', head, name)?.state !== 'done'; i++) await new Promise((r) => setTimeout(r, 50)); return readRecord(dir, 'L-1', head, name); };
t('no read started at a head has no record', readRecord(dir, 'L-1', head, 'ok'), null);
startRead(dir, { key: 'L-1', head, name: 'ok', command: 'echo "{\\"a\\":1}"; echo noise >&2', cwd: dir, base: 'b'.repeat(40) });
startRead(dir, { key: 'L-1', head, name: 'bad', command: 'echo partial; echo "AccessDenied: no key" >&2; echo "at line 3" >&2; exit 2', cwd: dir });
const ok = await wait('ok');
const bad = await wait('bad');
t('a read that exits 0 records code 0', ok?.code, 0);
t('DS-574 a read\'s record names the commit it ran at', ok?.base, 'b'.repeat(40));
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
mkdirSync(join(dir, 'wt2'));
copyFixtures({ state: repoState, key: 'F-1', worktree: join(dir, 'wt2') });
t('the standing batch reads its own state only', readFileSync(join(dir, 'wt2', WORKTREE_FIXTURES, 'F-1', 'reply.json'), 'utf8'), '{"from":"repo"}');
// The worktree is the worker's: a symlink it left where the copies go is replaced, never followed.
const outside = join(dir, 'outside');
mkdirSync(outside);
writeFileSync(join(outside, 'post.json'), 'host file', { mode: 0o600 });
const wt3 = join(dir, 'wt3');
mkdirSync(join(wt3, WORKTREE_FIXTURES, 'F-1'), { recursive: true });
symlinkSync(join(outside, 'post.json'), join(wt3, WORKTREE_FIXTURES, 'F-1', 'post.json'));
copyFixtures({ state: repoState, key: 'F-1', worktree: wt3 });
t('a symlink at a copy\'s path is replaced, its target untouched', `${readFileSync(join(outside, 'post.json'), 'utf8')} ${(statSync(join(outside, 'post.json')).mode & 0o777).toString(8)} ${readFileSync(join(wt3, WORKTREE_FIXTURES, 'F-1', 'post.json'), 'utf8')}`, 'host file 600 {"post":1}');
const wt4 = join(dir, 'wt4');
mkdirSync(join(wt4, WORKTREE_FIXTURES), { recursive: true });
symlinkSync(outside, join(wt4, WORKTREE_FIXTURES, 'F-1'));
const cp4 = copyFixtures({ state: repoState, key: 'F-1', worktree: wt4 });
t('so is a symlinked folder, and nothing lands where it pointed', `${readFileSync(join(outside, 'post.json'), 'utf8')} ${existsSync(join(outside, 'reply.json'))} ${cp4.copied.join(' ')}`, 'host file false big.json post.json reply.json');
const wt5 = join(dir, 'wt5');
mkdirSync(wt5);
symlinkSync(outside, join(wt5, WORKTREE_FIXTURES));
copyFixtures({ state: repoState, key: 'F-1', worktree: wt5 });
t('and a symlinked .desk-fixtures', `${existsSync(join(outside, 'F-1'))} ${readFileSync(join(wt5, WORKTREE_FIXTURES, 'F-1', 'post.json'), 'utf8')}`, 'false {"post":1}');
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
