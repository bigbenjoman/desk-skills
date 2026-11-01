// suite: repo templates (a repo's committed copies of desk's templates against the installed ones)
// covers: desk/bin/repo-templates.mjs desk/templates/** skills/desk-update/**
// A throwaway desk-skills checkout whose template history has two versions, the installed templates
// (the newer), and a repo whose committed copies are: the hook exactly, the gate with its own edit
// only, a pre-push.sh made from the older version with an edit of its own, and a review-gate.mjs
// where the repo and the template changed the same line. Nothing touches your real ~/.claude.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'desk', 'bin', 'repo-templates.mjs');
const T = mkdtempSync(join(tmpdir(), 'desk-repo-templates-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DESK_') && !k.startsWith('AUTOPILOT_'))),
  HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_SOURCE_CHECKOUT: join(T, 'src'), DESK_MACHINE: join(T, 'machine.md'),
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', env });
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };

// The pre-push.sh template before and after a fix that adds a skip (as DS-383's did), the gate
// unchanged, and review-gate.mjs's second line changed, with a line added at its end.
const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');
const PP1 = `#!/usr/bin/env bash\n# desk pre-push\n${lines(20)}\nexit 0\n`;
const PP2 = PP1.replace('exit 0\n', '# a ref already on a remote is skipped\nskip_known_refs\nexit 0\n');
const GATE = `name: desk gate\nenv:\n  PROTECTED: ''\n${lines(10, (i) => `step ${i}`)}\n`;
const HOOK = '#!/bin/sh\nexec bash scripts/desk/pre-push.sh "$@"\n';
const RG1 = `a\nb\n${lines(8)}\nz\n`;
const RG2 = RG1.replace('\nb\n', '\nB from the template\n').replace(/z\n$/, 'z\nadded by the template\n');
// A template whose one change is to the line this repo also changed: nothing for apply to bring in.
const SK1 = `#!/bin/sh\n${lines(5)}\nonly line\n${lines(5, (i) => `tail ${i}`)}\n`;
const SK2 = SK1.replace('only line', 'only line, as the template has it now');

const SRC = env.DESK_SOURCE_CHECKOUT;
mkdirSync(SRC, { recursive: true });
git(SRC, 'init', '-q', '-b', 'main');
const tpl = (rel, text) => put(SRC, join('desk', 'templates', rel), text);
tpl('scripts/desk/pre-push.sh', PP1); tpl('.github/workflows/desk-gate.yml', GATE); tpl('.githooks/pre-push', HOOK); tpl('scripts/desk/review-gate.mjs', RG1); tpl('scripts/desk/skip.sh', SK1);
git(SRC, 'add', '-A'); git(SRC, 'commit', '-q', '-m', 'templates');
const BASE = git(SRC, 'rev-parse', 'HEAD').stdout.trim();
const BASE_DAY = git(SRC, 'log', '-1', '--format=%cI', BASE).stdout.trim().slice(0, 10);
tpl('scripts/desk/pre-push.sh', PP2); tpl('scripts/desk/review-gate.mjs', RG2); tpl('scripts/desk/skip.sh', SK2);
git(SRC, 'commit', '-q', '-am', 'fix the templates');

// Installed: the newer versions, as install.sh copies them.
const INST = join(env.DESK_HOME, 'templates');
for (const [rel, text] of [['scripts/desk/pre-push.sh', PP2], ['.github/workflows/desk-gate.yml', GATE], ['.githooks/pre-push', HOOK], ['scripts/desk/review-gate.mjs', RG2], ['scripts/desk/skip.sh', SK2]]) put(INST, rel, text);
put(INST, 'scripts/desk/pre-push.sh.bak-desk-2026', 'an old backup install.sh left: not a template\n');

