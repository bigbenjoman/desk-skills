// Subscriptions: the Claude and Codex logins desk may use on this computer, each a config folder
// with a rule (in rotation, standby or off).
//
// One file per computer, ~/.config/desk/subscriptions.md (desk-env.mjs owns the path), beside
// machine.md and costs.md and read by every repo. With no file, desk has one login per tool: Claude's
// ~/.claude and Codex's ~/.codex, both in rotation, with no config folder override. A tool the file
// lists no login for keeps that default.
//
// The account check signs nothing in and reads no credential: a Claude login's account is what
// `claude auth status --json` says under its CLAUDE_CONFIG_DIR, and its plan is oauthAccount's
// planDisplayName in that folder's .claude.json (~/.claude.json for the default login). A Codex login
// is only `codex login status` under its CODEX_HOME, whose output is never shown: it can quote part
// of an API key. Signed-in folders under ~/.claude-logins and ~/.codex-logins that the file does not
// list are found: on standby when there is a file, with no rule when there is none. A login removed
// from the rules leaves its folder and sign-in alone: the file's Removed table names the folder, so it
// is not found again.
//
// This module imports nothing from desk-env.mjs: desk-env's CLI imports it at run time, and a cycle
// through a module still running its top-level await never settles.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { splitRow } from './machine.mjs';

export const TOOLS = Object.freeze(['claude', 'codex']);
export const RULES = Object.freeze(['in rotation', 'standby', 'off']);
export const CHECK_TIMEOUT_MS = 20 * 1000;
const home = () => process.env.HOME || homedir();
const expand = (p) => String(p).replace(/^~(?=\/|$)/, home());
export const tilde = (p) => (p === home() ? '~' : p.startsWith(`${home()}/`) ? `~${p.slice(home().length)}` : p);

// Each tool's default folder, the folder its extra logins live under, the variable that points it
// at another folder, and how a person signs a folder in.
const TOOL = {
  claude: { dir: () => join(home(), '.claude'), logins: () => join(home(), '.claude-logins'), env: 'CLAUDE_CONFIG_DIR',
    signIn: (l) => ({ shell: `${l.configDir ? `CLAUDE_CONFIG_DIR=${l.folder} ` : ''}claude`, then: '/login' }) },
  codex: { dir: () => join(home(), '.codex'), logins: () => join(home(), '.codex-logins'), env: 'CODEX_HOME',
    signIn: (l) => ({ shell: `${l.configDir ? `CODEX_HOME=${l.folder} ` : ''}codex login`, then: null }) },
};
export const loginsFolder = (tool) => TOOL[tool].logins();
// How a person signs a login in: the shell command to paste into a terminal, then what to type in the
// tool it opens, or null.   -> { shell, then }
export const signInParts = (login) => TOOL[login.tool].signIn(login);
export const signInCommand = (login) => { const p = signInParts(login); return p.then ? `${p.shell}, then ${p.then}` : p.shell; };

