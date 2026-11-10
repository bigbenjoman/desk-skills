// suite: bench endpoint arm (Claude Code on another provider's Anthropic-compatible endpoint)
// covers: desk/bin/bench-endpoint.mjs desk/bin/endpoint-proxy.mjs desk/bin/bench.mjs
// A stub claude records the environment it was started with and, behind the Go proxy, sends Messages
// requests to its base URL; a stub upstream records what reached it and answers with the hand-written
// Go responses in fixtures/opencode-go-responses.json. No test calls a live endpoint.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { baseUrlProblem, endpointArms, endpointEnv, loginReach, readKey } from '../desk/bin/bench-endpoint.mjs';
import { bodyAllowance, withKey } from '../desk/bin/endpoint-proxy.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const throws = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'bench.mjs');
const fx = JSON.parse(readFileSync(new URL('./fixtures/opencode-go-responses.json', import.meta.url), 'utf8'));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-endpoint-test-')));
let upstream = null;
process.on('exit', () => { try { upstream?.kill('SIGKILL'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
const home = join(dir, 'home');
mkdirSync(home);
const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
for (const k of Object.keys(gitEnv)) if (/^(DESK_|JIRA_|GIT_DIR$|GIT_WORK_TREE$|AUTOPILOT_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|ANTHROPIC_|CLAUDE_CODE_)/.test(k)) delete gitEnv[k];
writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '[user]\n\tname = t\n\temail = t@example.com\n');

const repo = join(dir, 'repo');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { env: gitEnv, encoding: 'utf8' }).trim();
mkdirSync(join(repo, 'tests'), { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: gitEnv });
writeFileSync(join(repo, 'src.txt'), 'the widget counter starts at zero\n');
writeFileSync(join(repo, 'run-tests.sh'), '#!/bin/sh\nfor f in "$@"; do sh "$f" || exit 1; done\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD');
git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');

const configRoot = join(dir, 'config');
mkdirSync(join(configRoot, 'repos', 'acme__widgets'), { recursive: true });
writeFileSync(join(configRoot, 'repos', 'acme__widgets', 'config.md'), `## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`${repo}\` |
| Worktrees directory | \`${join(dir, 'wt')}\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`jira\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Project subagents sync | \`none\` |
| Env files | \`none\` |
| Local database | \`none\` |
| Database URL variable | \`none\` |
| Database migrate | \`none\` |
| Unit tests | \`sh run-tests.sh\` |
`);

const setDir = join(dir, 'set');
mkdirSync(join(setDir, 'hidden', 'tests'), { recursive: true });
writeFileSync(join(setDir, 'hidden', 'tests', 'hidden.sh'), 'grep -q "one hundred" src.txt\n');
const setFile = join(setDir, 'tasks.json');
writeFileSync(setFile, JSON.stringify({ tasks: [{ id: 'fix', repo: 'acme/widgets', base, prompt: 'fix: make the counter start at one hundred. FIX', hidden_tests: { dir: 'hidden', files: ['tests/hidden.sh'] } }] }));

const bin = join(dir, 'bin');
mkdirSync(bin);
// The stub claude: records its environment, sends one JSON and one streamed Messages request and a
// token count through its base URL (the proxy), and one request with a token not its own. Like a model
// that dumps its environment while debugging, it prints that environment into the transcript as a tool
// result and writes it into the checkout.
writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const val = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const e = process.env;
const cfg = e.CLAUDE_CONFIG_DIR;
fs.appendFileSync(e.STUB_LOG, JSON.stringify({ model: val('--model'), base: e.ANTHROPIC_BASE_URL || null, token: e.ANTHROPIC_AUTH_TOKEN || null,
  apiKey: e.ANTHROPIC_API_KEY || null, oauth: e.CLAUDE_CODE_OAUTH_TOKEN || null, config: cfg || null, configEntries: cfg && fs.existsSync(cfg) ? fs.readdirSync(cfg).length : null,
  headers: e.ANTHROPIC_CUSTOM_HEADERS || null, haiku: e.ANTHROPIC_DEFAULT_HAIKU_MODEL || null, subagent: e.CLAUDE_CODE_SUBAGENT_MODEL || null,
  deny: JSON.parse(fs.readFileSync(val('--settings'), 'utf8')).permissions.deny }) + '\\n');
const say = (o) => console.log(JSON.stringify(o));
(async () => {
  const extra = Object.fromEntries((e.ANTHROPIC_CUSTOM_HEADERS || '').split('\\n').filter(Boolean).map((l) => l.split(': ')));
  const post = (path, body, token = e.ANTHROPIC_AUTH_TOKEN) => fetch(e.ANTHROPIC_BASE_URL + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  await post('/v1/messages', { model: val('--model'), stream: false }).then((r) => r.text());
  await post('/v1/messages/count_tokens', { model: val('--model') }).then((r) => r.text());
  await post('/v1/messages?beta=true', { model: val('--model'), stream: true }).then((r) => r.text());
  fs.writeFileSync(e.STUB_LOG + '.other', String((await post('/v1/messages', { model: val('--model') }, 'not-the-run-token')).status));
  say({ type: 'system', subtype: 'init', model: val('--model'), effort: 'medium' });
  say({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: JSON.stringify(e) }] } });
  fs.writeFileSync('env-dump.txt', JSON.stringify(e));
  if (val('-p').includes('FIX')) fs.writeFileSync('src.txt', 'the widget counter starts at one hundred\\n');
  say({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01,
    modelUsage: { m: { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40 } } });
})();
`);
chmodSync(join(bin, 'claude'), 0o755);

// The stub upstream: records each request and answers a JSON Messages request with the good fixture,
// a streamed one with its allowance on the last event, and a token count with no allowance.
const upstreamScript = join(dir, 'upstream.mjs');
writeFileSync(upstreamScript, `import http from 'node:http';
import fs from 'node:fs';
const [portFile, log, good] = process.argv.slice(2);
const body = fs.readFileSync(good, 'utf8');
http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, auth: req.headers.authorization || null, session: req.headers['x-opencode-session'] || null, plan: req.headers['x-plan'] || null, encoding: req.headers['accept-encoding'] || null, body: JSON.parse(b || '{}') }) + '\\n');
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":5}'); return; }
    if (JSON.parse(b).stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_start\\ndata: {"type":"message_start","message":{"id":"m"}}\\n\\nevent: message_delta\\ndata: {"type":"message_delta","usage":{"output_tokens":3},"opencode":{"allowance":0.2}}\\n\\nevent: message_stop\\ndata: {"type":"message_stop"}\\n\\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
}).listen(0, '127.0.0.1', function () { fs.writeFileSync(portFile, String(this.address().port)); });
`);
const goodFile = join(dir, 'good.json');
writeFileSync(goodFile, JSON.stringify(fx.good));
const portFile = join(dir, 'port');
const upstreamLog = join(dir, 'upstream.jsonl');
upstream = spawn(process.execPath, [upstreamScript, portFile, upstreamLog, goodFile], { stdio: 'ignore' });
for (let i = 0; i < 200 && !existsSync(portFile); i++) sleep(25);
const port = readFileSync(portFile, 'utf8').trim();

const KEY = ['sk', 'test', 'endpoint', Math.random().toString(36).slice(2)].join('-');
const keyFile = join(dir, 'keys', 'go.key');
mkdirSync(dirname(keyFile));
writeFileSync(keyFile, `${KEY}\n`);
chmodSync(keyFile, 0o600);
const providersFile = join(dir, 'providers.json');
const GO_BASE = `http://127.0.0.1:${port}/inference/go/anthropic`;
const DIRECT_BASE = `http://127.0.0.1:${port}/kimi/anthropic`;
const providers = (go = {}) => writeFileSync(providersFile, JSON.stringify({ providers: {
  'opencode-go': { base_url: GO_BASE, key_file: 'keys/go.key', session_header: 'x-opencode-session', ...go },
  kimi: { base_url: DIRECT_BASE, key_file: keyFile, headers: { 'x-plan': 'direct' } },
} }));
providers();
const plansFile = join(dir, 'plans.json');
writeFileSync(plansFile, JSON.stringify({ plans: [{ provider: 'OpenCode', plan: 'Go Plus', price: 40, currency: 'USD', read: '2026-11-09', url: 'https://opencode.ai/docs/console/go',
  windows: [{ name: 'monthly', hours: 720, size: 60, unit: 'usd' }], serves: [{ model: 'opencode-go/kimi-k3.1-pro' }] }] }));
