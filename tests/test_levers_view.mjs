// suite: levers view (one view model of every repo's levers, with input ages and the honesty rules)
// layer: L2
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratch } from './scratch.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const j = (v) => JSON.stringify(v);
process.env.HOME = scratch('levers-view-home-');
const V = await import('../desk/bin/levers-view.mjs');

const NOW = Date.parse('2026-11-15T09:00:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const w = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const REPOS = [
  { slug: 'bigbenjoman__desk-skills', gh: 'bigbenjoman/desk-skills', levers: '`preflight`' },
  { slug: 'acme__ai-agents', gh: 'acme/ai-agents', levers: '`none`' },
  { slug: 'acme__studia-web', gh: 'acme/studia-web', levers: null },
  { slug: 'acme__studia-zendesk', gh: 'acme/studia-zendesk', levers: null },
];
const config = (gh, levers) => `# desk config

## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`${gh}\` |
| Default branch | \`main\` |
${levers == null ? '' : `
## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Phase 0 levers | \`none\` | ${levers} |
`}`;

// The real baseline's total block, its long denials list cut short.
const BASELINE = `PHASE 0 BASELINE: bigbenjoman__desk-skills, the 7 day(s) from 2026-11-06T15:23:07.463Z to 2026-11-13T15:23:07.463Z. Read-only: nothing is fetched, reset, checked out or written.

total (red CI counts every failed run in the repo, not only batch branches):
  tickets with work or a merge in the window: 36, accepted (PR merged): 24
  spent in the window: 1,269,094,655 input tokens · 5,451,417 output tokens · $536.83 API-equivalent (7 run(s) with no result event not counted)
  per accepted ticket: 38,881,286 input tokens · 174,824 output tokens · $17.52 API-equivalent, over 24 of 24
  fix tries per accepted ticket: 0.13 (3 made by accepted tickets)
  repair cycles by kind: checks 2 · review 2 · conflict 1
  needs-you items: 4 raised (worker parks) · 11 answered (from the digest)
  permission denials by command: 374 in all: cd 36 · grep 31 · with-lock.sh 26
  Stage 4b review rounds: 33
  levers on: none (114 start(s)) · not recorded (24 start(s))

Usage readings name no login.
`;

// A fixture machine: four configured repos, each supervisor ticked a minute ago, and `files` written
// under the autopilot root (paths relative to it).
function machine({ repos = REPOS, files = {}, supervisorAge = {} } = {}) {
  const base = scratch('levers-view-');
  const configRoot = join(base, 'config');
  const root = join(base, 'autopilot');
  for (const r of repos) {
    w(join(configRoot, 'repos', r.slug, 'config.md'), config(r.gh, r.levers));
    const sup = join(root, r.slug, 'supervisor.json');
    w(sup, '{"idle":null,"notified":[]}\n');
    const at = new Date(NOW - (supervisorAge[r.slug] ?? MIN));
    utimesSync(sup, at, at);
  }
  w(join(root, 'bigbenjoman__desk-skills', 'phase0-baseline-2026-11-13.txt'), BASELINE);
  for (const [p, body] of Object.entries(files)) w(join(root, p), body);
  return { root, configRoot, out: join(base, 'out') };
}
const view = (m, extra = {}) => V.buildView({ root: m.root, configRoot: m.configRoot, now: NOW, tz: 'UTC', ...extra });

const DS = 'bigbenjoman__desk-skills';
const evalRow = (lever, o = {}) => ({
  v: 1, eval_id: `evl_${lever}`, at: o.at ?? iso(2 * HOUR), repo: DS, lever, layer: 'low', state: o.state ?? 'trial', arm_share_7d: 0.5,
  n: { on: o.on ?? 18, off: o.off ?? 19, pooled_on: 71, pooled_off: 68, excluded: { pin_mismatch: 0, cost_incomplete: 0, fp_reset: 0 } },
  min_n: 30, max_n: 150,
  mechanism: o.mechanism ?? { metric: 'denials_per_start', unit: 'ratio', min_benefit: -0.25, est: -0.58, lo90: -0.71, hi90: -0.41, p_benefit: 0.97, scope: 'pooled' },
  cost: o.cost ?? { ratio: 0.98, lo90: 0.88, hi90: 1.09, margin: 1.05, usd_per_admitted: { on: 17.1, off: 17.45 }, scope: 'pooled' },
  guardrails: o.guardrails ?? [], decision: 'hold', reason_code: 'below_min_sample', next: { earliest_change: '2026-11-27', needs: '12 more tickets in the smaller arm' },
});
const cell = (v, lever, repo = 'desk-skills') => v.panels.board.levers.find((l) => l.lever === lever).cells.find((c) => c.repo === repo);
const autoRepos = REPOS.map((r) => (r.slug === DS ? { ...r, levers: '`auto`' } : r));

// AC1: below the minimum sample, no verdict, the label says how far, and the interval is there.
{
  const v = view(machine({ repos: autoRepos, files: { [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('wrappers')]) } }));
  const e = cell(v, 'wrappers').effect;
  t('AC1 verdict is null below the minimum', e.verdict, null);
  t('AC1 label', e.label, 'too early: 18 of 30');
  t('AC1 the interval is present', `${e.lo90} to ${e.hi90}`, '-0.71 to -0.41');
  t('AC1 n is carried with it', e.n, 18);
  t('AC1 the point estimate shows from 10 per arm', e.est, -0.58);
  t('AC1 the cost ratio below the minimum has no words either', cell(v, 'wrappers').cost.verdict, null);
  t('AC1 a point estimate below 10 per arm is hidden', V.effectView({ est: -0.5, lo90: -0.9, hi90: 0.1 }, 6, 30).est, null);
}

