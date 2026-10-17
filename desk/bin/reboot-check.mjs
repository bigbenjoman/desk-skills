#!/usr/bin/env node
// What a reboot of this computer would interrupt or leave behind, read-only: every worktree of every
// configured repo with uncommitted changes or unpushed commits, the desk-runner VM, and the heavy
// processes desk-env counts. Claude sessions are not listed here: /desk-reboot reads them with
// ListAgents, the only source of their busy, waiting or idle state.
//   node reboot-check.mjs
// The last line is
// `summary: dirty=<n> unpushed=<n> runner=<running|stopped|absent|unknown> keep=<loaded|none> heavy=<n>`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, deskConfigRoot, expandHome, heavyProcesses } from './desk-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tilde = (p) => (p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);
const run = (cmd, args, opts = {}) => {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }) }; }
  catch (e) { return { ok: false, status: e.status, out: String(e.stdout ?? '') }; }
};
const git = (dir, ...args) => run('git', ['-C', dir, ...args]);

// Each repo's §2 Primary repo root, read through desk-env so there is one config parser. The child
// runs outside any repo with the repo-pinning variables cleared, so it reads only the config named.
function repoRoot(slug, config) {
  const env = { ...process.env, DESK_CONFIG: config };
  delete env.DESK_REPO_DIR; delete env.DESK_REPO_OVERRIDE;
  const r = run(process.execPath, [join(HERE, 'desk-env.mjs'), 'get', 'repo-root'], { env, cwd: dirname(config) });
  return r.ok ? expandHome(r.out.trim().replaceAll('<slug>', slug)) : null;
}

function worktrees(root) {
  const r = git(root, 'worktree', 'list', '--porcelain');
  if (!r.ok) return null;
  return r.out.split('\n\n').filter((b) => b.trim()).map((b) => {
    const field = (k) => b.split('\n').find((l) => l === k || l.startsWith(`${k} `))?.slice(k.length + 1);
    const branch = field('branch');
    return { path: field('worktree'), branch: branch ? branch.replace(/^refs\/heads\//, '') : field('detached') != null ? '(detached)' : '?' };
  });
}

function treeState(path, hasRemote) {
  if (!existsSync(path)) return { missing: true };
  const st = git(path, 'status', '--porcelain');
  if (!st.ok) return { error: 'git status failed' };
  const lines = st.out.split('\n').filter(Boolean);
  // Commits on no remote at all, so a branch that was never pushed counts every commit of its own.
  // A repo with no remote has nothing to push to, so it has no unpushed count.
  const up = hasRemote ? git(path, 'rev-list', '--count', 'HEAD', '--not', '--remotes') : { ok: false };
  return {
    changed: lines.length,
    untracked: lines.filter((l) => l.startsWith('??')).length,
    unpushed: up.ok ? Number(up.out.trim()) : 0,
  };
}

const configs = (() => {
  const dir = join(deskConfigRoot(), 'repos');
  try { return readdirSync(dir).sort().map((slug) => ({ slug, config: join(dir, slug, 'config.md') })).filter((c) => existsSync(c.config)); }
  catch { return []; }
})();

let dirty = 0; let unpushed = 0; let clean = 0; let total = 0;
const lines = [];
for (const { slug, config } of configs) {
  const root = repoRoot(slug, config);
  if (!root) { lines.push(`  ${slug}: §2 Primary repo root is unset; not checked`); continue; }
  const wts = existsSync(root) ? worktrees(root) : null;
  if (!wts) { lines.push(`  ${slug}: ${tilde(root)} is not a git checkout here; not checked`); continue; }
  const hasRemote = git(root, 'remote').out.trim() !== '';
  const rows = [];
  for (const w of wts) {
    total++;
    const s = treeState(w.path, hasRemote);
    if (s.missing) { rows.push(`    ${tilde(w.path)}  ${w.branch}  directory missing (git worktree prune clears it)`); continue; }
    if (s.error) { rows.push(`    ${tilde(w.path)}  ${w.branch}  ${s.error}`); continue; }
    if (!s.changed && !s.unpushed) { clean++; continue; }
    const parts = [];
    if (s.changed) { dirty++; parts.push(`${s.changed} uncommitted${s.untracked ? ` (${s.untracked} untracked)` : ''}`); }
    if (s.unpushed) { unpushed++; parts.push(`${s.unpushed} unpushed`); }
    rows.push(`    ${tilde(w.path)}  ${w.branch}  ${parts.join(' · ')}`);
  }
  lines.push(`  ${slug}  ${tilde(root)}  (${wts.length} worktree${wts.length === 1 ? '' : 's'}${hasRemote ? '' : '; no remote, so nothing counts as unpushed'})`, ...rows);
}
console.log(`worktrees: ${configs.length} configured repo${configs.length === 1 ? '' : 's'}, ${total} worktrees; ${dirty} with uncommitted changes, ${unpushed} with unpushed commits, ${clean} clean`);
for (const l of lines) console.log(l);

// desk-runner status exits 0 only while the VM runs. Its keep agent starts a stopped or absent VM
// within a minute, so a loaded agent means the VM will be running whatever its state now.
let runner = 'unknown';
const rs = run(join(HERE, 'desk-runner'), ['status']);
const rsLines = rs.out.split('\n').filter(Boolean);
if (rs.ok) runner = 'running';
else if (/: stopped /.test(rsLines[0] ?? '')) runner = 'stopped';
else if (/: absent /.test(rsLines[0] ?? '')) runner = 'absent';
const keep = rsLines.some((l) => /^agents: restart at login and every minute loaded/.test(l)) ? 'loaded' : 'none';
console.log(`runner: ${runner}${keep === 'loaded' ? ' (its keep agent is loaded and starts it again within a minute)' : ''}`);
for (const l of rsLines) console.log(`  ${l}`);

const heavy = heavyProcesses();
console.log(`heavy: ${heavy.length} (test suites, typechecks, dev servers)`);
for (const p of heavy) console.log(`  ${p.pid} ${p.args}`);

console.log(`summary: dirty=${dirty} unpushed=${unpushed} runner=${runner} keep=${keep} heavy=${heavy.length}`);
