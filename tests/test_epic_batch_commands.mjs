// suite: epic batch commands (every desk/bin command on desk-autopilot's epic path names the epic's batch)
// covers: skills/desk-autopilot/** desk/bin/**
// An epic runs as its own batch beside the standing one, so a desk/bin command run on its path without
// `--batch <EPIC>` acts on the standing batch. The epic path is desk-autopilot's epic-batch.md (the
// start, expansion, plan and close-out) and feature-mode.md (an epic's feature mode). A command is
// inline code or a code-block line that runs one of desk/bin's scripts with an argument.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const refs = join(root, 'skills/desk-autopilot/references');
const EPIC_PATH = ['epic-batch.md', 'feature-mode.md'];
const scripts = readdirSync(join(root, 'desk/bin')).filter((f) => /\.(mjs|sh)$/.test(f));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A script run with an argument after it; `desk-env` is also run by its bare name.
const RUNS = new RegExp(`(?:^|[\\s/])(?:${[...scripts.map(esc), 'desk-env'].join('|')})[ \\t]+[^\\s#]`);
const NAMED = /--batch[ =](?:<EPIC>|[A-Z][A-Z0-9]*-\d+)(?![\w-])/;

// -> each command in a markdown text: code-block lines (comments dropped) and inline code, joined
// across line breaks.
function commands(text) {
  const out = [];
  let fence = false;
  const prose = [];
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; prose.push(''); continue; }
    if (fence) out.push(line.replace(/\s+#.*$/, '').trim());
    else prose.push(line);
  }
  for (const para of prose.join('\n').split(/\n\s*\n/)) {
    for (const m of para.replace(/\s*\n\s*/g, ' ').matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out.filter((c) => RUNS.test(c));
}
const unnamed = (text) => commands(text).filter((c) => !NAMED.test(c));

// The check itself can fail, and passes what it should.
t('a command with no --batch is caught', unnamed('Run `node ~/.claude/desk/bin/queue.mjs approve <SPINE>` now.'), ['node ~/.claude/desk/bin/queue.mjs approve <SPINE>']);
t('so is one in a code block', unnamed('```bash\nnode ~/.claude/desk/bin/pass.mjs --json   # one pass\n```'), ['node ~/.claude/desk/bin/pass.mjs --json']);
t('so is one wrapped across lines', unnamed('the hand-over (`queue.mjs set-batch\n  supervised=true`) and'), ['queue.mjs set-batch supervised=true']);
t('so is one naming another option', unnamed('`answer.mjs X-1 "a" --batch-size 2`'), ['answer.mjs X-1 "a" --batch-size 2']);
t('--batch <EPIC> or an epic key passes', unnamed('`queue.mjs approve <SPINE> --batch <EPIC>` and `triage.sh X-2 --batch=ABC-900`'), []);
t('a script named with no argument is no command', commands('`pass.mjs` reads it, `base-gate.mjs` runs, `ledger not updated`'), []);

for (const f of EPIC_PATH) {
  const text = readFileSync(join(refs, f), 'utf8');
  const found = commands(text);
  t(`${f}: its commands are read (${found.length})`, found.length >= 5, true);
  t(`${f}: every desk/bin command passes --batch <EPIC>`, unnamed(text), []);
}

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
