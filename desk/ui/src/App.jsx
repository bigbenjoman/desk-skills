import { useState } from 'react';
import { useColorScheme } from './color-scheme.js';
import { Frame } from './frame.jsx';
import { ROUTES, screenAt } from './routes.js';
import { blockedIn, useConnection, Writes } from './connection.jsx';
import { clock, FirstRun, NotInstalled, SignedOut, Toast, Unreachable } from './system.jsx';

// Opens Terminal running /desk-setup in one of the repos /api/setup found.
const openFolder = (get) => (folder) => get('/api/terminal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }),
});

function Body({ c, get, routes }) {
  const [path, go] = useState('/');
  if (c.view === 'unreachable') return <Unreachable snapshot={c.snapshot} attempt={c.attempt} left={c.left} onRetry={c.retry} />;
  if (c.view === 'signed-out') return <SignedOut checkout={c.checkout} />;
  if (c.view === 'not-installed') return <NotInstalled />;
  if (c.view === 'first-run') return <FirstRun found={c.setup?.found ?? []} open={openFolder(get)} />;
  const screen = screenAt(path, routes);
  const Screen = screen ? routes[screen.id] : null;
  return (
    <Frame snapshot={c.snapshot} live={c.view === 'app'} path={screen ? path : '/'} go={go} routes={routes} title={screen?.label ?? null}>
      {Screen ? <Screen path={path} go={go} snapshot={c.snapshot} /> : (
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
