// Which Claude login new work starts on. A login's room is what its tighter window leaves, from the
// readings desk already takes (usage-pace.mjs). Logins in rotation come first, and standby logins
// only when no login in rotation can take it: one at 100% cannot, and one with no reading yet might.
import { WINDOWS, windowUse } from './usage-pace.mjs';

// What a reading leaves at `now`: room and weekly use in percent, each null with no reading of it. A
// window the subscription lacks does not count, and one past its reset reads 0% used.
//   -> { room, weekly }
export function loginRoom(reading, now) {
  const use = (w) => windowUse(w, now).pct;
  const read = WINDOWS.map((k) => reading?.[k]).filter(Boolean);
  return { room: read.length ? 100 - Math.max(...read.map(use)) : null, weekly: reading?.seven_day ? use(reading.seven_day) : null };
}

const canTake = (c) => c.room == null || c.room > 0;
const tier = (c) => (c.room == null ? 1 : c.room > 0 ? 0 : 2);
// Known room before unknown, and a login at 100% last. The most room wins, then the lower weekly use,
// then the fewest workers running there, then the listing order.
const best = (a, b) => tier(a) - tier(b) || (b.room ?? 0) - (a.room ?? 0) || (a.weekly ?? 101) - (b.weekly ?? 101) || a.running - b.running;

// `candidates` are the usable logins (logins.mjs), each as { login, reading, running }. With every
// login out it still names one, so the preflight meets the limit and the batch holds on it.
//   -> login | null with no candidate
export function chooseLogin(candidates, now = Date.now()) {
  const scored = candidates.map((c) => ({ ...c, ...loginRoom(c.reading, now) }));
  const rotation = scored.filter((c) => c.login.rule === 'in rotation');
  const standby = scored.filter((c) => c.login.rule === 'standby');
  const pool = rotation.some(canTake) ? rotation : standby.some(canTake) ? standby : rotation.length ? rotation : standby;
  return [...pool].sort(best)[0]?.login ?? null;
}