const machine = join(dir, 'machine.md');
writeFileSync(machine, '# Machine profile\n\n## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `bench-run-limit-kimi` | `5` | asked |\n');

const stubLog = join(dir, 'claude.jsonl');
const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
mkdirSync(join(dir, 'locks'));
const usage = join(dir, 'usage');
const inherited = join(dir, 'inherited-login');
mkdirSync(inherited);
writeFileSync(join(inherited, '.credentials.json'), '{}');
const run = (args, env = {}) => {
  rmSync(stubLog, { force: true });
  rmSync(upstreamLog, { force: true });
  return spawnSync(process.execPath, [SCRIPT, '--tasks', setFile, '--max-budget-usd', '1', '--seed', '1', '--providers', providersFile, '--plans', plansFile, ...args], { cwd: dir, encoding: 'utf8', env: {
    ...gitEnv, PATH: `${bin}:${process.env.PATH}`, STUB_LOG: stubLog, DESK_CONFIG_ROOT: configRoot, DESK_LOCK_DIR: join(dir, 'locks'), DESK_USAGE_DIR: usage, DESK_MACHINE: machine,
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-inherited', ANTHROPIC_API_KEY: 'api-key-inherited', CLAUDE_CONFIG_DIR: inherited, ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ...env,
  } });
};
const resultOf = (out) => { const d = readdirSync(join(out, 'runs'))[0]; return JSON.parse(readFileSync(join(out, 'runs', d, 'result.json'), 'utf8')); };
const filesUnder = (d) => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? filesUnder(join(d, x.name)) : [join(d, x.name)]));