// AC2 and AC3: a guardrail may read breached before the minimum sample, but never ok.
{
  const g = [
    { name: 'fix_tries_ratio', scope: 'repo', est: 1.9, lo90: 1.3, hi90: 2.6, margin: 1.25, p_worse: 0.9, status: 'too_early' },
    { name: 'acceptance_rate', scope: 'repo', est: -0.01, lo90: -0.09, hi90: 0.07, margin: -0.05, p_worse: 0.2, status: 'ok' },
  ];
  const v = view(machine({ repos: autoRepos, files: { [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('wrappers', { on: 12, off: 12, guardrails: g })]) } }));
  const [worse, within] = cell(v, 'wrappers').guardrails;
  t('AC2 worse beyond its margin with 90% probability at 12 per arm is breached', worse.status, 'breached');
  t('AC3 within its margin at 12 per arm is too early, whatever the row said', within.status, 'too_early');
  t('AC2 the guardrails panel carries the same statuses', j(v.panels.guardrails.rows.map((r) => r.status)), '["breached","too_early"]');
  t('AC3 at the minimum, within the margin reads ok', V.guardrailStatus({ p_worse: 0.2, est: 0 }, 30, 30), 'ok');
}

// AC4: a cost interval of 0.91 to 1.03 is not worse than off, and states no saving.
{
  const c = V.costView({ ratio: 0.97, lo90: 0.91, hi90: 1.03, margin: 1.05, usd_per_admitted: { on: 16.9, off: 17.4 } }, 31, 30, true);
  t('AC4 words', c.label, 'not worse than off');
  t('AC4 no saving is stated, even adopted', c.saving_usd, null);
  const s = V.costView({ ratio: 0.9, lo90: 0.85, hi90: 0.96, margin: 1.05, usd_per_admitted: { on: 15.7, off: 17.4 } }, 31, 30, true);
  t('AC4 a saving shows only for an adopted lever wholly under 1.00', j(s.saving_usd), '{"lo":0.7,"hi":2.61}');
  t('AC4 a trial lever shows no saving', V.costView({ lo90: 0.85, hi90: 0.96, usd_per_admitted: { off: 17.4 } }, 31, 30, false).saving_usd, null);
  t('AC4 an interval over the margin can\'t rule out worse', V.costView({ lo90: 0.95, hi90: 1.12 }, 31, 30).label, "can't rule out worse");
}

// AC5: one repo's supervisor 25 minutes old marks only its column stale.
{
  const v = view(machine({ supervisorAge: { 'acme__ai-agents': 25 * MIN } }));
  const col = Object.fromEntries(v.repos.map((r) => [r.name, r.column]));
  t('AC5 ai-agents is stale', col['ai-agents'], 'stale');
  t('AC5 the others are not', j([col['desk-skills'], col['studia-web'], col['studia-zendesk']]), '["ok","ok","ok"]');
  t('AC5 its age is in words', v.repos.find((r) => r.name === 'ai-agents').supervisor.words, '25 minutes ago');
}

// AC6: the newest evaluation row 30 hours old makes the lever board stale, with the age in words.
{
  const v = view(machine({ repos: autoRepos, files: { [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('wrappers', { at: iso(40 * HOUR) }), evalRow('memory', { at: iso(30 * HOUR) })]) } }));
  t('AC6 the board is stale', v.panels.board.state, 'stale');
  t('AC6 with its age in words', v.panels.board.age.words, '30 hours ago');
}

// DS-1000 AC4: an auto repo whose §3b Worker models already runs its finders on the finder-model
// lever's alias never draws it, and the view says why in one line.
{
  const m = machine({ repos: autoRepos });
  w(join(m.configRoot, 'repos', DS, 'config.md'), `${config('bigbenjoman/desk-skills', '`auto`')}| Worker models | \`default\` | \`default finder=sonnet\` |\n`);
  const c = cell(view(m), 'finder-model');
  t('DS-1000 AC4 the cell reads ineligible', c.state, 'ineligible');
  t('DS-1000 AC4 one line says both arms would be the same', c.note, 'not tested in desk-skills: §3b Worker models already runs its finders on sonnet, so both arms would be the same');
  t('DS-1000 AC4 the other levers are unaffected', cell(view(m), 'codex').state, 'off');
  w(join(m.configRoot, 'repos', DS, 'config.md'), `${config('bigbenjoman/desk-skills', '`auto`')}| Worker models | \`default\` | \`default finder=haiku\` |\n`);
  t('DS-1000 AC4 finder=haiku: finder-model reads off, as any lever with no evaluation yet', cell(view(m), 'finder-model').state, 'off');
}
// DS-1000 AC4: the daily evaluation still writes the ineligible lever a trial row; the view keeps
// saying why rather than reading it as testing, and a kept lever keeps its result.
{
  const m = machine({ repos: autoRepos, files: { [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('finder-model'), evalRow('wrappers')]) } });
  w(join(m.configRoot, 'repos', DS, 'config.md'), `${config('bigbenjoman/desk-skills', '`auto`')}| Worker models | \`default\` | \`default finder=sonnet\` |\n`);
  const c = cell(view(m), 'finder-model');
  t('DS-1000 AC4 an evaluated trial row: the cell still reads ineligible', c.state, 'ineligible');
  t('DS-1000 AC4 an evaluated trial row: its reason is kept apart for the page', c.why, '§3b Worker models already runs its finders on sonnet, so both arms would be the same');
  t('DS-1000 AC4 an evaluated trial row: an eligible lever keeps its evaluation', cell(view(m), 'wrappers').state, 'trial');
  const k = machine({ repos: autoRepos, files: { [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('finder-model', { state: 'adopted' })]) } });
  w(join(k.configRoot, 'repos', DS, 'config.md'), `${config('bigbenjoman/desk-skills', '`auto`')}| Worker models | \`default\` | \`default finder=sonnet\` |\n`);
  t('DS-1000 AC4 a kept lever keeps its result', cell(view(k), 'finder-model').state, 'adopted');
}

