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
export const specsCommand = (cmd, id) => cmd.split('{ids}').join(id);

// Every spec file under specDir at rev: [{path, text}].
export function specFilesAt(worktree, rev, specDir) {
  let paths = [];
  try {
    paths = execFileSync('git', ['-C', worktree, 'ls-tree', '-r', '--name-only', rev, '--', specRoot(specDir)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean);
  } catch { return []; }
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

// A finished child's branch in its worktree, against origin/<base>. `run(id)` runs one owned id's
// specs ({ok, out, command}); it is only called once the markers are clean, so a spec still marked
// expected-fail is named as that rather than as a run that passed.
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
  const head = specFilesAt(worktree, 'HEAD', dir);
  const c = scanChild({ head, changed, owners, key });
  if (!c.ok) return c;
  const problems = [];
  for (const { id, specs } of ownedSpecs(head, ids)) {
    const r = run(id);
    if (r.ok) continue;
    const named = specs.map((s) => `"${s.title}" in ${s.path}`).join(', ');
    const tail = String(r.out ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    problems.push(`${id}: ${named} fails when run (${r.command ?? 'the §4 Acceptance specs command'})${tail ? `: ${tail}` : ''}`);
  }
  return { ok: problems.length === 0, problems };
}
