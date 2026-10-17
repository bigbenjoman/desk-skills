#!/usr/bin/env node
// Places each job in a repo's GitHub Actions workflows on the self-hosted runner (the desk-runner
// arm64 Linux VM) or a GitHub-hosted one by a written rule, and lints workflows so no job that can
// land on a self-hosted runner receives a secret. Read-only: it never writes a workflow.
//   node desk-ci.mjs classify [<workflow file or directory>...]   default .github/workflows
//   node desk-ci.mjs ci-lint  [<workflow file or directory>...]   exits 1 on any finding
// classify prints `<file>:<line>  <job>  <hosted|self-hosted|callee>  <reason>` per job, the line
// being the one that decided it, then `summary: jobs=<n> hosted=<n> self-hosted=<n> callee=<n>`.
// ci-lint prints `<file>:<line>  <job>  <problem>` per finding, then `summary: findings=<n>`.
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
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

export function hostedReasons(job, wf) {
  return [
    ...secretHits(job.lines), ...inheritedEnv(wf),
    ...environmentHits(job), ...idTokenHits(job, wf),
    ...stagingHits([...job.lines, ...all(wf.env)]),
    ...serviceHits(job), ...imageHits(job), ...parityHits(job),
  ];
}

export function classify(text) {
  const wf = parseWorkflow(text);
  return wf.jobs.map((job) => {
    const reasons = hostedReasons(job, wf);
    if (reasons.length) return { job: job.id, placement: 'hosted', line: reasons[0].line.n, why: reasons[0].why, also: reasons.slice(1) };
    if (job.keys.uses && !job.keys['runs-on']) {
      return { job: job.id, placement: 'callee', line: job.keys.uses.line.n, why: `calls ${job.keys.uses.value}: its jobs are placed where they are defined`, also: [] };
    }
    const ro = job.keys['runs-on'];
    return { job: job.id, placement: 'self-hosted', line: job.line.n, why: `no hosted trigger${ro ? ` (runs-on today: ${textOf(ro).replace(/\s+/g, ' ').trim()})` : ''}`, also: [] };
  });
}

// ---- runs-on ----------------------------------------------------------------------------------

const HOSTED_LABEL = /^(ubuntu|macos|windows)-[a-z0-9.-]+$/i;
const DEPENDABOT = /github\.actor\s*==\s*'dependabot\[bot\]'|'dependabot\[bot\]'\s*==\s*github\.actor/;

// The values matrix.<key> can take, or null when the matrix is computed and cannot be read here.
function matrixValues(job, key) {
  const strat = job.keys.strategy;
  if (!strat) return null;
  const vals = [];
  const lines = strat.block;
  let found = false;
  lines.forEach((l, idx) => {
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
    const hits = [...secretHits(job.lines), ...inheritedEnv(wf), ...environmentHits(job), ...idTokenHits(job, wf)];
    for (const h of hits) out.push({ job: job.id, line: h.line.n, problem: `can run self-hosted but receives ${h.why}` });
    if (!DEPENDABOT.test(textOf(ro))) {
      out.push({ job: job.id, line: ro.line.n, problem: "can run self-hosted but runs-on has no github.actor == 'dependabot[bot]' branch to a hosted runner" });
    }
  }
  return out.sort((a, b) => a.line - b.line);
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
      const count = { hosted: 0, 'self-hosted': 0, callee: 0 };
      let jobs = 0;
      for (const f of workflowFiles(rest)) {
        for (const r of classify(readFileSync(f, 'utf8'))) {
          jobs++; count[r.placement]++;
          const also = r.also.length ? `  (also ${r.also.map((a) => `${a.kind} :${a.line.n}`).join(', ')})` : '';
          console.log(`${f}:${r.line}  ${r.job}  ${r.placement}  ${r.why}${also}`);
        }
      }
      console.log(`summary: jobs=${jobs} hosted=${count.hosted} self-hosted=${count['self-hosted']} callee=${count.callee}`);
    } else if (cmd === 'ci-lint' || cmd === 'lint') {
      let n = 0;
      for (const f of workflowFiles(rest)) {
        for (const r of lint(readFileSync(f, 'utf8'))) { n++; console.log(`${f}:${r.line}  ${r.job}  ${r.problem}`); }
      }
      console.log(`summary: findings=${n}`);
      process.exit(n ? 1 : 0);
    } else {
      throw new Error('usage: desk-ci.mjs classify|ci-lint [<workflow file or directory>...]');
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
