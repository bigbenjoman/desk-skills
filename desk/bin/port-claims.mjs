#!/usr/bin/env node
// Dev-server ports a peer session that runs no autopilot batch claimed, machine-wide, in ~/.desk-autopilot/port-claims.jsonl
// (DESK_PORT_CLAIMS names another file): one JSON line per claim or release. The orchestrator records
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
// `who` names the peer as its handshake did (its session name, or repo and batch).
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { EXIT } from './batch-state.mjs';

export const CLAIM_HOURS = 12;
// The widest claim taken: a range past this is a typo, and would leave a pass searching far for a port.
export const MAX_PORTS = 200;
export const claimsPath = () => E.expandHome(process.env.DESK_PORT_CLAIMS ?? join(E.HOME, '.desk-autopilot', 'port-claims.jsonl'));

const events = (path) => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
  : []);

// The claims in force at `now`: each claimer's last event, when it is a claim not yet lapsed.
export function activeClaims(now = Date.now(), path = claimsPath()) {
  const last = new Map();
  for (const e of events(path)) if (e?.by) last.set(e.by, e);
  return [...last.values()].filter((e) => e.event === 'claim' && Date.parse(e.until) > now
    && Number.isInteger(e.from) && Number.isInteger(e.to) && e.from > 0 && e.to >= e.from && e.to - e.from < MAX_PORTS);
}
// Every port a claim in force holds.
export function claimedPorts(now = Date.now(), path = claimsPath()) {
  const ports = new Set();
  for (const c of activeClaims(now, path)) for (let p = c.from; p <= c.to; p += 1) ports.add(p);
  return ports;
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
export const claimLine = (c) => `${c.from === c.to ? c.from : `${c.from}-${c.to}`}  by ${c.by}  until ${c.until}`;

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
  if (!(hours > 0)) die(`--hours wants a number of hours above 0, not "${hoursText}"`);
  claim({ ...r, by, hours });
  console.log(`claimed ${r.from === r.to ? r.from : `${r.from}-${r.to}`} for ${by}, for ${hours} hour(s): no pass gives a worker these ports`);
}
