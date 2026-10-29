// Cost sources: which GitHub repos, Vercel teams and projects and AWS profiles bill each name.
//
// One file per computer, ~/.config/desk/costs.md (desk-env.mjs owns the path), beside machine.md and
// read by every repo. A name is usually a configured repo's, but a bill can belong to no repo in desk,
// so each row carries the repo's slug or `none`. No token is ever read into the file: it records
// where each supplier's login lives.
//
// Detection is split from parsing so the parsers run on fixture output: parseAwsConfig() and the
// Vercel parsers take what the AWS config and the Vercel API return, propose() matches it to names
// and merges a saved file, and renderCosts()/parseCosts() are the file. Only `costs write` writes,
// and /desk-setup costs runs it only after the user confirms the proposal.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { splitRow } from './machine.mjs';

export const SUPPLIERS = Object.freeze(['github', 'vercel', 'aws']);
const HOME = process.env.HOME || homedir();
const tilde = (p) => (p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p);

// ---- where each supplier's login lives -------------------------------------------------------
export function vercelAuthPath(plat = osPlatform()) {
  if (process.env.DESK_VERCEL_AUTH) return process.env.DESK_VERCEL_AUTH;
  if (plat === 'darwin') return join(HOME, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json');
  return join(process.env.XDG_DATA_HOME || join(HOME, '.local', 'share'), 'com.vercel.cli', 'auth.json');
}
export const awsConfigPath = () => process.env.AWS_CONFIG_FILE || join(HOME, '.aws', 'config');
const vercelApi = () => (process.env.DESK_VERCEL_API || 'https://api.vercel.com').replace(/\/$/, '');
export const VERCEL_TIMEOUT_MS = 30 * 1000;

// The Vercel CLI's token, or null: an unreadable file reads as signed out.
export function vercelToken(auth = vercelAuthPath()) {
  let token = null;
  try { token = JSON.parse(readFileSync(auth, 'utf8')).token; } catch { /* unreadable reads as signed out */ }
  return typeof token === 'string' && token ? token : null;
}

// One GET with the token.  -> the body as text; throws with the reason
export async function vercelText(path, token) {
  let r;
  try { r = await fetch(`${vercelApi()}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(VERCEL_TIMEOUT_MS) }); }
  catch (e) { throw new Error(e?.name === 'TimeoutError' ? `timed out after ${VERCEL_TIMEOUT_MS / 1000}s` : `could not reach Vercel: ${e?.message ?? e}`); }
  if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status}: the Vercel login has expired or has no access: run vercel login`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  try { return await r.text(); } catch (e) { throw new Error(e?.name === 'TimeoutError' ? `timed out after ${VERCEL_TIMEOUT_MS / 1000}s` : `could not read Vercel's answer: ${e?.message ?? e}`); }
}

// ---- parsing ---------------------------------------------------------------------------------
// `[default]` and `[profile x]`; other sections (`[sso-session x]`, `[services x]`) are not profiles.
export function parseAwsConfig(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = /^\s*\[\s*(default|profile\s+([^\]]+?))\s*\]\s*$/.exec(line);
    if (m) out.push(m[2] ? m[2].trim() : 'default');
  }
  return [...new Set(out)];
}

// GET /v2/teams. A team without a string id and slug is skipped and counted, never guessed at.
//   -> { teams: [{ id, slug, name, plan }], skipped }
export function parseVercelTeams(body) {
  const list = Array.isArray(body?.teams) ? body.teams : [];
  const teams = [];
  let skipped = 0;
  for (const t of list) {
    if (typeof t?.id !== 'string' || typeof t?.slug !== 'string') { skipped++; continue; }
    const plan = typeof t.billing?.plan === 'string' ? t.billing.plan : 'unknown';
    teams.push({ id: t.id, slug: t.slug, name: typeof t.name === 'string' ? t.name : t.slug, plan });
  }
  return { teams, skipped };
}

// GET /v9/projects?teamId=…  -> { projects: [name], next: cursor | null }
export function parseVercelProjects(body) {
  const list = Array.isArray(body?.projects) ? body.projects : [];
  const next = body?.pagination?.next;
  return {
    projects: list.map((p) => p?.name).filter((n) => typeof n === 'string'),
    next: typeof next === 'number' || typeof next === 'string' ? next : null,
  };
}

// ---- detection -------------------------------------------------------------------------------
const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }); }
  catch { return ''; }
};
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

