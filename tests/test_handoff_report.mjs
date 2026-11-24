// suite: handoff report (which context-handoff threshold costs least, from interactive session transcripts)
// layer: L2
// covers: desk/bin/handoff-report.mjs
// handoff-report.mjs on fixture transcripts in a scratch HOME and projects folder: the arm read from the
// hook's injection, a compaction and its resume overhead, a resumed session taking the arm of the
// session that named its handoff, active hours with an idle gap capped, dollars at list prices and
// an unpriced model counted, per-arm totals, and the recommendation against the guardrails from a
// per-ticket rows file, where only tickets with an outcome count, and dollars compared only where
// every request is priced.
import { mkdirSync, writeFileSync } from 'node:fs';
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

// A ticket with its outcome: merged and done, unless `open` leaves it in flight.
const ticket = (key, branch, fixTries, open = false) => ({ key, batch: null, branch, fix_tries: fixTries, parks_by_class: {}, post_merge: 0,
  ...(open ? { state: 'running', merged_at: null } : { state: 'done', merged_at: '2026-11-03T10:00:00Z' }) });
const baseTickets = [1, 2, 3, 4, 5].map((i) => ticket(String(100 + i), null, 1));
const write = (name, rows) => { const f = join(T, name); writeFileSync(f, JSON.stringify(rows)); return f; };
const HOLDS = write('holds.json', [...baseTickets, ...[1, 2, 3, 4, 5].map((i) => ticket(`T${i}`, `fix/twenty-${i}`, 1)),
  ...[1, 2, 3, 4, 5].map((i) => ticket(`H${i}`, `fix/thirty-${i}`, 5)),
  ...[1, 2, 3, 4, 5].flatMap((i) => [ticket(String(200 + i), null, 1), ticket(`W${i}`, `fix/w3-25-${i}`, 1)])]);
const BASE_ONLY = write('base-only.json', baseTickets);
const IN_FLIGHT = write('in-flight.json', [...baseTickets, ...[1, 2, 3].map((i) => ticket(`T${i}`, `fix/twenty-${i}`, 0, true))]);
// Requeued: merged once, running again.
const REQUEUED = write('requeued.json', [...baseTickets, ...[1, 2, 3].map((i) => ({ ...ticket(`T${i}`, `fix/twenty-${i}`, 0), state: 'running' }))]);

const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DESK_') && k !== 'CLAUDE_CONFIG_DIR')), HOME, DESK_REPO_ROOT: '/x/repo' };
const run = (...args) => spawnSync(process.execPath, [BIN, '--root', ROOT, ...args], { cwd: T, env, encoding: 'utf8' });
const json = (...args) => { const r = run(...args, '--json'); if (r.status !== 0) console.log(r.stderr); return JSON.parse(r.stdout); };

const rep = json('--tickets', HOLDS);
const s = (id) => rep.sessions.find((x) => x.id === id);
t('this repo\'s project folder only, without --all', [rep.sessions.length, !!s('elsewhere')], [42, false]);
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
t('a session maps to a ticket by its queue branch or by the key its branch names', [s('twenty2').ticket, s('base3').ticket, s('plain1').ticket], ['T2', '103', null]);

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
t('tickets still in flight do not make an arm\'s guardrail measured', open?.why ?? 'recommended', 'fix-tries-parks not measured: 0 ticket(s) on this arm, 5 on the baseline; needs 3 each; post-merge not measured: 0 ticket(s) on this arm, 5 on the baseline; needs 3 each');

const requeued = rec(json('--tickets', REQUEUED), 200_000).refused.find((x) => x.arm === '20% of 200,000');
t('a requeued ticket, merged once and running again, does not make an arm\'s guardrail measured', requeued?.why ?? 'recommended',
  'fix-tries-parks not measured: 0 ticket(s) on this arm, 5 on the baseline; needs 3 each; post-merge not measured: 0 ticket(s) on this arm, 5 on the baseline; needs 3 each');

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
t('--all reads every project folder', json('--all', '--tickets', BASE_ONLY).sessions.length, 43);
t('the text report lists the guidance it took the arms from, with links',
  [noTickets.stdout.includes('\nGUIDANCE\n'), noTickets.stdout.split('\n').filter((l) => /^ {2}- .+: https:\/\/\S+$/.test(l)).length >= 5, noTickets.stdout.includes('No source measures a handoff at 20-30%')],
  [true, true, true]);

if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
console.log('all passed');
