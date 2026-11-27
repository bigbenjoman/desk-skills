#!/usr/bin/env node
// Builds desk-review as a Claude Code plugin, so a repo can enable it in its
// .claude/settings.json and a session with no desk install (a cloud session) gets the review.
//
//   node desk/bin/plugin-build.mjs <out>      write the marketplace to <out>, replacing an earlier build
//   node desk/bin/plugin-build.mjs --list     print the bundle manifest, write nothing
//
// <out> is a marketplace, `desk-skills`, holding one plugin, `desk`:
//   .claude-plugin/marketplace.json
//   desk/.claude-plugin/plugin.json        name, version, the finder agents
//   desk/.claude-plugin/bundle.json        every file shipped: the skill, the agents, the desk scripts
//   desk/skills/desk-review/**             the skill as it is in the repo
//   desk/agents/<name>.md                  each agent the skill names in backticks
//   desk/desk/bin/<script>                 the scripts it calls and everything they import
//   desk/bin/desk-env, desk-codex, desk-gh the commands it runs bare, on PATH while the plugin is on
//
// Files are copied, never linked: Claude Code refuses a symlink that leads out of a plugin. The
// scripts are the import closure of what the skill calls, so no batch, pass or setup machinery ships.
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { importClosure, relativeImports } from './import-closure.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MARKETPLACE = 'desk-skills';
export const PLUGIN = 'desk';
export const SKILL = 'skills/desk-review';
// The desk commands the skill runs bare, and the script each one runs.
export const SHIMS = { 'desk-env': 'desk/bin/desk-env.mjs', 'desk-codex': 'desk/bin/desk-codex.mjs', 'desk-gh': 'desk/bin/desk-gh.mjs' };

const walk = (d) => readdirSync(d).sort().flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const read = (root, f) => readFileSync(join(root, f), 'utf8');

export const skillFiles = (root = ROOT) => walk(join(root, SKILL)).map((p) => relative(root, p).split('\\').join('/'));

