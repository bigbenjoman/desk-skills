#!/usr/bin/env node
// The decision log: one JSON line per call a session took on its own recommendation rather than
// asking, in <state>/decisions.jsonl, for the check-in digest to list. A worker prints
// `AUTOPILOT_DECISION: <json>` and pass.mjs appends it when it harvests the run; an interactive
// session appends through this file's CLI:
//
//   decisions.mjs log <TICKET> '<json>' [--pr <number or URL>]
//   decisions.mjs check <TICKET> '{"question", "checked", "showed"}' [--pr <number or URL>]
//
// A check is a question the session settled by checking instead of asking (`AUTOPILOT_CHECKED:` from a
// worker), logged with what it checked and what that showed. Intake logs the calls a triage record
// took (triageCalls) when it admits the ticket.
// <json> is {"question", "options": [...], "chose", "category"}. Exits 0 once the entry is in the
// log (or already was), 11 (show the person) on anything it refuses: EXIT in batch-state.mjs.
import { readFileSync, appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir, ghRepo, SAFE_ID } from './desk-env.mjs';

// The calls that are always asked, never taken: money, legal or regulatory, production data or
// credentials, customer copy where length means cost, and facts only the user holds.
export const ASK_CATEGORIES = ['money', 'legal', 'production', 'customer-copy', 'user-fact'];
// Everything else is taken on the recommendation and logged, under one of these.
export const TAKE_CATEGORIES = ['product', 'design', 'wording', 'review', 'engineering', 'scope', 'tracker'];

export const decisionsPath = (dir = stateDir()) => join(dir, 'decisions.jsonl');

const text = (v) => typeof v === 'string' && v.trim() !== '';

