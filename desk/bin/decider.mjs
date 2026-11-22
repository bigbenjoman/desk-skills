// The decider: a fresh, small headless session the supervisor starts when a pass exits needing the
// person. It is given that pass's report and the recovery rules, settles what the rules let the
// orchestrator settle without asking (a requeue or a move to another batch, mostly, and under config
// §3 autopilot-judgement yes a recommended take call answered and logged), and hands
// everything else to the check-in digest. One runs at a time per repo, at low effort, and is stopped after DECIDER_TIMEOUT_MS.
//
// What a pass lists becomes items, each with an id that stays the same while the item does:
//   - an epic's feature-plan park, a lane C park, a lane D one parked at triage on its design, and anything naming a config §3 row
//     that is not `yes`, is handed straight on, as is a waiting line for a done ticket, which no
//     decider tool acts on, and a park asking again what the park its last requeue cleared asked,
//     with no answer since (queue.mjs requeue keeps that park as `prev_park`), and a park on a step only a
//     person or another account takes (batch-state.mjs personOnlyStep), with no answer since it parked;
//   - a park with a recorded clears-when waits on it, neither handed on nor given to a session;
//   - a park whose clears-when no form read goes to a session to restate as a form, or as none; once a
//     session has seen it, or none will, the supervisor records it none (restateKeys);
//   - the rest go to the session, unless already handed and not answered since (an answer through
//     answer.mjs, which the ticket's briefing records), and an answered one goes with its answers;
//   - what the session does not report settled is handed on with its reason, unless the usage limit
//     refused the session, which keeps every item for the next one.
// Handed items live in <state>/handed.json, which the digest lists; one the pass no longer lists is dropped.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { answerEntriesSince } from './handoff.mjs';
import { CLEARS_WHEN_FORMS, describeCond, personClears, recorded, restating } from './clears-when.mjs';
import { needsSession, planPark, leftPark, personOnlyStep, LEFT_PREFIX, moveTargetsOf, targetsText, moveOffer, openUnknowns } from './batch-state.mjs';
import { questionKey, readRegister, lookup } from './not-now.mjs';
import { usageLimit } from './usage-limit.mjs';
import { callLogin } from './call-login.mjs';
import { refusedLogin } from './health.mjs';
import { loginOf } from './claude-logins.mjs';
import { TAKE_CATEGORIES } from './decisions.mjs';
import { recommendedAnswer } from './recoveries.mjs';

export const DECIDER_TIMEOUT_MS = 15 * 60 * 1000;
export const DECIDER_EFFORT = 'low';
export const RESULT_MARK = 'DECIDER_RESULT:';
// How every decider prompt starts, which is how cache-report.mjs tells its transcripts apart.
export const DECIDER_OPENING = 'You are the autopilot decider for ';

const h = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };

// What a WAITING ON YOU line waits on, for its id: its ticket, its class (`DRAFT`, `STUCK`, `READY TO
// MERGE`) and the PR it names, so a line whose check states or reason reword keeps its id. The batch's
// base sync line is keyed on its label alone, as its cause and commit count change pass to pass. Any
// other line with no class is keyed on all of it.
const BASE_SYNC = 'base sync';
export const baseSyncLine = (line) => String(line).split(':')[0] === BASE_SYNC;
function waitKey(line) {
  const s = String(line);
  if (baseSyncLine(s)) return BASE_SYNC;
  const m = /^([^:]*): ([A-Z][A-Z ]*[A-Z]) — /.exec(s);
  if (!m) return s;
  const pr = /PR #(\d+)/.exec(s.slice(m[0].length));
  return `${m[1]}\0${m[2]}\0${pr ? pr[1] : ''}`;
}

// Do two parks ask the same thing? Workers word a repeat afresh each time, so past an exact match (as
// not-now.mjs matches a question) it compares the specific terms (paths, SHAs, other keys): the same
// question when at least half of them are shared. A term naming the ticket itself (its key, branch or
// worktree) or a remote ref (`origin/main`) is in nearly every park it makes, so it is not counted.
const parkTerms = (s, own) => new Set((String(s).toLowerCase().match(/[\w./-]+/g) ?? [])
  .map((w) => w.replace(/[.\-/]+$/, ''))
  .filter((w) => w.length >= 3 && /[\d/._]/.test(w) && !own?.test(w) && !w.startsWith('origin/')));
