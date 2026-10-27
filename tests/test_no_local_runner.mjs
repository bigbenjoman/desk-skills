// suite: no local CI runner (nothing in desk points at the retired runner VM)
// desk no longer ships a CI runner VM, its slots or the memory turns, and nothing points a repo's CI
// at one. A tracked file that names any of them fails, outside the design records under docs/design/
// and the blocks marked `retired local CI runner` that remove an old install's files.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'tests/test_no_local_runner.mjs';
const NAMES = ['desk-runner', 'runner-slot', 'runner-probe', 'mem-turns', 'desk-local-pr', 'DESK_RUNS_ON'];

let out = '';
try {
  out = execFileSync('git', ['grep', '-n', '-i', ...NAMES.flatMap((n) => ['-e', n]), '--', '.', ':!docs/design', `:!${SELF}`],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { if (e.status !== 1) throw e; } // 1: no match

// The 1-based line numbers inside each `# retired local CI runner` … `# end retired local CI runner` block.
const retired = new Map();
const inRetired = (file, n) => {
  if (!retired.has(file)) {
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    const keep = new Set();
    let open = false;
    lines.forEach((l, i) => {
      if (/^\s*# end retired local CI runner\b/.test(l)) { keep.add(i + 1); open = false; return; }
      if (/^\s*# retired local CI runner\b/.test(l)) open = true;
      if (open) keep.add(i + 1);
    });
    retired.set(file, keep);
  }
  return retired.get(file).has(n);
};

const hits = out.split('\n').filter(Boolean).map((l) => /^([^:]+):(\d+):(.*)$/.exec(l)).filter(Boolean);
const stray = hits.filter(([, file, n]) => !inRetired(file, Number(n)));
t('no tracked file names the local runner outside docs/design and the retired blocks', stray.map(([l]) => l.slice(0, 160)).join('\n  '), '');
t('the installer still removes an old install\'s runner', hits.some(([, file]) => file === 'install.sh'), true);
for (const f of ['desk/bin/desk-runner', 'desk/bin/runner-slot.sh', 'desk/bin/runner-probe.sh', 'desk/bin/mem-turns.mjs']) {
  t(`${f} is not tracked`, execFileSync('git', ['ls-files', f], { cwd: ROOT, encoding: 'utf8' }).trim(), '');
}

console.log(fails ? `${fails} FAILED` : 'no local runner: all checks passed');
process.exit(fails ? 1 : 0);
