// The repo config's schema: one entry per row the template (desk-config.md) declares in §0 to §5, in
// template order, and the types its values are read by. It reads no file. CONFIG_ROWS and
// PERMISSION_KEYS below are derived from it (desk-env re-exports both), and the config suite holds it
// equal to the template both ways (coverage), so neither can drift unnoticed.
//
// An entry is { id, section, label, kind, type, example, default?, machine?, unread? }:
//   id       the logical id scripts name (`desk-env get <id>`, `perm <id>`); a §3 row's id is its Key
//   section  '0', '1', '2', '3', '3b', '4' or '5'
//   label    the row's first cell as the template writes it, backticks aside (a §3 row's Key)
//   kind     'value' (one item), 'list' (one backtick span per item), 'perm' (a §3 permission) or
//            'table' (a `###` table of the person's own rows, matched by its heading)
//   type     the TYPES name each item parses by
//   example  a value that parses by the type: a string, or an array of items for a list or table
//   default  what the row's reader uses when the row is unset, where it uses one. Data reported beside
//            the value, never substituted for it: an unset row still reads as unset
//   machine  the machine profile key the row falls back to when the repo leaves it unset
//   unread   true for a row no script reads through desk-env yet: it stays out of CONFIG_ROWS, so
//            `desk-env ids`, `get` and `config` print only the rows scripts read
// The §3c rule ledger and the rows inside a 'table' entry's table are the person's own, so they have
// no entries.

// A config value a reader refuses rather than guesses at. desk-env re-exports it.
export class DeskConfigError extends Error {}

export const isNone = (v) => (Array.isArray(v) ? v.length === 1 && isNone(v[0]) : /^none$/i.test(String(v ?? '').trim()));
// `none` beside other items is a note written in backticks, which configValues refuses.
export const mixesNone = (items) => items.length > 1 && items.some((x) => isNone(x));

// ---- the row grammars ------------------------------------------------------------------------
// desk-env re-exports each under the same name.

// A command item may name the directory it runs in, relative to the repo root: `apps/api: uv run pytest`.
// -> { dir: 'apps/api' | '.', cmd }. The directory must be a plain relative path (no spaces, no ..).
export function parseCommandItem(item) {
  const m = /^([A-Za-z0-9._][A-Za-z0-9._/-]*):\s+(\S.*)$/.exec(String(item).trim());
  if (m && !m[1].split('/').includes('..')) {
    return { dir: m[1].replace(/\/+$/, ''), cmd: m[2] };
  }
  return { dir: '.', cmd: String(item).trim() };
}

// A §4 Test sign-in item, `<app dir>: <email>` or a bare email for the root: an existing development
// user's address, never a password. -> { dir, email }, or null where the rest is not one address.
export function testSigninOf(item) {
  const { dir, cmd } = parseCommandItem(item);
  return /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(cmd) ? { dir, email: cmd } : null;
}

// The compose service a §4 Local services item starts with, ending at whitespace or a colon (`search
// :8108`, `search: 8108`, `search`), or null. worker-settings allow-lists a worker starting it by this
// name, and drift names an item it cannot read.
export function localServiceName(item) {
  return /^[a-z0-9][a-z0-9_.-]*(?=[\s:]|$)/.exec(String(item ?? '').trim())?.[0] ?? null;
}

// §1 Git author name / email, from the row's spans: `Name <email>` or two spans, `Name` / `email`.
//   -> { name, email }, null where the row is unset or `none`, undefined where it is malformed
export function gitAuthorOf(items) {
  if (items == null || isNone(items)) return null;
  const one = items.length === 1 ? /^(.+?)\s*<([^<>]*)>$/.exec(String(items[0]).trim()) : null;
  const [name, email] = (one ? one.slice(1) : items.length === 2 ? items : []).map((x) => String(x).trim());
  if (!name || !email || !/^[^\s@<>]+@[^\s@<>]+$/.test(email) || /[<>\u0000-\u001f\u007f]/.test(name)) return undefined;
  return { name, email };
}

// A GitHub login, a bot's included: what §4 Review account and §4 Gate reviewers both name.
const LOGIN = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\[bot\\])?';
// A §4 Review account value as { login, dir } (dir as written, `~` unexpanded), null where it is unset,
// a TODO or `none`, and undefined where it is malformed.
export function reviewAccountOf(value) {
  const v = String(value ?? '').trim();
  if (!v || isNone(v) || /^todo\b/i.test(v)) return null;
  const m = new RegExp(`^(${LOGIN})\\s*:\\s*(\\S.*)$`).exec(v);
  return m ? { login: m[1], dir: m[2].trim() } : undefined;
}
// §4 Gate reviewers from the row's spans: { logins, bad }. logins is null where the row is unset, a
// TODO, `none` or `any` (the gate counts any account); bad lists the spans that are not a GitHub login.
// `any` and a TODO match the whole span (a TODO may carry a note after a space or colon, which no login
// holds), so a login that begins with either is still a login.
export function gateReviewersOf(items) {
  if (items == null || isNone(items) || (items.length === 1 && /^(?:any$|todo(?:[\s:]|$))/i.test(String(items[0]).trim()))) return { logins: null, bad: [] };
  const bad = items.filter((x) => !new RegExp(`^${LOGIN}$`).test(String(x).trim()));
  return { logins: items.map((x) => String(x).trim()), bad };
}

// The §3 values a row takes beyond yes, ask and no: branch-delete's merged deletes a local branch only
// once its PR merged and the base holds all it has (merged-branch.mjs).
const EXTRA_VALUES = { 'branch-delete': ['merged'] };
export const permValues = (key) => ['yes', ...(EXTRA_VALUES[key] ?? []), 'ask', 'no'];
const permWords = (key) => [...permValues(key), 'never', 'stop'];
const permMatch = (key, v) => new RegExp(`^(${permWords(key).join('|')})\\b`, 'i').exec(String(v).trim())?.[1].toLowerCase() ?? null;
// A §3 value: one of permValues, or never or stop; anything else is a no.
export const permValue = (key, v) => permMatch(key, v) ?? 'no';

// §4 Required fields rules (the row's items, `none` dropped) for an issue type, or for every type with
// none named: {need: [field id, in rule order], malformed: [item that is not `<Type>[, <Type>…]: <field>[, <field>…]`]}.
export function requiredFieldsIn(rules, type) {
  const want = type == null ? null : String(type).trim().toLowerCase();
  const need = rules.flatMap((rule) => {
    const r = requiredRule(rule);
    return r && (want == null || r.types.some((t) => t.toLowerCase() === want)) ? r.fields : [];
  });
  return { need: [...new Set(need)], malformed: rules.filter((r) => !/^[^:]+:.*\S/.test(r)) };
}
const requiredRule = (rule) => {
  const m = /^([^:]+):(.+)$/.exec(rule);
  return m && { types: m[1].split(',').map((t) => t.trim()), fields: m[2].split(/[,\s]+/).filter(Boolean) };
};
// requiredFieldsIn for every type the rules name, so a caller with no node can look its type up:
// {need: {<type as first written>: [field id…]}, malformed: [item…]}, one key per type case-blind.
export function requiredFieldsByType(rules) {
  const types = new Map();
  for (const t of rules.flatMap((rule) => requiredRule(rule)?.types ?? [])) if (t && !types.has(t.toLowerCase())) types.set(t.toLowerCase(), t);
  return { need: Object.fromEntries([...types.values()].map((t) => [t, requiredFieldsIn(rules, t).need])), malformed: requiredFieldsIn(rules, null).malformed };
}

