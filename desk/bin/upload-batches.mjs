// What upload-images.mjs uploads and how, apart from the browser, so a fake page can drive it.
//
// Only the files the body's `_drag <file>_` cells name are uploaded, found in the screenshot folder or
// any folder under it, at most BATCH_SIZE to a batch. After each batch every image's link is written to
// the tags file beside the folder (<folder>.tags.json) and its cells are filled, so a run that stops
// keeps what it uploaded. A file whose sha256 already has a link is never uploaded again.
//
// A batch that fills no image for STALL_MS is GitHub's rate limit: the run stops there, without
// retrying, and records the stall in the tags file. No run uploads again before its retry_after, which
// is THROTTLE_MS after the first stall in a row and doubles with each further one, to THROTTLE_MAX_MS.
//
//   <folder>.tags.json  { files: { [cell file]: { sha256, url, at } },
//                         throttle: { at, stalls, retry_after } | null }
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { SCREENSHOT_FILE } from './desk-env.mjs';
import { dragFiles, dragCells, swapCells } from './evidence.mjs';

export const BATCH_SIZE = 15;
export const STALL_MS = 180_000;
export const POLL_MS = 1000;
export const THROTTLE_MS = 15 * 60_000;
export const THROTTLE_MAX_MS = 8 * 60 * 60_000;
export const EXIT_THROTTLED = 7;

// A stop with an exit code, for a step that cannot go on (the login gone, the profile in use).
export class UploadStop extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const tagsPath = (dir) => `${String(dir).replace(/\/+$/, '')}.tags.json`;
export function readTags(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { files: {}, throttle: null };
    throw e;
  }
  let t;
  try { t = JSON.parse(text); } catch (e) { throw new UploadStop(1, `${path} is not JSON (${e.message}): fix or remove it, as it holds the links already uploaded`); }
  return { files: t?.files ?? {}, throttle: t?.throttle ?? null };
}
export function writeTags(path, tags) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(tags, null, 2)}\n`);
  renameSync(tmp, path);
}

// Every screenshot file in dir and the folders under it, by its path relative to dir ('/'-separated).
export function shotIndex(dir) {
  const found = new Map();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (SCREENSHOT_FILE.test(e.name)) found.set(relative(dir, p).split(sep).join('/'), p);
    }
  };
  walk(dir);
  return found;
}
// The file a cell names: that path under the folder, else the shallowest file of that name below it.
export function findShot(index, name) {
  if (index.has(name)) return index.get(name);
  const depth = (rel) => rel.split('/').length;
  const hits = [...index.keys()].filter((rel) => basename(rel) === name)
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  return hits.length ? index.get(hits[0]) : null;
}

export const fileSha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
// GitHub's alt for an uploaded file: its name without the extension.
export const altOf = (path) => basename(path).replace(/\.[^.]+$/, '');
export const imageMd = (name, url) => `![${altOf(name)}](${url})`;

// What a run does with the files `cells` name: { reuse: { [name]: url } for files whose sha256 already
// has a link, uploads: [{ sha256, path, names }] one per distinct image, missing: [name] }.
export function planUpload(cells, index, tags, sha = fileSha) {
  const reuse = {};
  const missing = [];
  const bySha = new Map();
  const known = new Map(Object.values(tags.files ?? {}).filter((e) => e?.sha256 && e?.url).map((e) => [e.sha256, e.url]));
  for (const name of cells) {
    const path = findShot(index, name);
    if (!path) { missing.push(name); continue; }
    const h = sha(path);
    if (known.has(h)) reuse[name] = known.get(h);
    else if (bySha.has(h)) bySha.get(h).names.push(name);
    else bySha.set(h, { sha256: h, path, names: [name] });
  }
  return { reuse, uploads: [...bySha.values()], missing };
}

// The uploads in batches of at most `size`, never two of one alt in a batch, as their links are told
// apart by it.
export function batchesOf(uploads, size = BATCH_SIZE) {
  const batches = [];
  let cur = [];
  for (const u of uploads) {
    if (cur.length >= size || cur.some((c) => altOf(c.path) === altOf(u.path))) { batches.push(cur); cur = []; }
    cur.push(u);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ASSET = 'https://github\\.com/user-attachments/assets/';
// The link GitHub wrote into the comment box for the file at `path`, or null while it is still
// uploading. GitHub writes an <img> tag into the textarea's value, or markdown.
export function linkIn(value, path) {
  if (value.includes(`Uploading ${basename(path)}`)) return null;
  const alt = reEsc(altOf(path));
  const m = new RegExp(`<img[^>]*alt="${alt}"[^>]*src="(${ASSET}[^"]+)"`).exec(value)
    ?? new RegExp(`!\\[${alt}\\]\\((${ASSET}[^)\\s]+)\\)`).exec(value);
  return m ? m[1] : null;
}