// The repo, committed on origin/main.
const REPO = join(T, 'repos', 'app');
mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
const LOCAL_EDIT = 'line 3 # this repo checks untracked files too';
put(REPO, 'scripts/desk/pre-push.sh', PP1.replace('line 3', LOCAL_EDIT));
put(REPO, '.github/workflows/desk-gate.yml', GATE.replace("PROTECTED: ''", "PROTECTED: '^(\\.github|scripts/desk)/'"));
put(REPO, '.githooks/pre-push', HOOK); chmodSync(join(REPO, '.githooks/pre-push'), 0o755);
put(REPO, 'scripts/desk/review-gate.mjs', RG1.replace('\nb\n', '\nB from this repo\n'));
// A committed file at the backup's path, so a backup read as a template would show in status.
put(REPO, 'scripts/desk/pre-push.sh.bak-desk-2026', 'this repo\'s own file\n');
put(REPO, 'scripts/desk/skip.sh', SK1.replace('only line', 'only line, as this repo has it'));
git(REPO, 'add', '-A'); git(REPO, 'commit', '-q', '-m', 'desk'); git(REPO, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
const SLUG = 'acme__app';
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', SLUG), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', SLUG, 'config.md'),
  `## 0. This repo\n\n| Field | Value |\n|---|---|\n| Default branch | \`main\` |\n\n## 2. Paths\n\n| Field | Value |\n|---|---|\n| Primary repo root | \`${REPO}\` |\n`);

const cli = (cwd, ...args) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, cwd }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }; };

// ---- AC5: each committed copy against the installed template, the behind one with its base
const st = cli(REPO, 'status');
t('DS-389 AC5 the hook is current', st.out.split('\n').includes('CURRENT  .githooks/pre-push'), true);
t('DS-389 AC5 a copy only this repo changed (setup\'s PROTECTED edit) is not behind', st.out.split('\n').some((l) => l.startsWith('EDITED   .github/workflows/desk-gate.yml')), true);
t('DS-389 AC5 a copy made from the older template, with an edit of its own, is behind, naming its base', st.out.split('\n').includes(`BEHIND   scripts/desk/pre-push.sh: the template changed since the version this copy was made from (${BASE.slice(0, 7)}, ${BASE_DAY})`), true);
t('DS-389 AC5 a backup beside the templates is not one', /\.bak/.test(st.out), false);
t('DS-389 AC5 a copy whose only template change is a line this repo also changed is not behind: apply would change nothing', st.out.split('\n').some((l) => l.startsWith('EDITED   scripts/desk/skip.sh')), true);
t('DS-389 AC5 any copy behind exits 1', st.code, 1);
const json = JSON.parse(cli(REPO, 'status', '--json').out);
t('DS-389 AC5 --json gives each file\'s status and base', json.map((f) => `${f.path} ${f.status} ${f.base ? f.base.slice(0, 7) : '-'}`).join('; '),
  `.githooks/pre-push CURRENT -; .github/workflows/desk-gate.yml EDITED -; scripts/desk/pre-push.sh BEHIND ${BASE.slice(0, 7)}; scripts/desk/review-gate.mjs BEHIND ${BASE.slice(0, 7)}; scripts/desk/skip.sh EDITED -`);
const diff = cli(REPO, 'diff', 'scripts/desk/pre-push.sh').out;
t('DS-389 AC5 the diff is what the template changed since that base, not the repo\'s edit', `${diff.includes('+skip_known_refs')} ${diff.includes('this repo checks untracked')}`, 'true false');
t('DS-389 AC5 a file that is not behind says so instead of a diff', cli(REPO, 'diff', '.githooks/pre-push').out, 'CURRENT  .githooks/pre-push');

