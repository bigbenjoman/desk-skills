// The Inbox (screen-spec §4): every needs-you item in needs-you's order, each question word for word
// beside its evidence, worked from the keyboard. An answer runs needs-you's own record command through
// desk-ui's record route, the exact command shown under the options as "Runs: …" (and copyable for
// Terminal); e puts the item off at once, with ⌘Z to take it back for 10 s.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COMPACT_BELOW, ExternalLink, TicketLink, useWidth, waited } from './frame.jsx';
import { Button, clock, Command, useCopy, WriteButton } from './system.jsx';

export const KIND_TIPS = {
  parked: 'A worker stopped to ask you something.',
  session: 'Only an interactive session can do this.',
  spine: "The epic's shared plan needs a decision.",
  plan: 'A plan needs your approval before work starts.',
  triage: 'A new ticket needs sizing or a lane.',
  held: 'Started only when you say so.',
  stopped: 'A worker stopped and needs requeue or drop.',
  pr: 'A pull request needs a person, often to merge.',
  worktree: "The ticket's folder is in use by something else.",
  usage: 'A usage limit is holding work.',
  'base-push': 'Pushing to the base branch needs your approval.',
  config: "The repo's desk setup is missing a value.",
  templates: 'A PR or ticket template is missing.',
  unset: 'A setting desk needs is unset.',
  reviewer: 'A review gate needs a reviewer.',
  step: 'A step in "your steps" is waiting on you.',
  lever: 'A lever desk is testing needs your decision.',
};
// needs-you says which of an item's actions record refuses without text (needs_text).
const needsText = (item, action) => !!item.actions.find((a) => a.action === action)?.needs_text;
const TEXT_ASKS = { move: 'Which batch should it move to?', promote: 'Which priority should it get?' };
const textAsk = (action) => TEXT_ASKS[action.split(' ')[0]] ?? 'What should the worker do?';
// needs-you as desk-needs-you runs it: installed under ~/.claude/desk/bin, with no command on PATH.
const NEEDS_YOU = ['node', '~/.claude/desk/bin/needs-you.mjs'];
const MAX_TEXT = 2000;
const SETTLE_EVERY_MS = 60 * 1000;
const SORTS = { oldest: 'Oldest first', held: 'Most held behind', repo: 'Repo' };
const WRITE_WORDS = { 'jira-comment': 'Jira comment', 'jira-transition': 'Jira transition', 'jira-edit': 'Jira edit', 'jira-ticket': 'New Jira ticket',
  'pr-body': 'PR description', 'pr-review': 'PR review' };

