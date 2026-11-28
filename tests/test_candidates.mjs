// suite: candidates (what to admit into a free batch slot, checked against main before it is offered)
// layer: L2
// covers: desk/bin/candidates.mjs
// listCandidates with stubbed Jira, GitHub and git reads; slotLines' keeping between passes; admitRun's
// one admission a run with stubbed admit and assign, and desk-q's line for it; the command with no Jira
// tracker. Scratch directories only.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCandidates, renderLines, priorityOf, rankOf, leftOut, missingSections, namedFiles, overlapOf, onMain, slotLines, slotCandidatesOn, candidatesJqls, ownAssignee, personOf, CANDIDATES_EVERY_MS, admitCandidatesOn, admitRefusal, admitRun, ADMIT_RETRY_MS } from '../desk/bin/candidates.mjs';
import { admitHead } from '../desk/bin/desk-q.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const PRIORITY = ['customfield_10300', 'P0', 'P1', 'P2'];
const issue = (key, type, p, extra = {}) => ({ key, fields: { issuetype: { name: type }, summary: `${key} summary`, customfield_10300: p ? { value: p } : null, issuelinks: [], ...extra } });
const blockedBy = (key, category) => ({ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key, fields: { status: { statusCategory: { key: category } } } } });
const CLEAN = 'h2. Acceptance criteria\n* Given x, when y, then z\nh2. Design\nNo UI.';

// reads: every ticket's description, merged PRs and commits keyed by ticket, and the recent PRs. The
// search answers each priority tier's JQL with that tier's issues, one page of `max`.
// An issue's `assignee` is an account id; the search answers `assignee = currentUser()` as ME, and a
// search with no assignee clause, as Jira does, with every assignee.
const ME = 'acct-me';
function readsOf({ issues, desc = {}, prs = {}, commits = {}, recent = [], queued = [], liveEpics = [], open = [] }) {
  const calls = { search: [], recent: 0, openPrs: 0 };
  return {
    calls,
    search: (jql, max, fields) => {
      calls.search.push({ jql, max, fields });
      const tier = /cf\[10300\] = "([^"]+)"/.exec(jql)?.[1];
      const rest = /is EMPTY OR/.test(jql);
      const who = /assignee is EMPTY/.test(jql) ? null : /assignee = currentUser\(\)/.test(jql) ? ME : /assignee = "([^"]+)"/.exec(jql)?.[1];
      const hits = issues.filter((i) => who === undefined || (i.fields.assignee?.accountId ?? null) === who)
        .filter((i) => { const v = i.fields.customfield_10300?.value ?? null; return tier ? v === tier : rest ? !['P0', 'P1', 'P2'].includes(v) : true; });
      return { ok: true, issues: hits.slice(0, max), more: hits.length > max };
    },
    description: (k) => (k in desc ? { ok: true, text: desc[k] } : { ok: false, why: 'no such issue' }),
    mergedPrs: (k) => prs[k] ?? [],
    openPrs: () => { calls.openPrs++; return open; },
    commits: (k) => commits[k] ?? [],
    recent: () => { calls.recent++; return recent; },
    queued: () => new Set(queued),
    liveEpics: () => new Set(liveEpics),
  };
}
// The searches a listing made for unassigned tickets, after the person's own.
const unassigned = (r) => r.calls.search.filter((c) => /assignee is EMPTY/.test(c.jql));
const list = (reads) => listCandidates({ project: 'ACME', priority: PRIORITY, reads, now: Date.parse('2026-11-25T12:00:00Z') });

