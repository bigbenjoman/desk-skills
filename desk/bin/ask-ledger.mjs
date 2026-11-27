// Each ask desk puts to the person or the decider, step by step, in the ticket ledger. An ask is a
// worker's park handed on (supervisor.mjs decide), and its id is <KEY>:<park.since>, so the same
// question parked again after a requeue is another ask. Its steps are four ticket events, each legal
// from any state and leaving it as it is (ticket-ledger.mjs):
//   ask_raised     { ask, since, kind, blocking, arm }   handed to the person or the decider
//   ask_presented  { ask, via, ref, notification, share } via push, digest, decider or session; a
//                                                         digest's share of its one push (digest.mjs)
//   ask_answered   { ask, by, session, latency_s }       by the person, the decider or a default
//   ask_acted      { ask, round }                        the spawn that resumes the ticket after it
// latency_s is the answer's time less the park's since. Each step is written once: its event id is
// ask:<ask>:<step> (a presentation's names its way too, ask:<ask>:presented:<via>), and an append skips
// a step the ledger already holds, so a retry writes nothing twice. A step for an ask with no `since`
// is no ask's, and is not written; nor is any step in a batch the ledger has never named, which the
// batch's first queue write seeds.
//
// Only with the ledger lever on (queue-ledger.mjs ledgerOn, or another repo's row for a writer that
// works across repos: ledgerOnIn). A write that fails never fails its caller: it comes back as a line
// for the caller's report. The fold keeps each ask on its ticket as t.asks, which readAsks lists.
//
//   node ask-ledger.mjs        every ask this repo's ledger holds, one JSON line each
import { basename, join } from 'node:path';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { append, fold, tokensKey, LOCK_WAIT_MS } from './ticket-ledger.mjs';
import { ledgerOn, ledgerTarget } from './queue-ledger.mjs';
import { parkKind } from './batch-state.mjs';
import { parseLevers, repoConfigValues } from './desk-env.mjs';
import { markersIn, marksStage, readLogFile, saidIn } from './harvest.mjs';
import { logRound, resultTokens, workerLogs } from './worker-cost.mjs';
import { requestOf, requestUsd, transcripts } from './cache-report.mjs';
import { projectsDirs } from './claude-logins.mjs';
import { DECIDER_TIMEOUT_MS } from './decider.mjs';

export const askId = (key, since) => `${key}:${since}`;
// Who answers through answer.mjs when it is neither the person nor the decider's --taken: `default`, set
// by the pass's own take of a recommended option (pass.mjs takeRecommended).
export const ASK_BY_ENV = 'DESK_ASK_BY';
// The ledger lever of the repo an answer.mjs run answers in, `on` or `off`, where its caller knows it
// better than answer.mjs's own config does: digest.mjs answer, for a ticket in another repo.
export const ASK_LEDGER_ENV = 'DESK_ASK_LEDGER';
// The lever as answer.mjs takes it: ASK_LEDGER_ENV where set, else its own config's.
export const answerLedgerOn = (env = process.env) => (['on', 'off'].includes(env[ASK_LEDGER_ENV]) ? env[ASK_LEDGER_ENV] === 'on' : ledgerOn());

// Whether the ledger lever is on in repo `slug`'s config, as ledgerOn reads this repo's: off where it
// cannot be read.
export function ledgerOnIn(slug) {
  try { return parseLevers(repoConfigValues(slug, 'levers')).on.includes('ledger'); } catch { return false; }
}

