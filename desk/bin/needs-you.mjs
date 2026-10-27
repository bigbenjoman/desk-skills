#!/usr/bin/env node
// What desk-q counts as needing the person, across every repo on this computer, one line per item,
// and the one command that records each answer. The desk-needs-you skill reads `list`, asks, and
// records through `record`; it reads no queue, log, briefing or digest page itself.
//
//   needs-you.mjs list [<repo>]                       one line per batch with items, then one per item
//       <repo> is a repo's name (all its batches) or <repo>:<name> (one named batch), as each item
//       line starts
//   needs-you.mjs record <repo> <TICKET> <action> ["<text>"]
//       resume "<answer>"   answer it (digest.mjs answer), then requeue it, or mark it answered and
//                           name the session to ask
//       answer "<answer>"   answer it only (digest.mjs answer): triage questions
//       release             release a hold nothing else will (desk-q's release command)
//       approve | reject "<note>"   a feature spine's specs (queue.mjs approve or reject)
//       override <id> "<choice>"    a decision its worker took (digest.mjs override)
//       not-now             put it off (the not-now register), asked again once its inputs change
//       open                a lane C or D park: names the desk-ticket session to open; records nothing
//       done                the person did the step themselves; records nothing
//   needs-you.mjs left [<repo>]                       how many items desk-q still counts, and where passes stopped
//
// Items are what desk-q's home screen counts as "◆ needs you", in order: a PRODUCTION BROKEN park
// first, then the longest waiting. Exits 0, or 11 (show the person) on anything it refuses.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { repoConfigValue, releaseCommand } from './desk-env.mjs';
import { isHeld, spinePark, EXIT } from './batch-state.mjs';
import { loadRepos, shownRepos, holdOf, resolveRepo, resumeOf, needsSession, queueRun, checkoutOf, timeOf } from './desk-q.mjs';
import { answer, override, readDecisions, openQuestions, PRODUCTION_BROKEN } from './digest.mjs';
import { addPutOff, putOffEntry, notNowPath } from './not-now.mjs';

// A question longer than this is cut on its line: the session asks it, not reads it in full.
const QUESTION_MAX = 240;
// The decisions a parked item offers to override, newest first.
const DECISIONS_SHOWN = 3;

