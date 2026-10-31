// suite: worker tools (each headless claude -p call is offered only the tools it uses, and a batch's workers share one system prompt)
// covers: desk/bin/worker-tools.mjs desk/bin/spawn-worker.sh desk/bin/desk-env.sh agents/** skills/**/*.md
// The worker's --tools list matches what the worker contract and the skills it loads name, in both
// directions; spawn-worker.sh passes it to the worker and its preflight, and passes nothing with the
// off switch set. Two tickets' workers send the same appended system prompt, drop the per-machine
// sections, and carry their own briefing in the first message, at a later stage too, and never again
// on a resume. A stub claude on PATH records each call's argv. Scratch HOME and repo only.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync, chmodSync, cpSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKER_TOOLS, TRIAGE_TOOLS } from '../desk/bin/worker-tools.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Claude Code's built-in tool names, which a file can name.
const BUILTIN = ['Agent', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'DesignSync', 'Edit',
  'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'Monitor',
  'NotebookEdit', 'PushNotification', 'Read', 'RemoteTrigger', 'ReportFindings', 'ScheduleWakeup', 'SendMessage',
  'SendToProject', 'SendToProjectContext', 'Skill', 'TaskStop', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch',
  'Workflow', 'Write'];
// Named in what a worker reads, and deliberately not offered.
const NOT_OFFERED = {
  AskUserQuestion: 'a headless worker cannot ask: the contract says it has none',
  Monitor: 'a blocking primitive the contract says is refused',
};
// Offered, and named only by a skill a worker loads from outside this repo, so the scan cannot see it.
const NAMED_OUTSIDE = {
  ReportFindings: "a repo's §4 Local review /code-review reports its findings with it",
};
// Text that spells a tool's name but is not the tool.
const NOT_A_TOOL = [/§4 Workflow/g, /`Workflow` and its named states/g];

// What a worker reads: the contract, the skills its stages load, and the agents it dispatches.
const mdUnder = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? mdUnder(join(d, e.name)) : e.name.endsWith('.md') ? [join(d, e.name)] : []);
const refs = join(root, 'skills/desk-autopilot/references');
const SOURCES = [
  ...readdirSync(refs).filter((f) => /^(autopilot-worker-contract|worker-contract-.*|ask-or-take)\.md$/.test(f)).map((f) => join(refs, f)),
  ...['desk-ticket', 'desk-pr', 'desk-jira', 'desk-review', 'desk-review-response', 'desk-kiss', 'desk-dev']
    .flatMap((s) => mdUnder(join(root, 'skills', s))),
  ...mdUnder(join(root, 'agents')),
];

// AC1: none of the tools no worker uses.
const DROPPED = ['Workflow', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'DesignSync',
  'NotebookEdit', 'EnterWorktree', 'ExitWorktree'];
t('AC1 the worker list excludes every unused tool', DROPPED.filter((x) => WORKER_TOOLS.includes(x)), []);
t('every listed tool is a Claude Code built-in', [...WORKER_TOOLS, ...TRIAGE_TOOLS].filter((x) => !BUILTIN.includes(x)), []);

// AC7 and AC2: every tool a file names is offered (naming the tool and the file), and every tool
// offered is named somewhere.
const named = new Map();
for (const f of SOURCES) {
  let s = readFileSync(f, 'utf8');
  for (const re of NOT_A_TOOL) s = s.replace(re, '');
  for (const tool of BUILTIN) if (new RegExp(`\\b${tool}\\b`).test(s)) named.set(tool, [...(named.get(tool) || []), relative(root, f)]);
}
t(`the scan read the worker's files (${SOURCES.length})`, SOURCES.length > 40, true);
const missing = [...named].filter(([tool]) => !WORKER_TOOLS.includes(tool) && !NOT_OFFERED[tool]).map(([tool, fs]) => `${tool} (named in ${fs.join(', ')})`);
t('AC7 every tool the contract and skills name is in the worker list', missing, []);
t('AC2 every tool in the worker list is named by the contract or a skill', WORKER_TOOLS.filter((x) => !named.has(x) && !NAMED_OUTSIDE[x]), []);
t('a tool named outside this repo is offered and not also named here (else drop it from NAMED_OUTSIDE)',
  Object.keys(NAMED_OUTSIDE).filter((x) => !WORKER_TOOLS.includes(x) || named.has(x)), []);
t('a tool named but not offered is still named (else drop it from NOT_OFFERED)', Object.keys(NOT_OFFERED).filter((x) => !named.has(x)), []);

