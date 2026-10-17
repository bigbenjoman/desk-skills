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
rmSync(T, { recursive: true, force: true });

console.log(fails ? `${fails} FAILED` : 'config: all checks passed');
process.exit(fails ? 1 : 0);
