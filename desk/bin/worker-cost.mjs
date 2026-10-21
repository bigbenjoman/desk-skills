#!/usr/bin/env node
// Each worker's tokens, cost and wall time, from the result events in its stream-json logs: every
// round's, since a requeued ticket ran more than once. A worker with a run whose log has no result
// event is unknown, never zero: a killed or still-running worker spent something nobody recorded.
// The figures are what `claude -p` reports (total_cost_usd is notional on a subscription), and input
// counts cache reads and writes as well as fresh input.
//   node worker-cost.mjs [--json]    the queue's workers, as the batch report prints them
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// One log's result events, summed, or null when it has none.
export function logUsage(logText) {
  let found = false;
  const u = { input: 0, output: 0, cost: 0, ms: 0 };
  for (const line of logText.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== 'result') continue;
    found = true;
    const t = d.usage ?? {};
    u.input += (Number(t.input_tokens) || 0) + (Number(t.cache_creation_input_tokens) || 0) + (Number(t.cache_read_input_tokens) || 0);
    u.output += Number(t.output_tokens) || 0;
    u.cost += Number(d.total_cost_usd) || 0;
    u.ms += Number(d.duration_ms) || 0;
  }
  return found ? u : null;
}

// A ticket's logs: the current `<KEY>.log` and every `<KEY>.log.round<n>` requeue moved aside.
export function workerLogs(stateDir, key) {
  const dir = join(stateDir, 'logs');
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n === `${key}.log` || (n.startsWith(`${key}.log.round`) && /^\d+$/.test(n.slice(`${key}.log.round`.length))))
    .map((n) => join(dir, n));
}

// -> { key, runs, unknown, usage } for a ticket with a log, or null for one no worker ever ran.
// `unknown` counts the runs with no result event; any at all leaves `usage` null.
export function ticketCost(stateDir, key) {
  const logs = workerLogs(stateDir, key);
  if (!logs.length) return null;
  const total = { input: 0, output: 0, cost: 0, ms: 0 };
  let unknown = 0;
  for (const f of logs) {
    let u = null;
    try { u = logUsage(readFileSync(f, 'utf8')); } catch { /* unreadable: unknown */ }
    if (!u) { unknown += 1; continue; }
    for (const k of Object.keys(total)) total[k] += u[k];
  }
  return { key, runs: logs.length, unknown, usage: unknown ? null : total };
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
  const out = [`WORKER COST — ${rows.length} worker(s); input counts cache reads and writes, cost is as claude -p reports it`, line(head)];
  for (const [i, row] of table.entries()) {
    const r = rows[i];
    out.push(`${line(row)}${r && !r.usage ? `   (${r.unknown} of ${r.runs} run(s) with no result event in the log)` : ''}`);
  }
  const left = rows.length - known.length;
  if (left) out[out.length - 1] += `   (${left} unknown worker(s) not counted)`;
  return out.join('\n');
}

// Every ticket in the queue that a worker ran, in queue order.
export const batchCost = (stateDir, keys) => keys.map((k) => ticketCost(stateDir, k)).filter(Boolean);

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const { stateDir, queueFile } = await import('./desk-env.mjs');
  const q = JSON.parse(readFileSync(queueFile(), 'utf8'));
  const rows = batchCost(stateDir(), Object.keys(q.tickets ?? {}));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
  else console.log(rows.length ? costTable(rows) : 'WORKER COST — no worker has run in this batch');
}
