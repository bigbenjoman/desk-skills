#!/usr/bin/env node
// The levers controller's assignment: in a repo whose levers row reads `auto`, each ticket is given its
// trial arms when it is admitted, before anything about its outcome is known, and keeps them for life.
// Each low-risk lever on trial is drawn on for half the repo's tickets, independently of the others, by
// randomisation blocked within the repo and the ticket's triage size: every block of four tickets of one
// size has each lever on for exactly two of them. A ticket with no triage size is a block of its own.
//
// A lever's state in a repo is the `to` of its latest transition, override or trip in the repo's lever log
// (lever-log.mjs): off, trial, adopted, settled, reverted, frozen or overridden. With none recorded, a low-risk lever
// the registry has trialled is on trial. An adopted lever stays off for its layer's holdback share of
// tickets for its holdback weeks, recorded as the `holdback` arm, then is on for every ticket; a settled
// one is on; an overridden one is its value; any other state is off. While the machine-wide
// freeze stands, a ticket gets the repo's kept levers and no arm. A lever the row names is on whatever
// its state, and a lever whose repo preconditions fail is off.
//
// The quality-risk layer is exclusive: a ticket carries at most one quality-risk lever, or a pair proven
// together. Each quality-risk trial (a lever on trial, or a pair trial) reaches its exposure share of
// the repo's tickets, starting at the layer's first ramp share and stepping to the next once
// `step_after` tickets have carried it at the current one with no hard trip, each step one `ramp` event
// in the lever log. A ticket drawn on for none of them is the `off` arm of every one, and carries the
// repo's kept quality-risk lever: one of them, at random, while two are kept and not yet proven
// together. Once 30% (`cap`) of the repo's tickets in flight already carry an unproven quality-risk
// lever, a ticket carries none. Two quality-risk levers kept alone, past their holdbacks, are tried as a
// pair: the pair's `on` arm carries both, its `off` arm the kept set as it stands. A pair's state is
// its latest `pair` event for that trial (levers-evaluate.mjs writes them): adopted or settled is the
// repo's default, both on; reverted ends the trial with the levers kept alone.
//
// The pin is the queue ticket's `levers: { set, arms, trial_ids, fp, block, at }` (lever-pin.mjs); one
// `assign` event in the lever log records the same draw, so exposure outlives the queue. A repo whose
// row has no `auto` gets the row's set and no arm. A lever log that cannot be read, or holds a line that
// does not parse, gets the row's set too, and one `needs_you` event says the repo cannot be assigned;
// where the log cannot be read as far as that event, the levers view raises the same item itself.
//
//   import { assignPin, leverStatesIn } from './levers-auto.mjs'
//   node levers-auto.mjs assign <TICKET>   pins a queued ticket that has no pin and prints the pin;
//                                          a ticket already pinned is left as it is
//   node levers-auto.mjs evaluate          the daily adopt, revert or hold of each lever on trial, if
//                                          today's has not run (levers-evaluate.mjs)
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { leverStates, leversFrozen, queueFile, repoSlug, stateDir, SAFE_ID } from './desk-env.mjs';
import { REGISTRY, KEPT_STATES, leverFingerprints, preconditions, repoValues, unassignableText } from './lever-registry.mjs';
import { appendWith, read } from './lever-log.mjs';
import { pinAtAdmission } from './lever-pin.mjs';
import { readQueue } from './batch-state.mjs';
import { listBatches, repoTickets } from './batches.mjs';
import { SIZES, sizeOf } from './desk-q-eta.mjs';
import { lock, unlock, writeJsonAtomic } from './dir-lock.mjs';

export const STATES = Object.freeze(['off', 'trial', 'adopted', 'settled', 'reverted', 'frozen', 'overridden']);
export const BLOCK_SIZE = 4;
export const ACTOR = 'levers-auto';
const WEEK_MS = 7 * 24 * 3_600_000;

// A uniform draw in [0, 1) from the system's random source.
const systemRandom = () => randomBytes(4).readUInt32LE(0) / 2 ** 32;

