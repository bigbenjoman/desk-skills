// Each worker's tokens, cost and wall time, from the result events in its stream-json logs: every
// round's in this batch, since a requeued ticket ran more than once. A worker with a run whose log
// has no result event is unknown, never zero: a killed or still-running worker spent something
// nobody recorded. The figures are what `claude -p` reports (total_cost_usd is notional on a
// subscription), and input counts cache reads and writes as well as fresh input.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { markersIn, saidIn, readLogFile } from './harvest.mjs';
import { cloudWall } from './cloud-worker.mjs';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { NO_EFFORT } from './desk-env.mjs';
import { archivedOf } from './queue-store.mjs';
import { readQueue } from './batch-state.mjs';

export const START_UP = 'start-up';

// API list prices in USD per million tokens, for the current model of each family (Opus 5.5, Sonnet
// 5.5, Haiku 5.5): uncached input, a write to the 5-minute and the 1-hour prompt cache, a cache read,
// and output. Haiku's `over` prices a request whose prompt is past `above` tokens.
export const MODEL_PRICES = {
  opus: { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  sonnet: { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
  haiku: { input: 0.1, write5m: 0.125, write1h: 0.2, read: 0.01, output: 0.5,
    over: { above: 100000, input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 } },
};
// The family a model id belongs to (`claude-opus-5-5` is `opus`), or null for one MODEL_PRICES lacks.
export const modelFamily = (model) => Object.keys(MODEL_PRICES).find((f) => String(model ?? '').toLowerCase().includes(f)) ?? null;

// OpenAI's standard API list prices in USD per million tokens for the GPT-6 models Codex runs on
// (developers.openai.com/api/docs/pricing): input, cached input and output, and `long` for a request
// whose input is past `above` tokens.
const GPT6 = (input, read, output) => ({ input, read, output, long: { above: 272000, input: input * 2, read: read * 2, output: output * 1.5 } });
export const CODEX_PRICES = {
  'gpt-6.2-astra': GPT6(8, 0.4, 40),
  'gpt-6.2-sol': GPT6(2, 0.1, 10),
  'gpt-6.1-sol': GPT6(2, 0.1, 10),
  'gpt-6.1-terra': GPT6(1, 0.05, 5),
  'gpt-6-astra': GPT6(10, 1, 50),
  'gpt-6-sol': GPT6(2, 0.2, 10),
  'gpt-6-luna': GPT6(0.1, 0.01, 0.5),
};
// The prices of a Codex model id: a listed id, or one with a suffix after it (`gpt-6.1-sol-high` is
// gpt-6.1-sol), or null.
export const codexPrices = (model) => {
  const m = String(model ?? '').toLowerCase();
  const k = Object.keys(CODEX_PRICES).find((p) => m === p || m.startsWith(`${p}-`));
  return k ? CODEX_PRICES[k] : null;
};

// pass.mjs writes one of these into the ticket's log before each spawn: the permissions preflight is
// a claude -p call of its own, outside the worker's session, so its result event is not in the log.
// A null figure is one the preflight did not report. Its time is `at`, not `timestamp`, which
// firstSpawnFromLogs (desk-q-eta.mjs) reads as a worker's start.
const PREFLIGHT_EVENT = 'desk_preflight';
export const preflightLine = ({ usd, turns }, at = new Date()) =>
  `${JSON.stringify({ type: PREFLIGHT_EVENT, total_cost_usd: usd, num_turns: turns, at: at.toISOString() })}\n`;

// spawn-worker.sh writes one of these into the log before each launch: what the session starts as, on
// which model and at which effort, `default` where it passes neither. Timed by `at` for the same reason.
const SPAWN_EVENT = 'desk_spawn';
export const startFields = ({ stage, model, effort }) => ({ stage: stage || '0', model: model || 'default', effort: effort || NO_EFFORT });
export const spawnEvent = ({ session, ...start }, at = new Date()) =>
  `${JSON.stringify({ type: SPAWN_EVENT, session, ...startFields(start), at: at.toISOString() })}\n`;

// Whether a worker wrote anything past byte `from` of its log: the lines desk writes there itself (the
// preflight, the start, the memory digest) are not its output, so they never read as it being live.
// Pass the log as read from disk: `from` is a file size, and text decoded from a log holding a byte
// that is not UTF-8 is longer than the file, which would read as output on every pass.
const writtenSince = (log, from) => Buffer.from(log).subarray(from).toString().split('\n')
  .filter((l) => l.trim() && !l.startsWith('{"type":"desk_'));
export const wroteSince = (log, from) => writtenSince(log, from).length > 0;

// Where everything a worker wrote past byte `from` is the harness's tool_progress heartbeat, the call it
// has run longest: { tool, id, secs }. Null where it wrote nothing, or anything else (a partial line
// included), since then the worker is doing more than waiting on one call.
export function heartbeatOnly(log, from) {
  const lines = writtenSince(log, from);
  let longest = null;
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { return null; }
    if (e?.type !== 'tool_progress' || !Number.isFinite(e.elapsed_time_seconds)) return null;
    if (!longest || e.elapsed_time_seconds > longest.secs) {
      longest = { tool: e.tool_name ?? 'tool', id: e.parent_tool_use_id ?? e.tool_use_id ?? null, secs: e.elapsed_time_seconds };
    }
  }
  return longest;
}

// The starts in one log: a fresh session's, and each resume of it.
function spawnStarts(logText) {
  const starts = [];
  for (const line of logText.split('\n')) {
    if (!line.includes(SPAWN_EVENT)) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type === SPAWN_EVENT) starts.push({ stage: d.stage, model: d.model, effort: d.effort });
  }
  return starts;
}

