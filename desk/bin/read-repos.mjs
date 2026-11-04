// The clones behind §4 Worker read-only repos. Each is shallow, at the head of its repo's default
// branch, and refreshed by the pass before a local worker spawns, because a worker measuring a stale
// copy gets wrong numbers with no sign of it. Workers read them and never clone or fetch one.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as E from './desk-env.mjs';

const GIT_TIMEOUT_MS = 600000;

// A repo's address by the same transport and host as this repo's own origin, so an unattended clone
// uses the credentials its fetches already use.
export function cloneUrl(origin, repo) {
  const m = /^(.*[/:])[^/:]+\/[^/:]+?(\.git)?\/?$/.exec(String(origin ?? '').trim());
  return m ? `${m[1]}${repo}${m[2] ?? ''}` : `https://github.com/${repo}.git`;
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, why: `git timed out after ${GIT_TIMEOUT_MS / 60000} minutes` };
  if (r.error) return { ok: false, why: r.error.message };
  // git's last line is often advice ("and the repository exists."), so the fatal line is the reason.
  const lines = (r.stderr ?? '').trim().split('\n');
  return { ok: r.status === 0, why: lines.find((l) => /^(fatal|error):/.test(l)) ?? (lines.pop() || `git exited ${r.status}`) };
}

// Bring one clone to its repo's current default head. -> null, or why it could not.
function refreshOne(url, path) {
  // A clone killed part way has no HEAD, and no fetch mends it.
  const whole = existsSync(join(path, '.git')) && git([`--git-dir=${join(path, '.git')}`, 'rev-parse', '--verify', '-q', 'HEAD']).ok;
  if (!whole) {
    rmSync(path, { recursive: true, force: true });
    const c = git(['clone', '--quiet', '--depth', '1', '--no-tags', '--single-branch', url, path]);
    return c.ok ? null : c.why;
  }
  for (const args of [['fetch', '--quiet', '--depth', '1', '--no-tags', url, 'HEAD'], ['reset', '--quiet', '--hard', 'FETCH_HEAD'], ['clean', '-ffdxq']]) {
    const r = git(['-C', path, ...args]);
    if (!r.ok) return r.why;
  }
  return null;
}

// Refresh every listed repo. -> [{ repo, why }], one per repo that could not be brought up to date:
// an item that is not `owner/name` is one, so a typo stops the spawn rather than dropping out unseen.
export function refreshReadRepos() {
  let repos;
  try { repos = E.readRepos(); } catch (e) { return [{ repo: '§4 Worker read-only repos', why: e.message }]; }
  if (!repos.length) return [];
  const origin = spawnSync('git', ['-C', E.repoRoot(), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout;
  return repos.flatMap(({ repo, path }) => {
    const why = path ? refreshOne(cloneUrl(origin, repo), path) : 'it is not owner/name';
    return why ? [{ repo, why }] : [];
  });
}

// Delete every clone the row no longer lists, so a delisted repo cannot be read through the state
// directory a worker of the standing batch is granted. -> [{ name, why }] for any that would not go.
export function pruneReadRepos() {
  let listed;
  let dir;
  try { listed = new Set(E.readRepos().map((r) => r.path)); dir = E.readRepoDir(); } catch { return []; }
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !listed.has(join(dir, name))).flatMap((name) => {
    try { rmSync(join(dir, name), { recursive: true, force: true }); return []; }
    catch (e) { return [{ name, why: e.message }]; }
  });
}