// `in rotation`, `In-Rotation` and `in  rotation` are one rule; anything else is null.
export function normRule(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, ' ');
  return RULES.includes(s) ? s : null;
}
export const ruleError = (v) => `"${v}" is not a rule: use one of ${RULES.map((r) => `\`${r}\``).join(', ')}`;

// A login as every reader gets it. configDir is the folder to point the tool at, or null for the
// tool's own default folder (no override).
export function login({ tool, name, folder, rule, source }) {
  const dir = resolve(expand(folder));
  return { tool, name, folder: tilde(dir), dir, configDir: dir === TOOL[tool].dir() ? null : dir, rule, source };
}
export const defaultLogin = (tool) => login({ tool, name: 'default', folder: TOOL[tool].dir(), rule: 'in rotation', source: 'default' });

// The environment a login's tool runs in: the caller's, never with an API key (the call stays on the
// signed-in account), and pointed at the login's folder, or at the default with no override.
export function loginEnv(l, env = process.env) {
  const { ANTHROPIC_API_KEY: _a, OPENAI_API_KEY: _o, CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _h, ...rest } = env;
  return l.configDir ? { ...rest, [TOOL[l.tool].env]: l.configDir } : rest;
}

// ---- the file --------------------------------------------------------------------------------
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const unquote = (s) => String(s ?? '').trim().replace(/^`(.*)`$/, '$1').trim();

// -> { exists, logins, removed: [{ tool, name, folder, dir }], errors: ["line <n>: <why>"] }. A malformed
// row is named and left out; a tool with no good row keeps its default login. `removed` are the logins
// the Removed table (Tool, Name, Folder) names, so setting a rule on one puts back its own folder.
export function parseSubscriptions(text, { exists = true } = {}) {
  const logins = [];
  const removed = [];
  const errors = [];
  let header = null;
  String(text ?? '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line.startsWith('|')) { header = null; return; }
    const c = splitRow(line).map(unquote);
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) return;
    if (!header) { header = c.map((x) => x.toLowerCase()); return; }
    const at = `line ${i + 1}`;
    if (header.join('|') === 'tool|name|folder') {
      const [tool, name, folder] = c;
      if (c.length !== 3 || !TOOLS.includes(tool) || !NAME.test(name ?? '') || !folder) errors.push(`${at}: a removed login wants a tool (claude or codex), a name and a folder`);
      else removed.push(removedLogin(tool, name, folder));
      return;
    }
    if (header.join('|') !== 'tool|name|folder|rule') return;
    const [tool, name, folder, ruleText] = c;
    const rule = normRule(ruleText);
    if (c.length !== 4) errors.push(`${at}: want 4 cells (Tool, Name, Folder, Rule), got ${c.length}`);
    else if (!TOOLS.includes(tool)) errors.push(`${at}: tool "${tool}" is neither claude nor codex`);
    else if (!NAME.test(name)) errors.push(`${at}: name "${name}" wants letters, digits, dots, dashes or underscores`);
    else if (!folder) errors.push(`${at}: ${tool} ${name} has no folder`);
    else if (!rule) errors.push(`${at}: ${tool} ${name}: ${ruleError(ruleText)}`);
    else {
      const l = login({ tool, name, folder, rule, source: 'file' });
      const same = logins.find((o) => o.tool === tool && (o.name === name || o.dir === l.dir));
      if (same) errors.push(`${at}: ${tool} ${name} repeats ${same.name === name ? 'the name' : `the folder of ${same.name}`}`);
      else logins.push(l);
    }
  });
  for (const tool of TOOLS) if (!logins.some((l) => l.tool === tool)) logins.push(defaultLogin(tool));
  return { exists, logins: sortLogins(logins), removed: removed.filter((r) => !logins.some((l) => l.tool === r.tool && l.dir === r.dir)), errors };
}
const sortLogins = (ls) => [...ls].sort((a, b) => TOOLS.indexOf(a.tool) - TOOLS.indexOf(b.tool));
const removedLogin = (tool, name, folder) => { const dir = resolve(expand(folder)); return { tool, name, folder: tilde(dir), dir }; };

export const readSubscriptions = (path) => (path && existsSync(path)
  ? parseSubscriptions(readFileSync(path, 'utf8'))
  : parseSubscriptions('', { exists: false }));

const cell = (v) => `\`${String(v).replace(/\|/g, '\\|')}\``;
export function renderSubscriptions(logins, removed = []) {
  return [
    '# Subscriptions',
    '',
    'The Claude and Codex logins desk may use on this computer, shared by every repo here. Each is a',
    'config folder (CLAUDE_CONFIG_DIR for Claude, CODEX_HOME for Codex) with a rule: `in rotation`',
    '(new workers start on whichever has the most room), `standby` (used only when every login in',
    'rotation is at its limit) or `off` (never used). `desk-env logins set` changes a rule and',
    '`desk-env logins remove` removes a login, each keeping the previous copy as subscriptions.md.bak;',
    '`desk-env logins check` confirms each is signed in. No token or credential is kept here.',
    '',
    '| Tool | Name | Folder | Rule |',
    '|---|---|---|---|',
    ...sortLogins(logins).map((l) => `| ${cell(l.tool)} | ${cell(l.name)} | ${cell(l.folder)} | ${cell(l.rule)} |`),
    '',
    ...(removed.length ? [
      '## Removed',
      '',
      'Logins desk leaves alone: removed from the rules, with their folder and sign-in kept, so a folder',
      'under ~/.claude-logins or ~/.codex-logins is not found again. Setting a rule on one lists it again.',
      '',
      '| Tool | Name | Folder |',
      '|---|---|---|',
      ...sortLogins(removed).map((r) => `| ${cell(r.tool)} | ${cell(r.name)} | ${cell(r.folder)} |`),
      '',
    ] : []),
  ].join('\n');
}

