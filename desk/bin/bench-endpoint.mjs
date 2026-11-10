// An endpoint arm: Claude Code itself against another provider's Anthropic-compatible endpoint, so the
// task, the brief, the sandbox and the scoring are the Claude arms' and only the model differs.
//
// An arm `<name>=<provider>/<model>` (e.g. `go-kimi=opencode-go/kimi-k3.1-pro`) on a provider with
// no meter of its own runs this way when the providers file has an entry for that provider. The file
// is JSON, by default bench-providers.json in the desk usage dir beside bench-quota.jsonl (`--providers`
// names another):
//   {"providers": {"opencode-go": {"base_url": "https://opencode.ai/inference/go/anthropic",
//                                  "key_file": "~/.config/desk/opencode-go.key",
//                                  "headers": {"<name>": "<value>"}, "session_header": "x-opencode-session"}}}
// A relative key_file is relative to the providers file. `session_header`, when set, is sent with one
// new id per run. Claude runs with that base URL and key and the model after the slash, and never with a
// Claude login: every credential and setting that could reach one is dropped from its environment and
// CLAUDE_CONFIG_DIR is a fresh empty folder, which is checked again just before claude starts.
//
// Every arm's entry and key file are checked before the bench starts any run: a key file must exist,
// hold the key and be open to its owner only (chmod 600). The key goes to claude in its environment
// and is never written to a file.
//
// The run's USD figure is claude's own pricing at Anthropic's rates, which do not apply: it is kept as
// `claude_priced_usd` and its `cost` is null, so it spends nothing of --total-budget-usd (bench.mjs
// counts only Claude arms' cost there). Its allowance is the provider's (bench-quota.mjs). On OpenCode
// Go, claude runs behind endpoint-proxy.mjs, which records each response's opencode.allowance for the
// result's `opencode_allowance`.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armEnv, runClaude } from './bench.mjs';
import { GO, armVendor, metered } from './bench-quota.mjs';
import { expandHome } from './desk-env.mjs';
import { usageDir } from './usage-probe.mjs';

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
export const providersPath = (dir = usageDir()) => join(dir, 'bench-providers.json');

// What would send claude to a Claude login, or a model or endpoint other than the arm's.
const CLAUDE_REACH = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$|CLAUDE_CONFIG_DIR$)/;
const ANTHROPIC_HOST = /(^|\.)(anthropic\.com|claude\.ai|claude\.com)$/i;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

// Why a base URL may not be an endpoint arm's, or null.
export function baseUrlProblem(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return 'no base URL is set, so claude would call Anthropic';
  let u;
  try { u = new URL(raw); } catch { return `its base URL ${raw} is not a URL`; }
  if (ANTHROPIC_HOST.test(u.hostname)) return `its base URL ${raw} is Anthropic's, so the run would bill a Claude account`;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOST.test(u.hostname))) return `its base URL ${raw} is not https`;
  return null;
}

// The provider's key from its key file.  -> { key } | { why }, naming the file and the fix
export function readKey(file) {
  const fix = `chmod 600 ${file}`;
  if (!existsSync(file)) return { why: `the key file ${file} does not exist: write the provider's key into it, then ${fix}` };
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) return { why: `the key file ${file} is open to group or others (mode ${mode.toString(8)}): ${fix}` };
  const key = readFileSync(file, 'utf8').trim();
  if (!key) return { why: `the key file ${file} is empty: write the provider's key into it, then ${fix}` };
  return { key };
}

