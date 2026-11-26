// The ticket page (screen-spec §6.1-6.3, §6.5), at /t/<repo>/<KEY>[/pr]: the header and its state line,
// then the Overview or PR & CI tab. Read only. The ticket comes from the server's queue reader and the
// PR from its GitHub read (desk-ui.mjs), so no GitHub or Jira credential reaches the window.
import { useCallback, useEffect, useState } from 'react';
import { Icon } from './icons.jsx';
import { TicketLink } from './frame.jsx';
import { ticketPath } from './routes.js';
import { clock } from './system.jsx';

export const NO_FILES = 'No files listed. The worker decides scope.';
export const NO_PR = 'No PR yet. The worker opens one at stage 7/9 (PR).';
const FILES_SHOWN = 20;
const REASON_LINES = 5;

// Each state's glyph, word and colour (§1.3).
const STATE = {
  running: ['●', 'running', 'run'], finishing: ['●', 'running', 'run'], ready: ['○', 'ready', 'ready'], queued: ['○', 'ready', 'ready'],
  merging: ['▸', 'merging', 'merge'], waiting: ['·', 'waiting', 'wait'], needs: ['◆', 'needs you', 'needs'], stuck: ['◆', 'needs you', 'needs'],
  failed: ['✕', 'failed', 'fail'], done: ['✓', 'done', 'done'],
};
const stateOf = (t) => STATE[t.state] ?? STATE[t.group] ?? ['·', t.state ?? 'unknown', 'wait'];
const RULE = { run: 'border-l-run bg-run-bg', ready: 'border-l-ready bg-ready-bg', merge: 'border-l-merge bg-merge-bg', wait: 'border-l-border bg-subtle',
  needs: 'border-l-needs bg-needs-bg', fail: 'border-l-fail bg-fail-bg', done: 'border-l-done bg-done-bg' };
const TEXT = { run: 'text-run', ready: 'text-ready', merge: 'text-merge', wait: 'text-wait', needs: 'text-needs', fail: 'text-fail', done: 'text-done' };

const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const listed = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
// "4/9 verify" as the page says it: "4/9 Verify".
const stageName = (label) => String(label).replace(/^(\S+)\s+(\S)/, (_, n, c) => `${n} ${c.toUpperCase()}`);
const stageText = (s) => (s ? `stage ${stageName(s.label)}${s.at ? ` since ${clock(s.at)}` : ''}` : 'stage not reported yet');

// The state line: whether the ticket moves without Ben, as { lead, rest, tone } (§6.1).
export function stateLine(t) {
  const tone = stateOf(t)[2];
  const pr = t.pr?.number != null ? `#${t.pr.number}` : null;
  // With passes stopped nothing new starts and no held ticket starts, so only resuming them moves it.
  if (t.passes && !t.passes.live && ['ready', 'queued', 'waiting'].includes(t.state)) {
    return { tone, lead: 'Will not move until passes resume.', rest: t.hold?.text ? sentence(capital(t.hold.text)) : '' };
  }
  switch (t.state) {
    case 'running': return { tone, lead: 'Moves without you:', rest: `a worker is on it, ${stageText(t.stage)}.` };
    case 'finishing': return { tone, lead: 'Moves without you:', rest: 'its worker finished, and the next pass records it.' };
    case 'queued': return { tone, lead: 'Moves without you:', rest: 'it is being triaged.' };
    case 'ready': return { tone, lead: 'Starts when a worker is free.', rest: t.wait ? sentence(capital(t.wait)) : '' };
    case 'waiting': {
      const b = t.behind ?? [];
      const rest = b.length ? `behind ${listed(b.map((x) => `${x.key}${x.state ? ` (${[x.state, x.stage && `stage ${x.stage}`].filter(Boolean).join(', ')})` : ''}`))}.`
        : t.hold?.text ? sentence(t.hold.text) : 'it waits for the next pass.';
      return { tone, lead: 'Moves by itself:', rest };
    }
    case 'merging': {
      if (t.pr?.draft) return { tone, lead: 'Merges by itself once green:', rest: `${pr} is draft and comes out of draft at the next pass.` };
      return { tone, lead: 'Merges by itself once green:', rest: sentence(`${pr}${t.pr?.need ? `: ${t.pr.need.replaceAll(' · ', ', ')}` : ''}`) };
    }
    case 'failed': return { tone, lead: 'Stopped:', rest: `${sentence(t.failed_why ?? 'its worker stopped')} Requeue or drop it in Inbox.` };
    case 'done': return t.merged_at && pr ? { tone, lead: `Merged at ${clock(t.merged_at)} as ${pr}.`, rest: '' } : { tone, lead: 'Done.', rest: '' };
    default:
      if (t.question) return { tone, lead: 'Needs your answer:', rest: t.question };
      if (t.open_questions > 0) return { tone, lead: 'Needs your answer:', rest: `triage left ${t.open_questions} question${t.open_questions === 1 ? '' : 's'} open.` };
      return { tone, lead: 'Needs you:', rest: sentence(t.hold?.text ?? t.pr?.need ?? 'it waits for you') };
  }
}

