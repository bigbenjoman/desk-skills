// suite: bash 3.2 feature scan (every bash 4+ case fires, 3.2-safe lines and this repo's scripts pass)
// tests/bash32_check.sh --scan-only, one fixture line per file: each line of
// tests/fixtures/bash32-newer.txt must fail the scan, each of tests/fixtures/bash32-ok.txt must pass,
// and so must every shell script in the repo. The Docker half (`bash -n` under 3.2) runs in CI.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoMap } from './scope_sections.mjs';
let fails = 0;
const t = (name, got, want) => { const g = JSON.stringify(got); const w = JSON.stringify(want); const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`); };
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const scan = (...files) => spawnSync('bash', [join(R, 'tests/bash32_check.sh'), '--scan-only', ...files], { encoding: 'utf8' });
const lines = (f) => readFileSync(join(R, 'tests/fixtures', f), 'utf8').split('\n').filter((l) => l.trim());
const T = mkdtempSync(join(tmpdir(), 'desk-bash32-'));
try {
  const one = (l, i) => { const f = join(T, `case${i}.sh`); writeFileSync(f, `#!/usr/bin/env bash\n${l}\n`); return scan(f); };
  const newer = lines('bash32-newer.txt');
  t('the bash 4+ fixture has cases', newer.length >= 40, true);
  newer.forEach((l, i) => { const r = one(l, i); t(`fires: ${l}`, [r.status, /FAIL bash-3.2 features/.test(r.stdout)], [1, true]); });
  lines('bash32-ok.txt').forEach((l, i) => { const r = one(l, 1000 + i); t(`3.2-safe passes: ${l}`, r.status, 0); });
  t('a comment line is not scanned', one('  # x=${y,,} in a comment', 2000).status, 0);
  t('# bash32: ok excuses a line', one('x=${y,,}  # bash32: ok (a test of the escape)', 2001).status, 0);
  t('a missing file fails', scan(join(T, 'nope.sh')).status, 1);
  const shells = [...repoMap(R).shells].sort();
  const repo = scan(...shells.map((f) => join(R, f)));
  t(`all ${shells.length} shell scripts in the repo pass the scan`, [repo.status, (repo.stdout.match(/^ok {3}bash-3.2 features/gm) ?? []).length], [0, shells.length]);
  if (repo.status) console.log(repo.stdout.split('\n').filter((l) => !l.startsWith('ok')).join('\n'));
} finally { rmSync(T, { recursive: true, force: true }); }
console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
