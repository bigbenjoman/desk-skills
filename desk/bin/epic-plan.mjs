// An epic admitted with no session (/desk-admit, standing intake): its feature batch is started
// beside the standing batch and handed to the supervisor, its children are triaged there, its plan
// (the spine and the owner table, in feature mode) is drafted headless, and the plan goes to the
// person as one needs-you item. The batch then waits: the epic is parked in it with a feature-plan
// park, and every child is admitted held behind the epic, so nothing spawns until it is answered.
//
// startEpic is the /desk-autopilot epic flow's Stages 0 to 2 (desk-autopilot's epic-batch.md and
// feature-mode.md) with the person's plan approval moved to needs-you. Anything that fails before the
// batch is handed over discards it (batch.mjs discard), so a refusal leaves nothing behind.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { FEATURE_PLAN_PREFIX, readQueue } from './batch-state.mjs';
import { listBatches } from './batches.mjs';
import { markedResult } from './decider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DRAFT_TIMEOUT_MS = 10 * 60 * 1000;
export const DRAFT_BUDGET_USD = 3;
export const RESULT_MARK = 'PLAN_RESULT:';
// The epic's queue lane: no headless worker takes it (queue.mjs requeue refuses any lane but A, B, D, E).
export const EPIC_LANE = 'epic';
// The longest epic or child text the drafter is given, each.
const TEXT_MAX = 8000;

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const lastLine = (r) => `${r.stderr ?? ''}${r.stdout ?? ''}${r.error?.message ?? ''}`.trim().split('\n').pop() || `exited ${r.status ?? r.signal}`;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The environment that points queue.mjs, triage.sh, expand-parent and plan-batch at batch `epic`.
function batchEnv(epic) {
  const { DESK_DEFAULT_BRANCH: _pinned, DESK_QUEUE: _q, DESK_AUTOPILOT_STATE: _s, ...env } = process.env;
  const p = E.batchPaths(E.repoSlug(), epic);
  return { ...env, DESK_BATCH: epic, DESK_QUEUE: p.queue, DESK_AUTOPILOT_STATE: p.state };
}
const run = (cmd, args, env, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env, maxBuffer: 64 << 20, ...opts });
const node = (script, args, env) => run(process.execPath, [join(HERE, script), ...args], env);

// In a batch's state from its start until it is handed to the supervisor. A start killed in between
// (the supervisor's intake timeout) never reaches its discard, so the next one finds this left behind
// by a pid that has exited.
const START_MARK = 'epic-start.json';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Discards each feature batch whose epic's start was cut off, which would otherwise read as live and
// refuse every later epic. -> [{batch, text}], one per batch found.
export function clearAbandoned() {
  let all;
  try { all = listBatches().filter((b) => b.name); } catch { return []; /* outside a repo there are none */ }
  const out = [];
  for (const b of all) {
    const m = readJson(join(b.state, START_MARK), null);
    if (!m || alive(m.pid)) continue;
    let supervised = false;
    try { supervised = readQueue(b.queue).supervised === true; } catch { /* unreadable: batch.mjs discard says so */ }
    // Cut off after the hand-over: the batch is whole, and only the mark is left.
    if (supervised) { rmSync(join(b.state, START_MARK), { force: true }); continue; }
    const d = node('batch.mjs', ['discard', b.name], batchEnv(b.name));
    out.push({ batch: b.name, text: `feature batch ${b.name}'s start was cut off (pid ${m.pid}) before it was handed to the supervisor: ${d.status === 0 ? 'discarded' : `not discarded (${lastLine(d)})`}` });
  }
  return out;
}

// The feature branch on origin, cut from origin/<default> and pushed under §3 git-push when it is not
// there yet: null, or why not.
function ensureBranch(branch) {
  const git = (args) => execFileSync('git', ['-C', E.repoRoot(), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const def = E.configValue('default-branch') || 'main';
  try {
    if (git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])) return null;
    const grant = E.permission('git-push');
    if (grant !== 'yes') return `its feature branch ${branch} is not on origin, and pushing it needs config §3 ${E.permissionKey('git-push')} to be "yes" (it is "${grant}"): push it (git push origin origin/${def}:refs/heads/${branch}) and admit it again`;
    git(['fetch', '-q', 'origin', def]);
    git(['push', '-q', 'origin', `origin/${def}:refs/heads/${branch}`]);
    return null;
  } catch (e) {
    return `its feature branch ${branch} could not be read or pushed (${String(e.stderr || e.message).trim().split('\n').pop()})`;
  }
}

