// The checks a skill split shares: a SKILL.md moved into a core and reference files must keep every
// heading, table row and paragraph of the file before the split, each in exactly one of the new files.
// A suite imports checkSplit and passes its own assertion function, so the lines it prints are its own.
//
//   checkSplit({ t, label, before, files, read, headings, minRows })
//
// `before` is the old file's text, `files` the new files' names, `read(f)` a file's text. `headings`
// is how many the old file had and `minRows` the fewest table body rows it may have, so a fixture that
// stops being read fails rather than passing with nothing to check.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Every file under a directory whose name ends with one of the extensions.
export const walk = (d, exts = ['.md']) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), exts) : exts.some((x) => e.name.endsWith(x)) ? [join(d, e.name)] : []));

export function checkSplit({ t, label, before, files, read, headings: headingCount, minRows }) {
  const lines = (f) => read(f).split('\n').map((l) => l.trim());
  const headings = before.split('\n').filter((l) => /^#{1,3} /.test(l));
  t(`${label} the old file has its ${headingCount} headings`, headings.length, headingCount);
  for (const h of headings) t(`${label} "${h}" is in exactly one file`, files.filter((f) => lines(f).includes(h)).length, 1);

  // A header or separator row repeats in every file that holds part of its table, so only body rows
  // must be in exactly one.
  const all = before.split('\n').map((l) => l.trim());
  const rows = all.filter((l) => /^\|/.test(l));
  const header = new Set(all.flatMap((l, i) => (/^\|/.test(l) && /^\|[-| ]+\|$/.test(all[i + 1] || '') ? [l] : [])));
  const body = rows.filter((r) => !header.has(r) && !/^\|[-| ]+\|$/.test(r));
  t(`${label} the old file's table rows are read (${body.length} body rows)`, body.length >= minRows, true);
  for (const r of rows) {
    const n = files.filter((f) => lines(f).includes(r)).length;
    if (body.includes(r)) t(`${label} row "${r.slice(0, 60)}" is in exactly one file`, n, 1);
    else t(`${label} header "${r.slice(0, 40)}" is in a file`, n >= 1, true);
  }

  // Word for word, whitespace aside: the split moves text, it does not reword it, and it does not
  // leave a copy behind.
  const after = files.map((f) => norm(read(f)));
  const paras = before.split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.) )/).filter((p) => !/^\|/.test(p.trimStart())).map(norm).filter(Boolean);
  const counts = paras.map((p) => after.filter((a) => a.includes(p)).length);
  const dropped = paras.filter((_, i) => counts[i] === 0);
  // A heading is counted line by line above; as a substring, "# x" is also inside every "## x".
  const twice = paras.filter((p, i) => counts[i] > 1 && !/^#{1,6} /.test(p));
  t(`${label} every paragraph of the old file survives the split (${paras.length} read)`, dropped.length, 0);
  for (const p of dropped) console.log(`     dropped: ${p.slice(0, 120)}`);
  t(`${label} and each is in exactly one file`, twice.map((p) => p.slice(0, 80)).join(' / '), '');
}