// A spend guard is a number of USD or explicitly off. Anything else ("25 USD", "0", "lots") is
// refused rather than read as off: a typo must never silently remove a cap.
//   -> { off: true } | { usd: <number> }, or throws DeskConfigError
export function parseBudget(raw, label) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (/^(none|off|no|no cap)$/.test(v)) return { off: true };
  if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0) return { usd: Number(v) };
  throw new DeskConfigError(`desk: ${label} is "${raw}" — want a positive number of USD, or none/off/no cap. Refusing to guess.`);
}

// Config §3b "Worker models": `default` (no --model, the session default) or
// `standard=<model> high=<model>`, each a `claude --model` alias or full name. Either may be followed
// by `finder=<model>` (self-review finders) and `text=<model>` (the Stage 7 handoff session); unset,
// nothing overrides those. The finder model goes to the Agent tool's model override, which
// takes an alias (`sonnet`, `haiku`), not a full model name. Anything else is refused rather than read
// as default, so a typo never silently runs every worker on one model.
//   -> { off: true } | { standard, high }, plus finder and text where set, or throws DeskConfigError
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
const ALIAS = /^[a-z]+$/;
export const EXTRA_MODELS = ['finder', 'text'];
export function parseWorkerModels(raw) {
  const words = String(raw ?? '').trim().split(/\s+/);
  const off = /^default$/i.test(words[0]);
  const pairs = words.slice(off ? 1 : 0).map((p) => p.split('='));
  const keys = pairs.map((p) => p[0]);
  const want = off ? [] : ['high', 'standard'];
  const bad = (why) => new DeskConfigError(`desk: config §3b "Worker models" is "${raw}" — ${why}want \`default\`, or \`standard=<model> high=<model>\`, either followed by \`finder=<alias>\` and \`text=<model>\` if set. Refusing to guess.`);
  const unknown = keys.filter((k, i) => pairs[i].length === 2 && !['high', 'standard', ...EXTRA_MODELS].includes(k));
  if (unknown.length) throw bad(`unknown key ${unknown.map((k) => `\`${k}\``).join(', ')}; `);
  const ok = pairs.every((p) => p.length === 2 && MODEL_NAME.test(p[1])) && new Set(keys).size === keys.length
    && keys.filter((k) => !EXTRA_MODELS.includes(k)).sort().join() === want.join();
  if (!ok) throw bad('');
  const m = Object.fromEntries(pairs);
  if (m.finder && !ALIAS.test(m.finder)) throw bad(`the finder model \`${m.finder}\` is not an alias the Agent tool takes (\`sonnet\`, \`haiku\`); `);
  return { ...(off ? { off: true } : { standard: m.standard, high: m.high }),
    ...Object.fromEntries(EXTRA_MODELS.filter((k) => m[k]).map((k) => [k, m[k]])) };
}

// Config §3b "Worker location": `local` (also when the row is unset) or `cloud`, where plan-batch
// sends each ticket that needs nothing on this computer to a cloud session (cloud-worker.mjs). Anything
// else is refused rather than read as local.
//   -> 'local' | 'cloud', or throws DeskConfigError
export function parseWorkerLocation(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'local' || v === 'cloud') return v;
  throw new DeskConfigError(`desk: config §3b "Worker location" is "${raw}" — want \`local\` or \`cloud\`. Refusing to guess.`);
}

// Config §3b "Phase 0 levers": names, one per backtick span (a span may hold several, split on commas
// and spaces). Each lever named is pinned on for every ticket, outside any trial; `auto` beside them
// hands every lever not named to desk's trials; `none` alone is every lever off and no trials. No row,
// an unset row and no config at all read as `none`: off is the side that changes nothing. `none` beside
// any other name is invalid, and reads as `none`. A name desk does not know is kept in `unknown`, for
// the caller to name, and is never on.
//   leverRow -> { on: [lever], unknown: [name], auto, invalid: message | null }
//   parseLevers -> { on, unknown }
export const LEVERS = Object.freeze(['codex', 'effort', 'failure-class', 'ledger', 'memory', 'preflight', 'review-reuse', 'wrappers']);
export const LEVERS_AUTO = 'auto';
export const leverWords = (items) => [...new Set((items ?? []).flatMap((x) => String(x).toLowerCase().split(/[\s,]+/)).filter(Boolean))];
export function leverRow(items) {
  const words = leverWords(items);
  const names = words.filter((x) => !isNone(x) && x !== LEVERS_AUTO);
  const unknown = names.filter((n) => !LEVERS.includes(n));
  if (words.some((x) => isNone(x)) && words.length > 1) {
    return { on: [], unknown, auto: false, invalid: `\`none\` cannot sit beside another name ("${(items ?? []).join(' ')}"); every lever is read as off` };
  }
  return { on: names.filter((n) => LEVERS.includes(n)), unknown, auto: words.includes(LEVERS_AUTO), invalid: null };
}
export function parseLevers(items) {
  const { on, unknown } = leverRow(items);
  return { on, unknown };
}

// Config §3b "Worker effort": `<start>=<effort>` pairs, read only with the effort lever on. A start is
// the stage a session starts at, `task` (a fix or review try) or `resume`. A value or start desk does
// not know is refused, naming it, whichever session is starting.
//   -> { <start>: <effort> }, or throws DeskConfigError
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const RESUME_STAGES = Object.freeze(['3', '4', '4b', '5', '6', '7', '8', '9']);
export const EFFORT_STARTS = Object.freeze(['0', ...RESUME_STAGES, 'task', 'resume']);
export function parseWorkerEffort(items) {
  const row = (items ?? []).join(' ').trim();
  const bad = (why) => new DeskConfigError(`desk: config §3b "Worker effort" is "${row}" — ${why}want \`none\`, or \`<start>=<effort>\` pairs: a start of ${EFFORT_STARTS.join(', ')}, and an effort of ${EFFORTS.join(', ')}. Refusing to guess.`);
  const out = {};
  for (const pair of row.split(/[\s,]+/).filter((p) => p && !isNone(p))) {
    const [start, effort, ...rest] = pair.split('=');
    if (effort === undefined || rest.length) throw bad(`\`${pair}\` is not a pair; `);
    if (!EFFORT_STARTS.includes(start)) throw bad(`unknown start \`${start}\`; `);
    if (!EFFORTS.includes(effort)) throw bad(`unknown effort \`${effort}\`; `);
    if (out[start]) throw bad(`start \`${start}\` is named twice; `);
    out[start] = effort;
  }
  return out;
}

