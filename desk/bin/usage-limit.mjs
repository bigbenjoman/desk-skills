// The 5-hour usage limit, read from a worker's stream-json log. Claude Code waits for the limit to
// reset and then carries on, so a worker at the limit goes quiet for up to five hours with nothing
// wrong with it: pass.mjs asks this module whether that is why.
//
// Every usage-limit decision is made here, in usageLimit(), and nowhere else. The event it reads is
// the `rate_limit_event` Claude Code writes to the log. Its envelope is recorded from real workers
// (tests/fixtures/usage-limit-allowed.json), but the event at the limit itself has not been captured
// yet: tests/fixtures/usage-limit-five-hour.provisional.json is that envelope with `status: "rejected"`,
// to be replaced by a real capture. An event that looks like a usage limit and does not match it is
// reported as unrecognised and never parsed by guesswork, so the pass falls back to the stall check.

const TYPE = 'rate_limit_event';
// Traffic under the limit: one of these follows most API calls and says nothing about a pause.
const UNDER = new Set(['allowed', 'allowed_warning']);

// -> { limits: [{ kind: 'limit', resetsAt, resumed }], unrecognised: [snippet],
//      last: <the latest limit> | { kind: 'unrecognised' } | null }
// `resetsAt` is epoch seconds. A limit has `resumed` once the model answered again after it. `last`
// is the latest usage-limit event of either kind, the one that describes the worker now; `limits`
// lists every recognised one, so each resume can be recorded, and `unrecognised` every other one.
export function usageLimit(text) {
  const limits = [];
  const unrecognised = [];
  let last = null;
  for (const line of String(text ?? '').split('\n')) {
    // The worker's own turns: an answer from the model after a limit means the window reset.
    if (line.startsWith('{"type":"assistant"')) {
      if (last?.kind === 'limit') last.resumed = true;
      continue;
    }
    // Only a top-level event counts. The same text inside a tool call or its result (a grep of an
    // older log, say) is not this worker reaching the limit.
    if (!line.startsWith(`{"type":"${TYPE}"`)) continue;
    let ev = null;
    try { ev = JSON.parse(line); } catch { /* unrecognised, below */ }
    const info = ev?.rate_limit_info;
    if (info && UNDER.has(info.status)) continue;
    if (info?.status === 'rejected' && info.rateLimitType === 'five_hour'
      && Number.isFinite(info.resetsAt) && info.resetsAt > 0) {
      last = { kind: 'limit', resetsAt: info.resetsAt, resumed: false };
      limits.push(last);
    } else {
      last = { kind: 'unrecognised' };
      unrecognised.push(line.length > 200 ? `${line.slice(0, 200)}…` : line);
    }
  }
  return { limits, unrecognised, last };
}

// The reset time as the report prints it, in UTC so every reader sees the same instant.
export const resetText = (resetsAt) => `${new Date(resetsAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
