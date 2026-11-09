// Runs a command, passing its stdout through line by line, and ends its whole process group the moment
// a line records a request using overage (bench-credits.mjs). A synchronous caller cannot watch a
// stream while it waits, so bench-arm3.mjs's Fable side runs claude through this file:
//   node overage-watch.mjs <command> [args...]
// Sent SIGTERM (the caller's timeout), it ends the group too.
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { usingOverage } from './bench-credits.mjs';

const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'pipe', 'inherit'], detached: true });
const end = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
for (const [sig, n] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]]) process.on(sig, () => { end(); process.exit(128 + n); });
child.on('error', (e) => { console.error(`could not run ${process.argv[2]}: ${e.message}`); process.exit(127); });
child.on('close', (code) => process.exit(code ?? 137));
let partial = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  writeSync(1, d);
  const lines = (partial + d).split('\n');
  partial = lines.pop();
  if (lines.some(usingOverage)) end();
});
