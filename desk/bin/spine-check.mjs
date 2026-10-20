// The check pass.mjs runs on a finished feature spine before it parks for the person's approval: one
// spec per criterion id the spine owes, titled with the id, each marked strict expected-fail
// (`test.fail`, `it.fails`, `test.failing`, `@pytest.mark.xfail(strict=True)`), so CI stays green
// and an unexpected pass turns it red. Only the files the spine's branch changed under the spec
// directory count: a spec an earlier epic left there is not this spine's.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { changedFiles } from './scope-report.mjs';
import { permission, permissionKey } from './desk-env.mjs';

const EXPECTED_FAIL = 'strict expected-fail (test.fail, it.fails, test.failing, or @pytest.mark.xfail(strict=True))';
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

// Every titled test declaration in one spec file: { title, expectedFail, why }.
export function declarations(path, text) {
  const out = [];
  if (/\.py$/.test(path)) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const m = /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/.exec(line);
      if (!m) return;
      // The decorators straight above the def, continuation lines included.
      // A commented-out decorator is not one.
      const deco = [];
      for (let j = i - 1; j >= 0; j -= 1) {
        const s = lines[j].trim();
        if (!s || /^(?:async\s+)?(def|class)\b/.test(s)) break;
        if (!s.startsWith('#')) deco.unshift(s);
      }
      const block = deco.join(' ');
      const xfail = /pytest\.mark\.xfail\b/.test(block);
      const strict = /pytest\.mark\.xfail\s*\([^)]*\bstrict\s*=\s*True\b/.test(block);
      out.push({ title: m[1], expectedFail: strict, why: xfail && !strict ? 'xfail without strict=True' : null });
    });
    return out;
  }
  // A commented-out spec is not one: block comments, and lines that open with //.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const re = /\b(?:test|it)((?:\.\w+)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of code.matchAll(re)) {
    const mods = m[1].split('.').filter(Boolean);
    if (!mods.every((x) => JS_MODIFIERS.has(x))) continue;
    out.push({ title: m[3], expectedFail: mods.some((x) => JS_FAILS.has(x)), why: null });
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
