#!/usr/bin/env node
// Which context-handoff threshold costs least, measured on session transcripts: this repo's primary
// root's project folder and each of its worktrees' (§2 Worktrees directory), where autopilot workers run.
// Each session's arm is the threshold T within window W its hook injection names ("desk handoff: context
// is at N% of a W-token window (threshold T%)", or a worker's "…, past this worker's threshold of T%"),
// else the one the hook stamped in its per-session state (<DESK_HOME>/handoff/<session>.json: `arm`, or
// the §2 rows `pct`/`pct_1m` it read at the session's first check, on the window its model and peak
// context give), else that of the session whose handoff it resumed; a session with none is `unknown`,
// shown and never recommended. An arm whose threshold, in tokens, is below the mean resume overhead
// measured on its window is flagged as below start-up cost, one whose sessions hand off in a loop, and
// never recommended. Per arm: sessions, handoffs per
// session (compactions, and sessions that start from a .handoffs/*.md file), the resume overhead of
// each (the input tokens of the first request after it; an autopilot worker session, which starts
// from its briefing, counts its first request), and the primary metric, API-equivalent
// dollars per active hour (cache-report.mjs requestUsd, at worker-cost.mjs MODEL_PRICES).
//
// The ticket guardrails are levers-evaluate's fix tries and parks, and post-merge reverts, per ticket
// with an outcome (its outcomeIn, and not in progress again). A session reaches its tickets through
// the work its transcript shows: the branches it ran on or pushed (`git push <remote> <branch>`), and
// the PRs it opened (`gh pr create`: its --title and --head, the issues of this repo its --body
// closes, its number from the URL printed) or merged (`gh pr merge <n|url|branch>`, and the title its
// output names). A ticket is the queue's whose branch or PR (result.pr, shipped_pr, draft_pr) that
// is, or whose key (batch-state keyPattern, ignoring case) a PR title or one of those branches names;
// unless the tracker is Jira, a closed issue or a branch starting with its number (`fix/850-slug`)
// names `issue-N`. A PR in another repo (--repo, its URL) is not this repo's. A session that reaches no ticket is measured on the
// session guardrails alone, listed as such: its handoffs, resume overhead and rework, the share of its
// tool calls that returned an error (each a turn of its own redone). Rework above the baseline's by
// the fix-tries margin refuses an arm; it never makes one eligible.
//
// Work no queue ticket is behind is measured on its merged PRs instead (pr-outcomes.mjs, read from
// GitHub in batches, each PR on its own windows, cached with the windows still open, or not at all
// with --offline): reverts and red main runs, follow-up fixes within 48 hours on the same files, and
// review rounds, each against the baseline at the registry's margin. A PR counts once final, every
// window closed (the revert watch's 14 days) and read in full. A session maps to its ticket where one is behind its work, else to its PRs,
// never both. An arm is judged on whichever of the two (tickets or PRs) is measured on it and the
// baseline; a breach of either refuses it, and with neither measured it is never recommended on cost
// alone. Each window states its sample per arm against the minimum, and where it lacks data, how many
// sessions it mapped and why the rest did not.
//
// It recommends, per window, the arm with the fewest dollars per active hour whose guardrails
// hold, against the 45/50 baseline; a person applies it as the §2 "Handoff at context %" row (or its
// 1M row). It never writes config.
//
// While PRs' windows are still open, each window also gets a provisional reading per arm, from the
// elapsed part of those windows (final PRs and open ones together), with how many PRs and hours it
// rests on. It never changes the verdict, which waits for final outcomes: in a live trial both arms
// keep gaining PRs and the baseline's open ones can still turn out reverted, so any reading taken
// before the windows close can be reversed. An arm whose provisional reading already breaches the
// baseline's provisional reading is flagged at once, as would be refused on what is seen so far.
//
// Usage and flags: USAGE below (--help).
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
import { prOutcomes } from './pr-outcomes.mjs';
import { WATCH_DAYS } from './post-merge.mjs';
import { marksStage } from './harvest.mjs';
import { hookState } from './handoff.mjs';