// Each registry lever's state in a repo, from its lever log's events (oldest first):
//   -> { <lever>: { state, at, id, value? } }, `at` and `id` those of the event that set it, null with
//   none. An overridden lever (lever-changes.mjs) carries the `value`, `on` or `off`, it was set to. An
//   override whose `to` is `on` or `off` with that same `value` (levers.mjs decide) is overridden to it;
//   one with no value (levers.mjs undo, back to a plain state) is that state. An override carrying
//   `restores: { id, at }` (levers.mjs undo) takes the restored state's `id` and `at`, so a trial keeps its
//   trial id and an adopt its holdback start.
export function leverStatesIn(events, registry = REGISTRY) {
  const out = {};
  for (const [name, l] of Object.entries(registry)) {
    out[name] = { state: l.trialled ? 'trial' : 'off', at: null, id: null };
  }
  for (const e of events) {
    if (!['transition', 'override', 'trip'].includes(e.kind) || !Object.hasOwn(out, e.lever) || e.to == null) continue;
    const pinned = e.kind === 'override' && (e.to === 'on' || e.to === 'off') && e.value === e.to;
    const state = pinned ? 'overridden' : STATES.includes(e.to) ? e.to : 'off';
    const value = pinned ? e.to : e.value;
    const from = e.kind === 'override' && e.restores && typeof e.restores === 'object' ? e.restores : { at: e.at, id: e.id };
    out[e.lever] = { state, at: from.at ?? null, id: from.id ?? null, ...(state === 'overridden' ? { value: value === 'on' ? 'on' : 'off' } : {}) };
  }
  return out;
}

// The size a ticket is blocked by: its triage size on desk's scale, or null.
const blockSize = (size) => {
  const s = String(size ?? '').trim().toUpperCase();
  return SIZES.includes(s) ? s : null;
};

// The block the next ticket of `size` joins, from the repo's earlier assign events: the latest block
// of that size while it has fewer than BLOCK_SIZE members, else the next one.
//   -> { id, members: [assign event] }
function nextBlock(slug, key, size, assigns) {
  if (!size) return { id: `${slug}/unsized/${key}`, members: [] };
  const sized = assigns.filter((e) => e.size === size && typeof e.block === 'string');
  const last = sized.at(-1)?.block;
  const members = last ? sized.filter((e) => e.block === last) : [];
  if (last && members.length < BLOCK_SIZE) return { id: last, members };
  const n = last ? Number(last.split('/').pop()) + 1 : 1;
  return { id: `${slug}/${size}/${Number.isFinite(n) ? n : sized.length + 1}`, members: [] };
}

// On or off for one lever on trial, so that a block of BLOCK_SIZE holds each arm BLOCK_SIZE / 2 times.
function blockedArm(lever, members, random) {
  const half = BLOCK_SIZE / 2;
  const used = (arm) => members.filter((e) => e.arms?.[lever] === arm).length;
  const on = Math.max(0, half - used('on'));
  const off = Math.max(0, half - used('off'));
  return random() < (on + off ? on / (on + off) : 0.5) ? 'on' : 'off';
}

// The trial a ticket draws a lever's arm under: one per state the lever enters in the repo.
export const trialId = (slug, lever, s) => `${slug}/${lever}/${s.id ?? 'initial'}`;

// When the holdback of a lever adopted at `adoptedAt` (ms) ends, in ms: the evaluation settles it then.
export const holdbackEnd = (adoptedAt, weeks) => adoptedAt + weeks * WEEK_MS;

// Whether an adopted lever is still in its holdback at `now` (ms): admission draws a holdback arm for it,
// and desk-env levers counts those tickets.
export const inHoldback = (s, l, now) => s.state === 'adopted' && !!s.at && now < holdbackEnd(Date.parse(s.at), l.ramp.holdback_weeks);

// ---- the quality-risk layer ------------------------------------------------------------------------
// The key a pair of levers is known by in a pin's arms and trial ids: the two names, sorted, joined.
export const pairKey = (a, b) => [a, b].sort().join('+');
export const isPairKey = (k) => typeof k === 'string' && k.includes('+');
const QUALITY_KEY = (k, registry) => isPairKey(k) || registry[k]?.layer === 'quality-risk';

