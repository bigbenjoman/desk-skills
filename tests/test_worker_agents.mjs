// suite: worker agents (the named review seats reach a worker through --agents)
// covers: agents/** skills/desk-review/references/**
// worker-agents.mjs builds the --agents file spawn-worker.sh launches every worker and its preflight
// with: each named desk-review seat from the installed agent files, a missing one refusing the spawn,
// and nothing but the agent definitions carried. Scratch HOME and worktree only. That spawn-worker.sh
// passes the file to the preflight and the worker, and refuses a spawn when it cannot be built, is
// proved by running it: tests/test_batch_e2e.sh.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_AGENTS, buildAgents, parseAgent } from '../desk/bin/worker-agents.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'desk', 'bin', 'worker-agents.mjs');
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const T = mkdtempSync(join(tmpdir(), 'worker-agents-'));
const home = join(T, 'home');
const wt = join(T, 'wt');
const userDir = join(home, '.claude', 'agents');
mkdirSync(userDir, { recursive: true });
mkdirSync(wt, { recursive: true });
const agentFile = (name, extra = '') => `---\nname: ${name}\ndescription: "Use ${name}.\\n\\nExamples: \\"review\\""\nmodel: opus\ncolor: red\n${extra}---\n\nYou are ${name}.\n`;
for (const name of REVIEW_AGENTS) writeFileSync(join(userDir, `${name}.md`), agentFile(name));
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, ...env } });

// ---- AC1: every named seat is in the file, as the installed agent defines it
const out = join(T, 'state', 'workers', 'DS-1.agents.json');
const ok = run(['--out', out, '--wt', wt]);
t('AC1 builds with every seat installed', ok.status, 0);
t('AC1 names the agents it wrote', ok.stdout.trim(), `AGENTS: ${REVIEW_AGENTS.join(' ')}`);
const file = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
t('AC1 the file holds every seat', JSON.stringify(Object.keys(file)), JSON.stringify(REVIEW_AGENTS));
const lena = file['lena-code-reviewer'] ?? {};
t('AC1 the prompt is the agent file body', lena.prompt, 'You are lena-code-reviewer.');
t('AC1 a quoted description keeps its escapes', lena.description, 'Use lena-code-reviewer.\n\nExamples: "review"');
t('AC1 the model is carried', lena.model, 'opus');

// The repo's own copy wins over the user's, as it does interactively.
mkdirSync(join(wt, '.claude', 'agents'), { recursive: true });
writeFileSync(join(wt, '.claude', 'agents', 'lena-code-reviewer.md'), '---\nname: lena-code-reviewer\ndescription: repo lena\n---\nRepo Lena.\n');
const over = buildAgents({ home, wt });
t('AC1 a repo override wins', over.agents['lena-code-reviewer'].prompt, 'Repo Lena.');
rmSync(join(wt, '.claude'), { recursive: true });

// Every named agent desk-review dispatches is in the list: a seat added there and not here would
// silently fall back again.
const shipped = readdirSync(join(ROOT, 'agents')).map((f) => f.replace(/\.md$/, ''));
const review = readdirSync(join(ROOT, 'skills', 'desk-review', 'references')).map((f) => readFileSync(join(ROOT, 'skills', 'desk-review', 'references', f), 'utf8')).join('\n');
const named = shipped.filter((a) => review.includes(`\`${a}\``)).sort();
t('AC1 desk-review names some agents', named.length >= 7, true);
t('AC1 every agent desk-review names is passed', JSON.stringify(named.filter((a) => !REVIEW_AGENTS.includes(a))), '[]');
t('AC1 every passed agent ships with desk', JSON.stringify(REVIEW_AGENTS.filter((a) => !shipped.includes(a))), '[]');

// ---- AC2: a missing seat refuses the spawn, naming it
rmSync(join(userDir, 'nadia-security-auditor.md'));
const out2 = join(T, 'missing.json');
const miss = run(['--out', out2, '--wt', wt]);
t('AC2 a missing seat fails', miss.status, 1);
t('AC2 the failure names the missing agent', /FAIL: review agent missing: nadia-security-auditor/.test(miss.stderr), true);
t('AC2 and only that one', miss.stderr.trim().split('\n').length, 1);
t('AC2 no file is written', existsSync(out2), false);
writeFileSync(join(userDir, 'nadia-security-auditor.md'), '---\nname: nadia-security-auditor\n---\n');
t('AC2 an agent with no description or prompt fails too', /nadia-security-auditor .*no description or no prompt/.test(run(['--out', out2]).stderr), true);
writeFileSync(join(userDir, 'nadia-security-auditor.md'), agentFile('nadia-security-auditor'));

// ---- AC4: only the agent definitions reach the worker
writeFileSync(join(userDir, 'jim-solution-architect.md'), agentFile('jim-solution-architect',
  'permissionMode: bypassPermissions\nmemory: user\nmcpServers:\n  - github\nhooks: x\ntools: Read, Grep, "Bash"\ndisallowedTools:\n  - Write\n  - Edit\n'));
const jim = buildAgents({ home, wt }).agents['jim-solution-architect'];
t('AC4 only description, prompt, model and tool lists are carried', JSON.stringify(Object.keys(jim)), JSON.stringify(['description', 'prompt', 'model', 'tools', 'disallowedTools']));
t('AC4 an inline tool list is read', JSON.stringify(jim.tools), JSON.stringify(['Read', 'Grep', 'Bash']));
t('AC4 a block tool list is read', JSON.stringify(jim.disallowedTools), JSON.stringify(['Write', 'Edit']));

t('a file with no frontmatter is not an agent', parseAgent('You are nobody.'), null);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
