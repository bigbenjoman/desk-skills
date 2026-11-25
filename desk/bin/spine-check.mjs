// The check pass.mjs runs on a finished feature spine before it parks for the person's approval: one
// spec per criterion id the spine owes, titled with the id, each marked strict expected-fail
// (`test.fail`, `it.fails`, `test.failing`, `@pytest.mark.xfail(strict=True)`), so CI stays green
// and an unexpected pass turns it red. Only the files the spine's branch changed under the spec
// directory count: a spec an earlier epic left there is not this spine's.
// Then the check on each child that owns criteria: its owned specs unmarked and passing, and no other
// child's spec changed (checkChild, below). A child's specs, like the base gate's, are the batch's
// own (batchSpecPaths): another epic's in the same directory, titled with the same id, never count.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { changedFiles } from './scope-report.mjs';
import { mergeGrant, parseCommandItem } from './desk-env.mjs';
import { runItem } from './baseline.mjs';

export const EXPECTED_FAIL = 'strict expected-fail (test.fail, it.fails, test.failing, or @pytest.mark.xfail(strict=True))';
// The modifiers a titled JS declaration may carry; `describe`, `step` and the hooks are not tests.
const JS_MODIFIERS = new Set(['fail', 'fails', 'failing', 'only', 'skip', 'concurrent', 'sequential']);
const JS_FAILS = new Set(['fail', 'fails', 'failing']);

// Who merges an approved spine under the batch's merge rules: the merge driver where config §3, or the
// batch's Stage 3 approval, lets it merge (mergeGrant), else the person. `rows` says why, for the message.
export function spineMerger(q) {
  const g = mergeGrant(q);
  return { driver: g.by != null, rows: g.why };
}

const mentions = (title, id) => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(title);

const specRoot = (specDir) => specDir.replace(/^\.\//, '').replace(/\/*$/, '/');
const gitShow = (worktree, rev, path) => {
  try { return execFileSync('git', ['-C', worktree, 'show', `${rev}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};

// Where the call whose `(` is at `open` ends: one past its `)`, skipping strings, template literals,
// comments and regex literals, or the end of the code when it never closes.
function callEnd(code, open) {
  let depth = 0;
  let prev = '';  // the last character that was code, for telling a regex from a division
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '\'' || c === '"' || c === '`') {
      for (i += 1; i < code.length && code[i] !== c; i += 1) if (code[i] === '\\') i += 1;
    } else if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 1;
      continue;
    } else if (c === '/' && (!prev || '(,=:[!&|?{};'.includes(prev))) {
      for (let cls = false, j = i + 1; j < code.length && code[j] !== '\n'; j += 1) {
        if (code[j] === '\\') j += 1;
        else if (code[j] === '[') cls = true;
        else if (code[j] === ']') cls = false;
        else if (code[j] === '/' && !cls) { i = j; break; }
      }
    } else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c) && --depth === 0) return i + 1;
    if (!/\s/.test(c)) prev = c;
  }
  return code.length;
}

