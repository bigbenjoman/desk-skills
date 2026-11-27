// suite: plugin root paths (desk-review and the finder agents reach desk scripts through CLAUDE_PLUGIN_ROOT, else ~/.claude)
// layer: L1
// covers: skills/desk-review/** agents/**
// issue-1559. A plugin install puts desk/bin under the plugin's root, so a desk-script call in
// skills/desk-review or agents/ must name it as "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/desk/bin/<script>":
// the plugin's copy when CLAUDE_PLUGIN_ROOT is set, ~/.claude/desk/bin as before when it is not.
import { readFileSync, readdirSync, statSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = [...walk(join(root, 'skills/desk-review')), ...walk(join(root, 'agents'))];

// AC3: nothing under skills/desk-review or agents/ names the home install's desk/bin directly.
const HARD = /~\/\.claude\/desk\/bin|\$HOME\/\.claude\/desk\/bin|\$\{HOME\}\/\.claude\/desk\/bin/;
const hard = (s) => s.split('\n').some((l) => HARD.test(l));
t('AC3 no file names ~/.claude/desk/bin directly', JSON.stringify(files.filter((f) => hard(readFileSync(f, 'utf8'))).map((f) => relative(root, f))), '[]');
t('AC3 the check fails on a hard-coded call', hard('node ~/.claude/desk/bin/review-post.mjs 1'), true);
t('AC3 and on one spelled with $HOME', hard('node "$HOME/.claude/desk/bin/review-post.mjs" 1'), true);
t('AC3 but not on the plugin-root form', hard('node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/desk/bin/review-post.mjs" 1'), false);

// Every desk-script call in those files uses the one form; collect the scripts they call.
const FORM = /"\$\{CLAUDE_PLUGIN_ROOT:-\$HOME\/\.claude\}\/desk\/bin\/([\w.-]+)"/g;
const calls = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(FORM)].map((m) => ({ file: relative(root, f), script: m[1] })));
const scripts = [...new Set(calls.map((c) => c.script))].sort();
t(`the call sites use the plugin-root form (${calls.length})`, calls.length >= 6, true);
t('every script they call is in desk/bin', JSON.stringify(scripts.filter((s) => !existsSync(join(root, 'desk/bin', s)))), '[]');
const stray = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => /desk\/bin\/[\w.-]+\.(mjs|sh|py)/.test(l) && /node |bash /.test(l) && !new RegExp(FORM.source).test(l)).map((l) => `${relative(root, f)}: ${l.trim().slice(0, 80)}`));
t('no desk-script call there uses another form', JSON.stringify(stray), '[]');

// AC1 / AC2: the form resolves, in bash, to a fixture copy of desk/bin when CLAUDE_PLUGIN_ROOT is set,
// and to $HOME/.claude/desk/bin when it is unset or empty.
const tmp = scratch('plugin-root');
const plugin = join(tmp, 'plugin'), home = join(tmp, 'home');
for (const base of [join(plugin, 'desk/bin'), join(home, '.claude/desk/bin')]) {
  mkdirSync(base, { recursive: true });
  for (const s of scripts) copyFileSync(join(root, 'desk/bin', s), join(base, s));
}
const resolve = (script, env) => execFileSync('bash', ['-c', `printf %s "\${CLAUDE_PLUGIN_ROOT:-$HOME/.claude}/desk/bin/${script}"`],
  { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: 'utf8' });
for (const s of scripts) {
  const set = resolve(s, { CLAUDE_PLUGIN_ROOT: plugin });
  t(`AC1 ${s} resolves under CLAUDE_PLUGIN_ROOT`, set, join(plugin, 'desk/bin', s));
  t(`AC1 and that copy is there`, existsSync(set), true);
  t(`AC2 ${s} resolves to ~/.claude/desk/bin when it is unset`, resolve(s, {}), join(home, '.claude/desk/bin', s));
  t(`AC2 and when it is empty`, resolve(s, { CLAUDE_PLUGIN_ROOT: '' }), join(home, '.claude/desk/bin', s));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