export const ghLogin = () => run('gh', ['api', 'user', '--jq', '.login']).trim() || null;

const vercelGet = async (path, token) => JSON.parse(await vercelText(path, token));

// -> { auth, teams: [{ id, slug, name, plan, projects: [name] }], error }
export async function detectVercel() {
  const auth = vercelAuthPath();
  const token = vercelToken(auth);
  if (!token) return { auth, teams: [], error: `not signed in (no token in ${tilde(auth)}): run vercel login` };
  try {
    const { teams, skipped } = parseVercelTeams(await vercelGet('/v2/teams?limit=100', token));
    for (const t of teams) {
      t.projects = [];
      let until = null;
      for (let page = 0; page < 20; page++) {
        const q = `/v9/projects?teamId=${encodeURIComponent(t.id)}&limit=100${until != null ? `&until=${until}` : ''}`;
        const { projects, next } = parseVercelProjects(await vercelGet(q, token));
        t.projects.push(...projects);
        if (next == null || !projects.length) break;
        until = next;
      }
    }
    return { auth, teams, error: skipped ? `${skipped} team(s) without an id and slug skipped` : null };
  } catch (e) {
    return { auth, teams: [], error: `could not read teams: ${e.message}` };
  }
}

// repos: [{ slug, ghRepo }] from the configured repo configs.
//   -> { repos, login, vercel, aws: { path, profiles, error } }
export async function detect({ repos }) {
  const awsPath = awsConfigPath();
  const awsText = read(awsPath);
  return {
    repos,
    login: ghLogin(),
    vercel: await detectVercel(),
    aws: { path: awsPath, profiles: parseAwsConfig(awsText), error: awsText == null ? `no AWS config at ${tilde(awsPath)}` : null },
  };
}

// ---- names -----------------------------------------------------------------------------------
const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const repoName = (ghRepo) => String(ghRepo).split('/').pop();

// The longest known name a source's own name contains (`prninja-admin` -> `pr-ninja`), or null.
export function matchName(text, names) {
  const s = squash(text);
  let best = null;
  for (const n of names) {
    const q = squash(n);
    if (q.length >= 3 && s.includes(q) && (!best || q.length > squash(best).length)) best = n;
  }
  return best;
}

// An AWS profile's name for itself when it matches nothing: less a role suffix.
const ROLE_SUFFIX = /[-_](admin|administrator|dev|developer|prod|production|staging|readonly|read-only|billing)$/i;
const ownName = (profile) => profile.replace(ROLE_SUFFIX, '') || profile;

// ---- entries ---------------------------------------------------------------------------------
// One entry per source: github { key: owner/name, account, readable }, vercel { key: team/project
// or team, teamId, team, plan, project }, aws { key: profile, credit }. Each has a name and repo.
export const entryId = (e) => `${e.supplier}:${e.key}`;

function detectedEntries(found, names) {
  const out = [];
  for (const r of found.repos) {
    const account = r.ghRepo.split('/')[0];
    out.push({ supplier: 'github', key: r.ghRepo, name: repoName(r.ghRepo), account,
      readable: found.login ? account.toLowerCase() === found.login.toLowerCase() : null });
  }
  for (const t of found.vercel?.teams ?? []) {
    const team = { teamId: t.id, team: t.slug, plan: t.plan };
    const byTeam = matchName(t.slug, names) ?? matchName(t.name, names);
    if (!t.projects?.length) out.push({ supplier: 'vercel', key: t.slug, name: byTeam ?? t.slug, ...team, project: null });
    for (const p of t.projects ?? []) {
      out.push({ supplier: 'vercel', key: `${t.slug}/${p}`, name: matchName(p, names) ?? byTeam ?? p, ...team, project: p });
    }
  }
  for (const p of found.aws?.profiles ?? []) {
    out.push({ supplier: 'aws', key: p, name: matchName(p, names) ?? ownName(p), credit: null });
  }
  return out;
}

const FACTS = { github: ['account', 'readable'], vercel: ['teamId', 'team', 'plan'], aws: [] };

