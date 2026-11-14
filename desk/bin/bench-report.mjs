// The bench report: each arm's quality and cost over one bench run, beside the Phase 0 baseline.
//
//   node bench-report.mjs --tasks <file.json> [--out <dir>] [--blind <dir>] [--baseline <file>] [--plans <file>]
//
// <out> is bench.mjs's output folder (bench-out beside the task set by default). Its run.json says
// which runs each arm made, and each run's result.json holds its status, tokens and quota points. The
// report goes to <out>/report.md. <blind> (default <out>/blind) is bench-blind.mjs's folder: its
// joined.json holds the blind scores, and until it exists every score reads "not scored".
// <baseline> (default <out>/phase0-baseline.txt) is phase0-report.mjs's output saved to a file: its
// total section gives the baseline column, which reads "no baseline" when there is none. <plans>
// (default <out>/plans.json) is the plan table, written by hand from each provider's own page: it
// prices each arm's £ per accepted task and accepted tasks per 5-hour window, and an arm it does not
// price reads "not priced".
//
// A failed run counts in no figure but its own row. A task the run left out before any arm (run.json's
// left_out, such as arm 1's tasks with no packet) is listed with why. A task a run left unstarted is listed as not
// run, and when the arms did not run the same tasks each arm is shown on its own beside the
// baseline, never beside another arm. The report states figures; it gives no verdict.
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantile } from './desk-ci.mjs';
import { GO, OWN_USE, armVendor } from './bench-quota.mjs';

const USAGE = 'usage: bench-report.mjs --tasks <file.json> [--out <dir>] [--blind <dir>] [--baseline <file>] [--plans <file>]';
export const NOT_SCORED = 'not scored';
export const NO_BASELINE = 'no baseline';
const PRODUCE = (path) => `node ~/.claude/desk/bin/phase0-report.mjs --days 7 > ${path}`;

// argv -> { tasks, out, blind, baseline, plans }. Throws, naming the flag, on anything missing.
export function parseArgs(argv) {
  const names = { '--tasks': 'tasks', '--out': 'out', '--blind': 'blind', '--baseline': 'baseline', '--plans': 'plans' };
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key) throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    o[key] = argv[++i];
  }
  if (!o.tasks) throw new Error(`--tasks is required\n${USAGE}`);
  o.out = resolve(o.out || join(dirname(resolve(o.tasks)), 'bench-out'));
  o.blind = resolve(o.blind || join(o.out, 'blind'));
  o.baseline = resolve(o.baseline || join(o.out, 'phase0-baseline.txt'));
  o.plans = resolve(o.plans || join(o.out, 'plans.json'));
  return o;
}

const readJson = (file, what) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`cannot read ${what} ${file}: ${e.message}`); }
};
const count = (s) => Number(s.replace(/,/g, ''));

// phase0-report.mjs's text -> its total section's figures, or { why } when it is not that report.
//   { date, days, tickets, accepted, perTicket: { input, output, over } | null, perTicketWhy,
//     fixTries: number | null, quotaPoints: number | null }
export function parseBaseline(text) {
  const lines = String(text).split('\n');
  const head = /^PHASE 0 BASELINE: .+?, the ([\d.]+) day\(s\) from \S+ to (\d{4}-\d{2}-\d{2})T\S*?Z\./.exec(lines[0] ?? '');
  if (!head) return { why: 'its first line is not a PHASE 0 BASELINE header' };
  const start = lines.findIndex((l) => /^total\b.*:$/.test(l));
  if (start < 0) return { why: 'it has no total section' };
  const total = [];
  for (const l of lines.slice(start + 1)) { if (!l.startsWith('  ')) break; total.push(l.trim()); }
  const find = (re) => total.map((l) => re.exec(l)).find(Boolean);
  const tickets = find(/^tickets with work or a merge in the window: (\d+), accepted \(PR merged\): (\d+)$/);
  const per = find(/^per accepted ticket: (.*)$/);
  if (!tickets || !per) return { why: 'its total section has no tickets or per accepted ticket line' };
  const b = { date: head[2], days: Number(head[1]), tickets: Number(tickets[1]), accepted: Number(tickets[2]) };
  const n = /^([\d,]+) input tokens · ([\d,]+) output tokens · \$[\d.]+ API-equivalent, over (\d+) of \d+/.exec(per[1]);
  b.perTicket = n ? { input: count(n[1]), output: count(n[2]), over: Number(n[3]) } : null;
  b.perTicketWhy = n ? null : /^no ticket accepted/.test(per[1]) ? 'no ticket accepted' : 'not recorded';
  const fix = find(/^fix tries per accepted ticket: ([\d.]+) /);
  b.fixTries = fix ? Number(fix[1]) : null;
  const points = total.map((l) => /^quota, .*: \d+% to \d+%, (\d+) point\(s\) used/.exec(l)).filter(Boolean);
  b.quotaPoints = points.length ? points.reduce((s, m) => s + Number(m[1]), 0) : null;
  return b;
}

