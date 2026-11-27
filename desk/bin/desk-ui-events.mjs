// desk-ui's change stream, GET /api/events: server-sent events carrying each change to desk's state.
// A watcher on desk's state folders rebuilds the read model (desk-q's home and repo views) at most
// once per DEBOUNCE_MS, diffs it by repo slug and ticket key against the last one, and sends each
// difference to every open window as its own event, numbered by the revision it makes:
//   snapshot  { at, rev, ...desk-q's home view but its inputs, tickets: { <slug>: [row] } }  first, and after a gap
//   home      { needs_you, machine, no_batch, usage, levers, subscriptions }    the machine-wide figures
// `subscriptions` is desk-q-model's subscriptionsJson, the Usage & costs screen's figures. A usage
// probe writes only a quiet .log, which the watcher leaves out, so the server's probe loop
// (desk-ui-probes.mjs) calls the feed's changed() after each round.
//   repo      { slug, summary }      one repo's home-view row; summary null once the repo has gone
//   tickets   { slug, upsert: [row], remove: [key] }                            the rows that moved
//   ping      { at }                 after PING_MS with nothing else sent; carries no revision
// Worker logs (logs/, any *.log), the read-only clones (ref/) and the server's own folder (ui/) are
// not watched: workers write them all the time and they change no count. A clock tick every TICK_MS
// rebuilds when a batch's heartbeat has aged past LIVE_MS (or come back) with no file written.
// The last RING events are kept, so a window that reconnects with Last-Event-ID (or ?since=) gets only
// those after it; a revision the ring no longer covers gets a snapshot first.
import { watch } from 'node:fs';
import { join, sep } from 'node:path';
import * as E from './desk-env.mjs';
import { lastBeat, liveBeat } from './borrow.mjs';

const DEBOUNCE_MS = 250;
const TICK_MS = 5000;
const PING_MS = 15_000;
const RING = 500;
// A window that stops reading is dropped once this much is waiting for it.
const MAX_BACKLOG = 8 * 1024 * 1024;

// The folders whose writes can change the read model: each batch's state, its queue and each repo's config.
const stateRoots = () => [join(E.HOME, '.desk-autopilot'), join(E.deskHome(), 'repos'), join(E.deskConfigRoot(), 'repos')];

// Whether a write at `file` (relative to the watched root) can change the read model: not the server's
// own folder (ui/), nor anything quietStateName leaves out of desk-q's state stamp. Paths run
// <slug>/[batches/<batch>/]<entry>: only an entry is read as quiet, never a repo slug or a batch name,
// since a slug may end in .log and a batch may be named logs or ref.
export function counts(file) {
  if (file == null) return true; // the platform did not say which file: assume it counts
  const segs = String(file).split(/[\\/]/).filter(Boolean);
  const at = segs[1] === 'batches' ? 3 : 1; // where the entry sits
  const last = segs.length - 1;
  if (segs[0] === 'ui') return false;
  if (last > at && (segs[at] === 'logs' || segs[at] === 'ref')) return false;
  return !(last >= at && E.quietStateName(segs[last]));
}

// The read model: desk-q's home view for every repo with a batch, each repo's ticket rows as its
// repo view lists them (their figures and stage, not the screen's line, which carries ages that move
// with the clock), and each batch's heartbeat liveness, which the clock tick checks.
export async function readModel(now) {
  const Q = await import('./desk-q-model.mjs');
  E.forgetReads(); // the server outlives edits to the machine profile and configs
  const repos = Q.loadRepos(now);
  const { lines, generated_at, ...body } = Q.homeJson(repos, { all: true, now });
  // An unreadable subscriptions file blanks only the Usage & costs figures, never every screen.
  try { body.subscriptions = Q.subscriptionsJson(repos, { now }); } catch (e) { body.subscriptions = { error: e.message }; }
  const tickets = {};
  for (const s of body.repos ?? []) {
    const r = s.error ? null : Q.repoPlace(repos, s.id);
    if (!r) { tickets[s.slug] = []; continue; }
    const stage = new Map([...(r.rows ?? []), ...(r.prs ?? [])].map((x) => [x.t.key, x.t.stage ?? null]));
    tickets[s.slug] = Q.repoJson(repos, r, { now }).tickets.map(({ line, ...row }) => ({ ...row, stage: stage.get(row.key) ?? null }));
  }
  const batches = repos.filter((r) => r.queuePath).map((r) => ({ stateDir: r.stateDir, queuePath: r.queuePath, live: !!r.live }));
  // `wire` is the listing itself, which desk-q reads (GET /api/model); no event or snapshot carries it.
  return { at: now, body, tickets, batches, wire: Q.modelWire(repos, now) };
}
// Whether any batch's liveness has moved since the model was read, with nothing written.
const livenessMoved = (model, now) => model.batches.some((b) => liveBeat(lastBeat(b.stateDir, b.queuePath), now) !== b.live);

