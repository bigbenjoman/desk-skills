// The decider: a fresh, small headless session the supervisor starts when a pass exits needing the
// person. It is given that pass's report and the recovery rules, settles what the rules let the
// orchestrator settle without asking (a requeue, mostly), and hands everything else to the check-in
// digest. One runs at a time per repo, at low effort, and is stopped after DECIDER_TIMEOUT_MS.
//
// What a pass lists becomes items, each with an id that stays the same while the item does:
//   - a lane C or D park, and anything naming a config §3 row that is not `yes`, is handed straight on;
//   - the rest go to the session, unless already handed and not answered since (an answer through
//     answer.mjs, which the ticket's briefing records);
//   - what the session does not report settled is handed on with its reason.
// Handed items live in <state>/handed.json, which the digest lists; one the pass no longer lists is dropped.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { answersSince } from './handoff.mjs';

export const DECIDER_TIMEOUT_MS = 15 * 60 * 1000;
export const DECIDER_EFFORT = 'low';
export const RESULT_MARK = 'DECIDER_RESULT:';

const h = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };

// One item per parked ticket and per WAITING ON YOU line, as the pass's verdict names them. A line
// whose label is no queue ticket (`BASE GATE`, `base sync`) is the batch's, with no ticket to answer.
export function deciderItems(v, q = {}) {
  const tickets = q.tickets ?? {};
  const parked = (Array.isArray(v?.parked) ? v.parked : []).map((p) => ({
    id: `park-${h(`${p.key}\0${p.question ?? ''}`)}`, ticket: p.key, kind: 'parked', text: String(p.question ?? ''), lane: tickets[p.key]?.lane ?? null,
  }));
  const waiting = (Array.isArray(v?.waiting) ? v.waiting : []).map((line) => {
    const label = String(line).split(':')[0];
    return { id: `wait-${h(line)}`, ticket: label, kind: tickets[label] ? 'waiting' : 'batch', text: String(line), lane: tickets[label]?.lane ?? null };
  });
  return [...parked, ...waiting];
}

// Items the rules hand on without a session: {hand: [{item, why}], ask: [item]}. A §3 row is read as
// the pass's line gives it.
export function presort(items) {
  const hand = [];
  const ask = [];
  for (const item of items) {
    const row = /config §3 `?([\w-]+)`? is "([^"]*)"/.exec(item.text);
    if (item.kind === 'parked' && ['C', 'D'].includes(item.lane)) {
      hand.push({ item, why: `lane ${item.lane} park: never requeued for a headless worker, it goes to an interactive desk-ticket session` });
    } else if (row && row[2] !== 'yes') {
      hand.push({ item, why: `needs config §3 ${row[1]}, which is "${row[2]}"` });
    } else ask.push(item);
  }
  return { hand, ask };
}

// ---- the handed register -----------------------------------------------------------------------
export const handedPath = (state) => join(state, 'handed.json');
export const readHanded = (state) => readJson(handedPath(state), {}) ?? {};
const writeHanded = (state, r) => writeFileSync(handedPath(state), `${JSON.stringify(r, null, 2)}\n`);

// Has the person answered this ticket since the item was handed on? answer.mjs records every answer,
// the digest's included, in the ticket's briefing.
export function answered(state, entry) {
  const brief = join(state, 'briefings', `${entry.ticket}.md`);
  if (!existsSync(brief)) return false;
  return answersSince(readFileSync(brief, 'utf8'), entry.at).length > 0;
}

// Items a session may be started for: none handed on and still unanswered.
export const freshItems = (state, items, handed = readHanded(state)) => items.filter((i) => !handed[i.id] || answered(state, handed[i.id]));

// Records items handed on and returns the ones newly recorded. One already handed and still
// unanswered keeps its time, so a later answer still counts; one answered since is handed again from now.
export function handItems(state, handed, now = new Date()) {
  const r = readHanded(state);
  const added = [];
  for (const h of handed) {
    if (r[h.item.id] && !answered(state, r[h.item.id])) continue;
    r[h.item.id] = { id: h.item.id, ticket: h.item.ticket, kind: h.item.kind, text: h.item.text, why: h.why, at: now.toISOString() };
    added.push(h);
  }
  if (added.length) writeHanded(state, r);
  return added;
}

// Drops every handed item the latest pass no longer lists: it was settled some other way.
export function pruneHanded(state, items) {
  const r = readHanded(state);
  const live = new Set(items.map((i) => i.id));
  const kept = Object.fromEntries(Object.entries(r).filter(([id]) => live.has(id)));
  if (Object.keys(kept).length !== Object.keys(r).length) writeHanded(state, kept);
  return kept;
}

// ---- the session ---------------------------------------------------------------------------------
// Only what settling needs: requeue and record, read the ticket and the PR, read the state directory.
export function deciderSettings({ bin, state }) {
  return {
    permissions: {
      allow: [
        `Bash(node ${join(bin, 'queue.mjs')} requeue:*)`,
        `Bash(node ${join(bin, 'queue.mjs')} render)`,
        `Bash(node ${join(bin, 'answer.mjs')}:*)`,
        'Bash(desk-jira get:*)',
        'Bash(gh pr view:*)',
        `Read(/${state}/**)`,
      ],
      deny: ['Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent'],
      additionalDirectories: [state],
    },
  };
}

