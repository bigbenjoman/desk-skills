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
//   digest.mjs ask-again <slug> <TICKET>                  take its put-off question out of the not-now register
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
import { readRegister, lookup, clearPutOff, NOT_NOW } from './not-now.mjs';
import { digestNotes } from './maintenance.mjs';
import { PRODUCTION_BROKEN, promotionSlot, promotionFor, promotionInputs, promotionQuestion, recordOffered, approve } from './promotion.mjs';

export const DEFAULT_TIMES = ['08:00', '17:00'];
export { PRODUCTION_BROKEN };
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

// The decision log split into taken calls, checks made instead of asking, and the overrides recorded
// against taken calls.
export function readDecisions(state) {
  const all = readLines(join(state, 'decisions.jsonl'));
  const overrides = all.filter((e) => e.override_of);
  const entries = all.filter((e) => !e.override_of && e.id);
  return { taken: entries.filter((e) => e.kind !== 'check'), checks: entries.filter((e) => e.kind === 'check'), overrides };
}

// Is this ticket's park a question the person put off, with the same inputs? An unreadable register
// puts nothing off.
const parkPutOff = (register, t) => (t.park?.question
  ? lookup(register, { question: t.park.question, inputs: t.park.inputs ?? {} })
  : { status: 'ask' });

// One repo's put-off questions, each once however many parked tickets ask it: {question, at, by, tickets}.
export function putOffQuestions(r, register = readRegister(r.state)) {
  const q = readJson(r.queue, null);
  const out = new Map();
  for (const t of Object.values(q?.tickets ?? {})) {
    if (t.state !== 'parked' || isHeld(t)) continue;
    const l = parkPutOff(register, t);
    if (l.status !== 'put_off') continue;
    const o = out.get(l.entry.key) ?? { question: l.entry.question, at: l.entry.at, by: l.entry.by ?? null, tickets: [] };
    o.tickets.push(t.key);
    out.set(l.entry.key, o);
  }
  return [...out.values()].map((o) => ({ ...o, tickets: o.tickets.sort() })).sort((a, b) => a.tickets[0].localeCompare(b.tickets[0]));
}