// The baseline file -> { ok: true, b, path } | { ok: false, why, path }.
export function loadBaseline(path) {
  if (!existsSync(path)) return { ok: false, path, why: `there is no baseline report at ${path}` };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return { ok: false, path, why: `cannot read ${path}: ${e.message}` }; }
  const b = parseBaseline(text);
  return b.why ? { ok: false, path, why: `${path} is not a Phase 0 baseline report: ${b.why}` } : { ok: true, path, b };
}

// run.json with each run's result.json beside its entry. -> { seed, arms, tasks: [{ task, runs: [{ arm, status, why, result }] }] }
export function loadRun(out) {
  const run = readJson(join(out, 'run.json'), 'the bench run');
  const arms = [];
  const tasks = (run.tasks ?? []).map((t) => ({
    task: t.task,
    runs: t.runs.map((r) => {
      if (!arms.includes(r.arm)) arms.push(r.arm);
      const result = r.dir && existsSync(join(r.dir, 'result.json')) ? readJson(join(r.dir, 'result.json'), 'a run result') : null;
      return { arm: r.arm, status: result?.status ?? r.status, why: r.why ?? result?.why ?? null, result };
    }),
  }));
  return { seed: run.seed ?? null, arms: arms.sort(), tasks, leftOut: run.left_out ?? [], armStops: run.arm_stops ?? [] };
}

const median = (values) => quantile(values, 0.5);

// Input tokens of all kinds, for one run.
export const allInput = (t) => ['uncached', 'cacheWrite', 'cacheRead'].reduce((s, k) => s + (Number(t[k]) || 0), 0);
// joined.json's scores for one arm. -> { mean, n } | null
export const meanScore = (list) => (list.length ? { mean: list.reduce((s, x) => s + x.score, 0) / list.length, n: list.length } : null);
// <blind>/joined.json, or null before the join has run.
export const readJoined = (blind) => { const file = join(blind, 'joined.json'); return existsSync(file) ? readJson(file, 'the joined scores') : null; };

// The plan table: what each plan costs a month and how big its windows are.
//   { rates: [{ currency, toGBP, read }],
//     plans: [{ provider, plan, price, currency, read, url, windows, serves: [{ arm | model, windows? }] }] }
// A window is { name, hours, size, unit }: `size` of `unit` every `hours`. A served entry's own windows
// replace the plan's, for a plan whose allowance is per model. The bench records a run's use only in
// WEEKLY_POINTS (quota.points, the rise in the account's weekly use in percent), so a window in any
// other unit reads "not measured".
export const NOT_PRICED = 'not priced';
export const WEEKLY_POINTS = 'weekly points';
export const STALE_DAYS = 31;
export const MONTH_HOURS = (365.25 * 24) / 12;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const windowWhy = (ws) => {
  if (!Array.isArray(ws) || !ws.length) return 'it has no windows';
  const bad = ws.find((w) => !(w?.hours > 0) || !(w?.size > 0) || typeof w?.unit !== 'string' || !w.unit);
  return bad ? `its window ${JSON.stringify(bad)} needs hours, size and unit` : null;
};

// One plan row -> why it cannot price anything, or null.
export function planWhy(p) {
  if (!p || typeof p !== 'object') return 'it is not an object';
  for (const k of ['provider', 'plan', 'currency', 'url']) if (typeof p[k] !== 'string' || !p[k]) return `it has no ${k}`;
  if (typeof p.price !== 'number' || !(p.price >= 0)) return 'it has no monthly price';
  if (typeof p.read !== 'string' || !DATE.test(p.read)) return 'it has no date read (YYYY-MM-DD)';
  if (!Array.isArray(p.serves) || !p.serves.length) return 'it serves no arm or model';
  for (const s of p.serves) {
    if (!s?.arm && !s?.model) return 'a served entry names no arm or model';
    const why = windowWhy(s.windows ?? p.windows);
    if (why) return `${s.arm ?? s.model}: ${why}`;
  }
  return null;
}

