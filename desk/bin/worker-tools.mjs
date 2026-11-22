#!/usr/bin/env node
// The built-in tools each headless `claude -p` call is launched with, as `--tools <list>`.
//   worker-tools.mjs worker|triage|none   prints the comma-separated list ("" for none)
//
// An allow-list, not --disallowedTools, so a tool a new Claude Code release adds never reaches a
// worker unseen. Every tool definition rides in every call's context, so a tool nobody uses is paid
// for on every turn. desk-env.sh's desk_tool_args turns a list into the flag, and passes no flag at
// all (Claude Code's default list) when AUTOPILOT_DEFAULT_TOOLS is set.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A worker, and the preflight that vets it: every tool the worker contract or a skill the worker
// loads names, and nothing else. tests/test_worker_tools.mjs checks both directions against the files.
// WebFetch and WebSearch stay listed: worker-settings.mjs denies them unless §3 worker-web-read is yes.
// ReportFindings is named outside this repo: a repo whose §4 Local review is /code-review reports with it.
export const WORKER_TOOLS = [
  'Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'ReportFindings', 'Skill',
  'TaskStop', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
];

// Tools a worker cannot use to any effect, with why: never offered, and the worker tools suite fails
// any file a worker reads that names one, so prose cannot keep a dead tool offered or a dead step alive.
// A park's channel is the park file and the next pass (worker contract section 1).
export const UNREACHABLE = {
  SendMessage: 'a worker starts with --setting-sources "", often on another Claude login, so it can never reach the orchestrator\'s agent registry',
  ListAgents: 'it lists only the agent registry of the worker\'s own login, which never holds the orchestrator',
};

// Triage and its lane challenge read code through git, read the routing file, and write one record.
export const TRIAGE_TOOLS = ['Bash', 'Read', 'Write'];

export const TOOL_LISTS = { worker: WORKER_TOOLS, triage: TRIAGE_TOOLS, none: [] };

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const list = TOOL_LISTS[process.argv[2]];
  if (!list) {
    console.error('usage: worker-tools.mjs worker|triage|none');
    process.exit(2);
  }
  console.log(list.join(','));
}