// ---- the account check -----------------------------------------------------------------------
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
export const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function run(bin, args, env) {
  const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: CHECK_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return { error: `${bin} did not answer within ${CHECK_TIMEOUT_MS / 1000}s` };
  if (r.error) return { error: `could not run ${bin}: ${r.error.code ?? r.error.message}` };
  return { code: r.status, out: r.stdout ?? '' };
}

// The sign-in state of one login, and for Claude its account and plan. Only these fields leave here.
//   -> { state: 'signed in' | 'signed out' | 'error', email, plan, why }
export function checkLogin(l, { claude = 'claude', codex = 'codex', env = process.env } = {}) {
  const out = { state: 'signed out', email: null, plan: null, why: null };
  if (!isDir(l.dir)) return { ...out, why: `${l.folder} does not exist` };
  if (l.tool === 'codex') {
    const r = run(codex, ['login', 'status'], loginEnv(l, env));
    if (r.error) return { ...out, state: 'error', why: r.error };
    return r.code === 0 ? { ...out, state: 'signed in' } : out;
  }
  const r = run(claude, ['auth', 'status', '--json'], loginEnv(l, env));
  if (r.error) return { ...out, state: 'error', why: r.error };
  let status = null;
  try { status = JSON.parse(r.out); } catch { /* not JSON: read as below */ }
  if (status?.loggedIn !== true) {
    if (r.code === 0 && !status) return { ...out, state: 'error', why: 'claude auth status --json did not print JSON' };
    return out;
  }
  const account = claudeAccount(l);
  const email = [status.email, account.email].find((e) => typeof e === 'string' && e) ?? null;
  return { ...out, state: 'signed in', email, plan: account.plan ?? 'unknown' };
}

// A Claude login's account as its folder's .claude.json records it (~/.claude.json for the default),
// with no call: oauthAccount's emailAddress and planDisplayName, each null when not recorded.
//   -> { email, plan }
export const claudeJsonPath = (l) => (l.configDir ? join(l.configDir, '.claude.json') : join(home(), '.claude.json'));
export function claudeAccount(l) {
  const a = readJson(claudeJsonPath(l))?.oauthAccount;
  const text = (v) => (typeof v === 'string' && v ? v : null);
  return { email: text(a?.emailAddress), plan: text(a?.planDisplayName) };
}

// Folders under a tool's logins folder that no login in `listed` points at and `removed` does not name.
export function unlistedFolders(tool, listed, removed = []) {
  const root = loginsFolder(tool);
  let names = [];
  try { names = readdirSync(root).sort(); } catch { return []; }
  const taken = new Set([...listed, ...removed].filter((l) => l.tool === tool).map((l) => l.dir));
  return names.map((n) => join(root, n)).filter((d) => isDir(d) && !taken.has(d));
}
// A folder the file does not list, as a login: on standby when there is a file, with no rule without one.
export const foundLogin = (tool, dir, subs) => login({ tool, name: basename(dir), folder: dir, rule: subs.exists ? 'standby' : null, source: 'found' });

// A tool's logins, each once by folder: its default folder first, then the file's rows for the tool,
// then the folders under its logins folder the file neither lists nor removed, then `extra`. The default keeps its
// place: the file's own row for it (a name, a rule) replaces it, and a file that lists other logins of
// the tool but not this one gives it no rule. Folders that do not exist are kept: the caller filters.
//   -> [login]
export function toolLogins(tool, subs, extra = []) {
  const out = [defaultLogin(tool)];
  const add = (l) => { if (!out.some((o) => o.dir === l.dir)) out.push(l); };
  for (const l of subs.logins) if (l.tool === tool) add(l);
  for (const dir of unlistedFolders(tool, out, subs.removed)) add(foundLogin(tool, dir, subs));
  for (const l of extra) add(l);
  const fileDefault = subs.logins.find((l) => l.tool === tool && l.dir === out[0].dir);
  out[0] = fileDefault ?? { ...out[0], rule: null };
  return out;
}

