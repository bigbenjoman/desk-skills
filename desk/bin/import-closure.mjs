// The relative imports of a repo's JavaScript modules, and the closure of files an entry loads through
// them. tests/scope_sections.mjs (which CI and tests/related.sh run) and desk/bin/plugin-build.mjs both
// walk the import graph with these, so the two never disagree on what a module loads.
import { posix } from 'node:path';

// A script's text without its whole-line `//` and `#` comments and, outside shell, its block comments.
// Line comments go first, so a `/*` inside one opens no block; a block opens only at a line's start or
// after a space, `;` or `,`, so a `/*` glued to a quote, a word or `}` in a string opens none.
export function uncommented(path, text) {
  const lines = String(text).split('\n').filter((l) => !/^\s*(\/\/|#)/.test(l)).join('\n');
  return /\.(mjs|cjs|js|py)$/.test(path) ? lines.replace(/(^|[\s;,])\/\*[\s\S]*?\*\//gm, '$1 ') : lines;
}

// The specifiers a module's comment-free `code` imports: `import x from './a.mjs'`, `} from './a.mjs'`,
// `export * from './a.mjs'`, `import './a.mjs'` and `import('./a.mjs')`. A static one has no quote
// before the keyword on its line, so a fixture string that holds an import is not one.
export function jsImports(code) {
  const out = [];
  for (const m of code.matchAll(/^[^'"`\n]*\b(?:from|import)\s+(['"])([^'"]+)\1/gm)) out.push(m[2]);
  for (const m of code.matchAll(/\bimport\s*\(\s*(['"`])([^'"`$]+)\1\s*\)/g)) out.push(m[2]);
  return out;
}

// The repo paths a module at `path` imports relatively, given its text.
export const relativeImports = (path, text) => (/\.[cm]?js$/.test(path) ? jsImports(uncommented(path, text)) : [])
  .filter((spec) => /^\.\.?\//.test(spec)).map((spec) => posix.join(posix.dirname(path), spec));

// Every repo file `entry` loads through its relative imports, itself included, as sorted repo paths.
// `read(path)` returns a repo file's text.
export function importClosure(entry, read) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    todo.push(...relativeImports(p, read(p)));
  }
  return [...seen].sort();
}