export function deciderPrompt({ slug, report, items, rules, bin }) {
  const list = items.map((i) => `- id \`${i.id}\` · ${i.ticket} · ${i.kind}${i.lane ? ` · lane ${i.lane}` : ''}: ${i.text}`).join('\n');
  return [
    `You are the autopilot decider for ${slug}. A pass has just exited needing the person, and nobody is reading: settle what the recovery rules below let the orchestrator do without asking, and hand everything else to the check-in digest. You cannot ask anything.`,
    '',
    'What you may do, and nothing else:',
    `- requeue a ticket whose worker parked asking for more agent work, on lane A, B or E: \`node ${join(bin, 'queue.mjs')} requeue <TICKET>\``,
    `- read: \`node ${join(bin, 'queue.mjs')} render\`, \`desk-jira get <KEY>\`, \`gh pr view <n> --json state,isDraft,headRefOid\`, and files in the batch state directory`,
    '- never requeue a lane C or D park, never answer a product, design or copy question, and never act on anything that needs a config §3 row that is not `yes`: hand those on',
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

// Starts the session detached, its JSON result written to <state>/decider/<id>.json. Returns the
// record the supervisor keeps until the session ends.
export function startDecider({ state, slug, bin, report, items, rules, cwd, env = process.env, claude = 'claude', now = new Date() }) {
  const dir = join(state, 'decider');
  mkdirSync(dir, { recursive: true });
  const id = `${now.toISOString().replace(/[:.]/g, '-')}`;
  const settings = join(dir, `${id}.settings.json`);
  writeFileSync(settings, `${JSON.stringify(deciderSettings({ bin, state }), null, 2)}\n`);
  const prompt = deciderPrompt({ slug, report, items, rules, bin });
  writeFileSync(join(dir, `${id}.prompt.md`), prompt);
  const out = join(dir, `${id}.json`);
  const fd = openSync(out, 'w');
  const child = spawn(claude, ['-p', prompt, '--output-format', 'json', '--setting-sources', '', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--settings', settings, '--add-dir', state, '--effort', DECIDER_EFFORT], {
    cwd, env, detached: true, stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.on('error', () => {});
  child.unref();
  return { id, pid: child.pid ?? null, started: now.toISOString(), out, items };
}

// The session's answer from its JSON result: {cost, settled: {id: did}, handed: {id: why}} or
// {cost, error} when there is no result line to read.
export function readResult(out) {
  let text = '';
  try { text = readFileSync(out, 'utf8'); } catch { return { cost: null, error: 'no output' }; }
  let d = null;
  for (const line of text.split('\n').reverse()) { try { const x = JSON.parse(line); if (x?.type === 'result') { d = x; break; } } catch { /* not JSON */ } }
  if (!d) return { cost: null, error: `no result (${text.trim().split('\n').slice(-1)[0]?.slice(0, 120) || 'empty output'})` };
  const cost = Number(d.total_cost_usd) || 0;
  const line = String(d.result ?? '').split('\n').reverse().find((l) => l.trimStart().startsWith(RESULT_MARK));
  if (!line) return { cost, error: `no ${RESULT_MARK} line` };
  let r;
  try { r = JSON.parse(line.trimStart().slice(RESULT_MARK.length)); } catch { return { cost, error: `an unreadable ${RESULT_MARK} line` }; }
  const pairs = (xs, k) => Object.fromEntries((Array.isArray(xs) ? xs : []).filter((x) => x?.id).map((x) => [x.id, String(x[k] ?? '')]));
  return { cost, settled: pairs(r.settled, 'did'), handed: pairs(r.handed, 'why') };
}

// What a finished session settled and handed on. A park it says it settled that is still parked with
// the same question was not settled. `q` is the queue as it stands now.
export function outcome(rec, result, q = {}) {
  const settled = [];
  const handed = [];
  for (const item of rec.items) {
    const did = result.settled?.[item.id];
    const t = q.tickets?.[item.ticket];
    const still = item.kind === 'parked' && t?.state === 'parked' && String(t.park?.question ?? '') === item.text;
    if (did != null && !still) settled.push({ item, did });
    else if (did != null) handed.push({ item, why: `the decider said "${did}", but ${item.ticket} is still parked` });
    else handed.push({ item, why: result.error ? `decider ${result.error}` : result.handed?.[item.id] || 'the decider handed it on' });
  }
  return { settled, handed, cost: result.cost ?? null };
}

// The cost as the report gives it: unknown when the session left no result, never zero.
const costText = (cost) => (cost == null ? 'cost unknown' : `$${cost.toFixed(2)}`);

// One line for the batch report: the session's cost and what it settled or handed on.
export function reportLine(rec, o) {
  const s = o.settled.map((x) => `${x.item.ticket} (${x.did})`).join(', ') || 'nothing';
  const hd = o.handed.map((x) => `${x.item.ticket} (${x.why})`).join(', ') || 'nothing';
  return `decider ${rec.id}: ${costText(o.cost)}; settled ${s}; handed to the digest ${hd}`;
}

// What it did and cost, for the workers and the orchestrator who read the batch notes.
export function noteOutcome(state, o, now = new Date()) {
  const at = now.toISOString();
  const lines = [
    `- [decider] ${at} a session ran: ${costText(o.cost)}\n`,
    ...o.settled.map((x) => `- [decider] ${at} ${x.item.ticket}: ${x.did}\n`),
    ...o.handed.map((x) => `- [decider] ${at} ${x.item.ticket}: handed to the check-in digest (${x.why})\n`),
  ];
  if (lines.length) appendFileSync(join(state, 'batch-notes.md'), lines.join(''));
}
