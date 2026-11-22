// §4 Preview database: the repo's recipe that gives a PR adding a migration a database branch and a
// preview of its own, so the PR's evidence is taken against its own migrations rather than a shared
// staging database that does not have them yet. The recipe is commands, one span per step, each
// `<step>: <command>` (config-schema.mjs previewDbStepOf):
//
//   create    make the database branch {db}                  (needed)
//   migrate   apply the PR's migrations to it, from the worktree (needed)
//   seed      load the seed rows into it                     (optional)
//   override  point {branch}'s preview, and only it, at {db} (needed)
//   rebuild   rebuild {branch}'s preview with the override, returning once it serves (needed)
//   delete    remove the override and the database branch   (needed; the pass runs each once the PR
//             merges or closes)
//
// A step may have several items, run in order. {branch} is the PR's git branch, {db} the database
// branch named after it (dbName), {pr} the PR number; each goes in shell-quoted.
//
// The worker runs `up` from its worktree, where §3 worker-preview-db is yes:
//
//   node preview-db.mjs up <branch> <pr>     create, migrate, seed, override and rebuild, in order
//   node preview-db.mjs check <shot dir>     move every shot whose page text is an error page aside;
//                                            a pass is kept on this branch's record at its PR's head,
//                                            and §4 Evidence workflow runs only after one (evidenceHold)
//
// From just before create runs, <state>/preview-db/<pr>.json records { pr, branch, db, repo, at, steps },
// so the pass deletes what was made even where a step failed part-way (teardownCalls, teardown). The
// batch is not idle while a record is left, and is not archived (batch.mjs archiveCheck), so its pass
// keeps running until each is deleted or handed to the person.
import { spawnSync, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIEW_DB_STEPS, previewDbStepOf, isNone } from './config-schema.mjs';
import { MIGRATION_DIR } from './migration-renames.mjs';
import { SCREENSHOT_FILE } from './desk-env.mjs';
import { isPrNumber, ownOpenPrRefusal, readPrView } from './own-pr.mjs';

const UP_STEPS = Object.freeze(['create', 'migrate', 'seed', 'override', 'rebuild']);
const NEEDED = Object.freeze(['create', 'migrate', 'override', 'rebuild', 'delete']);
export const TEARDOWN_TRIES = 3;
const UP_STEP_MS = 15 * 60 * 1000;
export const DELETE_STEP_MS = 2 * 60 * 1000;

// The §4 Preview database row's items (desk-env configValues) as { steps: { <step>: [cmd, …] } } or
// { errors }, or null when it is unset or `none`.
export function parseRecipe(items) {
  if (!items || !items.length || isNone(items)) return null;
  const steps = {};
  const errors = [];
  for (const item of items) {
    const s = previewDbStepOf(item);
    if (!s) { errors.push(`"${String(item).trim()}" is not \`<step>: <command>\` with a step of ${PREVIEW_DB_STEPS.join(', ')} and placeholders only {branch}, {db}, {pr}`); continue; }
    (steps[s.step] ??= []).push(s.cmd);
  }
  const missing = NEEDED.filter((s) => !steps[s]);
  if (missing.length) errors.push(`no ${missing.join(', ')} step`);
  return errors.length ? { errors } : { steps };
}

