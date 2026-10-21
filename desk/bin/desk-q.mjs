#!/usr/bin/env node
// desk-q: every autopilot queue on this computer, from the files alone. It reads the repo configs,
// each repo's queue.json, its orchestrator heartbeats and its triage records. Repos are found on
// disk every run, so a newly set-up repo appears with no change here.
//
//   desk-q [--plain] [--all]             one line per batch: live first, then quiet ones that need you
//   desk-q [--plain] <repo>              that repo's unfinished tickets in spawn order
//   desk-q [--plain] <repo> show <KEY>   one ticket in full
//   desk-q <repo> up|down|top|bottom <KEY>   move a ticket in the spawn order (queue.mjs move)
//   desk-q <repo> move <KEY> <n>         put it at position n of the unfinished tickets
//   desk-q <repo> workers <n>            the batch's worker count (queue.mjs set-batch), up to the cap
//
// A repo is named by its short name or any unique prefix of it. In a terminal, without --plain,
// the same views open full-screen, with arrow keys, Enter and Esc; piped output gets the plain text.
// The only writes are the move and workers commands, each a queue.mjs command against the queue of
// the repo named.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HOME, deskHome, deskConfigRoot, repoPortClaims, portClashes, repoConfigValue, concurrencyLimits, machineWhy, availableGiB, spawnGate } from './desk-env.mjs';
import { isHeld, waitingOnMerge, readJsonOrRefuse, describeCrash, batchConcurrency } from './batch-state.mjs';
import { RULES } from './machine.mjs';
import { LIVE_MS, lastPass, machineCap } from './borrow.mjs';

export { LIVE_MS };
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
    const limits = concurrencyLimits(repoConfigValue(c.slug, 'concurrency'));
    const r = { name, slug: c.slug, claim: c, stateDir, queuePath, cap: limits.cap, q: null, error: null };
    if (existsSync(queuePath)) {
      try { r.q = readJsonOrRefuse(queuePath, 'restore it, or start a new batch there'); } catch (e) { r.error = describeCrash(e); }
    }
    r.last = lastPass(stateDir, queuePath);
    r.live = r.last != null && now - r.last < LIVE_MS;
    const rows = Object.values(r.q?.tickets ?? {});
    // A row's place is queue.mjs's: its position among the unfinished tickets, where a failed one
    // keeps its slot and has no place.
    let place = 0;
    r.rows = rows.filter((t) => t.state !== 'done').map((t) => ({ t, k: shownState(r.q, t), pos: t.state === 'failed' ? null : ++place }));
    r.places = place;
    r.done = rows.length - r.rows.length;
    r.workers = r.q ? batchConcurrency(r.q, limits).n : null;
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

// The memory one worker takes at its heaviest: the profile writes it into the cap's reason
// (machine.mjs propose), else the rule the profile is sized by.
function workerGB() {
  const m = /(\d+(?:\.\d+)?) GB per worker/.exec(machineWhy('autopilot-concurrency') ?? '');
  return m ? Number(m[1]) : RULES.workerHeavyGB;
}

// Each pass gates on its own repo's §3b "Spawn gate", so the machine's is the highest of them.
const gateGiB = (repos) => Math.max(...repos.map((r) => spawnGate(repoConfigValue(r.slug, 'spawn-gate')).start), spawnGate(null).start);

const allowedBy = (r) => Math.min(r.workers, r.cap);
const liveAllowed = (repos) => repos.filter((r) => r.live && r.q).reduce((a, r) => a + allowedBy(r), 0);

// How many more workers this machine could start: the smaller of the machine cap less the running
// workers, and the free memory above the spawn gate at `perWorker` GB each.
export function headroom({ running, cap, avail, gate, perWorker }) {
  const byMemory = Math.max(0, Math.floor((avail - gate) / perWorker));
  return cap == null ? byMemory : Math.max(0, Math.min(cap - running, byMemory));
}

// Ready tickets beyond the batch's free slots: they start only as its running workers finish.
const unslotted = (r) => count(r, 'ready') - Math.max(0, r.workers - count(r, 'running'));

