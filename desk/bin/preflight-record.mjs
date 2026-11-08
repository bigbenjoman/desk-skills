// Keeps each spawn preflight's call for the bench to replay (bench-replay.mjs): spawn-worker.sh runs
// it right after the call, before any check tidies up. Under <state>/preflight/, one call is
// <TICKET>-<time>.prompt.md (the prompt), .json (the raw reply), .inputs.json (what the checks ran
// against, and which of the files they write were there after the call), and copies of the settings
// and agents files the call was given. Records older than KEEP_DAYS go when a new one is written.
//
//   node preflight-record.mjs --state <dir> --ticket <KEY> --prompt <text> --worktree <dir> --canary <path>
//     --settings <file> --agents <file> [--model <m>] [--effort <e>] [--tools <list>] [--agent-names <names>]
//     [--probe <cmd>]… [--add-dir <dir>]… [--gate <k>=<v>]…  < raw reply
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEP_DAYS = 14;
export const preflightDir = (state) => join(state, 'preflight');

// The file names one call's record uses, from its base name.
export const recordFiles = (dir, base) => ({
  prompt: join(dir, `${base}.prompt.md`), reply: join(dir, `${base}.json`), inputs: join(dir, `${base}.inputs.json`),
  settings: join(dir, `${base}.settings.json`), agents: join(dir, `${base}.agents.json`),
});

// Writes one call's record and prunes old ones. -> the record's base name
export function recordPreflight({ state, ticket, prompt, raw, inputs, settingsFile, agentsFile, now = new Date() }) {
  const dir = preflightDir(state);
  mkdirSync(dir, { recursive: true });
  const base = `${ticket}-${now.toISOString().replace(/[:.]/g, '-')}`;
  const f = recordFiles(dir, base);
  writeFileSync(f.prompt, prompt);
  writeFileSync(f.reply, raw);
  writeFileSync(f.inputs, `${JSON.stringify({ ticket, at: now.toISOString(), ...inputs }, null, 2)}\n`);
  if (settingsFile && existsSync(settingsFile)) copyFileSync(settingsFile, f.settings);
  if (agentsFile && existsSync(agentsFile)) copyFileSync(agentsFile, f.agents);
  const cutoff = now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch { /* gone already */ }
  }
  return base;
}

// argv -> the record's fields. Repeated flags gather into lists.
export function parseArgs(argv) {
  const one = { '--state': 'state', '--ticket': 'ticket', '--prompt': 'prompt', '--worktree': 'worktree', '--canary': 'canary',
    '--settings': 'settings', '--agents': 'agents', '--model': 'model', '--effort': 'effort', '--tools': 'tools', '--agent-names': 'agentNames' };
  const many = { '--probe': 'probes', '--add-dir': 'addDirs', '--gate': 'gates' };
  const o = { probes: [], addDirs: [], gates: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = one[argv[i]] ?? many[argv[i]];
    if (!k || i + 1 >= argv.length) throw new Error(`preflight-record: bad argument ${argv[i]}`);
    if (one[argv[i]]) o[k] = argv[i + 1]; else o[k].push(argv[i + 1]);
  }
  for (const k of ['state', 'ticket', 'prompt', 'worktree', 'canary']) if (!o[k]) throw new Error(`preflight-record: --${k} is required`);
  return o;
}

// The record's inputs from the parsed arguments, reading the files the checks write as they are now.
export function inputsOf(o) {
  return {
    worktree: o.worktree, canary: o.canary, model: o.model || null, effort: o.effort || null,
    tools: o.tools || null, add_dirs: o.addDirs, probes: o.probes,
    agent_names: String(o.agentNames ?? '').split(/[\s,]+/).filter(Boolean),
    gates: Object.fromEntries(o.gates.map((g) => { const i = g.indexOf('='); return i < 0 ? [g, ''] : [g.slice(0, i), g.slice(i + 1)]; })),
    files: { w_in: existsSync(join(o.worktree, '.preflight.tmp')), w_out: existsSync(o.canary), escape: existsSync(`${o.canary}.bash`) },
  };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  try {
    const o = parseArgs(process.argv.slice(2));
    const raw = readFileSync(0, 'utf8');
    recordPreflight({ state: o.state, ticket: o.ticket, prompt: o.prompt, raw, inputs: inputsOf(o), settingsFile: o.settings, agentsFile: o.agents });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