export function samePark(a, b, ticket = '') {
  if (!String(a ?? '').trim() || !String(b ?? '').trim()) return false;
  if (questionKey(a) === questionKey(b)) return true;
  const key = String(ticket).toLowerCase().replace(/[^\w-]/g, '');
  const own = key ? new RegExp(`(^|[^a-z0-9])${key}([^a-z0-9]|$)`) : null;
  const x = parkTerms(a, own);
  const y = parkTerms(b, own);
  if (x.size < 2 || y.size < 2) return false;
  const both = [...x].filter((w) => y.has(w)).length;
  return both / new Set([...x, ...y]).size >= 0.5;
}

// One item per parked ticket and per WAITING ON YOU line, as the pass's verdict names them. A line
// whose label is no queue ticket (`BASE GATE`, `base sync`) is the batch's, with no ticket to answer.
// A park carries its round (which park in a row this is, counted by queue.mjs requeue), the park the
// last requeue cleared, whether this one asks the same thing, and the clears-when it had when listed.
// A triaged ticket's line carries its open questions word for word (openQuestionsOf). A park's `note`
// (its PR conflicting with the base, say) goes in its text, never its id, so the item stays one item.
// The base sync line carries `baseSha`, origin's head of the batch base, as its `base`: one handed on
// is dropped once that moves (pruneHanded), so a new base gets one new session.
export function deciderItems(v, q = {}, state = null, { baseSha = null } = {}) {
  const tickets = q.tickets ?? {};
  const parked = (Array.isArray(v?.parked) ? v.parked : []).map((p) => {
    const prev = tickets[p.key]?.prev_park ?? null;
    return {
      id: `park-${h(`${p.key}\0${p.question ?? ''}`)}`, ticket: p.key, kind: 'parked', text: `${p.question ?? ''}${p.note ? ` (${p.note})` : ''}`, lane: tickets[p.key]?.lane ?? null,
      since: tickets[p.key]?.park?.since ?? null, clears: condKey(tickets[p.key]?.park?.clears_when),
      round: (prev?.round ?? 0) + 1, prev, repeat: !!prev && samePark(prev.question, p.question, p.key),
      takenOnce: !!tickets[p.key]?.auto_answered && samePark(tickets[p.key].auto_answered.question, p.question, p.key),
      ...(tickets[p.key]?.park?.session_step ? { step: tickets[p.key].park.session_step } : {}),
      ...(restating(tickets[p.key]?.park?.clears_when) ? { restate: String(tickets[p.key].park.clears_when.text ?? '') } : {}),
    };
  });
  const waiting = (Array.isArray(v?.waiting) ? v.waiting : []).map((line) => {
    const label = String(line).split(':')[0];
    const item = { id: `wait-${h(waitKey(line))}`, ticket: label, kind: tickets[label] ? 'waiting' : 'batch', text: String(line), lane: tickets[label]?.lane ?? null, state: tickets[label]?.state ?? null,
      ...(baseSyncLine(line) && baseSha ? { base: baseSha } : {}) };
    const questions = item.state === 'triaged' ? openQuestionsOf(state, label, tickets[label]) : [];
    return questions.length ? { ...item, questions } : item;
  });
  return [...parked, ...waiting];
}