// Every titled test declaration in one spec file: { title, expectedFail, why, held, body }.
// `expectedFail` is the spine's strict marker; `held` is any marker that keeps a spec from having to
// pass (expected-fail of any kind, or skipped), which a child that owns it must have removed. `body`
// is the whole declaration (with its decorators in Python, comments stripped in JS): a change to that
// spec changes it, and a spec added beside it does not.
export function declarations(path, text) {
  const out = [];
  if (/\.py$/.test(path)) {
    const lines = text.split('\n');
    const indent = (s) => /^\s*/.exec(s)[0].length;
    // The line a def's signature closes on: where its parentheses balance again, strings and comments
    // skipped. A formatter wraps a long one, with `):` back at the def's indent.
    const sigEnd = (i) => {
      let depth = 0;
      for (let k = i; k < lines.length; k += 1) {
        const l = lines[k];
        for (let c = 0; c < l.length && l[c] !== '#'; c += 1) {
          if (l[c] === '\'' || l[c] === '"') { const q = l[c]; for (c += 1; c < l.length && l[c] !== q; c += 1) if (l[c] === '\\') c += 1; }
          else if (l[c] === '(') depth += 1;
          else if (l[c] === ')' && --depth === 0) return k;
        }
      }
      return i;
    };
    const defs = [];
    lines.forEach((line, i) => {
      const m = /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/.exec(line);
      if (m) defs.push({ i, m });
    });
    defs.forEach(({ i, m }, n) => {
      const line = lines[i];
      // The decorators straight above the def, continuation lines included.
      // A commented-out decorator is not one.
      const deco = [];
      let from = i;
      for (let j = i - 1; j >= 0; j -= 1) {
        const s = lines[j].trim();
        if (!s || /^(?:async\s+)?(def|class)\b/.test(s)) break;
        from = j;
        if (!s.startsWith('#')) deco.unshift(s);
      }
      const block = deco.join(' ');
      const xfail = /pytest\.mark\.xfail\b/.test(block);
      const strict = /pytest\.mark\.xfail\s*\([^)]*\bstrict\s*=\s*True\b/.test(block);
      const skip = /pytest\.mark\.skip(if)?\b/.test(block);
      // The function runs on from its signature until the next non-blank line indented no deeper than
      // its def, and never into the next test's def at its own depth or shallower (one nested inside
      // it is part of its body).
      let to = sigEnd(i) + 1;
      const next = defs.slice(n + 1).find((d) => indent(lines[d.i]) <= indent(line))?.i ?? lines.length;
      while (to < next && (!lines[to].trim() || indent(lines[to]) > indent(line))) to += 1;
      const body = lines.slice(from, to).join('\n').trimEnd();
      out.push({
        title: m[1], expectedFail: strict, why: xfail && !strict ? 'xfail without strict=True' : null,
        held: xfail ? 'marked expected-fail' : skip ? 'skipped' : null, body,
      });
    });
    return out;
  }
  // A commented-out spec is not one: block comments, and lines that open with //.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re = /\b(?:test|it)((?:\.\w+)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  const found = [];
  for (const m of code.matchAll(re)) {
    const mods = m[1].split('.').filter(Boolean);
    if (mods.every((x) => JS_MODIFIERS.has(x))) found.push({ m, mods });
  }
  found.forEach(({ m, mods }, k) => {
    // Never past the next declaration, so a call it misreads cannot take a sibling spec into its body.
    const end = Math.min(callEnd(code, m.index + m[0].indexOf('(')), found[k + 1]?.m.index ?? code.length);
    const expectedFail = mods.some((x) => JS_FAILS.has(x));
    out.push({
      title: m[3], expectedFail, why: null,
      held: expectedFail ? 'marked expected-fail' : mods.includes('skip') ? 'skipped' : null, body: code.slice(m.index, end).trimEnd(),
    });
  });
  return out;
}

// Pure: the spec declarations titled with each id -> [{id, specs: [{...declaration, path}]}].
export function ownedSpecs(files, ids) {
  return ids.map((id) => ({
    id,
    specs: files.flatMap((f) => declarations(f.path, f.text).filter((d) => mentions(d.title, id)).map((d) => ({ ...d, path: f.path }))),
  }));
}

