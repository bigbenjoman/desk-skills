// The prose baseline only shrinks: a pull request whose tests/fixtures/prose_baseline.json holds an
// entry its base does not fails, naming it. Entries are counted by kind, value and context, without
// the file, so moving a reference into another file and its entry with it is not growth.
//
//   node tests/prose_baseline_guard.mjs --base <ref>        # the baseline at <ref> against the working tree's
//
// CI runs it for every pull request, against its base (HEAD^1 of the merge commit). A
// baseline missing at the base counts as empty. Exit 1 on growth, 2 on a usage error, 0 otherwise.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const BASELINE_PATH = 'tests/fixtures/prose_baseline.json';
const keyOf = (e) => JSON.stringify([e.kind, e.value, e.context]);

// The head's entries beyond the base's count of each kind, value and context.
export function grown(base, head) {
  const left = new Map();
  for (const e of base) left.set(keyOf(e), (left.get(keyOf(e)) ?? 0) + 1);
  const out = [];
  for (const e of head) {
    const n = left.get(keyOf(e)) ?? 0;
    if (n) left.set(keyOf(e), n - 1);
    else out.push(e);
  }
  return out;
}

export const report = (e) => `${BASELINE_PATH} gains an entry: ${e.file}: ${e.kind} ${e.value} (in: ${e.context})`;

const parse = (text) => JSON.parse(text || '[]');
function atRef(ref) {
  try { return execFileSync('git', ['show', `${ref}:${BASELINE_PATH}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] !== '--base' || !args[1] || args.length !== 2) {
    console.error('usage: prose_baseline_guard.mjs --base <ref>');
    process.exit(2);
  }
  const base = parse(atRef(args[1]));
  const head = parse(existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, 'utf8') : '');
  const added = grown(base, head);
  for (const e of added) console.log(report(e));
  console.log(added.length
    ? `The prose baseline only shrinks: fix each reference, or keep it with a prose-ok opt-out and its reason, rather than adding it to ${BASELINE_PATH}.`
    : `the prose baseline does not grow (${base.length} entries at the base, ${head.length} now)`);
  process.exit(added.length ? 1 : 0);
}