// Config §3b "Codex review": `<role>=<model>:<effort>` pairs for the codex finder and refuter, and
// `timeout=<seconds>` for every call, read by desk-codex.mjs with the codex lever on. A role or value
// the row leaves out keeps its default; one desk does not know is refused, naming it.
//   -> { finder: { model, effort }, refuter: { model, effort }, timeout }, or throws DeskConfigError
export const CODEX_ROLES = Object.freeze(['finder', 'refuter']);
export const CODEX_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const CODEX_DEFAULTS = Object.freeze({ finder: { model: 'gpt-6.1-sol', effort: 'medium' }, refuter: { model: 'gpt-6.1-sol', effort: 'low' }, timeout: 600 });
export function parseCodexReview(items) {
  const row = (items ?? []).join(' ').trim();
  const bad = (why) => new DeskConfigError(`desk: config §3b "Codex review" is "${row}" — ${why}want \`none\`, or \`finder=<model>:<effort> refuter=<model>:<effort> timeout=<seconds>\` with an effort of ${CODEX_EFFORTS.join(', ')}. Refusing to guess.`);
  const out = { finder: { ...CODEX_DEFAULTS.finder }, refuter: { ...CODEX_DEFAULTS.refuter }, timeout: CODEX_DEFAULTS.timeout };
  const seen = new Set();
  for (const pair of row.split(/[\s,]+/).filter((p) => p && !isNone(p))) {
    const [key, value, ...rest] = pair.split('=');
    if (value === undefined || rest.length) throw bad(`\`${pair}\` is not a pair; `);
    if (seen.has(key)) throw bad(`\`${key}\` is named twice; `);
    seen.add(key);
    if (key === 'timeout') {
      if (!/^[1-9]\d*$/.test(value)) throw bad(`timeout \`${value}\` is not a whole number of seconds; `);
      out.timeout = Number(value);
      continue;
    }
    if (!CODEX_ROLES.includes(key)) throw bad(`unknown role \`${key}\`; `);
    const [model, effort, ...more] = value.split(':');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model ?? '') || more.length) throw bad(`\`${value}\` is not <model>:<effort>; `);
    if (!CODEX_EFFORTS.includes(effort)) throw bad(`unknown effort \`${effort ?? ''}\`; `);
    out[key] = { model, effort };
  }
  return out;
}

// §3b "Spawn gate (available memory)", e.g. `start work > 8 GiB · hold 4–8 · drop to 1 below 4`:
// start = spawn only above this, hold = below it run at most one worker, dropTo = that one.
// Unset reads as the template's recommended values.
export function spawnGateOf(row) {
  const v = row ?? '';
  const num = (re) => { const m = re.exec(v); return m ? Number(m[1]) : null; };
  const start = num(/start[^0-9]*(\d+(?:\.\d+)?)/i) ?? num(/(\d+(?:\.\d+)?)/) ?? 8;
  const hold = num(/below\s*(\d+(?:\.\d+)?)/i) ?? num(/hold\s*(\d+(?:\.\d+)?)/i) ?? Math.min(4, start);
  const dropTo = num(/(?:drop to|drop)\s*(\d+)/i) ?? num(/(\d+)\s*below/i) ?? 1;
  return { start, hold, dropTo };
}

// §3b "Per-file collision budget": how many running tickets may name one file before a ticket naming
// it waits. `<big> over <lines> lines, else <small>` gives a file longer than <lines> on the batch base
// <big> places and any other <small>; a bare `<k>` gives every file k. `; serial: <glob>, ...` (or
// `none`) keeps the files it names at 1. Unset (null) is `3 over 1000 lines, else 1; serial: none`. A
// row that does not read is 1 for every file, with `bad` saying so: a typo never loosens the guard. The
// row is one code span: a cell of more than one is read whole and does not read, since its first span
// alone would drop the serial list without a word.
//   -> { big, lines, small, serial: [glob], bad: string | null }
const FILE_BUDGET_DEFAULT = { big: 3, lines: 1000, small: 1, serial: [] };
export function fileBudget(row) {
  if (row == null) return { ...FILE_BUDGET_DEFAULT, bad: null };
  const spans = [].concat(row);
  const v = spans.length === 1 ? String(spans[0]).trim() : '';
  const m = /^(?:(\d+)\s+over\s+(\d+)\s+lines?\s*,\s*else\s+(\d+)|(\d+))\s*(?:;\s*serial\s*:\s*(.*))?$/i.exec(v);
  const serial = m?.[5] == null || isNone(m[5].trim()) ? [] : m[5].split(',').map((s) => s.trim());
  const big = Number(m?.[1] ?? m?.[4]);
  const small = Number(m?.[3] ?? m?.[4]);
  if (!m || !(big >= 1) || !(small >= 1) || serial.some((g) => !g || /\s/.test(g))) {
    const read = spans.length === 1 ? `reads "${v}"` : 'holds more than one code span';
    return { big: 1, lines: 0, small: 1, serial: [], bad: `config §3b "${CONFIG_ROWS['file-budget'].row}" ${read}, not one \`<k> over <n> lines, else <k>; serial: <globs>\`` };
  }
  return { big, lines: m[2] == null ? 0 : Number(m[2]), small, serial, bad: null };
}

// ---- the types ---------------------------------------------------------------------------------
// A type parses one item (a backtick span, trimmed) and never throws: -> { value } or { error, fatal }.
// A `cell` type parses the row's every span at once instead, for a row whose reader reads them together.
// An error is fatal exactly where the row's reader refuses the value today (throws DeskConfigError),
// and not fatal where the reader warns, returns it as an error or reads past it.
const ok = (value) => ({ value });
const fail = (error, fatal = false) => ({ error, fatal });
const refusing = (grammar) => ({
  parse(item) {
    try { return ok(grammar(item)); } catch (e) { return fail(e.message, e instanceof DeskConfigError); }
  },
});
// A cell type: its grammar takes the spans, and a lone item is one span. noneFatal is false where the
// reader catches configValues' refusal of a `none` beside other spans rather than throwing it.
const cell = (type, noneFatal = true) => ({ cell: true, noneFatal, parse: (items) => type.parse([].concat(items ?? [])) });
const matching = (form, test, value = (s) => s) => ({ parse: (item) => (test(item) ? ok(value(item)) : fail(`"${item}" is not ${form}`)) });
// A type for a row whose grammar parses a list of items into { [key]: values, errors }: one item parses
// alone, and its error is not fatal, as the row's reader returns it rather than throwing.
const itemsOf = (grammar, key, form) => ({
  parse(item) { const r = grammar([item]); return r.errors.length ? fail(`${r.errors[0]} is not ${form}`) : ok(r[key][0] ?? 'none'); },
});
const oneOf = (...words) => matching(words.map((w) => `\`${w}\``).join(' or '), (s) => words.includes(s.toLowerCase()), (s) => s.toLowerCase());
const WHOLE = /^\d+$/;
const NUMBER = /^\d+(\.\d+)?$/;
const permType = (key) => {
  const words = permWords(key);
  const form = `${words.slice(0, -1).map((w) => `\`${w}\``).join(', ')} or \`${words.at(-1)}\``;
  return { parse: (item) => { const m = permMatch(key, item); return m ? ok(m) : fail(`"${item}" is not ${form}`); } };
};
// What follows a §4 Local services item's service name: nothing, or `:<port>`.
const PORT_TAIL = /^\s*(?::\s*(\d{1,5}))?$/;
const servicePort = (s) => {
  const service = localServiceName(s);
  const port = service == null ? null : PORT_TAIL.exec(s.slice(service.length));
  return port && (port[1] == null || Number(port[1]) <= 65535) ? { service, port: port[1] == null ? null : Number(port[1]) } : null;
};
// §3b Check-in times: every span joined, then local HH:MM times split on commas or spaces. The digest
// reads the row through these (digest.mjs checkinTimes) and falls back to its default on a bad row, so
// the type's error is not fatal.
export const CHECKIN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const checkinTimesOf = (items) => [].concat(items).join(' ').split(/[\s,]+/).filter(Boolean);