const external = (url) => () => window.desk?.openExternal?.(url);
const BTN = 'inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-[13px] font-medium hover:bg-muted';
const LINK = 'rounded-sm text-[12.5px] font-medium text-foreground underline-offset-3 hover:underline';

function Header({ t, tab, go, base }) {
  const [glyph, word, tone] = stateOf(t);
  const line = stateLine(t);
  const meta = [t.type, t.size && `size ${t.size}`, t.lane && t.lane !== '?' && `lane ${t.lane}`, t.pos != null && t.places != null && `position ${t.pos} of ${t.places}`].filter(Boolean).join(' · ');
  const tabs = [['overview', 'Overview', base], ['pr', 'PR & CI', `${base}/pr`]];
  return (
    <header className="flex flex-col gap-2.5 border-b border-border px-5 pt-4">
      <div className="flex items-center gap-1 text-xs text-muted-fg">{t.repo} <Icon name="chevron-right" size={12} /> Queue <Icon name="chevron-right" size={12} /><b className="font-medium text-foreground">{t.key}</b></div>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-xl font-semibold tracking-tight"><TicketLink ticket={t.key} browse={t.jira_browse} /></span>
        <span className={`text-[13px] font-medium ${TEXT[tone]}`} data-state={t.state}><span aria-hidden="true">{glyph}</span> {word}</span>
        {meta && <span className="text-[13px] text-muted-fg">{meta}</span>}
        <span className="ml-auto flex gap-2">
          {t.pr?.url && <button type="button" className={BTN} onClick={external(t.pr.url)}>Open PR #{t.pr.number} <Icon name="arrow-up-right" size={12} /></button>}
          {t.jira_browse && <button type="button" className={BTN} onClick={external(`${t.jira_browse}${t.key}`)}>Open in Jira <Icon name="arrow-up-right" size={12} /></button>}
        </span>
      </div>
      {t.title && <h1 className="max-w-[110ch] text-[15px] leading-[22px] font-medium">{t.title}</h1>}
      <p data-state-line="" className={`rounded-r-md border-l-3 px-3.5 py-2 text-sm leading-[21px] ${RULE[line.tone]}`}>
        <b className="font-semibold">{line.lead}</b>{line.rest ? ` ${line.rest}` : ''}
      </p>
      <nav aria-label="Ticket" className="flex gap-4 text-[13px]">
        {tabs.map(([id, label, to]) => (
          <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => go(to)}
            className={`-mb-px border-b-2 pb-2 ${tab === id ? 'border-foreground font-medium' : 'border-transparent text-muted-fg hover:text-foreground'}`}>{label}</button>
        ))}
      </nav>
    </header>
  );
}

