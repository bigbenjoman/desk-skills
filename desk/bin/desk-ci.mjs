#!/usr/bin/env node
// Places each job in a repo's GitHub Actions workflows on the self-hosted runner (the desk-runner
// arm64 Linux VM) or a GitHub-hosted one by a written rule, and lints workflows so no job that can
// land on a self-hosted runner receives a secret. Read-only: it never writes a workflow.
//   node desk-ci.mjs classify [<workflow file or directory>...]   default .github/workflows
//   node desk-ci.mjs ci-lint  [<workflow file or directory>...]   exits 1 on any finding
// classify prints `<file>:<line>  <job>  <hosted|self-hosted>  <reason>` per job, the line being
// the one that decided it, then `summary: jobs=<n> hosted=<n> self-hosted=<n>`.
// ci-lint prints `<file>:<line>  <job>  <problem>` per finding, then `summary: findings=<n>`.
//   node desk-ci.mjs measure [--repo owner/name] [--days 90] [--budget 600] [--out <dir>]
// measure reads a window of Actions runs, jobs and pull requests over the GitHub API within a call
// budget, prints what CI cost and how often it held PRs up, and saves the report under .handoffs/.
//   node desk-ci.mjs batch-red [--prs 12,13 | --queue <queue.json>] [--baseline <measure json>] [--repo owner/name]
// batch-red measures an autopilot batch's PRs (default: the queue's finished tickets) the way measure
// does and compares their CI red rate per PR with the newest measure baseline; exit 1 on a rise of
// more than 5 percentage points.
//   node desk-ci.mjs protection snapshot|restore <file>|pin|token [--repo owner/name] [--apply <plan id>]
// protection saves and restores branch protection and rulesets, pins required checks to the GitHub
// Actions app and makes the default workflow token read-only. Every write is gated on config §3
// ci-protection and printed as a plan first.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { permissionOrUnset, queueFile } from './desk-env.mjs';

// ---- a line scanner for workflow YAML ---------------------------------------------------------
// Workflows are block YAML, and every rule here needs the line it fired on, which a YAML parser
// discards. Comments are stripped outside block scalars only: GitHub expands `${{ }}` inside a
// `run: |` body even on a line the shell treats as a comment.

function stripComment(s) {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; continue; }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scan(text) {
  const out = [];
  let blockIndent = -1;
  text.split(/\r?\n/).forEach((raw, i) => {
    const indent = raw.length - raw.trimStart().length;
    const blank = raw.trim() === '';
    if (blockIndent >= 0 && (blank || indent > blockIndent)) {
      out.push({ n: i + 1, indent, text: raw.trim(), blank, scalar: true });
      return;
    }
    blockIndent = -1;
    const t = stripComment(raw).trimEnd().trim();
    const line = { n: i + 1, indent, text: t, blank: t === '', scalar: false };
    out.push(line);
    if (/:\s*[|>][-+0-9]*$/.test(t)) blockIndent = indent + (t.startsWith('- ') ? 2 : 0);
  });
  return out;
}

