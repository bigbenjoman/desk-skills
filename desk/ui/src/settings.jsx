// Settings (screen-spec §9.1-9.3, 9.5, 9.6, 9.8), route /settings/<section>: App (the app's own
// preferences, the one place a choice is saved here), Subscriptions, each repo's desk setup and the
// Desk install, all read only. A repo's setup changes through /desk-setup and a subscription in Usage
// & costs; nothing here runs a desk command.
import { useEffect, useRef, useState } from 'react';
import { DENSITIES, THEMES, usePrefsContext } from './color-scheme.js';
import { Button, clock } from './system.jsx';

const SAVED_MS = 2000;
const short = (sha) => String(sha ?? '').slice(0, 8);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
const day = (at) => {
  const d = new Date(at);
  return new Date().toDateString() === d.toDateString() ? `today ${clock(at)}`
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock(at)}`;
};

// One read of a settings route: { data, failed }, read again when `url` changes.
function useRead(get, url) {
  const [state, setState] = useState({ data: null, failed: false });
  useEffect(() => {
    if (!url) return undefined;
    let live = true;
    setState({ data: null, failed: false });
    (async () => {
      try {
        const r = await get(url);
        if (r.status !== 200) throw new Error(String(r.status));
        const data = await r.json();
        if (live) setState({ data, failed: false });
      } catch { if (live) setState({ data: null, failed: true }); }
    })();
    return () => { live = false; };
  }, [get, url]);
  return state;
}

const COULD_NOT = "Couldn't read this from Desk's server. It tries again when you open the page.";
function Skeleton({ rows = 3 }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />)}
    </div>
  );
}
function Header({ title, sub }) {
  return (
    <header className="flex flex-col gap-0.5 pb-4">
      <h1 className="text-base font-semibold tracking-tight">{title}</h1>
      {sub && <p className="text-[13px] text-muted-fg">{sub}</p>}
    </header>
  );
}
function Group({ title, children }) {
  return (
    <section aria-label={title} className="flex flex-col pb-5">
      <h2 className="pb-1.5 text-xs font-medium text-muted-fg">{title}</h2>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">{children}</div>
    </section>
  );
}
const Note = ({ children, tone = 'muted' }) => (
  <p role={tone === 'fail' ? 'alert' : undefined} className={`rounded-md border px-3 py-2 text-[13px] ${tone === 'fail' ? 'border-fail-bd bg-fail-bg' : 'border-border bg-subtle'}`}>{children}</p>
);

// ---- App ------------------------------------------------------------------------------------------

// A choice of one, saved at once: `Saved` shows beside it for 2 s once the file has it.
function Choice({ label, value, options, onPick }) {
  const [saved, setSaved] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const pick = async (v) => {
    if (v === value) return;
    clearTimeout(timer.current);
    setSaved(false);
    if (await onPick(v)) { setSaved(true); timer.current = setTimeout(() => setSaved(false), SAVED_MS); }
  };
  const id = `pref-${label.toLowerCase()}`;
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <span id={id} className="w-28 text-[13px] font-medium">{label}</span>
      <div role="radiogroup" aria-labelledby={id} className="inline-flex rounded-md border border-border bg-muted p-0.5">
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={o === value} onClick={() => pick(o)}
            className={`h-7 rounded-[5px] px-3 text-[13px] ${o === value ? 'bg-background font-medium shadow-sm' : 'text-muted-fg hover:text-foreground'}`}>{cap(o)}</button>
        ))}
      </div>
      {saved && <span role="status" className="flex items-center gap-1 text-[12.5px] text-done"><span aria-hidden="true">✓</span>Saved</span>}
    </div>
  );
}
function AppSection() {
  const { prefs, setPref } = usePrefsContext();
  return (
    <>
      <Header title="App" sub="This window's own display preferences, saved on this Mac. No desk command runs." />
      <Group title="Appearance">
        <Choice label="Theme" value={prefs.theme} options={THEMES} onPick={(v) => setPref('theme', v)} />
        <Choice label="Density" value={prefs.density} options={DENSITIES} onPick={(v) => setPref('density', v)} />
      </Group>
    </>
  );
}

// ---- Subscriptions --------------------------------------------------------------------------------

const BADGE = 'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11.5px] font-medium ring-1 ring-inset';
const badgeTone = (b) => (b === 'Default' ? 'bg-done-bg text-done ring-done-bd' : b === 'Off' ? 'bg-muted text-muted-fg ring-border' : b.startsWith('Pinned') ? 'bg-run-bg text-run ring-run-bd' : 'text-muted-fg ring-border');
function SubscriptionsSection({ get, go, routes }) {
  const { data, failed } = useRead(get, '/api/settings/subscriptions');
  const file = data?.file ?? '~/.config/desk/subscriptions.md';
  const open = routes?.usage ? () => go('/usage/subscriptions') : null;
  return (
    <>
      <Header title="Subscriptions" sub={`This computer · ${file} · read only here`} />
      <div className="flex items-center gap-3 pb-4">
        <p className="text-[13px]">Make a default, pin a repo or add a subscription in Usage & costs, next to each subscription's limits.</p>
        <Button onClick={open ?? undefined} disabled={!open} title={open ? undefined : "Usage & costs isn't in this version of Desk yet."}>Open Subscriptions</Button>
      </div>
      {failed ? <Note tone="fail">{COULD_NOT}</Note> : !data ? <Skeleton /> : data.error ? <Note tone="fail">{data.error}</Note> : (
        <>
          <Group title="On this computer">
            {data.rows.length === 0 && <p className="px-4 py-3 text-[13px] text-muted-fg">No subscription is set up on this computer yet.</p>}
            {data.rows.map((r) => (
              <div key={`${r.tool} ${r.name ?? r.email}`} data-subscription={r.email} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13.5px] font-medium">{r.email}</span>
                  <span className="truncate text-[12.5px] text-muted-fg">{[r.badge === 'Default' ? r.note : r.tool, r.name === 'default' ? null : r.name, r.plan].filter(Boolean).join(' · ')}</span>
                </span>
                {r.badge === 'Off' && <span className="text-[12.5px] text-muted-fg">{r.note}</span>}
                <span className={`ml-auto ${BADGE} ${badgeTone(r.badge)}`} data-badge="">{r.badge}</span>
              </div>
            ))}
          </Group>
          {data.pinned.length > 0 && (
            <Group title="Pinned repos">
              {data.pinned.map((line) => <p key={line} className="px-4 py-2.5 text-[13px]">{line}</p>)}
            </Group>
          )}
        </>
      )}
    </>
  );
}

// ---- a repo's desk setup --------------------------------------------------------------------------

function RepoSection({ get, slug, name }) {
  const { data, failed } = useRead(get, `/api/settings/repos/${encodeURIComponent(slug)}`);
  const groups = data?.rows ? [...new Set(data.rows.map((r) => r.group))] : [];
  return (
    <>
      <Header title={name} sub={`${slug.replace('__', '/')} · read only here`} />
      {failed ? <Note tone="fail">{COULD_NOT}</Note> : !data ? <Skeleton rows={5} /> : data.error ? <Note tone="fail">{data.error}</Note> : (
        <>
          <div className="pb-4"><Note>{`These come from ${name}'s desk setup. To change them, run /desk-setup: it checks each change with you before saving.`}</Note></div>
          {groups.map((g) => (
            <Group key={g} title={g}>
              {data.rows.filter((r) => r.group === g).map((r) => (
                <div key={r.id} data-row={r.id} className="grid grid-cols-[160px_minmax(0,180px)_1fr] items-baseline gap-3 px-4 py-2.5 text-[13px]">
                  <span className="font-medium">{r.label}</span>
                  <span className={r.set ? 'truncate font-mono text-[12.5px]' : 'font-medium text-needs'} title={r.value}>{r.value}</span>
                  <span className="text-muted-fg">{r.meaning}</span>
                </div>
              ))}
            </Group>
          ))}
        </>
      )}
    </>
  );
}