function Card({ title, children, side = null }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <h2 className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-[13px] font-semibold">{title}{side}</h2>
      <div className="px-4 py-3 text-[13px] leading-5">{children}</div>
    </section>
  );
}
const Facts = ({ rows, w = 'grid-cols-[96px_1fr]' }) => (
  <dl className={`m-0 grid gap-x-3 gap-y-1.5 ${w}`}>
    {rows.map(([dt, dd]) => [<dt key={`${dt}t`} className="text-muted-fg">{dt}</dt>, <dd key={`${dt}d`} className="m-0 min-w-0 break-words">{dd ?? <span className="text-muted-fg">—</span>}</dd>])}
  </dl>
);
const keys = (list, t, go) => (list.length
  ? list.map((k, i) => <span key={k}>{i ? ', ' : ''}<TicketLink ticket={k} browse={t.jira_browse} open={go ? () => go(ticketPath(t.repo, k)) : null} /></span>) : null);

function Reason({ lane, text }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const long = lines.length > REASON_LINES || text.length > REASON_LINES * 120;
  return (
    <Card title={`Why lane ${lane}`}>
      <p className={`m-0 text-[13.5px] leading-[21px] whitespace-pre-wrap ${long && !all ? 'line-clamp-5' : ''}`}>{text}</p>
      {long && <button type="button" className={`${LINK} mt-1.5`} onClick={() => setAll((x) => !x)}>{all ? 'Show less' : 'Show all'}</button>}
    </Card>
  );
}

function Files({ files }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  return (
    <Card title={<>Files in scope <span className="font-normal text-muted-fg">· {files.length}</span></>}>
      {files.length === 0 ? <p className="m-0 text-muted-fg">{NO_FILES}</p> : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 font-mono text-[12.5px]">
          {shown.map((f) => <li key={f} className="break-all">{f}</li>)}
          {files.length > shown.length && <li><button type="button" className={LINK} onClick={() => setAll(true)}>Show {files.length - shown.length} more</button></li>}
        </ul>
      )}
    </Card>
  );
}

export function Overview({ t, go = null }) {
  const w = t.worker ?? {};
  const model = [w.model, w.effort && w.effort !== 'default' && `effort ${w.effort}`].filter(Boolean).join(' · ') || null;
  const schedule = t.schedule ?? [];
  return (
    <div className="grid gap-5 p-5 min-[1200px]:grid-cols-[2fr_1fr]">
      <div className="flex min-w-0 flex-col gap-4">
        <Card title={<><Icon name="calendar" size={14} />Schedule</>}>
          {schedule.length ? (
            <Facts w="grid-cols-[72px_1fr]" rows={schedule.filter((f) => f.label !== 'Based on').map((f) => [f.label, <>{f.text}{f.note && <span className="text-muted-fg">, {f.note}</span>}</>])} />
          ) : <p className="m-0 text-muted-fg">No schedule: it has a PR, so it ships when that merges.</p>}
          {schedule.filter((f) => f.label === 'Based on').map((f) => <p key="based" className="mt-2 mb-0 text-[12.5px] text-muted-fg">Based on {f.text}</p>)}
        </Card>
        {t.lane_reason && <Reason lane={t.lane} text={t.lane_reason} />}
        <div className="grid gap-4 min-[1200px]:grid-cols-2">
          <Files files={t.files ?? []} />
          <Card title="Collisions and blockers">
            <Facts w="grid-cols-[112px_1fr]" rows={[['Never runs with', keys(t.collides ?? [], t, go)], ['Blocks', keys(t.blocks ?? [], t, go)],
              ['Waits for', keys((t.behind ?? []).map((b) => b.key), t, go)]]} />
          </Card>
        </div>
      </div>
      <div className="self-start">
        <Card title="Worker">
          <Facts w="grid-cols-[88px_1fr]" rows={[
            ['Branch', w.branch && <span className="font-mono text-xs">{w.branch}</span>],
            ['Worktree', w.worktree && <span className="font-mono text-xs">{w.worktree}</span>],
            ['Port', w.port && <span className="font-mono">{w.port}</span>],
            ['Subscription', w.subscription],
            ['Model', model],
            ['Session', w.session_id && <span className="font-mono text-xs">{w.session_id}</span>],
            ['Log', w.log && <span className="font-mono text-xs">{w.log}</span>],
          ]} />
        </Card>
      </div>
    </div>
  );
}