// The queue states a ticket is still in progress in: neither finished nor parked.
const IN_PROGRESS = STATES.filter((s) => !FINISHED.includes(s) && s !== 'parked');

// The fewest sessions an arm needs before it is compared, and the fewest tickets (or PRs) with a value
// a guardrail needs on both the arm and the baseline before it counts as measured.
const MIN_SESSIONS = 5;
const MIN_TICKETS = 3;
// The thresholds the earlier defaults used (DEFAULT_PCT 45 in the hook; 50 on a 1M window).
const BASELINE_PCTS = [45, 50];
// A gap between two lines longer than this counts as this much: idle time is not active time.
const IDLE_CAP_MS = 5 * 60 * 1000;
const USAGE = `usage: node handoff-report.mjs [--all] [--root <projects dir>] [--tickets <file>] [--offline] [--json]
  --all        every project folder, not only this repo's primary root's
  --root       a projects folder to read instead of every Claude login's
  --tickets    per-ticket rows (a JSON list: key, branch, prs, state, merged_at, fix_tries,
               parks_by_class, post_merge) to read instead of this repo's batches
  --offline    read no PR from GitHub: only the outcomes already cached count
  --json       the report as JSON
  -h, --help   this usage; reads and writes nothing`;
// The PR guardrails a provisional reading can flag: counts that only grow while a window is open
// (review rounds are settled a day after the merge, so they wait for the final reading).
const PROVISIONAL_BREACHES = ['pr-post-merge', 'follow-up-fixes'];
const CHECKED = ['fix-tries-parks', 'post-merge'];
// The guardrails of a merged PR no ticket is behind (pr-outcomes.mjs), each with the registry margin of
// the ticket guardrail it stands for: reverts and red main as post-merge, a follow-up fix as a defect
// found after the merge, review rounds as review findings.
const PR_CHECKED = {
  'pr-post-merge': { margin: GUARDRAILS['post-merge'].margin.max_rate_ratio, value: (o) => o.post_merge },
  'follow-up-fixes': { margin: GUARDRAILS['post-merge'].margin.max_rate_ratio, value: (o) => o.follow_ups.length },
  'review-rounds': { margin: GUARDRAILS['review-p0-p1'].margin.max_rate_ratio, value: (o) => o.review_rounds },
};
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

