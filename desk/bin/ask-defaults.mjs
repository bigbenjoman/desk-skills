// When an ask that offers options (needs-you.mjs ask --options) applies its recommendation by itself:
// at its own `--apply-by`, else the next §3b check-in after it was recorded, unless it must never
// default. One that must never default stays open until the person chooses: its recommendation spends
// money, reaches outside (a customer, a vendor, anyone not on the team), widens a §3 permission, or
// cannot be undone. The session recording the ask says so (--never-default "<why>"); a recommendation
// decisions.mjs reads as an ask category (money, legal, production, customer copy) is one too.
import { CHECKIN_TIME, checkinTimesOf, CONFIG_ROWS } from './config-schema.mjs';
import { askCategoryIn } from './decisions.mjs';

// An option is one word, as a needs-you action is: the ask's text says what each one does.
export const OPTION = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const NEVER_CATEGORIES = new Set(['money', 'legal', 'production', 'customer-copy']);

// The §3b Check-in times row (its raw spans joined) as sorted HH:MM, its default where unset or unread.
export function checkinTimesFrom(raw) {
  const fallback = checkinTimesOf(String(CONFIG_ROWS['checkin-times']?.default ?? '08:00, 17:00'));
  if (raw == null || raw === '' || /^todo\b/i.test(raw)) return fallback;
  const parts = checkinTimesOf(String(raw));
  return parts.length && parts.every((p) => CHECKIN_TIME.test(p)) ? [...new Set(parts)].sort() : fallback;
}

// The first check-in slot after `now` (local time), as a Date.
export function nextCheckin(times, now = new Date()) {
  for (let ahead = 0; ahead < 3; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    for (const t of times) {
      const [h, m] = t.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
      if (at > now) return at;
    }
  }
  return null;
}

// An --apply-by value: an ISO time, or a local HH:MM, the next one after `now`. -> Date, or null unread.
export function applyByOf(word, now = new Date()) {
  const s = String(word ?? '').trim();
  if (CHECKIN_TIME.test(s)) return nextCheckin([s], now);
  const t = /^\d{4}-\d\d-\d\dT/.test(s) ? new Date(s) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
}

// Why an ask with this text and recommendation never applies by itself, or null. `flag`: the session's
// own --never-default reason, which always wins.
export function neverDefault(text, recommended, flag = null) {
  if (flag && String(flag).trim()) return String(flag).trim();
  const c = askCategoryIn(`${text ?? ''} ${recommended ?? ''}`);
  return c && NEVER_CATEGORIES.has(c) ? `it is a ${c.replace('-', ' ')} call, which desk never takes for you` : null;
}

// An ask's deadline as the person reads it: "applies <option> at <HH:MM, or a day and time> unless you
// choose", "never applies by itself: <why>", or null for an ask with no recommendation.
export function deadlineText(a, now = new Date()) {
  if (!a?.recommended) return null;
  if (a.never_default) return `never applies by itself: ${a.never_default}`;
  if (!a.apply_by) return null;
  const at = new Date(a.apply_by);
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const sameDay = at.toDateString() === now.toDateString();
  return `applies ${a.recommended} at ${sameDay ? hm : `${at.toDateString().slice(0, 10)} ${hm}`} unless you choose`;
}
