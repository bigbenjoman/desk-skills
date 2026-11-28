// Calendar keys as the Levers view counts them: a day is 'YYYY-MM-DD', a week the day key of its
// Monday, a month 'YYYY-MM'. Pure string arithmetic in UTC, so a key never moves with the machine's
// time zone; the day a moment falls on in the person's zone is desk-env.mjs's localDay.
export const DAY_MS = 86_400_000;
export const keyMs = (k) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
export const addDays = (k, n) => new Date(keyMs(k) + n * DAY_MS).toISOString().slice(0, 10);
export const weekStart = (k) => addDays(k, -((new Date(keyMs(k)).getUTCDay() + 6) % 7));
export const monthOf = (k) => k.slice(0, 7);
export const addMonths = (m, n) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