// AC1 on OpenCode Go: claude behind the proxy, the endpoint reached with the key, model and session.
const goOut = join(dir, 'out-go');
let r = run(['--arm', 'go-kimi=opencode-go/kimi-k3.1-pro', '--out', goOut]);
if (r.status !== 0) console.log(r.stderr);
t('a Go endpoint run completes', r.status, 0);
t('the task is accepted', /fix go-kimi: accepted/.test(r.stdout), true);
let c = lines(stubLog);
t('claude runs once', c.length, 1);
t('AC1 claude is asked for the model after the provider', c[0]?.model, 'kimi-k3.1-pro');
t('AC1 every model alias is that model', `${c[0]?.haiku} ${c[0]?.subagent}`, 'kimi-k3.1-pro kimi-k3.1-pro');
t('AC5 claude holds the run\'s own token, never the key', `${c[0]?.token !== KEY} ${/^desk-endpoint-[0-9a-f]{48}$/.test(c[0]?.token ?? '')}`, 'true true');
t('claude talks to the local proxy', /^http:\/\/127\.0\.0\.1:\d+$/.test(c[0]?.base ?? ''), true);
t('AC5 the arm may not read the key file', c[0]?.deny.some((d) => d === `Read(/${keyFile})`), true);
t('a request without the run\'s token is refused and never sent on', readFileSync(`${stubLog}.other`, 'utf8'), '401');
t('AC3 no inherited OAuth token or API key reaches claude', `${c[0]?.oauth} ${c[0]?.apiKey}`, 'null null');
t('AC3 claude has a fresh empty config folder, not the inherited login', `${c[0]?.config !== inherited} ${c[0]?.configEntries}`, 'true 0');
const up = lines(upstreamLog);
t('AC1 each request reaches the provider base URL', up.map((u) => u.url).join(' '), '/inference/go/anthropic/v1/messages /inference/go/anthropic/v1/messages/count_tokens /inference/go/anthropic/v1/messages?beta=true');
t('AC1 with the key', up.every((u) => u.auth === `Bearer ${KEY}`), true);
t('AC1 with one session id for the whole run', new Set(up.map((u) => u.session)).size === 1 && /^[0-9a-f-]{36}$/.test(up[0]?.session ?? ''), true);
t('the proxy asks for an unencoded body', up.every((u) => u.encoding === 'identity'), true);
let res = resultOf(goOut);
t('AC4 the allowance of each Messages response, the token count left out', JSON.stringify(res.opencode_allowance), '[0.3,0.2]');
t('AC4 its quota is the Go model\'s own allowance', `${res.quota.account} ${res.quota.allowance}`, 'OpenCode Go model opencode-go/kimi-k3.1-pro 0.5');
t('AC4 tokens come from the session\'s log', JSON.stringify(res.tokens), '{"uncached":10,"cacheWrite":30,"cacheRead":40,"output":20}');
t('AC4 claude\'s USD figure is kept apart and costs nothing', `${res.cost} ${res.claude_priced_usd}`, 'null 0.01');
t('AC4 nothing is spent of --total-budget-usd', JSON.parse(readFileSync(join(goOut, 'run.json'), 'utf8')).spent, 0);
t('the result names the runner and provider', `${res.runner} ${res.provider}`, 'endpoint opencode-go');
t('the model ran at is the one asked for', res.ran_at.model, 'kimi-k3.1-pro');
t('AC5 the key is in no file under the output folder', filesUnder(goOut).filter((f) => readFileSync(f, 'utf8').includes(KEY)).join(' '), '');
t('AC5 nor in the ledger', readFileSync(join(usage, 'bench-quota.jsonl'), 'utf8').includes(KEY), false);

