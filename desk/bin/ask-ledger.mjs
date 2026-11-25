// Each ask desk puts to the person or the decider, step by step, in the ticket ledger. An ask is a
// worker's park handed on (supervisor.mjs decide), and its id is <KEY>:<park.since>, so the same
// question parked again after a requeue is another ask. Its steps are four ticket events, each legal
// from any state and leaving it as it is (ticket-ledger.mjs):
//   ask_raised     { ask, since, kind, blocking }        handed to the person or the decider
//   ask_presented  { ask, via, ref, notification }       via push, digest, decider or session
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
import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { append, fold, LOCK_WAIT_MS } from './ticket-ledger.mjs';
import { ledgerOn, ledgerTarget } from './queue-ledger.mjs';
import { parkKind } from './batch-state.mjs';
import { parseLevers, repoConfigValues } from './desk-env.mjs';

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
        data: { ask, since, kind: parkKind({ park: { kind: s.kind, question: s.question } }), blocking: typeof s.blocking === 'boolean' ? s.blocking : null } };
    case 'presented':
      return { ...base, id: `ask:${ask}:presented:${s.via}`, type: 'ask_presented', at: now,
        data: { ask, via: s.via, ref: text(s.ref), notification: text(s.notification) } };
    case 'answered': {
      const at = s.at != null ? iso(s.at) : now;
      const late = ms(at) - ms(since);
      return { ...base, id: `ask:${ask}:answered`, type: 'ask_answered', at,
        data: { ask, by: s.by, session: text(s.session), latency_s: Number.isFinite(late) ? Math.max(0, Math.round(late / 1000)) : null } };
    }
    case 'acted':
      return { ...base, id: `ask:${ask}:acted`, type: 'ask_acted', at: now, data: { ask, round: count(s.round) } };
    default: throw new Error(`unknown ask step "${s.step}" (want: raised|presented|answered|acted)`);
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
  return a.acted != null;
}

// Appends ask steps `steps` ([{ step, key, since, ... }]: raised takes kind (else read from question) and
// blocking; presented via, ref and notification; answered by, session and at; acted round) to the ledger of queue file `at` (or `{ repoDir, batch }`), in one append. `on`
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
// kind, blocking, raised_at, presented, answered, acted }], by ticket and then by since.
export const readAsks = (state) => Object.values(state?.tickets ?? {})
  .flatMap((t) => Object.values(t.asks ?? {}).map((a) => ({ key: t.key, batch: t.batch, ...structuredClone(a) })))
  .sort((a, b) => a.key.localeCompare(b.key) || String(a.since ?? '').localeCompare(String(b.since ?? '')));

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
