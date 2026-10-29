// The usage limit, read from a worker's stream-json log. Whichever limit it is (5-hour, weekly or one
// Claude Code names some other way), a headless worker ends its session at it with nothing wrong with
// its work: pass.mjs asks this module whether that is why, and holds the batch rather than failing it.
//
// Every usage-limit decision is made here, in usageLimit(), and nowhere else. Two events say so: the
// `rate_limit_event` Claude Code writes when a call is rejected (tests/fixtures/usage-limit-allowed.json
// is the envelope recorded from real workers), and the `result` that ends the session with HTTP 429.
// A rate_limit_event that matches neither the traffic under the limit nor a rejection is reported as
// unrecognised and never parsed by guesswork, so the pass falls back to the stall check.

const TYPE = 'rate_limit_event';
// Traffic under the limit: one of these follows most API calls and says nothing about a pause.
const UNDER = new Set(['allowed', 'allowed_warning']);

// -> { limits: [{ kind: 'limit', type, resetsAt, resumed }], unrecognised: [snippet],
//      last: <the latest limit> | { kind: 'unrecognised' } | null }
// `type` is the event's rateLimitType (`five_hour`, `seven_day`, …), or `unknown` where it names none.
// `resetsAt` is epoch seconds, or null where the limit carries no reset time. A limit has `resumed`
// once the model answered again after it. `last` is the latest usage-limit event of either kind, the
// one that describes the worker now; `limits` lists every recognised one, so each resume can be
// recorded, and `unrecognised` every other one.
export function usageLimit(text) {
  const limits = [];
  const unrecognised = [];
  let last = null;
  const reached = (type, resetsAt) => {
    last = { kind: 'limit', type: type || 'unknown', resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null, resumed: false };
    limits.push(last);
  };
  for (const line of String(text ?? '').split('\n')) {
    // The worker's own turns: an answer from the model after a limit means it lifted.
    if (line.startsWith('{"type":"assistant"')) {
      if (last?.kind === 'limit') last.resumed = true;
      continue;
    }
    // A session that ended on HTTP 429. Its rejection is usually recorded just before it; one that is
    // not is a limit of its own, with no type or reset time. Only a top-level result counts: the same
    // text quoted inside a tool result is escaped, and is not this worker reaching the limit.
    if (line.includes('"api_error_status":429')) {
      let ev = null;
      try { ev = JSON.parse(line); } catch { /* not an event */ }
      if (ev?.type === 'result' && ev.api_error_status === 429 && !(last?.kind === 'limit' && !last.resumed)) reached('unknown', null);
      continue;
    }
    // Only a top-level event counts, for the same reason.
    if (!line.startsWith(`{"type":"${TYPE}"`)) continue;
    let ev = null;
    try { ev = JSON.parse(line); } catch { /* unrecognised, below */ }
    const info = ev?.rate_limit_info;
    if (info && UNDER.has(info.status)) continue;
    if (info?.status === 'rejected') reached(info.rateLimitType, info.resetsAt);
    else {
      last = { kind: 'unrecognised' };
      unrecognised.push(line.length > 200 ? `${line.slice(0, 200)}…` : line);
    }
  }
  return { limits, unrecognised, last };
}

// The limit by name, as the report and desk-q print it: "the weekly usage limit".
const NAMES = { five_hour: '5-hour', seven_day: 'weekly' };
export function limitName(type) {
  const n = NAMES[type] ?? (type && type !== 'unknown' ? type.replace(/_/g, ' ') : null);
  return n ? `the ${n} usage limit` : 'the usage limit';
}

// The reset time as the report prints it, in UTC so every reader sees the same instant.
export const resetText = (resetsAt) => `${new Date(resetsAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
