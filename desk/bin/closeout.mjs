#!/usr/bin/env node
// Tells the batch about an interactive close-out. Once a desk-ticket or desk-pr session merges a ticket's
// last PR or moves it to Done, a ticket this repo's batch queue still holds unfinished gets a note in that
// batch's state, <state>/closed-out/<TICKET>.json, and the orchestrator's next pass records it done
// (pass.mjs): only the orchestrator writes its queue. A ticket in no batch, or already done there, writes
// nothing and prints nothing.
//
//   closeout.mjs <TICKET> [--pr <n>] [--how merged|done]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';

export const closedOutDir = (state) => join(state, 'closed-out');
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };

// Writes the note when the queue holds the ticket unfinished: {path, batch, state}, or null.
export function noteCloseout({ queue, state, ticket, pr = null, how = 'merged', now = new Date() }) {
  const q = readJson(queue, null);
  const t = q?.tickets?.[ticket];
  if (!t || t.state === 'done') return null;
  mkdirSync(closedOutDir(state), { recursive: true });
  const path = join(closedOutDir(state), `${ticket}.json`);
  writeFileSync(path, `${JSON.stringify({ ticket, how, pr, at: now.toISOString(), queue })}\n`);
  return { path, batch: q.batch ?? null, state: t.state };
}

// Every note waiting for a pass: [{ticket, how, pr, at, queue, file}]. An unreadable note is skipped, and kept.
export function readCloseouts(state) {
  const dir = closedOutDir(state);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().flatMap((f) => {
    const n = readJson(join(dir, f), null);
    return n && typeof n.ticket === 'string' && E.SAFE_ID.test(n.ticket) ? [{ ...n, file: join(dir, f) }] : [];
  });
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1] ?? ''; };
  const pr = opt('--pr');
  const how = opt('--how') ?? 'merged';
  const [ticket] = args;
  const usage = 'usage: closeout.mjs <TICKET> [--pr <n>] [--how merged|done]';
  if (!ticket || !E.SAFE_ID.test(ticket) || args.length > 1) { console.error(usage); process.exit(2); }
  if (pr != null && !/^\d+$/.test(pr)) { console.error(`--pr wants a PR number, not "${pr}". ${usage}`); process.exit(2); }
  if (!['merged', 'done'].includes(how)) { console.error(`--how is merged or done, not "${how}". ${usage}`); process.exit(2); }
  const r = noteCloseout({ queue: E.queueFile(), state: E.stateDir(), ticket, pr: pr == null ? null : Number(pr), how });
  if (r) console.log(`${ticket} is ${r.state} in batch ${r.batch ?? '(unnamed)'}: noted for its orchestrator, whose next pass records it done (${r.path})`);
}
