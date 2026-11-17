#!/usr/bin/env node
// Keeps the Levers page current: builds the view model and renders the page under one machine-wide
// lock, and skips both while no input has changed and the last attempt is under REBUILD_MS old. A
// build that throws, or whose desk-q line reads broken, leaves the last good view.json and index.html
// in place and records the error in build.json under `failed`.
//
//   node levers-refresh.mjs        one refresh; prints its result as one JSON line, and exits 0
//
//   import { refresh, pageState, whereOf, REBUILD_MS } from './levers-refresh.mjs'
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deskConfigRoot } from './desk-env.mjs';
import { autopilotRoot, buildRecord, buildView, inputFiles, leversDir } from './levers-view.mjs';
import { renderPage } from './levers-page.mjs';
import { releaseDirLock, takeDirLock } from './dir-lock.mjs';

// A page older than this is rebuilt whatever its inputs, so the ages it shows stay current.
export const REBUILD_MS = 10 * 60 * 1000;
// How long a refresh waits for another one's build before leaving the page to it.
export const LOCK_WAIT_MS = 10_000;

const filesIn = (dir) => ({ page: join(dir, 'index.html'), view: join(dir, 'view.json'), build: join(dir, 'build.json'), lock: join(dir, 'build.lock') });
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const writeAtomic = (file, text) => { writeFileSync(`${file}.tmp`, text); renameSync(`${file}.tmp`, file); };
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

// The inputs' names, sizes and modification times, hashed.
export function fingerprint(opts) {
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

// What the last refresh left: the page, the view it was rendered from, build.json, and whether the
// page is older than REBUILD_MS. `builtAt` is the page's build time in ms, null with no page.
export function pageState({ dir = leversDir(), now = Date.now() } = {}) {
  const f = filesIn(dir);
  const view = readJson(f.view);
  const record = readJson(f.build);
  const page = existsSync(f.page) ? f.page : null;
  const at = page && view ? Date.parse(view.generated_at) : NaN;
  const builtAt = Number.isNaN(at) ? null : at;
  return { dir, file: f.page, page, view, record, failed: record?.failed ?? null, builtAt, stale: builtAt == null || now - builtAt > REBUILD_MS };
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
      writeAtomic(f.build, json({ ...kept, attempted_at: attempted, fingerprint: fp, failed: { at: attempted, error, where } }));
      return { ran: true, ok: false, where };
    };
    try {
      view = buildView({ root, configRoot });
      if (view.line.state === 'broken') return fail(view.line.error);
      // The page first, so a write that fails leaves the view and the page it was drawn from.
      writeAtomic(f.page, renderPage(view));
      writeAtomic(f.view, json(view));
      writeAtomic(f.build, json({ ...buildRecord(view, Date.now() - t0), attempted_at: attempted, fingerprint: fp }));
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
