import { useEffect, useState } from 'react';
import { useColorScheme } from './color-scheme.js';
import { loadSnapshot } from './snapshot.js';

const clock = (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function useSnapshot() {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    let live = true;
    loadSnapshot()
      .then((s) => { if (live && s) setSnapshot(s); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return snapshot;
}

export default function App() {
  useColorScheme();
  const snapshot = useSnapshot();
  return (
    <main className="flex h-full flex-col items-center justify-center gap-1 bg-background text-foreground">
      <h1 className="text-base font-semibold">Desk</h1>
      {snapshot?.at && <p className="text-xs text-muted-fg">As of {clock(snapshot.at)}</p>}
    </main>
  );
}
