// suite: review-post (a worker's self-review post, from §4 Review account)
// covers: desk/bin/review-post.mjs
// review-post.mjs submits a review report as one COMMENTED review: from §4 Review account's gh config
// directory where the row is set, from the §1 handle's plain gh where it is not. A verdict flag, a
// malformed row or a missing directory is refused with exit 1 and never reaches gh. A fake gh on PATH
// records its arguments and the GH_CONFIG_DIR and GH_TOKEN it ran under. Scratch directory only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'desk', 'bin', 'review-post.mjs');
let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const T = mkdtempSync(join(tmpdir(), 'desk-review-post-'));
const log = join(T, 'gh.log');
const ghDir = join(T, 'gh-agent-pullbot');
mkdirSync(ghDir);
writeFileSync(join(T, 'gh'), `#!/bin/sh\nprintf 'GH_CONFIG_DIR=%s\\nGH_TOKEN=%s\\n' "\${GH_CONFIG_DIR-unset}" "\${GH_TOKEN-unset}" > "${log}"\nprintf '%s\\n' "$@" >> "${log}"\n`);
chmodSync(join(T, 'gh'), 0o755);
writeFileSync(join(T, 'report.md'), '<!-- desk-review:local -->\nclean\n');
const config = join(T, 'config.md');
const run = (row, args = ['42', '--repo', 'acme/web', '--body-file', join(T, 'report.md')]) => {
  writeFileSync(config, `## 0. Repo\n\n| Field | Value |\n|---|---|\n| GitHub repo | \`acme/web\` |\n\n## 4. Tracker\n\n| Field | Value |\n|---|---|\n${row == null ? '' : `| Review account | ${row} |\n`}`);
  rmSync(log, { force: true });
  const env = { ...process.env, PATH: `${T}:${process.env.PATH}`, DESK_CONFIG: config, DESK_MACHINE: join(T, 'none.md'), HOME: T, GH_TOKEN: 'person-token' };
  for (const k of ['GH_CONFIG_DIR', 'DESK_GH_REPO', 'DESK_REPO_OVERRIDE', 'DESK_SLUG', 'DESK_REPO_DIR', 'DESK_REPO_ROOT']) delete env[k];
  // Outside any git repo, so §0 GitHub repo is the config's, not this checkout's origin.
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, cwd: T });
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : null;
  return { status: r.status, env: lines?.slice(0, 2) ?? null, ran: lines?.slice(2) ?? null, err: r.stderr };
};
const COMMENT = ['pr', 'review', '42', '--repo', 'acme/web', '--comment', '--body-file', join(T, 'report.md')];

// AC1: the row set, the review is a COMMENTED review from the account's gh config directory.
let r = run(`\`agent-pullbot: ${ghDir}\``);
t('AC1 posts', r.status, 0);
t('AC1 as a COMMENTED review', r.ran, COMMENT);
t('AC1 from the account\'s gh config directory, with no token in the way', r.env, [`GH_CONFIG_DIR=${ghDir}`, 'GH_TOKEN=unset']);
t('AC1 and says which account it posted as', r.err.includes('as agent-pullbot'), true);
mkdirSync(join(T, '.config', 'gh-agent-pullbot'), { recursive: true });
t('AC1 a ~ directory is read from HOME', run('`agent-pullbot: ~/.config/gh-agent-pullbot`').env?.[0], `GH_CONFIG_DIR=${join(T, '.config', 'gh-agent-pullbot')}`);

// AC2: unset or none, plain gh as the §1 handle, with the environment untouched.
for (const [name, row] of [['none', '`none`'], ['unset', null]]) {
  r = run(row);
  t(`AC2 row ${name}: posts as a COMMENTED review`, [r.status, r.ran], [0, COMMENT]);
  t(`AC2 row ${name}: plain gh, as the handle`, r.env, ['GH_CONFIG_DIR=unset', 'GH_TOKEN=person-token']);
}

// AC3: a verdict flag is refused, and gh never runs.
for (const flag of ['--approve', '-a', '--request-changes', '-r', '--approve=true']) {
  r = run(`\`agent-pullbot: ${ghDir}\``, ['42', '--repo', 'acme/web', flag, '--body-file', join(T, 'report.md')]);
  t(`AC3 ${flag} is refused and posts nothing`, [r.status, r.ran, /only a comment review is allowed/.test(r.err)], [1, null, true]);
}
r = run('`none`', ['42', '--repo', 'acme/web', '--approve', '--body-file', join(T, 'report.md')]);
t('AC3 with the row none too', [r.status, r.ran], [1, null]);
r = run('`none`', ['42', '--repo', 'acme/web', '--body-file', join(T, 'report.md'), '--body', 'x']);
t('an unknown flag is refused and posts nothing', [r.status, r.ran], [1, null]);
t('usage: no --repo is exit 2', run('`none`', ['42', '--body-file', join(T, 'report.md')]).status, 2);
for (const pr of ['', '0', 'main', '12abc']) {
  r = run('`none`', [pr, '--repo', 'acme/web', '--body-file', join(T, 'report.md')]);
  t(`a PR "${pr}" that is not a number is refused and posts nothing (gh reads "" as the branch's PR)`, [r.status, r.ran], [2, null]);
}
r = run(`\`agent-pullbot: ${ghDir}\``, ['42', '--repo', 'acme/other', '--body-file', join(T, 'report.md')]);
t('a --repo other than §0 GitHub repo is refused and posts nothing', [r.status, r.ran, r.err.includes('not this repo (acme/web)')], [1, null, true]);
t('§0 GitHub repo matches in any case', run('`none`', ['42', '--repo', 'Acme/Web', '--body-file', join(T, 'report.md')]).status, 0);

// AC4: a config directory that does not exist is refused, naming the row and the directory.
r = run(`\`agent-pullbot: ${join(T, 'missing')}\``);
t('AC4 a missing directory is refused and posts nothing', [r.status, r.ran], [1, null]);
t('AC4 naming the row and the directory', r.err.includes('§4 Review account') && r.err.includes(join(T, 'missing')), true);
r = run('`agent pullbot`');
t('a malformed row is refused, naming the row', [r.status, r.ran, r.err.includes('"Review account"')], [1, null, true]);

rmSync(T, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'review-post: all checks passed');
process.exit(fails ? 1 : 0);