const KEY = /^(?:-\s+)?("[^"]*"|'[^']*'|[^\s:#'"][^:#]*?)\s*:(?:\s+(.*))?$/;
const keyOf = (l) => {
  if (l.scalar || l.blank) return null;
  const m = KEY.exec(l.text);
  return m ? { key: m[1].replace(/^["']|["']$/g, ''), value: (m[2] ?? '').trim() } : null;
};

// The lines under lines[i]: everything indented deeper, plus a sequence written at the key's own
// indent (`steps:` followed by `- uses:` in the same column).
function blockAfter(lines, i) {
  const k = lines[i].indent;
  const seq = keyOf(lines[i])?.value === '';
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.blank || l.scalar || l.indent > k || (seq && l.indent === k && /^-(\s|$)/.test(l.text))) j++;
    else break;
  }
  while (j > i + 1 && lines[j - 1].blank) j--;
  return lines.slice(i + 1, j);
}

// The direct keys of a mapping block: { key: { line, value, block } }.
function mapping(block) {
  const out = {};
  const first = block.find((l) => !l.blank && !l.scalar);
  if (!first) return out;
  block.forEach((l, idx) => {
    if (l.indent !== first.indent || /^-(\s|$)/.test(l.text)) return;
    const kv = keyOf(l);
    if (kv && !(kv.key in out)) out[kv.key] = { line: l, value: kv.value, block: blockAfter(block, idx) };
  });
  return out;
}

export function parseWorkflow(text) {
  const lines = scan(text);
  const top = {};
  lines.forEach((l, idx) => {
    if (l.indent !== 0) return;
    const kv = keyOf(l);
    if (kv && !(kv.key in top)) top[kv.key] = { line: l, value: kv.value, block: blockAfter(lines, idx) };
  });
  const jobs = Object.entries(top.jobs ? mapping(top.jobs.block) : {}).map(([id, j]) => ({
    id, line: j.line, lines: [j.line, ...j.block], keys: mapping(j.block),
  }));
  return { lines, env: top.env, permissions: top.permissions, jobs };
}

// ---- the rules --------------------------------------------------------------------------------

const all = (k) => (k ? [k.line, ...k.block] : []);
const textOf = (k) => (k ? [k.value, ...k.block.map((l) => l.text)].join('\n') : '');

// Every secret but GITHUB_TOKEN a set of lines hands over, one hit per line.
function secretHits(lines, why = '') {
  const hits = [];
  for (const l of lines) {
    if (l.blank) continue;
    const names = [...l.text.matchAll(/\bsecrets\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
      .filter((s) => s.toUpperCase() !== 'GITHUB_TOKEN');
    if (/\bsecrets\s*\[/.test(l.text)) names.push('secrets[…]');
    if (/\btoJSON\s*\(\s*secrets\s*\)/i.test(l.text)) names.push('toJSON(secrets)');
    if (/^secrets\s*:\s*inherit$/.test(l.text)) names.push('secrets: inherit');
    if (names.length) hits.push({ line: l, kind: 'secret', why: `secret ${[...new Set(names)].join(', ')}${why}` });
  }
  return hits;
}

function idTokenHits(job, wf) {
  const own = job.keys.permissions;
  const perms = own ?? wf.permissions;
  const why = own ? '' : ' (inherited workflow-level permissions)';
  for (const l of all(perms)) {
    if (/\bid-token\s*:\s*write\b/.test(l.text)) return [{ line: l, kind: 'id-token', why: `id-token: write${why}` }];
    if (/^permissions\s*:\s*write-all$/.test(l.text)) return [{ line: l, kind: 'id-token', why: `permissions: write-all grants id-token${why}` }];
  }
  return [];
}

const environmentHits = (job) => (job.keys.environment
  ? [{ line: job.keys.environment.line, kind: 'environment', why: `environment ${textOf(job.keys.environment).trim().split('\n')[0] || ''}`.trim() }]
  : []);

const STAGING_URL = [
  /https?:\/\/[^\s'"]*\b(staging|preview)\b[^\s'"]*/i,
  /\b[\w.-]+\.vercel\.app\b/i,
  /\b[A-Z0-9_]*(STAGING|PREVIEW)[A-Z0-9_]*_URL\b/i,
  /\b(vars|env|secrets)\.[A-Z0-9_]*(STAGING|PREVIEW)[A-Z0-9_]*/i,
  /\bdeployment_status\.(target_url|environment_url)\b/,
];
function stagingHits(lines) {
  for (const l of lines) {
    const m = !l.blank && STAGING_URL.map((re) => re.exec(l.text)).find(Boolean);
    if (m) return [{ line: l, kind: 'staging', why: `staging or preview URL ${m[0]}` }];
  }
  return [];
}

// Actions and CLIs that exist to talk to an outside service. A download over curl counts too: the
// self-hosted VM's network is not GitHub's, so anything leaving it is placed hosted until reviewed.
const SERVICE_ACTION = /^(codecov|vercel|amondnet\/vercel-action|slackapi|rtcamp\/action-slack-notify|getsentry|chromaui|netlify|cloudflare|aws-actions|google-github-actions|azure|docker\/login-action|browserstack|saucelabs|percy|snyk|sonarsource|datadog|supabase|neondatabase|superfly|railwayapp)\b/i;
const SERVICE_CLI = /(^|[;&|(]\s*|^run:\s*|^-\s*run:\s*|\b(npx|bunx|dlx|exec)\s+)(vercel|netlify|flyctl|gcloud|aws|wrangler|heroku|railway|doctl|supabase|neonctl|sentry-cli|codecov)\s+[a-z-]/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|([\w-]+\.)*github\.com|([\w-]+\.)*githubusercontent\.com|ghcr\.io)$/i;
function serviceHits(job) {
  for (const l of job.lines) {
    if (l.blank) continue;
    const uses = /^(?:-\s+)?uses\s*:\s*['"]?([^'"\s@]+)/.exec(l.text);
    if (uses && SERVICE_ACTION.test(uses[1])) return [{ line: l, kind: 'service', why: `third-party service action ${uses[1]}` }];
    const cli = SERVICE_CLI.exec(l.text);
    if (cli) return [{ line: l, kind: 'service', why: `third-party service CLI ${cli[3]}` }];
    const fetch = /\b(curl|wget)\b.*?https?:\/\/([^/\s'"$:]+)/.exec(l.text);
    if (fetch && !LOCAL_HOST.test(fetch[2])) return [{ line: l, kind: 'service', why: `outside host ${fetch[2]} (${fetch[1]})` }];
  }
  return [];
}

// Images published for amd64 only, which the arm64 runner VM cannot run natively.
const AMD64_ONLY = [/^(docker\.io\/)?postgis\/postgis(:|$)/i, /^mcr\.microsoft\.com\/mssql\/server(:|$)/i];
function imageHits(job) {
  const where = [job.keys.container, job.keys.services].filter(Boolean);
  for (const k of where) {
    for (const l of all(k)) {
      const img = /^(?:-\s+)?(?:image|container)\s*:\s*['"]?([^'"\s]+)/.exec(l.text);
      if (img && AMD64_ONLY.some((re) => re.test(img[1]))) return [{ line: l, kind: 'image', why: `image ${img[1]} has no arm64 build` }];
      if (/--platform[=\s]+linux\/amd64\b/.test(l.text)) return [{ line: l, kind: 'image', why: 'container pinned to linux/amd64' }];
    }
  }
  return [];
}

const PARITY = /\b(vercel[\s_-]*(parity|build)|production[\s_-]*build|prod[\s_-]*build|x64[\s_-]*parity|build[\s_-]*parity)\b/i;
function parityHits(job) {
  const name = job.keys.name;
  if (name && PARITY.test(name.value)) return [{ line: name.line, kind: 'parity', why: `production x64 build parity (name: ${name.value})` }];
  if (PARITY.test(job.id)) return [{ line: job.line, kind: 'parity', why: `production x64 build parity (job ${job.id})` }];
  const vb = job.lines.find((l) => !l.blank && /\bvercel\s+build\b/.test(l.text));
  return vb ? [{ line: vb, kind: 'parity', why: 'production x64 build parity (vercel build)' }] : [];
}

const inheritedEnv = (wf) => secretHits(all(wf.env), ' (inherited workflow-level env)');

// A YAML alias pulls in a block defined elsewhere (a secret env, an id-token permission) that the
// line rules above never see, so it is treated as handing over whatever it could.
const ALIAS = /(?:^|:\s+|-\s+|[[,{]\s*)\*([A-Za-z0-9_-]+)\s*(?:$|[,\]}])/;
function aliasHits(lines, why = '') {
  for (const l of lines) {
    const m = !l.blank && !l.scalar && ALIAS.exec(l.text);
    if (m) return [{ line: l, kind: 'alias', why: `YAML alias *${m[1]}${why}, which may carry a secret or permission not checked here` }];
  }
  return [];
}
const inheritedAliases = (wf) => aliasHits([...all(wf.env), ...all(wf.permissions)], ' (workflow level)');

export function hostedReasons(job, wf) {
  return [
    ...secretHits(job.lines), ...inheritedEnv(wf),
    ...environmentHits(job), ...idTokenHits(job, wf),
    ...stagingHits([...job.lines, ...all(wf.env)]),
    ...serviceHits(job), ...imageHits(job), ...parityHits(job),
    ...aliasHits(job.lines), ...inheritedAliases(wf),
  ];
}

export function classify(text) {
  const wf = parseWorkflow(text);
  return wf.jobs.map((job) => {
    const reasons = hostedReasons(job, wf);
    if (reasons.length) return { job: job.id, placement: 'hosted', line: reasons[0].line.n, why: reasons[0].why, also: reasons.slice(1) };
    const uses = job.keys.uses;
    if (uses && !job.keys['runs-on']) {
      return uses.value.startsWith('./')
        ? { job: job.id, placement: 'self-hosted', line: uses.line.n, why: `calls ${uses.value}: no hosted trigger here; its own jobs are placed in that file`, also: [] }
        : { job: job.id, placement: 'hosted', line: uses.line.n, why: `calls ${uses.value}, a workflow outside this repo that cannot be read here`, also: [] };
    }
    const ro = job.keys['runs-on'];
    return { job: job.id, placement: 'self-hosted', line: job.line.n, why: `no hosted trigger${ro ? ` (runs-on today: ${textOf(ro).replace(/\s+/g, ' ').trim()})` : ''}`, also: [] };
  });
}

// ---- runs-on ----------------------------------------------------------------------------------

const HOSTED_LABEL = /^(ubuntu|macos|windows)-[a-z0-9.-]+$/i;
const ACTOR = (op) => `(?:github\\.actor\\s*${op}\\s*'dependabot\\[bot\\]'|'dependabot\\[bot\\]'\\s*${op}\\s*github\\.actor)`;
const DEPENDABOT_EQ = new RegExp(`${ACTOR('==')}\\s*&&\\s*'([^']*)'`);
const DEPENDABOT_NE = new RegExp(`${ACTOR('!=')}\\s*&&\\s*'[^']*'\\s*\\|\\|\\s*'([^']*)'`);

// What runs-on gives Dependabot: 'hosted', 'not-hosted' (the branch exists but picks anything
// else, or cannot be read), or 'missing'.
function dependabotBranch(text) {
  const m = DEPENDABOT_EQ.exec(text) ?? DEPENDABOT_NE.exec(text);
  if (m) { const t = tokens(m[1]); return t.length && t.every((c) => HOSTED_LABEL.test(c)) ? 'hosted' : 'not-hosted'; }
  return new RegExp(ACTOR('[!=]=')).test(text) ? 'not-hosted' : 'missing';
}

// The values matrix.<key> can take, or null when the matrix is computed and cannot be read here.
function matrixValues(job, key) {
  const strat = job.keys.strategy;
  if (!strat) return null;
  const vals = [];
  const lines = strat.block;
  let found = false;
  const flow = new RegExp(`[{,]\\s*${key}\\s*:\\s*(\\[[^\\]]*\\]|[^,}]+)`, 'g');
  lines.forEach((l, idx) => {
    if (l.scalar) return;
    for (const m of l.text.matchAll(flow)) { found = true; vals.push(m[1].trim()); }
    const kv = keyOf(l);
    if (!kv || kv.key !== key) return;
    found = true;
    if (kv.value) vals.push(kv.value);
    for (const b of blockAfter(lines, idx)) if (!b.blank) vals.push(b.text.replace(/^-\s*/, ''));
  });
  if (!found || vals.some((v) => v.includes('${{'))) return null;
  return vals;
}

const tokens = (s) => s.split(/[\s,[\]"'{}]+/).filter((t) => t && t !== '-' && !/^[\w-]+:$/.test(t));

// Whether runs-on can resolve to anything other than a GitHub-hosted image label: a self-hosted
// label, a custom label, a runner group, or a value read from somewhere this file does not fix.
export function canResolveSelfHosted(job) {
  const ro = job.keys['runs-on'];
  if (!ro) return false;
  const text = textOf(ro);
  if (/(^|\n)\s*group\s*:/.test(text)) return true;
  const cands = [];
  let unknown = false;
  const rest = text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    const e = expr
      .replace(/[\w.[\]-]+\s*[!=]=\s*'[^']*'/g, '')
      .replace(/'[^']*'\s*[!=]=\s*[\w.[\]-]+/g, '');
    for (const m of e.matchAll(/'([^']*)'/g)) cands.push(...tokens(m[1]));
    for (const m of e.replace(/'[^']*'/g, '').matchAll(/\b(matrix|inputs|vars|env|needs|steps|github|jobs)\.([\w-]+)/g)) {
      const vals = m[1] === 'matrix' ? matrixValues(job, m[2]) : null;
      if (vals) cands.push(...vals.flatMap(tokens)); else unknown = true;
    }
    return ' ';
  });
  cands.push(...tokens(rest.replace(/(^|\n)\s*labels\s*:/g, ' ')));
  return unknown || cands.some((c) => !HOSTED_LABEL.test(c));
}

export function lint(text) {
  const wf = parseWorkflow(text);
  const out = [];
  for (const job of wf.jobs) {
    if (!canResolveSelfHosted(job)) continue;
    const ro = job.keys['runs-on'];
    const hits = [...secretHits(job.lines), ...inheritedEnv(wf), ...environmentHits(job), ...idTokenHits(job, wf),
      ...aliasHits(job.lines), ...inheritedAliases(wf)];
    for (const h of hits) out.push({ job: job.id, line: h.line.n, problem: `can run self-hosted but receives ${h.why}` });
    const dependabot = dependabotBranch(textOf(ro));
    if (dependabot === 'missing') {
      out.push({ job: job.id, line: ro.line.n, problem: "can run self-hosted but runs-on has no github.actor == 'dependabot[bot]' branch to a hosted runner" });
    } else if (dependabot === 'not-hosted') {
      out.push({ job: job.id, line: ro.line.n, problem: "can run self-hosted and its github.actor == 'dependabot[bot]' branch does not pick a GitHub-hosted runner" });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---- measure: the numbers -----------------------------------------------------------------------
// Runs, jobs and pull requests are the REST API's own shapes. A run's jobs (`filter=all`) carry
// every attempt, so a red attempt a re-run later turned green is still seen.

const RED = new Set(['failure', 'timed_out', 'startup_failure']);
const DECIDED = new Set(['success', ...RED]);
// A cancelled or approval-waiting attempt is neither red nor a pass.
const PASSING = new Set(['success', 'skipped', 'neutral']);
const ms = (s) => (s ? Date.parse(s) : NaN);
const finite = (xs) => xs.filter(Number.isFinite);

// Linear interpolation between closest ranks, so the median of an even count is the mean of the two.
export function quantile(xs, q) {
  const v = finite(xs).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
}

export const isSelfHosted = (job) => (job.labels ?? []).includes('self-hosted')
  || (!!job.runner_group_name && job.runner_group_name !== 'GitHub Actions');

// A GitHub-hosted job stops at 6 hours, so a longer span (a stuck job's cancelled record) counts as
// 360 minutes. A self-hosted job has no such limit and is counted as reported.
export const HOSTED_CAP = 360;
const rawMinutes = (job) => { const d = ms(job.completed_at) - ms(job.started_at); return Number.isFinite(d) && d > 0 ? Math.ceil(d / 60000) : 0; };
export const isCapped = (job) => !isSelfHosted(job) && rawMinutes(job) > HOSTED_CAP;

// GitHub bills each job in whole minutes, rounded up; a job that never ran bills nothing.
export function jobMinutes(job) {
  return isCapped(job) ? HOSTED_CAP : rawMinutes(job);
}

// Hosted minutes bill at the runner OS's multiplier.
const osMultiplier = (job) => { const l = (job.labels ?? []).join(' '); return /macos/i.test(l) ? 10 : /windows/i.test(l) ? 2 : 1; };

// Red and re-run runs are what the PR figures turn on, so their jobs are read first; the rest are
// sampled per workflow, red-or-green and month (by run creation date), and scaled back up within it,
// so each month's minutes come from that month's own runs. A workflow is its file (its id, else its
// path without the `@ref` a run may carry): Dependabot names every run after its update, so grouping
// by name would make each run a workflow of its own.
const mustRead = (run) => RED.has(run.conclusion) || (run.run_attempt ?? 1) > 1;
const pathOf = (run) => (run.path ?? '').replace(/@.*$/, '');
const workflowOf = (run) => (run.workflow_id != null ? `id:${run.workflow_id}` : pathOf(run) || run.name || '?');
const spanMinutes = (run) => { const d = ms(run.updated_at) - ms(run.run_started_at ?? run.created_at); return Number.isFinite(d) && d > 0 ? d / 60000 : 0; };
// A run that did not pass and lasted past the hosted cap may hold a stuck job (a job GitHub stops at
// 6 h fails or is cancelled). It is read before anything else and stands for itself alone, as does
// any run read with a capped job, so a capped job's 360 minutes are never multiplied by a stratum's
// weight.
const isLong = (run) => !PASSING.has(run.conclusion) && spanMinutes(run) > HOSTED_CAP;
const stratum = (run, solo = new Set()) => `${workflowOf(run)}\u0000${isLong(run) || solo.has(run.id) ? `solo:${run.id}` : mustRead(run) ? 'red' : 'rest'}\u0000${(run.created_at ?? '').slice(0, 7)}`;

// The fewest runs of a stratum read when the budget allows, so no month rests on one or two runs.
const MIN_READS = 3;

export function pickSample(runs, n) {
  if (n >= runs.length) return runs.slice();
  const groupOf = (rs) => { const g = new Map(); for (const r of rs) { const k = stratum(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); } return g; };
  const picked = new Set();
  const take = (r) => { if (picked.size < n) picked.add(r); };
  for (const r of runs) if (isLong(r)) take(r);
  const groups = groupOf(runs.filter((r) => !isLong(r)));
  const keys = [...groups.keys()].sort((a, b) => Number(a.includes('\u0000rest\u0000')) - Number(b.includes('\u0000rest\u0000')));
  for (const k of keys) take(groups.get(k)[0]);
  for (const r of runs) if (mustRead(r)) take(r);
  if (picked.size >= n) return runs.filter((r) => picked.has(r));

  // The rest goes where it most narrows each month's minutes: a stratum's need is its runs times the
  // spread of their lengths (run start to last update), over its month's total length (Neyman
  // allocation, per month). Every stratum first gets MIN_READS, then each read goes to the stratum it
  // helps most, so the reads end up in proportion to need.
  const monthLen = new Map();
  for (const r of runs) { const mo = (r.created_at ?? '').slice(0, 7); monthLen.set(mo, (monthLen.get(mo) ?? 0) + spanMinutes(r)); }
  const strata = keys.filter((k) => k.includes('\u0000rest\u0000')).map((k) => {
    const rs = groups.get(k);
    const lens = rs.map(spanMinutes);
    const avg = lens.reduce((t, x) => t + x, 0) / rs.length;
    const sd = Math.sqrt(lens.reduce((t, x) => t + (x - avg) ** 2, 0) / rs.length);
    return { rs, need: (rs.length * sd) / (monthLen.get(k.split('\u0000')[2]) || 1), q: rs.filter((r) => picked.has(r)).length };
  });
  if (!strata.some((s) => s.need > 0)) for (const s of strata) s.need = s.rs.length;
  let left = n - picked.size;
  for (let round = 1; round <= MIN_READS && left > 0; round++) {
    for (const s of [...strata].sort((a, b) => b.need - a.need)) if (left > 0 && s.q < Math.min(round, s.rs.length)) { s.q++; left--; }
  }
  // Moving a stratum from q to q + 1 reads takes need² × (1/q − 1/(q + 1)) off the summed variance.
  const gain = (s) => (s.q >= s.rs.length ? -1 : s.need ** 2 / (s.q * (s.q + 1)));
  while (left > 0) {
    let best = null;
    for (const s of strata) if (gain(s) >= 0 && (!best || gain(s) > gain(best))) best = s;
    if (!best) break;
    best.q++;
    left--;
  }
  // Within a stratum, the runs read are spread evenly over its runs ordered by length, so short and
  // long ones are both read.
  for (const s of strata) {
    const unread = s.rs.filter((r) => !picked.has(r)).sort((a, b) => spanMinutes(a) - spanMinutes(b));
    const q = s.q - (s.rs.length - unread.length);
    for (let i = 0; i < q; i++) picked.add(unread[Math.floor(((i + 0.5) * unread.length) / q)]);
  }
  return runs.filter((r) => picked.has(r));
}

// Each read run stands for the runs of its stratum that were not read.
export function sampleWeights(runs, readIds, solo = new Set()) {
  const total = new Map();
  const read = new Map();
  for (const r of runs) {
    const k = stratum(r, solo);
    total.set(k, (total.get(k) ?? 0) + 1);
    if (readIds.has(r.id)) read.set(k, (read.get(k) ?? 0) + 1);
  }
  const w = new Map();
  for (const r of runs) if (readIds.has(r.id)) w.set(r.id, total.get(stratum(r, solo)) / read.get(stratum(r, solo)));
  return w;
}

// A run is red only as GitHub shows it. The latest attempt takes the run's own conclusion, which a
// continue-on-error job's failure never turns red. The API keeps no conclusion for an earlier
// attempt, so that is read from its jobs: any failed job counts, except one that has failed in a run
// GitHub concluded success. Today's required checks are not applied to older runs.
const jobKey = (run, job) => `${workflowOf(run)}\u0000${job.name}`;

function nonBlockingJobs(runs, jobs) {
  const out = new Set();
  for (const r of runs) {
    if (!PASSING.has(r.conclusion)) continue;
    const last = r.run_attempt ?? 1;
    for (const j of jobs.get(r.id) ?? []) if ((j.run_attempt ?? 1) === last && RED.has(j.conclusion)) out.add(jobKey(r, j));
  }
  return out;
}

// One record per attempt of a run. Without its jobs only the latest attempt is known.
function attemptsOf(run, jobs, estimate, nonBlocking = new Set()) {
  const blocks = (j) => !nonBlocking.has(jobKey(run, j));
  const latest = run.run_attempt ?? 1;
  const byAttempt = new Map();
  for (const j of jobs ?? []) {
    const a = j.run_attempt ?? 1;
    if (!byAttempt.has(a)) byAttempt.set(a, []);
    byAttempt.get(a).push(j);
  }
  if (!byAttempt.size) {
    return [{ run, attempt: latest, sha: run.head_sha, created: ms(run.run_started_at ?? run.created_at), completed: ms(run.updated_at),
      red: RED.has(run.conclusion), decided: DECIDED.has(run.conclusion), passed: PASSING.has(run.conclusion),
      done: run.status === 'completed', minutes: estimate, jobs: [], failing: [] }];
  }
  return [...byAttempt.entries()].sort((a, b) => a[0] - b[0]).map(([attempt, js]) => {
    const failed = js.filter((j) => RED.has(j.conclusion));
    let red;
    let passed;
    let decided;
    if (attempt === latest) {
      red = RED.has(run.conclusion);
      passed = PASSING.has(run.conclusion);
      decided = DECIDED.has(run.conclusion);
    } else {
      red = failed.some(blocks);
      passed = !red && js.every((j) => PASSING.has(j.conclusion) || RED.has(j.conclusion));
      decided = red || js.some((j) => j.conclusion === 'success');
    }
    return {
      run, attempt, sha: run.head_sha,
      created: Math.min(...finite(js.map((j) => ms(j.created_at ?? j.started_at)))),
      completed: Math.max(...finite(js.map((j) => ms(j.completed_at)))),
      red, decided, passed,
      done: js.every((j) => j.status === 'completed'),
      minutes: js.reduce((t, j) => t + jobMinutes(j) * (isSelfHosted(j) ? 1 : osMultiplier(j)), 0), jobs: js,
      failing: !red ? [] : failed.some(blocks) ? failed.filter(blocks) : failed,
    };
  });
}

// The pull request a run tested: the one GitHub names, else the open PR whose head branch it ran on.
function prOfRun(run, prs, byNumber) {
  for (const p of run.pull_requests ?? []) if (byNumber.has(p.number)) return byNumber.get(p.number);
  const t = ms(run.created_at);
  return prs.find((p) => p.head?.ref === run.head_branch
    && (!run.head_repository || !p.head?.repo || p.head.repo.full_name === run.head_repository.full_name)
    && ms(p.created_at) <= t && t <= (ms(p.merged_at ?? p.closed_at) || Infinity)) ?? null;
}

// A PR's CI history in push order. A head commit is green at the first moment every run on it has an
// attempt that passed. A round trip runs from the first red to the next green, by re-run or by a new push.
export function prTimeline(atts) {
  const shas = new Map();
  for (const a of atts) { if (!shas.has(a.sha)) shas.set(a.sha, []); shas.get(a.sha).push(a); }
  const order = [...shas.values()].map((as) => {
    const passes = new Map();
    for (const a of as) {
      if (!passes.has(a.run.id)) passes.set(a.run.id, null);
      const p = passes.get(a.run.id);
      if (a.done && a.passed && (!p || a.completed < p.completed)) passes.set(a.run.id, a);
    }
    const pass = [...passes.values()];
    const reds = as.filter((a) => a.red).map((a) => a.completed);
    return {
      first: Math.min(...as.map((a) => a.created)),
      greenAt: pass.every(Boolean) && pass.some((a) => a.decided) ? Math.max(...pass.map((a) => a.completed)) : null,
      redAt: reds.length ? Math.min(...reds) : null,
    };
  }).sort((a, b) => a.first - b.first);
  const trips = [];
  let open = null;
  for (const s of order) {
    if (s.redAt !== null && open === null) open = s.redAt;
    if (s.greenAt !== null && open !== null && s.greenAt >= open) {
      const end = s.greenAt;
      const minutes = atts.filter((a) => a.created >= open && a.created <= end).reduce((t, a) => t + a.minutes, 0);
      trips.push({ start: open, end, minutes });
      open = null;
    }
  }
  const greens = order.map((s) => s.greenAt).filter((g) => g !== null);
  const start = Math.min(...atts.map((a) => a.created));
  return { red: order.some((s) => s.redAt !== null), trips, unresolved: open !== null, timeToGreen: greens.length ? Math.min(...greens) - start : null };
}

export function measure({ runs: listed, jobs = new Map(), prs = [], since, until, coveredSince = since }) {
  const runs = listed.filter((r) => r.status === 'completed');
  const readIds = new Set(runs.filter((r) => jobs.has(r.id)).map((r) => r.id));
  const nonBlocking = nonBlockingJobs(runs, jobs);
  const solo = new Set([...readIds].filter((id) => jobs.get(id).some(isCapped)));
  const weight = sampleWeights(runs, readIds, solo);
  // A workflow is shown by its runs' name when they share one, else by its file.
  const names = new Map();
  const paths = new Map();
  for (const r of runs) {
    const k = workflowOf(r);
    if (!names.has(k)) names.set(k, new Set());
    names.get(k).add(r.name ?? pathOf(r) ?? k);
    if (pathOf(r)) paths.set(k, pathOf(r));
  }
  const label = (k) => (names.get(k).size === 1 ? [...names.get(k)][0] : paths.get(k) ?? k);

  const runMin = new Map();
  for (const r of runs) {
    if (!readIds.has(r.id)) continue;
    let billed = 0;
    let self = 0;
    for (const j of jobs.get(r.id)) { if (isSelfHosted(j)) self += jobMinutes(j); else billed += jobMinutes(j) * osMultiplier(j); }
    runMin.set(r.id, { billed, self });
  }
  const mean = new Map();
  const byId = new Map(runs.map((r) => [r.id, r]));
  for (const [id, m] of runMin) {
    const k = stratum(byId.get(id), solo);
    const s = mean.get(k) ?? { n: 0, m: 0 };
    s.n++; s.m += m.billed + m.self;
    mean.set(k, s);
  }
  const estimate = (r) => { const s = mean.get(stratum(r, solo)); return s ? s.m / s.n : 0; };

  const workflows = new Map();
  const jobRows = new Map();
  const months = new Map();
  const month = (key) => { if (!months.has(key)) months.set(key, { month: key, billed: 0, self: 0, merged: 0 }); return months.get(key); };
  const attemptsByRun = new Map();
  let unmeasured = 0;
  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const prOf = new Map(runs.map((r) => [r.id, prOfRun(r, prs, byNumber)]));
  for (const r of runs) {
    const name = workflowOf(r);
    if (!workflows.has(name)) workflows.set(name, { workflow: label(name), runs: 0, attempts: 0, decided: 0, failed: 0, billed: 0, self: 0, firstFailing: {} });
    const w = workflows.get(name);
    const atts = attemptsOf(r, jobs.get(r.id), estimate(r), nonBlocking);
    attemptsByRun.set(r.id, atts);
    w.runs++;
    for (const a of atts) {
      w.attempts++;
      if (a.decided) w.decided++;
      if (!a.red) continue;
      w.failed++;
      if (!readIds.has(r.id)) continue;
      const first = a.failing.slice().sort((x, y) => ms(x.completed_at) - ms(y.completed_at))[0];
      const label = first?.name ?? '(no job ran)';
      w.firstFailing[label] = (w.firstFailing[label] ?? 0) + 1;
    }
    if (!readIds.has(r.id)) { if (!mean.has(stratum(r, solo))) unmeasured++; continue; }
    const k = weight.get(r.id);
    const m = runMin.get(r.id);
    w.billed += m.billed * k;
    w.self += m.self * k;
    const mo = month(r.created_at.slice(0, 7));
    mo.billed += m.billed * k;
    mo.self += m.self * k;
    for (const j of jobs.get(r.id)) {
      const key = `${name}\u0000${j.name}`;
      if (!jobRows.has(key)) jobRows.set(key, { workflow: label(name), job: j.name, runs: 0, billed: 0, self: 0 });
      const row = jobRows.get(key);
      row.runs += k;
      if (isSelfHosted(j)) row.self += jobMinutes(j) * k; else row.billed += jobMinutes(j) * osMultiplier(j) * k;
    }
  }
  for (const p of prs) {
    const d = p.merged_at?.slice(0, 10);
    if (d && d >= coveredSince && d <= until) month(d.slice(0, 7)).merged++;
  }

  const prAttempts = new Map();
  for (const r of runs) {
    const pr = prOf.get(r.id);
    if (!pr) continue;
    if (!prAttempts.has(pr.number)) prAttempts.set(pr.number, []);
    prAttempts.get(pr.number).push(...attemptsByRun.get(r.id));
  }
  const perPr = [...prAttempts.entries()].map(([number, atts]) => ({ number, ...prTimeline(atts) }));
  const trips = perPr.flatMap((p) => p.trips);

  const queue = { hosted: [], self: [] };
  for (const id of readIds) {
    for (const j of jobs.get(id)) {
      if (j.conclusion === 'skipped') continue;
      const q = (ms(j.started_at) - ms(j.created_at)) / 1000;
      if (Number.isFinite(q) && q >= 0) (isSelfHosted(j) ? queue.self : queue.hosted).push(q);
    }
  }
  const capped = [];
  for (const id of readIds) {
    for (const j of jobs.get(id)) {
      if (isCapped(j)) capped.push({ workflow: label(workflowOf(byId.get(id))), job: j.name, run: id, attempt: j.run_attempt ?? 1, reported: rawMinutes(j), counted: HOSTED_CAP });
    }
  }
  const spread = (xs) => ({ n: xs.length, median: quantile(xs, 0.5), p90: quantile(xs, 0.9) });
  const wfs = [...workflows.values()].sort((a, b) => b.billed + b.self - (a.billed + a.self));

  return {
    since, until, coveredSince, capped: capped.sort((a, b) => b.reported - a.reported),
    runs: { listed: listed.length, completed: runs.length, read: readIds.size, mustRead: runs.filter(mustRead).length,
      mustReadRead: runs.filter((r) => mustRead(r) && readIds.has(r.id)).length, unmeasured },
    totals: {
      billed: wfs.reduce((t, w) => t + w.billed, 0), self: wfs.reduce((t, w) => t + w.self, 0),
      attempts: wfs.reduce((t, w) => t + w.attempts, 0), decided: wfs.reduce((t, w) => t + w.decided, 0),
      failed: wfs.reduce((t, w) => t + w.failed, 0),
    },
    workflows: wfs.map((w) => ({ ...w, failureRate: w.decided ? w.failed / w.decided : null })),
    jobs: [...jobRows.values()].sort((a, b) => b.billed + b.self - (a.billed + a.self)),
    prs: {
      withCi: perPr.length, red: perPr.filter((p) => p.red).length, redNumbers: perPr.filter((p) => p.red).map((p) => p.number).sort((a, b) => a - b),
      roundTrips: { n: trips.length, unresolved: perPr.filter((p) => p.unresolved).length,
        medianMinutes: quantile(trips.map((t) => t.minutes), 0.5), medianWait: quantile(trips.map((t) => t.end - t.start), 0.5) },
      timeToGreen: spread(perPr.map((p) => p.timeToGreen).filter((x) => x !== null)),
    },
    queue: { hosted: spread(queue.hosted), self: spread(queue.self) },
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({ ...m, perMerged: m.merged ? (m.billed + m.self) / m.merged : null })),
  };
}

// ---- measure: the API, within a call budget -----------------------------------------------------

const day = (s, n = 0) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const chunks = (since, until, size = 30) => {
  const out = [];
  for (let from = since; from <= until; from = day(from, size)) { const to = day(from, size - 1); out.push({ from, to: to < until ? to : until }); }
  return out;
};

function ghApi(path) {
  const out = execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

// Every job of a run, every attempt included, or null when a page could not be read (the budget ran
// out, or the call failed).
function readJobs(get, repo, id) {
  const js = [];
  for (let p = 1; ; p++) {
    let page;
    try { page = get(`repos/${repo}/actions/runs/${id}/jobs?filter=all&per_page=100&page=${p}`); } catch { return null; }
    if (!page) return null;
    js.push(...page.jobs);
    if (page.jobs.length < 100 || js.length >= page.total_count) return js;
  }
}

// Every call is counted against the smaller of the budget and what the rate limit can spare above a
// reserve (a tenth of the limit, at least 100). The limit is re-read every 100 calls, since other
// sessions spend it too. Lists stop at a share of the allowance so job reads are never starved; what
// is left over reads jobs, sampled when it cannot cover every run.
export function collect({ repo, since, until, budget = 600, api = ghApi }) {
  const rate = () => api('rate_limit').resources.core;
  const start = rate();
  const reserve = Math.max(100, Math.ceil(start.limit * 0.1));
  let allowance = Math.min(budget, start.remaining - reserve);
  if (allowance < 3) {
    throw new Error(`GitHub API rate limit too low to measure: ${start.remaining} of ${start.limit} left, ${reserve} kept in reserve; it resets at ${new Date(start.reset * 1000).toISOString()}`);
  }
  let calls = 0;
  let rechecks = 0;
  const notes = [];
  const get = (path, share = 1) => {
    if (calls >= Math.min(Math.ceil(allowance * share), allowance)) return null;
    if (calls && calls % 100 === 0 && rechecks < calls / 100) {
      rechecks++;
      const now = rate();
      allowance = Math.min(allowance, calls + now.remaining - reserve);
      if (calls >= allowance) { notes.push(`stopped at ${calls} calls: the rate limit fell to ${now.remaining}, the reserve is ${reserve}`); return null; }
    }
    calls++;
    return api(path);
  };

  const runs = new Map();
  let coveredSince = since;
  let truncated = false;
  const todo = chunks(since, until).reverse();
  const runsPath = (c, p) => `repos/${repo}/actions/runs?created=${c.from}..${c.to}&per_page=100&page=${p}`;
  list: while (todo.length) {
    const c = todo.shift();
    const first = get(runsPath(c, 1), 0.5);
    if (!first) { truncated = true; break; }
    if (first.total_count > 1000 && c.from < c.to) {
      const mid = day(c.from, Math.floor(daysBetween(c.from, c.to) / 2));
      todo.unshift({ from: day(mid, 1), to: c.to }, { from: c.from, to: mid });
      continue;
    }
    if (first.total_count > 1000) notes.push(`${c.from} had ${first.total_count} runs; the API lists 1000 per query, so the rest are not counted`);
    for (const r of first.workflow_runs) runs.set(r.id, r);
    const pages = Math.ceil(Math.min(first.total_count, 1000) / 100);
    for (let p = 2; p <= pages; p++) {
      const next = get(runsPath(c, p), 0.5);
      if (!next) { truncated = true; break list; }
      for (const r of next.workflow_runs) runs.set(r.id, r);
    }
    coveredSince = c.from;
  }
  if (truncated) {
    const oldest = [...runs.values()].map((r) => r.created_at.slice(0, 10)).sort()[0];
    coveredSince = oldest ? day(oldest, 1) : until;
    for (const [id, r] of runs) if (r.created_at.slice(0, 10) < coveredSince) runs.delete(id);
    notes.push(`the run list stopped at the call budget: the window covers ${coveredSince} to ${until}, not ${since}`);
  }

  const prs = [];
  for (let p = 1; ; p++) {
    const page = get(`repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${p}`, 0.65);
    if (!page) { notes.push('the pull request list stopped at the call budget: PR figures cover only the most recently updated'); break; }
    prs.push(...page.filter((x) => x.updated_at.slice(0, 10) >= coveredSince));
    if (page.length < 100 || page[page.length - 1].updated_at.slice(0, 10) < coveredSince) break;
  }

  const completed = [...runs.values()].filter((r) => r.status === 'completed');
  const jobs = new Map();
  const sample = pickSample(completed, Math.max(0, allowance - calls));
  for (const r of [...sample.filter(isLong), ...sample.filter((x) => !isLong(x) && mustRead(x)), ...sample.filter((x) => !isLong(x) && !mustRead(x))]) {
    const js = readJobs(get, repo, r.id);
    if (js) jobs.set(r.id, js);
    else if (calls >= allowance) break;
  }
  return { repo, since, until, coveredSince, runs: [...runs.values()], jobs, prs, calls, budget, allowance, reserve, rate: start, notes };
}

// ---- measure: the report ------------------------------------------------------------------------

const int = (x) => (x == null ? 'n/a' : Math.round(x).toLocaleString('en-US'));
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : 'n/a');
const dur = (v) => (v == null ? 'n/a' : v < 3600000 ? `${Math.round(v / 60000)}m` : `${(v / 3600000).toFixed(1)}h`);
const secs = (v) => (v == null ? 'n/a' : v < 120 ? `${Math.round(v)}s` : `${(v / 60).toFixed(1)}m`);
const cell = (s) => String(s).replace(/\|/g, '\\|');

export function report(m, c, measuredAt) {
  const sampled = m.runs.read < m.runs.completed;
  const est = sampled ? ' (est.)' : '';
  const days = daysBetween(m.coveredSince, m.until) + 1;
  const out = [
    `# CI measure: ${c.repo}, ${m.coveredSince} to ${m.until} (${days} days)`,
    '',
    `- measured ${measuredAt}`,
    `- API calls: ${c.calls} of an allowance of ${c.allowance} (budget ${c.budget}; rate limit ${c.rate.remaining} of ${c.rate.limit} left at the start, ${c.reserve} kept in reserve)`,
    sampled
      ? `- sampled: jobs read for ${m.runs.read} of ${m.runs.completed} completed runs, including ${m.runs.mustReadRead} of the ${m.runs.mustRead} red or re-run ones; minutes are scaled per workflow, red-or-green and month (a run that may hold a stuck job stands for itself alone), and marked (est.)`
      : `- not sampled: jobs read for all ${m.runs.completed} completed runs`,
    ...(m.runs.listed > m.runs.completed ? [`- ${m.runs.listed - m.runs.completed} runs still in progress are left out`] : []),
    ...(m.runs.unmeasured ? [`- ${m.runs.unmeasured} runs are in a workflow, red-or-green and month with no job read, so carry no minutes`] : []),
    ...(m.capped.length ? [`- ${m.capped.length} hosted jobs reported more than 6 h and count as ${HOSTED_CAP} min each (listed under Capped jobs)`] : []),
    ...c.notes.map((n) => `- ${n}`),
    '',
    '## Totals',
    '',
    `- billed minutes${est}: ${int(m.totals.billed)} (each job rounded up to the minute; macOS ×10, Windows ×2)`,
    `- self-hosted minutes${est}: ${int(m.totals.self)}`,
    '- red as GitHub shows it: by the run\'s conclusion, and for an earlier attempt of a re-run any failed job that is not continue-on-error; today\'s required checks are not applied to older runs',
    `- attempts: ${m.totals.attempts}, red ${m.totals.failed} (${pct(m.totals.failed, m.totals.decided)} of ${m.totals.decided} that passed or failed)`,
    '',
    '## By workflow',
    '',
    `| workflow | runs | attempts | failure rate | billed min${est} | self-hosted min${est} | first failing job |`,
    '|---|---|---|---|---|---|---|',
    ...m.workflows.map((w) => `| ${cell(w.workflow)} | ${w.runs} | ${w.attempts} | ${pct(w.failed, w.decided)} | ${int(w.billed)} | ${int(w.self)} | ${cell(Object.entries(w.firstFailing).sort((a, b) => b[1] - a[1]).map(([j, n]) => `${j} ×${n}`).join(', ') || '-')} |`),
    '',
    '## By job',
    '',
    `| workflow | job | runs${est} | billed min${est} | self-hosted min${est} |`,
    '|---|---|---|---|---|',
    ...m.jobs.map((j) => `| ${cell(j.workflow)} | ${cell(j.job)} | ${int(j.runs)} | ${int(j.billed)} | ${int(j.self)} |`),
    '',
    '## Pull requests',
    '',
    '| measure | value |',
    '|---|---|',
    `| PRs with CI in the window | ${m.prs.withCi} |`,
    `| CI red rate per PR | ${m.prs.red} of ${m.prs.withCi} (${pct(m.prs.red, m.prs.withCi)}) went red at least once |`,
    `| red-to-fix round trips | ${m.prs.roundTrips.n}: median ${int(m.prs.roundTrips.medianMinutes)} CI min${est} and ${dur(m.prs.roundTrips.medianWait)} from red to green; ${m.prs.roundTrips.unresolved} PRs left red |`,
    `| PR time to green (first CI run to first green head) | median ${dur(m.prs.timeToGreen.median)}, p90 ${dur(m.prs.timeToGreen.p90)} over ${m.prs.timeToGreen.n} PRs |`,
    `| queue time, hosted | median ${secs(m.queue.hosted.median)}, p90 ${secs(m.queue.hosted.p90)} over ${m.queue.hosted.n} jobs |`,
    `| queue time, self-hosted | median ${secs(m.queue.self.median)}, p90 ${secs(m.queue.self.p90)} over ${m.queue.self.n} jobs |`,
    '',
    '## Minutes per merged PR by month',
    '',
    `| month | billed min${est} | self-hosted min${est} | merged PRs | CI min per merged PR${est} |`,
    '|---|---|---|---|---|',
    ...m.months.map((x) => `| ${x.month} | ${int(x.billed)} | ${int(x.self)} | ${x.merged} | ${int(x.perMerged)} |`),
    '',
    ...(m.capped.length ? [
      '## Capped jobs',
      '',
      `A GitHub-hosted job stops at 6 h, so each of these counts as ${HOSTED_CAP} min (before the OS multiplier). Self-hosted jobs are not capped.`,
      '',
      '| workflow | job | run | attempt | reported min | counted min |',
      '|---|---|---|---|---|---|',
      ...m.capped.map((x) => `| ${cell(x.workflow)} | ${cell(x.job)} | ${x.run} | ${x.attempt} | ${int(x.reported)} | ${x.counted} |`),
      '',
    ] : []),
  ];
  return out.join('\n');
}

const flagsOf = (args) => {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(args[i]);
    if (!m) throw new Error(`unexpected argument: ${args[i]}`);
    f[m[1]] = m[2] ?? args[++i];
  }
  return f;
};

function originRepo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`origin is not a GitHub remote (${url}); pass --repo owner/name`);
  return m[1];
}

// The main checkout, even from a worktree: the parent of the shared git directory.
const mainCheckout = () => dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim());

function runMeasure(args) {
  const f = flagsOf(args);
  const days = Number(f.days ?? 90);
  const budget = Number(f.budget ?? 600);
  if (!(days >= 1) || !(budget >= 1)) throw new Error('--days and --budget take a positive number');
  const repo = f.repo ?? originRepo();
  const now = new Date();
  const until = now.toISOString().slice(0, 10);
  const since = day(until, -(days - 1));
  const dir = f.out ?? join(mainCheckout(), '.handoffs');
  mkdirSync(dir, { recursive: true });
  const c = collect({ repo, since, until, budget });
  const m = measure({ ...c });
  const text = report(m, c, now.toISOString());
  console.log(text);
  const base = join(dir, `${until}-ci-measure-${repo.replace('/', '__')}`);
  writeFileSync(`${base}.md`, text);
  writeFileSync(`${base}.json`, `${JSON.stringify({ repo, measuredAt: now.toISOString(), calls: c.calls, budget, allowance: c.allowance, notes: c.notes, ...m }, null, 2)}\n`);
  console.log(`saved: ${base}.md and ${base}.json`);
}

// ---- batch-red: an autopilot batch's red rate against the measured baseline ---------------------
// The batch's PRs measured exactly as `measure` measures a window (same red, same PR matching), so
// the two rates compare. A run's earlier attempts are known only from its jobs, so jobs are read for
// every re-run run and for no other. The baseline is the newest `measure` JSON for the repo.

export const RED_RISE_PP = 5;

export function collectBatch({ repo, prs: numbers, api = ghApi }) {
  const prs = [];
  const runs = new Map();
  let calls = 0;
  const get = (path) => { calls++; return api(path); };
  for (const n of numbers) {
    const p = get(`repos/${repo}/pulls/${n}`);
    prs.push(p);
    for (let page = 1; ; page++) {
      const r = get(`repos/${repo}/actions/runs?branch=${enc(p.head.ref)}&per_page=100&page=${page}`);
      for (const x of r.workflow_runs) runs.set(x.id, x);
      if (r.workflow_runs.length < 100) break;
    }
  }
  const jobs = new Map();
  for (const r of runs.values()) {
    if (r.status !== 'completed' || (r.run_attempt ?? 1) < 2) continue;
    // Without its jobs a re-run's earlier attempts are unknown, which would undercount red.
    const js = readJobs(get, repo, r.id);
    if (!js) throw new Error(`batch-red: could not read the jobs of run ${r.id}; the red rate would undercount`);
    jobs.set(r.id, js);
  }
  return { prs, runs: [...runs.values()], jobs, calls };
}

export function batchRed(c) {
  const dates = c.runs.map((r) => (r.created_at ?? '').slice(0, 10)).filter(Boolean).sort();
  const m = measure({ runs: c.runs, jobs: c.jobs, prs: c.prs, since: dates[0] ?? '', until: dates[dates.length - 1] ?? '' });
  return { prs: c.prs.length, withCi: m.prs.withCi, red: m.prs.red, redNumbers: m.prs.redNumbers };
}

// The newest `<date>-ci-measure-<owner>__<name>.json` in a directory, or null.
export function newestBaseline(dir, repo) {
  const tail = `-ci-measure-${repo.replace('/', '__')}.json`;
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith(tail)).sort(); } catch { return null; }
  return names.length ? join(dir, names[names.length - 1]) : null;
}

// -> { rate, base, deltaPp, flag: 'rise' | 'ok' | 'no-baseline' | 'no-ci' }
export function compareRed(batch, baseline) {
  const rate = batch.withCi ? batch.red / batch.withCi : null;
  const base = baseline?.prs?.withCi ? baseline.prs.red / baseline.prs.withCi : null;
  if (rate === null) return { rate, base, deltaPp: null, flag: 'no-ci' };
  if (base === null) return { rate, base, deltaPp: null, flag: 'no-baseline' };
  const deltaPp = Math.round((rate - base) * 1000) / 10;
  return { rate, base, deltaPp, flag: deltaPp > RED_RISE_PP ? 'rise' : 'ok' };
}

export function batchReport(batch, cmp, baselineFile, baseline) {
  const sign = (x) => (x > 0 ? `+${x}` : `${x}`);
  return [
    `batch: ${batch.red} of ${batch.withCi} PRs with CI went red at least once (${pct(batch.red, batch.withCi)}); ${batch.prs} PRs read${batch.redNumbers?.length ? `; red: ${batch.redNumbers.map((n) => `#${n}`).join(' ')}` : ''}`,
    baseline
      ? `baseline: ${baseline.prs.red} of ${baseline.prs.withCi} (${pct(baseline.prs.red, baseline.prs.withCi)}), ${baseline.coveredSince} to ${baseline.until}, from ${baselineFile}`
      : 'baseline: none — run `desk-ci.mjs measure` to record one',
    cmp.flag === 'rise' ? `RED RATE ROSE: ${sign(cmp.deltaPp)} pp against the baseline, more than ${RED_RISE_PP} pp`
      : cmp.flag === 'ok' ? `change: ${sign(cmp.deltaPp)} pp against the baseline, within ${RED_RISE_PP} pp`
        : cmp.flag === 'no-ci' ? 'change: n/a — no PR in the batch has a completed CI run' : 'change: n/a — no baseline',
    `summary: red=${batch.red} with_ci=${batch.withCi} rate=${pct(batch.red, batch.withCi)} baseline=${cmp.base === null ? 'none' : `${Math.round(cmp.base * 1000) / 10}%`} delta_pp=${cmp.deltaPp ?? 'n/a'} flag=${cmp.flag}`,
  ].join('\n');
}

// The PRs of a batch: every ticket in the queue whose worker finished with one.
export const queuePrs = (q) => [...new Set(Object.values(q?.tickets ?? {}).map((t) => Number(t.result?.pr)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);

function runBatchRed(args) {
  const f = flagsOf(args);
  const repo = f.repo ?? originRepo();
  const numbers = f.prs
    ? String(f.prs).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
    : queuePrs(JSON.parse(readFileSync(f.queue ?? queueFile(), 'utf8')));
  if (!numbers.length) throw new Error('batch-red: no PRs (pass --prs 12,13, or --queue <queue.json> with finished tickets)');
  const file = f.baseline ?? newestBaseline(join(mainCheckout(), '.handoffs'), repo);
  const baseline = file ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const batch = batchRed(collectBatch({ repo, prs: numbers }));
  const cmp = compareRed(batch, baseline);
  console.log(batchReport(batch, cmp, file, baseline));
  return cmp.flag === 'rise' ? 1 : 0;
}

// ---- protection: snapshot, restore, pin, token --------------------------------------------------
// Every write is computed as a plan first and printed in full; it runs only when `--apply <id>`
// names that exact plan, re-computed from live state, so what runs is what was shown. Each command
// takes an injectable `api(path, { method, body })` that throws an Error carrying `.status`.

export const ACTIONS_SLUG = 'github-actions';
const enc = encodeURIComponent;
const sortBy = (xs, f) => [...xs].sort((a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0));

// JSON with object keys sorted, so two reads of the same state compare equal.
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

function ghCall(path, { method = 'GET', body } = {}) {
  const args = ['api', '-H', 'Accept: application/vnd.github+json', '-X', method, path];
  if (body !== undefined) args.push('--input', '-');
  try {
    const out = execFileSync('gh', args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: body === undefined ? undefined : JSON.stringify(body),
      stdio: [body === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e) {
    const stderr = String(e.stderr ?? e.message).trim();
    const err = new Error(`gh api -X ${method} ${path}: ${stderr}`);
    err.status = Number(/HTTP (\d{3})/.exec(stderr)?.[1]) || null;
    try { err.body = JSON.parse(e.stdout); } catch { /* no JSON body */ }
    throw err;
  }
}

// Reading protection needs admin rights. GitHub answers 404 both for "Branch not protected" and for
// a token that cannot see it, so only that exact message reads as unprotected: a snapshot that
// recorded an unreadable protection as none would make restore delete it.
function readClassic(api, repo, branch) {
  try { return api(`repos/${repo}/branches/${enc(branch)}/protection`); } catch (e) {
    if (e.status === 404 && /branch not protected/i.test(e.body?.message ?? e.message)) return null;
    throw new Error(`cannot read ${branch}'s branch protection (it needs admin rights on ${repo}): ${e.message}`);
  }
}

function readBranch(api, repo, branch) {
  try { api(`repos/${repo}/branches/${enc(branch)}`); } catch (e) { if (e.status === 404) return { exists: false }; throw e; }
  return { exists: true, classic: readClassic(api, repo, branch), rules: api(`repos/${repo}/rules/branches/${enc(branch)}?per_page=100`) ?? [] };
}

// Only the repo's own rulesets can be restored from here; an organisation's are listed by name.
function readRulesets(api, repo) {
  const list = api(`repos/${repo}/rulesets?includes_parents=false&per_page=100`) ?? [];
  if (list.length >= 100) throw new Error(`${repo} has 100 or more rulesets; reading past the first page is not supported`);
  return list.filter((r) => (r.source_type ?? 'Repository') === 'Repository').map((r) => api(`repos/${repo}/rulesets/${r.id}`));
}

// The check runs on a ref, with the app that produced each.
function checkRunsOn(api, repo, ref) {
  return (api(`repos/${repo}/commits/${enc(ref)}/check-runs?per_page=100`)?.check_runs ?? [])
    .map((c) => ({ name: c.name, appId: c.app?.id ?? null, appSlug: c.app?.slug ?? null, sha: c.head_sha }));
}

// The GitHub Actions app id, read from a real check run: the default branch's head, else the latest
// completed Actions run's commit.
export function readChecks(api, repo, branch) {
  let runs = checkRunsOn(api, repo, branch);
  if (!runs.some((c) => c.appSlug === ACTIONS_SLUG)) {
    const sha = api(`repos/${repo}/actions/runs?status=completed&per_page=1`)?.workflow_runs?.[0]?.head_sha;
    if (sha) runs = [...runs, ...checkRunsOn(api, repo, sha)];
  }
  const actions = runs.find((c) => c.appSlug === ACTIONS_SLUG);
  return { runs, actionsAppId: actions?.appId ?? null, actionsNames: new Set(runs.filter((c) => c.appSlug === ACTIONS_SLUG).map((c) => c.name)) };
}

// Each required check on a branch, wherever it is required, with the app allowed to satisfy it.
export function requiredChecks(branch, rulesets = [], apps = new Map()) {
  if (!branch?.exists) return [];
  const name = (id) => rulesets.find((r) => r.id === id)?.name;
  const label = (id) => (id == null ? 'any app' : `app ${id}${apps.get(id) ? ` (${apps.get(id)})` : ''}`);
  const out = [];
  const rsc = branch.classic?.required_status_checks;
  const classic = rsc ? (rsc.checks ?? (rsc.contexts ?? []).map((context) => ({ context, app_id: null }))) : [];
  for (const c of classic) out.push({ context: c.context, appId: c.app_id ?? null, source: label(c.app_id ?? null), via: 'branch protection' });
  for (const r of branch.rules ?? []) {
    if (r.type !== 'required_status_checks') continue;
    const via = `${r.ruleset_source_type === 'Organization' ? 'organisation ' : ''}ruleset ${name(r.ruleset_id) ? `"${name(r.ruleset_id)}" ` : ''}#${r.ruleset_id}`;
    for (const c of r.parameters?.required_status_checks ?? []) out.push({ context: c.context, appId: c.integration_id ?? null, source: label(c.integration_id ?? null), via, rulesetId: r.ruleset_id, org: r.ruleset_source_type === 'Organization' });
  }
  return out;
}

export function snapshot({ repo, branches, api = ghCall, takenAt = new Date().toISOString() }) {
  const def = api(`repos/${repo}`).default_branch;
  const names = [...new Set(branches?.length ? branches : [def, 'production'])];
  const checks = readChecks(api, repo, def);
  const apps = new Map(checks.runs.filter((c) => c.appId != null).map((c) => [c.appId, c.appSlug]));
  const rulesets = readRulesets(api, repo);
  const out = {
    kind: 'desk-ci protection snapshot', version: 1, repo, takenAt, defaultBranch: def,
    actionsAppId: checks.actionsAppId, actionsChecks: [...checks.actionsNames].sort(), branches: {}, rulesets,
  };
  for (const b of names) {
    const st = readBranch(api, repo, b);
    out.branches[b] = st.exists ? { ...st, requiredChecks: requiredChecks(st, rulesets, apps) } : st;
  }
  return out;
}

// Classic protection in the shape PUT takes, which is also the form compared. GET reports a check
// any app may satisfy as `app_id: null`, while PUT reads an omitted app_id as "the app that last
// sent it", so "any" is written as -1, which GitHub stores as null again.
const anyApp = (id) => (id == null || id === -1 ? -1 : id);
const logins = (o) => ({
  users: (o?.users ?? []).map((u) => u.login ?? u).sort(),
  teams: (o?.teams ?? []).map((t) => t.slug ?? t).sort(),
  apps: (o?.apps ?? []).map((a) => a.slug ?? a).sort(),
});
const on = (x) => !!(x?.enabled ?? x);
export function classicBody(p) {
  const rsc = p.required_status_checks;
  const rpr = p.required_pull_request_reviews;
  return {
    required_status_checks: rsc ? {
      strict: !!rsc.strict,
      checks: sortBy((rsc.checks ?? (rsc.contexts ?? []).map((context) => ({ context }))).map((c) => ({ context: c.context, app_id: anyApp(c.app_id) })), (c) => c.context),
    } : null,
    enforce_admins: on(p.enforce_admins),
    required_pull_request_reviews: rpr ? {
      dismiss_stale_reviews: !!rpr.dismiss_stale_reviews,
      require_code_owner_reviews: !!rpr.require_code_owner_reviews,
      required_approving_review_count: rpr.required_approving_review_count ?? 0,
      require_last_push_approval: !!rpr.require_last_push_approval,
      ...(rpr.dismissal_restrictions ? { dismissal_restrictions: logins(rpr.dismissal_restrictions) } : {}),
      ...(rpr.bypass_pull_request_allowances ? { bypass_pull_request_allowances: logins(rpr.bypass_pull_request_allowances) } : {}),
    } : null,
    restrictions: p.restrictions ? logins(p.restrictions) : null,
    required_linear_history: on(p.required_linear_history),
    allow_force_pushes: on(p.allow_force_pushes),
    allow_deletions: on(p.allow_deletions),
    block_creations: on(p.block_creations),
    required_conversation_resolution: on(p.required_conversation_resolution),
    lock_branch: on(p.lock_branch),
    allow_fork_syncing: on(p.allow_fork_syncing),
  };
}
const classicForm = (p) => (p ? { ...classicBody(p), required_signatures: on(p.required_signatures) } : null);

export function rulesetBody(r) {
  return {
    name: r.name,
    target: r.target ?? 'branch',
    enforcement: r.enforcement,
    bypass_actors: sortBy((r.bypass_actors ?? []).map((a) => ({ actor_id: a.actor_id ?? null, actor_type: a.actor_type, bypass_mode: a.bypass_mode })), (a) => `${a.actor_type}:${a.actor_id}`),
    conditions: r.conditions ?? {},
    rules: sortBy((r.rules ?? []).map((x) => ({ type: x.type, ...(x.parameters ? { parameters: x.parameters } : {}) })), (x) => x.type),
  };
}

// Where two snapshots differ, by branch and by ruleset name: an empty list is a match.
export function compareSnapshots(want, got) {
  const diffs = [];
  const keys = (a, b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => stable(a?.[k]) !== stable(b?.[k]));
  for (const [b, w] of Object.entries(want.branches)) {
    const g = got.branches[b];
    if (!w.exists) continue;
    if (!g?.exists) { diffs.push(`branch ${b}: no longer exists`); continue; }
    const wf = classicForm(w.classic);
    const gf = classicForm(g.classic);
    if (!wf !== !gf) diffs.push(`branch ${b}: protection is ${gf ? 'set' : 'off'}, the snapshot has it ${wf ? 'set' : 'off'}`);
    else if (wf && stable(wf) !== stable(gf)) diffs.push(`branch ${b}: protection differs in ${keys(wf, gf).join(', ')}`);
  }
  const byName = (rs) => new Map(rs.map((r) => [r.name, rulesetBody(r)]));
  const w = byName(want.rulesets);
  const g = byName(got.rulesets);
  for (const [n, body] of w) {
    if (!g.has(n)) diffs.push(`ruleset "${n}": missing`);
    else if (stable(body) !== stable(g.get(n))) diffs.push(`ruleset "${n}": differs in ${keys(body, g.get(n)).join(', ')}`);
  }
  for (const n of g.keys()) if (!w.has(n)) diffs.push(`ruleset "${n}": not in the snapshot`);
  return diffs;
}

// The writes that put `snap` back, against the live state `cur` (a snapshot taken now).
export function restorePlan(snap, cur) {
  const writes = [];
  const notes = [];
  const repo = snap.repo;
  for (const [b, s] of Object.entries(snap.branches)) {
    if (!s.exists) continue;
    const c = cur.branches[b] ?? { exists: false };
    if (!c.exists) { notes.push(`branch ${b} no longer exists: its protection cannot be restored`); continue; }
    const path = `repos/${repo}/branches/${enc(b)}/protection`;
    if (!s.classic && c.classic) writes.push({ method: 'DELETE', path });
    if (s.classic && stable(classicBody(s.classic)) !== stable(c.classic ? classicBody(c.classic) : null)) writes.push({ method: 'PUT', path, body: classicBody(s.classic) });
    if (s.classic && on(s.classic.required_signatures) !== on(c.classic?.required_signatures)) {
      writes.push({ method: on(s.classic.required_signatures) ? 'POST' : 'DELETE', path: `${path}/required_signatures` });
    }
  }
  const live = new Map(cur.rulesets.map((r) => [r.id, r]));
  const claimed = new Set();
  for (const r of snap.rulesets) {
    const match = live.get(r.id) ?? cur.rulesets.find((x) => x.name === r.name && !claimed.has(x.id));
    const body = rulesetBody(r);
    if (!match) { writes.push({ method: 'POST', path: `repos/${repo}/rulesets`, body }); continue; }
    claimed.add(match.id);
    if (stable(body) !== stable(rulesetBody(match))) writes.push({ method: 'PUT', path: `repos/${repo}/rulesets/${match.id}`, body });
  }
  for (const r of cur.rulesets) if (!claimed.has(r.id)) writes.push({ method: 'DELETE', path: `repos/${repo}/rulesets/${r.id}`, name: r.name });
  return { writes, notes };
}

// ---- a committed file that rewrites protection ----
// A repo whose CI rewrites its own protection from a committed file undoes a pin on its next run.
// A JSON file is read for each required check it writes; any other file that calls the protection or
// rulesets endpoint must name the Actions app id itself, or name a JSON file that is checked here.
// The REST path (an expression such as `${{ github.repository }}` may sit inside it) with a method or
// body flag near it, or an Octokit method that writes protection (actions/github-script).
const PROTECTION_CALL = /branches\/.{0,160}?\/protection\b|\/rulesets\b/;
const WRITE_VERB = /\b(PUT|POST|PATCH)\b|--input\b|(^|\s)-[fFd]\b|--(raw-)?field\b|--data(-raw|-binary)?\b|--method\b/;
export const OCTOKIT_WRITE = /\b(updateBranchProtection|updateStatusCheckProtection|setStatusCheckContexts|addStatusCheckContexts|(create|update)(Repo|Org)Ruleset)\b/;

function jsonChecks(v, out = []) {
  if (Array.isArray(v)) { v.forEach((x) => jsonChecks(x, out)); return out; }
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v)) {
    if (k === 'required_status_checks' && Array.isArray(x)) for (const c of x) out.push({ context: c.context, id: c.integration_id ?? null, field: 'integration_id' });
    else if (k === 'required_status_checks' && x && typeof x === 'object') {
      for (const c of x.checks ?? []) out.push({ context: c.context, id: c.app_id ?? null, field: 'app_id' });
      for (const c of x.contexts ?? []) out.push({ context: c, id: null, field: 'app_id', bare: true });
    } else jsonChecks(x, out);
  }
  return out;
}

// files: [{ path, text }]. -> [{ path, line, change }], one per file that does not carry the pin.
export function protectionFiles(files, actionsAppId) {
  const out = [];
  const jsonWriters = new Set();
  for (const f of files.filter((x) => /\.json$/i.test(x.path))) {
    let parsed;
    try { parsed = JSON.parse(f.text); } catch { continue; }
    const checks = jsonChecks(parsed);
    if (!checks.length) continue;
    jsonWriters.add(f.path);
    const unpinned = checks.filter((c) => c.bare || c.id !== actionsAppId);
    if (!unpinned.length) continue;
    const line = f.text.split('\n').findIndex((l) => l.includes('required_status_checks')) + 1;
    const bare = unpinned.some((c) => c.bare);
    out.push({
      path: f.path, line,
      change: `${bare ? 'replace "contexts" with "checks" and ' : ''}set "${unpinned[0].field}": ${actionsAppId} on ${unpinned.map((c) => c.context).join(', ')}`,
    });
  }
  const pin = new RegExp(`(app_id|integration_id)\\D{0,8}${actionsAppId}\\b`);
  for (const f of files.filter((x) => !/\.json$/i.test(x.path))) {
    const lines = f.text.split('\n');
    // The call and its method or body flag, on the same line or within three of it.
    const at = lines.findIndex((l, i) => OCTOKIT_WRITE.test(l) || (PROTECTION_CALL.test(l) && lines.slice(Math.max(0, i - 3), i + 4).some((x) => WRITE_VERB.test(x))));
    if (at < 0) continue;
    if (actionsAppId != null && pin.test(f.text) && !/\bcontexts\b/.test(f.text)) continue;
    if ([...jsonWriters].some((p) => f.text.includes(p) || f.text.includes(basename(p)))) continue;
    out.push({ path: f.path, line: at + 1, change: `the protection write here must pass app_id ${actionsAppId} for each required check (checks[][app_id]; integration_id in a ruleset), with no "contexts"` });
  }
  return out;
}

// The writes that make every required check on the snapshot's branches accept only GitHub Actions.
// Only a check any app may satisfy, and that an Actions check run carries, is repointed: one no
// Actions run carries is `left` (pinning it would block every merge), and one already bound to
// another app is `other` (repointing it would let a PR's own workflow satisfy it). Either keeps the
// pin from reporting success, since that check does not accept only GitHub Actions.
export function pinPlan(cur, { actionsAppId, actionsNames, files = [] }) {
  if (actionsAppId == null) throw new Error(`no check run from GitHub Actions found on ${cur.repo}: the app id cannot be read, so nothing can be pinned`);
  const repo = cur.repo;
  const writes = [];
  const left = [];
  const other = [];
  const pinned = [];
  const rulesetIds = new Set();
  for (const [b, st] of Object.entries(cur.branches)) {
    if (!st.exists) continue;
    for (const c of st.requiredChecks) {
      if (c.appId === actionsAppId) continue;
      if (c.appId != null) { other.push(`${b}: ${c.context} (${c.via}) accepts only ${c.source}, not GitHub Actions; it is left as it is`); continue; }
      if (c.org) { left.push(`${b}: ${c.context} (${c.via}, ${c.source}): set at the organisation; pin it there`); continue; }
      if (c.rulesetId != null) rulesetIds.add(c.rulesetId);
      if (actionsNames.has(c.context)) pinned.push(`${b}: ${c.context} (${c.via}): ${c.source} -> app ${actionsAppId} (${ACTIONS_SLUG})`);
      else left.push(`${b}: ${c.context} (${c.via}, ${c.source}): no GitHub Actions check run of that name was found, so it is left as it is`);
    }
    const rsc = st.classic?.required_status_checks;
    if (!rsc) continue;
    const before = classicBody(st.classic).required_status_checks;
    const after = { strict: before.strict, checks: before.checks.map((c) => (c.app_id === -1 && actionsNames.has(c.context) ? { ...c, app_id: actionsAppId } : c)) };
    if (stable(after) !== stable(before)) writes.push({ method: 'PATCH', path: `repos/${repo}/branches/${enc(b)}/protection/required_status_checks`, body: after });
  }
  for (const r of cur.rulesets.filter((x) => rulesetIds.has(x.id))) {
    const body = rulesetBody(r);
    const next = { ...body, rules: body.rules.map((x) => (x.type !== 'required_status_checks' ? x : {
      ...x, parameters: { ...x.parameters, required_status_checks: x.parameters.required_status_checks.map((c) => (c.integration_id == null && actionsNames.has(c.context) ? { ...c, integration_id: actionsAppId } : c)) },
    })) };
    if (stable(next) !== stable(body)) writes.push({ method: 'PUT', path: `repos/${repo}/rulesets/${r.id}`, body: next });
  }
  return { writes, left, other, pinned, files: protectionFiles(files, actionsAppId) };
}

// After a pin: no repo-level check an Actions check run carries still accepts any app.
export function pinUnverified(cur, { actionsNames }) {
  const out = [];
  for (const [b, st] of Object.entries(cur.branches)) {
    if (!st.exists) continue;
    for (const c of st.requiredChecks) if (!c.org && actionsNames.has(c.context) && c.appId == null) out.push(`${b}: ${c.context} (${c.via}) still accepts ${c.source}`);
  }
  return out;
}

// ---- the default workflow token ----
// workflows: [{ file, text }]; current: GET actions/permissions/workflow.
export function tokenPlan(repo, workflows, current) {
  const missing = workflows.filter((w) => !parseWorkflow(w.text).permissions).map((w) => w.file);
  if (missing.length) return { missing, writes: [] };
  if (current.default_workflow_permissions === 'read') return { missing, writes: [], already: true };
  return {
    missing,
    writes: [{ method: 'PUT', path: `repos/${repo}/actions/permissions/workflow`, body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: !!current.can_approve_pull_request_reviews } }],
  };
}

// ---- plans: the id, the gate, applying ----
export const planId = (writes) => createHash('sha256').update(stable(writes.map(({ method, path, body }) => ({ method, path, body })))).digest('hex').slice(0, 12);

export function printPlan(writes, log = console.log) {
  const id = planId(writes);
  log(`plan ${id}: ${writes.length} write${writes.length === 1 ? '' : 's'}`);
  for (const w of writes) {
    log(`  ${w.method} ${w.path}${w.name ? `  (ruleset "${w.name}")` : ''}`);
    if (w.body !== undefined) for (const l of JSON.stringify(w.body, null, 2).split('\n')) log(`    ${l}`);
  }
  return id;
}

// §3 ci-protection gates every write; an unset row is `ask`, which the skill asks before applying.
export function gate(perm, applyId, writes) {
  const p = perm ?? 'ask';
  if (applyId == null) return false;
  if (!['yes', 'ask'].includes(p)) throw new Error(`config §3 ci-protection is ${p}: protection and settings writes are off, so nothing was applied`);
  const id = planId(writes);
  if (applyId !== id) throw new Error(`the plan is now ${id}, not ${applyId}: live state changed since it was shown. Read the new plan and apply that`);
  return true;
}

export function applyWrites(api, writes) {
  writes.forEach((w, i) => {
    try { api(w.path, { method: w.method, body: w.body }); } catch (e) {
      throw new Error(`write ${i + 1} of ${writes.length} failed (${w.method} ${w.path}); ${i} applied before it. Restore from the snapshot. ${e.message}`);
    }
  });
}

// ---- protection: the CLI ------------------------------------------------------------------------

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

// What the default branch carries, as GitHub runs it: origin/<default>, fetched and checked against
// the head GitHub reports, so a stale or missing ref is refused rather than read.
function committedRef(api, repo, def) {
  const head = api(`repos/${repo}/branches/${enc(def)}`).commit.sha;
  try { git('fetch', '--quiet', 'origin', def); } catch (e) { throw new Error(`cannot fetch origin/${def} to read its committed files: ${String(e.stderr ?? e.message).trim()}`); }
  let sha = '';
  try { sha = git('rev-parse', '--verify', '-q', `refs/remotes/origin/${def}`).trim(); } catch { /* compared below */ }
  if (sha !== head) throw new Error(`origin/${def} here is ${sha || 'missing'} but GitHub's ${def} is ${head}: fetch it, then run this again`);
  console.log(`committed files read at origin/${def} ${head.slice(0, 12)}`);
  return `origin/${def}`;
}

// The committed files checked are this checkout's, so the repo written must be this checkout's too.
function targetRepo(f) {
  const repo = originRepo();
  if (f.repo && f.repo !== repo) throw new Error(`this checkout is ${repo}, not ${f.repo}: run it from a checkout of ${f.repo}, whose committed files and config are the ones that decide`);
  return repo;
}
const treePaths = (ref) => git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
const committedWorkflows = (ref) => treePaths(ref).filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).map((file) => ({ file, text: git('show', `${ref}:${file}`) }));

// Files that could rewrite protection: anything under .github/, a JSON file, or a file a workflow
// names, that mentions required checks or the protection endpoints.
function committedProtectionFiles(ref) {
  let hits = [];
  try { hits = git('grep', '-l', '-I', '-E', `required_status_checks|/protection|/rulesets|${OCTOKIT_WRITE.source.replace(/\\b/g, '')}`, ref).split('\n').filter(Boolean).map((l) => l.slice(ref.length + 1)); } catch { /* no match */ }
  const workflows = committedWorkflows(ref).map((w) => w.text).join('\n');
  return hits.filter((p) => p.startsWith('.github/') || /\.json$/i.test(p) || workflows.includes(p)).map((path) => ({ path, text: git('show', `${ref}:${path}`) }));
}

const snapshotSuffix = (repo) => `-ci-protection-${repo.replace('/', '__')}.json`;
const hasSnapshot = (dir, repo) => { try { return readdirSync(dir).some((f) => f.endsWith(snapshotSuffix(repo))); } catch { return false; } };

function ciProtectionPerm() {
  try { return permissionOrUnset('ci-protection'); } catch { return null; }
}

function printChecks(snap) {
  for (const [b, st] of Object.entries(snap.branches)) {
    if (!st.exists) { console.log(`${b}: no such branch`); continue; }
    console.log(`${b}: branch protection ${st.classic ? 'on' : 'off'}, ${st.requiredChecks.length} required check${st.requiredChecks.length === 1 ? '' : 's'}`);
    for (const c of st.requiredChecks) console.log(`  ${c.context}  accepts ${c.source}  via ${c.via}`);
  }
  console.log(`rulesets: ${snap.rulesets.length ? snap.rulesets.map((r) => `"${r.name}" #${r.id} (${r.enforcement})`).join(', ') : 'none'}`);
  console.log(`GitHub Actions app: ${snap.actionsAppId ?? 'no Actions check run found'}`);
}

function runProtection(args) {
  const [sub, ...rest] = args;
  const file = sub === 'restore' ? rest.shift() : null;
  if (sub === 'restore' && (!file || file.startsWith('--'))) throw new Error('usage: desk-ci.mjs protection restore <snapshot file> [--apply <plan id>]');
  const f = flagsOf(rest);
  const dir = f.out ?? join(mainCheckout(), '.handoffs');
  const branches = f.branches ? f.branches.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const applyHint = (id) => {
    const perm = ciProtectionPerm() ?? 'ask';
    console.log(['yes', 'ask'].includes(perm)
      ? `nothing applied (config §3 ci-protection is ${perm}). To apply exactly this plan: node ~/.claude/desk/bin/desk-ci.mjs protection ${args.join(' ')} --apply ${id}`
      : `nothing applied: config §3 ci-protection is ${perm}, so protection and settings writes are off`);
  };
  const needSnapshot = (repo) => { if (!hasSnapshot(dir, repo)) throw new Error(`no protection snapshot of ${repo} in ${dir}: run \`protection snapshot\` before changing anything`); };

  if (sub === 'snapshot') {
    if (!f.ticket) throw new Error('pass --ticket <the cut-over ticket> to attach the snapshot to, or --ticket none to save it only');
    const repo = f.repo ?? originRepo();
    const snap = snapshot({ repo, branches });
    printChecks(snap);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${snap.takenAt.replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z')}${snapshotSuffix(repo)}`);
    writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`, { flag: 'wx' });
    console.log(`saved: ${path}`);
    if (/^none$/i.test(f.ticket)) { console.log('not attached to a ticket (--ticket none)'); return 0; }
    // desk-jira sends only files inside the checkout it runs in, and the snapshot is in the main one.
    try { execFileSync('desk-jira', ['attach', f.ticket, path], { stdio: 'inherit', cwd: f.out ? undefined : mainCheckout() }); } catch {
      console.log(`saved but not attached to ${f.ticket}. Attach it with: desk-jira attach ${f.ticket} ${path}`);
      return 1;
    }
    console.log(`attached to ${f.ticket}`);
    return 0;
  }

  if (sub === 'restore') {
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    if (snap.kind !== 'desk-ci protection snapshot') throw new Error(`${file} is not a desk-ci protection snapshot`);
    if (snap.repo !== targetRepo(f)) throw new Error(`${file} is a snapshot of ${snap.repo}: restore it from a checkout of ${snap.repo}, whose config gates the write`);
    const read = () => snapshot({ repo: snap.repo, branches: Object.keys(snap.branches) });
    const { writes, notes } = restorePlan(snap, read());
    for (const n of notes) console.log(`note: ${n}`);
    if (!writes.length) {
      const diffs = compareSnapshots(snap, read());
      for (const d of diffs) console.log(`differs: ${d}`);
      console.log(diffs.length || notes.length ? `not restored: ${snap.repo} does not match ${file}` : `restored: ${snap.repo} already matches ${file}`);
      return diffs.length || notes.length ? 1 : 0;
    }
    const id = printPlan(writes);
    if (!gate(ciProtectionPerm(), f.apply ?? null, writes)) { applyHint(id); return 0; }
    applyWrites(ghCall, writes);
    const diffs = compareSnapshots(snap, read());
    for (const d of diffs) console.log(`differs: ${d}`);
    console.log(diffs.length || notes.length ? `not restored: read back, ${snap.repo} still differs from ${file}` : `restored: read back, ${snap.repo} matches ${file}`);
    return diffs.length || notes.length ? 1 : 0;
  }

  if (sub === 'pin') {
    const repo = targetRepo(f);
    const cur = snapshot({ repo, branches });
    const files = committedProtectionFiles(committedRef(ghCall, repo, cur.defaultBranch));
    const ctx = { actionsAppId: cur.actionsAppId, actionsNames: new Set(cur.actionsChecks) };
    const plan = pinPlan(cur, { ...ctx, files });
    console.log(`GitHub Actions app id ${cur.actionsAppId}, read from a check run on ${repo}`);
    for (const p of plan.pinned) console.log(`pin: ${p}`);
    for (const l of plan.left) console.log(`left: ${l}`);
    for (const o of plan.other) console.log(`another app: ${o}`);
    for (const x of plan.files) console.log(`${x.path}:${x.line}  rewrites protection and needs: ${x.change}`);
    let after = cur;
    if (plan.writes.length) {
      const id = printPlan(plan.writes);
      if (f.apply == null) { applyHint(id); return 0; }
      needSnapshot(repo);
      gate(ciProtectionPerm(), f.apply, plan.writes);
      applyWrites(ghCall, plan.writes);
      after = snapshot({ repo, branches });
    }
    const unverified = pinUnverified(after, ctx);
    for (const u of unverified) console.log(`not pinned: ${u}`);
    const ok = !unverified.length && !plan.left.length && !plan.other.length && !plan.files.length;
    console.log(ok
      ? `pinned: every required check accepts only GitHub Actions (app ${cur.actionsAppId}), read back`
      : `not pinned: ${[unverified.length && `${unverified.length} check(s) did not read back pinned`, plan.left.length && `${plan.left.length} check(s) left`, plan.other.length && `${plan.other.length} check(s) bound to another app`, plan.files.length && `${plan.files.length} committed file(s) would undo the pin`].filter(Boolean).join('; ')}`);
    return ok ? 0 : 1;
  }

  if (sub === 'token') {
    const repo = targetRepo(f);
    const ref = committedRef(ghCall, repo, ghCall(`repos/${repo}`).default_branch);
    const current = ghCall(`repos/${repo}/actions/permissions/workflow`);
    const plan = tokenPlan(repo, committedWorkflows(ref), current);
    console.log(`default workflow token on ${repo}: ${current.default_workflow_permissions}`);
    for (const m of plan.missing) console.log(`${m}: no top-level permissions block (${ref})`);
    if (plan.missing.length) { console.log(`not changed: ${plan.missing.length} workflow(s) declare no top-level permissions; give each one first`); return 1; }
    if (plan.already) { console.log('read-only already: nothing to change'); return 0; }
    const id = printPlan(plan.writes);
    if (f.apply == null) { applyHint(id); return 0; }
    needSnapshot(repo);
    gate(ciProtectionPerm(), f.apply, plan.writes);
    applyWrites(ghCall, plan.writes);
    const now = ghCall(`repos/${repo}/actions/permissions/workflow`).default_workflow_permissions;
    console.log(now === 'read' ? 'read-only: the default workflow token is read, read back' : `not changed: the default workflow token reads back as ${now}`);
    return now === 'read' ? 0 : 1;
  }

  throw new Error('usage: desk-ci.mjs protection snapshot [--repo owner/name] [--branches a,b] [--ticket KEY] | restore <file> | pin | token  [--apply <plan id>]');
}

// ---- CLI --------------------------------------------------------------------------------------

function workflowFiles(args) {
  const roots = args.length ? args : ['.github/workflows'];
  const files = [];
  for (const r of roots) {
    let st;
    try { st = statSync(r); } catch { throw new Error(`no such file or directory: ${r}`); }
    if (st.isDirectory()) files.push(...readdirSync(r).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(r, f)));
    else files.push(r);
  }
  if (!files.length) throw new Error(`no workflow files in ${roots.join(' ')}`);
  return files;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'classify') {
      const count = { hosted: 0, 'self-hosted': 0 };
      let jobs = 0;
      for (const f of workflowFiles(rest)) {
        for (const r of classify(readFileSync(f, 'utf8'))) {
          jobs++; count[r.placement]++;
          const also = r.also.length ? `  (also ${r.also.map((a) => `${a.kind} :${a.line.n}`).join(', ')})` : '';
          console.log(`${f}:${r.line}  ${r.job}  ${r.placement}  ${r.why}${also}`);
        }
      }
      console.log(`summary: jobs=${jobs} hosted=${count.hosted} self-hosted=${count['self-hosted']}`);
    } else if (cmd === 'ci-lint' || cmd === 'lint') {
      let n = 0;
      for (const f of workflowFiles(rest)) {
        for (const r of lint(readFileSync(f, 'utf8'))) { n++; console.log(`${f}:${r.line}  ${r.job}  ${r.problem}`); }
      }
      console.log(`summary: findings=${n}`);
      process.exit(n ? 1 : 0);
    } else if (cmd === 'measure') {
      runMeasure(rest);
    } else if (cmd === 'batch-red') {
      process.exit(runBatchRed(rest));
    } else if (cmd === 'protection') {
      process.exit(runProtection(rest));
    } else {
      throw new Error('usage: desk-ci.mjs classify|ci-lint [<workflow file or directory>...] | measure [--repo owner/name] [--days 90] [--budget 600] [--out <dir>] | batch-red [--prs a,b | --queue <file>] [--baseline <file>] | protection snapshot|restore <file>|pin|token');
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
