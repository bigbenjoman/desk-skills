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
// one is on; an overridden one is its value; any other state is off. The quality-risk layer is never drawn here. While the machine-wide
// freeze stands, a ticket gets the repo's kept levers and no arm. A lever the row names is on whatever
// its state, and a lever whose repo preconditions fail is off.
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
//   none. An overridden lever (lever-changes.mjs) carries the `value`, `on` or `off`, it was set to.
export function leverStatesIn(events, registry = REGISTRY) {
  const out = {};
  for (const [name, l] of Object.entries(registry)) {
    out[name] = { state: l.layer === 'low-risk' && l.trialled ? 'trial' : 'off', at: null, id: null };
  }
  for (const e of events) {
    if (!['transition', 'override', 'trip'].includes(e.kind) || !Object.hasOwn(out, e.lever) || e.to == null) continue;
    const state = STATES.includes(e.to) ? e.to : 'off';
    out[e.lever] = { state, at: e.at, id: e.id ?? null, ...(state === 'overridden' ? { value: e.value === 'on' ? 'on' : 'off' } : {}) };
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

// The draw for ticket `key` from the repo's log events: the pin and the assign event recording it.
function draw({ slug, key, size, events, states, frozen, values, random, now, registry }) {
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
    if (l.layer !== 'low-risk') {
      if (l.trialled && KEPT_STATES.includes(s.state)) set.push(name);
      continue;
    }
    if (frozen) {
      if (KEPT_STATES.includes(s.state)) set.push(name);
      continue;
    }
    if (s.state === 'trial') {
      arms[name] = blockedArm(name, b.members, random);
      trialIds[name] = trialId(slug, name, s);
      if (arms[name] === 'on') set.push(name);
    } else if (s.state === 'adopted' && s.at && now.getTime() < Date.parse(s.at) + l.ramp.holdback_weeks * WEEK_MS) {
      arms[name] = random() < l.ramp.holdback ? 'holdback' : 'adopted';
      trialIds[name] = trialId(slug, name, s);
      if (arms[name] === 'adopted') set.push(name);
    } else if (KEPT_STATES.includes(s.state)) {
      set.push(name);
    }
  }
  const block = Object.values(arms).some((a) => a === 'on' || a === 'off') ? b.id : null;
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
  now = new Date(), registry = REGISTRY, values = null,
} = {}) {
  const rowPin = () => pinAtAdmission({ on: Object.keys(states).filter((n) => states[n] === 'pinned') }, now);
  if (!Object.values(states).includes('auto')) return { pin: rowPin(), assigned: false, warning: null };
  let result = null;
  let unreadable = null;
  try {
    slug ??= repoSlug();
    if (frozen === undefined) frozen = leversFrozen();
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
      result = draw({ slug, key, size: blockSize(size), events: log.events, states, frozen: !!frozen, values: values ?? repoValues(), random, now, registry });
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
