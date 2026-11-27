// What the Usage & costs screen, its banners and its sidebar badge read from the snapshot's
// `subscriptions` (desk-q-model subscriptionsJson): every figure, and every time said the screen's way.
import { useEffect, useState } from 'react';
import { clock } from './system.jsx';

const WEEK_MS = 7 * 24 * 3600 * 1000;

// The clock the screen and the banners draw with, moved on every 30 s.
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// "Tue 08:00": a reset or a projection, its weekday and its time.
export function dayTime(ms) {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${clock(ms)}`;
}

// A limit's window as the screen names it, "7-day"; null for a limit no window is named for (a hold
// whose type is `unknown`), which the copy then calls the usage limit.
const WINDOW_WORD = { five_hour: '5-hour', seven_day: '7-day' };
export const windowWord = (type) => WINDOW_WORD[type] ?? null;

// "a", "a and b", "a, b and c".
export const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// The Claude subscription repos run on when nothing pins them, or null.
export const defaultSub = (subs) => subs?.claude?.find((s) => s.state === 'default') ?? null;

// A 7-day window's projection at its use so far, linear from the window's start:
//   -> { at, hours } when it fills before it resets (`hours` before the reset), else null.
export function paceOf(w, now) {
  if (!w || !(w.pct > 0) || w.pct >= 100) return null;
  const start = w.resets_at - WEEK_MS;
  if (now <= start || now >= w.resets_at) return null;
  const at = start + (now - start) / (w.pct / 100);
  if (at >= w.resets_at) return null;
  return { at, hours: Math.round((w.resets_at - at) / 3600000) };
}

// A window's word, beside its colour and never instead of it (screen-spec §11.1).
export function level(pct, limited) {
  // Only a limit says Limit reached: a reading rounds 99.6% up to 100 with nothing holding yet.
  if (limited) return { word: 'Limit reached', tone: 'fail' };
  if (pct >= 90) return { word: 'Tight', tone: 'fail' };
  if (pct >= 70) return { word: 'Watch', tone: 'needs' };
  return { word: 'Fine', tone: 'done' };
}

// The subscription's limit on its 7-day window, or null.
export const weekLimit = (s) => (s?.limit?.type === 'seven_day' ? s.limit : null);

// The probe stamp: "Checked 10:05 · next 10:10", or stale once the reading is over two intervals old.
export function probeStamp(subs, now) {
  // The default's reading, else (with the default off) the first Claude subscription read.
  const at = defaultSub(subs)?.reading?.at ?? subs?.claude?.find((s) => s.reading?.at != null)?.reading.at;
  const every = subs?.probe_every_ms ?? 5 * 60000;
  if (at == null) return { stale: true, text: '◌ No probe reading yet' };
  if (now - at > 2 * every) return { stale: true, text: `◌ Probe stale: last read ${clock(at)}` };
  return { stale: false, text: `Checked ${clock(at)} · next ${clock(at + every)}` };
}

// The sidebar's Usage & costs figure: the fullest window of any Claude subscription a repo runs on and
// of the Codex default every review runs on, amber from 85%. -> { pct, hot } | null
export function usageBadge(subs) {
  const inUse = [...(subs?.claude ?? []).filter((s) => s.state === 'default' || s.state === 'pinned'), ...(subs?.codex ?? []).filter((s) => s.state === 'default')];
  const pcts = inUse.flatMap((s) => [s.reading?.seven_day?.pct, s.reading?.five_hour?.pct]).filter((p) => Number.isFinite(p));
  if (!pcts.length) return null;
  const pct = Math.max(...pcts);
  return { pct, hot: pct >= 85 };
}

// The pace banner's step: shown again once the window passes the next 5% after a dismissal.
export const step = (pct) => Math.floor(pct / 5) * 5;
