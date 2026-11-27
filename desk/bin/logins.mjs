// Subscriptions: the Claude and Codex logins desk may use on this computer, each a config folder
// marked as its tool's one `default` or as `unused`. Every reader still gets a rule: default reads as
// in rotation and unused as standby. A file in the older rules (in rotation, standby, off) is migrated
// by migrateLogins: each tool's first login in rotation, or its first listed, becomes its default.
//
// One file per computer, ~/.config/desk/subscriptions.md (desk-env.mjs owns the path), beside
// machine.md and costs.md and read by every repo. With no file, desk has one login per tool: Claude's
// ~/.claude and Codex's ~/.codex, each its tool's default, with no config folder override. A tool the
// file lists no login for keeps that default.
//
// The account check signs nothing in and reads no credential: a Claude login's account is what
// `claude auth status --json` says under its CLAUDE_CONFIG_DIR, and its plan is oauthAccount's
// planDisplayName in that folder's .claude.json (~/.claude.json for the default login). A Codex login
// is `codex login status` under its CODEX_HOME, whose output is never shown: it can quote part of an
// API key. Its email and plan are the id_token's payload in that folder's auth.json (codexAccount);
// the access and refresh tokens are never read out. Signed-in folders under ~/.claude-logins and ~/.codex-logins that the file does not
// list are found: unused when there is a file, with no rule when there is none. A login removed
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
import { isRealDay, localDay, splitRow } from './machine.mjs';

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
const ruleWords = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, ' ');
export function normRule(v) {
  const s = ruleWords(v);
  return RULES.includes(s) ? s : null;
}
// What the file may say in place of a rule, and the rule every reader gets for it: a tool's one
// `default` login reads as in rotation, and each `unused` one and Claude's one `fallback` (new work of
// the repos following the default runs there while the default is full) as standby. A login read from
// one keeps the word as `stored`, so writing the file back keeps it.
export const STORED_RULES = Object.freeze({ default: 'in rotation', unused: 'standby', fallback: 'standby' });
const storedRule = (v) => { const s = ruleWords(v); return Object.hasOwn(STORED_RULES, s) ? s : null; };
export const ruleError = (v) => `"${v}" is not a rule: use one of ${RULES.map((r) => `\`${r}\``).join(', ')}`;
// What a person is shown for a login: its stored word, else its rule.
export const ruleWord = (l) => l.stored ?? l.rule;

// A login as every reader gets it. configDir is the folder to point the tool at, or null for the
// tool's own default folder (no override).
// account is a Claude login's pinned email, lowercased, or null.
export function login({ tool, name, folder, rule, source, stored, account = null }) {
  const dir = resolve(expand(folder));
  return { tool, name, folder: tilde(dir), dir, configDir: dir === TOOL[tool].dir() ? null : dir, rule, source, ...(stored ? { stored } : {}), account: account ? String(account).toLowerCase() : null };
}
// True when the file has an Account column (`accounts`, which parseSubscriptions sets even when every
// pinned row in it failed to read) or any Claude login has an account: the file is then in
// multi-account mode.
export const multiAccount = (subs) => subs?.accounts === true || (subs?.logins ?? []).some((l) => l.tool === 'claude' && l.account);
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
// The Fees table: each login's plan and monthly fee, as the person entered them in /desk-setup costs.
const FEE_HEADER = 'tool|name|plan|monthly fee (usd)';
// `$200`, `200.00` or `1,000` -> dollars; blank, `-` or `none` -> null (not set); anything else undefined.
export function feeUsd(v) {
  const s = String(v ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!s || s === '-' || s.toLowerCase() === 'none') return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;
}

// -> { exists, accounts, logins, removed: [{ tool, name, folder, dir, at }], errors: ["line <n>: <why>"] }. A
// malformed row is named and left out; a tool with no good row keeps its default login, except Claude in
// a file with an Account column (`accounts`), which stays in multi-account mode with no login rather
// than fall back to ~/.claude. `removed` are the logins the Removed table (Tool, Name, Folder, Removed)
// names, so setting a rule on one puts back its own folder; `at` is the day it was removed (YYYY-MM-DD),
// null where the table predates that column or says `-`.
export function parseSubscriptions(text, { exists = true } = {}) {
  const logins = [];
  const removed = [];
  const errors = [];
  const fees = [];
  let header = null;
  let accounts = false;
  String(text ?? '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line.startsWith('|')) { header = null; return; }
    const c = splitRow(line).map(unquote);
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) return;
    if (!header) { header = c.map((x) => x.toLowerCase()); return; }
    const at = `line ${i + 1}`;
    if (header.join('|') === FEE_HEADER) {
      const [tool, name, plan, usdText] = c;
      const usd = feeUsd(usdText);
      if (c.length !== 4 || !TOOLS.includes(tool) || !NAME.test(name ?? '')) errors.push(`${at}: a fee wants a tool (claude or codex), a name, a plan and a monthly fee`);
      else if (usd === undefined) errors.push(`${at}: ${tool} ${name}: fee "${usdText}" is not dollars`);
      else fees.push({ at, tool, name, fee: { plan: plan && plan !== '-' ? plan : null, usd } });
      return;
    }
    const dated = header.join('|') === 'tool|name|folder|removed';
    if (dated || header.join('|') === 'tool|name|folder') {
      const [tool, name, folder, day = '-'] = c;
      const when = day === '-' || day === '' ? null : day;
      if (c.length !== (dated ? 4 : 3) || !TOOLS.includes(tool) || !NAME.test(name ?? '') || !folder) errors.push(`${at}: a removed login wants a tool (claude or codex), a name, a folder${dated ? ' and the day it was removed' : ''}`);
      else if (when && !isRealDay(when)) errors.push(`${at}: ${tool} ${name}: removed "${when}" wants a day as YYYY-MM-DD, or -`);
      else removed.push(removedLogin(tool, name, folder, when));
      return;
    }
    const pinned = header.join('|') === 'tool|name|folder|account|rule';
    if (!pinned && header.join('|') !== 'tool|name|folder|rule') return;
    if (pinned) accounts = true;
    const [tool, name, folder, ...rest] = c;
    const ruleText = rest.at(-1);
    const accountText = pinned ? rest[0] : '';
    const account = accountText === '-' ? '' : accountText;
    const stored = storedRule(ruleText);
    const rule = stored ? STORED_RULES[stored] : normRule(ruleText);
    if (c.length !== (pinned ? 5 : 4)) errors.push(`${at}: want ${pinned ? '5 cells (Tool, Name, Folder, Account, Rule)' : '4 cells (Tool, Name, Folder, Rule)'}, got ${c.length}`);
    else if (!TOOLS.includes(tool)) errors.push(`${at}: tool "${tool}" is neither claude nor codex`);
    else if (!NAME.test(name)) errors.push(`${at}: name "${name}" wants letters, digits, dots, dashes or underscores`);
    else if (!folder) errors.push(`${at}: ${tool} ${name} has no folder`);
    else if (account && tool === 'codex') errors.push(`${at}: codex ${name}: a Codex row takes no account`);
    else if (account && !EMAIL.test(account)) errors.push(`${at}: claude ${name}: account "${account}" is not an email`);
    else if (!rule) errors.push(`${at}: ${tool} ${name}: ${ruleError(ruleText)}`);
    else {
      const l = login({ tool, name, folder, rule, source: 'file', stored, account });
      const same = logins.find((o) => o.tool === tool && (o.name === name || o.dir === l.dir));
      if (same) errors.push(`${at}: ${tool} ${name} repeats ${same.name === name ? 'the name' : `the folder of ${same.name}`}`);
      else logins.push(l);
    }
  });
  // A file with pins has no ~/.claude login unless it lists one.
  for (const tool of TOOLS) if (!logins.some((l) => l.tool === tool) && !(tool === 'claude' && multiAccount({ accounts, logins }))) logins.push(defaultLogin(tool));
  for (const f of fees) {
    const i = logins.findIndex((l) => l.tool === f.tool && l.name === f.name);
    if (i < 0) errors.push(`${f.at}: a fee for ${f.tool} ${f.name}, which is not one of the logins`);
    else logins[i] = { ...logins[i], fee: f.fee };
  }
  return { exists, accounts, logins: sortLogins(logins), removed: removed.filter((r) => !logins.some((l) => l.tool === r.tool && l.dir === r.dir)), errors };
}
const sortLogins = (ls) => [...ls].sort((a, b) => TOOLS.indexOf(a.tool) - TOOLS.indexOf(b.tool));
const removedLogin = (tool, name, folder, at = null) => { const dir = resolve(expand(folder)); return { tool, name, folder: tilde(dir), dir, at }; };
// `rows` as Removed table entries, removed today (this computer's date).
const asRemoved = (rows) => rows.map((l) => ({ tool: l.tool, name: l.name, folder: l.folder, dir: l.dir, at: localDay() }));

export const readSubscriptions = (path) => (path && existsSync(path)
  ? parseSubscriptions(readFileSync(path, 'utf8'))
  : parseSubscriptions('', { exists: false }));

// ---- default and unused ----------------------------------------------------------------------
const asWord = (l, word) => ({ ...l, rule: STORED_RULES[word], stored: word });
// A tool's default among `logins`: the one marked default, else its first in rotation, else its first
// not off, else its first (off: no work runs until a person names a default).
export const defaultOf = (logins, tool) => {
  const own = logins.filter((l) => l.tool === tool);
  return own.find((l) => l.stored === 'default') ?? own.find((l) => l.rule === 'in rotation')
    ?? own.find((l) => l.rule !== 'off') ?? own[0] ?? null;
};
// A tool's rows want migrating while they hold other than one default, or a rule of in rotation or
// standby: an `off` set beside a default is kept, and rows that are all off stay off.
const wantsWords = (rows) => rows.length > 0 && rows.some((l) => l.rule !== 'off')
  && (rows.filter((l) => l.stored === 'default').length !== 1 || rows.some((l) => !l.stored && l.rule !== 'off'));
// The logins with each such tool's default marked default and every other login of the tool unused.
export function migrateLogins(logins) {
  const moved = TOOLS.filter((tool) => wantsWords(logins.filter((l) => l.tool === tool)));
  const defaults = moved.map((tool) => defaultOf(logins, tool));
  return logins.map((l) => (moved.includes(l.tool) ? asWord(l, defaults.includes(l) ? 'default' : l.stored === 'fallback' ? 'fallback' : 'unused') : l));
}
// Claude's fallback login: the one marked fallback, not off and not the default; null with none.
export const fallbackOf = (logins) => {
  const def = defaultOf(logins, 'claude');
  return logins.find((l) => l.tool === 'claude' && l.stored === 'fallback' && l.rule !== 'off' && l.dir !== def?.dir) ?? null;
};
// Whether the file's own rows want migrating, so the file wants writing.
export const needsMigration = (subs) => subs.exists
  && TOOLS.some((tool) => wantsWords(subs.logins.filter((l) => l.tool === tool && l.source === 'file')));
export const migrateSubscriptions = (subs) => ({ ...subs, logins: migrateLogins(subs.logins) });
// The login `logins list` shows as a tool's default, whether or not the file says default yet.
export const toolDefault = (subs, tool) => defaultOf(migrateLogins(subs.logins), tool);

const cell = (v) => `\`${String(v).replace(/\|/g, '\\|')}\``;
export function renderSubscriptions(logins, removed = []) {
  const pinned = logins.some((l) => l.account);
  return [
    '# Subscriptions',
    '',
    'The Claude and Codex logins desk may use on this computer, shared by every repo here. Each is a',
    'config folder (CLAUDE_CONFIG_DIR for Claude, CODEX_HOME for Codex), marked `default` (the one',
    'subscription of its tool this computer runs on) or `unused`. One Claude login may be `fallback`:',
    'new work of the repos following the default starts there only while the default is full.',
    '`desk-env logins default` changes a tool\'s default, `desk-env logins set claude <name> fallback`',
    'sets the fallback and `desk-env logins remove` removes a login, each keeping the previous copy as',
    'subscriptions.md.bak, and a migration keeps a dated copy; `desk-env logins check` confirms each is',
    'signed in. No token or credential is kept here.',
    ...(pinned ? ['Account is the Claude account a folder belongs to: desk uses the folder only while it is signed in to that account.'] : []),
    '',
    ...(pinned ? ['| Tool | Name | Folder | Account | Rule |', '|---|---|---|---|---|'] : ['| Tool | Name | Folder | Rule |', '|---|---|---|---|']),
    ...sortLogins(logins).map((l) => `| ${cell(l.tool)} | ${cell(l.name)} | ${cell(l.folder)} | ${pinned ? `${cell(l.account ?? '-')} | ` : ''}${cell(l.stored ?? l.rule)} |`),
    '',
    ...(logins.some((l) => l.fee) ? [
      '## Fees',
      '',
      'What each subscription costs a month, as entered in `/desk-setup costs` (`desk-env logins fee`).',
      'desk-q\'s Costs shows each as a monthly line. desk never guesses a fee.',
      '',
      '| Tool | Name | Plan | Monthly fee (USD) |',
      '|---|---|---|---|',
      ...sortLogins(logins.filter((l) => l.fee)).map((l) => `| ${cell(l.tool)} | ${cell(l.name)} | ${cell(l.fee.plan ?? '-')} | ${cell(l.fee.usd ?? 'none')} |`),
      '',
    ] : []),
    ...(removed.length ? [
      '## Removed',
      '',
      'Logins desk leaves alone: removed from the rules, with their folder and sign-in kept, so a folder',
      'under ~/.claude-logins or ~/.codex-logins is not found again. Setting a rule on one lists it again.',
      'Removed is the day it was removed, `-` where that was not recorded.',
      '',
      '| Tool | Name | Folder | Removed |',
      '|---|---|---|---|',
      ...sortLogins(removed).map((r) => `| ${cell(r.tool)} | ${cell(r.name)} | ${cell(r.folder)} | ${cell(r.at ?? '-')} |`),
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

// A folder the file does not list, as a login: unused when there is a file, with no rule without one.
export const foundLogin = (tool, dir, subs) => login({ tool, name: basename(dir), folder: dir, rule: subs.exists ? STORED_RULES.unused : null, source: 'found', stored: subs.exists ? 'unused' : undefined });

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
//   sameAs    for a not set up folder on an account another login has, that login's name, else null
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
    l.sameAs = null;
    if (l.tool !== 'claude') continue;
    const live = l.liveEmail?.toLowerCase() ?? null;
    if (multi) {
      if (l.account && pins.get(l.account) !== l) Object.assign(l, { state: 'not set up', why: `pinned to the same account as ${pins.get(l.account).name}`, sameAs: pins.get(l.account).name });
      else if (l.account) {
        l.email = l.account;
        if (l.state === 'signed in' && !live) Object.assign(l, { state: 'error', why: 'its account could not be read' });
        else if (l.state === 'signed in' && live !== l.account) Object.assign(l, { state: 'wrong account', why: `signed in to ${l.liveEmail}` });
      } else if (l.state === 'signed in') {
        const other = live ? pins.get(live) : null;
        Object.assign(l, { state: 'not set up', why: other ? `the same account as ${other.name}` : null, sameAs: other?.name ?? null, pinnable: !!live && !other });
      }
      else if (l.state === 'signed out') Object.assign(l, { state: 'not set up', why: `signed out${l.why ? ` (${l.why})` : ''}` });
    } else if (l.state === 'signed in' && live) {
      // Two Claude names on one account: the first keeps it.
      if (owner.has(live)) Object.assign(l, { state: 'not set up', why: `the same account as ${owner.get(live).name}`, sameAs: owner.get(live).name });
      else owner.set(live, l);
    }
  }
  const logins = sortLogins(checked);
  return { exists: subs.exists, errors: subs.errors, logins, usable: logins.filter(isUsable) };
}
export const isUsable = (l) => l.state === 'signed in' && (l.rule === 'in rotation' || l.rule === 'standby');

// ---- changing a rule -------------------------------------------------------------------------
// What `desk-env logins set` takes, and the rule each is read as. The default is chosen by name with
// `desk-env logins default`, never set as a rule, and the older rules are refused rather than mapped, so
// a stale script fails loudly.
export const SET_WORDS = Object.freeze({ unused: STORED_RULES.unused, fallback: STORED_RULES.fallback, off: 'off' });
export const setWordError = (tool, v) => {
  const words = Object.keys(SET_WORDS).map((w) => `\`${w}\``);
  const how = `choose the default with desk-env logins default ${TOOLS.includes(tool) ? tool : '<claude|codex>'} <name>, and set any other login ${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
  const s = ruleWords(v);
  return s === 'default' || s === 'in rotation' || s === 'standby'
    ? `logins: "${v}" is not a rule desk sets any more: ${how}` : `logins: "${v}" is not a rule: ${how}`;
};
// The file's text with one login set unused or off. A login the file does not list is added: a tool's
// default (named `default`), a login the Removed table names, with its own folder, or a folder of that
// name under the tool's logins folder. Turning off the last usable Claude login is refused; `check` is
// called only then, -> checkLogins' result. So is turning off a login a repo's Subscription row runs
// on: `repos(login)` names those repos.
//   -> { text, login }, or throws with the reason
export function setRule(subs, { tool, name, rule: word, check, repos = () => [] }) {
  if (!TOOLS.includes(tool)) throw new Error(`logins: tool "${tool}" is neither claude nor codex`);
  const w = ruleWords(word);
  const rule = Object.hasOwn(SET_WORDS, w) ? SET_WORDS[w] : null;
  if (!rule) throw new Error(setWordError(tool, word));
  if (w === 'fallback' && tool !== 'claude') throw new Error(`logins: only a Claude login can be the fallback, not ${tool} ${name}`);
  return writeRule(subs, { tool, name, rule, fallback: w === 'fallback', check, repos });
}
// setRule's write, given the rule a reader gets (in rotation for the tool's default, standby for unused
// or fallback). `fallback` makes the login Claude's one fallback and its old fallback unused.
function writeRule(subs, { tool, name, rule, fallback = false, check, repos = () => [] }) {
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
  if (rule !== 'in rotation' && toolDefault(subs, tool)?.dir === target.dir) throw notDefault(tool, name);
  if (rule === 'off') {
    pinnedOn(repos(target), tool, name);
    lastUsable(tool, name, target, check, 'turning this one off');
  }
  // In place, so the order (which name keeps a shared account) stays; an added login goes last, and
  // leaves the Removed table. Where the tool's rows say default and unused, the rule is written in
  // those words: in rotation makes this login the tool's one default and its old default unused.
  const words = subs.logins.some((l) => l.tool === tool && l.stored);
  const stored = fallback ? 'fallback' : words ? Object.keys(STORED_RULES).find((k) => STORED_RULES[k] === rule) : undefined;
  const { stored: _was, ...rest } = target;
  const changed = { ...rest, rule, source: 'file', ...(stored ? { stored } : {}) };
  const down = fallback ? subs.logins.filter((l) => l.tool === tool && l.name !== target.name && l.stored === 'fallback')
    : demotedBy(subs.logins, { tool, name: target.name, rule });
  const demoted = (l) => (down.includes(l) ? { ...l, rule: STORED_RULES.unused, stored: 'unused' } : l);
  const listed = subs.logins.some((l) => l.tool === tool && l.name === target.name);
  const logins = listed
    ? subs.logins.map((l) => (l.tool !== tool ? l : l.name === target.name ? changed : demoted(l)))
    : [...subs.logins.map((l) => (l.tool === tool ? demoted(l) : l)), changed];
  return { text: renderSubscriptions(logins, subs.removed.filter((r) => !(r.tool === tool && r.dir === changed.dir))), login: changed };
}
// The tool's logins that setting `name` to `rule` turns from default to unused: setting one in
// rotation, where the tool's rows say default and unused, makes it the tool's one default. An undo
// puts each back in rotation once the login itself is back.   -> [login]
export function demotedBy(logins, { tool, name, rule }) {
  if (normRule(rule) !== 'in rotation' || !logins.some((l) => l.tool === tool && l.stored)) return [];
  return logins.filter((l) => l.tool === tool && l.name !== name && l.stored === 'default');
}

// ---- changing the default --------------------------------------------------------------------
// The file's text, in default and unused, with `who` as its tool's one default and its previous
// default unused; a login set off stays off. `who` is a login's name or, for Claude, the account its
// folder is signed in to (any case). A login the file does not list is added as setRule adds one.
//   -> { text, login, was: the tool's previous default, or null }, or throws with the reason
export function setDefault(subs, { tool, who }) {
  if (!TOOLS.includes(tool)) throw new Error(`logins: tool "${tool}" is neither claude nor codex`);
  const moved = migrateSubscriptions(subs);
  const key = String(who ?? '').trim();
  let name = key;
  if (tool === 'claude' && key.includes('@') && !moved.logins.some((l) => l.tool === tool && l.name === key)) {
    const on = signedInTo(moved, key);
    if (on.length > 1) throw new Error(`logins: ${on.map((l) => l.name).join(' and ')} are all signed in to ${key}: name the login instead`);
    if (!on.length) throw new Error(`logins: no claude login is signed in to ${key}: the logins are ${moved.logins.filter((l) => l.tool === tool).map((l) => l.name).join(', ')}`);
    // writeRule finds a login by name, a listed or removed one before a folder, so a name another
    // folder holds would make that folder the default.
    const clash = [...moved.logins, ...moved.removed].find((l) => l.tool === tool && l.name === on[0].name && l.dir !== on[0].dir);
    if (clash) throw new Error(`logins: ${key} is signed in at ${on[0].folder}, but the file's claude ${clash.name} is ${clash.folder}: give one of them another name in the subscriptions file first`);
    name = on[0].name;
  }
  const was = defaultOf(moved.logins, tool);
  const r = writeRule(moved, { tool, name, rule: 'in rotation', check: () => null });
  return { text: r.text, login: r.login, was: was && was.dir !== r.login.dir ? was : null };
}

// ---- a login's fee ---------------------------------------------------------------------------
// The file's text with one listed login's plan and monthly fee set, or cleared with a fee of `none`.
//   -> { text, login }, or throws with the reason
export function setFee(subs, { tool, name, fee: feeText, plan }) {
  if (!TOOLS.includes(tool)) throw new Error(`logins: tool "${tool}" is neither claude nor codex`);
  if (subs.errors.length) throw new Error(`logins: the subscriptions file has rows desk cannot read; fix them first:\n  ${subs.errors.join('\n  ')}`);
  const target = subs.logins.find((l) => l.tool === tool && l.name === name);
  if (!target) throw new Error(`logins: no ${tool} login "${name}": the logins are ${subs.logins.filter((l) => l.tool === tool).map((l) => l.name).join(', ')}`);
  const usd = feeUsd(feeText);
  if (usd === undefined) throw new Error(`logins: fee "${feeText}" is not dollars: give the monthly fee, e.g. 200, or none to clear it`);
  const p = String(plan ?? '').trim();
  if (usd !== null && !p) throw new Error(`logins: ${tool} ${name}: name the plan the fee is for, e.g. Max`);
  if (p.includes('`') || p.includes('|')) throw new Error('logins: a plan name takes no ` or |');
  const { fee: _was, ...rest } = target;
  const changed = { ...rest, source: 'file', ...(usd === null ? {} : { fee: { plan: p, usd } }) };
  return { text: renderSubscriptions(subs.logins.map((l) => (l === target ? changed : l)), subs.removed), login: changed };
}

// ---- a repo's subscription -------------------------------------------------------------------
// The Claude logins whose folder is signed in to `email`, any case, as each .claude.json records it.
function signedInTo(subs, email) {
  const key = String(email ?? '').trim().toLowerCase();
  // A folder pinned to another account is never this one's, whatever it is signed in to now.
  return key ? toolLogins('claude', subs).filter((l) => isDir(l.dir) && (!l.account || l.account === key) && claudeAccount(l).email?.toLowerCase() === key) : [];
}
// The Claude login not set off that is signed in to `email`: the first where two share an account
// (setDefault refuses those instead). null for none: a login set off runs no repo's work.
export function subscriptionLogin(subs, email) {
  return signedInTo(subs, email).find((l) => l.rule !== 'off') ?? null;
}
// The login set off that is signed in to `email`, where no login not set off is: what a pin to it is
// refused for. null otherwise.
export function offSubscriptionLogin(subs, email) {
  const on = signedInTo(subs, email);
  return on.some((l) => l.rule !== 'off') ? null : on[0] ?? null;
}
// What a repo's subscription resolves to. `value` is `default` or an account email, read from `source`
// (DESK_SUBSCRIPTION or the repo's row); unset or `default` is this computer's Claude default, and no
// login while that default is off. An email no login here is signed in to, or only an off one,
// resolves to no login, never to the default; `off` is the login set off it names, else null. Only a
// repo following the default has a `fallback`: Claude's fallback login (fallbackOf), else null.
//   -> { email, login, source: source | 'default' | 'unknown email', off, fallback }
export function repoSubscription(subs, { value, source }) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v || v === 'default') {
    // With accounts pinned and no pinned row readable there is no default: no login, never ~/.claude.
    const l = toolDefault(subs, 'claude');
    const login = l?.rule === 'off' ? null : l;
    return { email: l ? (l.account ?? claudeAccount(l).email?.toLowerCase() ?? null) : null, login, source: 'default', off: null,
      fallback: login ? fallbackOf(migrateLogins(subs.logins)) : null };
  }
  const l = subscriptionLogin(subs, v);
  return { email: v, login: l, source: l ? source : 'unknown email', off: l ? null : offSubscriptionLogin(subs, v) };
}