// An argument as the shell reads it back: bare when it is plain, else in single quotes, inside which
// neither sh nor zsh expands anything (zsh's history expansion of ! included). A leading = is quoted too,
// as zsh expands =word to that command's path.
const shellArg = (s) => (/^[\w.,:/@%+-][\w.,:/@%+=-]*$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
// The record command for one answer, or null while the text it needs is missing.
export function recordCommand(item, action, text = '') {
  const typed = text.trim();
  if (needsText(item, action) && !typed) return null;
  return [...NEEDS_YOU, ...['record', item.batch, item.key, ...action.split(' '), ...(typed ? [text] : [])].map(shellArg)].join(' ');
}

// A time as a weekday and a clock, Tue 08:00.
const dayTime =(at) => `${new Date(at).toLocaleDateString('en-GB', { weekday: 'short' })} ${clock(at)}`;

// Actions the record route does not take here: override and move name an argument of their own, and a
// drop or a base push's approve each get a confirm of their own first. They stay copy-only.
const recordsHere =(item, action) => {
  const verb = action.split(' ')[0];
  return !['override', 'move', 'drop'].includes(verb) && !(item.kind === 'base-push' && verb === 'approve');
};
const COPY_ONLY = "Desk can't record this one yet. Copy the needs-you command and run it in Terminal.";
// A PR only a person merges: the answer is to merge it on GitHub, then say done.
const MERGE_HOLD = /merge it on GitHub|only a person merges/i;
const mergeHold = (item) => item.kind === 'pr' && item.pr != null && item.actions.some((a) => a.action === 'done') && MERGE_HOLD.test(item.question);
const ANSWERS = new Set(['answer', 'resume']);
// needs-you record's words for an answer it took as an instruction to run elsewhere, recording nothing.
const NOTHING_RECORDED = /(^|: )nothing recorded\./;
const UNDO_MS = 10_000;
const READ_MS = 1000;

// The detail's answer cards: needs-you's actions, each run through record, except a PR merge hold's
// (opening the PR comes first) and a usage hold's (waiting is not-now; moving the repo is Usage & costs').
function optionsOf(item, repo, gh) {
  const base = item.actions.map((a) => ({ ...a, id: a.action, label: a.action, run: 'record' }));
  if (mergeHold(item)) {
    const done = base.find((o) => o.action === 'done');
    return [
      { id: 'open-pr', label: 'Open PR to merge', run: 'open', url: gh ? `https://github.com/${gh}/pull/${item.pr}` : null, recommended: true, needs_text: false, note: null,
        why: 'Merge it on GitHub, then come back and choose "done". Desk checks the PR before it records.' },
      { ...done, label: 'done: I merged it', recommended: false, why: null, note: null },
      ...base.filter((o) => o !== done).map((o) => ({ ...o, recommended: false })),
    ];
  }
  if (item.kind === 'usage' && base.some((o) => o.action === 'not-now')) {
    const when = item.resets_at ? dayTime(item.resets_at) : null;
    const n = repo?.ready ?? 0;
    const who = n ? `The ${n} ticket${n === 1 ? '' : 's'} start${n === 1 ? 's' : ''}` : 'Its tickets start';
    return [
      { id: 'wait', label: when ? `Wait until ${when}` : 'Wait for the reset', action: 'not-now', run: 'record', recommended: true, needs_text: false, note: null,
        why: `${who} ${when ? `at ${when}` : 'once the limit resets'}. Nothing else changes.` },
      { id: 'usage', label: 'Open Subscriptions in Usage & costs', run: 'go', path: '/usage', recommended: false, needs_text: false, note: null,
        why: `Pin ${item.repo} to another subscription there.` },
    ];
  }
  return base;
}

// The primary button's words for the chosen card.
function primaryLabel(item, o, nextCheckin) {
  const key = item.ticket ?? item.key;
  if (!o) return 'Record answer';
  if (o.run === 'open') return `Open #${item.pr} on GitHub`;
  if (o.run === 'go') return 'Open Usage & costs';
  if (o.id === 'wait') return o.label;
  const verb = o.action.split(' ')[0];
  if (ANSWERS.has(verb)) return `Send answer to ${key}`;
  if (verb === 'start') return `Start ${key}`;
  if (verb === 'requeue') return `Requeue ${key}`;
  if (verb === 'not-now') return nextCheckin ? `Put off until ${clock(nextCheckin)}` : `Put off ${key}`;
  return `Record "${o.action}"`;
}

// What a record's stdout tells a live session's batch: its MESSAGE line, { to, line }, or null.
const messageOf = (stdout) => {
  const line = String(stdout ?? '').split('\n').find((l) => l.startsWith('MESSAGE '));
  const m = line && /^MESSAGE (.+?): /.exec(line);
  return m ? { to: m[1] === '(no batch name recorded)' ? null : m[1], line } : null;
};
const recordLines = (stdout) => String(stdout ?? '').split('\n').filter((l) => l && !l.startsWith('MESSAGE ')).join('\n');

// How long an item has waited, and whether that is past 3 days (amber) or 7 (red).
const hoursOf = (item) => (item.since ? (Date.now() - Date.parse(item.since)) / 3_600_000 : (item.waited_s ?? 0) / 3600);
const ageTone = (h) => (h >= 7 * 24 ? 'text-fail' : h >= 3 * 24 ? 'text-needs' : 'text-muted-fg');
const waitedText = (item) => (item.since ? waited(item.since) : item.waited_s != null ? waited(new Date(Date.now() - item.waited_s * 1000).toISOString()) : '');

// A repo's snapshot row, by the name needs-you gives it.
const repoOf = (snapshot, name) => (snapshot?.repos ?? []).find((r) => r.name === name) ?? null;
const ghRepo = (r) => (r?.slug ? r.slug.replace('__', '/') : null);

// Ticket keys, PR numbers and commit SHAs in a question, each a link by the link rule (§1.6).
const TOKENS = /(PR #\d+|#\d+\b|\b[A-Z][A-Z0-9]+-\d+\b|(?<![\w./-])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![\w/-]))/g;
function Linked({ text, repo }) {
  const gh = ghRepo(repo);
  return String(text).split(TOKENS).map((part, i) => {
    if (i % 2 === 0) return part;
    const pr = /#(\d+)$/.exec(part);
    if (pr) return <ExternalLink key={i} text={part} url={gh ? `https://github.com/${gh}/pull/${pr[1]}` : null} where="GitHub" />;
    if (/^[A-Z]/.test(part)) return <TicketLink key={i} ticket={part} browse={repo?.jira_browse ?? null} />;
    return <ExternalLink key={i} text={part} url={gh ? `https://github.com/${gh}/commit/${part}` : null} where="GitHub" />;
  });
}

const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '') || e.target?.isContentEditable;

function Kind({ kind }) {
  return (
    <span title={KIND_TIPS[kind] ?? undefined}
      className="inline-flex h-[18px] shrink-0 items-center rounded px-[5px] font-mono text-[11px] leading-none font-medium text-muted-fg bg-muted">{kind}</span>
  );
}
function Kbd({ children }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-subtle px-1 font-mono text-[11px] font-medium text-muted-fg">{children}</kbd>;
}
function Ring() {
  return <span aria-hidden="true" className="inline-block size-3 animate-spin rounded-full border-2 border-border border-t-muted-fg" />;
}
const Bar = ({ w = '100%', h = 12 }) => <span className="block rounded bg-muted" style={{ width: w, height: h }} />;

// One row: ◆ · key · PR · kind · need · repo · held behind · waited.
function Row({ item, on, compact, showRepo, select, rowRef }) {
  const h = hoursOf(item);
  return (
    <li role="option" aria-selected={on} ref={rowRef} tabIndex={on ? 0 : -1} data-item={item.id} onClick={select}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } }}
      className={`relative flex shrink-0 cursor-default items-center gap-2 border-b border-faint pr-3.5 pl-[22px] text-[13px] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)] ${compact ? 'h-8' : 'h-9'}
        ${item.production_broken ? 'bg-fail-bg after:absolute after:inset-y-0 after:left-0 after:w-[3px] after:bg-fail' : on ? 'bg-muted' : 'hover:bg-muted/55'}
        ${on && !item.production_broken ? 'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-foreground' : ''}`}>
      <span aria-hidden="true" className={`w-3 text-center ${item.production_broken ? 'font-semibold text-fail' : 'text-needs'}`}>{item.production_broken ? '!' : '◆'}</span>
      <span className="shrink-0 font-mono text-[12.5px] font-medium">{item.ticket ?? item.key}</span>
      {item.pr != null && <span className="shrink-0 font-mono text-xs text-muted-fg">#{item.pr}</span>}
      {!compact && <Kind kind={item.kind} />}
      <span className={`min-w-0 flex-1 truncate ${item.production_broken ? 'font-medium' : ''}`}>{item.question}</span>
      {showRepo && !compact && <span className="shrink-0 text-xs text-muted-fg" data-repo="">{item.repo}</span>}
      {item.behind > 0 && !compact && <span className="shrink-0 font-mono text-[11.5px] font-medium text-muted-fg" title={`${item.behind} held behind it`}>⧗ {item.behind}</span>}
      <span data-waited="" className={`w-[62px] shrink-0 text-right font-mono text-xs font-medium tabular-nums ${ageTone(h)}`}>{waitedText(item)}</span>
    </li>
  );
}

function Alert({ icon = '!', children, action }) {
  return (
    <div role="alert" className="flex gap-2.5 rounded-lg border border-needs-bd bg-needs-bg px-3.5 py-3 text-[13px] leading-[19px]">
      <span aria-hidden="true" className="font-semibold text-needs">{icon}</span>
      <div className="flex min-w-0 grow flex-col gap-2">{children}</div>
      {action}
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="inline-flex items-center">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border border-border bg-background pr-7 pl-2.5 text-[13px] font-medium">
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );
}