// What a change compares: each figure, without the ones that move with the clock alone (a repo's ages,
// the Levers page's text and age) or with free memory (the machine's room).
const summaryKey = (s) => { if (!s) return 'null'; const { last_pass, all_done_by, ...rest } = s; return JSON.stringify(rest); };
const homeOf = (body) => ({ needs_you: body.needs_you, machine: body.machine, no_batch: body.no_batch, usage: body.usage, levers: body.levers, subscriptions: body.subscriptions });
const homeKey = (body) => JSON.stringify({ needs: body.needs_you, running: body.machine?.running, cap: body.machine?.cap, none: body.no_batch,
  usage: body.usage, subscriptions: body.subscriptions, levers: body.levers && { state: body.levers.state, fault: body.levers.fault, page: body.levers.page, figures: body.levers.figures } });

// The events that take a window from `prev` to `next`.
function diff(prev, next) {
  const out = [];
  const before = new Map((prev.body.repos ?? []).map((s) => [s.slug, s]));
  const after = new Map((next.body.repos ?? []).map((s) => [s.slug, s]));
  for (const slug of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(slug), b = after.get(slug);
    if (summaryKey(a) !== summaryKey(b)) out.push({ event: 'repo', data: { slug, summary: b ?? null } });
    const was = new Map((prev.tickets[slug] ?? []).map((t) => [t.key, JSON.stringify(t)]));
    const now = next.tickets[slug] ?? [];
    const upsert = now.filter((t) => was.get(t.key) !== JSON.stringify(t));
    const keys = new Set(now.map((t) => t.key));
    const remove = [...was.keys()].filter((k) => !keys.has(k));
    if (upsert.length || remove.length) out.push({ event: 'tickets', data: { slug, upsert, remove } });
  }
  if (homeKey(prev.body) !== homeKey(next.body)) out.push({ event: 'home', data: homeOf(next.body) });
  return out;
}

