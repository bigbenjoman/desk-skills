// Which tests/run.sh suites a change reaches, so a pull request's CI runs those and not all 80-odd.
// The same idea as desk/bin/test-scope.mjs (what a desk worker tests before it pushes), for this repo:
//
// A suite (tests/test_*.sh, tests/test_*.mjs) claims a file when
//   - its own text names the file: the repo path, a path ending of two or more segments
//     (`bin/desk-jira`, `desk-jira/SKILL.md`), or, for a file that is not Markdown, a basename no
//     other tracked file shares (`merge-driver.sh`, `gate.mjs`); or a skill, vendor or docs
//     directory two or more levels deep (`skills/desk-pr`), which claims every file under it;
//   - a `# covers: <glob> ...` (`// covers: ...` in .mjs) line in its first 30 lines matches it, for
//     suites that walk a directory rather than naming files (globs: `*` within a segment, `**` across).
//     A glob claims documents and data only: a script must be named to be claimed, so a script no
//     suite runs is unclaimed, and changing it runs everything;
//   - a script the suite claims loads it (an ES import, a shell `source`) or launches it by a path
//     built from a directory (`join(BIN, 'x.mjs')`, `"$DIR/x.sh"`; see loads()), followed
//     transitively, except through a foundational file (desk-env.mjs; changing it runs all). A file
//     many suites reach that way runs those suites: they are the ones that can see the change.
// A suite with a `// claims: imports` (`# claims: imports`) line uses repo file names as test data
// (the scoping suites themselves): its text names nothing, and only its import statements are followed.
//
// The decision, which fails closed: anything it cannot place runs every suite.
//   full  - tests/run.sh, any other file under tests/ that is not a suite (helpers, stubs, fixtures,
//           this script), .github/, install.sh, a root file other than README.md, desk-env.mjs or
//           desk-env.sh, a deleted or renamed file, or a changed file no suite claims
//   some  - the suites that claim a changed file, plus every changed suite
//   none  - nothing changed
// The suites in ALWAYS (the syntax and shellcheck pass) run on every pull request whatever the scope,
// and claim nothing: a file only they cover has no behavioural suite, so changing it runs everything.
//
// CLI (from anywhere in the repo):
//   node tests/scope_sections.mjs --base <ref> [--head <ref>]   decide for `git diff base...head`
//   node tests/scope_sections.mjs --files <path>...              decide for these paths, as modified
//   node tests/scope_sections.mjs --full                         every suite (a push to main)
//   add --json for the decision as JSON, or --github-output to append scope=, suites= and shells= to
//   $GITHUB_OUTPUT. --claims <path> lists the suites claiming a path; --unclaimed lists tracked files no
//   suite claims.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALWAYS = ['test_lint.sh'];
// Shared by everything: a change here can move any suite.
const FOUNDATION = [/^tests\/(?!test_[^/]+\.(sh|mjs)$)/, /^\.github\//, /^install\.sh$/, /^desk\/bin\/desk-env\.(mjs|sh)$/];
// A root file other than these is config for the whole repo (.gitignore, a lockfile, ...).
const ROOT_DOCS = new Set(['README.md']);
const CODE_EXT = /\.(sh|bash|mjs|cjs|js|py)$/;
const DIR_ROOTS = /^(skills|vendor|docs)\//;

export const isSuite = (p) => /^tests\/test_[^/]+\.(sh|mjs)$/.test(p);

// `**` spans segments, `*` stays within one.
export function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Every path-like token in a text, each with its endings: `"$SRC/desk/bin/x.sh"` gives
// desk/bin/x.sh, bin/x.sh and x.sh.
export function mentions(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/[A-Za-z0-9_.@/-]+/g)) {
    const tok = m[0].replace(/^[./]+(?=[A-Za-z0-9_@])/, '').replace(/[./-]+$/, '');
    if (!tok) continue;
    const segs = tok.split('/').filter((s) => s && s !== '.' && s !== '..');
    for (let i = 0; i < segs.length; i++) out.add(segs.slice(i).join('/'));
  }
  return out;
}

