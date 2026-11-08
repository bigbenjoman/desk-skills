// Bench arm 4: replays a sample of recorded preflight and decider calls on a cheaper model and with no
// model at all, and compares each answer with the one Opus gave.
//
//   node bench-replay.mjs --out <dir> [--state <dir>]… [--days <n>] [--sample <n>] [--model <m>]
//                         [--max-budget-usd <usd>] [--total-budget-usd <usd>] [--seed <s>] [--no-haiku]
//
// The calls come from each batch state folder (--state; by default every batch of this repo, the
// archived ones included): a spawn preflight's record under <state>/preflight/ (preflight-record.mjs)
// and a decider session's prompt and reply under <state>/decider/ (decider.mjs startDecider). A call
// whose files cannot be read is left out and counted as unreadable, and so is each preflight the
// workers' logs show from before preflights were recorded. A call Opus did not answer, or whose answer
// cannot be read line by line, is left out and counted too.
//
// Each side answers what Opus answered: a preflight's verdict per check line, and the decider's
// settled-or-handed per item. The no-model side is a script that answers from the call's recorded
// inputs only what needs no model, and marks the rest "needs a model". The model side (--model,
// haiku by default, at low effort) is sent the same prompt: a preflight in a throwaway checkout with
// the recorded settings, agents and tools, the recorded worktree and canary paths moved into it; a
// decider with no tools, told it is a replay, since its tools would requeue real tickets. Before
// each model replay the account's weekly allowance is read and the arm stops at the bench's cap,
// under the interactive reserve, or on a reading it cannot trust (bench-quota.mjs).
//
// <out>/replay-report.md gives, per call type, each side's share of matching answers, tokens per call
// and quota points, and lists every mismatch for Ben to judge. <out>/replay.json holds every answer.
// Each model replay is kept under <out>/replays/, and a later run with the same --seed reuses it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { USD } from './skill-eval.mjs';
import { logTokens } from './worker-cost.mjs';
import { readLogFile } from './harvest.mjs';
import { armOrder, armEnv } from './bench.mjs';
import { quantile } from './desk-ci.mjs';
import { repoSlug } from './desk-env.mjs';
import { allBatches } from './phase0-report.mjs';
import { presort, readResult } from './decider.mjs';
import { preflightDir, recordFiles } from './preflight-record.mjs';
import { TOOL_LISTS } from './worker-tools.mjs';
import * as Q from './bench-quota.mjs';

const USAGE = 'usage: bench-replay.mjs --out <dir> [--state <dir>]… [--days <n>] [--sample <n>] [--model <m>] [--max-budget-usd <usd>] [--total-budget-usd <usd>] [--seed <s>] [--no-haiku]';
export const NEEDS = 'needs a model';
export const TYPES = ['preflight', 'decider'];
const DAY_MS = 24 * 60 * 60 * 1000;
const REPLAY_TIMEOUT_MS = 5 * 60 * 1000;
export const REPLAY_NOTE = 'This is a replay of a recorded call, with no tools: run nothing, and answer as you would if every command you chose had succeeded.';

// argv -> options. Throws, naming the flag, on anything malformed.
export function parseArgs(argv) {
  const o = { states: [], days: '7', sample: '20', model: 'haiku', budget: '0.5', total: '5', seed: String(Date.now()), haiku: true };
  const names = { '--out': 'out', '--days': 'days', '--sample': 'sample', '--model': 'model', '--max-budget-usd': 'budget', '--total-budget-usd': 'total', '--seed': 'seed' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-haiku') { o.haiku = false; continue; }
    const key = names[argv[i]];
    if (!key && argv[i] !== '--state') throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    if (key) o[key] = argv[++i];
    else o.states.push(resolve(argv[++i]));
  }
  if (!o.out) throw new Error(`--out is required\n${USAGE}`);
  for (const [flag, v] of [['--days', o.days], ['--sample', o.sample]]) {
    if (!/^\d+$/.test(v) || !(Number(v) > 0)) throw new Error(`${flag} must be a positive whole number, not ${v}`);
  }
  for (const [flag, v] of [['--max-budget-usd', o.budget], ['--total-budget-usd', o.total]]) {
    if (!USD.test(v) || !(Number(v) > 0)) throw new Error(`${flag} must be a positive number of USD, not ${v}`);
  }
  if (Number(o.budget) > Number(o.total)) throw new Error(`--total-budget-usd ${o.total} cannot fit one replay at --max-budget-usd ${o.budget}`);
  return { ...o, out: resolve(o.out), days: Number(o.days), sample: Number(o.sample) };
}

