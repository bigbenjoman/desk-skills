// suite: handoff report (which context-handoff threshold costs least, from interactive session transcripts)
// layer: L2
// covers: desk/bin/handoff-report.mjs desk/bin/pr-outcomes.mjs
// handoff-report.mjs on fixture transcripts in a scratch HOME and projects folder: the arm read from the
// hook's injection, a compaction and its resume overhead, a resumed session taking the arm of the
// session that named its handoff, active hours with an idle gap capped, dollars at list prices and
// an unpriced model counted, per-arm totals, and the recommendation against the guardrails from a
// per-ticket rows file, where only tickets with an outcome count, and dollars compared only where
// every request is priced. A session on the default branch reaches its tickets through the PRs its
// Bash calls opened, pushed or merged; one that reaches none is measured on the session guardrails
// alone; and a window short of data says how many sessions it mapped and why the rest did not. Work
// no queue ticket is behind is measured on its merged PRs, read from a gh stub on PATH answering
// from fixtures and logging each call: reverts, red main, follow-up fixes and review rounds, the cache
// of final outcomes, --offline, and each window's sample against the minimum.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const BIN = fileURLToPath(new URL('../desk/bin/handoff-report.mjs', import.meta.url));

const T = scratch('desk-handoff-report-');
const HOME = join(T, 'home');
const ROOT = join(T, 'projects');
const P = join(ROOT, '-x-repo');
const OTHER = join(ROOT, '-y-other');
for (const d of [HOME, P, OTHER]) mkdirSync(d, { recursive: true });

