// desk-ui's usage probe loop (DS-731): while the server runs, it makes the probes an open desk-q
// screen would (desk-q-model probesDue), whether or not a Desk window is open, so the figures stay no
// older than one probe interval with the app quit. Every TICK_MS it writes its heartbeat,
// ~/.desk-autopilot/ui/scheduler.json { pid, at, every_ms }, then starts the probes due, one at a time
// (the probe's start lock refuses a second caller in the same moment), telling the change stream as each
// ends, since its reading is a quiet .log the stream's watcher leaves out. A desk-q screen that finds the heartbeat fresh (schedulerFresh) leaves the
// probes to the server and shows the readings it writes; with the heartbeat stale or gone, as when the
// server has stopped, desk-q probes by itself as it always has. The heartbeat is removed on stop.
import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as E from './desk-env.mjs';

export const TICK_MS = 30_000;
// A heartbeat is fresh while it is younger than two ticks and this much more.
const SLACK_MS = 15_000;

export const beatPath = () => join(E.HOME, '.desk-autopilot', 'ui', 'scheduler.json');

const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// Whether a server's probe loop is running now: its heartbeat younger than two of its ticks (and
// SLACK_MS), from a process still alive. A missing or unreadable heartbeat is not fresh.
export function schedulerFresh(now = Date.now(), path = beatPath()) {
  let b;
  try { b = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
  const every = Number(b?.every_ms) > 0 ? Number(b.every_ms) : TICK_MS;
  const at = Number(b?.at);
  return Number.isFinite(at) && now - at >= -SLACK_MS && now - at <= 2 * every + SLACK_MS && alive(Number(b.pid));
}

// The loop. `due(now)` lists the probes to make ([{ login }]), `probe({ now, login, done })` starts one
// (usage-probe's probe), `changed()` hears each probe end. The tests pass each of them and a clock. Timers never hold the
// process open.
export function makeScheduler({ now = Date.now, tickMs = TICK_MS, path = beatPath(), due, probe, changed = () => {},
  onError = (e) => console.error(`desk-ui: probes: ${e.message}`) } = {}) {
  let timer = null, round = null, stopped = false;
  const beat = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, at: now(), every_ms: tickMs })}\n`);
      renameSync(tmp, path);
    } catch (e) { onError(e); }
  };
  async function run() {
    let list = [];
    try { list = await due(now()); } catch (e) { onError(e); return; }
    // A probe returns once started and calls `done` as it exits, which is when its reading lands.
    const done = () => { if (!stopped) changed(); };
    for (const p of list) {
      if (stopped) break;
      try { await probe({ now: now(), ...p, done }); } catch (e) { onError(e); }
    }
  }
  // One round at a time: a tick while one runs only writes the heartbeat.
  function tick() {
    if (stopped) return round;
    beat();
    if (!round) round = run().finally(() => { round = null; });
    return round;
  }
  function start() {
    if (timer || stopped) return;
    tick();
    timer = setInterval(tick, tickMs);
    timer.unref?.();
  }
  function stop() {
    stopped = true;
    clearInterval(timer); timer = null;
    try {
      const b = JSON.parse(readFileSync(path, 'utf8'));
      if (b?.pid === process.pid) rmSync(path, { force: true });
    } catch { /* none, or another's: left alone */ }
  }
  return { start, stop, tick, get running() { return !!round; } };
}

// The loop desk-ui serve runs: the probes desk-q's screen would make, over every repo read now.
export async function serverScheduler({ changed }) {
  const [Q, P] = await Promise.all([import('./desk-q-model.mjs'), import('./usage-probe.mjs')]);
  return makeScheduler({
    due: (now) => Q.probesDue(Q.loadRepos(now), { now }),
    probe: (p) => P.probe(p),
    changed,
  });
}
