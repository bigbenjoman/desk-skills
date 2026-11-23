// suite: prose baseline guard, a pull request cannot add an entry to the prose baseline
// layer: L2
// covers: tests/fixtures/prose-baseline-guard/*.json .github/workflows/tests.yml
// tests/prose_baseline_guard.mjs on fixture baselines, then its --base form in a scratch repo, then the
// CI step that runs it on every pull request.
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grown, report, BASELINE_PATH } from './prose_baseline_guard.mjs';
import { parseWorkflow, mapping, jobSteps } from '../desk/bin/workflow-yaml.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const g = JSON.stringify(got); const w = JSON.stringify(want); const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`); };
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = join(R, 'tests/fixtures/prose-baseline-guard');
const load = (f) => JSON.parse(readFileSync(join(F, f), 'utf8'));
const guard = (args, cwd = R) => spawnSync(process.execPath, [join(R, 'tests/prose_baseline_guard.mjs'), ...args], { cwd, encoding: 'utf8' });

// ---- AC1 and AC2 on the fixtures: an added entry is growth, a moved one is not ---------------------
t('AC1 the added entry, and only it, is growth', grown(load('base.json'), load('grown.json')).map((e) => e.value), ['frobnicate']);
t('a second copy of an entry the base holds once is growth', grown(load('base.json'), [...load('base.json'), load('base.json')[2]]).length, 1);
t('AC2 a moved entry is not growth', grown(load('base.json'), load('moved.json')), []);
t('a shrinking baseline is not growth', grown(load('base.json'), load('base.json').slice(1)).length, 0);
t('the report names the file, kind, value and context', report(load('grown.json')[2]), `${BASELINE_PATH} gains an entry: skills/desk-a/SKILL.md: subcommand frobnicate (in: node queue.mjs frobnicate <KEY>)`);
t('a usage error exits 2', [guard(['--base']).status, guard([join(F, 'base.json'), join(F, 'grown.json')]).status], [2, 2]);

// ---- the --base form CI runs: the baseline at a ref against the working tree's ---------------------
const T = scratch('desk-prose-guard-');
const git = (...a) => execFileSync('git', ['-C', T, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q');
mkdirSync(join(T, 'tests/fixtures'), { recursive: true });
writeFileSync(join(T, BASELINE_PATH), readFileSync(join(F, 'base.json')));
git('add', '-A');
git('commit', '-qm', 'base');
const at = (fixture, ref = 'HEAD') => { writeFileSync(join(T, BASELINE_PATH), readFileSync(join(F, fixture))); return guard(['--base', ref], T); };
const g1 = at('grown.json');
t('AC1 the guard exits 1 and names the entry', [g1.status, g1.stdout.includes(report(load('grown.json')[2]))], [1, true]);
const g2 = at('moved.json');
t('AC2 the guard passes a moved entry', [g2.status, /does not grow \(3 entries at the base, 3 now\)/.test(g2.stdout)], [0, true]);
writeFileSync(join(T, BASELINE_PATH), JSON.stringify(load('base.json').slice(1)));
t('the guard passes a shrinking baseline', guard(['--base', 'HEAD'], T).status, 0);
t('a baseline missing at the base counts as empty', at('base.json', 'no-such-ref').status, 1);

// ---- CI: the step runs on every pull request, whatever it changes, and its failure fails `tests` --
const wf = parseWorkflow(readFileSync(join(R, '.github/workflows/tests.yml'), 'utf8'));
const job = (id) => wf.jobs.find((j) => j.id === id);
const text = (k) => [k?.value ?? '', ...(k?.block ?? []).map((l) => l.text)].join('\n');
const steps = jobSteps(job('plan'));
const gi = steps.findIndex((s) => text(s.run).includes('prose_baseline_guard.mjs'));
const step = steps[gi] ?? {};
t('the plan job runs the guard against the base', step.run?.value, 'node tests/prose_baseline_guard.mjs --base HEAD^1');
t('only on a pull request, and nothing lets it fail quietly: no continue-on-error on the step or the job',
  [step.if?.value, Object.keys(step).sort(), 'continue-on-error' in job('plan').keys], ["github.event_name == 'pull_request'", ['if', 'name', 'run'], false]);
t('before the suites are chosen, so a scope that runs nothing still runs it', gi >= 0 && gi < steps.findIndex((s) => text(s.run).includes('scope_sections.mjs')), true);
const pr = mapping(wf.on.block).pull_request;
t('every pull request triggers the workflow: pull_request carries no paths, branches or other filter', [pr?.value, pr?.block.filter((l) => !l.blank).length], ['', 0]);
t('the required tests job needs the plan job', /\bplan\b/.test(job('tests').keys.needs?.value ?? ''), true);

console.log(fails ? `${fails} FAILED` : 'all ok');
process.exit(fails ? 1 : 0);