const T0 = Date.parse('2026-11-02T10:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const user = (min, text = 'go', branch = 'main') => ({ type: 'user', timestamp: at(min), gitBranch: branch, message: { role: 'user', content: text } });
const req = (id, min, { uncached = 0, w5m = 0, w1h = 0, read = 0, output = 0, model = 'claude-opus-5-5' } = {}) => ({
  type: 'assistant', requestId: id, timestamp: at(min), isSidechain: false,
  message: { model, usage: { input_tokens: uncached, cache_creation_input_tokens: w5m + w1h, cache_read_input_tokens: read, output_tokens: output,
    cache_creation: { ephemeral_5m_input_tokens: w5m, ephemeral_1h_input_tokens: w1h } } },
});
const fireText = (pct, window, rel) => `desk handoff: context is at ${pct}% of a ${window.toLocaleString('en-US')}-token window (threshold ${pct}%). `
  + `Finish the step you are on, then write the handoff and start no new work. Write it to /x/repo/${rel} (repo-relative: ${rel}): read it`;
// The hook's injection as Claude Code logs it: a hook_success line with the hook's stdout and a
// hook_additional_context line, both for one tool call.
const fire = (min, pct, window, rel = '.handoffs/2026-11-02.md', id = `tool-${min}`) => [
  { type: 'attachment', timestamp: at(min), attachment: { type: 'hook_success', toolUseID: id, hookEvent: 'PostToolUse', stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: fireText(pct, window, rel) } }) } },
  { type: 'attachment', timestamp: at(min), attachment: { type: 'hook_additional_context', toolUseID: id, hookEvent: 'PostToolUse', content: [fireText(pct, window, rel)] } },
];
const compact = (min) => ({ type: 'system', subtype: 'compact_boundary', timestamp: at(min), isSidechain: false, content: 'Conversation compacted' });
const session = (dir, name, lines) => writeFileSync(join(dir, `${name}.jsonl`), `${lines.flat().map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);

// One hour of work (a line every 5 minutes), one Opus request of `cost` uncached tokens ($4 a
// million), on `branch`; `extra` more lines.
const hour = (name, cost, branch, armAt = null, extra = []) => session(P, name, [
  ...Array.from({ length: 12 }, (_, i) => user(i * 5, 'go', branch)), req(`${name}-r`, 60, { uncached: cost }), ...(armAt ? fire(30, ...armAt) : []), ...extra,
]);
for (let i = 1; i <= 5; i += 1) {
  hour(`base${i}`, 1_000_000, `feat/${100 + i}-base`, [45, 200_000]);
  hour(`twenty${i}`, 600_000, `fix/twenty-${i}`, [20, 200_000]);
  hour(`thirty${i}`, 300_000, `fix/thirty-${i}`, [30, 200_000]);
  // One request on a model with no price: counted, and left out of the dollars.
  hour(`plain${i}`, 100_000, 'main', null, i === 1 ? [req('plain1-x', 61, { uncached: 5_000_000, model: 'some-other-model' })] : []);
  // A 300,000-token window: the 25% arm looks cheaper only because its costly requests have no price.
  hour(`w3base${i}`, 1_000_000, `feat/${200 + i}-w3`, [45, 300_000]);
  hour(`w3cheap${i}`, 500_000, `fix/w3-25-${i}`, [25, 300_000], [req(`w3cheap${i}-x`, 61, { uncached: 2_000_000, model: 'some-other-model' })]);
  // A 400,000-token window whose baseline has a request with no price.
  hour(`w4base${i}`, 1_000_000, 'main', [45, 400_000], i === 1 ? [req('w4base1-x', 61, { uncached: 1, model: 'some-other-model' })] : []);
  hour(`w4low${i}`, 500_000, 'main', [20, 400_000]);
}

// A compaction: the first request after the boundary is its resume overhead; the second is not.
session(P, 'compacting', [user(0), req('c1', 1, { uncached: 5, read: 90_000 }), fire(2, 50, 1_000_000, '.handoffs/2026-11-02-2.md'),
  compact(3), req('c2', 4, { uncached: 100, w5m: 200, read: 3000 }), req('c3', 5, { uncached: 7, read: 4000 })]);
// A session that starts from the handoff another named, at 2, 3 and 63 minutes: the idle hour counts 5 minutes.
session(P, 'resumed', [user(2, 'Read .handoffs/2026-11-02-2.md and continue from its next step.'),
  req('r1', 3, { uncached: 10, w5m: 100, w1h: 100, read: 1000, output: 3 }), req('r1', 3, { uncached: 10, w5m: 100, w1h: 100, read: 1000, output: 10 }), user(63), '{not json']);
// Another project's session: read with --all only.
session(OTHER, 'elsewhere', [user(0), req('o1', 1, { uncached: 1 }), fire(2, 45, 200_000)]);

// One Bash call and its result, on the default branch.
let calls = 0;
const bash = (min, command, output = '', isError = false) => {
  const id = `call-${calls += 1}`;
  return [
    { type: 'assistant', requestId: `${id}-req`, timestamp: at(min), isSidechain: false, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } },
    { type: 'user', timestamp: at(min), gitBranch: 'main', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: isError }] } },
  ];
};
const failing = (min) => bash(min, 'ls missing', 'ls: cannot access', true);
const URL_OF = (n) => `https://github.com/acme/widgets/pull/${n}`;
// A 500,000-token window, every session on main. The 45% baseline reaches its tickets five ways: a
// PR title it opened, a PR number the queue records, a branch it pushed, the title a merge printed,
// and an opened PR's head the queue records. Half its tool calls error.
const base5 = [
  bash(31, `gh pr create --title "DS-11: add a thing" --body "$(cat <<'EOF'\nWhat it does\nEOF\n)"`, `${URL_OF(511)}\n`),
  bash(31, 'gh pr merge 512 --squash --delete-branch', ''),
  bash(31, 'cd /x/repo-worktrees/DS-13 && git push -u origin feat/DS-13-thing 2>&1 | tail -2', 'branch set up to track'),
  bash(31, `gh pr merge ${URL_OF(514)} --squash`, '✓ Squashed and merged pull request acme/widgets#514 (DS-14 fix the thing)'),
  bash(31, 'gh pr create --head feat/x-5 --title tidy --fill', URL_OF(515)),
];
for (let i = 1; i <= 5; i += 1) {
  hour(`base5_${i}`, 1_000_000, 'main', [45, 500_000], [...base5[i - 1], ...failing(32)]);
  // The 20% arm: cheaper, its own PRs, the same share of tool calls erroring. The first also merges a
  // PR in another repo whose number the queue records for this one's ticket: not this repo's.
  hour(`low5_${i}`, 500_000, 'main', [20, 500_000], [...bash(31, `gh pr create -t "DS-2${i} a change"`, URL_OF(520 + i)), ...failing(32),
    ...(i === 1 ? bash(33, 'gh pr merge 512 --repo other/thing --squash', '') : [])]);
  // The 30% arm: cheapest, its tickets' guardrails holding, but every tool call errors.
  hour(`rw5_${i}`, 250_000, 'main', [30, 500_000], [...bash(31, `gh pr create --title "DS-3${i} another"`, URL_OF(530 + i), true), ...failing(32), ...failing(33)]);
}
// A session in the 20% arm that touched no PR: measured on the session guardrails alone.
hour('low5_nopr', 500_000, 'main', [20, 500_000], failing(32));
// A 600,000-token window no session of which reaches a ticket with an outcome: two touch nothing,
// one pushes a branch naming no key, one opens a PR naming a key no queue ticket has, and one merges
// the PR of a ticket still in flight. The 20% arm touches nothing.
const a6 = [[], [], bash(31, 'git push origin feat/cleanup'), bash(31, 'gh pr create --title "DS-99 a thing"', URL_OF(699)), bash(31, 'gh pr merge 698', '')];
for (let i = 1; i <= 5; i += 1) {
  hour(`a6_${i}`, 1_000_000, 'main', [45, 600_000], a6[i - 1]);
  hour(`b6_${i}`, 500_000, 'main', [20, 600_000], bash(31, 'ls', 'a'));
}

// A ticket with its outcome: merged and done, unless `open` leaves it in flight.
const ticket = (key, branch, fixTries, open = false) => ({ key, batch: null, branch, fix_tries: fixTries, parks_by_class: {}, post_merge: 0,
  ...(open ? { state: 'running', merged_at: null } : { state: 'done', merged_at: '2026-11-03T10:00:00Z' }) });
const baseTickets = [1, 2, 3, 4, 5].map((i) => ticket(String(100 + i), null, 1));
const write = (name, rows) => { const f = join(T, name); writeFileSync(f, JSON.stringify(rows)); return f; };
const prTickets = [ticket('DS-11', null, 1), { ...ticket('DS-12', null, 1), prs: [512] }, ticket('DS-13', null, 1), ticket('DS-14', null, 1),
  ticket('DS-15', 'feat/x-5', 1), ...[1, 2, 3, 4, 5].flatMap((i) => [ticket(`DS-2${i}`, null, 1), ticket(`DS-3${i}`, null, 1)]), { ...ticket('DS-98', null, 0, true), prs: [698] }];
const HOLDS = write('holds.json', [...baseTickets, ...prTickets, ...[1, 2, 3, 4, 5].map((i) => ticket(`T${i}`, `fix/twenty-${i}`, 1)),
  ...[1, 2, 3, 4, 5].map((i) => ticket(`H${i}`, `fix/thirty-${i}`, 5)),
  ...[1, 2, 3, 4, 5].flatMap((i) => [ticket(String(200 + i), null, 1), ticket(`W${i}`, `fix/w3-25-${i}`, 1)])]);
const BASE_ONLY = write('base-only.json', baseTickets);
const IN_FLIGHT = write('in-flight.json', [...baseTickets, ...[1, 2, 3].map((i) => ticket(`T${i}`, `fix/twenty-${i}`, 0, true))]);
// Requeued: merged once, running again.
const REQUEUED = write('requeued.json', [...baseTickets, ...[1, 2, 3].map((i) => ({ ...ticket(`T${i}`, `fix/twenty-${i}`, 0), state: 'running' }))]);

// A repo config holding only its §4 tracker rows.
const config = (name, tracker, pattern) => {
  const f = join(T, name);
  writeFileSync(f, `## 4. Tracker\n\n| Field | Value |\n|---|---|\n| Tracker | \`${tracker}\` |\n| Ticket key pattern | \`${pattern}\` |\n`);
  return f;
};
// A gh on PATH: logs each call, and answers each aliased read of a GraphQL query from the fixture
// file its environment names: a PR by number (its first page of files and reviews, or a later page
// of either, a page being 100), the merged PRs a head branch heads, and a search, filtered by its
// `merged:` range and `revert in:title`, sorted by merge time, paged by the fixture's searchPage. A
// number no fixture PR has is answered as GitHub does: null with a NOT_FOUND error, and exit 1 (or
// the fixture's errorType for every read, to stand for another failure).
function stubGh() {
  const fs = require('fs');
  const args = process.argv.slice(2);
  fs.appendFileSync(process.env.HANDOFF_GH_LOG, `${JSON.stringify(args)}\n`);
  const q = (args.find((a) => a.startsWith('query=')) || '').slice(6);
  const fx = process.env.HANDOFF_GH_FIXTURE ? JSON.parse(fs.readFileSync(process.env.HANDOFF_GH_FIXTURE, 'utf8')) : { prs: {}, search: [] };
  const page = (list, from, size = 100) => ({ pageInfo: { hasNextPage: from + size < list.length, endCursor: String(from + size) }, nodes: list.slice(from, from + size) });
  const files = (p) => (p.files || []).map((path) => ({ path }));
  const reviews = (p) => (p.reviews || []).map((r) => ({ submittedAt: r.at, commit: { oid: r.oid } }));
  const any = (n) => fx.prs[n] || (fx.search || []).find((c) => c.number === Number(n));
  const repository = {};
  const top = {};
  const errors = [];
  const none = (alias) => { errors.push({ type: fx.errorType || 'NOT_FOUND', path: ['repository', alias], message: 'Could not resolve to a PullRequest' }); return null; };
  const re = /(a\d+): (?:pullRequest\(number:(\d+)\)\{(?:(files|reviews)\(first:100(?:, after:"(\d+)")?\)|number )|pullRequests\(headRefName:("(?:[^"\\]|\\.)*")|search\(query:("(?:[^"\\]|\\.)*"), type:ISSUE, first:100(?:, after:"(\d+)")?)/g;
  for (const m of q.matchAll(re)) {
    const [, alias, n, list, from, head, search, sFrom] = m;
    if (n && list) repository[alias] = any(n) ? { [list]: page(list === 'files' ? files(any(n)) : reviews(any(n)), Number(from || 0)) } : none(alias);
    else if (n) {
      const p = fx.prs[n];
      repository[alias] = p && !fx.errorType ? { number: p.number, title: p.title, mergedAt: p.mergedAt, baseRefName: p.baseRefName, mergeCommit: p.mergeCommit,
        files: { totalCount: files(p).length, ...page(files(p), 0) }, reviews: { totalCount: reviews(p).length, ...page(reviews(p), 0) } } : none(alias);
    } else if (head) {
      const mine = Object.values(fx.prs).filter((p) => p.headRefName === JSON.parse(head) && p.mergedAt).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      repository[alias] = page(mine.map((p) => ({ number: p.number, createdAt: p.createdAt, mergedAt: p.mergedAt })), 0);
    }
    else {
      const text = JSON.parse(search);
      const [, a, b] = /merged:(\S+)\.\.(\S+)/.exec(text);
      const hits = (fx.search || []).filter((c) => c.mergedAt >= a && c.mergedAt <= b && (!text.includes('revert in:title') || /revert/i.test(c.title)))
        .sort((x, y) => x.mergedAt.localeCompare(y.mergedAt))
        .map((c) => ({ number: c.number, title: c.title, body: c.body || '', mergedAt: c.mergedAt, files: { totalCount: files(c).length, ...page(files(c), 0) } }));
      top[alias] = page(hits, Number(sFrom || 0), fx.searchPage || 100);
    }
  }
  process.stdout.write(JSON.stringify({ data: { repository, ...top }, ...(errors.length ? { errors } : {}) }));
  if (errors.length) process.exitCode = 1;
}
const STUB = join(T, 'stub');
mkdirSync(STUB, { recursive: true });
writeFileSync(join(STUB, 'gh'), `#!/usr/bin/env node\n(${stubGh.toString()})();\n`);
chmodSync(join(STUB, 'gh'), 0o755);
const GH_LOG = join(T, 'gh.log');
const ghCalls = () => (existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).length : 0);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DESK_') && k !== 'CLAUDE_CONFIG_DIR')), HOME, DESK_REPO_ROOT: '/x/repo',
  DESK_CONFIG: config('jira.md', 'jira', 'DS-[0-9]+'), DESK_GH_REPO: 'acme/widgets', DESK_DEFAULT_BRANCH: 'main',
  DESK_AUTOPILOT_STATE: join(T, 'state'), PATH: `${STUB}:${process.env.PATH}`, HANDOFF_GH_LOG: GH_LOG };
const run = (...args) => spawnSync(process.execPath, [BIN, '--root', ROOT, ...args], { cwd: T, env, encoding: 'utf8' });
const json = (...args) => { const r = run(...args, '--json'); if (r.status !== 0) console.log(r.stderr); return JSON.parse(r.stdout); };

const rep = json('--tickets', HOLDS);
const s = (id) => rep.sessions.find((x) => x.id === id);
t('this repo\'s project folder only, without --all', [rep.sessions.length, !!s('elsewhere')], [68, false]);
t('the arm is the threshold and window the injection names', s('base1').arm, { pct: 45, window: 200_000 });
t('a session with no injection has no arm', s('plain1').arm, null);
t('one injection logged on two lines fires once', s('compacting').fires, 1);
t('a compaction is a handoff, its overhead the first request after it',
  [s('compacting').compactions, s('compacting').handoffs, s('compacting').resume_overheads], [1, 1, [3300]]);
t('a session starting from a handoff file is resumed, its first request the overhead',
  [s('resumed').resumed, s('resumed').handoffs, s('resumed').resume_overheads], [true, 1, [1210]]);
t('a resumed session takes the arm of the session that named its handoff', s('resumed').arm, { pct: 50, window: 1_000_000 });
t('active hours count an idle gap as 5 minutes', +s('resumed').active_hours.toFixed(4), +(6 / 60).toFixed(4));
t('dollars at Opus list prices (a cache read 0.05 of input), a repeated request once at its largest output',
  Math.round(s('resumed').usd * 1e6), 10 * 4 + 100 * 5 + 100 * 8 + 1000 * 0.2 + 10 * 20);
t('a request on a model with no price is counted, not priced', [s('plain1').unpriced, Math.round(s('plain1').usd * 100)], [1, 40]);
t('a session maps to a ticket by its queue branch or by the key its branch names', [s('twenty2').tickets, s('base3').tickets, s('plain1').tickets], [['T2'], ['103'], []]);

const arm = (name) => rep.arms.find((a) => a.arm === name);
t('per-arm sessions, dollars per active hour (in cents) and unpriced requests',
  ['45% of 200,000', '20% of 200,000', '30% of 200,000', 'unknown'].map((k) => [arm(k).sessions, Math.round(arm(k).usd_per_active_hour * 100), arm(k).unpriced]),
  [[5, 400, 0], [5, 240, 0], [5, 120, 0], [5, 40, 1]]);
t('per-arm handoffs per session and mean resume overhead',
  [arm('50% of 1,000,000').sessions, arm('50% of 1,000,000').handoffs_per_session, arm('50% of 1,000,000').resume_overhead_mean, arm('50% of 1,000,000').resume_samples],
  [2, 1, 2255, 2]);

const rec = (r, w) => r.recommendations.find((x) => x.window === w);
const small = rec(rep, 200_000);
t('recommends the cheapest arm whose guardrails hold, against the 45 baseline',
  [small.verdict, small.row, small.pct, small.baseline], ['recommend', 'Handoff at context %', 20, '45% of 200,000']);
t('refuses a cheaper arm whose guardrail breaches', small.refused.map((x) => [x.arm, x.why.startsWith('fix-tries-parks breach')]), [['30% of 200,000', true]]);
t('not enough data under the minimum sessions per arm', [rec(rep, 1_000_000).verdict, rec(rep, 1_000_000).counts], ['not enough data', { '50% of 1,000,000': 2 }]);
t('never recommends the unknown arm', rep.recommendations.some((r) => r.arm === 'unknown'), false);

const unmeasured = rec(json('--tickets', BASE_ONLY), 200_000);
t('an arm whose guardrails are not measured is not recommended on cost alone: keep the baseline',
  [unmeasured.pct, unmeasured.refused.map((x) => [x.arm, x.why.includes('not measured')]).sort()], [45, [['20% of 200,000', true], ['30% of 200,000', true]]]);

const open = rec(json('--tickets', IN_FLIGHT), 200_000).refused.find((x) => x.arm === '20% of 200,000');
t('tickets still in flight do not make an arm\'s guardrail measured', (open?.why ?? 'recommended').startsWith('fix-tries-parks not measured: 0 ticket(s) on this arm, 5 on the baseline; needs 3 each; post-merge not measured: 0 ticket(s) on this arm, 5 on the baseline; needs 3 each'), true);

const requeued = rec(json('--tickets', REQUEUED), 200_000).refused.find((x) => x.arm === '20% of 200,000');
t('a requeued ticket, merged once and running again, does not make an arm\'s guardrail measured', (requeued?.why ?? 'recommended')
  .startsWith('fix-tries-parks not measured: 0 ticket(s) on this arm, 5 on the baseline; needs 3 each; post-merge not measured: 0 ticket(s) on this arm, 5 on the baseline; needs 3 each'), true);

const w3 = rec(rep, 300_000);
t('an arm cheaper only through requests with no price is refused, its guardrails holding',
  [w3.verdict, w3.pct, w3.refused], ['recommend', 45, [{ arm: '25% of 300,000', why: '5 request(s) on a model with no price' }]]);
const w4 = rec(rep, 400_000);
t('a baseline with a request with no price gives not enough data', [w4.verdict, w4.why], ['not enough data', 'the 45% of 400,000 baseline has 1 request(s) on a model with no price']);

const noTickets = run();
t('without a ticket file and with no desk state, it still reports, guardrails not measured',
  [noTickets.status, /RECOMMENDATION\n {2}§2 "Handoff at context %": 45 /.test(noTickets.stdout)], [0, true]);
t('the text report gives dollars per active hour and counts the unpriced requests',
  [/\$\/active hour/.test(noTickets.stdout), / {2}45% of 200,000 .* \$4\.00 /.test(noTickets.stdout), noTickets.stdout.includes('(7 request(s) on a model with no price, left out of the dollars)')], [true, true, true]);
t('--all reads every project folder', json('--all', '--tickets', BASE_ONLY).sessions.length, 69);
t('the text report lists the guidance it took the arms from, with links',
  [noTickets.stdout.includes('\nGUIDANCE\n'), noTickets.stdout.split('\n').filter((l) => /^ {2}- .+: https:\/\/\S+$/.test(l)).length >= 5, noTickets.stdout.includes('No source measures a handoff at 20-30%')],
  [true, true, true]);

// A session on the default branch reaches the ticket of each PR it opened, pushed or merged.
t('a PR title it opened, a PR number the queue records, a pushed branch, a merge\'s printed title and an opened PR\'s head each reach a ticket',
  [1, 2, 3, 4, 5].map((i) => [s(`base5_${i}`).tickets, s(`base5_${i}`).measured_on]), [1, 2, 3, 4, 5].map((i) => [[`DS-1${i}`], 'tickets']));
t('a PR merged in another repo is not this repo\'s', s('low5_1').tickets, ['DS-21']);
const r5 = rec(rep, 500_000);
t('with its PRs mapped, a window on the default branch is measured and its cheapest arm recommended',
  [r5.verdict, r5.pct, ['fix-tries-parks', 'post-merge'].map((g) => rep.arms.find((a) => a.arm === '20% of 500,000').guardrail_status[g].status)], ['recommend', 20, ['holds', 'holds']]);
t('rework (tool calls that errored) above the baseline\'s by the margin refuses an arm whose ticket guardrails hold',
  r5.refused, [{ arm: '30% of 500,000', why: 'rework breach: 100.0% of tool calls errored against 50.0% (margin 1.25x)' }]);

// A session that touched no PR is measured on the session guardrails alone, and listed as such.
t('a session that touched no PR is kept, measured on the session guardrails alone',
  [s('low5_nopr').measured_on, s('low5_nopr').unmapped, s('low5_nopr').handoffs, s('low5_nopr').tool_calls, s('low5_nopr').tool_errors], ['session only', 'no pr', 0, 1, 1]);
const low5 = rep.arms.find((a) => a.arm === '20% of 500,000');
t('the arm counts it among its sessions and its rework, not its tickets',
  [low5.sessions, low5.sessions_on_tickets, low5.sessions_without_ticket, low5.rework], [6, 5, 1, { tool_calls: 12, tool_errors: 6, rate: 0.5 }]);
const r6 = rec(rep, 600_000);
t('sessions measured on the session guardrails alone never make an arm eligible',
  [r6.pct, r6.refused.map((x) => [x.arm, x.why.includes('not measured') && !x.why.includes('rework')])], [45, [['20% of 600,000', true]]]);

// A window short of data says how many sessions it saw, how many it mapped, and why the rest did not.
t('the window counts its sessions, the ones mapped, and why each of the rest did not map',
  r6.mapping, { sessions: 10, mapped: 0, no_pr: 7, no_key: 1, no_ticket: 1, no_outcome: 1, off_default: 0, no_match: 0, keys: ['DS-99'] });
const text = run('--tickets', HOLDS).stdout;
t('the text report says it, with what would map the rest',
  [/saw 10 session\(s\), mapped 0 to a ticket or PR with an outcome; 7 touched no PR and ran on the default branch: .*; 1 touched a PR or branch that names no ticket key: .*; 1 named a key no queue ticket has \(DS-99\): .*; 1 reached a ticket or PR with no outcome yet/.test(text),
    text.includes('measured on the session guardrails alone')], [true, true]);

// On a GitHub tracker, a PR's closing keywords and a branch starting with the issue number name it.
const GH = join(T, 'gh-projects');
mkdirSync(join(GH, '-z-gh'), { recursive: true });
const ghSession = (name, lines) => session(join(GH, '-z-gh'), name, [user(0), req(`${name}-r`, 1, { uncached: 1 }), ...lines]);
ghSession('closes', bash(2, `gh pr create --title "fix: a thing" --body "$(cat <<'EOF'\nWhat it does; see #7.\n\nCloses #42\nEOF\n)" 2>&1`, 'https://github.com/acme/gh/pull/50'));
ghSession('numbered', bash(2, 'git push origin fix/43-slug'));
ghSession('unqueued', bash(2, 'git push origin fix/44-slug'));
// A body closing an issue of another repo and one of this repo named with its owner (in other case).
ghSession('crossrepo', bash(2, 'gh pr create --title "fix: more" --body "Closes other/thing#42\nFixes ACME/GH#46"', 'https://github.com/acme/gh/pull/51'));
// A key in lower case in a branch, and a plain merge's "Merged pull request" output naming the title.
ghSession('lower', bash(2, 'git push origin feat/kan-12-fix'));
ghSession('lowerunq', bash(2, 'git push origin feat/kan-77-fix'));
ghSession('nodever', bash(2, 'git push origin feat/node-20-upgrade'));
ghSession('merged', bash(2, 'gh pr merge 60 --merge', '✓ Merged pull request acme/gh#60 (fix: issue-45 the thing)'));
const GH_TICKETS = write('gh.json', ['issue-42', 'issue-43', 'issue-45', 'issue-46', 'KAN-12'].map((k) => ticket(k, null, 1)));
const ghRun = (cfg) => JSON.parse(spawnSync(process.execPath, [BIN, '--root', GH, '--json', '--tickets', GH_TICKETS],
  { cwd: T, env: { ...env, DESK_REPO_ROOT: '/z/gh', DESK_GH_REPO: 'acme/gh', DESK_CONFIG: cfg }, encoding: 'utf8' }).stdout);
const gh = ghRun(config('gh.md', 'none', 'none'));
const g = (id) => gh.sessions.find((x) => x.id === id);
t('on a GitHub tracker the issue a PR closes, and the number a branch starts with, name its ticket',
  [g('closes').tickets, g('numbered').tickets, [g('unqueued').tickets, g('unqueued').unmapped]], [['issue-42'], ['issue-43'], [[], 'no ticket']]);
t('a closing reference to another repo\'s issue does not map; one naming this repo does', g('crossrepo').tickets, ['issue-46']);
t('a key in a branch maps whatever its case', g('lower').tickets, ['KAN-12']);
t('a plain merge\'s "Merged pull request" output gives the PR\'s title', g('merged').tickets, ['issue-45']);
const kan = ghRun(config('kan.md', 'jira', 'KAN-[0-9]+')).sessions.find((x) => x.id === 'lowerunq');
t('the §4 pattern matches with its case, so a lower-case key no queue ticket has reads as naming no key', [kan.unmapped, kan.tickets], ['no key', []]);
const wide = ghRun(config('wide.md', 'jira', '[A-Z][A-Z0-9]+-[0-9]+')).sessions.find((x) => x.id === 'nodever');
t('a lower-case word and number in a branch is not a key under a Jira pattern', [wide.unmapped, wide.tickets], ['no key', []]);

// ---- merged PRs no queue ticket is behind, read from GitHub --------------------------------------
// A 700,000-token window of sessions on main, each merging one PR by number, with no ticket rows.
const DAY_MS = 86_400_000;
const M = Date.now() - 20 * DAY_MS;
const iso = (ms) => new Date(ms).toISOString();
// A merged PR in the fixture: its files, its reviews (on the commits named, `late` ones after the
// merge) and the check suites on its merge commit.
const pr = (n, { mergedAt = M, title = `feat: change ${n}`, files = [`src/f${n}.js`], reviewed = ['a'], late = [], suites = [], head = `feat/change-${n}`, base = 'main', createdAt = null } = {}) => ({
  number: n, title, mergedAt: mergedAt == null ? null : iso(mergedAt), headRefName: head, baseRefName: base, createdAt: iso(createdAt ?? (mergedAt ?? M) - 3 * 3_600_000),
  mergeCommit: { oid: `m${n}`, checkSuites: { totalCount: suites.length, nodes: suites.map((x, i) => ({ conclusion: x.conclusion, branch: { name: x.branch ?? 'main' }, workflowRun: { databaseId: n * 10 + i, event: 'push', createdAt: iso(x.at), url: `u${n}`, workflow: { databaseId: 1, name: 'ci' } } })) } },
  files,
  reviews: [...reviewed.map((oid, i) => ({ at: iso((mergedAt ?? M) - DAY_MS + i), oid })), ...late.map((oid) => ({ at: iso((mergedAt ?? M) + DAY_MS), oid }))],
});
const cand = (number, title, at, files, body = '') => ({ number, title, body, mergedAt: iso(at), files });
const FX7 = write('fx7.json', {
  prs: Object.fromEntries([
    pr(701, { reviewed: ['a', 'b', 'b'], late: ['c'] }), pr(702), pr(703), pr(704), pr(705),
    pr(711), pr(712, { suites: [{ conclusion: 'FAILURE', at: M + 3_600_000 }, { conclusion: 'SUCCESS', at: M + 3_600_000 }] }), pr(713), pr(714), pr(715),
    pr(721), pr(722), pr(723), pr(724), pr(725),
  ].map((p) => [p.number, p])),
  search: [
    // After PR 702: a fix on its file within 48 hours (a follow-up), one after them, a feature on its
    // file, and a fix on another file.
    cand(790, 'fix: correct the thing', M + 5 * 3_600_000, ['src/f702.js']),
    cand(791, 'fix: much later', M + 60 * 3_600_000, ['src/f702.js']),
    cand(792, 'feat: more on it', M + 5 * 3_600_000, ['src/f702.js']),
    cand(793, 'fix: elsewhere', M + 5 * 3_600_000, ['src/other.js']),
    // A revert of PR 711 on its fifth day, the way GitHub's revert button writes one.
    cand(780, 'Revert "feat: change 711"', M + 5 * DAY_MS, ['src/f711.js'], 'Reverts acme/widgets#711'),
  ],
});
const ROOT7 = join(T, 'projects7');
const P7 = join(ROOT7, '-x-repo');
mkdirSync(P7, { recursive: true });
const hour7 = (name, cost, armAt, n) => session(P7, name, [...Array.from({ length: 12 }, (_, i) => user(i * 5)), req(`${name}-r`, 60, { uncached: cost }), ...fire(30, ...armAt),
  ...bash(31, `gh pr merge ${n} --squash`, '')]);
for (let i = 1; i <= 5; i += 1) {
  hour7(`base7_${i}`, 1_000_000, [45, 700_000], 700 + i);
  hour7(`low7_${i}`, 500_000, [20, 700_000], 710 + i);
  hour7(`clean7_${i}`, 250_000, [30, 700_000], 720 + i);
}
const NONE = write('none.json', []);
const run7 = (state, ...args) => {
  const r = spawnSync(process.execPath, [BIN, '--root', ROOT7, '--tickets', NONE, ...args], { cwd: T, env: { ...env, DESK_AUTOPILOT_STATE: state, HANDOFF_GH_FIXTURE: FX7 }, encoding: 'utf8' });
  if (r.status !== 0) console.log(r.stderr);
  return r.stdout;
};
const S7 = join(T, 'state7');
let before = ghCalls();
const pr7 = JSON.parse(run7(S7, '--json'));
const first = ghCalls() - before;
const s7 = (id) => pr7.sessions.find((x) => x.id === id);
t('a session merging a PR no ticket is behind is measured on that PR', [s7('base7_3').measured_on, s7('base7_3').unmapped, s7('base7_3').prs_measured],
  ['prs', null, [{ number: 703, post_merge: 0, follow_ups: [], review_rounds: 1 }]]);
t('a revert PR on its fifth day and a red default-branch run on its merge commit count as post-merge', [s7('low7_1').prs_measured?.[0]?.post_merge, s7('low7_2').prs_measured?.[0]?.post_merge], [1, 1]);
t('a fix PR merged within 48 hours on one of its files is a follow-up; a later one, a feature, or a fix elsewhere is not', s7('base7_2').prs_measured?.[0]?.follow_ups, [790]);
t('its review rounds are the distinct commits reviewed before the merge', s7('base7_1').prs_measured?.[0]?.review_rounds, 2);
const r7 = rec(pr7, 700_000);
t('a ticketless PR arm with a revert and a red run breaches post-merge against the baseline', r7.refused.map((x) => [x.arm, x.why]),
  [['20% of 700,000', 'pr-post-merge breach: 0.40 per PR against 0.00 (margin 1.25x)']]);
t('one without is clean, and with its PR guardrails measured it is recommended', [r7.verdict, r7.pct, Object.keys(pr7.arms.find((a) => a.arm === '30% of 700,000').guardrail_status ?? {}).filter((k) => !['fix-tries-parks', 'post-merge'].includes(k))
  .map((k) => pr7.arms.find((a) => a.arm === '30% of 700,000').guardrail_status[k].status)], ['recommend', 30, ['holds', 'holds', 'holds']]);
t('15 PRs are read in batched queries of 10 reads (2 for the PRs, 3 for the 30 window searches), and the final outcomes cached in the repo state',
  [first, existsSync(join(S7, 'handoff-pr-outcomes.json'))], [5, true]);
before = ghCalls();
const again = JSON.parse(run7(S7, '--json'));
t('a second run reads nothing from GitHub and gives the same outcomes from the cache', [ghCalls() - before, rec(again, 700_000).pct, again.pr_read?.cached], [0, 30, 15]);
const text7 = run7(S7);
t('each window states its sample per arm against the minimum it needs',
  ['45% of 700,000 (baseline) 5/5 sessions, 0/3 tickets, 5/3 PRs', '20% of 700,000 5/5 sessions, 0/3 tickets, 5/3 PRs'].map((x) => text7.includes(x))
    .concat(text7.includes('sample (an arm and the baseline each need 5 sessions, and 3 tickets or 3 PRs)')), [true, true, true]);
before = ghCalls();
const offCached = run7(S7, '--offline');
t('--offline reads nothing from GitHub and says so, counting only the outcomes already cached',
  [ghCalls() - before, offCached.includes('(PR guardrails: not read from GitHub (--offline), 15 PR(s) from the cache)'), /: 30 \(30% of 700,000\)/.test(offCached)], [0, true, true]);
const offFresh = JSON.parse(run7(join(T, 'state7-fresh'), '--offline', '--json'));
t('--offline with nothing cached measures no PR, so no arm is decided on cost alone',
  [ghCalls() - before, rec(offFresh, 700_000).pct, offFresh.sessions.filter((x) => x.measured_on === 'prs').length, offFresh.pr_read?.note], [0, 45, 0, '15 PR(s) not read from GitHub (--offline)']);
// A PR merged hours ago: its follow-up window is open, so it is read each run and not counted yet.
const FX8 = write('fx8.json', { prs: { 741: pr(741, { mergedAt: Date.now() - 10 * 3_600_000 }) }, search: [] });
const ROOT8 = join(T, 'projects8');
mkdirSync(join(ROOT8, '-x-repo'), { recursive: true });
session(join(ROOT8, '-x-repo'), 'recent', [user(0), req('recent-r', 1, { uncached: 1 }), ...bash(2, 'gh pr merge 741')]);
const run8 = () => JSON.parse(spawnSync(process.execPath, [BIN, '--root', ROOT8, '--tickets', NONE, '--json'],
  { cwd: T, env: { ...env, DESK_AUTOPILOT_STATE: join(T, 'state8'), HANDOFF_GH_FIXTURE: FX8 }, encoding: 'utf8' }).stdout);
before = ghCalls();
const recent = [run8(), run8()].map((r) => [r.sessions[0].measured_on, r.sessions[0].unmapped]);
t('a PR merged hours ago is not counted, and each run reads its open windows again', [recent, ghCalls() - before], [[['session only', 'no outcome'], ['session only', 'no outcome']], 4]);

// Each PR on its own windows: one merged three days ago is not final while its revert window is open,
// and a later run reads only that window; one whose follow-up window holds more merged PRs than the
// pages read stays open, while one whose windows fit is final and cached; a follow-up's shared file
// past its first page of files is found; and reviews past a page all count.
const N = Date.now();
const FX9 = write('fx9.json', {
  searchPage: 1,
  prs: Object.fromEntries([
    pr(901, { mergedAt: N - 3 * DAY_MS }), pr(902, { mergedAt: N - 20 * DAY_MS }), pr(903, { mergedAt: N - 30 * DAY_MS }),
    pr(904, { mergedAt: N - 25 * DAY_MS, files: ['src/deep.js'] }),
    pr(905, { mergedAt: N - 40 * DAY_MS, reviewed: Array.from({ length: 120 }, (_, i) => `c${i}`) }),
  ].map((p) => [p.number, p])),
  search: [
    ...Array.from({ length: 11 }, (_, i) => cand(960 + i, `fix: busy ${i}`, N - 20 * DAY_MS + (i + 1) * 3_600_000, ['src/elsewhere.js'])),
    cand(930, 'fix: after 903', N - 30 * DAY_MS + 3_600_000, ['src/f903.js']),
    cand(950, 'fix: wide change', N - 25 * DAY_MS + 3 * 3_600_000, [...Array.from({ length: 140 }, (_, i) => `src/w${i}.js`), 'src/deep.js', ...Array.from({ length: 9 }, (_, i) => `src/z${i}.js`)]),
  ],
});
const ROOT9 = join(T, 'projects9');
mkdirSync(join(ROOT9, '-x-repo'), { recursive: true });
for (const n of [901, 902, 903, 904, 905]) session(join(ROOT9, '-x-repo'), `w${n}`, [user(0), req(`w${n}-r`, 1, { uncached: 1 }), ...bash(2, `gh pr merge ${n}`)]);
const S9 = join(T, 'state9');
const run9 = () => JSON.parse(spawnSync(process.execPath, [BIN, '--root', ROOT9, '--tickets', NONE, '--json'],
  { cwd: T, env: { ...env, DESK_AUTOPILOT_STATE: S9, HANDOFF_GH_FIXTURE: FX9 }, encoding: 'utf8' }).stdout);
const w9 = run9();
const w = (n) => w9.sessions.find((x) => x.id === `w${n}`);
const cache9 = JSON.parse(readFileSync(join(S9, 'handoff-pr-outcomes.json'), 'utf8')).prs;
t('a PR merged three days ago is not final while its revert window is open, and is cached with that window open',
  [w(901).measured_on, w(901).unmapped, cache9['901'].final, cache9['901'].open], ['session only', 'no outcome', false, ['reverts']]);
t('a PR whose follow-up window holds more merged PRs than the pages read stays open',
  [w(902).measured_on, cache9['902'].final, cache9['902'].open], ['session only', false, ['follow-ups']]);
t('a PR whose own windows were read in full is final and cached, though another\'s were cut short',
  [w(903).measured_on, w(903).prs_measured, cache9['903'].final], ['prs', [{ number: 903, post_merge: 0, follow_ups: [930], review_rounds: 1 }], true]);
t('a follow-up whose shared file is past its first page of files is found', w(904).prs_measured?.[0]?.follow_ups, [950]);
t('reviews past a page all count as rounds', w(905).prs_measured?.[0]?.review_rounds, 120);
const log9 = ghCalls();
run9();
const again9 = readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).slice(log9).map((l) => JSON.parse(l).find((a) => a.startsWith('query=')));
t('a later run reads only the open windows: 901\'s reverts and 902\'s follow-ups, no PR again',
  [again9.length > 0, again9.every((q) => !q.includes('pullRequest(number:')), again9.every((q) => [901, 902].some((n) => q.includes(iso(N - (n === 901 ? 3 : 20) * DAY_MS).slice(0, 13))))],
  [true, true, true]);

