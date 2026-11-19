// What the person is told about each lever change, after the fact, and how they veto one. Every adopt
// and revert (an evaluation's transition to adopted, reverted or frozen, or a hard trip) is logged as a
// taken call in category `engineering` in the repo's decision log, so the check-in digest lists it on its
// Levers section with the evidence behind it, and `digest.mjs override <slug> <id> off|on` sets the lever
// by hand: one `override` event in the repo's lever log, actor `ben`, whose `to` is `overridden` and whose
// `value` is the choice. An overridden lever is pinned to that value for every ticket admitted after it,
// and is neither evaluated nor tripped again. `desk-env levers` prints one summary line of each managed
// lever's state in a repo whose levers row reads `auto`.
//
//   import { leverDecision, recordLeverDecision, changeLine, overrideEvent, summaryLine } from './lever-changes.mjs'
import { decisionEntry, appendDecisions } from './decisions.mjs';
import { shortName } from './desk-env.mjs';
import { REGISTRY, DECISION_RULE, reasonWording } from './lever-registry.mjs';
import { leverStatesIn, trialId, inHoldback } from './levers-auto.mjs';

export const CATEGORY = 'engineering';
// The states an adopt or a revert leaves a lever in, as the evaluation and the trips write them.
export const DECIDED = Object.freeze(['adopted', 'reverted', 'frozen']);
export const VALUES = Object.freeze(['on', 'off']);
const BY_HAND = 'ben';

// A repo's short name from its slug: `bigbenjoman__desk-skills` is `desk-skills`.
const repoName = (slug) => shortName(String(slug ?? ''));

// Whether a lever log event is an adopt or a revert the person is told about.
export const isDecided = (e) => ['transition', 'trip'].includes(e?.kind) && DECIDED.includes(e.to) && !!e.lever;

// The taken call an adopt or revert event is, as a decision log entry, or null for any other event. Its
// `chose` is the lever's value after it: `on` for an adopt, `off` for a revert; the override takes the
// other. `ticket` is the ticket a trip names, else null.
export function leverDecision(e, { slug = e?.repo, repo = null } = {}) {
  if (!isDecided(e)) return null;
  const chose = e.to === 'adopted' ? 'on' : 'off';
  const why = e.kind === 'trip' ? `a hard trip, ${e.trip ?? e.reason_code} on ${e.ticket}` : reasonWording(e.reason_code) ?? e.reason_code;
  const question = `Is ${e.lever} ${chose} in ${repoName(slug)}? desk ${e.to === 'adopted' ? 'adopted' : e.to === 'frozen' ? 'reverted and froze' : 'reverted'} it (${why}).`;
  const entry = decisionEntry({
    decision: { question, options: chose === 'on' ? ['on', 'off'] : ['off', 'on'], chose, category: CATEGORY },
    ticket: e.kind === 'trip' ? e.ticket ?? null : null, run: e.id, repo, pr: null, at: e.at, source: 'levers',
  });
  return { ...entry, slug, lever: e.lever, lever_event: e.id };
}

// Appends the decision for each adopt or revert in `events` to the decision log in `state` (the repo's
// own state folder), once each. Never throws: a decision log that cannot be written never undoes the
// change. The refusal goes to stderr, and the digest records a missing decision again when it lists the
// change (digest.mjs leverChanges). -> the entries appended.
export function recordLeverDecision(events, { slug, repo = null, state }) {
  try {
    const entries = (events ?? []).map((e) => leverDecision(e, { slug, repo })).filter(Boolean);
    return entries.length ? appendDecisions(entries, state) : [];
  } catch (err) {
    process.stderr.write(`lever-changes: ${slug}'s decision log in ${state} refused a lever decision: ${err.message}\n`);
    return [];
  }
}

// ---- the digest's line ---------------------------------------------------------------------------------
const pct = (v) => (v == null || !Number.isFinite(v) ? '?' : `${v > 0 ? '+' : ''}${Math.round(v * 100) || 0}%`);
const ratioPct = (v) => (v == null || !Number.isFinite(v) ? null : v - 1);

// The evidence an evaluation's transition carries, as one clause: the mechanism metric's change with its
// 90% interval, the cost per ticket's, the tickets per arm and the guardrails. Empty with none recorded.
export function evidenceText(e) {
  const parts = [];
  const m = e.mechanism;
  if (m && m.est != null) parts.push(`${m.metric} ${pct(m.est)} (90%: ${pct(m.lo90)} to ${pct(m.hi90)})`);
  const c = e.cost;
  if (c && c.ratio != null) parts.push(`cost per ticket ${pct(ratioPct(c.ratio))} (${pct(ratioPct(c.lo90))} to ${pct(ratioPct(c.hi90))})`);
  const n = e.n;
  if (n && Number.isFinite(n.on) && Number.isFinite(n.off)) {
    const pooled = Number.isFinite(n.pooled_on) && (n.pooled_on !== n.on || n.pooled_off !== n.off) ? ` (${n.pooled_on} vs ${n.pooled_off} pooled)` : '';
    parts.push(`${n.on} vs ${n.off} tickets${pooled}`);
  }
  if (Array.isArray(e.guardrails)) {
    const moved = e.guardrails.filter((g) => g.status !== 'ok');
    parts.push(moved.length ? `guardrails: ${moved.map((g) => `${g.name} ${g.status}`).join(', ')}` : 'no guardrail moved');
  }
  return parts.join(', ');
}