// AC7: a repo with no levers row is not enrolled, and waiting on you says how to enrol it.
{
  const m = machine();
  const v = view(m);
  t('AC7 studia-web reads not enrolled', v.repos.find((r) => r.name === 'studia-web').reads, 'not enrolled');
  t('AC7 its board cells read not enrolled', cell(v, 'wrappers', 'studia-web').state, 'not_enrolled');
  const item = v.panels.waiting.items.find((i) => i.repo === 'studia-web');
  t('AC7 waiting on you lists it', item?.text, 'set `auto` in studia-web');
  t('AC7 with the config path', item?.config, join(m.configRoot, 'repos', 'acme__studia-web', 'config.md'));
  t('AC7 a row reading none is listed too', v.panels.waiting.items.find((i) => i.repo === 'ai-agents')?.detail, 'the levers row reads `none`');
  t('AC7 a pinned repo is not', v.panels.waiting.items.some((i) => i.repo === 'desk-skills'), false);
}

// AC8: a line that fails to parse makes only the panels reading its file error, and build.json names it.
{
  const bad = `${DS}/lever-evals.jsonl`;
  const m = machine({ repos: autoRepos, files: { [bad]: `${JSON.stringify(evalRow('wrappers'))}\n{"lever": "memory", "at": \n` } });
  const { view: v, record } = V.build({ root: m.root, configRoot: m.configRoot, now: NOW, tz: 'UTC', out: m.out });
  const file = join(m.root, bad);
  t('AC8 the board is error', v.panels.board.state, 'error');
  t('AC8 naming the file and line', `${v.panels.board.errors[0].file}:${v.panels.board.errors[0].line}`, `${file}:2`);
  t('AC8 the guardrails panel, which reads it, is error', v.panels.guardrails.state, 'error');
  t('AC8 the cost panel, whose savings come from it, is error', v.panels.cost.state, 'error');
  t('AC8 panels that do not read it build', j([v.panels.trends.state, v.panels.data_quality.state, v.panels.status.state]), '["empty","empty","ok"]');
  const rec = JSON.parse(readFileSync(m.out + '/build.json', 'utf8'));
  t('AC8 build.json records the same file and line', `${rec.errors[0].file}:${rec.errors[0].line}`, `${file}:2`);
  t('AC8 build.json names the panels', rec.errors[0].panels.includes('board'), true);
  t('AC8 the returned record matches the file', j(record.errors), j(rec.errors));
}

// Per-ticket outcome rows, as phase0-report's ticketRows writes them, in an evaluation's evidence file.
const row = (key, daysAgo, o = {}) => ({
  slug: o.slug ?? DS, batch: null, key, admitted_at: iso(daysAgo * DAY), merged_at: 'merged' in o ? o.merged : iso(daysAgo * DAY - HOUR),
  cost: o.cost ?? 16.8, cost_complete: o.complete ?? true, input: o.input ?? 34_000_000, output: 150_000,
  starts: o.starts ?? 4, denials: o.denials ?? 8, fix_tries: o.fix ?? 0, start_records: [{ claude_version: '2.4.1', desk_commit: 'abc123' }],
  ...(o.excluded ? { excluded: o.excluded } : {}),
});
const evidence = (slug, rows, name = 'evl_2026-11-15_x.jsonl') => ({ [`${slug}/levers-evidence/${name}`]: jsonl(rows) });

// AC9: a ticket whose cost is incomplete is counted out, and its cost never reads 0.
{
  const ZD = 'acme__studia-zendesk';
  const v = view(machine({ files: { ...evidence(ZD, [row('ZD-1', 2, { slug: ZD, cost: 0, complete: false })]), ...evidence(DS, [row('DS-1', 2)]) } }));
  t('AC9 counted in the exclusions', v.panels.data_quality.excluded.cost_incomplete, 1);
  const zd = v.panels.cost.per_repo.find((r) => r.repo === 'studia-zendesk');
  t('AC9 its repo\'s cost is unknown, not 0', zd.usd_per_admitted, null);
  t('AC9 it is still counted as admitted', zd.admitted, 1);
  t('AC9 the week\'s cost leaves it out', v.panels.cost.this_week.usd_per_admitted, 16.8);
}