// Each screen is built as head lines, selectable rows and foot lines. The plain output joins them;
// the interactive screen draws the rows with a selection and opens a row's `open` view on Enter.
const joined = (s) => [...s.head, ...s.rows.map((x) => x.line), ...s.foot].join('\n');

function overviewParts(repos, { all = false, now = Date.now(), avail = availableGiB(), cap = machineCap(), gate = gateGiB(repos), perWorker = workerGB(), interactive = false } = {}) {
  const list = shownRepos(repos, all);
  const running = repos.reduce((a, r) => a + count(r, 'running'), 0);
  const allowed = liveAllowed(repos);
  const room = headroom({ running, cap, avail, gate, perWorker });
  const at = new Date(now).toTimeString().slice(0, 5);
  const w = Math.max(14, ...repos.map((r) => r.name.length + 2));
  const head = [
    `desk-q · ${at} · workers ${running} running · ${allowed} allowed by live batches · machine ${cap ?? '?'} · ${avail.toFixed(1)} GiB free · room for ${room}${cap == null ? ' (no machine profile: /desk-setup writes one)' : ''}`,
    '',
    `  ${pad('REPO', w)}${pad('LAST PASS', 15)}${rpad('RUN', 4)}${rpad('READY', 7)}${rpad('WAIT', 6)}${rpad('STUCK', 7)}${rpad('NEEDS YOU', 11)}${rpad('FAILED', 8)}${rpad('DONE', 6)}  WORKERS`,
  ];
  const rows = [], foot = [];
  const row = (r, line) => rows.push({ id: r.slug, line, open: { kind: 'repo', slug: r.slug } });
  let you = 0, stuck = 0;
  for (const r of list) {
    if (r.error) { row(r, `  ${pad(r.name, w)}queue unreadable: ${r.error}`); continue; }
    you += count(r, 'needs'); stuck += count(r, 'stuck');
    const last = r.live ? `live ${ago(now - r.last).replace(' ago', '')}` : ago(r.last == null ? null : now - r.last);
    row(r, `  ${pad(r.name, w)}${pad(last, 15)}${rpad(count(r, 'running'), 4)}${rpad(count(r, ['ready', 'queued']), 7)}${rpad(count(r, 'waiting'), 6)}${rpad(count(r, 'stuck'), 7)}${rpad(count(r, 'needs'), 11)}${rpad(count(r, 'failed'), 8)}${rpad(r.done, 6)}  ${r.workers} (cap ${r.cap})${unslotted(r) > 0 ? ` · ${unslotted(r)} ready with no free slot` : ''}`);
  }
  const none = repos.filter((r) => !hasBatch(r));
  if (all) for (const r of none) row(r, `  ${pad(r.name, w)}${pad('no batch', 64)}  cap ${r.cap}`);
  if (!list.length && !(all && none.length)) foot.push('  No batch is live, and no quiet batch needs you.');
  foot.push('', `${you} need you, ${stuck} stuck.`);
  if (!all && none.length) foot.push(`${none.length} more set up with no batch: ${none.map((r) => r.name).join(', ')}. ${interactive ? 'Press a to list them.' : 'desk-q --all lists them.'}`);
  const seen = new Set();
  for (const r of repos) {
    for (const c of portClashes(r.claim, repos.map((x) => x.claim))) {
      const o = repos.find((x) => x.slug === c.slug);
      const pair = [r.name, o.name].sort();
      if (seen.has(pair.join())) continue;
      seen.add(pair.join());
      foot.push(`ports overlap: ${pair.join(' + ')} share ${Math.max(r.claim.port, c.port)}–${Math.min(r.claim.last, c.last)}. Two batches there at once can get the same worker port.`);
    }
  }
  return { head, rows, foot };
}

export const overview = (repos, opts) => joined(overviewParts(repos, opts));

