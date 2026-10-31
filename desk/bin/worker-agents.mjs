#!/usr/bin/env node
// Build the --agents file a headless worker is launched with.
//
//   worker-agents.mjs --out <file> [--wt <worktree>]
//
// Workers run with --setting-sources "", which drops ~/.claude/agents along with the rest of the
// user's settings, so without this every named desk-review seat resolves to general-purpose. Each
// seat comes from <worktree>/.claude/agents/<name>.md where the repo overrides it, else
// ~/.claude/agents/<name>.md. Only its description, prompt, model and tool lists are carried:
// frontmatter that could widen what the worker may do (permissionMode, hooks, mcpServers) or reach
// outside its sandbox (memory) is dropped, so the agents are the only user setting a worker gets.
//
// Prints `AGENTS: <names>` and writes the file; exits 1 naming every seat with no usable file.
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every named agent desk-review dispatches: its finder seats (Phase 2), Bea (Phase 5) and the
// same-vendor refuter (Phase 4).
export const REVIEW_AGENTS = [
  'lena-code-reviewer', 'nadia-security-auditor', 'theo-api-designer', 'mira-playwright-expert',
  'jim-solution-architect', 'suki-frontend-architect', 'bea-business-analyst', 'ada-devils-advocate',
];

const scalar = (v) => {
  const s = String(v).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
};
const list = (v) => {
  if (v == null) return undefined;
  const items = Array.isArray(v) ? v : String(v).replace(/^\[|\]$/g, '').split(',');
  const out = items.map(scalar).filter(Boolean);
  return out.length ? out : undefined;
};

// An agent file's frontmatter (flat keys, quoted or bare values, block or inline lists) and body.
export function parseAgent(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const fm = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (kv) { key = kv[1]; fm[key] = kv[2].trim() === '' ? [] : scalar(kv[2]); continue; }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key && Array.isArray(fm[key])) fm[key].push(scalar(item[1]));
  }
  return { fm, prompt: (m[2] ?? '').trim() };
}

export function buildAgents({ home, wt }) {
  const dirs = [wt && join(wt, '.claude', 'agents'), join(home, '.claude', 'agents')].filter(Boolean);
  const agents = {};
  const missing = [];
  for (const name of REVIEW_AGENTS) {
    const file = dirs.map((d) => join(d, `${name}.md`)).find((f) => existsSync(f));
    if (!file) { missing.push(`${name} (not in ${dirs.join(' or ')})`); continue; }
    const a = parseAgent(readFileSync(file, 'utf8'));
    const description = a && typeof a.fm.description === 'string' ? a.fm.description.trim() : '';
    if (!description || !a.prompt) { missing.push(`${name} (${file} has no description or no prompt)`); continue; }
    const entry = { description, prompt: a.prompt };
    if (typeof a.fm.model === 'string' && a.fm.model) entry.model = a.fm.model;
    const tools = list(a.fm.tools);
    if (tools) entry.tools = tools;
    const disallowed = list(a.fm.disallowedTools);
    if (disallowed) entry.disallowedTools = disallowed;
    agents[name] = entry;
  }
  return { agents, missing };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i];
  if (!opt.out) { console.error('usage: worker-agents.mjs --out <file> [--wt <worktree>]'); process.exit(2); }
  const { agents, missing } = buildAgents({ home: process.env.HOME || homedir(), wt: opt.wt });
  if (missing.length) {
    for (const m of missing) console.error(`FAIL: review agent missing: ${m} — run install.sh or /desk-update`);
    process.exit(1);
  }
  mkdirSync(dirname(opt.out), { recursive: true });
  writeFileSync(opt.out, `${JSON.stringify(agents, null, 2)}\n`);
  console.log(`AGENTS: ${Object.keys(agents).join(' ')}`);
}
