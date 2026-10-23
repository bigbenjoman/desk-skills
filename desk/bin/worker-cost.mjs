// Each worker's tokens, cost and wall time, from the result events in its stream-json logs: every
// round's in this batch, since a requeued ticket ran more than once. A worker with a run whose log
// has no result event is unknown, never zero: a killed or still-running worker spent something
// nobody recorded. The figures are what `claude -p` reports (total_cost_usd is notional on a
// subscription), and input counts cache reads and writes as well as fresh input.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { markersIn, saidIn, readLogFile } from './harvest.mjs';

export const START_UP = 'start-up';

// pass.mjs writes one of these into the ticket's log before each spawn: the permissions preflight is
// a claude -p call of its own, outside the worker's session, so its result event is not in the log.
// A null figure is one the preflight did not report.
export const PREFLIGHT_EVENT = 'desk_preflight';
export const preflightLine = ({ usd, turns }, at = new Date()) =>
  `${JSON.stringify({ type: PREFLIGHT_EVENT, total_cost_usd: usd, num_turns: turns, timestamp: at.toISOString() })}\n`;

// The preflights in one log: how many, the cost of those that reported one, and how many did not.
export function preflightUsage(logText) {
  const p = { n: 0, cost: 0, unknown: 0 };
  for (const line of logText.split('\n')) {
    if (!line.includes(PREFLIGHT_EVENT)) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== PREFLIGHT_EVENT) continue;
    p.n += 1;
    if (typeof d.total_cost_usd === 'number') p.cost += d.total_cost_usd;
    else p.unknown += 1;
  }
  return p;
}

// Adds one stage's tokens into a Map of stages by name, keeping the order they were first reached.
const addStage = (stages, name, input, output) => {
  const s = stages.get(name) ?? { name, input: 0, output: 0 };
  s.input += input;
  s.output += output;
  stages.set(name, s);
};

// One log's tokens per stage, or null when no assistant event carries usage. claude -p writes one
// assistant event per content block, each repeating its message's usage, so a message counts once,
// in the stage it was in when it ended: a message that prints a stage marker opens that stage. The
// usage on those events has the full input but only an early snapshot of the output; the final
// output is on the message's message_delta stream event, which only a log written with partial
// messages on has. Workers now run without them, so the snapshot stands in there, as it always has
// for subagents' messages, which count in the stage that called them. The run's total output comes
// from its result event (logUsage), which is exact either way. `first` is the first model call's input (fresh, cache writes and cache
// reads), the prompt the worker starts on.
export function stageUsage(logText) {
  const n = (v) => Number(v) || 0;
  const msgs = new Map();
  const finalOut = new Map();
  let stage = START_UP;
  for (const line of logText.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type === 'stream_event' && d.event?.type === 'message_delta' && d.api_message_id && d.event.usage) {
      finalOut.set(d.api_message_id, n(d.event.usage.output_tokens));
      continue;
    }
    if (d?.type !== 'assistant') continue;
    for (const c of d.message?.content ?? []) {
      const said = saidIn(c);
      if (said == null) continue;
      for (const [k, v] of markersIn([said])) if (k === 'AUTOPILOT_STAGE' && v.trim()) stage = v.trim().replace(/\s+/g, ' ');
    }
    const u = d.message?.usage;
    if (!u) continue;
    const id = d.message?.id ?? `line-${msgs.size}`;
    msgs.set(id, {
      stage,
      input: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens),
      output: Math.max(msgs.get(id)?.output ?? 0, n(u.output_tokens)),
      main: !d.parent_tool_use_id,
    });
  }
  if (!msgs.size) return null;
  const stages = new Map();
  for (const [id, m] of msgs) addStage(stages, m.stage, m.input, finalOut.get(id) ?? m.output);
  const first = [...msgs.values()].find((m) => m.main) ?? msgs.values().next().value;
  return { first: first.input, stages: [...stages.values()] };
}