// ---- AC6: applied on a branch cut from origin/main: the template's hunk lands, the repo's edit stays
const WT = join(T, 'wt');
git(REPO, 'worktree', 'add', '-q', '-b', 'chore/desk-templates', WT, 'origin/main');
const ap = cli(REPO, 'apply', '--root', WT);
const pp = readFileSync(join(WT, 'scripts/desk/pre-push.sh'), 'utf8');
t('DS-389 AC6 a clean three-way update is APPLIED', ap.out.split('\n')[0], `APPLIED  scripts/desk/pre-push.sh: the template's changes since ${BASE.slice(0, 7)}, with this repo's own edits kept`);
t('DS-389 AC6 the template\'s hunk lands and the repo\'s edit survives', `${pp.includes('skip_known_refs')} ${pp.includes(LOCAL_EDIT)}`, 'true true');
t('DS-389 AC6 it is exactly the template plus the repo\'s one edit', pp, PP2.replace('line 3', LOCAL_EDIT));
const rg = readFileSync(join(WT, 'scripts/desk/review-gate.mjs'), 'utf8');
t('DS-389 AC6 a hunk both changed keeps the repo\'s lines and is named, never overwritten', `${/^KEPT {5}scripts\/desk\/review-gate\.mjs: .*except 1 hunk\(s\) this repo also changed/m.test(ap.out)} ${rg.includes('B from this repo')} ${rg.includes('B from the template')}`, 'true true false');
t('DS-389 AC6 the named hunk shows both sides, for the PR body', `${ap.out.includes('<<<<<<< this repo')} ${ap.out.includes('B from the template')} ${ap.out.includes('>>>>>>> template now')}`, 'true true true');
t('DS-389 AC6 the rest of that file still takes the template\'s change', `${rg.includes('added by the template')} ${/<<<<<<<|>>>>>>>/.test(rg)}`, 'true false');
t('DS-389 AC6 a current or edited copy is not touched', `${readFileSync(join(WT, '.github/workflows/desk-gate.yml'), 'utf8').includes('scripts/desk')} ${git(WT, 'status', '--porcelain').stdout.split('\n').filter(Boolean).map((l) => l.trim()).sort().join(',')}`,
  'true M scripts/desk/pre-push.sh,M scripts/desk/review-gate.mjs');
t('DS-389 AC6 the hook keeps its executable bit', (statSync(join(WT, '.githooks/pre-push')).mode & 0o111) !== 0, true);
t('DS-389 AC6 naming a file that is not behind skips it', cli(REPO, 'apply', '--root', WT, '.githooks/pre-push').out, 'SKIPPED  .githooks/pre-push: it is the template already');

// With no desk-skills history, a copy that differs cannot be told behind from edited.
const noSrc = { ...env, DESK_SOURCE_CHECKOUT: join(T, 'nowhere') };
const unk = spawnSync(process.execPath, [SCRIPT, 'status'], { encoding: 'utf8', env: noSrc, cwd: REPO });
t('DS-389 a copy with no history to read is UNKNOWN, and not behind', `${unk.stdout.includes('UNKNOWN  scripts/desk/pre-push.sh')} ${unk.status}`, 'true 0');

// ---- AC7: the supervisor's check records the behind copies for needs-you, at most hourly
const REC = join(env.HOME, '.desk-autopilot', SLUG, 'templates.json');
const c1 = cli(REPO, 'check');
const rec1 = JSON.parse(readFileSync(REC, 'utf8'));
t('DS-389 AC7 the check names the behind copies', c1.out, 'checked: behind: scripts/desk/pre-push.sh, scripts/desk/review-gate.mjs');
t('DS-389 AC7 and records them, each with when it was first found behind', `${rec1.ref} ${rec1.files.filter((f) => f.status === 'BEHIND').map((f) => `${f.path}@${f.base.slice(0, 7)}:${!!f.since}`).join(',')}`,
  `origin/main scripts/desk/pre-push.sh@${BASE.slice(0, 7)}:true,scripts/desk/review-gate.mjs@${BASE.slice(0, 7)}:true`);
t('DS-389 AC7 a second check within the hour reads nothing again', cli(REPO, 'check').out.startsWith('checked recently:'), true);
cli(REPO, 'check', '--force');
t('DS-389 AC7 a forced check keeps when each was first found behind', JSON.parse(readFileSync(REC, 'utf8')).files.find((f) => f.path === 'scripts/desk/pre-push.sh').since, rec1.files.find((f) => f.path === 'scripts/desk/pre-push.sh').since);
// Once the PR has merged, the copies on origin/main are current: nothing is behind.
git(WT, 'commit', '-q', '-am', 'bring the desk templates up to date');
git(REPO, 'update-ref', 'refs/remotes/origin/main', 'chore/desk-templates');
// The review gate kept this repo's own line, so it is only this repo's edit now: not behind either.
t('DS-389 AC7 after the PR merges, nothing is behind', cli(REPO, 'check', '--force').out, 'checked: no copy behind');
t('DS-389 the record exists where needs-you reads it', existsSync(REC), true);

console.log(fails ? `\n${fails} check(s) did not pass` : '\nall passed');
process.exit(fails ? 1 : 0);
