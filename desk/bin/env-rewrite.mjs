// The worker database rule for copied env files: every §4 Database URL variable in them is repointed
// at a ticket's own database (mode `ticket`) or blanked (mode `blank`), then each file is read back
// from disk and any value outside that rule fails. A non-local URL is blanked, never rewritten.
// setup-worktree.sh runs it for a worker's worktree and base-sync.mjs for the base worktree, so a
// worktree never reaches a shared database through its env files.
//
// Apps: a variable item may name its app's directory (`apps/portal: DATABASE_URL`), and each app has a
// database of its own. A file takes the variables of every app whose directory holds it, the deepest
// directory winning a name two apps share; an unscoped variable is the root app's (`.`). A variable
// the row names that no app holding the file lists is blanked there.
//
// CLI: node env-rewrite.mjs <ticket|blank> <worktree> <db> <container> <vars, one per line>
//        <files, one per line> [host port]
// <db> is one name, or `<dir><TAB><db>` lines, one per app; a var line may be `<dir><TAB><var>`.
// Prints one line per change; exits 1 if the result is not what the rule says.
//      node env-rewrite.mjs owned <apps> <items> <app>: the items that app owns (ownedBy, below).
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommandItem } from './config-schema.mjs';
import { nearestDir } from './test-scope.mjs';

