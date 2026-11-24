#!/usr/bin/env node
// Which context-handoff threshold costs least, measured on interactive sessions from their transcripts.
// The handoff hook (hooks/desk-handoff.py) runs only in interactive sessions, so this reads those: each
// session's arm is the threshold T within window W its hook injection names ("desk handoff: context is
// at N% of a W-token window (threshold T%)"), or that of the session whose handoff it resumed; a
// session with neither is `unknown`, shown and never recommended. Per arm: sessions, handoffs per
// session (compactions, and sessions that start from a .handoffs/*.md file), the resume overhead of
// each (the input tokens of the first request after it), and the primary metric, cost-weighted tokens
// per active hour. The guardrails are levers-evaluate's fix tries and parks, and post-merge reverts,
// per ticket, reached through each session's git branch (a ticket whose queue branch it is, or whose
// key the branch names); a session on no ticket's branch measures none, and an arm whose guardrails
// are not measured is never recommended on cost alone.
//
// It recommends, per window, the arm with the fewest weighted tokens per active hour whose guardrails
// hold, against the 45/50 baseline; a person applies it as the §2 "Handoff at context %" row (or its
// 1M row). It never writes config.
//
//   node handoff-report.mjs [--all] [--root <projects dir>] [--tickets <file>] [--json]
//     --all        every project folder, not only this repo's primary root's
//     --root       a projects folder to read instead of every Claude login's
//     --tickets    per-ticket rows (a JSON list: key, branch, fix_tries, parks_by_class, post_merge)
//                  to read instead of this repo's batches
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { requestOf } from './cache-report.mjs';
import { projectsDirs } from './claude-logins.mjs';
import { GUARDRAILS } from './lever-registry.mjs';
import { EVIDENCE_KEEP_DAYS, GUARDS, withOutcomes } from './levers-evaluate.mjs';
import { allBatches, DAY_MS, perTicket } from './phase0-report.mjs';
import { everyTicket } from './queue-store.mjs';
import { readQueue } from './batch-state.mjs';

// The fewest sessions an arm needs before it is compared, and the fewest tickets with a value a
// guardrail needs on both the arm and the baseline before it counts as measured.
const MIN_SESSIONS = 5;
const MIN_TICKETS = 3;
// The thresholds the earlier defaults used (DEFAULT_PCT 45 in the hook; 50 on a 1M window).
const BASELINE_PCTS = [45, 50];
// A gap between two lines longer than this counts as this much: idle time is not active time.
const IDLE_CAP_MS = 5 * 60 * 1000;
// Token weights relative to uncached input, as list prices weigh them.
const WEIGHTS = { uncached: 1, w5m: 1.25, w1h: 2, read: 0.1, output: 5 };
const CHECKED = ['fix-tries-parks', 'post-merge'];

const GUIDANCE = [
  ['Lost in the Middle (Liu et al., TACL 2023)', 'https://arxiv.org/abs/2307.03172'],
  ['RULER (Hsieh et al., NVIDIA, 2024)', 'https://arxiv.org/abs/2404.06654'],
  ['NoLiMa (Modarressi et al., ICML 2025)', 'https://arxiv.org/abs/2502.05167'],
  ['Context Rot (Chroma, 2025)', 'https://www.trychroma.com/research/context-rot'],
  ['Anthropic, Effective context engineering for AI agents (2025)', 'https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents'],
  ['Anthropic, Using Claude Code: session management and 1M context (2026)', 'https://claude.com/resources/articles/using-claude-code-session-management-and-1m-context'],
  ['Claude Code docs, Manage costs', 'https://code.claude.com/docs/en/costs'],
  ['Claude Code docs, model config', 'https://code.claude.com/docs/en/model-config'],
  ['Anthropic pricing', 'https://platform.claude.com/docs/en/about-claude/pricing'],
  ['Restart trajectory analysis (ejc3, 2025)', 'https://ejc3.github.io/claude-restart-trajectory-analysis'],
];
const GAP = 'No source measures a handoff at 20-30%; on a 1M window the absolute tokens re-read each turn matter more than the share.';

const FIRE = /desk handoff: context is at \d+% of a ([\d,]+)-token window \(threshold ([\d.]+)%\)/;
const NAMED = /\(repo-relative: (\.handoffs\/[^\s)]+\.md)\)/;
const HANDOFF_FILE = /\.handoffs\/[A-Za-z0-9._-]+\.md/;

