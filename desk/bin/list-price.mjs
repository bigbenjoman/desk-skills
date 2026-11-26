// Each configured repo's Claude and Codex use in a window, priced at API list prices: what the work
// would have cost bought by the token, never what was billed (a subscription pays for it). Claude's
// is every login's session transcripts (claude-logins.mjs projectsDirs), each request once by its id
// and priced as cache-report.mjs requestUsd prices it. Codex's is every login's rollout logs
// (codex-usage.mjs rolloutLogs): each token_count event that moves its session's running total is one
// request, priced at worker-cost.mjs CODEX_PRICES by the model the session's last turn_context names.
// A session is the repo's whose root or worktrees folder it ran in, so workers and interactive
// sessions both count. A request on a model with no list price is counted as unpriced, never as $0.
// Costs reads it over the days its charges cover (chargedWindow), so the two figures on a row agree.
import { statSync } from 'node:fs';
import { jsonLines as lines, keepRequest, requestOf, requestUsd, transcripts as transcriptPaths } from './cache-report.mjs';
import { projectsDirs } from './claude-logins.mjs';
import { chargesWindow, readingPeriod } from './cost-cache.mjs';
import { codexLogins, logText, rolloutLogs } from './codex-usage.mjs';
import { configuredRepos, repoDirs } from './desk-env.mjs';
import { codexPrice } from './worker-cost.mjs';

const n = (v) => Number(v) || 0;

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
  const requests = new Map();
  for (const d of ds) {
    const r = requestOf(d);
    if (r && Number.isFinite(r.at)) keepRequest(requests, r);
  }
  return { cwd: ds.find((d) => typeof d?.cwd === 'string')?.cwd ?? null,
    reqs: [...requests.values()].map(({ r }) => ({ id: r.id, at: r.at, usd: requestUsd(r)?.total ?? null })) };
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
  const s = read(logText(path, st.size, true));
  parsed.set(path, { size: st.size, mtimeMs: st.mtimeMs, s });
  return s;
}

const transcripts = (dir) => transcriptPaths(dir).flatMap((path) => { try { return [{ path, st: statSync(path) }]; } catch { return []; } });

const inside = (cwd, dirs) => typeof cwd === 'string' && dirs.some((d) => cwd === d || cwd.startsWith(`${d}/`));

// repos: [{ slug, dirs }]; from and to in epoch ms, `to` exclusive.
//   -> { [slug]: { usd, claude, codex, unpriced } } for each repo with any use in the window
export function useByRepo({ repos, from, to }) {
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
  for (const dir of new Set(projectsDirs())) {
    for (const { path, st } of transcripts(dir)) {
      if (st.mtimeMs < from) continue;
      const s = sessionOf(path, st, claudeSession);
      add('claude', s.cwd, s.reqs);
    }
  }
  for (const dir of new Set(codexLogins().map((l) => l.dir))) {
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

// The days a cost reading's charges cover (cost-cache.mjs: `period`, else the one a reading at `now`
// would cover), as the window the list-price use beside them is read over.  -> { from, to } in epoch ms
export function chargedWindow({ period = null, now = Date.now() } = {}) {
  const w = chargesWindow(period ?? readingPeriod(now));
  return { from: Date.parse(w.from), to: Date.parse(w.to) };
}