// Each repo's rework share this week, cost-weighted, with its data age.
{
  const rw = (key, o) => ({ ...row(key, 2, o), rework_share: o.share, rework_cost: o.rework, rework_by_cause: o.causes, rework_by_class: o.classes });
  const m = machine({ files: evidence(DS, [
    rw('DS-1', { cost: 10, share: 0.4, rework: 4, causes: { 'review round': 3, 'CI red': 1 }, classes: { 'application defect': 4 } }),
    rw('DS-2', { cost: 6, share: 0, rework: 0, causes: {}, classes: {} }),
    rw('DS-3', { cost: 5, complete: false, share: null, rework: 0, causes: {}, classes: {} }),
    row('DS-4', 2, { cost: 2 }),
    // Admitted before this week.
    { ...rw('DS-5', { cost: 9, share: 0.5, rework: 4.5, causes: { conflict: 4.5 }, classes: {} }), admitted_at: iso(9 * DAY) },
  ]) });
  const ev = join(m.root, DS, 'levers-evidence', 'evl_2026-11-15_x.jsonl');
  utimesSync(ev, new Date(NOW - 3 * HOUR), new Date(NOW - 3 * HOUR));
  const v = view(m);
  const ds = v.panels.guardrails.rework.find((r) => r.repo === 'desk-skills');
  t('DS-692 AC2 view.json carries the rework share per repo, cost-weighted over this week\'s tickets', `${ds.share} ${ds.rework_usd} ${ds.usd} ${ds.known} ${ds.unknown} ${ds.admitted}`, '0.25 4 16 2 2 4');
  t('DS-692 AC2 split by cause', j(ds.by_cause), '{"review round":{"usd":3,"share":0.1875},"CI red":{"usd":1,"share":0.0625}}');
  t('DS-692 AC2 with its data age, from the evidence it was read from', `${ds.age.as_of} ${ds.age.age_s} ${ds.age.stale}`, `${iso(3 * HOUR)} 10800 false`);
  const zd = v.panels.guardrails.rework.find((r) => r.repo === 'studia-zendesk');
  t('DS-692 AC2 a repo with no tickets this week has no share, never 0', `${zd.share} ${zd.admitted} ${zd.age.as_of}`, 'null 0 null');
  t('DS-692 AC2 the guardrails panel reads ok on the rework alone', v.panels.guardrails.state, 'ok');
}

// AC10: the same inputs build the same view.json, generated_at aside.
{
  const m = machine({ repos: autoRepos, files: { [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('wrappers'), evalRow('memory')]), ...evidence(DS, [row('DS-1', 3), row('DS-2', 9)]) } });
  const a = V.build({ root: m.root, configRoot: m.configRoot, now: NOW, tz: 'UTC', out: join(m.out, 'a'), generatedAt: NOW });
  const b = V.build({ root: m.root, configRoot: m.configRoot, now: NOW, tz: 'UTC', out: join(m.out, 'b'), generatedAt: NOW + 5000 });
  const strip = (f) => readFileSync(f, 'utf8').replace(/"generated_at": "[^"]*"/, '');
  t('AC10 the two files differ', readFileSync(a.files.view, 'utf8') === readFileSync(b.files.view, 'utf8'), false);
  t('AC10 only in generated_at', strip(a.files.view) === strip(b.files.view), true);
}

// AC11 and AC12: each trend metric's series, baseline and callouts; no point before desk recorded.
{
  const rows = Array.from({ length: 30 }, (_, i) => row(`DS-${i + 1}`, i + 1, { cost: 16 + (i % 3) * 0.5, denials: 6, starts: 3, fix: i % 5 === 0 ? 1 : 0 }));
  const v = view(machine({ files: evidence(DS, rows) }));
  const m = v.panels.trends.metrics;
  t('AC11 four metrics', Object.keys(m).join(','), 'cost,tokens,prompts,fixes');
  for (const [k, x] of Object.entries(m)) {
    t(`AC11 ${k}: 30 daily points ending yesterday`, `${x.daily.length} ${x.daily.at(-1).date}`, '30 2026-11-14');
    t(`AC11 ${k}: 6 weekly points ending last week`, `${x.weekly.length} ${x.weekly.at(-1).week}`, '6 2026-11-02');
    t(`AC11 ${k}: 12 monthly points ending this month`, `${x.monthly.length} ${x.monthly.at(-1).month}`, '12 2026-11');
    t(`AC11 ${k}: nine callouts`, Object.keys(x.callouts).join(','), 'yesterday,dod_pct,last_week,wow_pct,last_week_vs_before_pct,mtd,mom_pct,to_date,to_date_vs_before_pct');
    t(`AC11 ${k}: every day of the 30 has a point`, x.daily.every((p) => p.value != null), true);
  }
  t('AC11 the cost baseline is the 13 Nov figure, per accepted ticket', `${m.cost.baseline.value} ${m.cost.baseline.basis}`, '17.52 per accepted ticket');
  t('AC11 the tokens baseline', m.tokens.baseline.value, 38881286);
  t('AC11 the prompts baseline is per start: 374 denials over 138 starts', m.prompts.baseline.value, 2.7101);
  t('AC11 the fix tries baseline', m.fixes.baseline.value, 0.13);
  t('AC11 prompts per start yesterday', m.prompts.callouts.yesterday, 2);
  t('AC11 yesterday\'s cost', m.cost.callouts.yesterday, 16);
  t('AC11 DoD% against the day before', m.cost.callouts.dod_pct, -3);
  t('AC11 the baseline is labelled per accepted ticket', v.baseline.label, 'per accepted ticket');
  t('AC12 desk started recording 30 days ago', m.cost.first_recorded, '2026-10-16');
  t('AC12 months before it are null, never 0', j(m.cost.monthly.slice(0, 9).map((p) => p.value)), j(Array(9).fill(null)));
  t('AC12 October has a point', m.cost.monthly.at(-2).value != null, true);
  const late = view(machine({ files: evidence(DS, [row('DS-1', 3), row('DS-2', 2)]) })).panels.trends.metrics.cost;
  t('AC12 a day before the first record is null', late.daily[0].value, null);
  t('AC12 the series carries the first recorded date', late.first_recorded, '2026-11-12');
  t('AC12 a recorded day with no ticket is null too', late.daily.at(-1).value, null);
}

