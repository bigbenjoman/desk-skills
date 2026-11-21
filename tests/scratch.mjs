// A suite's scratch directory under the temp dir, removed when the process exits, pass or fail, so
// local runs never leave them behind. /tmp on WSL is a tmpfs with a fixed count of inodes, and suites
// that each left a fake desk home there once used every one, which stopped every shell on the machine.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const made = [];
process.on('exit', () => {
  for (const d of made) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* gone already, or busy: nothing to keep */ }
  }
});

// Interrupted (Ctrl-C, a kill from the runner), the process exits through the hook above.
for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15]]) process.once(sig, () => process.exit(128 + n));

export function scratch(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