// The database branch named after git branch `branch`: lowercase letters, digits and dashes, at most
// 63 characters (a Postgres identifier's limit), a longer name ending in a hash of the whole branch so
// two long branches never share one. null for a branch with no letter or digit.
export const DB_NAME_MAX = 63;
export function dbName(branch) {
  const slug = String(branch ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  if (slug.length <= DB_NAME_MAX) return slug;
  const hash = createHash('sha1').update(String(branch)).digest('hex').slice(0, 8);
  return `${slug.slice(0, DB_NAME_MAX - hash.length - 1).replace(/-+$/, '')}-${hash}`;
}

// A value as one shell word: bare where it holds nothing the shell reads, else single-quoted.
export const shellWord = (v) => (/^[A-Za-z0-9._/:@%+=,-]+$/.test(String(v)) ? String(v) : `'${String(v).replace(/'/g, `'\\''`)}'`);
// A recipe command with its placeholders filled; a shell `${…}` is left for the shell.
export const fill = (cmd, vars) => String(cmd).replace(/(?<!\$)\{(branch|db|pr)\}/g, (_, k) => shellWord(vars[k]));

// Whether a PR's added files hold a migration: `added` is `git diff --name-only --diff-filter=A`'s lines.
export const addsMigration = (added) => String(added ?? '').split('\n').some((f) => f.trim() && MIGRATION_DIR.test(f.trim()));

// The worker's `up`. view: gh pr view's { headRefName, state, isCrossRepository } for the PR, or null
// when it could not be read; added: the branch's added files against the default branch; prior: the
// record an earlier `up` for this PR left, whose database is deleted first so this one starts fresh.
// -> { refused } saying why, or { vars, plan: [{ step, cmd }] } with every command filled.
export function upCall({ argv, view, recipe, allowed, added, prior = null }) {
  if (argv.length !== 2) return { refused: 'usage: preview-db.mjs up <branch> <pr>' };
  const [branch, pr] = argv;
  if (!isPrNumber(pr)) return { refused: `"${pr}" is not a PR number` };
  if (!recipe) return { refused: 'no §4 Preview database recipe: the evidence step runs as it does without one' };
  if (recipe.errors) return { refused: `§4 Preview database does not parse: ${recipe.errors.join('; ')}` };
  if (!allowed) return { refused: '§3 worker-preview-db is not yes' };
  const notOwn = ownOpenPrRefusal(branch, pr, view);
  if (notOwn) return { refused: notOwn };
  if (!addsMigration(added)) return { refused: `${branch} adds no migration, so its preview needs no database of its own` };
  const db = dbName(branch);
  if (!db) return { refused: `no database branch name can be made from ${branch}` };
  const vars = { branch, db, pr };
  // Any earlier record, even one whose create failed part-way, may have left a database behind.
  const reset = prior ? recipe.steps.delete.map((cmd) => ({ step: 'delete', cmd: fill(cmd, { branch: prior.branch, db: prior.db, pr: prior.pr }) })) : [];
  return { vars, plan: [...reset, ...UP_STEPS.flatMap((step) => (recipe.steps[step] ?? []).map((cmd) => ({ step, cmd: fill(cmd, vars) })))] };
}

// What a failed command said, for the park that quotes it: the lines naming an error, else its last
// lines, at most three, each cut at 300 characters.
const ERRORISH = /\b(?:error|errors|fatal|failed|failure|denied|forbidden|unauthori[sz]ed|not found|exception|refused|invalid)\b/i;
export function stepError(out) {
  const lines = String(out ?? '').split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim()).filter(Boolean);
  const named = lines.filter((l) => ERRORISH.test(l));
  return (named.length ? named.slice(0, 3) : lines.slice(-3)).map((l) => (l.length > 300 ? `${l.slice(0, 299)}…` : l)).join(' / ') || 'no output';
}

// Runs one command in `cwd` through sh. -> { ok, code, out }.
export function runCommand(cmd, { cwd, timeout }) {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stderr ?? ''}\n${r.stdout ?? ''}`;
  if (r.error) return { ok: false, code: null, out: `${r.error.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeout / 1000)}s` : r.error.message}\n${out}` };
  return { ok: r.status === 0, code: r.status, out };
}

// The records of the preview databases made: [{ file, pr, branch, db, … }], unreadable ones left out.
const recordsDir = (state) => join(state, 'preview-db');
const recordFile = (state, pr) => join(recordsDir(state), `${pr}.json`);
export function readRecords(state) {
  let names = [];
  try { names = readdirSync(recordsDir(state)).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  return names.flatMap((f) => {
    try { return [{ ...JSON.parse(readFileSync(join(recordsDir(state), f), 'utf8')), file: join(recordsDir(state), f) }]; } catch { return []; }
  });
}
// Why §4 Evidence workflow may not run yet for PR `pr` at `head`, or null when it may. The workflow
// writes its shots straight into the PR body, where no error-page check reads them, so for a PR with a
// preview database it runs only once a worker's own capture of its screens passed `check` at this head
// (the record's `checked`): the same preview and database, read for an error page before anything is
// posted. A PR with no preview database is never held.
export function evidenceHold(state, pr, head) {
  const rec = readRecords(state).find((r) => String(r.pr) === String(pr));
  if (!rec) return null;
  if (head && rec.checked?.head === head) return null;
  const at = head ? String(head).slice(0, 9) : 'its head';
  return `#${pr} has a preview database, and no capture of its screens has passed preview-db.mjs check at ${at}: capture them, run \`preview-db.mjs check <shot dir>\` from its worktree, then start the evidence workflow`;
}
// The record after a `check` of its PR's shots at `head`: `checked` set when there were shots, every one
// with its page text and none an error page; cleared otherwise, so a failed check holds the workflow again.
export function checkedRecord(rec, results, head, at) {
  const { checked: _c, ...rest } = rec;
  const passed = !!head && results.length > 0 && results.every((r) => r.call === 'ok');
  return passed ? { ...rest, checked: { head, at, shots: results.length } } : rest;
}
export function writeRecord(state, rec) {
  mkdirSync(recordsDir(state), { recursive: true });
  const { file: _f, ...body } = rec;
  writeFileSync(recordFile(state, rec.pr), `${JSON.stringify(body)}\n`);
}

// `up`'s steps in order, stopping at the first failure. run(cmd) -> { ok, code, out }; record(rec) is
// called before create runs (steps []), since a create that fails or times out part-way may still have
// made the database, and again after each step, so the pass deletes whatever was made. The reset's
// deletes of an earlier record are best-effort: what they could not find is not there to delete.
// -> { ok: true, done } or { ok: false, step, cmd, error, done }.
export function runUp({ call, run, record, repo, now = () => new Date().toISOString() }) {
  const done = [];
  let rec = null;
  const save = () => { rec = { pr: call.vars.pr, branch: call.vars.branch, db: call.vars.db, repo, at: rec?.at ?? now(), steps: [...new Set(done)] }; record(rec); };
  for (const { step, cmd } of call.plan) {
    if (!rec && step !== 'delete') save();
    const r = run(cmd);
    if (step === 'delete') continue;
    if (!r.ok) return { ok: false, step, cmd, code: r.code, error: stepError(r.out), done };
    done.push(step);
    save();
  }
  return { ok: true, done };
}

// ---- the pass: delete each once its PR merges or closes --------------------------------------
// snap: { records, states: { [pr]: 'OPEN' | 'MERGED' | 'CLOSED' | null }, recipe, owed }. A PR whose
// state cannot be read is left until it can be. `owed` holds the PRs the pass closed to start their CI
// and still owes a reopen (queue-store.mjs owesReopen): closed for now, not for good, so their database
// and override stay for the preview the reopen rebuilds.
// -> [{ type: 'teardown', pr, rec, cmds, why }] and [{ type: 'report', list, line }].
export function teardownCalls({ records, states, recipe, owed = [] }) {
  const actions = [];
  const reopens = new Set([...owed].map(String));
  for (const rec of records) {
    const st = states[rec.pr];
    if (st !== 'MERGED' && st !== 'CLOSED') continue;
    if (st === 'CLOSED' && reopens.has(String(rec.pr))) continue;
    const why = `#${rec.pr} ${st.toLowerCase()}`;
    if (!recipe || recipe.errors || !recipe.steps.delete) {
      actions.push({ type: 'report', list: 'failed', line: `preview database ${rec.db} for ${rec.branch} (${why}) is not deleted: §4 Preview database ${recipe?.errors ? `does not parse (${recipe.errors.join('; ')})` : 'has no delete step'}. Delete it and ${rec.branch}'s preview override yourself, then remove ${rec.file}` });
      continue;
    }
    const vars = { branch: rec.branch, db: rec.db, pr: rec.pr };
    actions.push({ type: 'teardown', pr: rec.pr, rec, why, cmds: recipe.steps.delete.map((c) => fill(c, vars)) });
  }
  return actions;
}

// Runs one teardown: every delete command, past a failure, so one that fails leaves the rest done.
// All passing removes the record and logs what was removed to <state>/preview-db/removed.log; a
// failure keeps the record for the next pass, and after TEARDOWN_TRIES moves it to <pr>.failed.json
// for the person. -> { list, line } for the report.
export function teardown(a, { state, run, now = () => new Date().toISOString() }) {
  const ran = a.cmds.map((cmd) => ({ cmd, ...run(cmd) }));
  const failed = ran.filter((r) => !r.ok);
  const what = `preview database ${a.rec.db} and the preview override for ${a.rec.branch} (${a.why})`;
  if (!failed.length) {
    mkdirSync(recordsDir(state), { recursive: true });
    appendFileSync(join(recordsDir(state), 'removed.log'), `${JSON.stringify({ at: now(), pr: a.pr, branch: a.rec.branch, db: a.rec.db, why: a.why, ran: a.cmds })}\n`);
    try { unlinkSync(a.rec.file); } catch { /* gone */ }
    return { list: 'done', line: `removed ${what}: ${a.cmds.map((c) => `\`${c}\``).join(', ')}` };
  }
  const tries = (a.rec.tries ?? 0) + 1;
  const errs = failed.map((r) => `\`${r.cmd}\`: ${stepError(r.out)}`).join('; ');
  if (tries >= TEARDOWN_TRIES) {
    try { renameSync(a.rec.file, a.rec.file.replace(/\.json$/, '.failed.json')); } catch { /* gone */ }
    return { list: 'failed', line: `could not remove ${what} after ${tries} tries: ${errs}. Run the failed commands yourself from the main checkout` };
  }
  writeRecord(state, { ...a.rec, tries, last_error: errs });
  return { list: 'advanced', line: `could not remove ${what} (try ${tries} of ${TEARDOWN_TRIES}, again next pass): ${errs}` };
}