function detail(r, x) {
  const { t, k } = x;
  if (k === 'running') return `stage ${t.stage ?? '?'}`;
  if (k === 'waiting' || k === 'stuck') return `behind ${unmergedBlockers(r.q, t).join(', ') || 'PRs of done tickets'}`;
  if (k === 'needs') return t.state === 'parked' ? (t.park?.question ?? 'parked') : `${t.open_questions} triage question(s) open`;
  if (k === 'failed') return t.park?.question ?? '';
  if (k === 'queued') return 'waiting for triage';
  return '';
}

// The columns before TITLE on a ticket row.
const ROW_LEAD = 63;

// `width` is the terminal's: titles take what the row has left, rather than a fixed 60.
function repoParts(r, { now = Date.now(), width = null } = {}) {
  const none = { rows: [], foot: [] };
  if (r.error) return { head: [`${r.name} · queue unreadable: ${r.error}`], ...none };
  if (!r.q) return { head: [`${r.name} · set up, no autopilot batch yet · cap ${r.cap} · ports ${r.claim.port}–${r.claim.last}`, '', 'Nothing to show until a batch starts. Run /desk-autopilot in that repo to start one.'], ...none };
  const pass = r.live ? `orchestrator live, last pass ${ago(now - r.last)}` : r.last == null ? 'no pass yet' : `no pass for ${ago(now - r.last).replace(' ago', '')}`;
  const head = [
    `${r.name} · batch ${r.q.batch ?? '-'} · ${pass}`,
    `workers ${count(r, 'running')} running of ${r.workers} (cap ${r.cap}) · ${r.done} done, not shown`,
    '',
    `  ${rpad('#', 4)}  ${pad('TICKET', 10)}${pad('STATE', 11)}${pad('DETAIL', 34)}TITLE`,
  ];
  const tw = width == null ? 60 : Math.max(1, width - ROW_LEAD);
  const rows = r.rows.map((x) => {
    const title = triageOf(r.stateDir, x.t.key)?.summary ?? '';
    const line = `  ${rpad(x.pos == null ? '-' : `${x.t.placed ? '*' : ''}${x.pos}`, 4)}  ${pad(x.t.key, 10)}${pad(LABEL[x.k], 11)}${pad(cut(detail(r, x), 32), 34)}${cut(title, tw)}`.trimEnd();
    return { id: x.t.key, line, open: { kind: 'ticket', slug: r.slug, key: x.t.key } };
  });
  const foot = !r.rows.length ? ['  No unfinished tickets.']
    : r.rows.some((x) => x.t.placed) ? ['', '* placed by you: a release or requeue leaves it where it is'] : [];
  return { head, rows, foot };
}

export const repoScreen = (r, opts) => joined(repoParts(r, opts));

const logPath =(r, key) => join(r.stateDir, 'logs', `${key}.log`);