// The preflights in one log: how many, the cost of those that reported one, and how many did not.
function preflightUsage(logText) {
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

// One result event's tokens by kind. Tokens come from modelUsage, which counts subagents' calls as
// the cost does; `usage` is the fallback for a result event without it.
export function resultTokens(d) {
  const n = (v) => Number(v) || 0;
  const models = Object.values(d.modelUsage ?? {});
  const sum = (k) => models.reduce((s, m) => s + n(m[k]), 0);
  return models.length
    ? { uncached: sum('inputTokens'), cacheWrite: sum('cacheCreationInputTokens'), cacheRead: sum('cacheReadInputTokens'), output: sum('outputTokens') }
    : { uncached: n(d.usage?.input_tokens), cacheWrite: n(d.usage?.cache_creation_input_tokens), cacheRead: n(d.usage?.cache_read_input_tokens), output: n(d.usage?.output_tokens) };
}

// One log's tokens by kind from its last result event, or null when it has none.
export function logTokens(logText) {
  let last = null;
  for (const line of logText.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type === 'result') last = d;
  }
  return last && resultTokens(last);
}

// One log (one worker process), or null when it has no result event. A process that is woken again
// after its turn ends writes a result event per turn: cost and modelUsage in each are running totals
// for the session, so they come from the last one, and only duration_ms, which is per turn, is
// summed.
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
  const t = resultTokens(last);
  return { input: t.uncached + t.cacheWrite + t.cacheRead, output: t.output, cost: Number(last.total_cost_usd) || 0, ms };
}

// A ticket's logs in this batch: the current `<KEY>.log` and every round a respawn or requeue moved
// aside (`<KEY>.log.round<n>`, gzipped or not), less
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

// A log holding nothing but preflights: the spawn after them was refused, so no worker ran in it. A
// line of stderr is a worker that ran and died, so it is a run.
const preflightOnly = (text) => text.split('\n').every((l) => {
  if (!l.trim()) return true;
  try { return JSON.parse(l)?.type === PREFLIGHT_EVENT; } catch { return false; }
});

