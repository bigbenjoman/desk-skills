#!/usr/bin/env node
// How a repo's committed copies of desk's templates (desk/templates/: the pre-push hook and its
// script, the desk gate workflow and its script) stand against the installed templates. /desk-setup
// copies each in once, so a later template fix reaches a repo only through this. A copy is read on
// origin/<§0 Default branch> of the repo's main checkout. Its base is the template version it was
// copied from: of the template's versions in the desk-skills checkout's history, the one nearest it.
//   node repo-templates.mjs status [--root <dir>] [--json]
//       one line per committed copy: CURRENT (it is the template), BEHIND (the template changed since
//       its base; apply keeps the repo's own edits), EDITED (only the repo changed it), UNKNOWN (it
//       differs, and no desk-skills history was found to tell which). Exit 1 when any is BEHIND
//   node repo-templates.mjs diff <path> [--root <dir>]
//       what the template changed since that copy's base, as a unified diff
//   node repo-templates.mjs apply [--root <dir>] [<path>...]
//       writes each BEHIND copy (or those named) into <dir>'s working tree, which the caller has cut
//       from origin/<default>: the template's changes applied and the repo's own kept. Prints APPLIED,
//       or KEPT with each hunk where both changed the same lines: the repo's lines stay, and the hunk
//       goes in the PR body
//   node repo-templates.mjs check [--force]
//       the supervisor's: status for this repo, written to the standing batch's templates.json, at
//       most hourly unless the installed desk version moved
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, realpathSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { sourceCheckout } from './maintenance.mjs';
import { readInstalled } from './installed.mjs';

const CHECK_EVERY_MS = 60 * 60 * 1000;
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, status: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim() || r.error?.message || '' };
};
const git = (dir, ...a) => run('git', ['-C', dir, ...a]);
const short = (sha) => (sha === 'installed' ? 'installed' : String(sha).slice(0, 7));

export const templatesDir = () => join(E.deskHome(), 'templates');

// Every installed template, as its path in a repo (`.githooks/pre-push`).
export function templateFiles(dir = templatesDir()) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (!n.includes('.bak')) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

// Lines in one text and not the other, by longest common subsequence: how far a copy is from a version.
export function lineDistance(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let prev = new Uint32Array(y.length + 1), cur = new Uint32Array(y.length + 1);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return x.length + y.length - 2 * prev[y.length];
}

// The template's versions, newest first: the installed copy, then each commit's in the desk-skills
// checkout (renames followed). -> [{ sha, date, text }], one per distinct text.
export function templateVersions(rel, { installed, src = sourceCheckout() } = {}) {
  const versions = [{ sha: 'installed', date: null, text: installed }];
  versions.history = false;
  if (src && existsSync(src)) {
    const log = git(src, 'log', '--format=%x01%H%x09%cI', '--name-only', '--follow', '--', `desk/templates/${rel}`);
    for (const chunk of log.ok ? log.out.split('\x01').slice(1) : []) {
      const [head, ...paths] = chunk.split('\n').filter(Boolean);
      const [sha, date] = head.split('\t');
      const show = paths[0] ? git(src, 'show', `${sha}:${paths[0]}`) : { ok: false };
      if (show.ok) versions.history = true;
      if (show.ok && !versions.some((v) => v.text === show.out)) versions.push({ sha, date, text: show.out });
    }
  }
  return versions;
}

const defaultRef = () => `origin/${E.configValue('default-branch') ?? 'main'}`;
const rootOf = (root) => root ?? E.repoRoot();

