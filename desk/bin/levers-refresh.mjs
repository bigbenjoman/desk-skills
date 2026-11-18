#!/usr/bin/env node
// Keeps the Levers page current: builds the view model and renders the page under one machine-wide
// lock, and skips both while no input has changed and the last attempt is under REBUILD_MS old. A
// build that throws, or whose desk-q line reads broken, leaves the last good view.json and index.html
// in place and records the error in build.json under `failed`.
//
//   node levers-refresh.mjs        one refresh; prints its result as one JSON line, and exits 0
//
//   import { refresh, pageState, whereOf } from './levers-refresh.mjs'
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, mkdirSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deskConfigRoot } from './desk-env.mjs';
import { autopilotRoot, buildLock, buildRecord, buildView, inputFiles, leversDir } from './levers-view.mjs';
import { renderPage } from './levers-page.mjs';
import { releaseDirLock, takeDirLock, writeJsonAtomic, writeTextAtomic } from './dir-lock.mjs';

// A page older than this is rebuilt whatever its inputs, so the ages it shows stay current.
const REBUILD_MS = 10 * 60 * 1000;
// A page older than this has missed the rebuild several supervisor ticks would have made, so desk-q
// warns that the supervisor may be stopped. Well past REBUILD_MS: a page waits up to one tick after
// turning REBUILD_MS old before a tick rebuilds it, and that wait is not a fault.
const STALE_MS = 30 * 60 * 1000;
// How long a refresh waits for another one's build before leaving the page to it.
const LOCK_WAIT_MS = 10_000;

const filesIn = (dir) => ({ page: join(dir, 'index.html'), view: join(dir, 'view.json'), build: join(dir, 'build.json'), lock: buildLock(dir) });
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

// The inputs' names, sizes and modification times, hashed.
function fingerprint(opts) {
  const parts = inputFiles(opts).map((f) => { try { const s = statSync(f); return `${f}\t${s.mtimeMs}\t${s.size}`; } catch { return `${f}\t-`; } });
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

// Where an input error is, as desk-q says it: "studia-web lever-evals.jsonl line 214". `repos` are the
// view's, each { slug, name, config }; a file under none of them is named alone.
export function whereOf(error, repos = [], root = autopilotRoot()) {
  if (!error?.file) return error?.message ?? 'an unknown error';
  const r = repos.find((x) => x.config === error.file || error.file.startsWith(`${join(root, x.slug)}${sep}`));
  return `${r ? `${r.name} ` : ''}${basename(error.file)}${error.line ? ` line ${error.line}` : ''}`;
}

// What the last refresh left: the page, the view it was rendered from and build.json's failure.
// `builtAt` is the page's build time in ms, null with no page: the view's, or the page file's own
// time where that is older (a `levers-view build` rewrote view.json without rendering the page).
// `old` says opening it rebuilds it first (older than REBUILD_MS), and `stale` that no supervisor
// has rebuilt it (older than STALE_MS).
export function pageState({ dir = leversDir(), now = Date.now() } = {}) {
  const f = filesIn(dir);
  const view = readJson(f.view);
  const page = existsSync(f.page) ? f.page : null;
  const at = page && view ? Math.min(Date.parse(view.generated_at), statSync(f.page).mtimeMs) : NaN;
  const builtAt = Number.isNaN(at) ? null : at;
  const age = builtAt == null ? Infinity : now - builtAt;
  return { file: f.page, page, view, failed: readJson(f.build)?.failed ?? null, builtAt, old: age > REBUILD_MS, stale: age > STALE_MS };
}

// One refresh. -> { ran: false, why: 'up_to_date' | 'busy' } or { ran: true, ok, line?, where? }.
// Never throws for a failed build: that is recorded, and the caller goes on.
export function refresh({ root = autopilotRoot(), configRoot = deskConfigRoot(), dir = leversDir(root), waitMs = LOCK_WAIT_MS } = {}) {
  const f = filesIn(dir);
  const due = (fp) => {
    const rec = readJson(f.build);
    return !rec || rec.fingerprint !== fp || !(Date.now() - Date.parse(rec.attempted_at) < REBUILD_MS) || (!rec.failed && !existsSync(f.page));
  };
  if (!due(fingerprint({ root, configRoot }))) return { ran: false, why: 'up_to_date' };
  mkdirSync(dir, { recursive: true });
  try { takeDirLock(f.lock, { waitMs }); } catch { return { ran: false, why: 'busy' }; }
  try {
    // Another refresh may have built while this one waited.
    const fp = fingerprint({ root, configRoot });
    if (!due(fp)) return { ran: false, why: 'up_to_date' };
    const t0 = Date.now();
    const attempted = new Date(t0).toISOString();
    const prev = readJson(f.build);
    let view = null;
    const fail = (error) => {
      const where = whereOf(error, view?.repos, root);
      const { failed: _, ...kept } = prev ?? {};
      writeJsonAtomic(f.build, { ...kept, attempted_at: attempted, fingerprint: fp, failed: { at: attempted, error, where } });
      return { ran: true, ok: false, where };
    };
    try {
      view = buildView({ root, configRoot });
      if (view.line.state === 'broken') return fail(view.line.error);
      // The page last, so a write that fails before it leaves the last good page in place.
      const html = renderPage(view);
      writeJsonAtomic(f.view, view);
      writeTextAtomic(f.page, html);
      writeJsonAtomic(f.build, { ...buildRecord(view, Date.now() - t0), attempted_at: attempted, fingerprint: fp });
      return { ran: true, ok: true, line: view.line.state };
    } catch (e) { return fail({ file: null, line: null, message: e.message }); }
  } finally { releaseDirLock(f.lock); }
}

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  let r;
  try { r = refresh(); } catch (e) { r = { ran: true, ok: false, where: e.message }; }
  console.log(JSON.stringify(r));
}
