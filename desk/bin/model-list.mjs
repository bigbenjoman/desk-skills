#!/usr/bin/env node
// The models the installed Claude Code CLI offers this login, one `value` per line.
//   model-list.mjs [<extra claude flag>…]
//
// Read from the CLI's `initialize` control response (stream-json input, as the Agent SDK's
// supportedModels() reads it). No user message is sent, so the call spends no model turn: spawn-worker.sh
// checks §3b Worker models' finder= and text= values against this list before it pays for a one-word
// probe on each (DS-696). Exit 0 with the list; exit 1 when the CLI gave none (a CLI without the
// request, an error response, a timeout), and the caller keeps its paid probe.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ID = 'desk-model-list';
const TIMEOUT_MS = 30000;

// The `value` of each model a stream of the CLI's stdout lines lists in its answer to our request, or
// null while (or if) no such answer is among them.
export function listedModels(lines) {
  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== 'control_response' || d.response?.request_id !== ID) continue;
    const models = d.response.subtype === 'success' ? d.response.response?.models : null;
    if (!Array.isArray(models)) return [];
    return models.map((m) => (typeof m === 'string' ? m : m?.value)).filter((v) => typeof v === 'string' && v);
  }
  return null;
}

function main(extra) {
  const child = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--setting-sources', '', '--strict-mcp-config', ...extra], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let done = false;
  const finish = (models) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { child.stdin.end(); } catch {}
    child.kill('SIGTERM');
    if (models?.length) process.stdout.write(`${models.join('\n')}\n`);
    process.exitCode = models?.length ? 0 : 1;
  };
  const timer = setTimeout(() => finish(null), TIMEOUT_MS);
  child.on('error', () => finish(null));
  child.stdin.on('error', () => {});
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    const models = listedModels(lines);
    if (models) finish(models);
  });
  child.on('close', () => finish(listedModels([buf])));
  child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: ID, request: { subtype: 'initialize' } })}\n`);
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main(process.argv.slice(2));