// The agents the skill routes to or refutes with: every agents/<name>.md it names as `<name>`.
export function finderAgents(root = ROOT) {
  const text = skillFiles(root).map((f) => read(root, f)).join('\n');
  return readdirSync(join(root, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    .filter((n) => text.includes(`\`${n}\``)).sort();
}

// The scripts the skill and its agents call (`node <desk bin>/<script>`), the shims' scripts and the skill's own bin.
export function entryScripts(root = ROOT) {
  const files = [...skillFiles(root), ...finderAgents(root).map((n) => `agents/${n}.md`)];
  const called = files.flatMap((f) => [...read(root, f).matchAll(/node <desk bin>\/([\w.-]+)/g)].map((m) => `desk/bin/${m[1]}`));
  const own = skillFiles(root).filter((f) => /\/bin\/[^/]+\.mjs$/.test(f));
  return [...new Set([...called, ...Object.values(SHIMS), ...own])].sort();
}

// The relative imports of one script, as repo paths: static, re-exported, side-effect and dynamic.
export const importsOf = (root, file) => [...new Set(relativeImports(file, read(root, file)))].sort();

// Every script the entries reach through their imports. `missing` names an entry with no file, or an
// import with no file behind it as `<importer> -> <import>`: the bundle would fail at run time, so
// build refuses it.
export function scriptClosure(root, entries) {
  const has = (f) => existsSync(join(root, f));
  const files = [...new Set(entries.flatMap((e) => importClosure(e, (f) => (has(f) ? read(root, f) : ''))))].filter(has).sort();
  const missing = [...entries.filter((e) => !has(e)),
    ...files.flatMap((f) => importsOf(root, f).filter((i) => !has(i)).map((i) => `${f} -> ${i}`))];
  return { files, missing: [...new Set(missing)].sort() };
}

const shim = (script) => `#!/usr/bin/env bash\n# desk plugin: runs ${script.split('/').pop()} from this plugin's desk/bin.\n`
  + `exec node "$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)/../${script}" "$@"\n`;

const version = (root) => {
  try { return `0.0.0-${execFileSync('git', ['-C', root, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()}`; } catch { return '0.0.0-dev'; }
};

// What the plugin ships, as { manifest, copies: [{ from, to }], shims: [{ to, text }] }; paths under
// the plugin directory. Throws, naming each, when an import has no file behind it.
export function bundle(root = ROOT) {
  const agents = finderAgents(root);
  const skill = skillFiles(root).filter((f) => !/\.(bak|tmp-desk)/.test(f));
  const scripts = scriptClosure(root, entryScripts(root).filter((f) => f.startsWith('desk/bin/')));
  const own = scriptClosure(root, entryScripts(root).filter((f) => !f.startsWith('desk/bin/')));
  const missing = [...scripts.missing, ...own.missing];
  if (missing.length) throw new Error(`plugin-build: imported but not in the repo, so the bundle cannot run: ${missing.join(', ')}`);
  const strays = own.files.filter((f) => !f.startsWith(`${SKILL}/`));
  const deskBin = [...new Set([...scripts.files, ...strays])].sort();
  const copies = [
    ...skill.map((f) => ({ from: f, to: f })),
    ...agents.map((n) => ({ from: `agents/${n}.md`, to: `agents/${n}.md` })),
    ...deskBin.map((f) => ({ from: f, to: f })),
  ];
  const shims = Object.entries(SHIMS).map(([name, script]) => ({ to: `bin/${name}`, text: shim(script) }));
  const manifest = {
    name: PLUGIN,
    skills: [`./${SKILL}`],
    agents: agents.map((n) => `./agents/${n}.md`),
    scripts: deskBin.map((f) => `./${f}`),
    commands: shims.map((s) => `./${s.to}`),
  };
  return { manifest, copies, shims };
}

// Writes the marketplace to <out>. Refuses a non-empty <out> that is not an earlier build.
export function build(out, root = ROOT) {
  const { manifest, copies, shims } = bundle(root);
  const market = join(out, '.claude-plugin', 'marketplace.json');
  if (existsSync(out) && readdirSync(out).length) {
    let ours = false;
    try { ours = JSON.parse(readFileSync(market, 'utf8')).name === MARKETPLACE; } catch { /* not a build */ }
    if (!ours) throw new Error(`plugin-build: ${out} is not empty and holds no earlier build; name an empty or new directory`);
    if (realpathSync(out) === realpathSync(root)) throw new Error('plugin-build: <out> is the repo itself');
    rmSync(out, { recursive: true, force: true });
  }
  const dir = join(out, PLUGIN);
  for (const { from, to } of copies) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    copyFileSync(join(root, from), join(dir, to));
    if (statSync(join(root, from)).mode & 0o111) chmodSync(join(dir, to), 0o755);
  }
  for (const { to, text } of shims) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    writeFileSync(join(dir, to), text);
    chmodSync(join(dir, to), 0o755);
  }
  const description = 'desk-review: a local code review with read-only finders, cross-vendor refutation and a verdict a required check can read';
  const json = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`); };
  json(join(dir, '.claude-plugin', 'plugin.json'), { name: PLUGIN, version: version(root), description, agents: manifest.agents });
  json(join(dir, '.claude-plugin', 'bundle.json'), manifest);
  json(market, { name: MARKETPLACE, owner: { name: MARKETPLACE }, plugins: [{ name: PLUGIN, source: `./${PLUGIN}`, description }] });
  return { manifest, files: copies.length + shims.length };
}

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const [arg] = process.argv.slice(2);
  try {
    if (!arg) { console.error('usage: plugin-build.mjs <out> | --list'); process.exit(2); }
    if (arg === '--list') { console.log(JSON.stringify(bundle().manifest, null, 2)); process.exit(0); }
    const out = resolve(arg);
    const { manifest, files } = build(out);
    console.log(`built ${MARKETPLACE} at ${out}: plugin ${PLUGIN}, ${files} files`);
    console.log(`skill:   ${manifest.skills.join(' ')}`);
    console.log(`agents:  ${manifest.agents.map((a) => a.split('/').pop().replace(/\.md$/, '')).join(' ')}`);
    console.log(`scripts: ${manifest.scripts.length} from desk/bin`);
    console.log(`enable it: "extraKnownMarketplaces": {"${MARKETPLACE}": {"source": {"source": "directory", "path": "${out}"}}}, "enabledPlugins": {"${PLUGIN}@${MARKETPLACE}": true}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
