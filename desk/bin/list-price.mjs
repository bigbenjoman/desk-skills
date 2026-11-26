// Each configured repo's Claude and Codex use in a window, priced at API list prices: what the work
// would have cost bought by the token, never what was billed (a subscription pays for it). Claude's
// is every login's session transcripts (claude-logins.mjs projectsDirs), each request once by its id
// and priced as cache-report.mjs requestUsd prices it. Codex's is every login's rollout logs
// (codex-usage.mjs rolloutLogs): each token_count event that moves its session's running total is one
// request, priced at worker-cost.mjs CODEX_PRICES by the model the session's last turn_context names.
// A session is the repo's whose root or worktrees folder it ran in, so workers and interactive
// sessions both count. A request on a model with no list price is counted as unpriced, never as $0.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as zlib from 'node:zlib';
import { requestOf, requestUsd } from './cache-report.mjs';
import { projectsDirs } from './claude-logins.mjs';
import { codexLogins, rolloutLogs } from './codex-usage.mjs';
import { configuredRepos, repoDirs } from './desk-env.mjs';
import { codexPrice } from './worker-cost.mjs';

const n = (v) => Number(v) || 0;
const lines = (text) => String(text).split('\n').flatMap((l) => { if (!l.trim()) return []; try { return [JSON.parse(l)]; } catch { return []; } });

// One Codex request's list-price dollars from its token_count `last_token_usage`, or null on a model
// with no price. Input counts its cached part, which is priced as a cache read.
export function codexUsd(model, u) {
  const base = codexPrice(model);
  if (!base) return null;
  const input = n(u?.input_tokens), cached = Math.min(input, n(u?.cached_input_tokens));
  const p = base.over && input > base.over.above ? base.over : base;
  return ((input - cached) * p.input + cached * p.read + n(u?.output_tokens) * p.output) / 1e6;
}

// A Claude transcript as { cwd, reqs: [{ id, at, usd }] }, usd null where its model has no price.
export function claudeSession(text) {
  const ds = lines(text);
  const reqs = [];
  const byId = new Map();
  for (const d of ds) {
    const r = requestOf(d);
    if (!r || !Number.isFinite(r.at)) continue;
    const had = r.id ? byId.get(r.id) : null;
    // A request is logged once per content block, each with the output so far: the largest stands.
    if (had) { if (r.output > had.r.output) Object.assign(had, { r, usd: requestUsd(r)?.total ?? null }); continue; }
    const q = { id: r.id, at: r.at, r, usd: requestUsd(r)?.total ?? null };
    if (r.id) byId.set(r.id, q);
    reqs.push(q);
  }
  return { cwd: ds.find((d) => typeof d?.cwd === 'string')?.cwd ?? null, reqs: reqs.map(({ id, at, usd }) => ({ id, at, usd })) };
}

// A Codex rollout as { cwd, reqs: [{ id: null, at, usd }] }. Codex can log one token_count twice;
// one that leaves the running total where it was is not a request.
export function codexSession(text) {
  let cwd = null, model = null, total = null;
  const reqs = [];
  for (const e of lines(text)) {
    const p = e?.payload;
    if (e?.type === 'session_meta' && typeof p?.cwd === 'string') cwd ??= p.cwd;
    if (e?.type === 'turn_context' && typeof p?.model === 'string') model = p.model;
    if (p?.type !== 'token_count' || !p.info?.last_token_usage) continue;
    const t = n(p.info.total_token_usage?.total_tokens);
    if (total != null && t === total) continue;
    total = t;
    const at = Date.parse(e.timestamp);
    if (Number.isFinite(at)) reqs.push({ id: null, at, usd: codexUsd(model, p.info.last_token_usage) });
  }
  return { cwd, reqs };
}

// Each file's session, kept while its size and modified time hold, so a screen redrawn every few
// seconds reads only what changed.
const parsed = new Map();
function sessionOf(path, st, read) {
  const had = parsed.get(path);
  if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return had.s;
  let text = '';
  try { text = path.endsWith('.zst') ? (zlib.zstdDecompressSync ? zlib.zstdDecompressSync(readFileSync(path)).toString('utf8') : '') : readFileSync(path, 'utf8'); } catch { /* unreadable: no use */ }
  const s = read(text);
  parsed.set(path, { size: st.size, mtimeMs: st.mtimeMs, s });
  return s;
}

function transcripts(dir) {
  let names = [];
  try { names = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return names.flatMap((f) => { const path = join(dir, f); try { const st = statSync(path); return st.isFile() ? [{ path, st }] : []; } catch { return []; } });
}

const inside = (cwd, dirs) => typeof cwd === 'string' && dirs.some((d) => cwd === d || cwd.startsWith(`${d}/`));

// repos: [{ slug, dirs }]; from and to in epoch ms, `to` exclusive.
//   -> { [slug]: { usd, claude, codex, unpriced } } for each repo with any use in the window
export function useByRepo({ repos, from, to, claudeDirs, codexDirs }) {
  const out = {};
  const mine = repos.filter((r) => r.dirs.length);
  if (!mine.length) return out;
  const seen = new Set();
  const add = (tool, cwd, reqs) => {
    const repo = mine.find((r) => inside(cwd, r.dirs));
    if (!repo) return;
    for (const q of reqs) {
      if (q.at < from || q.at >= to) continue;
      if (q.id) { if (seen.has(q.id)) continue; seen.add(q.id); }
      const u = (out[repo.slug] ??= { usd: 0, claude: 0, codex: 0, unpriced: 0 });
      if (q.usd == null) { u.unpriced += 1; continue; }
      u.usd += q.usd;
      u[tool] += q.usd;
    }
  };
  for (const dir of new Set(claudeDirs ?? projectsDirs())) {
    for (const { path, st } of transcripts(dir)) {
      if (st.mtimeMs < from) continue;
      const s = sessionOf(path, st, claudeSession);
      add('claude', s.cwd, s.reqs);
    }
  }
  for (const dir of new Set(codexDirs ?? codexLogins().map((l) => l.dir))) {
    for (const { path, st } of rolloutLogs(dir) ?? []) {
      if (st.mtimeMs < from) continue;
      const s = sessionOf(path, st, codexSession);
      add('codex', s.cwd, s.reqs);
    }
  }
  return out;
}

// Every configured repo with the folders its sessions run in.  -> [{ slug, dirs }]
export const repoFolders = () => configuredRepos().map(({ slug }) => {
  const d = repoDirs(slug);
  return { slug, dirs: [d.root, d.worktrees].filter(Boolean) };
});

// The calendar month `now` is in, local time, from its first day to `now`.  -> { from, to }
export function monthSoFar(now = Date.now()) {
  const d = new Date(now);
  return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: now + 1 };
}
