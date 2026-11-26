// What this month's Claude and Codex use would cost at API list prices, by repo and by login: a measure
// of the work the subscriptions bought, never a bill. Claude's is every request in the session
// transcripts of every login (claude-logins.mjs projectsDirs), worker and interactive alike, counted
// once by request id and priced as cache-report.mjs prices one. Codex's is every token_count event in
// each Codex login's session logs, priced at worker-cost.mjs CODEX_PRICES by the model its session ran.
// A session belongs to the configured repo whose primary checkout or worktrees folder holds its working
// folder, and to the login whose folder it was read from. Reading every transcript takes seconds, so
// cost-cache.mjs reads this in the background and keeps it in use.json; desk-q only reads that file.
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { transcripts, requestOf, requestUsd } from './cache-report.mjs';
import { projectsDirs } from './claude-logins.mjs';
import { codexLogins, logText, rolloutLogs } from './codex-usage.mjs';
import { configuredRepos, repoDirs } from './desk-env.mjs';
import { codexPrices } from './worker-cost.mjs';

// Every configured repo's folders: its primary checkout and its worktrees folder.  -> [{ slug, dirs }]
export const repoPlaces = (root) => configuredRepos(root).map(({ slug }) => {
  const d = repoDirs(slug, root);
  return { slug, dirs: [d.root, d.worktrees].filter(Boolean) };
});
// The repo a working folder is in, the deepest folder winning, or null.
export function repoOfCwd(cwd, places) {
  let best = null;
  for (const p of places) for (const d of p.dirs) if (`${cwd}/`.startsWith(`${d}/`) && (!best || d.length > best.d.length)) best = { slug: p.slug, d };
  return best?.slug ?? null;
}

// The month `now` (UTC) falls in, as epoch ms, `to` exclusive.
export function monthWindow(now) {
  const d = new Date(now);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), to: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

const lines = (text) => String(text).split('\n').flatMap((l) => { if (!l.trim()) return []; try { const d = JSON.parse(l); return d && typeof d === 'object' ? [d] : []; } catch { return []; } });

// Each Claude request in the window across `dirs` ([{ dir: <login folder>, projects }]), counted once by
// request id, keeping its largest output: -> [{ login, cwd, r }]
export function claudeRequests(dirs, { from, to }) {
  const seen = new Map();
  for (const { dir, projects } of dirs) {
    for (const file of transcripts(projects)) {
      try { if (statSync(file).mtimeMs < from) continue; } catch { continue; }
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      const all = lines(text);
      const fileCwd = all.find((d) => d.cwd)?.cwd ?? '';
      for (const d of all) {
        const r = requestOf(d);
        if (!r || !(r.at >= from && r.at < to)) continue;
        const key = r.id ?? `${file}:${seen.size}`;
        const had = seen.get(key);
        if (had) had.r.output = Math.max(had.r.output, r.output);
        else seen.set(key, { login: dir, cwd: d.cwd ?? fileCwd, r });
      }
    }
  }
  return [...seen.values()];
}

// One Codex session log's use in the window, from the running total each token_count event carries:
// each event adds what the total grew by, priced by the session's model then, the long-context rate
// where that turn's input was past the model's threshold.  -> { cwd, usd, unpriced }
export function codexLogUse(text, { from, to }) {
  let cwd = '', model = null, prev = null, usd = 0, unpriced = 0;
  const n = (v) => Number(v) || 0;
  for (const e of lines(text)) {
    const p = e.payload;
    if (e.type === 'session_meta' && typeof p?.cwd === 'string') cwd = p.cwd;
    if (e.type === 'turn_context' && typeof p?.model === 'string') { model = p.model; if (typeof p.cwd === 'string' && !cwd) cwd = p.cwd; }
    const total = p?.type === 'token_count' ? p.info?.total_token_usage : null;
    if (!total) continue;
    const grew = { input: n(total.input_tokens) - n(prev?.input_tokens), read: n(total.cached_input_tokens) - n(prev?.cached_input_tokens), output: n(total.output_tokens) - n(prev?.output_tokens) };
    prev = total;
    const at = Date.parse(e.timestamp);
    if (!(at >= from && at < to) || grew.input + grew.read + grew.output <= 0) continue;
    const base = codexPrices(model);
    if (!base) { unpriced += 1; continue; }
    const price = n(p.info.last_token_usage?.input_tokens) > base.long.above ? base.long : base;
    usd += (Math.max(0, grew.input - grew.read) * price.input + Math.max(0, grew.read) * price.read + Math.max(0, grew.output) * price.output) / 1e6;
  }
  return { cwd, usd, unpriced };
}

// This month's use.  -> { v, at, period: { year, month }, repos: { <slug>: { claude, codex } },
//   logins: [{ tool, dir, usd, repos: [slug] }], other: { claude, codex }, unpriced: { claude, codex } }
// `other` is use in no configured repo; `unpriced` counts requests or turns on a model with no price.
export function readUse({ now = Date.now(), places = repoPlaces(), claudeDirs = projectsDirs().map((projects) => ({ dir: dirname(projects), projects })),
  codexDirs = codexLogins().map((l) => l.dir) } = {}) {
  const w = monthWindow(now);
  const out = { v: 1, at: now, period: { year: w.year, month: w.month }, repos: {}, logins: [], other: { claude: 0, codex: 0 }, unpriced: { claude: 0, codex: 0 } };
  const logins = new Map();
  const add = (tool, dir, cwd, usd) => {
    const slug = repoOfCwd(cwd, places);
    if (slug) { out.repos[slug] ??= { claude: 0, codex: 0 }; out.repos[slug][tool] += usd; } else out.other[tool] += usd;
    const k = `${tool}\u0000${dir}`;
    if (!logins.has(k)) logins.set(k, { tool, dir, usd: 0, repos: new Set() });
    const l = logins.get(k);
    l.usd += usd;
    if (slug) l.repos.add(slug);
  };
  for (const { login, cwd, r } of claudeRequests(claudeDirs, w)) {
    const usd = requestUsd(r);
    if (!usd) { out.unpriced.claude += 1; continue; }
    add('claude', login, cwd, usd.total);
  }
  for (const dir of codexDirs) {
    for (const { path, st } of rolloutLogs(dir) ?? []) {
      if (st.mtimeMs < w.from) continue;
      const u = codexLogUse(logText(path, st.size, true), w);
      out.unpriced.codex += u.unpriced;
      if (u.usd > 0) add('codex', dir, u.cwd, u.usd);
    }
  }
  out.logins = [...logins.values()].map((l) => ({ ...l, repos: [...l.repos].sort() }));
  return out;
}
