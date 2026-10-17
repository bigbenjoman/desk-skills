// Dev ports across repo configs: a port /desk-setup proposes meets no other repo's port or worker
// block, and a repo whose block already meets another's is flagged. Fixture configs only.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { portClashes, proposePort, repoPortClaims } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const T = mkdtempSync(join(tmpdir(), 'desk-ports-'));
const ROOT = join(T, 'desk');
// No machine profile, so an unset concurrency row reads as 2 / 3 rather than this computer's sizing.
process.env.DESK_MACHINE = join(T, 'none.md');
const repo = (slug, rows) => {
  mkdirSync(join(ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(ROOT, 'repos', slug, 'config.md'), `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n${rows}\n`);
};
const port = (p) => `| Preferred dev-server port | \`3000\` | \`${p}\` |`;
const conc = (c) => `| Autopilot worker concurrency | \`2 / 3\` | \`${c}\` |`;
repo('acme__shop', `${port(3400)}\n${conc('2 / 3')}`);
repo('acme__blog', `${port(3500)}\n${conc('2 / 5')}`);
repo('acme__todo', port('TODO'));
repo('acme__empty', '');
mkdirSync(join(ROOT, 'repos', 'acme__noconfig'), { recursive: true });

// ---- claims: each port holds itself and one port per worker above it; unset runs on 3000
const claims = repoPortClaims(ROOT);
t('every config claims, a directory with none does not', claims.map((c) => c.slug).join(), 'acme__blog,acme__empty,acme__shop,acme__todo');
t('block runs to port + worker cap, unset port is 3000', claims.map((c) => `${c.port}-${c.last}`).join(), '3500-3505,3000-3003,3400-3403,3000-3003');
t('no repos directory: no claims', repoPortClaims(join(T, 'nowhere')).length, 0);

// ---- AC1: the proposal is no repo's port and inside no worker block, and its own block is clear
t('a repo with an unset port keeps 3000 off the table', proposePort(3, claims), 3100);
t('nothing claimed: the first step', proposePort(3, []), 3000);
const crowded = [{ slug: 'a', port: 3000, last: 3003 }, { slug: 'b', port: 3098, last: 3101 }];
t('a worker block reaching the next step rules it out', proposePort(3, crowded), 3200);
t('own worker block reaching another port rules it out', proposePort(3, [{ slug: 'a', port: 3102, last: 3104 }], { from: 3100 }), 3200);
t('a port inside another worker block is ruled out', proposePort(3, [{ slug: 'a', port: 2999, last: 3002 }]), 3100);
t('custom start', proposePort(3, claims, { from: 3400 }), 3600);

// ---- AC2: a port sharing another repo's, or inside its worker block, is flagged
t('same port clashes', portClashes({ slug: 'me', port: 3400, last: 3403 }, claims).map((c) => c.slug).join(), 'acme__shop');
t('inside a worker block clashes', portClashes({ slug: 'me', port: 3503, last: 3506 }, claims).map((c) => c.slug).join(), 'acme__blog');
t('own workers reaching another port clash', portClashes({ slug: 'me', port: 3397, last: 3400 }, claims).map((c) => c.slug).join(), 'acme__shop');
t('a repo never clashes with itself', portClashes({ slug: 'acme__shop', port: 3400, last: 3403 }, claims).length, 0);
t('clear block: no clash', portClashes({ slug: 'me', port: 3600, last: 3603 }, claims).length, 0);

// ---- the CLI: REPO lines, CLASH for this repo, PROPOSE skipping every block
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-env.mjs');
const ports = (ownerRepo, ...args) => execFileSync('node', [BIN, 'ports', ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, HOME: T, DESK_CONFIG_ROOT: ROOT, DESK_REPO_OVERRIDE: ownerRepo, DESK_MACHINE: join(T, 'none.md'), DESK_CONFIG: '' },
}).trim().split('\n');
repo('acme__clash', `${port(3400)}\n${conc('1 / 2')}`);
repo('acme__api', `${port(3000)}\n${conc('2 / 3')}`);
const out = ports('acme/clash');
t('this repo marked', out.some((l) => l === 'REPO\tacme__clash\t3400\tworkers 3401-3402\t(this repo)'), true);
t('the shared port is flagged', out.filter((l) => l.startsWith('CLASH')).join('|'), 'CLASH\tacme__shop\t3400\tworkers 3401-3403');
t('proposal skips a taken port', out.at(-1), 'PROPOSE\t3100');
const fresh = ports('acme/todo');
t('unset port: no clash line', fresh.some((l) => l.startsWith('CLASH')), false);
t('unset port: still proposes', fresh.at(-1), 'PROPOSE\t3100');
t('--cap sizes this repo: a block reaching 3400 rules out 3100-3300', ports('acme/todo', '--cap', '300').at(-1), 'PROPOSE\t3600');
t('--cap flags a clash the config row would miss', ports('acme/clash', '--cap', '100').filter((l) => l.startsWith('CLASH')).length, 2);

if (fails) { console.log(`FAIL: ${fails} checks failed`); process.exit(1); }