// AC13: today, with no repo on auto and preflight pinned in desk-skills.
{
  const v = view(machine());
  const l = v.line;
  t('AC13 line state', l.state, 'today');
  t('AC13 on auto and repos', `${l.on_auto} of ${l.repos}`, '0 of 4');
  t('AC13 pinned', j(l.pinned), '[{"lever":"preflight","repo":"desk-skills"}]');
  t('AC13 the board shows preflight pinned', cell(v, 'preflight').state, 'pinned');
  t('AC13 the controller is not running', v.panels.status.controller, 'not running');
  t('AC13 the trends are empty but carry the baseline', `${v.panels.trends.state} ${v.panels.trends.metrics.cost.baseline.value}`, 'empty 17.52');
}

// AC14: two levers testing, the smaller arm 18 of 30, none kept.
{
  const v = view(machine({ repos: autoRepos, files: { [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('wrappers', { on: 25, off: 22 }), evalRow('memory', { on: 18, off: 21 })]) } }));
  t('AC14 line', j({ state: v.line.state, testing: v.line.testing, smaller_arm: v.line.smaller_arm }), '{"state":"early","testing":2,"smaller_arm":{"n":18,"min":30}}');
}

// AC15: three kept, two testing, last week 4.1% under the baseline, and one lever waiting on you.
{
  const evals = [
    evalRow('preflight', { state: 'adopted', on: 40, off: 38 }), evalRow('memory', { state: 'adopted', on: 41, off: 39 }), evalRow('failure-class', { state: 'settled', on: 60, off: 55 }),
    evalRow('wrappers', { on: 20, off: 19 }), evalRow('codex', { on: 31, off: 33 }),
  ];
  const log = [
    { v: 1, id: 'a', at: iso(3 * DAY), repo: DS, lever: 'codex', kind: 'transition', from: 'off', to: 'trial', actor: 'controller', reason_code: 'adopt_all_conditions', reason: 'started', eval_id: 'e', evidence_file: 'f' },
    { v: 1, id: 'b', at: iso(DAY), repo: DS, lever: 'codex', kind: 'needs_you', actor: 'controller', reason_code: 'own_step_error', reason: 'codex frozen after 2 reverts' },
    { v: 1, id: 'c', at: iso(9 * DAY), repo: DS, lever: 'wrappers', kind: 'needs_you', actor: 'controller', reason_code: 'own_step_error', reason: 'spent' },
    { v: 1, id: 'd', at: iso(8 * DAY), repo: DS, lever: 'wrappers', kind: 'override', actor: 'ben', reason_code: 'ben_override', reason: 'answered' },
  ];
  // Last week is Monday 2 to Sunday 8 November.
  const rows = [row('DS-1', 10), row('DS-2', 11), row('DS-3', 12)];
  const v = view(machine({ repos: autoRepos, files: { [`${DS}/lever-evals.jsonl`]: jsonl(evals), [`${DS}/levers.jsonl`]: jsonl(log), ...evidence(DS, rows) } }));
  const { state, cheaper_pct, kept, testing, needs_you } = v.line;
  t('AC15 line', j({ state, cheaper_pct, kept, testing, needs_you }), '{"state":"needs_you","cheaper_pct":4.1,"kept":3,"testing":2,"needs_you":1}');
  t('AC15 the answered item is not counted', v.panels.waiting.items.filter((i) => i.kind === 'lever').map((i) => i.text).join(), 'codex frozen after 2 reverts');
  t('AC15 the change list holds this week\'s changes only', v.panels.changes.events.map((e) => e.kind).join(), 'transition');
}