// The drafter's prompt: the epic, its numbered criteria and each child, and the feature.json shape.
export function draftPrompt({ epic, epicText, criteria, children }) {
  return [
    `You are drafting the feature plan for epic ${epic}, headless: nobody is reading, and you cannot ask anything. The person approves your draft afterwards, so draft what you would recommend.`,
    '',
    'Draft two things:',
    '- the spine: one dedicated ticket, as it would be filed in the desk ticket template, that lands one strict expected-fail acceptance spec per criterion id below, each titled with its id, plus the shared contracts the children need. Nothing is filed yet.',
    '- the owner table: for each criterion id, the one child whose PR makes its spec pass. Where several children contribute, the owner is the one that completes it, and the rest are its contributors. A criterion that cannot be written as a test goes under untestable, with why.',
    'Use only the criterion ids and child keys given below.',
    '',
    `## The epic ${epic}`,
    '',
    cut(String(epicText ?? '').trim(), TEXT_MAX) || '(its text could not be read)',
    '',
    '## Its numbered criteria',
    '',
    ...(criteria ?? []).map((c) => `- ${c.id}: ${c.text}`),
    '',
    '## Its children',
    '',
    ...children.map((c) => `- ${c.key}: ${c.summary ?? '(no summary)'}${c.files?.length ? ` (files: ${c.files.join(', ')})` : ''}`),
    '',
    '## Your answer',
    '',
    `End your reply with one line, at the start of a line: \`${RESULT_MARK} {"draft": "<the spine ticket>", "owners": {"<id>": "<KEY>"}, "contributors": {"<id>": ["<KEY>"]}, "untestable": {"<id>": {"why": "<why>"}}}\`.`,
  ].join('\n');
}

// The drafter's plan from its JSON output: {draft, owners, contributors, untestable} or {why}.
export function readDraft(text) {
  const { cost, error, payload: p } = markedResult(text, RESULT_MARK);
  if (error) return { why: `the drafter's answer has ${error}` };
  if (typeof p?.draft !== 'string' || !p.draft.trim() || typeof p.owners !== 'object' || !p.owners) return { why: 'the drafter gave no spine draft or owner table' };
  return { draft: p.draft, owners: p.owners, contributors: p.contributors ?? {}, untestable: p.untestable ?? {}, cost };
}