// A triaged ticket's open questions, each once: its triage record's unknowns not yet answered (read from
// `state`, so none without it), then the ones plan-batch added when it seeded the queue entry `t` (`plan_questions`).
export function openQuestionsOf(state, key, t = {}) {
  const unknowns = state ? openUnknowns(readJson(join(state, 'triage', `${key}.json`), {})?.unknowns, t) : null;
  const list = (a) => (Array.isArray(a) ? a : []);
  const all = [...list(unknowns), ...list(t?.plan_questions)].map((s) => String(s).replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  return [...new Set(all)];
}

// Items the rules hand on without a session: {hand: [{item, why}], ask: [item], waits: [item]}. A §3
// row is read as the pass's line gives it. A park that asks again what the park its last requeue
// cleared asked, with no answer since that one, is handed on: another worker would park the same way.
// So is a park on a step only a person or another account takes, with no answer since it parked.
// With no `state` to read answers from, none is counted. A park with a recorded clears-when waits on
// it: each pass checks it and settles the park, so it needs neither a session nor the person. One whose
// clears-when no form read goes to the session to restate, unless the rules above hand it on first.
export function presort(items, state = null) {
  const hand = [];
  const ask = [];
  const waits = [];
  const short = (s) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  for (const item of items) {
    const row = /config §3 `?([\w-]+)`? is "([^"]*)"/.exec(item.text);
    const prevAt = item.prev?.since ?? item.prev?.requeued_at;
    if (item.kind === 'parked' && planPark({ state: 'parked', park: { question: item.text } })) {
      hand.push({ item, why: 'an epic\'s drafted plan: only the person starts, edits or discards it' });
    } else if (item.kind === 'parked' && leftPark({ state: 'parked', park: { question: item.text } })) {
      hand.push({ item, why: 'left in a finished feature batch: only the person moves it to the standing batch or drops it' });
    } else if (item.kind === 'parked' && item.step) {
      hand.push({ item, why: `the person approved a step no worker can run (${short(String(item.step.step))}): it goes to an interactive desk-ticket session` });
    } else if (item.kind === 'parked' && needsSession({ lane: item.lane, park: { question: item.text } })) {
      hand.push({ item, why: `lane ${item.lane} park: never requeued for a headless worker, it goes to an interactive desk-ticket session` });
    } else if (item.kind === 'parked' && item.restate != null) {
      ask.push(item);
    } else if (item.kind === 'parked' && item.clears && personClears(JSON.parse(item.clears))) {
      hand.push({ item, why: JSON.parse(item.clears).kind === 'file-exists'
        ? `waits on a file only the person makes (${describeCond(JSON.parse(item.clears))}): a pass requeues it once the file is there`
        : 'waits on issue links only the person makes: a pass records it done again once each is on Jira' });
    } else if (item.kind === 'parked' && item.clears) {
      waits.push(item);
    } else if (item.kind === 'parked' && personOnlyStep(item.text) && !(state && item.since && answered(state, { ticket: item.ticket, at: item.since }))) {
      hand.push({ item, why: `its step is one only a person or another account takes, with no answer since it parked: a requeue would park again ("${short(personOnlyStep(item.text))}")` });
    } else if (item.kind === 'parked' && item.repeat && !(state && prevAt && answered(state, { ticket: item.ticket, at: prevAt }))) {
      hand.push({ item, why: `park ${item.round} asks what park ${item.round - 1} asked, with no answer since: a requeue would park again (last park: "${short(item.prev.question)}")` });
    } else if (item.kind === 'parked' && item.takenOnce && !(state && item.since && answered(state, { ticket: item.ticket, at: item.since }))) {
      hand.push({ item, why: 'its recommended option was taken once already (auto_answered) and it parked on the same call again: a call is taken once, so it is the person\'s' });
    } else if (row && row[2] !== 'yes') {
      hand.push({ item, why: `needs config §3 ${row[1]}, which is "${row[2]}"` });
    } else if (item.kind === 'waiting' && item.state === 'done') {
      hand.push({ item, why: `${item.ticket} is done, and the decider can only requeue or record clears-when for a parked ticket` });
    } else ask.push(item);
  }
  return { hand, ask, waits };
}

// A recorded clears-when as one comparable string, or null for none or one still to be restated.
function condKey(c) {
  return recorded(c) ? JSON.stringify(c) : null;
}

// The tickets of `items` parked on an unreadable clears-when, and with a queue `q` only those whose park
// still is. Once a session has seen them, or none will, the supervisor records each as none, so the park
// is the person's.
export const restateKeys = (items, q = null) => [...new Set(items.filter((i) => i.restate != null).map((i) => i.ticket))]
  .filter((k) => !q || restating(q.tickets?.[k]?.park?.clears_when));

// ---- the handed register -----------------------------------------------------------------------
export const handedPath = (state) => join(state, 'handed.json');
export const readHanded = (state) => readJson(handedPath(state), {}) ?? {};
const writeHanded = (state, r) => writeFileSync(handedPath(state), `${JSON.stringify(r, null, 2)}\n`);

