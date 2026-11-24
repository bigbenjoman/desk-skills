#!/usr/bin/env node
// Which context-handoff threshold costs least, measured on interactive sessions from their transcripts.
// The handoff hook (hooks/desk-handoff.py) runs only in interactive sessions, so this reads those: each
// session's arm is the threshold T within window W its hook injection names ("desk handoff: context is
// at N% of a W-token window (threshold T%)"), or that of the session whose handoff it resumed; a
// session with neither is `unknown`, shown and never recommended. Per arm: sessions, handoffs per
// session (compactions, and sessions that start from a .handoffs/*.md file), the resume overhead of
// each (the input tokens of the first request after it), and the primary metric, API-equivalent
// dollars per active hour (cache-report.mjs requestUsd, at worker-cost.mjs MODEL_PRICES).
//
// The ticket guardrails are levers-evaluate's fix tries and parks, and post-merge reverts, per ticket
// with an outcome (its outcomeIn, and not in progress again). A session reaches its tickets through
// the work its transcript shows: the branches it ran on or pushed (`git push <remote> <branch>`), and
// the PRs it opened (`gh pr create`: its --title and --head, the issues its --body closes, its number
// from the URL printed) or merged (`gh pr merge <n|url|branch>`, and the title its output names). A
// ticket is the queue's whose branch or PR (result.pr, shipped_pr, draft_pr) that is, or whose key
// (batch-state keyPattern) a PR title or one of those branches names; unless the tracker is Jira, a
// closed issue or a branch starting with its number (`fix/850-slug`) names `issue-N`. A PR in another
// repo (--repo, its URL) is not this repo's. A session that reaches no ticket is measured on the
// session guardrails alone, listed as such: its handoffs, resume overhead and rework, the share of its
// tool calls that returned an error (each a turn of its own redone). Rework above the baseline's by
// the fix-tries margin refuses an arm; it never makes one eligible, and an arm whose ticket guardrails
// are not measured is never recommended on cost alone.
// Where a window lacks data, the report says how many sessions it mapped and why the rest did not.
//
// It recommends, per window, the arm with the fewest dollars per active hour whose guardrails
// hold, against the 45/50 baseline; a person applies it as the §2 "Handoff at context %" row (or its
// 1M row). It never writes config.
//
//   node handoff-report.mjs [--all] [--root <projects dir>] [--tickets <file>] [--json]
//     --all        every project folder, not only this repo's primary root's
//     --root       a projects folder to read instead of every Claude login's
//     --tickets    per-ticket rows (a JSON list: key, branch, prs, state, merged_at, fix_tries,
//                  parks_by_class, post_merge) to read instead of this repo's batches
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { requestOf, requestUsd } from './cache-report.mjs';
import { projectsDirs } from './claude-logins.mjs';
import { GUARDRAILS } from './lever-registry.mjs';
import { EVIDENCE_KEEP_DAYS, GUARDS, outcomeIn, withOutcomes } from './levers-evaluate.mjs';
import { allBatches, DAY_MS, perTicket } from './phase0-report.mjs';
import { everyTicket } from './queue-store.mjs';
import { keyPattern, readQueue } from './batch-state.mjs';
import { isNone } from './config-schema.mjs';
import { closedBy } from './closing-keywords.mjs';
import { FINISHED, STATES } from './queue-states.mjs';

// The queue states a ticket is still in progress in: neither finished nor parked.
const IN_PROGRESS = STATES.filter((s) => !FINISHED.includes(s) && s !== 'parked');

// The fewest sessions an arm needs before it is compared, and the fewest tickets with a value a
// guardrail needs on both the arm and the baseline before it counts as measured.
const MIN_SESSIONS = 5;
const MIN_TICKETS = 3;
// The thresholds the earlier defaults used (DEFAULT_PCT 45 in the hook; 50 on a 1M window).
const BASELINE_PCTS = [45, 50];
// A gap between two lines longer than this counts as this much: idle time is not active time.
const IDLE_CAP_MS = 5 * 60 * 1000;
const CHECKED = ['fix-tries-parks', 'post-merge'];
// Rework is fix tries' analogue within a session, so it takes that guardrail's margin.
const REWORK_MARGIN = GUARDRAILS['fix-tries-parks'].margin.max_rate_ratio;

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
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : '');

