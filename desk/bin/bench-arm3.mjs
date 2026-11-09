// Arm 3: every frozen task on four implementers, scored the same way: Codex Sol at medium and at high
// effort, Opus at medium, and Sonnet at the CLI's default effort.
//
//   node bench-arm3.mjs --tasks <file.json> --max-budget-usd <usd> [--total-budget-usd <usd>]
//                       [--out <dir>] [--timeout <seconds>] [--seed <n>] [--fable]
//
// --fable adds a fifth side on Fable. It is refused before any run unless every Claude account desk
// signs in with reads usage credits off (bench-credits.mjs), checked again before each Fable run. A
// Fable run whose log records a request using overage is ended, and no further Fable run starts.
//
// The Claude sides run as every bench arm does (bench.mjs). A Codex side runs through codex-exec.mjs,
// as desk-codex's calls do: stdin closed, its final message captured to last-message.txt in the run's
// folder, ended with its process group at --timeout, and the model and effort on the command line. Its
// sandbox is workspace-write with the task's throwaway checkout as the workspace, no network, and
// neither /tmp nor $TMPDIR writable, so it can write only inside that checkout. It runs on the Codex
// login bench.mjs's quota guard reads before and after it, whose weekly rise is its quota points.
// Its tokens come from its own session log (the rollout under that login's sessions folder whose
// session_meta names the checkout), copied to codex-session.jsonl. Any tool call the sandbox refused is
// listed in result.json's `refusals`; the run is still scored on its hidden tests.
import { readFileSync, copyFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armEnv, parseArgs as benchArgs, printBench, promptFor, runBench, runClaude } from './bench.mjs';
import { execArgs, KILL_GRACE_MS } from './codex-exec.mjs';
import { accountFor } from './bench-quota.mjs';
import { fableEnv, fableRefusal, usingOverage } from './bench-credits.mjs';
import { rolloutLogs } from './codex-usage.mjs';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
export const CODEX_MODEL = 'gpt-6.1-sol';
// Only the checkout is writable: no network, and neither temporary folder codex adds by default.
export const SANDBOX_CONFIG = Object.freeze(['sandbox_workspace_write.network_access=false',
  'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true', 'approval_policy="never"']);

// One Codex side: codex in its sandbox in the checkout, workspace-write unless the arm names its own
// `sandbox` and `config`. -> bench.mjs's runner result.
export function runCodex(task, arm, wt, _settings, opts, dir, { env = armEnv(), now = Date.now } = {}) {
  const last = join(dir, 'last-message.txt');
  const call = { args: execArgs({ sandbox: arm.sandbox ?? 'workspace-write', cd: wt, model: arm.model, effort: arm.effort, last, prompt: promptFor(task, arm), config: arm.config ?? SANDBOX_CONFIG }),
    last, cwd: wt, timeout: opts.timeout };
  const started = now();
  // The bridge ends codex at the timeout itself; this ceiling only catches a bridge that never returns.
  const r = spawnSync(process.execPath, [join(HERE, 'codex-exec.mjs')], { input: JSON.stringify(call), env, encoding: 'utf8',
    timeout: (opts.timeout + 60) * 1000 + KILL_GRACE_MS, killSignal: 'SIGTERM' });
  let res;
  try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { res = { code: r.status ?? 1, timedOut: false, message: '', tail: r.stderr ?? '', error: r.error?.message ?? `codex-exec printed no result: ${(r.stderr || '').trim()}` }; }
  const log = sessionLog(accountFor('codex', env).login.dir, wt, started);
  let text = '';
  if (log) { copyFileSync(log, join(dir, 'codex-session.jsonl')); text = readFileSync(log, 'utf8'); }
  const ran = log ? codexRanAt(text) : { model: null, effort: null, why: 'no Codex session log names the run\'s checkout' };
  return { ...codexVerdict(res, opts.timeout), cost: null, tokens: log ? codexTokens(text) : null, attempts: [], ranAt: ran,
    extra: { runner: 'codex', refusals: log ? sandboxRefusals(text) : [], session_log: log } };
}

// codex-exec's result -> { ok, why }.
export function codexVerdict({ code, timedOut, message, tail, error }, timeout) {
  if (error) return { ok: false, why: `could not run codex: ${error}` };
  if (timedOut) return { ok: false, why: `timed out after ${timeout}s` };
  if (code !== 0) return { ok: false, why: `codex exited ${code}: ${String(tail ?? '').trim().split('\n').slice(-3).join(' | ') || 'no error text'}` };
  if (!String(message ?? '').trim()) return { ok: false, why: 'codex wrote no final message' };
  return { ok: true, why: null };
}

const events = (text) => String(text).split('\n').flatMap((l) => { try { const e = JSON.parse(l); return e && typeof e === 'object' ? [e] : []; } catch { return []; } });
const same = (a, b) => { if (a === b) return true; try { return realpathSync(a) === realpathSync(b); } catch { return false; } };

// The rollout under `codexDir`/sessions, written since `since` (ms), whose session_meta cwd is `wt`.
export function sessionLog(codexDir, wt, since) {
  const hits = [];
  // A run's own log is still plain: Codex compresses only older ones.
  for (const { path: p, st } of rolloutLogs(codexDir) ?? []) {
    if (p.endsWith('.zst') || st.mtimeMs < since - 1000) continue;
    let first;
    try { first = JSON.parse(readFileSync(p, 'utf8').split('\n', 1)[0]); } catch { continue; }
    if (first?.type === 'session_meta' && typeof first.payload?.cwd === 'string' && same(first.payload.cwd, wt)) hits.push({ p, at: st.mtimeMs });
  }
  return hits.sort((a, b) => b.at - a.at)[0]?.p ?? null;
}

