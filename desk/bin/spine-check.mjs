// The check pass.mjs runs on a finished feature spine before it parks for the person's approval: one
// spec per criterion id the spine owes, titled with the id, each marked strict expected-fail
// (`test.fail`, `it.fails`, `test.failing`, `@pytest.mark.xfail(strict=True)`), so CI stays green
// and an unexpected pass turns it red. Only the files the spine's branch changed under the spec
// directory count: a spec an earlier epic left there is not this spine's.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { changedFiles } from './scope-report.mjs';

const EXPECTED_FAIL = 'strict expected-fail (test.fail, it.fails, test.failing, or @pytest.mark.xfail(strict=True))';
// The modifiers a titled JS declaration may carry; `describe`, `step` and the hooks are not tests.
const JS_MODIFIERS = new Set(['fail', 'fails', 'failing', 'only', 'skip', 'concurrent', 'sequential']);
const JS_FAILS = new Set(['fail', 'fails', 'failing']);

// The criterion ids the spine owes a spec for: the queue's `spine_ids` (plan-batch records them at
// seed), else every criterion of the epic that is not left to the close-out check.
export function spineIds(q, stateDir) {
  if (Array.isArray(q?.spine_ids)) return q.spine_ids;
  try {
    const exp = JSON.parse(readFileSync(join(stateDir, 'expansion.json'), 'utf8'));
    const plan = JSON.parse(readFileSync(join(stateDir, 'feature.json'), 'utf8'));
    if (!Array.isArray(exp.criteria) || (q?.epic && exp.parent !== q.epic)) return null;
    return exp.criteria.map((c) => c.id).filter((id) => plan.owners?.[id] || !plan.untestable?.[id]);
  } catch { return null; }
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
      const deco = [];
      for (let j = i - 1; j >= 0; j -= 1) {
        const s = lines[j].trim();
        if (!s || /^(?:async\s+)?(def|class)\b/.test(s)) break;
        deco.unshift(s);
      }
      const block = deco.join(' ');
      const xfail = /pytest\.mark\.xfail\b/.test(block);
      const strict = /pytest\.mark\.xfail\s*\([^)]*\bstrict\s*=\s*True\b/.test(block);
      out.push({ title: m[1], expectedFail: strict, why: xfail && !strict ? 'xfail without strict=True' : null });
    });
    return out;
  }
  const re = /\b(?:test|it)((?:\.\w+)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of text.matchAll(re)) {
    const mods = m[1].split('.').filter(Boolean);
    if (!mods.every((x) => JS_MODIFIERS.has(x))) continue;
    out.push({ title: m[3], expectedFail: mods.some((x) => JS_FAILS.has(x)), why: null });
  }
  return out;
}

// Pure: files [{path, text}] and the ids owed -> { ok, problems, specs: {id: [path]} }.
export function scanSpecs(files, ids) {
  const problems = [];
  const specs = {};
  for (const id of ids) {
    const hits = files.flatMap((f) => declarations(f.path, f.text).filter((d) => mentions(d.title, id)).map((d) => ({ ...d, path: f.path })));
    if (!hits.length) { problems.push(`${id}: no spec titled with it`); continue; }
    specs[id] = [...new Set(hits.map((h) => h.path))];
    for (const h of hits.filter((x) => !x.expectedFail)) {
      problems.push(`${id}: "${h.title}" in ${h.path} is not marked ${h.why ? `strict expected-fail (${h.why})` : EXPECTED_FAIL}`);
    }
  }
  return { ok: problems.length === 0, problems, specs };
}

// The spine's branch in its worktree, against origin/<base>: the specs it changed under specDir.
export function checkSpine({ worktree, base, specDir, ids }) {
  const fail = (why) => ({ ok: false, problems: [why], specs: {} });
  if (!Array.isArray(ids) || !ids.length) return fail('the batch records no criterion ids for the spine (spine_ids on the queue, or expansion.json and feature.json)');
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