// ---- Desk install ---------------------------------------------------------------------------------

const CHECK_WORD = { success: '✓ tests passed', pending: '· tests running', failure: '✕ tests failed', unreadable: "◌ tests check couldn't be read" };
const STATE_TONE = { '✓': 'text-done', '✕': 'text-fail', '◌': 'text-muted-fg', '·': 'text-foreground', '●': 'text-run' };
function InstallSection({ get }) {
  const { data, failed } = useRead(get, '/api/settings/install');
  const sub = data ? [`This computer${data.checkout ? ` · installed from ${data.checkout}` : ''}`, data.checked_at ? `Checked GitHub ${clock(data.checked_at)}` : null].filter(Boolean).join(' · ') : 'This computer';
  const u = data?.updates;
  return (
    <>
      <Header title="Desk install" sub={sub} />
      {failed ? <Note tone="fail">{COULD_NOT}</Note> : !data ? <Skeleton rows={4} /> : (
        <>
          <Group title="Desk">
            <div className="flex gap-3 px-4 py-2.5 text-[13px]">
              <span className="w-28 font-medium">Installed</span>
              <span>{data.installed ? <><span className="font-mono text-[12.5px]">{short(data.installed.commit)}</span>{data.installed.at ? ` · installed ${day(data.installed.at)}` : ''}</> : 'No install recorded yet.'}</span>
            </div>
            <div className="flex gap-3 px-4 py-2.5 text-[13px]">
              <span className="w-28 font-medium">GitHub main</span>
              <span>{data.main ? <><span className="font-mono text-[12.5px]">{short(data.main.commit)}</span>{data.main.ahead ? ` · ${plural(data.main.ahead, 'commit')} ahead` : ''}{CHECK_WORD[data.main.check] ? ` · ${CHECK_WORD[data.main.check]}` : ''}</> : 'Not fetched yet.'}</span>
            </div>
            <p data-state-line="" className={`px-4 py-2.5 text-[13px] ${STATE_TONE[data.state.glyph] ?? ''}`}>{data.state.text}</p>
          </Group>
          <p className="-mt-3 pb-5 text-[12.5px] text-muted-fg">desk checks GitHub main about every 5 minutes and installs it by itself once main's tests check passes. It waits while a worker is opening a PR, and while a maintenance window is open.</p>
          <Group title="Skills & plugins">
            <p className="px-4 py-2.5 text-[13px]">
              {!u ? 'Not checked yet. desk checks for skill and plugin updates every 6 hours.'
                : u.count === 0 ? `All up to date · checked ${day(u.at)}.`
                  : `${plural(u.count, 'update')} available · ${u.names.join(' · ')} · checked ${day(u.at)}. desk doesn't install these by itself.`}
            </p>
          </Group>
        </>
      )}
    </>
  );
}