// One batch through `page` ({ setFiles(paths), value(), clear() }): { got: { [sha256]: url }, stalled }.
// It has stalled once no image has been filled for stallMs.
export async function uploadBatch(page, batch, { stallMs = STALL_MS, pollMs = POLL_MS, now = Date.now, sleep } = {}) {
  await page.setFiles(batch.map((u) => u.path));
  const got = {};
  let last = now();
  let stalled = false;
  for (;;) {
    const value = await page.value();
    let moved = false;
    for (const u of batch) {
      if (got[u.sha256]) continue;
      const url = linkIn(value, u.path);
      if (url) { got[u.sha256] = url; moved = true; }
    }
    if (Object.keys(got).length === batch.length) break;
    if (moved) last = now();
    else if (now() - last >= stallMs) { stalled = true; break; }
    await sleep(pollMs);
  }
  await page.clear();                     // clear, never submit
  return { got, stalled };
}

export const throttleMs = (stalls) => Math.min(THROTTLE_MS * 2 ** Math.max(0, stalls - 1), THROTTLE_MAX_MS);

// The whole run. readBody() and writeBody(text) are the PR body's; openPage() opens the comment box
// (only once there is something to upload). -> { code, lines }, the exit code and what to say.
export async function runUpload({ dir, readBody, writeBody, openPage, log = () => {}, now = Date.now, sleep, stallMs, pollMs, batchSize = BATCH_SIZE }) {
  const cells = dragFiles(readBody());
  if (!cells.length) return { code: 3, lines: ['found no `_drag <file>_` placeholders in the body, so nothing was uploaded'] };
  const path = tagsPath(dir);
  const tags = readTags(path);
  const until = Date.parse(tags.throttle?.retry_after ?? '');
  if (until > now()) {
    return { code: EXIT_THROTTLED, lines: [`throttled: GitHub's rate limit stalled an upload at ${tags.throttle.at} (${tags.throttle.stalls} in a row), so nothing is uploaded before ${tags.throttle.retry_after}`] };
  }

  const plan = planUpload(cells, shotIndex(dir), tags);
  const fill = (fills) => {
    if (!Object.keys(fills).length) return;
    const body = readBody();
    const next = swapCells(body, Object.fromEntries(Object.entries(fills).map(([n, url]) => [n, imageMd(n, url)])));
    if (next !== body) writeBody(next);
  };
  if (Object.keys(plan.reuse).length) {
    log(`${Object.keys(plan.reuse).length} cell(s) get a link already uploaded`);
    fill(plan.reuse);
  }

  const batches = batchesOf(plan.uploads, batchSize);
  const total = plan.uploads.length;
  log(`${total} image(s) to upload in ${batches.length} batch(es) of at most ${batchSize}, from ${dir}`);
  let sent = 0;
  if (batches.length) {
    const page = await openPage();
    for (const [i, batch] of batches.entries()) {
      const { got, stalled } = await uploadBatch(page, batch, { stallMs, pollMs, now, sleep });
      const at = new Date(now()).toISOString();
      const fills = {};
      for (const u of batch) {
        if (!got[u.sha256]) continue;
        for (const n of u.names) { tags.files[n] = { sha256: u.sha256, url: got[u.sha256], at }; fills[n] = got[u.sha256]; }
      }
      sent += Object.keys(got).length;
      if (stalled) {
        const stalls = (tags.throttle?.stalls ?? 0) + 1;
        tags.throttle = { at, stalls, retry_after: new Date(now() + throttleMs(stalls)).toISOString() };
      } else tags.throttle = null;
      writeTags(path, tags);
      fill(fills);
      log(`batch ${i + 1}/${batches.length}: ${Object.keys(got).length} of ${batch.length} uploaded (${sent}/${total})`);
      if (stalled) {
        const waiting = batch.filter((u) => !got[u.sha256]).map((u) => u.names[0]);
        return { code: EXIT_THROTTLED, lines: [
          `throttled: batch ${i + 1} filled no image for ${Math.round((stallMs ?? STALL_MS) / 1000)}s (still waiting on ${waiting.join(', ')}), which is GitHub's rate limit, so it stopped without retrying`,
          `${sent} image(s) uploaded this run are in ${path} and their cells are filled; nothing is uploaded before ${tags.throttle.retry_after}`,
          ...(plan.missing.length ? [missingLine(dir, plan.missing)] : []),
        ] };
      }
    }
  }

  const after = readBody();
  const live = (after.match(/user-attachments\/assets/g) ?? []).length;
  const left = dragCells(after);
  return { code: left ? 4 : 0, lines: [
    `done: ${live} image(s) in the body, ${left} placeholder(s) left`,
    ...(plan.missing.length ? [missingLine(dir, plan.missing)] : []),
  ] };
}
const missingLine = (dir, missing) => `not in ${dir} or a folder under it, so their cells are left: ${missing.join(', ')}`;