// One log (one worker process), or null when it has no result event. A process that is woken again
// after its turn ends writes a result event per turn: cost and modelUsage in each are running totals
// for the session, so they come from the last one, and only duration_ms, which is per turn, is
// summed. Tokens come from modelUsage, which counts subagents' calls as the cost does; `usage` is
// the fallback for a result event without it.
export function logUsage(logText) {
  let last = null;
  let ms = 0;
  for (const line of logText.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== 'result') continue;
    last = d;
    ms += Number(d.duration_ms) || 0;
  }
  if (!last) return null;
  const n = (v) => Number(v) || 0;
  const models = Object.values(last.modelUsage ?? {});
  const [input, output] = models.length
    ? [models.reduce((s, m) => s + n(m.inputTokens) + n(m.cacheCreationInputTokens) + n(m.cacheReadInputTokens), 0),
      models.reduce((s, m) => s + n(m.outputTokens), 0)]
    : [n(last.usage?.input_tokens) + n(last.usage?.cache_creation_input_tokens) + n(last.usage?.cache_read_input_tokens),
      n(last.usage?.output_tokens)];
  return { input, output, cost: n(last.total_cost_usd), ms };
}

// A ticket's logs in this batch: the current `<KEY>.log` and every round a respawn or requeue moved
// aside (`<KEY>.log.round<n>.gz`, or `<KEY>.log.round<n>` from before rounds were compressed), less
// any last written before the ticket joined this queue (`added_at`): the logs directory outlives a
// batch, so an earlier batch's rounds of the same ticket are still there.
export function workerLogs(stateDir, key, since = null) {
  const dir = join(stateDir, 'logs');
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const from = since ? Date.parse(since) : NaN;
  return names.filter((n) => n === `${key}.log` || (n.startsWith(`${key}.log.round`) && /^\d+(\.gz)?$/.test(n.slice(`${key}.log.round`.length))))
    .map((n) => join(dir, n))
    .filter((f) => { try { return Number.isNaN(from) || statSync(f).mtimeMs >= from; } catch { return false; } });
}

// A log holding nothing but preflights: the spawn after them was refused, so no worker ran in it.
const preflightOnly = (text) => text.split('\n').every((l) => {
  try { return JSON.parse(l)?.type === PREFLIGHT_EVENT; } catch { return true; }
});

// -> { key, runs, unknown, usage, preflight, first, stages } for a queue ticket with a log, or null for
// one no worker ran. `unknown` counts the runs with no result event; any at all leaves `usage` null.
// `preflight` is every preflight's `{ n, cost, unknown }`, apart from `usage`. `first` and `stages`
// add every run's up, a stage seen in two runs once, and are null when any run's log has no
// assistant usage at all.
export function ticketCost(stateDir, ticket) {
  const round = (f) => { const m = f.match(/\.log\.round(\d+)(\.gz)?$/); return m ? Number(m[1]) : Infinity; };
  const logs = workerLogs(stateDir, ticket.key, ticket.added_at).sort((a, b) => round(a) - round(b));
  if (!logs.length) return null;
  const total = { input: 0, output: 0, cost: 0, ms: 0 };
  const preflight = { n: 0, cost: 0, unknown: 0 };
  let runs = 0;
  let unknown = 0;
  let first = 0;
  let stagesKnown = true;
  const stages = new Map();
  for (const f of logs) {
    let text = '';
    try { text = readLogFile(f); } catch { /* unreadable: unknown */ }
    const p = preflightUsage(text);
    for (const k of Object.keys(preflight)) preflight[k] += p[k];
    if (p.n && preflightOnly(text)) continue;
    runs += 1;
    const s = stageUsage(text);
    if (!s) stagesKnown = false;
    else {
      first += s.first;
      for (const st of s.stages) addStage(stages, st.name, st.input, st.output);
    }
    const u = logUsage(text);
    if (!u) { unknown += 1; continue; }
    for (const k of Object.keys(total)) total[k] += u[k];
  }
  return {
    key: ticket.key, runs, unknown, usage: unknown ? null : total, preflight,
    first: stagesKnown ? first : null, stages: stagesKnown ? [...stages.values()] : null,
  };
}