const inputOf = (r) => r.uncached + r.w5m + r.w1h + r.read;
const weightOf = (r) => Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * r[k], 0);
const label = (a) => (a ? `${a.pct}% of ${a.window.toLocaleString('en-US')}` : 'unknown');
const rowName = (window) => (window >= 1_000_000 ? 'Handoff at context % on a 1M window' : 'Handoff at context %');

// One transcript's session: its arm, handoffs, resume overheads, weighted tokens and active hours.
function sessionOf(file, text) {
  const lines = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const d = JSON.parse(l); if (d && !d.isSidechain) lines.push({ d, raw: l }); } catch { /* not JSON */ }
  }
  let arm = null;
  let named = null;
  const fires = new Set();
  let compactions = 0;
  let afterBoundary = false;
  let resumed = false;
  let resumedFrom = null;
  let seenRequest = false;
  const overheads = [];
  const requests = new Map();
  const times = [];
  const branches = new Map();
  for (const { d, raw } of lines) {
    const at = Date.parse(d.timestamp);
    if (Number.isFinite(at)) times.push(at);
    if (d.gitBranch) branches.set(d.gitBranch, (branches.get(d.gitBranch) ?? 0) + 1);
    if (d.type === 'attachment') {
      const m = FIRE.exec(raw);
      if (m) {
        fires.add(d.attachment?.toolUseID ?? d.uuid ?? raw);
        arm ??= { pct: Number(m[2]), window: Number(m[1].replace(/,/g, '')) };
        named ??= NAMED.exec(raw)?.[1] ?? null;
      }
    }
    if (d.type === 'system' && d.subtype === 'compact_boundary') { compactions += 1; afterBoundary = true; }
    const r = requestOf(d);
    if (!seenRequest && (r || d.type === 'user' || d.type === 'attachment') && HANDOFF_FILE.test(raw)) {
      resumed = true;
      resumedFrom ??= HANDOFF_FILE.exec(raw)[0];
    }
    if (!r) continue;
    if (!seenRequest && resumed) overheads.push(inputOf(r));
    if (afterBoundary) { overheads.push(inputOf(r)); afterBoundary = false; }
    seenRequest = true;
    const key = r.id ?? `line-${requests.size}`;
    const had = requests.get(key);
    if (had) had.output = Math.max(had.output, r.output);
    else requests.set(key, r);
  }
  times.sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < times.length; i += 1) active += Math.min(times[i] - times[i - 1], IDLE_CAP_MS);
  return {
    id: basename(file, '.jsonl'), project: basename(join(file, '..')), arm, named, resumed_from: resumedFrom,
    fires: fires.size, compactions, resumed, handoffs: compactions + (resumed ? 1 : 0), resume_overheads: overheads,
    weighted_tokens: Math.round([...requests.values()].reduce((s, r) => s + weightOf(r), 0)),
    active_hours: active / 3_600_000, branch: [...branches].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

// The transcripts to read: each projects folder's own folder for this repo's primary root, or every one.
function transcriptFiles(roots, project) {
  const dirs = roots.flatMap((root) => {
    if (project) return [join(root, project)];
    try { return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(root, e.name)); } catch { return []; }
  });
  return dirs.flatMap((dir) => {
    try { return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)); } catch { return []; }
  });
}

// This repo's per-ticket rows over the evidence window, each with its queue branch and post-merge count.
function repoTicketRows(now) {
  try {
    const slug = E.repoSlug();
    const batches = allBatches(slug);
    const { rows } = perTicket({ slug, batches, since: now - EVIDENCE_KEEP_DAYS * DAY_MS, until: now, ci: false, repo: null });
    const branchOf = new Map();
    for (const b of batches) {
      try { for (const t of Object.values(everyTicket(readQueue(b.queue)))) if (t.branch) branchOf.set(`${b.name ?? ''}|${t.key}`, t.branch); } catch { /* no queue */ }
    }
    return { rows: withOutcomes(rows, batches, now).rows.map((r) => ({ ...r, branch: branchOf.get(`${r.batch ?? ''}|${r.key}`) ?? null })), note: null };
  } catch (e) {
    return { rows: [], note: `ticket rows unreadable: ${e.message}` };
  }
}