// The plan table file -> { ok: true, path, rates, plans } | { ok: false, path, why }. A row that
// cannot price is kept with its `why`, so an arm it serves names it rather than reading unserved.
export function loadPlans(path) {
  if (!existsSync(path)) return { ok: false, path, why: `there is no plan table at ${path}` };
  let t;
  try { t = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return { ok: false, path, why: `cannot read the plan table ${path}: ${e.message}` }; }
  if (!Array.isArray(t?.plans)) return { ok: false, path, why: `the plan table ${path} has no plans list` };
  const rates = (Array.isArray(t.rates) ? t.rates : []).filter((r) => typeof r?.currency === 'string' && r.toGBP > 0 && DATE.test(r.read ?? ''));
  return { ok: true, path, rates, plans: t.plans.map((p) => ({ ...p, why: planWhy(p) })) };
}

const lower = (s) => String(s ?? '').toLowerCase();
const planName = (p) => `${p.provider ?? '?'} ${p.plan ?? '?'}`;

// The plan row serving this arm, and the entry in it: an arm named outright beats one matched by model.
export function planFor(plans, f) {
  const hit = (test) => {
    for (const p of plans.plans) {
      const s = (Array.isArray(p.serves) ? p.serves : []).find(test);
      if (s) return { plan: p, served: s };
    }
    return null;
  };
  return hit((s) => s?.arm === f.arm) ?? (f.model ? hit((s) => s?.model && lower(s.model) === lower(f.model)) : null);
}

const money = (n) => `£${n < 0.1 ? n.toPrecision(2) : n.toFixed(2)}`;
const tasksN = (n) => (n >= 100 ? num(n) : (Math.round(n * 10) / 10).toFixed(1));

// One arm's value figures. -> { perTask, perWindow, plan, gbp, rate, stale, why }
//   perTask: £ per accepted task: the monthly price in £ over the accepted tasks one month of the
//     plan's windows allows at the arm's median use per accepted task, the tightest window binding.
//   perWindow: the 5-hour window's size over that median use, in the window's unit.
export function armValue(f, plans, now = Date.now()) {
  const not = (why) => ({ perTask: `${NOT_PRICED}: ${why}`, perWindow: `${NOT_PRICED}: ${why}`, why });
  if (!plans.ok) return not('no plan table');
  const m = planFor(plans, f);
  if (!m) return not('no plan serves this arm');
  const { plan, served } = m;
  if (plan.why) return { ...not(`${planName(plan)}: ${plan.why}`), plan };
  const cur = plan.currency.toUpperCase();
  const rate = cur === 'GBP' ? null : plans.rates.find((r) => r.currency.toUpperCase() === cur);
  const age = Math.floor((now - Date.parse(`${plan.read}T00:00:00Z`)) / DAY_MS);
  const stale = age > STALE_DAYS ? ` (stale: price read ${plan.read}, ${age} days ago)` : '';
  const gbp = cur === 'GBP' ? plan.price : rate ? plan.price * rate.toGBP : null;
  const base = { plan, rate, stale, gbp };
  if (!f.accepted) return { ...base, perTask: 'no task accepted', perWindow: 'no task accepted' };
  const points = median(f.acceptedQuota.map((q) => q.points).filter((v) => typeof v === 'number'));
  const windows = (served.windows ?? plan.windows).map((w) => ({ ...w, use: w.unit === WEEKLY_POINTS ? points : null }));
  const label = (w) => w.name ?? `${w.hours}-hour`;
  const notMeasured = (w) => (w.unit === WEEKLY_POINTS ? `no accepted run recorded its use in ${WEEKLY_POINTS}` : `the bench records use only in ${WEEKLY_POINTS}, not ${w.unit}`);
  const measured = windows.filter((w) => w.use > 0);
  const unmeasured = windows.filter((w) => !(w.use > 0)).map((w) => `${label(w)} window not measured: ${notMeasured(w)}`);
  const five = windows.find((w) => w.hours === 5);
  const perWindow = !five ? `${planName(plan)} has no 5-hour window`
    : !(five.use > 0) ? `not measured: ${notMeasured(five)}`
    : `${tasksN(five.size / five.use)} (${five.size} ${five.unit} ÷ ${pts(five.use)} per accepted task)${stale}`;
  let perTask;
  if (gbp == null) perTask = `${NOT_PRICED}: no ${cur} rate in the plan table`;
  else if (!measured.length) perTask = `not measured: ${[...new Set(windows.map(notMeasured))].join('; ')}`;
  else {
    const bound = measured.map((w) => ({ w, tasks: (MONTH_HOURS / w.hours) * (w.size / w.use) })).sort((a, b) => a.tasks - b.tasks)[0];
    perTask = `${money(gbp / bound.tasks)} (${money(gbp)} a month ÷ ${tasksN(bound.tasks)} task(s), bound by the ${label(bound.w)} window${unmeasured.length ? `; ${unmeasured.join('; ')}` : ''})${stale}`;
  }
  return { ...base, perTask, perWindow };
}

