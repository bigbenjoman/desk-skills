#!/usr/bin/env node
// The check-in digest: at each config §3b "Check-in times" slot, one page listing every repo's open
// questions and the decisions taken since the last digest, and one push notification naming the
// counts. Every repo's pass calls checkin(); a machine-wide lock and the last digest's slot make the
// first pass past a slot the only one to build it, and a slot no pass saw is covered by the next one.
// Only a park reading `PRODUCTION BROKEN: …` is pushed between check-ins (urgentParks).
//
//   digest.mjs checkin                                    this repo's check-in now, as JSON (the supervisor's idle ticks)
//   digest.mjs answer <slug> <TICKET> "<answer>"          record it through that repo's answer.mjs
//   digest.mjs override <slug> <decision-id> "<choice>"   record an override in that repo's decision log
//
// The page and its state live in ~/.desk-autopilot/digest/ (DESK_DIGEST_DIR overrides). Exits 0 once
// recorded, 11 (show the person) on anything it refuses: EXIT in batch-state.mjs.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { isHeld } from './batch-state.mjs';
import { takeBorrowLock } from './borrow.mjs';

export const DEFAULT_TIMES = ['08:00', '17:00'];
export const PRODUCTION_BROKEN = /^\s*production broken\b/i;
export const digestDir = () => E.expandHome(process.env.DESK_DIGEST_DIR ?? join(E.HOME, '.desk-autopilot', 'digest'));
const stateRoot = () => join(E.HOME, '.desk-autopilot');

// The row as read from config: every backtick span, since `08:00`, `17:00` is two of them.
export const checkinRow = () => (E.configValues('checkin-times') ?? []).join(' ') || null;

// The §3b row as sorted HH:MM strings: {ok, times} or {ok: false, why}. Unset is the default.
export function checkinTimes(raw) {
  if (raw == null || raw === '' || /^todo\b/i.test(raw)) return { ok: true, times: DEFAULT_TIMES };
  const parts = String(raw).split(/[\s,]+/).filter(Boolean);
  const bad = parts.filter((p) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(p));
  if (!parts.length || bad.length) {
    return { ok: false, why: `config §3b "Check-in times" is "${raw}": want local HH:MM times, e.g. \`08:00, 17:00\`` };
  }
  return { ok: true, times: [...new Set(parts)].sort() };
}

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// The latest check-in slot at or before `now`, as {id: 'YYYY-MM-DDTHH:MM', at: Date}, local time.
export function latestSlot(times, now = new Date()) {
  for (let back = 0; back < 2; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    for (const t of [...times].reverse()) {
      const [h, m] = t.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      if (at <= now) return { id: `${localDay(at)}T${t}`, at };
    }
  }
  return null;
}

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const readLines = (path) => {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) { try { const e = JSON.parse(line); if (e) out.push(e); } catch { /* a torn line */ } }
  return out;
};
const lastFile = (dir) => join(dir, 'last.json');
const answeredFile = (dir) => join(dir, 'answered.json');
const questionKey = (slug, ticket, text) => `${slug}/${ticket}/${createHash('sha256').update(String(text)).digest('hex').slice(0, 12)}`;