// A tool's default is changed by naming another, never by taking it off, on standby or out.
const notDefault = (tool, name) => new Error(`logins: ${tool} ${name} is the ${tool === 'claude' ? 'Claude' : 'Codex'} default: make another subscription the default first (desk-env logins default ${tool} <name>)`);

// Refuses to take away a login the repos `on` run on, by their config's Subscription row.
function pinnedOn(on, tool, name) {
  if (on.length) throw new Error(`logins: ${on.join(', ')} ${on.length > 1 ? 'run' : 'runs'} on ${tool} ${name}, by ${on.length > 1 ? 'their' : 'its'} config's Subscription row: move ${on.length > 1 ? 'them' : 'it'} to another subscription first (desk-env subscription set <slug> <default|email>)`);
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
// login desk can use, nor a login a repo's Subscription row runs on: `repos(login)` names those repos.
// `check` is called only for a Claude login, -> checkLogins' result.
//   -> { text, login }, or throws with the reason
export function removeLogin(subs, { tool, name, check, repos = () => [] }) {
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
  if (toolDefault(subs, tool)?.dir === target.dir) throw notDefault(tool, name);
  pinnedOn(repos(target), tool, name);
  lastUsable(tool, name, target, check, 'removing this one');
  // The last pinned account is kept whatever its state: without a pin the file would leave
  // multi-account mode, and desk would go back to ~/.claude, the person's own Claude Code.
  if (tool === 'claude' && target.account && !subs.logins.some((l) => l.tool === 'claude' && l.account && l.dir !== target.dir)) {
    throw new Error(`logins: claude ${name} is the only Claude account desk has, and removing it would put desk back on ${tilde(TOOL.claude.dir())}: add another account first, or sign this one in again (${signInCommand(target)})`);
  }
  const logins = subs.logins.filter((l) => !(l.tool === tool && l.dir === target.dir));
  return { text: renderSubscriptions(logins, [...subs.removed, ...asRemoved([target])]), login: target };
}

// ---- pinning a folder to its account ---------------------------------------------------------
const underLogins = (l) => l.dir.startsWith(`${loginsFolder(l.tool)}/`);
// A listed ~/.claude row has no place once pins are written: it goes to Removed, as migration does.
const defaultRows = (subs) => subs.logins.filter((l) => l.tool === 'claude' && !l.configDir);
const removedFrom = (subs, rows) => [...subs.removed, ...asRemoved(rows)];
// `logins` once the ~/.claude rows are gone: where one of them was Claude's default, the folder pinned
// to the account ~/.claude was signed in to (`live`) takes over as the default, and every other Claude
// login is unused; with no such folder, nothing is marked and the first in rotation reads as default.
function defaultKept(subs, logins, live) {
  const was = toolDefault(subs, 'claude');
  if (!was || was.configDir) return logins;
  const next = live && logins.find((l) => l.tool === 'claude' && l.account === live && l.rule !== 'off');
  if (!next) return logins;
  return logins.map((l) => (l.tool !== 'claude' || l.rule === 'off' ? l : asWord(l, l === next ? 'default' : 'unused')));
}
const ownLive = (checked) => checked.logins.find((l) => l.tool === 'claude' && !l.configDir)?.liveEmail?.toLowerCase() ?? null;

// The file's text with one Claude folder pinned to the email it is signed in to. A folder the file does
// not list is added unused (a Removed one with its own folder, or a folder of that name under
// ~/.claude-logins); a listed one keeps its rule. `check` is -> checkLogins' result.
//   -> { text, login, migrated }, or throws with the reason; migrated is true when the pin also moves a
//   ~/.claude row to Removed, which makes the write a migration
export function pinLogin(subs, { tool, name, check }) {
  if (tool !== 'claude') throw new Error(`logins: only a Claude login is pinned, not ${tool}`);
  if (subs.errors.length) throw new Error(`logins: the subscriptions file has rows desk cannot read; fix them first:\n  ${subs.errors.join('\n  ')}`);
  const dir = NAME.test(name) ? join(loginsFolder(tool), name) : null;
  const gone = subs.removed.find((r) => r.tool === tool && r.name === name);
  const target = subs.logins.find((l) => l.tool === tool && l.name === name)
    ?? (gone ? login({ tool, name, folder: gone.dir, rule: STORED_RULES.unused, source: 'file', stored: 'unused' }) : null)
    ?? (dir && isDir(dir) ? login({ tool, name, folder: dir, rule: STORED_RULES.unused, source: 'file', stored: 'unused' }) : null);
  if (!target) {
    const names = subs.logins.filter((l) => l.tool === tool).map((l) => l.name);
    throw new Error(`logins: no ${tool} login "${name}": the logins are ${names.join(', ')}, or a folder under ${tilde(loginsFolder(tool))}`);
  }
  if (!target.configDir) throw new Error(`logins: ${tool} ${name} is ${tilde(TOOL[tool].dir())}, which desk does not pin: sign a folder under ${tilde(loginsFolder(tool))} in to the account instead`);
  const checked = check();
  const c = checked.logins.find((l) => l.tool === tool && l.dir === target.dir) ?? checkLogin(target);
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
  const kept2 = defaultKept(subs, logins, ownLive(checked));
  return { text: renderSubscriptions(kept2, removed), login: kept2.find((l) => l.dir === changed.dir), migrated: defaultRows(subs).length > 0 };
}

// True when the file exists, has no pins, and lists or finds a Claude folder under ~/.claude-logins that
// the Removed table does not name. A file for Codex rules or a rule on ~/.claude alone is left alone.
// (needsMigration and migrateSubscriptions above are the default-and-unused words' migration.)
export function needsPinMigration(subs) {
  if (!subs.exists || multiAccount(subs)) return false;
  return subs.logins.some((l) => l.tool === 'claude' && l.configDir && underLogins(l)) || unlistedFolders('claude', subs.logins, subs.removed).length > 0;
}

// The file's text migrated to account pins: each signed-in folder, listed or found, pinned to its email
// (the first in file order keeps one that two share, the other stays unpinned with its rule), and the
// ~/.claude row moved to Removed. `check` is -> checkLogins' result.
//   -> { text, hint }; text is null, and nothing is to be written, when no folder can be pinned (~/.claude
//   then stays as it is); hint is the email ~/.claude was signed in to when no folder is pinned to it, else null
export function migratePins(subs, check) {
  if (subs.errors.length) throw new Error(`logins: the subscriptions file has rows desk cannot read; fix them first:\n  ${subs.errors.join('\n  ')}`);
  const checked = check();
  const claude = checked.logins.filter((l) => l.tool === 'claude');
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
  return { text: renderSubscriptions(defaultKept(subs, [...listed, ...found], live), removedFrom(subs, rows)), hint: live && !pins.has(live) ? live : null };
}

// What a migration changes, for the person to read: `before -> after` for each login of `was` (the file
// as read) whose rule or section differs in `text` (the file to be written), then, for a ~/.claude
// login moved to Removed, why and the command that lists it again.   -> [line]
export function migrationLines(was, text) {
  const now = parseSubscriptions(text);
  const same = (l) => (o) => o.tool === l.tool && o.dir === l.dir;
  const lines = [], moved = [];
  for (const l of was.logins) {
    const after = now.logins.find(same(l));
    const gone = !after && now.removed.find(same(l));
    const word = after ? ruleWord(after) : gone ? 'Removed' : null;
    if (!word || word === ruleWord(l)) continue;
    lines.push(`${l.tool} ${l.name} (${l.folder}): ${ruleWord(l)} -> ${word}`);
    if (gone && l.tool === 'claude' && !l.configDir) moved.push(l);
  }
  // ~/.claude moved to Removed though the file never listed it (migratePins' fallback): said too.
  for (const r of now.removed) {
    if (r.tool !== 'claude' || r.dir !== defaultLogin('claude').dir || was.logins.some(same(r)) || was.removed.some(same(r))) continue;
    lines.push(`${r.tool} ${r.name} (${r.folder}): not listed -> Removed`);
    moved.push(r);
  }
  for (const l of moved) {
    lines.push(`${l.tool} ${l.name} (${l.folder}) moved to Removed: once a Claude login is pinned to an account, desk signs in only through pinned folders, never ${l.folder}. To list it again: desk-env logins set ${l.tool} ${l.name} unused`);
  }
  return lines;
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
    l.tool === 'claude' ? l.email ?? '-' : '-', l.tool === 'claude' ? l.plan ?? '-' : '-', ruleWord(l) ?? 'found, no rule']);
  const notes = [];
  for (const l of r.logins) {
    if (l.state === 'signed out') notes.push(`${l.tool} ${l.name} is signed out${l.why ? ` (${l.why})` : ''}: sign it in, in another terminal: ${signInCommand(l)}`);
    if (l.state === 'error') notes.push(`${l.tool} ${l.name} could not be checked: ${l.why}`);
    if (l.state === 'wrong account') notes.push(`${l.tool} ${l.name} is signed in to ${l.liveEmail}, not ${l.account}: desk won't use it until it is signed back in`);
    if (l.state === 'not set up') notes.push(l.pinnable ? `${l.tool} ${l.name} is not set up: desk-env logins pin ${l.tool} ${l.name} pins it to the account it is signed in to`
      : `${l.tool} ${l.name} is not set up: ${l.why ?? 'it is not signed in to an account'}; desk won't use it`);
  }
  const found = r.logins.filter((l) => l.source === 'found');
  if (found.length && !r.exists) notes.push(`found ${found.map((l) => `${l.tool} ${l.name}`).join(', ')}: no rule until one is set (desk-env logins set <tool> <name> unused)`);
  if (found.length && r.exists) notes.push(`found ${found.map((l) => `${l.tool} ${l.name}`).join(', ')}, not in the file: unused`);
  return [
    ...tableLines(r, path, head, body),
    ...(notes.length ? ['', ...notes] : []),
    '',
    `usable: ${r.usable.map((l) => `${l.tool} ${l.name}`).join(', ') || 'none'}`,
  ];
}

export function listLines(subs, path) {
  return tableLines(subs, path, ['TOOL', 'NAME', 'FOLDER', 'RULE'], subs.logins.map((l) => [l.tool, l.name, l.folder, ruleWord(l)]));
}

// The JSON a script reads: nothing from a status call but the fields above.
export const loginJson = (l) => ({ tool: l.tool, name: l.name, folder: l.folder, configDir: l.configDir, rule: l.rule, source: l.source,
  ...(l.account ? { account: l.account } : {}),
  ...(l.state ? { state: l.state, email: l.email, plan: l.plan, why: l.why, account: l.account ?? null, liveEmail: l.liveEmail ?? null, pinnable: !!l.pinnable, sameAs: l.sameAs ?? null, signIn: l.state === 'signed out' ? signInCommand(l) : null } : {}) });