// AC1: unassigned, unstarted Bugs and self-contained Tasks, ranked by the repo's priority field.
const BASE = 'project = "ACME" AND issuetype in (Bug, Task) AND assignee is EMPTY AND statusCategory = "To Do"';
t('AC1 the searches ask for unassigned, unstarted Bugs and Tasks, a priority tier each, then the unset or unlisted by the field', candidatesJqls('ACME', priorityOf(PRIORITY)), [
  `${BASE} AND cf[10300] = "P0" ORDER BY created DESC`,
  `${BASE} AND cf[10300] = "P1" ORDER BY created DESC`,
  `${BASE} AND cf[10300] = "P2" ORDER BY created DESC`,
  `${BASE} AND (cf[10300] is EMPTY OR cf[10300] not in ("P0", "P1", "P2")) ORDER BY cf[10300] ASC, created DESC`,
]);
t('AC1 with no values listed, one search Jira orders by its own priority', candidatesJqls('ACME', priorityOf(['none'])), [`${BASE} ORDER BY priority DESC, created DESC`]);
t('AC1 with only a custom field named, one search ordered by its options', candidatesJqls('ACME', priorityOf(['customfield_10300'])), [`${BASE} ORDER BY cf[10300] ASC, created DESC`]);
t('AC1 a quote in a value is escaped', candidatesJqls('ACME', priorityOf(['Must "now"']))[0], `${BASE} AND priority = "Must \\"now\\"" ORDER BY created DESC`);
t('AC1 a value written with its option id is searched and ranked by its name', priorityOf(['customfield_10207', 'P0=10089', 'P1=10090']), { field: 'customfield_10207', names: ['P0', 'P1'], order: ['p0', 'p1'] });
{
  const r = readsOf({
    issues: [issue('ACME-1', 'Task', 'P2'), issue('ACME-2', 'Bug', 'P0'), issue('ACME-3', 'Task', null), issue('ACME-4', 'Bug', 'P1')],
    desc: { 'ACME-1': CLEAN, 'ACME-2': CLEAN, 'ACME-3': CLEAN, 'ACME-4': CLEAN },
  });
  const got = list(r);
  t('AC1 ranked by §4 Priority\'s own order, an unset one last', got.offered.map((c) => c.key), ['ACME-2', 'ACME-4', 'ACME-1', 'ACME-3']);
  t('AC1 the priority field is asked for beside the links and parent', r.calls.search[0].fields, ['issuelinks', 'parent', 'created', 'customfield_10300']);
}
{
  // The repo's own row form, option ids beside the names: P2s are searched and checked before any P4,
  // Bugs before Tasks within a priority, newest first.
  const P = ['customfield_10300', 'P0=1', 'P1=2', 'P2=3', 'P3=4', 'P4=5'];
  const at = (d) => ({ created: `2026-11-${d}T09:00:00.000+0000` });
  const issues = [issue('ACME-31', 'Task', 'P4', at(10)), issue('ACME-32', 'Task', 'P2', at(11)), issue('ACME-33', 'Bug', 'P4', at(12)),
    issue('ACME-34', 'Task', 'P2', at(20)), issue('ACME-35', 'Bug', 'P2', at(5)), issue('ACME-36', 'Bug', 'P2', at(15))];
  const r = readsOf({ issues, desc: Object.fromEntries(issues.map((x) => [x.key, CLEAN])) });
  const got = listCandidates({ project: 'ACME', priority: P, reads: r, checkMax: 4 });
  t('AC1 the P2s are checked before any P4', got.offered.map((c) => c.key), ['ACME-36', 'ACME-35', 'ACME-34', 'ACME-32']);
  t('AC3 Bugs before Tasks at one priority, each newest first', got.offered.map((c) => c.type), ['Bug', 'Bug', 'Task', 'Task']);
  t('AC1 a priority at option-id form ranks by its name', got.offered.map((c) => c.rank), [2, 2, 2, 2]);
  t('AC1 the P2 tier filled the list, so no P4 search ran', unassigned(r).map((c) => /cf\[10300\] = "([^"]+)"/.exec(c.jql)?.[1]), ['P0', 'P1', 'P2']);
}
{
  // Values the row does not list rank by their own text: P3 before P4, then Bugs, then newest, unset last.
  const at = (d) => ({ created: `2026-${d}T09:00:00.000+0000` });
  const issues = [issue('ACME-51', 'Task', 'P4', at('11-20')), issue('ACME-52', 'Task', 'P3', at('01-10')), issue('ACME-53', 'Bug', null, at('11-25')),
    issue('ACME-54', 'Task', 'P3', at('04-10')), issue('ACME-55', 'Bug', 'P4', at('02-10')), issue('ACME-56', 'Task', 'P2', at('03-10'))];
  const got = list(readsOf({ issues, desc: Object.fromEntries(issues.map((x) => [x.key, CLEAN])) }));
  t('AC1 P3 before P4 though the row lists neither, a Bug first in each, unset last', got.offered.map((c) => c.key), ['ACME-56', 'ACME-54', 'ACME-52', 'ACME-55', 'ACME-51', 'ACME-53']);
}

// AC2: a decision, or access, key or infrastructure work outside the repo, is left out naming the word.
{
  const say = (k, s, extra) => leftOut({ ...issue(k, 'Task', 'P2', extra), fields: { ...issue(k, 'Task', 'P2', extra).fields, summary: s } });
  t('AC2 a policy question is left out', say('ACME-40', 'Decide whether to adopt the new retention schedule'), 'a decision or work outside the repo ("Decide" in its summary)');
  t('AC2 a key rotation is left out', say('ACME-41', 'Rotate the licence key for the reporting service'), 'a decision or work outside the repo ("Rotate" in its summary)');
  t('AC2 a WAF rule is left out', say('ACME-42', 'Promote WAF rule 12 to block'), 'a decision or work outside the repo ("WAF" in its summary)');
  t('AC2 a label marks it too', say('ACME-43', 'Move the build cache', { labels: ['infra'] }), 'a decision or work outside the repo ("infra" in its label infra)');
  t('AC2 a Bug is left out the same way', leftOut({ key: 'ACME-44', fields: { issuetype: { name: 'Bug' }, summary: 'Staff lose access to reports after sign-in' } }), 'a decision or work outside the repo ("access" in its summary)');
  t('AC2 a word inside another word is not one', say('ACME-45', 'Accessibility of the infrared sensor page'), null);
  t('AC2 a should-we is left out', say('ACME-48', 'Should we drop Node 18?'), 'a decision or work outside the repo ("Should we" in its summary)');
  t('AC2 a key is left out', say('ACME-49', 'Issue a new Sentry key for staging'), 'a decision or work outside the repo ("key" in its summary)');
  t('AC2 an ops label marks it', say('ACME-50', 'Bump the runner image', { labels: ['devops-ci'] }), 'a decision or work outside the repo ("devops" in its label devops-ci)');
  t('AC2 a label or summary only containing those letters is not one', [say('ACME-57', 'Keyboard focus lost in modal', { labels: ['opsdashboard'] }), say('ACME-58', 'Show ops totals on the dashboard')], [null, null]);
  const tickets = [issue('ACME-46', 'Task', 'P2'), { ...issue('ACME-47', 'Task', 'P2'), fields: { ...issue('ACME-47', 'Task', 'P2').fields, summary: 'Should we adopt pnpm workspaces?' } }];
  const got = list(readsOf({ issues: tickets, desc: { 'ACME-46': CLEAN, 'ACME-47': CLEAN } }));
  t('VERIFY a policy-question Task is listed under left out, not offered', [got.offered.map((c) => c.key), renderLines(got, { project: 'ACME' }).find((l) => l.startsWith('left out'))],
    [['ACME-46'], 'left out: ACME-47 (a decision or work outside the repo ("Should we" in its summary))']);
}
t('AC1 a row naming no field ranks Jira\'s own priority by its own names', rankOf({ fields: { priority: { name: 'High' } } }, priorityOf(['none'])), 1);
t('AC1 the field is read from the row', priorityOf(PRIORITY), { field: 'customfield_10300', names: ['P0', 'P1', 'P2'], order: ['p0', 'p1', 'p2'] });
t('AC1 a Task with an open blocker is left out', leftOut(issue('ACME-5', 'Task', 'P1', { issuelinks: [blockedBy('ACME-9', 'indeterminate')] })), 'blocked by ACME-9');
t('AC1 one whose blocker is done is self-contained', leftOut(issue('ACME-5', 'Task', 'P1', { issuelinks: [blockedBy('ACME-9', 'done')] })), null);
t('AC1 a Task under an epic with a running feature batch is left out',
  leftOut(issue('ACME-6', 'Task', 'P1', { parent: { key: 'ACME-50' } }), { liveEpics: new Set(['ACME-50']) }), 'a child of epic ACME-50, whose feature batch is running');
