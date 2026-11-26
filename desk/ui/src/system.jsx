// The bodies the window shows in place of Desk while it cannot show Desk: the server down, the window
// not signed in, desk not installed, and no repo set up yet; and the toast. Copy is screen-spec §2.7-2.10.
import { useEffect, useRef, useState } from 'react';
import { useWritesBlocked } from './connection.jsx';

export const KICKSTART = 'launchctl kickstart -k gui/$(id -u)/com.desk-skills.ui';
export const CLONE = 'git clone https://github.com/bigbenjoman/desk-skills && cd desk-skills && ./install.sh';
const DEFAULT_CHECKOUT = '~/studia/desk-skills';
const clock = (at) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const BUTTON = {
  primary: 'border-primary bg-primary text-primary-fg',
  outline: 'border-border bg-background text-foreground',
  secondary: 'border-border bg-secondary text-secondary-fg',
};
export function Button({ variant = 'secondary', className = '', ...props }) {
  return (
    <button type="button" {...props}
      className={`inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-[13px] font-medium disabled:opacity-50 ${BUTTON[variant]} ${className}`} />
  );
}

// A button that changes something: off, with the reason as its tooltip, while writes are blocked. The
// tooltip sits on a wrapper because a disabled button gets no hover.
export function WriteButton({ disabled = false, ...props }) {
  const blocked = useWritesBlocked();
  return (
    <span className="inline-flex" title={blocked ?? undefined}>
      <Button {...props} disabled={disabled || !!blocked} />
    </span>
  );
}

function Copy({ text }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }, () => {});
  };
  return <Button onClick={copy} aria-label={`Copy ${text}`}>{copied ? 'Copied' : 'Copy'}</Button>;
}

export function Command({ text }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted py-2 pr-2 pl-3">
      <code className="flex-1 font-mono text-[12.5px] break-all select-all">{text}</code>
      <Copy text={text} />
    </div>
  );
}

function Card({ width = 'w-[520px]', children, ...props }) {
  return (
    <main className="flex h-full items-center justify-center bg-background p-10 text-foreground">
      <section {...props} className={`${width} flex flex-col gap-3.5 rounded-lg border border-border bg-card p-6 shadow-md`}>{children}</section>
    </main>
  );
}

export function Unreachable({ snapshot, attempt, left, onRetry }) {
  return (
    <Card aria-labelledby="unreachable-title">
      <h2 id="unreachable-title" className="text-lg font-semibold tracking-tight">Desk can't reach its local server</h2>
      <p>
        The desk-ui server on 127.0.0.1:4823 isn't answering. Your queues are safe: workers and the supervisor keep running without it.
        {snapshot?.at && <> You're looking at the copy from {clock(snapshot.at)}.</>}
      </p>
      <Command text={KICKSTART} />
      <div className="flex items-center gap-2.5 border-t border-border pt-3.5" role="status">
        <span className="flex-1 text-[13px] text-muted-fg tabular-nums">
          {left > 0 ? `Trying again in ${left} s… (attempt ${attempt})` : `Trying again… (attempt ${attempt})`}
        </span>
        <Button variant="primary" onClick={onRetry}>Try now</Button>
      </div>
    </Card>
  );
}

export function SignedOut({ checkout }) {
  return (
    <Card aria-labelledby="signed-out-title">
      <h2 id="signed-out-title" className="text-lg font-semibold tracking-tight">This window isn't signed in to Desk</h2>
      <p>Re-run install.sh in Terminal. It writes Desk's sign-in again, and this window signs in by itself.</p>
      <Command text={`cd ${checkout || DEFAULT_CHECKOUT} && ./install.sh`} />
    </Card>
  );
}

export function NotInstalled() {
  return (
    <Card width="w-[560px]" aria-labelledby="not-installed-title">
      <h2 id="not-installed-title" className="text-[17px] font-semibold">Desk isn't installed on this Mac yet.</h2>
      <p className="text-muted-fg">Install it, then reopen this window.</p>
      <Command text={CLONE} />
    </Card>
  );
}

// The git repos under ~/studia, each with Set up, which opens Terminal running /desk-setup there.
export function FirstRun({ found, open }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const setUp = async (name) => {
    setBusy(name); setNote(null);
    let ok = false;
    try { ok = (await open(name)).status === 200; } catch { ok = false; }
    setBusy(null);
    setNote(ok ? { name, text: `Terminal is running /desk-setup in ${name}. This list goes once it's set up.` }
      : { name, text: `Terminal didn't open for ${name}. Try again, or run /desk-setup there yourself.`, failed: true });
  };
  return (
    <main className="flex h-full justify-center overflow-auto bg-background px-10 py-18 text-foreground">
      <section className="flex w-[640px] flex-col gap-4.5" aria-labelledby="first-run-title">
        <div className="flex flex-col gap-1.5">
          <h2 id="first-run-title" className="text-2xl font-semibold tracking-tight">Set up desk in your first repo</h2>
          <p className="text-muted-fg">
            {found.length
              ? `Desk found ${found.length} git ${found.length === 1 ? 'repo' : 'repos'} under ~/studia. Set up opens Terminal running /desk-setup in that folder.`
              : 'Desk found no git repos under ~/studia. Clone one there, then reopen this window.'}
          </p>
        </div>
        {found.length > 0 && (
          <ul className="overflow-hidden rounded-lg border border-border bg-card">
            {found.map((r, i) => (
              <li key={r.name} className={`flex flex-col gap-1 px-4 py-3 ${i ? 'border-t border-border' : ''}`}>
                <div className="flex items-center gap-3">
                  <div className="flex flex-1 flex-col">
                    <span className="font-medium">{r.name}</span>
                    <span className="font-mono text-xs text-muted-fg">{r.path}</span>
                  </div>
                  <WriteButton variant={i === 0 ? 'primary' : 'outline'} disabled={busy !== null} onClick={() => setUp(r.name)}
                    aria-label={`Set up ${r.name}`}>
                    {busy === r.name ? 'Opening…' : 'Set up'}
                  </WriteButton>
                </div>
                {note?.name === r.name && <p role={note.failed ? 'alert' : 'status'} className={`text-[13px] ${note.failed ? 'text-fail' : 'text-muted-fg'}`}>{note.text}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[13px] text-muted-fg">Desk only acts in repos you set up.</p>
      </section>
    </main>
  );
}

export function Toast({ text, onDismiss }) {
  if (!text) return null;
  return (
    <div className="fixed right-4 bottom-4 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 text-[13.5px] shadow-lg" role="status">
      <span className="text-done" aria-hidden="true">✓</span>
      <span>{text}</span>
      <Button variant="outline" onClick={onDismiss} aria-label="Dismiss">Dismiss</Button>
    </div>
  );
}
