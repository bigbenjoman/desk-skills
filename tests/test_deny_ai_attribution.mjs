// suite: attribution hook (its §5 AI attribution read, held to desk-env's)
// layer: L2
// covers: hooks/deny-ai-attribution.py
// The hook keeps its own one-row pattern, as it runs on every Bash call; this holds that pattern's read
// to `desk-env get ai-attribution` on the same config, for every value the schema's type accepts.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPES } from '../desk/bin/config-schema.mjs';
import { scratch } from './scratch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'hooks', 'deny-ai-attribution.py');
const BIN = join(ROOT, 'desk', 'bin', 'desk-env.mjs');
const T = scratch('desk-attr-hook-');
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|GIT_)/.test(k)));
const env = (cfg) => ({ ...bare, HOME: T, DESK_CONFIG_ROOT: join(T, 'cfg'), DESK_MACHINE: join(T, 'none.md'), DESK_CONFIG: cfg });
let n = 0;
const config = (cell) => {
  const p = join(T, `c${n++}.md`);
  writeFileSync(p, `## 5. Conventions\n\n| Field | Value |\n|---|---|\n| Branch names | \`<type>/<TICKET>-slug\` |\n| AI attribution | ${cell} |\n| PR body | \`intro\` |\n`);
  return p;
};
// The hook's own read of the row, through its attribution_value.
const PY = 'import importlib.util, sys\n'
  + 's = importlib.util.spec_from_file_location("hook", sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)\n'
  + 'print(m.attribution_value(open(sys.argv[2], encoding="utf-8").read()))';
const hookRead = (cfg) => spawnSync('python3', ['-I', '-c', PY, HOOK, cfg], { encoding: 'utf8', env: env(cfg) }).stdout.trim();
const deskRead = (cfg) => { const r = spawnSync('node', [BIN, 'get', 'ai-attribution'], { encoding: 'utf8', env: env(cfg), cwd: T }); return r.status === 0 ? r.stdout.trim() : `exit ${r.status}`; };

// AC8: every value the type accepts, as its refusal names them, read alike with a trailing note in backticks.
const values = [...(TYPES['ai-attribution'].parse('?').error ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1]);
t('the schema type names the values it accepts', values.length > 0, true);
for (const v of values) {
  const c = config(`\`${v}\` (\`forbidden\` or \`allowed\`; enforced by the hook)`);
  t(`AC8 "${v}" with a trailing note: the hook and desk-env read the same value`, `${hookRead(c)} | ${deskRead(c)}`, `${v} | ${v}`);
}

// AC7: forbidden followed by a note in backticks denies a commit carrying a Claude co-author line.
const hook = (cfg, command) => {
  const r = spawnSync('python3', [HOOK], { encoding: 'utf8', env: env(cfg), input: JSON.stringify({ tool_input: { command }, cwd: T }) });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* no decision printed */ }
  return out?.hookSpecificOutput?.permissionDecision ?? 'none';
};
const commit = `git commit -m "fix: x\n\nCo-Authored-By: ${'Claude'} <noreply@${'anthropic'}.com>"`;
t('AC7 forbidden with a note in backticks: a Claude co-author line is denied',
  hook(config('`forbidden` (`no Co-Authored-By: Claude` in commits, PR bodies and Jira)'), commit), 'deny');
t('and allowed with the same note lets it through', hook(config('`allowed` (`no Co-Authored-By: Claude` in commits)'), commit), 'none');
t('and forbidden lets a commit with no attribution through', hook(config('`forbidden` (`a note`)'), 'git commit -m "fix: x"'), 'none');

process.exit(fails ? 1 : 0);