t('AC1 one under an epic with no live batch is self-contained', leftOut(issue('ACME-6', 'Task', 'P1', { parent: { key: 'ACME-50' } })), null);
t('AC1 a Bug is offered whatever its links', leftOut(issue('ACME-7', 'Bug', 'P1', { issuelinks: [blockedBy('ACME-9', 'new')] })), null);
t('AC1 a ticket already in a batch is left out', leftOut(issue('ACME-8', 'Bug', 'P1'), { queued: new Set(['ACME-8']) }), 'in a batch already');

// AC2: a key in a merged PR title or a commit on the default branch is already on main, and not offered.
{
  const r = readsOf({
    issues: [issue('ACME-10', 'Bug', 'P0'), issue('ACME-11', 'Task', 'P1'), issue('ACME-12', 'Task', 'P2'), issue('ACME-13', 'Bug', 'P2')],
    desc: { 'ACME-10': CLEAN, 'ACME-11': CLEAN, 'ACME-12': CLEAN, 'ACME-13': CLEAN },
    prs: { 'ACME-10': [{ number: 98, title: 'fix(login): ACME-10 redirect after sign-in', headRefName: 'fix/ACME-10-redirect' }],
      'ACME-13': [{ number: 77, title: 'fix: ACME-130 something else', headRefName: 'fix/ACME-130' }] },
    commits: { 'ACME-11': [{ sha: 'abc1234', subject: 'Merge pull request #105 from acme/feat/ACME-11-tidy' }],
      'ACME-12': [{ sha: 'def5678', subject: 'feat: ACME-12 direct to main' }] },
  });
  const got = list(r);
  t('AC2 a merged PR naming the key, a merge commit naming it and a bare commit are on main', got.onMain.map((c) => [c.key, c.pr ?? c.commit]), [['ACME-10', 98], ['ACME-11', 105], ['ACME-12', 'def5678']]);
  t('AC2 and none of them is offered; a longer key is not this one', got.offered.map((c) => c.key), ['ACME-13']);
  const lines = renderLines(got, { project: 'ACME' });
  t('AC2 the listing says already on main (PR #n)', lines.filter((l) => l.includes('already on main')), ['  ACME-10  already on main (PR #98)', '  ACME-11  already on main (PR #105)', '  ACME-12  already on main (commit def5678)']);
}
t('AC2 a key inside another word is not named', onMain('ACME-1', { prs: [{ number: 1, title: 'XACME-1 and ACME-12' }] }), null);
{
  const r = readsOf({ issues: [issue('ACME-14', 'Bug', 'P0')], desc: { 'ACME-14': CLEAN } });
  r.mergedPrs = () => null;
  t('AC2 an unread GitHub is said, not taken as not on main', list(r).offered[0].flags, ['not checked against merged PRs: it could not be read']);
}

// AC3: no Acceptance criteria or no Design section is said, as triage's lint reads them.
const NO_DESIGN = 'no Design section (no design link or "No UI." line)';
t('AC3 wiki headings', missingSections(CLEAN), []);
t('AC3 markdown headings', missingSections('## Acceptance criteria\n- AC1\n## Design\nNo UI.'), []);
t('AC3 neither section', missingSections('h2. Problem\nIt breaks.'), ['no Acceptance criteria', NO_DESIGN]);
t('AC3 the words in prose are not a section', missingSections('The design has no acceptance criteria yet.'), ['no Acceptance criteria', NO_DESIGN]);
t('AC3 an empty criteria section is no criteria', missingSections('h2. Acceptance criteria\n\nh2. Design\nNo UI.'), ['no Acceptance criteria']);
t('AC3 a Design section with no link and no "No UI." is said', missingSections('h2. Acceptance criteria\n* AC1\nh2. Design\nTo follow.'), [NO_DESIGN]);
t('AC3 a Figma link anywhere is a design, as lint takes it', missingSections('h2. Acceptance criteria\n* AC1\nSee https://www.figma.com/file/abc/x'), []);

