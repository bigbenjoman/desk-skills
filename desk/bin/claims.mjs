// A ticket claimed by an interactive session: `queue.mjs park <KEY> --claimed-by <session id>` records
// {session, at} on its park. Each pass reads how long that session's transcript under
// ~/.claude/projects has been still, and once it is past config §3b "Release idle claims after
// (hours)" and the ticket's worktree holds no uncommitted change, the ticket goes back to the workers
// with its branch kept. A worktree with uncommitted changes keeps the claim, and says so once.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as E from './desk-env.mjs';

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

// The session's transcript, `<projects>/<any project>/<session>.jsonl`, and when it last changed: the
// newest where a session id appears under more than one project. Null when there is none.
export function transcriptOf(session, home = E.HOME) {
  const root = join(home, '.claude', 'projects');
  let best = null;
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const path = join(root, d, `${session}.jsonl`);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!best || st.mtimeMs > best.mtimeMs) best = { path, mtimeMs: st.mtimeMs };
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