// §4 Known flaky checks items: `<check>: <glob> [<glob>…]`, split on the last `: ` so a check name may
// hold one. The globs are the paths whose change can make that check fail for real: a PR touching one
// never has the check waived. `<check>: <file> > <test>` names one test in a check instead, split on
// the first ` > `: that check is waived only when each of its failure annotations names a listed test,
// and the test's file is its path. An item with no check, no glob, or no file or test is an error.
// gate.mjs re-exports it.
export function parseFlaky(items) {
  const flaky = [];
  const errors = [];
  for (const x of items || []) {
    if (!x || /^none$/i.test(x.trim())) continue;
    const gt = x.indexOf(' > ');
    if (gt >= 0) {
      const head = x.slice(0, gt);
      const j = head.lastIndexOf(': ');
      const name = j < 0 ? '' : head.slice(0, j).trim();
      const file = j < 0 ? '' : head.slice(j + 2).trim();
      const title = x.slice(gt + 3).trim();
      if (!name || !file || /\s/.test(file) || !title) errors.push(`\`${x}\``);
      else flaky.push({ name, paths: [file], test: { file, title } });
      continue;
    }
    const i = x.lastIndexOf(': ');
    const name = i < 0 ? '' : x.slice(0, i).trim();
    const paths = i < 0 ? [] : x.slice(i + 2).trim().split(/\s+/).filter(Boolean);
    if (!name || !paths.length) errors.push(`\`${x}\``);
    else flaky.push({ name, paths });
  }
  return { flaky, errors };
}

// §4 State checks items: checks that read the PR's state (its reviews, approvals, title or another
// gate over those) rather than its code, so a rerun reads the same state and fails the same way. Each
// is `<check>` or `<check>: <kind>`, split on the last `: `: kind `verdict` reads the desk-review
// verdict at the head (a review worker posts a fresh one), `approval` reads a person's approval at
// the head (only a person clears it); a bare check reads other state, such as the title or an
// aggregate gate failing because of one of the others. A one-word tail that is no kind is an error,
// never a guess. Unset is desk-gate.yml's two state jobs; `none` names none.
// `<check>: external <login>` is a gate that reads the review of an outside reviewer, such as a review
// bot posting from its own account: kind `external`, with `login` that account. desk posts no review
// for it; the pass waits for that reviewer at the head and sends its findings to a fix worker.
// gate.mjs re-exports these.
export const STATE_KINDS = ['verdict', 'approval'];
export const DEFAULT_STATE_CHECKS = [{ name: 'desk-review verdict', kind: 'verdict' }, { name: 'protected-path approval', kind: 'approval' }];
export function parseStateChecks(items) {
  if (items == null) return { checks: DEFAULT_STATE_CHECKS, errors: [] };
  const checks = [];
  const errors = [];
  for (const x of items) {
    if (!x || /^none$/i.test(x.trim())) continue;
    const i = x.lastIndexOf(': ');
    const tail = i < 0 ? '' : x.slice(i + 2).trim();
    const ext = /^external\s+(\S+)$/.exec(tail);
    if (ext) { const name = x.slice(0, i).trim(); if (name) checks.push({ name, kind: 'external', login: ext[1] }); else errors.push(`\`${x}\``); continue; }
    if (/^external$/.test(tail)) { errors.push(`\`${x}\` (external names the reviewer's login: \`<check>: external <login>\`)`); continue; }
    const kind = STATE_KINDS.includes(tail) ? tail : null;
    const name = (kind ? x.slice(0, i) : x).trim();
    if (!name || (!kind && /^[a-z]+$/.test(tail))) errors.push(`\`${x}\``);
    else checks.push({ name, kind });
  }
  return { checks, errors };
}

// §4 Checks workers can't fix, Check builds and Pre-merge steps items: `<check>: <what fixes it>`,
// split on the first `: `, so the command may hold one. An item with no check or no command is an
// error, never a guess. workflow-yaml.mjs and fix-tries.mjs re-export it.
export function parseOperatorChecks(items) {
  const checks = [];
  const errors = [];
  for (const x of items || []) {
    if (!x || /^none$/i.test(x.trim())) continue;
    const i = x.indexOf(': ');
    const name = i < 0 ? '' : x.slice(0, i).trim();
    const command = i < 0 ? '' : x.slice(i + 2).trim();
    if (!name || !command) errors.push(`\`${x}\``);
    else checks.push({ name, command });
  }
  return { checks, errors };
}

// §4 Live reads items: `<name>: <command>`, as parseOperatorChecks reads them, where the name is a file
// name too, so it holds no path. -> { reads: [{ name, command }], errors: [item] }. live-read.mjs
// re-exports it.
const LIVE_READ_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function parseLiveReads(items) {
  const { checks, errors } = parseOperatorChecks(items);
  const bad = checks.filter((c) => !LIVE_READ_NAME.test(c.name));
  return { reads: checks.filter((c) => LIVE_READ_NAME.test(c.name)), errors: [...errors, ...bad.map((c) => `\`${c.name}: ${c.command}\` (a name holds only letters, digits, . _ and -)`)] };
}

// §4 Merge holds items: `<glob>: <why>`, split on the first `: `. A bare glob holds with no reason given.
// `<glob>#<key>` holds a JSON file only when the PR changes that key (dotted for a nested one), so
// `package.json#scripts` holds a PR that edits the scripts but not one that only bumps versions.
// `glob` is the item as written, for reporting; `path` is the part matched against file names.
// `<why>; desk runs: <command>` names the routine that clears the hold (null when none is named):
// the merge driver runs it before merging where §3 merge-hold-routine is yes.
// NO_REASON is the reason desk writes itself for a hold item with none: it names no check an agent
// could run, so it is a person's. gate.mjs re-exports these.
export const ROUTINE_MARK = '; desk runs: ';
export const NO_REASON = '(no reason given in §4 Merge holds)';
export function parseHolds(items) {
  if (!items) return [];
  return items.filter((x) => x && !/^none$/i.test(x.trim())).map((x) => {
    const i = x.indexOf(': ');
    const glob = (i < 0 ? x : x.slice(0, i)).trim();
    let why = i < 0 ? NO_REASON : x.slice(i + 2).trim();
    let routine = null;
    const m = why.indexOf(ROUTINE_MARK);
    if (m >= 0) {
      routine = why.slice(m + ROUTINE_MARK.length).trim() || null;
      why = why.slice(0, m).trim() || NO_REASON;
    }
    const k = glob.indexOf('#');
    return { glob, path: k < 0 ? glob : glob.slice(0, k), key: k < 0 ? null : glob.slice(k + 1), why, routine };
  });
}