// The quality-risk levers a repo's tickets may carry, from its row `states`, its config `values` and
// its lever states `byLever`: those on trial, and those kept (adopted or settled), in registry order.
// With `values` null the preconditions are not read (the evaluation weighs what tickets drew).
function qualityLevers({ states, values, byLever, registry }) {
  const out = { trial: [], kept: [] };
  for (const [name, l] of Object.entries(registry)) {
    if (l.layer !== 'quality-risk' || !l.trialled || states?.[name] !== 'auto') continue;
    if (values && !preconditions(name, values, registry).eligible) continue;
    const s = byLever[name];
    if (s.state === 'trial') out.trial.push(name);
    else if (KEPT_STATES.includes(s.state)) out.kept.push(name);
  }
  return out;
}

// The id of the event that began `lever`'s latest unbroken run of kept states (adopted, then settled),
// so settling an adopted lever does not start its pair trial again.
function keptSince(events, lever) {
  let id = null;
  let kept = false;
  for (const e of events) {
    if (!['transition', 'override', 'trip'].includes(e.kind) || e.lever !== lever || e.to == null) continue;
    const now = KEPT_STATES.includes(e.to);
    if (now && !kept) id = e.id ?? null;
    kept = now;
  }
  return kept ? id : null;
}

// The pair trial a repo runs, or null: its first two kept quality-risk levers, from the moment both are
// kept. Its id names the event each lever was kept from, so a lever reverted and kept again starts a new
// one. `state` is the latest `pair` event's `to` for that id, `trial` with none.
//   -> { key, id, levers, state, at } | null
export function pairTrial({ slug, events, states, values = repoValues(), registry = REGISTRY }) {
  const byLever = leverStatesIn(events, registry);
  const kept = qualityLevers({ states, values, byLever, registry }).kept;
  if (kept.length < 2) return null;
  const [a, b] = kept;
  const key = pairKey(a, b);
  const id = `${slug}/${key}/${keptSince(events, a) ?? 'initial'}+${keptSince(events, b) ?? 'initial'}`;
  const last = events.filter((e) => e.kind === 'pair' && e.trial_id === id && e.to != null).at(-1);
  return { key, id, levers: [a, b].sort(), state: last ? last.to : 'trial', at: last?.at ?? null, event_id: last?.id ?? null };
}

// Every quality-risk trial running in a repo, singles first in registry order, then the pair:
//   -> [{ key, id, levers }]
export function qualityTrials({ slug, events, states, values = repoValues(), registry = REGISTRY, now = Date.now() }) {
  const byLever = leverStatesIn(events, registry);
  const q = qualityLevers({ states, values, byLever, registry });
  const out = q.trial.map((n) => ({ key: n, id: trialId(slug, n, byLever[n]), levers: [n] }));
  const p = pairTrial({ slug, events, states, values, registry, now });
  if (p?.state === 'trial') out.push({ key: p.key, id: p.id, levers: p.levers });
  return out;
}

// A quality-risk trial's exposure from the repo's log events: its share now, and how many tickets that
// carried it since it reached that share (its last ramp, or the trial's start) have merged, so ran to
// the end with every hard trip able to fire. `merged` holds the repo's merged ticket keys.
//   -> { share, step, carried }
export function exposureOf(events, trial, ramp, merged = new Set()) {
  const ramps = events.filter((e) => e.kind === 'ramp' && e.trial_id === trial.id && Number.isFinite(e.to));
  const share = ramps.at(-1)?.to ?? ramp.ramp[0];
  const from = ramps.length ? events.indexOf(ramps.at(-1)) : -1;
  const carried = new Set(events.slice(from + 1).filter((e) => e.kind === 'assign' && e.arms?.[trial.key] === 'on' && e.trial_ids?.[trial.key] === trial.id && merged.has(e.ticket)).map((e) => e.ticket)).size;
  return { share, step: ramp.ramp.indexOf(share), carried };
}

