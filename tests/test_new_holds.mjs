// suite: new merge holds (a change pushed after a PR opened that puts it under §4 Merge holds)
// layer: L1
// covers: desk/bin/new-holds.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './scratch.mjs';
import { newHolds, nowNeedsText, writeHoldAsks, NOW_NEEDS } from '../desk/bin/new-holds.mjs';
import { readAsks, pruneAsks } from '../desk/bin/asks.mjs';
import { newHoldPrs } from '../desk/bin/desk-q.mjs';
import { renderPage } from '../desk/bin/digest.mjs';
import { personHolds, matchHolds, parseHolds, routinePerm } from '../desk/bin/gate.mjs';
import { scopeEntry, currentRepo } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const ci = { glob: '.github/**', why: 'workflow change', files: ['.github/workflows/ci.yml'] };
const s = (head, o = {}) => ({ state: 'OPEN', pr: 7, head, base: 'main', ...o });
const opts = (r, calls = []) => ({ defaultBranch: 'main', read: () => { calls.push(1); return r; } });

const rec = (o) => ({ pr: 7, head: 'a1', files: ['.github/workflows/ci.yml'], asked: [], asks: [], ...o });
const J = JSON.stringify;

// The first read is the PR's own: it records what it holds and flags nothing.
let r = newHolds({ key: 'T-1' }, s('a1'), opts({ head: 'a1', holds: [ci] }));
t('AC2 the first read records the PR, its head and its own held files', J(r.record), J(rec()));
t('AC2 the first read flags nothing', r.fresh.length + r.holds.length + r.drop.length + (r.changed ? 1 : 0) + (r.line ? 1 : 0) + (r.ask ? 1 : 0), 0);

// A later head holding a file the PR did not touch before flags it, with a line and the person's ask.
const src = { glob: 'infra/**', why: 'deploys the stack', files: ['infra/main.tf'] };
const t1 = { key: 'T-1', hold_read: rec() };
r = newHolds(t1, s('b2'), opts({ head: 'b2', holds: [ci, src] }));
t('AC2 a later head holding a new file names only it', r.fresh.join(','), 'infra/main.tf');
t('AC2 the record keeps the first read\'s files and the file asked about', J(r.record), J(rec({ head: 'b2', asked: ['infra/main.tf'] })));
t('AC2 new_holds is the new file, and changed', `${J(r.holds)} ${r.changed}`, `${J(['infra/main.tf'])} true`);
t('AC2 the report line says the PR now needs the person\'s merge and names the path', r.line,
  'T-1: PR #7 now needs your merge: infra/main.tf. A change pushed after the PR opened put it under §4 Merge holds (`infra/**`: deploys the stack), so the merge driver leaves the merge to you');
t('AC3 the ask recommends keeping the change and leaving the merge to the person', r.ask,
  'PR #7 (T-1) now needs your merge: a change pushed after it opened touched infra/main.tf, under §4 Merge holds (`infra/**`: deploys the stack), so desk will not merge it. Recommended: keep the change and merge #7 yourself once it is green, then say done');

// A file already flagged is not flagged again at a later head, and its ask is kept.
const a4 = { id: 4, files: ['infra/main.tf'] };
const t2 = { ...t1, hold_read: rec({ head: 'b2', asked: ['infra/main.tf'], asks: [a4] }), new_holds: ['infra/main.tf'] };
r = newHolds(t2, s('c3'), opts({ head: 'c3', holds: [ci, src] }));
t('AC2 a file already flagged is not flagged again', r.fresh.length + (r.ask ? 1 : 0), 0);
t('AC2 ... new_holds is unchanged', `${J(r.holds)} ${r.changed}`, `${J(['infra/main.tf'])} false`);
t('AC2 ... and its ask is kept, none dropped', `${J(r.record.asks)} ${J(r.drop)}`, `${J([a4])} []`);

// Two later files asked about apart: reverting one drops its ask and keeps the other's.
const db = { glob: 'db/**', why: 'migrations', files: ['db/m.sql'] };
const a5 = { id: 5, files: ['db/m.sql'] };
const t3 = { ...t1, hold_read: rec({ head: 'c3', asked: ['infra/main.tf', 'db/m.sql'], asks: [a4, a5] }), new_holds: ['db/m.sql', 'infra/main.tf'] };
r = newHolds(t3, s('c4'), opts({ head: 'c4', holds: [ci, db] }));
t('reverting one of two later holds drops only its ask', `${J(r.drop)} ${J(r.record.asks)}`, `[4] ${J([a5])}`);
t('... forgets only it was asked, and flags nothing new', `${J(r.record.asked)} ${r.fresh.length} ${J(r.holds)}`, `${J(['db/m.sql'])} 0 ${J(['db/m.sql'])}`);