// An auto repo whose lever log cannot be read as far as the assignment's item is one item saying the
// repo cannot be assigned trial arms.
{
  const items = (v) => v.panels.waiting.items.filter((i) => i.kind === 'lever' && i.repo === 'desk-skills').map((i) => i.text);
  const override = { v: 1, id: 'a', at: iso(DAY), repo: DS, lever: 'memory', kind: 'override', to: 'reverted', actor: 'ben', reason_code: 'ben_override', reason: 'off' };
  const written = { v: 1, id: 'b', at: iso(MIN), repo: DS, kind: 'needs_you', actor: 'levers-auto', reason_code: 'state_unreadable', reason: 'desk-skills cannot be assigned trial arms: written' };
  const torn = items(view(machine({ repos: autoRepos, files: { [`${DS}/levers.jsonl`]: jsonl([override, '{ torn', written]) } })));
  t('unassignable: a line that does not parse is one item', j(torn), j(['desk-skills cannot be assigned trial arms: line 2 of its lever log does not parse; tickets get the levers row\'s named levers alone until it is fixed']));
  const m = machine({ repos: autoRepos });
  mkdirSync(join(m.root, DS, 'levers.jsonl'), { recursive: true });
  const dir = items(view(m));
  t('unassignable: a log that cannot be opened is one item', j([dir.length, /^desk-skills cannot be assigned trial arms: its lever log cannot be read/.test(dir[0])]), '[1,true]');
  t('unassignable: the item the assignment wrote, when it can be read, is not listed twice', j(items(view(machine({ repos: autoRepos, files: { [`${DS}/levers.jsonl`]: jsonl([override, written]) } })))), j([written.reason]));
  const pinned = machine();
  mkdirSync(join(pinned.root, DS, 'levers.jsonl'), { recursive: true });
  t('unassignable: a repo not on auto is not told it cannot be assigned', items(view(pinned)).length, 0);
}

// The baseline file's total block, as phase0-report prints it.
{
  const { base: b, error } = V.readBaseline(join(machine().root, DS, 'phase0-baseline-2026-11-13.txt'));
  t('baseline: reads without error', error, null);
  t('baseline: window', `${b.window.from} ${b.window.to}`, '2026-11-06T15:23:07.463Z 2026-11-13T15:23:07.463Z');
  t('baseline: per accepted ticket', `${b.cost} ${b.input_tokens} ${b.output_tokens} over ${b.tickets_costed} of ${b.accepted}`, '17.52 38881286 174824 over 24 of 24');
  t('baseline: fix tries, denials and starts', `${b.fix_tries} ${b.denials} ${b.starts}`, '0.13 374 138');
}

// A baseline file that is not the report errors the panels reading it, never reads as no baseline.
{
  const m = machine({ files: { [`${DS}/phase0-baseline-2026-11-13.txt`]: 'not a report\n', ...evidence(DS, [row('DS-1', 2)]) } });
  const v = view(m);
  const file = join(m.root, DS, 'phase0-baseline-2026-11-13.txt');
  t('baseline error: trends, cost and status are error', j([v.panels.trends.state, v.panels.cost.state, v.panels.status.state]), '["error","error","error"]');
  t('baseline error: naming the file', v.panels.trends.errors[0].file, file);
  t('baseline error: the line is broken', v.line.state, 'broken');
  t('baseline error: the data-quality panel, which does not read it, builds', v.panels.data_quality.state, 'ok');
}

// A malformed levers row errors its repo's column, and is not offered as an enrolment to make.
{
  const bad = REPOS.map((r) => (r.slug === 'acme__ai-agents' ? { ...r, levers: '`none` `preflight`' } : r));
  const m = machine({ repos: bad });
  const v = view(m);
  const col = v.repos.find((r) => r.name === 'ai-agents');
  t('config error: its column is error', `${col.column} ${col.reads}`, 'error levers row unreadable');
  t('config error: naming the config and its row', `${col.errors[0].file}:${col.errors[0].line}`, `${join(m.configRoot, 'repos', 'acme__ai-agents', 'config.md')}:12`);
  t('config error: not listed as waiting to enrol', v.panels.waiting.items.some((i) => i.repo === 'ai-agents'), false);
  t('config error: the other columns build', v.repos.find((r) => r.name === 'desk-skills').column, 'ok');
  const g = [{ name: 'fix_tries_ratio', scope: 'repo', est: 1.9, lo90: 1.3, hi90: 2.6, margin: 1.25, p_worse: 0.95 }];
  const badDs = REPOS.map((r) => (r.slug === DS ? { ...r, levers: '`none` `auto`' } : r));
  const ev = view(machine({ repos: badDs, files: { [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('wrappers', { guardrails: g })]) } }));
  t('config error: an evaluated lever keeps its guardrails', j(ev.panels.guardrails.rows.map((r) => `${r.lever} ${r.status}`)), '["wrappers breached"]');
  t('config error: a lever with no evaluation is error', cell(ev, 'memory').state, 'error');
  // One span holding `auto none` passes the config reader; desk-env's leverRow reads it as all off.
  const oneSpan = view(machine({ repos: REPOS.map((r) => (r.slug === DS ? { ...r, levers: '`auto none`' } : r)) }));
  const ds = oneSpan.repos.find((r) => r.name === 'desk-skills');
  t('config error: one span mixing none and auto is error, not auto', `${ds.column} ${ds.reads}`, 'error levers row unreadable');
  t('config error: and names why', /cannot sit beside/.test(ds.errors[0].message), true);
  t('config error: and is not counted on auto', oneSpan.panels.status.on_auto, 0);
}