// AC4: a named file a PR merged in the last 7 days changed names that PR.
t('AC4 the files a description names', [...namedFiles('Fix `desk/bin/pass.mjs` and intake.mjs; see https://example.com/a/b.html and v1.2 notes.')], ['desk/bin/pass.mjs', 'intake.mjs']);
t('AC4 a bare name matches it in any directory', overlapOf(new Set(['intake.mjs', 'desk/bin/pass.mjs']), [{ number: 7, files: [{ path: 'desk/bin/intake.mjs' }, { path: 'README.md' }] }, { number: 8, files: [{ path: 'docs/x.md' }] }]),
  [{ number: 7, files: ['desk/bin/intake.mjs'] }]);

// Verification: a ticket in a merged PR title is on main, one lacking ACs is flagged, a clean one is first.
{
  const r = readsOf({
    issues: [issue('ACME-20', 'Bug', 'P0'), issue('ACME-21', 'Bug', 'P0'), issue('ACME-22', 'Task', 'P1'), issue('ACME-23', 'Task', 'P2')],
    desc: { 'ACME-20': CLEAN, 'ACME-21': 'h2. Design\nNo UI.', 'ACME-22': `${CLEAN}\nTouches desk/bin/intake.mjs.`, 'ACME-23': CLEAN },
    prs: { 'ACME-20': [{ number: 300, title: 'fix: ACME-20 done already', headRefName: 'fix/ACME-20' }] },
    recent: [{ number: 310, files: [{ path: 'desk/bin/intake.mjs' }] }],
  });
  const got = list(r);
  t('VERIFY the clean one is offered first, then the flagged ones by priority', got.offered.map((c) => c.key), ['ACME-23', 'ACME-21', 'ACME-22']);
  t('VERIFY the one lacking ACs says so', got.offered.find((c) => c.key === 'ACME-21').flags, ['no Acceptance criteria']);
  t('VERIFY the overlapping one names the PR', got.offered.find((c) => c.key === 'ACME-22').overlap, [{ number: 310, files: ['desk/bin/intake.mjs'] }]);
  t('VERIFY the merged PRs are read once a listing', r.calls.recent, 1);
  const lines = renderLines(got, { project: 'ACME' });
  t('VERIFY the listing', lines, [
    'candidates for a free slot from ACME, by priority:',
    '  1. ACME-23  P2  Task  ACME-23 summary',
    '  2. ACME-21  P0  Bug  ACME-21 summary — no Acceptance criteria',
    '  3. ACME-22  P1  Task  ACME-22 summary — possible overlap with #310, merged in the last 7 days (desk/bin/intake.mjs)',
    'not offered:',
    '  ACME-20  already on main (PR #300)',
    'admit one with /desk-admit <KEY>; this list admits nothing',
  ]);
}
{
  const issues = Array.from({ length: 20 }, (_, i) => issue(`ACME-${100 + i}`, 'Bug', 'P1'));
  const r = readsOf({ issues, desc: Object.fromEntries(issues.map((x) => [x.key, CLEAN])) });
  const got = listCandidates({ project: 'ACME', priority: PRIORITY, reads: r, checkMax: 3 });
  t('only the first checkMax are checked, the rest counted, and no lower tier searched', [got.offered.length, got.unchecked, got.more, unassigned(r).length], [3, 17, true, 2]);
  t('the listing says so', renderLines(got, { project: 'ACME' }).at(-2), '17+ more not checked: only the first 15 by priority are');
}
{
  // A backlog past a page: the first page of the top tier is read, not refused.
  const issues = Array.from({ length: 150 }, (_, i) => issue(`ACME-${200 + i}`, 'Bug', 'P0'));
  const r = readsOf({ issues, desc: Object.fromEntries(issues.map((x) => [x.key, CLEAN])) });
  const got = list(r);
  t('a tier past one page lists its first page', [got.ok, got.offered.length, got.offered[0].key, got.unchecked, got.more], [true, 15, 'ACME-200', 85, true]);
}
t('a failed search is said', renderLines(listCandidates({ project: 'ACME', priority: PRIORITY, reads: { ...readsOf({ issues: [] }), search: () => ({ ok: false, why: 'HTTP 401' }) } }), { project: 'ACME' }), ['no candidates: HTTP 401']);