// AC1 on a direct provider: claude behind the proxy too, with the provider's headers.
const directOut = join(dir, 'out-direct');
r = run(['--arm', 'kimi=kimi/kimi-k3.1-pro', '--out', directOut]);
if (r.status !== 0) console.log(r.stderr);
c = lines(stubLog);
t('a direct endpoint run completes', `${r.status} ${c.length}`, '0 1');
t('AC1 with its headers', c[0]?.headers, 'x-plan: direct');
const direct = lines(upstreamLog);
t('AC1 a direct provider\'s requests reach its base URL with the key and its headers', direct.every((u) => u.url.startsWith('/kimi/anthropic/v1/messages') && u.auth === `Bearer ${KEY}` && u.plan === 'direct' && u.session === null) && direct.length === 3, true);
t('AC5 the direct run\'s claude never holds the key', c[0]?.token === KEY, false);
res = resultOf(directOut);
t('a direct provider records no Go allowance', 'opencode_allowance' in res, false);
t('AC5 the key is in no file under the direct run', filesUnder(directOut).some((f) => readFileSync(f, 'utf8').includes(KEY)), false);

// AC2: the key file, refused before claude starts or any ledger line is written.
const ledgerBefore = readFileSync(join(usage, 'bench-quota.jsonl'), 'utf8');
const refusedRun = (label, setup, want) => {
  setup();
  const rr = run(['--arm', 'go-kimi=opencode-go/kimi-k3.1-pro', '--out', join(dir, `out-${label}`)]);
  t(`${label}: refused before anything ran`, `${rr.status} ${lines(stubLog).length} ${readFileSync(join(usage, 'bench-quota.jsonl'), 'utf8') === ledgerBefore}`, '2 0 true');
  t(`${label}: it names the file and the fix`, want.test(rr.stderr), true);
  if (!want.test(rr.stderr)) console.log(rr.stderr);
};
refusedRun('AC2 a key readable by others', () => chmodSync(keyFile, 0o644), new RegExp(`the key file ${keyFile} is open to group or others \\(mode 644\\): chmod 600 ${keyFile}`));
refusedRun('AC2 a key readable by the group', () => chmodSync(keyFile, 0o640), /mode 640\): chmod 600/);
refusedRun('AC2 an empty key', () => { writeFileSync(keyFile, '\n'); chmodSync(keyFile, 0o600); }, new RegExp(`the key file ${keyFile} is empty: .*chmod 600`));
refusedRun('AC2 a missing key', () => rmSync(keyFile), new RegExp(`the key file ${keyFile} does not exist: .*chmod 600`));
writeFileSync(keyFile, `${KEY}\n`);
chmodSync(keyFile, 0o600);
// AC3: a base URL that would reach Anthropic, refused the same way.
refusedRun('AC3 no base URL', () => providers({ base_url: '' }), /no base URL is set, so claude would call Anthropic/);
refusedRun('AC3 an Anthropic base URL', () => providers({ base_url: 'https://api.anthropic.com' }), /its base URL https:\/\/api\.anthropic\.com is Anthropic's/);
providers();
refusedRun('a provider with no entry', () => writeFileSync(providersFile, JSON.stringify({ providers: {} })), /arm go-kimi is on opencode-go, and the providers file .* has no entry for it/);
providers();

// The checks on their own.
t('AC2 a key file open to its owner only is read', readKey(keyFile).key, KEY);
t('AC3 a base URL on a subdomain of anthropic.com', /is Anthropic's/.test(baseUrlProblem('https://x.anthropic.com/v1')), true);
t('AC3 an Anthropic host written with a trailing dot', /is Anthropic's/.test(baseUrlProblem('https://api.anthropic.com./v1')), true);
t('AC3 plain http to another host', baseUrlProblem('http://example.test'), 'its base URL http://example.test is not https');
t('an https base URL elsewhere is taken', baseUrlProblem('https://opencode.ai/inference/go/anthropic'), null);
const fresh = join(dir, 'fresh');
mkdirSync(fresh);
const ep = { provider: 'opencode-go', model: 'glm-5.3', baseUrl: 'https://opencode.ai/inference/go/anthropic', headers: { 'x-a': 'b' }, sessionHeader: 'x-opencode-session' };
const env = endpointEnv({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'o', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CONFIG_DIR: inherited, CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'opus' }, ep, fresh, 'sess');
t('the run\'s environment drops every inherited Claude credential, token and model', ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_MODEL'].filter((k) => k in env).join(' '), '');
t('and carries the endpoint, headers and session', `${env.ANTHROPIC_BASE_URL} ${JSON.stringify(env.ANTHROPIC_CUSTOM_HEADERS)} ${env.CLAUDE_CONFIG_DIR === fresh}`,
  'https://opencode.ai/inference/go/anthropic "x-a: b\\nx-opencode-session: sess" true');
t('a clean environment reaches no login', loginReach(env), null);
t('AC3 an OAuth token is named', loginReach({ ...env, CLAUDE_CODE_OAUTH_TOKEN: 'o' }), 'a Claude OAuth token is set (CLAUDE_CODE_OAUTH_TOKEN)');
t('AC3 an API key is named', loginReach({ ...env, ANTHROPIC_API_KEY: 'k' }), 'an Anthropic API key is set (ANTHROPIC_API_KEY)');
t('AC3 an inherited login folder is named', loginReach({ ...env, CLAUDE_CONFIG_DIR: inherited }), `CLAUDE_CONFIG_DIR ${inherited} is not a fresh empty folder, so it could hold a Claude login`);
t('AC3 no config folder at all', /would read the default Claude login/.test(loginReach({ ...env, CLAUDE_CONFIG_DIR: '' })), true);
t('AC3 an Anthropic base URL', /is Anthropic's/.test(loginReach({ ...env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })), true);
t('an arm with a runner of its own is left alone', endpointArms([{ name: 'x', model: 'opencode-go/m', runner: () => ({}) }], join(dir, 'none.json'))[0].endpoint, undefined);
t('a Claude arm needs no providers file', endpointArms([{ name: 'o', model: 'opus' }], join(dir, 'none.json'))[0].runner, undefined);
t('an endpoint arm with no providers file is refused, naming it', /there is no providers file at .*none\.json/.test(throws(() => endpointArms([{ name: 'g', model: 'opencode-go/m' }], join(dir, 'none.json')))), true);
t('a relative key file is read beside the providers file', endpointArms([{ name: 'g', model: 'opencode-go/kimi-k3.1-pro' }], providersFile)[0].endpoint.keyFile, keyFile);
t('the key file keeps its mode', (statSync(keyFile).mode & 0o777).toString(8), '600');

// The proxy's key swap.
t('a bearer token of the run\'s is swapped for the key', withKey({ authorization: 'Bearer tok', 'x-b': '1' }, 'tok', 'K').authorization, 'Bearer K');
t('so is an x-api-key one', withKey({ 'x-api-key': 'tok' }, 'tok', 'K')['x-api-key'], 'K');
t('any other token is not', `${withKey({ authorization: 'Bearer nope' }, 'tok', 'K')} ${withKey({}, 'tok', 'K')}`, 'null null');

// The proxy's reader.
t('a JSON body\'s allowance', bodyAllowance(JSON.stringify(fx.good), 'application/json'), 0.3);
t('a JSON body with none', bodyAllowance(JSON.stringify(fx.missing), 'application/json'), undefined);
t('an unknown shape is passed on for the guard to refuse', JSON.stringify(bodyAllowance(JSON.stringify(fx.unknownShape), 'application/json')), '{"usd":0.3}');
t('a stream\'s last allowance', bodyAllowance('data: {"type":"message_start","message":{"opencode":{"allowance":0.1}}}\n\ndata: {"type":"message_delta","opencode":{"allowance":0.4}}\n', 'text/event-stream'), 0.4);
t('a stream with none', bodyAllowance('data: {"type":"message_stop"}\n', 'text/event-stream; charset=utf-8'), undefined);

console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
