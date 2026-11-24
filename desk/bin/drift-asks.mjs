#!/usr/bin/env node
// The config rows a desk release added that a repo's config lacks, put on that repo's needs-you list
// as one ask, so a release installed mid-batch (install.sh, run by hand or by maintenance.mjs's
// auto-release) does not go unnoticed until a ticket parks on a missing row. install.sh runs it last:
//   node drift-asks.mjs [<installed commit>]   for each configured repo: record one ask naming every row
//                                              `desk-env drift` calls MISSING, with a recommended value
//                                              where one can be read; one line per repo
// The ask carries the rows (`rows`, settles 'drift'), so the next install replaces it and a pass drops
// it once the config has them all (pass.mjs, settleDrift).
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { addAsk, settleDrift, readAsks } from './asks.mjs';

const DRIFT_PREFIX = 'config drift:';
const SEED_EXT = /\.(ts|js|mjs|cjs|sql|json|ya?ml|rb|py|exs?)$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor', 'coverage', '.turbo']);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// The first user a seed file of the repo at `root` creates, as { email, file } (file relative to
// root), or null: a file whose name has "seed" in it, or one under a seeds directory, up to four
// levels down. Only a recommendation: the person confirms the user holds the grant its pages need.
export function seededUser(root, depth = 4) {
  if (!root || !existsSync(root)) return null;
  const walk = (dir, d, seedDir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return null; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && SEED_EXT.test(e.name) && (seedDir || /seed/i.test(e.name))) {
        let text = '';
        try { if (statSync(p).size < 1 << 20) text = readFileSync(p, 'utf8'); } catch { /* unreadable: none */ }
        const m = EMAIL.exec(text);
        if (m) return { email: m[0], file: relative(root, p) };
      }
    }
    if (d <= 0) return null;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const hit = walk(join(dir, e.name), d - 1, seedDir || /^seeds?$/i.test(e.name));
      if (hit) return hit;
    }
    return null;
  };
  return walk(root, depth, false);
}

// What to put in one MISSING row, or null where nothing can be read: for §4 Test sign-in, a user the
// repo's seed files create.
function recommend(m, root) {
  if (m.section === '4' && m.label === '"Test sign-in"') {
    const u = seededUser(root);
    return u ? `\`${u.email}\`, a user ${u.file} creates: confirm it holds the grant its signed-in pages need` : null;
  }
  return null;
}

// One repo's ask: { text, rows } for its MISSING rows, or null with none. `short` names the release.
export function driftAsk(config, { root = null, short = null, template } = {}) {
  const { missing } = E.configDrift({ config, root, ...(template ? { template } : {}) });
  if (!missing.length) return null;
  const rows = missing.map((m) => `§${m.section} ${m.label}`);
  const each = missing.map((m) => { const r = recommend(m, root); return `§${m.section} ${m.label}${r ? ` (recommended: ${r})` : ''}`; });
  const text = `${DRIFT_PREFIX} desk${short ? ` ${short}` : ''} added ${rows.length === 1 ? 'a config row' : `${rows.length} config rows`} this repo's config lacks: ${each.join('; ')}. Add ${rows.length === 1 ? 'it' : 'each'} with node ${join(E.runBin(), 'desk-env.mjs')} add-row <section> "<row>" "<value>" in the repo, or run /desk-setup there`;
  return { text, rows };
}

// For each configured repo, replaces its drift ask with the current one (none where nothing is
// missing). -> one line per repo with drift, or one that says none has any.
export function recordDriftAsks({ short = null, repos = E.configuredRepos(), template } = {}) {
  const lines = [];
  for (const { slug, config } of repos) {
    if (!existsSync(config)) continue;
    // Each repo on its own: a config or an asks file one cannot read leaves the others' asks recorded.
    try {
      const root = (() => { try { return E.configFileRoot(config); } catch { return null; } })();
      const a = driftAsk(config, { root, short, template });
      const state = E.batchPaths(slug).state;
      // An earlier install's ask naming other rows goes; one naming these same rows stays as it is, so
      // the person's not-now on it holds.
      const same = (old) => a != null && old.rows.length === a.rows.length && old.rows.every((r, i) => r === a.rows[i]);
      settleDrift(state, (old) => !same(old));
      if (!a) continue;
      const kept = readAsks(state).find((x) => x.settles === 'drift' && Array.isArray(x.rows) && same(x));
      const { id } = kept ?? addAsk(state, a.text, Date.now(), { rows: a.rows, settles: 'drift' });
      lines.push(`${slug} lacks ${a.rows.length} config row(s) this release has (${a.rows.join(', ')}), now on its needs-you list as ask:${id}`);
    } catch (e) { lines.push(`${slug}'s drift could not be checked or recorded (${String(e?.message ?? e).split('\n')[0]})`); }
  }
  return lines.length ? lines : ['no configured repo lacks a config row this release has'];
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const commit = process.argv[2];
  for (const l of recordDriftAsks({ short: commit ? commit.slice(0, 8) : null })) console.log(l);
}