// One lever log event as the digest's Levers section words it, or null for an event that changes no
// lever's state. `decision` is the taken call it was logged as, to name its id and the override; it is
// left off once overridden.
export function changeLine(e, { decision = null, overridden = false, cmd = 'digest.mjs' } = {}) {
  const name = repoName(e.repo);
  let line;
  if (e.kind === 'trip') {
    // The trip's reason opens with the same "<trip> on <ticket>: " the line already gives.
    const trip = `${e.trip ?? e.reason_code} on ${e.ticket}`;
    const why = String(e.reason ?? '').startsWith(`${trip}: `) ? e.reason.slice(trip.length + 2) : e.reason;
    line = `${e.to === 'frozen' ? 'reverted and froze' : 'reverted'} ${e.lever} in ${name} on a hard trip, ${trip}${why ? `: ${why}` : ''}`;
  } else if (e.kind === 'override') {
    line = `overridden ${e.lever} ${e.value ?? e.to ?? '?'} in ${name} by ${e.actor}${e.decision_id ? ` (decision \`${e.decision_id}\`)` : ''}`;
  } else if (e.kind === 'transition' && e.to) {
    const verb = { adopted: 'adopted', reverted: 'reverted', frozen: 'reverted and froze', settled: 'settled' }[e.to] ?? `moved to ${e.to}`;
    const ev = evidenceText(e);
    const why = e.to === 'adopted' || e.to === 'settled' ? '' : ` (${reasonWording(e.reason_code) ?? e.reason_code})`;
    line = `${verb} ${e.lever} in ${name}${why}${ev ? `: ${ev}` : ''}`;
  } else if (e.kind === 'pair' && e.to) {
    // A pair trial's end: adopted, both levers are on together for every ticket.
    const levers = (e.levers ?? []).join(' with ');
    const ev = evidenceText(e);
    line = e.to === 'adopted'
      ? `adopted ${levers} together in ${name}, now its default${ev ? `: ${ev}` : ''}`
      : `${e.to === 'reverted' ? 'ended' : `moved to ${e.to}`} the trial of ${levers} together in ${name}, each kept alone (${reasonWording(e.reason_code) ?? e.reason_code})${ev ? `: ${ev}` : ''}`;
  } else return null;
  if (decision && !overridden) {
    const other = decision.options.find((o) => o !== decision.chose);
    line += ` · id \`${decision.id}\` · override: \`node ${cmd} override ${decision.slug ?? e.repo} ${decision.id} ${other}\``;
  }
  return line;
}

// The lever log event an override of lever decision `d` writes, given the repo's events so far, or
// {why} when it cannot be overridden.
export function overrideEvent(d, choice, events, { registry = REGISTRY, at = new Date().toISOString() } = {}) {
  if (!VALUES.includes(choice)) return { why: `a lever decision is overridden to on or off, not "${choice}"` };
  if (!Object.hasOwn(registry, d.lever)) return { why: `${d.lever} is not a lever the registry declares` };
  const s = leverStatesIn(events, registry)[d.lever];
  return {
    event: {
      kind: 'override', lever: d.lever, actor: BY_HAND, reason_code: 'ben_override', at, from: s.state, to: 'overridden', value: choice, decision_id: d.id,
      reason: `set ${choice} by hand, overriding decision ${d.id} (desk had it ${d.chose})`,
    },
  };
}

// ---- desk-env levers' summary line -----------------------------------------------------------------------
// Each lever in a repo whose levers row reads `auto`, as the summary line words it: `<lever> pinned`, a
// trial's smaller arm against its minimum (`memory trial 31/30`), an adopt's holdback tickets while it
// runs (`wrappers adopted (holdback 23)`), `<lever> overridden off`, or its state. A lever off in the
// repo, by the row or by its state, is left out. -> the line, or null for a row with no `auto`.
export function summaryLine({ slug, states, events, registry = REGISTRY, minPerArm = DECISION_RULE.min_per_arm, now = Date.now() }) {
  if (!Object.values(states ?? {}).includes('auto')) return null;
  const byLever = leverStatesIn(events ?? [], registry);
  const assigns = (events ?? []).filter((e) => e.kind === 'assign');
  const drew = (name, id, arm) => assigns.filter((e) => e.arms?.[name] === arm && e.trial_ids?.[name] === id).length;
  const parts = [];
  for (const [name, l] of Object.entries(registry)) {
    if (states[name] === 'pinned') { parts.push(`${name} pinned`); continue; }
    if (states[name] !== 'auto') continue;
    const s = byLever[name];
    if (s.state === 'off') continue;
    const id = trialId(slug, name, s);
    if (s.state === 'trial') {
      parts.push(`${name} trial ${Math.min(drew(name, id, 'on'), drew(name, id, 'off'))}/${minPerArm[l.layer]}`);
    } else if (inHoldback(s, l, now)) {
      parts.push(`${name} adopted (holdback ${drew(name, id, 'holdback')})`);
    } else if (s.state === 'overridden') {
      parts.push(`${name} overridden ${s.value ?? '?'}`);
    } else parts.push(`${name} ${s.state}`);
  }
  return `levers: ${parts.join(' · ') || 'none managed'}`;
}
