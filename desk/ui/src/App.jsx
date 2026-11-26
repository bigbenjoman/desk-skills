import { useState } from 'react';
import { useColorScheme } from './color-scheme.js';
import { Frame, WINDOW_DRAG } from './frame.jsx';
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

function Body({ c, get, routes }) {
  const [path, go] = useState('/');
  const card = systemView(c, get);
  // The window has no native title bar, so a card keeps the top 40 px to drag it by.
  if (card) return <>{card}<div aria-hidden="true" data-drag="" style={WINDOW_DRAG} className="fixed inset-x-0 top-0 h-10" /></>;
  const screen = screenAt(path, routes);
  const Screen = screen ? routes[screen.id] : null;
  return (
    <Frame snapshot={c.snapshot} live={c.view === 'app'} path={screen ? path : '/'} go={go} routes={routes} title={screen?.label ?? null}>
      {Screen ? <Screen path={path} go={go} snapshot={c.snapshot} get={get} /> : (
        <main className="flex h-full flex-col items-center justify-center gap-1">
          <h1 className="text-base font-semibold">Desk</h1>
          {c.snapshot?.at && <p className="text-xs text-muted-fg">As of {clock(c.snapshot.at)}</p>}
        </main>
      )}
    </Frame>
  );
}

// `deps` stands in for fetch, EventSource, Cache Storage and the countdown's second (useConnection),
// and `routes` for the screens that exist (routes.js ROUTES).
export default function App({ deps = {} }) {
  useColorScheme();
  const c = useConnection(deps);
  const get = deps.get ?? ((u, o) => fetch(u, o));
  return (
    <Writes.Provider value={blockedIn(c.view)}>
      <Body c={c} get={get} routes={deps.routes ?? ROUTES} />
      <Toast text={c.toast} onDismiss={c.dismiss} />
    </Writes.Provider>
  );
}