const FIRE = /desk handoff: context is at \d+% of a ([\d,]+)-token window(?: \(threshold |, past this worker's threshold of )([\d.]+)%/;
const SMALL_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;
// The oldest version of each family whose default window is 1M, shared with desk-handoff.py.
const DEFAULT_1M_SINCE = JSON.parse(readFileSync(new URL('./model-windows.json', import.meta.url), 'utf8')).default_1m_since;
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
const MERGED = /merged pull request \S*?#(\d+) \((.+)\)/i;

// The PRs and branches one Bash call touched, from its command and what it printed:
//   -> { prs: [{ number, title, head, repo, closes }], pushed: [branch] }
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
  let worker = false;
  let firstInput = null;
  const overheads = [];
  const requests = new Map();
  const times = [];
  const branches = new Map();
  const bash = new Map();
  const calls = new Set();
  let errors = 0;
  let peak = 0;
  const models = new Map();
  const work = { prs: [], pushed: [] };
  for (const { d, raw } of lines) {
    const content = Array.isArray(d.message?.content) ? d.message.content : [];
    if (!worker && marksStage(d)) worker = true;
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
    peak = Math.max(peak, inputOf(r));
    if (r.model) models.set(r.model, (models.get(r.model) ?? 0) + 1);
    if (!seenRequest && resumed) overheads.push(inputOf(r));
    firstInput ??= inputOf(r);
    if (afterBoundary) { overheads.push(inputOf(r)); afterBoundary = false; }
    seenRequest = true;
    const key = r.id ?? `line-${requests.size}`;
    const had = requests.get(key);
    if (had) had.output = Math.max(had.output, r.output);
    else requests.set(key, r);
  }
  // A worker session starts from its briefing, never a .handoffs/ file: its first request is its start-up.
  if (worker && !resumed && firstInput != null) overheads.unshift(firstInput);
  times.sort((a, b) => a - b);
  let active = 0;
  for (let i = 1; i < times.length; i += 1) active += Math.min(times[i] - times[i - 1], IDLE_CAP_MS);
  return {
    id: basename(file, '.jsonl'), project: basename(join(file, '..')), arm, named, resumed_from: resumedFrom,
    fires: fires.size, compactions, resumed, handoffs: compactions + (resumed ? 1 : 0), resume_overheads: overheads,
    usd: [...requests.values()].reduce((s, r) => s + (requestUsd(r)?.total ?? 0), 0),
    unpriced: [...requests.values()].filter((r) => !requestUsd(r)).length,
    active_hours: active / 3_600_000, start: times[0] ?? null, end: times.at(-1) ?? null, branch: [...branches].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    branches: [...branches.keys()], prs: work.prs, pushed: [...new Set(work.pushed)], tool_calls: calls.size, tool_errors: errors,
    peak, model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  };
}

// Whether a model's default window is 1M with no [1m], parsed as desk-handoff.py's default_1m does.
function default1m(model) {
  const parts = String(model ?? '').toLowerCase().replace('[1m]', '').split('-');
  const since = DEFAULT_1M_SINCE[parts.find((p) => p && p !== 'claude' && !/^\d+$/.test(p))];
  const nums = parts.filter((p) => /^\d{1,2}$/.test(p)).map(Number);
  if (!since || !nums.length) return false;
  const [major, minor = 0] = nums;
  return major > since[0] || (major === since[0] && minor >= since[1]);
}

// The arm the hook stamped in a session's state, or null: its `arm` where it recorded one, else the
// §2 rows it cached at the session's first check, on the window the hook gives the session's model
// and peak context. A row of 0 (handoff off) is no arm.
function stampedArm(state, s) {
  if (!state || typeof state !== 'object') return null;
  const a = state.arm;
  if (a && Number(a.pct) > 0 && Number(a.window) > 0) return { pct: Number(a.pct), window: Number(a.window) };
  if (typeof state.pct !== 'number') return null;
  const window = s.peak > SMALL_WINDOW || default1m(state.model ?? s.model) || /\[1m\]/i.test(String(state.model ?? '')) ? LARGE_WINDOW : SMALL_WINDOW;
  const pct = window >= LARGE_WINDOW && typeof state.pct_1m === 'number' ? state.pct_1m : state.pct;
  return pct > 0 ? { pct, window } : null;
}

// Claude Code's project folder name for a directory.
const projectName = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');

// The transcripts to read: in each projects folder, the folders `mine` accepts (every one without it).
function transcriptFiles(roots, mine) {
  const dirs = roots.flatMap((root) => {
    try { return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && (!mine || mine(e.name))).map((e) => join(root, e.name)); } catch { return []; }
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

// The ticket keys a text names by the §4 Ticket key pattern, matched with its case (ignoring it, a
// Jira pattern reads `node-20` and `utf-8` as keys), and, unless the tracker is Jira, the
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
  // A reference naming no repo is this one's; one naming a repo must name this one.
  const same = (r) => !repo || !r || r.toLowerCase() === repo.toLowerCase();
  const prs = s.prs.filter((p) => same(p.repo));
  const branches = [...new Set([...s.branches, ...s.pushed, ...prs.map((p) => p.head)])].filter((b) => b && b !== base && b !== 'HEAD');
  // A PR's closing keywords name its issues as `issue-N`, the work id of a GitHub issue; so, unless
  // the tracker is Jira, does a branch that starts with the issue's number (`fix/850-slug`).
  const issues = tracker === 'jira' ? [] : branches.flatMap((b) => [...b.matchAll(/(?:^|\/)(\d+)(?=-|$)/g)].map((m) => `issue-${m[1]}`));
  const texts = [...branches, ...prs.map((p) => p.title).filter(Boolean), ...prs.flatMap((p) => (p.closes ?? []).filter((c) => same(c.repo)).map((c) => `issue-${c.number}`)), ...issues];
  const numbers = prs.map((p) => p.number).filter((n) => n != null);
  const hit = rows.filter((t) => (t.branch && branches.includes(t.branch)) || (t.prs ?? []).some((n) => numbers.includes(Number(n)))
    // Keys match ignoring case, as scope-precision does: some repos name branches in lower case.
    || (t.key && texts.some((x) => new RegExp(keyPattern(String(t.key)), 'i').test(x))));
  const counted = hit.filter(hasOutcome);
  if (counted.length) return { tickets: counted, why: null, keys: [] };
  if (hit.length) return { tickets: [], why: 'no outcome', keys: hit.map((t) => t.key) };
  if (!prs.length && !branches.length) return { tickets: [], why: 'no pr', keys: [] };
  const keys = keysNamed(texts, { pattern, tracker });
  // No ticket is behind this work, so its PRs are measured themselves: by number, else by head branch.
  const refs = [...new Set(numbers)].map((n) => ({ number: n }));
  const named = new Set(prs.filter((p) => p.number != null).map((p) => p.head));
  // A branch alone names the merged PR from it whose lifetime overlaps this session.
  for (const b of branches) if (!named.has(b)) refs.push({ head: b, from: s.start, to: s.end });
  return { tickets: [], why: keys.length ? 'no ticket' : 'no key', keys, refs };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function armRows(sessions, now) {
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
    const prs = new Map();
    for (const s of list) for (const o of s.map.prs ?? []) prs.set(o.number, o);
    const prRates = Object.fromEntries(Object.entries(PR_CHECKED).map(([g, { value }]) => {
      const vals = [...prs.values()].map(value);
      return [g, { prs: vals.length, rate: mean(vals) }];
    }));
    // The provisional pool: final PRs and those with windows still open, each counted once.
    const pool = new Map(prs);
    for (const s of list) for (const o of s.map.open ?? []) if (!pool.has(o.number)) pool.set(o.number, o);
    const opened = [...pool.values()].filter((o) => !o.final);
    const provisional = {
      prs: pool.size, open: opened.length,
      elapsed_hours: opened.length ? mean(opened.map((o) => Math.min(now - Date.parse(o.merged_at), WATCH_DAYS * 24 * 3_600_000) / 3_600_000)) : null,
      rates: Object.fromEntries(Object.entries(PR_CHECKED).map(([g, { value }]) => [g, mean([...pool.values()].map(value))])),
    };
    const on = (s) => s.map.tickets.length || s.map.prs?.length;
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
      sessions_on_tickets: list.filter((s) => s.map.tickets.length).length, sessions_on_prs: list.filter((s) => s.map.prs?.length).length,
      sessions_without_ticket: list.filter((s) => !on(s)).length, tickets_mapped: mapped.size, prs_mapped: prs.size,
      guardrails: rates, pr_guardrails: prRates, provisional, rework: { tool_calls: calls, tool_errors: errs, rate: calls ? errs / calls : null },
      mapping: { sessions: list.length, mapped: list.filter(on).length,
        ...Object.fromEntries(['no pr', 'no key', 'no ticket', 'no outcome', 'off default', 'no match'].map((w) => [w.replace(' ', '_'), list.filter((s) => s.map.why === w).length])),
        keys: [...new Set(list.filter((s) => s.map.why === 'no ticket').flatMap((s) => s.map.keys))] },
    };
  });
}