// The plan table's lines under the arms: each plan priced, with its conversion, and each arm unpriced.
function pricesSection(figures, values, plans) {
  if (!plans.ok) return ['## Prices', '', `Value figures read "${NOT_PRICED}": ${plans.why}.`, ''];
  const out = ['## Prices', ''];
  const seen = new Set();
  figures.forEach((f, i) => {
    const v = values[i];
    if (!v.plan) { out.push(`- ${f.arm}${f.model ? ` (model ${f.model})` : ''}: ${NOT_PRICED}: no plan in ${plans.path} serves it.`); return; }
    if (seen.has(v.plan)) return;
    seen.add(v.plan);
    const p = v.plan;
    const arms = figures.filter((_, j) => values[j].plan === p).map((g) => g.arm).join(', ');
    if (p.why) { out.push(`- ${planName(p)} (${arms}): ${NOT_PRICED}: ${p.why}.`); return; }
    const cur = p.currency.toUpperCase();
    const conv = cur === 'GBP' ? `£${p.price} a month`
      : v.rate ? `${p.price} ${cur} a month = ${money(v.gbp)} at ${v.rate.toGBP} GBP per ${cur}, rate read ${v.rate.read}`
      : `${p.price} ${cur} a month, ${NOT_PRICED}: the plan table has no ${cur} rate`;
    out.push(`- ${planName(p)} (${arms}): ${conv}; price read ${p.read} from ${p.url}${v.stale}.`);
  });
  out.push('', `A month is ${MONTH_HOURS} hours, every window used in full. A price is flagged stale once it is over ${STALE_DAYS} days old.`, '');
  return out;
}

// [vendor, label, what its points measure where a reading does not say it]. Built when called, since
// bench-quota.mjs imports this module and its bindings are not yet set while this one loads.
const allowances = () => [['claude', 'Claude', ''], ['codex', 'Codex', ''],
  [GO, 'OpenCode Go', ` (a share of each model's weekly allowance; ${OWN_USE})`]];
const TOKEN_KINDS = [['uncached', 'uncached input'], ['cacheWrite', 'cache-write'], ['cacheRead', 'cache-read'], ['output', 'output']];

// One arm's figures over the runs it made. `scores` is joined.json's entry for the arm, or null.
export function armFigures(tasks, arm, scores) {
  const runs = tasks.map((t) => ({ task: t.task, ...t.runs.find((r) => r.arm === arm) })).filter((r) => r.status);
  const ran = runs.filter((r) => r.status !== 'not run');
  const accepted = ran.filter((r) => r.status === 'accepted');
  const withTokens = accepted.filter((r) => r.result?.tokens);
  const tokens = Object.fromEntries(TOKEN_KINDS.map(([k]) => [k, median(withTokens.map((r) => Number(r.result.tokens[k]) || 0))]));
  tokens.input = median(withTokens.map((r) => allInput(r.result.tokens)));
  const byAccount = (list) => {
    const m = new Map();
    for (const r of list) {
      const q = r.result?.quota;
      if (!q?.account) continue;
      const e = m.get(q.account) ?? { points: [], unreadable: 0 };
      if (typeof q.points === 'number') e.points.push(q.points); else e.unreadable += 1;
      m.set(q.account, e);
    }
    return m;
  };
  const list = scores?.scores ?? [];
  const model = ran.map((r) => r.result?.model).find(Boolean);
  return {
    arm,
    model: model ?? null,
    vendor: armVendor({ model }),
    acceptedQuota: accepted.map((r) => r.result?.quota).filter(Boolean),
    ran: ran.map((r) => r.task),
    accepted: accepted.length,
    rejected: ran.filter((r) => r.status === 'rejected').length,
    failed: ran.filter((r) => r.status === 'failed').length,
    notRun: runs.filter((r) => r.status === 'not run').map((r) => ({ task: r.task, why: r.why })),
    score: meanScore(list),
    tokens, tokensOver: withTokens.length,
    quotaAccepted: byAccount(accepted),
    quotaAll: byAccount(ran),
  };
}