// One repo's open questions: each parked ticket's question (a hold is not one, nor a question the
// person put off with the same inputs) and each triaged ticket's unanswered triage unknowns. Questions
// already answered from a digest are left out. A put-off question whose inputs changed says what changed.
export function openQuestions(r, answered = {}, register = readRegister(r.state)) {
  const q = readJson(r.queue, null);
  const out = [];
  for (const t of Object.values(q?.tickets ?? {})) {
    if (t.state === 'parked' && !isHeld(t)) {
      const l = parkPutOff(register, t);
      if (l.status === 'put_off') continue;
      const text = `${String(t.park?.question ?? 'parked, with no question recorded')}${l.status === 'changed' ? ` (${l.line})` : ''}`;
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
// The weekly maintenance window's notes are the computer's, not a repo's, so they head the page.
export function renderPage({ slot, since, groups, bin = E.binDir(), maintenance = [] }) {
  const nq = groups.reduce((n, g) => n + g.questions.length, 0);
  const nd = groups.reduce((n, g) => n + g.decisions.length, 0);
  const nc = groups.reduce((n, g) => n + (g.checks?.length ?? 0), 0);
  const np = groups.reduce((n, g) => n + (g.putOff?.length ?? 0), 0);
  const nm = maintenance.length;
  const npr = groups.filter((g) => g.promotion?.key).length;
  const cmd = join(bin, 'digest.mjs');
  const lines = [`# Check-in ${slot.replace('T', ' ')}`, ''];
  // A repo the promotion window skipped says why, last, whatever else the page holds.
  const skipped = groups.filter((g) => g.promotion?.why).map((g) => `No promotion question for ${g.slug}: ${g.promotion.why}.`);
  const footer = () => (skipped.length ? [...lines, '## Promotion', '', ...skipped, ''] : lines).join('\n');
  if (!nq && !nd && !nc && !np && !nm && !npr) {
    lines.push(`Nothing to answer, and no decisions taken${since ? ` since ${since}` : ''}.`, '');
    return footer();
  }
  lines.push(`${nq} question(s) to answer${npr ? `, ${npr} promotion question(s)` : ''}, ${nd} decision(s) taken${nc ? `, ${nc} question(s) settled by checking` : ''}${since ? ` since ${since}` : ''}${np ? `; ${np} put off` : ''}${nm ? `; ${nm} maintenance note(s)` : ''}.`, '');
  if (nm) {
    lines.push('## Maintenance', '');
    for (const m of maintenance) lines.push(`- ${m.at.slice(0, 16).replace('T', ' ')}: ${m.text}`);
    lines.push('');
  }
  for (const g of groups.filter((x) => x.questions.length || x.decisions.length || x.checks?.length || x.putOff?.length || x.promotion?.key)) {
    lines.push(`## ${g.slug}`, '');
    const p = g.promotion;
    if (p?.key) {
      lines.push('### Promotion', '');
      lines.push(`- [ ] Promote \`${p.range}\` (${p.count} change(s) merged since the last promotion) to production? Staging check: ${p.page}`);
      lines.push(`  go: \`node ${cmd} promote ${g.slug} ${p.range} go\``, '');
    }
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
    if (g.checks?.length) {
      lines.push('### Checked instead of asking', '');
      for (const c of g.checks) lines.push(`- \`${c.ticket}\`: ${c.question} Checked ${c.checked}: ${c.showed}${c.pr ? ` [PR](${c.pr})` : ''}`);
      lines.push('');
    }
    if (g.putOff?.length) {
      lines.push('### Put off', '');
      for (const p of g.putOff) {
        lines.push(`- ${p.tickets.map((k) => `\`${k}\``).join(', ')}: ${p.question} Put off on ${p.at.slice(0, 10)}${p.by ? ` by ${p.by}` : ''}; asked again when its inputs change.`);
        lines.push(`  ask it now: \`node ${cmd} ask-again ${g.slug} ${p.tickets[0]}\``);
      }
      lines.push('');
    }
  }
  return footer();
}

// Builds the digest for the latest slot if no digest has covered it yet, under a machine-wide lock
// never waited on: a live holder is building the same slot. Returns {status, push, ...}: `sent` with
// the page and counts, `not_due` (the latest slot already has one) or `busy`. `push` is {key, text},
// or null when nothing is new since the last digest: a question the last page did not list, or a
// decision taken since. The repo that built the latest digest keeps getting its push until the next
// slot, so a notification that failed goes out on a later pass; consumers send each key once.
// A repo's promotion for the day's last slot: {why} (no Promotion ref, or unreadable), {empty: true}
// (nothing merged since it) or {range, prs, page}. Tests pass their own.
const readPromotion = (r) => promotionFor(promotionInputs(r.slug));

export async function checkin({ times, now = new Date(), dir = digestDir(), list = repos(), bin = E.binDir(), self = null, pid = process.pid, promote = readPromotion } = {}) {
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
    const inWindow = (d) => (!since || d.at > since) && d.at <= now.toISOString();
    const name = slot.id.replace(':', '');
    // Going to production is asked once a day, in the last slot; nothing merged asks nothing.
    const promotionOf = (r) => {
      if (!promotionSlot(times, slot.id)) return null;
      let p;
      try { p = promote(r); } catch (e) { p = { why: `the promotion range could not be read: ${e.message}` }; }
      if (!p || p.empty) return null;
      if (p.why) return { why: p.why };
      recordOffered(r.state, p.range);
      return promotionQuestion({ slug: r.slug, p, dir, name });
    };
    const groups = list.map((r) => {
      const { taken, checks, overrides } = readDecisions(r.state);
      const overridden = new Set(overrides.map((o) => o.override_of));
      const register = readRegister(r.state);
      return {
        slug: r.slug,
        questions: openQuestions(r, answered, register),
        decisions: taken.filter((d) => inWindow(d) && !overridden.has(d.id)),
        checks: checks.filter(inWindow),
        putOff: putOffQuestions(r, register),
        promotion: promotionOf(r),
      };
    });
    const maintenance = digestNotes().filter(inWindow);
    const page = join(dir, `${name}.md`);
    writeFileSync(page, renderPage({ slot: slot.id, since, groups, bin, maintenance }));
    const nq = groups.reduce((n, g) => n + g.questions.length, 0);
    const nd = groups.reduce((n, g) => n + g.decisions.length, 0);
    const nc = groups.reduce((n, g) => n + g.checks.length, 0);
    const nm = maintenance.length;
    const asks = groups.filter((g) => g.promotion?.key);
    const listed = [...groups.flatMap((g) => g.questions.map((q) => q.key)), ...asks.map((g) => g.promotion.key)];
    const fresh = listed.filter((k) => !(last?.listed ?? []).includes(k));
    const repoCount = groups.filter((g) => g.questions.length || g.decisions.length || g.checks.length || g.promotion?.key).length;
    // Put-off questions and checks are listed, never pushed: neither asks anything of the person.
    const push = nd || nm || fresh.length
      ? { key: `digest:${slot.id}`, text: `Check-in ${slot.id.slice(11)}: ${nq} question(s)${asks.length ? `, ${asks.length} promotion question(s)` : ''}, ${nd} decision(s)${nc ? `, ${nc} check(s)` : ''}${nm ? `, ${nm} maintenance note(s)` : ''} across ${repoCount} repo(s). ${page}` }
      : null;
    writeFileSync(lastFile(dir), `${JSON.stringify({ slot: slot.id, through: now.toISOString(), page, questions: nq, decisions: nd, listed, by: self, push }, null, 2)}\n`);
    return { status: 'sent', slot: slot.id, page, questions: nq, promotions: asks.length, decisions: nd, push };
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
  // A "not now" is not settled: the register hides it, and ask-again must be able to bring it back.
  if (question && !NOT_NOW.test(text)) {
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

// A "go" on a promotion question: recorded in that repo's batch notes with the range, and marked on
// the page. What runs next is the repo's own promotion steps, never a skill.
export function promote({ slug, range, text, dir = digestDir(), list = repos(), by = who(), now = new Date() }) {
  const r = list.find((x) => x.slug === slug);
  if (!r) return { ok: false, why: `no repo ${slug} in the digest (it has no queue and no decision log)` };
  if (!/^go$/i.test(String(text ?? '').trim())) return { ok: false, why: `only "go" is recorded; anything else, leave it and the next promotion window asks again` };
  const a = approve({ slug, state: r.state, range, by, now });
  if (!a.ok) return a;
  const marked = markPage(dir, (l) => l.includes(`Promote \`${range}\``) && pageRepo(dir, l, slug), `go from ${by} at ${now.toISOString()}`);
  return { ...a, marked };
}

// Takes a parked ticket's put-off question out of its repo's register, so it is asked again.
export function askAgain({ slug, ticket, list = repos() }) {
  const r = list.find((x) => x.slug === slug);
  if (!r) return { ok: false, why: `no repo ${slug} in the digest (it has no queue and no decision log)` };
  const question = readJson(r.queue, null)?.tickets?.[ticket]?.park?.question;
  if (!question) return { ok: false, why: `${ticket} has no parked question in ${slug}` };
  return clearPutOff(question, r.state);
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
  if (cmd === 'ask-again' && slug && target) {
    if (!E.SAFE_ID.test(slug) || slug.includes('..')) refuse(`'${slug}' is not a repo slug`);
    const r = askAgain({ slug, ticket: target });
    if (!r.ok) refuse(`not cleared: ${r.why}`);
    console.log(`digest: ${target}'s question is out of ${slug}'s not-now register; the next check-in lists it to answer`);
    process.exit(0);
  }
  if (!['answer', 'override', 'promote'].includes(cmd) || !slug || !target || !text) {
    refuse('usage: digest.mjs answer <slug> <TICKET> "<answer>" | digest.mjs override <slug> <decision-id> "<choice>" | digest.mjs ask-again <slug> <TICKET> | digest.mjs promote <slug> <from>..<to> go');
  }
  if (!E.SAFE_ID.test(slug) || slug.includes('..')) refuse(`'${slug}' is not a repo slug`);
  if (cmd === 'promote') {
    const r = promote({ slug, range: target, text });
    if (!r.ok) refuse(`not recorded: ${r.why}`);
    console.log(`digest: promoting ${slug} ${r.from}..${r.to} approved and recorded in its batch notes. Now run that repo's own promotion steps; skills never deploy production.`);
    process.exit(0);
  }
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