// Has the person answered this ticket since the item was handed on? answer.mjs records every answer,
// the digest's included, in the ticket's briefing.
export function answers(state, entry) {
  const brief = join(state, 'briefings', `${entry.ticket}.md`);
  if (!existsSync(brief)) return [];
  return answerEntriesSince(readFileSync(brief, 'utf8'), entry.at);
}
export const answered = (state, entry) => answers(state, entry).length > 0;

// Items a session may be started for: none handed on and still unanswered. One answered since it was
// handed on carries those answers ([{at, text}]), so the session acts on them, and so does a park
// never handed on that was answered since it parked.
export function freshItems(state, items, handed = readHanded(state)) {
  return items
    .filter((i) => !handed[i.id] || answered(state, handed[i.id]))
    .map((i) => {
      const got = handed[i.id] ? answers(state, handed[i.id]) : i.kind === 'parked' && i.since ? answers(state, { ticket: i.ticket, at: i.since }) : [];
      return got.length ? { ...i, answers: got } : i;
    });
}

// Records items handed on and returns the ones newly recorded. One already handed and still
// unanswered keeps its time, so a later answer still counts; one answered since is handed again from now.
export function handItems(state, handed, now = new Date()) {
  const r = readHanded(state);
  const added = [];
  for (const h of handed) {
    if (r[h.item.id] && !answered(state, r[h.item.id])) continue;
    r[h.item.id] = { id: h.item.id, ticket: h.item.ticket, kind: h.item.kind, text: h.item.text, why: h.why, at: now.toISOString(), ...(h.item.base ? { base: h.item.base } : {}) };
    added.push(h);
  }
  if (added.length) writeHanded(state, r);
  return added;
}

// Removes the handed items `ids`.
export function dropHanded(state, ids) {
  const r = readHanded(state);
  for (const id of ids) delete r[id];
  writeHanded(state, r);
}

// Drops every handed item the latest pass no longer lists: it was settled some other way. One it still
// lists keeps its time and takes the line's latest wording, unless it was handed on at another base
// than the item now names, which drops it too. The archive check's own items (kind `archive`,
// batch.mjs) are no pass's, and that check drops them.
export function pruneHanded(state, items) {
  const r = readHanded(state);
  const live = new Map(items.map((i) => [i.id, i]));
  const moved = (e, i) => !!(e.base && i.base && e.base !== i.base);
  const kept = Object.fromEntries(Object.entries(r).filter(([id, e]) => (live.has(id) && !moved(e, live.get(id))) || e.kind === 'archive'));
  const reworded = Object.entries(kept).filter(([id, e]) => live.has(id) && (e.text !== live.get(id).text || (!e.base && live.get(id).base)));
  for (const [id, e] of reworded) {
    e.text = live.get(id).text;
    if (live.get(id).base) e.base = live.get(id).base;
  }
  if (Object.keys(kept).length !== Object.keys(r).length || reworded.length) writeHanded(state, kept);
  return kept;
}

// ---- moving a ticket to another batch --------------------------------------------------------------
// The repo's other running batches a ticket of this batch can be moved into (batch-state.mjs
// moveTargetsOf), asked of queue.mjs in the supervisor's checkout. None when queue.mjs cannot say.
export function runningBatches(bin, { cwd, env = process.env } = {}) {
  const r = spawnSync(process.execPath, [join(bin, 'queue.mjs'), 'running'], { cwd, env, encoding: 'utf8' });
  try { return r.status === 0 ? moveTargetsOf(r.stdout) : []; } catch { return []; }
}
// A hand-on about a ticket's base or batch offers the person needs-you's move (batch-state.mjs moveOffer).
const BASE_ASK = /\b(base|batch)\b/i;