// Whether an arm's rate `a` breaches the baseline's `b` at `margin`: above b by more than the margin,
// or above none where the baseline has none.
const ratio = (a, b, margin) => (b === 0 ? a > 0 : a > b * margin);

// Each guardrail of an arm against the baseline: holds, breach, or not measured (with why), the ticket
// guardrails then the PR ones.
function guardrailsAgainst(arm, base) {
  const prs = Object.entries(PR_CHECKED).map(([g, { margin }]) => {
    const a = arm.pr_guardrails[g];
    const b = base.pr_guardrails[g];
    if (a.prs < MIN_TICKETS || b.prs < MIN_TICKETS) return [g, { status: 'not measured', why: `${a.prs} PR(s) on this arm, ${b.prs} on the baseline; needs ${MIN_TICKETS} each` }];
    return [g, { status: ratio(a.rate, b.rate, margin) ? 'breach' : 'holds', why: `${a.rate.toFixed(2)} per PR against ${b.rate.toFixed(2)} (margin ${margin}x)` }];
  });
  return Object.fromEntries([...ticketGuardrails(arm, base), ...prs]);
}
function ticketGuardrails(arm, base) {
  return CHECKED.map((g) => {
    const a = arm.guardrails[g];
    const b = base.guardrails[g];
    const margin = GUARDRAILS[g].margin.max_rate_ratio;
    if (a.tickets < MIN_TICKETS || b.tickets < MIN_TICKETS) {
      return [g, { status: 'not measured', why: `${a.tickets} ticket(s) on this arm, ${b.tickets} on the baseline; needs ${MIN_TICKETS} each` }];
    }
    const breach = ratio(a.rate, b.rate, margin);
    return [g, { status: breach ? 'breach' : 'holds', why: `${a.rate.toFixed(2)} per ticket against ${b.rate.toFixed(2)} (margin ${margin}x)` }];
  });
}