// One committed copy against its template. -> { path, status, base?, base_date?, copy, template, baseText? }
export function fileStatus(rel, { root, ref = defaultRef(), dir = templatesDir(), src } = {}) {
  const shown = git(root, 'show', `${ref}:${rel}`);
  if (!shown.ok) return null; // not committed here: setup never copied it in
  const copy = shown.out;
  const template = readFileSync(join(dir, rel), 'utf8');
  if (copy === template) return { path: rel, status: 'CURRENT', copy, template };
  const versions = templateVersions(rel, { installed: template, src });
  if (!versions.history) return { path: rel, status: 'UNKNOWN', copy, template };
  let best = versions[0], d = lineDistance(copy, best.text);
  // A tie goes to the older version: merging from a base older than the real one only re-applies
  // changes the copy already has, which merge-file takes cleanly, while a base too new hides a fix.
  for (const v of versions.slice(1)) { const e = lineDistance(copy, v.text); if (e <= d) { best = v; d = e; } }
  if (best.sha === 'installed') return { path: rel, status: 'EDITED', copy, template };
  return { path: rel, status: 'BEHIND', base: best.sha, base_date: best.date, copy, template, baseText: best.text };
}

export function repoStatus({ root, ref = defaultRef(), dir = templatesDir(), src } = {}) {
  return templateFiles(dir).map((rel) => fileStatus(rel, { root, ref, dir, src })).filter(Boolean);
}

export function statusLine(s) {
  switch (s.status) {
    case 'CURRENT': return `CURRENT  ${s.path}`;
    case 'EDITED': return `EDITED   ${s.path}: this repo changed its copy; the template has nothing new for it`;
    case 'UNKNOWN': return `UNKNOWN  ${s.path}: differs from the template, and no desk-skills history was found to tell whether it is behind`;
    default: return `BEHIND   ${s.path}: the template changed since the version this copy was made from (${short(s.base)}, ${String(s.base_date).slice(0, 10)})`;
  }
}

const NOT_BEHIND = {
  CURRENT: 'it is the template already',
  EDITED: 'only this repo changed it, so the template has nothing new for it',
  UNKNOWN: 'no desk-skills history was found to tell whether it is behind',
  ABSENT: 'not a desk template committed in this repo',
};

// In a scratch directory, for git merge-file and diff, which read files.
function withFiles(texts, fn) {
  const d = mkdtempSync(join(tmpdir(), 'desk-templates-'));
  try {
    const paths = texts.map((t, i) => { const p = join(d, String(i)); writeFileSync(p, t); return p; });
    return fn(paths);
  } finally { rmSync(d, { recursive: true, force: true }); }
}

export function templateDiff(s) {
  return withFiles([s.baseText, s.template], ([a, b]) => run('diff', ['-u', '-L', `${s.path} (template at ${short(s.base)})`, '-L', `${s.path} (template now)`, a, b]).out);
}

// The template's changes since the copy's base, on the repo's copy. -> { text, conflicts: [hunk] }:
// where both changed the same lines the repo's lines are kept, and the hunk as merge-file marks it is
// returned for the PR body.
export function mergeCopy(s) {
  return withFiles([s.copy, s.baseText, s.template], ([ours, base, theirs]) => {
    const labels = ['-L', 'this repo', '-L', `template at ${short(s.base)}`, '-L', 'template now'];
    const marked = run('git', ['merge-file', '-p', ...labels, ours, base, theirs]);
    if (marked.status == null || marked.status < 0) throw new Error(`git merge-file failed on ${s.path}: ${marked.err}`);
    if (marked.status === 0) return { text: marked.out, conflicts: [] };
    const kept = run('git', ['merge-file', '-p', '--ours', ...labels, ours, base, theirs]);
    const conflicts = [...marked.out.matchAll(/^<{7} [^\n]*\n[^]*?^>{7} [^\n]*$/gm)].map((m) => m[0]);
    return { text: kept.out, conflicts };
  });
}

// The standing batch's record of this repo's copies, for needs-you. -> { at, installed, files } | null
export const recordPath = (slug = E.repoSlug()) => join(E.batchPaths(slug).state, 'templates.json');
export function readRecord(slug) { try { return JSON.parse(readFileSync(recordPath(slug), 'utf8')); } catch { return null; } }

