import { useCallback, useEffect, useState } from 'react';
import { Prefs, useColorScheme, usePrefs } from './color-scheme.js';
import { Frame, WINDOW_DRAG } from './frame.jsx';
import { keep, kept, saveKept, useKept } from './kept.js';
import { ROUTES, screenAt } from './routes.js';
import { blockedIn, useConnection, Writes } from './connection.jsx';
import { clock, FirstRun, NotInstalled, SignedOut, Toast, Unreachable } from './system.jsx';

// Opens Terminal running /desk-setup in one of the repos /api/setup found.
const openFolder = (get) => (folder) => get('/api/terminal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }),
});

// The card a system state shows in place of the frame, or null once the frame shows.
function systemView(c, get) {
  if (c.view === 'unreachable') return <Unreachable snapshot={c.snapshot} attempt={c.attempt} left={c.left} onRetry={c.retry} />;
  if (c.view === 'signed-out') return <SignedOut checkout={c.checkout} />;
  if (c.view === 'not-installed') return <NotInstalled />;
  if (c.view === 'first-run') return <FirstRun found={c.setup?.found ?? []} open={openFolder(get)} />;
  return null;
}

// §2.5's app banners. `Later` hides App updated until Desk next comes to the front at least an hour on.
export const LATER_MS = 60 * 60 * 1000;
const FAILED_SEEN = 'desk:build-failed-dismissed';
export const reloadApp = () => { saveKept(); window.location.reload(); };

function useAppBanners(c, get, reload) {
  const [later, setLater] = useState(null);
  const [failedSeen, setFailedSeen] = useState(() => kept('localStorage', FAILED_SEEN));
  useEffect(() => {
    if (later == null) return undefined;
    const back = () => { if (Date.now() - later >= LATER_MS) setLater(null); };
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [later]);
  const updated = c.app?.updated && later == null;
  useEffect(() => {
    if (!updated) return undefined;
    const key = (e) => { if (e.metaKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'r') { e.preventDefault(); reload(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [updated, reload]);
  const out = [];
  if (updated) {
    out.push({ id: 'app-updated', tone: 'info', glyph: null, body: 'Desk updated. Reload to use the new version of the app.',
      actions: [{ label: 'Reload ⌘R', run: reload }, { label: 'Later', run: () => setLater(Date.now()) }] });
  }
  if (c.view === 'restarting') {
    const copy = c.snapshot?.at ? ` You're looking at the copy from ${clock(c.snapshot.at)}.` : '';
    out.push({ id: 'restarting', tone: 'info', glyph: '◌', body: `Desk's server is restarting after an update. Reconnecting…${copy}`, action: null });
  }
  const failed = c.app?.failed;
  if (failed && failed !== failedSeen) {
    out.push({ id: 'app-failed', tone: 'warn', glyph: '!', body: "Desk updated, but the app's new version didn't build. You're on the previous app version.",
      sub: 'The update itself still applies: supervisors and workers run the new desk code. Only the window stays on the previous app.',
      actions: [
        { label: 'Open install log', run: () => { get('/api/settings/install-log', { method: 'POST' }).catch(() => {}); } },
        { label: 'Dismiss', run: () => { keep('localStorage', FAILED_SEEN, failed); setFailedSeen(failed); } },
      ] });
  }
  return out;
}

function Body({ c, get, routes, reload }) {
  // Kept across a reload for a new app, so the window comes back on the same screen (§2.5).
  const [path, go] = useKept('path', '/');
  const banners = useAppBanners(c, get, reload);
  const card = systemView(c, get);
  // The window has no native title bar, so a card keeps the top 40 px to drag it by.
  if (card) return <>{card}<div aria-hidden="true" data-drag="" style={WINDOW_DRAG} className="fixed inset-x-0 top-0 h-10" /></>;
  const screen = screenAt(path, routes);
  const Screen = screen ? routes[screen.id] : null;
  return (
    <Frame snapshot={c.snapshot} live={c.view === 'app'} path={screen ? path : '/'} go={go} routes={routes} title={screen ? screen.title?.(path) ?? screen.label : null} banners={banners}>
      {Screen ? <Screen path={path} go={go} snapshot={c.snapshot} get={get} routes={routes} /> : (
        <main className="flex h-full flex-col items-center justify-center gap-1">
          <h1 className="text-base font-semibold">Desk</h1>
          {c.snapshot?.at && <p className="text-xs text-muted-fg">As of {clock(c.snapshot.at)}</p>}
        </main>
      )}
    </Frame>
  );
}

// `deps` stands in for fetch, EventSource, Cache Storage and the countdown's second (useConnection),
// `routes` for the screens that exist (routes.js ROUTES), `desk` for Desk.app's bridge (window.desk)
// and `reload` for reloading the window.
export default function App({ deps = {} }) {
  const prefs = usePrefs(deps.desk ?? globalThis.window?.desk);
  useColorScheme(document.documentElement, prefs.prefs);
  const c = useConnection(deps);
  // One function for the window's life: a screen reads again when the `get` it holds changes.
  const fallback = useCallback((u, o) => fetch(u, o), []);
  const get = deps.get ?? fallback;
  return (
    <Prefs.Provider value={prefs}>
      <Writes.Provider value={blockedIn(c.view)}>
        <Body c={c} get={get} routes={deps.routes ?? ROUTES} reload={deps.reload ?? reloadApp} />
        <Toast text={c.toast} onDismiss={c.dismiss} />
      </Writes.Provider>
    </Prefs.Provider>
  );
}