// A number that names no PR here beside one that does; a PR merged into another branch; a failed run
// on the merge commit pushed to another branch; and one branch name used for two PRs, at two times.
const FX10 = write('fx10.json', {
  prs: Object.fromEntries([
    pr(1001, { suites: [{ conclusion: 'FAILURE', at: M + 3_600_000, branch: 'feat/elsewhere' }] }),
    pr(1002, { base: 'feat/epic' }),
    pr(1003, { head: 'feat/reused', createdAt: T0 - 3_600_000, mergedAt: T0 + 2 * 3_600_000 }),
    pr(1004, { head: 'feat/reused', createdAt: T0 + 3 * DAY_MS - 3_600_000, mergedAt: T0 + 3 * DAY_MS + 2 * 3_600_000 }),
  ].map((p) => [p.number, p])),
  search: [],
});
const ROOT10 = join(T, 'projects10');
const P10 = join(ROOT10, '-x-repo');
mkdirSync(P10, { recursive: true });
session(P10, 'pair', [user(0), req('pair-r', 1, { uncached: 1 }), ...bash(2, 'gh pr merge 1001'), ...bash(3, 'gh pr merge 1999')]);
session(P10, 'epic', [user(0), req('epic-r', 1, { uncached: 1 }), ...bash(2, 'gh pr merge 1002')]);
const later = (d) => 60 * 24 * d;
session(P10, 'reusedA', [user(0), req('ra-r', 1, { uncached: 1 }), ...bash(2, 'git push origin feat/reused')]);
session(P10, 'reusedB', [user(later(3)), req('rb-r', later(3) + 1, { uncached: 1 }), ...bash(later(3) + 2, 'git push origin feat/reused')]);
session(P10, 'reusedC', [user(later(8)), req('rc-r', later(8) + 1, { uncached: 1 }), ...bash(later(8) + 2, 'git push origin feat/reused')]);
const S10 = join(T, 'state10');
const run10 = (fx = FX10, state = S10) => JSON.parse(spawnSync(process.execPath, [BIN, '--root', ROOT10, '--tickets', NONE, '--json'],
  { cwd: T, env: { ...env, DESK_AUTOPILOT_STATE: state, HANDOFF_GH_FIXTURE: fx }, encoding: 'utf8' }).stdout);
