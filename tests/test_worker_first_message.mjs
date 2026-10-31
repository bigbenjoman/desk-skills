// suite: worker first message (a batch's ticket workers share one system prompt; the briefing rides in the first message)
// covers: desk/bin/spawn-worker.sh desk/bin/desk-env.sh skills/desk-autopilot/references/autopilot-worker-contract.md
// Dry-run spawns of two tickets through a stub claude on PATH, which records each call's argv:
// their appended system prompts match, both drop the per-machine sections, and each ticket's
// briefing is in its own first message, at a later stage too, and never again on a resume.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const T = mkdtempSync(join(tmpdir(), 'desk-first-msg-'));
for (const d of ['home', 'state', 'stub', 'repo', 'wt-one', 'wt-two']) mkdirSync(join(T, d), { recursive: true });
const gitEnv = { ...process.env, HOME: join(T, 'home'), GIT_CONFIG_NOSYSTEM: '1' };
for (const d of ['repo', 'wt-one', 'wt-two']) {
  spawnSync('git', ['-C', join(T, d), 'init', '-q', '-b', 'main'], { env: gitEnv });
  spawnSync('git', ['-C', join(T, d), '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { env: gitEnv });
}
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
const stub = join(T, 'stub', 'claude');
writeFileSync(stub, `#!/usr/bin/env bash
if [ "$1" = agents ]; then printf '[{"sessionId":"%s","pid":4242}]' "${SID}"; exit 0; fi
n=0; while [ -e "$STUB_LOG.$n" ]; do n=$((n+1)); done
printf '%s\\0' "$@" > "$STUB_LOG.$n"
`);
chmodSync(stub, 0o755);

const brief = (key) => {
  const p = join(T, 'state', `${key}.brief.md`);
  writeFileSync(p, `Orchestrator session name: batch-x\nAnswer file to wait on: ${join(T, 'state', 'answers', `${key}.txt`)}\n\n` +
    `## Answer from the user\n\nFor ${key}: use makeFixture from tests/helpers.\n`);
  return p;
};
const env = (log, extra = {}) => {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(DESK_|AUTOPILOT_)/.test(k)) delete e[k];
  return { ...e, HOME: join(T, 'home'), GIT_CONFIG_NOSYSTEM: '1', PATH: `${join(T, 'stub')}:${process.env.PATH}`,
    DESK_CONFIG: join(T, 'config.md'), DESK_HOME: join(root, 'desk'), DESK_STATE: join(T, 'state'),
    DESK_AUTOPILOT_STATE: join(T, 'state'), DESK_QUEUE: join(T, 'queue.json'), DESK_SKILLS_DIR: join(root, 'skills'),
    AUTOPILOT_PORT: '3999', AUTOPILOT_BRANCH: 'fix/x', AUTOPILOT_DRY_RUN: '1', STUB_LOG: join(T, log), ...extra };
};
// The worker's own claude -p call: its argv, waiting a few seconds for the detached call.
const spawn = (key, wt, log, extra) => {
  const r = spawnSync('bash', [join(root, 'desk/bin/spawn-worker.sh'), key, join(T, wt), SID, brief(key)],
    { cwd: join(T, wt), env: env(log, extra), encoding: 'utf8', timeout: 60000 });
  const f = join(T, `${log}.0`);
  for (let i = 0; i < 50 && !(existsSync(f) && statSync(f).size); i++) spawnSync('sleep', ['0.1']);
  const a = existsSync(f) ? readFileSync(f, 'utf8').split('\0').slice(0, -1) : [];
  const val = (flag) => (a.includes(flag) ? a[a.indexOf(flag) + 1] : undefined);
  return { status: r.status, stderr: r.stderr, argv: a, prompt: val('-p') ?? '', system: val('--append-system-prompt') ?? '' };
};

const one = spawn('fix-one', 'wt-one', 'one');
const two = spawn('fix-two', 'wt-two', 'two');
t('both dry-run spawns launch a worker', [one.status, two.status, !!one.prompt, !!two.prompt], [0, 0, true, true]);
if (one.status) console.log(one.stderr);

t('AC1 both workers carry the same appended system prompt', one.system === two.system && one.system.length > 0, true);
t('AC1 and it names neither ticket', [one.system, two.system].some((s) => /fix-one|fix-two/.test(s)), false);
t('AC2 each includes --exclude-dynamic-system-prompt-sections',
  [one, two].map((w) => w.argv.includes('--exclude-dynamic-system-prompt-sections')), [true, true]);

t('AC3 the whole briefing is in the first message', one.prompt.includes(`# Briefing for this ticket\n\n${readFileSync(join(T, 'state', 'fix-one.brief.md'), 'utf8').trimEnd()}`), true);
t('AC3 its binding answer included', one.prompt.includes('For fix-one: use makeFixture'), true);
t('AC3 and each worker gets only its own', two.prompt.includes('For fix-two: use makeFixture') && !two.prompt.includes('fix-one'), true);
t('AC3 the system prompt holds no briefing', one.system.includes('Briefing for this ticket'), false);

const later = spawn('fix-one', 'wt-one', 'later', { AUTOPILOT_START_STAGE: '4b' });
t('AC4 a later-stage worker starts at its stage', later.prompt.includes('This session starts at Stage 4b'), true);
t('AC4 and is pointed at the briefing in its first message', later.prompt.includes('the briefing below in this message is what it left for you'), true);
t('AC4 not at its system prompt', /briefing in your system prompt/.test(later.prompt), false);
t('AC4 which follows', later.prompt.includes('# Briefing for this ticket') && !later.system.includes('Briefing for this ticket'), true);
t('AC4 the same system prompt as a Stage 0 worker', later.system === one.system, true);

const RESUME = 'Your previous run of this session was killed before it finished. Carry on.';
const resumed = spawn('fix-one', 'wt-one', 'resumed', { AUTOPILOT_RESUME: RESUME });
t('AC5 a resumed worker resumes its session', resumed.argv.includes('--resume'), true);
t('AC5 and is not handed a second copy of the briefing', [resumed.prompt, resumed.system].some((s) => s.includes('Briefing for this ticket')), false);
t('AC5 its prompt is the resume text', resumed.prompt, RESUME);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