// ---- the session ---------------------------------------------------------------------------------
// Only what settling needs: requeue, move and record, read the ticket and the PR, read the state directory.
// Under config §3 autopilot-judgement yes (`judgement`), also take a call a worker parked on with a
// recommended option: answer it (answer.mjs --taken, which records no grant) and log it as the decider's.
export function deciderSettings({ bin, state, judgement = null }) {
  return {
    permissions: {
      allow: [
        `Bash(node ${join(bin, 'queue.mjs')} requeue:*)`,
        `Bash(node ${join(bin, 'needs-you.mjs')} move:*)`,
        `Bash(node ${join(bin, 'queue.mjs')} clears-when:*)`,
        `Bash(node ${join(bin, 'queue.mjs')} render)`,
        ...(judgement === 'yes' ? [
          `Bash(node ${join(bin, 'answer.mjs')} --taken:*)`,
          `Bash(node ${join(bin, 'decisions.mjs')} log --source decider:*)`,
        ] : []),
        'Bash(desk-jira get:*)',
        'Bash(gh pr view:*)',
        `Read(/${state}/**)`,
        `Grep(/${state}/**)`,
        `Glob(/${state}/**)`,
      ],
      deny: ['Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent'],
      additionalDirectories: [state],
    },
  };
}

export function deciderPrompt({ slug, report, items, rules, bin, state = null, webRead = false, targets = [], judgement = null }) {
  const answerLines = (i) => (i.answers ?? []).map((a) => `  - answered ${a.at}: ${a.text.replace(/\n/g, '\n    ')}`);
  const prevLines = (i) => (i.prev?.question ? [`  - park ${i.round}; the last requeue cleared park ${i.round - 1}: ${i.prev.question.replace(/\n/g, ' ')}`] : []);
  const questionLines = (i) => (i.questions ?? []).map((x) => `  - open question: ${x}`);
  const restateLines = (i) => (i.restate != null ? [`  - clears-when to restate: ${i.restate.replace(/\n/g, ' ')}`] : []);
  const list = items.flatMap((i) => [`- id \`${i.id}\` · ${i.ticket} · ${i.kind}${i.lane ? ` · lane ${i.lane}` : ''}: ${i.text}`, ...restateLines(i), ...questionLines(i), ...prevLines(i), ...answerLines(i)]).join('\n');
  // Only when an item's clears-when did not read, so a prompt without any reads as it always has.
  const onRestate = items.some((i) => i.restate != null) ? [
    `- an item with a "clears-when to restate" under it was parked with a condition no form reads, often a command or a sentence. Restate it once: where it names one fact a script can read, record that fact as one of the forms above (a \`gh pr view <n> … MERGED\` is \`pr <n> merged\`), keeping its meaning and adding nothing; where it names nothing a script can read (a person's answer, a comment, a sign-off), record \`none\` with \`node ${join(bin, 'queue.mjs')} clears-when <TICKET> none\`. Then deal with the item as the rest of these rules say: one now waiting on a recorded form is settled, and one recorded \`none\` goes to the person unless another rule settles it`,
  ] : [];
  // Only when an item has a previous park, so a prompt without any reads as it always has.
  const onRepeats = items.some((i) => i.prev?.question) ? [
    '- an item whose last requeue cleared a park asking the same thing in other words, with no answer under it, would only park again: hand it on, naming both parks in its `why`, rather than requeue it',
  ] : [];
  // Only when an item has answers, so a prompt without any reads as it always has.
  const onAnswers = items.some((i) => i.answers?.length) ? [
    '- an item with an answer under it was answered by the person since it parked or was handed on: act on the answer, and never hand the same question back. Where the answer lets the ticket carry on and it is lane A, B, D or E, and its park does not start `lane C` or `lane D` (one parked at triage), requeue it (its worker reads the answer from the briefing) and settle the item. Where the answer says to run it in another batch or on another base, move it there instead (a requeue would respawn it here, on this base): a batch that is not running cannot take it, so hand the item on naming the batches running. Where the step the answer asks for needs a config §3 row that is not `yes` (merging a green PR needs `pr-merge-green`, for one), hand the item on with that step and that row as its `why`, not the original question',
  ] : [];
  // Only when an item is parked, so a prompt without any reads as it always has.
  const onMove = items.some((i) => i.kind === 'parked') ? [
    `- move a parked ticket into another running batch of this repo, its next worker on that batch's base: \`node ${join(bin, 'needs-you.mjs')} move ${slug} <TICKET> <batch>\` (the standing batch is \`standing\`). The batches running beside this one: ${targetsText(targets)}`,
  ] : [];
  // Only where this repo's workers can read the web, so a prompt for any other repo reads as it always has.
  const onWeb = webRead ? [
    '- a park asking only for a public fact (a published figure, or a page, robots.txt or terms anyone can read on the web) is not a fact only the person holds: this repo\'s workers can search and read the web (config §3 `worker-web-read` is `yes`). On lane A, B, D or E, requeue it for its worker to look the fact up, and settle the item',
  ] : [];
  // Only where config §3 autopilot-judgement is yes and an item is parked, so a prompt for any other
  // repo reads as it always has. The ask categories are decisions.mjs ASK_CATEGORIES, worded as ask-or-take.md asks them.
  const takes = judgement === 'yes' && items.some((i) => i.kind === 'parked');
  const onTake = takes ? [
    `- take a call a worker could have taken itself (config §3 \`autopilot-judgement\` is \`yes\`): a park on lane A, B, D or E whose question marks one option as recommended (or as the worker's pick), on a ${TAKE_CATEGORIES.join(', ')} call, that touches no money, legal or regulatory matter, production data or credentials, new customer-facing copy or customer copy where length means cost, or fact only the person holds. Write the call once as <CALL>, \`'{"question": "<the question parked on, one line>", "options": ["<the recommended option>", "<each other option>"], "chose": "<the recommended option>", "category": "<one of ${TAKE_CATEGORIES.join(', ')}>"}'\`. Record it as the answer (which refuses an ask category before it writes anything), requeue it as above, then log the call, in that order, each only once the one before it succeeded, and settle the item:`,
    `  \`node ${join(bin, 'answer.mjs')} --taken <TICKET> <CALL>\`, which gives the worker "${recommendedAnswer({ chose: '<the recommended option>', category: '<category>' }, 'the decider')}"`,
    `  \`node ${join(bin, 'decisions.mjs')} log --source decider <TICKET> <CALL>\``,
    '  Keep the shell quoting whole: inside the single-quoted JSON write an apostrophe as `\'\\\'\'`, and leave `` ` `` and `$` out of it',
    '  A park with no option marked recommended, one in an ask category, one a session has claimed, one naming a config §3 row that is not `yes`, one asking what its last requeue\'s park asked, or one either command refuses: hand it on',
  ] : [];
  return [
    `${DECIDER_OPENING}${slug}. A pass has just exited needing the person, and nobody is reading: settle what the recovery rules below let the orchestrator do without asking, and hand everything else to the check-in digest. You cannot ask anything.`,
    '',
    'What you may do, and nothing else:',
    `- requeue a ticket whose worker parked asking for more agent work, on lane A, B, D or E:\`node ${join(bin, 'queue.mjs')} requeue <TICKET>\``,
    ...onMove,
    `- read: \`node ${join(bin, 'queue.mjs')} render\`, \`desk-jira get <KEY>\`, \`gh pr view <n> --json state,isDraft,headRefOid\`, and files in the batch state directory${state ? ` (${state})` : ''} with the Read, Grep and Glob tools only. Run each allowed command on its own: no \`cd\`, pipe or \`;\`, which are refused`,
    `- never requeue a lane C ticket or a park that starts \`lane C\` or \`lane D\` (parked at triage on its lane), never requeue or record a clears-when for a park that starts \`${LEFT_PREFIX}\` (left in a finished feature batch), never answer a ${takes ? 'product, design or copy question other than by taking its recommended option as below' : 'product, design or copy question'}, and never act on anything that needs a config §3 row that is not \`yes\`: hand those on`,
    `- for a parked ticket you hand on that waits on something a script can read, record it so a later pass settles it with no session: \`node ${join(bin, 'queue.mjs')} clears-when <TICKET> "<${CLEARS_WHEN_FORMS}>"\``,
    ...onRestate,
    ...onAnswers,
    ...onTake,
    ...onWeb,
    ...onRepeats,
    '',
    '## The items',
    '',
    list,
    '',
    '## The pass report',
    '',
    String(report ?? '').trimEnd(),
    '',
    '## The recovery rules',
    '',
    String(rules ?? '').trimEnd(),
    '',
    '## Your answer',
    '',
    `End your reply with one line, at the start of a line, giving every item id once: \`${RESULT_MARK} {"settled": [{"id": "<id>", "did": "<what you did, one line>"}], "handed": [{"id": "<id>", "why": "<why it needs the person, one line>"}]}\`. An item you leave out is handed on.`,
  ].join('\n');
}

