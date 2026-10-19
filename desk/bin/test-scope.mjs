// What an autopilot worker tests before it pushes: the tests related to its changed files, or the
// full suites. CI runs the full suites on every push regardless, so a worker runs only what its
// change can break, found through the import graph by the configured §4 Related tests command
// (`vitest related`, `jest --findRelatedTests`, or a pytest affected-set command). Some changes reach
// tests no import graph walk from the changed file finds, and those run the full suites:
//   - a lockfile: every dependency can have moved
//   - a root file, or a test or build config anywhere (package.json, tsconfig, *.config.*, conftest.py,
//     pyproject.toml, …): it changes how every test of its project runs
//   - a file in a shared package: a JS workspace package another workspace package depends on, whose
//     dependants' tests sit in other projects that a per-project related run never looks at
//   - a deleted or renamed file: its importers cannot be found from a path that no longer exists
// Pure apart from workspacePackages(), which reads the workspace manifests under a root.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export const LOCKFILES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock',
]);
// Files at the root that change no test: documentation and licences.
const DOC = /(^|\/)(README|CHANGELOG|CONTRIBUTING|LICEN[CS]E|NOTICE|CODEOWNERS)([.-][^/]*)?$|\.(md|markdown|mdx|txt|rst)$/i;
// Test and build config, wherever it sits: it changes how every test of its project runs.
const CONFIG = /(^|\/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|[^/]+\.config\.[cm]?[jt]s|[^/]+\.config\.json|(jest|vitest)\.(setup|workspace)[^/]*|vitest\.workspace\.[^/]+|\.babelrc[^/]*|\.swcrc|conftest\.py|pyproject\.toml|setup\.cfg|setup\.py|pytest\.ini|tox\.ini|pnpm-workspace\.yaml|turbo\.json|nx\.json)$/;

const base = (p) => p.slice(p.lastIndexOf('/') + 1);
export const isLockfile = (path) => LOCKFILES.has(base(path));
export const isConfig = (path) => (!path.includes('/') && !DOC.test(path)) || CONFIG.test(path);

// `git diff --name-status -M` lines (and `?? <path>` for untracked files) -> [{ status, path, from }].
export function parseNameStatus(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length === 1) { const m = /^\?\?\s+(.+)$/.exec(line); if (m) out.push({ status: 'A', path: m[1] }); continue; }
    const status = f[0][0];
    if ((status === 'R' || status === 'C') && f.length >= 3) out.push({ status, path: f[2], from: f[1] });
    else out.push({ status, path: f[1] });
  }
  return out;
}

