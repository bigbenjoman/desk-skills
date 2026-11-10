// Runs claude behind a local forwarding proxy, recording what each Messages response counted against
// an OpenCode Go allowance. Claude Code keeps no field of a response it does not know, and Go reports
// a request's allowance only in its response, so a synchronous caller runs claude through this file:
//   node endpoint-proxy.mjs <allowance file> <command> [args...]
// The upstream is the ANTHROPIC_BASE_URL it is started with; the command gets this proxy's own address
// in its place. Requests and responses pass through unchanged apart from the host and the encoding
// asked for (identity, so the body can be read). After each 2xx POST to /v1/messages the allowance
// file is rewritten as a JSON list, one value per response in order: its `opencode.allowance`, or null
// where it carries none. Nothing about a request (its headers, its key) is written anywhere.
// Sent SIGTERM (the caller's timeout), it ends the command's process group too.
import { spawn } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
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

function main([file, command, ...args]) {
  const upstream = new URL(process.env.ANTHROPIC_BASE_URL);
  const base = upstream.pathname.replace(/\/$/, '');
  const values = [];
  const save = () => writeFileSync(file, `${JSON.stringify(values)}\n`);
  save();
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: upstream.host, 'accept-encoding': 'identity' };
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
    const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` };
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
