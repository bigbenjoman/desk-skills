// Claude's fallback login (logins.mjs fallbackOf): new work of a repo following the default starts there
// while the default is full, and on the default again once it has room. Only new sessions move: a
// resumed one stays on the login it started on, waiting for that login's reset, so nothing moves
// mid-session. The pass reads the default each time; these decide on what it read, and run nothing.
import { fullWindow } from './usage-pace.mjs';
import { limitName } from './usage-limit.mjs';
import { untilText } from './pass/shared.mjs';

// Whether the default login is full. Snapshot:
//   hold     a usage limit still holding the default ({ type, resetsAt }): a refused preflight or a paused
//            worker's (the queue's usage_hold), or the limit the last switch was for; null with none or
//            once it has lifted
//   reading  the default's newest reading (usage-pace.mjs newestReading), or null
//   pace     usage-pace.mjs usagePace on that reading, or null
//   now      the time, in ms
//   -> { full, why, limit: { type, resetsAt } | null }; `type` is a window, 'unknown', or 'pace'
export function defaultFull({ hold = null, reading = null, pace = null, now = Date.now() } = {}) {
  if (hold) return { full: true, why: `at ${limitName(hold.type)}${untilText(hold)}`, limit: { type: hold.type ?? 'unknown', resetsAt: hold.resetsAt ?? null } };
  const w = fullWindow(reading, now);
  if (w) return { full: true, why: `at ${limitName(w.type)}${untilText(w)}`, limit: w };
  if (pace?.hold && !pace.bad) return { full: true, why: `past the usage pacing headroom (${String(pace.line).replace(/^usage: /, '')})`, limit: { type: 'pace', resetsAt: null } };
  return { full: false, why: null, limit: null };
}

// Which login this pass's new sessions start on, and what the report says. Snapshot:
//   def       the default login, fallback the fallback login (or null)
//   full      defaultFull's answer
//   usable    null when the fallback can take work, else why not ("signed out")
//   record    the queue's login_fallback, the switch the last pass made, or null
//   now       the time, in ms
//   -> { on: 'default' | 'fallback', record: what login_fallback becomes (undefined: unchanged), line: the
//      report's line, or null, held: true when the fallback could not take the work }
export function fallbackCall({ def, fallback, full, usable = null, record = null, now = Date.now() }) {
  if (!fallback) return { on: 'default', record: record ? null : undefined, line: null };
  const name = (l) => (l.configDir ? l.name : 'default');
  if (full.full && !usable) {
    const kept = record && record.login === fallback.name;
    const rec = { since: kept ? record.since : new Date(now).toISOString(), login: fallback.name, why: full.why, type: full.limit?.type ?? null, resets_at: full.limit?.resetsAt ?? null };
    const line = kept ? null : `login: new workers start on fallback login ${name(fallback)}, as default login ${name(def)} is ${full.why}; workers already running stay on their own login`;
    return { on: 'fallback', record: rec, line };
  }
  if (full.full) return { on: 'default', record: record ? null : undefined, held: true, line: `login: default login ${name(def)} is ${full.why}, and fallback login ${name(fallback)} ${usable}, so new workers wait for the default as before` };
  if (record) return { on: 'default', record: null, line: `login: new workers start on default login ${name(def)} again, as it has room; workers on fallback login ${record.login} finish there` };
  return { on: 'default', record: undefined, line: null };
}