// The next ramp event due among the repo's quality-risk trials, or null: a trial whose `step_after`
// merged tickets at its current share ran with no hard trip steps to the ramp's next share. A hard trip
// reverts its lever (levers-trips.mjs), which ends the trial, so a trial still running has had none.
function rampDue({ slug, key, events, states, values, registry, now, merged }) {
  for (const t of qualityTrials({ slug, events, states, values, registry })) {
    const ramp = registry[t.levers[0]].ramp;
    const x = exposureOf(events, t, ramp, merged);
    if (x.step < 0 || x.step >= ramp.ramp.length - 1 || x.carried < ramp.step_after) continue;
    const to = ramp.ramp[x.step + 1];
    const pct = (v) => `${Math.round(v * 100)}%`;
    return {
      kind: 'ramp', ...(isPairKey(t.key) ? { pair: t.key, levers: t.levers } : { lever: t.key }), actor: ACTOR, reason_code: 'ramp_clean',
      at: now.toISOString(), from: x.share, to, trial_id: t.id, ticket: key,
      reason: `${x.carried} merged tickets carried ${t.levers.join(' with ')} at ${pct(x.share)} with no hard trip, so it now reaches ${pct(to)} of ${slug}'s tickets`,
    };
  }
  return null;
}

// Whether a pin carries an unproven quality-risk lever: drawn `on` for a quality-risk trial.
const carriesUnproven = (pin, registry) => Object.entries(pin?.arms ?? {}).some(([k, a]) => a === 'on' && QUALITY_KEY(k, registry));

// The repo's tickets: the keys of those merged, from every batch with archived tickets and archived
// batches included (batches.mjs repoTickets), so the ramp counts a carrier a pass archived; and the pins
// of those in flight, from the live tickets of the live batches only (not merged or failed), since an
// archived ticket is done, its PR merged or closed, and an archived batch is finished.
//   -> { inFlight: [pin], merged: Set<key> }
export function ticketsOf(slug) {
  const out = { inFlight: [], merged: new Set() };
  try {
    for (const t of repoTickets(slug)) if (t?.merged_at) out.merged.add(t.key);
    for (const t of repoTickets(slug, listBatches(slug))) {
      if (!t || t.archived_at || t.merged_at || t.state === 'failed' || !t.levers || typeof t.levers !== 'object') continue;
      out.inFlight.push(t.levers);
    }
  } catch { return { inFlight: [], merged: new Set() }; }
  return out;
}

// The quality-risk part of a ticket's draw: { set, arms, trialIds }.
function qualityDraw({ slug, events, byLever, states, frozen, values, random, now, registry, inFlight }) {
  const q = qualityLevers({ states, values, byLever, registry });
  const out = { set: [], arms: {}, trialIds: {} };
  const pair = pairTrial({ slug, events, states, values, registry });
  const trials = frozen ? [] : qualityTrials({ slug, events, states, values, registry });
  let picked = null;
  if (trials.length) {
    // Drawn on only while the repo's tickets in flight, this one counted, stay within the cap.
    const live = inFlight.filter((p) => p && typeof p === 'object');
    const carrying = live.filter((p) => carriesUnproven(p, registry)).length;
    const cap = registry[trials[0].levers[0]].ramp.cap;
    if ((carrying + 1) / (live.length + 1) <= cap) {
      const shares = trials.map((t) => exposureOf(events, t, registry[t.levers[0]].ramp).share);
      const total = shares.reduce((n, s) => n + s, 0);
      const scale = total > 1 ? 1 / total : 1;
      const u = random();
      let acc = 0;
      for (const [i, t] of trials.entries()) {
        acc += shares[i] * scale;
        if (u < acc) { picked = t; break; }
      }
    }
    for (const t of trials) {
      if (picked && picked !== t) continue;
      out.arms[t.key] = picked === t ? 'on' : 'off';
      out.trialIds[t.key] = t.id;
    }
  }
  if (picked) { out.set.push(...picked.levers); return out; }
  // Not drawn on for a trial: the kept set, exclusive unless its pair is proven.
  if (pair && KEPT_STATES.includes(pair.state)) { out.set.push(...pair.levers); return out; }
  const pick = (names) => (names.length === 1 ? names[0] : names[Math.min(names.length - 1, Math.floor(random() * names.length))]);
  // A lever adopted lately draws its holdback arm: `adopted` carries it, `holdback` what the repo kept
  // before it, the other kept levers (one, at random).
  const held = frozen ? null : q.kept.find((n) => inHoldback(byLever[n], registry[n], now.getTime()));
  if (held) {
    out.arms[held] = random() < registry[held].ramp.holdback ? 'holdback' : 'adopted';
    out.trialIds[held] = trialId(slug, held, byLever[held]);
    const before = q.kept.filter((n) => n !== held);
    if (out.arms[held] === 'adopted') out.set.push(held);
    else if (before.length) out.set.push(pick(before));
  } else if (q.kept.length) out.set.push(pick(q.kept));
  return out;
}

