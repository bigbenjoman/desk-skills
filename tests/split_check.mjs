// The checks a skill split shares: a SKILL.md moved into a core and reference files must keep every
// heading, table row and paragraph of the file before the split, each in exactly one of the new files.
// A suite imports checkSplit and passes its own assertion function, so the lines it prints are its own.
//
//   checkSplit({ t, label, before, files, read, headings, minRows })
//
// `before` is the old file's text, `files` the new files' names, `read(f)` a file's text. `headings`
// is how many the old file had and `minRows` the fewest table body rows it may have, so a fixture that
// stops being read fails rather than passing with nothing to check. checkSize, stepTable and
// paragraphs are the AC1 size check, the core's step table and the paragraph split, for a suite that
// checks those too.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const norm = (s) => s.replace(/\s+/g, ' ').trim();

// A file's paragraphs, normalised: blank-line blocks, with each list item its own, and tables left out.
export const paragraphs = (text) => text.split(/\n[ \t]*\n|\n(?=[ \t]*(?:[-*]|\d+\.) )/).filter((p) => !/^\|/.test(p.trimStart())).map(norm).filter(Boolean);

// The core is at most 20,480 bytes, the bound is a real one, and the skill is off the size check's
// allow-list.
export function checkSize({ t, root, name, core, before }) {
  const CAP = 20480;
  const within = (s) => Buffer.byteLength(s) <= CAP;
  t(`AC1 the core is at most 20,480 bytes (${Buffer.byteLength(core)} bytes)`, within(core), true);
  t('AC1 the size check fails one byte over', within('x'.repeat(CAP + 1)), false);
  t('AC1 and the file before the split would have failed it', within(before), false);
  const unsplit = readFileSync(join(root, 'tests/test_skill_size.mjs'), 'utf8').match(/^const UNSPLIT = \[([^\]]*)\]/m);
  t('AC1 the size check\'s UNSPLIT list is read', Boolean(unsplit), true);
  t(`AC1 ${name} is off UNSPLIT`, unsplit?.[1].includes(`'${name}'`) ?? true, false);
}

// The core's step table: for each step, the sections it moved (in *italics*) and the one file to read.
export const stepTable = (core) => [...core.matchAll(/^\| ([^|]+) \| ([^|]+) \| `references\/([\w.-]+\.md)` \|$/gm)]
  .map((m) => ({ step: m[1], sections: [...m[2].matchAll(/\*([^*]+)\*/g)].map((x) => x[1]), file: m[3] }));

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
  const paras = paragraphs(before);
  const counts = paras.map((p) => after.filter((a) => a.includes(p)).length);
  const dropped = paras.filter((_, i) => counts[i] === 0);
  // A heading is counted line by line above; as a substring, "# x" is also inside every "## x".
  const twice = paras.filter((p, i) => counts[i] > 1 && !/^#{1,6} /.test(p));
  t(`${label} every paragraph of the old file survives the split (${paras.length} read)`, dropped.length, 0);
  for (const p of dropped) console.log(`     dropped: ${p.slice(0, 120)}`);
  t(`${label} and each is in exactly one file`, twice.map((p) => p.slice(0, 80)).join(' / '), '');
}
