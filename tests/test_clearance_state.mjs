// suite: desk-clearance state (config rows read through desk-env)
// layer: L2
// covers: skills/desk-clearance/bin/clearance-state.mjs
// clearance-state.mjs reads its config rows through desk-env, so the memory ceiling `capacity` reports
// names the source `desk-env get memory-ceiling` reads it from. Scratch directories only.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'skills', 'desk-clearance', 'bin', 'clearance-state.mjs');
const BIN = join(ROOT, 'desk', 'bin', 'desk-env.mjs');
const T = scratch('desk-clearance-');
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const bare = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DESK_|GIT_)/.test(k)));
let n = 0;
const run = (ceilingCell, machine) => {
  const cfg = join(T, `c${n}.md`);
  writeFileSync(cfg, '## 0. This repo\n\n| Field | Value |\n|---|---|\n| GitHub repo | `acme/widget` |\n\n'
    + `## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Memory ceiling for parallel work (GB) | WSL: \`16\` | ${ceilingCell} |\n`);
  const profile = join(T, `m${n++}.md`);
  if (machine) writeFileSync(profile, `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| memory-ceiling-gb | \`${machine}\` | x |\n`);
  const env = { ...bare, HOME: T, DESK_CONFIG_ROOT: join(T, 'cfg'), DESK_CONFIG: cfg, DESK_MACHINE: profile, DESK_ENV_MJS: BIN, DESK_CLEARANCE_DIR: join(T, 'state') };
  const r = spawnSync('node', [SCRIPT, 'capacity'], { encoding: 'utf8', env, cwd: T });
  const head = /of (\d+)G ceiling \((.*)\), /.exec(r.stdout);
  const get = spawnSync('node', [BIN, 'get', 'memory-ceiling'], { encoding: 'utf8', env, cwd: T }).stdout.trim();
  return { line: head ? `${head[1]}G ${head[2]}` : `exit ${r.status}: ${r.stderr.trim()}`, get };
};

let r = run('`24` (`GB`; the WSL default is `16`)');
t('AC6 a ceiling with a trailing note in backticks: the figure desk-env reads, named as config §3b', `${r.line} | ${r.get}`,
  '24G config §3b Memory ceiling for parallel work (GB) | 24');
r = run('`TODO` (`<GB>`)', '20');
t('a row left TODO: the machine profile\'s figure, named as the profile', `${r.line} | ${r.get}`, '20G machine profile memory-ceiling-gb | 20');
r = run('`32`', '16');
t('a row above the profile\'s limit: the profile\'s figure, named as the profile, as desk-env caps it', `${r.line} | ${r.get}`, '16G machine profile memory-ceiling-gb | 16');

process.exit(fails ? 1 : 0);