// `jiraUrl` adds the Jira line the interactive screen opens with o.
function ticketParts(r, key, { width = null, jiraUrl = null } = {}) {
  const t = r.q.tickets[key];
  const k = shownState(r.q, t);
  const tr = triageOf(r.stateDir, key) ?? {};
  const pos = r.rows.find((x) => x.t.key === key)?.pos;
  const lane = t.lane && t.lane !== '?' ? t.lane : tr.lane ?? '?';
  const ww = width == null ? 96 : Math.max(20, Math.min(96, width - 2));
  const head = [
    `${key}  ${LABEL[k]}  ${[t.type ?? tr.type, `size ${tr.size ?? '?'}`, `lane ${lane}`, pos != null ? `position ${pos} of ${r.places}${t.placed ? ' (placed by you)' : ''}` : null].filter(Boolean).join(' · ')}`,
    '',
    ...(tr.summary ? wrap(tr.summary, ww) : ['(no triage record: title unknown)']),
    '',
  ];
  const rows = [], out = [];
  if (k === 'running') head.push(`A worker is on it, at stage ${t.stage ?? '?'}.`, '');
  if (k === 'waiting' || k === 'stuck') {
    const open = unmergedBlockers(r.q, t);
    head.push(!open.length ? 'Every blocker is done: it starts once the merge driver sees their PRs merged.'
      : k === 'waiting' ? 'Starts when the last of these merges:' : 'Stuck. At least one of these will never merge by itself:');
    for (const b of open) {
      const bt = r.q.tickets[b];
      const line = `  ${pad(b, 10)}${bt ? `${pad(LABEL[shownState(r.q, bt)], 11)}${cut(triageOf(r.stateDir, b)?.summary ?? '', 70)}` : 'not in this queue'}`.trimEnd();
      rows.push({ id: b, line, open: bt ? { kind: 'ticket', slug: r.slug, key: b } : null });
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
  if (tr.lane_reason) { out.push(`Why lane ${lane}:`); for (const l of wrap(tr.lane_reason, ww)) out.push(`  ${l}`); out.push(''); }
  const files = tr.files_in_scope ?? [];
  if (files.length) { out.push(`Files in scope (${files.length}):`); for (const f of files) out.push(`  ${f}`); out.push(''); }
  if (t.collides_with) out.push(`Never runs at the same time as: ${String(t.collides_with).split('|').join(', ')}`);
  const branch = t.branch ?? tr.branch;
  if (branch) out.push(`Branch: ${branch}`);
  out.push(`Log: ${logPath(r, key)}${width == null ? '' : '  (l shows the last 40 lines)'}`);
  if (jiraUrl) out.push(`Jira: ${jiraUrl}  (o opens it)`);
  return { head, rows, foot: out };
}

export const ticketScreen = (r, key, opts) => joined(ticketParts(r, key, opts));

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

const MOVES = ['up', 'down', 'top', 'bottom', 'move'];
const VERBS = ['show', ...MOVES, 'workers'];
const isWrite = (v) => v.kind === 'move' || v.kind === 'workers';

// What the words name: a view, or a move or workers change. The one-shot command line and the
// screen's ":" prompt read the same words.
function target(repos, words) {
  const [repoWord, verb, keyWord, ...extra] = words.filter((a) => !a.startsWith('--'));
  if (!repoWord) return { kind: 'overview', all: words.includes('--all') };
  const r = resolveRepo(repos, repoWord);
  if (!verb) return { kind: 'repo', slug: r.slug };
  const unknown = () => new Usage(`Unknown command "${[verb, keyWord, ...extra].filter(Boolean).join(' ')}". Verbs: ${VERBS.join(', ')}.`);
  if (!VERBS.includes(verb)) throw unknown();
  if (r.error) throw new Usage(`${r.name}: queue unreadable: ${r.error}`);
  if (!r.q) throw new Usage(`${r.name} has no batch yet.`);
  if (verb === 'workers') {
    if (keyWord == null) throw new Usage(`How many? desk-q ${r.name} workers <n>.`);
    if (extra.length) throw unknown();
    return { kind: 'workers', slug: r.slug, n: keyWord };
  }
  if (!keyWord) throw new Usage(`Which ticket? desk-q ${r.name} ${verb} <KEY>${verb === 'move' ? ' <n>' : ''}.`);
  const key = [keyWord, keyWord.toUpperCase()].find((k) => r.q.tickets?.[k]);
  if (!key) throw new Usage(`${keyWord} isn't in ${r.name}'s queue.`);
  if (verb === 'move') {
    if (extra.length !== 1) throw new Usage(`Which position? desk-q ${r.name} move ${key} <n>.`);
    return { kind: 'move', slug: r.slug, key, verb, to: extra[0] };
  }
  if (extra.length) throw unknown();
  return verb === 'show' ? { kind: 'ticket', slug: r.slug, key } : { kind: 'move', slug: r.slug, key, verb };
}

// ---- changes -----------------------------------------------------------------------------------

const QUEUE_MJS = join(dirname(fileURLToPath(import.meta.url)), 'queue.mjs');

// Every change is a queue.mjs command, which takes the queue's lock. Its queue and state directory
// are the named repo's, passed explicitly: left to itself, queue.mjs picks the repo it is run in.
function queueCmd(r, args) {
  try {
    execFileSync(process.execPath, [QUEUE_MJS, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DESK_QUEUE: r.queuePath, DESK_AUTOPILOT_STATE: r.stateDir } });
  } catch (e) {
    throw new Usage(String(e.stderr ?? '').trim().replace(/^queue: /, '') || describeCrash(e));
  }
}

// Positions are queue.mjs's (loadRepos), so a place here is the place passed on.
function moveTicket(r, key, verb, to) {
  const x = r.rows.find((y) => y.t.key === key);
  if (!x) throw new Usage(`${key} is done: only unfinished tickets have a place in the spawn order.`);
  const i = x.pos, last = r.places;
  if (x.k === 'running') throw new Usage(`${key} is running, so its position no longer matters. Nothing moved.`);
  if (x.k === 'failed') throw new Usage(`${key} failed, so it has no place in the spawn order until it is requeued. Nothing moved.`);
  let n;
  if (verb === 'move') {
    if (!/^\d+$/.test(to) || Number(to) < 1 || Number(to) > last) throw new Usage(`Position ${to} is out of range: give 1 to ${last}. Nothing moved.`);
    n = Number(to);
  } else n = { up: i - 1, down: i + 1, top: 1, bottom: last }[verb];
  if (n < 1 || n > last || n === i) throw new Usage(`${key} is already at position ${i}. Nothing moved.`);
  queueCmd(r, ['move', key, String(n)]);
  const why = x.k === 'waiting' ? ` It still waits on ${unmergedBlockers(r.q, x.t).join(', ') || 'its blockers'}, then starts from here.`
    : x.k === 'stuck' ? ` Still stuck behind ${unmergedBlockers(r.q, x.t).join(', ')}: moving it does not unblock it.`
      : x.k === 'needs' ? ' It still needs you first.' : x.k === 'queued' ? ' It still waits for triage.' : '';
  return `${key} → position ${n} of ${last}, placed by you.${why}`;
}

// Above the repo's cap is refused, with what raising the cap would take; above the machine's total
// goes ahead with a warning, since the memory gate still holds back spawns.
function setWorkers(repos, r, word) {
  const n = /^\d+$/.test(word) ? Number(word) : NaN;
  if (!Number.isInteger(n)) throw new Usage(`Workers must be a whole number from 0 to ${r.cap}. Nothing changed.`);
  const total = liveAllowed(repos.filter((x) => x.slug !== r.slug)) + n;
  const cap = machineCap();
  if (n > r.cap) {
    const block = { slug: r.slug, port: r.claim.port, last: r.claim.port + n };
    const clash = portClashes(block, repos.map((x) => x.claim)).map((c) => `${repos.find((x) => x.slug === c.slug).name} (${c.port}–${c.last})`);
    throw new Usage(`${r.name}'s cap is ${r.cap}, so ${n} workers is refused: nothing changed. `
      + `A cap of ${n} is an edit to §3b "Autopilot worker concurrency" in ${join(deskConfigRoot(), 'repos', r.slug, 'config.md')}. `
      + `It would hold ports ${block.port} to ${block.last}, ${clash.length ? `overlapping ${clash.join(' and ')}` : 'clear of every other repo'}, `
      + `and live batches would then allow ${total} against this machine's ${cap ?? '? (no machine profile)'}.`);
  }
  const was = r.workers;
  queueCmd(r, ['set-batch', `concurrency=${n}`, 'concurrency_by=user']);
  return `${r.name}: workers ${was} → ${n} (cap ${r.cap}), set by you. The next pass uses it.`
    + (n === 0 ? ' No new workers start, and running ones finish.' : '')
    + (cap != null && total > cap ? ` Live batches now allow ${total}, over this machine's ${cap}: allowed, and the memory gate holds new workers below ${gateGiB(repos)} GiB free.` : '');
}

// One confirmation line, or a Usage refusal that says what to do instead.
function apply(repos, v) {
  const r = repos.find((x) => x.slug === v.slug);
  return v.kind === 'workers' ? setWorkers(repos, r, v.n) : moveTicket(r, v.key, v.verb, v.to);
}

function checkFlags(argv) {
  const unknown = argv.filter((a) => a.startsWith('--') && !['--plain', '--all', '--help'].includes(a));
  if (unknown.length) throw new Usage(`Unknown option ${unknown.join(' ')}. Options: --plain, --all.`);
}

function loadOrRefuse(now) {
  const repos = loadRepos(now);
  if (!repos.length) throw new Usage('No repo is set up for desk on this machine. Run /desk-setup in a repo first.');
  return repos;
}

export function run(argv, { now = Date.now() } = {}) {
  if (argv.includes('--help')) return 'usage: desk-q [--plain] [--all] | desk-q [--plain] <repo> [show <KEY>]\n'
    + '       desk-q <repo> up|down|top|bottom <KEY> | desk-q <repo> move <KEY> <n> | desk-q <repo> workers <n>';
  checkFlags(argv);
  const repos = loadOrRefuse(now);
  const v = target(repos, argv);
  if (v.kind === 'overview') return overview(repos, { all: v.all, now });
  if (isWrite(v)) {
    const said = apply(repos, v);
    return `${said}\n\n${repoScreen(loadOrRefuse(now).find((x) => x.slug === v.slug), { now })}`;
  }
  const r = repos.find((x) => x.slug === v.slug);
  return v.kind === 'repo' ? repoScreen(r, { now }) : ticketScreen(r, v.key);
}

// ---- the interactive screen --------------------------------------------------------------------

export const REFRESH_MS = 2000;
const LOG_LINES = 40;
const MOVE_KEYS = 'shift+↑↓ move · t top · b bottom · + − workers';
const ESC = '\x1b[';
const ENTER_SCREEN = `${ESC}?1049h${ESC}?25l`;
export const LEAVE_SCREEN = `${ESC}?25h${ESC}?1049l`;

function jiraUrlFor(slug, key) {
  const site = repoConfigValue(slug, 'jira-site');
  if (!site || /^none$/i.test(site)) return null;
  return `https://${site.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/browse/${key}`;
}

function systemOpener(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  const p = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
  p.on('error', () => {});
  p.unref();
}

// Log text can carry a worker's own escape codes; only printable text reaches the screen.
const printable = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\t/g, '  ').replace(/[\x00-\x1f\x7f]/g, '');

