// suite: prose baseline guard, a pull request cannot add an entry to the prose baseline
// covers: tests/fixtures/prose-baseline-guard/*.json .github/workflows/tests.yml
// tests/prose_baseline_guard.mjs on fixture baselines, then its --base form in a scratch repo, then the
// CI step that runs it on every pull request.
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grown, report, BASELINE_PATH } from './prose_baseline_guard.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const g = JSON.stringify(got); const w = JSON.stringify(want); const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`); };
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = join(R, 'tests/fixtures/prose-baseline-guard');
const load = (f) => JSON.parse(readFileSync(join(F, f), 'utf8'));
const guard = (args, cwd = R) => spawnSync(process.execPath, [join(R, 'tests/prose_baseline_guard.mjs'), ...args], { cwd, encoding: 'utf8' });

// ---- AC1: an added entry fails, naming it ---------------------------------------------------------
t('AC1 the added entry, and only it, is growth', grown(load('base.json'), load('grown.json')).map((e) => e.value), ['frobnicate']);
const g1 = guard([join(F, 'base.json'), join(F, 'grown.json')]);
t('AC1 the guard exits 1 and names the entry', [g1.status, g1.stdout.includes(`${BASELINE_PATH} gains an entry: skills/desk-a/SKILL.md: subcommand frobnicate (in: node queue.mjs frobnicate <KEY>)`)], [1, true]);
t('a second copy of an entry the base holds once is growth', grown(load('base.json'), [...load('base.json'), load('base.json')[2]]).length, 1);

// ---- AC2: an entry moved to another file with its reference is not growth -------------------------
t('AC2 a moved entry is not growth', grown(load('base.json'), load('moved.json')), []);
const g2 = guard([join(F, 'base.json'), join(F, 'moved.json')]);
t('AC2 the guard passes', [g2.status, /does not grow \(3 entries at the base, 3 now\)/.test(g2.stdout)], [0, true]);
t('a shrinking baseline passes', [grown(load('base.json'), load('base.json').slice(1)).length, guard([join(F, 'base.json'), join(F, 'base.json')]).status], [0, 0]);
t('the report names the file, kind, value and context', report(load('grown.json')[2]), `${BASELINE_PATH} gains an entry: skills/desk-a/SKILL.md: subcommand frobnicate (in: node queue.mjs frobnicate <KEY>)`);
t('a usage error exits 2', guard(['--base']).status, 2);

// ---- the --base form: the baseline at a ref against the working tree's -----------------------------
const T = scratch('desk-prose-guard-');
const git = (...a) => execFileSync('git', ['-C', T, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q');
mkdirSync(join(T, 'tests/fixtures'), { recursive: true });
writeFileSync(join(T, BASELINE_PATH), readFileSync(join(F, 'base.json')));
git('add', '-A');
git('commit', '-qm', 'base');
writeFileSync(join(T, BASELINE_PATH), readFileSync(join(F, 'grown.json')));
const g3 = guard(['--base', 'HEAD'], T);
t('AC1 --base fails on an entry the ref does not hold', [g3.status, g3.stdout.includes('subcommand frobnicate')], [1, true]);
writeFileSync(join(T, BASELINE_PATH), readFileSync(join(F, 'moved.json')));
t('AC2 --base passes a moved entry', guard(['--base', 'HEAD'], T).status, 0);
t('a baseline missing at the base counts as empty', guard(['--base', 'no-such-ref'], T).status, 1);

// ---- CI: the step runs on every pull request, whatever it changes ----------------------------------
const yml = readFileSync(join(R, '.github/workflows/tests.yml'), 'utf8');
const plan = yml.slice(yml.indexOf('\n  plan:\n'), yml.indexOf('\n  bash32:\n'));
const step = plan.split(/\n(?=      - )/).find((s) => s.includes('prose_baseline_guard.mjs')) ?? '';
t('the plan job runs the guard against the base', /run: node tests\/prose_baseline_guard\.mjs --base HEAD\^1$/m.test(step), true);
t('only on a pull request, and on every one: no path filter or other condition', [/^\s+if: github\.event_name == 'pull_request'$/m.test(step), step.match(/^\s+if:/gm)?.length], [true, 1]);
t('before the suites are chosen, so a scope that runs nothing still runs it', plan.indexOf('prose_baseline_guard.mjs') < plan.indexOf('scope_sections.mjs'), true);
t('the workflow has no paths filter that could skip a baseline-only change', /^\s+paths(-ignore)?:/m.test(yml.slice(0, yml.indexOf('\njobs:'))), false);

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
