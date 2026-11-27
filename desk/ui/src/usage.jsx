// Usage & costs (screen-spec §11.1, §11.3, §11.4): how full each subscription's windows are,
// which subscription each repo runs on, and which repos wait for a reset. Read only: every
// subscription write (pin, default, off, add, remove) is its own story, so no control for one is drawn.
// Read from the snapshot's `subscriptions` (desk-q-model subscriptionsJson), which the server's probe
// loop keeps fresh; drawn again every 30 s so the stamp and the pace move with the clock.
import { useEffect } from 'react';
import { Icon } from './icons.jsx';
import { andList, dayTime, defaultSub, level, paceOf, probeStamp, useNow, weekLimit, windowWord } from './usage-figures.js';

const FILL = { done: 'bg-done', needs: 'bg-needs-solid', fail: 'bg-fail' };
const TEXT = { done: 'text-done', needs: 'text-needs', fail: 'text-fail' };
const BADGE = { done: 'bg-done-bg text-done ring-done-bd', needs: 'bg-needs-bg text-needs ring-needs-bd', fail: 'bg-fail-bg text-fail ring-fail-bd',
  muted: 'bg-muted text-muted-fg ring-border', outline: 'bg-background text-foreground ring-border', primary: 'bg-primary text-primary-fg ring-primary' };

function Badge({ tone, children }) {
  return <span className={`inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium whitespace-nowrap ring-1 ring-inset ${BADGE[tone]}`}>{children}</span>;
}

// A window's bar. `full` draws the limit's red pattern across all of it.
function Bar({ label, pct, tone, full = false, projection = null, className = 'h-1.5' }) {
  const shown = full ? 100 : Math.min(100, Math.max(0, pct ?? 0));
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={full ? 100 : (pct ?? 0)}
      className={`relative block overflow-hidden rounded-full ${full ? 'bg-fail-bg' : 'bg-muted'} ${className}`}>
      <span className={`absolute inset-y-0 left-0 rounded-full ${full ? '' : FILL[tone]}`} data-fill=""
        style={{ width: `${shown}%`, ...(full ? { background: 'repeating-linear-gradient(135deg, var(--fail) 0 6px, color-mix(in srgb, var(--fail) 75%, transparent) 6px 10px)' } : {}) }} />
      {projection != null && !full && (
        <span aria-hidden="true" className="absolute inset-y-0 border-y border-r border-dashed border-needs-bd bg-needs-bg"
          style={{ left: `${shown}%`, width: `${Math.max(0, projection - shown)}%` }} />
      )}
    </span>
  );
}

// One window's line on a card or under the hero: its label, bar, use and reset.
function Meter({ label, w, off = false, tight = false, now }) {
  if (!w) {
    return (
      <div className="grid grid-cols-[28px_1fr_40px_auto] items-center gap-2 text-[12.5px]">
        <span className="text-muted-fg">{label}</span><Bar label={`${label} not read`} pct={0} tone="done" />
        <b className="text-right font-medium text-muted-fg">—</b><span className="text-muted-fg">not read</span>
      </div>
    );
  }
  const l = level(w.pct, tight);
  return (
    <div className={`grid grid-cols-[28px_1fr_40px_auto] items-center gap-2 text-[12.5px] ${off ? 'opacity-55' : ''}`}>
      <span className="text-muted-fg">{label}</span><Bar label={`${label} ${w.pct}%`} pct={w.pct} tone={l.tone} full={tight} />
      <b className={`text-right font-medium tabular-nums ${l.tone === 'done' ? '' : TEXT[l.tone]}`}>{w.pct}%</b>
      <span className="text-muted-fg tabular-nums">resets {resetText(w.resets_at, now)}</span>
    </div>
  );
}

// A reset today reads as its time, a later one with its weekday.
const resetText = (ms, now) => (new Date(ms).toDateString() === new Date(now).toDateString() ? dayTime(ms).split(' ')[1] : dayTime(ms));