// ---- the error-page check ------------------------------------------------------------------
// A screenshot's page text (`<shot>.txt` beside it, the page's body text the capture saved) that is an
// error page rather than the screen: a framework's crash page, a host's failed function, a server
// error, a not-found page, or a database error naming a table or column the preview's database lacks.
const ERROR_PAGES = [
  /Application error: a (?:server|client)-side exception has occurred/i,
  /Unhandled Runtime Error/,
  /\bInternal Server Error\b/i,
  /\b50[0234]\b[^\n]{0,60}\b(?:Bad Gateway|Service Unavailable|Gateway Time-?out|Server Error)\b/i,
  /\b(?:FUNCTION_INVOCATION_FAILED|FUNCTION_INVOCATION_TIMEOUT|DEPLOYMENT_NOT_FOUND|MIDDLEWARE_INVOCATION_FAILED|INTERNAL_FUNCTION_INVOCATION_FAILED)\b/,
  /This Serverless Function has crashed/i,
  /\b404\b[^\n]{0,60}(?:This page could not be found|Page not found|Not[ _]Found)/i,
  /\bPrismaClient\w*Error\b/,
  /\bThe (?:table|column) `[^`]+` does not exist/,
  /\b(?:relation|column) "[^"]+"(?: of relation "[^"]+")? does not exist/i,
];
// The first line of `text` that marks an error page, or null. A page's body text puts each element on
// a line of its own, so a status and its message ("404", then "This page could not be found.") are
// also read as one line, joined with " | ".
export function errorPageLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    for (const line of [lines[i], i + 1 < lines.length ? `${lines[i]} | ${lines[i + 1]}` : null]) {
      if (line && ERROR_PAGES.some((re) => re.test(line))) return line.slice(0, 200);
    }
  }
  return null;
}

export const REJECTED_DIR = 'error-pages';
// Each shot in `dir` read against its page text: -> [{ shot, call: 'ok' | 'error' | 'no-text', line? }].
export function checkShots(dir) {
  let names = [];
  try { names = readdirSync(dir).filter((f) => SCREENSHOT_FILE.test(f)); } catch { return []; }
  return names.sort().map((shot) => {
    const txt = join(dir, `${basename(shot, extname(shot))}.txt`);
    if (!existsSync(txt)) return { shot, call: 'no-text' };
    const line = errorPageLine(readFileSync(txt, 'utf8'));
    return line ? { shot, call: 'error', line } : { shot, call: 'ok' };
  });
}
// Moves each error-page shot, and its text, into <dir>/error-pages/, where no upload reads it.
export function setAside(dir, results) {
  const bad = results.filter((r) => r.call === 'error');
  if (bad.length) mkdirSync(join(dir, REJECTED_DIR), { recursive: true });
  for (const r of bad) {
    for (const f of [r.shot, `${basename(r.shot, extname(r.shot))}.txt`]) {
      try { renameSync(join(dir, f), join(dir, REJECTED_DIR, f)); } catch { /* gone */ }
    }
  }
  return bad;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const [cmd, ...argv] = process.argv.slice(2);
  const usage = 'usage: preview-db.mjs up <branch> <pr> | check <screenshot dir>';
  if (cmd === 'check') {
    if (argv.length !== 1) { console.error(usage); process.exit(2); }
    const results = checkShots(argv[0]);
    const bad = setAside(argv[0], results);
    const bare = results.filter((r) => r.call === 'no-text');
    for (const r of bad) console.log(`ERROR PAGE ${r.shot}: "${r.line}" (moved to ${join(argv[0], REJECTED_DIR)}/)`);
    for (const r of bare) console.log(`NO TEXT    ${r.shot}: save the page's text beside it as ${basename(r.shot, extname(r.shot))}.txt and check again`);
    if (!results.length) console.log(`no screenshots in ${argv[0]}`);
    else if (!bad.length && !bare.length) console.log(`${results.length} screenshot(s), none an error page`);
    // This worktree's PR, where it has a preview database: the result is kept on its record at the PR's
    // head, which §4 Evidence workflow waits on (evidenceHold).
    const E = await import('./desk-env.mjs');
    const safe = (f) => { try { return f(); } catch { return null; } };
    const branch = safe(() => execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    const state = safe(() => E.stateDir());
    const rec = branch && state ? readRecords(state).find((r) => r.branch === branch) : null;
    if (rec) {
      const view = readPrView(rec.repo ?? safe(E.ghRepo), rec.pr);
      const head = ownOpenPrRefusal(branch, rec.pr, view) ? null : view.headRefOid ?? null;
      const next = checkedRecord(rec, results, head, new Date().toISOString());
      writeRecord(state, next);
      console.log(next.checked
        ? `preview-db: PR #${rec.pr} passed at ${head.slice(0, 9)}, so its evidence workflow may run there`
        : `preview-db: PR #${rec.pr} did not pass${head ? '' : ' (its head could not be read)'}, so its evidence workflow is held until a check passes`);
    }
    process.exit(bad.length || bare.length ? 1 : 0);
  }
  if (cmd !== 'up') { console.error(usage); process.exit(2); }
  const E = await import('./desk-env.mjs');
  const safe = (f) => { try { return f(); } catch { return null; } };
  const repo = safe(E.ghRepo);
  const base = String(safe(() => E.configValue('default-branch')) ?? '').trim() || 'main';
  const view = readPrView(repo, argv[1]);
  const added = safe(() => execFileSync('git', ['diff', '--name-only', '--diff-filter=A', `origin/${base}...HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const call = upCall({
    argv, view, added,
    recipe: parseRecipe(safe(() => E.configValues('preview-db'))),
    allowed: safe(() => E.permission('worker-preview-db')) === 'yes',
    prior: readRecords(E.stateDir()).find((x) => String(x.pr) === argv[1]) ?? null,
  });
  if (call.refused) { console.error(`preview-db.mjs: refused: ${call.refused}`); process.exit(1); }
  const state = E.stateDir();
  const r = runUp({
    call, repo,
    run: (c) => { console.log(`preview-db: ${c}`); return runCommand(c, { cwd: process.cwd(), timeout: UP_STEP_MS }); },
    record: (rec) => writeRecord(state, rec),
  });
  if (!r.ok) {
    console.log(`preview-db: the ${r.step} step failed${r.code != null ? ` (exit ${r.code})` : ''}: ${r.error}`);
    console.log(`PARK: preview database for ${call.vars.branch}: the ${r.step} step (\`${r.cmd}\`) failed: "${r.error}"`);
    console.log(`preview-db: ${call.vars.db} ${r.done.includes('create') ? 'was created' : 'may have been created part-way'}, so the pass runs the delete steps for it once PR #${call.vars.pr} merges or closes`);
    process.exit(1);
  }
  console.log(`preview-db: ${call.vars.db} is ${call.vars.branch}'s preview database (${r.done.join(', ')} done); the pass deletes it and the override once PR #${call.vars.pr} merges or closes`);
}