// The user's changes to a proposal, from the CLI's flags.
//   --name <supplier>:<key>=<name>   --drop <supplier>:<key>
//   --actions-budget <usd>           --credit <profile>=<usd>@<YYYY-MM-DD>
export function parseEdits(args) {
  const edits = { names: {}, drop: [], budget: undefined, credits: {} };
  for (let i = 0; i < args.length; i++) {
    const [flag, v] = [args[i], args[i + 1]];
    if (!['--name', '--drop', '--actions-budget', '--credit'].includes(flag)) throw new Error(`costs: unknown option ${flag}`);
    if (v == null) throw new Error(`costs: ${flag} needs a value`);
    i++;
    if (flag === '--drop') { edits.drop.push(v); continue; }
    if (flag === '--actions-budget') {
      const n = Number(v.replace(/^\$/, ''));
      if (!(n >= 0) || v.trim() === '') throw new Error(`costs: --actions-budget wants dollars, got "${v}"`);
      edits.budget = n;
      continue;
    }
    const eq = v.lastIndexOf('=');
    if (eq <= 0) throw new Error(`costs: ${flag} wants <source>=<value>, got "${v}"`);
    const [k, val] = [v.slice(0, eq), v.slice(eq + 1)];
    if (flag === '--name') {
      if (!val.trim()) throw new Error(`costs: --name ${k} needs a name`);
      edits.names[k] = val.trim();
      continue;
    }
    const m = /^\$?(\d+(?:\.\d+)?)@(\d{4}-\d{2}-\d{2})$/.exec(val);
    if (!m) throw new Error(`costs: --credit wants <profile>=<usd>@<YYYY-MM-DD>, got "${v}"`);
    edits.credits[k] = { usd: Number(m[1]), ends: m[2] };
  }
  return edits;
}

// Saved entries keep their name and credit, with their facts refreshed from what was found; a found
// source not saved yet is new; a saved one not found is kept and said. Then the user's edits.
//   -> { entries: [{ ...entry, status }], budget: { actionsUsd }, logins }
export function propose({ found, saved, edits = parseEdits([]), today }) {
  const repoOf = Object.fromEntries(found.repos.map((r) => [repoName(r.ghRepo), r.slug]));
  const savedEntries = saved?.entries ?? [];
  const names = [...new Set([...Object.keys(repoOf), ...savedEntries.map((e) => e.name)])];
  const detected = new Map(detectedEntries(found, names).map((e) => [entryId(e), e]));
  // A supplier that could not be read says nothing about whether a saved source still exists.
  const looked = { github: true, vercel: !found.vercel?.error, aws: !found.aws?.error };
  const entries = [];
  for (const s of savedEntries) {
    const d = detected.get(entryId(s));
    detected.delete(entryId(s));
    if (!d) { entries.push({ ...s, status: looked[s.supplier] ? 'not found' : 'saved' }); continue; }
    const changed = FACTS[s.supplier].some((k) => d[k] !== s[k]);
    entries.push({ ...s, ...Object.fromEntries(FACTS[s.supplier].map((k) => [k, d[k]])), status: changed ? 'changed' : 'saved' });
  }
  for (const d of detected.values()) entries.push({ ...d, status: 'new' });

  const ids = new Set(entries.map(entryId));
  for (const id of [...edits.drop, ...Object.keys(edits.names)]) {
    if (!ids.has(id)) throw new Error(`costs: no source ${id} (sources are <supplier>:<key>, as the proposal lists them)`);
  }
  const kept = entries.filter((e) => !edits.drop.includes(entryId(e)));
  for (const e of kept) {
    if (edits.names[entryId(e)]) e.name = edits.names[entryId(e)];
    e.repo = repoOf[e.name] ?? null;
  }
  for (const [profile, c] of Object.entries(edits.credits)) {
    const e = kept.find((x) => x.supplier === 'aws' && x.key === profile);
    if (!e) throw new Error(`costs: no AWS profile ${profile} in the proposal`);
    e.credit = { ...c, entered: today };
  }
  const budget = { actionsUsd: edits.budget !== undefined ? edits.budget : saved?.budget?.actionsUsd ?? null };
  const logins = { github: 'gh', vercel: tilde(found.vercel?.auth ?? vercelAuthPath()), aws: tilde(found.aws?.path ?? awsConfigPath()) };
  return { entries: kept, budget, logins };
}