// The session's tokens by kind from its last token_count event's running total, in the shape the
// Claude runs record: input_tokens includes the cached input, so uncached is the rest.
export function codexTokens(text) {
  let total = null;
  for (const e of events(text)) if (e.payload?.type === 'token_count' && e.payload.info?.total_token_usage) total = e.payload.info.total_token_usage;
  if (!total) return null;
  const n = (v) => Number(v) || 0;
  return { uncached: Math.max(0, n(total.input_tokens) - n(total.cached_input_tokens)), cacheWrite: 0, cacheRead: n(total.cached_input_tokens),
    output: n(total.output_tokens), reasoning: n(total.reasoning_output_tokens) };
}

// The model and effort the session's own log says it ran at (its first turn_context).
export function codexRanAt(text) {
  const tc = events(text).find((e) => e.type === 'turn_context')?.payload;
  const named = (v) => (typeof v === 'string' && v ? v : null);
  const model = named(tc?.model), effort = named(tc?.effort ?? tc?.reasoning_effort);
  const missing = [!model && 'model', !effort && 'effort'].filter(Boolean);
  return { model, effort, why: !tc ? 'the session\'s log has no turn_context event' : missing.length ? `the session's log names no ${missing.join(' or ')}` : null };
}

const REFUSED = /operation not permitted|read-only file system|permission denied|sandbox(ed)? (denied|error|violation)|writing outside of the project|rejected by (user|the) approval/i;
const TOOL_OUT = /_output$|^exec_command_end$|^patch_apply_end$/;
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);

// Every tool call whose output says the sandbox refused it. -> [{ call, output }], `call` the command or
// patch that was refused where the log names it, `output` the first line saying so.
export function sandboxRefusals(text) {
  const calls = new Map();
  const out = [];
  const seen = new Set();
  for (const e of events(text)) {
    const p = e.payload;
    if (!p || typeof p.type !== 'string') continue;
    if (p.call_id && /call$/.test(p.type)) calls.set(p.call_id, String(p.arguments ?? p.input ?? ''));
    if (!TOOL_OUT.test(p.type)) continue;
    // A shell call's output is often its own JSON ({ output, metadata }) in a string.
    let body = p.output ?? p;
    if (typeof body === 'string' && body.trimStart().startsWith('{')) { try { body = JSON.parse(body); } catch { /* plain text */ } }
    const line = strings(body).flatMap((s) => s.split('\n')).find((l) => REFUSED.test(l));
    if (!line) continue;
    const key = p.call_id ?? `${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ call: (calls.get(p.call_id) ?? strings(p.command).join(' ')) || null, output: line.trim().slice(0, 300) });
  }
  return out;
}

export const ARMS = Object.freeze([
  { name: 'codex-medium', model: CODEX_MODEL, effort: 'medium', runner: runCodex },
  { name: 'codex-high', model: CODEX_MODEL, effort: 'high', runner: runCodex },
  { name: 'opus-medium', model: 'opus', effort: 'medium' },
  { name: 'sonnet', model: 'sonnet', effort: null },
]);

// The Fable side: a Claude run while usage credits read off, watched for a request that uses them.
export function runFable(task, arm, wt, settings, opts, dir, { env = armEnv() } = {}) {
  const refused = fableRefusal({ env });
  if (refused) return { ok: false, why: refused, cost: 0, tokens: null, attempts: [], ranAt: null, stopArm: refused };
  const run = runClaude(task, arm, wt, settings, opts, dir, { command: [process.execPath, join(HERE, 'overage-watch.mjs'), 'claude'], killSignal: 'SIGTERM', env: fableEnv(env) });
  if (!usingOverage(readFileSync(join(dir, 'transcript.jsonl'), 'utf8'))) return run;
  const why = `task ${task.id} on ${accountFor('claude', env).name} recorded a request using overage, so the run was ended`;
  return { ...run, ok: false, why, stopArm: why };
}

export const FABLE_ARM = Object.freeze({ name: 'fable', model: 'claude-fable-5-1', effort: null, runner: runFable, env: fableEnv });

const spec = (a) => `${a.name}=${a.model}${a.effort ? `:${a.effort}` : ''}`;

// argv -> bench.mjs's options with arm 3's sides, Fable among them only with --fable. An --arm of its
// own is refused.
export function parseArgs(argv) {
  if (argv.includes('--arm')) throw new Error(`bench-arm3.mjs sets its own arms: ${ARMS.map(spec).join(', ')}`);
  const fable = argv.includes('--fable');
  const sides = fable ? [...ARMS, FABLE_ARM] : ARMS;
  const o = benchArgs([...argv.filter((a) => a !== '--fable'), ...sides.flatMap((a) => ['--arm', spec(a)])]);
  return { ...o, fable, arms: sides.map((a) => ({ ...a })) };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const refused = opts.fable ? fableRefusal({ env: armEnv() }) : null;
    if (refused) throw new Error(`${refused}. Nothing ran. Without --fable the other four sides run.`);
    printBench(runBench(opts, (m) => console.error(m)));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
