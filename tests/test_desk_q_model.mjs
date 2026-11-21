// suite: desk-q's model builds the home view's JSON on its own and loads no terminal code
// covers: desk/bin/desk-q-model.mjs desk/bin/desk-q.mjs
// A Node process that imports desk-q-model.mjs alone builds home's JSON for a fixture repo under a
// throwaway HOME, DESK_HOME and DESK_CONFIG_ROOT, and it matches `desk-q --json home` for the same
// state; and a resolve hook in that process sees every module it loads, through the build too, and
// neither node:readline nor desk-q.mjs is among them. launchctl and vm_stat are fakes on PATH and
// available memory is pinned (DESK_MEM_AVAIL_GB), so nothing reads launchd or this computer's memory.
import { mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
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
// Each process reads available memory for itself, so a live reading would differ between the two builds.
const env = { ...process.env, HOME: join(T, 'home'), DESK_HOME: join(T, 'deskhome'), DESK_CONFIG_ROOT: join(T, 'config'), DESK_MACHINE: join(T, 'machine.md'),
  DESK_PLATFORM: 'darwin', DESK_SKILLS_DIR: join(T, 'skills'), DESK_REPO_DIR: T, DESK_MEM_AVAIL_GB: '12', PATH: `${BIN}${delimiter}${process.env.PATH}` };
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

// A Node process that records every module it resolves (import, import() and require alike, a query
// string dropped) while it imports `mod` and runs `build`, and prints { out, loaded }.
const traced = (mod, build) => `import { registerHooks } from 'node:module';
const loaded = new Set();
registerHooks({ resolve(s, c, next) { const r = next(s, c); loaded.add(r.url.replace(/[?#].*$/, '')); return r; } });
const m = await import(${JSON.stringify(pathToFileURL(mod).href)});
const out = ${build};
console.log(JSON.stringify({ out, loaded: [...loaded] }));`;
const node = (args) => execFileSync(process.execPath, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const run = (mod, build) => JSON.parse(node(['--input-type=module', '-e', traced(mod, build)]));
const terminal = (urls) => urls.filter((u) => u === 'node:readline' || u.endsWith('/desk-q.mjs'));

// ---- AC1: the model alone builds what desk-q --json home prints ---------------------------------
const alone = run(MODEL, '(() => { const now = Date.now(); return m.homeJson(m.loadRepos(now), { now }); })()');
const fromModel = alone.out;
const fromCli = JSON.parse(node([DESK_Q, '--json', 'home']));
t('the fixture repo is on home, its ticket running', fromModel.repos.map((r) => [r.name, r.running]), [['alpha', 1]]);
if (!t('AC1 the model alone builds the home JSON desk-q --json home prints, ages aside', timeless(fromModel), timeless(fromCli))) {
  console.log(JSON.stringify(fromModel, null, 2));
  console.log(JSON.stringify(fromCli, null, 2));
}
t('AC1 the plain lines are the same too', fromModel.lines, fromCli.lines);

// ---- AC2: what the model loads holds neither node:readline nor desk-q.mjs -----------------------
t('the hook saw the model\'s own imports (needs-you.mjs among them)', alone.loaded.some((u) => u.endsWith('/needs-you.mjs')), true);
t('AC2 importing the model and building home loads neither node:readline nor desk-q.mjs', terminal(alone.loaded), []);
t('importing desk-q.mjs does load both, so the hook would see them',
  terminal(run(DESK_Q, 'null').loaded).map((u) => u.replace(/^.*\//, '')).sort(), ['desk-q.mjs', 'node:readline']);

process.exit(fails ? 1 : 0);
