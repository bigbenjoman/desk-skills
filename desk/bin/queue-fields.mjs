// A queue as one value per field path, and the paths two queues differ at. The pass's ledger
// difference check compares queue.json with the queue rebuilt from the ticket ledger this way, and
// tests/compare_pass.mjs compares the queues two source trees wrote.

// A queue stamp says when a writer last wrote a ticket or started its worker. Where the load of the
// machine put that write decides its value, so a stamp is compared as set or not, and by its type.
export const STAMP = /(?:^|[ .])(?:updated_at|spawned_at|last_start|cloud\.started)$/;
export const stampLeaf = (v, path) => (v != null && STAMP.test(path) ? `<STAMP:${typeof v}>` : null);
const plainLeaf = (v, path) => stampLeaf(v, path) ?? JSON.stringify(v);

// Every leaf of `rec.queue` and `rec.archive` (each a queue document, or null) as a Map of path to
// text: "T-1 state" for a ticket's field, "T-1 park.question" below it, "archive T-1 state" in the
// archive, "queue <path>" for the queue's own fields. `key(k)` writes each key in a path, and
// `leaf(v, path)` each value.
export function flattenQueue(rec, { key = (k) => k, leaf = plainLeaf } = {}) {
  const out = new Map();
  const walk = (v, path) => {
    if (v && typeof v === 'object' && Object.keys(v).length) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${key(k)}` : key(k));
    } else out.set(path, leaf(v, path));
  };
  const top = (doc, prefix) => {
    if (!doc) return;
    for (const [k, v] of Object.entries(doc)) {
      if (k === 'tickets' && v && typeof v === 'object') {
        for (const [t, x] of Object.entries(v)) {
          if (x && typeof x === 'object') for (const [f, y] of Object.entries(x)) walk(y, `${prefix}${key(t)} ${key(f)}`);
          else out.set(`${prefix}${key(t)}`, leaf(x, `${prefix}${key(t)}`));
        }
      } else walk(v, `${prefix || 'queue '}${key(k)}`);
    }
  };
  top(rec.queue, '');
  top(rec.archive, 'archive ');
  return out;
}

// The paths at which flattened queues `a` and `b` differ, sorted: [{ path, a, b }], a side without
// the path holding undefined.
export function fieldDiffs(a, b) {
  return [...new Set([...a.keys(), ...b.keys()])].sort()
    .filter((p) => a.get(p) !== b.get(p))
    .map((path) => ({ path, a: a.get(path), b: b.get(path) }));
}
