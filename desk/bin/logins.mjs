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
// is `codex login status` under its CODEX_HOME, whose output is never shown: it can quote part of an
// API key. Its email and plan are the id_token's payload in that folder's auth.json (codexAccount);
// the access and refresh tokens are never read out. Signed-in folders under ~/.claude-logins and ~/.codex-logins that the file does not
// list are found: on standby when there is a file, with no rule when there is none. A login removed
// from the rules leaves its folder and sign-in alone: the file's Removed table names the folder, so it
// is not found again.
//
// A Claude row may carry an Account: the email the folder belongs to, lowercased. Once any Claude row
// has one the file is in multi-account mode: ~/.claude is no longer one of the Claude logins, and a
// folder is used only while it is signed in to the account it is pinned to. Background code only reads
// the file; the commands a person runs write the pins.
//
// This module imports nothing from desk-env.mjs: desk-env's CLI imports it at run time, and a cycle
// through a module still running its top-level await never settles.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
// account is a Claude login's pinned email, lowercased, or null.
export function login({ tool, name, folder, rule, source, account = null }) {
  const dir = resolve(expand(folder));
  return { tool, name, folder: tilde(dir), dir, configDir: dir === TOOL[tool].dir() ? null : dir, rule, source, account: account ? String(account).toLowerCase() : null };
}
// True when any Claude login has an account: the file is then in multi-account mode.
export const multiAccount = (subs) => (subs?.logins ?? []).some((l) => l.tool === 'claude' && l.account);
export const defaultLogin = (tool) => login({ tool, name: 'default', folder: TOOL[tool].dir(), rule: 'in rotation', source: 'default' });

// The environment a login's tool runs in: the caller's, never with an API key (the call stays on the
// signed-in account), and pointed at the login's folder, or at the default with no override.
export function loginEnv(l, env = process.env) {
  const { ANTHROPIC_API_KEY: _a, OPENAI_API_KEY: _o, CLAUDE_CONFIG_DIR: _c, CODEX_HOME: _h, ...rest } = env;
  return l.configDir ? { ...rest, [TOOL[l.tool].env]: l.configDir } : rest;
}

// ---- the file --------------------------------------------------------------------------------
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
    const pinned = header.join('|') === 'tool|name|folder|account|rule';
    if (!pinned && header.join('|') !== 'tool|name|folder|rule') return;
    const [tool, name, folder, ...rest] = c;
    const ruleText = rest.at(-1);
    const accountText = pinned ? rest[0] : '';
    const account = accountText === '-' ? '' : accountText;
    const rule = normRule(ruleText);
    if (c.length !== (pinned ? 5 : 4)) errors.push(`${at}: want ${pinned ? '5 cells (Tool, Name, Folder, Account, Rule)' : '4 cells (Tool, Name, Folder, Rule)'}, got ${c.length}`);
    else if (!TOOLS.includes(tool)) errors.push(`${at}: tool "${tool}" is neither claude nor codex`);
    else if (!NAME.test(name)) errors.push(`${at}: name "${name}" wants letters, digits, dots, dashes or underscores`);
    else if (!folder) errors.push(`${at}: ${tool} ${name} has no folder`);
    else if (account && tool === 'codex') errors.push(`${at}: codex ${name}: a Codex row takes no account`);
    else if (account && !EMAIL.test(account)) errors.push(`${at}: claude ${name}: account "${account}" is not an email`);
    else if (!rule) errors.push(`${at}: ${tool} ${name}: ${ruleError(ruleText)}`);
    else {
      const l = login({ tool, name, folder, rule, source: 'file', account });
      const same = logins.find((o) => o.tool === tool && (o.name === name || o.dir === l.dir));
      if (same) errors.push(`${at}: ${tool} ${name} repeats ${same.name === name ? 'the name' : `the folder of ${same.name}`}`);
      else logins.push(l);
    }
  });
  // A file with pins has no ~/.claude login unless it lists one.
  for (const tool of TOOLS) if (!logins.some((l) => l.tool === tool) && !(tool === 'claude' && multiAccount({ logins }))) logins.push(defaultLogin(tool));
  return { exists, logins: sortLogins(logins), removed: removed.filter((r) => !logins.some((l) => l.tool === r.tool && l.dir === r.dir)), errors };
}
const sortLogins = (ls) => [...ls].sort((a, b) => TOOLS.indexOf(a.tool) - TOOLS.indexOf(b.tool));
const removedLogin = (tool, name, folder) => { const dir = resolve(expand(folder)); return { tool, name, folder: tilde(dir), dir }; };

