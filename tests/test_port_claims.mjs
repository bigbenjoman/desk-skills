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