// Starts the session detached, on the repo's subscription (call-login.mjs), its JSON result written to
// <state>/decider/<id>.json. Returns the record the supervisor keeps until the session ends, or
// { wait }, starting nothing, when the subscription is at its limit, no login here is signed in to it,
// or the pass's last health check found the API refusing its login (health.mjs refusedLogin), which
// that check's own item names to the person.
export function startDecider({ state, slug, bin, report, items, rules, webRead = false, targets = [], judgement = null, cwd, env = process.env, claude = 'claude', now = new Date() }) {
  const run = startHeadless({ state, kind: 'decider', id: now.toISOString().replace(/[:.]/g, '-'), effort: DECIDER_EFFORT, addDirs: [state], cwd, env, claude, now,
    settings: deciderSettings({ bin, state, judgement }), prompt: deciderPrompt({ slug, report, items, rules, bin, state, webRead, targets, judgement }) });
  return run.wait ? run : { ...run, items, targets };
}

// Starts one short headless session detached, on the repo's subscription (call-login.mjs), its settings,
// prompt and `--output-format json` result written to <state>/<kind>/<id>.*. -> { id, pid, started, out,
// login }, or { wait }, starting nothing, when no login can take it now or the pass's last health check
// found the API refusing its login (health.mjs refusedLogin).
export function startHeadless({ state, kind, id, settings, prompt, addDirs, effort, cwd, env: callerEnv = process.env, claude = 'claude', now = new Date() }) {
  const { login, env, wait } = callLogin({ env: callerEnv, now: now.getTime() });
  if (wait) return { wait };
  const refused = refusedLogin(state, login, login ? loginOf(callerEnv.CLAUDE_CONFIG_DIR) : null);
  if (refused) return { wait: `its login${login ? ` ${login.name}` : ''} failed its health check, ${refused}` };
  const dir = join(state, kind);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.settings.json`);
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  writeFileSync(join(dir, `${id}.prompt.md`), prompt);
  const out = join(dir, `${id}.json`);
  const fd = openSync(out, 'w');
  const child = spawn(claude, ['-p', prompt, '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--settings', file, ...addDirs.flatMap((d) => ['--add-dir', d]), '--effort', effort], {
    // One short session: the 5-minute prompt cache costs less to write than the 1-hour one.
    cwd, env: { ...env, FORCE_PROMPT_CACHING_5M: '1' }, detached: true, stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.on('error', () => {});
  child.unref();
  return { id, pid: child.pid ?? null, started: now.toISOString(), out, login: login?.name ?? null };
}

// The payload on the last `mark` line of a headless session's `--output-format json` text:
// {cost, payload}, or {cost, error} when there is no result line, no mark line or no JSON after it.
export function markedResult(text, mark) {
  let d = null;
  for (const line of String(text ?? '').split('\n').reverse()) { try { const x = JSON.parse(line); if (x?.type === 'result') { d = x; break; } } catch { /* not JSON */ } }
  if (!d) return { cost: null, error: `no result (${String(text ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 120) || 'empty output'})` };
  const cost = Number(d.total_cost_usd) || 0;
  const line = String(d.result ?? '').split('\n').reverse().find((l) => l.trimStart().startsWith(mark));
  if (!line) return { cost, error: `no ${mark} line` };
  try { return { cost, payload: JSON.parse(line.trimStart().slice(mark.length)) }; } catch { return { cost, error: `an unreadable ${mark} line` }; }
}

// A headless session's marked payload from its output file `out`: {cost, payload}, or {cost, error} when
// there is none to read, with `limit: true` when the usage limit stopped it.
export function readMarked(out, mark) {
  let text = '';
  try { text = readFileSync(out, 'utf8'); } catch { return { cost: null, error: 'no output' }; }
  const r = markedResult(text, mark);
  if (r.error && usageLimit(text).last?.kind === 'limit') return { cost: r.cost, error: 'stopped at the usage limit', limit: true };
  return r;
}

// The session's answer from its JSON result: {cost, settled: {id: did}, handed: {id: why}} or
// {cost, error} when there is no result line to read, with `limit: true` when the usage limit refused it.
export function readResult(out) {
  const { cost, error, limit, payload: r } = readMarked(out, RESULT_MARK);
  if (error) return { cost, error, ...(limit ? { limit } : {}) };
  const pairs = (xs, k) => Object.fromEntries((Array.isArray(xs) ? xs : []).filter((x) => x?.id).map((x) => [x.id, String(x[k] ?? '')]));
  return { cost, settled: pairs(r.settled, 'did'), handed: pairs(r.handed, 'why') };
}

// What a finished session settled and handed on. A park it says it settled that is still parked with
// the same question was not settled, unless it now waits on a clears-when it did not have, which each
// pass checks, or is put off in the "not now" register (read from `state`): either is settled, whatever
// the session called it. `q` is the queue as it stands now. A session the usage limit refused settled
// and handed on nothing: its items are kept for the next one. A park handed on that is about the
// ticket's base or batch offers the move, with the batches running when the session started.
export function outcome(rec, result, q = {}, { state = null } = {}) {
  if (result.limit) return { settled: [], handed: [], kept: rec.items, cost: result.cost ?? null };
  const settled = [];
  const handed = [];
  const ts = rec.targets ?? [];
  const offered = (item, why) => (item.kind === 'parked' && ts.length && (BASE_ASK.test(item.text) || BASE_ASK.test(why)) && !why.includes('move <batch>')
    ? `${why}; ${moveOffer(ts)}` : why);
  let register = null;
  const putOff = (t) => {
    if (!state) return false;
    register ??= readRegister(state);
    return lookup(register, { question: t.park.question, inputs: t.park.inputs ?? {} }).status === 'put_off';
  };
  for (const item of rec.items) {
    const did = result.settled?.[item.id];
    const t = q.tickets?.[item.ticket];
    const still = item.kind === 'parked' && t?.state === 'parked' && String(t.park?.question ?? '') === item.text;
    const waits = still && condKey(t.park?.clears_when) && condKey(t.park.clears_when) !== item.clears;
    if (waits) settled.push({ item, did: `recorded clears-when "${describeCond(t.park.clears_when)}", which a later pass checks` });
    else if (still && putOff(t)) settled.push({ item, did: 'put off with "not now": left parked until its inputs change' });
    else if (did != null && !still) settled.push({ item, did });
    else if (did != null) handed.push({ item, why: offered(item, `the decider said "${did}", but ${item.ticket} is still parked`) });
    else handed.push({ item, why: offered(item, result.error ? `decider ${result.error}` : result.handed?.[item.id] || 'the decider handed it on') });
  }
  return { settled, handed, cost: result.cost ?? null };
}

// The cost as the report gives it: unknown when the session left no result, never zero.
const costText = (cost) => (cost == null ? 'cost unknown' : `$${cost.toFixed(2)}`);

// One line for the batch report: the session's cost and what it settled or handed on.
export function reportLine(rec, o) {
  if (o.kept) return `decider ${rec.id}: ${costText(o.cost)}; stopped at the usage limit, so it settled nothing and handed nothing on; ${o.kept.map((i) => i.ticket).join(', ') || 'nothing'} kept for the next decider`;
  const s = o.settled.map((x) => `${x.item.ticket} (${x.did})`).join(', ') || 'nothing';
  const hd = o.handed.map((x) => `${x.item.ticket} (${x.why})`).join(', ') || 'nothing';
  return `decider ${rec.id}: ${costText(o.cost)}; settled ${s}; handed to the digest ${hd}`;
}

// What it did and cost, for the workers and the orchestrator who read the batch notes.
export function noteOutcome(state, o, now = new Date()) {
  if (o.kept) return;
  const at = now.toISOString();
  const lines = [
    `- [decider] ${at} a session ran: ${costText(o.cost)}\n`,
    ...o.settled.map((x) => `- [decider] ${at} ${x.item.ticket}: ${x.did}\n`),
    ...o.handed.map((x) => `- [decider] ${at} ${x.item.ticket}: handed to the check-in digest (${x.why})\n`),
  ];
  if (lines.length) appendFileSync(join(state, 'batch-notes.md'), lines.join(''));
}