// AC5: every tool an agent definition names is in the worker's list.
for (const f of readdirSync(join(root, 'agents')).filter((x) => x.endsWith('.md'))) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(root, 'agents', f), 'utf8'))?.[1] || '';
  const tools = (/^tools:\s*(.+)$/m.exec(fm)?.[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (tools.length) t(`AC5 ${f}: every tool it names is in the worker list`, tools.filter((x) => !WORKER_TOOLS.includes(x)), []);
}

// The CLI prints each list comma-joined, and refuses an unknown one.
const cli = (k) => spawnSync('node', [join(root, 'desk/bin/worker-tools.mjs'), k], { encoding: 'utf8' });
t('worker-tools.mjs worker', cli('worker').stdout.trim(), WORKER_TOOLS.join(','));
t('worker-tools.mjs triage', cli('triage').stdout.trim(), 'Bash,Read,Write');
t('worker-tools.mjs none is empty', cli('none').stdout, '\n');
t('worker-tools.mjs <unknown> exits 2', cli('bogus').status, 2);

// Dry-run spawns through a stub claude.
const T = mkdtempSync(join(tmpdir(), 'desk-tools-'));
for (const d of ['home', 'state', 'stub', 'repo']) mkdirSync(join(T, d), { recursive: true });
// spawn-worker.sh builds the --agents file from the user-level agents and refuses a spawn without them.
cpSync(join(root, 'agents'), join(T, 'home', '.claude', 'agents'), { recursive: true });
const git = (...a) => spawnSync('git', ['-C', join(T, 'repo'), ...a], { env: { ...process.env, HOME: join(T, 'home'), GIT_CONFIG_NOSYSTEM: '1' } });
git('init', '-q', '-b', 'main'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
writeFileSync(join(T, 'config.md'), `## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`${join(T, 'repo')}\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |

## 4. Toolchain
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`none\` |
| Other work id patterns | \`none\` |
| Package manager | \`none\` |
| Command prefix | \`none\` |
| Install | \`none\` |
| Unit tests | \`bash tests/run.sh\` |
`);
const SID = '11111111-2222-3333-4444-555555555555';
// `claude agents --json` reports the session, so spawn-worker finds its pid at once; any other call
// writes its argv, NUL-separated, to the next free $STUB_LOG.<n>.
const stub = join(T, 'stub', 'claude');
writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = agents ]; then printf '[{"sessionId":"%s","pid":4242}]' "${SID}"; exit 0; fi
n=0; while [ -e "$STUB_LOG.$n" ]; do n=$((n+1)); done
printf '%s\\0' "$@" > "$STUB_LOG.$n"
`);
chmodSync(stub, 0o755);

const env = (log, extra = {}) => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete e[k];
  return { ...e, HOME: join(T, 'home'), GIT_CONFIG_NOSYSTEM: '1', PATH: `${join(T, 'stub')}:${process.env.PATH}`,
    DESK_CONFIG: join(T, 'config.md'), DESK_HOME: join(root, 'desk'), DESK_STATE: join(T, 'state'),
    DESK_AUTOPILOT_STATE: join(T, 'state'), DESK_QUEUE: join(T, 'queue.json'), DESK_SKILLS_DIR: join(root, 'skills'),
    AUTOPILOT_PORT: '3999', AUTOPILOT_BRANCH: 'fix/fix-thing', STUB_LOG: join(T, log), ...extra };
};
const spawnWorker = (sid, log, extra, key = 'fix-thing', brief = []) => spawnSync('bash', [join(root, 'desk/bin/spawn-worker.sh'), key, join(T, 'repo'), sid, ...brief],
  { cwd: join(T, 'repo'), env: env(log, extra), encoding: 'utf8', timeout: 60000 });
// The argv of call n, waiting a few seconds for a detached one.
const argv = (log, n) => {
  const f = join(T, `${log}.${n}`);
  for (let i = 0; i < 50 && !(existsSync(f) && statSync(f).size); i++) spawnSync('sleep', ['0.1']);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\0').slice(0, -1) : null;
};
const toolsOf = (a) => (a && a.includes('--tools') ? a[a.indexOf('--tools') + 1] : undefined);
const LIST = WORKER_TOOLS.join(',');

// AC1: the worker's own claude -p call, in a dry run.
let r = spawnWorker(SID, 'run', { AUTOPILOT_DRY_RUN: '1' });
let a = argv('run', 0);
t('AC1 dry-run spawn launches the worker', r.status === 0 && !!a && a.includes('-p') && a.includes('--append-system-prompt'), true);
t('AC1 the worker is launched with --tools <worker list>', toolsOf(a), LIST);
t('AC1 its --tools excludes Workflow', (toolsOf(a) || '').split(',').includes('Workflow'), false);

// AC3: the preflight offers the same list; the finder model check offers none.
r = spawnWorker('preflight', 'pre', { AUTOPILOT_PREFLIGHT: '1', AUTOPILOT_FINDER_MODEL: 'opus' });
const pre = argv('pre', 0);
t('AC3 the preflight runs', !!pre && pre.includes('-p') && pre.includes('--settings'), true);
t('AC3 the preflight offers the same list as the worker', toolsOf(pre), LIST);
t('the finder model check is offered no tool', toolsOf(argv('pre', 1)), '');

// AC6: the off switch gives every call Claude Code's default list.
r = spawnWorker(SID, 'off', { AUTOPILOT_DRY_RUN: '1', AUTOPILOT_DEFAULT_TOOLS: '1' });
a = argv('off', 0);
t('AC6 off switch: the worker still launches', !!a && a.includes('-p'), true);
t('AC6 off switch: no --tools, so the default list', toolsOf(a), undefined);
r = spawnWorker('preflight', 'preoff', { AUTOPILOT_PREFLIGHT: '1', AUTOPILOT_FINDER_MODEL: 'opus', AUTOPILOT_DEFAULT_TOOLS: '1' });
t('AC6 off switch: the preflight passes no --tools', [toolsOf(argv('preoff', 0)), toolsOf(argv('preoff', 1))], [undefined, undefined]);

// A batch's ticket workers share one system prompt: dry-run spawns of two tickets, each with its own
// briefing, compared by the system prompt and the first message each sends.
const brief = (key) => {
  const p = join(T, 'state', `${key}.brief.md`);
  writeFileSync(p, `Orchestrator session name: batch-x\nAnswer file to wait on: ${join(T, 'state', 'answers', `${key}.txt`)}\n\n` +
    `## Answer from the user\n\nFor ${key}: use makeFixture from tests/helpers.\n`);
  return p;
};
const launch = (key, log, extra = {}) => {
  const r2 = spawnWorker(SID, log, { AUTOPILOT_DRY_RUN: '1', ...extra }, key, [brief(key)]);
  const a2 = argv(log, 0) ?? [];
  const val = (flag) => (a2.includes(flag) ? a2[a2.indexOf(flag) + 1] : undefined);
  return { status: r2.status, stderr: r2.stderr, argv: a2, prompt: val('-p') ?? '', system: val('--append-system-prompt') ?? '' };
};
const one = launch('fix-one', 'one');
const two = launch('fix-two', 'two');
t('briefing: both dry-run spawns launch a worker', [one.status, two.status, !!one.prompt, !!two.prompt], [0, 0, true, true]);
if (one.status) console.log(one.stderr);

