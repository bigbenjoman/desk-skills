// suite: desk-q asks each git, launchctl and ps question once per build of a view
// desk-q's home view built in this process against four fixture repos under a throwaway HOME,
// DESK_HOME and DESK_CONFIG_ROOT, with git, ps, vm_stat and launchctl on PATH as fakes that log every
// call (git and ps then run the real ones). Nothing touches launchd or your real state.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

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

// Four repos, every batch handed to the supervisor with a ticket running. alpha has a named batch as
// well as its standing one, so two batches read one supervisor label.
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
writeFileSync(LOADED, `${label('alpha')}\n${label('beta')}\n`);

const { run } = await import('../desk/bin/desk-q.mjs');
const calls = () => (existsSync(CALLS) ? readFileSync(CALLS, 'utf8').split('\n').filter(Boolean) : []);
const repeated = (cs) => [...new Set(cs.filter((c, i) => cs.indexOf(c) !== i))];
const prints = (cs, name) => cs.filter((c) => c.startsWith('launchctl\t') && c.endsWith(`/${label(name)}`)).length;

// ---- AC1, AC2, AC4: one build asks each question once, a failed one included -----------------------
rmSync(CALLS, { force: true });
const first = run(['--plain']);
const one = calls();
t('the home view was built', /alpha/.test(first) && /delta/.test(first), true);
t('AC1 launchctl print ran once for each of the four labels, alpha\'s two batches included',
  ['alpha', 'beta', 'gamma', 'delta'].map((n) => prints(one, n)), [1, 1, 1, 1]);
t('AC2 no command ran twice in one build, in the same directory with the same arguments', repeated(one), []);
t('AC2 the build asked git something', one.some((c) => c.startsWith('git\t')), true);
// gamma and delta are not loaded, so their print fails, and DESK_REPO_DIR is no git checkout, so its git reads fail.
t('AC4 a failed launchctl print was asked again and not rerun', prints(one, 'gamma'), 1);
t('AC4 a failed git read was asked again and not rerun', one.filter((c) => c.startsWith(`git\t-C ${T} `)).length > 0 && repeated(one).length === 0, true);

// ---- AC3: the next build reads afresh -----------------------------------------------------------
writeFileSync(LOADED, `${label('beta')}\n`);
rmSync(CALLS, { force: true });
const second = run(['--plain']);
const two = calls();
t('AC3 the next build asks launchctl again', ['alpha', 'beta', 'gamma', 'delta'].map((n) => prints(two, n)), [1, 1, 1, 1]);
t('AC3 the next build shows alpha\'s supervisor turned off', second !== first, true);

process.exit(fails ? 1 : 0);
