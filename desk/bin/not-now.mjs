#!/usr/bin/env node
// The "not now" register: one JSON line per question the person put off, in <state>/not-now.jsonl,
// with the inputs it depends on. A question in it whose inputs are unchanged is not asked again (the
// digest lists it under "Put off"); one whose inputs changed is asked, saying what changed.
//
//   not-now.mjs check "<question>" [--inputs '<json>']           exit 0: ask (prints why); 3: put off
//   not-now.mjs add <TICKET> "<question>" [--inputs '<json>']    record a "not now" answer
//   not-now.mjs clear "<question>"                               ask it again from now on
//   not-now.mjs list
//
// <json> is a flat object naming what the question depends on, e.g. {"ticket": "ABC-1", "pr-head":
// "3f2a…", "config:default-branch": "main", "conflict-files": ["a.ts", "b.ts"]}. A question is matched by its text, with case, spacing
// and closing punctuation ignored. Each pass re-reads a put-off park's `pr-head` and `config:<id>`
// inputs (refreshInputs), so those bring the question back when they change.
// An unreadable register reads as empty, so the question is asked as it would be without one.
import { readFileSync, appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir, configValue, SAFE_ID } from './desk-env.mjs';

export const notNowPath = (dir = stateDir()) => join(dir, 'not-now.jsonl');
// An answer that puts the question off: "not now", "Not now.", "not now — after the launch".
export const NOT_NOW = /^\s*not now\b/i;

const sha = (s) => createHash('sha256').update(s).digest('hex');
const normal = (q) => String(q).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s?.!:;,]+$/, '');
export const questionKey = (question) => sha(normal(question)).slice(0, 12);
const stable = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
export const inputsHash = (inputs) => sha(stable(inputs ?? {})).slice(0, 16);

// {ok, inputs} or {ok: false, why}: a flat object of strings, numbers or booleans, or lists of them,
// each kept as text (a list joined with ", ", in its order). Nothing is {}.
const plain = (v) => ['string', 'number', 'boolean'].includes(typeof v);
export function parseInputs(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, inputs: {} };
  let o;
  try { o = JSON.parse(String(raw)); } catch { return { ok: false, why: 'inputs are not JSON' }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, why: 'inputs must be a JSON object' };
  const bad = Object.entries(o).filter(([, v]) => !plain(v) && !(Array.isArray(v) && v.every(plain))).map(([k]) => k);
  if (bad.length) return { ok: false, why: `inputs must be plain values or lists of them, not ${bad.join(', ')}` };
  return { ok: true, inputs: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(String).join(', ') : String(v)])) };
}

export function putOffEntry({ question, ticket, inputs = {}, by = null, at = new Date().toISOString() }) {
  return { key: questionKey(question), question: String(question).trim(), ticket, at, by, inputs, hash: inputsHash(inputs) };
}

// {ok: true, entries: Map(key -> entry)} or {ok: false, why}. The last line for a key wins, and a
// cleared line removes it. A missing file is an empty register; a line that does not parse makes the
// whole file unreadable, since a lost entry would be guessed at rather than asked.
export function readRegister(dir = stateDir()) {
  const path = notNowPath(dir);
  if (!existsSync(path)) return { ok: true, entries: new Map() };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return { ok: false, why: `${path} could not be read (${e.code ?? e.message})` }; }
  const entries = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { ok: false, why: `${path} line ${i + 1} is not JSON` }; }
    if (!e?.key) return { ok: false, why: `${path} line ${i + 1} has no key` };
    if (e.cleared) entries.delete(e.key);
    else entries.set(e.key, e);
  }
  return { ok: true, entries };
}

const day = (iso) => String(iso ?? '').slice(0, 10);

// What changed between the inputs recorded when it was put off and the ones it has now.
export function changes(was = {}, now = {}) {
  const out = [];
  for (const k of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    if (!(k in now)) out.push(`${k} ${was[k]} → (gone)`);
    else if (!(k in was)) out.push(`${k} (new) → ${now[k]}`);
    else if (was[k] !== now[k]) out.push(`${k} ${was[k]} → ${now[k]}`);
  }
  return out;
}

