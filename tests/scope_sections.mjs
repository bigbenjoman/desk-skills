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
//     suite runs is unclaimed, and changing it runs everything. The one exception is another suite
//     (`# covers: tests/test_pass*.sh`, for a suite that replays them): it is claimed, and changing it
//     runs the claiming suite too, but nothing that suite names is followed;
//   - a script the suite claims loads it (an ES import, a shell `source`) or launches it by a path
//     built from a directory (`join(BIN, 'x.mjs')`, `"$DIR/x.sh"`; see loads()), followed
//     transitively, except through a foundational file (desk-env.mjs; changing it runs all). A file
//     many suites reach that way runs those suites: they are the ones that can see the change.
// Test helpers, stubs and fixtures under tests/, and the root's documents and scripts (install.sh,
// desk-config.md), are claimed the same way as any other file.
// A suite with a `// claims: imports` (`# claims: imports`) line uses repo file names as test data
// (the scoping suites themselves): its text names nothing, and only its import statements are followed.
//
// The decision, which fails closed: anything it cannot place runs every suite.
//   full  - a foundational file (tests/run.sh and the environment it gives suites, this script, the
//           bash 3.2 check, .github/, desk-env.sh, and desk-env.mjs unless the change only adds
//           exports), a root file that is not a document or a script (.gitignore, a lockfile), a
//           deleted or renamed file, or a changed file no suite claims
//   some  - the suites that claim a changed file, plus every changed suite and the suites claiming it;
//           for a change that only adds exports to desk-env.mjs, the suites that name a new export
//   none  - nothing changed
// The suites in ALWAYS (the syntax and shellcheck pass) run on every pull request whatever the scope,
// and claim nothing: a file only they cover has no behavioural suite, so changing it runs everything.
//
// CLI (from anywhere in the repo):
//   node tests/scope_sections.mjs --base <ref> [--head <ref>]   decide for `git diff base...head`
//   node tests/scope_sections.mjs --base <ref> --worktree       decide for the working tree against the
//                                                                merge base with <ref>, untracked files
//                                                                included (tests/related.sh)
//   node tests/scope_sections.mjs --files <path>...              decide for these paths, as modified
//   node tests/scope_sections.mjs --full                         every suite (a push to main)
//   add --json for the decision as JSON, or --github-output to append scope=, suites= and shells= to
//   $GITHUB_OUTPUT. --claims <path> lists the suites claiming a path; --unclaimed lists tracked files no
//   suite claims; --layers [<file>...] names each suite (every one, or these files) whose layer line is
//   missing, doubled or unknown, and exits 1 when there is one.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