// One headless session drafts the plan: {plan} or {why}.
function draft({ epic, state, children, env, claude }) {
  const epicText = run('desk-jira', ['get', epic], env);
  const expansion = readJson(join(state, 'expansion.json'), {});
  const prompt = draftPrompt({ epic, epicText: epicText.status === 0 ? epicText.stdout : '', criteria: expansion.criteria, children });
  writeFileSync(join(state, 'plan-draft.prompt.md'), prompt);
  const r = run(claude, ['-p', prompt, '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--tools', '', '--max-budget-usd', String(DRAFT_BUDGET_USD)], env, { timeout: DRAFT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) return { why: `the plan drafter failed (${lastLine(r)})` };
  const p = readDraft(r.stdout);
  return p.why ? p : { plan: { epic, spine: null, draft: p.draft, owners: p.owners, contributors: p.contributors, untestable: p.untestable }, cost: p.cost };
}

// plan-batch's verdict on the children, in the batch: {message, needs_person} or {why}.
function planOf(children, env) {
  const r = node('plan-batch.mjs', ['--json', ...children], env);
  try { const v = JSON.parse(r.stdout); return v.status === 'error' ? { why: `plan-batch refused: ${v.message}` } : v; }
  catch { return { why: `plan-batch failed (${lastLine(r)})` }; }
}

// The plan the person reads before answering, in the batch's state folder.
export const planFile = (state) => join(state, 'plan.md');

// The park the epic waits on in its batch: the person reads the plan and answers it in needs-you.
export const planQuestion = (epic, n, path, feature) => `${FEATURE_PLAN_PREFIX}: ${feature ? 'the spine and owner table' : 'the plan'} for ${epic} ${feature ? 'are' : 'is'} drafted, with ${n} ${n === 1 ? 'child' : 'children'} held behind it: read ${path}, then start, edit or discard it`;

// Starts epic `key`'s feature batch, triaged rec `rec` (its `branch` is the feature branch), and leaves
// its plan for the person. -> {batch, children, lines} or {why}; a `why` has left no batch behind.
export function startEpic(key, rec, { by = 'hand', claude = 'claude' } = {}) {
  const branch = rec?.branch;
  if (!branch) return { why: `its triage record names no branch for the feature batch: run /desk-autopilot ${key}` };
  const noBranch = ensureBranch(branch);
  if (noBranch) return { why: noBranch };
  const env = batchEnv(key);
  const state = env.DESK_AUTOPILOT_STATE;
  const st = node('batch.mjs', ['start', key, branch], env);
  if (st.status !== 0) return { why: lastLine(st).replace(/^batch: /, '') };
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, START_MARK), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  const lines = [`started feature batch ${key} on ${branch}, beside the standing batch`];
  const discard = (why) => {
    const d = node('batch.mjs', ['discard', key], env);
    return { why: `${why}; batch ${key} ${d.status === 0 ? 'discarded' : `not discarded (${lastLine(d)})`}` };
  };

  const ex = node('expand-parent.mjs', [key], env);
  if (ex.status === 3) return discard(`nothing is open under ${key}`);
  if (ex.status !== 0) return discard(`expand-parent failed (${lastLine(ex)})`);
  const children = ex.stdout.split('\n').map((s) => s.trim()).filter((s) => E.SAFE_ID.test(s));
  if (!children.length) return discard(`expand-parent named no children of ${key}`);

  const recs = {};
  for (const c of children) {
    const t = run(join(HERE, 'triage.sh'), [c], env);
    const r = t.status === 0 ? readJson(join(state, 'triage', `${c}.json`), null) : null;
    if (!r) return discard(`child ${c} could not be triaged (${t.status === 0 ? 'triage wrote no record' : lastLine(t)})`);
    recs[c] = r;
  }

  let v = planOf(children, env);
  if (v.why) return discard(v.why);
  const wantsPlan = (v.needs_person ?? []).some((n) => n.ticket === key && n.why === 'feature_plan');
  if (wantsPlan) {
    const d = draft({ epic: key, state, env, claude, children: children.map((c) => ({ key: c, summary: recs[c].summary, files: recs[c].files_in_scope })) });
    if (d.why) return discard(d.why);
    writeFileSync(join(state, 'feature.json'), `${JSON.stringify(d.plan, null, 2)}\n`);
    lines.push(`drafted ${key}'s spine and owner table headless${d.cost != null ? ` ($${d.cost.toFixed(2)})` : ''}`);
    v = planOf(children, env);
    if (v.why) return discard(v.why);
  }

  const planPath = planFile(state);
  mkdirSync(state, { recursive: true });
  writeFileSync(planPath, `# The plan for ${key}\n\n${[].concat(v.message ?? []).join('\n')}\n`);
  const q = (args) => { const r = node('queue.mjs', args, env); return r.status === 0 ? null : lastLine(r); };
  // A child parked for its own reason (a lane C or D park, a size) cannot be held as well: it waits on that.
  const admit = (c) => (q(['admit', c, '--by', by, '--hold', key]) && q(['admit', c, '--by', by]));
  const why = q(['add', key, 'Epic', EPIC_LANE])
    ?? q(['park', key, planQuestion(key, children.length, planPath, wantsPlan)])
    ?? children.reduce((w, c) => w ?? admit(c), null)
    ?? q(['set-batch', 'supervised=true']);
  if (why) return discard(`its batch could not be written (${why})`);
  rmSync(join(state, START_MARK), { force: true });
  lines.push(`${key}'s ${children.length} ${children.length === 1 ? 'child is' : 'children are'} held behind it, and its plan waits for you in /desk-needs-you; the batch is handed to the supervisor`);
  return { batch: key, children, lines };
}