const STATUS = { passed: ['✓', 'text-done'], failed: ['✕', 'text-fail'], running: ['◷', 'text-run'], queued: ['○', 'text-muted-fg'] };
const took = (s) => (s == null ? '' : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const VERDICT = { ok: 'border-done-bd bg-done-bg', done: 'border-done-bd bg-done-bg', warn: 'border-needs-bd bg-needs-bg', err: 'border-fail-bd bg-fail-bg', person: 'border-border bg-subtle', info: 'border-border bg-subtle' };
// "Ready to merge: all 14 …": the words before the first colon lead, bold.
function Verdict({ v, asOf, refresh }) {
  const at = v.text.indexOf(': ');
  return (
    <div data-verdict={v.tone} className={`flex items-start gap-3 rounded-lg border px-4 py-3.5 text-[13.5px] leading-5 ${VERDICT[v.tone] ?? VERDICT.info}`}>
      <p className="m-0 grow">{at > 0 ? <><b className="font-semibold">{v.text.slice(0, at + 1)}</b>{v.text.slice(at + 1)}</> : <b className="font-semibold">{v.text}</b>}</p>
      {asOf && <span className="shrink-0 text-xs text-muted-fg">As of {clock(asOf)} · <button type="button" className="underline" onClick={refresh}>Refresh</button></span>}
    </div>
  );
}

function JobLog({ get, base, job }) {
  const [log, setLog] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await get(`${base}/pr/jobs/${job}/log`);
        const body = await r.json();
        if (live) setLog(r.ok ? body : { error: body?.error?.message ?? "The job log can't be read." });
      } catch { if (live) setLog({ error: "The server didn't answer, so the job log can't be read." }); }
    })();
    return () => { live = false; };
  }, [get, base, job]);
  if (!log) return <p className="m-0 text-xs text-muted-fg">Reading the job log…</p>;
  if (log.error) return <p className="m-0 text-xs text-fail">{log.error}</p>;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-fg">As of {clock(log.as_of)} · the last {log.lines.length} lines</span>
      <pre data-job-log={job} className="m-0 max-h-80 overflow-auto rounded-md bg-subtle p-2.5 font-mono text-xs leading-5 whitespace-pre-wrap">{log.lines.join('\n')}</pre>
    </div>
  );
}

function Checks({ checks, get, base }) {
  const [open, setOpen] = useState(null);
  if (!checks.length) return <p className="m-0 text-[13px] text-muted-fg">No checks have reported on this PR yet.</p>;
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead><tr className="text-left text-xs text-muted-fg">{['', 'Check', 'Kind', 'Status', 'Duration', 'Runner', ''].map((h, i) => <th key={i} className="border-b border-border px-3 py-2 font-medium">{h}</th>)}</tr></thead>
      <tbody>
        {checks.map((c, i) => {
          const [glyph, cls] = STATUS[c.status] ?? ['·', 'text-muted-fg'];
          const id = `${c.name} ${i}`;
          const can = c.status === 'failed' && c.job_id;
          return [
            <tr key={id} data-check={c.status} className="border-b border-faint">
              <td className={`px-3 py-2 ${cls}`} aria-hidden="true">{glyph}</td>
              <td className="px-3 py-2">{can ? <button type="button" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)} className={LINK}>{c.name}</button> : c.name}</td>
              <td className="px-3 py-2 text-muted-fg">{c.kind ?? ''}</td>
              <td className={`px-3 py-2 ${cls}`}>{c.status}</td>
              <td className="px-3 py-2 font-mono text-xs">{took(c.duration_s)}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted-fg">{c.runner ?? ''}</td>
              <td className="px-3 py-2">{c.url && <button type="button" className={`${LINK} inline-flex items-center gap-0.5 text-muted-fg`} onClick={external(c.url)} title={`Open ${c.name}'s job on GitHub`}>Job <Icon name="arrow-up-right" size={12} /></button>}</td>
            </tr>,
            open === id && <tr key={`${id} log`}><td /><td colSpan={6} className="px-3 pb-3"><JobLog get={get} base={base} job={c.job_id} /></td></tr>,
          ];
        })}
      </tbody>
    </table>
  );
}

