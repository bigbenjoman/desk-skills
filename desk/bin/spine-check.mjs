// The check pass.mjs runs on a finished feature spine before it parks for the person's approval: one
// spec per criterion id the spine owes, titled with the id, each marked strict expected-fail
// (`test.fail`, `it.fails`, `test.failing`, `@pytest.mark.xfail(strict=True)`), so CI stays green
// and an unexpected pass turns it red. Only the files the spine's branch changed under the spec
// directory count: a spec an earlier epic left there is not this spine's.
// Then the check on each child that owns criteria: its owned specs unmarked and passing, and no other
// child's spec changed (checkChild, below).
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { changedFiles } from './scope-report.mjs';
import { permission, permissionKey } from './desk-env.mjs';

export const EXPECTED_FAIL = 'strict expected-fail (test.fail, it.fails, test.failing, or @pytest.mark.xfail(strict=True))';
// The modifiers a titled JS declaration may carry; `describe`, `step` and the hooks are not tests.
const JS_MODIFIERS = new Set(['fail', 'fails', 'failing', 'only', 'skip', 'concurrent', 'sequential']);
const JS_FAILS = new Set(['fail', 'fails', 'failing']);

// Who merges an approved spine under the batch's merge rules: the merge driver where config §3 grants
// it both rows, else the person. `rows` names the two settings for the message that asks them.
export function spineMerger() {
  const rows = ['autopilot-merge', 'pr-merge-green'].map((id) => `${permissionKey(id)} is "${permission(id)}"`).join(' and ');
  return { driver: permission('autopilot-merge') === 'yes' && permission('pr-merge-green') === 'yes', rows: `config §3 ${rows}` };
}

const mentions = (title, id) => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`, 'i').test(title);

// Where the call whose `(` is at `open` ends: one past its `)`, skipping strings and template
// literals, or the end of the code when it never closes.
function callEnd(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i];
    if (c === '\'' || c === '"' || c === '`') {
      for (i += 1; i < code.length && code[i] !== c; i += 1) if (code[i] === '\\') i += 1;
    } else if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c) && --depth === 0) return i + 1;
  }
  return code.length;
}

// Every titled test declaration in one spec file: { title, expectedFail, why, body }. `body` is the
// whole declaration (with its decorators in Python, comments stripped in JS): a change to that spec
// changes it, and a spec added beside it does not.
export function declarations(path, text) {
  const out = [];
  if (/\.py$/.test(path)) {
    const lines = text.split('\n');
    const indent = (s) => /^\s*/.exec(s)[0].length;
    lines.forEach((line, i) => {
      const m = /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/.exec(line);
      if (!m) return;
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
      // The function runs until the next non-blank line indented no deeper than its def.
      let to = i + 1;
      while (to < lines.length && (!lines[to].trim() || indent(lines[to]) > indent(line))) to += 1;
      const body = lines.slice(from, to).join('\n').trimEnd();
      out.push({ title: m[1], expectedFail: strict, why: xfail && !strict ? 'xfail without strict=True' : null, body });
    });
    return out;
  }
  // A commented-out spec is not one: block comments, and lines that open with //.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re = /\b(?:test|it)((?:\.\w+)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of code.matchAll(re)) {
    const mods = m[1].split('.').filter(Boolean);
    if (!mods.every((x) => JS_MODIFIERS.has(x))) continue;
    const body = code.slice(m.index, callEnd(code, m.index + m[0].indexOf('(')));
    out.push({ title: m[3], expectedFail: mods.some((x) => JS_FAILS.has(x)), why: null, body });
  }
  return out;
}