// Every host but the container's own name reaches it through the port it publishes on this machine.
const VIA_HOST = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']);
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]*)@)?(\[[^\]]*\]|[^/:?#]*)(:\d+)?(\/[^?#]*)?(\?[^#]*)?$/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const repoRel = (p) => p.replace(/^(\.\/+)+/, '');

// -> the items (`{ dir, cmd }`) whose owner is `app`: the deepest of `appDirs` holding the item's
// directory, '' where none does. setup-worktree.sh asks this for each app's migrate and seed items.
export function ownedBy(appDirs, items, app) {
  const apps = appDirs.map((dir) => ({ dir }));
  return items.filter((i) => (nearestDir(apps, repoRel(i.dir))?.dir ?? '') === app);
}

// -> { bad, touched }: bad counts values that still break the rule on disk. `vars` are §4 Database URL
// variable items, each optionally `<dir>: <var>`; `dbs` maps an app directory to its database, and
// without it every variable takes `db`.
export function rewriteEnvFiles({ mode, wt, db = '', dbs = null, container = '', vars, files, hostPort = '', log = console.log, error = console.error }) {
  const items = vars.map(parseCommandItem).filter((v) => VAR_NAME.test(v.cmd));
  if (!items.length) return { bad: 0, touched: 0 };
  const names = [...new Set(items.map((v) => v.cmd))];
  // The database each variable is pointed at in one file: '' blanks it. For each name, the deepest
  // app holding the file that lists it wins.
  const plan = (rel) => Object.fromEntries(names.map((name) => {
    if (!dbs) return [name, db];
    const app = nearestDir(items.filter((v) => v.cmd === name), repoRel(rel))?.dir;
    return [name, app == null ? '' : dbs[app] ?? ''];
  }));
  const LOCAL = new Set([...VIA_HOST, container].filter(Boolean).map((h) => h.toLowerCase()));
  // `(.*)` cannot match a trailing \r, so a CRLF file (common on WSL) would skip every line and keep
  // its production URL. Lines are matched with the \r removed; a rewritten or blanked line is written back with a plain \n.
  const lineRe = new RegExp(`^(\\s*(?:export\\s+)?)(${names.map(esc).join('|')})(\\s*=\\s*)(.*?)\\r?$`);
  const target = (value, db) => {
    let q = '';
    let v = value.trim();
    const m = /^(['"])(.*)\1\s*(#.*)?$/.exec(v);
    if (m) { q = m[1]; v = m[2]; } else v = v.replace(/\s+#.*$/, '');
    if (mode === 'blank' || v === '') return { out: '', what: 'blanked' };
    if (!db) return { out: '', what: 'blanked (no app holding this file names it)' };
    const u = URL_RE.exec(v);
    if (u) {
      const host = u[3].toLowerCase();
      if (!LOCAL.has(host)) return { out: '', what: `blanked (host ${u[3]} is not local, so it is never rewritten)` };
      const port = hostPort && VIA_HOST.has(host) && (u[4] || hostPort !== '5432') ? `:${hostPort}` : (u[4] ?? '');
      return { out: `${q}${u[1]}://${u[2] != null ? `${u[2]}@` : ''}${u[3]}${port}/${db}${u[6] ?? ''}${q}`, what: `repointed at ${db}${port ? ` on port ${port.slice(1)}` : ''}` };
    }
    if (/^[A-Za-z0-9_]+$/.test(v)) return { out: `${q}${db}${q}`, what: `set to ${db}` };
    return { out: '', what: 'blanked (not a URL or a database name)' };
  };
  const ok = (value, db) => {
    const v = value.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v === '') return true;
    if (mode === 'blank' || !db) return false;
    const u = URL_RE.exec(v);
    if (u) {
      const host = u[3].toLowerCase();
      const portOk = !hostPort || !VIA_HOST.has(host) || (u[4] ?? ':5432') === `:${hostPort}`;
      return LOCAL.has(host) && portOk && (u[5] ?? '') === `/${db}`;
    }
    return v === db;
  };
  let bad = 0;
  let touched = 0;
  for (const rel of files) {
    const f = join(wt, rel);
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, 'utf8').split('\n');
    const dbFor = plan(rel);
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lineRe.exec(lines[i]);
      if (!m) continue;
      const t = target(m[4], dbFor[m[2]] ?? '');
      const next = `${m[1]}${m[2]}=${t.out}`;
      if (next !== lines[i]) { lines[i] = next; changed = true; }
      log(`${rel}: ${m[2]} ${t.what}`);
      touched++;
    }
    if (changed) writeFileSync(f, lines.join('\n'));
    // Verify from disk, not from what was meant to be written.
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      const m = lineRe.exec(l);
      if (m && !ok(m[4], dbFor[m[2]] ?? '')) { error(`FAIL: ${rel}: ${m[2]} still holds a value outside this ticket's database`); bad++; }
    }
  }
  return { bad, touched };
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
// `<dir><TAB><rest>` lines, split at the first tab only, so a command keeps any tab of its own.
const tabbed = (raw) => raw.split('\n').filter(Boolean).map((l) => (l.includes('\t') ? [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)] : ['.', l]));
if (isMain && process.argv[2] === 'owned') {
  // node env-rewrite.mjs owned <`DIR<TAB>DB` app lines> <`DIR<TAB>CMD` item lines> <app dir, or '' for none>
  // Prints the item lines that app owns, as given.
  const [, appsRaw = '', itemsRaw = '', app = ''] = process.argv.slice(2);
  const items = tabbed(itemsRaw).map(([dir, cmd]) => ({ dir, cmd }));
  for (const i of ownedBy(tabbed(appsRaw).map(([dir]) => dir), items, app)) console.log(`${i.dir}\t${i.cmd}`);
} else if (isMain) {
  const [mode, wt, dbRaw = '', container, varsRaw = '', filesRaw = '', hostPort = ''] = process.argv.slice(2);
  const vars = tabbed(varsRaw).map(([dir, v]) => `${dir}: ${v}`);
  const dbLines = tabbed(dbRaw);
  const dbs = dbRaw.includes('\t') ? Object.fromEntries(dbLines) : null;
  const { bad, touched } = rewriteEnvFiles({ mode, wt, db: dbs ? '' : dbRaw, dbs, container, vars, files: filesRaw.split('\n').filter(Boolean), hostPort,
    log: (l) => console.log(`[setup-worktree]   ${l}`) });
  const names = [...new Set(tabbed(varsRaw).map(([, v]) => v))];
  if (!touched && names.length) console.log(`[setup-worktree]   no copied env file sets ${names.join(', ')}`);
  process.exit(bad ? 1 : 0);
}
