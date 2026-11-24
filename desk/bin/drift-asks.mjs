#!/usr/bin/env node
// The config rows a desk release added that a repo's config lacks, put on that repo's needs-you list
// as one ask, so a release installed mid-batch (install.sh, run by hand or by maintenance.mjs's
// auto-release) does not go unnoticed until a ticket parks on a missing row. install.sh runs it last:
//   node drift-asks.mjs [<installed commit>]   for each configured repo: write each row `desk-env drift`
//                                              calls MISSING that desk can set itself (considered), noted
//                                              and logged as desk's decision, and put the rest, which need
//                                              the person, on its needs-you list as one ask
// The ask carries the rows (`rows`, settles 'drift'), so the next install replaces it and a pass drops
// it once the config has them all (pass.mjs, settleDrift).
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { addAsk, settleDrift, readAsks } from './asks.mjs';
import { ROWS, isNone, parseCommandItem } from './config-schema.mjs';
import { decisionEntry, appendDecisions } from './decisions.mjs';

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

// The schema row a MISSING entry names: a §3 row by its key, any other by its label.
const schemaOf = (m) => {
  const label = m.label.replace(/^"(.*)"$/, '$1');
  return ROWS.find((r) => r.section === m.section && (r.kind === 'perm' ? r.id === label : r.label === label)) ?? null;
};
const rowName = (m) => m.label.replace(/^"(.*)"$/, '$1');

// The value desk takes for MISSING row `m` itself, as { value, why }, or null where it needs the person:
// - a §3 permission: `no`, which a row the config lacks already reads as, so nothing is widened;
// - a row whose template default already applies while it is unset: that default;
// - §4 Test sign-in: a user the repo's seed files create, for its one app (devDirs, the §4 Dev server
//   items' directories, '.' for the root). An email a seed file creates is read, not guessed.
// A value that widens what workers may do, spends, or names a person is never one of these.
export function considered(m, { root = null, devDirs = [] } = {}) {
  const r = schemaOf(m);
  if (!r) return null;
  if (r.kind === 'perm') return r.type === 'perm' && r.example === 'yes'
    ? { value: 'no', why: 'a §3 row the config lacks already reads as no, so this widens nothing workers may do; set it to yes to grant it' } : null;
  const d = r.default == null ? [] : [].concat(r.default);
  if (d.length === 1) return { value: String(d[0]), why: "the template's default, which already applies while the row is unset" };
  if (r.id === 'test-signin' && devDirs.length <= 1) {
    const u = seededUser(root);
    const dir = devDirs[0] && devDirs[0] !== '.' ? devDirs[0] : null;
    if (u) return { value: dir ? `${dir}: ${u.email}` : u.email, why: `a development user ${u.file} creates; change it if that user lacks the grant its signed-in pages need` };
  }
  return null;
}

// The directories repo `slug`'s §4 Dev server items run in ('.' for the root), [] with none.
export function devDirsOf(slug, cfgRoot = null) {
  let dev;
  try { dev = E.repoConfigValues(slug, 'dev-cmd', ...(cfgRoot ? [cfgRoot] : [])); } catch { return []; }
  return !dev || isNone(dev) ? [] : [...new Set(dev.map((x) => parseCommandItem(x).dir || '.'))];
}

// Writes `taken` ({ m, value, why }) into `config`, each row noted as desk's with its reason, and logs
// each as a taken decision in the repo's state, so the check-in digest lists it with how to change it.
// -> { done: the rows written, as "§<section> <row> = <value>", failed: [{ m, why }] the config refused,
//    which go to the person instead }
export function takeRows(config, taken, { slug, state, short = null, template } = {}) {
  const done = [], failed = [];
  for (const { m, value, why } of taken) {
    try { E.addTemplateRow({ config, section: m.section, row: rowName(m), value, note: `set by desk: ${why}`, ...(template ? { template } : {}) }); }
    catch (e) { failed.push({ m, why: String(e?.message ?? e) }); continue; }
    done.push(`§${m.section} ${m.label} = ${value}`);
    try {
      appendDecisions([decisionEntry({
        decision: { question: `What should config §${m.section} ${m.label} be? ${short ? `desk ${short}` : 'A desk release'} added the row, and desk set it (${why}). To change it, edit the row in ${config} or run /desk-setup.`,
          options: [value, 'ask the person'], chose: value, category: 'engineering' },
        ticket: 'config', run: short, repo: slug, pr: null, source: 'drift',
      })], state);
    } catch { /* the row is written; a log that cannot be written never undoes it */ }
  }
  return { done, failed };
}

// One repo's drift: the rows desk takes itself (`taken`, each { m, value, why }), the rest (`left`), and
// the ask for them ({ text, rows }, null with none). `short` names the release.
export function driftAsk(config, { root = null, short = null, template, devDirs = [] } = {}) {
  const { missing } = E.configDrift({ config, root, ...(template ? { template } : {}) });
  const taken = [], left = [];
  for (const m of missing) { const c = considered(m, { root, devDirs }); if (c) taken.push({ m, ...c }); else left.push(m); }
  return { taken, left, ask: askFor(left, short) };
}

// The ask for MISSING rows that need the person: { text, rows }, or null with none.
function askFor(left, short) {
  if (!left.length) return null;
  const rows = left.map((m) => `§${m.section} ${m.label}`);
  const text = `${DRIFT_PREFIX} desk${short ? ` ${short}` : ''} added ${rows.length === 1 ? 'a config row' : `${rows.length} config rows`} this repo's config lacks that need you: ${rows.join('; ')}. Run /desk-setup in the repo: it puts each to you as a choice, its recommendation first`;
  return { text, rows };
}

// For each configured repo, replaces its drift ask with the current one (none where nothing is
// missing). -> one line per repo with drift, or one that says none has any.
export function recordDriftAsks({ short = null, repos = E.configuredRepos(), template, cfgRoot = null } = {}) {
  const lines = [];
  for (const { slug, config } of repos) {
    if (!existsSync(config)) continue;
    // Each repo on its own: a config or an asks file one cannot read leaves the others' asks recorded.
    try {
      const root = (() => { try { return E.configFileRoot(config); } catch { return null; } })();
      const state = E.batchPaths(slug).state;
      const drift = driftAsk(config, { root, short, template, devDirs: devDirsOf(slug, cfgRoot) });
      const { done: set, failed } = drift.taken.length ? takeRows(config, drift.taken, { slug, state, short, template }) : { done: [], failed: [] };
      if (set.length) lines.push(`${slug} had ${set.length} config row(s) desk set itself, each noted as desk's and in the check-in digest (${set.join('; ')})`);
      // A row desk could not write goes to the person with the rest.
      const a = failed.length ? askFor([...drift.left, ...failed.map((f) => f.m)], short) : drift.ask;
      // An earlier install's ask naming other rows goes; one naming these same rows stays as it is, so
      // the person's not-now on it holds.
      const same = (old) => a != null && old.rows.length === a.rows.length && old.rows.every((r, i) => r === a.rows[i]);
      settleDrift(state, (old) => !same(old));
      if (!a) continue;
      const kept = readAsks(state).find((x) => x.settles === 'drift' && Array.isArray(x.rows) && same(x));
      const { id } = kept ?? addAsk(state, a.text, Date.now(), { rows: a.rows, settles: 'drift' });
      lines.push(`${slug} lacks ${a.rows.length} config row(s) this release has that need the person (${a.rows.join(', ')}), now on its needs-you list as ask:${id}`);
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