// Every repo with a queue or a decision log: {slug, state, queue}. `self` names the calling repo's
// paths, which environment overrides can move away from the defaults.
export function repos({ home = E.deskHome(), root = stateRoot(), self = null } = {}) {
  const found = new Map();
  const add = (slug, r) => { if (!found.has(slug)) found.set(slug, r); };
  if (self) add(self.slug, self);
  const qdir = join(home, 'repos');
  for (const slug of existsSync(qdir) ? readdirSync(qdir) : []) {
    if (existsSync(join(qdir, slug, 'queue.json'))) add(slug, { slug, state: join(root, slug), queue: join(qdir, slug, 'queue.json') });
  }
  for (const slug of existsSync(root) ? readdirSync(root) : []) {
    if (existsSync(join(root, slug, 'decisions.jsonl'))) add(slug, { slug, state: join(root, slug), queue: join(qdir, slug, 'queue.json') });
  }
  return [...found.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

// The decision log split into taken calls and the overrides recorded against them.
export function readDecisions(state) {
  const all = readLines(join(state, 'decisions.jsonl'));
  const overrides = all.filter((e) => e.override_of);
  return { taken: all.filter((e) => !e.override_of && e.id), overrides };
}

// One repo's open questions: each parked ticket's question (a hold is not one) and each triaged
// ticket's unanswered triage unknowns. Questions already answered from a digest are left out.
export function openQuestions(r, answered = {}) {
  const q = readJson(r.queue, null);
  const out = [];
  for (const t of Object.values(q?.tickets ?? {})) {
    if (t.state === 'parked' && !isHeld(t)) {
      const text = String(t.park?.question ?? 'parked, with no question recorded');
      // Keyed to this park, so the same question parked again after a requeue is a new one.
      const key = questionKey(r.slug, t.key, `${text}\0${t.park?.since ?? ''}`);
      if (!answered[key]) out.push({ ticket: t.key, kind: 'parked', text, key });
    } else if (t.state === 'triaged' && (t.open_questions ?? 0) > 0) {
      const unknowns = readJson(join(r.state, 'triage', `${t.key}.json`), {})?.unknowns;
      const text = Array.isArray(unknowns) && unknowns.length ? unknowns.join(' · ') : `${t.open_questions} triage question(s) open`;
      const key = questionKey(r.slug, t.key, text);
      if (!answered[key]) out.push({ ticket: t.key, kind: 'triage', text, key });
    }
  }
  return out.sort((a, b) => a.ticket.localeCompare(b.ticket));
}

// The page: every repo with something to answer or something taken, questions first.
export function renderPage({ slot, since, groups, bin = E.binDir() }) {
  const nq = groups.reduce((n, g) => n + g.questions.length, 0);
  const nd = groups.reduce((n, g) => n + g.decisions.length, 0);
  const cmd = join(bin, 'digest.mjs');
  const lines = [`# Check-in ${slot.replace('T', ' ')}`, ''];
  if (!nq && !nd) {
    lines.push(`Nothing to answer, and no decisions taken${since ? ` since ${since}` : ''}.`, '');
    return lines.join('\n');
  }
  lines.push(`${nq} question(s) to answer, ${nd} decision(s) taken${since ? ` since ${since}` : ''}.`, '');
  for (const g of groups.filter((x) => x.questions.length || x.decisions.length)) {
    lines.push(`## ${g.slug}`, '');
    if (g.questions.length) {
      lines.push('### Questions', '');
      for (const q of g.questions) {
        lines.push(`- [ ] \`${q.ticket}\` (${q.kind}): ${q.text}`);
        lines.push(`  answer: \`node ${cmd} answer ${g.slug} ${q.ticket} "<answer>"\``);
      }
      lines.push('');
    }
    if (g.decisions.length) {
      lines.push('### Decisions taken', '');
      for (const d of g.decisions) {
        lines.push(`- [ ] \`${d.ticket}\` ${d.category}: ${d.question} Chose **${d.chose}** (options: ${d.options.join(' · ')})${d.pr ? ` [PR](${d.pr})` : ''} · id \`${d.id}\``);
        lines.push(`  override: \`node ${cmd} override ${g.slug} ${d.id} "<choice>"\``);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// Builds the digest for the latest slot if no digest has covered it yet, under a machine-wide lock
// never waited on: a live holder is building the same slot. Returns {status, push, ...}: `sent` with
// the page and counts, `not_due` (the latest slot already has one) or `busy`. `push` is {key, text},
// or null when nothing is new since the last digest: a question the last page did not list, or a
// decision taken since. The repo that built the latest digest keeps getting its push until the next
// slot, so a notification that failed goes out on a later pass; consumers send each key once.
export async function checkin({ times, now = new Date(), dir = digestDir(), list = repos(), bin = E.binDir(), self = null, pid = process.pid } = {}) {
  const slot = latestSlot(times, now);
  if (!slot) return { status: 'not_due', push: null };
  mkdirSync(dir, { recursive: true });
  const lock = await takeBorrowLock({ dir, name: 'digest.lock.d', waitMs: 0, pid });
  if (!lock.ok) return { status: 'busy', why: lock.why, push: null };
  try {
    // Read under the lock: a pass that took it a moment earlier may have just sent this slot.
    const last = readJson(lastFile(dir), null);
    if (last?.slot && last.slot >= slot.id) {
      const carried = last.slot === slot.id && self && last.by === self ? last.push ?? null : null;
      return { status: 'not_due', slot: slot.id, push: carried };
    }
    const answered = readJson(answeredFile(dir), {});
    const since = last?.through ?? null;
    const groups = list.map((r) => {
      const { taken, overrides } = readDecisions(r.state);
      const overridden = new Set(overrides.map((o) => o.override_of));
      const decisions = taken.filter((d) => (!since || d.at > since) && d.at <= now.toISOString() && !overridden.has(d.id));
      return { slug: r.slug, questions: openQuestions(r, answered), decisions };
    });
    const page = join(dir, `${slot.id.replace(':', '')}.md`);
    writeFileSync(page, renderPage({ slot: slot.id, since, groups, bin }));
    const nq = groups.reduce((n, g) => n + g.questions.length, 0);
    const nd = groups.reduce((n, g) => n + g.decisions.length, 0);
    const listed = groups.flatMap((g) => g.questions.map((q) => q.key));
    const fresh = listed.filter((k) => !(last?.listed ?? []).includes(k));
    const repoCount = groups.filter((g) => g.questions.length || g.decisions.length).length;
    const push = nd || fresh.length
      ? { key: `digest:${slot.id}`, text: `Check-in ${slot.id.slice(11)}: ${nq} question(s), ${nd} decision(s) across ${repoCount} repo(s). ${page}` }
      : null;
    writeFileSync(lastFile(dir), `${JSON.stringify({ slot: slot.id, through: now.toISOString(), page, questions: nq, decisions: nd, listed, by: self, push }, null, 2)}\n`);
    return { status: 'sent', slot: slot.id, page, questions: nq, decisions: nd, push };
  } finally { lock.release(); }
}

// Pushed at once, outside the check-in times: each parked ticket whose question reads production broken.
export const urgentParks = (parked, slug) => parked
  .filter((p) => PRODUCTION_BROKEN.test(p.question ?? ''))
  .map((p) => ({ key: `urgent:${slug}:${p.key}`, text: `${p.key}: ${p.question}` }));

// Marks a line of the latest page: the question or decision named by `match`, with `note`.
function markPage(dir, match, note) {
  const page = readJson(lastFile(dir), null)?.page;
  if (!page || !existsSync(page)) return false;
  const lines = readFileSync(page, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('- [ ] ') && match(l));
  if (at < 0) return false;
  lines[at] = `${lines[at].replace('- [ ] ', '- [x] ')} — ${note}`;
  writeFileSync(page, lines.join('\n'));
  return true;
}

const who = () => {
  try { const n = E.configValue('name'); if (n) return n; } catch { /* outside a repo */ }
  return userInfo().username;
};

// Records an answer through the named repo's answer.mjs, as an answer given there would be.
export function answer({ slug, ticket, text, dir = digestDir(), list = repos(), bin = E.binDir(), now = new Date() }) {
  const r = list.find((x) => x.slug === slug);
  if (!r) return { ok: false, why: `no repo ${slug} in the digest (it has no queue and no decision log)` };
  const question = openQuestions(r).find((q) => q.ticket === ticket);
  let out;
  try {
    out = execFileSync('node', [join(bin, 'answer.mjs'), ticket, text], {
      encoding: 'utf8', env: { ...process.env, DESK_AUTOPILOT_STATE: r.state, DESK_QUEUE: r.queue }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) { return { ok: false, why: `answer.mjs refused: ${`${e.stdout ?? ''}${e.stderr ?? ''}`.trim()}` }; }
  if (question) {
    const answered = readJson(answeredFile(dir), {});
    answered[question.key] = now.toISOString();
    mkdirSync(dir, { recursive: true });
    writeFileSync(answeredFile(dir), `${JSON.stringify(answered, null, 2)}\n`);
  }
  const marked = markPage(dir, (l) => l.includes(`\`${ticket}\` (`) && pageRepo(dir, l, slug), `answered ${now.toISOString()}`);
  return { ok: true, out, marked };
}

// True when the page line sits under the `## <slug>` heading.
function pageRepo(dir, line, slug) {
  const page = readJson(lastFile(dir), null)?.page;
  const lines = readFileSync(page, 'utf8').split('\n');
  const heading = lines.slice(0, lines.indexOf(line)).reverse().find((l) => l.startsWith('## '));
  return heading === `## ${slug}`;
}

// Records an override of a taken call in its repo's decision log, with who and when. The next pass
// in that repo lists the ticket under WAITING ON YOU (pass.mjs).
export function override({ slug, id, choice, dir = digestDir(), list = repos(), by = who(), now = new Date() }) {
  const r = list.find((x) => x.slug === slug);
  if (!r) return { ok: false, why: `no repo ${slug} in the digest (it has no queue and no decision log)` };
  const { taken, overrides } = readDecisions(r.state);
  const d = taken.find((x) => x.id === id);
  if (!d) return { ok: false, why: `no decision ${id} in ${slug}'s log` };
  if (overrides.some((o) => o.override_of === id)) return { ok: false, why: `decision ${id} is already overridden` };
  const at = now.toISOString();
  const entry = {
    id: createHash('sha256').update(['override', id, choice, at].join('\0')).digest('hex').slice(0, 16),
    override_of: id, at, repo: d.repo, ticket: d.ticket, question: d.question, was: d.chose, chose: choice, by,
  };
  appendFileSync(join(r.state, 'decisions.jsonl'), `${JSON.stringify(entry)}\n`);
  const marked = markPage(dir, (l) => l.includes(`id \`${id}\``), `overridden to **${choice}** by ${by} at ${at}`);
  return { ok: true, entry, marked };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const { EXIT, crashShowsPerson } = await import('./batch-state.mjs');
  crashShowsPerson();
  const [cmd, slug, target, ...rest] = process.argv.slice(2);
  const text = rest.join(' ').trim();
  const refuse = (why) => { console.error(why); process.exit(EXIT.SHOW_PERSON); };
  if (cmd === 'checkin') {
    const times = checkinTimes(checkinRow());
    if (!times.ok) refuse(times.why);
    const self = E.repoSlug();
    console.log(JSON.stringify(await checkin({ times: times.times, self, list: repos({ self: { slug: self, state: E.stateDir(), queue: E.queueFile() } }) })));
    process.exit(0);
  }
  if (!['answer', 'override'].includes(cmd) || !slug || !target || !text) {
    refuse('usage: digest.mjs answer <slug> <TICKET> "<answer>" | digest.mjs override <slug> <decision-id> "<choice>"');
  }
  if (!E.SAFE_ID.test(slug) || slug.includes('..')) refuse(`'${slug}' is not a repo slug`);
  if (cmd === 'answer') {
    const r = answer({ slug, ticket: target, text });
    if (!r.ok) refuse(r.why);
    process.stdout.write(r.out);
    console.log(r.marked ? 'digest: marked answered on the page' : 'digest: recorded; the latest page does not list that question');
  } else {
    const r = override({ slug, id: target, choice: text });
    if (!r.ok) refuse(r.why);
    console.log(`digest: decision ${target} overridden to "${text}" by ${r.entry.by}; the next pass in ${slug} lists ${r.entry.ticket} under WAITING ON YOU`);
    if (!r.marked) console.log('digest: the latest page does not list that decision');
  }
}