export const TYPES = Object.freeze({
  text: matching('text', () => true),
  perm: permType(null),
  'perm-merged': permType('branch-delete'),
  whole: matching('a whole number', (s) => WHOLE.test(s), Number),
  'whole-or-none': matching('a whole number or `none`', (s) => WHOLE.test(s) || isNone(s), (s) => (isNone(s) ? 'none' : Number(s))),
  'promotion-slice': matching('a whole number from 5 to 10', (s) => WHOLE.test(s) && Number(s) >= 5 && Number(s) <= 10, Number),
  number: matching('a number', (s) => NUMBER.test(s), Number),
  'number-or-off': matching('a number or `off`', (s) => NUMBER.test(s) || /^off$/i.test(s), (s) => (/^off$/i.test(s) ? 'off' : Number(s))),
  gb: matching('a number of GB', (s) => NUMBER.test(s) && Number(s) > 0, Number),
  port: matching('a port number', (s) => WHOLE.test(s) && Number(s) >= 1 && Number(s) <= 65535, Number),
  'subagent-cap': matching('a whole number or `no cap`', (s) => WHOLE.test(s) || /^no cap$/i.test(s), (s) => (WHOLE.test(s) ? Number(s) : 'no cap')),
  concurrency: matching('`<default> / <cap>`', (s) => /^\d+(\s*\/\s*\d+)?$/.test(s), (s) => s.match(/\d+/g).map(Number)),
  times: cell(matching('local HH:MM times', (items) => checkinTimesOf(items).length > 0 && checkinTimesOf(items).every((t) => CHECKIN_TIME.test(t)), checkinTimesOf)),
  'yes-no': oneOf('yes', 'no'),
  'on-off': oneOf('on', 'off'),
  tracker: oneOf('jira', 'none'),
  'merge-method': oneOf('squash', 'merge', 'rebase'),
  'suite-weight': oneOf('heavy', 'light'),
  'status-table': oneOf('full', 'quiet'),
  'batches-run-by': oneOf('supervisor', 'session'),
  'ai-attribution': oneOf('forbidden', 'allowed'),
  regex: matching('a regular expression', (s) => { try { new RegExp(s); return true; } catch { return false; } }),
  command: matching('a command', () => true, parseCommandItem),
  'test-signin': matching('`[<app dir>: ]<email>`', (s) => testSigninOf(s) != null, testSigninOf),
  'service-port': matching('`<service> [:<port>]`', (s) => servicePort(s) != null, servicePort),
  'required-fields': matching('`<Type>[, <Type>…]: <field>[, <field>…]`', (s) => !requiredFieldsIn([s], null).malformed.length,
    (s) => ({ types: requiredRule(s)?.types ?? [], fields: requiredFieldsIn([s], null).need })),
  // The whole cell is checked, as `desk-env levers` reads it; the value stays one entry per span.
  lever: cell({ parse(items) { const r = leverRow(items); return r.invalid ? fail(r.invalid) : r.unknown.length ? fail(`unknown lever ${r.unknown.map((n) => `\`${n}\``).join(', ')}: want ${LEVERS.join(', ')}`) : ok(isNone(items) ? ['none'] : items.map((x) => leverRow([x]).on)); } }),
  budget: refusing((s) => parseBudget(s, 'the budget')),
  'worker-models': refusing(parseWorkerModels),
  'worker-effort': cell(refusing(parseWorkerEffort)),
  'worker-location': refusing(parseWorkerLocation),
  'codex-review': cell(refusing(parseCodexReview)),
  'spawn-gate': matching('a spawn gate', () => true, spawnGateOf),
  'file-budget': cell({ parse(items) { const r = fileBudget(items); return r.bad ? fail(r.bad) : ok(r); } }, false),
  'git-author': cell({ parse(items) { const a = gitAuthorOf(items); return a === undefined ? fail(`"${items.join(' | ')}" is not \`Name <email>\` or \`Name\` / \`email\``, true) : ok(a); } }),
  'review-account': { parse(item) { const a = reviewAccountOf(item); return a === undefined ? fail(`"${item}" is not \`<login>: <gh config directory>\` or \`none\``, true) : ok(a); } },
  'flaky-check': itemsOf(parseFlaky, 'flaky', '`<check>: <glob> [<glob>…]` or `<check>: <file> > <test>`'),
  'state-check': itemsOf(parseStateChecks, 'checks', `\`<check>\`, \`<check>: ${STATE_KINDS.join('|')}\` or \`<check>: external <login>\``),
  'operator-check': itemsOf(parseOperatorChecks, 'checks', '`<check>: <what fixes it>`'),
  'live-read': itemsOf(parseLiveReads, 'reads', '`<name>: <command>`, a name of letters, digits, . _ and -'),
  'merge-hold': matching('`<glob>[#<key>]: <why>[; desk runs: <command>]`', (s) => parseHolds([s]).length > 0, (s) => parseHolds([s])[0]),
  'gate-reviewers': cell({ parse(items) { const r = gateReviewersOf(items); return r.bad.length ? fail(`"${items.join(' | ')}" is not one GitHub login per span, \`any\` or \`none\``, true) : ok(r.logins); } }),
});

// A row's items checked by its entry's type: -> { value, errors: [{ item, error, fatal }] }, value null
// unless errors is empty; never throws. A cell type parses every item together, as its reader reads
// them, and its error names no item (null). Otherwise a value row parses its first item, as configValue
// reads it, and a list row parses each item, every one that does not fit named. `none` stands alone in
// a list or a cell (a lone `none` is the row's value), so `none` beside another item is fatal, as
// configValues refuses it.
export function checkRow(entry, items) {
  const all = [].concat(items ?? []).map((x) => String(x).trim());
  const type = TYPES[entry.type];
  const one = (r, item) => (r.error ? { value: null, errors: [{ item, error: r.error, fatal: r.fatal }] } : { value: r.value, errors: [] });
  if ((entry.kind === 'list' || type.cell) && mixesNone(all)) return one(fail(`\`none\` must stand alone, not beside other items (${all.join(' | ')})`, type.noneFatal !== false), null);
  if (type.cell) return one(type.parse(all), null);
  if (entry.kind !== 'list' && entry.kind !== 'table') return one(type.parse(all[0] ?? ''), all[0] ?? '');
  if (isNone(all)) return { value: ['none'], errors: [] };
  const read = all.map((item) => [item, type.parse(item)]);
  const errors = read.filter(([, r]) => r.error).map(([item, r]) => ({ item, error: r.error, fatal: r.fatal }));
  return errors.length ? { value: null, errors } : { value: read.map(([, r]) => r.value), errors };
}

// checkRow's first error, as one reader that stops at it sees the row: -> { value } or { error, fatal }.
export function parseRow(entry, items) {
  const { value, errors } = checkRow(entry, items);
  return errors.length ? fail(errors[0].error, errors[0].fatal) : ok(value);
}

// ---- the rows ----------------------------------------------------------------------------------
const v = (id, section, label, type, example, extra) => ({ id, section, label, kind: 'value', type, example, ...extra });
const l = (id, section, label, type, example, extra) => ({ id, section, label, kind: 'list', type, example, ...extra });
const p = (key, extra) => ({ id: key, section: '3', label: key, kind: 'perm', type: 'perm', example: 'yes', ...extra });
const unread = { unread: true };
const dflt = (value, extra) => ({ default: value, ...extra });
const never = { example: 'never' };
const stop = { example: 'stop' };