// A shell command as its simple commands, each a list of words with the quotes removed, split on
// unquoted ;, &, |, parentheses and newlines. Enough to find gh and git calls; not a shell.
function commandsIn(cmd) {
  const out = [];
  let words = [];
  let w = null;
  let q = null;
  const end = () => { if (w != null) words.push(w); w = null; };
  const cut = () => { end(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else w += c === '\\' && q === '"' && i + 1 < cmd.length ? cmd[++i] : c;
    } else if (c === "'" || c === '"') { q = c; w ??= ''; }
    else if (c === '\\' && i + 1 < cmd.length) w = (w ?? '') + cmd[++i];
    else if (c === ' ' || c === '\t') end();
    else if ('\n;&|()'.includes(c)) cut();
    else w = (w ?? '') + c;
  }
  cut();
  return out;
}

// gh flags that take a value, so the word after one is not a positional.
const GH_VALUED = new Set(['-t', '--title', '-H', '--head', '-R', '--repo', '-b', '--body', '-B', '--base', '-F', '--body-file',
  '--subject', '-A', '--author-email', '--match-head-commit', '-l', '--label', '-a', '--assignee', '-r', '--reviewer', '-m', '--milestone', '-p', '--project', '-T', '--template']);
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const MERGED = /merged pull request \S*?#(\d+) \((.+)\)/;

// The PRs and branches one Bash call touched, from its command and what it printed:
//   -> { prs: [{ number, title, head, repo }], pushed: [branch] }
function workIn(command, output) {
  const prs = [];
  const pushed = [];
  for (let words of commandsIn(command)) {
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === 'rtk')) words = words.slice(1);
    // A redirection (`2>`, `>out`, the file after a bare `>`) and a bare variable (`$1`) are not
    // arguments we can read; a quoted body holding `$(cat <<EOF ...)` is.
    words = words.filter((x, i) => !/^\d*[<>]/.test(x) && !/^\d*[<>]+$/.test(words[i - 1] ?? '') && !/^\$\S*$/.test(x));
    if (words[0] === 'gh' && words[1] === 'pr' && ['create', 'merge'].includes(words[2])) {
      const opts = {};
      const pos = [];
      for (let i = 3; i < words.length; i += 1) {
        const [k, v] = words[i].startsWith('--') && words[i].includes('=') ? [words[i].slice(0, words[i].indexOf('=')), words[i].slice(words[i].indexOf('=') + 1)] : [words[i], null];
        if (GH_VALUED.has(k)) opts[k] = v ?? words[++i];
        else if (!k.startsWith('-')) pos.push(k);
      }
      const repo = opts['--repo'] ?? opts['-R'] ?? null;
      if (words[2] === 'create') {
        const url = PR_URL.exec(output);
        prs.push({ number: url ? Number(url[2]) : null, title: opts['--title'] ?? opts['-t'] ?? null, head: opts['--head'] ?? opts['-H'] ?? null, repo: url?.[1] ?? repo,
          closes: closedBy(opts['--body'] ?? opts['-b'] ?? '') });
      } else {
        const arg = pos[0] ?? null;
        const url = arg ? PR_URL.exec(arg) : null;
        const said = MERGED.exec(output);
        const number = url ? Number(url[2]) : /^\d+$/.test(arg ?? '') ? Number(arg) : said ? Number(said[1]) : null;
        prs.push({ number, title: said && Number(said[1]) === number ? said[2] : null, head: arg && !url && !/^\d+$/.test(arg) ? arg : null, repo: url?.[1] ?? repo });
      }
    }
    if (words[0] === 'git') {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i += ['-C', '-c'].includes(words[i]) ? 2 : 1;
      if (words[i] !== 'push') continue;
      const pos = [];
      for (i += 1; i < words.length; i += 1) {
        if (['-o', '--push-option', '--repo'].includes(words[i])) i += 1;
        else if (!words[i].startsWith('-')) pos.push(words[i]);
      }
      for (const ref of pos.slice(1)) {
        const b = ref.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
        if (b && b !== 'HEAD') pushed.push(b);
      }
    }
  }
  return { prs, pushed };
}
const label = (a) => (a ? `${a.pct}% of ${a.window.toLocaleString('en-US')}` : 'unknown');
const rowName = (window) => (window >= 1_000_000 ? 'Handoff at context % on a 1M window' : 'Handoff at context %');