// The per accepted ticket trends read merged tickets only; the cost panel stays per admitted.
{
  const rows = [row('DS-1', 10), row('DS-2', 11), row('DS-3', 12, { cost: 0, merged: null }), row('DS-4', 12, { cost: 2, merged: null, fix: 4 })];
  const v = view(machine({ files: evidence(DS, rows) }));
  const m = v.panels.trends.metrics;
  t('merged only: last week\'s cost leaves out tickets not merged', m.cost.callouts.last_week, 16.8);
  t('merged only: and its fix tries', m.fixes.callouts.last_week, 0);
  t('merged only: the cost panel counts every admitted ticket', v.panels.cost.weeks_before[0].admitted + v.panels.cost.weeks_before[1].admitted, 4);
}

// A ticket in several levers' evidence files is one row, its ticket-level fields from the newest
// evaluation's copy, and never a lever's own exclusion: the fleet-wide trends and the cost panel leave
// out only a ticket-wide reason (a pin mismatch, an incomplete cost).
{
  const rows = [row('DS-1', 2, { cost: 10 }), row('DS-2', 2, { cost: 20 }), row('DS-3', 2, { cost: 30 })];
  const m = machine({ files: {
    ...evidence(DS, rows, 'evl_2026-11-14_a.jsonl'),
    // The last file by name, as a lever whose own code changed writes it: every ticket fp_reset.
    ...evidence(DS, rows.map((r) => ({ ...r, excluded: 'fp_reset' })), 'evl_2026-11-14_wrappers.jsonl'),
    ...evidence(DS, [{ ...row('DS-4', 2, { cost: 99 }), pin_mismatch: true, excluded: 'pin_mismatch' }], 'evl_2026-11-14_b.jsonl'),
  } });
  const v = view(m);
  const c = v.panels.trends.metrics.cost.callouts;
  t('dedupe: a lever\'s fp_reset leaves no ticket out of the cost trend', c.to_date, 20);
  t('dedupe: nor out of the fix tries trend', v.panels.trends.metrics.fixes.callouts.to_date, 0);
  t('dedupe: a pin mismatch is still left out', v.panels.cost.this_week.usd_per_admitted, 20);
  t('dedupe: the data quality tally counts ticket-wide reasons only', j(v.panels.data_quality.excluded), '{"cost_incomplete":0,"pin_mismatch":1,"other":0}');
  t('dedupe: each ticket once', v.panels.data_quality.tickets, 4);
  // An older evaluation's copy sorts after the newer one by name: the newer copy still wins.
  const m2 = machine({ files: {
    ...evidence(DS, [row('DS-1', 2, { cost: 12 })], 'evl_new.jsonl'),
    ...evidence(DS, [row('DS-1', 2, { cost: 0, complete: false, merged: null })], 'evl_old.jsonl'),
  } });
  const ev = (n) => join(m2.root, DS, 'levers-evidence', n);
  utimesSync(ev('evl_old.jsonl'), new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));
  utimesSync(ev('evl_new.jsonl'), new Date(NOW - HOUR), new Date(NOW - HOUR));
  t('dedupe: the newest evaluation\'s copy of a ticket wins, not the last file read', view(m2).panels.trends.metrics.cost.callouts.to_date, 12);
}

// The per accepted ticket trends are keyed by the day each ticket merged, so a slow ticket counts on
// the day it finished rather than pulling its admission day up after the fact.
{
  const slow = { ...row('DS-1', 4, { cost: 40, fix: 2 }), merged_at: iso(1 * DAY) };
  const v = view(machine({ files: evidence(DS, [slow, row('DS-2', 1, { cost: 10 })]) }));
  const m = v.panels.trends.metrics;
  t('merge day: yesterday counts the slow ticket that merged yesterday', m.cost.callouts.yesterday, 25);
  t('merge day: and its fix tries', m.fixes.callouts.yesterday, 1);
  t('merge day: the day it was admitted has no point', m.cost.daily.at(-4).value, null);
  t('merge day: the trends say how many tickets each callout is over', j(m.cost.counts), '{"yesterday":2,"last_week":0,"mtd":2,"to_date":2}');
  t('merge day: the trends name their window', j([m.cost.keyed_by, m.cost.first_recorded]), '["merged_at","2026-11-11"]');
}

