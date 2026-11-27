// suite: plugin root paths (desk-review and the finder agents reach desk scripts through <desk bin>: CLAUDE_PLUGIN_ROOT's, else ~/.claude's)
// layer: L1
// covers: skills/desk-review/** agents/**
// issue-1559. A plugin install puts desk/bin under the plugin's root, so a desk-script call in
// skills/desk-review or agents/ names it as `node <desk bin>/<script>`, and the file says how to
// resolve <desk bin>: the plugin's desk/bin when CLAUDE_PLUGIN_ROOT is set, ~/.claude's when it is not.
// Never a `${CLAUDE_PLUGIN_ROOT:-…}` expansion: the permission matcher refuses any command holding
// `${`, whatever the allow rules say, so a worker could never run it. tests/test_worker_settings.sh
// checks the resolved worker calls against the generated allow rules.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = [...walk(join(root, 'skills/desk-review')), ...walk(join(root, 'agents'))];
const text = Object.fromEntries(files.map((f) => [relative(root, f), readFileSync(f, 'utf8')]));

// AC3: nothing under skills/desk-review or agents/ names the home install's desk/bin directly.
const HARD = /~\/\.claude\/desk\/bin|\$HOME\/\.claude\/desk\/bin|\$\{HOME\}\/\.claude\/desk\/bin/;
const hard = (s) => s.split('\n').some((l) => HARD.test(l));
t('AC3 no file names ~/.claude/desk/bin directly', JSON.stringify(Object.keys(text).filter((f) => hard(text[f]))), '[]');
t('AC3 the check fails on a hard-coded call', hard('node ~/.claude/desk/bin/review-post.mjs 1'), true);
t('AC3 and on one spelled with $HOME', hard('node "$HOME/.claude/desk/bin/review-post.mjs" 1'), true);
t('AC3 but not on the <desk bin> form', hard('node <desk bin>/review-post.mjs 1'), false);

// Every desk-script call there is `node <desk bin>/<script>`; collect the scripts they call.
const FORM = /node <desk bin>\/([\w.-]+)/g;
const calls = Object.entries(text).flatMap(([f, s]) => [...s.matchAll(FORM)].map((m) => ({ file: f, script: m[1] })));
const scripts = [...new Set(calls.map((c) => c.script))].sort();
t(`the call sites use the <desk bin> form (${calls.length})`, calls.length >= 6, true);
t('every script they call is in desk/bin', JSON.stringify(scripts.filter((s) => !existsSync(join(root, 'desk/bin', s)))), '[]');
const stray = Object.entries(text).flatMap(([f, s]) => s.split('\n')
  .filter((l) => /desk\/bin\/[\w.-]+\.(mjs|sh|py)/.test(l) && /node |bash /.test(l)).map((l) => `${f}: ${l.trim().slice(0, 80)}`));
t('no desk-script call there names a desk/bin path of its own', JSON.stringify(stray), '[]');
// issue-1561: CLAUDE_PLUGIN_ROOT is not in the Bash tool's environment; a plugin writes its path in
// place of `${CLAUDE_PLUGIN_ROOT}` only in a SKILL.md or agent file it loads, never in a reference read
// later. So the variable is named there alone, and never on a line that runs something.
const loaded = (f) => /(^|\/)SKILL\.md$/.test(f) || f.startsWith('agents/');
const expansion = Object.entries(text).flatMap(([f, s]) => s.split('\n')
  .filter((l) => /\$\{CLAUDE_PLUGIN_ROOT/.test(l) && (!loaded(f) || /\bnode |\bbash |^\s*(\$ )?[\w./-]+\.(mjs|sh)\b/.test(l))).map(() => f));
t('${CLAUDE_PLUGIN_ROOT} is written only in a file the plugin loads, never in a command', JSON.stringify(expansion), '[]');

// AC1 / AC2: each file that calls through <desk bin> says how to resolve it, or names the file that does.
const RULE = '`<desk bin>` is the desk scripts folder';
const BRANCHES = ['`desk/bin` under the plugin root', 'when it reads as a path', 'else `desk/bin` under `~/.claude`'];
const flat = (s) => s.replace(/\s+/g, ' ');
const POINTERS = { 'skills/desk-review/references/gotchas.md': 'skills/desk-review/references/phase-7-post.md' };
const states = (s) => [RULE, ...BRANCHES].every((b) => flat(s).includes(b));
for (const f of [...new Set(calls.map((c) => c.file))].sort()) {
  const via = POINTERS[f];
  const ok = via ? states(text[via]) && flat(text[f]).includes(`resolved as \`${via.split('/').pop()}\` says`) : states(text[f]);
  t(`AC1 AC2 ${f} resolves <desk bin>${via ? ` through ${via}` : ''}`, ok, true);
}
t('AC1 AC2 the check fails on a file that states only the plugin branch', states(`${RULE}: ${BRANCHES[0]}`), false);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
