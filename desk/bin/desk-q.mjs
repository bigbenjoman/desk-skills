#!/usr/bin/env node
// desk-q: every autopilot queue on this computer, from the files alone. It reads the repo configs,
// each repo's queue.json, its orchestrator heartbeats and its triage records. Repos are found on
// disk every run, so a newly set-up repo appears with no change here.
//
//   desk-q [--plain] [--all]             one line per batch: live first, then quiet ones that need you
//   desk-q [--plain] <repo>              that repo's unfinished tickets grouped by state, each group in spawn order
//   desk-q [--plain] <repo> show <KEY>   one ticket in full
//   desk-q ships [<repo>]                the Timeline: a bar per unfinished ticket from when it starts
//                                        to when it ships (`when` too), and in one repo with an epic, a bar
//                                        per epic first; with --plain, one line per ticket, then one per
//                                        epic with children in the queue
//   desk-q <repo> days, desk-q days      By day: the tickets grouped by the day they ship
//   desk-q costs                         every name's charge this month, from the cost cache, each repo's
//                                        Claude and Codex use at list prices, and each subscription's fee
//   desk-q costs <repo>                  one repo's (or name's) charge this month by supplier
//   desk-q <repo> up|down|top|bottom <KEY>   move a ticket in the spawn order (queue.mjs move)
//   desk-q <repo> move <KEY> <n>         put it at position n of the unfinished tickets
//   desk-q <repo> workers <n>            the batch's worker count (queue.mjs set-batch), up to the cap
//   desk-q <repo> supervisor [on|off]    the repo's supervisor: its status, or install or uninstall it
//   desk-q levers                        opens the Levers page in the browser, rebuilt first when it is
//                                        over 10 minutes old (levers-refresh.mjs); with --plain, prints
//                                        home's Levers line and the page's path
//   desk-q --json home [--all] | repo <repo> | ticket <repo> <KEY> | usage | costs [<repo>]
//                                        the view as JSON: its figures, each input's age, and its plain
//                                        lines; home carries the Levers line's figures from view.json
//
// A repo is named by its short name or any unique prefix of it, which is its standing batch; a named
// batch (an epic's) has a row of its own and is named `<repo>:<name>`. In a terminal, without --plain,
// the same views open full-screen, with arrow keys, Enter and Esc, ←→, Tab or 1–6 for a place's Queue,
// Timeline, By day and Epics, Costs on home and on a repo, and Usage, every Claude and Codex login on this
// computer, and clicks on the breadcrumb, the tabs, the rows and home's Levers line (as v, which opens
// the Levers page); piped output gets the plain text.
// The only queue writes are the move and workers commands, each a queue.mjs command against the queue
// of the repo named. Usage changes a login's rule or removes it with desk-env's logins set and remove,
// and adds one by showing its sign-in command and waiting until it is signed in; a Codex login's folder
// is made then, with the label it is listed under. The supervisor command runs that repo's supervisor.mjs install, uninstall or
// status, and changes no config row or approval. The one other write is a repo's <state>/eta.jsonl,
// which gains a ticket's first ship estimate the first time a live batch's forecast dates it.
//
// This file is the full-screen view and the command line. Everything else, the views, their JSON and the
// one-shot commands, is desk-q-model.mjs, which loads no terminal code; this file re-exports it.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { availableGiB,costsPath, subscriptionsPath } from './desk-env.mjs';
import { describeCrash } from './batch-state.mjs';
import { backend } from './run-by.mjs';
import { probe, PROBE_EVERY_MS } from './usage-probe.mjs';
import { claudeLogins } from './claude-logins.mjs';
import { codexLogins } from './codex-usage.mjs';
import { defaultLogin, dropNewFolder, login as makeLogin, makeLabelledFolder, multiAccount, needsPinMigration, nextLoginFolder, readSubscriptions, signInParts } from './logins.mjs';
import { startRefresh } from './cost-cache.mjs';
import { readCosts } from './costs.mjs';
import { pageState } from './levers-refresh.mjs';
import { newBuild, oneBuild } from './build-memo.mjs';
import { serverModel } from './desk-q-server.mjs';
import { schedulerFresh } from './desk-ui-probes.mjs';
import { LABEL, cut, wrap, stateStamp, attention, epicShort, epicIn, GREY, DIM, BOLD, FAINT, STATE_SGR, YOU_BOLD, BAND, UNDERLINE, segLine, dim,
  timelineParts, daysParts, epicsParts, SUPPLIER_LABEL, SUPPLIER_BILL, costsParts, costNameOf, supplierParts, supplierPageParts, parkedBadge,
  openLeversPage, leversDue, U_NAME, accountOf, loginLabel, checkKey, sameAccountAs, unusable, pickKeys, DROP_IN, DROP_W, R_RUNS, addingName,
  usageParts, usageLines, usageOf, forgetLogins, overviewParts, hhmm, repoParts, logPath, ticketParts, prToOpen, shownState, shownRepos, repoPlace,
  forecastOf, runningOn, andList, probesDue, ZOOMS, Usage, resolveRepo, isWrite, isCommand, target, apply, supervisorState, noSupervisor, readHidden, writeHidden,
  checkFlags, loadOrRefuse, scopeWord, run, SELECT_BG, OPT_ON, OPT_BOLD, OPT_GREY, OPT_GOOD, printable, systemOpener, REREAD_MS, costCheck, jiraBrowseOf } from './desk-q-model.mjs';

export * from './desk-q-model.mjs';

// ---- the interactive screen --------------------------------------------------------------------

export const REFRESH_MS = 2000;
const LOG_LINES = 40;
const MOVE_KEYS = 'shift+↑↓ move · t top · b bottom · + − workers';
// The question before the supervisor goes off, in the terminal's own text colour with its keys bold.
export const askLine = (name) => segLine([[`Turn off the supervisor for ${name}? Running workers finish.  `, null], ['y', BOLD], [' / ', null], ['n', BOLD]]);
const labelLine = (text) => segLine([['Label for the new Codex login: ', BOLD], [text, null], ['  enter add · esc cancel', DIM]]);
const ESC = '\x1b[';
// Mouse reporting in SGR form (1000 + 1006), so a click on the breadcrumb, a tab or a row arrives
// as ESC [ < button ; column ; row M.
const ENTER_SCREEN = `${ESC}?1049h${ESC}?25l${ESC}?1000h${ESC}?1006h`;
export const LEAVE_SCREEN = `${ESC}?1006l${ESC}?1000l${ESC}?25h${ESC}?1049l`;
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL_MS = 30;
const REVERSE = '7';
// The views every place but a ticket has, in the order Tab and the number keys take them. An epic
// has every one but Epics, Costs and Usage, and a name whose repo isn't set up here has only Costs.
// Usage is this computer's, the same on every place that has it.
export const VIEWS = [['queue', 'Queue'], ['timeline', 'Timeline'], ['days', 'By day'], ['epics', 'Epics'], ['costs', 'Costs'], ['usage', 'Usage']];
const VIEW_KEYS = '←→ or 1–6 view';
export const REORDER_HERE = 'Reorder on the Queue view (press 1). The dates follow.';
// An epic's Queue hides the tickets a move steps past, so the order is set on the repo's.
export const REORDER_IN_REPO = "Reorder on the repo's Queue (esc, then 1). The dates follow.";
export const NO_EPICS_HERE = "An epic has no Epics view: you're already in one.";
export const NO_COSTS_HERE = "An epic has no Costs view: its repo's is esc, then 5.";
export const NO_USAGE_HERE = 'An epic has no Usage view: every login is on esc, then 6.';
export const onlyCosts = (name) => `${name} isn't set up in desk here, so it has only Costs.`;

function jiraUrlFor(slug, key) {
  const browse = jiraBrowseOf(slug);
  return browse ? `${browse}${key}` : null;
}

