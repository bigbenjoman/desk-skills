// The frame every Desk screen sits in (screen-spec §2.1-2.5): the 40 px title bar, the sidebar (232 px,
// or the 56 px rail in Compact), the banner slot and the 28 px status bar, all read from the live snapshot.
import { useEffect, useState } from 'react';
import { Icon } from './icons.jsx';
import { SCREENS, ticketPath } from './routes.js';

export const SERVER = '127.0.0.1:4823';
// Below this width the window is Compact: Standard's sidebar, list and detail pane need 1192 px.
export const COMPACT_BELOW = 1200;
const NAME_MAX = 20;
const OFFLINE = "You're offline. Queues and logs still update; PR and Jira panels show their last copy.";

// The window has no native title bar (hidden-inset): a region with this style is where it is dragged from.
export const WINDOW_DRAG = { WebkitAppRegion: 'drag' };
const noDrag = { WebkitAppRegion: 'no-drag' };

export function useWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);
  return online;
}

// How long ago `iso` was, as desk-q says it: 12d 14h, 5h 3m, 12m.
export function waited(iso, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}m`;
}

// A repo's name as the sidebar draws it: at most NAME_MAX characters, the rest an ellipsis.
export const shortName = (name) => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name);
const fullName = (slug) => slug.replace('__', '/');

// The link rule (§1.6): ⌘-click, or the ↗ that follows the key on hover and focus, opens the ticket's
// Jira page in the Mac's browser and leaves the window where it was. `browse` is the repo's
// `jira_browse` from the server; with none the key is plain text. A plain click runs `open`, which
// opens the ticket's page where there is one, and does nothing without it.
export function TicketLink({ ticket, browse, open = null }) {
  const url = browse ? `${browse}${ticket}` : null;
  if (!url && !open) return <span className="font-mono text-[.93em] font-medium">{ticket}</span>;
  const click = (e) => {
    e.preventDefault();
    if (url && (e.metaKey || e.target.closest?.('[data-ext]'))) window.desk?.openExternal?.(url);
    else open?.();
  };
  return (
    <a href={url ?? '#'} onClick={click} title={[open && `Open ${ticket}`, url && `⌘-click to open ${ticket} in Jira`].filter(Boolean).join(' · ')} style={noDrag}
      className="group inline-flex items-center gap-0.5 rounded-sm font-mono text-[.93em] font-medium text-foreground no-underline hover:underline hover:decoration-ring hover:underline-offset-3">
      {ticket}
      {url && <span data-ext="" className="hidden group-hover:inline-block group-focus-visible:inline-block"><Icon name="arrow-up-right" size={12} /></span>}
    </a>
  );
}

// The banners due now, highest first in §2.5's priority order. Each is { id, tone, glyph, body, action }.
// A production-broken park and being offline cannot be dismissed; the other banners belong to the
// Usage and Settings screens.
export function bannersFor({ snapshot, online, routes, go }) {
  const out = [];
  for (const r of snapshot?.repos ?? []) {
    for (const key of r.production_broken ?? []) {
      out.push({
        id: `broken ${r.slug} ${key}`, tone: 'crit', glyph: '!',
        body: <>Production is broken in {r.name}: <TicketLink ticket={key} browse={r.jira_browse} open={routes.ticket ? () => go(ticketPath(r.name, key)) : null} /> is waiting for your answer.</>,
        action: routes.inbox ? { label: 'Answer now', run: () => go('/inbox') } : null,
      });
    }
  }
  if (!online) out.push({ id: 'offline', tone: 'info', glyph: null, body: OFFLINE, action: null });
  return out;
}

const TONE = { crit: 'bg-fail-bg border-b-fail-bd', warn: 'bg-needs-bg border-b-needs-bd', info: 'bg-subtle border-b-border' };
const GLYPH = { crit: 'text-fail', warn: 'text-needs', info: 'text-muted-fg' };

function Banner({ b, more = null }) {
  return (
    <div role={b.tone === 'crit' ? 'alert' : 'status'} data-banner={b.id}
      className={`flex h-10 shrink-0 items-center gap-2.5 border-b pr-3 pl-5 text-[13px] text-foreground ${TONE[b.tone]}`}>
      {b.glyph && <span className={`font-semibold ${GLYPH[b.tone]}`}>{b.glyph}</span>}
      <span className="min-w-0 truncate">{b.body}</span>
      <span className="ml-auto flex items-center gap-1.5">
        {b.action && (
          <button type="button" onClick={b.action.run}
            className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2.5 text-[12.5px] font-medium">{b.action.label}</button>
        )}
        {more}
      </span>
    </div>
  );
}

// At most two banners show; the rest wait behind "+n more", which lists them.
export function Banners({ list }) {
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  const rest = list.length - 2;
  const more = rest > 0 && (
    <button type="button" aria-expanded={open} onClick={() => setOpen((x) => !x)}
      className="inline-flex h-7 items-center rounded-md px-2 text-[12.5px] font-medium text-muted-fg hover:bg-muted">
      {open ? 'Show fewer' : `+${rest} more`}
    </button>
  );
  const shown = open ? list : list.slice(0, 2);
  return <div className="flex shrink-0 flex-col">{shown.map((b, i) => <Banner key={b.id} b={b} more={i === 1 ? more : null} />)}</div>;
}

const countText = (n) => (n > 99 ? '99+' : String(n));

function Pill({ needs, broken, onClick }) {
  const n = needs?.count ?? 0;
  const tip = n ? `${n} need${n === 1 ? 's' : ''} you${needs?.oldest_at ? ` · oldest ${waited(needs.oldest_at)}` : ''}` : 'Nothing needs you';
  const cls = `inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-semibold tabular-nums ${broken ? 'bg-fail-bg text-fail ring-1 ring-inset ring-fail-bd'
    : n ? 'bg-needs-bg text-needs ring-1 ring-inset ring-needs-bd' : 'font-medium text-muted-fg'}`;
  const body = <><span aria-hidden="true">◆</span><span data-count="needs">{n}</span></>;
  return onClick
    ? <button type="button" onClick={onClick} title={tip} aria-label={tip} style={noDrag} className={cls}>{body}</button>
    : <span title={tip} aria-label={tip} className={cls}>{body}</span>;
}

// "● 7 workers · cap 30 · room for 7 more · 27.5 GiB free"
export function machineLine(m) {
  if (!m) return null;
  return [`● ${m.running} worker${m.running === 1 ? '' : 's'}`, m.cap != null ? `cap ${m.cap}` : null,
    m.room != null ? `room for ${m.room} more` : null, m.avail_gib != null ? `${Number(m.avail_gib).toFixed(1)} GiB free` : null]
    .filter(Boolean).join(' · ');
}

function TitleBar({ title, snapshot, compact, routes, go }) {
  const broken = (snapshot?.repos ?? []).some((r) => r.production_broken?.length);
  const m = snapshot?.machine;
  return (
    <header style={WINDOW_DRAG}className="grid h-10 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border bg-sidebar pr-3 pl-[86px]">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex items-center gap-[7px] text-sm font-semibold tracking-tight">
          <span aria-hidden="true" className="relative size-4 shrink-0 rounded bg-primary after:absolute after:top-[5px] after:left-[5px] after:size-1.5 after:rotate-45 after:bg-needs-solid" />
          Desk
        </span>
        {title && <span className="truncate border-l border-border pl-2.5 text-[13px] text-muted-fg" data-page-title="">{title}</span>}
      </div>
      <div />
      <div className="flex min-w-0 items-center justify-end gap-2.5">
        {compact && m && <span title={machineLine(m)} className="inline-flex h-6 items-center gap-1.5 px-2 text-xs font-medium text-muted-fg tabular-nums"><span className="size-[7px] rounded-full bg-run" />{m.running}</span>}
        <Pill needs={snapshot?.needs_you} broken={broken} onClick={routes.inbox ? () => go('/inbox') : null} />
      </div>
    </header>
  );
}

const ITEM = 'relative flex w-full items-center gap-[9px] rounded-md text-left whitespace-nowrap';
const ON = 'bg-sidebar-accent font-medium before:absolute before:top-[7px] before:bottom-[7px] before:-left-2 before:w-0.5 before:rounded-sm before:bg-foreground';

function Counts({ running, needs }) {
  return (
    <span className="ml-auto flex gap-1.5 text-xs font-medium tabular-nums">
      {needs > 0 && <span className="text-needs">◆ {needs}</span>}
      {running > 0 && <span className="text-run">● {running}</span>}
    </span>
  );
}

// A repo's row, or with `under` (its repo's id) one of its named batches, indented beneath it.
function RepoRow({ name, title, running, needs, under = null, open, on }) {
  const sub = under != null;
  const cls = `${ITEM} ${sub ? 'h-[26px] pl-8 text-[12.5px] text-muted-fg' : 'h-7 pl-4 text-[13px]'} pr-2 ${on ? ON : ''} ${open ? 'hover:bg-sidebar-accent' : ''}`;
  const body = <><span className="min-w-0 truncate">{shortName(name)}</span><Counts running={running} needs={needs} /></>;
  return (
    <li title={title} data-under={under ?? undefined}>
      {open ? <button type="button" onClick={open} className={cls}>{body}</button> : <div className={cls}>{body}</div>}
    </li>
  );
}

// What the sidebar and the rail both draw: the shipped screens in order, Settings apart (or null
// until it ships), and each screen's badge count.
const navOf = (snapshot, routes) => ({
  screens: SCREENS.filter((s) => routes[s.id] && s.id !== 'settings'),
  settings: routes.settings ? SCREENS.find((s) => s.id === 'settings') : null,
  badge: { inbox: snapshot?.needs_you?.count, workers: snapshot?.machine?.running },
});

function Sidebar({ snapshot, path, routes, go, nav: { screens, settings, badge } }) {
  const repos = (snapshot?.repos ?? []).filter((r) => !r.error);
  // A repo set up with no batch yet: home lists it by name in no_batch, with nothing to count.
  const idle = (snapshot?.no_batch ?? []).filter((name) => !repos.some((r) => r.name === name));
  const shipped = screens.filter((s) => s.id !== 'repos');
  const broken = repos.some((r) => r.production_broken?.length);
  const item = (s) => (
    <li key={s.id}>
      <button type="button" onClick={() => go(s.path)} aria-current={path.startsWith(s.path) ? 'page' : undefined} title={`${s.label} ⌘${s.key}`}
        className={`${ITEM} h-8 px-2 hover:bg-sidebar-accent ${path.startsWith(s.path) ? ON : ''}`}>
        {s.icon && <span className="text-muted-fg"><Icon name={s.icon} /></span>}
        {s.label}
        {badge[s.id] > 0 && (
          <span className="ml-auto flex gap-1.5 text-xs font-medium tabular-nums">
            {s.id === 'inbox' && broken && <span className="font-semibold text-fail" title="Production is broken">!</span>}
            <span className={s.id === 'inbox' ? 'text-needs' : 'text-muted-fg'} data-badge={s.id}>{badge[s.id]}</span>
          </span>
        )}
      </button>
    </li>
  );
  const openRepo = (id) => (routes.repos ? () => go(`/repos/${id}`) : null);
  return (
    <nav aria-label="Desk" className="flex w-58 shrink-0 flex-col gap-px overflow-y-auto border-r border-border bg-sidebar px-2 pt-2.5 pb-2 text-sm">
      <ul className="flex flex-col gap-px">{shipped.filter((s) => s.id === 'inbox').map(item)}</ul>
      <div className="px-2 pt-3 pb-1 text-xs font-medium text-muted-fg" id="repos-label">Repos</div>
      <ul aria-labelledby="repos-label" className="flex flex-col gap-px" data-repos="">
        {repos.length + idle.length === 0 && <li className="h-7 pl-4 text-[13px] leading-7 text-muted-fg">No repos set up yet</li>}
        {repos.flatMap((r) => [
          <RepoRow key={r.id} name={r.name} title={fullName(r.slug)} running={r.running} needs={r.needs_you} open={openRepo(r.id)} on={path === `/repos/${r.id}`} />,
          ...(r.batches ?? []).map((b) => (
            <RepoRow key={b.id} under={r.id} name={b.name} title={b.name} running={b.running} needs={b.needs_you} open={openRepo(b.id)} on={path === `/repos/${b.id}`} />
          )),
        ])}
        {idle.map((name) => <RepoRow key={`idle ${name}`} name={name} title={`${name} · no batch yet`} running={0} needs={0} open={null} on={false} />)}
      </ul>
      <ul className="mt-2 flex flex-col gap-px">{shipped.filter((s) => s.id !== 'inbox').map(item)}</ul>
      {settings && <ul className="mt-auto border-t border-border pt-2">{item(settings)}</ul>}
    </nav>
  );
}

function Rail({ path, go, nav: { screens, settings, badge } }) {
  const item = (s) => (
    <li key={s.id}>
      <button type="button" onClick={() => go(s.path)} aria-label={s.label} title={`${s.label} ⌘${s.key}`} aria-current={path.startsWith(s.path) ? 'page' : undefined}
        className={`relative flex h-9 w-10 items-center justify-center rounded-md hover:bg-sidebar-accent ${path.startsWith(s.path) ? `${ON} before:-left-1.5` : ''}`}>
        {s.icon ? <Icon name={s.icon} /> : <span className="text-xs font-semibold">{s.label[0]}</span>}
        {badge[s.id] > 0 && (
          <span data-badge={s.id}
            className={`absolute top-[3px] right-px h-4 min-w-4 rounded-lg px-1 text-center text-[10px] leading-4 font-semibold ${s.id === 'inbox' ? 'bg-needs-solid text-[#1c1917]' : 'bg-muted text-foreground ring-1 ring-inset ring-border'}`}>
            {countText(badge[s.id])}
          </span>
        )}
      </button>
    </li>
  );
  return (
    <nav aria-label="Desk" data-rail="" className="flex w-14 shrink-0 flex-col items-center gap-px border-r border-border bg-sidebar px-1.5 pt-2.5 pb-2">
      <ul className="flex flex-col items-center gap-px">{screens.map(item)}</ul>
      {settings && <ul className="mt-auto">{item(settings)}</ul>}
    </nav>
  );
}

function StatusBar({ snapshot, live }) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-1.5 border-t border-border bg-sidebar px-3 text-xs whitespace-nowrap text-muted-fg tabular-nums" data-status-bar="">
      {snapshot?.machine && <span className="px-1.5" data-segment="machine">{machineLine(snapshot.machine)}</span>}
      <span className="ml-auto inline-flex items-center gap-1.5 px-1.5" data-segment="server">
        Server {SERVER} <span aria-label={live ? 'answering' : 'not answering'} className={live ? 'text-done' : 'text-fail'}>●</span>
      </span>
    </footer>
  );
}

// `path` is the screen showing, `go` opens another, and `routes` holds the screens that exist.
export function Frame({ snapshot, live, path, go, routes, title, children }) {
  const width = useWidth();
  const online = useOnline();
  const [hidden, setHidden] = useState(false);
  const compact = width < COMPACT_BELOW;

  useEffect(() => {
    const key = (e) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      if (e.key === '\\') { e.preventDefault(); setHidden((h) => !h); return; }
      const s = SCREENS.find((x) => x.key === e.key);
      if (s && routes[s.id]) { e.preventDefault(); go(s.path); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [routes, go]);

  const side = { snapshot, path, routes, go, nav: navOf(snapshot, routes) };
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <TitleBar title={title} snapshot={snapshot} compact={compact} routes={routes} go={go} />
      <div className="flex min-h-0 flex-1">
        {!hidden && (compact ? <Rail {...side} /> : <Sidebar {...side} />)}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <Banners list={bannersFor({ snapshot, online, routes, go })} />
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        </div>
      </div>
      {!compact && <StatusBar snapshot={snapshot} live={live} />}
    </div>
  );
}