const readText = (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } };
const readJson = (f) => { const t = readText(f); try { return t == null ? null : JSON.parse(t); } catch { return null; } };

// The result event of a `claude -p --output-format json` reply, or null.
export function resultOf(text) {
  for (const line of String(text ?? '').trim().split('\n').reverse()) {
    try { const d = JSON.parse(line); if (d?.type === 'result') return d; } catch { /* not JSON */ }
  }
  return null;
}
const onOpus = (r) => Object.keys(r?.modelUsage ?? {}).some((m) => /opus/i.test(m));

// ---- preflight ---------------------------------------------------------------------------------
// The check names a preflight prompt asks for, in order.
export const checkNames = (prompt) => String(prompt).split('\n').map((l) => /^([A-Z][A-Z0-9_]*)=OK or \1=BLOCKED\b/.exec(l)?.[1]).filter(Boolean);

// A reply's verdict per check, the first line naming each, as spawn-worker.sh reads it.
export function verdicts(reply) {
  const v = {};
  for (const l of String(reply ?? '').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(OK|BLOCKED)\b/.exec(l.trim());
    if (m && !(m[1] in v)) v[m[1]] = m[2];
  }
  return v;
}

// One recorded preflight. -> { call } | { left: 'unreadable' | 'not Opus' | 'unanswered' }
export function loadPreflight(dir, base) {
  const f = recordFiles(dir, base);
  const prompt = readText(f.prompt);
  const raw = readText(f.reply);
  const inputs = readJson(f.inputs);
  const settings = readText(f.settings);
  const agents = readText(f.agents);
  const checks = prompt == null ? [] : checkNames(prompt);
  if (prompt == null || raw == null || !inputs?.worktree || !inputs?.canary || settings == null || agents == null || !checks.length) return { left: 'unreadable' };
  const r = resultOf(raw);
  if (!r || typeof r.result !== 'string') return { left: 'unanswered' };
  if (!onOpus(r)) return { left: 'not Opus' };
  const answer = verdicts(r.result);
  if (checks.some((c) => !(c in answer))) return { left: 'unanswered' };
  return { call: { type: 'preflight', id: base, prompt, inputs, settings, agents, checks, opus: Object.fromEntries(checks.map((c) => [c, answer[c]])), tokens: logTokens(raw) } };
}

// The no-model side: what the recorded inputs settle on their own. A check that runs a command under
// the sandbox needs a session to try it, so only those whose answer the inputs fix are answered:
// W_IN, W_OUT and ESCAPE from whether the file each writes was there after the call, AGENTS from the
// agents file and the tool list, JIRA and CODEX where the binary was not installed.
const FILE_CHECKS = { W_IN: 'w_in', W_OUT: 'w_out', ESCAPE: 'escape' };
export function preflightScript(call) {
  const i = call.inputs;
  let agents = null;
  try { agents = JSON.parse(call.agents); } catch { /* left to a model */ }
  const tools = i.tools == null ? null : String(i.tools).split(',').filter(Boolean);
  const out = {};
  for (const c of call.checks) {
    const file = i.files?.[FILE_CHECKS[c]];
    if (typeof file === 'boolean') out[c] = file ? 'OK' : 'BLOCKED';
    else if (c === 'AGENTS' && agents && typeof agents === 'object') {
      out[c] = (tools && !tools.includes('Agent')) || !(i.agent_names ?? []).every((n) => Object.hasOwn(agents, n)) ? 'BLOCKED' : 'OK';
    } else if (c === 'JIRA' && i.gates?.jira === '') out[c] = 'BLOCKED';
    else if (c === 'CODEX' && i.gates?.codex === '') out[c] = 'BLOCKED';
    else out[c] = NEEDS;
  }
  return out;
}