// The draw for ticket `key` from the repo's log events: the pin and the assign event recording it.
function draw({ slug, key, size, events, states, frozen, values, random, now, registry, inFlight = [] }) {
  const byLever = leverStatesIn(events, registry);
  const set = [];
  const arms = {};
  const trialIds = {};
  const b = frozen ? { id: null, members: [] } : nextBlock(slug, key, size, events.filter((e) => e.kind === 'assign'));
  for (const name of Object.keys(registry)) {
    const row = states[name];
    if (row === 'pinned') { set.push(name); continue; }
    if (row !== 'auto' || !preconditions(name, values, registry).eligible) continue;
    const l = registry[name];
    const s = byLever[name];
    // Set by hand: pinned to its value, with no arm, whatever the freeze or the layer.
    if (s.state === 'overridden') {
      if (s.value === 'on') set.push(name);
      continue;
    }
    // The quality-risk layer is drawn as one, below.
    if (l.layer !== 'low-risk') continue;
    if (frozen) {
      if (KEPT_STATES.includes(s.state)) set.push(name);
      continue;
    }
    if (s.state === 'trial') {
      arms[name] = blockedArm(name, b.members, random);
      trialIds[name] = trialId(slug, name, s);
      if (arms[name] === 'on') set.push(name);
    } else if (inHoldback(s, l, now.getTime())) {
      arms[name] = random() < l.ramp.holdback ? 'holdback' : 'adopted';
      trialIds[name] = trialId(slug, name, s);
      if (arms[name] === 'adopted') set.push(name);
    } else if (KEPT_STATES.includes(s.state)) {
      set.push(name);
    }
  }
  // The block is the low-risk layer's: a quality-risk arm is drawn by its exposure, not in blocks.
  const block = Object.values(arms).some((a) => a === 'on' || a === 'off') ? b.id : null;
  const qd = qualityDraw({ slug, events, byLever, states, frozen, values, random, now, registry, inFlight });
  for (const n of qd.set) if (!set.includes(n)) set.push(n);
  Object.assign(arms, qd.arms);
  Object.assign(trialIds, qd.trialIds);
  const at = now.toISOString();
  const pin = { set, arms, trial_ids: trialIds, fp: leverFingerprints(registry).fp, block, at };
  const drawn = Object.keys(arms).length;
  const event = {
    kind: 'assign', actor: ACTOR, reason_code: 'assigned_at_admission', at,
    reason: frozen ? `${key} was admitted while trials were frozen: kept levers only, no arm`
      : `${key} drew ${drawn ? Object.entries(arms).map(([n, a]) => `${n} ${a}`).join(', ') : 'no arm'} at admission`,
    ticket: key, size, block, arms, trial_ids: trialIds, set,
  };
  return { pin, event };
}