export function PrTab({ t, get, base }) {
  const [read, setRead] = useState(null);
  const [n, setN] = useState(0);
  const refresh = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!t.pr) return undefined;
    let live = true;
    (async () => {
      try {
        const r = await get(`${base}/pr`);
        const body = await r.json();
        if (live) setRead(r.ok ? body : { error: body?.error?.message ?? "The PR can't be read." });
      } catch { if (live) setRead({ error: "The server didn't answer, so the PR can't be read." }); }
    })();
    return () => { live = false; };
  }, [get, base, n, t.pr?.number]);
  if (!t.pr) return <div className="p-5"><p data-pr-state="none" className="m-0 text-sm text-muted-fg">{NO_PR}</p></div>;
  const pr = read?.pr;
  return (
    <div className="flex min-w-0 flex-col gap-4 p-5">
      {read?.error && <p role="alert" className="m-0 rounded-md border border-fail-bd bg-fail-bg px-3 py-2 text-[13px]">{read.error}</p>}
      {read?.note && <p role="status" className="m-0 rounded-md border border-needs-bd bg-needs-bg px-3 py-2 text-[13px]">{read.note}</p>}
      {read?.verdict && <Verdict v={read.verdict} asOf={read.source === 'github' ? read.as_of : null} refresh={refresh} />}
      <section className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="font-mono font-semibold">#{t.pr.number}</span>
          <span className="min-w-0 grow truncate font-medium">{pr?.title ?? ''}</span>
          <button type="button" className={BTN} onClick={external(pr?.url || t.pr.url)}>Open on GitHub <Icon name="arrow-up-right" size={12} /></button>
        </div>
        {pr && (
          <p className="m-0 text-[12.5px] text-muted-fg">
            {[pr.state && capital(pr.state.toLowerCase()), `draft ${pr.draft ? 'yes' : 'no'}`, pr.review && `review ${pr.review}`,
              pr.approvals != null && `${pr.approvals} approval${pr.approvals === 1 ? '' : 's'}`, pr.merge_state && `mergeable ${pr.merge_state}`,
              pr.head && `head ${pr.head.slice(0, 8)}`, pr.branch && pr.base && `${pr.branch} → ${pr.base}`].filter(Boolean).join(' · ')}
          </p>
        )}
      </section>
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        {read?.checks ? <Checks checks={read.checks} get={get} base={base} /> : !read?.error && <p className="m-0 px-4 py-3 text-[13px] text-muted-fg">Reading the checks from GitHub…</p>}
      </section>
    </div>
  );
}

// /t/<repo>/<KEY>[/pr]: <repo> is the snapshot's repos[].name.
export function TicketPage({ path, go, snapshot, get = (u, o) => fetch(u, o) }) {
  const [, , name = '', key = '', tab = 'overview'] = path.split('/').map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const repo = (snapshot?.repos ?? []).find((r) => r.name === name);
  const api = repo ? `/api/repos/${encodeURIComponent(repo.slug)}/tickets/${encodeURIComponent(key)}` : null;
  const [t, setT] = useState(null);
  useEffect(() => {
    if (!api) return undefined;
    let live = true;
    (async () => {
      try {
        const r = await get(api);
        const body = await r.json();
        if (live) setT(r.ok ? body : { error: body?.error?.message ?? `desk can't read ${key}.` });
      } catch { if (live) setT((was) => was ?? { error: "The server didn't answer." }); }
    })();
    return () => { live = false; };
  }, [api, get, key, snapshot?.at]);
  if (!repo) return <p className="p-5 text-sm text-muted-fg">No repo named {name} is set up in desk.</p>;
  if (!t || t.key !== key) return t?.error ? <p role="alert" className="p-5 text-sm">{t.error}</p> : <p className="p-5 text-sm text-muted-fg">Reading {key}…</p>;
  const base = ticketPath(name, key);
  return (
    <div className="flex min-h-full flex-col">
      <Header t={t} tab={tab === 'pr' ? 'pr' : 'overview'} go={go} base={base} />
      {tab === 'pr' ? <PrTab t={t} get={get} base={api} /> : <Overview t={t} go={go} />}
    </div>
  );
}
