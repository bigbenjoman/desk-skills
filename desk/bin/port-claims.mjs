#!/usr/bin/env node
// Dev-server ports a peer session that runs no autopilot batch claimed, machine-wide, in ~/.desk-autopilot/port-claims.jsonl
// (DESK_PORT_CLAIMS names another file): one JSON line per claim, release or lapse. The orchestrator records
// what a peer's handshake said it holds, and every pass skips those ports when it gives a worker one,
// whether or not the peer's server is up at that moment. Another batch's ports are never recorded here:
// every pass already skips its workers' ports, and its published range is the one its own pass uses.
//
//   port-claims.mjs claim <port | from-to> --by <who> [--hours <n>]
//       records <who>'s claim, replacing any earlier one of theirs; it lapses after <n> hours (default
//       CLAIM_HOURS), so a peer that never releases does not hold the ports for good.
//   port-claims.mjs release --by <who>
//       ends <who>'s claim.
//   port-claims.mjs list
//       the claims in force, one line each.
// `who` names the peer as its handshake did (its session name).
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { EXIT } from './batch-state.mjs';

export const CLAIM_HOURS = 12;
// The widest claim taken: a range past this is a typo, and would leave a pass searching far for a port.
export const MAX_PORTS = 200;
export const claimsPath = () => E.expandHome(process.env.DESK_PORT_CLAIMS ?? join(E.HOME, '.desk-autopilot', 'port-claims.jsonl'));

// The file read: each claimer's last event, the count of lines that do not parse, `missing` when there
// is no file (no claims, not an error), and `error`, why the file could not be read at all. A `lapse`
// event ends only the claim it names (`of`, that claim's `at`), so a pass dropping a lapsed claim never
// ends a claim its peer renewed in between.
function readFile(path) {
  const last = new Map();
  if (!existsSync(path)) return { last, torn: 0, missing: true, error: null };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return { last, torn: 0, missing: false, error: e.code ?? e.message }; }
  let torn = 0;
  for (const l of text.split('\n').filter((s) => s.trim())) {
    let e;
    try { e = JSON.parse(l); } catch { torn += 1; continue; }
    if (!e?.by) continue;
    if (e.event === 'lapse' && last.get(e.by)?.at !== e.of) continue;
    last.set(e.by, e);
  }
  return { last, torn, missing: false, error: null };
}
const isClaim = (e) => e.event === 'claim'
  && Number.isInteger(e.from) && Number.isInteger(e.to) && e.from > 0 && e.to >= e.from && e.to - e.from < MAX_PORTS;
const isActive = (e, now) => isClaim(e) && Date.parse(e.until) > now;

// The claims in force at `now`: each claimer's last event, when it is a claim not yet lapsed.
export function activeClaims(now = Date.now(), path = claimsPath()) {
  return [...readFile(path).last.values()].filter((e) => isActive(e, now));
}
const portsOf = (claims) => {
  const ports = new Set();
  for (const c of claims) for (let p = c.from; p <= c.to; p += 1) ports.add(p);
  return ports;
};
const rangeOf = (c) => (c.from === c.to ? String(c.from) : `${c.from}-${c.to}`);