// The detail's tabs: in Compact every tab after the third sits under More.
const COMPACT_TABS = 3;
export function Tabs({ tabs, compact }) {
  const [on, setOn] = useState(tabs[0]?.id);
  const [more, setMore] = useState(false);
  const shown = compact && tabs.length > COMPACT_TABS ? tabs.slice(0, COMPACT_TABS) : tabs;
  const rest = tabs.filter((t) => !shown.includes(t));
  const cur = tabs.find((t) => t.id === on) ?? tabs[0];
  const tab = (t) => (
    <button key={t.id} type="button" role="tab" aria-selected={cur.id === t.id} onClick={() => { setOn(t.id); setMore(false); }}
      className={`-mb-px h-8 border-b-2 px-2.5 text-[13px] font-medium ${cur.id === t.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-fg'}`}>{t.label}</button>
  );
  return (
    <div className="flex flex-col gap-2.5">
      <div role="tablist" className="relative flex items-end gap-1 border-b border-border">
        {shown.map(tab)}
        {rest.length > 0 && (
          <span className="relative">
            <button type="button" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((x) => !x)}
              className={`-mb-px h-8 border-b-2 px-2.5 text-[13px] font-medium ${rest.includes(cur) ? 'border-foreground text-foreground' : 'border-transparent text-muted-fg'}`}>More ▾</button>
            {more && (
              <div role="menu" className="absolute top-9 left-0 z-10 flex min-w-40 flex-col rounded-md border border-border bg-popover p-1 shadow-md">
                {rest.map((t) => <button key={t.id} type="button" role="menuitem" onClick={() => { setOn(t.id); setMore(false); }} className="rounded px-2 py-1.5 text-left text-[13px] hover:bg-muted">{t.label}</button>)}
              </div>
            )}
          </span>
        )}
      </div>
      <div role="tabpanel" className="text-[13px] text-muted-fg">{cur.body}</div>
    </div>
  );
}

function CopyCommand({ command, why }) {
  const [copied, copy] = useCopy();
  return (
    <span className="inline-flex" title={command ? undefined : why}>
      <button type="button" disabled={!command} onClick={() => copy(command)}
        className="text-[12.5px] font-medium text-foreground underline decoration-ring underline-offset-2 disabled:text-muted-fg disabled:no-underline">
        {copied ? 'Copied' : 'Copy needs-you command'}
      </button>
    </span>
  );
}

function GateBlock({ approve }) {
  const [copied, copy] = useCopy();
  const what = WRITE_WORDS[approve.kind] ?? approve.kind.replace(/-/g, ' ');
  return (
    <div className="flex flex-col gap-1.5" data-gate="">
      <div className="flex items-center">
        <span className="text-xs font-medium text-foreground">{what}{approve.target ? ` on ${approve.target}` : ''}</span>
        <span className="flex-1" />
        <Button variant="outline" aria-label="Copy the exact text"
          onClick={() => copy(approve.body)}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <pre className="m-0 rounded-md border border-border bg-subtle px-3 py-2.5 font-mono text-[12.5px] leading-5 break-words whitespace-pre-wrap">{approve.body}</pre>
      <span className="text-xs text-muted-fg">This is the exact text that will be posted.</span>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div aria-busy="true" data-skeleton="detail" className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-border px-5 pt-3.5 pb-3"><Bar w="60%" /><Bar w="85%" h={16} /></div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <Bar w="30%" h={10} />
        <div className="flex flex-col gap-2">{['100%', '96%', '92%', '60%'].map((w) => <Bar key={w} w={w} h={14} />)}</div>
        {[1, 2, 3].map((n) => (
          <div key={n} className="flex gap-2.5 rounded-lg border border-border p-3"><Bar w="16px" h={16} /><div className="flex grow flex-col gap-1.5"><Bar w="40%" /><Bar w="80%" h={10} /></div></div>
        ))}
      </div>
    </div>
  );
}

// The note under the action bar for a record that did not go through: exit 10 (nothing changed), exit
// 11 (needs-you refused it), or any other failure, each with what the command or the server said.
function Outcome({ result, again }) {
  if (result.phase === 'nothing') {
    return (
      <div role="status" data-outcome="nothing" className="flex flex-col gap-1.5 rounded-lg border border-border bg-subtle px-3.5 py-3 text-[13px] leading-[19px]">
        <span className="font-semibold">Nothing changed:</span>
        <pre className="m-0 font-mono text-[12.5px] break-words whitespace-pre-wrap">{result.out}</pre>
      </div>
    );
  }
  const refused = result.phase === 'refused';
  return (
    <div role="alert" data-outcome={result.phase} className="flex gap-2.5 rounded-lg border border-fail-bd bg-fail-bg px-3.5 py-3 text-[13px] leading-[19px]">
      <span aria-hidden="true" className="font-semibold text-fail">×</span>
      <div className="flex min-w-0 grow flex-col gap-1.5">
        <span className="font-semibold">{refused ? "Desk didn't record that" : "Desk couldn't record that"}</span>
        <pre className="m-0 font-mono text-[12.5px] break-words whitespace-pre-wrap">{result.out || result.message}</pre>
        <div className="mt-1"><Button variant="outline" onClick={again}>Choose another answer</Button></div>
      </div>
    </div>
  );
}

// A live session's batch reads answers only when it is told: the MESSAGE line to pass it.
function SessionMessage({ message }) {
  const [copied, copy] = useCopy();
  return (
    <div data-message="" className="flex flex-col gap-2.5 rounded-lg border border-border px-3.5 py-3">
      <p className="text-[13.5px]">{message.to
        ? <>A live Claude session runs this batch (<b>{message.to}</b>). Pass it this message:</>
        : 'A live Claude session runs this batch. Pass it this message:'}</p>
      <pre className="m-0 rounded-md border border-border bg-subtle px-3 py-2 font-mono text-[12.5px] break-words whitespace-pre-wrap">{message.line}</pre>
      <div><Button variant="primary" onClick={() => copy(message.line)}>{copied ? 'Copied' : 'Copy message'}</Button></div>
      <span className="text-[12.5px] text-muted-fg">Desk can't send to a session directly yet.</span>
    </div>
  );
}

// The next item, as a recorded or vanished item's detail offers it, with j.
function NextCard({ next }) {
  return (
    <div data-next="" className="flex flex-col gap-1.5 rounded-lg border border-border px-3.5 py-3">
      <span className="text-[11px] font-semibold tracking-[.07em] text-muted-fg uppercase">Next:</span>
      {next ? (
        <div className="flex items-center gap-2 text-[13px]">
          <span aria-hidden="true" className="text-needs">◆</span>
          <span className="font-mono font-medium">{next.ticket ?? next.key}</span>
          <span className="min-w-0 flex-1 truncate">{String(next.question).split('\n')[0]}</span>
          <Kbd>j</Kbd>
        </div>
      ) : <span className="text-[13px] text-muted-fg">Nothing else needs you right now.</span>}
    </div>
  );
}