// The pin ticket `key` is admitted with, given its triage size. In a repo with `auto` in its levers
// row, the draw and its assign event are made under the lever log's lock, so two admissions at once
// never fill one block slot twice. Every failure falls back to the row's set (pinAtAdmission), with
// `warning` saying why the repo could not be assigned. `states` is each lever's state in the row
// (desk-env leverStates), read from the row itself rather than any DESK_LEVERS the caller carries.
//   -> { pin, assigned: bool, warning: text | null }
export function assignPin(key, {
  size = null, slug, states = leverStates({}).states, frozen, random = systemRandom,
  now = new Date(), registry = REGISTRY, values = null, inFlight = null, merged = null,
} = {}) {
  const rowPin = () => pinAtAdmission({ on: Object.keys(states).filter((n) => states[n] === 'pinned') }, now);
  if (!Object.values(states).includes('auto')) return { pin: rowPin(), assigned: false, warning: null };
  let result = null;
  let unreadable = null;
  try {
    slug ??= repoSlug();
    if (frozen === undefined) frozen = leversFrozen();
    values ??= repoValues();
    // The repo's tickets, read under the lever log's lock with the draw, so two admissions at once
    // count each other's pins once each is saved.
    const tickets = () => {
      const r = inFlight && merged ? null : ticketsOf(slug);
      return { inFlight: inFlight ?? r.inFlight, merged: typeof merged?.has === 'function' ? merged : new Set(merged ?? r.merged) };
    };
    // Each exposure step due is written first, one event a time under the log's lock, so the draw
    // below reads the share it set. Never more than one step per trial per admission.
    if (!frozen) {
      for (let i = 0; i < Object.keys(registry).length + 1; i++) {
        const e = appendWith(slug, () => {
          const log = read(slug);
          return log.bad.length ? null : rampDue({ slug, key, events: log.events, states, values, registry, now, merged: tickets().merged });
        });
        if (!e) break;
      }
    }
    appendWith(slug, () => {
      let log;
      try { log = read(slug); } catch (e) { unreadable = e.message; }
      if (!unreadable && log.bad.length) unreadable = `line ${log.bad.map((b) => b.line).join(', ')} of its lever log does not parse`;
      if (unreadable) {
        // One item while the log stays broken: nothing else can be appended until it is fixed.
        const last = log?.events.at(-1);
        if (last?.kind === 'needs_you' && last.reason_code === 'state_unreadable') return null;
        return { kind: 'needs_you', actor: ACTOR, reason_code: 'state_unreadable', reason: unassignableText(slug, unreadable), ticket: key };
      }
      result = draw({ slug, key, size: blockSize(size), events: log.events, states, frozen: !!frozen, values, random, now, registry, inFlight: tickets().inFlight });
      return result.event;
    });
  } catch (e) {
    unreadable ??= e.message;
    result = null;
  }
  if (unreadable || !result) return { pin: rowPin(), assigned: false, warning: `levers: ${slug} cannot be assigned trial arms (${unreadable}); ${key} is pinned with the row's named levers alone` };
  return { pin: result.pin, assigned: true, warning: null };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain && process.argv[2] === 'evaluate' && process.argv.length === 3) {
  // Not awaited: levers-evaluate.mjs imports this module, which must finish evaluating first.
  import('./levers-evaluate.mjs').then(({ evaluateDue }) => {
    const r = evaluateDue();
    console.log(r.line ?? { none: 'levers evaluate: no repo on this computer has `auto` in its levers row', busy: 'levers evaluate: another pass is evaluating now', not_due: 'levers evaluate: today\'s evaluation has run' }[r.status]);
  }).catch((e) => {
    console.error(`levers-auto: ${e.message ?? e}`);
    process.exit(1);
  });
} else if (isMain) {
  const [cmd, key] = process.argv.slice(2);
  if (cmd !== 'assign' || !key || !SAFE_ID.test(key) || key.includes('..')) { console.error('usage: levers-auto.mjs assign <TICKET> | evaluate'); process.exit(2); }
  try {
    const qf = queueFile();
    if (!existsSync(qf)) throw new Error(`no queue at ${qf}`);
    const qLock = `${qf}.lock`;
    lock(qLock, { timeout: (pid) => new Error(`the queue is locked by pid ${pid ?? '?'} past the 10s wait: nothing was changed`) });
    const q = readQueue(qf);
    const t = q.tickets?.[key];
    if (!t) throw new Error(`no such ticket in the queue: ${key}`);
    if (t.levers != null) {
      unlock(qLock);
      console.log(`${key} is already pinned; unchanged: ${JSON.stringify(t.levers)}`);
      process.exit(0);
    }
    const { pin, warning } = assignPin(key, { size: sizeOf(stateDir(), key) });
    t.levers = pin;
    writeJsonAtomic(qf, q);
    unlock(qLock);
    if (warning) console.error(warning);
    console.log(`${key} pinned: ${JSON.stringify(pin)}`);
  } catch (e) {
    console.error(`levers-auto: ${e.message ?? e}`);
    process.exit(1);
  }
}