// What a pass reads before it gives a worker a port: `ports`, every port a claim in force holds, and
// `lines` for its report. A claim that lapsed unrenewed is taken as its peer's session gone: with
// `drop` it is recorded as lapsed, so the next pass does not report it again, and the line says it
// was dropped. A file that is missing, cannot be read, or has lines that do not parse, is named, and
// the pass picks from what it could read.
export function passClaims({ now = Date.now(), path = claimsPath(), drop = true } = {}) {
  const { last, torn, missing, error } = readFile(path);
  if (missing) return { ports: new Set(), lines: [`ports: there is no port claims file ${path}, so no peer has claimed a port`] };
  if (error) return { ports: new Set(), lines: [`ports: the port claims file ${path} cannot be read (${error}), so no peer's claimed ports were skipped`] };
  const lines = torn ? [`ports: ${torn} line(s) of the port claims file ${path} do not parse and were skipped: a claim on one of them is not honoured until it is fixed or removed`] : [];
  for (const c of last.values()) {
    if (!isClaim(c) || isActive(c, now)) continue;
    let kept = '';
    if (drop) {
      try { append({ at: new Date(now).toISOString(), by: c.by, event: 'lapse', of: c.at }, path); } catch (e) { kept = `, though recording that failed (${e.code ?? e.message}), so the next pass says so again`; }
    }
    lines.push(`ports: dropped ${c.by}'s claim on ${rangeOf(c)}, which lapsed unrenewed at ${c.until}, so its session is taken as gone${kept}`);
  }
  return { ports: portsOf([...last.values()].filter((e) => isActive(e, now))), lines };
}

// `3001` or `3001-3004` as { from, to }, or an error naming what is wrong.
export function parseRange(text) {
  const m = /^([1-9][0-9]{0,4})(?:-([1-9][0-9]{0,4}))?$/.exec(String(text ?? '').trim());
  if (!m) return { error: `"${text}" is not a port or a range of ports (3001, or 3001-3004)` };
  const from = Number(m[1]); const to = Number(m[2] ?? m[1]);
  if (to > 65535) return { error: `${to} is past the highest port, 65535` };
  if (to < from) return { error: `${text} ends before it starts` };
  if (to - from >= MAX_PORTS) return { error: `${text} is ${to - from + 1} ports, more than the ${MAX_PORTS} a claim may hold` };
  return { from, to };
}

// Each line starts on a line of its own, so a torn last line (a write cut off) never swallows it.
const append = (e, path) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `\n${JSON.stringify(e)}\n`); };
export function claim({ from, to, by, hours = CLAIM_HOURS, now = Date.now(), path = claimsPath() }) {
  append({ at: new Date(now).toISOString(), by, event: 'claim', from, to, until: new Date(now + hours * 3600 * 1000).toISOString() }, path);
}
export function release({ by, now = Date.now(), path = claimsPath() }) {
  append({ at: new Date(now).toISOString(), by, event: 'release' }, path);
}
export const claimLine = (c) => `${rangeOf(c)}  by ${c.by}  until ${c.until}`;

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? ''; };
  const by = flag('--by'); const hoursText = flag('--hours');
  const [cmd, range] = args;
  const usage = 'usage: port-claims.mjs claim <port | from-to> --by <who> [--hours <n>] | release --by <who> | list';
  const die = (m) => { console.error(`port-claims: ${m}`); process.exit(EXIT.SHOW_PERSON); };
  if (cmd === 'list') {
    const { error } = readFile(claimsPath());
    if (error) die(`the port claims file ${claimsPath()} cannot be read (${error})`);
    const live = activeClaims();
    if (!live.length) console.log('no ports claimed');
    for (const c of live) console.log(claimLine(c));
    process.exit(EXIT.GO_ON);
  }
  if (!['claim', 'release'].includes(cmd) || !by?.trim()) die(usage);
  if (cmd === 'release') {
    release({ by });
    console.log(`released the ports ${by} claimed`);
    process.exit(EXIT.GO_ON);
  }
  const r = parseRange(range);
  if (r.error) die(`${r.error}. ${usage}`);
  const hours = hoursText == null ? CLAIM_HOURS : Number(hoursText);
  // At most a year: past that the lapse is no lapse, and a huge number is no date at all.
  if (!(Number.isFinite(hours) && hours > 0 && hours <= 24 * 366)) die(`--hours wants a number of hours above 0 and at most ${24 * 366}, not "${hoursText}"`);
  claim({ ...r, by, hours });
  console.log(`claimed ${r.from === r.to ? r.from : `${r.from}-${r.to}`} for ${by}, for ${hours} hour(s): no pass gives a worker these ports`);
}