// claude's environment for one run: `env` without anything that reaches a Claude login, on a fresh
// config folder, with the endpoint, key and model, and the provider's headers.
export function endpointEnv(env, ep, key, configDir, session = randomUUID()) {
  const kept = Object.fromEntries(Object.entries(env).filter(([k]) => !CLAUDE_REACH.test(k)));
  const headers = { ...ep.headers, ...(ep.sessionHeader ? { [ep.sessionHeader]: session } : {}) };
  const m = ep.model;
  return { ...kept, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: ep.baseUrl, ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m, ANTHROPIC_DEFAULT_SONNET_MODEL: m, ANTHROPIC_DEFAULT_HAIKU_MODEL: m, ANTHROPIC_SMALL_FAST_MODEL: m,
    CLAUDE_CODE_SUBAGENT_MODEL: m, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(Object.keys(headers).length ? { ANTHROPIC_CUSTOM_HEADERS: Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') } : {}) };
}

// Why an environment could still reach a Claude login, or null.
export function loginReach(env) {
  const base = baseUrlProblem(env.ANTHROPIC_BASE_URL);
  if (base) return base;
  for (const [k, what] of [['CLAUDE_CODE_OAUTH_TOKEN', 'a Claude OAuth token'], ['ANTHROPIC_API_KEY', 'an Anthropic API key'],
    ['CLAUDE_CODE_USE_BEDROCK', 'Bedrock'], ['CLAUDE_CODE_USE_VERTEX', 'Vertex'], ['CLAUDE_CODE_USE_FOUNDRY', 'Foundry']]) {
    if (env[k]) return `${what} is set (${k})`;
  }
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir) return 'CLAUDE_CONFIG_DIR is not set, so claude would read the default Claude login';
  let entries;
  try { entries = readdirSync(dir); } catch { return `CLAUDE_CONFIG_DIR ${dir} cannot be read`; }
  if (entries.length) return `CLAUDE_CONFIG_DIR ${dir} is not a fresh empty folder, so it could hold a Claude login`;
  return null;
}

// The providers file.  -> { [provider]: entry }. Throws, naming the file, when it cannot be read.
export function loadProviders(path) {
  if (!existsSync(path)) throw new Error(`there is no providers file at ${path}`);
  let t;
  try { t = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { throw new Error(`cannot read the providers file ${path}: ${e.message}`); }
  if (!t?.providers || typeof t.providers !== 'object' || Array.isArray(t.providers)) throw new Error(`the providers file ${path} has no providers object`);
  return t.providers;
}

// One provider entry, checked.  -> { endpoint } | { why }
function endpointOf(entry, provider, model, path) {
  const where = `the providers file's ${provider} entry`;
  const base = baseUrlProblem(entry?.base_url);
  if (base) return { why: `${where}: ${base}` };
  if (typeof entry.key_file !== 'string' || !entry.key_file.trim()) return { why: `${where} names no key_file` };
  const headers = entry.headers ?? {};
  if (typeof headers !== 'object' || Array.isArray(headers)) return { why: `${where}: headers must be an object of name to value` };
  for (const [k, v] of Object.entries(headers)) {
    if (!HEADER_NAME.test(k) || typeof v !== 'string' || /[\r\n]/.test(v)) return { why: `${where}: header ${JSON.stringify(k)} must be a name of letters, digits or - with a one-line string value` };
  }
  const sessionHeader = entry.session_header ?? null;
  if (sessionHeader !== null && (typeof sessionHeader !== 'string' || !HEADER_NAME.test(sessionHeader))) return { why: `${where}: session_header must be a header name` };
  const keyFile = resolve(dirname(path), expandHome(entry.key_file));
  const key = readKey(keyFile);
  if (key.why) return { why: key.why };
  return { endpoint: { provider, model, baseUrl: entry.base_url, keyFile, headers, sessionHeader } };
}

// The arms, each one on an unmetered `<provider>/<model>` with no runner of its own made an endpoint
// arm from the providers file. Throws, before any run, on any such arm that cannot run.
export function endpointArms(arms, path = providersPath()) {
  let providers = null;
  return arms.map((arm) => {
    const provider = armVendor(arm);
    if (arm.runner || metered(provider)) return arm;
    const refuse = (why) => new Error(`refusing to start: arm ${arm.name} is on ${provider}, and ${why}`);
    try { providers ??= loadProviders(path); } catch (e) { throw refuse(e.message); }
    if (!Object.hasOwn(providers, provider)) throw refuse(`the providers file ${path} has no entry for it`);
    const e = endpointOf(providers[provider], provider, arm.model.slice(arm.model.indexOf('/') + 1), path);
    if (e.why) throw refuse(e.why);
    return { ...arm, runner: runEndpoint, endpoint: e.endpoint };
  });
}

function readAllowance(file) {
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}

// One run on the arm's endpoint. -> bench.mjs's runner result.
export function runEndpoint(task, arm, wt, settings, opts, dir, { env = armEnv() } = {}) {
  const ep = arm.endpoint;
  const refuse = (why) => {
    const w = `refusing the endpoint arm ${arm.name}: ${why}`;
    return { ok: false, why: w, cost: null, tokens: null, attempts: [], ranAt: null, stopArm: w };
  };
  const k = readKey(ep.keyFile);
  if (k.why) return refuse(k.why);
  const home = join(dirname(wt), 'endpoint');
  const configDir = join(home, 'claude-config');
  mkdirSync(configDir, { recursive: true });
  const e = endpointEnv(env, ep, k.key, configDir);
  const reach = loginReach(e);
  if (reach) return refuse(reach);
  const go = ep.provider === GO;
  const allowance = join(home, 'allowance.json');
  const wrap = go ? { command: [process.execPath, join(HERE, 'endpoint-proxy.mjs'), allowance, 'claude'], killSignal: 'SIGTERM' } : {};
  const run = runClaude(task, { ...arm, model: ep.model }, wt, settings, opts, dir, { env: e, ...wrap });
  return { ...run, cost: null, extra: { runner: 'endpoint', provider: ep.provider, claude_priced_usd: run.cost ?? null, ...(go ? { opencode_allowance: readAllowance(allowance) } : {}) } };
}