export const ALWAYS = ['test_lint.sh'];
// Shared by everything: a change here can move any suite.
const FOUNDATION = [/^tests\/(run\.sh|suite_env\.sh|scope_sections\.mjs|bash32_check\.sh|bash32_features\.txt)$/, /^\.github\//, /^desk\/bin\/desk-env\.(mjs|sh)$/, /^desk\/bin\/config-schema\.mjs$/];
// A foundational module whose change, when it only adds exports, reaches only the suites using them.
const EXPORTS_ONLY = new Set(['desk/bin/desk-env.mjs']);
const CODE_EXT = /\.(sh|bash|mjs|cjs|js|py)$/;
const DIR_ROOTS = /^(skills|vendor|docs)\//;

export const isSuite = (p) => /^tests\/test_[^/]+\.(sh|mjs)$/.test(p);
// A root file that is not a document or a script is config for the whole repo (.gitignore, a lockfile).
const rootConfig = (p) => !p.includes('/') && !/\.md$/.test(p) && !CODE_EXT.test(p);

// Top-level statements: a line at column 0 that does not close a bracket starts one. Trailing blank
// lines are dropped, so moving a blank line between statements changes none.
function topLevel(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    if (!out.length || /^[^\s})\]]/.test(l)) out.push([]);
    out.at(-1).push(l);
  }
  return out.map((c) => { while (c.length && !c.at(-1).trim()) c.pop(); return c.join('\n'); }).filter(Boolean);
}
// Whether `src` compiles as strict script. It is compiled, never run. JavaScript's own parser reads the
// quotes, regexes, templates, comments and line breaks, which no hand-written scan reads reliably.
function compiles(src) {
  try { new Script(`'use strict';\n${src}`); return true; } catch { return false; }
}
// The same for a whole run of old module code, which may `await` at top level as a module can: it is
// compiled as an async function's body. A `}` that closed that function early would leave the rest
// unbalanced, so it does not compile either.
function compilesAsModuleBody(src) {
  try { new Script(`(async function () {\n'use strict';\n${src}\n})`); return true; } catch { return false; }
}
// Where the group `text` opens with ends: just past the first `close` at which `wrap(text up to it)`
// compiles, or -1. JavaScript reads a prefix exactly as it reads that part of the whole text, so every
// earlier `close` leaves the group open (or a quote, regex or comment unclosed) and does not compile.
function groupEnd(text, close, wrap) {
  for (let i = text.indexOf(close); i >= 0; i = text.indexOf(close, i + 1)) if (compiles(wrap(text.slice(0, i + 1)))) return i + 1;
  return -1;
}
const asExpression = (p) => `(${p}\n)`;
// Whole top-level chunks of a module as script that compiles where the module does: imports and export
// lists become `;`, `export` comes off a declaration, `import.meta` is renamed, and a `#!` line (only
// allowed first, before the 'use strict' compiles() adds) is dropped.
const asScript = (chunks) => chunks.map((c) => (/^import\s*[{*'"\w]/.test(c) && !/^import\s*\(/.test(c)) || /^export\s*[{*]/.test(c) ? ';' : c.replace(/^export\s+(?:default\s+)?/, ''))
  .join('\n').replace(/^#!.*/, '').replace(/\bimport\.meta\b/g, 'import_meta');
// Only comments: every line a line comment (which any line terminator ends), or one block comment whose
// first `*/` is its end.
const isComment = (c) => /^\/\/[^\n\r\p{Zl}\p{Zp}]*(?:\n\/\/[^\n\r\p{Zl}\p{Zp}]*)*$/u.test(c) || /^\/\*(?:(?!\*\/)[\s\S])*\*\/$/.test(c);
// Whether a new chunk can go in after the first `i` old chunks without changing them: the old code up
// to there compiles (so no bracket, string, template or comment is open), and the next old statement
// starts with a name, which cannot carry on the statement before it the way `(`, `[`, `.` or an
// operator can.
function boundary(old, i) {
  if (i > 0 && !compilesAsModuleBody(asScript(old.slice(0, i)))) return false;
  const next = old.slice(i).find((c) => !isComment(c));
  return !next || (/^[A-Za-z_$]/.test(next) && !/^(?:in|instanceof)(?![\w$])/.test(next));
}
// No BigInt (`n` is left as a letter, so it is refused): `+1n` and `1n + 1` throw on load.
const NUMBER = /(?<![\w$.])(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)(?![\w$.])/gi;
// A value built only of literals: a regex, or strings, numbers, true, false and null and arrays and
// objects of them. No call, member access, template, reference or spread.
function literal(value) {
  const v = value.trim().replace(/;$/, '').trim();
  // A regex never starts `/*` or `//` (that is a comment), and the parser must read the value whole.
  if (!compiles(`({ k: ${v}\n})`)) return false;
  if (/^\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuvy]*$/.test(v)) return true;
  const bare = v.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""').replace(NUMBER, '0')
    .replace(/([{,]\s*)(?:[A-Za-z_$][\w$]*|""|0)\s*:/g, '$1');
  if (/["0\]}a-z]\s*\[/.test(bare)) return false;
  // A sign only in front of a number, never between two values.
  const signless = bare.replace(/(^|[[{,:])(\s*)[+-](?=\s*0)/g, '$1$2');
  return /^[\s"0[\]{},:]*(?:(?:true|false|null)(?![\w$])[\s"0[\]{},:]*)*$/.test(signless);
}
// A function expression or an arrow, and nothing after it: no call, second declarator or statement.
// `v` must compile as one object property's value, where a `,` would start another property (which a
// second declarator cannot be) and no line break ends anything; then the function must end where `v`
// does, or the arrow's head be a parameter list straight before `=>`.
function fnValue(v) {
  if (!compiles(`({ k: ${v}\n})`)) return false;
  if (/^(?:async\s+)?function\b/.test(v)) return groupEnd(v, '}', asExpression) === v.length;
  if (/^(?:async\s+)?[A-Za-z_$][\w$]*[ \t]*=>/.test(v)) return true;
  const p = v.match(/^(?:async[ \t]*)?\(/);
  if (!p) return false;
  const head = v.slice(p[0].length - 1);
  const end = groupEnd(head, ')', (q) => `(${q} => 0\n)`);
  return end > 0 && /^[ \t]*=>/.test(head.slice(end));
}
// A new top-level statement that declares an export and runs nothing when the module loads: a function
// declaration, or a const whose value is a function or a literal. -> its name, or null. A class (its
// static members and extends run on load) or any other value is refused, and so is a name the old module
// already uses or a global's (declaring it would change what the unchanged code refers to), a name
// written with an escape, and `then` (it makes the module's namespace a thenable, which `import()`
// calls). HTML-like comments (`<!--`, `-->`) are refused: a script reads them as comments, a module not.
function newExport(chunk, before) {
  if (/<!--|-->/.test(chunk)) return null;
  let name = null;
  const fn = chunk.match(/^export\s+((?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([\s\S]*)$/);
  if (fn) {
    const end = groupEnd(fn[1], '}', asExpression);
    if (end > 0 && /^\s*;?\s*$/.test(fn[1].slice(end))) name = fn[2];
  } else {
    const c = chunk.match(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?)\s*;?\s*$/);
    if (c && (literal(c[2]) || fnValue(c[2]))) name = c[1];
  }
  if (!name || name === 'then' || name in globalThis || new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(before)) return null;
  return name;
}
// The names a change to a module only adds as exports, or null when it does anything else: every old
// top-level statement is still there unchanged and in order, each new one goes in at a boundary(), and
// each is a comment or a newExport().
export function addedExports(before, after) {
  const old = topLevel(before);
  const names = [];
  let i = 0;
  for (const c of topLevel(after)) {
    if (i < old.length && c === old[i]) { i++; continue; }
    if (!boundary(old, i)) return null;
    if (isComment(c)) continue;
    const name = newExport(c, before);
    if (!name) return null;
    names.push(name);
  }
  return i === old.length ? names : null;
}

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

// Every suite declares its test layer in one `# layer: <layer>` line (`//` in .mjs) in its first ten
// lines, as it does its `# budget:`:
//   L1  in process: its cases import modules and start no process
//   L2  one process boundary: its cases start a desk script or command each and read what it did
//   L3  end to end: it runs a pass, a batch, the merge driver or the installer through
export const LAYERS = ['L1', 'L2', 'L3'];
const LAYER_LINE = /^(#|\/\/) layer:/;
// A suite's declared layer, or what is wrong with its declaration: { layer, problem }, layer null and
// problem set unless it declares exactly one known layer.
function readLayer(text) {
  const lines = String(text).split('\n').slice(0, 10).filter((l) => LAYER_LINE.test(l));
  if (!lines.length) return { layer: null, problem: `declares no layer: add a \`# layer: <${LAYERS.join('|')}>\` line (\`//\` in .mjs) in its first ten lines` };
  if (lines.length > 1) return { layer: null, problem: `declares ${lines.length} layers: ${lines.join(' / ')}` };
  const v = lines[0].replace(LAYER_LINE, '').trim();
  return LAYERS.includes(v) ? { layer: v, problem: '' } : { layer: null, problem: `declares an unknown layer: ${lines[0]} (one of ${LAYERS.join(', ')})` };
}

// A suite's header, its first 30 lines: the `suite:` label ('' when none), its layer (null unless it
// declares exactly one known layer), the `covers:` globs and whether it `claims: imports` only.
export function suiteHeader(text) {
  const head = String(text).split('\n').slice(0, 30);
  return {
    label: (head.slice(0, 10).find((l) => /^(#|\/\/) suite: /.test(l)) ?? '').replace(/^(#|\/\/) suite: /, ''),
    layer: readLayer(text).layer,
    covers: head.filter((l) => /^(#|\/\/) covers: /.test(l)).flatMap((l) => l.replace(/^(#|\/\/) covers: /, '').trim().split(/\s+/)),
    importsOnly: head.some((l) => /^(#|\/\/) claims: imports\b/.test(l)),
  };
}

// -> { suites: [{ file, label, covers: [glob] }], claims: Map(path -> Set(suite file)) }
// `files` is every tracked path; `read(path)` returns its text (or '' when unreadable).
export function buildMap(files, read) {
  const suites = files.filter(isSuite).sort();
  const nodes = files.filter((f) => !isSuite(f));
  const names = new Map(); // a mention -> the paths it names
  const add = (k, p) => { if (!names.has(k)) names.set(k, new Set()); names.get(k).add(p); };
  // Basenames are counted outside tests/ and across every file, so a file under tests/ named by its
  // basename alone never takes that name from a file elsewhere.
  const baseCount = new Map();
  const allCount = new Map();
  const bump = (m, b) => m.set(b, (m.get(b) ?? 0) + 1);
  for (const f of nodes) { const b = f.slice(f.lastIndexOf('/') + 1); bump(allCount, b); if (!f.startsWith('tests/')) bump(baseCount, b); }
  const dirs = new Map(); // a skills/vendor/docs directory (two or more levels) -> its files
  for (const f of nodes) {
    const segs = f.split('/');
    for (let i = 0; i < segs.length - 1; i++) add(segs.slice(i).join('/'), f);
    if (segs.length === 1) add(f, f);
    const b = segs.at(-1);
    if (!b.endsWith('.md') && (f.startsWith('tests/') ? allCount : baseCount).get(b) === 1 && b.length >= 5) add(b, f);
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
    const { label, layer, covers, importsOnly } = suiteHeader(t);
    out.push({ file: s.slice(6), label: label || s.slice(6), layer, covers, importsOnly });
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
    // Another suite a glob matches is claimed as it stands, and nothing it names is followed.
    for (const f of suites) if (f !== s && res.some((r) => r.test(f))) seen.add(f);
    for (const f of seen) { if (!claims.has(f)) claims.set(f, new Set()); claims.get(f).add(s.slice(6)); }
  }
  const shells = new Set(files.filter((f) => /\.(sh|bash)$/.test(f) || (!/\.[A-Za-z0-9]+$/.test(f.slice(f.lastIndexOf('/') + 1)) && /^#!.*[/ ](ba)?sh( |$)/.test(textOf(f).split('\n')[0]))));
  // The suites (bar ALWAYS) whose text names any of these identifiers as a whole word.
  const uses = (ids) => {
    const res = ids.map((n) => new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}(?![\\w$])`));
    return suites.filter((s) => !ALWAYS.includes(s.slice(6)) && res.some((r) => r.test(textOf(s)))).map((s) => s.slice(6));
  };
  return { suites: out, claims, shells, uses };
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
  for (const { path, exports } of changes) {
    if (isSuite(path)) {
      if (!all.includes(path.slice(6))) return full(`${path} is not a suite tests/run.sh knows`);
      pick.add(path.slice(6));
      for (const s of map.claims.get(path) ?? []) pick.add(s);
      continue;
    }
    if (EXPORTS_ONLY.has(path) && Array.isArray(exports)) {
      for (const s of map.uses(exports)) pick.add(s);
      continue;
    }
    if (FOUNDATION.some((r) => r.test(path))) return full(`${path} is shared by every suite`);
    if (rootConfig(path)) return full(`${path} is a root file`);
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
    // Line comments go first, so a `/*` inside one opens no block; a block opens only at a line's
    // start or after a space, `;` or `,`, so a `/*` glued to a quote, a word or `}` in a string opens none.
    const code = t.split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n').replace(/(^|[\s;,])\/\*[\s\S]*?\*\//gm, '$1 ');
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

// Every repo file `entry` loads through the relative imports loads() finds (static and `import()`),
// itself included, as sorted repo paths. `read(path)` returns a repo file's text.
export function importClosure(entry, read) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const spec of loads(p, read(p), { importsOnly: true }).split('\n')) if (/^\.\.?\//.test(spec)) todo.push(posix.join(posix.dirname(p), spec));
  }
  return [...seen].sort();
}

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
export function repoMap(root) {
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  return buildMap(files, (p) => { try { return readFileSync(join(root, p), 'utf8'); } catch { return ''; } });
}

// The changes CI and tests/related.sh both decide on: everything since the merge base of `base` and
// `head`, or, with no head, of `base` and HEAD up to the working tree, untracked files included.
// A modified EXPORTS_ONLY module carries `exports`: addedExports() between the merge base and the head.
export function changesAgainst(root, base, head) {
  const mb = git(root, ['merge-base', base, head ?? 'HEAD']).trim();
  const changes = parseNameStatus(git(root, ['diff', '--name-status', '-M', mb, ...(head ? [head] : [])]));
  if (!head) for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) changes.push({ status: 'A', path });
  for (const c of changes) {
    if (c.status !== 'M' || !EXPORTS_ONLY.has(c.path)) continue;
    const after = head ? git(root, ['show', `${head}:${c.path}`]) : readFileSync(join(root, c.path), 'utf8');
    c.exports = addedExports(git(root, ['show', `${mb}:${c.path}`]), after) ?? undefined;
  }
  return changes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const root = git(dirname(fileURLToPath(import.meta.url)), ['rev-parse', '--show-toplevel']).trim();
  if (args.includes('--layers')) {
    const given = args.slice(args.indexOf('--layers') + 1).filter((a) => !a.startsWith('--'));
    const paths = given.length ? given : git(root, ['ls-files']).split('\n').filter(isSuite);
    let bad = 0;
    for (const p of paths) {
      let problem;
      try { problem = readLayer(readFileSync(given.length ? p : join(root, p), 'utf8')).problem; } catch (e) { problem = `is unreadable: ${e.message}`; }
      if (problem) { bad++; console.log(`${p}: ${problem}`); }
    }
    process.exit(bad ? 1 : 0);
  }
  const map = repoMap(root);
  if (args.includes('--claims')) {
    const p = opt('--claims');
    console.log([...(map.claims.get(p) ?? [])].sort().join('\n') || `no suite claims ${p}`);
    process.exit(0);
  }
  if (args.includes('--unclaimed')) {
    const files = git(root, ['ls-files']).split('\n').filter(Boolean);
    for (const f of files) if (!isSuite(f) && !map.claims.get(f)?.size && !FOUNDATION.some((r) => r.test(f)) && !rootConfig(f)) console.log(f);
    process.exit(0);
  }
  let changes;
  let d;
  if (args.includes('--full')) d = fullScope(map, '--full');
  else if (args.includes('--files')) changes = args.slice(args.indexOf('--files') + 1).filter((a) => !a.startsWith('--')).map((path) => ({ status: 'M', path }));
  else if (opt('--base')) changes = changesAgainst(root, opt('--base'), args.includes('--worktree') ? undefined : opt('--head') ?? 'HEAD');
  else { console.error('usage: scope_sections.mjs --base <ref> [--head <ref> | --worktree] | --files <path>... | --full [--json | --github-output]'); process.exit(2); }
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