// Pure: files [{path, text}] and the ids owed -> { ok, problems }.
export function scanSpecs(files, ids) {
  const problems = [];
  for (const id of ids) {
    const hits = files.flatMap((f) => declarations(f.path, f.text).filter((d) => mentions(d.title, id)).map((d) => ({ ...d, path: f.path })));
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
  const fail = (why) => ({ ok: false, problems: [why] });
  if (!Array.isArray(ids) || !ids.length) return fail('the queue records no criterion ids for the spine (spine_ids, set when plan-batch seeds)');
  if (!specDir) return fail('config §4 Acceptance specs names no spec directory');
  if (!worktree || !existsSync(worktree)) return fail(`its worktree ${worktree ?? '(none recorded)'} is gone, so its specs could not be read`);
  const changed = changedFiles(worktree, `origin/${base}`);
  if (!changed) return fail(`could not diff ${worktree} against origin/${base}`);
  const dir = specDir.replace(/^\.\//, '').replace(/\/*$/, '/');
  const files = [];
  for (const path of changed.filter((p) => p.startsWith(dir))) {
    try {
      files.push({ path, text: execFileSync('git', ['-C', worktree, 'show', `HEAD:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) });
    } catch { /* deleted on the branch: not a spec it lands */ }
  }
  if (!files.length) return fail(`its branch changes no spec under ${dir}`);
  return scanSpecs(files, ids);
}

// ---- children: each makes the specs it owns pass and leaves the others alone ----------------------
// The owner table is the queue's `owners` ({<id>: <KEY>}), recorded by plan-batch when it seeds.

const specRoot = (specDir) => specDir.replace(/^\.\//, '').replace(/\/*$/, '/');
const gitShow = (worktree, rev, path) => {
  try { return execFileSync('git', ['-C', worktree, 'show', `${rev}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
};

// How pass.mjs parks a finished child whose check failed.
export const CHILD_SPECS_PREFIX = 'acceptance specs not done';

// The criterion ids a child owns, in the table's order.
export const ownedIds = (owners, key) => Object.keys(owners ?? {}).filter((id) => owners[id] === key);

// The §4 Acceptance specs command with the ids in place of {ids}, as one alternation (`AC1|AC2`), the
// form a test-name pattern (`-t`, `-k`, `--grep`) takes.
export const specsCommand = (cmd, ids) => cmd.split('{ids}').join(ids.join('|'));

// Every spec file under specDir at rev: [{path, text}].
export function specFilesAt(worktree, rev, specDir) {
  let paths = [];
  try {
    paths = execFileSync('git', ['-C', worktree, 'ls-tree', '-r', '--name-only', rev, '--', specRoot(specDir)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
  return paths.map((path) => ({ path, text: gitShow(worktree, rev, path) ?? '' }));
}

// Pure: the spec declarations titled with each id -> [{id, specs: [{path, title, expectedFail}]}].
export function ownedSpecs(files, ids) {
  return ids.map((id) => ({
    id,
    specs: files.flatMap((f) => declarations(f.path, f.text).filter((d) => mentions(d.title, id))
      .map((d) => ({ path: f.path, title: d.title, expectedFail: d.expectedFail }))),
  }));
}

// Pure: a finished child's specs. `head` is every spec file on its branch; `changed` is each spec
// file its branch changed, as [{path, before, after}] (null where the file is absent). Problems: an
// owned id with no spec, an owned spec still marked expected-fail, and any spec the branch added,
// removed or changed whose id another child owns.
export function scanChild({ head, changed, owners, key }) {
  const problems = [];
  for (const { id, specs } of ownedSpecs(head, ownedIds(owners, key))) {
    if (!specs.length) problems.push(`${id}: no spec titled with it`);
    for (const s of specs.filter((x) => x.expectedFail)) problems.push(`${id}: "${s.title}" in ${s.path} is still marked expected-fail`);
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

// A finished child's branch in its worktree, against origin/<base>. `run(ids)` runs the owned specs
// ({ok, out}); it is only called once the markers are clean, so a spec still marked expected-fail is
// named as that rather than as a run that passed.
export function checkChild({ worktree, base, specDir, owners, key, run }) {
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
  const c = scanChild({ head: specFilesAt(worktree, 'HEAD', dir), changed, owners, key });
  if (!c.ok || !run) return c;
  const r = run(ids);
  if (r.ok) return c;
  const tail = String(r.out ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
  return fail(`${ids.join(', ')}: the owned specs fail when run (${r.command ?? 'the §4 Acceptance specs command'})${tail ? `: ${tail}` : ''}`);
}
