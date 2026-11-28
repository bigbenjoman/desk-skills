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
//   full  - a foundational file (tests/run.sh and the environment it gives suites, this script and the
//           untracked.mjs and import-closure.mjs it reads, the bash 3.2 check, .github/, desk-env.sh, and desk-env.mjs and config-schema.mjs unless the
//           change only adds exports), a root file that is not a document or a script (.gitignore, a lockfile), a
//           deleted or renamed file, or a changed file no suite claims
//   some  - the suites that claim a changed file, plus every changed suite and the suites claiming it;
//           for a change that only adds exports to desk-env.mjs or config-schema.mjs, the suites that
//           name a new export; with --by-name, for one that edits their functions (or those of another
//           desk/bin/ module), those reaching them
//   none  - nothing changed
// With --l3-direct, as tests/related.sh runs it, `some` leaves out an L3 suite (end to end) that claims
// no changed file directly, only through what loads it, and names it as left for CI. CI never sets it.
// With --by-name, as tests/related.sh runs it too, a change to desk-env.mjs or config-schema.mjs that
// only edits or adds named top-level functions and constants (changedNames()) runs the suites reaching
// them (users()): those naming an exported name the changed ones reach inside the module, those claiming
// a script that loads the module and names one, and, for a `case` of desk-env.mjs's command line that
// reaches one, those claiming a script naming desk-env and that command. Module-level code reaching one,
// or a removed, renamed or unexported name, is still full. CI never sets it, so it backs up a caller
// these miss (a command run through a wrapper that names neither).
// The same --by-name edit to any other .mjs module under desk/bin/ (bar a foundational one) runs those
// of the suites claiming it that reach the changed names, plus each suite naming the module other than
// in an import (narrow()).
// Where the names cannot be followed (module-level code, a removed or renamed name, a script taking the
// module whole by a namespace, default or bare import() and using one, or passing it on), it runs every
// suite claiming the module, as without --by-name; a suite doing that runs itself.
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
//   $GITHUB_OUTPUT. --l3-direct (tests/related.sh) runs an L3 suite only for a change it claims
//   directly, and leaves one it reaches only through imports for CI: `ci` in the JSON, a ci= line, and
//   "left for CI" lines. --by-name (tests/related.sh) narrows a change to a desk/bin/ .mjs module
//   by the names it changes: `narrowed` in the JSON and a narrowed= line. --claims <path> lists the suites claiming a path; --unclaimed lists tracked files no
//   suite claims; --layers [<file>...] names each suite (every one, or these files) whose layer line is
//   missing, doubled or unknown, and exits 1 when there is one.
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { deskUntracked } from '../desk/bin/untracked.mjs';
import { uncommented, jsImports } from '../desk/bin/import-closure.mjs';
export { importClosure } from '../desk/bin/import-closure.mjs';

