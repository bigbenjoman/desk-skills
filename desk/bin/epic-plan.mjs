// An epic admitted with no session (/desk-admit, standing intake): its feature batch is started
// beside the standing batch and handed to the supervisor, its children are triaged there, its plan
// (the spine and the owner table, in feature mode) is drafted headless, and the plan goes to the
// person as one needs-you item. The batch then waits: the epic is parked in it with a feature-plan
// park, and every child is admitted held behind the epic, so nothing spawns until it is answered.
// The supervisor acts on the answer (actOnPlan): start, an edit applied before it starts, or discard.
//
// startEpic is the /desk-autopilot epic flow's Stages 0 to 2 (desk-autopilot's epic-batch.md and
// feature-mode.md) with the person's plan approval moved to needs-you. Anything that fails before the
// batch is handed over discards it (batch.mjs discard), so a refusal leaves nothing behind.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { FEATURE_PLAN_PREFIX, readQueue, planPark } from './batch-state.mjs';
import { listBatches } from './batches.mjs';
import { markedResult, answers } from './decider.mjs';
import { NOT_NOW } from './not-now.mjs';

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
    // git's own last line, after any pre-push hook's lines: the hook says why it refused, git does not.
    const err = String(e.stderr || e.message).trim().split('\n');
    const said = [...err.filter((l) => l.startsWith('pre-push: ')), err.pop()];
    return `its feature branch ${branch} could not be read or pushed (${[...new Set(said)].join(' ')})`;
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

// A spine and owner table as a headless session gave it: {draft, owners, contributors, untestable}, or
// null when it has no draft or no owner table.
const planShape = (p) => (typeof p?.draft !== 'string' || !p.draft.trim() || typeof p.owners !== 'object' || !p.owners ? null
  : { draft: p.draft, owners: p.owners, contributors: p.contributors ?? {}, untestable: p.untestable ?? {} });

// The drafter's plan from its JSON output: {draft, owners, contributors, untestable} or {why}.
export function readDraft(text) {
  const { cost, error, payload: p } = markedResult(text, RESULT_MARK);
  if (error) return { why: `the drafter's answer has ${error}` };
  const s = planShape(p);
  return s ? { ...s, cost } : { why: 'the drafter gave no spine draft or owner table' };
}

// One headless session with no tools, answering `prompt`: the spawn result.
const headless = (claude, prompt, env) => run(claude, ['-p', prompt, '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config',
  '--permission-mode', 'dontAsk', '--tools', '', '--max-budget-usd', String(DRAFT_BUDGET_USD)], env, { timeout: DRAFT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });

// One headless session drafts the plan: {plan} or {why}.
function draft({ epic, state, children, env, claude }) {
  const epicText = run('desk-jira', ['get', epic], env);
  const expansion = readJson(join(state, 'expansion.json'), {});
  const prompt = draftPrompt({ epic, epicText: epicText.status === 0 ? epicText.stdout : '', criteria: expansion.criteria, children });
  writeFileSync(join(state, 'plan-draft.prompt.md'), prompt);
  const r = headless(claude, prompt, env);
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
// Whether plan-batch wants a feature plan for the epic, and the questions it puts on the epic itself
// (an owner table it cannot use).
const wantsSpine = (v, epic) => (v.needs_person ?? []).some((n) => n.ticket === epic && n.why === 'feature_plan');
const epicQuestions = (v, epic) => (v.needs_person ?? []).filter((n) => n.ticket === epic && n.why === 'question').map((n) => n.detail);

// queue.mjs in the batch `env` names: -> (args) => null, or why it refused.
const queueIn = (env) => (args) => { const r = node('queue.mjs', args, env); return r.status === 0 ? null : lastLine(r); };

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
  const wantsPlan = wantsSpine(v, key);
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
  const q = queueIn(env);
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

// ---- the person's answer to the plan -------------------------------------------------------------
// The supervisor reads it on each tick, before the batch's pass. A start files the spine (feature
// mode) and seeds the batch as the /desk-autopilot epic flow's Stage 3 does; an edit is applied as it
// stands and the batch starts, with no second round, unless it cannot be applied cleanly, which asks
// again naming why; a discard removes the batch (batch.mjs discard), which releases the children.

export const EDIT_MARK = 'PLAN_EDIT:';
const START_WORDS = /^(start|start it|approve|approved|yes|go|ok|okay)[.!]?$/i;
const DISCARD_WORDS = /^(discard|discard it|reject|rejected|no)[.!]?$/i;
// What an answer asks for: 'start', 'discard', or 'edit' (anything else).
export const answerKind = (text) => {
  const s = String(text ?? '').trim();
  return START_WORDS.test(s) ? 'start' : DISCARD_WORDS.test(s) ? 'discard' : 'edit';
};

// The park asked again when an answer could not be carried out: the needs-you plan item, naming why.
export const replanQuestion = (epic, why, path) => `${FEATURE_PLAN_PREFIX}: the plan for ${epic} was not started, because ${why}: read ${path}, then start, edit or discard it`;

// The editor's prompt: the plan as it stands, the children, and the person's edit, verbatim.
export function editPrompt({ epic, edit, planText, plan, children }) {
  return [
    `You are applying the person's edit to the plan for epic ${epic}, headless: nobody is reading, and you cannot ask anything.`,
    'Apply the edit exactly as it stands and change nothing else. If any part of it cannot be applied to this plan as it is written (it names a criterion or a child the plan does not have, contradicts itself, or asks for something the plan does not hold), apply none of it and say which part, and why.',
    '',
    '## The plan as the person read it',
    '',
    cut(String(planText ?? '').trim(), TEXT_MAX) || '(the plan file could not be read)',
    '',
    '## The spine and owner table (feature.json)',
    '',
    plan ? JSON.stringify({ draft: plan.draft, owners: plan.owners ?? {}, contributors: plan.contributors ?? {}, untestable: plan.untestable ?? {} }, null, 2)
      : '(none: this batch runs as an ordinary epic batch, so the only edit the plan holds is which children it builds)',
    '',
    '## Its children',
    '',
    ...children.map((c) => `- ${c}`),
    '',
    '## The edit',
    '',
    cut(String(edit).trim(), TEXT_MAX),
    '',
    '## Your answer',
    '',
    `End your reply with one line, at the start of a line: \`${EDIT_MARK} {"plan": ${plan ? '{"draft": "<the spine ticket>", "owners": {"<id>": "<KEY>"}, "contributors": {"<id>": ["<KEY>"]}, "untestable": {"<id>": {"why": "<why>"}}}' : 'null'}, "drop": ["<KEY of a child the batch no longer builds>"]}\`, or, when the edit cannot be applied, \`${EDIT_MARK} {"cannot": "<the part that cannot be applied, and why>"}\`.`,
  ].join('\n');
}

// The editor's answer: {plan, drop}, {cannot} for an edit it could not apply, or {why} when it failed.
export function readEdit(text, { children, plan }) {
  const { error, payload: p } = markedResult(text, EDIT_MARK);
  if (error) return { why: `the plan editor's answer has ${error}` };
  if (typeof p?.cannot === 'string' && p.cannot.trim()) return { cannot: p.cannot.trim() };
  const drop = Array.isArray(p?.drop) ? p.drop.map(String) : [];
  const stray = drop.filter((k) => !children.includes(k));
  if (stray.length) return { cannot: `it drops ${stray.join(', ')}, which ${stray.length === 1 ? 'is not a child' : 'are not children'} of this batch` };
  if (!plan) return p?.plan ? { cannot: 'this batch has no spine or owner table to change' } : { plan: null, drop };
  const s = planShape(p?.plan);
  if (!s) return { why: 'the plan editor gave no spine draft or owner table' };
  // A spine already filed is in Jira: its draft here is no longer what the batch builds from.
  if (plan.spine && s.draft.trim() !== String(plan.draft).trim()) return { cannot: `it changes the spine, which is already filed as ${plan.spine}: edit ${plan.spine} in Jira, then answer start` };
  return { plan: { ...plan, ...s }, drop };
}

// Files the drafted spine under the epic (desk-jira's gate, §3 jira-create): {key} or {why}.
function fileSpine({ epic, state, env, draft }) {
  const grant = E.permission('jira-create');
  if (grant !== 'yes') return { why: `filing its spine needs config §3 ${E.permissionKey('jira-create')} to be "yes" (it is "${grant}")` };
  const lines = String(draft).trim().split('\n');
  const summary = lines[0].replace(/^#+\s*/, '').replace(/^(summary|title)\s*:\s*/i, '').replace(/\*\*/g, '').trim();
  const file = join(state, 'spine.md');
  writeFileSync(file, `${lines.slice(1).join('\n').trim() || summary}\n`);
  // desk-jira sends a body only from inside the repo, $DESK_STATE or a temp dir.
  const r = run('desk-jira', ['create', 'Story', summary, file, `parent=${epic}`], { ...env, DESK_STATE: state });
  const key = /^created ([A-Z][A-Z0-9_]*-\d+)/m.exec(r.stdout ?? '')?.[1];
  return r.status === 0 && key ? { key } : { why: `filing its spine was refused (${lastLine(r)})` };
}

// Seeds the batch with `children` (and, in feature mode, the spine, filed first) and takes the epic out
// of it: -> {lines} or {why}.
function startPlan({ epic, state, env, children }) {
  let v = planOf(children, env);
  if (v.why) return v;
  // Asked before the spine is filed, so a plan that cannot start leaves nothing in Jira.
  const unsettled = (w) => { const qs = epicQuestions(w, epic); return qs.length ? { why: `plan-batch has questions on its owner table: ${qs.join('; ')}` } : null; };
  const early = unsettled(v);
  if (early) return early;
  let spine = null;
  if (wantsSpine(v, epic)) {
    const path = join(state, 'feature.json');
    const plan = readJson(path, null);
    if (!plan?.draft) return { why: `it has no drafted spine in ${path}` };
    spine = plan.spine;
    // Filed once: a start that stops after filing finds its key here next time.
    if (!spine) {
      const f = fileSpine({ epic, state, env, draft: plan.draft });
      if (f.why) return f;
      spine = f.key;
      writeFileSync(path, `${JSON.stringify({ ...plan, spine }, null, 2)}\n`);
    }
    if (!readJson(join(state, 'triage', `${spine}.json`), null)) {
      const t = run(join(HERE, 'triage.sh'), [spine], env);
      if (t.status !== 0 || !readJson(join(state, 'triage', `${spine}.json`), null)) return { why: `its spine ${spine} could not be triaged (${t.status === 0 ? 'triage wrote no record' : lastLine(t)})` };
    }
    v = planOf([spine, ...children], env);
    if (v.why) return v;
  }
  const late = unsettled(v);
  if (late) return late;
  const seed = node('plan-batch.mjs', ['--json', ...(spine ? [spine] : []), ...children], { ...env, AUTOPILOT_WRITE_QUEUE: '1' });
  let sv = null;
  try { sv = JSON.parse(seed.stdout); } catch { /* reported below */ }
  if (!sv || sv.status === 'error') return { why: `plan-batch did not seed it (${sv?.message ?? lastLine(seed)})` };
  const q = queueIn(env);
  // A child plan-batch made runnable still carries the epic's hold park, which nothing reads once it is
  // triaged; it is cleared so the queue says what the ticket waits on.
  const after = readQueue(env.DESK_QUEUE);
  const stale = Object.values(after.tickets ?? {}).filter((t) => t.key !== epic && t.state === 'triaged' && t.park);
  const why = stale.reduce((w, t) => w ?? q(['set', t.key, 'park=null']), null) ?? q(['drop', epic]);
  if (why) return { why: `its queue could not be written (${why})` };
  return { lines: [`${epic}'s feature batch started on ${after.base ?? 'its feature branch'}${spine ? `, with its spine ${spine} first` : ''}: ${children.length} ${children.length === 1 ? 'child' : 'children'} seeded by plan-batch`] };
}

// Applies an edit to the plan, then starts the batch: -> {lines} or {why} (asked again).
function editPlan({ epic, state, env, children, edit, claude }) {
  const path = join(state, 'feature.json');
  const before = readJson(path, null);
  const plan = before?.draft ? before : null;
  let planText = '';
  try { planText = readFileSync(planFile(state), 'utf8'); } catch { /* the prompt says so */ }
  const prompt = editPrompt({ epic, edit, planText, plan, children });
  writeFileSync(join(state, 'plan-edit.prompt.md'), prompt);
  const r = headless(claude, prompt, env);
  if (r.error || r.status !== 0) return { why: `your edit was not applied: the plan editor failed (${lastLine(r)})` };
  const e = readEdit(r.stdout, { children, plan });
  if (e.why) return { why: `your edit was not applied: ${e.why}` };
  if (e.cannot) return { why: `your edit could not be applied: ${e.cannot}` };
  const kept = children.filter((c) => !e.drop.includes(c));
  if (!kept.length) return { why: 'your edit could not be applied: it leaves no child to build' };
  if (e.plan) writeFileSync(path, `${JSON.stringify(e.plan, null, 2)}\n`);
  const v = planOf(kept, env);
  const qs = v.why ? [v.why] : epicQuestions(v, epic);
  if (qs.length) {
    if (e.plan) writeFileSync(path, `${JSON.stringify(before, null, 2)}\n`);
    return { why: `your edit could not be applied cleanly: ${qs.join('; ')}` };
  }
  const q = queueIn(env);
  const dropped = e.drop.reduce((w, c) => w ?? q(['drop', c]), null);
  if (dropped) return { why: `your edit could not be applied: its queue could not be written (${dropped})` };
  writeFileSync(planFile(state), `# The plan for ${epic}\n\n${[].concat(v.message ?? []).join('\n')}\n\nEdited on your answer: ${edit}\n`);
  const s = startPlan({ epic, state, env, children: kept });
  const did = `your edit to ${epic}'s plan was applied${e.drop.length ? `, and ${e.drop.join(', ')} left the batch` : ''}`;
  return s.why ? { why: `${did}, but ${s.why}` } : { lines: [did, ...s.lines] };
}

// Removes the batch on the person's word: -> {lines, gone} or {why}.
function discardPlan({ name, env, children }) {
  const q = queueIn(env);
  const sup = q(['set-batch', 'supervised=false']);
  if (sup) return { why: `discarding it was refused (${sup})` };
  const d = node('batch.mjs', ['discard', name], env);
  if (d.status !== 0) {
    q(['set-batch', 'supervised=true']);
    return { why: `discarding it was refused (${lastLine(d).replace(/^batch: /, '')})` };
  }
  const freed = children.length ? `; ${children.join(', ')} ${children.length === 1 ? 'is' : 'are'} released: no batch holds ${children.length === 1 ? 'it' : 'them'}, and /desk-admit or intake can take ${children.length === 1 ? 'it' : 'each'} again` : '';
  return { gone: true, lines: [...d.stdout.trim().split('\n').filter(Boolean), `discarded on your answer to its plan${freed}`] };
}

// The answer waiting on batch `b`'s plan: {q, epic, last}, or null when there is none to act on.
function pendingAnswer(b) {
  let q;
  try { q = readQueue(b.queue); } catch { return null; /* the batch's own tick reports it */ }
  const epic = q.epic ?? b.name;
  const t = q.tickets?.[epic];
  if (q.supervised !== true || !planPark(t)) return null;
  const last = answers(b.state, { ticket: epic, at: t.park.since }).pop();
  // "not now" puts the item off (not-now.mjs): nothing to act on.
  return !last || NOT_NOW.test(last.text) ? null : { q, epic, last };
}

// Acts on the person's answer to the plan of feature batch `b` ({name, queue, state}), if one came since
// the epic parked: -> {acted: null | 'start' | 'edit' | 'discard' | 'asked', lines, gone}. `gone`: the
// batch's folders are removed, so its lines belong in the standing batch's log. `lock` is the batch's
// run lock: take() -> whether it was taken, drop(). It is held from reading the answer to re-parking,
// so a tick that overlaps this one (an edit runs for minutes) does not act on the same answer, and
// dropped before a discard, which refuses a batch any run holds.
export function actOnPlan(b, { claude = 'claude', lock = { take: () => true, drop: () => {} } } = {}) {
  const none = { acted: null, lines: [], gone: false };
  if (!b?.name || !pendingAnswer(b) || !lock.take()) return none;
  try {
    // Read again under the lock: a run that held it may have acted on the answer since.
    const a = pendingAnswer(b);
    if (!a) return none;
    const { q, epic, last } = a;
    const env = batchEnv(b.name);
    const children = Object.keys(q.tickets).filter((k) => k !== epic);
    const kind = answerKind(last.text);
    if (kind === 'discard') lock.drop();
    const r = kind === 'discard' ? discardPlan({ name: b.name, env, children })
      : kind === 'start' ? startPlan({ epic, state: b.state, env, children })
        : editPlan({ epic, state: b.state, env, children, edit: last.text, claude });
    if (!r.why) return { acted: kind, lines: r.lines, gone: r.gone === true };
    // Parked again with why: a new needs-you item, and an answer to it is newer than this park.
    const p = queueIn(env)(['park', epic, replanQuestion(epic, r.why, planFile(b.state))]);
    return { acted: 'asked', gone: false, lines: [`${epic}: your answer to its plan was not carried out, because ${r.why}; ${p ? `and asking again failed (${p})` : 'asked again in /desk-needs-you'}`] };
  } finally { lock.drop(); }
}