// A later head that no longer touches the new file clears it, and its ask goes.
r = newHolds(t2, s('d5'), opts({ head: 'd5', holds: [ci] }));
t('a reverted hold clears new_holds', `${J(r.holds)} ${r.changed}`, '[] true');
t('... drops its ask', J(r.drop), '[4]');
t('... and forgets it was asked, so a later re-add asks again', `${J(r.record.asked)} ${J(r.record.asks)}`, '[] []');

// A ticket's next PR (its earlier one closed) is read afresh: its own files are its own.
r = newHolds(t2, s('e1', { pr: 8 }), opts({ head: 'e1', holds: [ci, src] }));
t('a new PR\'s first read flags nothing of its own', r.fresh.length + r.holds.length + (r.ask ? 1 : 0), 0);
t('... records the new PR', J(r.record), J({ pr: 8, head: 'e1', files: ['.github/workflows/ci.yml', 'infra/main.tf'], asked: [], asks: [] }));
t('... clears the earlier PR\'s new_holds and drops its ask', `${r.changed} ${J(r.drop)}`, 'true [4]');
t('the same head of a new PR number is read, not skipped', newHolds(t2, s('b2', { pr: 8 }), opts({ head: 'b2', holds: [] })) != null, true);

// Two new files are listed with "and" in the ask.
r = newHolds(t1, s('d4'), opts({ head: 'd4', holds: [ci, { ...src, files: ['infra/a.tf', 'infra/b.tf'] }] }));
t('two new files are joined with "and" in the ask', r.ask.includes('touched infra/a.tf and infra/b.tf,'), true);
t('... and "them" in the line', r.line.includes('put them under'), true);

// writeHoldAsks: the ask goes in the repo's asks, a named batch's state included, and a dropped one goes.
const repoState = scratch('new-holds-');
const batchState = join(repoState, 'batches', 'EPIC-1');
mkdirSync(batchState, { recursive: true });
r = newHolds(t1, s('b2'), opts({ head: 'b2', holds: [ci, src] }));
const kept = writeHoldAsks(batchState, r);
const asked = readAsks(repoState);
t('writeHoldAsks writes the ask in the repo\'s asks, not the named batch\'s folder', `${asked.length} ${readAsks(batchState).length}`, '1 0');
t('... and records its id and files on the hold_read', J(kept.asks), J([{ id: asked[0].id, files: ['infra/main.tf'] }]));
r = newHolds({ ...t1, hold_read: kept, new_holds: ['infra/main.tf'] }, s('c3'), opts({ head: 'c3', holds: [ci] }));
const failures = [];
writeHoldAsks(batchState, r, (what) => failures.push(what));
t('writeHoldAsks removes a reverted hold\'s ask from the repo\'s asks', `${readAsks(repoState).length} ${failures.length}`, '0 0');

// The ask waits on the ticket, so pruneAsks drops it once the ticket is finished (its PR merged).
r = newHolds(t1, s('b2'), opts({ head: 'b2', holds: [ci, src] }));
const waits = writeHoldAsks(repoState, r);
t('the ask waits on the ticket (until), so it goes once the ticket is finished', J(readAsks(repoState)[0].until), J(['T-1']));
pruneAsks(repoState, { known: () => true, finished: (k) => k === 'T-1' });
t('... and pruneAsks drops it once T-1 is finished', readAsks(repoState).length, 0);
t('... its id was on the hold_read', waits.asks.length, 1);

// An ask that could not be added is not recorded as asked, so the next head asks again.
writeFileSync(join(repoState, 'asks.json'), '{ not json');
const unasked = [];
r = newHolds(t1, s('b2'), opts({ head: 'b2', holds: [ci, src] }));
const lost = writeHoldAsks(repoState, r, (what) => unasked.push(what));
t('a failed ask is reported', unasked.join(','), 'recorded');
t('... and leaves its files out of asked, with no ask id', `${J(lost.asked)} ${J(lost.asks)}`, '[] []');
r = newHolds({ ...t1, hold_read: lost, new_holds: ['infra/main.tf'] }, s('c3'), opts({ head: 'c3', holds: [ci, src] }));
t('... so the next head asks about them again', `${r.fresh.join(',')} ${Boolean(r.ask)}`, 'infra/main.tf true');

// Nothing read, nothing changed.
let calls = [];
t('the same head is not read again', newHolds(t1, s('a1'), opts({ head: 'a1', holds: [ci, src] }, calls)), null);
t('... and gh is not asked', calls.length, 0);
calls = [];
t('a PR into a base that is not the default branch gives null', newHolds(t1, s('b2', { base: 'batch/x' }), opts({ head: 'b2', holds: [ci, src] }, calls)), null);
t('... unread', calls.length, 0);
t('an unread PR gives null', newHolds(t1, s('b2'), opts(null)), null);
t('a closed PR gives null', newHolds(t1, s('b2', { state: 'MERGED' }), opts({ head: 'b2', holds: [src] })), null);