// -> { key, runs, unknown, usage, preflight, first, stages, sessions } for a queue ticket with a log, or
// null for one no worker ran. `unknown` counts the runs with no result event; any at all leaves `usage`
// null. `preflight` is every preflight's `{ n, cost, unknown }`, apart from `usage`. `first` and `stages`
// add every run's up, a stage seen in two runs once, and are null when any run's log has no
// assistant usage at all. `sessions` is each run's `{ starts, cost }`: a run is one session, so one
// log, and `starts` is empty for a log written before starts were recorded.
// A cloud worker writes no log here and nothing reports its tokens or cost: its row is its session
// URL and its wall time from session start to PR (`cloud`), and its usage stays null. Its one session
// starts at Stage 0 with no model or effort passed, which is what startFields gives for nothing.
// A worker log's file name, any ticket's: the current `<KEY>.log` or a round moved aside, gzipped or not.
// Its groups are the key and the round (none for the current log).
export const WORKER_LOG = /^(.+)\.log(?:\.round(\d+)(?:\.gz)?)?$/;
// A log's place in a ticket's round order: `.round<n>` by n, the current log last.
export const logRound = (f) => { const m = String(f).match(/\.log\.round(\d+)(\.gz)?$/); return m ? Number(m[1]) : Infinity; };

// A review try on its PR runs here and logs here: those runs are added to the same row, their
// usage the row's usage, with the cloud session kept first (`cloud: true`, no cost).
export function ticketCost(stateDir, ticket) {
  const local = localCost(stateDir, ticket);
  if (!(ticket.location === 'cloud' && ticket.cloud)) return local;
  const session = { starts: [startFields({})], cost: null, cloud: true };
  const cloud = { url: ticket.cloud.url ?? null, ms: cloudWall(ticket.cloud) };
  if (!local) {
    return { key: ticket.key, runs: 1, unknown: 0, usage: null, preflight: { n: 0, cost: 0, unknown: 0 }, first: null, stages: null,
      sessions: [session], cloud };
  }
  return { ...local, runs: local.runs + 1, sessions: [session, ...local.sessions], cloud };
}