// -> { suites: [{ file, label, covers: [glob] }], claims: Map(path -> Set(suite file)) }
// `files` is every tracked path; `read(path)` returns its text (or '' when unreadable).
export function buildMap(files, read) {
  const suites = files.filter(isSuite).sort();
  const nodes = files.filter((f) => !f.startsWith('tests/'));
  const names = new Map(); // a mention -> the paths it names
  const add = (k, p) => { if (!names.has(k)) names.set(k, new Set()); names.get(k).add(p); };
  const baseCount = new Map();
  for (const f of nodes) { const b = f.slice(f.lastIndexOf('/') + 1); baseCount.set(b, (baseCount.get(b) ?? 0) + 1); }
  const dirs = new Map(); // a skills/vendor/docs directory (two or more levels) -> its files
  for (const f of nodes) {
    const segs = f.split('/');
    for (let i = 0; i < segs.length - 1; i++) add(segs.slice(i).join('/'), f);
    const b = segs.at(-1);
    if (!b.endsWith('.md') && baseCount.get(b) === 1 && b.length >= 5) add(b, f);
    if (DIR_ROOTS.test(f)) for (let d = 2; d < segs.length; d++) {
      const dir = segs.slice(0, d).join('/');
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push(f);
    }
  }
  for (const [dir, fs] of dirs) {
    const segs = dir.split('/');
    for (let i = 0; i < segs.length - 1; i++) for (const f of fs) add(segs.slice(i).join('/'), f);
  }
  const text = new Map();
  const textOf = (p) => { if (!text.has(p)) text.set(p, read(p) ?? ''); return text.get(p); };
  const isCode = (p) => CODE_EXT.test(p) || (!/\.[A-Za-z0-9]+$/.test(p.slice(p.lastIndexOf('/') + 1)) && /^#!/.test(textOf(p)));
  const named = new Map();
  // A suite's whole text counts, comments too (naming what it tests is a claim); a script's loads only.
  const namedBy = (p) => {
    if (!named.has(p)) {
      const out = new Set();
      for (const k of mentions(isSuite(p) ? textOf(p) : loads(p, textOf(p)))) for (const q of names.get(k) ?? []) if (q !== p) out.add(q);
      named.set(p, out);
    }
    return named.get(p);
  };
  const claims = new Map();
  const out = [];
  for (const s of suites) {
    const t = textOf(s);
    const head = t.split('\n').slice(0, 30);
    const label = (head.slice(0, 10).find((l) => /^(#|\/\/) suite: /.test(l)) ?? '').replace(/^(#|\/\/) suite: /, '') || s.slice(6);
    const covers = head.filter((l) => /^(#|\/\/) covers: /.test(l)).flatMap((l) => l.replace(/^(#|\/\/) covers: /, '').trim().split(/\s+/));
    const importsOnly = head.some((l) => /^(#|\/\/) claims: imports\b/.test(l));
    out.push({ file: s.slice(6), label, covers, importsOnly });
    if (ALWAYS.includes(s.slice(6))) continue;
    const seen = new Set();
    const todo = importsOnly ? [...mentions(loads(s, t, { importsOnly }))].flatMap((k) => [...(names.get(k) ?? [])]) : [...namedBy(s)];
    const res = covers.map(globRe);
    for (const f of nodes) if (!isCode(f) && res.some((r) => r.test(f))) todo.push(f);
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      if (isCode(f) && !FOUNDATION.some((r) => r.test(f))) for (const q of namedBy(f)) if (!seen.has(q)) todo.push(q);
    }
    for (const f of seen) { if (!claims.has(f)) claims.set(f, new Set()); claims.get(f).add(s.slice(6)); }
  }
  const shells = new Set(files.filter((f) => /\.(sh|bash)$/.test(f) || (!/\.[A-Za-z0-9]+$/.test(f.slice(f.lastIndexOf('/') + 1)) && /^#!.*[/ ](ba)?sh( |$)/.test(textOf(f).split('\n')[0]))));
  return { suites: out, claims, shells };
}

// `git diff --name-status -M` lines -> [{ status, path, from }]
export function parseNameStatus(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    const status = f[0][0];
    if ((status === 'R' || status === 'C') && f.length >= 3) out.push({ status, path: f[2], from: f[1] });
    else out.push({ status, path: f[1] });
  }
  return out;
}

// -> { scope: 'full' | 'some' | 'none', reason, suites: [file], shells: [path] }
// `shells` is the shell scripts to syntax-check under bash 3.2: the changed ones and those the
// chosen suites claim (every one when the scope is full).
export const fullScope = (map, reason) => ({ scope: 'full', reason, suites: map.suites.map((s) => s.file), shells: [...map.shells].sort() });
export function decide(changes, map) {
  const all = map.suites.map((s) => s.file);
  const shellsOf = (paths) => [...new Set(paths.filter((p) => map.shells.has(p)))].sort();
  const full = (reason) => fullScope(map, reason);
  if (!changes.length) return { scope: 'none', reason: 'nothing changed', suites: [...ALWAYS], shells: [] };
  const gone = changes.find((c) => c.status === 'D' || c.status === 'R');
  if (gone) return full(gone.status === 'D' ? `${gone.path} was deleted` : `${gone.from} was renamed to ${gone.path}`);
  const pick = new Set(ALWAYS);
  for (const { path } of changes) {
    if (isSuite(path)) { if (!all.includes(path.slice(6))) return full(`${path} is not a suite tests/run.sh knows`); pick.add(path.slice(6)); continue; }
    if (FOUNDATION.some((r) => r.test(path))) return full(`${path} is shared by every suite`);
    if (!path.includes('/') && !ROOT_DOCS.has(path)) return full(`${path} is a root file`);
    const by = map.claims.get(path);
    if (!by?.size) return full(`no suite claims ${path}`);
    for (const s of by) pick.add(s);
  }
  const suites = all.filter((s) => pick.has(s));
  const claimed = [...map.claims].filter(([, by]) => [...by].some((s) => pick.has(s))).map(([p]) => p);
  return { scope: 'some', reason: `${changes.length} changed file(s) reach ${suites.length} of ${all.length} suites`, suites, shells: shellsOf([...changes.map((c) => c.path), ...suites.map((s) => `tests/${s}`), ...claimed]) };
}

// What a script loads into its own process (ES imports, static or `import()`, and shell `source` / `.`
// lines) and what it launches as a command by a path built from a directory: `join(BIN, 'x.mjs')`
// (and `resolve(...)`, `new URL('./x', import.meta.url)`, Python's `os.path.join`) in JavaScript or
// Python, `"$DIR/x.sh"`, `${DIR}/x`, `$(dirname "$0")/x` in shell. A name in a message or a comment
// is neither, so it is not followed.
const quoted = (s) => [...s.matchAll(/(['"`])([^'"`$]*)\1/g)].map((m) => m[2]);
export function loads(path, text, { importsOnly = false } = {}) {
  const t = String(text);
  const out = [];
  if (/\.(mjs|cjs|js|py)$/.test(path)) {
    const code = t.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
    if (!/\.py$/.test(path)) {
      // `import x from './a.mjs'`, `} from './a.mjs'`, `import './a.mjs'`: no quote before the keyword on
      // its line, so a fixture string that holds an import is not one.
      for (const m of code.matchAll(/^[^'"`\n]*\b(?:from|import)\s+(['"])([^'"]+)\1/gm)) out.push(m[2]);
      for (const m of code.matchAll(/\bimport\(\s*(['"`])([^'"`$]+)\1\s*\)/g)) out.push(m[2]);
    }
    if (importsOnly) return out.join('\n');
    for (const m of code.matchAll(/\b(?:join|resolve)\(([^()]*)\)/g)) { const q = quoted(m[1]); if (q.length) out.push(q.join('/')); }
    for (const m of code.matchAll(/new URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url/g)) out.push(m[2]);
    return out.join('\n');
  }
  for (const l of t.split('\n')) {
    if (/^\s*#/.test(l)) continue;
    if (/^\s*(source|\.)\s/.test(l)) out.push(l);
    for (const m of l.matchAll(/(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\))\/([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*)/g)) out.push(m[1]);
  }
  return out.join('\n');
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
export function repoMap(root) {
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  return buildMap(files, (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const root = git(dirname(fileURLToPath(import.meta.url)), ['rev-parse', '--show-toplevel']).trim();
  const map = repoMap(root);
  if (args.includes('--claims')) {
    const p = opt('--claims');
    console.log([...(map.claims.get(p) ?? [])].sort().join('\n') || `no suite claims ${p}`);
    process.exit(0);
  }
  if (args.includes('--unclaimed')) {
    const files = git(root, ['ls-files']).split('\n').filter(Boolean);
    for (const f of files) if (!isSuite(f) && !map.claims.get(f)?.size && !FOUNDATION.some((r) => r.test(f)) && f.includes('/')) console.log(f);
    process.exit(0);
  }
  let changes;
  let d;
  if (args.includes('--full')) d = fullScope(map, '--full');
  else if (args.includes('--files')) changes = args.slice(args.indexOf('--files') + 1).filter((a) => !a.startsWith('--')).map((path) => ({ status: 'M', path }));
  else if (opt('--base')) changes = parseNameStatus(git(root, ['diff', '--name-status', '-M', `${opt('--base')}...${opt('--head') ?? 'HEAD'}`]));
  else { console.error('usage: scope_sections.mjs --base <ref> [--head <ref>] | --files <path>... | --full [--json | --github-output]'); process.exit(2); }
  d ??= decide(changes, map);
  if (args.includes('--json')) console.log(JSON.stringify(d, null, 2));
  else {
    console.log(`scope: ${d.scope} (${d.reason})`);
    for (const s of d.suites) console.log(`  ${s}  ${map.suites.find((x) => x.file === s)?.label ?? ''}`);
  }
  if (args.includes('--github-output')) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out || !existsSync(dirname(out))) { console.error('GITHUB_OUTPUT is not set'); process.exit(2); }
    appendFileSync(out, `scope=${d.scope}\nreason=${d.reason}\nsuites=${d.suites.join(' ')}\nshells=${d.shells.join(' ')}\n`);
  }
}
