// suite: port claims (ports a peer session claimed at handshake)
// port-claims.mjs records the dev-server ports a peer's handshake claimed, machine-wide: claimedPorts
// holds each claimer's last claim until it is released or lapses, a new claim replaces the claimer's
// last, and the CLI refuses a range it cannot read.
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

const T = scratch('port-claims-');
process.env.DESK_PORT_CLAIMS = join(T, 'claims.jsonl');
const P = await import('../desk/bin/port-claims.mjs');
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'port-claims.mjs');
let fails = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};
const path = process.env.DESK_PORT_CLAIMS;
const NOW = Date.parse('2026-11-20T10:00:00Z');
const H = 3600 * 1000;
const ports = (now = NOW) => [...P.claimedPorts(now, path)].sort((a, b) => a - b).join(',');

t('#823 nothing claimed holds no port', ports(), '');
P.claim({ from: 3001, to: 3003, by: 'peer A', now: NOW, path });
t('#823 a claimed range holds every port in it', ports(), '3001,3002,3003');
P.claim({ from: 4000, to: 4000, by: 'peer B', now: NOW, path });
t('#823 claims by two peers both hold', ports(), '3001,3002,3003,4000');
P.claim({ from: 3005, to: 3006, by: 'peer A', now: NOW + 1000, path });
t('#823 a peer claiming again replaces its own last claim', ports(NOW + 2000), '3005,3006,4000');
P.release({ by: 'peer B', now: NOW + 3000, path });
t('#823 a release frees that peer\'s ports', ports(NOW + 4000), '3005,3006');
t('#823 a claim lapses after its hours', ports(NOW + 1000 + P.CLAIM_HOURS * H + 1), '');
P.claim({ from: 5000, to: 5001, by: 'peer C', hours: 1, now: NOW, path });
t('#823 --hours sets when it lapses', [ports(NOW + H - 1).includes('5000'), ports(NOW + H + 1).includes('5000')], [true, false]);
appendFileSync(path, '{"by": "torn');
P.claim({ from: 6000, to: 6000, by: 'peer E', now: NOW, path });
t('#823 a torn last line is skipped, and the claim after it still holds', ports(NOW + 4000), '3005,3006,5000,5001,6000');
// DS-825: what a pass reads. A claim that lapsed unrenewed is dropped once and said; a peer that
// renewed between the pass's read and its drop keeps its new claim; an unreadable file is named.
const pc = join(T, 'pass.jsonl');
const sorted = (s) => [...s].sort((a, b) => a - b).join(',');
P.claim({ from: 7000, to: 7001, by: 'peer F', hours: 1, now: NOW, path: pc });
P.claim({ from: 7100, to: 7100, by: 'peer G', now: NOW, path: pc });
const r1 = P.passClaims({ now: NOW + 2 * H, path: pc });
t('DS-825 AC3 a lapsed claim no longer blocks, and the pass says it dropped it', [sorted(r1.ports), r1.lines],
  ['7100', [`ports: dropped peer F's claim on 7000-7001, which lapsed unrenewed at ${new Date(NOW + H).toISOString()}, so its session is taken as gone`]]);
t('DS-825 AC3 a claim dropped once is not said again', P.passClaims({ now: NOW + 2 * H, path: pc }).lines, []);
P.claim({ from: 7200, to: 7200, by: 'peer H', hours: 1, now: NOW, path: pc });
const lapsedAt = new Date(NOW).toISOString();
P.claim({ from: 7300, to: 7300, by: 'peer H', now: NOW + 2 * H, path: pc });
appendFileSync(pc, `\n${JSON.stringify({ at: new Date(NOW + 2 * H).toISOString(), by: 'peer H', event: 'lapse', of: lapsedAt })}\n`);
t('DS-825 a drop naming a claim since renewed leaves the new claim in force', sorted(P.passClaims({ now: NOW + 2 * H, path: pc, drop: false }).ports), '7100,7300');
P.claim({ from: 7400, to: 7400, by: 'peer I', hours: 1, now: NOW, path: pc });
const twice = [1, 2].map(() => P.passClaims({ now: NOW + 3 * H, path: pc, drop: false }).lines.filter((l) => l.includes('peer I')).length);
t('DS-825 without drop (a dry run), a lapsed claim is said but not recorded', twice, [1, 1]);
t('DS-825 AC4 a missing file holds no port and says nothing', P.passClaims({ now: NOW, path: join(T, 'none.jsonl') }), { ports: new Set(), lines: [] });
const r3 = P.passClaims({ now: NOW, path: T });
t('DS-825 AC4 a file that cannot be read holds no port, and is named', [r3.ports.size, r3.lines], [0, [`ports: the port claims file ${T} cannot be read (EISDIR), so no peer's claimed ports were skipped`]]);
appendFileSync(pc, '{"by": "torn');
const r4 = P.passClaims({ now: NOW + 2 * H, path: pc, drop: false });
t('DS-825 AC4 lines that do not parse are counted and named, and the rest still hold', [sorted(r4.ports), r4.lines[0]],
  ['7100,7300', `ports: 1 line(s) of the port claims file ${pc} do not parse and were skipped: a claim on one of them is not honoured until it is fixed or removed`]);

t('#823 parseRange reads one port and a range', [P.parseRange('3001'), P.parseRange('3001-3004')], [{ from: 3001, to: 3001 }, { from: 3001, to: 3004 }]);
t('#823 and refuses what it cannot read', ['abc', '3004-3001', '70000', `3000-${3000 + P.MAX_PORTS}`].map((r) => Boolean(P.parseRange(r).error)), [true, true, true, true]);

const cli = (...a) => spawnSync('node', [BIN, ...a], { encoding: 'utf8', env: { ...process.env, DESK_PORT_CLAIMS: join(T, 'cli.jsonl') } });
const c1 = cli('claim', '3101-3102', '--by', 'peer D');
t('#823 the CLI claims, saying for how long', [c1.status, c1.stdout.trim()], [0, `claimed 3101-3102 for peer D, for ${P.CLAIM_HOURS} hour(s): no pass gives a worker these ports`]);
t('#823 list prints the claims in force', cli('list').stdout.trim().replace(/until \S+/, 'until X'), '3101-3102  by peer D  until X');
t('#823 release, then list says none', [cli('release', '--by', 'peer D').status, cli('list').stdout.trim()], [0, 'no ports claimed']);
t('#823 a bad range or no --by is refused, exit 11', [cli('claim', 'abc', '--by', 'x').status, cli('claim', '3001').status, cli('claim', '3001', '--by', 'x', '--hours', '0').status, cli('claim', '3001', '--by', 'x', '--hours', 'Infinity').status, cli('claim', '3001', '--by', 'x', '--hours', '1e300').status], [11, 11, 11, 11, 11]);

console.log(fails ? `${fails} FAILED` : 'all port claim checks passed');
process.exit(fails ? 1 : 0);