// The full-screen view: ↑↓ select, Enter opens, Esc goes back, : takes a command, q quits.
// Rereads the queues every REFRESH_MS, keeping the selection on the same repo or ticket.
export function interactive({
  input = process.stdin, output = process.stdout, start = { kind: 'overview', all: false },
  opener = systemOpener, exit = (c) => process.exit(c), refreshMs = REFRESH_MS,
} = {}) {
  let repos = loadOrRefuse(Date.now());
  // On a screen too tall to fit, `scroll` is its first line shown when it has no rows to select,
  // and how far past the selection it shows when it has.
  let view = start, sel = 0, selId = null, scroll = null, msg = '', cmd = null, screen = null, done = false, timer = null;
  const stack = [];
  const width = () => Math.max(20, output.columns || 80);
  const height = () => Math.max(5, output.rows || 24);
  const repoOf = (slug) => repos.find((r) => r.slug === slug);

  function build() {
    const now = Date.now();
    const w = width();
    if (view.kind === 'overview') {
      return { crumbs: 'desk-q', ...overviewParts(repos, { all: view.all, now, interactive: true }),
        keys: `↑↓ select · enter open · a ${view.all ? 'hide repos with no batch' : 'all repos'} · : command · q quit` };
    }
    const r = repoOf(view.slug);
    const back = ': command · esc back · q quit';
    if (!r) return { crumbs: 'desk-q', head: ['That repo is no longer set up here.'], rows: [], foot: [], keys: back };
    const crumbs = ['desk-q', r.name, view.key].filter(Boolean).join(' › ');
    if (view.kind === 'repo') return { crumbs, ...repoParts(r, { now, width: w }), keys: `↑↓ select · enter open · ${r.q ? `${MOVE_KEYS} · ` : ''}${back}` };
    if (!r.q?.tickets?.[view.key]) return { crumbs, head: [`${view.key} is no longer in ${r.name}'s queue.`], rows: [], foot: [], keys: back };
    if (view.kind === 'log') {
      const p = logPath(r, view.key);
      const lines = readFileSync(p, 'utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      const last = lines.slice(-LOG_LINES).map(printable);
      return { crumbs: `${crumbs} › log`, head: [`Last ${last.length} lines of ${p}`, ''], rows: [], foot: last, keys: '↑↓ scroll · esc back · q quit', bottom: true };
    }
    const jira = jiraUrlFor(r.slug, view.key);
    const s = ticketParts(r, view.key, { width: w, jiraUrl: jira });
    const keys = `${s.rows.length ? '↑↓ select a blocker · enter open it · ' : ''}${MOVE_KEYS} · l log · ${jira ? 'o Jira · ' : ''}${back}`;
    return { crumbs, ...s, keys };
  }

  function draw() {
    if (done) return;
    try { screen = build(); } catch (e) { screen = { crumbs: 'desk-q', head: [`Could not draw this screen: ${describeCrash(e)}`], rows: [], foot: [], keys: 'esc back · q quit' }; }
    const { rows } = screen;
    if (selId != null) { const i = rows.findIndex((x) => x.id === selId); if (i >= 0) sel = i; }
    sel = Math.max(0, Math.min(sel, rows.length - 1));
    selId = rows[sel]?.id ?? null;
    const w = width(), h = height();
    const fit = (l) => cut(l, w);
    const body = [screen.crumbs, '', ...screen.head.map(fit),
      ...rows.map((x, i) => (i === sel ? `${ESC}7m${fit(`›${x.line.slice(1)}`)}${ESC}27m` : fit(x.line))), ...screen.foot.map(fit)];
    // A message can be longer than the line (a refused raise says what raising the cap takes).
    const status = [...wrap(msg, w), cmd != null ? `:${cmd}` : screen.keys].filter(Boolean).map(fit);
    const room = h - status.length;
    let top = 0;
    if (body.length > room) {
      const max = body.length - room;
      const clamp = (n) => Math.max(0, Math.min(max, n));
      if (rows.length) {
        // Centred on the selection; `scroll` is how far ↓ on the last row has read on past it.
        const base = clamp(2 + screen.head.length + sel - Math.floor(room / 2));
        top = clamp(base + (scroll ?? 0));
        scroll = top - base;
      } else top = scroll = clamp(scroll ?? (screen.bottom ? max : 0));
    } else if (rows.length) scroll = 0;
    const shown = body.slice(top, top + room);
    while (shown.length < room) shown.push('');
    output.write(`${ESC}H${[...shown, ...status].map((l) => `${l}${ESC}K`).join('\r\n')}${ESC}J`);
  }

  function go(v) { stack.push({ view, sel, selId }); view = v; sel = 0; selId = null; scroll = null; msg = ''; }
  function back() { const p = stack.pop(); if (p) ({ view, sel, selId } = p); scroll = null; msg = ''; }

  function finish(code) {
    if (done) return;
    done = true;
    clearInterval(timer);
    input.removeListener('keypress', onKey);
    output.removeListener?.('resize', draw);
    if (input.isTTY) input.setRawMode(false);
    input.pause?.();
    output.write(LEAVE_SCREEN);
    exit(code);
  }

  // A change, then the queues reread so the screen shows it; the message stays until the next view.
  function act(v) {
    try { msg = apply(repos, v); } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); }
    try { repos = loadOrRefuse(Date.now()); } catch (e) { msg = `${msg} Could not reread the queues: ${describeCrash(e)}`; }
  }

  function runCommand(line) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    try {
      checkFlags(words);
      const v = target(repos, words);
      if (isWrite(v)) {
        // A change typed anywhere lands on that repo's queue, with the moved ticket selected.
        if (!(view.kind === 'repo' && view.slug === v.slug)) go({ kind: 'repo', slug: v.slug });
        if (v.key) selId = v.key;
        act(v);
      } else if (v.kind === 'overview' && view.kind === 'overview') { view = { ...view, all: v.all }; msg = ''; } else go(v);
    } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); }
  }

  function onKey(str, key = {}) {
    if (done) return;
    if (key.ctrl && key.name === 'c') return finish(130);
    const rows = screen?.rows ?? [];
    if (cmd != null) {
      if (key.name === 'return' || key.name === 'enter') { const line = cmd; cmd = null; runCommand(line); }
      else if (key.name === 'escape') cmd = null;
      else if (key.name === 'backspace') cmd = cmd.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') cmd += str;
      return draw();
    }
    // On a repo's queue the selected ticket moves; on a ticket's screen, that ticket.
    const queueView = view.kind === 'repo' || view.kind === 'ticket';
    const moveVerb = key.shift && key.name === 'up' ? 'up' : key.shift && key.name === 'down' ? 'down' : str === 't' ? 'top' : str === 'b' ? 'bottom' : null;
    if (queueView && moveVerb) {
      const k = view.kind === 'ticket' ? view.key : rows[sel]?.id;
      if (k && repoOf(view.slug)?.q) act({ kind: 'move', slug: view.slug, key: k, verb: moveVerb });
    } else if (queueView && (str === '+' || str === '-')) {
      const r = repoOf(view.slug);
      if (r?.q) act({ kind: 'workers', slug: r.slug, n: String(r.workers + (str === '+' ? 1 : -1)) });
      else msg = `${r?.name ?? view.slug} has no batch yet.`;
    } else if ((key.name === 'up' || key.name === 'down') && !rows.length) scroll = (scroll ?? 0) + (key.name === 'up' ? -1 : 1);
    else if (key.name === 'up' && scroll > 0) scroll -= 1;
    else if (key.name === 'down' && sel === rows.length - 1) scroll = (scroll ?? 0) + 1;
    else if (key.name === 'up') { sel = Math.max(0, sel - 1); selId = rows[sel]?.id ?? null; }
    else if (key.name === 'down') { sel = Math.min(rows.length - 1, sel + 1); selId = rows[sel]?.id ?? null; }
    else if (key.name === 'return' || key.name === 'enter') { const o = rows[sel]?.open; if (o) go(o); }
    else if (key.name === 'escape') back();
    else if (str === 'q') return finish(0);
    else if (str === ':') { cmd = ''; msg = ''; }
    else if (str === 'a' && view.kind === 'overview') view = { ...view, all: !view.all };
    else if (str === 'l' && view.kind === 'ticket') {
      const r = repoOf(view.slug);
      if (r && existsSync(logPath(r, view.key))) go({ kind: 'log', slug: view.slug, key: view.key });
      else msg = `${view.key} has no log yet.`;
    } else if (str === 'o' && view.kind === 'ticket') {
      const url = jiraUrlFor(view.slug, view.key);
      if (!url) msg = `No Jira site in ${repoOf(view.slug)?.name ?? view.slug}'s config, so there is nothing to open.`;
      else { try { opener(url); msg = `Opened ${url}`; } catch (e) { msg = `Could not open ${url}: ${describeCrash(e)}`; } }
    } else return;
    draw();
  }

  emitKeypressEvents(input);
  if (input.isTTY) input.setRawMode(true);
  input.on('keypress', onKey);
  input.resume?.();
  output.on?.('resize', draw);
  output.write(ENTER_SCREEN);
  timer = setInterval(() => {
    try { repos = loadOrRefuse(Date.now()); } catch (e) { msg = `Could not reread the queues: ${describeCrash(e)}`; }
    draw();
  }, refreshMs);
  draw();
  return { finish };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  try {
    // A terminal on both ends gets the screen; anything piped, --plain, and a change typed in the
    // shell get the plain output.
    let start = null;
    if (process.stdin.isTTY && process.stdout.isTTY && !argv.includes('--plain') && !argv.includes('--help')) {
      checkFlags(argv);
      start = target(loadOrRefuse(Date.now()), argv);
    }
    if (start && !isWrite(start)) {
      const ui = interactive({ start });
      process.on('SIGTERM', () => ui.finish(143));
      process.on('SIGHUP', () => ui.finish(129));
    } else console.log(run(argv));
  } catch (e) { console.error(e instanceof Usage ? e.message : describeCrash(e)); process.exit(1); }
}