// ---- the screen -----------------------------------------------------------------------------------

// The section `path` opens: { id, slug? }. /settings alone is App.
export function sectionOf(path) {
  const rest = path.replace(/^\/settings\/?/, '');
  const m = /^repos\/([^/]+)$/.exec(rest);
  if (m) { try { return { id: 'repo', slug: decodeURIComponent(m[1]) }; } catch { return { id: 'app' }; } }
  return { id: ['app', 'subscriptions', 'install'].includes(rest) ? rest : 'app' };
}

function NavItem({ on, onClick, children, badge = null }) {
  return (
    <li>
      <button type="button" onClick={onClick} aria-current={on ? 'page' : undefined}
        className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] whitespace-nowrap hover:bg-muted ${on ? 'bg-muted font-medium' : ''}`}>
        <span className="min-w-0 truncate">{children}</span>
        {badge && <span data-badge="install" className="ml-auto rounded-full bg-needs-bg px-1.5 text-[11px] font-medium text-needs ring-1 ring-inset ring-needs-bd">{badge}</span>}
      </button>
    </li>
  );
}

// `path` is /settings/<section>; `go` opens another; `get` is the window's fetch.
export function Settings({ path, go, get, routes }) {
  const s = sectionOf(path);
  const repos = useRead(get, '/api/settings/repos').data ?? [];
  // The skill and plugin updates the server counted (/api/meta), for Desk install's badge only (§9.6):
  // no banner and no Inbox item.
  const updates = useRead(get, '/api/meta').data?.updates;
  const n = updates?.count ?? 0;
  const repo = s.id === 'repo' ? repos.find((r) => r.slug === s.slug) ?? { slug: s.slug, name: s.slug.split('__').pop() } : null;
  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Settings" className="flex w-50 shrink-0 flex-col gap-px overflow-y-auto border-r border-border px-2 py-3">
        <ul className="flex flex-col gap-px">
          <NavItem on={s.id === 'app'} onClick={() => go('/settings/app')}>App</NavItem>
          <NavItem on={s.id === 'subscriptions'} onClick={() => go('/settings/subscriptions')}>Subscriptions</NavItem>
        </ul>
        <div className="px-2.5 pt-3 pb-1 text-xs font-medium text-muted-fg" id="settings-repos">Repos</div>
        <ul aria-labelledby="settings-repos" className="flex flex-col gap-px">
          {repos.map((r) => <NavItem key={r.slug} on={s.id === 'repo' && s.slug === r.slug} onClick={() => go(`/settings/repos/${encodeURIComponent(r.slug)}`)}>{r.name}</NavItem>)}
        </ul>
        <ul className="mt-3 flex flex-col gap-px">
          <NavItem on={s.id === 'install'} onClick={() => go('/settings/install')} badge={n > 0 ? plural(n, 'update') : null}>Desk install</NavItem>
        </ul>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-160">
          {s.id === 'app' && <AppSection />}
          {s.id === 'subscriptions' && <SubscriptionsSection get={get} go={go} routes={routes} />}
          {s.id === 'repo' && <RepoSection key={repo.slug} get={get} slug={repo.slug} name={repo.name} />}
          {s.id === 'install' && <InstallSection get={get} />}
        </div>
      </div>
    </div>
  );
}