const tokens = (n) => n.toLocaleString('en-US');
const usd = (n) => `$${n.toFixed(2)}`;
export function wallTime(ms) {
  const s = Math.round(ms / 1000);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}h ${two(m)}m` : `${m}m ${two(sec)}s`;
}

// The report's table, one row per worker and a total row. The total adds the known rows only and
// says how many it left out, so an unknown row never reads as a zero inside it.
export function costTable(rows) {
  const known = rows.filter((r) => r.usage);
  const sum = { input: 0, output: 0, cost: 0, ms: 0 };
  for (const r of known) for (const k of Object.keys(sum)) sum[k] += r.usage[k];
  const noPre = { n: 0, cost: 0, unknown: 0 };
  const pre = { ...noPre };
  for (const r of known) for (const k of Object.keys(pre)) pre[k] += (r.preflight ?? noPre)[k];
  const firstOf = (r) => (r.first == null ? 'unknown' : tokens(r.first));
  // A preflight with no result is unknown, never a zero: it is named beside the known ones' cost.
  const preOf = (p = noPre) => (!p.n ? 'none' : p.unknown === p.n ? 'unknown'
    : `${usd(p.cost)}${p.unknown ? ` + ${p.unknown} unknown` : ''}`);
  const cells = (r, u, p = r.preflight ?? noPre) => [r.key, String(r.runs), tokens(u.input), tokens(u.output), usd(u.cost + p.cost), preOf(p), wallTime(u.ms), firstOf(r)];
  const table = rows.map((r) => (r.usage ? cells(r, r.usage)
    : [r.key, String(r.runs), 'unknown', 'unknown', 'unknown', preOf(r.preflight), 'unknown', firstOf(r)]));
  const firstKnown = rows.filter((r) => r.first != null);
  table.push(cells({ key: 'total', runs: rows.reduce((n, r) => n + r.runs, 0), first: firstKnown.length ? firstKnown.reduce((n, r) => n + r.first, 0) : null }, sum, pre));
  const head = ['worker', 'runs', 'input tokens', 'output tokens', 'cost', 'preflight', 'wall time', 'first-turn input'];
  const width = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const line = (row) => `  ${row.map((c, i) => (i < 2 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ')}`.trimEnd();
  // Each worker's stages sit under its row, in the order its runs reached them.
  const stageLines = (r) => {
    if (!r.stages) return ['      stages: unknown (no usage in the log)'];
    const w = Math.max(...r.stages.map((s) => s.name.length));
    const wi = Math.max(...r.stages.map((s) => tokens(s.input).length));
    return r.stages.map((s) => `      ${s.name.padEnd(w)}  ${tokens(s.input).padStart(wi)} in  ${tokens(s.output)} out`);
  };
  const out = [`WORKER COST — ${rows.length} worker(s); input counts cache reads and writes, cost is as claude -p reports it and includes the permissions preflights before each spawn, which the preflight column shows apart, wall time is the time inside the worker's turns, first-turn input is the prompt each run started on, and each worker's stages list the tokens from one stage marker to the next (${START_UP} is before the first)`, line(head)];
  for (const [i, row] of table.entries()) {
    const r = rows[i];
    out.push(`${line(row)}${r && !r.usage ? `   (${r.unknown} of ${r.runs} run(s) with no result event in the log)` : ''}`);
    if (r) out.push(...stageLines(r));
  }
  const notes = [];
  const leftFirst = rows.length - firstKnown.length;
  if (leftFirst) notes.push(`first-turn input leaves out ${leftFirst} worker(s) with no usage`);
  const left = rows.length - known.length;
  if (left) notes.push(`${left} unknown worker(s) not counted`);
  if (notes.length) out[out.length - 1] += `   (${notes.join('; ')})`;
  return out.join('\n');
}

// Every queue ticket a worker ran in this batch, in queue order.
export const batchCost = (stateDir, tickets) => tickets.map((t) => ticketCost(stateDir, t)).filter(Boolean);