const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const since = (ms) => { const m = Math.floor(ms / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
// A park triage made (size, a dependency cycle): queue.mjs requeue refuses it, so it needs a person.
const triagePark = (t) => /^(size |dependency cycle:)/.test(String(t.park?.question ?? ''));
const digestList = (r) => [{ slug: r.slug, batch: r.batch ?? null, state: r.stateDir, queue: r.queuePath }];

// The batches `word` names: a repo's name is all of its batches, `<repo>:<name>` one named batch.
function batchesNamed(repos, word) {
  const r = resolveRepo(repos, word);
  return { named: r, scope: r.batch ? [r] : repos.filter((x) => x.slug === r.slug) };
}

// Who moves the repo's batch on once an answer is recorded: its supervisor, a live session (named by
// its batch, as the orchestrator is), or nothing while passes are stopped.
export function runner(r) {
  if (!r.live) return { by: 'stopped', resume: resumeOf(r) };
  return r.run?.by === 'supervisor' ? { by: 'supervisor' } : { by: 'session', name: r.q?.batch ?? null };
}

// One item's kind, its one-line need and its actions, the recommended one first with its reason.
function itemOf(r, x) {
  const t = x.t;
  if (isHeld(t)) {
    const h = holdOf(r.q, t, r.ctx);
    return h.act
      ? { kind: 'held', need: h.text, actions: [['release', 'nothing else releases it, and releasing it lets the next pass start it'], ['not-now']] }
      : { kind: 'held', need: h.text, actions: [['done', 'only you can do this step; say done once you have'], ['not-now']] };
  }
  if (t.state === 'parked') {
    const need = one(t.park?.question) || 'parked, with no question recorded';
    const sp = spinePark(t);
    if (sp === 'approval') return { kind: 'spine', need, actions: [['approve', 'its acceptance specs passed the spec check'], ['reject'], ['not-now']] };
    if (sp === 'specs') return { kind: 'spine', need, actions: [['reject', 'its acceptance specs failed the spec check, so it goes back with what to fix'], ['not-now']] };
    if (needsSession(t)) return { kind: 'session', need, actions: [['open', `lane ${t.lane ?? 'C or D'}: only an interactive desk-ticket session takes it on`], ['not-now']] };
    if (triagePark(t)) return { kind: 'session', need, actions: [['open', 'parked at triage: it needs splitting or its links fixing, which a requeue cannot do'], ['not-now']] };
    const { taken, overrides } = readDecisions(r.stateDir);
    const overridden = new Set(overrides.map((o) => o.override_of));
    const offer = taken.filter((d) => d.ticket === t.key && !overridden.has(d.id)).slice(-DECISIONS_SHOWN).reverse()
      .map((d) => [`override ${d.id}`, null, `took "${cut(one(d.chose), 40)}" on "${cut(one(d.question), 60)}"`]);
    // No bare answer: it would leave the ticket parked, and desk-q still counting it.
    return { kind: 'parked', need, actions: [['resume', `lane ${t.lane ?? '?'}: a worker finishes it once it has your answer`], ['not-now'], ...offer] };
  }
  // Its questions as the digest page words them, so a put-off entry keys to the same text.
  const need = one(openQuestions(digestList(r)[0]).find((q) => q.ticket === t.key && q.kind === 'triage')?.text) || `${t.open_questions} triage question(s) open`;
  return { kind: 'triage', need, actions: [['answer', 'answering clears its questions, so the next pass can start it'], ['not-now']] };
}

// Every item desk-q counts as needing the person, in the batches `word` names (all when null).
export function collect({ word = null, now = Date.now(), repos = loadRepos(now) } = {}) {
  const { named = null, scope } = word ? batchesNamed(repos, word) : { scope: shownRepos(repos, false) };
  const items = [];
  for (const r of scope.filter((x) => !x.error && x.q)) {
    for (const x of r.rows.filter((y) => y.k === 'needs')) {
      items.push({ r, t: x.t, ...itemOf(r, x), since: timeOf(x.t.park?.since ?? x.t.added_at), broken: PRODUCTION_BROKEN.test(x.t.park?.question ?? '') });
    }
  }
  items.sort((a, b) => (b.broken - a.broken) || ((a.since ?? Infinity) - (b.since ?? Infinity)) || a.t.key.localeCompare(b.t.key));
  return { repos, scope, items, named };
}

const actionText = ([name, why, note], i) => `${i + 1}. ${name}${why ? ` (recommended: ${why})` : note ? ` (${note})` : ''}`;
const runLine = (r) => {
  const w = runner(r);
  return `@ ${r.name}: ${w.by === 'supervisor' ? 'run by the supervisor; its next pass picks answers up'
    : w.by === 'session' ? `run by a live session${w.name ? ` (${w.name})` : ''}; resumes go to it by message`
      : `passes stopped; answers wait until they resume. To resume: ${w.resume}`}`;
};

export function listText(c, now = Date.now()) {
  if (!c.items.length) return `Nothing needs you${c.named ? ` in ${c.named.name}` : ''}.`;
  const repos = [...new Set(c.items.map((i) => i.r))];
  const lines = repos.map(runLine);
  for (const i of c.items) {
    const waited = i.since == null ? '' : ` ${since(now - i.since)}`;
    lines.push(`${i.r.word} ${i.t.key} ${i.kind}${waited} | ${cut(i.need, QUESTION_MAX)} | ${i.actions.map(actionText).join(' | ')}`);
  }
  const n = new Set(repos.map((r) => r.slug)).size;
  lines.push(`${c.items.length} item${c.items.length === 1 ? '' : 's'} in ${n} repo${n === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

// A queue.mjs command run from the named repo's checkout, so the permissions and GitHub repo it reads
// are that repo's, not those of the repo this session is in: { ok, out }. Exit 11 with nothing on
// stderr is queue.mjs having recorded it and naming what is left for the person, on stdout.
function queueCmd(r, args) {
  let at;
  try { at = checkoutOf(r, 'record it'); } catch (e) { return { ok: false, out: e.message }; }
  const q = queueRun(r, args, at);
  if (q.ok || (q.code === EXIT.SHOW_PERSON && !q.err && q.out.trim())) return { ok: true, out: one(q.out) };
  return { ok: false, out: one(q.why) };
}

// Records one answer: { ok, line, message } where `message` is what a live session must be sent.
export function record({ word, ticket, action, text = '', now = Date.now(), repos = loadRepos(now) }) {
  // A ticket is in one batch at most, so the batch named that holds it is the one its answer goes to.
  const { named, scope } = batchesNamed(repos, word);
  const r = scope.find((b) => b.q?.tickets?.[ticket]) ?? named;
  const x = r.rows?.find((y) => y.t.key === ticket && y.k === 'needs');
  if (!x) return { ok: false, line: `${r.name} ${ticket}: desk-q does not count it as needing you, so nothing was recorded.` };
  const item = itemOf(r, x);
  const [verb, id] = action.split(/\s+/);
  const allowed = item.actions.map(([a]) => a.split(' ')[0]);
  if (!allowed.includes(verb)) return { ok: false, line: `${r.name} ${ticket}: ${verb} is not an action for a ${item.kind} item (${[...new Set(allowed)].join(', ')}).` };
  const w = runner(r);
  const tail = w.by === 'stopped' ? ` Passes are stopped in ${r.name}: nothing acts on it until they resume.` : '';
  const say = (ok, line, message = null) => ({ ok, line: `${r.name} ${ticket}: ${line}${ok ? tail : ''}`, message });
  if (['answer', 'resume', 'reject', 'override'].includes(verb) && !text.trim()) return say(false, `${verb} needs the text to record.`);
  const ans = () => answer({ slug: r.slug, ticket, text, list: digestList(r), now: new Date(now) });
  switch (verb) {
    case 'answer': {
      const a = ans();
      return a.ok ? say(true, 'answer recorded (digest.mjs answer).') : say(false, a.why);
    }
    case 'resume': {
      const a = ans();
      if (!a.ok) return say(false, a.why);
      if (w.by === 'session') {
        // Marked answered, so desk-q shows it waiting on that session rather than needing the person.
        const m = queueCmd(r, ['set', ticket, `park.answered=${new Date(now).toISOString()}`]);
        if (!m.ok) return say(false, `answer recorded, but marking it answered was refused: ${m.out}`);
        return say(true, `answer recorded; not requeued, because a live session runs ${r.name}: message it to requeue ${ticket}.`,
          { to: w.name, text: `${ticket} was answered through desk-needs-you: requeue it (node ~/.claude/desk/bin/queue.mjs requeue ${ticket}).` });
      }
      const q = queueCmd(r, ['requeue', ticket]);
      return q.ok ? say(true, `answer recorded and requeued; the next pass can spawn it.`) : say(false, `answer recorded, but the requeue was refused: ${q.out}`);
    }
    case 'release': {
      const steps = releaseCommand(ticket, '').split(/, then /).map((s) => s.trim().split(/\s+/));
      for (const s of steps) { const q = queueCmd(r, s); if (!q.ok) return say(false, `release refused: ${q.out}`); }
      return say(true, 'released; the next pass can start it.');
    }
    // queue.mjs's own lines: they name any undraft or merge left for the person to do.
    case 'approve': { const q = queueCmd(r, ['approve', ticket]); return q.ok ? say(true, `spine approved: ${q.out}`) : say(false, q.out); }
    case 'reject': {
      const q = queueCmd(r, ['reject', ticket, text]);
      return q.ok ? say(true, 'spine sent back with your note.') : say(false, q.out);
    }
    case 'override': {
      if (!id) return say(false, 'override needs the decision id.');
      const o = override({ slug: r.slug, id, choice: text, list: digestList(r), now: new Date(now) });
      return o.ok ? say(true, `decision ${id} overridden to "${text}" (digest.mjs override).`) : say(false, o.why);
    }
    case 'not-now': {
      // A park is put off by answer.mjs, keyed to its inputs; anything else by its question alone.
      if (item.kind === 'parked' || item.kind === 'session' || item.kind === 'spine') {
        const a = answer({ slug: r.slug, ticket, text: 'not now', list: digestList(r), now: new Date(now) });
        return a.ok ? say(true, 'put off (not-now register).') : say(false, a.why);
      }
      addPutOff(putOffEntry({ question: item.need, ticket, inputs: { ticket }, at: new Date(now).toISOString() }), r.stateDir);
      return say(true, `put off (${notNowPath(r.stateDir)}).`);
    }
    case 'open': {
      const root = repoConfigValue(r.slug, 'repo-root');
      return say(true, `not requeued (lane C or D). Open an interactive session${root ? ` in ${root}` : ` in ${r.name}`} and run /desk-ticket ${ticket}.`);
    }
    case 'done': return say(true, 'nothing recorded: you did the step.');
    default: return say(false, `unknown action ${verb}.`);
  }
}

// What is left: desk-q's count in scope, then a line for each unfinished batch there whose passes are
// stopped, needing the person or not: one just answered no longer does, and still waits on a pass.
export function leftText({ word = null, now = Date.now(), repos = loadRepos(now) } = {}) {
  const c = collect({ word, now, repos });
  const where = c.named ? ` in ${c.named.name}` : '';
  const lines = [`desk-q counts ${c.items.length} item${c.items.length === 1 ? '' : 's'} needing you${where}.`];
  for (const r of (c.named ? c.scope : repos).filter((x) => !x.error && x.q && !x.live && (x.rows.length || x.prs.length))) {
    lines.push(`Passes are stopped in ${r.name}, so nothing acts on its answers yet. To resume: ${resumeOf(r)}.`);
  }
  return lines.join('\n');
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const refuse = (why) => { console.error(why); process.exit(EXIT.SHOW_PERSON); };
  try {
    if (cmd === 'list' && rest.length <= 1) console.log(listText(collect({ word: rest[0] ?? null })));
    else if (cmd === 'left' && rest.length <= 1) console.log(leftText({ word: rest[0] ?? null }));
    else if (cmd === 'record' && rest.length >= 3) {
      const [word, ticket, verb, ...more] = rest;
      // An override names its decision id before the choice.
      const [action, text] = verb === 'override' ? [`override ${more[0] ?? ''}`, more.slice(1).join(' ')] : [verb, more.join(' ')];
      const res = record({ word, ticket, action, text });
      console.log(res.line);
      if (res.message) console.log(`MESSAGE ${res.message.to ?? '(no batch name recorded)'}: ${res.message.text}`);
      if (!res.ok) process.exit(EXIT.SHOW_PERSON);
    } else refuse('usage: needs-you.mjs list [<repo>] | record <repo> <TICKET> <action> ["<text>"] | left [<repo>]');
  } catch (e) { refuse(e.message); }
}
