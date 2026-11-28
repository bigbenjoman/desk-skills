import { useEffect, useRef, useState } from 'react';

// State that survives a reload of the window and nothing else (screen-spec §2.5: reloading for a new
// app keeps an unsent answer, the Inbox position and its filters). Each value is written to
// sessionStorage as the page goes away (pagehide, or saveKept() before a reload) and read back once by
// the next page: a screen opened again later in the same page starts fresh.
const live = new Map(); // key -> () => its current value
const restored = new Map(); // key -> the value the last page left, until a mount takes it
let armed = false;

// Web Storage (`name` localStorage or sessionStorage) that a refusal never throws from.
export const storage = (name) => { try { return globalThis[name] ?? null; } catch { return null; } };
export const kept = (name, key) => { try { return storage(name)?.getItem(key) ?? null; } catch { return null; } };
// A null `value` removes the key.
export const keep = (name, key, value) => {
  try { if (value == null) storage(name)?.removeItem(key); else storage(name)?.setItem(key, value); } catch { /* storage refused: only the hint is lost */ }
};
const session = () => storage('sessionStorage');
const PREFIX = 'desk:kept:';

// Writes every kept value now: Reload calls it before location.reload(), and the connection before a
// system card takes the window's place, since that unmounts the screens holding them.
export function saveKept() {
  const s = session();
  if (!s) return;
  for (const [key, value] of live) { try { s.setItem(PREFIX + key, JSON.stringify(value())); } catch { /* storage refused: only the restore is lost */ } }
}
function arm() {
  if (armed || typeof window === 'undefined') return;
  armed = true;
  window.addEventListener('pagehide', saveKept);
}
// Everything saved, moved out of storage at a read, so a value survives one reload only: one no screen
// mounted for (an item gone from the list) is not written again, and the reload after drops it.
function drain() {
  const s = session();
  try {
    const keys = [];
    for (let i = 0; i < (s?.length ?? 0); i++) { const k = s.key(i); if (k?.startsWith(PREFIX)) keys.push(k); }
    for (const k of keys) {
      const raw = s.getItem(k);
      s.removeItem(k);
      try { restored.set(k.slice(PREFIX.length), JSON.parse(raw)); } catch { /* unreadable: starts fresh */ }
    }
  } catch { /* storage refused: nothing is restored */ }
}
// What the last page left under `key`; React may call an initialiser twice.
function take(key) {
  drain();
  return restored.get(key);
}

// useState, kept across a reload under `key`.
export function useKept(key, initial) {
  const [value, setValue] = useState(() => { const v = take(key); return v === undefined ? initial : v; });
  const now = useRef(value);
  now.current = value;
  useEffect(() => {
    arm();
    restored.delete(key); // taken: a later mount in this page starts from `initial`
    const read = () => now.current;
    live.set(key, read);
    return () => { if (live.get(key) === read) live.delete(key); };
  }, [key]);
  return [value, setValue];
}