// AC1's auto-fill: the pass's lines, kept between passes and read again once CANDIDATES_EVERY_MS has passed.
{
  const S = scratch('candidates-');
  let n = 0;
  const lst = () => { n++; return { lines: [`run ${n}`] }; };
  const now = Date.parse('2026-11-25T12:00:00Z');
  t('a first pass lists and keeps', slotLines({ state: S, now, list: lst }), ['free slot: run 1']);
  t('a pass before the interval reads the kept listing', slotLines({ state: S, now: now + CANDIDATES_EVERY_MS - 1, list: lst }), ['free slot: run 1']);
  t('one after it lists again', slotLines({ state: S, now: now + CANDIDATES_EVERY_MS, list: lst }), ['free slot: run 2']);
  t('a dry pass keeps nothing', [slotLines({ state: S, now: now + 3 * CANDIDATES_EVERY_MS, dry: true, list: lst }), JSON.parse(readFileSync(join(S, 'candidates.json'), 'utf8')).lines], [['free slot: run 3'], ['run 2']]);
  t('the row is on only at on', ['on', 'ON', 'off', '', null, 'TODO'].map((v) => slotCandidatesOn(v)), [true, true, false, false, false, false]);
}

// #1484: the person's own unstarted assigned tickets come first, then the unassigned ones.
const mine = (key, type, p, who = ME) => issue(key, type, p, { assignee: { accountId: who } });
const OWN = 'project = "ACME" AND issuetype in (Bug, Task) AND assignee = "acct-1" AND statusCategory = "To Do"';
t('#1484 AC1 the own searches ask for the §1 account id, a priority tier each', candidatesJqls('ACME', priorityOf(PRIORITY), ownAssignee('acct-1')), [
  `${OWN} AND cf[10300] = "P0" ORDER BY created DESC`,
  `${OWN} AND cf[10300] = "P1" ORDER BY created DESC`,
  `${OWN} AND cf[10300] = "P2" ORDER BY created DESC`,
  `${OWN} AND (cf[10300] is EMPTY OR cf[10300] not in ("P0", "P1", "P2")) ORDER BY cf[10300] ASC, created DESC`,
]);
t('#1484 AC1 with no account id, the signed-in Jira user', ownAssignee(null), 'assignee = currentUser()');
{
  // More of the person's own than a page: the top tier is read first, so an older P0 is not lost behind newer P2s.
  const at = (d) => ({ created: `2026-11-${String(d).padStart(2, '0')}T09:00:00.000+0000`, assignee: { accountId: ME } });
  // The fake reads in array order, so the P0 sits after a page of P2s, as a created-ordered search would hold it.
  const issues = [...Array.from({ length: 120 }, (_, i) => issue(`ACME-${300 + i}`, 'Task', 'P2', at(20))), issue('ACME-80', 'Bug', 'P0', at(1))];
  const got = list(readsOf({ issues, desc: Object.fromEntries(issues.map((x) => [x.key, CLEAN])) }));
  t('#1484 AC1 an older P0 of the person\'s own comes first past a page of P2s', [got.offered[0].key, got.more], ['ACME-80', true]);
}
t('#1484 AC1 the §1 row read as the person, none and TODO as unset', ['712020:0d2c', 'none', 'TODO', '', null].map((v) => personOf(v)), ['712020:0d2c', null, null, null, null]);
{
  const issues = [issue('ACME-60', 'Bug', 'P0'), mine('ACME-61', 'Task', 'P2'), mine('ACME-62', 'Bug', 'P1'), mine('ACME-63', 'Task', 'P0'),
    mine('ACME-64', 'Task', 'P0', 'acct-someone-else'), issue('ACME-65', 'Task', 'P1')];
  const r = readsOf({ issues, desc: { ...Object.fromEntries(issues.map((x) => [x.key, CLEAN])), 'ACME-62': 'h2. Design\nNo UI.' },
    open: [{ number: 400, title: 'feat: something', headRefName: 'feat/ACME-63-started', author: { login: 'mousedown' } }] });
  const got = list(r);
  t('#1484 AC1 the person\'s own come first, in priority order, a flagged one too, then the unassigned', got.offered.map((c) => [c.key, c.own]),
    [['ACME-62', true], ['ACME-61', true], ['ACME-60', false], ['ACME-65', false]]);
  t('#1484 AC1 one someone else\'s open PR names is started, so left out', got.left, [{ key: 'ACME-63', why: 'open PR #400 by mousedown' }]);
  t('#1484 AC1 the open PRs are read once a listing', r.calls.openPrs, 1);
  t('#1484 AC2 a ticket assigned to someone else is neither searched for nor offered', [r.calls.search.some((c) => c.jql.includes('acct-someone-else')), got.offered.some((c) => c.key === 'ACME-64'), got.left.some((l) => l.key === 'ACME-64')], [false, false, false]);
  t('#1484 VERIFY the listing names them first, as ready to admit', renderLines(got, { project: 'ACME' }), [
    'your unstarted assigned tickets in ACME, ready to admit:',
    '  1. ACME-62  P1  Bug  ACME-62 summary — no Acceptance criteria',
    '  2. ACME-61  P2  Task  ACME-61 summary',
    'candidates for a free slot from ACME, by priority:',
    '  3. ACME-60  P0  Bug  ACME-60 summary',
    '  4. ACME-65  P1  Task  ACME-65 summary',
    'left out: ACME-63 (open PR #400 by mousedown)',
    'admit one with /desk-admit <KEY>; this list admits nothing',
  ]);
  const only = listCandidates({ project: 'ACME', priority: PRIORITY, reads: readsOf({ issues, desc: Object.fromEntries(issues.map((x) => [x.key, CLEAN])) }), ownOnly: true });
  t('#1484 AC3 own only lists the person\'s own and searches nothing else', [only.offered.map((c) => c.key), renderLines(only, { project: 'ACME' })[0]], [['ACME-63', 'ACME-62', 'ACME-61'], 'your unstarted assigned tickets in ACME, ready to admit:']);
  t('#1484 AC3 own only with none of the person\'s own says nothing', renderLines(listCandidates({ project: 'ACME', priority: PRIORITY, reads: readsOf({ issues: [issue('ACME-66', 'Bug', 'P0')] }), ownOnly: true }), { project: 'ACME' }), []);
  const failed = (ownOnly) => renderLines(listCandidates({ project: 'ACME', priority: PRIORITY, reads: { ...readsOf({ issues: [] }), search: () => ({ ok: false, why: 'HTTP 401' }) }, ownOnly }), { project: 'ACME' });
  t('#1484 AC3 own only says nothing of a failed search either; the whole list says it', [failed(true), failed(false)], [[], ['no candidates: HTTP 401']]);
  const unread = readsOf({ issues: [mine('ACME-67', 'Bug', 'P0')], desc: { 'ACME-67': CLEAN } });
  unread.openPrs = () => null;
  t('#1484 AC1 unread open PRs are said, not taken as none', list(unread).offered[0].flags, ['not checked for an open PR: the open PRs could not be read']);
  t('#1484 the unassigned heading says when only the person\'s own are offered', renderLines(list(readsOf({ issues: [mine('ACME-68', 'Bug', 'P0')], desc: { 'ACME-68': CLEAN } })), { project: 'ACME' })[2], 'no unassigned candidates for a free slot from ACME');
}
{
  // #1501: an open PR naming a candidate's key, by anyone but §1 GitHub handle, leaves it out; the
  // person's own keeps it offered, flagged for the batch to adopt; closed PRs change nothing.
  const issues = [issue('ACME-70', 'Bug', 'P0'), issue('ACME-71', 'Bug', 'P1'), issue('ACME-72', 'Task', 'P1'), mine('ACME-73', 'Task', 'P2'), issue('ACME-74', 'Task', 'P2')];
  const desc = Object.fromEntries(issues.map((x) => [x.key, CLEAN]));
  const open = [
    { number: 3478, title: 'fix(auth-roles): ACME-70 tell a locked account why', headRefName: 'fix/acme-70-locked', isDraft: true, author: { login: 'mousedown' } },
    { number: 3480, title: 'fix: ACME-71 retry', headRefName: 'fix/ACME-71-retry', author: { login: 'Me-GH' } },
    { number: 3481, title: 'feat: unrelated', headRefName: 'feat/ACME-73-own', author: { login: 'me-gh' } },
    { number: 3482, title: 'fix: ACME-74 by me', headRefName: 'fix/ACME-74', author: { login: 'me-gh' } },
    { number: 3483, title: 'fix: ACME-74 by them', headRefName: 'fix/ACME-74-b', author: { login: 'someone' } },
  ];
  // ACME-72's only PR is closed without merging: the open list never holds it, and no merged PR names it.
  const r = readsOf({ issues, desc, open });
  const got = listCandidates({ project: 'ACME', priority: PRIORITY, handle: 'me-gh', reads: r, now: Date.parse('2026-11-26T12:00:00Z') });
  t('#1501 AC1 another author\'s open PR, draft or not, leaves it out naming the PR and its author', got.left,
    [{ key: 'ACME-70', why: 'open PR #3478 by mousedown' }, { key: 'ACME-74', why: 'open PR #3483 by someone' }]);
  t('#1501 AC2 the person\'s own open PR keeps it offered, flagged with the PR, own or unassigned', got.offered.map((c) => [c.key, c.flags, c.openPr ?? null]),
    [['ACME-73', ['open PR #3481'], 3481], ['ACME-72', [], null], ['ACME-71', ['open PR #3480'], 3480]]);
  t('#1501 AC3 one whose PRs are all closed unmerged is offered clean', got.offered.find((c) => c.key === 'ACME-72')?.flags, []);
  t('#1501 the open PRs are read once a listing', r.calls.openPrs, 1);
  t('#1501 VERIFY the listing names them', renderLines(got, { project: 'ACME' }).filter((l) => /ACME-7[01]/.test(l)), [
    '  3. ACME-71  P1  Bug  ACME-71 summary — open PR #3480; adopt it with node ~/.claude/desk/bin/queue.mjs adopt ACME-71 3480 --filed, not /desk-admit, which would open a second PR',
    'left out: ACME-70 (open PR #3478 by mousedown), ACME-74 (open PR #3483 by someone)',
  ]);
  t('#1501 AC2 the person\'s own flagged one is adopted on its PR, not admitted to a second', renderLines(got, { project: 'ACME' }).find((l) => l.includes('ACME-73')),
    '  1. ACME-73  P2  Task  ACME-73 summary — open PR #3481; adopt it with node ~/.claude/desk/bin/queue.mjs adopt ACME-73 3481 --filed, not /desk-admit, which would open a second PR');
  t('#1501 a clean one names no adopt command', renderLines(got, { project: 'ACME' }).find((l) => l.includes('ACME-72')).includes('adopt'), false);  const noHandle = listCandidates({ project: 'ACME', priority: PRIORITY, reads: readsOf({ issues, desc, open }) });
  t('#1501 with no GitHub handle every open PR is someone else\'s', noHandle.left.map((l) => l.key), ['ACME-73', 'ACME-70', 'ACME-71', 'ACME-74']);
  const unread = readsOf({ issues, desc });
  unread.openPrs = () => null;
  const blind = listCandidates({ project: 'ACME', priority: PRIORITY, handle: 'me-gh', reads: unread });
  t('#1501 AC4 with GitHub unread, each candidate is marked unchecked, not offered as clear', [blind.left, blind.offered.map((c) => c.flags.includes('not checked for an open PR: the open PRs could not be read'))],
    [[], [true, true, true, true, true]]);
}
{
  // AC3: the idle pass asks for the person's own alone with §3b "Propose candidates" off, and a kept
  // listing read the other way is read again.
  const S = scratch('candidates-own-');
  const asked = [];
  const lst = ({ ownOnly } = {}) => { asked.push(ownOnly); return { lines: [ownOnly ? 'yours' : 'all'] }; };
  const now = Date.parse('2026-11-26T12:00:00Z');
  t('#1484 AC3 the pass names the person\'s own with the row off', slotLines({ state: S, now, ownOnly: true, list: lst }), ['free slot: yours']);
  t('#1484 AC3 kept between passes', slotLines({ state: S, now: now + 1, ownOnly: true, list: lst }), ['free slot: yours']);
  t('#1484 AC3 the row turned on reads again', [slotLines({ state: S, now: now + 2, list: lst }), asked], [['free slot: all'], [true, false]]);
}