// The change list: an evidence_incomplete event carries what was not recorded, by ticket and file name
// rather than absolute path, and one repo's per-lever copies of it on one day are one event naming each
// lever.
{
  const st = '/home/x/.desk-autopilot/bigbenjoman__desk-skills';
  const missing = [`${st}/post-merge.jsonl (its latest scan is incomplete)`, `${st}/workers/DS-261.runs.jsonl`, `${st}/workers/DS-262.runs.jsonl`, `${st}/workers/DS-263.findings.jsonl`];
  const inc = (lever, at) => ({ v: 1, id: `i-${lever}-${at}`, at, repo: DS, lever, kind: 'evidence_incomplete', actor: 'levers-auto', reason_code: 'evidence_incomplete', eval_id: `evl_${lever}`, missing, reason: `${lever}: nothing adopts while outcome files are missing: ${missing.join(', ')}` });
  const log = [inc('wrappers', iso(2 * DAY)), inc('memory', iso(2 * DAY + MIN)), inc('codex', iso(2 * DAY + 2 * MIN)), inc('memory', iso(3 * DAY)),
    { v: 1, id: 't', at: iso(2 * DAY), repo: DS, lever: 'wrappers', kind: 'transition', from: 'off', to: 'trial', actor: 'controller', reason_code: 'row_change' },
    { v: 1, id: 't2', at: iso(2 * DAY), repo: DS, lever: 'memory', kind: 'transition', from: 'off', to: 'trial', actor: 'controller', reason_code: 'row_change' }];
  const v = view(machine({ repos: autoRepos, files: { [`${DS}/levers.jsonl`]: jsonl(log), [`${DS}/lever-evals.jsonl`]: jsonl([evalRow('wrappers')]) } }));
  const all = v.panels.changes.all;
  const incs = all.filter((e) => e.kind === 'evidence_incomplete');
  t('changes: one evidence_incomplete event per repo per day', incs.length, 2);
  t('changes: naming each lever it was recorded for', j(incs[0].levers), '["codex","memory","wrappers"]');
  t('changes: a merged event cites no one lever\'s evaluation', incs[0].evidence, null);
  t('changes: a single one keeps its lever', j([incs[1].levers, incs[1].lever]), '[["memory"],"memory"]');
  t('changes: what was not recorded, by ticket and file name', j(incs[0].missing), j([
    { what: 'a review round’s findings weren’t recorded', tickets: ['DS-261', 'DS-262'] },
    { what: 'no review findings were recorded', tickets: ['DS-263'] },
    { what: 'the post-merge watch’s latest scan didn’t finish', files: ['post-merge.jsonl'] },
  ]));
  t('changes: no absolute path is carried', JSON.stringify(incs[0].missing).includes('/home/x'), false);
  t('changes: decisions are never merged', all.filter((e) => e.kind === 'transition').length, 2);
}

// A lever an auto repo's config rules out says so as a short status, its rationale kept beside it.
{
  const v = view(machine({ repos: autoRepos }));
  const qh = cell(v, 'question-handling');
  t('preconditions: question handling without the ledger is ineligible', qh.state, 'ineligible');
  t('preconditions: with a short status', qh.status, 'needs ledger on');
  t('preconditions: and the rationale kept', qh.why, 'its asks and what they cost are read from the ticket ledger');
  const { REGISTRY } = await import('../desk/bin/lever-registry.mjs');
  t('preconditions: every precondition has a short status', Object.values(REGISTRY).flatMap((l) => l.preconditions).every((p) => typeof p.status === 'string' && p.status.length <= 32), true);
}

// An unrecorded sample size is never worded as 0.
{
  t('no n: the effect label', V.effectView({ lo90: -0.7, hi90: -0.4 }, null, 30).label, 'too early: sample not recorded, needs 30');
  t('no n: the cost label', V.costView({ lo90: 0.9, hi90: 1.0 }, null, 30).label, 'too early: sample not recorded, needs 30');
}

// The quality-risk cap is the registry's.
t('overhead: the quality-risk cap', view(machine()).panels.overhead.quality_risk_cap, 0.3);

// DS-709 AC14: a build run while another holds the Levers build lock waits for it, then builds.
{
  const { tryLock, unlock } = await import('../desk/bin/dir-lock.mjs');
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const out = V.leversDir();
  mkdirSync(out, { recursive: true });
  t('AC14 the lock is taken as a supervisor\'s build would', tryLock(V.buildLock(out)), true);
  const child = spawn('node', [join(dirname(new URL(import.meta.url).pathname), '..', 'desk', 'bin', 'levers-view.mjs'), 'build'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  child.stdout.on('data', (d) => { said += d; });
  const exited = new Promise((res) => child.on('exit', (code) => res(code)));
  await new Promise((res) => setTimeout(res, 1500));
  t('AC14 nothing is written while the other build holds the lock', existsSync(join(out, 'view.json')), false);
  unlock(V.buildLock(out));
  const code = await exited;
  t('AC14 once it lets go, the build runs and exits 0', j([code, existsSync(join(out, 'view.json')), existsSync(join(out, 'build.json'))]), j([0, true, true]));
  t('AC14 and says where it wrote', said.startsWith(`levers-view: wrote ${join(out, 'view.json')} and ${join(out, 'build.json')}`), true);
}

// DS-709 AC14, in this process (where no exit handler stands in for build letting go): build takes the
// lock, so one held here makes it wait and give up, and a build that ran has let go of it before returning.
{
  const { tryLock, unlock } = await import('../desk/bin/dir-lock.mjs');
  const { existsSync } = await import('node:fs');
  const m = machine({ repos: autoRepos });
  const out = join(m.out, 'inproc');
  mkdirSync(out, { recursive: true });
  tryLock(V.buildLock(out));
  let refused = '';
  try { V.build({ root: m.root, configRoot: m.configRoot, now: NOW, tz: 'UTC', out, waitMs: 200 }); } catch (e) { refused = e.message; }
  t('AC14 a build waits on the lock another build holds, then gives up writing nothing', j([refused.startsWith('another Levers build'), existsSync(join(out, 'view.json'))]), j([true, false]));
  unlock(V.buildLock(out));
  V.build({ root: m.root, configRoot: m.configRoot, now: NOW, tz: 'UTC', out });
  t('AC14 a build that ran has let go of the lock before it returns', j([existsSync(join(out, 'view.json')), existsSync(V.buildLock(out))]), j([true, false]));
}

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
