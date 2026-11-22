// The worker database rule for copied env files: every §4 Database URL variable in them is repointed
// at a ticket's own database (mode `ticket`) or blanked (mode `blank`), then each file is read back
// from disk and any value outside that rule fails. A non-local URL is blanked, never rewritten.
// setup-worktree.sh runs it for a worker's worktree and base-sync.mjs for the base worktree, so a
// worktree never reaches a shared database through its env files.
//
// CLI: node env-rewrite.mjs <ticket|blank> <worktree> <db> <container> <vars, one per line>
//        <files, one per line> [host port]
// Prints one line per change; exits 1 if the result is not what the rule says.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every host but the container's own name reaches it through the port it publishes on this machine.
const VIA_HOST = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']);
const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]*)@)?(\[[^\]]*\]|[^/:?#]*)(:\d+)?(\/[^?#]*)?(\?[^#]*)?$/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// -> { bad, touched }: bad counts values that still break the rule on disk.
export function rewriteEnvFiles({ mode, wt, db = '', container = '', vars, files, hostPort = '', log = console.log, error = console.error }) {
  vars = vars.filter((v) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(v));
  if (!vars.length) return { bad: 0, touched: 0 };
  const LOCAL = new Set([...VIA_HOST, container].filter(Boolean).map((h) => h.toLowerCase()));
  // `(.*)` cannot match a trailing \r, so a CRLF file (common on WSL) would skip every line and keep
  // its production URL. Lines are matched with the \r removed; a rewritten or blanked line is written back with a plain \n.
  const lineRe = new RegExp(`^(\\s*(?:export\\s+)?)(${vars.map(esc).join('|')})(\\s*=\\s*)(.*?)\\r?$`);
  const target = (value) => {
    let q = '';
    let v = value.trim();
    const m = /^(['"])(.*)\1\s*(#.*)?$/.exec(v);
    if (m) { q = m[1]; v = m[2]; } else v = v.replace(/\s+#.*$/, '');
    if (mode === 'blank' || v === '') return { out: '', what: 'blanked' };
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
  const ok = (value) => {
    const v = value.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v === '') return true;
    if (mode === 'blank') return false;
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
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      const m = lineRe.exec(lines[i]);
      if (!m) continue;
      const t = target(m[4]);
      const next = `${m[1]}${m[2]}=${t.out}`;
      if (next !== lines[i]) { lines[i] = next; changed = true; }
      log(`${rel}: ${m[2]} ${t.what}`);
      touched++;
    }
    if (changed) writeFileSync(f, lines.join('\n'));
    // Verify from disk, not from what was meant to be written.
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      const m = lineRe.exec(l);
      if (m && !ok(m[4])) { error(`FAIL: ${rel}: ${m[2]} still holds a value outside this ticket's database`); bad++; }
    }
  }
  return { bad, touched };
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const [mode, wt, db, container, varsRaw = '', filesRaw = '', hostPort = ''] = process.argv.slice(2);
  const vars = varsRaw.split('\n').filter(Boolean);
  const { bad, touched } = rewriteEnvFiles({ mode, wt, db, container, vars, files: filesRaw.split('\n').filter(Boolean), hostPort,
    log: (l) => console.log(`[setup-worktree]   ${l}`) });
  if (!touched && vars.length) console.log(`[setup-worktree]   no copied env file sets ${vars.join(', ')}`);
  process.exit(bad ? 1 : 0);
}