export const num = (n) => Math.round(n).toLocaleString('en-US');
const pts = (n) => String(Math.round(n * 100) / 100);
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const over = (k, of) => (k < of ? ` (over ${k} of ${of})` : '');
const accounts = (m, value) => ([...m].length ? [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([name, e]) => `${name}: ${value(e)}`).join(' · ') : 'not recorded');
const unread = (e) => (e.unreadable ? `, ${e.unreadable} run(s) unreadable` : '');

// The table's rows: [label, baseline cell, (figures) -> arm cell].
function rows(baseline) {
  const b = baseline.ok ? baseline.b : null;
  const none = NO_BASELINE;
  const perTicket = (k) => (!b ? none : b.perTicket ? `${num(b.perTicket[k])} (mean over ${b.perTicket.over} ticket(s))` : b.perTicketWhy);
  const noTask = (f, v) => (!f.accepted ? 'no task accepted' : v);
  const tok = (k) => (f) => noTask(f, f.tokensOver ? `${num(f.tokens[k])}${over(f.tokensOver, f.accepted)}` : 'not recorded');
  return [
    ['Tasks accepted, of tasks run', b ? `${b.accepted} ticket(s) accepted of ${b.tickets} worked` : none, (f) => `${f.accepted} of ${f.accepted + f.rejected}`],
    ['Runs failed (not counted)', b ? '—' : none, (f) => String(f.failed)],
    ['Mean blind score (1 to 5)', b ? '—' : none, (f) => (f.score ? `${f.score.mean.toFixed(2)} (${f.score.n} scored)` : NOT_SCORED)],
    ['£ per accepted task', b ? '—' : none, (f) => f.value.perTask],
    ['Accepted tasks per 5-hour window', b ? '—' : none, (f) => f.value.perWindow],
    ...TOKEN_KINDS.map(([k, label]) => [`Median ${label} tokens per accepted task`, k === 'output' ? perTicket('output') : b ? '—' : none, tok(k)]),
    ['Input tokens of all kinds per accepted task (median)', perTicket('input'), tok('input')],
    // Each allowance on its own line: an arm spends one vendor's, so the other's cell is a dash. The
    // baseline's quota is the signed-in Claude login's.
    ...allowances().flatMap(([vendor, label, note]) => {
      const own = (f, v) => (f.vendor === vendor ? v() : '—');
      return [
        [`${label} quota points per accepted task (median), per account${note}`,
          !b ? none : vendor !== 'claude' ? '—' : b.quotaPoints == null ? 'not recorded' : !b.accepted ? 'no ticket accepted' : `signed-in login: ${(b.quotaPoints / b.accepted).toFixed(2)} (${b.quotaPoints} point(s) ÷ ${b.accepted} accepted)`,
          (f) => own(f, () => noTask(f, accounts(f.quotaAccepted, (e) => (e.points.length ? `${pts(median(e.points))}${over(e.points.length, e.points.length + e.unreadable)}` : 'unreadable'))))],
        [`${label} quota points used by every run, per account${note}`, b ? '—' : none, (f) => own(f, () => accounts(f.quotaAll, (e) => `${pts(e.points.reduce((s, p) => s + p, 0))}${unread(e)}`))],
      ];
    }),
    ['Repair cycles per ticket', !b ? none : b.fixTries == null ? 'no ticket accepted' : `${b.fixTries.toFixed(2)} (fix tries per accepted ticket)`, () => '— (one run per task)'],
  ];
}

