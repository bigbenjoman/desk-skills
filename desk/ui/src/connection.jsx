import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { loadSnapshot } from './snapshot.js';

const RETRY_S = 5;
const BLOCKED = {
  unreachable: "Can't change anything until the server is back.",
  'signed-out': 'Sign in first: re-run install.sh in Terminal.',
};
// Why writes are off in `view`, or null when they are allowed.
export const blockedIn = (view) => BLOCKED[view] ?? null;
const RECONNECTED = 'Reconnected. Showing live data.';
// Kept for this window only: the server was unreachable when it last looked. Desk.app reloads the page
// once a restarted server signs it in again, so the reconnect toast is shown by the page that loads then.
const DOWN = 'desk:down';
// Kept across reloads: the checkout install.sh ran from, for the not-signed-in body's command.
const CHECKOUT = 'desk:checkout';

const storage = (name) => { try { return globalThis[name] ?? null; } catch { return null; } };
const kept = (name, key) => { try { return storage(name)?.getItem(key) ?? null; } catch { return null; } };
const keep = (name, key, value) => {
  try { if (value == null) storage(name)?.removeItem(key); else storage(name)?.setItem(key, value); } catch { /* storage refused: only the hint is lost */ }
};

// The window's view of the server:
//   view      loading | app | unreachable | signed-out | not-installed | first-run
//   snapshot  the last one read (or kept from an earlier load), null for none
//   setup     /api/setup's answer, null until one is read
//   checkout  the checkout install.sh ran from, null when never read
//   attempt   how many tries in a row the server did not answer
//   left      seconds until the next try while unreachable
//   toast     the one toast showing, or null
// `get` is fetch, `Events` EventSource and `store` Cache Storage; `tickMs` is one second of the countdown.
export function useConnection({ get = (u, o) => fetch(u, o), Events = globalThis.EventSource, store = globalThis.caches, tickMs = 1000 } = {}) {
  const cur = useRef({ view: 'loading', snapshot: null, setup: null, checkout: kept('localStorage', CHECKOUT), attempt: 0, left: 0, toast: null });
  const [state, setState] = useState(cur.current);
  const live = useRef(false);
  const t = useRef({ tick: null, again: null, toast: null, stream: null, checking: null });
  const set = (patch) => {
    if (!live.current) return;
    cur.current = { ...cur.current, ...(typeof patch === 'function' ? patch(cur.current) : patch) };
    setState(cur.current);
  };

  const closeStream = () => { t.current.stream?.close(); t.current.stream = null; };
  const stopTicking = () => { clearInterval(t.current.tick); clearTimeout(t.current.again); t.current.tick = null; t.current.again = null; };
  const toast = (text) => {
    clearTimeout(t.current.toast);
    set({ toast: text });
    t.current.toast = setTimeout(() => set({ toast: null }), 5 * tickMs);
  };

  // The server did not answer: show the copy kept last, and try again every RETRY_S seconds.
  async function down() {
    closeStream();
    keep('sessionStorage', DOWN, '1');
    let copy = null;
    if (!cur.current.snapshot) {
      try { copy = await loadSnapshot({ get: () => Promise.reject(new Error('unreachable')), store }); } catch { copy = null; }
    }
    set((s) => ({ view: 'unreachable', attempt: s.attempt + 1, left: RETRY_S, snapshot: s.snapshot ?? copy, toast: null }));
    if (!live.current) return;
    t.current.tick = setInterval(() => {
      const left = cur.current.left - 1;
      set({ left: Math.max(0, left) });
      if (left <= 0) check();
    }, tickMs);
  }

  async function look() {
    stopTicking();
    let r;
    try { r = await get('/api/setup'); } catch { return down(); }
    if (r.status === 401) { closeStream(); return set({ view: 'signed-out' }); }
    let setup = null;
    if (r.status === 200) { try { setup = await r.json(); } catch { setup = null; } }
    if (setup?.checkout) keep('localStorage', CHECKOUT, setup.checkout);
    const back = kept('sessionStorage', DOWN) != null;
    let view = 'app', snapshot = null;
    if (setup?.installed === false) view = 'not-installed';
    else if (setup?.repos === 0) view = 'first-run';
    else {
      try { snapshot = await loadSnapshot({ get, store }); } catch { return down(); }
    }
    // Desk with no snapshot read is the server answering without its data: not yet reconnected.
    const reconnected = view !== 'app' || snapshot != null;
    if (reconnected) keep('sessionStorage', DOWN, null);
    set((s) => ({ view, setup, attempt: 0, left: 0, checkout: setup?.checkout ?? s.checkout, snapshot: snapshot ?? s.snapshot }));
    if (back && reconnected) toast(RECONNECTED);
    openStream();
  }
  // One look at a time; a look asked for while one runs is that one.
  function check() {
    t.current.checking ??= look().finally(() => { t.current.checking = null; });
    return t.current.checking;
  }

  // The change stream is how the window hears that the server stopped: an error is a reason to look,
  // at once for a stream that was open, and after RETRY_S seconds for one the server refused to open,
  // so a server answering everything but its stream is not asked again in a loop.
  function openStream() {
    if (!Events || t.current.stream || !live.current) return;
    const es = new Events('/api/events');
    t.current.stream = es;
    let opened = false;
    es.onopen = () => { opened = true; };
    es.addEventListener('snapshot', (e) => { opened = true; try { set({ snapshot: JSON.parse(e.data) }); } catch { /* not JSON */ } });
    // A repo set up from the first-run list ends the list: with no batch yet it shows in `home`'s
    // no_batch, and once it has one, as a `repo`.
    const firstRunEnds = () => { if (cur.current.view === 'first-run') check(); };
    // Each change also lands on the snapshot held: `home` carries the machine-wide figures, `repo` one
    // repo's row (null once it has gone), in place.
    const onto = (e, fn) => {
      firstRunEnds();
      try { const d = JSON.parse(e.data); set((s) => (s.snapshot ? { snapshot: fn(s.snapshot, d) } : {})); } catch { /* not JSON */ }
    };
    es.addEventListener('home', (e) => onto(e, (s, d) => ({ ...s, ...d })));
    es.addEventListener('repo', (e) => onto(e, (s, { slug, summary }) => {
      const repos = s.repos ?? [];
      const at = repos.findIndex((r) => r.slug === slug);
      if (!summary) return { ...s, repos: repos.filter((r) => r.slug !== slug) };
      return { ...s, repos: at < 0 ? [...repos, summary] : repos.map((r, i) => (i === at ? summary : r)) };
    }));
    es.onerror = () => {
      if (t.current.stream !== es) return;
      closeStream();
      if (opened) check();
      else t.current.again = setTimeout(check, RETRY_S * tickMs);
    };
  }

  useEffect(() => {
    live.current = true;
    check();
    return () => { live.current = false; stopTicking(); closeStream(); clearTimeout(t.current.toast); };
  }, []);

  const retry = useCallback(() => { check(); }, []);
  const dismiss = useCallback(() => set({ toast: null }), []);
  return { ...state, retry, dismiss };
}

// Why writes are off right now, or null when they are allowed (blockedIn's text).
export const Writes = createContext(null);
export const useWritesBlocked = () => useContext(Writes);