// {ok: true, decision} or {ok: false, why}. An ask category is refused: that call parks or asks,
// and is never logged as taken.
export function parseDecision(raw) {
  let d;
  try { d = JSON.parse(String(raw ?? '').trim()); } catch { return { ok: false, why: 'not JSON' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, why: 'not a JSON object' };
  if (!text(d.question)) return { ok: false, why: 'no question' };
  if (!Array.isArray(d.options) || d.options.length < 2 || !d.options.every(text)) {
    return { ok: false, why: 'options must list at least two choices' };
  }
  if (!text(d.chose) || !d.options.includes(d.chose)) return { ok: false, why: 'chose is not one of the options' };
  if (ASK_CATEGORIES.includes(d.category)) return { ok: false, why: `${d.category} is an ask category: ask, never take it` };
  if (!TAKE_CATEGORIES.includes(d.category)) return { ok: false, why: `category must be one of ${TAKE_CATEGORIES.join(', ')}` };
  return { ok: true, decision: { question: d.question.trim(), options: d.options.map((o) => o.trim()), chose: d.chose.trim(), category: d.category } };
}

// A triage record's questions, split: `ask` (strings) waits for the person, `taken` (decisions) is
// each call triage made on its recommendation. An unknown is a string, asked, or
// {question, category, options, recommended}: taken when parseDecision accepts it with `recommended`
// as the choice, asked otherwise. Entries already in `decided` are taken, so a split record splits
// the same again.
export function triageCalls(rec) {
  const ask = [];
  const taken = [];
  const asDecision = (u) => parseDecision(JSON.stringify({ question: u.question, options: u.options, chose: u.recommended ?? u.chose, category: u.category }));
  for (const u of Array.isArray(rec?.unknowns) ? rec.unknowns : []) {
    const obj = u && typeof u === 'object' && !Array.isArray(u);
    const d = obj ? asDecision(u) : null;
    if (d?.ok) taken.push(d.decision);
    else if (obj) ask.push(text(u.question) ? u.question.trim() : JSON.stringify(u));
    else if (text(String(u ?? ''))) ask.push(String(u).trim());
  }
  for (const u of Array.isArray(rec?.decided) ? rec.decided : []) {
    const d = u && typeof u === 'object' ? asDecision(u) : null;
    if (d?.ok && !taken.some((t) => t.question === d.decision.question)) taken.push(d.decision);
  }
  return { ask, taken };
}

// One ticket's calls and checks from a decision log as digest.mjs readDecisions splits it, each taken
// call with the person's override applied: `chose` is the override's, `was` the call triage or a worker
// took, `by` who overrode it.
export function ticketCalls({ taken = [], checks = [], overrides = [] } = {}, ticket) {
  const over = new Map(overrides.filter((o) => o.ticket === ticket).map((o) => [o.override_of, o]));
  return {
    taken: taken.filter((d) => d.ticket === ticket).map((d) => {
      const o = over.get(d.id);
      return o ? { ...d, chose: o.chose, was: d.chose, by: o.by ?? null } : d;
    }),
    checks: checks.filter((c) => c.ticket === ticket),
  };
}

// A question a session settled by checking rather than asking: {"question", "checked", "showed"}.
// {ok: true, check} or {ok: false, why}.
export function parseCheck(raw) {
  let d;
  try { d = JSON.parse(String(raw ?? '').trim()); } catch { return { ok: false, why: 'not JSON' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, why: 'not a JSON object' };
  for (const k of ['question', 'checked', 'showed']) if (!text(d[k])) return { ok: false, why: `no ${k}` };
  return { ok: true, check: { kind: 'check', question: d.question.trim(), checked: d.checked.trim(), showed: d.showed.trim() } };
}

export const prLink = (pr, repo) => {
  if (pr == null || pr === '') return null;
  if (/^https?:\/\//.test(String(pr))) return String(pr);
  return /^\d+$/.test(String(pr)) && repo ? `https://github.com/${repo}/pull/${pr}` : null;
};

// One run taking one call, or making one check, is one entry, however often its log is read.
export function decisionEntry({ decision, ticket, run, repo, pr, at = new Date().toISOString(), source }) {
  const said = decision.kind === 'check' ? `check\0${decision.checked}` : decision.chose;
  const id = createHash('sha256').update([ticket, run ?? '', decision.question, said].join('\0')).digest('hex').slice(0, 16);
  return { id, at, repo, ticket, ...decision, pr: prLink(pr, repo), source, run: run ?? null };
}

const loggedIds = (path) => {
  if (!existsSync(path)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try { const e = JSON.parse(line); if (e?.id) ids.add(e.id); } catch { /* a torn line is not an entry */ }
  }
  return ids;
};

// Appends the entries the log does not already hold; returns those it appended.
export function appendDecisions(entries, dir = stateDir()) {
  const path = decisionsPath(dir);
  const seen = loggedIds(path);
  const fresh = [];
  for (const e of entries) if (!seen.has(e.id)) { seen.add(e.id); fresh.push(e); }
  if (fresh.length) {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, fresh.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  return fresh;
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const { EXIT, crashShowsPerson } = await import('./batch-state.mjs');
  crashShowsPerson();
  const args = process.argv.slice(2);
  const prAt = args.indexOf('--pr');
  const pr = prAt >= 0 ? args[prAt + 1] : null;
  const [cmd, ticket, raw] = prAt >= 0 ? [...args.slice(0, prAt), ...args.slice(prAt + 2)] : args;
  const refuse = (why) => { console.error(why); process.exit(EXIT.SHOW_PERSON); };
  if (!['log', 'check'].includes(cmd) || !ticket || !raw) {
    refuse('usage: decisions.mjs log <TICKET> \'{"question","options":[…],"chose","category"}\' [--pr <number or URL>]\n' +
      '       decisions.mjs check <TICKET> \'{"question","checked","showed"}\' [--pr <number or URL>]');
  }
  if (!SAFE_ID.test(ticket) || ticket.includes('..')) refuse(`'${ticket}' is not usable as a ticket id (letters, digits, . _ - only; no ..)`);
  const repo = ghRepo();
  if (prAt >= 0 && !prLink(pr, repo)) refuse(`--pr takes a PR number or URL, not '${pr ?? ''}'`);
  const parsed = cmd === 'check' ? parseCheck(raw) : parseDecision(raw);
  if (!parsed.ok) refuse(`not logged: ${parsed.why}`);
  const entry = decisionEntry({
    decision: parsed.check ?? parsed.decision, ticket, run: process.env.CLAUDE_CODE_SESSION_ID ?? 'session', repo, pr, source: 'session',
  });
  const added = appendDecisions([entry]);
  console.log(`${added.length ? 'logged' : 'already logged'}: ${entry.id} in ${decisionsPath()}`);
}
