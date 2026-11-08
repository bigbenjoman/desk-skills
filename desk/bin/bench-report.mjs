// The bench report: each arm's quality and cost over one bench run, beside the Phase 0 baseline.
//
//   node bench-report.mjs --tasks <file.json> [--out <dir>] [--blind <dir>] [--baseline <file>]
//
// <out> is bench.mjs's output folder (bench-out beside the task set by default). Its run.json says
// which runs each arm made, and each run's result.json holds its status, tokens and quota points. The
// report goes to <out>/report.md. <blind> (default <out>/blind) is bench-blind.mjs's folder: its
// joined.json holds the blind scores, and until it exists every score reads "not scored".
// <baseline> (default <out>/phase0-baseline.txt) is phase0-report.mjs's output saved to a file: its
// total section gives the baseline column, which reads "no baseline" when there is none.
//
// A failed run counts in no figure but its own row. A task the run left out before any arm (run.json's
// left_out, such as arm 1's tasks with no packet) is listed with why. A task a run left unstarted is listed as not
// run, and when the arms did not run the same tasks each arm is shown on its own beside the
// baseline, never beside another arm. The report states figures; it gives no verdict.
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quantile } from './desk-ci.mjs';
import { armVendor } from './bench-quota.mjs';

const USAGE = 'usage: bench-report.mjs --tasks <file.json> [--out <dir>] [--blind <dir>] [--baseline <file>]';
export const NOT_SCORED = 'not scored';
export const NO_BASELINE = 'no baseline';
const PRODUCE = (path) => `node ~/.claude/desk/bin/phase0-report.mjs --days 7 > ${path}`;

// argv -> { tasks, out, blind, baseline }. Throws, naming the flag, on anything missing.
export function parseArgs(argv) {
  const names = { '--tasks': 'tasks', '--out': 'out', '--blind': 'blind', '--baseline': 'baseline' };
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

const ALLOWANCES = [['claude', 'Claude'], ['codex', 'Codex']];
const TOKEN_KINDS = [['uncached', 'uncached input'], ['cacheWrite', 'cache-write'], ['cacheRead', 'cache-read'], ['output', 'output']];

// One arm's figures over the runs it made. `scores` is joined.json's entry for the arm, or null.
export function armFigures(tasks, arm, scores) {
  const runs = tasks.map((t) => ({ task: t.task, ...t.runs.find((r) => r.arm === arm) })).filter((r) => r.status);
  const ran = runs.filter((r) => r.status !== 'not run');
  const accepted = ran.filter((r) => r.status === 'accepted');
  const withTokens = accepted.filter((r) => r.result?.tokens);
  const tokens = Object.fromEntries(TOKEN_KINDS.map(([k]) => [k, median(withTokens.map((r) => Number(r.result.tokens[k]) || 0))]));
  tokens.input = median(withTokens.map((r) => ['uncached', 'cacheWrite', 'cacheRead'].reduce((s, k) => s + (Number(r.result.tokens[k]) || 0), 0)));
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
    vendor: armVendor({ model }),
    ran: ran.map((r) => r.task),
    accepted: accepted.length,
    rejected: ran.filter((r) => r.status === 'rejected').length,
    failed: ran.filter((r) => r.status === 'failed').length,
    notRun: runs.filter((r) => r.status === 'not run').map((r) => ({ task: r.task, why: r.why })),
    score: list.length ? { mean: list.reduce((s, x) => s + x.score, 0) / list.length, n: list.length } : null,
    tokens, tokensOver: withTokens.length,
    quotaAccepted: byAccount(accepted),
    quotaAll: byAccount(ran),
  };
}

const num = (n) => Math.round(n).toLocaleString('en-US');
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
    ...TOKEN_KINDS.map(([k, label]) => [`Median ${label} tokens per accepted task`, k === 'output' ? perTicket('output') : b ? '—' : none, tok(k)]),
    ['Input tokens of all kinds per accepted task (median)', perTicket('input'), tok('input')],
    // Each allowance on its own line: an arm spends one vendor's, so the other's cell is a dash. The
    // baseline's quota is the signed-in Claude login's.
    ...ALLOWANCES.flatMap(([vendor, label]) => {
      const own = (f, v) => (f.vendor === vendor ? v() : '—');
      return [
        [`${label} quota points per accepted task (median), per account`,
          !b ? none : vendor !== 'claude' ? '—' : b.quotaPoints == null ? 'not recorded' : !b.accepted ? 'no ticket accepted' : `signed-in login: ${(b.quotaPoints / b.accepted).toFixed(2)} (${b.quotaPoints} point(s) ÷ ${b.accepted} accepted)`,
          (f) => own(f, () => noTask(f, accounts(f.quotaAccepted, (e) => (e.points.length ? `${pts(median(e.points))}${over(e.points.length, e.points.length + e.unreadable)}` : 'unreadable'))))],
        [`${label} quota points used by every run, per account`, b ? '—' : none, (f) => own(f, () => accounts(f.quotaAll, (e) => `${pts(e.points.reduce((s, p) => s + p, 0))}${unread(e)}`))],
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
export function renderReport({ out, run, joined, baseline }) {
  const figures = run.arms.map((a) => armFigures(run.tasks, a, joined?.arms && Object.hasOwn(joined.arms, a) ? joined.arms[a] : null));
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
  text.push('', 'A failed run is in neither tasks accepted nor tasks run. Quota points are the rise in the account\'s weekly use during a run, other work on that account included.');
  return { text: `${text.join('\n')}\n`, compared: same, figures };
}

// Reads the run, the scores and the baseline, and writes <out>/report.md. -> { path, text, compared }
export function writeReport(o) {
  const run = loadRun(o.out);
  const joinedFile = join(o.blind, 'joined.json');
  const joined = existsSync(joinedFile) ? readJson(joinedFile, 'the joined scores') : null;
  const r = renderReport({ out: o.out, run, joined, baseline: loadBaseline(o.baseline) });
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