const mono = () => performance.now();
const frame = (event, data, id = null) => `${id == null ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// The feed one server holds. `build(now)` reads the model (readModel), `stale(model, now)` says the clock
// alone has changed it (livenessMoved), `now` is the clock both read, and `onBuild(at)` hears when each
// rebuild starts (the tests count them). Timers never hold the process open.
export function makeFeed({ build = readModel, stale = livenessMoved, now = Date.now, roots = stateRoots, debounceMs = DEBOUNCE_MS,
  tickMs = TICK_MS, pingMs = PING_MS, ring = RING, onBuild = () => {}, onError = (e) => console.error(`desk-ui: events: ${e.message}`) } = {}) {
  // `lastBuild` is on the monotonic clock, so a wall-clock jump never stretches the debounce.
  let model = null, rev = 0, dirty = false, timer = null, building = null, lastBuild = -Infinity, rebuilds = 0, ticker = null, started = false, stopped = false;
  const held = []; // the last `ring` events: { id, event, data }
  const clients = new Set();
  const watchers = new Map(); // root -> FSWatcher
  const waiting = []; // reads waiting on the rebuild a change scheduled

  // A ping once `pingMs` passes with nothing else sent.
  const arm = (c) => {
    clearTimeout(c.ping);
    c.ping = setTimeout(() => send(c, frame('ping', { at: new Date(now()).toISOString() })), pingMs);
    c.ping.unref?.();
  };
  const send = (c, text) => {
    if (c.res.writableLength > MAX_BACKLOG) { drop(c); c.res.destroy(); return; }
    c.res.write(text);
    arm(c);
  };
  const drop = (c) => { clearTimeout(c.ping); clients.delete(c); };
  function publish(event, data) {
    rev += 1;
    held.push({ id: rev, event, data });
    if (held.length > ring) held.shift();
    const text = frame(event, data, rev);
    for (const c of clients) send(c, text);
  }

  async function rebuild() {
    clearTimeout(timer); timer = null;
    dirty = false;
    lastBuild = mono();
    rebuilds += 1;
    onBuild(Date.now());
    try {
      const next = await build(now());
      if (!model) rev += 1; // the first model is a revision of its own, which only a snapshot carries
      else for (const c of diff(model, next)) publish(c.event, c.data);
      model = next;
    } catch (e) { onError(e); }
  }
  function run() {
    building = rebuild().finally(() => {
      building = null;
      for (const r of waiting.splice(0)) r();
      if (dirty) schedule();
    });
    return building;
  }
  // How long until DEBOUNCE_MS has passed since the last rebuild started, rounded up.
  const untilDebounced = () => Math.max(0, Math.ceil(lastBuild + debounceMs - mono()));
  // Resolves once DEBOUNCE_MS has passed since the last rebuild started. A timer may fire a
  // millisecond early, so the wait is checked again on waking.
  const debounced = async () => { for (let ms = untilDebounced(); ms > 0; ms = untilDebounced()) await new Promise((r) => setTimeout(r, ms)); };
  // A rebuild once DEBOUNCE_MS has passed since the last one started, so a burst of writes costs one.
  function schedule() {
    dirty = true;
    if (timer || building || stopped) return;
    timer = setTimeout(() => { timer = null; if (untilDebounced() > 0) schedule(); else run(); }, untilDebounced());
    timer.unref?.();
  }

  function watchRoots() {
    for (const root of roots()) {
      if (watchers.has(root)) continue;
      try {
        const w = watch(root, { recursive: true }, (_type, file) => { if (counts(file)) schedule(); });
        w.on('error', () => { w.close(); watchers.delete(root); schedule(); });
        watchers.set(root, w);
      } catch { /* not there yet: the next tick tries again */ }
    }
  }
  // A failed read (a batch archived mid-read) waits for the next tick, never ends the server.
  function tick() {
    try {
      watchRoots();
      if (model && !timer && !building && stale(model, now())) schedule();
    } catch (e) { onError(e); }
  }
  function start() {
    if (started || stopped) return;
    started = true;
    watchRoots();
    ticker = setInterval(tick, tickMs);
    ticker.unref?.();
  }

  // The model as it stands, built first when there is none or a change is waiting. `fresh` also
  // rebuilds an unchanged one, for a read of what the watcher does not see (the machine profile): once
  // DEBOUNCE_MS has passed since the last rebuild started, unless one started since it was asked for.
  async function current({ fresh = false } = {}) {
    start();
    const asked = rebuilds; // a rebuild started after this read was asked for is fresh enough
    if (fresh && model) await debounced();
    if (building) await building;
    if (!model || (fresh && rebuilds === asked)) await run();
    else if (dirty && !stopped) await new Promise((r) => waiting.push(r));
    return model;
  }
  // /api/snapshot's whole read. The stream's leaves out `inputs`, the ages of what it was read from,
  // which no event keeps current.
  const snapshot = (m = model) => ({ at: new Date(m.at).toISOString(), rev, ...m.body, tickets: m.tickets });

  // The revision a window last saw, from Last-Event-ID or ?since=, or null.
  const since = (req, query) => {
    const raw = req.headers['last-event-id'] ?? query.get('since');
    return raw != null && /^\d+$/.test(String(raw).trim()) ? Number(raw) : null;
  };
  // Opens one window's stream: the events after the revision it names while the ring still holds every
  // one of them, else a snapshot.
  async function subscribe(req, res, { headers = {}, query = new URLSearchParams() } = {}) {
    let gone = false;
    res.once('close', () => { gone = true; });
    const m = await current();
    if (gone) return true; // the window left while the model was read: nothing to open
    // The server stopped while the model was read: no stream opens after the stop, or it would hold the exit.
    if (stopped) { res.writeHead(503, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }); res.end('desk-ui is stopping.\n'); return true; }
    if (!m) return false;
    const after = since(req, query);
    const floor = held.length ? held[0].id - 1 : rev;
    res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'close' });
    res.flushHeaders?.();
    const c = { res, ping: null };
    clients.add(c);
    res.on('close', () => drop(c)); // the window went away (a request's own 'close' fires once it is read)
    if (after != null && after >= floor && after <= rev) for (const e of held.filter((x) => x.id > after)) send(c, frame(e.event, e.data, e.id));
    else { const { inputs, ...s } = snapshot(m); send(c, frame('snapshot', s, rev)); }
    if (!c.ping) arm(c); // nothing missed and nothing new, so nothing was sent to arm it
    return true;
  }

  // Ends the feed for good: open streams are ended, and a read waiting on a rebuild that will now never
  // run is released, so no request still opening holds the server's close.
  function stop() {
    stopped = true;
    clearInterval(ticker); clearTimeout(timer); timer = null;
    for (const w of watchers.values()) w.close();
    watchers.clear();
    for (const c of [...clients]) { drop(c); c.res.end(); }
    for (const r of waiting.splice(0)) r();
    started = false;
  }

  // A change the watcher cannot see (a usage probe's .log): a rebuild, debounced as a write's is.
  const changed = () => schedule();

  return { current, snapshot, subscribe, stop, tick, changed, get rev() { return rev; }, get clients() { return clients.size; } };
}