// ---- the file --------------------------------------------------------------------------------
const cell = (v) => `\`${String(v ?? 'none').replace(/\|/g, '\\|')}\``;
const unquote = (s) => String(s ?? '').trim().replace(/^`(.*)`$/, '$1').trim();
const none = (s) => (s === 'none' || s === '' ? null : s);
const byName = (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key);

// Vercel entries grouped one row per name per team, and which teams bill more than one name.
function vercelRows(entries) {
  const rows = new Map();
  const namesOf = new Map();
  for (const e of entries.filter((x) => x.supplier === 'vercel').sort(byName)) {
    const k = `${e.name}\u0000${e.teamId}`;
    if (!rows.has(k)) rows.set(k, { ...e, projects: [] });
    if (e.project) rows.get(k).projects.push(e.project);
    namesOf.set(e.teamId, (namesOf.get(e.teamId) ?? new Set()).add(e.name));
  }
  return [...rows.values()].map((r) => ({ ...r, shared: namesOf.get(r.teamId).size > 1 }));
}

export function renderCosts({ entries, budget, logins }) {
  const of = (s) => entries.filter((e) => e.supplier === s).sort(byName);
  const yn = (v) => (v == null ? 'unknown' : v ? 'yes' : 'no');
  return [
    '# Cost sources',
    '',
    'Which GitHub repos, Vercel teams and projects and AWS profiles bill each name, for every repo on',
    'this computer. Written by `desk-env costs write` once you confirmed the proposal in',
    '`/desk-setup costs`; run it again to see what is new. Repo `none` is a name with no repo in desk.',
    'No token is kept here: Logins says where each supplier\'s login lives.',
    '',
    '## GitHub',
    '',
    '| Name | Repo | GitHub repo | Account | Readable |',
    '|---|---|---|---|---|',
    ...of('github').map((e) => `| ${cell(e.name)} | ${cell(e.repo)} | ${cell(e.key)} | ${cell(e.account)} | ${cell(yn(e.readable))} |`),
    '',
    '## Vercel',
    '',
    '| Name | Repo | Team id | Team | Plan | Plan shared | Projects |',
    '|---|---|---|---|---|---|---|',
    ...vercelRows(entries).map((r) => `| ${cell(r.name)} | ${cell(r.repo)} | ${cell(r.teamId)} | ${cell(r.team)} | ${cell(r.plan)} | ${cell(yn(r.shared))} | ${cell(r.projects.join(', ') || 'none')} |`),
    '',
    '## AWS',
    '',
    '| Name | Repo | Profile | Credit (USD) | Credits end | Credit entered |',
    '|---|---|---|---|---|---|',
    ...of('aws').map((e) => `| ${cell(e.name)} | ${cell(e.repo)} | ${cell(e.key)} | ${cell(e.credit?.usd)} | ${cell(e.credit?.ends)} | ${cell(e.credit?.entered)} |`),
    '',
    '## Budget',
    '',
    '| Key | Value |',
    '|---|---|',
    `| \`actions-budget-usd\` | ${cell(budget?.actionsUsd)} |`,
    '',
    '## Logins',
    '',
    '| Supplier | Where |',
    '|---|---|',
    ...SUPPLIERS.map((s) => `| \`${s}\` | ${cell(logins?.[s])} |`),
    '',
  ].join('\n');
}