// The ticket a branch worked on: the one whose queue branch it is, else one whose key it names.
function ticketOf(branch, tickets) {
  if (!branch) return null;
  const exact = tickets.find((t) => t.branch === branch);
  if (exact) return exact;
  const names = (key) => new RegExp(`(^|[^A-Za-z0-9])${String(key).replace(/^#/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`, 'i').test(branch);
  return tickets.find((t) => t.key && names(t.key)) ?? null;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function armRows(sessions, tickets) {
  const by = new Map();
  for (const s of sessions) {
    const k = label(s.arm);
    if (!by.has(k)) by.set(k, { arm: k, pct: s.arm?.pct ?? null, window: s.arm?.window ?? null, list: [] });
    by.get(k).list.push(s);
  }
  return [...by.values()].map(({ list, ...a }) => {
    const hours = list.reduce((x, s) => x + s.active_hours, 0);
    const weighted = list.reduce((x, s) => x + s.weighted_tokens, 0);
    const overheads = list.flatMap((s) => s.resume_overheads);
    const mapped = new Map();
    for (const s of list) { const t = ticketOf(s.branch, tickets); if (t) mapped.set(`${t.batch ?? ''}|${t.key}`, t); }
    const rates = Object.fromEntries(CHECKED.map((g) => {
      const vals = [...mapped.values()].map(GUARDS[g].value).filter((v) => v != null);
      return [g, { tickets: vals.length, rate: mean(vals) }];
    }));
    return {
      ...a, sessions: list.length, handoffs: list.reduce((x, s) => x + s.handoffs, 0), fires: list.reduce((x, s) => x + s.fires, 0),
      handoffs_per_session: list.length ? list.reduce((x, s) => x + s.handoffs, 0) / list.length : 0,
      resume_overhead_mean: mean(overheads), resume_samples: overheads.length,
      weighted_tokens: weighted, active_hours: hours, per_active_hour: hours > 0 ? weighted / hours : null,
      sessions_on_tickets: list.filter((s) => ticketOf(s.branch, tickets)).length, guardrails: rates,
    };
  });
}

// Each guardrail of an arm against the baseline: holds, breach, or not measured (with why).
function guardrailsAgainst(arm, base) {
  return Object.fromEntries(CHECKED.map((g) => {
    const a = arm.guardrails[g];
    const b = base.guardrails[g];
    const margin = GUARDRAILS[g].margin.max_rate_ratio;
    if (a.tickets < MIN_TICKETS || b.tickets < MIN_TICKETS) {
      return [g, { status: 'not measured', why: `${a.tickets} ticket(s) on this arm, ${b.tickets} on the baseline; needs ${MIN_TICKETS} each` }];
    }
    const breach = b.rate === 0 ? a.rate > 0 : a.rate > b.rate * margin;
    return [g, { status: breach ? 'breach' : 'holds', why: `${a.rate.toFixed(2)} per ticket against ${b.rate.toFixed(2)} (margin ${margin}x)` }];
  }));
}

// Per window: the cheapest arm whose guardrails hold, or why there is not enough data.
function recommend(arms) {
  const windows = [...new Set(arms.filter((a) => a.window).map((a) => a.window))].sort((x, y) => x - y);
  return windows.map((window) => {
    const here = arms.filter((a) => a.window === window);
    const counts = Object.fromEntries(here.map((a) => [a.arm, a.sessions]));
    const out = { window, row: rowName(window), counts };
    const base = here.filter((a) => BASELINE_PCTS.includes(a.pct)).sort((x, y) => y.sessions - x.sessions)[0];
    if (!base || base.sessions < MIN_SESSIONS || base.per_active_hour == null) {
      return { ...out, verdict: 'not enough data', why: `the ${BASELINE_PCTS.join('/')}% baseline has ${base?.sessions ?? 0} session(s); needs ${MIN_SESSIONS}` };
    }
    const others = here.filter((a) => a !== base && a.sessions >= MIN_SESSIONS && a.per_active_hour != null);
    if (!others.length) return { ...out, baseline: base.arm, verdict: 'not enough data', why: `no other arm has ${MIN_SESSIONS} session(s)` };
    const refused = [];
    const eligible = [base];
    for (const a of others) {
      const g = guardrailsAgainst(a, base);
      a.guardrail_status = g;
      const bad = Object.entries(g).filter(([, v]) => v.status !== 'holds');
      if (bad.length) refused.push({ arm: a.arm, why: bad.map(([k, v]) => `${k} ${v.status}: ${v.why}`).join('; ') });
      else eligible.push(a);
    }
    const best = eligible.reduce((x, y) => (y.per_active_hour < x.per_active_hour ? y : x));
    const save = 1 - best.per_active_hour / base.per_active_hour;
    return {
      ...out, baseline: base.arm, verdict: 'recommend', arm: best.arm, pct: best.pct, refused,
      why: best === base ? 'no other arm is cheaper with its guardrails measured and holding: keep the baseline'
        : `${(100 * save).toFixed(0)}% fewer weighted tokens per active hour than the ${base.arm} baseline, guardrails holding`,
    };
  });
}

const fmt = (v, places = 0) => (v == null ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: places }));

