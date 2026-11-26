// The per-file collision budget (config §3b "Per-file collision budget"): a ready ticket waits while
// any file its triage record names is already named by as many running tickets as that file's places.
// The pass decides spawns with it, and desk-q says why a ready ticket waits with the same functions, so
// the two never disagree.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeJsonAtomic } from './dir-lock.mjs';
import { loweredBy } from './conflict-record.mjs';

// The files a triage record names, less those an append-only glob (RegExps) covers, which are only
// added to and have no limit.
export const scopeFiles = (rec, appendOnly = []) => {
  const files = rec?.files_in_scope;
  return [...new Set(Array.isArray(files) ? files.map((f) => String(f).replace(/^\.\//, '')) : [])].filter((f) => f && !appendOnly.some((re) => re.test(f)));
};

// A file's configured places: 1 for a file a serial glob (RegExps) covers, else the budget's big or
// small count by its length on the base (`lines(f)`, read only when the two differ).
export const configuredPlaces = (f, { budget, serial = [], lines }) => (serial.some((re) => re.test(f)) ? 1
  : budget.big === budget.small ? budget.small
  : lines(f) > budget.lines ? budget.big : budget.small);

// Its places now: configured, lowered by its merge-time conflicts (`conflictsBy`, Map file -> [ms]).
export const placesFor = (f, { conflictsBy = new Map(), now = Date.now(), ...opts }) => {
  const k = configuredPlaces(f, opts);
  return conflictsBy.has(f) ? k - loweredBy(conflictsBy.get(f), k, now) : k;
};

// Each of `files` (ticket `key`'s) at its budget, as { file, k, by, elsewhere }: `running` is this
// batch's running tickets that fill places, [{ key, files }]; `elsewhere` the repo's other batches',
// [{ key, batch, files }]; `places(f)` a file's places. A review try fills none: it is left out, or
// given no files.
export function budgetHolds({ key, files, running, elsewhere = [], places }) {
  const here = new Set(running.map((o) => o.key));
  const holds = [];
  for (const f of files) {
    const by = running.filter((o) => o.key !== key && o.files.includes(f)).map((o) => o.key);
    const away = elsewhere.filter((o) => o.key !== key && !here.has(o.key) && o.files.includes(f)).map(({ key: k, batch }) => ({ key: k, batch }));
    if (!by.length && !away.length) continue;
    const k = places(f);
    if (by.length + away.length >= k) holds.push({ file: f, k, by, elsewhere: away });
  }
  return holds;
}

// Files' lengths on a ref of the checkout at `main`: each ref's tree is listed once (one git call, not
// one per file), and each blob's length is kept across runs by its id in `cacheFile` (written only
// where `write`), so only a blob not counted before is read. A file no ref has is 0 lines.
const GIT_BIG = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 };
export function lineCounter({ main, cacheFile = null, write = false }) {
  const trees = new Map();
  const counts = new Map();
  let blobLines = null;
  const treeOf = (ref) => {
    if (!trees.has(ref)) {
      let t = null;
      try {
        t = new Map();
        for (const e of execFileSync('git', ['-C', main, 'ls-tree', '-r', '-z', ref], GIT_BIG).split('\0')) {
          const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(e);
          if (m) t.set(m[2], m[1]);
        }
      } catch { t = null; }
      trees.set(ref, t);
    }
    return trees.get(ref);
  };
  const linesOfBlob = (sha) => {
    if (!blobLines) {
      try { blobLines = cacheFile ? JSON.parse(readFileSync(cacheFile, 'utf8')) : null; } catch { /* none yet */ }
      if (!blobLines || typeof blobLines !== 'object') blobLines = {};
    }
    if (Number.isInteger(blobLines[sha])) return blobLines[sha];
    const n = execFileSync('git', ['-C', main, 'cat-file', 'blob', sha], GIT_BIG).split('\n').length - 1;
    blobLines[sha] = n;
    if (write && cacheFile) {
      // Only blobs still on a listed ref are kept, so the file holds about one entry per counted file.
      const live = new Set([...trees.values()].flatMap((t) => (t ? [...t.values()] : [])));
      const keep = Object.fromEntries(Object.entries(blobLines).filter(([s]) => live.has(s)));
      try { writeJsonAtomic(cacheFile, keep); } catch { /* counted again next run */ }
    }
    return n;
  };
  return {
    // The file's length on the first of `refs` that has it.
    lines(f, refs) {
      const id = `${refs.join('\0')}\0${f}`;
      if (!counts.has(id)) {
        let n = 0;
        for (const ref of refs) {
          const sha = treeOf(ref)?.get(f);
          if (!sha) continue;
          try { n = linesOfBlob(sha); break; } catch { /* unreadable on that ref */ }
        }
        counts.set(id, n);
      }
      return counts.get(id);
    },
    // Forget the trees and lengths read: a ref may have moved.
    clear() { trees.clear(); counts.clear(); },
  };
}