// Text onto the clipboard: pbcopy on macOS, else wl-copy or xclip, else the terminal's own clipboard
// through an OSC 52 sequence written to `out` when it is a terminal. Throws when none can.
function systemCopier(text, out = null) {
  const tries = process.platform === 'darwin' ? [['pbcopy', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]];
  for (const [bin, args] of tries) { try { execFileSync(bin, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }); return; } catch { /* the next */ } }
  if (out?.isTTY) { out.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`); return; }
  throw new Error(`no clipboard command (${tries.map(([b]) => b).join(', ')}) worked`);
}

// `desk-env logins <args>` (or `subscription <args>`) in the background, so a check that calls each
// login's CLI, or a rule change that checks first, never holds the screen. done({ code, out, err }).
const DESK_ENV_MJS = join(dirname(fileURLToPath(import.meta.url)), 'desk-env.mjs');
const deskEnvLogins = (args, done) => deskEnvRun(['logins', ...args], done);
// What a desk-env logins run that migrated the file printed (the dated backup, each row's before and
// after, why ~/.claude moved), as lines for the message, or [] when it moved and changed nothing.
function migrationSaid(r) {
  const out = String(r?.code === 0 ? r.out ?? '' : '').split('\n').filter((l) => l.trim());
  return out.some((l) => / -> | moved to Removed: /.test(l)) ? out.filter((l) => / -> | moved to Removed: |\(previous copy: /.test(l)) : [];
}
const deskEnvSubscription = (args, done) => deskEnvRun(['subscription', ...args], done);
function deskEnvRun(args, done) {
  const p = spawn(process.execPath, [DESK_ENV_MJS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => done({ code: 1, out, err: e.message }));
  p.on('close', (code) => done({ code, out, err }));
}
// The Levers page's refresh (levers-refresh.mjs) in the background, so the screen keeps drawing while it
// builds. done() once it has ended, whatever it did: the page and build.json say.
const LEVERS_REFRESH_MJS = join(dirname(fileURLToPath(import.meta.url)), 'levers-refresh.mjs');
function rebuildLevers(done) {
  let ended = false;
  const end = () => { if (!ended) { ended = true; done(); } };
  const p = spawn(process.execPath, [LEVERS_REFRESH_MJS], { stdio: 'ignore' });
  p.on('error', end);
  p.on('close', end);
}
// The account check is rerun this often while Usage is shown, and while a login is being added, this
// often whatever is shown, so a sign-in shows well within a minute.
const CHECK_EVERY_MS = 60_000;
const ADD_CHECK_MS = 10_000;
// The longest label a Codex login can be given: the name column's width.
const LABEL_MAX = U_NAME - 1;

// What undoes each code that sets more than a colour; a colour alone is undone by 39, and a dimmed
// colour by 22;39.
const OFF = { [BOLD]: '22', [FAINT]: '22', [REVERSE]: '27', [UNDERLINE]: '24', [YOU_BOLD]: '22;39', [BAND]: '22;27;39', [OPT_ON]: '49', [OPT_BOLD]: '22;49', [OPT_GREY]: '39;49', [OPT_GOOD]: '39;49' };
// Under NO_COLOR, grey is drawn faint, bold magenta bold and the band reversed.
const NO_COLOR_AS = { [GREY]: FAINT, [YOU_BOLD]: BOLD, [BAND]: REVERSE };

// A row cut to `w` columns as `cut` would, `›` in its first column when selected, then each coloured
// run wrapped in its SGR code. Each code is undone on its own (22 or 39), so a selected row's
// background holds across the runs, and its erase to the end of the line (ESC [K, which the
// terminal fills with the current background) carries the tint across the full width.
// NO_COLOR drops the colours and keeps bold, faint, reverse and underline, and selects in reverse video.
function paint(x, w, selected) {
  const plain = !!process.env.NO_COLOR;
  let segs = (x.segs ?? [[x.line, null]]).map(([s, k]) => [s, k]);
  if (selected) segs[0][0] = `›${segs[0][0].slice(1)}`;
  if (x.line.length > w) {
    const kept = [];
    let room = w - 1;
    for (const [s, k] of segs) { if (room <= 0) break; kept.push([s.slice(0, room), k]); room -= s.length; }
    segs = [...kept, ['…', null]];
  }
  const out = segs.map(([s, k0]) => {
    const k = plain ? NO_COLOR_AS[k0] ?? k0 : k0;
    return k && s && !(plain && ![BOLD, FAINT, REVERSE, UNDERLINE].includes(k)) ? `${ESC}${k}m${s}${ESC}${OFF[k] ?? (k.startsWith(`${FAINT};`) ? '22;39' : '39')}m` : s;
  }).join('');
  if (!selected) return out;
  return plain ? `${ESC}7m${out}${ESC}27m` : `${ESC}${SELECT_BG}m${out}${ESC}K${ESC}49m`;
}
// A line already erased to its end in the selection's tint; another erase would clear the tint.
const tinted = (l) => l.endsWith(`${ESC}K${ESC}49m`);
// A screen row a command too wide for the terminal runs on into (draw).
const SPILL = Symbol('spill');

// A row the selection can land on: a heading row has no id.
const pickable = (x) => x?.id != null;
// The next selectable row from `i` in direction `d` (1 or -1), or null with none that way.
function step(rows, i, d) {
  for (let j = i + d; j >= 0 && j < rows.length; j += d) if (pickable(rows[j])) return j;
  return null;
}

// A keys line, each key bold: "↑↓ select · enter open · q quit". One wider than the terminal goes on
// two, "move" (select, open, view, back, scroll) then "act" (the rest), each breaking between keys
// rather than losing the last ones.
const KEY = /^(←→ or 1–6|\+ −|\S+) (.+)$/;
const MOVES_ON = new RegExp(`^(select|choose|open(?! the bill|${Object.values(SUPPLIER_BILL).map((t) => ` ${t}`).join('|')})|view|back|scroll)\\b`);
function keyLines(s, w) {
  const items = s.split(' · ').map((k) => { const m = KEY.exec(k); return m ? [m[1], m[2]] : [k, '']; });
  const text = (list) => list.map(([k, d]) => (d ? `${k} ${d}` : k)).join(' · ');
  const line = (lead, list) => segLine([[lead, DIM], ...list.flatMap(([k, d], i) => [...(i ? [[' · ', null]] : []), [k, BOLD], [d ? ` ${d}` : '', null]])]);
  if (text(items).length <= w) return [line('', items)];
  return [['move  ', items.filter(([, d]) => MOVES_ON.test(d))], ['act   ', items.filter(([, d]) => !MOVES_ON.test(d))]].flatMap(([lead, list]) => {
    const out = [];
    let cur = [];
    for (const it of list) {
      if (cur.length && lead.length + text([...cur, it]).length > w) { out.push(line(out.length ? ' '.repeat(lead.length) : lead, cur)); cur = []; }
      cur.push(it);
    }
    if (cur.length) out.push(line(out.length ? ' '.repeat(lead.length) : lead, cur));
    return out;
  });
}

// Labels joined by `sep`, each with the columns it covers (from, up to end), so a click's column
// finds its label.
function spans(parts, sep) {
  let at = 0;
  return parts.map((p, i) => { const from = at + (i ? sep.length : 0); at = from + p.label.length; return { ...p, from, end: at }; });
}

// A Timeline or By day view names its place by repo, or every repo, as the screen does.
// A name's Costs are its repo's place, or with no repo in desk a place of their own.
const placeOf = (v) => (v.kind === 'timeline' || v.kind === 'days'
  ? { place: v.slug ? { kind: 'repo', slug: v.slug } : { kind: 'overview', all: false }, tab: v.kind }
  : v.kind === 'costs' ? { place: v.slug ? { kind: 'repo', slug: v.slug } : v.name ? { kind: 'cost', name: v.name } : { kind: 'overview', all: false }, tab: 'costs' }
    : { place: v, tab: null });

// The full-screen view is a place (every repo, a repo, an epic, a ticket) and, for every place but a
// ticket, a view of it: Queue, Timeline, By day or Epics. Tab, 1–4, w and a click on the tab line change the view
// and keep the place; Enter, Esc and a click on the breadcrumb change the place and keep the view.
// ↑↓ select, : takes a command, q quits. Redraws every REFRESH_MS, rereading the queues when their
// files changed (stateStamp) or REREAD_MS has passed, keeping the selection on the same repo or ticket.
export function interactive({
  input = process.stdin, output = process.stdout, start = { kind: 'overview', all: false },
  opener = systemOpener, exit = (c) => process.exit(c), refreshMs = REFRESH_MS, clock = Date.now,
  probeMs = PROBE_EVERY_MS, probeWith = probe, costWith = startRefresh, loginsWith = deskEnvLogins, copier = (text) => systemCopier(text, output),
  addCheckMs = ADD_CHECK_MS, subscriptionWith = deskEnvSubscription, leversWith = rebuildLevers, word = null,
  served = null, serverWith = serverModel, serverProbes = schedulerFresh,
} = {}) {
  // Started on a repo (`desk-q <repo>`, scopeWord), the screen loads only that repo, as run() does,
  // while it shows that repo's own queue, timeline, days, epics or tickets. Anywhere else, and a workers
  // change, read every repo, so the first move there loads every repo, and so does every reread after.
  // Once loaded, the scope is the repo's slug, which names its standing batch (always listed) whichever
  // named batches come and go. A scoped reread that still fails reads every repo, which says what is gone.
  let scope = word;
  const load = () => {
    if (scope == null) return loadOrRefuse(clock());
    try { return loadOrRefuse(clock(), scope); } catch { scope = null; return loadOrRefuse(clock()); }
  };
  // `lastRead`: the state stamp and the time of the last reread that did not fail, null after one that
  // did. The stamp is taken first, so a write made during the reread brings the next. `avail`, Home's
  // free memory, is sampled with each reread: on macOS a sample runs vm_stat, which an idle tick must not.
  let lastRead = null, avail;
  const reload = (stamp = stateStamp()) => {
    lastRead = null;
    const out = load();
    avail = availableGiB();
    lastRead = { stamp, at: clock() };
    return out;
  };
  // `servedAt`: the date of desk-ui's listing (`served`, desk-q-server.mjs) the screen opened on and
  // refreshes from, every repo's; null once it reads the files, which it then does for good.
  let servedAt = scope == null && served ? served.at : null;
  let asking = false;
  let repos = servedAt != null ? served.repos : reload();
  if (servedAt != null) avail = availableGiB();
  if (scope != null) scope = repos[0].slug;
  const inScope = () => view?.slug != null && !['costs', 'usage'].includes(tab) && repos.some((x) => x.id === view.slug);
  function widen(always = false) {
    if (scope == null || (!always && inScope())) return;
    scope = null;
    repos = reload();
  }
  // On a screen too tall to fit, `scroll` is its first line shown when it has no rows to select,
  // and how far past the selection it shows when it has.
  // `tab`: the view, one of VIEWS, kept across every change of place.
  // `checkin`: tickets waiting on the user are dated as if answered at the next check-in (c).
  // `zoom`: the Timeline's scale, z cycling it; back to auto whenever the place changes.
  // `layout`: where the last draw put the breadcrumb, the tabs and the rows, for a click to find them.
  // `ask`: a change waiting on y or n, shown in place of the keys; nothing else acts until it is answered.
  // `unfold`: what a, y and f show in full on a ticket's page; folded again whenever the place changes.
  // `screen`, `crumbs`: what the last build made, which a frame writes without reading anything.
  // `reading`, `held`: an input read is being handled, and the frame it will write when it ends.
  let view = null, tab = 'queue', sel = 0, selId = null, scroll = null, msg = '', cmd = null, ask = null, screen = null, crumbs = [], done = false, timer = null, probeTimer = null, checkin = false, zoom = 'auto', layout = null;
  let unfold = new Set(), reading = false, held = null;
  // Usage's account check: `checked` the last one's logins by checkKey, at `checkedAt`; `checking` while
  // one runs. `saving` while a rule change or removal runs, `saveGen` counting the saves begun, and
  // `recheck` once a check that overlapped a save was dropped; `undo`, what u puts back.
  let checked = null, checkedAt = null, checking = false, saving = false, saveGen = 0, recheck = false, undo = null;
  // Adding a login: `typed`, a Codex login's label as it is typed, then `adding` (as isAdding describes)
  // until the check finds it signed in or esc stops it, the check rerun by `addTimer`.
  let typed = null, adding = null, addTimer = null;
  // A repo's subscription dropdown, open: { slug, at }, `at` the option ↑↓ is on (null: the ✓ one).
  let drop = null;
  // While the Levers page rebuilds before it opens.
  let leversBusy = false;
  const stack = [];
  const width = () => Math.max(20, output.columns || 80);
  const height = () => Math.max(5, output.rows || 24);
  // A place's `slug` is its batch row's id: the repo's slug for its standing batch.
  const repoOf = (slug) => repos.find((r) => r.id === slug);
  const hasTabs = () => ['overview', 'repo', 'epic', 'cost', 'supplier'].includes(view.kind);
  const tabOk = (id) => (view.kind === 'cost' || (view.kind === 'supplier' && !view.slug) ? id === 'costs' : view.kind !== 'epic' || !['epics', 'costs', 'usage'].includes(id));
  // The supplier screen: Costs on a repo's place or a name's own.
  const bySupplier = () => tab === 'costs' && ['repo', 'cost'].includes(view.kind);
  const costName = () => (view.kind === 'cost' ? view.name : costNameOf(readCosts(costsPath()), repoOf(view.slug)?.slug));
  // A view the new place lacks gives way to its nearest: Costs and Usage to the Queue, Epics to the Timeline.
  const keepTab = () => { if (!tabOk(tab)) tab = tab === 'costs' || tab === 'usage' ? 'queue' : 'timeline'; };
  const epicFacts = () => { const r = repoOf(view.slug); return r?.q ? forecastOf(r, { now: clock(), checkin }) : null; };
  // The parked note is shown while any ticket in view waits on the user, or c is on.
  const badge = (rs) => (checkin || rs.some((r) => attention(r) > 0) ? parkedBadge(checkin) : '');

  // The breadcrumb's parts, each with the place a click on it goes to; the last is where you are.
  function crumbParts() {
    const r = view.slug ? repoOf(view.slug) : null;
    const parts = [{ label: 'desk-q', to: { kind: 'overview', all: false } }];
    // A repo's Costs sit under home's: "desk-q › costs › voicepa".
    if (bySupplier()) return spans([...parts, { label: 'costs', to: { kind: 'costs' } }, { label: view.kind === 'cost' ? view.name : r?.name ?? view.slug, to: null }], ' › ');
    // A supplier's screen sits under its name's: "desk-q › costs › voicepa › GitHub".
    if (view.kind === 'supplier') {
      return spans([...parts, { label: 'costs', to: { kind: 'costs' } }, { label: view.slug ? r?.name ?? view.slug : view.name, to: { kind: 'costs', name: view.name, slug: view.slug } },
        { label: SUPPLIER_LABEL[view.supplier], to: null }], ' › ');
    }
    if (view.slug) parts.push({ label: r?.name ?? view.slug, to: { kind: 'repo', slug: view.slug } });
    if (view.epic) parts.push({ label: cut(epicShort(epicFacts()?.epics?.[view.epic] ?? { key: view.epic }), 40), to: { kind: 'epic', slug: view.slug, epic: view.epic } });
    if (view.key) parts.push({ label: view.key, to: { kind: 'ticket', slug: view.slug, key: view.key, ...(view.epic ? { epic: view.epic } : {}) } });
    if (view.kind === 'log') parts.push({ label: 'log', to: null });
    if (view.kind === 'overview' && tab === 'costs') parts.push({ label: 'costs', to: null });
    return spans(parts, ' › ');
  }

  // "1 Queue  2 Timeline  3 By day  4 Epics", the view shown in reverse video and one this place
  // lacks dimmed.
  const tabParts = () => spans(VIEWS.map(([id, label], i) => ({ label: `${i + 1} ${label}`, id })), '  ');

  function build() {
    const now = clock();
    const w = width();
    const r = view.slug ? repoOf(view.slug) : null;
    const esc = view.kind === 'overview' ? '' : 'esc back · ';
    const cmdKeys = `: command · ${esc}q quit`;
    if (view.slug && !r) return { head: ['That repo is no longer set up here.'], rows: [], foot: [], keys: cmdKeys };
    keepTab();
    if (tab === 'usage' && hasTabs()) {
      if (!checking && (checkedAt == null || now - checkedAt >= CHECK_EVERY_MS)) checkLogins();
      const s = usageParts(repos, { now, width: w, checked, adding, drop, selected: selId });
      if (adding) return { badge: '', ...s, keys: `↑↓ select · ${VIEW_KEYS} · y copy command · esc stop adding · : command · q quit` };
      // The digits pick while it is open, so only ←→ change view.
      if (s.drop) return { badge: '', ...s, keys: `↑↓ choose · ←→ view · ${pickKeys(s.drop)} pick · enter save · esc close · q quit` };
      const x = s.rows.find((row) => row.id != null && row.id === selId) ?? s.rows.find((row) => row.id != null);
      if (x?.repo) return { badge: '', ...s, keys: `↑↓ select · ${VIEW_KEYS} · enter change subscription · a add${undo ? ' · u undo' : ''} · ${cmdKeys}` };
      const copy = x?.fix ? ' · y copy command' : '';
      return { badge: '', ...s, keys: `↑↓ select · ${VIEW_KEYS} · ${s.rows.length ? 'd make default · ' : ''}a add${s.rows.length ? ` · x remove${copy}` : ''}${undo ? ' · u undo' : ''} · ${cmdKeys}` };
    }
    // The Claude usage line is pinned above the keys, not in the header: every repo shown on home,
    // one repo's own, or none for a repo with no batch.
    const claude = (shown) => (shown ? { usage: usageLines(usageOf(repos, now, shown), { now, solid: !process.env.NO_COLOR }) } : {});
    const own = r?.q && !r.error ? [r] : null;
    if (view.kind === 'epic' && !epicIn(r, epicFacts(), view.epic)) return { head: [`${view.epic} has no unfinished tickets in ${r.name}'s queue.`], rows: [], foot: [], keys: cmdKeys };
    // Costs carry the Claude usage line but none of home's batch lines.
    if (bySupplier()) {
      const s = supplierParts(repos, costName(), { now, pinUsage: true, width: w, label: r?.repo, slug: view.kind === 'cost' ? null : view.slug });
      return { badge: '', ...s, ...claude(shownRepos(repos, false)), keys: `↑↓ select · ${s.rows.length ? 'enter open · ' : ''}${VIEW_KEYS} · o open the bill · ${cmdKeys}` };
    }
    if (view.kind === 'supplier') return { badge: '', ...supplierPageParts(repos, view.name, view.supplier, { now, width: w }), ...claude(shownRepos(repos, false)), keys: `${VIEW_KEYS} · o open ${SUPPLIER_BILL[view.supplier]} · ${cmdKeys}` };
    if (tab === 'costs') return { badge: '', ...costsParts(repos, { now, pinUsage: true, width: w }), ...claude(shownRepos(repos, false)), keys: `↑↓ select · enter open · ${VIEW_KEYS} · o open the bill · ${cmdKeys}` };
    if (tab !== 'queue' && hasTabs()) {
      const tl = tab === 'timeline';
      const opts = { now, width: w, checkin, zoom, epic: view.epic ?? null, pinUsage: true };
      const parts = tl ? timelineParts : tab === 'days' ? daysParts : epicsParts;
      const rp = view.kind === 'repo' ? repoPlace(repos, view.slug) : r;
      return { badge: badge(rp ? [rp] : repos), ...parts(repos, view.slug ?? null, opts), ...claude(rp ? (rp.q && !rp.error ? [rp] : null) : shownRepos(repos, false)),
        keys: `↑↓ select · enter open · ${VIEW_KEYS} · ${tl ? 'z scale · ' : ''}c parked dates · ${cmdKeys}` };
    }
    if (view.kind === 'overview') {
      // Home's parked note goes in its notes, not on the tab line, where a 100-column terminal cuts it.
      return { badge: '', ...overviewParts(repos, { all: view.all, now, avail, interactive: true, checkin, width: w, badge: badge(repos), pinUsage: true, hidden: readHidden(now) }), ...claude(shownRepos(repos, view.all)),
        keys: `↑↓ select · enter open · ${VIEW_KEYS} · a ${view.all ? 'hide repos with no batch' : 'all repos'} · c parked dates · s supervisor · v levers · h hide warnings · H show hidden warnings · ${cmdKeys}` };
    }
    if (view.kind === 'repo') {
      const rp = repoPlace(repos, view.slug);
      return { badge: badge([rp]), ...repoParts(rp, { now, width: w, checkin, pinUsage: true }), ...claude(rp.q && !rp.error ? [rp] : null),
        keys: `↑↓ select · enter open · ${VIEW_KEYS} · ${rp.q ? `${MOVE_KEYS} · c parked dates · ` : ''}${cmdKeys}` };
    }
    if (view.kind === 'epic') return { badge: badge([r]), ...repoParts(r, { now, width: w, checkin, epic: view.epic, pinUsage: true }), ...claude(own), keys: `↑↓ select · enter open · ${VIEW_KEYS} · c parked dates · ${cmdKeys}` };
    if (!r.q?.tickets?.[view.key]) return { head: [`${view.key} is no longer in ${r.name}'s queue.`], rows: [], foot: [], keys: cmdKeys };
    if (view.kind === 'log') {
      const p = logPath(r, view.key);
      const lines = readFileSync(p, 'utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      const last = lines.slice(-LOG_LINES).map(printable);
      const k = shownState(r.q, r.q.tickets[view.key], r.ctx);
      return { head: [segLine([[view.key, BOLD], ['  ', null], [LABEL[k], STATE_SGR[k] ?? null]]), dim(`Last ${last.length} lines of ${p}`), ''], rows: [], foot: last, keys: '↑↓ scroll · esc back · q quit', bottom: true };
    }
    const jira = jiraUrlFor(r.slug, view.key);
    const s = ticketParts(r, view.key, { width: w, jiraUrl: jira, now, checkin, open: unfold });
    const pr = prToOpen(r, view.key, selId);
    const fold = [['a', 'blockers'], ['y', 'why lane'], ['f', 'files']].filter(([k]) => s.can[k]).map(([k, d]) => `${k} ${unfold.has(k) ? `fold ${d}` : d} · `).join('');
    const keys = `${s.rows.some(pickable) ? '↑↓ select a blocker · enter open it · ' : ''}${fold}${MOVE_KEYS} · l log · ${jira ? 'o Jira · ' : ''}${pr ? `g open #${pr.pr} · ` : ''}c parked dates · ${cmdKeys}`;
    return { badge: badge([r]), ...s, keys };
  }

  // Rebuilds the screen from disk, then writes it.
  // One build, joined by the refresh's reread where it made one (build-memo.mjs).
  function draw() {
    oneBuild(() => {
      if (done) return;
      try { widen(); } catch (e) { msg = `Could not reread the queues: ${describeCrash(e)}`; }
      try { screen = build(); } catch (e) { screen = { head: [`Could not draw this screen: ${describeCrash(e)}`], rows: [], foot: [], keys: 'esc back · q quit' }; }
      crumbs = crumbParts();
      frame();
    });
  }

  // Writes the screen last built, reading nothing: all a change of selection, window or command line
  // needs. Within one input read only the last frame is written (onData).
  function frame() {
    if (done) return;
    const { rows } = screen;
    if (selId != null) { const i = rows.findIndex((x) => x.id === selId); if (i >= 0) sel = i; }
    sel = Math.max(0, Math.min(sel, rows.length - 1));
    // A heading is never selected: the selection goes on to the row below it, else the one above.
    if (rows[sel] && !pickable(rows[sel])) sel = step(rows, sel, 1) ?? step(rows, sel, -1) ?? sel;
    selId = rows[sel]?.id ?? null;
    const w = width(), h = height();
    const fit = (l) => (typeof l === 'string' ? cut(l, w) : paint(l, w, false));
    // The breadcrumb and the tab line stay at the top while the rest scrolls. A ticket has no tab
    // line, so its parked note follows the breadcrumb. The breadcrumb's last part, where you are, is
    // bold and the parts above it dim.
    const crumbLine = segLine([...crumbs.flatMap((p, i) => [...(i ? [[' › ', DIM]] : []), [p.label, i === crumbs.length - 1 ? BOLD : DIM]]), [' · ', DIM], [hhmm(clock()), null]]);
    const pinned = [];
    if (hasTabs()) {
      const segs = tabParts().flatMap((p, i) => [...(i ? [['  ', null]] : []), [p.label, p.id === tab ? REVERSE : tabOk(p.id) ? null : DIM]]);
      // A parked note too long to follow the tabs goes on its own line below them, so its key is kept.
      const tabsWide = segs.map((s) => s[0]).join('').length;
      const own = screen.badge && tabsWide + 4 + screen.badge.length > w;
      if (screen.badge && !own) segs.push([`    ${screen.badge}`, null]);
      pinned.push(fit(crumbLine), paint({ segs, line: segs.map((s) => s[0]).join('') }, w, false), ...(own ? [fit(screen.badge)] : []));
    } else pinned.push(fit(screen.badge ? segLine([...crumbLine.segs, [`    ${screen.badge}`, null]]) : crumbLine));
    // A command to copy (`whole`) wider than the terminal is not cut: it runs on into the rows below,
    // which the terminal wraps it onto, so a copy takes it whole. Each row it runs on to is a SPILL.
    const lay = (l) => {
      if (!l?.whole || l.line.length <= w) return [fit(l)];
      const n = Math.ceil(l.line.length / w);
      return [{ full: paint(l, Infinity, false), cut: fit(l), n }, ...Array(n - 1).fill(SPILL)];
    };
    const head = [];
    let leversAt = null;
    for (const l of screen.head) { if (l?.link === 'levers') leversAt = 1 + head.length; head.push(...lay(l)); }
    const body = ['', ...head, ...rows.map((x, i) => paint(x, w, i === sel && pickable(x))), ...screen.foot.flatMap(lay)];
    // A message can be longer than the line (a refused raise says what raising the cap takes). The
    // usage lines stay put above it and the keys, a blank line above them.
    // A message's lines are split at `\n`, each wrapped under its own indent.
    const said = String(msg ?? '').split('\n').flatMap((p) => { const lead = /^ */.exec(p)[0]; return wrap(p, w - lead.length).map((l) => lead + l); });
    const status = [...(screen.usage ? ['', ...screen.usage.map(fit)] : []), ...[...said, ...(typed != null ? [labelLine(typed)] : ask ? [askLine(ask.name)] : cmd != null ? [`:${cmd}`] : keyLines(screen.keys, w))].filter(Boolean).map(fit)];
    const room = Math.max(1, h - status.length - pinned.length);
    const first = 1 + head.length;
    let top = 0;
    if (body.length > room) {
      const max = body.length - room;
      const clamp = (n) => Math.max(0, Math.min(max, n));
      if (rows.length) {
        // Centred on the selection; `scroll` is how far ↓ on the last row has read on past it.
        const base = clamp(first + sel - Math.floor(room / 2));
        top = clamp(base + (scroll ?? 0));
        scroll = top - base;
      } else top = scroll = clamp(scroll ?? (screen.bottom ? max : 0));
    } else if (rows.length) scroll = 0;
    const shown = body.slice(top, top + room);
    while (shown.length < room) shown.push('');
    // `levers`: the screen line the Levers line is drawn on, null while it is not shown.
    layout = { pinned: pinned.length, top, room, first, rows: rows.length,
      levers: leversAt != null && leversAt >= top && leversAt < top + room ? pinned.length + leversAt - top : null };
    // A whole line is written in full only where every row it runs on to is shown, else cut; a SPILL
    // whose line scrolled off is a blank row.
    const out = [];
    for (let i = 0; i < shown.length; i++) {
      const l = shown[i];
      if (l === SPILL) out.push('');
      else if (typeof l === 'object') {
        const runOn = shown.slice(i + 1, i + l.n);
        const whole = runOn.length === l.n - 1 && runOn.every((s) => s === SPILL);
        out.push(whole ? l.full : l.cut);
        if (whole) i += l.n - 1;
      } else out.push(l);
    }
    const text = `${ESC}H${[...pinned, ...out, ...status].map((l) => (tinted(l) ? l : `${l}${ESC}K`)).join('\r\n')}${ESC}J`;
    if (reading) held = text; else output.write(text);
  }

  // A new place pushes the one you were on, so Esc comes back to it with its selection; the view
  // stays whatever it is. A Timeline or By day row opening a repo opens that repo's same view, and an
  // Epics row opens its epic's Timeline.
  function go(v) {
    const p = placeOf(v);
    stack.push({ view, sel, selId, tab });
    view = p.place; if (p.tab) tab = p.tab;
    keepTab();
    sel = 0; selId = null; scroll = null; msg = ''; zoom = 'auto'; unfold = new Set(); drop = null;
  }
  // The selection comes back only to the view it was made on: another view's rows are other rows.
  // Up from a repo's Costs, home's Costs select that repo's row.
  function back() {
    const p = stack.pop();
    const name = bySupplier() ? costName() : null;
    if (p) { view = p.view; keepTab(); if (p.tab === tab) ({ sel, selId } = p); else { sel = 0; selId = null; } }
    if (name && view.kind === 'overview' && tab === 'costs') { sel = 0; selId = `cost ${name}`; }
    scroll = null; msg = ''; zoom = 'auto'; unfold = new Set(); drop = null;
  }
  // A place reached directly (the command line, :, the breadcrumb) gets the places above it to Esc to.
  function goPlace(v) {
    const p = placeOf(v);
    if (p.tab) tab = p.tab;
    stack.length = 0;
    const up = (u) => stack.push({ view: u, sel: 0, selId: null, tab });
    const { kind, slug, epic, key } = p.place;
    if (kind !== 'overview') up({ kind: 'overview', all: false });
    if (['epic', 'ticket', 'log'].includes(kind)) up({ kind: 'repo', slug });
    if (epic && kind !== 'epic') up({ kind: 'epic', slug, epic });
    if (kind === 'log') up({ kind: 'ticket', slug, key, ...(epic ? { epic } : {}) });
    view = p.place; sel = 0; selId = null; scroll = null; msg = ''; zoom = 'auto'; unfold = new Set(); drop = null;
    keepTab();
  }
  // A view this place lacks leaves the view as it is and says why. A supplier's screen is Costs: another
  // view is its name's place's.
  function setTab(id) {
    if (!tabOk(id)) { msg = ['cost', 'supplier'].includes(view.kind) ? onlyCosts(view.name) : id === 'costs' ? NO_COSTS_HERE : id === 'usage' ? NO_USAGE_HERE : NO_EPICS_HERE; return; }
    if (view.kind === 'supplier') { if (id !== 'costs') { back(); setTab(id); } return; }
    tab = id; sel = 0; selId = null; scroll = null; msg = ''; undo = null; drop = null;
  }

  // ---- Usage's keys ----
  const usageTab = () => hasTabs() && tab === 'usage';
  // A check that overlapped a save read the subscriptions file from before it, so its result is dropped
  // and a fresh check runs once the save is done: now, or when it ends (saveEnded).
  function checkLogins() {
    checking = true;
    const stale = saving, gen = saveGen;
    if (!stale) recheck = false;
    loginsWith(['check', '--json'], (r) => {
      checking = false;
      if (stale || gen !== saveGen) {
        if (saving) recheck = true;
        else if (!done) checkLogins();
        return;
      }
      checkedAt = clock();
      try { checked = new Map(JSON.parse(r.out).logins.map((l) => [checkKey(l.tool, l.configDir), l])); } catch { checked = null; }
      if (!done && adding) addChecked();
      if (!done) settleAccounts();
      if (!done && usageTab()) draw();
    });
  }
  // After a check, an old file is migrated to account pins, and then each signed-in folder no account is
  // pinned to yet is pinned, unused, as desk-env logins migrate and pin do. Each is tried once a
  // session, so one that fails is not retried on every check; the check after it shows the result. A
  // session that has added a login migrates nothing: the folder it added is the add flow's.
  const tried = new Set();
  function settleAccounts() {
    if (saving || !checked) return;
    let subs;
    try { subs = readSubscriptions(subscriptionsPath()); } catch { return; }
    if (subs.errors.length) return;
    const pin = [...checked.values()].find((l) => l.tool === 'claude' && l.pinnable && !tried.has(`pin ${l.name}`));
    const args = needsPinMigration(subs) ? (tried.has('migrate') ? null : ['migrate']) : pin ? ['pin', 'claude', pin.name] : null;
    if (!args) return;
    tried.add(args[0] === 'migrate' ? 'migrate' : `pin ${pin.name}`);
    saveStarted();
    loginsWith(args, (r) => {
      forgetLogins();
      // A migration (or a pin that moved ~/.claude to Removed) shows what it printed in the terminal.
      const said = migrationSaid(r);
      if (said.length) msg = said.join('\n');
      saveEnded(true);
    });
  }
  const saveStarted = () => { saving = true; saveGen++; };
  // A save is done: a check dropped for overlapping it runs now, as does one the caller wants (`again`).
  function saveEnded(again = false) {
    saving = false;
    if ((again || recheck) && !done && !checking) checkLogins();
  }

  // ---- adding a login ----
  // The next folder for a login of `tool`, its row waiting on standby and the check rerun until it is
  // signed in. A Codex login's folder is made now, holding its label; a Claude one is made by its sign-in.
  // With no Claude account pinned and ~/.claude signed in, the first folder is for ~/.claude's account
  // and the next one for the new account.
  function startAdding(tool, name = null) {
    const subs = readSubscriptions(subscriptionsPath());
    const email = tool === 'claude' && !multiAccount(subs) ? accountOf(defaultLogin('claude')).email?.toLowerCase() ?? null : null;
    const f = nextLoginFolder(tool, subs, email ? 0 : (tool === 'claude' ? claudeLogins() : codexLogins()).length);
    if (tool === 'codex') {
      try { makeLabelledFolder(f.dir, name); } catch (e) { msg = `Could not make the new login's folder ${f.dir}: ${describeCrash(e)}`; return; }
    }
    const folder = (x) => makeLogin({ tool, name: x.name, folder: x.dir, rule: 'standby', source: 'found' });
    adding = { tool, login: folder(f), label: name };
    if (email) adding.first = { email, next: folder(nextLoginFolder(tool, { ...subs, logins: [...subs.logins, adding.login] }, 0)) };
    tried.add('migrate');
    selId = 'adding';
    msg = `esc cancels adding ${addingName(adding)}.`;
    clearInterval(addTimer);
    addTimer = setInterval(() => { if (!done && adding && !checking && !saving) checkLogins(); }, addCheckMs);
    if (!checking) checkLogins();
  }
  const stopAdding = () => { clearInterval(addTimer); addTimer = null; adding = null; };
  // The check found the folder being added. The first add's folder for the current account is pinned to
  // whatever it signed in to. Otherwise, signed in, it stays unused (settleAccounts pins a new
  // Claude folder first; a computer with no subscriptions file gets the rule written, so it has one);
  // signed in to an account already listed, it keeps waiting and the panel says so. Anything else waits
  // for the next check, as does a save while another is running.
  function addChecked() {
    const a = adding;
    const c = checked?.get(checkKey(a.tool, a.login.configDir));
    if (a.first) {
      if (!saving && c?.liveEmail && ['signed in', 'not set up'].includes(c.state)) pinFirst(a, c.liveEmail.toLowerCase());
      return;
    }
    const taken = sameAccountAs(c) ? c.liveEmail?.toLowerCase() ?? null : null;
    if (taken !== (a.taken ?? null)) adding = { ...a, taken };
    if (c?.state === 'signed in') {
      if (c.rule !== 'standby' && saving) return;
      stopAdding();
      selId = `login ${checkKey(a.tool, a.login.configDir)}`;
      const said = `${c.email ?? a.label ?? 'The new account'} is added, unused. Press d on it to make it the default.`;
      if (c.rule === 'standby') msg = said;
      else saveLogin(['set', a.tool, a.login.name, 'unused'], said, null);
    }
  }
  // The current account's folder is signed in: pinning it starts multi-account mode, ~/.claude going to
  // the Removed table, and the folder takes over as the default where ~/.claude was it (logins.mjs
  // pinLogin). Then the add waits for the new account.
  function pinFirst(a, email) {
    saveStarted();
    msg = 'Saving…';
    const fail = (r) => { stopAdding(); msg = notSaved(r); saveEnded(); if (!done) draw(); };
    const next = (r) => {
      forgetLogins();
      adding = { tool: a.tool, login: a.first.next, label: null };
      selId = 'adding';
      // The pin moved ~/.claude to Removed: what that migration printed comes first.
      msg = [...migrationSaid(r), `${email} signs in for desk through ${a.login.folder}. esc stops adding the new account.`].join('\n');
      saveEnded(true);
      if (!done) draw();
    };
    loginsWith(['pin', 'claude', a.login.name], (r) => (r.code !== 0 ? fail(r) : next(r)));
  }
  // esc while waiting: the row goes, and so does the folder desk made for it while it holds only its
  // label. A folder the sign-in began is removed from the rules instead, so it is not found again.
  function stopWaiting() {
    if (saving) { msg = 'Still saving the last change.'; return; }
    const a = adding;
    stopAdding();
    selId = null;
    const name = addingName(a);
    if (!existsSync(a.login.dir) || dropNewFolder(a.login.dir)) { msg = `Cancelled: ${name} is not added.`; return; }
    saveLogin(['remove', a.tool, a.login.name], `Cancelled: ${name} is not added. Its folder ${a.login.folder} is left as it is.`, null);
  }
  // a: a Codex login when the CODEX table's row is selected, which asks for its label first; else a Claude one.
  function addKey(x) {
    if (adding) { msg = `Still waiting for ${addingName(adding)} to be signed in: esc cancels adding it.`; return; }
    if (saving) { msg = 'Still saving the last change.'; return; }
    if (x?.login?.tool !== 'codex') return startAdding('claude');
    typed = '';
    msg = 'Type a label for the new Codex login. desk-q lists it by its email once it is signed in, or by this label where it has none.';
  }
  function labelKey(str, key) {
    if (key.name === 'return' || key.name === 'enter') {
      const name = typed.trim();
      if (!name) { msg = 'Type a label first, or esc to cancel.'; return frame(); }
      typed = null;
      startAdding('codex', name);
      return draw();
    }
    if (key.name === 'escape') { typed = null; msg = ''; return draw(); }
    if (key.name === 'backspace') typed = typed.slice(0, -1);
    else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ' && typed.length < LABEL_MAX) typed += str;
    return frame();
  }
  const notSaved = (r) => `Not saved: ${(r.err || r.out).trim().split('\n').filter(Boolean).at(-1)?.replace(/^(logins|desk-env subscription set): /, '') ?? `desk-env exited ${r.code}`}`;
  // A login made the default, given a rule or removed, then the footer says what changed (`said`,
  // `\n` between its lines) and u puts back `then`: { args, said }, the desk-env logins command that
  // undoes it and what the footer says once it has.
  // `run` is the desk-env command it goes through, logins unless named; an undo names its own.
  function saveLogin(args, said, then, run = loginsWith) {
    saveStarted();
    msg = 'Saving…';
    run(args, (r) => {
      if (r.code === 0) { undo = then; msg = said; }
      else msg = notSaved(r);
      saveEnded();
      if (!done) draw();
    });
  }
  // enter on a repo row, or a click on its RUNS ON cell: its subscription dropdown opens under it.
  function openDrop(x) {
    if (saving) { msg = 'Still saving the last change.'; return; }
    drop = { slug: x.repo.slug, at: null };
    msg = '';
  }
  // An option picked from the open dropdown (`d`, the screen's): the repo's Subscription row written,
  // u putting back what it was. The option already ✓ closes the dropdown and writes nothing.
  function pickOption(d, i) {
    const o = d.options[i];
    if (!o) return;
    drop = null;
    msg = '';
    if (o.current) return;
    const was = d.sub?.source === 'default' || !d.sub?.email ? 'default' : d.sub.email;
    // A pin to an email no login here is signed in to can't be set again, so it can't be undone.
    const lost = d.sub?.source === 'unknown email';
    const undoes = lost ? `No undo: ${was} isn't signed in here.` : 'u undoes.';
    const said = o.value === 'default'
      ? `✓ ${d.name} follows the default${d.def ? `, ${d.def}` : ''}. ${undoes}\n  Saved to its config as | Subscription | default |.`
      : `✓ ${d.name} is pinned to ${o.value}. Its next worker starts there. ${undoes}\n  Saved to its config as | Subscription | ${o.value} |. Pick Default to unpin.`;
    const back = lost ? null : { args: ['set', d.slug, was], run: subscriptionWith,
      said: was === 'default' ? `${d.name} follows the default again.` : `${d.name} is pinned to ${was} again.` };
    saveLogin(['set', d.slug, o.value], said, back, subscriptionWith);
  }
  // The keys while a dropdown is open: 1-N pick, ↑↓ move, enter saves, esc closes, q quits, and a change
  // of view closes it. -> true when the key was the dropdown's.
  function dropKey(str, key) {
    const d = screen?.drop;
    if (!d) { drop = null; return false; }
    if (/^[1-9]$/.test(str ?? '')) { if (Number(str) <= d.options.length) pickOption(d, Number(str) - 1); return true; }
    if (key.name === 'up' || key.name === 'down') { drop = { ...drop, at: Math.max(0, Math.min(d.options.length - 1, (d.at ?? d.mark) + (key.name === 'up' ? -1 : 1))) }; return true; }
    // enter before any move keeps the ✓ choice, as picking it does.
    if (key.name === 'return' || key.name === 'enter') { if (d.at == null) drop = null; else pickOption(d, d.at); return true; }
    if (key.name === 'escape') { drop = null; return true; }
    if (['left', 'right', 'tab'].includes(key.name) || str === 'q') { drop = null; return false; }
    return true;
  }
  // d: the selected login becomes its tool's default at once, the old default unused. The repos that
  // follow the default move with it from their next worker; the old default's running workers finish there.
  function makeDefault(x) {
    const l = x.login, label = loginLabel(l), codex = l.tool === 'codex';
    const was = x.use?.def;
    if (x.use?.isDefault) { msg = `${label} is already the ${codex ? 'Codex ' : ''}default.`; return; }
    if (unusable(x)) { msg = `${label} isn't signed in yet, so it can't be the default. Sign it in first.`; return; }
    const follow = !codex && screen?.following?.length
      ? ` ${andList(screen.following)} ${screen.following.length === 1 ? 'follows it from its' : 'follow it from their'} next worker.` : '';
    const n = !codex && was ? runningOn(repos, was) : 0;
    const finish = n ? `${n} running worker${n === 1 ? ' finishes' : 's finish'} on ${loginLabel(was)}. ` : '';
    const said = `✓ ${label} is now the ${codex ? 'Codex ' : ''}default.${follow}\n  ${finish}u undoes.`;
    saveLogin(['default', l.tool, l.name], said, was && { args: ['default', was.tool, was.name], said: `${loginLabel(was)} is the ${codex ? 'Codex ' : ''}default again.` });
  }
  // x: the login removed from this computer's subscriptions, unless it is the default or a repo runs on it.
  function removeKey(x) {
    const l = x.login, label = loginLabel(l);
    if (x.use?.isDefault) { msg = `${label} is the default. Make another subscription the default with d first.`; return; }
    const on = x.use?.pinned ?? [];
    if (on.length) { msg = `${label} runs ${andList(on)}. Move ${andList(on)} to another subscription first.`; return; }
    const back = l.rule ? { args: ['set', l.tool, l.name, l.rule === 'off' ? 'off' : 'unused'], said: `${label} is back, ${l.rule === 'off' ? 'off' : 'unused'}.` } : null;
    saveLogin(['remove', l.tool, l.name], `${label} is removed from the rules for this computer. Its folder and sign-in are left as they are.${back ? ' u undoes.' : ''}`, back);
  }
  function usageKey(k, x) {
    if (saving) { msg = 'Still saving the last change.'; return; }
    if (k === 'u') {
      if (!undo) { msg = 'Nothing to undo.'; return; }
      return saveLogin(undo.args, undo.said, null, undo.run);
    }
    if (k === 'y' && adding) {
      const { shell } = signInParts(adding.login);
      try { copier(shell); msg = `Copied. Paste it in a new terminal tab, or esc to cancel adding ${addingName(adding)}.`; }
      catch (e) { msg = `Could not copy the command (${describeCrash(e)}). Run it in another terminal: ${shell}`; }
      return;
    }
    if (!x?.login) return;
    const l = x.login, label = loginLabel(l);
    if (k === 'y') {
      if (!x.fix) { msg = `${label} is signed in, so there is no sign-in command to copy.`; return; }
      const { shell, then } = signInParts(l);
      try { copier(shell); msg = `Copied the sign-in command: ${shell}. Run it in another terminal${then ? `, then ${then}` : ''}.`; }
      catch (e) { msg = `Could not copy the sign-in command (${describeCrash(e)}). Run it in another terminal: ${shell}`; }
      return;
    }
    if (k === 'd') makeDefault(x);
    if (k === 'x') removeKey(x);
  }

  // A left click on the breadcrumb goes to that place, on the tab line to that view, on home's Levers
  // line opens the Levers page as v does, on a row selects and opens it. The wheel moves the selection as the arrows do.
  function onMouse(b, x, y) {
    if (done || !layout || cmd != null || typed != null || ask) return;
    if (b === 64 || b === 65) return onKey(undefined, { name: b === 64 ? 'up' : 'down' });
    if ((b & ~(4 | 8 | 16)) !== 0) return;
    const col = x - 1, line = y - 1;
    const hit = (parts) => parts.find((p) => col >= p.from && col < p.end);
    if (line === 0) {
      const parts = crumbParts(), p = hit(parts);
      if (!p || p === parts.at(-1) || !p.to) return;
      goPlace(p.to);
    } else if (line === 1 && hasTabs()) {
      const p = hit(tabParts());
      if (!p) return;
      setTab(p.id);
    } else if (line === layout.levers) {
      if (drop) drop = null;
      openLevers();
    } else {
      const i = line - layout.pinned + layout.top - layout.first;
      if (line < layout.pinned || line >= layout.pinned + layout.room || i < 0 || i >= layout.rows) return;
      // With a dropdown open, a click on an option picks it and one anywhere else closes it.
      if (drop && screen.drop && screen.rows[i]?.opt != null && col >= DROP_IN && col < DROP_IN + DROP_W + 2) { pickOption(screen.drop, screen.rows[i].opt); return draw(); }
      if (drop) drop = null;
      if (!pickable(screen.rows[i])) return draw();
      sel = i; selId = screen.rows[i]?.id ?? null;
      const o = screen.rows[i]?.open;
      if (o) go(o);
      else if (usageTab() && screen.rows[i].repo && !adding && col >= DROP_IN && col < DROP_IN + R_RUNS) openDrop(screen.rows[i]);
    }
    draw();
  }

  // Mouse reports are taken out of the input before readline reads it for keys, which would
  // otherwise split one into stray keypresses. A read ending in what may be the start of one (ESC,
  // ESC [, ESC [ < …) waits for the next read; with none within PARTIAL_MS it goes on to readline
  // as keys, so a lone Esc still arrives. However many events one read holds, it writes one frame.
  const keys = new PassThrough();
  let partial = '', flush = null;
  function onData(chunk) {
    clearTimeout(flush);
    let s = partial + String(chunk);
    const cutAt = s.search(/\x1b(\[(<[\d;]*)?)?$/);
    partial = cutAt >= 0 ? s.slice(cutAt) : '';
    if (cutAt >= 0) s = s.slice(0, cutAt);
    const clicks = [];
    s = s.replace(MOUSE, (_, b, x, y, m) => { if (m === 'M') clicks.push([Number(b), Number(x), Number(y)]); return ''; });
    reading = true;
    try {
      if (s) keys.write(s);
      for (const c of clicks) onMouse(...c);
    } finally {
      reading = false;
      if (held != null && !done) output.write(held);
      held = null;
    }
    if (partial) flush = setTimeout(() => { const p = partial; partial = ''; if (!done) keys.write(p); }, PARTIAL_MS);
  }

  function finish(code) {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearInterval(probeTimer);
    clearInterval(addTimer);
    clearTimeout(flush);
    input.removeListener('data', onData);
    keys.removeListener('keypress', onKey);
    output.removeListener?.('resize', draw);
    if (input.isTTY) input.setRawMode(false);
    input.pause?.();
    output.write(LEAVE_SCREEN);
    exit(code);
  }

  // Opens the Levers page, rebuilding it first (leversWith, in the background) when it is due; the
  // message says what happened. desk-q stays open.
  function openLevers() {
    const p = pageState({ now: clock() });
    if (!leversDue(p)) { msg = openLeversPage(p, opener); return; }
    if (leversBusy) { msg = 'Still updating Levers…'; return; }
    leversBusy = true;
    msg = 'Updating Levers…';
    leversWith(() => {
      leversBusy = false;
      if (done) return;
      msg = openLeversPage(pageState({ now: clock() }), opener, p.builtAt);
      draw();
    });
  }

  // A change, then the queues reread so the screen shows it; the message stays until the next view.
  function act(v) {
    try { widen(v.kind === 'workers'); msg = apply(repos, v); } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); }
    try { repos = newBuild(reload); } catch (e) { msg = `${msg} Could not reread the queues: ${describeCrash(e)}`; }
  }

  function runCommand(line) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    try {
      checkFlags(words);
      // A command for another repo, or for every repo, reads every repo.
      const w = scopeWord(words);
      const here = () => { try { return resolveRepo(repos, w) != null; } catch { return false; } };
      if (scope != null && (w == null || !here())) widen(true);
      const v = target(repos, words);
      if (v.kind === 'supervisor') act(v);
      else if (v.kind === 'levers') openLevers();
      else if (isWrite(v)) {
        // A change typed anywhere lands on that repo's Queue, with the moved ticket selected.
        if (!(view.kind === 'repo' && view.slug === v.slug && tab === 'queue')) { goPlace({ kind: 'repo', slug: v.slug }); tab = 'queue'; }
        if (v.key) selId = v.key;
        act(v);
      } else if (v.kind === 'overview' && view.kind === 'overview') { view = { ...view, all: v.all }; msg = ''; } else goPlace(v);
    } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); }
  }

  function onKey(str, key = {}) {
    if (done) return;
    if (key.ctrl && key.name === 'c') return finish(130);
    const rows = screen?.rows ?? [];
    if (cmd != null) {
      if (key.name === 'return' || key.name === 'enter') { const line = cmd; cmd = null; runCommand(line); return draw(); }
      if (key.name === 'escape') cmd = null;
      else if (key.name === 'backspace') cmd = cmd.slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') cmd += str;
      return frame();
    }
    if (typed != null) return labelKey(str, key);
    if (ask) {
      if (str === 'y') { const v = ask.v; ask = null; act(v); }
      else if (str === 'n' || key.name === 'escape') { ask = null; msg = ''; }
      else return;
      return draw();
    }
    if (drop && usageTab() && dropKey(str, key)) return draw();
    // On a repo's Queue the selected ticket moves within its own batch; on a ticket's screen, that
    // ticket. On a Timeline or By day nothing moves: the order is set on the Queue, and the dates follow.
    const queueView = (view.kind === 'repo' && tab === 'queue') || view.kind === 'ticket';
    const batchSlug = view.kind === 'repo' ? rows[sel]?.open?.slug ?? view.slug : view.slug;
    const moveVerb = key.shift && key.name === 'up' ? 'up' : key.shift && key.name === 'down' ? 'down' : str === 't' ? 'top' : str === 'b' ? 'bottom' : null;
    const viewNo = VIEWS.findIndex((_, i) => str === String(i + 1));
    if (hasTabs() && key.name === 'tab') {
      const ok = VIEWS.filter(([id]) => tabOk(id));
      const i = ok.findIndex(([id]) => id === tab);
      setTab(ok[(i + (key.shift ? -1 : 1) + ok.length) % ok.length][0]);
    } else if (hasTabs() && (key.name === 'left' || key.name === 'right')) {
      // ← and → follow the tab bar and stop at its ends; Tab wraps.
      const ok = VIEWS.filter(([id]) => tabOk(id));
      const next = ok[ok.findIndex(([id]) => id === tab) + (key.name === 'left' ? -1 : 1)];
      if (next) setTab(next[0]);
    } else if (hasTabs() && viewNo >= 0) setTab(VIEWS[viewNo][0]);
    else if (hasTabs() && str === 'w') setTab('timeline');
    else if (view.kind === 'epic' && moveVerb) msg = REORDER_IN_REPO;
    else if (hasTabs() && tab !== 'queue' && moveVerb) msg = REORDER_HERE;
    else if (queueView && moveVerb) {
      const k = view.kind === 'ticket' ? view.key : rows[sel]?.id;
      if (k && repoOf(batchSlug)?.q) act({ kind: 'move', slug: batchSlug, key: k, verb: moveVerb });
    } else if (queueView && (str === '+' || str === '-')) {
      const r = repoOf(batchSlug);
      if (r?.q) act({ kind: 'workers', slug: r.id, n: String(r.workers + (str === '+' ? 1 : -1)) });
      else msg = `${r?.name ?? view.slug} has no batch yet.`;
    } else if (key.name === 'up' || key.name === 'down') {
      const was = selId;
      if (!rows.length) scroll = (scroll ?? 0) + (key.name === 'up' ? -1 : 1);
      else if (key.name === 'up' && scroll > 0) scroll -= 1;
      else if (key.name === 'down' && step(rows, sel, 1) == null) scroll = (scroll ?? 0) + 1;
      else { sel = step(rows, sel, key.name === 'up' ? -1 : 1) ?? sel; selId = rows[sel]?.id ?? null; }
      // A ticket's keys name the PR of its selected blocker, and Usage's whether the selected login has a
      // sign-in command to copy, so a new selection there is a new screen.
      return (view.kind === 'ticket' || usageTab()) && selId !== was ? draw() : frame();
    } else if (usageTab() && ['d', 'x', 'u', 'y'].includes(str)) usageKey(str, rows[sel]);
    else if (usageTab() && str === 'a') addKey(rows[sel]);
    else if (usageTab() && (key.name === 'return' || key.name === 'enter') && rows[sel]?.repo && !adding) openDrop(rows[sel]);
    else if (key.name === 'return' || key.name === 'enter') { const o = rows[sel]?.open; if (o) go(o); }
    else if (key.name === 'escape' && adding && usageTab()) stopWaiting();
    else if (key.name === 'escape') back();
    else if (str === 'q') return finish(0);
    else if (str === ':') { cmd = ''; msg = ''; return frame(); }
    else if (str === 'a' && view.kind === 'overview' && tab === 'queue') view = { ...view, all: !view.all };
    else if (['a', 'y', 'f'].includes(str) && view.kind === 'ticket' && screen?.can?.[str]) { if (!unfold.delete(str)) unfold.add(str); msg = ''; }
    else if (str === 's' && view.kind === 'overview' && tab === 'queue') {
      // Turning off asks first; turning on does not. The supervisor is the repo's: its standing batch's row.
      const r = repoOf(repoOf(rows[sel]?.id)?.slug);
      if (!r) return;
      const v = { kind: 'supervisor', slug: r.slug };
      let state = null;
      if (noSupervisor()) msg = noSupervisor();
      else { try { ({ state } = supervisorState(r)); } catch (e) { msg = e instanceof Usage ? e.message : describeCrash(e); } }
      if (state === 'loaded') { ask = { name: r.repo, v: { ...v, op: 'off' } }; msg = ''; }
      else if (state) act({ ...v, op: 'on' });
    }
    else if (str === 'v' && view.kind === 'overview' && tab === 'queue') openLevers();
    else if ((str === 'h' || str === 'H') && view.kind === 'overview' && tab === 'queue') {
      // h hides the ▲ notes on Home now, keeping when each already hidden was; H shows every one again.
      const at = Date.now(), hidden = readHidden(at), keys = screen?.warnings ?? [];
      const fresh = keys.filter((k) => !hidden.has(k));
      if (str === 'h' && !fresh.length) msg = 'No warnings to hide.';
      else if (str === 'H' && !keys.some((k) => hidden.has(k))) msg = 'No warnings are hidden.';
      else {
        try { writeHidden(str === 'H' ? new Map() : new Map([...hidden, ...fresh.map((k) => [k, at])])); msg = ''; }
        catch (e) { msg = `Could not save the hidden warnings: ${describeCrash(e)}`; }
      }
    }
    else if (str === 'z' && hasTabs() && tab === 'timeline') { zoom = ZOOMS[(ZOOMS.indexOf(zoom) + 1) % ZOOMS.length]; msg = ''; }
    else if (str === 'c' && view.kind !== 'log') {
      checkin = !checkin;
      msg = checkin ? 'Tickets that need your answer are now dated as if answered at the next check-in (08:00 or 17:00).' : 'Tickets that need your answer have no date until you answer them.';
    }
    else if (str === 'l' && view.kind === 'ticket') {
      const r = repoOf(view.slug);
      if (r && existsSync(logPath(r, view.key))) go({ ...view, kind: 'log' });
      else msg = `${view.key} has no log yet.`;
    } else if (str === 'o' && (bySupplier() || (view.kind === 'overview' && tab === 'costs'))) {
      const x = rows[sel];
      if (!x?.bill) msg = x ? `No billing page to open for ${x.id.replace(/^(cost|supplier) /, '')}.` : 'No row to open the bill of.';
      else { try { opener(x.bill); msg = `Opened ${x.bill}`; } catch (e) { msg = `Could not open ${x.bill}: ${describeCrash(e)}`; } }
    } else if (str === 'o' && view.kind === 'supplier') {
      const url = screen?.bill;
      if (!url) msg = `No ${SUPPLIER_BILL[view.supplier]} page to open for ${view.name}.`;
      else { try { opener(url); msg = `Opened ${url}`; } catch (e) { msg = `Could not open ${url}: ${describeCrash(e)}`; } }
    } else if (str === 'o' && view.kind === 'ticket') {
      const url = jiraUrlFor(repoOf(view.slug)?.slug ?? view.slug, view.key);
      if (!url) msg = `No Jira site in ${repoOf(view.slug)?.name ?? view.slug}'s config, so there is nothing to open.`;
      else { try { opener(url); msg = `Opened ${url}`; } catch (e) { msg = `Could not open ${url}: ${describeCrash(e)}`; } }
    } else if (str === 'g' && view.kind === 'ticket') {
      const r = repoOf(view.slug);
      const pr = r ? prToOpen(r, view.key, selId) : null;
      if (!pr) msg = `${view.key} has no PR in CI to open.`;
      else { try { opener(pr.url); msg = `Opened ${pr.url}`; } catch (e) { msg = `Could not open ${pr.url}: ${describeCrash(e)}`; } }
    } else return;
    draw();
  }

  goPlace(start);
  emitKeypressEvents(keys);
  if (input.isTTY) input.setRawMode(true);
  keys.on('keypress', onKey);
  input.on('data', onData);
  input.resume?.();
  output.on?.('resize', draw);
  output.write(ENTER_SCREEN);
  // Every tick redraws, as one build; the queues are reread only once the state stamp has changed, or
  // REREAD_MS has passed, so a heartbeat ageing past LIVE_MS or a countdown still moves.
  const fileTick = () => {
    try {
      const stamp = stateStamp();
      if (lastRead == null || stamp !== lastRead.stamp || clock() - lastRead.at >= REREAD_MS) repos = reload(stamp);
    } catch (e) { msg = `Could not reread the queues: ${describeCrash(e)}`; }
  };
  // Read from the server, a tick asks it for any newer listing, one ask at a time; a server that has
  // stopped or will not answer in time hands the screen to the files.
  const servedTick = () => {
    if (asking) return;
    asking = true;
    serverWith({ since: servedAt }).catch(() => null).then((got) => oneBuild(() => {
      asking = false;
      if (done) return;
      if (got?.repos) { repos = got.repos; servedAt = got.at; avail = availableGiB(); }
      else if (!got?.same) { servedAt = null; fileTick(); }
      draw();
    }));
  };
  timer = setInterval(() => {
    if (servedAt != null && scope == null) servedTick();
    else oneBuild(() => { fileTick(); draw(); });
  }, refreshMs);
  // Only while this screen is open: the usage probe, for each login no worker keeps fresh (probesDue),
  // and the cost cache's reading, workers or not. While desk-ui's server runs its probe loop (its
  // heartbeat fresh, serverProbes) the server makes them and this screen shows the readings it writes,
  // but for a login only this screen's CLAUDE_CONFIG_DIR names (source `env`): the server, started
  // without it, never sees that one. With the heartbeat stale or gone, this screen probes by itself.
  probeTimer = setInterval(() => {
    const now = clock();
    // One at a time: the probe's start lock refuses a second caller in the same moment.
    const due = probesDue(repos, { now }).filter((p) => !serverProbes(now) || p.login?.source === 'env');
    (async () => { for (const p of due) await probeWith({ now, ...p, done: () => { if (!done) draw(); } }).catch(() => {}); })();
    costCheck(costWith, now);
  }, probeMs);
  // Opened on Costs, the check runs at once rather than at the timer's first tick.
  if (start?.kind === 'costs') costCheck(costWith, clock());
  draw();
  return { finish };
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
// `desk-q rollback <commit>`: the release watch's rollback, on demand (release-watch.mjs). It reads no
// queue. Not awaited: release-watch's imports reach back into this module, which must finish loading first.
if (isMain && process.argv[2] === 'rollback') {
  Promise.all([import('./maintenance.mjs'), import('./release-watch.mjs')]).then(([m, w]) => {
    const r = w.manualRollback(process.argv.slice(3), { dir: m.maintDir(), src: m.sourceCheckout() });
    (r.code === 2 ? console.error : console.log)(r.text);
    process.exit(r.code);
  }).catch((e) => { console.error(`desk-q rollback: ${e.message}`); process.exit(1); });
} else if (isMain) {
  const argv = process.argv.slice(2);
  // Every repo is read from desk-ui's server while it answers (desk-q-server.mjs); with one repo named,
  // or no server, from the files.
  const served = argv.includes('--help') || scopeWord(argv) != null ? null : await serverModel();
  try {
    // A terminal on both ends gets the screen; anything piped, --plain and a change typed in the
    // shell get the plain output.
    // The screen's first load, its own reload and its first draw are one build (build-memo.mjs).
    const ui = oneBuild(() => {
      const word = scopeWord(argv);
      if (!process.stdin.isTTY || !process.stdout.isTTY || ['--plain', '--help', '--json'].some((f) => argv.includes(f))) return null;
      checkFlags(argv);
      const start = target(served?.repos ?? loadOrRefuse(Date.now(), word), argv);
      return start && !isCommand(start) ? interactive({ start, word, served }) : null;
    });
    if (ui) {
      process.on('SIGTERM', () => ui.finish(143));
      process.on('SIGHUP', () => ui.finish(129));
    } else console.log(run(argv, { repos: served?.repos }));
  } catch (e) { console.error(e instanceof Usage ? e.message : describeCrash(e)); process.exit(1); }
}
