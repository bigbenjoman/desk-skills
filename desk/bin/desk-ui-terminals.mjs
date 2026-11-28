// desk-ui's terminals: the server's side of desk-ptyd's socket (desk-ptyd.mjs). The daemon owns every
// terminal, so a server restart loses none: the next server lists them and attaches again, and each
// attach answers with the terminal's last 256 KB of output.
// With no daemon answering (node-pty did not install, or the job is not loaded), every request is
// refused with code `unavailable` and Desk carries on without terminals.
import { connect } from 'node:net';

const TIMEOUT_MS = 10 * 1000;

// `socket` the daemon's path. -> { available, request, open, list, attach, detach, write, resize, kill, stop }
export function makeTerminals({ socket, log = (l) => console.error(l) } = {}) {
  let sock = null, ready = null, buf = '', next = 1;
  const pending = new Map(); // re -> { resolve, timer }
  const watchers = new Map(); // terminal id -> onEvent

  const unavailable = (message = 'Desk\'s terminals are unavailable: the pty daemon is not running.') => ({ ok: false, error: { code: 'unavailable', message } });
  function drop() {
    sock = null; ready = null; buf = '';
    for (const [re, p] of pending) { clearTimeout(p.timer); pending.delete(re); p.resolve(unavailable('The pty daemon closed the connection.')); }
    for (const [id, on] of watchers) { watchers.delete(id); try { on({ ev: 'gone', id }); } catch { /* the watcher's own */ } }
  }
  function onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m?.ev) { const on = watchers.get(m.id); if (on) try { on(m); } catch (e) { log(`desk-ui: terminals: ${e.message}`); } return; }
    const p = pending.get(m?.re);
    if (!p) return;
    pending.delete(m.re); clearTimeout(p.timer);
    const { re: _re, ...rest } = m;
    p.resolve(rest);
  }
  function connected() {
    if (ready) return ready;
    ready = new Promise((resolve) => {
      const s = connect(socket);
      s.setEncoding('utf8');
      s.once('connect', () => { sock = s; resolve(true); });
      s.on('data', (d) => {
        buf += d;
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(l); }
      });
      s.on('error', () => {});
      s.on('close', () => { if (sock === s || !sock) { drop(); resolve(false); } });
    });
    return ready;
  }
  // One request to the daemon: -> its answer ({ ok, ... }), never a throw.
  async function request(op, body = {}) {
    if (!(await connected()) || !sock) return unavailable();
    const re = next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(re); resolve(unavailable('The pty daemon did not answer.')); }, TIMEOUT_MS);
      timer.unref();
      pending.set(re, { resolve, timer });
      sock.write(`${JSON.stringify({ ...body, re, op })}\n`);
    });
  }

  const available = async () => (await request('ping')).ok === true;
  // `onEvent` gets { ev: 'data', id, data (base64) }, { ev: 'exit', id, code, signal }, or { ev: 'gone', id } when the daemon goes.
  async function attach(id, onEvent) {
    const r = await request('attach', { id });
    if (r.ok) watchers.set(id, onEvent);
    return r;
  }
  async function detach(id) { watchers.delete(id); return request('detach', { id }); }
  function stop() { watchers.clear(); if (sock) sock.destroy(); drop(); }

  return {
    available, request, attach, detach, stop,
    open: (o) => request('open', o),
    list: () => request('list'),
    write: (id, data) => request('write', { id, data: Buffer.from(String(data), 'utf8').toString('base64') }),
    resize: (id, cols, rows) => request('resize', { id, cols, rows }),
    kill: (id) => request('kill', { id }),
  };
}