// AC4: a PR that touches no merge-hold path changes nothing beyond the head it was read at.
r = newHolds({ key: 'T-2' }, s('a1'), opts({ head: 'a1', holds: [] }));
t('AC4 a PR under no hold records only its read', `${J(r.record)} ${r.changed}`, `${J(rec({ files: [] }))} false`);
r = newHolds({ key: 'T-2', hold_read: rec({ files: [] }) }, s('b2'), opts({ head: 'b2', holds: [] }));
t('AC4 a later head under no hold flags nothing', r.fresh.length + r.drop.length + (r.changed ? 1 : 0) + (r.ask ? 1 : 0), 0);

// nowNeedsText
t('nowNeedsText names the new files', nowNeedsText({ new_holds: ['infra/main.tf', 'infra/b.tf'] }), `${NOW_NEEDS}: infra/main.tf, infra/b.tf`);
t('nowNeedsText is null with none', nowNeedsText({ new_holds: [] }), null);
t('nowNeedsText is null with no ticket', nowNeedsText(undefined), null);

// desk-q newHoldPrs: an open PR row with new holds, by ticket.
const done = (pr, o = {}) => ({ state: 'done', result: { pr }, pr_status: { pr, state: 'OPEN', url: `https://github.com/o/r/pull/${pr}` }, ...o });
const q = { tickets: {
  'T-9': done(9, { new_holds: ['infra/main.tf'] }),
  'T-3': done(3, { new_holds: ['.github/x.yml'] }),
  'T-4': done(4),
  'T-5': done(5, { new_holds: ['infra/main.tf'], pr_status: { pr: 5, state: 'MERGED' }, merged_at: '2026-11-27T00:00:00Z' }),
} };
const prs = newHoldPrs(q);
t('newHoldPrs lists only open PRs with new holds, by ticket', prs.map((p) => p.ticket).join(','), 'T-3,T-9');
t('newHoldPrs gives the PR, its url and the text', JSON.stringify(prs[1]), JSON.stringify({ ticket: 'T-9', pr: 9, url: 'https://github.com/o/r/pull/9', text: `${NOW_NEEDS}: infra/main.tf` }));
t('newHoldPrs of no queue is empty', newHoldPrs(null).length, 0);

// The digest's section and its count.
const page = renderPage({ slot: '2026-11-27T08:00', since: null, bin: '/b', leversPage: 'file:///l',
  groups: [{ slug: 'acme__w', questions: [], decisions: [], held: prs }] });
t('AC2 the digest counts the PRs that now need the person\'s merge', page.includes('; 2 PR(s) that now need your merge'), true);
t('AC2 the digest has the section', page.includes('### Now needs your merge'), true);
t('AC2 the digest names the ticket, PR and path', page.includes(`- \`T-9\` [#9](https://github.com/o/r/pull/9): ${NOW_NEEDS}: infra/main.tf, changed after it opened under §4 Merge holds`), true);
const quiet = renderPage({ slot: '2026-11-27T08:00', since: null, bin: '/b', leversPage: 'file:///l', groups: [{ slug: 'acme__w', questions: [], decisions: [], held: [] }] });
t('AC4 with none, the digest has no section and nothing to answer', !quiet.includes('Now needs your merge') && quiet.includes('Nothing to answer'), true);

// gate personHolds: a routine hold leaves the merge to a person only where merge-hold-routine is not yes.
const holds = parseHolds(['infra/**: deploys; desk runs: ./deploy.sh', '.github/**: workflow change']);
const held = matchHolds(['infra/a.tf', '.github/x.yml'], holds);
t('personHolds keeps a routine hold under merge-hold-routine no', personHolds(held, 'no').map((h) => h.glob).join(','), 'infra/**,.github/**');
t('personHolds drops only the routine hold under merge-hold-routine yes', personHolds(held, 'yes').map((h) => h.glob).join(','), '.github/**');
t('routinePerm reads merge-hold-routine', routinePerm({ permission: (k) => (k === 'merge-hold-routine' ? 'yes' : 'x') }), 'yes');
t('routinePerm is no with no config', routinePerm({ permission: () => { throw new Error('no config'); } }), 'no');

// desk-env scopeEntry: what triage matches against this repo's holds.
const here = (f) => scopeEntry(f, '/nonexistent-desk-config').path ?? null;
t('scopeEntry keeps a bare path', here('.github/workflows/ci.yml'), '.github/workflows/ci.yml');
t('scopeEntry keeps a path-like prefix no repo has', here('src/a.ts: the handler'), 'src/a.ts: the handler');
t('scopeEntry gives no path for an unknown repo prefix', here('otherrepo: infra/x.tf'), null);
const self = currentRepo().ownerRepo;
if (self) t('scopeEntry takes this repo\'s own prefix off', here(`${self.split('/').pop()}: .github/x.yml`), '.github/x.yml');

if (fails) { console.log(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nall passed');
