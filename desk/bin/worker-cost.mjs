// Each worker's tokens, cost and wall time, from the result events in its stream-json logs: every
// round's in this batch, since a requeued ticket ran more than once. A worker with a run whose log
// has no result event is unknown, never zero: a killed or still-running worker spent something
// nobody recorded. The figures are what `claude -p` reports (total_cost_usd is notional on a
// subscription), and input counts cache reads and writes as well as fresh input.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

// A ticket's logs in this batch: the current `<KEY>.log` and every `<KEY>.log.round<n>` requeue moved
// aside, less any last written before the ticket joined this queue (`added_at`): the logs directory
// outlives a batch, so an earlier batch's rounds of the same ticket are still there.
export function workerLogs(stateDir, key, since = null) {
  const dir = join(stateDir, 'logs');
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const from = since ? Date.parse(since) : NaN;
  return names.filter((n) => n === `${key}.log` || (n.startsWith(`${key}.log.round`) && /^\d+$/.test(n.slice(`${key}.log.round`.length))))
    .map((n) => join(dir, n))
    .filter((f) => { try { return Number.isNaN(from) || statSync(f).mtimeMs >= from; } catch { return false; } });
}

// -> { key, runs, unknown, usage } for a queue ticket with a log, or null for one no worker ran.
// `unknown` counts the runs with no result event; any at all leaves `usage` null.
export function ticketCost(stateDir, ticket) {
  const logs = workerLogs(stateDir, ticket.key, ticket.added_at);
  if (!logs.length) return null;
  const total = { input: 0, output: 0, cost: 0, ms: 0 };
  let unknown = 0;
  for (const f of logs) {
    let u = null;
    try { u = logUsage(readFileSync(f, 'utf8')); } catch { /* unreadable: unknown */ }
    if (!u) { unknown += 1; continue; }
    for (const k of Object.keys(total)) total[k] += u[k];
  }
  return { key: ticket.key, runs: logs.length, unknown, usage: unknown ? null : total };
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
  const cells = (r, u) => [r.key, String(r.runs), tokens(u.input), tokens(u.output), usd(u.cost), wallTime(u.ms)];
  const table = rows.map((r) => (r.usage ? cells(r, r.usage)
    : [r.key, String(r.runs), 'unknown', 'unknown', 'unknown', 'unknown']));
  table.push(cells({ key: 'total', runs: rows.reduce((n, r) => n + r.runs, 0) }, sum));
  const head = ['worker', 'runs', 'input tokens', 'output tokens', 'cost', 'wall time'];
  const width = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const line = (row) => `  ${row.map((c, i) => (i < 2 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ')}`.trimEnd();
  const out = [`WORKER COST — ${rows.length} worker(s); input counts cache reads and writes, cost is as claude -p reports it, wall time is the time inside the worker's turns`, line(head)];
  for (const [i, row] of table.entries()) {
    const r = rows[i];
    out.push(`${line(row)}${r && !r.usage ? `   (${r.unknown} of ${r.runs} run(s) with no result event in the log)` : ''}`);
  }
  const left = rows.length - known.length;
  if (left) out[out.length - 1] += `   (${left} unknown worker(s) not counted)`;
  return out.join('\n');
}

// Every queue ticket a worker ran in this batch, in queue order.
export const batchCost = (stateDir, tickets) => tickets.map((t) => ticketCost(stateDir, t)).filter(Boolean);