function Hero({ subs, now }) {
  const def = defaultSub(subs);
  if (!def) {
    const off = (subs.claude ?? []).find((s) => s.is_default) ?? null;
    return (
      <section className="rounded-lg border border-border p-4 text-[13px] text-muted-fg" data-hero="">
        {off ? `This computer's default Claude subscription, ${off.email ?? off.label}, is off, so repos that aren't pinned can't start work.`
          : "No Claude subscription is set as this computer's default yet."}
      </section>
    );
  }
  const week = def.reading?.seven_day ?? null;
  const limit = weekLimit(def);
  const codex = (subs.codex ?? []).find((s) => s.state === 'default') ?? null;
  const others = (subs.claude ?? []).filter((s) => s !== def && s.state === 'pinned');
  const email = def.email ?? def.label;
  const pct = limit ? 100 : week?.pct ?? null;
  const l = level(pct ?? 0, !!limit);
  const pace = limit ? null : paceOf(week, now);
  const resets = limit?.at ?? week?.resets_at ?? null;
  const projected = pace && week ? 100 : null;
  return (
    <section aria-label="Claude default" className="flex flex-col gap-3 rounded-lg border border-border p-4" data-hero="">
      <div className="flex items-baseline gap-2.5">
        <h2 className="text-[14px] font-semibold" data-hero-line="">
          {`Claude ${email} (default) · 7d ${pct == null ? '—' : `${pct}%`}${resets != null ? ` · resets ${dayTime(resets)}` : ''}`}
        </h2>
        {pct != null && <Badge tone={l.tone}>{l.word}</Badge>}
      </div>
      {pct == null ? (
        <p className="text-[13px] text-muted-fg">No 7-day reading yet. The server reads it every few minutes while it runs.</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2.5">
            <span className="text-5xl leading-[52px] font-semibold tracking-tighter tabular-nums">{pct}%</span>
            {pace && <span className="text-[13.5px] text-muted-fg" data-pace="">{`At this pace: 100% ${dayTime(pace.at)}, ${pace.hours} h before reset.`}</span>}
          </div>
          <Bar label={`7-day window ${pct}%`} pct={pct} tone={l.tone} full={!!limit} projection={projected} className="h-3" />
          {limit && (
            <p className="text-[13.5px]" data-limit="">
              {`Limit reached. Repos on ${email} wait until ${limit.at != null ? dayTime(limit.at) : 'its limit lifts'}. desk doesn't move them.`}
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3 text-[13px] whitespace-nowrap">
        <Secondary label="5h window" w={def.reading?.five_hour} tight={def.limit?.type === 'five_hour'} now={now} />
        {codex && <Secondary label="Codex 7d" w={codex.reading?.seven_day} tight={false} now={now} />}
        {others.map((s) => (
          <span key={s.name} className="text-muted-fg">
            {`${s.email ?? s.label} · Pinned · ${s.pinned.length} repo${s.pinned.length === 1 ? '' : 's'} · 7d ${s.reading?.seven_day ? `${s.reading.seven_day.pct}%` : '—'}`}
          </span>
        ))}
      </div>
    </section>
  );
}

function Secondary({ label, w, tight, now }) {
  if (!w) return <span className="text-muted-fg">{label} not read</span>;
  const l = level(w.pct, tight);
  return (
    <span className="inline-flex items-center gap-2">
      <span>{label}</span>
      <span className="w-[72px]"><Bar label={`${label} ${w.pct}%`} pct={w.pct} tone={l.tone} full={tight} /></span>
      <b className="font-semibold tabular-nums">{w.pct}%</b>
      <span className="text-muted-fg tabular-nums">resets {resetText(w.resets_at, now)}</span>
    </span>
  );
}

// A subscription's badge, by its rule (screen-spec §9.5).
function RuleBadge({ s, codex }) {
  if (s.state === 'default') return <Badge tone="primary">Default</Badge>;
  if (s.state === 'off') return <Badge tone="muted">Off</Badge>;
  if (!codex && s.pinned.length) return <Badge tone="outline"><Icon name="pin" size={11} />{`Pinned · ${s.pinned.length} repo${s.pinned.length === 1 ? '' : 's'}`}</Badge>;
  return <Badge tone="muted">Unused</Badge>;
}

function SubCard({ s, codex = false, now }) {
  const off = s.state === 'off';
  const tight = (k) => s.limit?.type === k;
  return (
    <article aria-label={s.email ?? s.label} data-sub={s.name}
      className={`flex flex-col gap-3 rounded-lg border p-4 ${s.state === 'default' ? 'border-ring' : 'border-border'}`}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-semibold">{s.email ?? s.label}</span>
          <span className="truncate text-[12.5px] text-muted-fg">{[s.name, s.plan, s.folder].filter(Boolean).join(' · ')}</span>
        </div>
        <span className="ml-auto"><RuleBadge s={s} codex={codex} /></span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Meter label="5h" w={s.reading?.five_hour} off={off} tight={tight('five_hour')} now={now} />
        <Meter label="7d" w={s.reading?.seven_day} off={off} tight={tight('seven_day')} now={now} />
      </div>
      <p className="text-[12.5px] leading-[18px] text-muted-fg">
        {codex ? (s.state === 'default' ? "Every Codex review in every repo runs on this computer's default Codex subscription." : 'Codex reviews run on the default, not here.')
          : off ? "Off: desk won't pick it for new work."
            : s.pinned.length ? `Pinned by ${andList(s.pinned)}`
              : s.state === 'default' ? "Repos that aren't pinned run here." : 'No repo runs on it.'}
      </p>
    </article>
  );
}

// A repo's "Runs on" cell: the default, the account it is pinned to, or an account no subscription here has.
function RunsOn({ r }) {
  if (r.source === 'default') return <span className={r.known ? '' : 'text-fail'}>{`Default (${r.email ?? 'not set'})`}</span>;
  if (!r.known) return <span className="inline-flex items-center gap-1.5 text-fail"><Icon name="pin" size={13} />{r.email}</span>;
  return <span className="inline-flex items-center gap-1.5"><Icon name="pin" size={13} />{r.email}</span>;
}

function ReposTable({ subs, now }) {
  const def = defaultSub(subs);
  const defaultOff = (subs.claude ?? []).some((s) => s.is_default && s.state === 'off');
  const byName =new Map((subs.claude ?? []).map((s) => [s.name, s]));
  const waitOf = new Map((subs.waiting ?? []).flatMap((w) => w.repos.map((r) => [r.name, w])));
  const rows = [];
  for (const r of subs.repos ?? []) {
    const s = r.source === 'default' ? def : r.on ? byName.get(r.on) : null;
    const w = waitOf.get(r.name) ?? null;
    const week = s?.reading?.seven_day ?? null;
    const pct = w?.type === 'seven_day' || weekLimit(s) ? 100 : week?.pct ?? null;
    const tone = pct == null ? null : level(pct, false).tone;
    const now_ = !r.known ? <span className="font-medium text-fail">✕ can't start work</span>
      : w ? <span className="text-needs">{`⧗ waits for the reset${r.ready ? '' : ' · 0 ready'}`}</span>
        : r.workers ? <span className="text-run">{`● ${r.workers} running`}</span>
          : <span className="text-muted-fg">nothing running</span>;
    rows.push(
      <tr key={r.slug} className="h-10 border-t border-border" data-repo={r.name}>
        <td className="px-3 font-medium">{r.name}</td>
        <td className="px-3"><RunsOn r={r} /></td>
        <td className={`px-3 text-right tabular-nums ${tone && tone !== 'done' ? TEXT[tone] : pct == null ? 'text-muted-fg' : ''}`}>{pct == null ? '—' : `${pct}%`}</td>
        <td className="px-3">{now_}</td>
      </tr>,
    );
    if (w && r.ready) {
      rows.push(
        <tr key={`${r.slug} wait`} className="border-t border-border bg-needs-bg">
          <td colSpan={4} className="px-3 py-2 text-[13px]">
            <span className="inline-flex items-center gap-2" data-wait={r.name}>
              <span className="text-needs"><Icon name="hourglass" size={14} /></span>
              {`${r.name} waits for ${w.email}'s ${windowWord(w.type) ? `${windowWord(w.type)} reset` : 'usage limit to lift'} · ${r.ready} ready · starts ${w.at != null ? dayTime(w.at) : 'once its limit lifts'}`}
            </span>
          </td>
        </tr>,
      );
    }
    if (!r.known) {
      rows.push(
        <tr key={`${r.slug} unknown`} className="border-t border-border">
          <td colSpan={4} className="px-3 py-2.5">
            <div role="alert" className="flex items-start gap-2 rounded-md border border-fail-bd bg-fail-bg px-3 py-2.5 text-[13px]" data-unknown={r.name}>
              <span className="mt-px text-fail"><Icon name="circle-x" size={14} /></span>
              <span>{r.source === 'default'
                ? (defaultOff
                  ? `✕ This computer's default Claude subscription is off, so ${r.name} can't start work. Turn it back on, or pick another subscription for it.`
                  : `✕ This computer has no default Claude subscription, so ${r.name} can't start work. Set one, or pick another subscription for it.`)
                : r.off
                ? `✕ The subscription on this computer signed in to ${r.email}, ${r.off}, is off, so ${r.name} can't start work. Turn ${r.off} back on, or pick another subscription for it.`
                : `✕ No subscription on this computer is signed in to ${r.email}, so ${r.name} can't start work. Pick another subscription for it, or add one signed in to that account.`}</span>
            </div>
          </td>
        </tr>,
      );
    }
  }
  if (!rows.length) return <p className="text-[13px] text-muted-fg">No repo is set up on this computer yet.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-[13px]">
        <thead className="bg-subtle text-left text-xs text-muted-fg">
          <tr className="h-9"><th className="w-[200px] px-3 font-medium">Repo</th><th className="px-3 font-medium">Runs on</th>
            <th className="w-[130px] px-3 text-right font-medium">Its 7-day window</th><th className="px-3 font-medium">Now</th></tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

function SectionHead({ id, title, children }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 id={id} className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {children && <p className="text-[13px] text-muted-fg">{children}</p>}
    </div>
  );
}

export function Usage({ snapshot, path = '/usage' }) {
  const now = useNow();
  const subs = snapshot?.subscriptions ?? null;
  useEffect(() => {
    if (path === '/usage/subscriptions') document.getElementById('subscriptions')?.scrollIntoView?.({ block: 'start' });
  }, [path]);
  const stamp = subs && !subs.error ? probeStamp(subs, now) : null;
  return (
    <main className="flex flex-col">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <h1 className="text-lg font-semibold tracking-tight">Usage &amp; costs</h1>
        {stamp && <span className={`text-[13px] tabular-nums ${stamp.stale ? 'text-needs' : 'text-muted-fg'}`} data-stamp="">{stamp.text}</span>}
      </div>
      {!subs ? (
        <p className="p-5 text-[13px] text-muted-fg">Waiting for the server's first usage reading.</p>
      ) : subs.error ? (
        <p role="alert" className="m-5 rounded-md border border-fail-bd bg-fail-bg px-3 py-2.5 text-[13px]" data-subs-error="">
          {`desk couldn't read this computer's subscriptions: ${subs.error}`}
        </p>
      ) : (
        <div className="flex max-w-[1180px] flex-col gap-6 p-5">
          <Hero subs={subs} now={now} />
          <section aria-labelledby="subscriptions" className="flex flex-col gap-3">
            <SectionHead id="subscriptions" title="Subscriptions">
              Each repo runs on this computer's default, or on the one it's pinned to. desk never switches subscriptions on its own.
            </SectionHead>
            <span className="text-xs font-medium text-muted-fg">{`Claude · ${subs.claude.length}`}</span>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">{subs.claude.map((s) => <SubCard key={s.name} s={s} now={now} />)}</div>
            {subs.codex.length > 0 && (
              <>
                <span className="mt-2 text-xs font-medium text-muted-fg">{`Codex · ${subs.codex.length}`}</span>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">{subs.codex.map((s) => <SubCard key={s.name} s={s} codex now={now} />)}</div>
              </>
            )}
          </section>
          <section aria-labelledby="repos-on-subs" className="flex flex-col gap-3">
            <SectionHead id="repos-on-subs" title="Repos on subscriptions">Each repo and the subscription its new workers start on.</SectionHead>
            <ReposTable subs={subs} now={now} />
            <p className="text-[12.5px] text-muted-fg" data-footer="">desk doesn't move a waiting repo to another subscription. Pinning it elsewhere is your choice.</p>
          </section>
        </div>
      )}
    </main>
  );
}
