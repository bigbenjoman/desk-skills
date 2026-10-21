// suite: command shapes Claude Code prompts on, in skill code blocks
// Each fixture under tests/fixtures/command-shapes/ teaches one shape; the checker must name its file,
// line and shape. Then the real skills/ tree must teach none of them.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanFiles, markdownFiles, report } from './command_shapes.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = join(R, 'tests/fixtures/command-shapes');
const cli = (...files) => spawnSync(process.execPath, [join(R, 'tests/command_shapes.mjs'), ...files.map((f) => join(F, f))],
  { cwd: R, encoding: 'utf8' });
const lines = (f) => scanFiles([join(F, f)], R).hits.map((h) => `${h.line} ${h.shape}`).join(', ');

// ---- one shape per fixture, through the CLI: it prints file, line and shape, and exits 1 --------
const printed = (f, line, shape) => {
  const r = cli(f);
  return r.status === 1 && r.stdout.includes(`tests/fixtures/command-shapes/${f}:${line}: ${shape}: `);
};
t('AC1 a function with a quoted brace in its body', printed('function.md', 5, 'function definition'), true);
t('AC2 a { …; } group', printed('brace-group.md', 5, 'brace group'), true);
t('AC3 a heredoc written to a file', printed('heredoc.md', 4, 'heredoc to file'), true);
t('AC4 cd <dir> &&', printed('cd.md', 4, 'cd into another directory'), true);
t('AC4 cd <dir>;', printed('cd.md', 6, 'cd into another directory'), true);
t('AC5 >> /tmp', printed('write-outside.md', 4, 'write outside cwd'), true);
t('the CLI says how to fix or exempt a hit', cli('cd.md').stdout.includes('# shape-ok: <reason>'), true);

// ---- exactly the lines that should be hit, and nothing else -----------------------------------
t('function: only the definition line', lines('function.md'), '5 function definition');
t('brace group: only the group', lines('brace-group.md'), '5 brace group');
t('heredoc: the opening line only; its body is data', lines('heredoc.md'), '4 heredoc to file');
t('cd: both forms, not the plain git line', lines('cd.md'), '4 cd into another directory, 6 cd into another directory');
t('AC5 /tmp, ~, a <placeholder>/ dir, a $VAR, >| and a redirect after a multi-line quote are outside; a relative file, /dev/null, 2>&1 and quoted text are not',
  lines('write-outside.md'), '4 write outside cwd, 5 write outside cwd, 6 write outside cwd, 7 write outside cwd, 12 write outside cwd, 13 write outside cwd');
t('AC6 untagged, text, and console output lines are not commands', lines('output.md'), '');
t('AC6 the CLI passes an output-only file', cli('output.md').status, 0);
t('AC7 a marker with a reason passes; one without is itself a hit', lines('exempt.md'), '5 exemption with no reason');
t('shapes that do not prompt: ${}, awk/jq braces in quotes (one line or several), find {}, git -C, heredoc to stdin or in "$(…)", a continued redirect',
  lines('clean.md'), '');

// ---- AC8: the real skills tree ----------------------------------------------------------------
const { hits, exempt } = scanFiles(markdownFiles([join(R, 'skills')]), R);
for (const h of hits) console.log(`FAIL ${report(h)}`);
t('AC8 no skill or reference file teaches a shape Claude Code prompts on', hits.length, 0);
const autopilot = exempt.filter((e) => e.file.startsWith('skills/desk-autopilot/'));
for (const e of autopilot) console.log(`FAIL exempted in desk-autopilot: ${e.file}:${e.line}: ${e.text}`);
t('AC8 desk-autopilot carries no exemptions', autopilot.length, 0);

// ---- AC9 and AC10: the two rewrites the shapes pointed at ---------------------------------------
const auto = readFileSync(join(R, 'skills/desk-autopilot/SKILL.md'), 'utf8');
// Each mention of the header with the line after it: the instruction wraps.
const seed = auto.split('\n').map((l, i, all) => `${l} ${all[i + 1] ?? ''}`).filter((l) => l.includes('batch-notes-header.md'));
t('AC9 seeding batch-notes.md names the Write or Edit tool or a desk/bin script',
  seed.length > 0 && seed.some((l) => /Write|Edit|desk\/bin|queue\.mjs/.test(l)) && !seed.some((l) => />>?\s*<state>/.test(l)), true);
const rest = readFileSync(join(R, 'skills/desk-jira/references/jira-rest-recipes.md'), 'utf8');
t('AC10 the Jira REST recipes name desk-jira api', rest.includes('desk-jira api'), true);
t('AC10 and show no shell function or jcurl', /\b[A-Za-z_]\w*\s*\(\)\s*\{|jcurl/.test(rest), false);

console.log(fails ? `\n${fails} failed` : '\nall command-shape checks passed');
process.exit(fails ? 1 : 0);