export const readSubscriptions = (path) => (path && existsSync(path)
  ? parseSubscriptions(readFileSync(path, 'utf8'))
  : parseSubscriptions('', { exists: false }));

const cell = (v) => `\`${String(v).replace(/\|/g, '\\|')}\``;
export function renderSubscriptions(logins, removed = []) {
  const pinned = logins.some((l) => l.account);
  return [
    '# Subscriptions',
    '',
    'The Claude and Codex logins desk may use on this computer, shared by every repo here. Each is a',
    'config folder (CLAUDE_CONFIG_DIR for Claude, CODEX_HOME for Codex) with a rule: `in rotation`',
    '(new workers start on whichever has the most room), `standby` (used only when every login in',
    'rotation is at its limit) or `off` (never used). `desk-env logins set` changes a rule and',
    '`desk-env logins remove` removes a login, each keeping the previous copy as subscriptions.md.bak;',
    '`desk-env logins check` confirms each is signed in. No token or credential is kept here.',
    ...(pinned ? ['Account is the Claude account a folder belongs to: desk uses the folder only while it is signed in to that account.'] : []),
    '',
    ...(pinned ? ['| Tool | Name | Folder | Account | Rule |', '|---|---|---|---|---|'] : ['| Tool | Name | Folder | Rule |', '|---|---|---|---|']),
    ...sortLogins(logins).map((l) => `| ${cell(l.tool)} | ${cell(l.name)} | ${cell(l.folder)} | ${pinned ? `${cell(l.account ?? '-')} | ` : ''}${cell(l.rule)} |`),
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
    return r.code === 0 ? { ...out, state: 'signed in', ...codexAccount(l) } : out;
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

// A Codex login's account as its folder's auth.json records it, with no call and no signature check:
// the email and the https://api.openai.com/auth claim's chatgpt_plan_type, title-cased (pro -> Pro),
// from the id_token's payload alone. The access and refresh tokens are never read out. Each is null
// with no file, an API key only, or an id_token that is not three parts with a JSON middle.
//   -> { email, plan }
export const codexAuthPath = (l) => join(l.dir, 'auth.json');
const titleCase = (s) => s.split(/[_\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
export function codexAccount(l) {
  const none = { email: null, plan: null };
  const jwt = readJson(codexAuthPath(l))?.tokens?.id_token;
  const parts = typeof jwt === 'string' ? jwt.split('.') : [];
  if (parts.length !== 3) return none;
  let p = null;
  try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return none; }
  if (!p || typeof p !== 'object') return none;
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const plan = text(p['https://api.openai.com/auth']?.chatgpt_plan_type);
  return { email: text(p.email), plan: plan && titleCase(plan) };
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
// The folder a new login of `tool` gets: login-<n> under its logins folder, n one past the `count` of
// logins it has, moved on past a name or folder that is listed, removed or already on disk.
//   -> { name, dir }
export function nextLoginFolder(tool, subs, count) {
  const known = [...subs.logins, ...subs.removed].filter((l) => l.tool === tool);
  for (let n = Math.max(1, count + 1); ; n++) {
    const name = `login-${n}`, dir = join(loginsFolder(tool), name);
    if (!existsSync(dir) && !known.some((l) => l.name === name || l.dir === dir)) return { name, dir };
  }
}

// The label a person gave a login when adding it, kept in its folder's desk-label file beside the tool's
// own files, which desk never reads for it; null with none.
export const LABEL_FILE = 'desk-label';
export function loginLabelOf(l) {
  try { return readFileSync(join(l.dir, LABEL_FILE), 'utf8').split('\n')[0].trim() || null; } catch { return null; }
}
// A new login's folder made with its label in it.
export function makeLabelledFolder(dir, label) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LABEL_FILE), `${label}\n`);
}
// A new login's folder taken away again, only while it holds nothing but its label: true when it is gone.
export function dropNewFolder(dir) {
  try { if (readdirSync(dir).every((n) => n === LABEL_FILE)) rmSync(dir, { recursive: true }); } catch { /* left as it is */ }
  return !existsSync(dir);
}

// A folder the file does not list, as a login: on standby when there is a file, with no rule without one.
export const foundLogin = (tool, dir, subs) => login({ tool, name: basename(dir), folder: dir, rule: subs.exists ? 'standby' : null, source: 'found' });

// A tool's logins, each once by folder: its default folder first, then the file's rows for the tool,
// then the folders under its logins folder the file neither lists nor removed, then `extra`. The default keeps its
// place: the file's own row for it (a name, a rule) replaces it, and a file that lists other logins of
// the tool but not this one gives it no rule. Folders that do not exist are kept: the caller filters.
//   -> [login]
export function toolLogins(tool, subs, extra = []) {
  // With pins, Claude has no default login: every account has its own folder.
  const own = tool === 'claude' && multiAccount(subs);
  const out = own ? [] : [defaultLogin(tool)];
  const add = (l) => { if (!out.some((o) => o.dir === l.dir) && !(own && !l.configDir)) out.push(l); };
  for (const l of subs.logins) if (l.tool === tool) add(l);
  for (const dir of unlistedFolders(tool, out, subs.removed)) add(foundLogin(tool, dir, subs));
  for (const l of extra) add(l);
  if (!own) {
    const fileDefault = subs.logins.find((l) => l.tool === tool && l.dir === out[0].dir);
    out[0] = fileDefault ?? { ...out[0], rule: null };
  }
  return out;
}

// Every login checked, the found ones added, and the usable ones named.
//   -> { exists, errors, logins: [{ ...login, state, email, plan, why, liveEmail, pinnable }], usable: [login] }
// state is 'signed in', 'signed out', 'error', 'wrong account' or 'not set up'; a usable login is signed
// in with a rule of in rotation or standby. `tools` narrows the check to those tools' logins.
//   email     the pinned email when there is a pin, else the live one
//   liveEmail what the folder is signed in to, or null
//   pinnable  true only for a not set up folder signed in to an email no other login is pinned to
// Without pins, a second Claude folder on one account is not set up, and the first keeps it. With pins
// (multi-account mode) ~/.claude is never checked: a pinned folder is signed in only on its own account,
// wrong account on another, and a check that fails leaves its state as the check reported it, never
// re-pinning; an unpinned folder is not set up; two rows pinned to one email leave it to the first.
export function checkLogins(subs, { tools = TOOLS, ...opts } = {}) {
  const multi = multiAccount(subs);
  const skip = (l) => multi && l.tool === 'claude' && !l.configDir;
  const checked = subs.logins.filter((l) => tools.includes(l.tool) && !skip(l)).map((l) => ({ ...l, ...checkLogin(l, opts) }));
  for (const tool of tools) {
    for (const dir of unlistedFolders(tool, subs.logins, subs.removed)) {
      const l = foundLogin(tool, dir, subs);
      const c = checkLogin(l, opts);
      if (c.state === 'signed in') checked.push({ ...l, ...c });
    }
  }
  const claude = checked.filter((l) => l.tool === 'claude');
  const pins = new Map();
  for (const l of claude) if (l.account && !pins.has(l.account)) pins.set(l.account, l);
  const owner = new Map();
  for (const l of checked) {
    l.liveEmail = l.tool === 'claude' ? l.email : null;
    l.pinnable = false;
    if (l.tool !== 'claude') continue;
    const live = l.liveEmail?.toLowerCase() ?? null;
    if (multi) {
      if (l.account && pins.get(l.account) !== l) Object.assign(l, { state: 'not set up', why: `pinned to the same account as ${pins.get(l.account).name}` });
      else if (l.account) {
        l.email = l.account;
        if (l.state === 'signed in' && !live) Object.assign(l, { state: 'error', why: 'its account could not be read' });
        else if (l.state === 'signed in' && live !== l.account) Object.assign(l, { state: 'wrong account', why: `signed in to ${l.liveEmail}` });
      } else if (l.state === 'signed in') {
        const other = live ? pins.get(live) : null;
        Object.assign(l, { state: 'not set up', why: other ? `the same account as ${other.name}` : null, pinnable: !!live && !other });
      }
      else if (l.state === 'signed out') Object.assign(l, { state: 'not set up', why: `signed out${l.why ? ` (${l.why})` : ''}` });
    } else if (l.state === 'signed in' && live) {
      // Two Claude names on one account: the first keeps it.
      if (owner.has(live)) Object.assign(l, { state: 'not set up', why: `the same account as ${owner.get(live).name}` });
      else owner.set(live, l);
    }
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
  // Listed, then removed (its own folder), then a folder of that name, then the tool's own default.
  let target = subs.logins.find((l) => l.tool === tool && l.name === name);
  const gone = subs.removed.find((r) => r.tool === tool && r.name === name);
  const dir = join(loginsFolder(tool), name);
  const def = defaultLogin(tool);
  if (!target && gone) target = login({ tool, name, folder: gone.dir, rule, source: 'file' });
  else if (!target && NAME.test(name) && isDir(dir)) target = login({ tool, name, folder: dir, rule, source: 'file' });
  else if (!target && name === def.name && !subs.logins.some((l) => l.tool === tool && l.dir === def.dir)) target = { ...def, rule };
  if (!target) {
    const names = subs.logins.filter((l) => l.tool === tool).map((l) => l.name);
    throw new Error(`logins: no ${tool} login "${name}": the logins are ${names.join(', ')}, or a folder under ${tilde(loginsFolder(tool))}`);
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

// ---- pinning a folder to its account ---------------------------------------------------------
const underLogins = (l) => l.dir.startsWith(`${loginsFolder(l.tool)}/`);
// A listed ~/.claude row has no place once pins are written: it goes to Removed, as migration does.
const defaultRows = (subs) => subs.logins.filter((l) => l.tool === 'claude' && !l.configDir);
const removedFrom = (subs, rows) => [...subs.removed, ...rows.map((l) => ({ tool: l.tool, name: l.name, folder: l.folder, dir: l.dir }))];

// The file's text with one Claude folder pinned to the email it is signed in to. A folder the file does
// not list is added on standby (a Removed one with its own folder, or a folder of that name under
// ~/.claude-logins); a listed one keeps its rule. `check` is -> checkLogins' result.
//   -> { text, login }, or throws with the reason
export function pinLogin(subs, { tool, name, check }) {
  if (tool !== 'claude') throw new Error(`logins: only a Claude login is pinned, not ${tool}`);
  if (subs.errors.length) throw new Error(`logins: the subscriptions file has rows desk cannot read; fix them first:\n  ${subs.errors.join('\n  ')}`);
  const dir = NAME.test(name) ? join(loginsFolder(tool), name) : null;
  const gone = subs.removed.find((r) => r.tool === tool && r.name === name);
  const target = subs.logins.find((l) => l.tool === tool && l.name === name)
    ?? (gone ? login({ tool, name, folder: gone.dir, rule: 'standby', source: 'file' }) : null)
    ?? (dir && isDir(dir) ? login({ tool, name, folder: dir, rule: 'standby', source: 'file' }) : null);
  if (!target) {
    const names = subs.logins.filter((l) => l.tool === tool).map((l) => l.name);
    throw new Error(`logins: no ${tool} login "${name}": the logins are ${names.join(', ')}, or a folder under ${tilde(loginsFolder(tool))}`);
  }
  if (!target.configDir) throw new Error(`logins: ${tool} ${name} is ${tilde(TOOL[tool].dir())}, which desk does not pin: sign a folder under ${tilde(loginsFolder(tool))} in to the account instead`);
  const c = check().logins.find((l) => l.tool === tool && l.dir === target.dir) ?? checkLogin(target);
  if (c.state === 'error') throw new Error(`logins: claude ${name} could not be checked: ${c.why}`);
  const live = ('liveEmail' in c ? c.liveEmail : c.email)?.toLowerCase() ?? null;
  if (!live) throw new Error(`logins: claude ${name} is not signed in`);
  const other = subs.logins.find((l) => l.tool === tool && l.account === live && l.dir !== target.dir);
  if (other) throw new Error(`logins: ${live} is already pinned to ${other.name}`);
  const listed = subs.logins.some((l) => l.tool === tool && l.dir === target.dir);
  const changed = { ...target, account: live, source: 'file' };
  const kept = subs.logins.filter((l) => !defaultRows(subs).includes(l));
  const logins = listed ? kept.map((l) => (l.dir === changed.dir ? changed : l)) : [...kept, changed];
  const removed = removedFrom({ removed: subs.removed.filter((r) => !(r.tool === tool && r.dir === changed.dir)) }, defaultRows(subs));
  return { text: renderSubscriptions(logins, removed), login: changed };
}

// True when the file exists, has no pins, and lists or finds a Claude folder under ~/.claude-logins that
// the Removed table does not name. A file for Codex rules or a rule on ~/.claude alone is left alone.
export function needsMigration(subs) {
  if (!subs.exists || multiAccount(subs)) return false;
  return subs.logins.some((l) => l.tool === 'claude' && l.configDir && underLogins(l)) || unlistedFolders('claude', subs.logins, subs.removed).length > 0;
}

// The file's text migrated to account pins: each signed-in folder, listed or found, pinned to its email
// (the first in file order keeps one that two share, the other stays unpinned with its rule), and the
// ~/.claude row moved to Removed. `check` is -> checkLogins' result.
//   -> { text, hint }; text is null, and nothing is to be written, when no folder can be pinned (~/.claude
//   then stays as it is); hint is the email ~/.claude was signed in to when no folder is pinned to it, else null
export function migrateSubscriptions(subs, check) {
  if (subs.errors.length) throw new Error(`logins: the subscriptions file has rows desk cannot read; fix them first:\n  ${subs.errors.join('\n  ')}`);
  const claude = check().logins.filter((l) => l.tool === 'claude');
  const pins = new Map();
  for (const l of claude.filter((x) => x.configDir)) {
    const live = l.liveEmail?.toLowerCase();
    if (live && !pins.has(live)) pins.set(live, l.dir);
  }
  if (!pins.size) return { text: null, hint: null };
  const pin = (l) => ({ ...l, account: [...pins].find(([, d]) => d === l.dir)?.[0] ?? null });
  const own = defaultRows(subs);
  const listed = subs.logins.filter((l) => !own.includes(l)).map((l) => (l.tool === 'claude' ? pin(l) : l));
  const found = claude.filter((l) => l.configDir && !subs.logins.some((o) => o.dir === l.dir)).map((l) => pin(foundLogin('claude', l.dir, subs)));
  const live = claude.find((l) => !l.configDir)?.liveEmail?.toLowerCase() ?? null;
  const rows = own.length ? own : [defaultLogin('claude')];
  return { text: renderSubscriptions([...listed, ...found], removedFrom(subs, rows)), hint: live && !pins.has(live) ? live : null };
}

// ---- what the person is shown ----------------------------------------------------------------
const STATE = { 'signed in': 'signed in', 'signed out': 'signed out', error: 'not checked', 'wrong account': 'wrong account', 'not set up': 'not set up' };

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
    if (l.state === 'wrong account') notes.push(`${l.tool} ${l.name} is signed in to ${l.liveEmail}, not ${l.account}: desk won't use it until it is signed back in`);
    if (l.state === 'not set up') notes.push(l.pinnable ? `${l.tool} ${l.name} is not set up: desk-env logins pin ${l.tool} ${l.name} pins it to the account it is signed in to`
      : `${l.tool} ${l.name} is not set up: ${l.why ?? 'it is not signed in to an account'}; desk won't use it`);
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
  ...(l.account ? { account: l.account } : {}),
  ...(l.state ? { state: l.state, email: l.email, plan: l.plan, why: l.why, account: l.account ?? null, liveEmail: l.liveEmail ?? null, pinnable: !!l.pinnable, signIn: l.state === 'signed out' ? signInCommand(l) : null } : {}) });