// What the detail shows once Desk recorded the item (exit 0): the question collapses to what was sent.
function Recorded({ item, result, next, nextPass }) {
  const key = item.ticket ?? item.key;
  const at = clock(result.at);
  const answer = ANSWERS.has(result.action.split(' ')[0]);
  const message = messageOf(result.out);
  const lines = recordLines(result.out);
  return (
    <div className="flex flex-col gap-3" data-recorded="">
      <div role="status" className="flex gap-2.5 rounded-lg border border-done-bd bg-done-bg px-3.5 py-3 text-[13px] leading-[19px]">
        <span aria-hidden="true" className="font-semibold text-done">✓</span>
        <div className="flex flex-col">
          <span className="font-semibold">{answer ? `Answer sent to ${key} at ${at}.` : `Recorded: ${result.label ?? result.action} for ${key} at ${at}.`}</span>
          {answer && <span>{nextPass ? `The worker picks it up at the next pass (${clock(nextPass)}).` : 'The worker picks it up at the next pass.'}</span>}
        </div>
      </div>
      {lines && <pre data-record-line="" className="m-0 rounded-md border border-border bg-subtle px-3 py-2 font-mono text-[12.5px] break-words whitespace-pre-wrap">{lines}</pre>}
      {message && <SessionMessage message={message} />}
      <NextCard next={next} />
      <p className="text-[12.5px] text-muted-fg">Desk doesn't move on by itself, so you read each question before you answer it.</p>
    </div>
  );
}

// An item a refresh dropped while it was open, that Desk did not record: answered in Terminal or
// another window (its line in needs-you's records log), or settled by itself.
function Gone({ gone, next, step }) {
  const key = gone.item.ticket ?? gone.item.key;
  return (
    <div data-gone="" className="flex flex-col items-start gap-3 p-7">
      <p className="flex items-center gap-2 text-[15px] font-semibold">
        <span aria-hidden="true" className="text-done">✓</span>
        {gone.entry ? `${key} was answered elsewhere at ${clock(gone.entry.at)}.` : `${key} left the list at ${clock(gone.at)}.`}
      </p>
      {gone.entry?.line
        ? <pre className="m-0 w-full rounded-md border border-border bg-subtle px-3 py-2 font-mono text-[12.5px] break-words whitespace-pre-wrap">{gone.entry.line}</pre>
        : <p className="text-[13px] text-muted-fg">needs-you no longer lists it: it was answered elsewhere or settled by itself.</p>}
      {next && <Button variant="outline" onClick={() => step(1)} aria-label="Next item (j)" title="Next item · j">Next item <span className="ml-1.5"><Kbd>j</Kbd></span></Button>}
    </div>
  );
}

