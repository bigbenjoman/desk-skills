#!/usr/bin/env node
// desk-q: every autopilot queue on this computer, from the files alone. Reads only: the repo
// configs, each repo's queue.json, its orchestrator heartbeats and its triage records. Repos are
// found on disk every run, so a newly set-up repo appears with no change here.
//
//   desk-q [--plain] [--all]             one line per batch: live first, then quiet ones that need you
//   desk-q [--plain] <repo>              that repo's unfinished tickets in spawn order
//   desk-q [--plain] <repo> show <KEY>   one ticket in full
//
// A repo is named by its short name or any unique prefix of it.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, deskHome, repoPortClaims, portClashes, repoConfigValue, concurrencyLimits, machineValue, availableGiB } from './desk-env.mjs';
import { isHeld, waitingOnMerge, readJsonOrRefuse, describeCrash } from './batch-state.mjs';

// The same test queue.mjs init uses: a heartbeat fresher than this is a live batch.
export const LIVE_MS = 15 * 60 * 1000;
const LABEL = { running: 'running', ready: 'ready', queued: 'queued', waiting: 'waiting', stuck: 'stuck', needs: 'needs you', failed: 'failed', done: 'done' };

const pad = (s, n) => { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); };
const rpad = (s, n) => { s = String(s ?? ''); return ' '.repeat(Math.max(0, n - s.length)) + s; };
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const ago = (ms) => {
  if (ms == null) return 'never';
  const m = Math.floor(ms / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};
function wrap(s, w) {
  const out = []; let line = '';
  for (const word of String(s ?? '').split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > w) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// ---- reading ---------------------------------------------------------------------------------

// The shown state: "parked" splits three ways with waitingOnMerge, the orchestrator's own test. A
// queued ticket has not been triaged yet, so it is not ready either.
export function shownState(q, t) {
  if (['running', 'done', 'failed'].includes(t.state)) return t.state;
  if (isHeld(t)) return waitingOnMerge(q, t) ? 'waiting' : 'stuck';
  if (t.state === 'parked' || (t.open_questions ?? 0) > 0) return 'needs';
  return t.state === 'queued' ? 'queued' : 'ready';
}

// A hold's blockers less those done with a PR. The queue does not record merges and nothing here
// calls GitHub, so a done one with a PR is merged or about to be, and is left out.
export const unmergedBlockers = (q, t) => String(t.held_by ?? '').split('|').filter(Boolean)
  .filter((p) => { const pt = q.tickets?.[p]; return !(pt?.state === 'done' && pt.result?.pr != null); });

// pass.mjs writes one heartbeat per queue file into the state directory, so only this queue's counts.
function lastPass(stateDir, queuePath) {
  const dir = join(stateDir, 'orchestrators');
  let last = null;
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    try {
      const hb = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const at = Date.parse(hb.at);
      if (hb.queue === queuePath && Number.isFinite(at) && (last == null || at > last)) last = at;
    } catch { /* a torn heartbeat is no heartbeat */ }
  }
  return last;
}

function triageOf(stateDir, key) {
  const p = join(stateDir, 'triage', `${key}.json`);
  if (!existsSync(p)) return null;
  try { return readJsonOrRefuse(p, `re-run triage.sh ${key}`); } catch { return { summary: '(triage record unreadable)' }; }
}

// Every set-up repo, with its batch where it has one. A queue that will not parse is reported on
// its repo rather than stopping the rest.
export function loadRepos(now = Date.now()) {
  const claims = repoPortClaims();
  const short = claims.map((c) => c.slug.split('__').slice(1).join('__') || c.slug);
  return claims.map((c, i) => {
    const name = short.filter((n) => n === short[i]).length > 1 ? c.slug.replace('__', '/') : short[i];
    const stateDir = join(HOME, '.desk-autopilot', c.slug);
    const queuePath = join(deskHome(), 'repos', c.slug, 'queue.json');
    const r = { name, slug: c.slug, claim: c, stateDir, queuePath, cap: concurrencyLimits(repoConfigValue(c.slug, 'concurrency')).cap, q: null, error: null };
    if (existsSync(queuePath)) {
      try { r.q = readJsonOrRefuse(queuePath, 'restore it, or start a new batch there'); } catch (e) { r.error = describeCrash(e); }
    }
    r.last = lastPass(stateDir, queuePath);
    r.live = r.last != null && now - r.last < LIVE_MS;
    const rows = Object.values(r.q?.tickets ?? {});
    r.rows = rows.filter((t) => t.state !== 'done').map((t) => ({ t, k: shownState(r.q, t) }));
    r.done = rows.length - r.rows.length;
    r.workers = r.q ? (Number.isInteger(r.q.concurrency) ? r.q.concurrency : concurrencyLimits(repoConfigValue(c.slug, 'concurrency')).def) : null;
    return r;
  });
}

const count = (r, k) => r.rows.filter((x) => (Array.isArray(k) ? k : [k]).includes(x.k)).length;
const attention = (r) => count(r, ['needs', 'stuck', 'failed']);
const hasBatch = (r) => r.q != null || r.error != null;

// Live batches first, freshest first; then quiet ones with something for the user, most first.
export function shownRepos(repos, all) {
  const b = repos.filter(hasBatch);
  const live = b.filter((r) => r.live).sort((a, c) => c.last - a.last);
  const quiet = b.filter((r) => !r.live && (all || r.error || attention(r) > 0)).sort((a, c) => attention(c) - attention(a));
  return [...live, ...quiet];
}

// ---- screens ---------------------------------------------------------------------------------

function machineCap() {
  const v = machineValue('autopilot-concurrency');
  return v ? concurrencyLimits(v).cap : null;
}

export function overview(repos, { all = false, now = Date.now(), avail = availableGiB(), cap = machineCap() } = {}) {
  const list = shownRepos(repos, all);
  const running = repos.reduce((a, r) => a + count(r, 'running'), 0);
  const allowed = repos.filter((r) => r.live && r.q).reduce((a, r) => a + Math.min(r.workers, r.cap), 0);
  const at = new Date(now).toTimeString().slice(0, 5);
  const w = Math.max(14, ...repos.map((r) => r.name.length + 2));
  const out = [
    `desk-q · ${at} · ${avail.toFixed(1)} GiB free · workers ${running} running · ${allowed} allowed by live batches, of ${cap ?? '?'} for this machine${cap == null ? ' (no machine profile: /desk-setup writes one)' : ''}`,
    '',
    `  ${pad('REPO', w)}${pad('LAST PASS', 15)}${rpad('RUN', 4)}${rpad('READY', 7)}${rpad('WAIT', 6)}${rpad('STUCK', 7)}${rpad('NEEDS YOU', 11)}${rpad('FAILED', 8)}${rpad('DONE', 6)}  WORKERS`,
  ];
  let you = 0, stuck = 0;
  for (const r of list) {
    if (r.error) { out.push(`  ${pad(r.name, w)}queue unreadable: ${r.error}`); continue; }
    you += count(r, 'needs'); stuck += count(r, 'stuck');
    const last = r.live ? `live ${ago(now - r.last).replace(' ago', '')}` : ago(r.last == null ? null : now - r.last);
    out.push(`  ${pad(r.name, w)}${pad(last, 15)}${rpad(count(r, 'running'), 4)}${rpad(count(r, ['ready', 'queued']), 7)}${rpad(count(r, 'waiting'), 6)}${rpad(count(r, 'stuck'), 7)}${rpad(count(r, 'needs'), 11)}${rpad(count(r, 'failed'), 8)}${rpad(r.done, 6)}  ${r.workers} (cap ${r.cap})`);
  }
  const none = repos.filter((r) => !hasBatch(r));
  if (all) for (const r of none) out.push(`  ${pad(r.name, w)}${pad('no batch', 64)}  cap ${r.cap}`);
  if (!list.length && !(all && none.length)) out.push('  No batch is live, and no quiet batch needs you.');
  out.push('', `${you} need you, ${stuck} stuck.`);
  if (!all && none.length) out.push(`${none.length} more set up with no batch: ${none.map((r) => r.name).join(', ')}. desk-q --all lists them.`);
  const seen = new Set();
  for (const r of repos) {
    for (const c of portClashes(r.claim, repos.map((x) => x.claim))) {
      const o = repos.find((x) => x.slug === c.slug);
      const pair = [r.name, o.name].sort();
      if (seen.has(pair.join())) continue;
      seen.add(pair.join());
      out.push(`ports overlap: ${pair.join(' + ')} share ${Math.max(r.claim.port, c.port)}–${Math.min(r.claim.last, c.last)}. Two batches there at once can get the same worker port.`);
    }
  }
  return out.join('\n');
}

function detail(r, x) {
  const { t, k } = x;
  if (k === 'running') return `stage ${t.stage ?? '?'}`;
  if (k === 'waiting' || k === 'stuck') return `behind ${unmergedBlockers(r.q, t).join(', ') || 'PRs of done tickets'}`;
  if (k === 'needs') return t.state === 'parked' ? (t.park?.question ?? 'parked') : `${t.open_questions} triage question(s) open`;
  if (k === 'failed') return t.park?.question ?? '';
  if (k === 'queued') return 'waiting for triage';
  return '';
}

export function repoScreen(r, { now = Date.now() } = {}) {
  if (r.error) return `${r.name} · queue unreadable: ${r.error}`;
  if (!r.q) return `${r.name} · set up, no autopilot batch yet · cap ${r.cap} · ports ${r.claim.port}–${r.claim.last}\n\nNothing to show until a batch starts. Run /desk-autopilot in that repo to start one.`;
  const pass = r.live ? `orchestrator live, last pass ${ago(now - r.last)}` : r.last == null ? 'no pass yet' : `no pass for ${ago(now - r.last).replace(' ago', '')}`;
  const out = [
    `${r.name} · batch ${r.q.batch ?? '-'} · ${pass}`,
    `workers ${count(r, 'running')} running of ${r.workers} (cap ${r.cap}) · ${r.done} done, not shown`,
    '',
    `  ${rpad('#', 4)}  ${pad('TICKET', 10)}${pad('STATE', 11)}${pad('DETAIL', 34)}TITLE`,
  ];
  r.rows.forEach((x, i) => {
    const title = triageOf(r.stateDir, x.t.key)?.summary ?? '';
    out.push(`  ${rpad(i + 1, 4)}  ${pad(x.t.key, 10)}${pad(LABEL[x.k], 11)}${pad(cut(detail(r, x), 32), 34)}${cut(title, 60)}`.trimEnd());
  });
  if (!r.rows.length) out.push('  No unfinished tickets.');
  return out.join('\n');
}

export function ticketScreen(r, key) {
  const t = r.q.tickets[key];
  const k = shownState(r.q, t);
  const tr = triageOf(r.stateDir, key) ?? {};
  const i = r.rows.findIndex((x) => x.t.key === key);
  const lane = t.lane && t.lane !== '?' ? t.lane : tr.lane ?? '?';
  const out = [
    `${key}  ${LABEL[k]}  ${[t.type ?? tr.type, `size ${tr.size ?? '?'}`, `lane ${lane}`, i >= 0 ? `position ${i + 1} of ${r.rows.length}` : null].filter(Boolean).join(' · ')}`,
    '',
    ...(tr.summary ? wrap(tr.summary, 96) : ['(no triage record: title unknown)']),
    '',
  ];
  if (k === 'running') out.push(`A worker is on it, at stage ${t.stage ?? '?'}.`, '');
  if (k === 'waiting' || k === 'stuck') {
    const open = unmergedBlockers(r.q, t);
    out.push(!open.length ? 'Every blocker is done: it starts once the merge driver sees their PRs merged.'
      : k === 'waiting' ? 'Starts when the last of these merges:' : 'Stuck. At least one of these will never merge by itself:');
    for (const b of open) {
      const bt = r.q.tickets[b];
      out.push(`  ${pad(b, 10)}${bt ? `${pad(LABEL[shownState(r.q, bt)], 11)}${cut(triageOf(r.stateDir, b)?.summary ?? '', 70)}` : 'not in this queue'}`.trimEnd());
    }
    out.push('');
  }
  if (t.park?.question) out.push(`Parked: ${t.park.question}`);
  if (k === 'needs') {
    out.push(/^lane [CD]\b/.test(t.park?.question ?? '') ? `Lane C or D: open an interactive /desk-ticket ${key} session.`
      : `Answer, in ${r.name}: node ~/.claude/desk/bin/answer.mjs ${key} "…", then the orchestrator decides whether to requeue it.`);
  }
  if (k === 'stuck') out.push('Unblock the blocker first, or have the orchestrator drop this hold (orchestrator-recovery.md).');
  if (t.park?.question || ['needs', 'stuck'].includes(k)) out.push('');
  if (tr.lane_reason) { out.push(`Why lane ${lane}:`); for (const l of wrap(tr.lane_reason, 96)) out.push(`  ${l}`); out.push(''); }
  const files = tr.files_in_scope ?? [];
  if (files.length) { out.push(`Files in scope (${files.length}):`); for (const f of files) out.push(`  ${f}`); out.push(''); }
  if (t.collides_with) out.push(`Never runs at the same time as: ${String(t.collides_with).split('|').join(', ')}`);
  const branch = t.branch ?? tr.branch;
  if (branch) out.push(`Branch: ${branch}`);
  out.push(`Log: ${join(r.stateDir, 'logs', `${key}.log`)}`);
  return out.join('\n');
}

// ---- the command -------------------------------------------------------------------------------

class Usage extends Error {}

// Exact name first, then a unique prefix of the short name; owner/name and the slug match too.
export function resolveRepo(repos, word) {
  const w = word.toLowerCase();
  const exact = repos.filter((r) => [r.name, r.slug, r.slug.replace('__', '/')].some((n) => n.toLowerCase() === w));
  if (exact.length === 1) return exact[0];
  const hits = repos.filter((r) => r.name.toLowerCase().startsWith(w));
  if (hits.length === 1) return hits[0];
  if (hits.length) throw new Usage(`"${word}" matches ${hits.map((r) => r.name).join(' and ')}. Type more of the name.`);
  throw new Usage(`No repo "${word}". Set up here: ${repos.map((r) => r.name).join(', ')}.`);
}

export function run(argv, { now = Date.now() } = {}) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [repoWord, verb, keyWord, ...extra] = argv.filter((a) => !a.startsWith('--'));
  if (flags.has('--help')) return 'usage: desk-q [--plain] [--all] | desk-q [--plain] <repo> [show <KEY>]';
  const unknown = [...flags].filter((f) => !['--plain', '--all'].includes(f));
  if (unknown.length) throw new Usage(`Unknown option ${unknown.join(' ')}. Options: --plain, --all.`);
  const repos = loadRepos(now);
  if (!repos.length) throw new Usage('No repo is set up for desk on this machine. Run /desk-setup in a repo first.');
  if (!repoWord) return overview(repos, { all: flags.has('--all'), now });
  const r = resolveRepo(repos, repoWord);
  if (!verb) return repoScreen(r, { now });
  if (verb !== 'show' || extra.length) throw new Usage(`Unknown command "${[verb, keyWord, ...extra].filter(Boolean).join(' ')}". This version reads only: desk-q ${r.name} show <KEY>.`);
  if (!keyWord) throw new Usage(`Which ticket? desk-q ${r.name} show <KEY>.`);
  if (r.error) throw new Usage(`${r.name}: queue unreadable: ${r.error}`);
  if (!r.q) throw new Usage(`${r.name} has no batch yet.`);
  const key = [keyWord, keyWord.toUpperCase()].find((k) => r.q.tickets?.[k]);
  if (!key) throw new Usage(`${keyWord} isn't in ${r.name}'s queue.`);
  return ticketScreen(r, key);
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  // The interactive screen is a later change; until then a terminal gets the plain output too.
  try { console.log(run(process.argv.slice(2))); }
  catch (e) { console.error(e instanceof Usage ? e.message : describeCrash(e)); process.exit(1); }
}
