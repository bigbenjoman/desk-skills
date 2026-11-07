#!/usr/bin/env node
// The memory digest a worker gets in its brief when the memory lever is on, or when it runs on another
// login: the repo's auto-memory index (MEMORY.md) entry by entry, in order, up to DIGEST_CAP bytes, with
// how many were cut. Its size goes into the worker's log, beside the preflight's cost line.
//
//   node memory-digest.mjs <memory dir> [--log <worker log>]
//       prints the brief's digest section (nothing when there is no index), and with --log appends
//       one {"type":"desk_memory_digest",…} line to that log
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIGEST_CAP = 6144;
const DIGEST_EVENT = 'desk_memory_digest';

// The index's entries: every line but blank lines and headings, each a one-line pointer.
export const indexEntries = (text) => String(text).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !/^\s*#/.test(l));

// -> null when the folder or its index is missing or holds no entry, else
//    { text, entries, kept, cut, bytes }, `bytes` being the kept entries' size, newlines included.
export function memoryDigest(dir) {
  let index;
  try { index = readFileSync(join(dir, 'MEMORY.md'), 'utf8'); } catch { return null; }
  const all = indexEntries(index);
  if (!all.length) return null;
  const kept = [];
  let bytes = 0;
  for (const e of all) {
    const b = Buffer.byteLength(e) + 1;
    if (bytes + b > DIGEST_CAP) break;
    kept.push(e);
    bytes += b;
  }
  const cut = all.length - kept.length;
  const said = cut
    ? `${kept.length} of its ${all.length} entries, cut at ${DIGEST_CAP} bytes: ${cut} ${cut === 1 ? 'entry was' : 'entries were'} cut.`
    : `all ${all.length} of its entries: nothing was cut.`;
  const text = `# Memory digest

Auto-memory is off for this session, and the memory folder is not yours to read or write. This is the repo's memory index, ${said} The files it links to are not loaded.

${kept.join('\n')}`;
  return { text, entries: all.length, kept: kept.length, cut, bytes };
}

export const digestLine = (d, at = new Date()) =>
  `${JSON.stringify({ type: DIGEST_EVENT, bytes: d.bytes, entries: d.entries, kept: d.kept, cut: d.cut, at: at.toISOString() })}\n`;

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--log');
  const log = i >= 0 ? args[i + 1] : null;
  const [dir, ...extra] = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
  if (!dir || extra.length || (i >= 0 && !log)) { console.error('usage: memory-digest.mjs <memory dir> [--log <worker log>]'); process.exit(2); }
  const d = memoryDigest(dir);
  if (d) {
    process.stdout.write(d.text);
    if (log) { try { appendFileSync(log, digestLine(d)); } catch { /* a record that cannot be written never stops a spawn */ } }
  }
}