function Detail({ item, snapshot, compact, step, result, record, go, next, nextPass, nextCheckin }) {
  const [chosen, setChosen] = useState(null);
  const [text, setText] = useState('');
  const [hint, setHint] = useState(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  const field = useRef(null);
  const question = useRef(null);
  const article = useRef(null);
  const opened = useRef(Date.now());
  const repo = repoOf(snapshot, item.repo);
  const gh = ghRepo(repo);
  const ticket = item.ticket;
  const jira = ticket && repo?.jira_browse ? `${repo.jira_browse}${ticket}` : null;
  const options = optionsOf(item, repo, gh).map((o, i) => ({ ...o, n: o.action === 'drop' ? null : i + 1 }));
  const recommended = options.some((o) => o.recommended);
  const o = options.find((x) => x.id === chosen) ?? null;
  const busy = result?.phase === 'busy';
  const done = result?.phase === 'done';

  // The question counts as read once any of it has been on screen.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || !question.current) return undefined;
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) setSeen(true); });
    io.observe(question.current);
    return () => io.disconnect();
  }, []);

  const typed = o?.needs_text ? text : '';
  const command = o?.run === 'record' ? recordCommand(item, o.action, typed) : null;
  const why = !o ? 'Choose an answer first.'
    : o.needs_text && !text.trim() ? 'Say what to do first.'
      : o.run === 'record' && !recordsHere(item, o.action) ? COPY_ONLY
        : o.run === 'record' && !repo?.slug ? `Desk can't find ${item.repo} among its repos, so it can't record this.`
          : o.run === 'open' && !o.url ? `${item.repo} has no GitHub repo set, so Desk can't open the PR.` : null;
  const act = () => {
    if (!o || why || busy || done) return;
    if (o.run === 'open') window.desk?.openExternal?.(o.url);
    else if (o.run === 'go') go?.(o.path);
    else record(item, o, o.needs_text ? text : undefined);
  };
  // ⏎ answers only once the question has been read: shown for a second, and on screen.
  const press = () => {
    if (busy || done) return;
    if (Date.now() - opened.current < READ_MS || !seen) {
      question.current?.scrollIntoView?.({ block: 'nearest' });
      setHint('Read the question first, then press ⏎.');
      return;
    }
    setHint(why);
    act();
  };
  const again = () => {
    const radios = [...(article.current?.querySelectorAll('input[type="radio"]') ?? [])];
    (radios.find((r) => r.checked) ?? radios[0])?.focus();
  };

  useEffect(() => {
    const key = (e) => {
      if (e.key === 'Enter') {
        const t = e.target, tag = t?.tagName ?? '';
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || t?.isContentEditable) return;
        if (/^(BUTTON|A|TEXTAREA|SELECT)$/.test(tag) || (tag === 'INPUT' && t.type !== 'radio')) return;
        e.preventDefault();
        press();
        return;
      }
      if (busy || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = /^[1-9]$/.test(e.key) ? options.find((x) => x.n === Number(e.key)) : null;
      if (n) { e.preventDefault(); setChosen(n.id); setHint(null); }
      if (e.key === 'a' && field.current) { e.preventDefault(); field.current.focus(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const decisions = item.actions.filter((a) => a.action.startsWith('override ') && a.note);
  const tabs = [
    { id: 'pr', label: 'PR & CI', body: item.pr != null
      ? <p><ExternalLink text={`PR #${item.pr}`} url={gh ? `https://github.com/${gh}/pull/${item.pr}` : null} where="GitHub" /> · ⌘-click to open it on GitHub.</p>
      : <p>{ticket ?? item.key} has no pull request yet.</p> },
    { id: 'jira', label: 'Jira', body: jira
      ? <p><TicketLink ticket={ticket} browse={repo.jira_browse} /> · ⌘-click to open it in Jira.</p>
      : <p>{ticket ? `${item.repo} has no Jira site set, so ${ticket} has no Jira page here.` : 'This item is not a ticket.'}</p> },
    { id: 'decisions', label: decisions.length ? `Decisions (${decisions.length})` : 'Decisions', body: decisions.length
      ? <ul className="flex flex-col gap-1">{decisions.map((d) => <li key={d.action}>{d.note}</li>)}</ul>
      : <p>No decisions taken on {ticket ?? item.key} that you can override.</p> },
  ];

  return (
    <article ref={article} aria-label={`${item.key} detail`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-border px-5 pt-3.5 pb-3">
        <div className="flex items-center gap-2 text-[12.5px] whitespace-nowrap text-muted-fg">
          <span className={`font-mono text-[13px] font-semibold ${item.production_broken ? 'text-fail' : 'text-needs'}`}>
            {item.production_broken ? '!' : '◆'} {ticket ? <TicketLink ticket={ticket} browse={repo?.jira_browse ?? null} /> : item.key}
          </span>
          <Kind kind={item.kind} />
          <span>{item.repo}</span>
          <span>·</span>
          <span>waited {waitedText(item)}</span>
          {item.behind > 0 && <><span>·</span><span>⧗ {item.behind} behind</span></>}
          <span className="flex-1" />
          <button type="button" aria-label="Previous item (k)" title="Previous item · k" onClick={() => step(-1)} className="flex size-7 items-center justify-center rounded-md hover:bg-muted">‹</button>
          <button type="button" aria-label="Next item (j)" title="Next item · j" onClick={() => step(1)} className="flex size-7 items-center justify-center rounded-md hover:bg-muted">›</button>
        </div>
      </header>
      <div className={`flex min-h-0 flex-1 flex-col gap-4 overflow-auto py-4 ${compact ? 'px-4' : 'px-5'}`}>
        {done ? <Recorded item={item} result={result} next={next} nextPass={nextPass} /> : <>
        <section className="flex flex-col gap-2" aria-labelledby="needs-answer">
          <span id="needs-answer" className="text-[11px] font-semibold tracking-[.07em] text-muted-fg uppercase">Needs your answer</span>
          <div ref={question} data-question="" className="max-w-[60ch] rounded-r-md border-l-[3px] border-needs-solid bg-needs-bg py-3 pr-4 pl-[15px] text-[15px] leading-6 break-words whitespace-pre-wrap">
            <Linked text={item.question} repo={repo} />{item.note ? <> <Linked text={item.note} repo={repo} /></> : null}
          </div>
        </section>
        {item.approve && <GateBlock approve={item.approve} />}
        <section className="flex flex-col gap-2" aria-labelledby="your-answer">
          <span id="your-answer" className="text-[11px] font-semibold tracking-[.07em] text-muted-fg uppercase">Your answer</span>
          {!recommended && <p className="text-[13px] text-muted-fg">No recommendation: this needs something only you know.</p>}
          <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
          <div role="radiogroup" aria-labelledby="your-answer" className={`flex flex-col gap-2 ${busy ? 'opacity-60' : ''}`}>
            {options.map((c) => {
              const on = chosen === c.id;
              return (
                <label key={c.id} className={`flex cursor-default gap-3 rounded-lg border bg-background px-3 py-2.5 ${on ? 'border-foreground shadow-[0_0_0_1px_var(--foreground)]' : 'border-border'}`}>
                  <input type="radio" name={`answer ${item.id}`} value={c.id} checked={on} onChange={() => { setChosen(c.id); setHint(null); }} className="mt-0.5 size-4 accent-foreground" />
                  <div className="flex min-w-0 grow flex-col">
                    <span className="flex items-center gap-2 text-[13.5px] font-medium">
                      {c.run === 'open' || c.run === 'go' ? <span aria-hidden="true" className="text-muted-fg">↗</span> : null}
                      {c.label}
                      {c.recommended && <span className="rounded-md border border-border px-1.5 text-[11px] font-medium text-foreground">Recommended</span>}
                      <span className="ml-auto">{c.n != null && <Kbd>{c.n}</Kbd>}</span>
                    </span>
                    {(c.why ?? c.note) && <span className="mt-0.5 text-[13px] leading-[18px] text-muted-fg">{c.why ?? c.note}</span>}
                    {on && c.needs_text && (
                      <span className="mt-2.5 flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-foreground" id={`text-${item.id}`}>{textAsk(c.action)}</span>
                        <textarea ref={field} aria-labelledby={`text-${item.id}`} value={text} maxLength={MAX_TEXT} rows={3}
                          onChange={(e) => setText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') e.currentTarget.blur();
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); press(); }
                          }}
                          placeholder={TEXT_ASKS[c.action.split(' ')[0]] ? (c.note ?? '') : "Say what to do, in the worker's terms. It's passed on word for word."}
                          className="rounded-md border border-input bg-background px-2.5 py-2 text-[13px]" />
                        <span className="flex text-xs text-muted-fg">
                          Don't paste tokens or passwords. This text is saved and passed on as written.
                          {text.length > 1500 && <span className="ml-auto tabular-nums">{text.length.toLocaleString('en-GB')} / 2,000</span>}
                        </span>
                      </span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          </fieldset>
          <div className="mt-1 flex flex-wrap items-center gap-3" data-actions="">
            <span className="inline-flex" title={busy ? undefined : (why ?? undefined)}>
              {o?.run === 'open' || o?.run === 'go'
                ? <Button variant="primary" disabled={!!why} onClick={act}>{primaryLabel(item, o, nextCheckin)}{o.run === 'open' && <span aria-hidden="true" className="ml-1">↗</span>}<span className="ml-2"><Kbd>⏎</Kbd></span></Button>
                : <WriteButton variant="primary" disabled={!!why || busy} aria-busy={busy || undefined} onClick={act}>
                  {busy ? <><Ring /><span className="ml-1.5">{ANSWERS.has(result.action.split(' ')[0]) ? 'Sending answer…' : 'Recording…'}</span></> : <>{primaryLabel(item, o, nextCheckin)}<span className="ml-2"><Kbd>⏎</Kbd></span></>}
                </WriteButton>}
            </span>
            <CopyCommand command={command} why={why ?? (o && o.run !== 'record' ? 'This answer runs no needs-you command.' : 'Choose an answer first.')} />
          </div>
          {hint && <p role="status" data-hint="" className="text-[12.5px] text-needs">{hint}</p>}
          {command && <div data-runs="" className="truncate font-mono text-[11.5px] leading-4 text-muted-fg" title={command}>Runs: {command}</div>}
          {o?.run === 'open' && o.url && <div data-opens="" className="truncate font-mono text-[11.5px] leading-4 text-muted-fg">Opens: {o.url}</div>}
          {o?.run === 'go' && <div data-opens="" className="font-mono text-[11.5px] leading-4 text-muted-fg">Opens: Usage &amp; costs</div>}
          {item.kind === 'usage' && <p className="text-[12.5px] text-muted-fg">Every subscription change happens in Usage &amp; costs, not here.</p>}
          {result && ['nothing', 'refused', 'failed'].includes(result.phase) && <Outcome result={result} again={again} />}
        </section></>}
        <div className="flex flex-wrap gap-1.5 text-[12.5px]">
          {item.pr != null && <span className="inline-flex h-7 items-center rounded-md border border-border px-2"><ExternalLink text={`PR #${item.pr}`} url={gh ? `https://github.com/${gh}/pull/${item.pr}` : null} where="GitHub" /></span>}
          {jira && <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2"><TicketLink ticket={ticket} browse={repo.jira_browse} /> in Jira</span>}
        </div>
        <Tabs key={item.id} tabs={tabs} compact={compact} />
      </div>
    </article>
  );
}

// The stamp at the header's right: what the list was read as of, and whether GitHub answered.
function Stamp({ data, checking, check }) {
  if (checking) return <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-fg" role="status"><Ring />Checking GitHub and Jira…</span>;
  if (!data) return null;
  const gh = data.github;
  const at = clock(gh && !gh.ok ? (data.settled_at ?? data.generated_at) : data.generated_at);
  if (gh && !gh.ok) return <span className="text-xs whitespace-nowrap text-muted-fg" role="status">◌ As of {at} · {gh.reason === 'signin' ? 'GitHub sign-in expired' : "GitHub didn't answer"}</span>;
  return (
    <span className="inline-flex gap-1.5 text-xs whitespace-nowrap text-muted-fg" role="status">
      As of {at} ·
      <button type="button" onClick={check} className="text-foreground underline decoration-ring underline-offset-2">Check now</button>
    </span>
  );
}

// "7 workers are running. The next pass is at 10:11, and the next check-in is at 17:00."
export function quietLine(running, nextPass, nextCheckin) {
  const w = running ? `${running} worker${running === 1 ? ' is' : 's are'} running.` : 'No workers are running.';
  const pass = nextPass ? `the next pass is at ${clock(nextPass)}` : null;
  const checkin = nextCheckin ? `the next check-in is at ${clock(nextCheckin)}` : null;
  const then = [pass, checkin].filter(Boolean).join(', and ');
  return then ? `${w} ${then[0].toUpperCase()}${then.slice(1)}.` : w;
}

// The toast after e: the item put off, with Undo (⌘Z) and a bar that drains over the 10 s it is offered.
function PutOff({ toast, undo }) {
  const [full, setFull] = useState(true);
  useEffect(() => { const t = setTimeout(() => setFull(false), 0); return () => clearTimeout(t); }, [toast.id]);
  return (
    <div role="status" data-toast="" className="fixed right-4 bottom-4 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-[13.5px] shadow-lg">
      <div className="flex items-center gap-3 px-4 py-3">
        <span>{toast.error ?? `${toast.key} put off until the next check-in.`}</span>
        {!toast.error && <Button variant="outline" onClick={undo} disabled={toast.undoing}>Undo (⌘Z)</Button>}
      </div>
      <span aria-hidden="true" className="h-0.5 bg-muted-fg transition-[width] ease-linear motion-reduce:transition-none"
        style={{ width: full ? '100%' : '0%', transitionDuration: `${UNDO_MS}ms` }} />
    </div>
  );
}

// A write's result, from the record route's answer: exit 0 done, 10 nothing, 11 refused, else failed.
async function resultOf(r) {
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  const exit = body?.exit;
  const phase = exit === 0 ? 'done' : exit === 10 ? 'nothing' : exit === 11 ? 'refused' : 'failed';
  const message = body?.error?.message ?? ([body?.stdout, body?.stderr].filter(Boolean).join('\n').trim() || `Desk's server answered ${r.status}. See the server log.`);
  return { phase, out: typeof body?.stdout === 'string' ? body.stdout.replace(/\n$/, '') : '', message };
}

// `get` is the window's fetch, `snapshot` the live one: a change to its needs-you figures reads the list
// again. `go` opens another screen.
export function Inbox({ get, snapshot, go }) {
  const [data, setData] = useState(null);
  const [results, setResults] = useState({});
  const [toast, setToast] = useState(null);
  const [gone, setGone] = useState(null);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [sel, setSel] = useState(null);
  const [repoF, setRepoF] = useState('');
  const [kindF, setKindF] = useState('');
  const [sort, setSort] = useState('oldest');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const compact = useWidth() < COMPACT_BELOW;
  const busy = useRef(false);
  const lastSettle = useRef(-Infinity);
  const rows = useRef(new Map());
  const picked = useRef(false);

  const load = useCallback(async (settle) => {
    // A press while a check runs is that check; one within a minute of the last reads the list only.
    // The minute runs from a check GitHub answered, as the server's does: after a failed one, Try again checks again.
    if (settle && busy.current) return;
    const settling = settle && Date.now() - lastSettle.current >= SETTLE_EVERY_MS;
    const started = Date.now();
    if (settling) { busy.current = true; setChecking(true); }
    try {
      const r = await get(`/api/inbox?settle=${settling ? 1 : 0}`);
      if (r.status !== 200) throw new Error(String(r.status));
      const body = await r.json();
      if (settling && body.github?.ok) lastSettle.current = started;
      setData(body);
      setFailed(false);
    } catch { setFailed(true); }
    finally { if (settling) { busy.current = false; setChecking(false); } }
  }, [get]);

  const figures = JSON.stringify([snapshot?.needs_you, (snapshot?.repos ?? []).map((r) => [r.slug, r.needs_you, r.production_broken])]);
  useEffect(() => { load(false); }, [load, figures]);

  // An item Desk recorded leaves the list at once, before needs-you's next read drops it. Once a read
  // has dropped it (`left`), a later read that lists it again is a new question, and it shows.
  const items = useMemo(() => (data?.items ?? []).filter((i) => !(results[i.id]?.phase === 'done' && !results[i.id].left)), [data, results]);
  const shown = useMemo(() => {
    let out = items.filter((i) => (!repoF || i.repo === repoF) && (!kindF || i.kind === kindF));
    if (sort === 'held') out = [...out].sort((a, b) => (b.behind ?? 0) - (a.behind ?? 0));
    if (sort === 'repo') out = [...out].sort((a, b) => a.repo.localeCompare(b.repo));
    return [...out.filter((i) => i.production_broken), ...out.filter((i) => !i.production_broken)];
  }, [items, repoF, kindF, sort]);
  const broken = shown.filter((i) => i.production_broken);
  const rest = shown.filter((i) => !i.production_broken);

  // The detail opens by itself on a production-broken item, or on the only item; otherwise Ben picks.
  // A refresh that drops the open item Desk did not record: it was answered elsewhere (or settled by
  // itself), which the detail says, with needs-you's records log line where it has one.
  const before = useRef([]);
  const beforeAt = useRef(null);
  useEffect(() => {
    if (!data) return;
    const all = data.items ?? [];
    const listed = new Set(all.map((i) => i.id));
    // A recorded item a read no longer lists has left; one listed again after that is asked afresh.
    setResults((r) => {
      let changed = false;
      const out = { ...r };
      for (const [id, x] of Object.entries(r)) {
        if (x.phase !== 'done') continue;
        if (!listed.has(id) && !x.left) { out[id] = { ...x, left: true }; changed = true; }
        else if (listed.has(id) && x.left) { delete out[id]; changed = true; }
      }
      return changed ? out : r;
    });
    // Desk's own record (sent, or still sending) is not "elsewhere"; one it was refused or failed is.
    if (sel && !listed.has(sel) && !['done', 'busy'].includes(results[sel]?.phase)) {
      const was = before.current.find((i) => i.id === sel);
      if (was) {
        // Only a record made since the last read that still listed it answered this question.
        const since = Date.parse(beforeAt.current ?? '') || -Infinity;
        const entry = [...(data.recorded ?? [])].reverse().find((e) => e.key === was.key && (e.batch === was.batch || !e.batch) && Date.parse(e.at) > since) ?? null;
        setGone({ id: sel, item: was, entry, at: data.generated_at ?? new Date().toISOString(), next: nextOf(sel, before.current.filter((i) => listed.has(i.id) || i.id === sel)) });
      }
      setSel(null);
    }
    before.current = shownOf(all);
    beforeAt.current = data.generated_at ?? new Date().toISOString();
    if (picked.current) return;
    const first = items.find((i) => i.production_broken) ?? (items.length === 1 ? items[0] : null);
    if (first) { setSel(first.id); picked.current = true; }
  }, [data]);

  // The list as shown, for an item list: the same filters and order as `shown`.
  function shownOf(list) {
    const ids = new Set(list.map((i) => i.id));
    return shown.filter((i) => ids.has(i.id)).concat(list.filter((i) => !shown.some((s) => s.id === i.id)));
  }
  // The item after `id` in `list`, else the one before it, else null.
  function nextOf(id, list = shown) {
    const at = list.findIndex((i) => i.id === id);
    if (at < 0) return list[0] ?? null;
    return list[at + 1] ?? list[at - 1] ?? null;
  }

  const select = (id, focus = false) => {
    picked.current = true;
    setGone(null);
    setSel(id);
    if (focus) requestAnimationFrame(() => rows.current.get(id)?.focus());
  };
  const step = (by) => {
    if (!shown.length) return;
    // From an item that just left the list, j goes to the one that was after it.
    const after = results[sel]?.phase === 'done' ? results[sel].next : gone ? gone.next : undefined;
    if (by > 0 && after && shown.some((i) => i.id === after.id)) return select(after.id, true);
    const at = shown.findIndex((i) => i.id === sel);
    const next = shown[at < 0 ? (by > 0 ? 0 : shown.length - 1) : Math.min(shown.length - 1, Math.max(0, at + by))];
    select(next.id, true);
  };

  const record = async (item, option, text) => {
    const slug = repoOf(snapshot, item.repo)?.slug;
    const next = nextOf(item.id);
    setResults((r) => ({ ...r, [item.id]: { phase: 'busy', action: option.action, label: option.id === 'wait' ? option.label : null, item } }));
    let res;
    try {
      const r = await get(`/api/repos/${encodeURIComponent(slug)}/tickets/${encodeURIComponent(item.key)}/record`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(text === undefined ? { action: option.action, batch: item.batch } : { action: option.action, text, batch: item.batch }),
      });
      res = await resultOf(r);
      // An instruction (admit, a plan-first start) exits 0 having recorded nothing: the item stays.
      if (res.phase === 'done' && NOTHING_RECORDED.test(res.out.split('\n')[0])) res = { ...res, phase: 'nothing' };
    } catch { res = { phase: 'failed', out: '', message: "Desk couldn't reach its server, so nothing was recorded. Try again once it's back." }; }
    const at = new Date().toISOString();
    setResults((r) => ({ ...r, [item.id]: { ...r[item.id], ...res, at, next } }));
    return res;
  };
  // e: put the open item off at once, with 10 s to take it back.
  const putOff = async (item) => {
    const o = item.actions.find((a) => a.action === 'not-now');
    if (!o || results[item.id]?.phase === 'busy' || results[item.id]?.phase === 'done') return;
    const res = await record(item, { ...o, id: o.action }, undefined);
    if (res.phase === 'done') setToast({ id: item.id, key: item.ticket ?? item.key, item, until: Date.now() + UNDO_MS });
  };
  const undo = async () => {
    const t = toast;
    if (!t || t.undoing || t.error) return;
    setToast({ ...t, undoing: true });
    const slug = repoOf(snapshot, t.item.repo)?.slug;
    let failed = null;
    try {
      const r = await get(`/api/repos/${encodeURIComponent(slug)}/tickets/${encodeURIComponent(t.item.key)}/undo-not-now`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (r.status !== 200) failed = (await resultOf(r)).message;
    } catch { failed = "Desk couldn't reach its server."; }
    if (failed) { setToast({ ...t, error: `Desk couldn't take that back: ${failed}`, until: Date.now() + UNDO_MS }); return; }
    setResults((r) => { const { [t.id]: _, ...rest } = r; return rest; });
    setToast(null);
    select(t.id);
    load(false);
  };
  useEffect(() => {
    if (!toast) return undefined;
    const left = toast.until - Date.now();
    const timer = setTimeout(() => setToast(null), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const key = (e) => {
      if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !typing(e) && toast && !toast.error) { e.preventDefault(); undo(); return; }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'k') { e.preventDefault(); step(e.key === 'j' ? 1 : -1); }
      else if (e.key === 'r') { e.preventDefault(); load(true); }
      else if (e.key === 'e' && current) { e.preventDefault(); putOff(current); }
      else if (e.key === 'Escape' && results[sel]?.phase !== 'busy') { setSel(null); setGone(null); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const repoNames = [...new Set([...(snapshot?.repos ?? []).filter((r) => !r.error).map((r) => r.name), ...items.map((i) => i.repo)])];
  const count = (f) => items.filter(f).length;
  const filters = (
    <>
      <Select label="Repo" value={repoF} onChange={setRepoF} options={[['', 'All repos'], ...repoNames.map((n) => [n, `${n} ${count((i) => i.repo === n)}`])]} />
      <Select label="Kind" value={kindF} onChange={setKindF} options={[['', 'All kinds'], ...[...new Set(items.map((i) => i.kind))].map((k) => [k, `${k} ${count((i) => i.kind === k)}`])]} />
      <Select label="Sort" value={sort} onChange={setSort} options={Object.entries(SORTS)} />
    </>
  );
  const active = [repoF && ['repo', repoF, () => setRepoF('')], kindF && ['kind', kindF, () => setKindF('')], sort !== 'oldest' && ['sort', SORTS[sort], () => setSort('oldest')]].filter(Boolean);
  const clear = () => { setRepoF(''); setKindF(''); setSort('oldest'); };
  const oldest = items.reduce((m, i) => (!m || hoursOf(i) > hoursOf(m) ? i : m), null);
  const current = items.find((i) => i.id === sel) ?? results[sel]?.item ?? null;
  const gh = data?.github;

  const rowOf = (i) => (
    <Row key={i.id} item={i} on={i.id === sel} compact={compact} showRepo={!repoF} select={() => select(i.id)}
      rowRef={(el) => { if (el) rows.current.set(i.id, el); else rows.current.delete(i.id); }} />
  );

  let list;
  if (!data && !failed) {
    list = <ul aria-busy="true" aria-label="Loading the needs-you list" data-skeleton="list" className="flex flex-col">
      {Array.from({ length: 8 }, (_, n) => <li key={n} className="flex h-9 items-center gap-2 border-b border-faint pr-3.5 pl-[22px]"><Bar w="12px" /><Bar w="64px" /><Bar w={`${30 + ((n * 17) % 40)}%`} /><span className="flex-1" /><Bar w="44px" /></li>)}
    </ul>;
  } else if (data && !items.length) {
    list = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center" data-empty="">
        <span aria-hidden="true" className="text-[28px] text-done">✓</span>
        <h2 className="text-lg font-semibold tracking-tight">Nothing needs you</h2>
        <p className="max-w-[40ch] text-[13.5px] leading-[21px] text-muted-fg">{quietLine(snapshot?.machine?.running ?? 0, data.next_pass_at, data.next_checkin_at)}</p>
      </div>
    );
  } else if (data && !shown.length) {
    const others = items.length;
    list = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2.5 p-10 text-center" data-filtered-empty="">
        <p className="font-semibold">{repoF ? `No items in ${repoF} match these filters.` : 'No items match these filters.'}</p>
        <p className="text-[13px] text-muted-fg">{others} other{others === 1 ? ' needs' : 's need'} you.</p>
        <Button variant="outline" onClick={clear}>Clear filters</Button>
      </div>
    );
  } else {
    list = (
      <ul role="listbox" aria-label="Needs you" className="flex flex-col">
        {broken.length > 0 && <li role="presentation" className="flex h-[30px] items-center gap-2 pr-3.5 pl-[22px] text-xs font-medium text-fail"><span aria-hidden="true">!</span>Production broken · {broken.length}</li>}
        {broken.map(rowOf)}
        {rest.map(rowOf)}
      </ul>
    );
  }

  return (
    <main className="flex h-full min-h-0 flex-col" aria-label="Inbox">
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-5">
        <h1 className="text-lg leading-6 font-semibold tracking-tight whitespace-nowrap">Inbox</h1>
        {items.length > 0 && <span className="text-[13px] whitespace-nowrap text-muted-fg tabular-nums">{items.length} need{items.length === 1 ? 's' : ''} you · oldest {waitedText(oldest)}</span>}
        <span className="flex-1" />
        {data && items.length > 0 && (compact
          ? <Button variant="outline" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((x) => !x)}>Filter</Button>
          : filters)}
        <Stamp data={data} checking={checking} check={() => load(true)} />
      </div>
      {compact && filtersOpen && <div className="flex shrink-0 flex-wrap gap-2 border-b border-border px-5 py-2" data-filters="">{filters}</div>}
      {active.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-5 py-2 text-xs">
          <span className="mr-1 text-muted-fg">Showing</span>
          {active.map(([id, label, off]) => (
            <button key={id} type="button" onClick={off} aria-label={`Remove the ${label} filter`} className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 font-medium">{label} ×</button>
          ))}
        </div>
      )}
      {(failed || (gh && !gh.ok)) && (
        <div className="shrink-0 px-5 py-3">
          {failed ? (
            <Alert action={<Button variant="outline" onClick={() => load(false)}>Try again</Button>}>
              {data ? "Showing the last list. Desk couldn't read needs-you's list again; see the server log." : "Desk couldn't read needs-you's list; see the server log."}
            </Alert>
          ) : gh.reason === 'signin' ? (
            <Alert>
              <p className="font-semibold">GitHub sign-in has expired, so PR items can't be checked.</p>
              <Command text="gh auth login" />
              <div><Button variant="outline" onClick={() => load(true)}>Check again</Button></div>
            </Alert>
          ) : (
            <Alert action={<Button variant="outline" onClick={() => load(true)}>Try again</Button>}>
              Showing the last list. GitHub isn't answering ({gh.detail}), so new PR items may be missing.
            </Alert>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className={`flex min-h-0 flex-col overflow-auto ${compact ? 'w-100 shrink-0' : 'min-w-110 flex-1'}`} data-list="">
          {list}
          {data?.put_off > 0 && <p className="flex h-[30px] shrink-0 items-center gap-2 pr-3.5 pl-[22px] text-xs font-medium text-muted-fg">Put off · {data.put_off} <span className="font-normal">left out until they change</span></p>}
        </div>
        {(!data || items.length > 0 || current || gone) && (
          <div className={`flex min-h-0 flex-col overflow-hidden border-l border-border ${compact ? 'min-w-142 flex-1' : 'w-130 shrink-0'}`} data-detail="">
            {!data ? <DetailSkeleton />
              : current ? <Detail key={current.id} item={current} snapshot={snapshot} compact={compact} step={step} go={go}
                result={results[current.id] ?? null} record={record} next={results[current.id]?.next ?? null}
                nextPass={data.next_pass_at} nextCheckin={data.next_checkin_at} />
                : gone ? <Gone gone={gone} next={gone.next && items.some((i) => i.id === gone.next.id) ? gone.next : (items[0] ?? null)} step={step} />
                  : <p className="m-auto max-w-[36ch] text-center text-[13px] text-muted-fg">Choose an item to read its question, or press <Kbd>j</Kbd> to open the first.</p>}
          </div>
        )}
      </div>
      {toast && <PutOff key={toast.id + (toast.error ? ':error' : '')} toast={toast} undo={undo} />}
    </main>
  );
}