function reportText(rep) {
  const head = ['arm', 'sessions', 'handoffs/session', 'resume overhead (mean, n)', 'weighted tokens/active hour', 'active hours', ...CHECKED];
  const rows = rep.arms.map((a) => [a.arm, a.sessions, fmt(a.handoffs_per_session, 2), `${fmt(a.resume_overhead_mean)} (${a.resume_samples})`,
    fmt(a.per_active_hour), fmt(a.active_hours, 1), ...CHECKED.map((g) => a.guardrail_status?.[g]?.status ?? `${a.guardrails[g].tickets} ticket(s)`)]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => `  ${r.map((c, i) => String(c).padEnd(width[i])).join('  ')}`.trimEnd();
  const w = Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    `HANDOFF REPORT (${rep.scope}): ${rep.sessions.length} session(s); weighted tokens weigh ${w}; active hours count each gap up to ${IDLE_CAP_MS / 60000} minutes`,
    line(head), ...rows.map(line),
    ...(rep.ticket_note ? [`  (${rep.ticket_note}; guardrails not measured)`] : []),
    `  (${rep.sessions.filter((s) => s.ticket).length} session(s) on a ticket's branch; the rest measure no guardrail)`,
    'RECOMMENDATION',
    ...(rep.recommendations.length ? rep.recommendations.map((r) => (r.verdict === 'recommend'
      ? `  §2 "${r.row}": ${r.pct} (${r.arm}): ${r.why}${r.refused.length ? `; not ${r.refused.map((x) => `${x.arm} (${x.why})`).join(', ')}` : ''}`
      : `  §2 "${r.row}" (${r.window.toLocaleString('en-US')}-token window): not enough data: ${r.why} (sessions per arm: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')})`))
      : ['  not enough data: no session ran under a known threshold']),
    '  A recommendation only: set the §2 row by hand to apply it, and back to revert it.',
    'GUIDANCE',
    ...GUIDANCE.map(([t, u]) => `  - ${t}: ${u}`),
    `  Gap: ${GAP}`,
  ].join('\n');
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
  const now = Date.now();
  let project = null;
  if (!argv.includes('--all')) {
    try { project = E.repoRoot().replace(/[^A-Za-z0-9]/g, '-'); }
    catch (e) { console.error(`handoff-report: ${e.message}; pass --all to read every project`); process.exit(2); }
  }
  const roots = opt('--root') ? [opt('--root')] : projectsDirs();
  const sessions = [];
  for (const f of transcriptFiles([...new Set(roots)], project)) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    sessions.push(sessionOf(f, text));
  }
  // A resumed session with no injection of its own ran under the arm of the session that named its handoff.
  const namer = new Map(sessions.filter((s) => s.named).map((s) => [`${s.project}|${s.named}`, s.arm]));
  for (const s of sessions) if (!s.arm && s.resumed_from) s.arm = namer.get(`${s.project}|${s.resumed_from}`) ?? null;
  let tickets;
  if (opt('--tickets')) {
    try { tickets = { rows: JSON.parse(readFileSync(opt('--tickets'), 'utf8')), note: null }; }
    catch (e) { tickets = { rows: [], note: `ticket rows unreadable: ${e.message}` }; }
  } else tickets = repoTicketRows(now);
  for (const s of sessions) s.ticket = ticketOf(s.branch, tickets.rows)?.key ?? null;
  const arms = armRows(sessions, tickets.rows);
  const rep = {
    scope: project ? `project ${project}` : 'every project', sessions: sessions.map(({ named, resumed_from, ...s }) => s), arms,
    recommendations: recommend(arms), ticket_note: tickets.note, guidance: GUIDANCE.map(([title, url]) => ({ title, url })), gap: GAP,
  };
  console.log(argv.includes('--json') ? JSON.stringify(rep, null, 2) : reportText(rep));
}
