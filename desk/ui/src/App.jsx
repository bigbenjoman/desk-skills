import { useColorScheme } from './color-scheme.js';
import { blockedIn, useConnection, Writes } from './connection.jsx';
import { clock, FirstRun, NotInstalled, SignedOut, Toast, Unreachable } from './system.jsx';

// Opens Terminal running /desk-setup in one of the repos /api/setup found.
const openFolder = (get) => (folder) => get('/api/terminal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }),
});

function Body({ c, get }) {
  if (c.view === 'unreachable') return <Unreachable snapshot={c.snapshot} attempt={c.attempt} left={c.left} onRetry={c.retry} />;
  if (c.view === 'signed-out') return <SignedOut checkout={c.checkout} />;
  if (c.view === 'not-installed') return <NotInstalled />;
  if (c.view === 'first-run') return <FirstRun found={c.setup?.found ?? []} open={openFolder(get)} />;
  return (
    <main className="flex h-full flex-col items-center justify-center gap-1 bg-background text-foreground">
      <h1 className="text-base font-semibold">Desk</h1>
      {c.snapshot?.at && <p className="text-xs text-muted-fg">As of {clock(c.snapshot.at)}</p>}
    </main>
  );
}

// `deps` stands in for fetch, EventSource, Cache Storage and the countdown's second (useConnection).
export default function App({ deps = {} }) {
  useColorScheme();
  const c = useConnection(deps);
  const get = deps.get ?? ((u, o) => fetch(u, o));
  return (
    <Writes.Provider value={blockedIn(c.view)}>
      <Body c={c} get={get} />
      <Toast text={c.toast} onDismiss={c.dismiss} />
    </Writes.Provider>
  );
}