// Every login checked, the found ones added, duplicates refused, and the usable ones named.
//   -> { exists, errors, logins: [{ ...login, state, email, plan, why, duplicateOf }], usable: [login] }
// state is 'signed in', 'signed out', 'error' or 'duplicate'; a usable login is signed in with a rule
// of in rotation or standby. `tools` narrows the check to those tools' logins.
export function checkLogins(subs, { tools = TOOLS, ...opts } = {}) {
  const checked = subs.logins.filter((l) => tools.includes(l.tool)).map((l) => ({ ...l, ...checkLogin(l, opts), duplicateOf: null }));
  for (const tool of tools) {
    for (const dir of unlistedFolders(tool, subs.logins, subs.removed)) {
      const l = foundLogin(tool, dir, subs);
      const c = checkLogin(l, opts);
      if (c.state === 'signed in') checked.push({ ...l, ...c, duplicateOf: null });
    }
  }
  // Two Claude names on one account: the first keeps it.
  const owner = new Map();
  for (const l of checked) {
    if (l.tool !== 'claude' || l.state !== 'signed in' || !l.email) continue;
    const key = l.email.toLowerCase();
    if (owner.has(key)) Object.assign(l, { state: 'duplicate', duplicateOf: owner.get(key).name, why: `the same account as ${owner.get(key).name}` });
    else owner.set(key, l);
  }
  const logins = sortLogins(checked);
  return { exists: subs.exists, errors: subs.errors, logins, usable: logins.filter(isUsable) };
}
export const isUsable = (l) => l.state === 'signed in' && (l.rule === 'in rotation' || l.rule === 'standby');

// ---- changing a rule -------------------------------------------------------------------------
// The file's text with one login's rule changed. A login the file does not list is added: a tool's
// default (named `default`), a login the Removed table names, with its own folder, or a folder of that
// name under the tool's logins folder. Turning off the last usable Claude login is refused; `check` is
// called only then, -> checkLogins' result.
//   -> { text, login }, or throws with the reason
export function setRule(subs, { tool, name, rule: ruleText, check }) {
  if (!TOOLS.includes(tool)) throw new Error(`logins: tool "${tool}" is neither claude nor codex`);
  const rule = normRule(ruleText);
  if (!rule) throw new Error(`logins: ${ruleError(ruleText)}`);
  if (subs.errors.length) throw new Error(`logins: the subscriptions file has rows desk cannot read; fix them first:\n  ${subs.errors.join('\n  ')}`);
  let target = subs.logins.find((l) => l.tool === tool && l.name === name);
  const def = defaultLogin(tool);
  const gone = subs.removed.find((r) => r.tool === tool && r.name === name);
  if (!target && name === def.name && !subs.logins.some((l) => l.tool === tool && l.dir === def.dir)) target = { ...def, rule };
  else if (!target && gone) target = login({ tool, name, folder: gone.dir, rule, source: 'file' });
  if (!target) {
    const dir = join(loginsFolder(tool), name);
    if (!NAME.test(name) || !isDir(dir)) {
      const names = subs.logins.filter((l) => l.tool === tool).map((l) => l.name);
      throw new Error(`logins: no ${tool} login "${name}": the logins are ${names.join(', ')}, or a folder under ${tilde(loginsFolder(tool))}`);
    }
    target = login({ tool, name, folder: dir, rule, source: 'file' });
  }
  if (rule === 'off') lastUsable(tool, name, target, check, 'turning this one off');
  // In place, so the order (which name keeps a shared account) stays; an added login goes last, and
  // leaves the Removed table.
  const changed = { ...target, rule, source: 'file' };
  const listed = subs.logins.some((l) => l.tool === tool && l.name === target.name);
  const logins = listed ? subs.logins.map((l) => (l.tool === tool && l.name === target.name ? changed : l)) : [...subs.logins, changed];
  return { text: renderSubscriptions(logins, subs.removed.filter((r) => !(r.tool === tool && r.dir === changed.dir))), login: changed };
}

// Refuses to take away the last Claude login desk can use. Asked whatever the target's rule: a found
// folder is usable on standby before the file lists it, and a login already off is never usable.
function lastUsable(tool, name, target, check, doing) {
  if (tool !== 'claude') return;
  const usable = check().usable.filter((l) => l.tool === 'claude');
  if (usable.length === 1 && usable[0].dir === target.dir) {
    throw new Error(`logins: claude ${name} is the only Claude login desk can use, and desk needs one login it can use: sign another in, or set its rule, before ${doing}`);
  }
}