// The preflight's call, moved into a throwaway checkout: the recorded worktree, canary and batch state
// paths in the prompt, settings, agents and added directories become ones under `parent`, so the
// replay is never granted the live batch's state.  -> { prompt, settings, agents, addDirs, wt, canary, state }
export function movePreflight(call, parent) {
  const wt = join(parent, 'checkout');
  const canary = join(parent, 'outside', basename(call.inputs.canary));
  const state = join(parent, 'state');
  const move = (s) => {
    const out = String(s).replaceAll(call.inputs.canary, canary).replaceAll(call.inputs.worktree, wt);
    return call.state ? out.replaceAll(call.state, state) : out;
  };
  return { prompt: move(call.prompt), settings: move(call.settings), agents: move(call.agents), addDirs: (call.inputs.add_dirs ?? []).map(move), wt, canary, state };
}

function replayPreflight(call, o) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'desk-replay-'));
  try {
    const m = movePreflight(call, parent);
    mkdirSync(m.wt, { recursive: true });
    mkdirSync(dirname(m.canary), { recursive: true });
    mkdirSync(m.state, { recursive: true });
    spawnSync('git', ['init', '-q', m.wt], { env: armEnv() });
    const settings = join(parent, 'settings.json');
    const agents = join(parent, 'agents.json');
    writeFileSync(settings, m.settings);
    writeFileSync(agents, m.agents);
    const i = call.inputs;
    const args = ['-p', m.prompt, '--setting-sources', '', '--strict-mcp-config', ...(i.tools == null ? [] : ['--tools', i.tools]),
      '--settings', settings, '--agents', agents, '--permission-mode', 'dontAsk', ...m.addDirs.flatMap((d) => ['--add-dir', d]),
      '--model', o.model, '--effort', 'low', '--max-budget-usd', String(o.budget), '--output-format', 'json'];
    return runReplay(args, m.wt, (reply) => ({ answers: Object.fromEntries(call.checks.map((c) => [c, verdicts(reply)[c] ?? 'no verdict'])) }));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

// ---- decider -----------------------------------------------------------------------------------
// The items a decider prompt lists (deciderPrompt): [{ id, ticket, kind, lane, text, answers, prev }].
export function deciderItems(prompt) {
  const lines = String(prompt).split('\n');
  const from = lines.indexOf('## The items');
  const to = lines.indexOf('## The pass report');
  if (from < 0 || to < from) return null;
  const items = [];
  for (const l of lines.slice(from + 1, to)) {
    const m = /^- id `([^`]+)` · (.*?) · (parked|waiting|batch)(?: · lane ([A-Z]))?: (.*)$/.exec(l);
    if (m) { items.push({ id: m[1], ticket: m[2], kind: m[3], lane: m[4] ?? null, text: m[5], answers: [], prev: null }); continue; }
    const it = items[items.length - 1];
    if (!it) continue;
    const a = /^ {2}- answered (\S+): (.*)$/.exec(l);
    if (a) it.answers.push(a[2]);
    else if (/^ {2}- park \d+; /.test(l)) it.prev = l.trim().slice(2);
    else if (/^ {4}/.test(l) && it.answers.length) it.answers[it.answers.length - 1] += `\n${l.trim()}`;
    else if (l.trim()) it.text += `\n${l.trim()}`;
  }
  return items;
}

// What a decider reply did with each item: settled, or handed (an item it left out is handed on).
const answerOf = (r, items) => Object.fromEntries(items.map((i) => [i.id, r.settled?.[i.id] != null ? 'settled' : 'handed']));
const reasonOf = (r, id) => r.settled?.[id] ?? r.handed?.[id] ?? 'left out';

// One recorded decider session. -> { call } | { left }
export function loadDecider(dir, id) {
  const prompt = readText(join(dir, `${id}.prompt.md`));
  const raw = readText(join(dir, `${id}.json`));
  const items = prompt == null ? null : deciderItems(prompt);
  if (prompt == null || raw == null || !items?.length) return { left: 'unreadable' };
  const r = resultOf(raw);
  if (!r) return { left: 'unanswered' };
  if (!onOpus(r)) return { left: 'not Opus' };
  const got = readResult(join(dir, `${id}.json`));
  if (got.error) return { left: 'unanswered' };
  return { call: { type: 'decider', id, prompt, items, opus: answerOf(got, items), reasons: Object.fromEntries(items.map((i) => [i.id, reasonOf(got, i.id)])), tokens: logTokens(raw) } };
}

// The no-model side: the rules that need no reading of the item's words. No decider tool acts on a
// waiting or batch line, and whatever the decider's own rules hand on without a session (presort) is
// handed on.
export function deciderScript(call) {
  const hand = new Set(presort(call.items).hand.map((h) => h.item.id));
  return Object.fromEntries(call.items.map((i) => [i.id, i.kind !== 'parked' || hand.has(i.id) ? 'handed' : NEEDS]));
}

function replayDecider(call, o) {
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'desk-replay-'));
  try {
    const args = ['-p', `${call.prompt.trimEnd()}\n\n${REPLAY_NOTE}`, '--setting-sources', '', '--strict-mcp-config', '--tools', TOOL_LISTS.none.join(','),
      '--permission-mode', 'dontAsk', '--model', o.model, '--effort', 'low', '--max-budget-usd', String(o.budget), '--output-format', 'json'];
    return runReplay(args, cwd, (_, text) => {
      // Read as the live decider reads its reply (readResult), and as loadDecider reads Opus's.
      const out = join(cwd, 'reply.json');
      writeFileSync(out, text);
      const r = readResult(out);
      if (r.error) return { why: `its reply had ${r.error}` };
      return { answers: answerOf(r, call.items), reasons: Object.fromEntries(call.items.map((i) => [i.id, reasonOf(r, i.id)])) };
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// One model call. `read(reply, text)` -> { answers, reasons? } | { why }.  -> { ok, answers, …, tokens, cost } | { ok: false, why }
function runReplay(args, cwd, read) {
  const p = spawnSync('claude', args, { cwd, env: armEnv(), encoding: 'utf8', timeout: REPLAY_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  const text = String(p.stdout ?? '');
  const r = resultOf(text);
  const cost = typeof r?.total_cost_usd === 'number' ? r.total_cost_usd : null;
  if (p.error) return { ok: false, why: p.error.code === 'ETIMEDOUT' ? 'timed out' : `could not run claude: ${p.error.message}`, cost };
  if (!r || typeof r.result !== 'string' || r.is_error) return { ok: false, why: `claude gave no result${p.status ? ` (exit ${p.status})` : ''}`, cost };
  const got = read(r.result, text);
  if (got.why) return { ok: false, why: got.why, cost, tokens: logTokens(text) };
  return { ok: true, ...got, tokens: logTokens(text), cost };
}

// ---- the sample --------------------------------------------------------------------------------
const SUFFIXES = ['.prompt.md', '.inputs.json', '.settings.json', '.agents.json', '.json'];
const baseOf = (name) => { const s = SUFFIXES.find((x) => name.endsWith(x)); return s ? name.slice(0, -s.length) : null; };
// Each record's base name in `dir` whose newest file is at or after `since`.
function recordsIn(dir, since) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const newest = new Map();
  for (const n of names) {
    const b = baseOf(n);
    if (!b) continue;
    let t = 0;
    try { t = statSync(join(dir, n)).mtimeMs; } catch { continue; }
    newest.set(b, Math.max(newest.get(b) ?? 0, t));
  }
  return [...newest].filter(([, t]) => t >= since).map(([b]) => b).sort();
}

// The preflights a state folder's worker logs show in the window: pass.mjs writes a line for each
// one that made a call.
export function loggedPreflights(state, since) {
  const dir = join(state, 'logs');
  let names = [];
  try { names = readdirSync(dir).filter((n) => /\.log(\.round\d+(\.gz)?)?$/.test(n)); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    let text = '';
    try { text = readLogFile(join(dir, name)); } catch { continue; }
    for (const l of text.split('\n')) {
      if (!l.startsWith('{"type":"desk_preflight"')) continue;
      try { if (Date.parse(JSON.parse(l).at) >= since) n += 1; } catch { /* a torn line */ }
    }
  }
  return n;
}

// Every readable call in the window, and how many of each type were left out and why.
//   -> { calls: { preflight: [call], decider: [call] }, left: { preflight: { why: n }, decider: { why: n } } }
export function collect({ states, since }) {
  const calls = { preflight: [], decider: [] };
  const left = { preflight: {}, decider: {} };
  const leave = (type, why, n = 1) => { if (n > 0) left[type][why] = (left[type][why] ?? 0) + n; };
  for (const state of states) {
    const pdir = preflightDir(state);
    const records = recordsIn(pdir, since);
    for (const base of records) {
      const r = loadPreflight(pdir, base);
      if (r.call) calls.preflight.push({ ...r.call, state }); else leave('preflight', r.left);
    }
    // A preflight from before calls were recorded left only its log line.
    leave('preflight', 'unreadable', loggedPreflights(state, since) - records.length);
    const ddir = join(state, 'decider');
    for (const id of recordsIn(ddir, since)) {
      const r = loadDecider(ddir, id);
      if (r.call) calls.decider.push({ ...r.call, state }); else leave('decider', r.left);
    }
  }
  return { calls, left };
}

// A seeded sample of `n` calls of one type: the same seed and calls give the same sample.
export const sampleOf = (calls, n, seed, type) => armOrder([...calls].sort((a, b) => a.id.localeCompare(b.id)), seed, type).slice(0, n);

// Each answer a side gave against Opus's.  -> [{ key, opus, got, match, needs }]
export function compare(opus, side) {
  return Object.keys(opus).map((key) => {
    const got = side?.[key] ?? 'no answer';
    return { key, opus: opus[key], got, needs: got === NEEDS, match: got === opus[key] };
  });
}

// ---- running the arm ---------------------------------------------------------------------------
export function runReplays(o, log = () => {}) {
  const settings = Q.quotaSettings();
  const ledger = Q.ledgerPath();
  log(Q.settingsLine(settings));
  const states = o.states.length ? o.states : allBatches(repoSlug()).map((b) => b.state);
  const since = Date.now() - o.days * DAY_MS;
  const { calls, left } = collect({ states, since });
  mkdirSync(join(o.out, 'replays'), { recursive: true });
  const total = Number(o.total), budget = Number(o.budget);
  let spent = 0;
  let stopped = null;
  const points = new Map();
  const results = {};
  for (const type of TYPES) {
    results[type] = sampleOf(calls[type], o.sample, o.seed, type).map((call) => {
      const script = type === 'preflight' ? preflightScript(call) : deciderScript(call);
      const entry = { type, id: call.id, state: call.state, opus: call.opus, reasons: call.reasons ?? null, tokens: call.tokens, items: call.items?.map((i) => ({ id: i.id, ticket: i.ticket, kind: i.kind, text: i.text })) ?? null,
        script: compare(call.opus, script), model: null };
      if (!o.haiku) return entry;
      const file = join(o.out, 'replays', `${type}.${call.id}.${o.model}.json`.replace(/[^A-Za-z0-9._-]/g, '-'));
      const prior = readJson(file);
      if (prior?.ok) { log(`reuse ${type} ${call.id}`); entry.model = prior; return entry; }
      if (stopped) { entry.model = { ok: false, notRun: true, why: stopped }; return entry; }
      if (spent + budget > total + 1e-9) { entry.model = { ok: false, notRun: true, why: `$${spent.toFixed(2)} of the $${total} budget spent` }; return entry; }
      const account = Q.accountFor('claude', armEnv());
      const start = Q.startRun({ account, settings, ledger, env: armEnv(), id: `${file}@${new Date().toISOString()}`, fields: { task: call.id, arm: `replay-${type}` } });
      points.set(account.key, start.line);
      if (start.why) {
        stopped = `stopped: ${start.why}`;
        log(`stopped before ${type} ${call.id}: ${start.why}`);
        entry.model = { ok: false, notRun: true, why: stopped };
        return entry;
      }
      log(`replay ${type} ${call.id} on ${o.model}`);
      const r = type === 'preflight' ? replayPreflight(call, o) : replayDecider(call, o);
      spent += r.cost ?? budget;
      const end = Q.endRun({ account, settings, ledger, env: armEnv(), before: start.before, entry: start.entry, label: `${type} ${call.id}` });
      if (end.stop) { stopped = `stopped: ${end.stop}`; log(stopped); } else points.set(account.key, end.line);
      const kept = { ...r, quota: end.quota, compared: r.ok ? compare(call.opus, r.answers) : [] };
      writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
      entry.model = kept;
      return entry;
    });
  }
  const run = { model: o.haiku ? o.model : null, seed: o.seed, days: o.days, sample: o.sample, states, left, found: { preflight: calls.preflight.length, decider: calls.decider.length },
    spent, quota: { cap: settings.cap, reserve: settings.reserve, stopped, accounts: [...points.values()] }, results };
  writeFileSync(join(o.out, 'replay.json'), `${JSON.stringify(run, null, 2)}\n`);
  const text = renderReplayReport(run);
  const path = join(o.out, 'replay-report.md');
  writeFileSync(path, text);
  return { path, text, run };
}

// ---- the report --------------------------------------------------------------------------------
const median = (xs) => quantile(xs, 0.5);
const num = (n) => Math.round(n).toLocaleString('en-US');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const inputOf = (t) => (Number(t.uncached) || 0) + (Number(t.cacheWrite) || 0) + (Number(t.cacheRead) || 0);
const share = (rows) => {
  const asked = rows.filter((r) => !r.needs);
  const hit = asked.filter((r) => r.match).length;
  return asked.length ? `${hit} of ${asked.length} (${Math.round((100 * hit) / asked.length)}%)` : 'none answered';
};
const tokenCell = (list, pick) => { const t = list.filter(Boolean); return t.length ? `${num(median(t.map(pick)))}${t.length < list.length ? ` (over ${t.length} of ${list.length})` : ''}` : 'not recorded'; };
const short = (s, n = 140) => { const x = String(s ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const LEFT = ['unreadable', 'unanswered', 'not Opus'];

// The markdown report of one run. Opus's quota points per call were never recorded, so its column says so.
export function renderReplayReport(run) {
  const model = run.model;
  const out = ['# Bench arm 4: recorded calls replayed', '',
    `${model ? `Model side: ${model} at low effort.` : 'Model side: not run (--no-haiku).'} Sample of up to ${run.sample} call(s) per type from the last ${run.days} day(s) · seed ${run.seed}.`, ''];
  for (const type of TYPES) {
    const rows = run.results[type] ?? [];
    const left = run.left[type] ?? {};
    const what = type === 'preflight' ? 'check line' : 'item';
    out.push(`## ${type}`, '', `${run.found[type]} readable call(s) found, ${rows.length} sampled. Left out: ${LEFT.map((k) => `${left[k] ?? 0} ${k}`).join(', ')}.`, '');
    if (!rows.length) { out.push('No call to compare.', ''); continue; }
    const ran = rows.filter((r) => r.model?.ok);
    const notRun = rows.filter((r) => r.model && !r.model.ok);
    const scriptRows = rows.flatMap((r) => r.script);
    const modelRows = ran.flatMap((r) => r.model.compared);
    const qp = ran.map((r) => r.model.quota?.points).filter((p) => typeof p === 'number');
    out.push(`| Figure | Opus (recorded) | ${model ?? 'model'} | no model |`, '|---|---|---|---|');
    out.push(`| Calls | ${rows.length} | ${model ? `${ran.length} replayed${notRun.length ? `, ${notRun.length} not replayed` : ''}` : 'not run'} | ${rows.length} |`);
    out.push(`| ${what}s matching Opus | — | ${model ? share(modelRows) : 'not run'} | ${share(scriptRows)}; ${scriptRows.filter((r) => r.needs).length} of ${scriptRows.length} ${NEEDS} |`);
    out.push(`| Median input tokens per call, all kinds | ${tokenCell(rows.map((r) => r.tokens), inputOf)} | ${model ? tokenCell(ran.map((r) => r.model.tokens), inputOf) : 'not run'} | 0 |`);
    out.push(`| Median output tokens per call | ${tokenCell(rows.map((r) => r.tokens), (t) => Number(t.output) || 0)} | ${model ? tokenCell(ran.map((r) => r.model.tokens), (t) => Number(t.output) || 0) : 'not run'} | 0 |`);
    out.push(`| Quota points per call (median) | not recorded | ${!model ? 'not run' : qp.length ? `${median(qp)}${qp.length < ran.length ? ` (over ${qp.length} of ${ran.length})` : ''}` : 'unreadable'} | 0 |`);
    out.push(`| Quota points, every replay | not recorded | ${model ? (Math.round(qp.reduce((s, p) => s + p, 0) * 100) / 100) : 'not run'} | 0 |`, '');
    const mism = [];
    const itemOf = (r, key) => r.items?.find((i) => i.id === key);
    const line = (r, x, side, reasons) => {
      const it = itemOf(r, x.key);
      const why = (rs, k) => (rs?.[k] ? ` ("${short(rs[k], 80)}")` : '');
      return `- ${r.id} · ${it ? `${it.ticket} (${it.kind}) \`${x.key}\`: ${short(it.text)}` : x.key}: Opus ${x.opus}${why(r.reasons, x.key)}, ${side} ${x.got}${why(reasons, x.key)}`;
    };
    for (const r of ran) for (const x of r.model.compared) if (!x.match) mism.push(line(r, x, model, r.model.reasons));
    for (const r of rows) for (const x of r.script) if (!x.match && !x.needs) mism.push(line(r, x, 'no model', null));
    out.push(`### Mismatches (${mism.length})`, '', ...(mism.length ? mism : ['None.']), '');
    if (notRun.length) out.push('### Not replayed, or the replay failed', '', ...notRun.map((r) => `- ${r.id}: ${r.model.why}`), '');
  }
  if (run.quota?.accounts?.length) out.push(...run.quota.accounts, '');
  if (run.quota?.stopped) out.push(run.quota.stopped, '');
  out.push('A match is the same verdict for a check line, or the same settled-or-handed for a decider item. A "needs a model" answer counts in no share. Quota points are the rise in the account\'s weekly use during a replay, other work on that account included.');
  return `${out.join('\n')}\n`;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  try {
    const { path, text } = runReplays(parseArgs(process.argv.slice(2)), (m) => console.error(m));
    process.stdout.write(text);
    console.log(`report: ${path}`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
