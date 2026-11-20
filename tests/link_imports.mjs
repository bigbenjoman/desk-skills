// node tests/link_imports.mjs <src bin> <scratch bin> <file>...
// Links into the scratch bin every module the named files (already copied there) import from beside
// them, `from './x.mjs'` or `import('./x.mjs')`, so a suite that copies a module next to its fakes need
// not list the module's imports by hand. A name the scratch bin already has (a fake, or a copy) is left
// alone. Only direct imports are linked: Node resolves a linked module to its real path, so its own
// imports load from the source bin. A module the copied files only spawn is not an import, and the
// suite links it, or writes its fake, itself.
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const [src, dest, ...files] = process.argv.slice(2);
if (!src || !dest || !files.length) { console.error('usage: link_imports.mjs <src bin> <scratch bin> <file>...'); process.exit(2); }
const have = (name) => { try { lstatSync(join(dest, name)); return true; } catch { return false; } };
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]\.\/([\w.-]+\.mjs)['"]/g;
for (const f of files) {
  for (const [, name] of readFileSync(join(dest, f), 'utf8').matchAll(IMPORT)) {
    if (have(name)) continue;
    if (!existsSync(join(src, name))) { console.error(`link_imports: ${f} imports ./${name}, which ${src} does not have`); process.exit(1); }
    symlinkSync(join(src, name), join(dest, name));
  }
}