// {status: 'ask'} for a question nobody put off, {status: 'put_off', entry} when its inputs are
// unchanged, or {status: 'changed', entry, line} naming what changed since.
export function lookup(register, { question, inputs = {} }) {
  const entry = register?.ok ? register.entries.get(questionKey(question)) : null;
  if (!entry) return { status: 'ask' };
  if (entry.hash === inputsHash(inputs)) return { status: 'put_off', entry };
  const what = changes(entry.inputs, inputs);
  return { status: 'changed', entry, line: `Changed since ${entry.by ?? 'it was'} put ${entry.by ? 'it ' : ''}off on ${day(entry.at)}: ${what.join('; ') || 'its inputs'}.` };
}

// The inputs a pass can read again for itself: `config:<row id>` through read.config(id), and
// `pr-head` through read.prHead(). A reader that answers null leaves the input as it was; any other
// input is compared only when a session asks the question again.
export function refreshInputs(inputs = {}, read) {
  const out = { ...inputs };
  for (const k of Object.keys(out)) {
    const v = k === 'pr-head' ? read.prHead() : k.startsWith('config:') ? read.config(k.slice(7)) : null;
    if (v != null && v !== '') out[k] = String(v);
  }
  return out;
}

export function addPutOff(entry, dir = stateDir()) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(notNowPath(dir), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function clearPutOff(question, dir = stateDir(), at = new Date().toISOString()) {
  const key = questionKey(question);
  const reg = readRegister(dir);
  if (!reg.ok) return { ok: false, why: reg.why };
  if (!reg.entries.has(key)) return { ok: false, why: 'that question is not in the register' };
  appendFileSync(notNowPath(dir), `${JSON.stringify({ key, cleared: at })}\n`);
  return { ok: true, key };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const { EXIT, crashShowsPerson } = await import('./batch-state.mjs');
  crashShowsPerson();
  const args = process.argv.slice(2);
  const at = args.indexOf('--inputs');
  const rawInputs = at >= 0 ? args[at + 1] : null;
  const [cmd, ...rest] = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  const refuse = (why) => { console.error(why); process.exit(EXIT.SHOW_PERSON); };
  const usage = 'usage: not-now.mjs check "<question>" [--inputs \'<json>\'] | add <TICKET> "<question>" [--inputs \'<json>\'] | clear "<question>" | list';
  const inputs = () => { const p = parseInputs(rawInputs); if (!p.ok) refuse(p.why); return p.inputs; };
  if (cmd === 'check' && rest[0]) {
    const reg = readRegister();
    if (!reg.ok) console.log(`register unreadable (${reg.why}): ask as usual`);
    const r = lookup(reg, { question: rest.join(' '), inputs: inputs() });
    if (r.status === 'put_off') { console.log(`put off on ${day(r.entry.at)}${r.entry.by ? ` by ${r.entry.by}` : ''}, inputs unchanged: do not ask`); process.exit(3); }
    console.log(r.status === 'changed' ? `ask, with this line: ${r.line}` : 'ask');
    process.exit(0);
  }
  if (cmd === 'add' && rest[0] && rest[1]) {
    const [ticket, ...q] = rest;
    if (!SAFE_ID.test(ticket) || ticket.includes('..')) refuse(`'${ticket}' is not usable as a ticket id (letters, digits, . _ - only; no ..)`);
    let by = null;
    try { by = configValue('name') ?? null; } catch { /* outside a repo */ }
    const e = addPutOff(putOffEntry({ question: q.join(' '), ticket, inputs: inputs(), by }));
    console.log(`put off: ${e.key} in ${notNowPath()}`);
    process.exit(0);
  }
  if (cmd === 'clear' && rest[0]) {
    const r = clearPutOff(rest.join(' '));
    if (!r.ok) refuse(`not cleared: ${r.why}`);
    console.log(`cleared: ${r.key}; the question is asked again from now on`);
    process.exit(0);
  }
  if (cmd === 'list') {
    const reg = readRegister();
    if (!reg.ok) refuse(`register unreadable: ${reg.why}`);
    for (const e of reg.entries.values()) console.log(`${day(e.at)} ${e.ticket ?? '-'} ${e.question}  ${JSON.stringify(e.inputs)}`);
    process.exit(0);
  }
  refuse(usage);
}