// ---- removing a login ------------------------------------------------------------------------
// The file's text with one login removed from the rules: its row dropped and its folder added to the
// Removed table, so a folder under the logins folder is not found on standby again. The folder and its
// sign-in are left alone. A tool's default folder is not removed (turn it off), nor the last Claude
// login desk can use; `check` is called only for a Claude login, -> checkLogins' result.
//   -> { text, login }, or throws with the reason
export function removeLogin(subs, { tool, name, check }) {
  if (!TOOLS.includes(tool)) throw new Error(`logins: tool "${tool}" is neither claude nor codex`);
  if (subs.errors.length) throw new Error(`logins: the subscriptions file has rows desk cannot read; fix them first:\n  ${subs.errors.join('\n  ')}`);
  const dir = NAME.test(name) ? join(loginsFolder(tool), name) : null;
  const target = subs.logins.find((l) => l.tool === tool && l.name === name)
    ?? (dir && isDir(dir) && !subs.removed.some((r) => r.tool === tool && r.dir === dir) ? foundLogin(tool, dir, subs) : null);
  if (!target) {
    const names = subs.logins.filter((l) => l.tool === tool).map((l) => l.name);
    throw new Error(`logins: no ${tool} login "${name}": the logins are ${names.join(', ')}, or a folder under ${tilde(loginsFolder(tool))}`);
  }
  if (!target.configDir) throw new Error(`logins: ${tool} ${name} is ${tilde(TOOL[tool].dir())}, ${tool === 'claude' ? 'Claude' : 'Codex'}'s own folder, which desk always knows: turn it off instead (desk-env logins set ${tool} ${name} off)`);
  lastUsable(tool, name, target, check, 'removing this one');
  const logins = subs.logins.filter((l) => !(l.tool === tool && l.dir === target.dir));
  return { text: renderSubscriptions(logins, [...subs.removed, { tool, name: target.name, folder: target.folder, dir: target.dir }]), login: target };
}

// ---- what the person is shown ----------------------------------------------------------------
const STATE = { 'signed in': 'signed in', 'signed out': 'signed out', error: 'not checked', duplicate: 'refused' };

// The file's status line, its unreadable rows, then the rows as aligned columns.
function tableLines(subs, path, head, body) {
  const w = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const fmt = (row) => row.map((c, i) => (i < row.length - 1 ? c.padEnd(w[i]) : c)).join('  ').trimEnd();
  return [
    subs.exists ? `subscriptions file: ${tilde(path)}` : `no subscriptions file at ${tilde(path)}: desk uses ~/.claude and ~/.codex`,
    ...subs.errors.map((e) => `left out, ${e}`),
    '',
    fmt(head), ...body.map(fmt),
  ];
}

export function checkLines(r, path) {
  const head = ['TOOL', 'NAME', 'FOLDER', 'STATE', 'ACCOUNT', 'PLAN', 'RULE'];
  const body = r.logins.map((l) => [l.tool, l.name, l.folder, STATE[l.state] ?? l.state,
    l.tool === 'claude' ? l.email ?? '-' : '-', l.tool === 'claude' ? l.plan ?? '-' : '-', l.rule ?? 'found, no rule']);
  const notes = [];
  for (const l of r.logins) {
    if (l.state === 'signed out') notes.push(`${l.tool} ${l.name} is signed out${l.why ? ` (${l.why})` : ''}: sign it in, in another terminal: ${signInCommand(l)}`);
    if (l.state === 'error') notes.push(`${l.tool} ${l.name} could not be checked: ${l.why}`);
    if (l.state === 'duplicate') notes.push(`${l.tool} ${l.name} refused: ${l.name} and ${l.duplicateOf} are signed in to the same account; desk uses ${l.duplicateOf}`);
  }
  const found = r.logins.filter((l) => l.source === 'found');
  if (found.length && !r.exists) notes.push(`found ${found.map((l) => `${l.tool} ${l.name}`).join(', ')}: no rule until one is set (desk-env logins set <tool> <name> <rule>)`);
  if (found.length && r.exists) notes.push(`found ${found.map((l) => `${l.tool} ${l.name}`).join(', ')}, not in the file: on standby`);
  return [
    ...tableLines(r, path, head, body),
    ...(notes.length ? ['', ...notes] : []),
    '',
    `usable: ${r.usable.map((l) => `${l.tool} ${l.name}`).join(', ') || 'none'}`,
  ];
}

export function listLines(subs, path) {
  return tableLines(subs, path, ['TOOL', 'NAME', 'FOLDER', 'RULE'], subs.logins.map((l) => [l.tool, l.name, l.folder, l.rule]));
}

// The JSON a script reads: nothing from a status call but the fields above.
export const loginJson = (l) => ({ tool: l.tool, name: l.name, folder: l.folder, configDir: l.configDir, rule: l.rule, source: l.source,
  ...(l.state ? { state: l.state, email: l.email, plan: l.plan, why: l.why, duplicateOf: l.duplicateOf, signIn: l.state === 'signed out' ? signInCommand(l) : null } : {}) });