// The workspace globs of a JS monorepo (pnpm-workspace.yaml's `packages:`, else package.json's
// `workspaces`), each expanded to the directories under the root that hold a package.json.
// -> [{ dir, name, deps: [names] }]
export function workspacePackages(root) {
  const read = (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return null; } };
  let globs = [];
  const pnpm = read('pnpm-workspace.yaml');
  if (pnpm) {
    const block = /^packages:\s*\n((?:[ \t]*(?:-.*|#.*)?\n?)*)/m.exec(pnpm)?.[1] ?? '';
    globs = block.split('\n').map((l) => /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(l)?.[1]).filter(Boolean);
  } else {
    try {
      const w = JSON.parse(read('package.json') ?? '{}').workspaces;
      globs = Array.isArray(w) ? w : Array.isArray(w?.packages) ? w.packages : [];
    } catch { globs = []; }
  }
  const isDir = (p) => { try { return statSync(join(root, p)).isDirectory(); } catch { return false; } };
  const subdirs = (p) => { try { return readdirSync(join(root, p)).filter((d) => d !== 'node_modules' && !d.startsWith('.') && isDir(posix.join(p, d))).map((d) => posix.join(p, d)); } catch { return []; } };
  const dirs = new Set();
  const excluded = new Set();
  for (const raw of globs) {
    const neg = raw.startsWith('!');
    const g = raw.replace(/^!/, '').replace(/^\.\//, '').replace(/\/+$/, '');
    let found = [];
    if (g.endsWith('/**')) {
      const walk = (p) => { for (const d of subdirs(p)) { found.push(d); walk(d); } };
      walk(g.slice(0, -3));
    } else if (g.endsWith('/*')) found = subdirs(g.slice(0, -2));
    else if (!g.includes('*')) found = [g];
    for (const d of found) (neg ? excluded : dirs).add(d);
  }
  const out = [];
  for (const dir of [...dirs].filter((d) => !excluded.has(d)).sort()) {
    const text = read(posix.join(dir, 'package.json'));
    if (!text) continue;
    try {
      const p = JSON.parse(text);
      const deps = Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies, ...p.optionalDependencies });
      out.push({ dir, name: p.name ?? null, deps });
    } catch { /* an unreadable manifest is no package */ }
  }
  return out;
}

// -> [{ dir, name, by: [dependant dirs] }]: the workspace packages another workspace package depends on.
export function sharedPackages(pkgs) {
  return pkgs.filter((p) => p.name).map((p) => ({ dir: p.dir, name: p.name, by: pkgs.filter((q) => q !== p && q.deps.includes(p.name)).map((q) => q.dir) }))
    .filter((p) => p.by.length);
}

const under = (path, dir) => dir === '.' || path === dir || path.startsWith(`${dir}/`);

// The decision. `changes` from parseNameStatus; `shared` from sharedPackages; `related` is whether
// §4 Related tests is set to something other than none.
// -> { scope: 'full' | 'related' | 'none', reason, files }
export function decide(changes, { shared = [], related = true } = {}) {
  const files = [...new Set(changes.map((c) => c.path))];
  if (!changes.length) return { scope: 'none', reason: 'nothing changed against the base', files };
  if (!related) return { scope: 'full', reason: '§4 Related tests is none or unset', files };
  const full = (reason) => ({ scope: 'full', reason, files });
  const lock = changes.find((c) => isLockfile(c.path) || (c.from && isLockfile(c.from)));
  if (lock) return full(`${lock.path} is a lockfile`);
  const gone = changes.find((c) => c.status === 'D' || c.status === 'R');
  if (gone) return full(gone.status === 'D' ? `${gone.path} was deleted` : `${gone.from} was renamed to ${gone.path}`);
  const cfg = changes.find((c) => isConfig(c.path));
  if (cfg) return full(cfg.path.includes('/') ? `${cfg.path} is test or build config` : `${cfg.path} is root config`);
  for (const c of changes) {
    const s = shared.find((p) => under(c.path, p.dir));
    if (s) return full(`${c.path} is in ${s.dir} (${s.name}), a shared package ${s.by.join(', ')} depend${s.by.length === 1 ? 's' : ''} on`);
  }
  return { scope: 'related', reason: `${files.length} changed file(s): no lockfile, config, shared package, deletion or rename`, files };
}

// Vitest and Jest take the changed files as arguments (`vitest related`, `jest --findRelatedTests`);
// any other related-tests command (a pytest affected-set command, say) chooses its own set and runs
// as written, once a changed file sits under its directory.
export const takesFiles = (cmd) => /(^|[\s/])(vitest|jest)(\s|$)/.test(cmd);

// What to run. `relatedItems` and `fullItems` are { dir, cmd } from §4 Related tests and §4 Unit
// tests. With scope related, each changed file goes to the item whose directory holds it most
// closely, a Related tests item winning a tie with a Unit tests item in the same directory. A file
// that lands on a Unit tests item has no related form for its suite, so that suite runs in full:
// a suite left out of §4 Related tests is never skipped.
// -> [{ dir, cmd, files: [paths relative to dir] }]
const depth = (dir) => (dir === '.' ? 0 : dir.split('/').length);
export function runs(decision, { relatedItems = [], fullItems = [] } = {}) {
  if (decision.scope === 'none') return [];
  if (decision.scope === 'full') return fullItems.map((i) => ({ dir: i.dir, cmd: i.cmd, files: [] }));
  const related = new Map();
  const full = new Set();
  for (const f of decision.files) {
    let best = null;
    for (const [kind, list] of [['related', relatedItems], ['full', fullItems]]) {
      for (const i of list) if (under(f, i.dir) && (!best || depth(i.dir) > depth(best.i.dir))) best = { kind, i };
    }
    if (!best) continue;
    if (best.kind === 'full') { full.add(best.i); continue; }
    if (!related.has(best.i)) related.set(best.i, []);
    related.get(best.i).push(best.i.dir === '.' ? f : f.slice(best.i.dir.length + 1));
  }
  return [
    ...relatedItems.filter((i) => related.has(i)).map((i) => ({ dir: i.dir, cmd: i.cmd, files: takesFiles(i.cmd) ? related.get(i) : [] })),
    ...fullItems.filter((i) => full.has(i)).map((i) => ({ dir: i.dir, cmd: i.cmd, files: [] })),
  ];
}