// One transcript's session: its arm, handoffs, resume overheads, dollars and active hours.
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
  const bash = new Map();
  const calls = new Set();
  let errors = 0;
  const work = { prs: [], pushed: [] };
  for (const { d, raw } of lines) {
    const content = Array.isArray(d.message?.content) ? d.message.content : [];
    for (const c of content) {
      if (c?.type === 'tool_use' && c.id) {
        calls.add(c.id);
        if (c.name === 'Bash' && typeof c.input?.command === 'string') bash.set(c.id, c.input.command);
      }
      if (c?.type === 'tool_result') {
        if (c.is_error === true) errors += 1;
        if (bash.has(c.tool_use_id)) {
          const got = workIn(bash.get(c.tool_use_id), textOf(c.content));
          bash.delete(c.tool_use_id);
          work.prs.push(...got.prs);
          work.pushed.push(...got.pushed);
        }
      }
    }
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
    usd: [...requests.values()].reduce((s, r) => s + (requestUsd(r)?.total ?? 0), 0),
    unpriced: [...requests.values()].filter((r) => !requestUsd(r)).length,
    active_hours: active / 3_600_000, branch: [...branches].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    branches: [...branches.keys()], prs: work.prs, pushed: [...new Set(work.pushed)], tool_calls: calls.size, tool_errors: errors,
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

// This repo's per-ticket rows over the evidence window, each with its queue branch and PRs and its
// post-merge count.
function repoTicketRows(now) {
  try {
    const slug = E.repoSlug();
    const batches = allBatches(slug);
    const { rows } = perTicket({ slug, batches, since: now - EVIDENCE_KEEP_DAYS * DAY_MS, until: now, ci: false, repo: null });
    const queued = new Map();
    for (const b of batches) {
      try {
        for (const t of Object.values(everyTicket(readQueue(b.queue)))) {
          queued.set(`${b.name ?? ''}|${t.key}`, { branch: t.branch ?? null, prs: [t.result?.pr, t.shipped_pr, t.draft_pr].filter((n) => n != null).map(Number) });
        }
      } catch { /* no queue */ }
    }
    return { rows: withOutcomes(rows, batches, now).rows.map((r) => ({ ...r, ...(queued.get(`${r.batch ?? ''}|${r.key}`) ?? { branch: null, prs: [] }) })), note: null };
  } catch (e) {
    return { rows: [], note: `ticket rows unreadable: ${e.message}` };
  }
}

// A ticket row whose outcome is in: merged, or done, parked or failed, and not in progress again (a
// requeued ticket keeps its first merged_at while it runs again).
const hasOutcome = (t) => outcomeIn(t) && !IN_PROGRESS.includes(t.state);

// The ticket keys a text names by the §4 Ticket key pattern, and, unless the tracker is Jira, the
// GitHub issue work ids `#N` and `issue-N` (batch-state keyPattern's `issue-N`).
function keysNamed(texts, { pattern, tracker }) {
  const keys = new Set();
  let re = null;
  try { if (pattern && !isNone(pattern)) re = new RegExp(pattern, 'g'); } catch { /* not a usable regex */ }
  for (const x of texts) {
    if (re) for (const m of x.matchAll(re)) keys.add(m[0]);
    if (tracker !== 'jira') for (const m of x.matchAll(/(?:^|[^A-Za-z0-9])(?:#|issue-)(\d+)(?![0-9])/g)) keys.add(`issue-${m[1]}`);
  }
  return [...keys];
}

// The tickets a session reached: rows whose queue branch is one it ran on or pushed or a PR's head,
// whose PR is one it opened or merged, or whose key a PR title or one of those branches names. A
// session that reaches none says why: `no pr` (no PR, only the default branch), `no key` (nothing it
// touched names a ticket key), `no ticket` (it names keys no queue ticket has: `keys`) or `no outcome`.
function mapSession(s, rows, { repo, base, pattern, tracker }) {
  const ours = (p) => !repo || !p.repo || p.repo.toLowerCase() === repo.toLowerCase();
  const prs = s.prs.filter(ours);
  const branches = [...new Set([...s.branches, ...s.pushed, ...prs.map((p) => p.head)])].filter((b) => b && b !== base && b !== 'HEAD');
  // A PR's closing keywords name its issues as `issue-N`, the work id of a GitHub issue; so, unless
  // the tracker is Jira, does a branch that starts with the issue's number (`fix/850-slug`).
  const issues = tracker === 'jira' ? [] : branches.flatMap((b) => [...b.matchAll(/(?:^|\/)(\d+)(?=-|$)/g)].map((m) => `issue-${m[1]}`));
  const texts = [...branches, ...prs.map((p) => p.title).filter(Boolean), ...prs.flatMap((p) => (p.closes ?? []).map((n) => `issue-${n}`)), ...issues];
  const numbers = prs.map((p) => p.number).filter((n) => n != null);
  const hit = rows.filter((t) => (t.branch && branches.includes(t.branch)) || (t.prs ?? []).some((n) => numbers.includes(Number(n)))
    || (t.key && texts.some((x) => new RegExp(keyPattern(String(t.key))).test(x))));
  const counted = hit.filter(hasOutcome);
  if (counted.length) return { tickets: counted, why: null, keys: [] };
  if (hit.length) return { tickets: [], why: 'no outcome', keys: hit.map((t) => t.key) };
  if (!prs.length && !branches.length) return { tickets: [], why: 'no pr', keys: [] };
  const keys = keysNamed(texts, { pattern, tracker });
  return { tickets: [], why: keys.length ? 'no ticket' : 'no key', keys };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function armRows(sessions) {
  const by = new Map();
  for (const s of sessions) {
    const k = label(s.arm);
    if (!by.has(k)) by.set(k, { arm: k, pct: s.arm?.pct ?? null, window: s.arm?.window ?? null, list: [] });
    by.get(k).list.push(s);
  }
  return [...by.values()].map(({ list, ...a }) => {
    const hours = list.reduce((x, s) => x + s.active_hours, 0);
    const usd = list.reduce((x, s) => x + s.usd, 0);
    const overheads = list.flatMap((s) => s.resume_overheads);
    const mapped = new Map();
    // Only a ticket with an outcome counts: an open one's post-merge is 0 and its fix tries so far.
    for (const s of list) for (const t of s.map.tickets) mapped.set(`${t.batch ?? ''}|${t.key}`, t);
    const calls = list.reduce((x, s) => x + s.tool_calls, 0);
    const errs = list.reduce((x, s) => x + s.tool_errors, 0);
    const rates = Object.fromEntries(CHECKED.map((g) => {
      const vals = [...mapped.values()].map(GUARDS[g].value).filter((v) => v != null);
      return [g, { tickets: vals.length, rate: mean(vals) }];
    }));
    return {
      ...a, sessions: list.length, handoffs: list.reduce((x, s) => x + s.handoffs, 0), fires: list.reduce((x, s) => x + s.fires, 0),
      handoffs_per_session: list.length ? list.reduce((x, s) => x + s.handoffs, 0) / list.length : 0,
      resume_overhead_mean: mean(overheads), resume_samples: overheads.length,
      usd, unpriced: list.reduce((x, s) => x + s.unpriced, 0), active_hours: hours, usd_per_active_hour: hours > 0 ? usd / hours : null,
      sessions_on_tickets: list.filter((s) => s.map.tickets.length).length, sessions_without_ticket: list.filter((s) => !s.map.tickets.length).length,
      guardrails: rates, rework: { tool_calls: calls, tool_errors: errs, rate: calls ? errs / calls : null },
      mapping: { sessions: list.length, mapped: list.filter((s) => s.map.tickets.length).length,
        ...Object.fromEntries(['no pr', 'no key', 'no ticket', 'no outcome'].map((w) => [w.replace(' ', '_'), list.filter((s) => s.map.why === w).length])),
        keys: [...new Set(list.filter((s) => s.map.why === 'no ticket').flatMap((s) => s.map.keys))] },
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
    const sum = (k) => here.reduce((x, a) => x + a.mapping[k], 0);
    const mapping = { ...Object.fromEntries(['sessions', 'mapped', 'no_pr', 'no_key', 'no_ticket', 'no_outcome'].map((k) => [k, sum(k)])),
      keys: [...new Set(here.flatMap((a) => a.mapping.keys))] };
    const out = { window, row: rowName(window), counts, mapping };
    const base = here.filter((a) => BASELINE_PCTS.includes(a.pct)).sort((x, y) => y.sessions - x.sessions)[0];
    if (!base || base.sessions < MIN_SESSIONS || base.usd_per_active_hour == null) {
      return { ...out, verdict: 'not enough data', why: `the ${BASELINE_PCTS.join('/')}% baseline has ${base?.sessions ?? 0} session(s); needs ${MIN_SESSIONS}` };
    }
    if (base.unpriced) return { ...out, baseline: base.arm, verdict: 'not enough data', why: `the ${base.arm} baseline has ${base.unpriced} request(s) on a model with no price` };
    const others = here.filter((a) => a !== base && a.sessions >= MIN_SESSIONS && a.usd_per_active_hour != null);
    if (!others.length) return { ...out, baseline: base.arm, verdict: 'not enough data', why: `no other arm has ${MIN_SESSIONS} session(s)` };
    const refused = [];
    const eligible = [base];
    for (const a of others) {
      const g = guardrailsAgainst(a, base);
      a.guardrail_status = g;
      // Rework needs no ticket: measured, it can refuse an arm, never make one eligible.
      const rw = a.rework.rate != null && base.rework.rate != null
        ? { status: (base.rework.rate === 0 ? a.rework.rate > 0 : a.rework.rate > base.rework.rate * REWORK_MARGIN) ? 'breach' : 'holds',
          why: `${(100 * a.rework.rate).toFixed(1)}% of tool calls errored against ${(100 * base.rework.rate).toFixed(1)}% (margin ${REWORK_MARGIN}x)` }
        : { status: 'not measured', why: 'no tool calls on this arm or the baseline' };
      a.rework_status = rw;
      // Dollars are compared on complete data only: an unpriced request adds hours but no dollars.
      const bad = [...(a.unpriced ? [`${a.unpriced} request(s) on a model with no price`] : []),
        ...Object.entries(g).filter(([, v]) => v.status !== 'holds').map(([k, v]) => `${k} ${v.status}: ${v.why}`),
        ...(rw.status === 'breach' ? [`rework breach: ${rw.why}`] : [])];
      if (bad.length) refused.push({ arm: a.arm, why: bad.join('; ') });
      else eligible.push(a);
    }
    const best = eligible.reduce((x, y) => (y.usd_per_active_hour < x.usd_per_active_hour ? y : x));
    const save = 1 - best.usd_per_active_hour / base.usd_per_active_hour;
    return {
      ...out, baseline: base.arm, verdict: 'recommend', arm: best.arm, pct: best.pct, refused,
      why: best === base ? 'no other arm is cheaper with its guardrails measured and holding: keep the baseline'
        : `${(100 * save).toFixed(0)}% fewer dollars per active hour than the ${base.arm} baseline, guardrails holding`,
    };
  });
}

// How many of a window's sessions reached a ticket, and what would map the rest.
function mappingText(m) {
  const rest = [
    [m.no_pr, 'touched no PR and ran on the default branch: open, push or merge the work\'s PR from the session, or work on a branch named for its ticket'],
    [m.no_key, 'touched a PR or branch that names no ticket key: put the key in the PR title or branch (a PR merged by number shows no title)'],
    [m.no_ticket, `named a key no queue ticket has (${m.keys.slice(0, 5).join(', ')}${m.keys.length > 5 ? ` and ${m.keys.length - 5} more` : ''}): run the ticket through desk so its queue records it`],
    [m.no_outcome, 'reached a ticket with no outcome yet: it counts once merged, or done, parked or failed'],
  ].filter(([n]) => n).map(([n, why]) => `${n} ${why}`);
  return `    saw ${m.sessions} session(s), mapped ${m.mapped} to a ticket with an outcome${rest.length ? `; ${rest.join('; ')}` : ''}`;
}

const fmt = (v, places = 0) => (v == null ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: places }));

function reportText(rep) {
  const head = ['arm', 'sessions', 'on tickets', 'handoffs/session', 'resume overhead (mean, n)', '$/active hour', 'active hours', ...CHECKED, 'rework'];
  const rows = rep.arms.map((a) => [a.arm, a.sessions, a.sessions_on_tickets, fmt(a.handoffs_per_session, 2), `${fmt(a.resume_overhead_mean)} (${a.resume_samples})`,
    a.usd_per_active_hour == null ? '-' : `$${a.usd_per_active_hour.toFixed(2)}`, fmt(a.active_hours, 1), ...CHECKED.map((g) => a.guardrail_status?.[g]?.status ?? `${a.guardrails[g].tickets} ticket(s)`),
    a.rework_status?.status ?? (a.rework.rate == null ? '-' : `${(100 * a.rework.rate).toFixed(1)}%`)]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => `  ${r.map((c, i) => String(c).padEnd(width[i])).join('  ')}`.trimEnd();
  const unpriced = rep.arms.reduce((x, a) => x + a.unpriced, 0);
  return [
    `HANDOFF REPORT (${rep.scope}): ${rep.sessions.length} session(s); dollars are API-equivalent at list prices (worker-cost.mjs MODEL_PRICES); active hours count each gap up to ${IDLE_CAP_MS / 60000} minutes`,
    line(head), ...rows.map(line),
    ...(unpriced ? [`  (${unpriced} request(s) on a model with no price, left out of the dollars)`] : []),
    ...(rep.ticket_note ? [`  (${rep.ticket_note}; guardrails not measured)`] : []),
    `  (${rep.sessions.filter((s) => s.measured_on === 'tickets').length} session(s) reached a ticket with an outcome (merged, or done, parked or failed) and are measured on its guardrails; ${rep.sessions.filter((s) => s.measured_on === 'session only').length} are measured on the session guardrails alone (handoffs, resume overhead, rework: tool calls that errored), which can refuse an arm but never make one eligible)`,
    'RECOMMENDATION',
    ...(rep.recommendations.length ? rep.recommendations.flatMap((r) => [r.verdict === 'recommend'
      ? `  §2 "${r.row}": ${r.pct} (${r.arm}): ${r.why}${r.refused.length ? `; not ${r.refused.map((x) => `${x.arm} (${x.why})`).join(', ')}` : ''}`
      : `  §2 "${r.row}" (${r.window.toLocaleString('en-US')}-token window): not enough data: ${r.why} (sessions per arm: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')})`,
    // Where a window lacks data: what its sessions reached, and what would map the rest.
    ...(r.verdict !== 'recommend' || r.refused.some((x) => x.why.includes('not measured')) ? [mappingText(r.mapping)] : [])])
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
  const read = (f) => { try { return f(); } catch { return null; } };
  const ctx = { repo: read(E.ghRepo), base: read(E.defaultBranch) ?? 'main', pattern: read(() => E.configValue('ticket-pattern')),
    tracker: String(read(() => E.configValue('tracker')) ?? '').trim().toLowerCase() };
  for (const s of sessions) {
    s.map = mapSession(s, tickets.rows, ctx);
    s.tickets = s.map.tickets.map((t) => t.key);
    s.measured_on = s.tickets.length ? 'tickets' : 'session only';
    s.unmapped = s.map.why;
  }
  const arms = armRows(sessions);
  const rep = {
    scope: project ? `project ${project}` : 'every project', sessions: sessions.map(({ named, resumed_from, map, ...s }) => s), arms,
    recommendations: recommend(arms), ticket_note: tickets.note, guidance: GUIDANCE.map(([title, url]) => ({ title, url })), gap: GAP,
  };
  console.log(argv.includes('--json') ? JSON.stringify(rep, null, 2) : reportText(rep));
}