// #1710: the pass admits one checked candidate for a free slot.
{
  t('#1710 AC1 the admit row is off unless on', [admitCandidatesOn('on'), admitCandidatesOn('off'), admitCandidatesOn(''), admitCandidatesOn(undefined)], [true, false, false, false]);
  const cand = (key, extra = {}) => ({ key, own: false, flags: [], overlap: [], blockers: [], ...extra });
  const checks = (landed = {}, away = {}) => ({ landed: (k) => (k in landed ? landed[k] : true), elsewhere: (k) => away[k] ?? null });
  t('#1710 AC1 a clean candidate passes', admitRefusal(cand('ACME-1', { blockers: [{ key: 'ACME-9', category: 'done' }] }), 'main', checks()), null);
  t('#1710 AC1 one with no Acceptance criteria is refused', admitRefusal(cand('ACME-2', { flags: ['no Acceptance criteria'] }), 'main', checks()), 'no Acceptance criteria');
  t('#1710 AC1 a blocker not Done is refused', admitRefusal(cand('ACME-3', { blockers: [{ key: 'ACME-9', category: 'indeterminate' }] }), 'main', checks()), 'blocker ACME-9 is not Done');
  t('#1710 AC1 a Done blocker whose work is merged only into a feature branch is refused', admitRefusal(cand('ACME-4', { blockers: [{ key: 'ACME-9', category: 'done' }] }), 'main',
    checks({ 'ACME-9': false }, { 'ACME-9': { branch: 'feat/ACME-100-epic', state: 'none' } })), 'blocker ACME-9 is merged into feat/ACME-100-epic, not main');
  t('#1710 AC1 a blocker GitHub could not be read for is refused', admitRefusal(cand('ACME-5', { blockers: [{ key: 'ACME-9', category: 'done' }] }), 'main', checks({ 'ACME-9': null })),
    'whether blocker ACME-9 is on main could not be read');
  t('#1710 AC1 a PR naming it merged into a feature branch is refused', admitRefusal(cand('ACME-6'), 'main', checks({}, { 'ACME-6': { branch: 'feat/x', state: 'open' } })), 'a PR naming it is merged into feat/x, not main');
  t('#1710 AC1 one whose feature branch already merged into the base passes', admitRefusal(cand('ACME-7'), 'main', checks({}, { 'ACME-7': { branch: 'feat/x', state: 'merged' } })), null);

  // admitRun: the listing's offered entries, admit and assign stubbed.
  const now = Date.parse('2026-11-28T12:00:00Z');
  const runWith = (S, offered, { admitted = () => true, own = false, assignSelf = 'yes', at = now, dry = false, landed = {}, away = {}, on = true } = {}) => {
    const calls = { admit: [], assign: [], list: 0 };
    const lines = admitRun({ state: S, base: 'main', now: at, dry, assignSelf, on, checks: checks(landed, away),
      list: () => { calls.list++; return { result: { ok: true, offered: offered.map((c) => ({ own, ...c })) } }; },
      admit: (k) => { calls.admit.push(k); return admitted(k) ? { admitted: true } : { admitted: false, why: `not admitted ${k}: open questions` }; },
      assign: (k) => { calls.assign.push(k); return { ok: true }; } });
    return { lines, calls, kept: (() => { try { return JSON.parse(readFileSync(join(S, 'candidate-admit.json'), 'utf8')); } catch { return null; } })() };
  };
  {
    const S = scratch('candidates-admit-');
    const r = runWith(S, [cand('ACME-20', { flags: ['no Acceptance criteria'] }),
      cand('ACME-21', { blockers: [{ key: 'ACME-9', category: 'done' }] }), cand('ACME-22'), cand('ACME-23')],
    { landed: { 'ACME-9': false }, away: { 'ACME-9': { branch: 'feat/ACME-100-epic', state: 'none' } } });
    t('#1710 AC2 one clean candidate is admitted, the first in order, and assigned', [r.calls.admit, r.calls.assign], [['ACME-22'], ['ACME-22']]);
    t('#1710 AC3 the pass says what it admitted and refused, with why', r.lines, [
      'free slot: admitted ACME-22 (assigned to you)',
      'free slot: refused ACME-20 (no Acceptance criteria), ACME-21 (blocker ACME-9 is merged into feat/ACME-100-epic, not main)',
    ]);
    t('#1710 AC3 the run is kept for desk-q', [r.kept.at, r.kept.admitted, r.kept.refused.map((x) => x.key)], ['2026-11-28T12:00:00.000Z', { key: 'ACME-22', note: 'assigned to you' }, ['ACME-20', 'ACME-21']]);
    t('#1710 AC3 desk-q\'s repo screen shows the last run and its reasons', admitHead({ stateDir: S }, now + 5 * 60_000), [
      'free-slot admit 5m ago: admitted ACME-22 (assigned to you) · refused ACME-20 (no Acceptance criteria), ACME-21 (blocker ACME-9 is merged into feat/ACME-100-epic, not main)']);
    t('#1710 AC3 and nothing before a run', admitHead({ stateDir: scratch('candidates-admit-none-') }, now), []);
    const again = runWith(S, [cand('ACME-23')], { at: now + 60_000 });
    t('#1710 AC2 a second pass inside the interval reads and admits nothing', [again.lines, again.calls.list, again.calls.admit], [[], 0, []]);
  }
  {
    const S = scratch('candidates-admit-refused-');
    const r = runWith(S, [cand('ACME-30'), cand('ACME-31')], { admitted: (k) => k !== 'ACME-30' });
    t('#1710 AC2 a candidate the admit refuses stops the run: one admit a pass', [r.calls.admit, r.lines], [['ACME-30'],
      ['free slot: refused ACME-30 (not admitted ACME-30: open questions)', 'free slot: admitted nothing: the one candidate tried this run was refused']]);
    const next = runWith(S, [cand('ACME-30'), cand('ACME-31')], { at: now + CANDIDATES_EVERY_MS });
    t('#1710 AC2 it is passed over next run, and the next candidate admitted', next.calls.admit, ['ACME-31']);
    const day = runWith(S, [cand('ACME-30')], { at: now + 2 * CANDIDATES_EVERY_MS + ADMIT_RETRY_MS });
    t('#1710 after a day it is tried again', day.calls.admit, ['ACME-30']);
  }
  {
    const S = scratch('candidates-admit-assign-');
    t('#1710 AC2 with jira-assign-self not yes it is admitted unassigned, saying so', runWith(S, [cand('ACME-40')], { assignSelf: 'no' }).lines, ['free slot: admitted ACME-40 (not assigned: config §3 jira-assign-self is no)']);
    const S2 = scratch('candidates-admit-own-');
    const own = runWith(S2, [cand('ACME-41')], { own: true });
    t('#1710 AC2 the person\'s own is admitted with no assignment', [own.calls.assign, own.lines], [[], ['free slot: admitted ACME-41']]);
    const S3 = scratch('candidates-admit-dry-');
    const dry = runWith(S3, [cand('ACME-42')], { dry: true });
    t('#1710 a dry run admits nothing and keeps nothing', [dry.calls.admit, dry.lines, dry.kept], [[], ['free slot: would admit ACME-42'], null]);
  }
  {
    const S = scratch('candidates-admit-off-');
    const off = runWith(S, [cand('ACME-50')], { on: false });
    t('#1710 AC4 with the row off nothing is listed, admitted or kept', [off.lines, off.calls, off.kept], [[], { admit: [], assign: [], list: 0 }, null]);
  }
}