// Any configured repo's, by slug (needs-you re-checks one from another repo): its main checkout and
// default branch from its own config. Each behind copy keeps the `since` it was first found behind at.
export function check({ slug = E.repoSlug(), force = false, now = Date.now() } = {}) {
  const installed = readInstalled()?.commit ?? null;
  const prev = readRecord(slug);
  if (!force && prev && prev.installed === installed && now - Date.parse(prev.at) < CHECK_EVERY_MS) return { skipped: true, record: prev };
  const rootRow = E.repoConfigValue(slug, 'repo-root');
  const ref = `origin/${E.repoConfigValue(slug, 'default-branch') ?? 'main'}`;
  const at = new Date(now).toISOString();
  const was = (f) => prev?.files?.find((p) => p.path === f.path && p.status === 'BEHIND' && p.base === f.base);
  // With no template installed there is nothing to be behind, and no checkout to read.
  const installedAny = templateFiles().length > 0;
  if (installedAny && !rootRow) throw new Error(`no §2 Primary repo root in ${slug}'s config`);
  const root = rootRow ? E.expandHome(rootRow) : null;
  const files = (installedAny ? repoStatus({ root, ref }) : []).map(({ path, status, base, base_date }) => ({ path, status, ...(base ? { base, base_date } : {}) }))
    .map((f) => (f.status === 'BEHIND' ? { ...f, since: was(f)?.since ?? at } : f));
  const record = { at, installed, ref, root, files };
  const p = recordPath(slug);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
  return { skipped: false, record };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
  const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
  try {
    const cmd = argv.shift();
    const rootArg = opt('--root');
    const root = rootArg ? E.expandHome(rootArg) : null;
    if (cmd === 'status') {
      const json = flag('--json');
      const all = repoStatus({ root: rootOf(root) });
      if (json) console.log(JSON.stringify(all.map(({ path, status, base, base_date }) => ({ path, status, base: base ?? null, base_date: base_date ?? null }))));
      else console.log(all.length ? all.map(statusLine).join('\n') : 'no desk template is committed in this repo');
      process.exitCode = all.some((s) => s.status === 'BEHIND') ? 1 : 0;
    } else if (cmd === 'diff' && argv.length === 1) {
      const s = fileStatus(argv[0], { root: rootOf(root) });
      if (!s) throw new Error(`${argv[0]} is not a desk template committed in this repo`);
      if (s.status !== 'BEHIND') console.log(statusLine(s));
      else process.stdout.write(templateDiff(s));
    } else if (cmd === 'apply') {
      const at = rootOf(root);
      const all = repoStatus({ root: at });
      const picked = argv.length ? argv.map((p) => all.find((s) => s.path === p) ?? { path: p, status: 'ABSENT' }) : all.filter((s) => s.status === 'BEHIND');
      if (!picked.length) console.log('nothing is behind: no copy to update');
      for (const s of picked) {
        if (s.status !== 'BEHIND') { console.log(`SKIPPED  ${s.path}: ${NOT_BEHIND[s.status]}`); continue; }
        const m = mergeCopy(s);
        writeFileSync(join(at, s.path), m.text);
        if (!m.conflicts.length) console.log(`APPLIED  ${s.path}: the template's changes since ${short(s.base)}, with this repo's own edits kept`);
        else {
          console.log(`KEPT     ${s.path}: the template's changes since ${short(s.base)} applied, except ${m.conflicts.length} hunk(s) this repo also changed, where its lines were kept:`);
          for (const c of m.conflicts) console.log(c);
        }
      }
    } else if (cmd === 'check') {
      const r = check({ force: flag('--force') });
      const behind = r.record.files.filter((f) => f.status === 'BEHIND').map((f) => f.path);
      console.log(`${r.skipped ? 'checked recently' : 'checked'}: ${behind.length ? `behind: ${behind.join(', ')}` : 'no copy behind'}`);
    } else {
      console.error('usage: repo-templates.mjs status [--root <dir>] [--json] | diff <path> [--root <dir>] | apply [--root <dir>] [<path>...] | check [--force]');
      process.exit(2);
    }
  } catch (e) {
    console.error(`repo-templates: ${e.message}`);
    process.exit(1);
  }
}
