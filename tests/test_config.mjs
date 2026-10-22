// suite: config values (list items, trailing notes)
// Config value cells: one item per backtick span, except spans inside a trailing parenthesised note.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cellItems } from '../desk/bin/desk-env.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const items = (cell) => cellItems(cell).join(' | ');

t('a note with backticks adds no item', items('`ABC` (not `parent`)'), 'ABC');
t('a list keeps every span before the note', items('`A` `B, C` (two `items`)'), 'A | B, C');
t('a note without backticks', items('`ABC` (the main project)'), 'ABC');
t('nested parens in the note', items('`ABC` (not `x` (or `y`))'), 'ABC');
t('parens inside a span are value text', items('`P[0-9]+(-FIX)?` (planning `ids`)'), 'P[0-9]+(-FIX)?');
t('a span ending in a paren, no note', items('`foo (bar)`'), 'foo (bar)');
t('a mid-cell parenthesis is not trailing', items('`A` (x) `B`'), 'A | B');
t('a note-only cell is left whole', items('(`a`)'), 'a');
t('doubled display backticks', items('`` `A` `B` `` (see `C`)'), 'A | B');
t('no spans: the cell is the item', items('none (no tracker)'), 'none (no tracker)');

// End to end: `desk-env list` on a §4 row that carries a note.
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'desk-env.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-config-'));
const cfg = join(T, 'config.md');
writeFileSync(cfg, '## 4. Tracker\n\n| Field | Value |\n|---|---|\n'
  + '| Other work id patterns | `BUG-[0-9]+` `P[0-9]+-M[0-9]+(-FIX)?-[0-9]+` (not `roadmap-fw-3xx`) |\n');
const out = execFileSync('node', [BIN, 'list', 'work-id-patterns'], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: cfg, DESK_MACHINE: join(T, 'none.md'), HOME: T } }).trim();
t('desk-env list skips the note', out.split('\n').join(' | '), 'BUG-[0-9]+ | P[0-9]+-M[0-9]+(-FIX)?-[0-9]+');

// The design rows, by key: §2's value column sits before its Notes column.
const design = join(T, 'design.md');
writeFileSync(design, '## 2. Paths on your machine\n\n| Field | Value | Notes |\n|---|---|---|\n'
  + '| Design canvases directory | `docs/design/` | committed, not `~/Downloads/` |\n\n'
  + '## 5. Conventions\n\n| Field | Value |\n|---|---|\n'
  + '| Breakpoints | `375` `768` `1024` `1280` `1920` (from `scripts/audit.ts:65`) |\n'
  + '| Design system | `src/styles/tokens.css` `DESIGN.md` |\n');
const env = { ...process.env, DESK_CONFIG: design, DESK_MACHINE: join(T, 'none.md'), HOME: T };
const run = (...a) => execFileSync('node', [BIN, ...a], { encoding: 'utf8', env }).trim().split('\n').join(' | ');
t('design-dir reads the value column', run('get', 'design-dir'), 'docs/design/');
t('breakpoints lists every width', run('list', 'breakpoints'), '375 | 768 | 1024 | 1280 | 1920');
t('design-system lists every file', run('list', 'design-system'), 'src/styles/tokens.css | DESIGN.md');

// `none` stands alone: beside another item it is a note in backticks, refused rather than run.
const tool = join(T, 'tool.md');
writeFileSync(tool, '## 4. Toolchain\n\n| Field | Value |\n|---|---|\n'
  + '| Install | `none` — `./install.sh` installs to your machine |\n'
  + '| Unit tests | `none` (`./install.sh` is not a suite) |\n'
  + '| Lint | `none` |\n');
const toolEnv = { ...process.env, DESK_CONFIG: tool, DESK_MACHINE: join(T, 'none.md'), HOME: T };
const refused = (...a) => {
  try { execFileSync('node', [BIN, ...a], { encoding: 'utf8', env: toolEnv, stdio: 'pipe' }); return 'exit 0'; }
  catch (e) { return `exit ${e.status}: ${String(e.stderr).trim()}`; }
};
for (const sub of ['cmds', 'list']) {
  const r = refused(sub, 'install-cmd');
  t(`${sub} refuses a mixed none row`, /^exit 4: .*§4 "Install" mixes `none` with other items \(none \| \.\/install\.sh\).*move the note out of backticks/.test(r), true);
}
const plain = (...a) => execFileSync('node', [BIN, ...a], { encoding: 'utf8', env: toolEnv }).trim();
t('cmds prints nothing for a plain none', plain('cmds', 'lint-cmd'), '');
t('list prints a plain none', plain('list', 'lint-cmd'), 'none');
t('a backticked note in trailing parens is still one none', plain('cmds', 'test-cmd'), '');

// The worker rows (DS-135): known ids, `no` when the row is missing, read by key when it is there.
const perms = join(T, 'perms.md');
writeFileSync(perms, '## 3. Permissions\n\n| Key | Capability | Recommended | Your setting |\n|---|---|---|---|\n'
  + '| `worker-screenshots` | Capture | `ask` | `yes` |\n| `worker-local-services` | Start | `ask` | `ask` |\n');
const perm = (id) => execFileSync('node', [BIN, 'perm', id], { encoding: 'utf8', env: { ...process.env, DESK_CONFIG: perms, DESK_MACHINE: join(T, 'none.md'), HOME: T } }).trim();
t('worker-dependency-install missing reads as no', perm('worker-dependency-install'), 'no');
t('worker-screenshots reads its row', perm('worker-screenshots'), 'yes');
t('worker-local-services reads its row', perm('worker-local-services'), 'ask');
rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'config: all checks passed');
process.exit(fails ? 1 : 0);