const ms = (iso) => Date.parse(iso ?? '');
const iso = (t) => (t instanceof Date ? t : new Date(t ?? Date.now())).toISOString();
const text = (v) => (typeof v === 'string' && v !== '' ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// The event for one step, or null for a step of no ask (no key or since).
function eventOf(s, batch, now) {
  const key = text(s.key), since = text(s.since);
  if (!key || !since) return null;
  const ask = askId(key, since);
  const base = { batch, key };
  switch (s.step) {
    case 'raised':
      return { ...base, id: `ask:${ask}:raised`, type: 'ask_raised', at: now,
        data: { ask, since, kind: parkKind({ park: { kind: s.kind, question: s.question } }), blocking: typeof s.blocking === 'boolean' ? s.blocking : null, arm: text(s.arm) } };
    case 'presented':
      return { ...base, id: `ask:${ask}:presented:${s.via}`, type: 'ask_presented', at: now,
        data: { ask, via: s.via, ref: text(s.ref), notification: text(s.notification), share: Number.isFinite(s.share) && s.share >= 0 && s.share <= 1 ? s.share : null } };
    case 'answered': {
      const at = s.at != null ? iso(s.at) : now;
      const late = ms(at) - ms(since);
      return { ...base, id: `ask:${ask}:answered`, type: 'ask_answered', at,
        data: { ask, by: s.by, session: text(s.session), latency_s: Number.isFinite(late) ? Math.max(0, Math.round(late / 1000)) : null } };
    }
    case 'acted':
      return { ...base, id: `ask:${ask}:acted`, type: 'ask_acted', at: now, data: { ask, round: count(s.round) } };
    case 'tokens': {
      const fig = (k) => count(s[k]);
      return { ...base, id: `ask:${ask}:tokens:${s.of}:${s.source}`, type: 'ask_tokens', at: now,
        data: { ask, step: s.of, source: s.source, input: fig('input'), output: fig('output'), cache_read: fig('cache_read'), cache_write: fig('cache_write'),
          usd: Number.isFinite(s.usd) && s.usd >= 0 ? s.usd : null, complete: s.complete === true, approx: typeof s.approx === 'boolean' ? s.approx : null } };
    }
    default: throw new Error(`unknown ask step "${s.step}" (want: raised|presented|answered|acted|tokens)`);
  }
}

// Whether event `ev` is left out of the folded `state`: a step it holds already (its id, or the step on
// the ask's record), or any step of a batch the log has never named. A batch's first event names it, and
// a queue write seeds only a batch the log has not named (queue-ledger.mjs recordWrite), so an ask
// written first would leave its batch never seeded.
function holds(state, ev) {
  if (!Object.hasOwn(state.batches, ev.batch ?? '')) return true;
  if (state.ids.includes(ev.id)) return true;
  const a = state.tickets[ev.key]?.asks?.[ev.data.ask];
  if (!a) return false;
  if (ev.type === 'ask_raised') return a.raised_at != null;
  if (ev.type === 'ask_presented') return a.presented.some((p) => p.via === ev.data.via);
  if (ev.type === 'ask_answered') return a.answered != null;
  if (ev.type === 'ask_tokens') return a.tokens?.[tokensKey(ev.data)] != null;
  return a.acted != null;
}

// Appends ask steps `steps` ([{ step, key, since, ... }]: raised takes kind (else read from question),
// blocking and arm (the question-handling lever's, question-arms.mjs); presented via, ref, notification and share; answered by, session and at; acted round) to the ledger of queue file `at` (or `{ repoDir, batch }`), in one append. `on`
// is the ledger lever. -> the report lines: none, or one saying the steps could not be written.
export function recordAsks(at, steps, { on = ledgerOn(), by, now = new Date(), waitMs = LOCK_WAIT_MS } = {}) {
  const list = [].concat(steps ?? []).filter(Boolean);
  if (!on || !list.length) return [];
  let events = [];
  try {
    const { repoDir, batch } = typeof at === 'string' ? ledgerTarget(at) : at;
    events = list.map((s) => eventOf(s, batch, iso(now))).filter(Boolean);
    if (events.length) append(repoDir, events, { by: by ?? basename(process.argv[1] ?? 'node'), waitMs, skip: holds });
    return [];
  } catch (e) {
    const what = [...new Set((events.length ? events.map((ev) => `${ev.key}'s ${ev.type}`) : list.map((s) => `${s.key}'s ask_${s.step}`)))].join(', ');
    return [`ask ledger: ${what} could not be added to the ticket ledger (${String(e?.message ?? e).split('\n')[0]})`];
  }
}

// The answer to asks `asks` ({ key, since, by, session, at: the answer's time, else now }, or a list).
export const askAnswered = (at, asks, opts) => recordAsks(at, [].concat(asks ?? []).map((a) => ({ ...a, step: 'answered' })), opts);

// Every ask a folded ledger state holds, with its ticket's key and batch: [{ key, batch, ask, since,
// kind, blocking, arm, raised_at, presented, answered, acted, tokens }], by ticket and then by since.
export const readAsks = (state) => Object.values(state?.tickets ?? {})
  .flatMap((t) => Object.values(t.asks ?? {}).map((a) => ({ key: t.key, batch: t.batch, ...structuredClone(a) })))
  .sort((a, b) => a.key.localeCompare(b.key) || String(a.since ?? '').localeCompare(String(b.since ?? '')));

// ---- what each step of an ask cost --------------------------------------------------------------
// measure, run once a pass with the ledger lever on, writes each step's ask_tokens once its figures can
// be read, and never again (recordAsks keeps a step written once):
//   raise    the parked round's main-session messages from the one that writes the park (its park file,
//            or the AUTOPILOT_PARK marker) to the round's end: a lower bound, since the work before the
//            decision to park cannot be told from the ticket's own. The round is the latest of the
//            ticket's logs that writes a park and was last written by the park's since.
//   present  a decider's session's tokens over the items its prompt listed (source decider); or the
//            person's session named on the answer, its requests since that session's previous answer
//            in this ledger up to this one (source session, approx), or 0 with no session (source shell).
//            A push or a digest costs no tokens, and is not measured.
//   act      the round the acting spawn started (its desk_spawn line, by the act's time), from that start
//            to its first stage marker, the cache reads and writes apart: on a resumed round, whether the
//            cache was still warm.
// Tokens and list-price dollars are cache-report.mjs's requestOf and requestUsd over each message once.
// A step whose round ended without the part it is read from (a killed worker), or whose record is
// missing, is complete false with what was read, never 0.

// How far a round's log time may lie from the time desk recorded for it: a park's since is the pass's
// harvest, after the worker's last line; an act is recorded once spawn-worker.sh has written its start.
const SLACK_MS = 10 * 60 * 1000;
const parsed = (text) => text.split('\n').flatMap((l) => { if (!l.trim()) return []; try { return [JSON.parse(l)]; } catch { return []; } });
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const noFigures = { input: null, output: null, cache_read: null, cache_write: null, usd: null };

// The requests among events `events`, each once by its id with its largest output, summed: tokens by
// kind and dollars, null dollars where a request's model has no price.
function sumRequests(events) {
  const byId = new Map();
  for (const d of events) {
    const r = requestOf(d);
    if (!r) continue;
    const k = r.id ?? `line-${byId.size}`;
    const had = byId.get(k);
    if (had) had.output = Math.max(had.output, r.output); else byId.set(k, { ...r });
  }
  const t = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let usd = 0, priced = true;
  for (const r of byId.values()) {
    t.input += r.uncached; t.output += r.output; t.cache_read += r.read; t.cache_write += r.w1h + r.w5m;
    const u = requestUsd(r);
    if (u) usd += u.total; else priced = false;
  }
  return { ...t, usd: priced ? round6(usd) : null };
}

const main = (d) => d?.type === 'assistant' && !d.parent_tool_use_id;
const writesPark = (d, key) => main(d) && (d.message?.content ?? []).some((c) => (c?.type === 'tool_use' && JSON.stringify(c.input ?? {}).includes(`parks/${key}.json`))
  || markersIn([saidIn(c) ?? '']).some(([k]) => k === 'AUTOPILOT_PARK'));
// A ticket's logs, oldest round first, each with its events and when it was last written.
const roundsOf = (stateDir, key) => workerLogs(stateDir, key).sort((a, b) => logRound(a) - logRound(b)).map((f) => {
  let events = [], mtime = NaN;
  try { events = parsed(readLogFile(f)); mtime = statSync(f).mtimeMs; } catch { /* unread: no events */ }
  return { f, events, mtime, current: logRound(f) === Infinity };
});

function raiseTokens(stateDir, key, since) {
  const by = Date.parse(since);
  // The round by its time, then whether it wrote the park: a park the pass made (a stall, a budget stop,
  // a claim) wrote none, and an earlier round's park is another ask's. A round started after the park
  // (the respawn a requeue made, in the same pass) is not the one that parked.
  const firstSpawnAt = (r) => Date.parse(r.events.find((d) => d?.type === 'desk_spawn')?.at);
  const round = roundsOf(stateDir, key).filter((r) => !(r.mtime > by + SLACK_MS) && !(firstSpawnAt(r) > by)).at(-1);
  if (!round?.events.some((d) => writesPark(d, key))) return { ...noFigures, complete: false };
  const after = round.events.slice(round.events.findIndex((d) => writesPark(d, key)));
  return { ...sumRequests(after.filter(main)), complete: after.some((d) => d.type === 'result') };
}

// null while the round has not reached its first marker and may still. A cloud session writes no log
// here, and an act no start lies near is past finding once SLACK_MS old: either is unread, once.
function actTokens(stateDir, key, actedAt, { cloud = false, now = new Date() } = {}) {
  const at = Date.parse(actedAt);
  if (cloud) return { ...noFigures, complete: false };
  const rounds = roundsOf(stateDir, key);
  let best = null;
  rounds.forEach((r, ri) => r.events.forEach((d, i) => {
    const t = d?.type === 'desk_spawn' ? Date.parse(d.at) : NaN;
    if (Math.abs(t - at) <= SLACK_MS && (!best || Math.abs(t - at) < best.gap)) best = { ri, i, gap: Math.abs(t - at) };
  }));
  if (!best) return now.getTime() - at > SLACK_MS ? { ...noFigures, complete: false } : null;
  const r = rounds[best.ri];
  const rest = r.events.slice(best.i + 1);
  const next = rest.findIndex((d) => d?.type === 'desk_spawn');
  const seg = next < 0 ? rest : rest.slice(0, next);
  const mark = seg.findIndex(marksStage);
  if (mark >= 0) return { ...sumRequests(seg.slice(0, mark)), complete: true };
  // Ended, moved aside or started again before any marker: what it spent is all there is to read.
  if (next >= 0 || !r.current || seg.some((d) => d.type === 'result') || best.ri < rounds.length - 1) return { ...sumRequests(seg), complete: false };
  return null;
}

// A decider session's share: null while it may still be running.
function deciderShare(stateDir, id, now) {
  const dir = join(stateDir, 'decider');
  let items = 0;
  try { items = (readFileSync(join(dir, `${id}.prompt.md`), 'utf8').match(/^- id `/gm) ?? []).length; } catch { /* no prompt kept */ }
  const out = join(dir, `${id}.json`);
  let text = '';
  try { text = readFileSync(out, 'utf8'); } catch { /* none written */ }
  const result = parsed(text).filter((d) => d?.type === 'result').at(-1);
  if (!result || !items) {
    let age = Infinity;
    try { age = now.getTime() - statSync(out).mtimeMs; } catch { /* no output at all */ }
    return age > DECIDER_TIMEOUT_MS ? { ...noFigures, complete: false } : null;
  }
  const t = resultTokens(result);
  const models = Object.entries(result.modelUsage ?? {});
  const usds = models.map(([model, m]) => requestUsd({ model, uncached: Number(m.inputTokens) || 0, w5m: Number(m.cacheCreationInputTokens) || 0, w1h: 0, read: Number(m.cacheReadInputTokens) || 0, output: Number(m.outputTokens) || 0 }));
  const share = (n) => Math.round(n / items);
  return { input: share(t.uncached), output: share(t.output), cache_read: share(t.cacheRead), cache_write: share(t.cacheWrite),
    usd: models.length && usds.every(Boolean) ? round6(usds.reduce((s, u) => s + u.total, 0) / items) : null, complete: true };
}

// Every transcript file of session `session` under login projects folders `dirs`: <project>/<id>.jsonl,
// and its subagents' under <project>/<id>/.
function sessionFiles(dirs, session) {
  const projects = dirs.flatMap((dir) => { try { return readdirSync(dir).map((p) => join(dir, p)); } catch { return []; } });
  return projects.flatMap((p) => [join(p, `${session}.jsonl`), ...transcripts(join(p, session))]).filter((f) => existsSync(f));
}

function sessionTokens(dirs, session, from, to) {
  const files = sessionFiles(dirs, session);
  if (!files.length) return { ...noFigures, complete: false, approx: true };
  const inWindow = (d) => { const t = Date.parse(d?.timestamp); return t > from && t <= to; };
  return { ...sumRequests(files.flatMap((f) => { try { return parsed(readFileSync(f, 'utf8')); } catch { return []; } }).filter(inWindow)), complete: true, approx: true };
}

// Measures what each ask of queue `queue`'s batch has not had measured yet, from batch state folder
// `stateDir`, and writes it. `dirs` are the login projects folders (claude-logins.mjs projectsDirs).
// -> the report lines: what could not be measured or written. Never throws.
export function measure(stateDir, { queue, on = ledgerOn(), dirs = null, now = new Date(), by = 'pass' } = {}) {
  if (!on) return [];
  const lines = [];
  try {
    const { repoDir, batch } = ledgerTarget(queue);
    // An ask's since is in its id, whether or not its raise was recorded.
    const state = fold(repoDir);
    // Every ask of the repo, whichever batch: a session's previous answer may be in another batch.
    const all = readAsks(state);
    const asks = all.filter((a) => a.batch === batch && a.ask.startsWith(`${a.key}:`)).map((a) => ({ ...a, since: a.since ?? a.ask.slice(a.key.length + 1) }));
    let logins = dirs;
    const loginDirs = () => (logins ??= (() => { try { return projectsDirs(); } catch { return []; } })());
    const steps = [];
    const put = (a, of, source, fig) => { if (fig && !a.tokens?.[`${of}:${source}`]) steps.push({ step: 'tokens', key: a.key, since: a.since, of, source, ...fig }); };
    for (const a of asks) {
      try {
        if (a.raised_at && !a.tokens?.['raise:log']) put(a, 'raise', 'log', raiseTokens(stateDir, a.key, a.since));
        for (const p of a.presented.filter((x) => x.via === 'decider' && x.ref)) if (!a.tokens?.['present:decider']) put(a, 'present', 'decider', deciderShare(stateDir, p.ref, now));
        const ans = a.answered;
        if (ans?.by === 'person') {
          if (!ans.session) put(a, 'present', 'shell', { input: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0, complete: true });
          else if (!a.tokens?.['present:session']) {
            const prev = all.map((x) => x.answered).filter((x) => x?.session === ans.session && Date.parse(x.at) < Date.parse(ans.at)).map((x) => Date.parse(x.at));
            put(a, 'present', 'session', sessionTokens(loginDirs(), ans.session, prev.length ? Math.max(...prev) : -Infinity, Date.parse(ans.at)));
          }
        }
        if (a.acted && !a.tokens?.['act:log']) put(a, 'act', 'log', actTokens(stateDir, a.key, a.acted.at, { cloud: state.tickets[a.key]?.fields?.location === 'cloud', now }));
      } catch (e) { lines.push(`ask ledger: ${a.ask}'s tokens not measured (${String(e?.message ?? e).split('\n')[0]})`); }
    }
    lines.push(...recordAsks({ repoDir, batch }, steps, { on, by, now }));
  } catch (e) { lines.push(`ask ledger: tokens not measured (${String(e?.message ?? e).split('\n')[0]})`); }
  return lines;
}

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  try {
    if (process.argv.length > 2) { console.error('usage: ask-ledger.mjs'); process.exit(2); }
    const { queueFile } = await import('./desk-env.mjs');
    for (const a of readAsks(fold(ledgerTarget(queueFile()).repoDir))) console.log(JSON.stringify(a));
  } catch (e) {
    console.error(`ask-ledger: ${e.message ?? e}`);
    process.exit(1);
  }
}
