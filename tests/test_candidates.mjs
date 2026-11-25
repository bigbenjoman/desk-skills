// suite: candidates (what to admit into a free batch slot, checked against main before it is offered)
// layer: L2
// covers: desk/bin/candidates.mjs
// listCandidates with stubbed Jira, GitHub and git reads; slotLines' keeping between passes; the command
// with no Jira tracker. Scratch directories only.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCandidates, renderLines, priorityOf, rankOf, leftOut, missingSections, namedFiles, overlapOf, onMain, slotLines, slotCandidatesOn, candidatesJqls, CANDIDATES_EVERY_MS } from '../desk/bin/candidates.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const PRIORITY = ['customfield_10300', 'P0', 'P1', 'P2'];
const issue = (key, type, p, extra = {}) => ({ key, fields: { issuetype: { name: type }, summary: `${key} summary`, customfield_10300: p ? { value: p } : null, issuelinks: [], ...extra } });
const blockedBy = (key, category) => ({ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key, fields: { status: { statusCategory: { key: category } } } } });
const CLEAN = 'h2. Acceptance criteria\n* Given x, when y, then z\nh2. Design\nNo UI.';

// reads: every ticket's description, merged PRs and commits keyed by ticket, and the recent PRs. The
// search answers each priority tier's JQL with that tier's issues, one page of `max`.
function readsOf({ issues, desc = {}, prs = {}, commits = {}, recent = [], queued = [], liveEpics = [] }) {
  const calls = { search: [], recent: 0 };
  return {
    calls,
    search: (jql, max, fields) => {
      calls.search.push({ jql, max, fields });
      const tier = /cf\[10300\] = "([^"]+)"/.exec(jql)?.[1];
      const rest = /is EMPTY OR/.test(jql);
      const hits = issues.filter((i) => { const v = i.fields.customfield_10300?.value ?? null; return tier ? v === tier : rest ? !['P0', 'P1', 'P2'].includes(v) : true; });
      return { ok: true, issues: hits.slice(0, max), more: hits.length > max };
    },
    description: (k) => (k in desc ? { ok: true, text: desc[k] } : { ok: false, why: 'no such issue' }),
    mergedPrs: (k) => prs[k] ?? [],
    commits: (k) => commits[k] ?? [],
    recent: () => { calls.recent++; return recent; },
    queued: () => new Set(queued),
    liveEpics: () => new Set(liveEpics),
  };
}
const list = (reads) => listCandidates({ project: 'ACME', priority: PRIORITY, reads, now: Date.parse('2026-11-25T12:00:00Z') });

// AC1: unassigned, unstarted Bugs and self-contained Tasks, ranked by the repo's priority field.
const BASE = 'project = "ACME" AND issuetype in (Bug, Task) AND assignee is EMPTY AND statusCategory = "To Do"';
t('AC1 the searches ask for unassigned, unstarted Bugs and Tasks, a priority tier each, then the unset or unlisted', candidatesJqls('ACME', priorityOf(PRIORITY)), [
  `${BASE} AND cf[10300] = "P0" ORDER BY created DESC`,
  `${BASE} AND cf[10300] = "P1" ORDER BY created DESC`,
  `${BASE} AND cf[10300] = "P2" ORDER BY created DESC`,
  `${BASE} AND (cf[10300] is EMPTY OR cf[10300] not in ("P0", "P1", "P2")) ORDER BY created DESC`,
]);
t('AC1 with no values listed, one search Jira orders by its own priority', candidatesJqls('ACME', priorityOf(['none'])), [`${BASE} ORDER BY priority DESC, created DESC`]);
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
  t('AC1 the P2 tier filled the list, so no P4 search ran', r.calls.search.map((c) => /= "([^"]+)"/.exec(c.jql)?.[1]), ['P0', 'P1', 'P2']);
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
  const tickets = [issue('ACME-46', 'Task', 'P2'), { ...issue('ACME-47', 'Task', 'P2'), fields: { ...issue('ACME-47', 'Task', 'P2').fields, summary: 'Should we adopt pnpm workspaces?' } }];
  const got = list(readsOf({ issues: tickets, desc: { 'ACME-46': CLEAN, 'ACME-47': CLEAN } }));
  t('VERIFY a policy-question Task is listed under left out, not offered', [got.offered.map((c) => c.key), renderLines(got, { project: 'ACME' }).find((l) => l.startsWith('left out'))],
    [['ACME-46'], 'left out: ACME-47 (a decision or work outside the repo ("adopt" in its summary))']);
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
  t('only the first checkMax are checked, the rest counted, and no lower tier searched', [got.offered.length, got.unchecked, got.more, r.calls.search.length], [3, 17, true, 2]);
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
