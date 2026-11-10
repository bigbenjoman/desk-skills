// Runs claude behind a local forwarding proxy that alone holds the provider's key, and on OpenCode Go
// records what each Messages response counted against its allowance:
//   node endpoint-proxy.mjs <key file> <allowance file | -> <command> [args...]
// The command and every process it starts (the tools the model under test runs) never see the key:
// they get this proxy's address as ANTHROPIC_BASE_URL and a token made for this run only as
// ANTHROPIC_AUTH_TOKEN. A request carrying that token is sent on to the upstream (the ANTHROPIC_BASE_URL
// the proxy is started with) with the key in its place; any other is answered 401 and never sent.
// Requests and responses pass through otherwise unchanged apart from the host and the encoding asked
// for (identity, so the body can be read). Claude Code keeps no field of a response it does not know,
// and Go reports a request's allowance only in its response, so with an allowance file, after each 2xx
// POST to /v1/messages, the file is rewritten as a JSON list, one value per response in order: its
// `opencode.allowance`, or null where it carries none. Nothing about a request (its headers, its key)
// is written anywhere. Sent SIGTERM (the caller's timeout), it ends the command's process group too.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

// The allowance a response body reports: a JSON body's own `opencode`, or in a stream the last event
// carrying one, on the event or on its message. undefined where none does.
const own = (d) => (d && typeof d === 'object' ? (d.opencode ?? d.message?.opencode)?.allowance : undefined);
export function bodyAllowance(text, contentType = '') {
  if (!/event-stream/i.test(contentType)) {
    try { return own(JSON.parse(text)); } catch { return undefined; }
  }
  let found;
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { const a = own(JSON.parse(line.slice(5))); if (a !== undefined) found = a; } catch { /* not JSON */ }
  }
  return found;
}

const isMessages = (req) => req.method === 'POST' && /\/v1\/messages$/.test(new URL(req.url, 'http://x').pathname);

// The request's headers with the run's token swapped for the key, or null when it does not carry the token.
const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function withKey(headers, token, key) {
  const h = { ...headers };
  if (same(h.authorization, `Bearer ${token}`)) h.authorization = `Bearer ${key}`;
  else if (same(h['x-api-key'], token)) h['x-api-key'] = key;
  else return null;
  return h;
}

function main([keyFile, file, command, ...args]) {
  const upstream = new URL(process.env.ANTHROPIC_BASE_URL);
  const base = upstream.pathname.replace(/\/$/, '');
  const key = readFileSync(keyFile, 'utf8').trim();
  const token = `desk-endpoint-${randomBytes(24).toString('hex')}`;
  const values = [];
  const save = () => { if (file !== '-') writeFileSync(file, `${JSON.stringify(values)}\n`); };
  save();
  const server = http.createServer((req, res) => {
    const keyed = withKey(req.headers, token, key);
    if (!keyed) {
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'the endpoint proxy takes only its own run\'s token' } }));
      return;
    }
    const headers = { ...keyed, host: upstream.host, 'accept-encoding': 'identity' };
    delete headers.connection;
    const send = (upstream.protocol === 'https:' ? https : http).request(
      { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: req.method, path: base + req.url, headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        const chunks = [];
        up.on('data', (c) => { chunks.push(c); res.write(c); });
        up.on('end', () => {
          res.end();
          if (!isMessages(req) || up.statusCode < 200 || up.statusCode >= 300) return;
          values.push(bodyAllowance(Buffer.concat(chunks).toString('utf8'), up.headers['content-type']) ?? null);
          save();
        });
      });
    send.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: `the endpoint proxy could not reach ${upstream.origin}: ${e.code ?? e.message}` } }));
    });
    req.pipe(send);
  });
  server.listen(0, '127.0.0.1', () => {
    const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_AUTH_TOKEN: token };
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], detached: true, env });
    const end = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    for (const [sig, n] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]]) process.on(sig, () => { end(); process.exit(128 + n); });
    child.on('error', (e) => { console.error(`could not run ${command}: ${e.message}`); process.exit(127); });
    child.on('close', (code) => process.exit(code ?? 137));
  });
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) main(process.argv.slice(2));