function localCost(stateDir, ticket) {
  const logs = workerLogs(stateDir, ticket.key, ticket.added_at).sort((a, b) => logRound(a) - logRound(b));
  if (!logs.length) return null;
  const total = { input: 0, output: 0, cost: 0, ms: 0 };
  const preflight = { n: 0, cost: 0, unknown: 0 };
  let runs = 0;
  let unknown = 0;
  let first = 0;
  let stagesKnown = true;
  const stages = new Map();
  const sessions = [];
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
    sessions.push({ starts: spawnStarts(text), cost: u?.cost ?? null });
    if (!u) { unknown += 1; continue; }
    for (const k of Object.keys(total)) total[k] += u[k];
  }
  return {
    key: ticket.key, runs, unknown, usage: unknown ? null : total, preflight,
    first: stagesKnown ? first : null, stages: stagesKnown ? [...stages.values()] : null, sessions,
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
  const NR = 'not reported for cloud';
  // A cloud row with nothing local: nothing in it was reported. One with a local run, or a local
  // preflight alone, shows what was.
  const cloudOnly = (r) => Boolean(r.cloud) && !r.usage && !(r.sessions ?? []).some((x) => !x.cloud);
  const table = rows.map((r) => (cloudOnly(r) ? [r.key, String(r.runs), NR, NR, NR, 'none', r.cloud.ms == null ? 'no PR yet' : wallTime(r.cloud.ms), NR]
    : r.usage ? cells(r, r.usage)
      : [r.key, String(r.runs), 'unknown', 'unknown', 'unknown', preOf(r.preflight), 'unknown', firstOf(r)]));
  const firstKnown = rows.filter((r) => r.first != null);
  table.push(cells({ key: 'total', runs: rows.reduce((n, r) => n + r.runs, 0), first: firstKnown.length ? firstKnown.reduce((n, r) => n + r.first, 0) : null }, sum, pre));
  const head = ['worker', 'runs', 'input tokens', 'output tokens', 'cost', 'preflight', 'wall time', 'first-turn input'];
  const width = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const line = (row) => `  ${row.map((c, i) => (i < 2 ? c.padEnd(width[i]) : c.padStart(width[i]))).join('  ')}`.trimEnd();
  // Each worker's sessions sit under its row, then its stages in the order its runs reached them.
  const startOf = (s) => `start ${s.stage}, model ${s.model}, effort ${s.effort}`;
  const sessionLines = (r) => (r.sessions ?? []).map((s) =>
    `      session: ${s.starts.length ? s.starts.map(startOf).join('; ') : 'start, model and effort not recorded'}: ${s.cloud ? 'cost not reported for cloud' : s.cost == null ? 'cost unknown' : usd(s.cost)}`);
  const stageLines = (r) => {
    const url = r.cloud ? [`      cloud session: ${r.cloud.url ?? 'unknown'}`] : [];
    if (cloudOnly(r)) return url;
    if (!r.stages) return [...url, '      stages: unknown (no usage in the log)'];
    const w = Math.max(...r.stages.map((s) => s.name.length));
    const wi = Math.max(...r.stages.map((s) => tokens(s.input).length));
    return [...url, ...r.stages.map((s) => `      ${s.name.padEnd(w)}  ${tokens(s.input).padStart(wi)} in  ${tokens(s.output)} out`)];
  };
  const out = [`WORKER COST — ${rows.length} worker(s); input counts cache reads and writes, cost is as claude -p reports it and includes the permissions preflights before each spawn, which the preflight column shows apart, wall time is the time inside the worker's turns (a cloud worker's runs from session start to its PR), first-turn input is the prompt each run started on, each session line gives a run's start stage, model, effort (default where none was passed) and cost before its preflight, and each worker's stages list the tokens from one stage marker to the next (${START_UP} is before the first)`, line(head)];
  for (const [i, row] of table.entries()) {
    const r = rows[i];
    out.push(`${line(row)}${r && !r.usage && !cloudOnly(r) ? `   (${r.unknown} of ${r.runs} run(s) with no result event in the log)` : ''}`);
    if (r) out.push(...sessionLines(r), ...stageLines(r));
  }
  const notes = [];
  const cloud = rows.filter(cloudOnly).length;
  const partly = rows.filter((r) => r.cloud && r.usage).length;
  const leftFirst = rows.length - cloud - firstKnown.length;
  if (leftFirst) notes.push(`first-turn input leaves out ${leftFirst} worker(s) with no usage`);
  if (cloud) notes.push(`${cloud} cloud worker(s) not counted: Claude Code does not report a cloud session's tokens or cost`);
  if (partly) notes.push(`${partly} cloud worker(s) counted for their local review runs only, not their cloud session`);
  const left = rows.length - cloud - known.length;
  if (left) notes.push(`${left} unknown worker(s) not counted`);
  if (notes.length) out[out.length - 1] += `   (${notes.join('; ')})`;
  return out.join('\n');
}

// Every queue ticket a worker ran in this batch, local or cloud, in queue order.
export const batchCost = (stateDir, tickets) => tickets.map((t) => ticketCost(stateDir, t)).filter(Boolean);

// This batch's tickets, from queue `q`: its live ones, then those already archived (queue-store.mjs
// archiveDone), whose logs stay in the state directory. A new batch sets the old archive aside, so the
// archive holds only this batch's. A ticket admitted again after it was archived counts from its first
// admission in this batch (`first_added_at`, which archiveDone keeps), so no round of it is lost.
export const batchTickets = (q) => {
  const live = q?.tickets ?? {}, archived = archivedOf(q);
  const first = (t) => [t?.first_added_at, t?.added_at].filter(Boolean).sort()[0];
  const since = (t, a) => { const at = [first(t), first(a)].filter(Boolean).sort()[0]; return at ? { ...t, added_at: at } : t; };
  return [...Object.values(live).map((t) => since(t, Object.hasOwn(archived, t.key) ? archived[t.key] : null)),
    ...Object.entries(archived).filter(([k]) => !Object.hasOwn(live, k)).map(([, t]) => since(t, null))];
};

// `node worker-cost.mjs`: this batch's WORKER COST table, at any time, idle or not.
const isMain = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  try {
    const rows = batchCost(E.stateDir(), batchTickets(readQueue(E.queueFile())));
    console.log(rows.length ? costTable(rows) : 'WORKER COST: no worker has run in this batch');
  } catch (e) {
    console.error(`worker-cost: ${e.message}`);
    process.exit(1);
  }
}
