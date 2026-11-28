// A ticket claimed by an interactive session: `queue.mjs park <KEY> --claimed-by <session id>` records
// {session, at} on its park. Each pass reads how long that session's transcript under
// ~/.claude/projects has been still, and once it is past config §3b "Release idle claims after
// (hours)" and the ticket's worktree holds no uncommitted change, the ticket goes back to the workers
// with its branch kept. A worktree with uncommitted changes keeps the claim, and says so once.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as E from './desk-env.mjs';
import { projectsDirs } from './claude-logins.mjs';

export const CLAIM_ROW = E.CONFIG_ROWS['claim-release'].row;
export const DEFAULT_CLAIM_HOURS = 12;
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
// The park question of a ticket claimed with no park of its own and no question given.
export const claimQuestion = (session) => `claimed by session ${session}: worked there, not by a worker`;

// Config §3b "Release idle claims after (hours)": a number of hours, `0` or `none` never releases,
// unset is 12.
export function claimHours(raw = E.configValue('claim-release')) {
  if (raw == null) return { hours: DEFAULT_CLAIM_HOURS };
  if (E.isNone(raw)) return { hours: 0 };
  const v = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return { hours: Number(v) };
  return { bad: `config §3b "${CLAIM_ROW}" is "${raw}" — want a number of hours, or 0 to never release a claim` };
}
// claimHours of repo `slug`'s row, as desk-q and needs-you read another repo's config; an unreadable
// config reads as unset.
export function claimHoursOf(slug) {
  let raw = null;
  try { raw = E.repoConfigValue(slug, 'claim-release'); } catch { /* an unreadable config reads as unset */ }
  return claimHours(raw);
}
// Whether a session's claim made at `at` still holds: its transcript `tr` (transcriptOf) is there and has
// changed within `hours` of `now`, counted from the claim at the latest. With no transcript it has
// lapsed; with `hours` 0, or unset because the row is bad (claimHours), it never lapses while the
// transcript is there.
export function claimLive(tr, at, hours, now = Date.now()) {
  if (!tr) return false;
  if (!(hours > 0)) return true;
  return now - Math.max(tr.mtimeMs, Date.parse(at) || 0) <= hours * 3600e3;
}

// Config §3b "Plan-first wait before needs-you (hours)", in milliseconds: how long a plan-first ticket
// no session has claimed waits before it reaches needs-you. Unset, or a value that does not read, is 4
// hours. `slug` reads another repo's config, as desk-q and needs-you do.
export const PLAN_FIRST_ROW = E.CONFIG_ROWS['plan-first-wait'].row;
export const DEFAULT_PLAN_FIRST_HOURS = 4;
export function planFirstWaitMs(slug = null) {
  let raw = null;
  try { raw = slug ? E.repoConfigValue(slug, 'plan-first-wait') : E.configValue('plan-first-wait'); } catch { /* an unreadable config reads as unset */ }
  const v = String(raw ?? '').trim();
  return (/^\d+(\.\d+)?$/.test(v) ? Number(v) : DEFAULT_PLAN_FIRST_HOURS) * 3600e3;
}

// The session's transcript, `<projects>/<any project>/<session>.jsonl` under any Claude login's folder,
// and when it last changed: the newest where a session id appears under more than one project. Null
// when there is none.
export function transcriptOf(session, roots = projectsDirs()) {
  let best = null;
  for (const root of roots) {
    let dirs = [];
    try { dirs = readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const path = join(root, d, `${session}.jsonl`);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!best || st.mtimeMs > best.mtimeMs) best = { path, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

// Where the claimed work sits: the worktree the queue recorded, else the batch's worktree for the key.
// Null when neither exists, so nothing uncommitted can be lost.
export function claimWorktree(t, dir = E.worktreesDir()) {
  for (const wt of [t.worktree, dir ? join(dir, t.key) : null]) if (wt && existsSync(wt)) return wt;
  return null;
}

// The worktree's uncommitted paths (`git status --porcelain`, untracked included). Throws when git
// cannot read it.
export function uncommitted(wt) {
  const out = execFileSync('git', ['-C', wt, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.split('\n').filter(Boolean).map((l) => l.slice(3));
}
