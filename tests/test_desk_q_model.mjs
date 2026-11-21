// suite: desk-q's model builds the home view's JSON on its own and loads no terminal code
// covers: desk/bin/desk-q-model.mjs desk/bin/desk-q.mjs
// A Node process that imports desk-q-model.mjs alone builds home's JSON for a fixture repo under a
// throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT, and it matches `desk-q --json home` for the same
// state; and the model's import graph, walked file by file, reaches neither node:readline nor
// desk-q.mjs. launchctl and vm_stat are fakes on PATH, so nothing reads launchd or this computer's memory.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); return ok; };

const DESK_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin');
const MODEL = join(DESK_BIN, 'desk-q-model.mjs');
const DESK_Q = join(DESK_BIN, 'desk-q.mjs');

const T = scratch('desk-q-model-');
const BIN = join(T, 'bin');
mkdirSync(BIN);
const fake = (name, body) => writeFileSync(join(BIN, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
fake('vm_stat', `echo 'Mach Virtual Memory Statistics: (page size of 4096 bytes)'; echo 'Pages free: 1000000.'`);
fake('launchctl', 'exit 1');
const env = { ...process.env, HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), DESK_REPO_DIR: T, PATH: `${BIN}${delimiter}${process.env.PATH}` };
writeFileSync(env.DESK_MACHINE, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| autopilot-concurrency | `5 / 10` | x |\n');

// One repo with a batch: a running ticket and a triaged one.
const slug = 'acme__alpha';
mkdirSync(join(env.DESK_CONFIG_ROOT, 'repos', slug), { recursive: true });
writeFileSync(join(env.DESK_CONFIG_ROOT, 'repos', slug, 'config.md'),
  '## 3b. Cost and autonomy\n\n| Field | Recommended | Your setting |\n|---|---|---|\n| Preferred dev-server port | `3000` | `3100` |\n'
  + '| Autopilot worker concurrency | `2 / 3` | `2 / 3` |\n');
const queuePath = join(env.DESK_HOME, 'repos', slug, 'queue.json');
mkdirSync(dirname(queuePath), { recursive: true });
writeFileSync(queuePath, JSON.stringify({ version: 1, batch: 'alpha', concurrency: 2, tickets: {
  'ALPHA-1': { key: 'ALPHA-1', state: 'running', stage: '4/9' },
  'ALPHA-2': { key: 'ALPHA-2', state: 'triaged', lane: 'A' },
} }));

// Every age is read against its own process's clock, so the two builds are compared without them.
const timeless = (v) => (Array.isArray(v) ? v.map(timeless)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !['generated_at', 'as_of', 'age_s'].includes(k)).map(([k, x]) => [k, timeless(x)])) : v);

// ---- AC1: the model alone builds what desk-q --json home prints ---------------------------------
const alone = `const m = await import(${JSON.stringify(pathToFileURL(MODEL).href)});
const now = Date.now();
console.log(JSON.stringify(m.homeJson(m.loadRepos(now), { now }), null, 2));`;
const node = (args) => execFileSync(process.execPath, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fromModel = JSON.parse(node(['--input-type=module', '-e', alone]));
const fromCli = JSON.parse(node([DESK_Q, '--json', 'home']));
t('the fixture repo is on home, its ticket running', fromModel.repos.map((r) => [r.name, r.running]), [['alpha', 1]]);
if (!t('AC1 the model alone builds the home JSON desk-q --json home prints, ages aside', timeless(fromModel), timeless(fromCli))) {
  console.log(JSON.stringify(fromModel, null, 2));
  console.log(JSON.stringify(fromCli, null, 2));
}
t('AC1 the plain lines are the same too', fromModel.lines, fromCli.lines);

// ---- AC2: the model's import graph holds neither node:readline nor desk-q.mjs -------------------
// Every module specifier in a file: static imports, re-exports and dynamic import() of a literal.
const specs = (file) => [...readFileSync(file, 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
function graph(start) {
  const seen = new Set(), builtins = new Set(), todo = [start];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of specs(f)) {
      if (s.startsWith('node:')) builtins.add(s);
      else if (s.startsWith('.')) { const p = resolve(dirname(f), s); if (existsSync(p)) todo.push(p); }
    }
  }
  return { files: [...seen], builtins: [...builtins] };
}
const g = graph(MODEL);
t('the walk follows the model\'s own imports (needs-you.mjs among them)', g.files.some((f) => f.endsWith('/needs-you.mjs')), true);
t('AC2 no module the model reaches imports node:readline', g.builtins.filter((b) => b === 'node:readline'), []);
t('AC2 no module the model reaches imports desk-q.mjs, the terminal module', g.files.filter((f) => f.endsWith('/desk-q.mjs')), []);
t('desk-q.mjs itself does import node:readline, so the walk would see it', specs(DESK_Q).includes('node:readline'), true);

process.exit(fails ? 1 : 0);