export const ALWAYS = ['test_lint.sh'];
// The suites that check every test file against the repo's rules for them (a suite's layer label against
// what it does, its sections): any change under tests/ runs them, since it can break a rule no claim
// leads to. A helper counts too: the layer check reads every tests/ helper a suite imports.
const TEST_CHECKS = ['test_scope_sections.mjs'];
// Shared by everything: a change here can move any suite.
const FOUNDATION = [/^tests\/(run\.sh|suite_env\.sh|scope_sections\.mjs|bash32_check\.sh|bash32_features\.txt)$/, /^\.github\//, /^desk\/bin\/desk-env\.(mjs|sh)$/, /^desk\/bin\/config-schema\.mjs$/, /^desk\/bin\/(untracked|import-closure)\.mjs$/];
// Foundational modules whose change, when it only adds exports, reaches only the suites using them.
const EXPORTS_ONLY = new Set(['desk/bin/desk-env.mjs', 'desk/bin/config-schema.mjs']);
// Modules a change to named functions and constants narrows by name (with --by-name).
const BY_NAME = /^desk\/bin\/.+\.mjs$/;
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
// A regex matching any of these identifiers as a whole word.
const wordsRe = (ids) => new RegExp(`(?<![\\w$])(?:${ids.map((n) => n.replace(/\$/g, '\\$')).join('|')})(?![\\w$])`);
// A static import statement (not an `import()` call).
const isImport = (c) => /^import\s*[{*'"\w]/.test(c) && !/^import\s*\(/.test(c);
// A statement starting with a name, which cannot carry on the statement before it the way `(`, `[`,
// `.` or an operator can.
const startsWithName = (c) => /^[A-Za-z_$]/.test(c) && !/^(?:in|instanceof)(?![\w$])/.test(c);
// Whole top-level chunks of a module as script that compiles where the module does: imports and export
// lists become `;`, `export` comes off a declaration, `import.meta` is renamed, and a `#!` line (only
// allowed first, before the 'use strict' compiles() adds) is dropped.
const asScript = (chunks) => chunks.map((c) => isImport(c) || /^export\s*[{*]/.test(c) ? ';' : c.replace(/^export\s+(?:default\s+)?/, ''))
  .join('\n').replace(/^#!.*/, '').replace(/\bimport\.meta\b/g, 'import_meta');
// Only comments: every line a line comment (which any line terminator ends), or one block comment whose
// first `*/` is its end.
const isComment = (c) => /^\/\/[^\n\r\p{Zl}\p{Zp}]*(?:\n\/\/[^\n\r\p{Zl}\p{Zp}]*)*$/u.test(c) || /^\/\*(?:(?!\*\/)[\s\S])*\*\/$/.test(c);
// Whether a new chunk can go in after the first `i` old chunks without changing them: the old code up
// to there compiles (so no bracket, string, template or comment is open), and the next old statement
// startsWithName().
function boundary(old, i) {
  if (i > 0 && !compilesAsModuleBody(asScript(old.slice(0, i)))) return false;
  const next = old.slice(i).find((c) => !isComment(c));
  return !next || startsWithName(next);
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
// A top-level statement that declares one name and runs nothing when the module loads: a function
// declaration, or a const or let with one declarator whose value is a function, a literal or a
// frozenLiteral().
// -> { name, exported, kind: 'function' | 'const' | 'let' }, or null for anything else: a class (its
// static members and extends run on load), a destructuring, a call or any other value, a name written
// with an escape. HTML-like comments (`<!--`, `-->`) are refused: a script reads them as comments, a
// module not.
function declOf(chunk) {
  if (/<!--|-->/.test(chunk)) return null;
  const exported = /^export\s+(?!default\b)/.test(chunk);
  const c = exported ? chunk.replace(/^export\s+/, '') : chunk;
  const fn = c.match(/^((?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([\s\S]*)$/);
  if (fn) {
    const end = groupEnd(fn[1], '}', asExpression);
    return end > 0 && /^\s*;?\s*$/.test(fn[1].slice(end)) ? { name: fn[2], exported, kind: 'function' } : null;
  }
  const v = c.match(/^(const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?)\s*;?\s*$/);
  return v && (literal(v[3]) || frozenLiteral(v[3]) || fnValue(v[3])) ? { name: v[2], exported, kind: v[1] } : null;
}
// `Object.freeze` of an array or object literal(), and nothing after it: it only holds data. Any other
// call, or a spread, call or reference inside it, may run code on load.
function frozenLiteral(v) {
  const m = v.match(/^Object\.freeze\(\s*([[{][\s\S]*)\)$/);
  return Boolean(m) && compiles(asExpression(v)) && literal(m[1]);
}
// A new top-level statement that declares an export, a function or a const, by declOf(). -> its name, or
// null. Refused too: a name the old module already uses or a global's (declaring it would change what
// the unchanged code refers to), and `then` (it makes the module's namespace a thenable, which
// `import()` calls).
function newExport(chunk, before) {
  const d = declOf(chunk);
  if (!d?.exported || d.kind === 'let' || d.name === 'then' || d.name in globalThis || wordsRe([d.name]).test(before)) return null;
  return d.name;
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

// A module's top-level statements bar comments, each with its declOf(). One with none (module-level code,
// a const set by a call) runs when the module loads.
const statements = (text) => topLevel(text).filter((c) => !isComment(c)).map((c) => ({ c, decl: declOf(c) }));

// The top-level names a change to a module edits or declares anew, when that is all it does: every
// other statement is unchanged and in order, no name goes or stops being exported, an edited
// statement is still a declOf() that runs nothing on load, a new one is also a newExport() (exported
// or not), and each compiles alone with a name starting the statement after it.
// -> { names } or { full: why }.
export function changedNames(before, after) {
  const old = statements(before);
  const neu = statements(after);
  const key = (s) => (s.decl ? `#${s.decl.name}` : s.c);
  const oldKeys = new Set(old.map(key));
  const newKeys = new Set(neu.map(key));
  if (oldKeys.size !== old.length || newKeys.size !== neu.length) return { full: 'it declares a name twice' };
  const gone = (s) => ({ full: s.decl ? `${s.decl.name} was removed or renamed` : `a top-level statement was removed: ${s.c.split('\n')[0]}` });
  const names = [];
  let i = 0;
  for (const [j, s] of neu.entries()) {
    const k = key(s);
    if (i < old.length && k === key(old[i])) {
      const was = old[i++];
      if (s.c === was.c) continue;
      if (was.decl.exported && !s.decl.exported) return { full: `${s.decl.name} is no longer exported` };
    } else if (oldKeys.has(k)) return newKeys.has(key(old[i])) ? { full: `${s.decl?.name ?? 'a top-level statement'} moved` } : gone(old[i]);
    else if (!s.decl) return { full: `a top-level statement that runs code when the module loads changed: ${s.c.split('\n')[0]}` };
    else if (!newExport(s.decl.exported ? s.c : `export ${s.c}`, before)) return { full: `the new ${s.decl.name} is a let, or a name already in use` };
    if (!compilesAsModuleBody(asScript([s.c])) || (j + 1 < neu.length && !startsWithName(neu[j + 1].c))) return { full: `${s.decl.name} does not stand alone` };
    names.push(s.decl.name);
  }
  if (i < old.length) return gone(old[i]);
  if (!compilesAsModuleBody(asScript(topLevel(after)))) return { full: 'it does not compile' };
  return { names };
}

// A command line: an `if (` statement whose body switches on `cmd` with `case '<command>':` labels.
// -> { cases: [{ cmds, body }], shared: the rest of the statement (what runs for every command, and
// `default:`) }, labels with no body of their own grouped with the case they fall through to; or null.
function cliCases(c) {
  if (!/^if\s*\(/.test(c)) return null;
  const lines = c.split('\n');
  const sw = lines.findIndex((l) => /^\s+switch \(cmd\) \{$/.test(l));
  const indent = lines[sw + 1]?.match(/^(\s+)case '/)?.[1];
  if (sw < 0 || !indent) return null;
  const label = new RegExp(`^${indent}case '([\\w-]+)':`);
  const shared = lines.slice(0, sw + 1);
  const cases = [];
  let cur = null;
  let done = false;
  for (const l of lines.slice(sw + 1)) {
    if (!done) {
      const m = l.match(label);
      if (m) {
        if (cur && cur.body.every((b) => /^\s*case '[\w-]+':\s*$/.test(b))) cur.cmds.push(m[1]);
        else cases.push(cur = { cmds: [m[1]], body: [] });
        cur.body.push(l);
        continue;
      }
      // A case's body is indented past its label; `default:` and the switch's end are not.
      if (cur && (!l.trim() || l.startsWith(`${indent} `))) { cur.body.push(l); continue; }
      cur = null;
      if (l.trim() && !l.startsWith(indent)) done = true;
    }
    shared.push(l);
  }
  return { cases: cases.map((x) => ({ cmds: x.cmds, body: x.body.join('\n') })), shared: shared.join('\n') };
}

// A lookbehind for a name that is not a property: no word character before it, and no single `.` (one
// after the `...` of a spread is still the name).
const NOT_A_PROPERTY = '(?<![\\w$])(?<!(?<!\\.)\\.)';

// `t` without its comments, the text of its strings, or a template's text, keeping each template's
// `${...}` code (nested templates too) and every regex literal whole. A quote or a `/` opening a string
// or regex nothing closes on its line leaves the rest as it is, so a misread only keeps text.
function scrubCode(t) {
  let out = '';
  let i = 0;
  let depth = 0;
  const open = []; // the brace depth each `${` we are inside opened
  const parens = []; // for each open `(`, whether it is an if, while, for or with condition's
  let last = ''; // the last token of code, to tell a regex from a division
  let member = false; // whether that token, a word, follows a `.` or `#` (`x.with`, `this.#with`: a property, not a keyword)
  const regexNext = () => !last || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(last) || /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(last);
  // A template's text from i: -> true where it stops at a `${`, false at its closing backtick.
  const text = () => {
    for (; i < t.length; i++) {
      if (t[i] === '\\') { i++; continue; }
      if (t[i] === '`') { i++; return false; }
      if (t[i] === '$' && t[i + 1] === '{') { i += 2; open.push(++depth); return true; }
    }
    return false;
  };
  // A whole number literal (`.5`, `0x1F`, `1.`, `1.5e-3`, `1e+3`, `1n`), else a word. A number's own
  // point is no property access, and one after the literal is (`1e+3.with(`: `with` is a property).
  const word = /\.\d[\d_]*(?:[eE][+-]?[\d_]+)?|0[xXoObB][\da-fA-F_]*n?|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?[\d_]+)?n?|[\w$]+/y;
  while (i < t.length) {
    const c = t[i];
    word.lastIndex = i;
    const w = word.exec(t);
    if (w) { out += w[0]; member = last === '.' || last === '#'; last = w[0]; i += w[0].length; continue; }
    if (c === '`' || (c === '}' && open.at(-1) === depth)) {
      if (c === '}') { open.pop(); depth--; }
      i++;
      out += ' ';
      last = text() ? '(' : ')';
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== c && t[j] !== '\n') j += t[j] === '\\' ? 2 : 1;
      if (t[j] !== c) return out + t.slice(i);
      out += "''";
      i = j + 1;
      last = ')';
      continue;
    }
    // A line comment ends at any line terminator, as JavaScript's does.
    if (c === '/' && t[i + 1] === '/') { const e = t.slice(i).search(/[\n\r\p{Zl}\p{Zp}]/u); i = e < 0 ? t.length : i + e; continue; }
    if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 2; out += ' '; continue; }
    if (c === '/' && regexNext()) {
      let j = i + 1;
      let cls = false;
      for (; j < t.length && t[j] !== '\n'; j++) {
        if (t[j] === '\\') { j++; continue; }
        if (t[j] === '[') cls = true;
        else if (t[j] === ']') cls = false;
        else if (t[j] === '/' && !cls) break;
      }
      if (t[j] !== '/') return out + t.slice(i);
      for (j++; /[a-z]/.test(t[j] ?? ''); j++);
      out += t.slice(i, j);
      i = j;
      last = ')';
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    out += c;
    i++;
    // A `/` after the `)` closing a condition opens a regex, as after a `;`.
    if (c === '(') { parens.push(!member && /^(?:if|while|for|with)$/.test(last)); last = c; }
    else if (c === ')') last = parens.pop() ? ';' : c;
    else if (!/\s/.test(c)) last = c;
  }
  return out;
}

// Whether a condition tests that the module was run as a command (`process.argv[1]` against
// `import.meta.url`), and not its negation, nor one an `||`, `??` or `? :` can turn otherwise.
const launchTest = (t) => /process\.argv\[1\]/.test(t) && /import\.meta\.url/.test(t) && !/!=|!\s*\(|\|\||\?(?!\.(?!\d))/.test(t);
// Whether an `if` condition holds only when the module is run as a command: a launchTest(), or a const
// in `guards` set to one (`g`, or `g()` where it is an arrow function), alone or as the first operand of
// an `&&` that no `||`, `?` or top-level `,` follows (`g && process.argv[2] === 'x'`).
function guardedBy(cond, guards) {
  if (launchTest(cond)) return true;
  const g = cond.match(/^([A-Za-z_$][\w$]*)\s*(\(\s*\))?\s*(&&[\s\S]*)?$/);
  if (!g || guards.get(g[1]) !== (g[2] ? 'call' : 'value')) return false;
  if (!g[3]) return true;
  const more = scrubCode(g[3]);
  let depth = 0;
  for (const ch of more) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) return false;
  }
  return !/\|\||\?(?!\.(?!\d))/.test(more);
}
// Whether a top-level statement runs only when the module is run as a command: an `if`, or a chain of
// `else if`s with no final `else`, each of whose conditions is guardedBy(). A condition ends at the
// first `)` that closes it as an expression, and a block where it first compiles, each read with
// `import.meta` (which no script compiles) renamed to a name of the same length. -> its conditions'
// text, one per line (they still run on load), or null when it is not such a statement.
function mainOnly(c, guards) {
  const read = c.replace(/(?<![\w$.])import\.meta(?![\w$])/g, 'import_meta');
  const conds = [];
  for (let at = 0; ;) {
    const head = read.slice(at).match(/^if\s*(?=\()/);
    if (!head) return null;
    at += head[0].length;
    const close = groupEnd(read.slice(at), ')', asExpression);
    if (close < 0) return null;
    const cond = c.slice(at + 1, at + close - 1).trim();
    if (!guardedBy(cond, guards)) return null;
    conds.push(cond);
    at += close;
    // Whitespace and comments before the body: a `{` after a comment still opens a braced body. A line
    // comment ends at any line terminator, as JavaScript's does.
    at += read.slice(at).match(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n\r\p{Zl}\p{Zp}]*)*/u)[0].length;
    // An unbraced body is one expression on the `if`'s line, ended by its `;` with nothing after it. A
    // second statement there, one on a later line after a line break ends the first, or a body that is
    // not an expression (a `for`, `while`, `if` or block, whose own `}` can hide a statement after it)
    // runs on load.
    if (read[at] !== '{') {
      const tail = read.slice(at);
      const end = groupEnd(tail, ';', (p) => `(async function () {\n${asExpression(p.slice(0, -1))}\n})`);
      return end > 0 && !/[\n\r\p{Zl}\p{Zp}]/u.test(tail.slice(0, end)) && !tail.slice(end).trim() ? conds.join('\n') : null;
    }
    const end = groupEnd(read.slice(at), '}', (p) => `(async function () {\n${p}\n})`);
    if (end < 0) return null;
    at += end;
    const next = read.slice(at).match(/^\s*(?:$|else\s+(?=if\b))/);
    if (!next) return null;
    if (at + next[0].length === read.length) return conds.join('\n');
    at += next[0].length;
  }
}

// What reaches these names in a module: the declarations naming one, and those naming them, and so on.
// -> { names, exported: the exported ones, under their exported names, commands: the cliCases()
// commands whose case names one, code: the first line of a statement that is not a declaration, an
// import, an export list or such a case but names one (module-level code, which runs on load), or null,
// main: whether a mainOnly() statement names one }. Only with `mainGuard` is a mainOnly() statement
// told apart from module-level code (without it, it is code), and a name in a comment, a quoted string
// or a template's text, or as a property, counted nowhere.
function reach(text, seeds, { mainGuard = false } = {}) {
  const stmts = statements(text);
  // A guard const's name -> 'call' where it is an arrow function (`if (g())`), else 'value' (`if (g)`).
  const guards = new Map();
  if (mainGuard) for (const { c } of stmts) {
    const g = c.match(/^const\s+([A-Za-z_$][\w$]*)\s*=([\s\S]*)$/);
    if (g && launchTest(g[2])) guards.set(g[1], /^\s*\(\s*\)\s*=>/.test(g[2]) ? 'call' : 'value');
  }
  let main = false;
  // With mainGuard, a statement's code without its comments, strings or template text (scrubCode()).
  const scrub = (t) => (mainGuard ? scrubCode(t) : t);
  for (const s of stmts) s.code = scrub(s.c);
  // With mainGuard, a property (`x.name`, `x?.name`) is not the module's own name; a spread (`...name`) is.
  const refs = (ids) => (mainGuard ? new RegExp(wordsRe(ids).source.replace('(?<![\\w$])', NOT_A_PROPERTY)) : wordsRe(ids));
  const names = new Set(seeds);
  for (let grew = names.size > 0; grew;) {
    grew = false;
    const re = refs([...names]);
    for (const { code: c, decl } of stmts) if (decl && !names.has(decl.name) && re.test(c)) { names.add(decl.name); grew = true; }
  }
  const exported = new Set();
  const commands = new Set();
  let code = null;
  const re = names.size ? refs([...names]) : null;
  // With mainGuard, scrubCode() reads comments as JavaScript does (to any line terminator, and never
  // inside a string or template), so no line is dropped before it.
  const named = (t) => re?.exec(mainGuard ? scrubCode(t) : t.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'))?.[0];
  for (const { c, decl } of stmts) {
    if (decl) { if (decl.exported && names.has(decl.name)) exported.add(decl.name); continue; }
    if (isImport(c)) continue;
    const list = c.match(/^export\s*\{([^}]*)\}/);
    if (list) {
      for (const item of list[1].split(',')) { const [local, as] = item.trim().split(/\s+as\s+/); if (names.has(local)) exported.add(as ?? local); }
      continue;
    }
    // A mainOnly() statement's conditions run on load, so a name in one is module-level code.
    const conds = mainGuard ? mainOnly(c, guards) : null;
    if (conds !== null) {
      const inCond = named(conds);
      if (inCond) code ??= `${c.split('\n')[0]} (${inCond})`;
      else if (named(c)) main = true;
      continue;
    }
    const cli = cliCases(c);
    const hit = named(cli ? cli.shared : c);
    if (hit) code ??= `${c.split('\n')[0]} (${hit})`;
    for (const { cmds, body } of cli?.cases ?? []) if (named(body)) for (const k of cmds) commands.add(k);
  }
  return { names: [...names], exported: [...exported], commands: [...commands], code, main };
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

// -> { suites: [{ file, label, layer, covers: [glob] }], claims: Map(path -> Set(suite file)),
//      direct: Map(path -> Set(suite file)), the claims made before any load is followed }
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
  const direct = new Map(); // path -> the suites claiming it directly, not through what it is loaded by
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
    // What the suite claims directly: what its text names or imports, and what its globs match.
    const first = new Set(todo);
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      if (isCode(f) && !FOUNDATION.some((r) => r.test(f))) for (const q of namedBy(f)) if (!seen.has(q)) todo.push(q);
    }
    // Another suite a glob matches is claimed as it stands, and nothing it names is followed.
    for (const f of suites) if (f !== s && res.some((r) => r.test(f))) { seen.add(f); first.add(f); }
    for (const f of seen) { if (!claims.has(f)) claims.set(f, new Set()); claims.get(f).add(s.slice(6)); }
    for (const f of first) { if (!direct.has(f)) direct.set(f, new Set()); direct.get(f).add(s.slice(6)); }
  }
  const shells = new Set(files.filter((f) => /\.(sh|bash)$/.test(f) || (!/\.[A-Za-z0-9]+$/.test(f.slice(f.lastIndexOf('/') + 1)) && /^#!.*[/ ](ba)?sh( |$)/.test(textOf(f).split('\n')[0]))));
  // The suites (bar ALWAYS) whose text names any of these identifiers as a whole word.
  const uses = (ids) => {
    if (!ids.length) return [];
    const re = wordsRe(ids);
    return suites.filter((s) => !ALWAYS.includes(s.slice(6)) && re.test(textOf(s))).map((s) => s.slice(6));
  };
  // The suites a change to these top-level names of an EXPORTS_ONLY module reaches, through reach(): those
  // naming an exported name it reaches, and those claiming a script that loads the module and names one
  // outside its comments, followed into another EXPORTS_ONLY module that does. -> { suites } (a Set), or
  // { full: why } when module-level code runs one, or a foundational file names one. With `named` (for
  // narrow()), a suite or script counts only where it imports an exported name it reaches by name
  // (importedNames()), and code that runs only when the module is run as a command is left to the caller.
  const users = (mod, ids, seen = new Set([mod]), named = false) => {
    const r = reach(textOf(mod), ids, { mainGuard: named });
    if (r.code) return { full: `${mod} runs one at load: ${r.code}` };
    const got = new Set();
    // A command the change reaches: every suite or script that names the module and the command as a
    // word outside its comments may run it. A foundational shell script (desk-env.sh) that does only
    // inside shell functions passes it on to every file naming one of those functions.
    if (r.commands.length) {
      const word = (ws) => new RegExp(`(?<![\\w-])(?:${ws.join('|')})(?![\\w-])`);
      const cmd = word(r.commands);
      const base = mod.slice(mod.lastIndexOf('/') + 1).replace(/\.mjs$/, '');
      const callers = (re, need, from) => {
        for (const f of files) {
          if (f === mod || f === from || !(isSuite(f) || isCode(f))) continue;
          const code = uncommented(f, textOf(f));
          const hit = (!need || code.includes(need)) && code.match(re);
          if (!hit) continue;
          if (isSuite(f)) { if (!ALWAYS.includes(f.slice(6))) got.add(f.slice(6)); continue; }
          if (!FOUNDATION.some((x) => x.test(f))) { for (const s of claims.get(f) ?? []) got.add(s); continue; }
          const fns = from ? null : shellWrappers(f, code, re);
          const why = from ? `${f}, shared by every suite, runs ${hit[0]} from ${from}` : `${f}, shared by every suite, may run \`${base} ${hit[0]}\``;
          if (!fns?.length) return why;
          const w = callers(word(fns), null, f);
          if (w) return w;
        }
        return null;
      };
      const why = callers(cmd, base);
      if (why) return { full: why };
    }
    if (!r.exported.length) return { suites: got };
    const imports = (code) => r.exported.find((n) => importedNames(code, mod).has(n));
    if (!named) for (const s of uses(r.exported)) got.add(s);
    else for (const s of suites) if (direct.get(mod)?.has(s.slice(6)) && imports(uncommented(s, textOf(s)))) got.add(s.slice(6));
    const re = wordsRe(r.exported);
    for (const f of nodes) {
      if (seen.has(f) || !isCode(f) || ![...mentions(loads(f, textOf(f)))].some((k) => names.get(k)?.has(mod))) continue;
      const code = uncommented(f, textOf(f));
      const hit = named ? imports(code) : code.match(re)?.[0];
      if (!hit) continue;
      if (EXPORTS_ONLY.has(f)) {
        seen.add(f);
        const local = r.exported.flatMap((n) => [n, ...[...code.matchAll(new RegExp(`(?<![\\w$])${n.replace(/\$/g, '\\$')}\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1])]);
        const u = users(f, local, seen);
        if (u.full) return u;
        for (const s of u.suites) got.add(s);
      } else if (FOUNDATION.some((x) => x.test(f))) return { full: `${f}, shared by every suite, uses ${hit}` };
      else for (const s of claims.get(f) ?? []) got.add(s);
    }
    return { suites: got };
  };
  // Whether an import specifier (or an `import()` argument) names `mod`, or names another repo file.
  const isMod = (spec, mod) => [...mentions(spec)].some((k) => names.get(k)?.has(mod));
  const isOther = (spec, mod) => !isMod(spec, mod) && [...mentions(spec)].some((k) => names.get(k)?.size);
  // The names a script's comment-free `code` imports from `mod` by name: an import's `{ ... }`, an
  // `export { ... } from` it, and a destructured `import()` (one whose argument names no other repo file
  // may be `mod`), each under the module's own name.
  const importedNames = (code, mod) => {
    const got = new Set();
    const list = (l) => { for (const item of l.split(',')) { const n = item.trim().split(/\s+as\s+|\s*:/)[0]; if (n) got.add(n); } };
    for (const m of code.matchAll(STATIC_IMPORT)) { const b = isMod(m[3], mod) && m[1].match(/\{([^}]*)\}/); if (b) list(b[1]); }
    for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2/g)) if (isMod(m[3], mod)) list(m[1]);
    for (const { start, arg } of importCalls(code)) {
      const d = !isOther(arg, mod) && code.slice(0, start).match(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?$/);
      if (d) list(d[1]);
    }
    return got;
  };
  // Why a script's comment-free `code` takes in `mod` whole and uses one of `ids` through it, or lets it
  // go where no name can be followed; or null. Whole is a namespace or default import, or an `import()`
  // that is neither destructured nor read by one member straight away; one whose argument names no other
  // repo file may be `mod`. It goes untraced through `export * from` it, or a binding used other than
  // as `<binding>.<name>`.
  const untraced = (f, code, mod, ids) => {
    const binds = [];
    for (const m of code.matchAll(STATIC_IMPORT)) {
      if (!isMod(m[3], mod)) continue;
      const ns = m[1].match(/\*\s*as\s+([\w$]+)/);
      if (ns) binds.push(ns[1]);
      const def = m[1].match(/^([A-Za-z_$][\w$]*)/);
      if (def) binds.push(def[1]);
    }
    for (const m of code.matchAll(/\bexport\s*\*[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g)) if (isMod(m[2], mod)) return `${f} re-exports all of ${mod}`;
    let inline = false;
    for (const { start, end, arg } of importCalls(code)) {
      if (isOther(arg, mod)) continue;
      const before = code.slice(0, start);
      const bound = before.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/);
      if (bound) binds.push(bound[1]);
      else if (/\b(?:const|let|var)\s*\{[^{}]*\}\s*=\s*(?:await\s+)?$/.test(before)) {
        // A rest element (`...rest`) takes every name not listed, which no name can be followed through.
        if (/\{[^{}]*\.\.\.[^{}]*\}\s*=\s*(?:await\s+)?$/.test(before)) return `${f} takes the rest of ${mod} whole by a destructured import()`;
        continue;
      }
      else if (/\(\s*await\s+$/.test(before) && /^\s*\)\s*\??\.\s*[A-Za-z_$]/.test(code.slice(end))) inline = true;
      else return `${f} takes ${mod} by an import() no name can be followed through`;
    }
    for (const b of binds) {
      for (const m of code.matchAll(new RegExp(`${NOT_A_PROPERTY}${b.replace(/\$/g, '\\$')}(?![\\w$])`, 'g'))) {
        if (/(?:\bas|\bimport|\bconst|\blet|\bvar)\s+$/.test(code.slice(0, m.index)) || /^\s*\??\.\s*[A-Za-z_$]/.test(code.slice(m.index + b.length))) continue;
        return `${f} passes ${mod} on whole as ${b}`;
      }
    }
    const hit = (binds.length || inline) && ids.length ? code.match(wordsRe(ids)) : null;
    return hit ? `${f} uses ${hit[0]} through the whole of ${mod}` : null;
  };
  // The suites a change to these top-level names of a BY_NAME module (not a foundational one) reaches:
  // users(), kept to the suites claiming the module, every suite naming the module other than in an
  // import (one reading its text, launching it, or listing it on a covers: line), and every suite that
  // takes it in whole where the names cannot be followed (untraced(); nothing loads a suite, so that
  // reaches no further). Where the code the module runs only as a command (mainOnly()) reaches one, the
  // suites claiming each script that names the module other than in an import (one launching it) too.
  // -> { suites } (a Set), or { full: why } when users() is full, a script takes the module in whole
  // that way, or a foundational file launches it; the change then runs every suite claiming the module.
  const narrow = (mod, ids) => {
    const reaches = claims.get(mod);
    if (!reaches?.size) return { full: `no suite claims ${mod}` };
    const r = reach(textOf(mod), ids, { mainGuard: true });
    // `text` without its imports of `mod` (static, or an import() naming it).
    const unimported = (text) => {
      let rest = text.replace(STATIC_IMPORT, (m, clause, q, spec) => (isMod(spec, mod) ? '' : m));
      for (const c of importCalls(rest).reverse()) if (isMod(c.arg, mod)) rest = rest.slice(0, c.start) + rest.slice(c.end);
      return rest;
    };
    const isDirect = (s) => direct.get(mod)?.has(s.slice(6));
    const takers = [...suites.filter(isDirect), ...nodes.filter((f) => f !== mod && isCode(f) && isMod(loads(f, textOf(f)), mod))];
    const whole = [];
    if (r.exported.length) for (const f of takers) {
      const why = untraced(f, uncommented(f, textOf(f)), mod, r.exported);
      if (!why) continue;
      if (!isSuite(f)) return { full: why };
      whole.push(f.slice(6));
    }
    const u = users(mod, ids, undefined, true);
    if (u.full) return u;
    const got = new Set([...u.suites, ...whole]);
    // A shell script's embedded node code (a heredoc, a `node -e`) taking the module: loads() reads a
    // script's shell lines only, so its lines naming the module in an import, or as a quoted file name (an
    // import helper's `load('x.mjs')`), are read here. Where one takes a reached name, the suites claiming
    // the script run (the embedded code runs only inside it); where one takes the module other than by
    // name (whole, or so no name can be followed), every suite claiming the module does, as for a script.
    const file = mod.slice(mod.lastIndexOf('/') + 1);
    const quotedFile = new RegExp(`['"\`]${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
    // `const { a, b: c } = await <helper>('<file>')`: the names an import helper's result is read by,
    // none where a rest element (`...rest`) takes the others, so no name can be followed.
    const helperNames = (l) => {
      const m = l.match(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\(\s*(['"`])[^'"`]*\2\s*\)/);
      return new Set(m && !m[1].includes('...') ? m[1].split(',').map((x) => x.trim().split(/\s*:\s*|\s+as\s+/)[0]).filter(Boolean) : []);
    };
    if (r.exported.length) for (const f of shells) {
      if (f === mod || isSuite(f)) continue;
      const lines = uncommented(f, textOf(f)).split('\n').filter((l) => (/\bimport\b/.test(l) && l.includes(file)) || quotedFile.test(l));
      let hit = false;
      for (const l of lines) {
        const imported = importedNames(l, mod);
        const took = imported.size ? imported : helperNames(l);
        const why = took.size ? untraced(f, l, mod, r.exported) : `${f} takes ${mod} in embedded code no name can be followed through`;
        if (why) return { full: why };
        hit ||= r.exported.some((n) => took.has(n));
      }
      if (hit) for (const s of claims.get(f) ?? []) got.add(s);
    }
    if (r.main) for (const f of nodes) {
      if (f === mod || !isCode(f) || !isMod(loads(f, unimported(textOf(f))), mod)) continue;
      if (FOUNDATION.some((x) => x.test(f))) return { full: `${f}, shared by every suite, runs ${mod}` };
      for (const s of claims.get(f) ?? []) got.add(s);
    }
    for (const s of suites.filter(isDirect)) if (!out.find((x) => x.file === s.slice(6))?.importsOnly && isMod(unimported(textOf(s)), mod)) got.add(s.slice(6));
    return { suites: new Set([...got].filter((s) => reaches.has(s))) };
  };
  return { suites: out, claims, direct, shells, uses, users, narrow };
}

// A static import that binds something: [, its clause, the quote, its specifier].
const STATIC_IMPORT = /\bimport\s+([^'"`;()]*?)\s*\bfrom\s*(['"])([^'"]+)\2/g;
// Each `import(` call in `code` (`import (` too): where it starts, just past its closing `)`, and its
// argument's text.
function importCalls(code) {
  const out = [];
  for (const m of code.matchAll(/\bimport\s*\(/g)) {
    let i = m.index + m[0].length;
    for (let depth = 1; i < code.length && depth; i++) depth += code[i] === '(' ? 1 : code[i] === ')' ? -1 : 0;
    out.push({ start: m.index, end: i, arg: code.slice(m.index + m[0].length, i - 1) });
  }
  return out;
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
// With `l3Direct` (tests/related.sh's local runs; CI never sets it), an L3 suite that claims a changed
// file only through what loads it, never directly, does not run: it is in `ci`, left for CI, which still
// runs it before merge. One changed file the suite does claim directly runs it.
export const fullScope = (map, reason) => ({ scope: 'full', reason, suites: map.suites.map((s) => s.file), shells: [...map.shells].sort() });
export function decide(changes, map, { l3Direct = false, byName = false } = {}) {
  const all = map.suites.map((s) => s.file);
  const l3 = new Set(l3Direct ? map.suites.filter((s) => s.layer === 'L3').map((s) => s.file) : []);
  const left = new Set();
  const narrowed = [];
  const kept = []; // BY_NAME modules not narrowed, and why
  const shellsOf = (paths) => [...new Set(paths.filter((p) => map.shells.has(p)))].sort();
  const full = (reason) => fullScope(map, reason);
  if (!changes.length) return { scope: 'none', reason: 'nothing changed', suites: [...ALWAYS], shells: [] };
  const gone = changes.find((c) => c.status === 'D' || c.status === 'R');
  if (gone) return full(gone.status === 'D' ? `${gone.path} was deleted` : `${gone.from} was renamed to ${gone.path}`);
  const pick = new Set(ALWAYS);
  for (const { path, exports, names } of changes) {
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
    if (byName && EXPORTS_ONLY.has(path) && names) {
      const u = names.full ? names : map.users(path, names.names);
      if (u.full) return full(`${path} is shared by every suite, and the change is not narrowed by name: ${u.full}`);
      for (const s of u.suites) (l3.has(s) && !map.direct?.get(path)?.has(s) ? left : pick).add(s);
      narrowed.push(`${path}: ${names.names.join(', ')}`);
      continue;
    }
    // Any other module bar a foundational one: narrowed where narrow() can follow the names, else every
    // suite claiming it.
    if (byName && BY_NAME.test(path) && !FOUNDATION.some((r) => r.test(path)) && names) {
      const u = names.full ? names : map.narrow(path, names.names);
      if (!u.full) {
        for (const s of u.suites) (l3.has(s) && !map.direct?.get(path)?.has(s) ? left : pick).add(s);
        narrowed.push(`${path}: ${names.names.join(', ')}`);
        continue;
      }
      kept.push(`${path} (${u.full})`);
    }
    if (FOUNDATION.some((r) => r.test(path))) return full(`${path} is shared by every suite`);
    if (rootConfig(path)) return full(`${path} is a root file`);
    const by = map.claims.get(path);
    if (!by?.size) return full(`no suite claims ${path}`);
    for (const s of by) (l3.has(s) && !map.direct?.get(path)?.has(s) ? left : pick).add(s);
  }
  if (changes.some((c) => c.path.startsWith('tests/'))) for (const s of TEST_CHECKS) if (all.includes(s)) pick.add(s);
  const suites = all.filter((s) => pick.has(s));
  const ci = all.filter((s) => left.has(s) && !pick.has(s));
  const claimed = [...map.claims].filter(([, by]) => [...by].some((s) => pick.has(s))).map(([p]) => p);
  const reason = `${changes.length} changed file(s) reach ${suites.length} of ${all.length} suites${ci.length ? `, and ${ci.length} L3 suite(s) only through imports, left for CI` : ''}${narrowed.length ? `, narrowed on the changed names in ${narrowed.join('; ')}` : ''}${kept.length ? `, not narrowed by name in ${kept.join('; ')}` : ''}`;
  return { scope: 'some', reason, suites, shells: shellsOf([...changes.map((c) => c.path), ...suites.map((s) => `tests/${s}`), ...claimed]), ...(l3Direct ? { ci } : {}), ...(byName ? { narrowed } : {}) };
}

// What a script loads into its own process (ES imports, static or `import()`, and shell `source` / `.`
// lines) and what it launches as a command by a path built from a directory: `join(BIN, 'x.mjs')`
// (and `resolve(...)`, `new URL('./x', import.meta.url)`, Python's `os.path.join`) in JavaScript or
// Python, `"$DIR/x.sh"`, `${DIR}/x`, `$(dirname "$0")/x` in shell. A name in a message or a comment
// is neither, so it is not followed.
const quoted = (s) => [...s.matchAll(/(['"`])([^'"`$]*)\1/g)].map((m) => m[2]);
// The shell functions in a script's comment-free `code` whose bodies match `re`, or call one that does
// -> [name]; or null when it is not a shell script, or its top-level code (which every script sourcing
// it runs) does either.
function shellWrappers(path, code, re) {
  if (!/\.(sh|bash)$/.test(path)) return null;
  const bodies = new Map();
  const top = [];
  let cur = null;
  for (const l of code.split('\n')) {
    const m = l.match(/^([A-Za-z_]\w*)\s*\(\)\s*\{(.*)$/);
    if (m) { bodies.set(m[1], m[2]); cur = /\}\s*(#.*)?$/.test(m[2]) ? null : m[1]; continue; }
    if (!cur) { top.push(l); continue; }
    bodies.set(cur, `${bodies.get(cur)}\n${l}`);
    if (/^\}/.test(l)) cur = null;
  }
  const found = new Set();
  const runs = (t) => re.test(t) || (found.size > 0 && wordsRe([...found]).test(t));
  for (let grew = true; grew;) {
    grew = false;
    for (const [n, b] of bodies) if (!found.has(n) && runs(b)) { found.add(n); grew = true; }
  }
  return runs(top.join('\n')) ? null : [...found];
}
export function loads(path, text, { importsOnly = false } = {}) {
  const t = String(text);
  const out = [];
  if (/\.(mjs|cjs|js|py)$/.test(path)) {
    const code = uncommented(path, t);
    if (!/\.py$/.test(path)) out.push(...jsImports(code));
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

// The changes CI and tests/related.sh both decide on: everything since the merge base of `base` and
// `head`, or, with no head, of `base` and HEAD up to the working tree, untracked files included bar the
// ones desk itself leaves there (deskUntracked: a resume file, a desk-review run's scratch files).
// A modified EXPORTS_ONLY module carries `exports`: addedExports() between the merge base and the head;
// one that only adds no exports, and any other modified BY_NAME module, carries `names`: changedNames().
export function changesAgainst(root, base, head) {
  const mb = git(root, ['merge-base', base, head ?? 'HEAD']).trim();
  const changes = parseNameStatus(git(root, ['diff', '--name-status', '-M', mb, ...(head ? [head] : [])]));
  if (!head) for (const path of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) if (!deskUntracked(path)) changes.push({ status: 'A', path });
  for (const c of changes) {
    if (c.status !== 'M' || !(EXPORTS_ONLY.has(c.path) || BY_NAME.test(c.path))) continue;
    const after = head ? git(root, ['show', `${head}:${c.path}`]) : readFileSync(join(root, c.path), 'utf8');
    const before = git(root, ['show', `${mb}:${c.path}`]);
    if (EXPORTS_ONLY.has(c.path)) c.exports = addedExports(before, after) ?? undefined;
    if (!c.exports) c.names = changedNames(before, after);
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
  const l3Direct = args.includes('--l3-direct');
  const byName = args.includes('--by-name');
  d ??= decide(changes, map, { l3Direct, byName });
  if (args.includes('--json')) console.log(JSON.stringify(d, null, 2));
  else {
    console.log(`scope: ${d.scope} (${d.reason})`);
    for (const s of d.suites) console.log(`  ${s}  ${map.suites.find((x) => x.file === s)?.label ?? ''}`);
    for (const s of d.ci ?? []) console.log(`  left for CI: ${s}  ${map.suites.find((x) => x.file === s)?.label ?? ''}`);
  }
  if (args.includes('--github-output')) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out || !existsSync(dirname(out))) { console.error('GITHUB_OUTPUT is not set'); process.exit(2); }
    appendFileSync(out, `scope=${d.scope}\nreason=${d.reason}\nsuites=${d.suites.join(' ')}\nshells=${d.shells.join(' ')}\n${l3Direct ? `ci=${(d.ci ?? []).join(' ')}\n` : ''}${byName ? `narrowed=${(d.narrowed ?? []).join('; ')}\n` : ''}`);
  }
}
