// The Mac's memory, shared by the runner VM's CI slots and autopilot's workers. Neither side starts
// work that would leave `avail` under one free-memory floor (the machine profile's
// runner-memory-floor-gb, 8 unless set), and they take turns: a side that is waiting for memory
// writes a marker here, and the other side's next start waits while one stands. CI always gets its
// first slot, and autopilot its first worker, when their own memory check allows; past those, when
// both wait, the side that began waiting first goes first.
//
// A marker is <DESK_HOME>/memory-turns/<name>.json: { side, since, at, why } plus what keeps it alive,
// the VM's process for CI (pid) and the batch's heartbeat for autopilot (state, queue). Each check
// that still waits rewrites it, keeping `since`. One not rewritten for 30 minutes, or whose VM or
// batch has gone, is stale: the reader removes it and says so.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { RULES } from './machine.mjs';
import { lastBeat, liveBeat } from './borrow.mjs';

export const STALE_MS = 30 * 60 * 1000;
export const turnsDir = (home = E.deskHome()) => join(home, 'memory-turns');

// What starting one more slot takes from `avail`: every slot's limit and the VM's own 2 GB, less what
// the VM already holds, which `avail` has already lost.
export function slotClaim({ slotGB, running, residentGB, reserveGB = RULES.vmReserveGB }) {
  return Math.max(0, (running + 1) * slotGB + reserveGB - (residentGB > 0 ? residentGB : 0));
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const mins = (ms) => Math.round(ms / 60000);
function staleWhy(m, now) {
  if (!(now - m.at <= STALE_MS)) return `not rewritten for ${mins(now - m.at)} minutes`;
  if (m.side === 'ci' && !(m.pid > 0 && alive(m.pid))) return `the VM process it was written for (pid ${m.pid ?? '?'}) no longer runs`;
  if (m.side === 'autopilot' && !liveBeat(lastBeat(m.state, m.queue), now)) return 'the batch that wrote it has no live pass';
  return null;
}

// Every live marker, oldest wait first. A stale or unreadable one is removed, and `removed` names it.
//   -> { live: [{ name, side, since, at, why, … }], removed: [line] }
export function readTurns({ dir = turnsDir(), now = Date.now() } = {}) {
  const live = [];
  const removed = [];
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.json')) : []) {
    const name = f.slice(0, -5);
    let m = null;
    try { m = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { /* unreadable: stale */ }
    const why = m && ['ci', 'autopilot'].includes(m.side) && Number.isFinite(m.since) && Number.isFinite(m.at) ? staleWhy(m, now) : 'it could not be read';
    if (why) {
      try { unlinkSync(join(dir, f)); } catch { /* gone already */ }
      removed.push(`memory turns: removed ${name}'s stale waiting marker: ${why}`);
    } else live.push({ ...m, name });
  }
  return { live: live.sort((a, b) => a.since - b.since), removed };
}

// Write or rewrite a side's marker, keeping the time it began waiting.
export function writeTurn(name, fields, { dir = turnsDir(), now = Date.now(), live = [] } = {}) {
  const was = live.find((m) => m.name === name);
  const m = { ...fields, since: was?.since ?? now, at: now };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json.tmp`), JSON.stringify(m));
  renameSync(join(dir, `${name}.json.tmp`), join(dir, `${name}.json`));
  return { ...m, name };
}
export function clearTurn(name, { dir = turnsDir() } = {}) {
  try { unlinkSync(join(dir, `${name}.json`)); return true; } catch { return false; }
}

const at = (ms) => new Date(ms).toTimeString().slice(0, 5);
export const waitLine = (m) => `${m.side === 'ci' ? 'a CI slot' : `autopilot (${m.name.replace(/^autopilot-/, '')})`} waiting for memory since ${at(m.since)}: ${m.why}`;

// Whether the runner may start one more slot now. `running` counts the VM's slots, every repo's.
//   -> { go, claim, why }
export function ciTurn({ avail, floor, slotGB, running, residentGB, live, self = 'ci' }) {
  const claim = slotClaim({ slotGB, running, residentGB });
  const left = avail - claim;
  const sum = `${avail.toFixed(1)}G available, a slot claims ${claim.toFixed(1)}G (${running + 1} x ${slotGB} + ${RULES.vmReserveGB} for the VM - ${Math.max(0, residentGB).toFixed(1)} it holds)`;
  if (left < floor) return { go: false, claim, why: `${sum}, which would leave ${left.toFixed(1)}G, under the ${floor}G floor` };
  const mine = live.find((m) => m.name === self);
  const first = live.find((m) => m.side === 'autopilot' && (!mine || m.since < mine.since));
  if (running > 0 && first) return { go: false, claim, why: `autopilot's turn: ${waitLine(first)}` };
  return { go: true, claim, why: `${sum}, leaving ${left.toFixed(1)}G, over the ${floor}G floor` };
}

// Whether a CI slot waiting for memory holds this batch's next spawn. Autopilot keeps its first worker.
//   -> null, or the CI marker that holds it
export function ciHolds({ running, live, self }) {
  if (running === 0) return null;
  const mine = live.find((m) => m.name === self);
  return live.find((m) => m.side === 'ci' && (!mine || m.since < mine.since)) ?? null;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

// For desk-runner:
//   ci --slot-gb <GB> --running <n> --pid <VM process>   exit 0 to start one more slot, 1 to wait, with why; CI's marker kept to match
//   ci clear                                              CI is no longer waiting
//   status                                                the floor, then every live wait
// Stale markers removed on the way are printed first.
if (isMain) {
  const args = process.argv.slice(2);
  const usage = () => { console.error('usage: mem-turns.mjs ci --slot-gb <GB> --running <n> --pid <pid> | ci clear | status'); process.exit(2); };
  const opt = (name) => { const i = args.indexOf(name); return i > 0 ? Number(args[i + 1]) : NaN; };
  if (args[0] === 'ci' && args[1] === 'clear') clearTurn('ci');
  else if (args[0] === 'status') {
    const { live, removed } = readTurns();
    for (const l of removed) console.log(l);
    console.log(`memory: floor ${E.memoryFloor()}G, ${E.availableGiB().toFixed(1)}G available`);
    for (const m of live) console.log(`memory: ${waitLine(m)}`);
  } else if (args[0] === 'ci') {
    const [slotGB, running, pid] = ['--slot-gb', '--running', '--pid'].map(opt);
    if (!(slotGB > 0) || !(running >= 0)) usage();
    const { live, removed } = readTurns();
    for (const l of removed) console.log(l);
    const t = ciTurn({ avail: E.availableGiB(), floor: E.memoryFloor(), slotGB, running, residentGB: E.vmResidentGiB(), live });
    if (t.go) { clearTurn('ci'); console.log(`memory: ${t.why}`); }
    else {
      writeTurn('ci', { side: 'ci', why: t.why, pid: pid > 0 ? pid : null }, { live });
      console.log(`a slot waits for memory: ${t.why}`);
      process.exitCode = 1;
    }
  } else usage();
}