function table(figures, baseline) {
  const out = [`| Figure | Phase 0 baseline | ${figures.map((f) => cell(f.arm)).join(' | ')} |`, `|---|---|${figures.map(() => '---|').join('')}`];
  for (const [label, base, armCell] of rows(baseline)) out.push(`| ${label} | ${cell(base)} | ${figures.map((f) => cell(armCell(f))).join(' | ')} |`);
  return out;
}

// The markdown report. -> { text, compared, figures }
export function renderReport({ out, run, joined, baseline, plans = { ok: false, path: null, why: 'no plan table was given' }, now = Date.now() }) {
  const figures = run.arms.map((a) => armFigures(run.tasks, a, joined?.arms && Object.hasOwn(joined.arms, a) ? joined.arms[a] : null));
  for (const f of figures) f.value = armValue(f, plans, now);
  const same = figures.every((f) => f.ran.join('\n') === figures[0].ran.join('\n'));
  const text = [`# Bench report: ${out}`, '',
    `${run.tasks.length} task(s) · arms ${run.arms.join(', ')}${run.seed ? ` · seed ${run.seed}` : ''}`, ''];
  text.push(baseline.ok
    ? `Phase 0 baseline: the ${baseline.b.days} day(s) to ${baseline.b.date}, from ${baseline.path}. Its token figures are means per accepted ticket over real tickets; an arm's are medians per accepted task.`
    : `Phase 0 baseline: ${NO_BASELINE}: ${baseline.why}. Produce one in the repo the tasks came from with \`${PRODUCE(baseline.path)}\`, then write this report again.`, '');
  if (!joined) text.push(`Blind scores: ${NOT_SCORED}. Score the sheets \`bench-blind.mjs export\` wrote, then run \`bench-blind.mjs join\`.`, '');
  else if (joined.left_out?.length) text.push(`Blind scores: ${joined.left_out.length} sheet(s) left out, none of their scores counted: ${joined.left_out.map((l) => `${l.task} (${l.why})`).join('; ')}.`, '');
  text.push('## Tasks', '', `| Task | ${run.arms.map(cell).join(' | ')} |`, `|---|${run.arms.map(() => '---|').join('')}`);
  for (const t of run.tasks) text.push(`| ${cell(t.task)} | ${run.arms.map((a) => cell(t.runs.find((r) => r.arm === a)?.status ?? '—')).join(' | ')} |`);
  text.push('');
  if (run.leftOut?.length) {
    text.push('## Left out', '', 'These tasks ran on no arm:', '');
    for (const l of run.leftOut) text.push(`- ${l.task}: ${l.why}`);
    text.push('');
  }
  if (run.armStops?.length) {
    text.push('## Arms stopped', '', 'These arms started no further run:', '');
    for (const s of run.armStops) text.push(`- ${s.arm}: ${s.why}`);
    text.push('');
  }
  const notRun = figures.flatMap((f) => f.notRun.map((n) => ({ ...n, arm: f.arm })));
  if (notRun.length) {
    text.push('## Not run', '', 'These runs never started, and count in no figure:', '');
    for (const n of notRun) text.push(`- ${n.task} (${n.arm})${n.why ? `: ${n.why}` : ''}`);
    text.push('');
  }
  text.push('## Arms', '');
  if (same) text.push(...table(figures, baseline));
  else {
    text.push(`No comparison between arms: they did not run the same tasks (${figures.map((f) => `${f.arm} ran ${f.ran.length}`).join(', ')}). Each arm stands beside the baseline on its own.`);
    for (const f of figures) text.push('', `### ${f.arm}`, '', ...table([f], baseline));
  }
  text.push('', ...pricesSection(figures, figures.map((f) => f.value), plans));
  text.push('A failed run is in neither tasks accepted nor tasks run. Quota points are the rise in the account\'s weekly use during a run, other work on that account included.');
  return { text: `${text.join('\n')}\n`, compared: same, figures };
}

// Reads the run, the scores and the baseline, and writes <out>/report.md. -> { path, text, compared }
export function writeReport(o) {
  const run = loadRun(o.out);
  const joined = readJoined(o.blind);
  const r = renderReport({ out: o.out, run, joined, baseline: loadBaseline(o.baseline), plans: loadPlans(o.plans) });
  const path = join(o.out, 'report.md');
  writeFileSync(path, r.text);
  return { path, ...r };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const { path, text } = writeReport(parseArgs(process.argv.slice(2)));
    process.stdout.write(text);
    console.log(`report: ${path}`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