// -> { exists, entries, budget: { actionsUsd }, logins }; a missing file is no cost sources.
export function parseCosts(text) {
  const out = { exists: true, entries: [], budget: { actionsUsd: null }, logins: {} };
  let section = null;
  let header = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { section = h[1].trim().toLowerCase(); header = false; continue; }
    if (!section || !line.startsWith('|')) { header = false; continue; }
    const c = splitRow(line).map(unquote);
    if (c.every((x) => /^:?-{2,}:?$/.test(x) || x === '')) continue;
    if (!header) { header = true; continue; }
    const [name, repo] = [c[0], none(c[1])];
    if (section === 'github') {
      out.entries.push({ supplier: 'github', key: c[2], name, repo, account: c[3], readable: c[4] === 'yes' ? true : c[4] === 'no' ? false : null });
    } else if (section === 'vercel') {
      const team = { name, repo, teamId: c[2], team: c[3], plan: c[4] };
      const projects = none(c[6])?.split(',').map((p) => p.trim()).filter(Boolean) ?? [];
      if (!projects.length) out.entries.push({ supplier: 'vercel', key: c[3], ...team, project: null });
      for (const p of projects) out.entries.push({ supplier: 'vercel', key: `${c[3]}/${p}`, ...team, project: p });
    } else if (section === 'aws') {
      const usd = none(c[3]);
      out.entries.push({ supplier: 'aws', key: c[2], name, repo,
        credit: usd == null ? null : { usd: Number(usd), ends: none(c[4]), entered: none(c[5]) } });
    } else if (section === 'budget' && name === 'actions-budget-usd') {
      const v = none(c[1]);
      out.budget.actionsUsd = v == null ? null : Number(v);
    } else if (section === 'logins') {
      out.logins[name] = none(c[1]);
    }
  }
  return out;
}

export const readCosts = (path) => (path && existsSync(path)
  ? parseCosts(readFileSync(path, 'utf8'))
  : { exists: false, entries: [], budget: { actionsUsd: null }, logins: {} });

// Each name's sources as data: { name: { repo, github: [...], vercel: [...], aws: [...] } }.
export function costsByName(costs) {
  const out = {};
  for (const e of costs.entries) {
    const n = (out[e.name] ??= { repo: e.repo, github: [], vercel: [], aws: [] });
    n.repo ??= e.repo;
    if (e.supplier === 'github') n.github.push({ repo: e.key, account: e.account, readable: e.readable });
    if (e.supplier === 'aws') n.aws.push({ profile: e.key, credit: e.credit });
  }
  for (const r of vercelRows(costs.entries)) {
    out[r.name].vercel.push({ teamId: r.teamId, team: r.team, plan: r.plan, shared: r.shared, projects: r.projects });
  }
  return out;
}

// ---- billing pages ---------------------------------------------------------------------------
// Each supplier's page for what it charged this month. Vercel's is the team's; AWS's is Cost
// Explorer, which opens on whichever account the browser is signed in to.
export function billingUrl(supplier, { team } = {}) {
  if (supplier === 'github') return 'https://github.com/settings/billing/usage';
  if (supplier === 'vercel') return team ? `https://vercel.com/${team}/~/usage` : null;
  if (supplier === 'aws') return 'https://console.aws.amazon.com/costmanagement/home#/cost-explorer';
  return null;
}

// ---- what the conversation is shown ----------------------------------------------------------
const detail = (e) => {
  if (e.supplier === 'github') return `account ${e.account}, ${e.readable == null ? 'readable unknown (gh signed out)' : e.readable ? 'readable' : 'not readable: another account'}`;
  if (e.supplier === 'vercel') return `team ${e.team} (${e.teamId}), plan ${e.plan}`;
  return e.credit ? `credit $${e.credit.usd} until ${e.credit.ends}, entered ${e.credit.entered}` : 'no credit entered';
};

export function proposalLines({ entries, budget }) {
  const rows = [...entries].sort((a, b) => a.name.localeCompare(b.name) || SUPPLIERS.indexOf(a.supplier) - SUPPLIERS.indexOf(b.supplier) || a.key.localeCompare(b.key));
  const head = ['NAME', 'REPO', 'SOURCE', 'DETAIL', 'STATUS'];
  const body = rows.map((e) => [e.name, e.repo ?? 'none (no repo in desk)', entryId(e), detail(e), e.status ?? '']);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const fmt = (r) => r.map((c, i) => (i < r.length - 1 ? c.padEnd(w[i]) : c)).join('  ').trimEnd();
  const shared = vercelRows(entries).filter((r) => r.shared).map((r) => r.team);
  return [
    fmt(head), ...body.map(fmt), '',
    ...[...new Set(shared)].map((t) => `vercel team ${t} bills more than one name: its plan is saved as shared`),
    `github actions budget: ${budget.actionsUsd == null ? 'none set' : `$${budget.actionsUsd} a month`}`,
  ];
}
