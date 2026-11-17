// suite: levers view (one view model of every repo's levers, with input ages and the honesty rules)
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const j = (v) => JSON.stringify(v);
process.env.HOME = mkdtempSync(join(tmpdir(), 'levers-view-home-'));
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
  const base = mkdtempSync(join(tmpdir(), 'levers-view-'));
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

// DS-692 AC2: each repo's rework share this week, cost-weighted, with its data age.
{
  const rw = (key, o) => ({ ...row(key, 2, o), rework_share: o.share, rework_cost: o.rework, rework_by_cause: o.causes, rework_by_class: o.classes });
  const m = machine({ files: evidence(DS, [
    rw('DS-1', { cost: 10, share: 0.4, rework: 4, causes: { 'review round': 3, 'CI red': 1 }, classes: { 'application defect': 4 } }),
    rw('DS-2', { cost: 6, share: 0, rework: 0, causes: {}, classes: {} }),
    rw('DS-3', { cost: 5, complete: false, share: null, rework: 0, causes: {}, classes: {} }),
    row('DS-4', 2, { cost: 2 }),
    // Admitted before this week.
    { ...rw('DS-5', { cost: 9, share: 0.5, rework: 4.5, causes: { conflict: 4.5 }, classes: {} }), admitted_at: iso(9 * DAY) },
  ]) } });
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

// An unrecorded sample size is never worded as 0.
{
  t('no n: the effect label', V.effectView({ lo90: -0.7, hi90: -0.4 }, null, 30).label, 'too early: sample not recorded, needs 30');
  t('no n: the cost label', V.costView({ lo90: 0.9, hi90: 1.0 }, null, 30).label, 'too early: sample not recorded, needs 30');
}

// The quality-risk cap is the registry's.
t('overhead: the quality-risk cap', view(machine()).panels.overhead.quality_risk_cap, 0.3);

console.log(fails ? `${fails} check(s) failed` : 'all checks passed');
process.exit(fails ? 1 : 0);
