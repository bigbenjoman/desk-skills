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
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// GitHub bills each job in whole minutes, rounded up; a job that never ran bills nothing.
export function jobMinutes(job) {
  const d = ms(job.completed_at) - ms(job.started_at);
  return Number.isFinite(d) && d > 0 ? Math.ceil(d / 60000) : 0;
}

export const isSelfHosted = (job) => (job.labels ?? []).includes('self-hosted')
  || (!!job.runner_group_name && job.runner_group_name !== 'GitHub Actions');

// Hosted minutes bill at the runner OS's multiplier.
const osMultiplier = (job) => { const l = (job.labels ?? []).join(' '); return /macos/i.test(l) ? 10 : /windows/i.test(l) ? 2 : 1; };

// Red and re-run runs are what the PR figures turn on, so their jobs are read first; the rest are
// sampled per workflow and scaled back up.
const mustRead = (run) => RED.has(run.conclusion) || (run.run_attempt ?? 1) > 1;
const workflowOf = (run) => run.name ?? run.path ?? '?';
const stratum = (run) => `${workflowOf(run)}\u0000${mustRead(run) ? 'red' : 'rest'}`;

export function pickSample(runs, n) {
  if (n >= runs.length) return runs.slice();
  const groups = new Map();
  for (const r of runs) { const k = stratum(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const picked = new Set();
  const keys = [...groups.keys()].sort((a, b) => Number(a.endsWith('rest')) - Number(b.endsWith('rest')));
  for (const k of keys) if (picked.size < n) picked.add(groups.get(k)[0]);
  for (const r of runs) if (picked.size < n && mustRead(r)) picked.add(r);
  const rest = runs.filter((r) => !picked.has(r));
  const k = n - picked.size;
  for (let i = 0; i < k; i++) picked.add(rest[Math.floor((i * rest.length) / k)]);
  return runs.filter((r) => picked.has(r));
}

// Each read run stands for the runs of its stratum that were not read.
export function sampleWeights(runs, readIds) {
  const total = new Map();
  const read = new Map();
  for (const r of runs) {
    const k = stratum(r);
    total.set(k, (total.get(k) ?? 0) + 1);
    if (readIds.has(r.id)) read.set(k, (read.get(k) ?? 0) + 1);
  }
  const w = new Map();
  for (const r of runs) if (readIds.has(r.id)) w.set(r.id, total.get(stratum(r)) / read.get(stratum(r)));
  return w;
}

// One record per attempt of a run. Without its jobs only the latest attempt is known.
function attemptsOf(run, jobs, estimate) {
  const byAttempt = new Map();
  for (const j of jobs ?? []) {
    const a = j.run_attempt ?? 1;
    if (!byAttempt.has(a)) byAttempt.set(a, []);
    byAttempt.get(a).push(j);
  }
  if (!byAttempt.size) {
    return [{ run, attempt: run.run_attempt ?? 1, sha: run.head_sha, created: ms(run.run_started_at ?? run.created_at), completed: ms(run.updated_at),
      red: RED.has(run.conclusion), decided: DECIDED.has(run.conclusion), done: run.status === 'completed', minutes: estimate, jobs: [] }];
  }
  return [...byAttempt.entries()].sort((a, b) => a[0] - b[0]).map(([attempt, js]) => {
    const red = js.some((j) => RED.has(j.conclusion));
    return {
      run, attempt, sha: run.head_sha,
      created: Math.min(...finite(js.map((j) => ms(j.created_at ?? j.started_at)))),
      completed: Math.max(...finite(js.map((j) => ms(j.completed_at)))),
      red, decided: red || js.some((j) => j.conclusion === 'success'), done: js.every((j) => j.status === 'completed'),
      minutes: js.reduce((t, j) => t + jobMinutes(j) * (isSelfHosted(j) ? 1 : osMultiplier(j)), 0), jobs: js,
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

// A PR's CI history in push order. A head commit is green once every run on it has a final attempt
// that passed. A round trip runs from the first red to the next green, by re-run or by a new push.
export function prTimeline(atts) {
  const shas = new Map();
  for (const a of atts) { if (!shas.has(a.sha)) shas.set(a.sha, []); shas.get(a.sha).push(a); }
  const order = [...shas.values()].map((as) => {
    const finals = new Map();
    for (const a of as) { const f = finals.get(a.run.id); if (!f || a.attempt > f.attempt) finals.set(a.run.id, a); }
    const fin = [...finals.values()];
    const reds = as.filter((a) => a.red).map((a) => a.completed);
    return {
      first: Math.min(...as.map((a) => a.created)),
      greenAt: fin.every((a) => a.done && !a.red) ? Math.max(...fin.map((a) => a.completed)) : null,
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
  const weight = sampleWeights(runs, readIds);

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
    const k = stratum(byId.get(id));
    const s = mean.get(k) ?? { n: 0, m: 0 };
    s.n++; s.m += m.billed + m.self;
    mean.set(k, s);
  }
  const estimate = (r) => { const s = mean.get(stratum(r)); return s ? s.m / s.n : 0; };

  const workflows = new Map();
  const jobRows = new Map();
  const months = new Map();
  const month = (key) => { if (!months.has(key)) months.set(key, { month: key, billed: 0, self: 0, merged: 0 }); return months.get(key); };
  const attemptsByRun = new Map();
  let unmeasured = 0;
  for (const r of runs) {
    const name = workflowOf(r);
    if (!workflows.has(name)) workflows.set(name, { workflow: name, runs: 0, attempts: 0, decided: 0, failed: 0, billed: 0, self: 0, firstFailing: {} });
    const w = workflows.get(name);
    const atts = attemptsOf(r, jobs.get(r.id), estimate(r));
    attemptsByRun.set(r.id, atts);
    w.runs++;
    for (const a of atts) {
      w.attempts++;
      if (a.decided) w.decided++;
      if (!a.red) continue;
      w.failed++;
      if (!readIds.has(r.id)) continue;
      const first = a.jobs.filter((j) => RED.has(j.conclusion)).sort((x, y) => ms(x.completed_at) - ms(y.completed_at))[0];
      const label = first?.name ?? '(no job ran)';
      w.firstFailing[label] = (w.firstFailing[label] ?? 0) + 1;
    }
    if (!readIds.has(r.id)) { if (!mean.has(stratum(r))) unmeasured++; continue; }
    const k = weight.get(r.id);
    const m = runMin.get(r.id);
    w.billed += m.billed * k;
    w.self += m.self * k;
    const mo = month(r.created_at.slice(0, 7));
    mo.billed += m.billed * k;
    mo.self += m.self * k;
    for (const j of jobs.get(r.id)) {
      const key = `${name}\u0000${j.name}`;
      if (!jobRows.has(key)) jobRows.set(key, { workflow: name, job: j.name, runs: 0, billed: 0, self: 0 });
      const row = jobRows.get(key);
      row.runs += k;
      if (isSelfHosted(j)) row.self += jobMinutes(j) * k; else row.billed += jobMinutes(j) * osMultiplier(j) * k;
    }
  }
  for (const p of prs) {
    const d = p.merged_at?.slice(0, 10);
    if (d && d >= coveredSince && d <= until) month(d.slice(0, 7)).merged++;
  }

  const byNumber = new Map(prs.map((p) => [p.number, p]));
  const prAttempts = new Map();
  for (const r of runs) {
    const pr = prOfRun(r, prs, byNumber);
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
  const spread = (xs) => ({ n: xs.length, median: quantile(xs, 0.5), p90: quantile(xs, 0.9) });
  const wfs = [...workflows.values()].sort((a, b) => b.billed + b.self - (a.billed + a.self));

  return {
    since, until, coveredSince,
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
      withCi: perPr.length, red: perPr.filter((p) => p.red).length,
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
  for (const r of pickSample(completed, Math.max(0, allowance - calls))) {
    const js = [];
    let whole = true;
    for (let p = 1; ; p++) {
      let page;
      try { page = get(`repos/${repo}/actions/runs/${r.id}/jobs?filter=all&per_page=100&page=${p}`); } catch { whole = false; break; }
      if (!page) { whole = false; break; }
      js.push(...page.jobs);
      if (page.jobs.length < 100 || js.length >= page.total_count) break;
    }
    if (whole) jobs.set(r.id, js);
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
      ? `- sampled: jobs read for ${m.runs.read} of ${m.runs.completed} completed runs, including ${m.runs.mustReadRead} of the ${m.runs.mustRead} red or re-run ones; minutes are scaled per workflow and marked (est.)`
      : `- not sampled: jobs read for all ${m.runs.completed} completed runs`,
    ...(m.runs.listed > m.runs.completed ? [`- ${m.runs.listed - m.runs.completed} runs still in progress are left out`] : []),
    ...(m.runs.unmeasured ? [`- ${m.runs.unmeasured} runs are in workflows with no job read, so carry no minutes`] : []),
    ...c.notes.map((n) => `- ${n}`),
    '',
    '## Totals',
    '',
    `- billed minutes${est}: ${int(m.totals.billed)} (each job rounded up to the minute; macOS ×10, Windows ×2)`,
    `- self-hosted minutes${est}: ${int(m.totals.self)}`,
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
  const c = collect({ repo, since, until, budget });
  const m = measure({ ...c });
  const text = report(m, c, now.toISOString());
  const dir = f.out ?? join(mainCheckout(), '.handoffs');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${until}-ci-measure-${repo.replace('/', '__')}`);
  writeFileSync(`${base}.md`, text);
  writeFileSync(`${base}.json`, `${JSON.stringify({ repo, measuredAt: now.toISOString(), calls: c.calls, budget, allowance: c.allowance, notes: c.notes, ...m }, null, 2)}\n`);
  console.log(text);
  console.log(`saved: ${base}.md and ${base}.json`);
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
    } else {
      throw new Error('usage: desk-ci.mjs classify|ci-lint [<workflow file or directory>...] | measure [--repo owner/name] [--days 90] [--budget 600] [--out <dir>]');
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