// The command: no Jira tracker is exit 3, saying so.
{
  const S = scratch('candidates-cli-');
  mkdirSync(join(S, 'cfg/repos/acme__widgets'), { recursive: true });
  mkdirSync(join(S, 'home'));
  writeFileSync(join(S, 'cfg/repos/acme__widgets/config.md'), '## 0. Repo\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widgets` |\n\n## 4. Tracker\n| Field | Value |\n|---|---|\n| Tracker | `none` |\n');
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'candidates.mjs');
  const env = { ...process.env, HOME: join(S, 'home'), DESK_CONFIG_ROOT: join(S, 'cfg'), DESK_REPO_OVERRIDE: 'acme/widgets', DESK_AUTOPILOT_STATE: join(S, 'state') };
  for (const k of ['DESK_CONFIG', 'DESK_REPO_DIR', 'DESK_REPO_ROOT', 'DESK_SLUG', 'DESK_STATE', 'DESK_GH_REPO', 'DESK_BATCH']) delete env[k];
  let r = spawnSync(process.execPath, [bin], { encoding: 'utf8', env, cwd: S });
  t('no Jira tracker is exit 3, saying why', [r.status, r.stdout.trim()], [3, 'no candidates: config §4 Tracker is not jira, and candidates come from a Jira project']);
  r = spawnSync(process.execPath, [bin, '--bogus'], { encoding: 'utf8', env, cwd: S });
  t('an unknown argument is exit 2', r.status, 2);
}

process.exit(fails ? 1 : 0);