// Pure: files [{path, text}] and the ids owed -> { ok, problems }.
export function scanSpecs(files, ids) {
  const problems = [];
  for (const { id, specs: hits } of ownedSpecs(files, ids)) {
    if (!hits.length) { problems.push(`${id}: no spec titled with it`); continue; }
    for (const h of hits.filter((x) => !x.expectedFail)) {
      problems.push(`${id}: "${h.title}" in ${h.path} is not marked ${h.why ? `strict expected-fail (${h.why})` : EXPECTED_FAIL}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// The spine's branch in its worktree, against origin/<base>: the specs it changed under specDir. The
// ids are the queue's `spine_ids`, which plan-batch records with the spine when it seeds.
export function checkSpine({ worktree, base, specDir, ids }) {
  if (!Array.isArray(ids) || !ids.length) return { ok: false, problems: ['the queue records no criterion ids for the spine (spine_ids, set when plan-batch seeds)'] };
  const { files, problem } = spineSpecFiles({ worktree, base, specDir });
  return problem ? { ok: false, problems: [problem] } : scanSpecs(files, ids);
}

// The spec files the spine's branch lands under specDir, at its HEAD: { files: [{path, text}] }, or
// { problem } naming why they could not be read.
export function spineSpecFiles({ worktree, base, specDir }) {
  if (!specDir) return { problem: 'config §4 Acceptance specs names no spec directory' };
  if (!worktree || !existsSync(worktree)) return { problem: `its worktree ${worktree ?? '(none recorded)'} is gone, so its specs could not be read` };
  const changed = changedFiles(worktree, `origin/${base}`);
  if (!changed) return { problem: `could not diff ${worktree} against origin/${base}` };
  const dir = specRoot(specDir);
  // A file deleted on the branch reads as null: not a spec it lands.
  const files = changed.filter((p) => p.startsWith(dir)).map((path) => ({ path, text: gitShow(worktree, 'HEAD', path) })).filter((f) => f.text != null);
  return files.length ? { files } : { problem: `its branch changes no spec under ${dir}` };
}

// ---- children: each makes the specs it owns pass and leaves the others alone ----------------------
// The owner table is the queue's `owners` ({<id>: <KEY>}), recorded by plan-batch when it seeds.

// How pass.mjs parks a finished child whose check failed.
export const CHILD_SPECS_PREFIX = 'acceptance specs not done';

// The criterion ids a child owns, in the table's order.
export const ownedIds = (owners, key) => Object.keys(owners ?? {}).filter((id) => owners[id] === key);

// The §4 Acceptance specs command for one id, in place of {ids}. One id per run: runners join several
// differently (a regex alternation for `-t` and `--grep`, `or` for pytest's `-k`).
// With `scope` ({ dir, specDir, files }), the run takes only those spec files (repo paths), so another
// epic's spec titled with the same id never runs: they go in place of `{files}` where the command has
// it, else in place of the spec directory where the command names it (as `dir` sees it, e.g.
// `specs-it/acceptance` for `packages/app/specs-it/acceptance/` run in packages/app). A command naming
// neither, or no files, is left as it is.
export function specsCommand(cmd, id, scope = null) {
  const c = cmd.split('{ids}').join(id);
  const files = scope?.files?.length ? scope.files : null;
  if (!files) return c;
  const dir = scope.dir && scope.dir !== '.' ? scope.dir.replace(/\/+$/, '') : '.';
  const list = [...new Set(files)].map((f) => shellWord(dir === '.' ? f : posix.relative(dir, f))).join(' ');
  if (c.includes('{files}')) return c.split('{files}').join(list);
  if (!scope.specDir) return c;
  const root = specRoot(scope.specDir).replace(/\/$/, '');
  const rel = dir === '.' ? root : posix.relative(dir, root);
  if (!rel || rel.startsWith('..')) return c;
  const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\s)(?:\\./)?${esc}/?(?=\\s|$)`);
  return re.test(c) ? c.replace(re, (_, pre) => `${pre}${list}`) : c;
}
// One argument for `sh -c`, quoted where it holds anything but a path's plain characters.
const shellWord = (w) => (/^[A-Za-z0-9_./@%+=:,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

// The row's command item for one id, read as every §4 command item is (`packages/app: <cmd>` runs in
// packages/app): { dir, cmd } with {ids} replaced, and `label`, the item as the config writes it.
// `scope` ({ specDir, files }) narrows the run to those files, as specsCommand says.
export function specsRun(item, id, scope = null) {
  const { dir, cmd } = parseCommandItem(item);
  const c = specsCommand(cmd, id, scope ? { ...scope, dir } : null);
  return { dir, cmd: c, label: dir === '.' ? c : `${dir}: ${c}` };
}

// One id's specs, under the test lock, in the item's directory of the worktree at `root`.
// -> runItem's { out, code, stopped }, plus ok and the command run.
export function runSpecs({ bin, root, item, id, timeout, scope = null }) {
  const { dir, cmd, label } = specsRun(item, id, scope);
  const r = runItem({ bin, root, dir, cmd, lock: 'test', timeout });
  return { ...r, ok: r.code === 0, command: label };
}

// The spec files that are this batch's own: every file under specDir its base changed against the
// default branch it was cut from (`source`), which is the spine's specs and whatever its children
// have added there since, plus any the worktree's HEAD changed against the base. Several epics' specs
// share one acceptance directory, and their criterion ids repeat (every epic has a DoD5), so a child
// is held to, and runs, only these. `base` is the base's branch; `baseRef` the commit standing for
// it (origin's, unless the worktree is the base's own). -> sorted repo paths, or null where there is
// no separate base or it changed nothing there: then every spec under specDir is the batch's, as in
// a repo whose directory holds one epic's specs.
export function batchSpecPaths({ worktree, source, base, specDir, baseRef = base ? `origin/${base}` : null }) {
  if (!worktree || !specDir || !source || !base || source === base) return null;
  const dir = specRoot(specDir);
  const diff = (range) => {
    try {
      return execFileSync('git', ['-C', worktree, 'diff', '--name-only', range, '--', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n').filter(Boolean);
    } catch { return null; }
  };
  const ofBase = diff(`origin/${source}...${baseRef}`);
  if (!ofBase?.length) return null;
  const ofBranch = baseRef === 'HEAD' ? [] : diff(`${baseRef}...HEAD`) ?? [];
  return [...new Set([...ofBase, ...ofBranch])].filter((p) => p.startsWith(dir)).sort();
}

// The run scope for one id's specs: only the files they are in, once the batch's own are known.
export const idScope = (specDir, paths, specs) => (paths ? { specDir, files: [...new Set(specs.map((s) => s.path))] } : null);

// Every spec file under specDir at rev: [{path, text}]. With `only` (batchSpecPaths), just those.
export function specFilesAt(worktree, rev, specDir, only = null) {
  let paths = [];
  try {
    paths = execFileSync('git', ['-C', worktree, 'ls-tree', '-r', '--name-only', rev, '--', specRoot(specDir)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
  if (only) { const keep = new Set(only); paths = paths.filter((p) => keep.has(p)); }
  return paths.map((path) => ({ path, text: gitShow(worktree, rev, path) ?? '' }));
}

// Pure: a finished child's specs. `head` is every spec file on its branch; `changed` is each spec
// file its branch changed, as [{path, before, after}] (null where the file is absent). Problems: an
// owned id with no spec, an owned spec still marked expected-fail (strict or not) or skipped, and any
// spec the branch added, removed or changed whose id another child owns.
export function scanChild({ head, changed, owners, key }) {
  const problems = [];
  for (const { id, specs } of ownedSpecs(head, ownedIds(owners, key))) {
    if (!specs.length) problems.push(`${id}: no spec titled with it`);
    for (const s of specs.filter((x) => x.held)) problems.push(`${id}: "${s.title}" in ${s.path} is still ${s.held}`);
  }
  const others = Object.keys(owners ?? {}).filter((id) => owners[id] !== key);
  for (const { path, before, after } of changed) {
    const was = before == null ? [] : declarations(path, before);
    const now = after == null ? [] : declarations(path, after);
    const bodies = (ds, title) => ds.filter((d) => d.title === title).map((d) => d.body).join('\n');
    for (const title of new Set([...was, ...now].map((d) => d.title))) {
      if (bodies(was, title) === bodies(now, title)) continue;
      for (const id of others.filter((x) => mentions(title, x))) {
        problems.push(`"${title}" in ${path} is ${id}'s spec, owned by ${owners[id]}: ${key} changed it`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// A finished child's branch in its worktree, against origin/<base>. Its owned specs are found among
// the batch's own (batchSpecPaths, with `source` the default branch the base was cut from), never
// another epic's titled with the same id. `run(id, scope)` runs one owned id's specs
// ({ok, out, command}), `scope` narrowing the run to their files (null: the command as configured);
// it is only called once the markers are clean, so a spec still marked expected-fail is named as that
// rather than as a run that passed.
export function checkChild({ worktree, base, source = null, specDir, owners, key, run }) {
  const fail = (why) => ({ ok: false, problems: [why] });
  const ids = ownedIds(owners, key);
  if (!specDir) return fail('config §4 Acceptance specs names no spec directory');
  if (!worktree || !existsSync(worktree)) return fail(`its worktree ${worktree ?? '(none recorded)'} is gone, so its specs could not be read`);
  const changedAll = changedFiles(worktree, `origin/${base}`);
  let mergeBase = null;
  try { mergeBase = execFileSync('git', ['-C', worktree, 'merge-base', 'HEAD', `origin/${base}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* below */ }
  if (!changedAll || !mergeBase) return fail(`could not diff ${worktree} against origin/${base}`);
  const dir = specRoot(specDir);
  const changed = changedAll.filter((p) => p.startsWith(dir))
    .map((path) => ({ path, before: gitShow(worktree, mergeBase, path), after: gitShow(worktree, 'HEAD', path) }));
  const mine = batchSpecPaths({ worktree, source, base, specDir: dir });
  const head = specFilesAt(worktree, 'HEAD', dir, mine);
  const c = scanChild({ head, changed, owners, key });
  if (!c.ok) return c;
  const problems = [];
  for (const { id, specs } of ownedSpecs(head, ids)) {
    const r = run(id, idScope(dir, mine, specs));
    if (r.ok) continue;
    const named = specs.map((s) => `"${s.title}" in ${s.path}`).join(', ');
    const tail = String(r.out ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    problems.push(`${id}: ${named} fails when run (${r.command ?? 'the §4 Acceptance specs command'})${tail ? `: ${tail}` : ''}`);
  }
  return { ok: problems.length === 0, problems };
}