const p10 = run10();
const x = (id) => p10.sessions.find((y) => y.id === id);
t('a number that names no PR here (GitHub\'s NOT_FOUND, gh exiting 1) leaves the PR beside it measured',
  [x('pair').measured_on, x('pair').prs_measured.map((o) => o.number), p10.pr_read.note], ['prs', [1001], null]);
t('a failed run on the merge commit pushed to another branch is not red main', x('pair').prs_measured[0]?.post_merge, 0);
t('a PR merged into another branch than the default is not measured, and says so', [x('epic').measured_on, x('epic').unmapped], ['session only', 'off default']);
t('one branch name used for two PRs maps each session to the PR whose lifetime overlaps it',
  [x('reusedA').prs_measured.map((o) => o.number), x('reusedB').prs_measured.map((o) => o.number), [x('reusedC').measured_on, x('reusedC').unmapped]], [[1003], [1004], ['session only', 'no match']]);
const cache10 = JSON.parse(readFileSync(join(S10, 'handoff-pr-outcomes.json'), 'utf8'));
t('the cache holds PRs by number only, and the number that names no PR as not asked again', [Object.keys(cache10).sort(), cache10.missing], [['missing', 'prs'], [1999]]);
before = ghCalls();
run10();
const again10 = readFileSync(GH_LOG, 'utf8').split('\n').filter(Boolean).slice(before).map((l) => JSON.parse(l).find((a) => a.startsWith('query=')));
t('the next run asks again only for the branch\'s PRs, not for the number that named none', [again10.length, again10.some((q) => q.includes('1999')), again10.every((q) => q.includes('headRefName'))], [1, false, true]);
const failed = run10(write('fx10-fail.json', { prs: { 1001: pr(1001) }, search: [], errorType: 'RATE_LIMITED' }), join(T, 'state10-fail'));
t('any other error drops the read and says so', [failed.pr_read.note?.startsWith('PRs not read from GitHub'), failed.sessions.filter((y) => y.measured_on === 'prs').length], [true, 0]);

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all passed');
