// suite: desk-q asks each git, launchctl and ps question once per build of a view
// desk-q's home view built in this process against four fixture repos under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT, with git, ps, vm_stat and launchctl on PATH as fakes that log every
// call (git and ps then run the real ones). Nothing touches launchd or your real state.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); return ok; };

const T = scratch('desk-q-once-');
const BIN = join(T, 'bin');
const CALLS = join(T, 'calls');
const LOADED = join(T, 'loaded');
mkdirSync(BIN);
const real = (name) => process.env.PATH.split(delimiter).map((d) => join(d, name)).find((p) => existsSync(p));
const log = (name) => `printf '%s\\t%s\\n' ${name} "$*" >> ${JSON.stringify(CALLS)}\n`;
const fake = (name, body) => writeFileSync(join(BIN, name), `#!/bin/sh\n${log(name)}${body}\n`, { mode: 0o755 });
fake('git', `exec ${JSON.stringify(real('git'))} "$@"`);
fake('ps', `exec ${JSON.stringify(real('ps'))} "$@"`);
fake('vm_stat', `echo 'Mach Virtual Memory Statistics: (page size of 4096 bytes)'; echo 'Pages free: 1000000.'`);
// `print gui/<uid>/<label>` exits 0 for each label in LOADED, else 1, as an agent launchd has not loaded.
fake('launchctl', `grep -qxF "\${2##*/}" ${JSON.stringify(LOADED)} 2>/dev/null || exit 1\necho 'state = waiting'`);

Object.assign(process.env, { HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), DESK_REPO_DIR: T, PATH: `${BIN}${delimiter}${process.env.PATH}` });
writeFileSync(process.env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

// Four repos, every batch handed to the supervisor with a ticket running. alpha (loaded) and gamma
// (not loaded) each have a named batch as well as their standing one, so two batches read one
// supervisor label: alpha's print succeeds, gamma's fails.
const label = (name) => `com.desk-skills.supervisor.acme__${name}`;
const queue = (file, batch, key) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, batch, supervised: true, concurrency: 2, tickets: { [key]: { key, state: 'running', stage: '4/9' } } }));
};
['alpha', 'beta', 'gamma', 'delta'].forEach((name, i) => {
  const slug = `acme__${name}`;
  mkdirSync(join(process.env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
  writeFileSync(join(process.env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
    `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | \`3000\` | \`${3100 + i * 100}\` |\n`
    + '| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n| Batches run by | `supervisor` | `supervisor` |\n');
  queue(join(process.env.DESK_HOME, 'repos', slug, 'queue.json'), name, `${name.toUpperCase()}-1`);
});
queue(join(process.env.DESK_HOME, 'repos', 'acme__alpha', 'batches', 'epic', 'queue.json'), 'epic', 'ALPHA-2');
queue(join(process.env.DESK_HOME, 'repos', 'acme__gamma', 'batches', 'epic', 'queue.json'), 'epic', 'GAMMA-2');
writeFileSync(LOADED, `${label('alpha')}\n${label('beta')}\n`);

const { run } = await import('../desk/bin/desk-q.mjs');
const { READS } = await import('../desk/bin/needs-you.mjs');
const { oneBuild } = await import('../desk/bin/build-memo.mjs');
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').split('\n').filter(Boolean) : []);
const repeated = (cs) => [...new Set(cs.filter((c, i) => cs.indexOf(c) !== i))];
const prints = (cs, name) => cs.filter((c) => c.startsWith('launchctl\t') && c.endsWith(`/${label(name)}`)).length;

// ---- AC1, AC2, AC4: one build asks each question once, a failed one included -----------------------
rmSync(CALLS, { force: true });
// --all: the home view otherwise hides a quiet repo whose supervisor is loaded, as alpha's is.
const first = run(['--plain', '--all']);
const one = calls();
if (!t('the home view was built', /alpha/.test(first) && /delta/.test(first), true)) console.log(first);
t('AC1 launchctl print ran once for each of the four labels, alpha\'s and gamma\'s two batches included',
  ['alpha', 'beta', 'gamma', 'delta'].map((n) => prints(one, n)), [1, 1, 1, 1]);
t('AC2 no command ran twice in one build, in the same directory with the same arguments', repeated(one), []);

// This checkout is a git repo, so `git -C HERE rev-parse HEAD` succeeds: asked twice in one build it
// runs once, and both answers are the same commit.
const HERE = dirname(new URL(import.meta.url).pathname);
const headOf = (dir, cs) => cs.filter((c) => c === `git\t-C ${dir} rev-parse HEAD`).length;
rmSync(CALLS, { force: true });
const okTwice = oneBuild(() => [READS.git(HERE, ['rev-parse', 'HEAD']), READS.git(HERE, ['rev-parse', 'HEAD'])]);
t('AC2 a git read asked twice in one build ran once, both answers the commit',
  [/^[0-9a-f]{40}$/.test(okTwice[0] ?? ''), okTwice[0] === okTwice[1], headOf(HERE, calls())], [true, true, 1]);
// gamma is not loaded and both its batches ask for its print, which fails: it runs once.
t('AC4 a failed launchctl print was asked again and not rerun', prints(one, 'gamma'), 1);

// T is no git checkout, so `git -C T rev-parse HEAD` fails: asked twice in one build it runs once and
// both answers are the failure; asked twice outside a build it runs twice.
const headOfT = (cs) => headOf(T, cs);
rmSync(CALLS, { force: true });
const inBuild = oneBuild(() => [READS.git(T, ['rev-parse', 'HEAD']), READS.git(T, ['rev-parse', 'HEAD'])]);
t('AC4 a failed git read asked twice in one build: both fail, it ran once', [inBuild, headOfT(calls())], [[null, null], 1]);
rmSync(CALLS, { force: true });
READS.git(T, ['rev-parse', 'HEAD']); READS.git(T, ['rev-parse', 'HEAD']);
t('outside a build the same git read runs each time', headOfT(calls()), 2);

// ---- AC3: the next build reads afresh -----------------------------------------------------------
writeFileSync(LOADED, `${label('beta')}\n`);
rmSync(CALLS, { force: true });
const second = run(['--plain', '--all']);
const two = calls();
t('AC3 the next build asks launchctl again', ['alpha', 'beta', 'gamma', 'delta'].map((n) => prints(two, n)), [1, 1, 1, 1]);
// A line naming the repo that says its supervisor is off (the pass cell, or the band's "supervisor on" fix).
const offFor = (screen, name) => screen.split('\n').some((l) => l.includes(name) && /supervisor (is )?off|supervisor on/.test(l));
t('the first build shows gamma\'s supervisor off and alpha\'s not', [offFor(first, 'gamma'), offFor(first, 'alpha')], [true, false]);
t('AC3 the next build shows alpha\'s supervisor turned off', offFor(second, 'alpha'), true);

process.exit(fails ? 1 : 0);