t('briefing AC1 both workers carry the same appended system prompt', one.system === two.system && one.system.length > 0, true);
t('briefing AC1 and it names neither ticket', [one.system, two.system].some((s) => /fix-one|fix-two/.test(s)), false);
t('briefing AC2 each includes --exclude-dynamic-system-prompt-sections',
  [one, two].map((w) => w.argv.includes('--exclude-dynamic-system-prompt-sections')), [true, true]);

t('briefing AC3 the whole briefing is in the first message', one.prompt.includes(`# Briefing for this ticket\n\n${readFileSync(join(T, 'state', 'fix-one.brief.md'), 'utf8').trimEnd()}`), true);
t('briefing AC3 its binding answer included', one.prompt.includes('For fix-one: use makeFixture'), true);
t('briefing AC3 and each worker gets only its own', two.prompt.includes('For fix-two: use makeFixture') && !two.prompt.includes('fix-one'), true);
t('briefing AC3 the system prompt holds no briefing', one.system.includes('Briefing for this ticket'), false);

const later = launch('fix-one', 'later', { AUTOPILOT_START_STAGE: '4b' });
t('briefing AC4 a later-stage worker starts at its stage', later.prompt.includes('This session starts at Stage 4b'), true);
t('briefing AC4 and is pointed at the briefing in its first message', later.prompt.includes('the briefing below in this message is what it left for you'), true);
t('briefing AC4 not at its system prompt', /briefing in your system prompt/.test(later.prompt), false);
t('briefing AC4 which follows', later.prompt.includes('# Briefing for this ticket') && !later.system.includes('Briefing for this ticket'), true);
t('briefing AC4 the same system prompt as a Stage 0 worker', later.system === one.system, true);

const RESUME = 'Your previous run of this session was killed before it finished. Carry on.';
const resumed = launch('fix-one', 'resumed', { AUTOPILOT_RESUME: RESUME });
t('briefing AC5 a resumed worker resumes its session', resumed.argv.includes('--resume'), true);
t('briefing AC5 and is not handed a second copy of the briefing', [resumed.prompt, resumed.system].some((s) => s.includes('Briefing for this ticket')), false);
t('briefing AC5 its prompt is the resume text', resumed.prompt, RESUME);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