const belowText = (b) => `below start-up cost, so its sessions hand off in a loop: its threshold, ${fmt(b.threshold_tokens)} tokens, is under the ${fmt(b.overhead)}-token mean resume overhead on this window (${b.samples} resume(s))`;

// Per window: the cheapest arm whose guardrails hold, or why there is not enough data.
function recommend(arms) {
  const windows = [...new Set(arms.filter((a) => a.window).map((a) => a.window))].sort((x, y) => x - y);
  return windows.map((window) => {
    const here = arms.filter((a) => a.window === window);
    const counts = Object.fromEntries(here.map((a) => [a.arm, a.sessions]));
    const sum = (k) => here.reduce((x, a) => x + a.mapping[k], 0);
    const mapping = { ...Object.fromEntries(['sessions', 'mapped', 'no_pr', 'no_key', 'no_ticket', 'no_outcome', 'off_default', 'no_match'].map((k) => [k, sum(k)])),
      keys: [...new Set(here.flatMap((a) => a.mapping.keys))] };
    const samples = here.map((a) => ({ arm: a.arm, baseline: BASELINE_PCTS.includes(a.pct), sessions: a.sessions, tickets: a.tickets_mapped, prs: a.prs_mapped }));
    const base = here.filter((a) => BASELINE_PCTS.includes(a.pct)).sort((x, y) => y.sessions - x.sessions)[0];
    // Provisional: each arm with a PR window still open, and a flag where it would be refused on what is
    // seen so far (its reading against the baseline's, each on MIN_TICKETS PRs or more). A flag only:
    // the verdict waits for the windows to close.
    const provisional = here.filter((a) => a.provisional.open).map((a) => {
      const p = a.provisional;
      const b = base?.provisional;
      const flags = a === base || !b || p.prs < MIN_TICKETS || b.prs < MIN_TICKETS ? []
        : PROVISIONAL_BREACHES.filter((g) => ratio(p.rates[g], b.rates[g], PR_CHECKED[g].margin)).map((g) => `${g} ${p.rates[g].toFixed(2)} per PR against `
          + `${b.rates[g].toFixed(2)} on the baseline so far (margin ${PR_CHECKED[g].margin}x; provisional, the verdict waits for the windows to close)`);
      return { arm: a.arm, baseline: a === base, prs: p.prs, open: p.open, elapsed_hours: p.elapsed_hours, rates: p.rates, flags };
    });
    // Start-up cost: the mean resume overhead over every arm on this window. An arm whose threshold, in
    // tokens, is below it hands off before a resumed session has done any work: flagged, never recommended.
    const n = here.reduce((x, a) => x + a.resume_samples, 0);
    const overhead = n ? here.reduce((x, a) => x + (a.resume_overhead_mean ?? 0) * a.resume_samples, 0) / n : null;
    const below = overhead == null ? [] : here.filter((a) => (a.pct / 100) * window < overhead)
      .map((a) => ({ arm: a.arm, threshold_tokens: Math.round((a.pct / 100) * window), overhead: Math.round(overhead), samples: n }));
    const isBelow = (a) => below.some((b) => b.arm === a.arm);
    const startupWhy = (a) => belowText(below.find((b) => b.arm === a.arm));
    const out = { window, row: rowName(window), counts, mapping, samples, provisional, startup: { overhead: overhead == null ? null : Math.round(overhead), samples: n, below } };
    if (!base || base.sessions < MIN_SESSIONS || base.usd_per_active_hour == null) {
      return { ...out, verdict: 'not enough data', why: `the ${BASELINE_PCTS.join('/')}% baseline has ${base?.sessions ?? 0} session(s); needs ${MIN_SESSIONS}` };
    }
    if (base.unpriced) return { ...out, baseline: base.arm, verdict: 'not enough data', why: `the ${base.arm} baseline has ${base.unpriced} request(s) on a model with no price` };
    const others = here.filter((a) => a !== base && a.sessions >= MIN_SESSIONS && a.usd_per_active_hour != null);
    if (!others.length) return { ...out, baseline: base.arm, verdict: 'not enough data', why: `no other arm has ${MIN_SESSIONS} session(s)` };
    const refused = isBelow(base) ? [{ arm: base.arm, why: startupWhy(base) }] : [];
    const eligible = isBelow(base) ? [] : [base];
    for (const a of others) {
      const g = guardrailsAgainst(a, base);
      a.guardrail_status = g;
      // Rework needs no ticket: measured, it can refuse an arm, never make one eligible.
      const rw = a.rework.rate != null && base.rework.rate != null
        ? { status: ratio(a.rework.rate, base.rework.rate, REWORK_MARGIN) ? 'breach' : 'holds',
          why: `${(100 * a.rework.rate).toFixed(1)}% of tool calls errored against ${(100 * base.rework.rate).toFixed(1)}% (margin ${REWORK_MARGIN}x)` }
        : { status: 'not measured', why: 'no tool calls on this arm or the baseline' };
      a.rework_status = rw;
      // An arm is judged on the tickets or the PRs its sessions reached, whichever (or both) is
      // measured on it and the baseline: a breach of either refuses it, and with neither measured it is
      // not recommended on cost alone.
      const family = (names) => names.every((k) => g[k].status !== 'not measured');
      const measured = family(CHECKED) || family(Object.keys(PR_CHECKED));
      // Dollars are compared on complete data only: an unpriced request adds hours but no dollars.
      const bad = [...(isBelow(a) ? [startupWhy(a)] : []), ...(a.unpriced ? [`${a.unpriced} request(s) on a model with no price`] : []),
        ...Object.entries(g).filter(([, v]) => v.status === 'breach' || (!measured && v.status === 'not measured')).map(([k, v]) => `${k} ${v.status}: ${v.why}`),
        ...(rw.status === 'breach' ? [`rework breach: ${rw.why}`] : [])];
      if (bad.length) refused.push({ arm: a.arm, why: bad.join('; ') });
      else eligible.push(a);
    }
    if (!eligible.length) return { ...out, baseline: base.arm, verdict: 'not enough data', refused, why: 'every arm with enough sessions is refused, the baseline below its start-up cost' };
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
    [m.no_outcome, `reached a ticket or PR with no outcome yet: a ticket counts once merged, or done, parked or failed, a PR once its windows close, ${WATCH_DAYS} days after it merged`],
    [m.off_default, 'merged its PRs into another branch than the default: they are not measured'],
    [m.no_match, 'pushed a branch no merged PR from the session\'s time heads: open or merge the PR from the session'],
  ].filter(([n]) => n).map(([n, why]) => `${n} ${why}`);
  return `    saw ${m.sessions} session(s), mapped ${m.mapped} to a ticket or PR with an outcome${rest.length ? `; ${rest.join('; ')}` : ''}`;
}

// A window's provisional reading per arm with a PR window open, and the arms it would refuse so far.
const provisionalText = (r) => (r.provisional.length ? [
  `    provisional, from the elapsed part of open windows (never a recommendation on its own): ${r.provisional.map((x) => `${x.arm}${x.baseline ? ' (baseline)' : ''} `
    + `${x.prs} PR(s), ${x.open} open at ${Math.round(x.elapsed_hours)}h elapsed on average: ${Object.entries(x.rates).map(([g, v]) => `${g} ${v.toFixed(2)}`).join(', ')}`).join('; ')}`,
  ...r.provisional.flatMap((x) => x.flags.map((why) => `    ${x.arm} would be refused on what is seen so far: ${why}`)),
] : []);

// A window's sample per arm against what a decision needs.
const sampleText = (r) => `    sample (an arm and the baseline each need ${MIN_SESSIONS} sessions, and ${MIN_TICKETS} tickets or ${MIN_TICKETS} PRs): ${r.samples.map((x) => `${x.arm}${x.baseline ? ' (baseline)' : ''} `
  + `${x.sessions}/${MIN_SESSIONS} sessions, ${x.tickets}/${MIN_TICKETS} tickets, ${x.prs}/${MIN_TICKETS} PRs`).join('; ')}`;

const fmt = (v, places = 0) => (v == null ? '-' : Number(v).toLocaleString('en-US', { maximumFractionDigits: places }));

function reportText(rep) {
  const head = ['arm', 'sessions', 'on tickets', 'on PRs', 'handoffs/session', 'resume overhead (mean, n)', '$/active hour', 'active hours', ...CHECKED, ...Object.keys(PR_CHECKED), 'rework'];
  const rows = rep.arms.map((a) => [a.arm, a.sessions, a.sessions_on_tickets, a.sessions_on_prs, fmt(a.handoffs_per_session, 2), `${fmt(a.resume_overhead_mean)} (${a.resume_samples})`,
    a.usd_per_active_hour == null ? '-' : `$${a.usd_per_active_hour.toFixed(2)}`, fmt(a.active_hours, 1), ...CHECKED.map((g) => a.guardrail_status?.[g]?.status ?? `${a.guardrails[g].tickets} ticket(s)`),
    ...Object.keys(PR_CHECKED).map((g) => a.guardrail_status?.[g]?.status ?? `${a.pr_guardrails[g].prs} PR(s)`),
    a.rework_status?.status ?? (a.rework.rate == null ? '-' : `${(100 * a.rework.rate).toFixed(1)}%`)]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => `  ${r.map((c, i) => String(c).padEnd(width[i])).join('  ')}`.trimEnd();
  const unpriced = rep.arms.reduce((x, a) => x + a.unpriced, 0);
  return [
    `HANDOFF REPORT (${rep.scope}): ${rep.sessions.length} session(s); dollars are API-equivalent at list prices (worker-cost.mjs MODEL_PRICES); active hours count each gap up to ${IDLE_CAP_MS / 60000} minutes`,
    line(head), ...rows.map(line),
    ...(unpriced ? [`  (${unpriced} request(s) on a model with no price, left out of the dollars)`] : []),
    ...(rep.ticket_note ? [`  (${rep.ticket_note}; guardrails not measured)`] : []),
    `  (PR guardrails: ${rep.pr_read.offline ? 'not read from GitHub (--offline)' : `${rep.pr_read.reads} GitHub quer(ies)`}, ${rep.pr_read.cached} PR(s) from the cache${rep.pr_read.note ? `; ${rep.pr_read.note}` : ''})`,
    `  (${rep.sessions.filter((s) => s.measured_on === 'tickets').length} session(s) reached a ticket with an outcome (merged, or done, parked or failed) and are measured on its guardrails; ${rep.sessions.filter((s) => s.measured_on === 'prs').length} reached no ticket but merged PRs with an outcome and are measured on theirs; ${rep.sessions.filter((s) => s.measured_on === 'session only').length} are measured on the session guardrails alone (handoffs, resume overhead, rework: tool calls that errored), which can refuse an arm but never make one eligible)`,
    'RECOMMENDATION',
    ...(rep.recommendations.length ? rep.recommendations.flatMap((r) => [r.verdict === 'recommend'
      ? `  §2 "${r.row}": ${r.pct} (${r.arm}): ${r.why}${r.refused.length ? `; not ${r.refused.map((x) => `${x.arm} (${x.why})`).join(', ')}` : ''}`
      : `  §2 "${r.row}" (${r.window.toLocaleString('en-US')}-token window): not enough data: ${r.why} (sessions per arm: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')})`,
    sampleText(r),
    ...r.startup.below.map((b) => `    ${b.arm} is ${belowText(b)}: never recommended`),
    ...provisionalText(r),
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
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
  const opt = (k) => { const i = argv.indexOf(k); return i < 0 ? undefined : argv[i + 1]; };
  const now = Date.now();
  let project = null;
  let mine = null;
  if (!argv.includes('--all')) {
    try { project = projectName(E.repoRoot()); }
    catch (e) { console.error(`handoff-report: ${e.message}; pass --all to read every project`); process.exit(2); }
    let worktrees = null;
    try { worktrees = `${projectName(E.worktreesDir())}-`; } catch { /* no worktrees directory: the primary root only */ }
    mine = (name) => name === project || (!!worktrees && name.startsWith(worktrees));
  }
  const roots = opt('--root') ? [opt('--root')] : projectsDirs();
  const stateDir = join(E.deskHome(), 'handoff');
  const sessions = [];
  for (const f of transcriptFiles([...new Set(roots)], mine)) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const s = sessionOf(f, text);
    s.arm ??= stampedArm(hookState(stateDir, s.id), s);
    sessions.push(s);
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
  for (const s of sessions) s.map = mapSession(s, tickets.rows, ctx);
  // A session reaches its ticket where one is behind its work, else its merged PRs, never both: one
  // batched read for every session's PRs, final outcomes cached in the repo's state.
  const offline = argv.includes('--offline');
  const refs = [...new Map(sessions.flatMap((s) => s.map.refs ?? []).map((r) => [r.number != null ? `n${r.number}` : `h${r.head}|${r.from}|${r.to}`, r])).values()];
  const cachePath = read(() => join(E.repoStateOf(E.stateDir()), 'handoff-pr-outcomes.json'));
  const outcomes = prOutcomes(refs, { repo: ctx.repo, base: ctx.base, cachePath, offline, now });
  for (const s of sessions) {
    const found = (s.map.refs ?? []).map(outcomes.of).filter(Boolean);
    s.map.prs = [...new Map(found.filter((o) => o.final).map((o) => [o.number, o])).values()];
    s.map.open = found.filter((o) => o.merged_at && !o.final && !o.off_default && o.post_merge != null);
    if (s.map.prs.length) s.map.why = null;
    else if (found.some((o) => !o.off_default && !o.unmatched)) s.map.why = 'no outcome';
    else if (found.some((o) => o.off_default)) s.map.why = 'off default';
    else if (found.some((o) => o.unmatched)) s.map.why = 'no match';
    s.tickets = s.map.tickets.map((t) => t.key);
    s.prs_measured = s.map.prs.map(({ number, post_merge: pm, follow_ups: fu, review_rounds: rr }) => ({ number, post_merge: pm, follow_ups: fu, review_rounds: rr }));
    s.measured_on = s.tickets.length ? 'tickets' : s.map.prs.length ? 'prs' : 'session only';
    s.unmapped = s.map.why;
  }
  const arms = armRows(sessions, now);
  const rep = {
    scope: project ? `project ${project} and its worktrees'` : 'every project', sessions: sessions.map(({ named, resumed_from, map, ...s }) => s), arms,
    recommendations: recommend(arms), ticket_note: tickets.note,
    pr_read: { offline, reads: outcomes.reads, cached: outcomes.cached, note: outcomes.note ?? (cachePath ? null : 'no repo state, so PR outcomes are not cached') }, guidance: GUIDANCE.map(([title, url]) => ({ title, url })), gap: GAP,
  };
  console.log(argv.includes('--json') ? JSON.stringify(rep, null, 2) : reportText(rep));
}
