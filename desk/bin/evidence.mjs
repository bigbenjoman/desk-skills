// §4 Evidence workflow: the repo's own workflow that takes a PR's screenshots and writes them into its
// body, in place of the `_drag <file>_` cells a worker leaves when it cannot take them itself. Where no
// such workflow fills them, cells whose file was never taken go to a capture worker (missingShots). The pass
// starts it for a draft PR whose body still has those cells and carries a fenced ```evidence block
// (undraft.mjs evidenceCall decides when), as `gh workflow run <file> --ref <default branch> -f pr=<n>`:
// the workflow runs the default branch's code and reads the PR number alone, so a worker's branch can
// change neither. Once per PR head:
//
//   <dir>/<n>-<head>.json   { workflow, runId, url, at }, written as it is started
//
// The run is read back by its id (gh workflow run prints the run's URL). A run whose id was not
// printed is read as done once DISPATCH_GRACE_MS has passed, so its cells are the person's from then.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DISPATCH_GRACE_MS = 30 * 60 * 1000;

const file = (dir, n, head) => join(dir, `${n}-${head}.json`);
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// The §4 Evidence workflow row's items (desk-env configValues) as { workflow } or { errors }, or null
// when it is unset or `none`. One item: the workflow's file name.
export function parseEvidenceRow(items) {
  if (!items || !items.length) return null;
  if (items.length === 1 && /^none$/i.test(items[0].trim())) return null;
  const errors = [];
  if (items.length > 1) errors.push(`${items.length} items, want one`);
  const wf = items[0].trim();
  if (!/^[\w.-]+\.ya?ml$/.test(wf)) errors.push(`\`${wf}\` is not a workflow file name`);
  return errors.length ? { errors } : { workflow: wf };
}

// A body the evidence workflow can fill: `_drag <file>_` cells left, and a fenced ```evidence block
// saying what to shoot.
// A cell is never inside a code span or a fenced block: a body that writes `_drag <file>_` there is
// describing the cell, not leaving one (DS-381).
const outsideCode = (body) => String(body ?? '').replace(/^[ \t]*(```|~~~)[^]*?^[ \t]*\1[^\n]*$/gm, '').replace(/(`+)[^`]*?\1/g, '');
export const dragCells = (body) => (outsideCode(body).match(/_drag \S+_/g) ?? []).length;
export const hasEvidenceBlock = (body) => /^\s*```evidence\b/m.test(String(body ?? ''));
// The files a body's `_drag <file>_` cells name, once each, in the order they first appear.
export const dragFiles = (body) => [...new Set([...outsideCode(body).matchAll(/_drag (\S+)_/g)].map((m) => m[1]))];
// The files a body's cells name that `shots` (the file names in the ticket's screenshot directory)
// does not hold: screenshots nobody took, which a capture try (fix-tries.mjs captureTry) takes.
export const missingShots = (body, shots) => dragFiles(body).filter((f) => !(shots ?? []).includes(f));

// The run id in gh workflow run's output (it prints the run's URL), or null.
export function runIdFrom(out) {
  const m = String(out ?? '').match(/\/actions\/runs\/(\d+)/);
  return m ? m[1] : null;
}

export function recordDispatch(dir, n, head, { workflow, out, at = new Date().toISOString() }) {
  mkdirSync(dir, { recursive: true });
  const runId = runIdFrom(out);
  const url = runId ? String(out).match(/https:\S+\/actions\/runs\/\d+/)?.[0] ?? null : null;
  const rec = { workflow, runId, url, at };
  writeFileSync(file(dir, n, head), `${JSON.stringify(rec)}\n`);
  return rec;
}

// The run started for PR n at head, or null when none was: { state: 'running' | 'done', conclusion,
// url, workflow }. view(runId) reads the run ({ status, conclusion } from gh run view, or null when
// it cannot be read, which reads as still running).
export function evidenceRecord(dir, n, head, view, now = Date.now()) {
  if (!head) return null;
  const rec = readJson(file(dir, n, head));
  if (!rec) return null;
  const base = { workflow: rec.workflow, url: rec.url ?? null };
  if (!rec.runId) {
    const done = now - Date.parse(rec.at) >= DISPATCH_GRACE_MS;
    return { ...base, state: done ? 'done' : 'running', conclusion: done ? 'unknown (its run id was not printed)' : null };
  }
  const r = view?.(rec.runId) ?? null;
  if (!r || r.status !== 'completed') return { ...base, state: 'running', conclusion: null };
  return { ...base, state: 'done', conclusion: r.conclusion ?? 'unknown' };
}