export const ROWS = Object.freeze([
  // §0 This repo
  v('gh-repo', '0', 'GitHub repo', 'text', 'acme/widgets'),
  v('slug', '0', 'Slug', 'text', 'acme__widgets', unread),
  v('default-branch', '0', 'Default branch', 'text', 'main', dflt('main')),
  v('repo-description', '0', 'One-line description', 'text', 'A voice assistant for clinics'),
  l('other-names', '0', 'Other names', 'text', ['widgets-portal']),
  // §1 Who you are in this repo
  v('name', '1', 'Name', 'text', 'Pat Example'),
  v('short-name', '1', 'Short form colleagues use', 'text', 'Pat', unread),
  v('github-handle', '1', 'GitHub handle', 'text', 'pat-example'),
  v('jira-email', '1', 'Jira email', 'text', 'pat@example.com'),
  v('jira-display-name', '1', 'Jira display name', 'text', 'Pat Example'),
  v('jira-account-id', '1', 'Jira account id', 'text', '712020:0d2c1a9e'),
  v('git-author', '1', 'Git author name / email', 'git-author', 'Pat Example <pat@example.com>'),
  v('pronouns', '1', 'Pronouns (optional)', 'text', 'they/them', unread),
  // §2 Paths on your machine
  v('repo-root', '2', 'Primary repo root', 'text', '~/widgets'),
  v('worktrees-dir', '2', 'Worktrees directory', 'text', '~/widgets-worktrees'),
  v('handoff-dir', '2', 'Handoff directory', 'text', '~/desk-handoff/'),
  v('backups-dir', '2', 'Backups directory', 'text', '~/desk-backups/<slug>/'),
  v('design-dir', '2', 'Design canvases directory', 'text', 'docs/design/'),
  v('wsl', '2', 'Running on WSL?', 'yes-no', 'no'),
  v('browser-profile', '2', 'Signed-in browser profile', 'text', '~/.cache/ms-playwright-mcp/desk-profile', dflt('~/.cache/ms-playwright-mcp/desk-profile')),
  v('handoff-pct', '2', 'Handoff at context %', 'whole', '45', dflt('45')),
  v('handoff-pct-1m', '2', 'Handoff at context % on a 1M window', 'whole', '20'),
  l('autopilot-state', '2', 'Autopilot state', 'text', ['~/.desk-autopilot/<slug>/', '~/.claude/desk/'], unread),
  // §3 Permissions: Reading
  p('read-own-work'), p('read-local-git'), p('read-others'), p('read-slack-public'), p('read-figma'),
  p('read-vercel'), p('read-confluence'), p('read-transcripts'), p('read-calendar'), p('read-slack-own'),
  // §3 Jira
  p('jira-assign-self'), p('jira-comment'), p('jira-create'), p('jira-edit'), p('jira-transition'),
  p('jira-close-own-merged'), p('jira-close'), p('jira-route'), p('jira-others'),
  // §3 Git and pull requests
  p('git-commit'), p('git-push'), p('git-force-with-lease'), p('pr-open'), p('pr-edit'), p('pr-images'),
  p('pr-self-review-comment'), p('pr-review-others'), p('pr-reply'), p('pr-request-review'), p('pr-ready'),
  p('pr-auto-merge'), p('pr-merge-green'), p('merge-feedback-first'), p('pr-update-branch'),
  p('pr-conflict-unreviewed'), p('pr-conflict-reviewed'), p('ci-rerun'), p('codex-review'), p('ci-protection'),
  p('gh-close-linked-issue'), p('gh-issue-create'), p('gh-issue-comment'),
  // §3 Autopilot
  p('autopilot-workers'), p('autopilot-worker-mode', { type: 'text', example: 'dontAsk' }), p('autopilot-merge'), p('merge-hold-routine'),
  p('batch-base-push'), p('autopilot-judgement'), p('autopilot-reclaim'), p('machine-reboot'),
  p('worker-dependency-install'), p('worker-screenshots'), p('worker-local-services'), p('worker-web-read'),
  p('worker-workflow-dispatch'),
  // §3 Local and shared state
  p('db-per-ticket'), p('db-clone-staging'), p('staging-write'), p('local-reindex'), p('tests-shared-db'),
  p('worktree-remove'), p('branch-delete', { type: 'perm-merged', example: 'merged' }), p('server-stop'), p('skills-edit'), p('vercel-env'), p('slack-draft'),
  // §3 Not configurable
  p('slack-send', never), p('merge-bypass', never), p('others-prs', never), p('product-calls', stop), p('legal-content', stop),
  // §3b Cost and autonomy
  v('subagents-without-asking', '3b', 'Subagents that may run without asking', 'subagent-cap', 'no cap'),
  v('dev-port', '3b', 'Preferred dev-server port', 'port', '3000', dflt('3000')),
  v('concurrency', '3b', 'Autopilot worker concurrency', 'concurrency', '2 / 3', dflt('2 / 3', { machine: 'autopilot-concurrency' })),
  v('memory-ceiling', '3b', 'Memory ceiling for parallel work (GB)', 'gb', '16', { machine: 'memory-ceiling-gb' }),
  v('spawn-gate', '3b', 'Spawn gate (available memory)', 'spawn-gate', 'start work > 8 GiB · hold 4–8 · drop to 1 below 4', dflt('start work > 8 GiB · hold 4–8 · drop to 1 below 4')),
  v('file-budget', '3b', 'Per-file collision budget', 'file-budget', '3 over 1000 lines, else 1; serial: none', dflt('3 over 1000 lines, else 1; serial: none')),
  v('test-cap', '3b', 'Test worker cap under the test lock', 'whole', '4', { machine: 'test-cap' }),
  v('worker-budget', '3b', 'Autopilot per-worker budget (USD)', 'budget', '25', dflt('25')),
  v('batch-budget', '3b', 'Autopilot batch budget (USD)', 'budget', 'none', dflt('none')),
  v('worker-models', '3b', 'Worker models', 'worker-models', 'standard=sonnet high=opus', dflt('default')),
  v('worker-effort', '3b', 'Worker effort', 'worker-effort', '0=medium 4b=high task=low', dflt('none')),
  v('worker-location', '3b', 'Worker location', 'worker-location', 'local', dflt('local')),
  v('batches-run-by', '3b', 'Batches run by', 'batches-run-by', 'supervisor', dflt('session')),
  v('borrow-idle', '3b', 'Borrow idle workers', 'on-off', 'off', dflt('off')),
  v('park-after', '3b', 'Park an unanswered question after (minutes)', 'whole', '15'),
  v('resume-killed', '3b', 'Resume a killed worker (times)', 'whole', '2', dflt('2')),
  v('disk-floor', '3b', 'Free disk floor (GB)', 'whole-or-none', '20', dflt('20')),
  v('promotion-slice', '3b', 'Promotion slice size (children)', 'promotion-slice', '8', dflt('8')),
  v('claim-release', '3b', 'Release idle claims after (hours)', 'number', '12', dflt('12')),
  v('usage-pacing', '3b', 'Usage pacing headroom (points)', 'number-or-off', '5', dflt('5')),
  v('subscription', '3b', 'Subscription', 'text', 'default', dflt('default')),
  v('maintenance-window', '3b', 'Maintenance window', 'text', 'Mon 06:30 UTC', dflt('none')),
  v('maintenance-drain', '3b', 'Maintenance drain limit (minutes)', 'whole', '60', dflt('60')),
  v('stage-reports', '3b', 'Report every stage transition on long runs', 'yes-no', 'yes', unread),
  v('status-table', '3b', 'Orchestrator status table', 'status-table', 'full', dflt('full')),
  v('push-notify', '3b', 'Push notification when a batch needs you', 'yes-no', 'yes', unread),
  v('checkin-times', '3b', 'Check-in times', 'times', '08:00, 17:00', dflt('08:00, 17:00')),
  l('levers', '3b', 'Phase 0 levers', 'lever', ['codex', 'effort'], dflt(['none'])),
  v('codex-models', '3b', 'Codex review', 'codex-review', 'finder=gpt-6.1-sol:medium refuter=gpt-6.1-sol:low timeout=600', dflt('none')),
  v('intake-query', '3b', 'Intake query', 'text', 'project = ABC AND labels = autopilot AND statusCategory = "To Do"', dflt('none')),
  v('triage-concurrency', '3b', 'Triage concurrency', 'whole', '1', dflt('1')),
  // §4 Tracker
  v('tracker', '4', 'Tracker', 'tracker', 'jira'),
  v('jira-site', '4', 'Jira site', 'text', 'yourteam.atlassian.net'),
  v('jira-cloudid', '4', 'Jira cloudId', 'text', '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0'),
  l('jira-project', '4', 'Jira project', 'text', ['KAN']),
  v('ticket-pattern', '4', 'Ticket key pattern', 'regex', 'KAN-[0-9]+'),
  l('work-id-patterns', '4', 'Other work id patterns', 'regex', ['P[0-9]+-M[0-9]+(-FIX)?-[0-9]+', 'BUG-[0-9]+(-[0-9]+)*']),
  v('jira-workflow', '4', 'Workflow', 'text', 'To Do → In Progress → In Review → Done', unread),
  v('in-progress-state', '4', 'In-progress state', 'text', 'In Progress'),
  v('review-state', '4', 'Review state', 'text', 'In Review'),
  v('done-state', '4', 'Done state', 'text', 'Done'),
  l('jira-priority', '4', 'Priority', 'text', ['customfield_10300', 'P0', 'P1', 'P2']),
  l('jira-other-fields', '4', 'Other fields', 'text', ['customfield_10210']),
  l('jira-required-fields', '4', 'Required fields', 'required-fields', ['Epic, Story, Task, Bug: customfield_10208, customfield_10207']),
  v('jira-size-field', '4', 'Size field', 'text', 'customfield_10208'),
  l('jira-priority-user-only', '4', 'Priorities only you set', 'text', ['P0', 'P1']),
  l('labels', '4', 'Labels', 'text', ['any']),
  l('person-step-labels', '4', 'Person-step labels', 'text', ['ben-step', 'operator-task'], dflt(['none'])),
  l('person-input-labels', '4', 'Person-input labels', 'text', ['ben-input'], dflt(['none'])),
  v('desk-jira-setup', '4', 'desk-jira set up?', 'yes-no', 'yes', unread),
  // §4 GitHub and CI
  v('branch-protection', '4', 'Branch protection', 'text', '1 approval; CHANGES_REQUESTED blocks; up to date required'),
  l('required-checks', '4', 'Required checks', 'text', ['Lint', 'Unit tests']),
  l('advisory-checks', '4', 'Advisory checks', 'text', ['Lighthouse']),
  l('flaky-checks', '4', 'Known flaky checks', 'flaky-check', ['Run e2e tests: e2e/** playwright.config.ts']),
  l('state-checks', '4', 'State checks', 'state-check', ['🔐 Review gate: approval', '🏁 CI gate']),
  l('operator-checks', '4', "Checks workers can't fix", 'operator-check', ['Flows image missing: build it: ensure-flows-image.sh']),
  l('check-builds', '4', 'Check builds', 'operator-check', ['Flows image: ./scripts/ensure-flows-image.sh']),
  l('live-reads', '4', 'Live reads', 'live-read', ['gateway-models: ./scripts/fetch-gateway-models.sh staging']),
  l('pre-merge-steps', '4', 'Pre-merge steps', 'operator-check', ["Check portal schema mirror: apply the PR's migrations to staging first"]),
  l('evidence-workflow', '4', 'Evidence workflow', 'text', ['pr-evidence.yml']),
  l('worker-workflows', '4', 'Worker workflows', 'text', ['e2e-manual.yml -f environment=staging -f suite=all']),
  l('worker-read-repos', '4', 'Worker read-only repos', 'text', ['acme/web'], dflt(['none'])),
  l('worker-measure-cmds', '4', 'Worker measuring commands', 'command', ['python3 scripts/measure_exclusions.py', 'tools: python3 measure.py'], dflt(['none'])),
  l('merge-holds', '4', 'Merge holds', 'merge-hold', ['backend/**: build and push Lambda images first (./scripts/build-lambda-images-local.sh)']),
  l('incidental-paths', '4', 'Incidental paths', 'text', ['pnpm-lock.yaml', 'docs/**']),
  l('append-only-paths', '4', 'Append-only paths', 'text', ['messages/*.json'], dflt(['none'])),
  v('merge-method', '4', 'Merge method', 'merge-method', 'squash'),
  v('repo-merge-settings', '4', 'Repo merge settings', 'text', 'auto-merge allowed; delete_branch_on_merge on'),
  v('gh-token-scopes', '4', 'gh token scopes', 'text', 'repo, workflow', unread),
  v('codex-answers', '4', 'Codex answers a real call?', 'text', 'yes', unread),
  v('local-review', '4', 'Local review command', 'text', '/desk-review'),
  v('clean-verdict', '4', 'Clean review verdict', 'text', 'p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0'),
  v('review-account', '4', 'Review account', 'review-account', 'agent-pullbot: ~/.config/gh-agent-pullbot', dflt('none')),
  l('gate-reviewers', '4', 'Gate reviewers', 'gate-reviewers', ['agent-pullbot'], dflt(['any'])),
  v('review-bar', '4', 'Review bar', 'text', 'default'),
  l('review-experts', '4', 'Review domain experts', 'text', ['apps/api/pricing/**: energy-trader']),
  l('agents-sync', '4', 'Project subagents sync', 'command', ['pnpm agents:sync']),
  // §4 Toolchain
  v('package-manager', '4', 'Package manager', 'text', 'pnpm'),
  v('command-prefix', '4', 'Command prefix', 'text', 'mise exec --'),
  l('install-cmd', '4', 'Install', 'command', ['pnpm install --frozen-lockfile']),
  l('dev-cmd', '4', 'Dev server', 'command', ['pnpm --filter frontend dev', 'portal: pnpm dev']),
  l('typecheck-cmd', '4', 'Typecheck', 'command', ['pnpm typecheck']),
  l('lint-cmd', '4', 'Lint', 'command', ['pnpm lint']),
  v('baseline-checks', '4', 'Baseline checks', 'on-off', 'on', dflt('off')),
  l('test-cmd', '4', 'Unit tests', 'command', ['pnpm turbo run test', 'apps/api: uv run pytest']),
  l('related-test-cmd', '4', 'Related tests', 'command', ['pnpm vitest related --run --passWithNoTests', 'apps/api: uv run pytest --testmon']),
  v('suite-weight', '4', 'Suite weight', 'suite-weight', 'light', dflt('heavy')),
  l('e2e-cmd', '4', 'E2E tests', 'command', ['pnpm e2e']),
  l('storybook-cmd', '4', 'Storybook', 'command', ['apps/web: pnpm build-storybook']),
  l('integration-cmd', '4', 'Integration tests', 'command', ['pnpm test:integration']),
  l('acceptance-specs', '4', 'Acceptance specs', 'text', ['tests/acceptance/', 'pnpm vitest run tests/acceptance -t "{ids}"']),
  l('build-cmd', '4', 'Build', 'command', ['pnpm build']),
  l('codegen-cmd', '4', 'Codegen', 'command', ['pnpm prisma generate']),
  l('pre-push-checks', '4', 'Pre-push checks', 'command', ['pnpm prisma generate', 'pnpm lint', 'pnpm typecheck']),
  l('merged-tree-check-cmd', '4', 'Merged-tree check', 'command', ['apps/api: uv run python scripts/check_alembic_heads.py']),
  l('pr-description-checks', '4', 'PR-description checks', 'command', ['node scripts/check-pr-body.mjs']),
  l('env-files', '4', 'Env files', 'text', ['frontend/.env.local', 'portal/.env.local']),
  l('test-signin', '4', 'Test sign-in', 'test-signin', ['dev-user@example.test', 'apps/portal: portal-dev@example.test']),
  // §4 Environments and services
  v('local-db', '4', 'Local database', 'text', 'postgres container voicepa-postgres-1'),
  l('db-url-var', '4', 'Database URL variable', 'text', ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']),
  l('db-migrate-cmd', '4', 'Database migrate', 'command', ['pnpm db:migrate']),
  l('seed-cmd', '4', 'Seed', 'command', ['pnpm db:seed']),
  l('local-services', '4', 'Local services', 'service-port', ['typesense :8108', 'mailpit :8025']),
  l('staging', '4', 'Staging', 'text', ['web: https://staging.example.com']),
  v('staging-bypass', '4', 'Staging bypass token location', 'text', '~/.config/desk/repos/<slug>/vercel-staging-bypass'),
  v('production', '4', 'Production', 'text', 'https://example.com, deployed by Vercel from main', unread),
  v('promotion-ref', '4', 'Promotion ref', 'text', 'origin/production'),
  l('vercel', '4', 'Vercel', 'text', ['acme-team', 'web: prj_0a1b2c3d']),
  l('slack-channels', '4', 'Slack channels', 'text', ['#widgets-dev']),
  v('checkout-destination', '4', 'Check-out destination', 'text', '#standup'),
  // §4 People, by role
  v('code-reviewer', '4', 'Code reviewer', 'text', 'Sam Reviewer (sam-reviewer)'),
  v('infra-owner', '4', 'Infra and security owner', 'text', 'you', unread),
  v('product-owner', '4', 'Product owner', 'text', 'you'),
  v('designer', '4', 'Designer', 'text', 'none', unread),
  v('qa-filers', '4', 'QA filers', 'text', 'none', unread),
  v('ticket-deleters', '4', 'Deletes tickets', 'text', 'you', unread),
  v('former-members', '4', 'No longer on the team', 'text', 'none', unread),
  { id: 'review-asks', section: '4', label: 'What review here consistently asks for', kind: 'table', type: 'text', example: ['Small PRs: one concern per PR'] },
  // §5 Conventions
  v('branch-names', '5', 'Branch names', 'text', '<type>/<TICKET>-short-slug'),
  v('pr-title', '5', 'PR title', 'text', 'type(scope): <TICKET> description'),
  v('ai-attribution', '5', 'AI attribution', 'ai-attribution', 'forbidden'),
  v('pr-body', '5', 'PR body', 'text', 'intro · ### Changes · ### Testing', unread),
  v('pr-lifecycle', '5', 'PR lifecycle', 'text', 'draft → local review until clean → undraft → merge on green', unread),
  v('batches', '5', 'Batches', 'text', 'serial to the merge', unread),
  v('ticket-format', '5', 'Ticket format', 'text', 'default', unread),
  v('ticket-comment', '5', 'Ticket comment', 'text', 'root cause, fix, PR link', unread),
  v('code-comments', '5', 'Code comments', 'text', 'default none; at most one short line', unread),
  v('user-copy', '5', 'User-facing copy you write', 'text', 'copy supplied by design or product ships verbatim', unread),
  l('breakpoints', '5', 'Breakpoints', 'whole', ['390', '768', '1024', '1280', '1440']),
  l('themes', '5', 'Themes', 'text', ['light', 'dark']),
  l('design-system', '5', 'Design system', 'text', ['src/styles/tokens.css', 'tailwind.config.ts', 'DESIGN.md']),
  v('colleague-messages', '5', 'Messages to colleagues', 'text', 'plain, direct, no filler', unread),
  v('decisions-put', '5', 'Decisions put to you', 'text', 'one AskUserQuestion carousel', unread),
  v('vercel-env-vars', '5', 'Vercel env vars', 'text', 'none', unread),
  l('repo-instructions', '5', 'Repo instructions', 'text', ['CLAUDE.md', 'AGENTS.md']),
].map((e) => Object.freeze(e)));

// desk-env's id tables, which it re-exports: the §3 key of each permission id, and the section and row
// of every other id scripts read.
export const PERMISSION_KEYS = Object.freeze(Object.fromEntries(ROWS.filter((e) => e.kind === 'perm').map((e) => [e.id, e.label])));
const idRow = (e) => [e.id, e.kind === 'table' ? { section: e.section, row: e.label, table: true } : { section: e.section, row: e.label }];
export const CONFIG_ROWS = Object.freeze(Object.fromEntries(ROWS.filter((e) => e.kind !== 'perm' && !e.unread).map(idRow)));
// Every non-permission row the schema declares, unread ones included, in the same shape: `get --json`
// reads them all, where plain `get` reads CONFIG_ROWS alone.
export const DECLARED_ROWS = Object.freeze(Object.fromEntries(ROWS.filter((e) => e.kind !== 'perm').map(idRow)));
// The rows that fall back to the machine profile, as id -> profile key.
export const MACHINE_FALLBACK = Object.freeze(Object.fromEntries(ROWS.filter((e) => e.machine).map((e) => [e.id, e.machine])));

// How a label, heading or table header is compared: markdown emphasis and backticks dropped, spacing
// collapsed, case folded. desk-env's config parser normalises with this too.
export const norm = (s) => String(s).replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const where = (section, label) => `${section}\t${norm(label)}`;

// The template's declared rows ([{ section, label }]) and the `###` headings of its tables of the
// person's own rows ([{ section, heading }]) against the schema. -> { missing: the declared rows with
// no entry, extra: the entries naming no declared row or table }, each as { section, label }. Both
// empty means the two agree.
export function coverage({ rows = [], tables = [] }) {
  const byRow = new Set(ROWS.filter((e) => e.kind !== 'table').map((e) => where(e.section, e.label)));
  const haveRows = new Set(rows.map((r) => where(r.section, r.label)));
  const haveTables = new Set(tables.map((t) => where(t.section, t.heading)));
  const missing = rows.filter((r) => !byRow.has(where(r.section, r.label))).map(({ section, label }) => ({ section, label }));
  const extra = ROWS.filter((e) => !(e.kind === 'table' ? haveTables : haveRows).has(where(e.section, e.label)))
    .map(({ section, label }) => ({ section, label }));
  return { missing, extra };
}
