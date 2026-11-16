# Desk app: screen-by-screen spec for the UI designer

Date: 15 Nov 2026. Author: UX (ux-designer + ux-copywriter skills loaded).
Inputs: `use-cases.md` (personas, J1-J12, use cases A-M, gaps G1-G14) and `desktop-feasibility.md`
(the window is Desk.app, a thin Electron shell on `127.0.0.1:4823` served by `desk-ui`; Ben chose Electron from the start on 2026-11-16).
Real data read today, read-only: `desk-q --plain` home, `desk-skills` and `studia-web` queues,
`show DS-676`, `show SV-3844`, `costs`, `decisions.jsonl`. Every sample string below is shaped from
those outputs. Token and USD figures marked *(illustrative)* are not real; the shape is.

> Gate note: the ux-designer skill asks the user three questions first. This step runs inside a
> workflow with no channel to the user, so the answers come from the request and the live data.
> Assumptions to confirm are in section 14.

> **Updated 15 Nov (decisions round).** Brought in line with Ben's 15 Nov decisions
> (`.handoffs/2026-11-15-2.md`, including "Ben's answers") and desk's code: subscriptions per DS-616
> (one default, repo pins, no automatic switching), the conversation start sheet, the new Levers
> screen (11b), Desk updates (2.5, 2.7, 9.6, 9.7), drop made irreversible with a two-step confirm,
> desk's real stage names, new required frames (2.10, 4.4 states 12-14, 1.7) and a "Not yet drawn"
> backlog (section 17). Changed sections carry "(updated 15 Nov)". All emails are placeholders on
> `*.example`. Where the app needs a command desk doesn't have yet, the text says **planned** and names it.

---

## 0. Strategy in one screen

**Target user:** one senior engineer who runs 4+ repos of autonomous workers. Usually *glancing*
(5 to 60 s, mildly anxious, between meetings), sometimes *deep-diving* (focused, sceptical, wants the
verbatim evidence), rarely *configuring* (careful, poor recall of where things are).

**Core insight:** attention is the scarce resource. desk moves itself; the app exists to drain
"needs you" quickly and correctly, prove at a glance that the machine is healthy, and get to the PR,
the Jira ticket, a live worker or a conversation in one click.

**Key decisions (each against its default):**
- Inbox is the landing screen, worked from the keyboard like Superhuman, because 25 items wait today
  and the oldest is 12d 14h. The question text is the hero, never the buttons, because a fast wrong
  park answer costs more than a slow right one (speed vs. safety: safety wins on answers).
- Answers are inline in a detail pane, not modals, because the question must stay beside its evidence.
- Not now acts at once with a 10 s undo, not a confirm dialog (frequent, and undo actually protects).
  Drop is different (updated 15 Nov): it deletes the queue row and the worktree and can't be undone,
  so it takes an inline two-step confirm and never a single key (4.4 state 12).
- Supervisor off, grants and caps get typed confirmation or are routed to `/desk-setup`, because they
  are rare and expensive (friction vs. safety: friction wins at destruction moments).
- Identical causes collapse into one group row with "Apply to all", because 9 of 14 studia-web items
  share one cause today. Each member stays visible and can be excluded.
- Skeletons from the last snapshot, never a bare spinner. Local files load in milliseconds; only
  network panels (PR, Jira) wait, and they show the cached copy with "as of" first.
- Links follow one rule everywhere: plain click opens it in the app, Cmd-click (or the trailing
  arrow icon) opens GitHub or Jira in the Mac's default browser.

**Inspired by:** Linear (sidebar + list/detail, Cmd+K), Superhuman (keyboard triage), air-traffic
control flight strips (each ticket is a strip that shows what it waits on), aviation checklists
(typed confirmation for irreversible actions).

**Biggest UX risk:** answering too cheaply. Mitigations are specified in 4.6 and tested in section 15.

---

## 1. Frame, grid and global rules

### 1.1 Window sizes

| Size | Name | Layout |
|---|---|---|
| **1440 x 900** | Standard | Sidebar 232 px + list column (flex, min 440) + detail pane 520 px. Title bar 40 px, status bar 28 px. Content height 832 px. |
| **1024 x 700** | Compact | Sidebar collapses to a 56 px icon rail (labels in tooltips and in Cmd+K). List 400 px + detail flex (min 568). Status bar hidden; its content moves into the title bar right cluster. Content height 660 px. |
| < 1024 wide | Narrow (not drawn, must not break) | List and detail become one column; detail slides over the list with a "Back to Inbox" control. No horizontal scroll at any width down to 720. |

Draw every screen at 1440 x 900. Draw the Inbox, Queue, Ticket and Session screens again at 1024 x 700.

### 1.2 Grid and density
- 4 px base unit. Gutters 16 px; pane padding 20 px (Standard), 16 px (Compact).
- List row height 36 px (Standard) / 32 px (Compact). Every action target inside a row is at least
  44 x 44 px hit area even when the drawn control is 28 px (pad the hit area, not the visual).
- Body text 14/20. Mono (park questions with gate blocks, log lines, commands, SHAs) 13/20.
- shadcn primitives to use: `Sidebar`, `Command`, `ResizablePanelGroup`, `Tabs`, `Table`,
  `Badge`, `Button`, `RadioGroup` (as cards), `Textarea`, `Tooltip`, `HoverCard`, `Sheet`,
  `Dialog` (only for typed confirmations), `Sonner` toasts, `Skeleton`, `Progress`, `ScrollArea`,
  `Collapsible`, `Toggle Group`, `Alert`, `Separator`, `Kbd`.

### 1.3 State language (glyph + word + colour, never colour alone)
These match desk-q exactly so the terminal and the app read the same.

| Glyph | Word | Meaning shown in tooltip | Colour token |
|---|---|---|---|
| `●` | running | Holds a worker | `--state-running` (blue) |
| `○` | ready | The next free worker takes it | `--state-ready` (slate) |
| `▸` | merging | Merges by itself once green | `--state-merging` (violet) |
| `·` | waiting | Moves by itself | `--state-waiting` (muted) |
| `◆` | needs you | Nothing moves until you act | `--state-needs` (amber) |
| `✓` | done | Merged | `--state-done` (green) |
| `✕` | failed / red check | Failed; see why | `--state-failed` (red) |
| `◌` | stale | Last read is older than expected | `--state-stale` (muted, dashed) |
| `!` | production broken | Production is down; answer first | `--state-critical` (red, filled) |

### 1.4 Freshness rule
Every panel that depends on the network carries an "as of" stamp, top right of the panel, 12 px muted:
`As of 10:07 · Refresh`. Local panels carry none (they are live). If a local snapshot is older than one
pass interval (3 min), the Inbox header shows `◌ Last checked 10:02 · Check now`.

### 1.5 Write rule (affects every action button)
Every write runs an existing command. While it runs, the button shows its own inline busy state
(label stays, a 12 px ring replaces the icon, the button stays its width). The result is one of:
- **exit 0** done: the row updates; a passive line appears under the action for 4 s.
- **exit 10** nothing to do: neutral inline note, verbatim stdout.
- **exit 11** refused: inline `Alert` under the action, verbatim stdout, typed text kept, focus returns to the field.
Never a generic error. Never a toast for exit 11 (it needs the user's eyes where they were).
The one exception: app-local display preferences (9.2) are saved by the app itself, with no desk command (16 Nov).

### 1.9 Entry points follow their screen (new 16 Nov)
A control and its shortcut (a sidebar item, a palette command, a button or link that opens a screen) are drawn only once that screen's route exists. Each screen's ticket adds its own entry points. Until then the control is absent, never disabled or a dead link (Ben, 16 Nov).

### 1.6 Link rule
- Ticket keys (`DS-563`), PR numbers (`#3113`), check names (`unit (node 24)`) and SHAs (`a742f155`) are links everywhere.
- Plain click: in-app (ticket page, PR & CI tab, check detail).
- Cmd-click, or the 12 px `↗` icon that follows the link on hover/focus: opens externally in the Mac's default browser.
  - Ticket key: `https://{jira-site}/browse/DS-563` (from the repo's §4 Jira site). Repos without Jira open the GitHub issue.
  - PR: `https://github.com/sophos-education/studia-web/pull/3113`.
  - Check: `https://github.com/sophos-education/studia-web/actions/runs/{runId}/job/{jobId}`.
- Tooltip on hover: `Open DS-563 · ⌘-click to open in Jira`.
- `{jira-site}` is a placeholder; draw it as `jira.example.net` and label it "§4 Jira site".

### 1.7 Keyboard focus (new 15 Nov)
- Every interactive element has a visible focus state, drawn as its own frame (section 16): list row,
  radio card, button, link chip, tab, sidebar item, stepper, menu item, textarea, the inline confirms.
- Focus ring: token `--focus-ring`, 2 px solid, 2 px offset, contrast at least 3:1 against both the
  element and the surface behind it, in light and in dark. Never shown by colour change alone.
- Focus order follows reading order; opening an inline confirm moves focus to its safe button; closing
  it returns focus to the control that opened it.

### 1.8 Sample identities (new 15 Nov)
Every email in frames is a placeholder on `*.example`: `ben@studia.example` (this computer's Claude
default), `ops@studia.example` (`work-2`), `ben@personal.example` (`work-3`, off). Never a real account.

---

## 2. App shell (every screen)

### 2.1 Regions (1440 x 900)

```
+--------------------------------------------------------------------------------------------------+
| ● ● ●  Desk      Inbox                    [ ⌘K  Search tickets, PRs, commands ]   ◆25  ●  ⚙      | title bar 40
+-------------+------------------------------------------------------------------------------------+
| SIDEBAR 232 |  [global banner slot, 0-2 banners, 40 each]                                          |
|             |  PAGE HEADER 56: breadcrumb · title · count · page actions                          |
|             |  PAGE BODY (list / detail, per screen)                                               |
|             |                                                                                      |
+-------------+------------------------------------------------------------------------------------+
| ● 7 workers · cap 30 · 27.5 GiB free   Claude 5h 32% · 7d 88% Tue 08:00   Codex 7d 46%   10:08  | status bar 28
+--------------------------------------------------------------------------------------------------+
```

### 2.2 Title bar (Electron hidden-inset title bar, 40 px) (updated 16 Nov)
- Left: traffic lights (system), then `Desk` wordmark 14 px semibold.
- Centre-left: current page title (`Inbox`, `desk-skills · Queue`, `DS-676`), for Cmd-Tab and Mission Control readability.
- Centre: search trigger, 360 px wide (Standard) / icon only (Compact). Placeholder: `Search tickets, PRs, commands`. Right inside: `⌘K` kbd.
- Right cluster: needs-you pill `◆ 25` (amber, links to Inbox; tooltip `25 need you · oldest 12d 14h`), health dot `● Healthy` (tooltip lists checks), settings gear.
- Whole bar is a drag region except the controls.

### 2.3 Sidebar (232 px; 56 px rail in Compact) (updated 15 Nov)

| Item | Badge / trailing | Shortcut |
|---|---|---|
| `◆ Inbox` | `25` amber count; red `!` if any production broken | ⌘1 |
| `Repos` (section label, collapsible) | | |
| `desk-skills` | `● 4` running count; nothing if 0 needs | ⌘2 opens All repos |
|  `desk-skills:DS-631` (named batch, indented 16) | `· 9` | |
| `studia-web` | `◆ 14` | |
| `studia-zendesk` | `◆ 5` | |
| `ai-agents` | `◆ 6` · `● 3` | |
| `Workers` | `7` | ⌘3 |
| `Conversations` | `1 live` green dot when a session runs | ⌘4 |
| `Usage & costs` | `88%` amber when any window ≥ 85% | ⌘5 |
| `Levers` (new 15 Nov, 11b) | `◆ 1` when a lever needs you; `◌` when the build is late | ⌘6 |
| `Health` | glyph + word when failing (`✕ 1 failing`) | ⌘7 |
| `Decisions` | `12 new` since last check-in | ⌘8 |
| Footer: `Settings` | | ⌘, |
| Footer: usage mini-meters | `Claude 5h ███··· 32%` / `7d █████████· 88%` | |

- Repo rows: hover reveals a chevron to expand batches. Repo name truncates at 20 chars with full name in tooltip (`sophos-education/studia-web`).
- Active item: filled background, 2 px left accent. Focus ring 2 px offset.
- Compact rail: icons only, badges as 16 px dots with numbers ≤ 99, `99+` above.
- Sidebar toggle: ⌘\ .

### 2.4 Status bar (28 px, Standard only) (updated 15 Nov)
`● 7 workers · cap 30 · room for 7 more · 27.5 GiB free` · `Claude ben@studia.example 5h 32% (resets 13:10) · 7d 88% (Tue 08:00)` · `Codex 7d 46%` · right: `Server 127.0.0.1:4823 ●` · clock `10:08`.
Each segment is a link (Workers, Usage & costs, Health). The Claude segment leads with the default
subscription's email, never the folder name `default`.

### 2.5 Global banners (slot under title bar; max 2 shown, rest as "+1 more") (updated 15 Nov)
Priority order, highest first. Each: 40 px, icon + one sentence + one action. Dismissible only where noted.

| Trigger | Copy | Action | Dismiss |
|---|---|---|---|
| Any `PRODUCTION BROKEN` park | `! Production is broken in studia-web: SV-4021 is waiting for your answer.` | `Answer now` | No |
| Server unreachable | full screen, see 2.8 | | |
| Usage at limit | `ben@studia.example has reached its 7-day limit. desk-skills and studia-zendesk wait until Tue 08:00. desk doesn't move them to another subscription.` | `See subscriptions` (Usage & costs) | No |
| Usage ≥ 85% | `Claude's 7-day window is at 88% and resets Tue 08:00. At this pace it fills Mon 14:00.` | `See usage` | Yes, until next 5% step |
| Health check failing | `The browser check is failing, so no new worker starts in desk-skills.` | `See the fix` | No |
| Old code | `Desk's running code is older than what is installed. Workers use the old code until you update.` | `Update desk` | Yes, 24 h |
| App updated (new 15 Nov) | `Desk updated. Reload to use the new version of the app.` | `Reload ⌘R` · `Later` | `Later` hides it; it returns the next time Desk comes to the front at least 1 h later. Reloading keeps an unsent answer, the Inbox position and filters; an open conversation reconnects to its session. |
| Server restarting (new 15 Nov) | `Desk's server is restarting after an update. Reconnecting… You're looking at the copy from 10:12.` | none | No; replaced by the toast `Reconnected. Showing live data.` |
| App build failed (new 15 Nov) | `Desk updated, but the app's new version didn't build. You're on the previous app version.` Sub: `The update itself still applies: supervisors and workers run the new desk code. Only the window stays on the previous app.` | `Open install log` | Yes |
| Machine offline | `You're offline. Queues and logs still update; PR and Jira panels show their last copy.` | none | No |

A failed desk release is **not** a banner (15 Nov): it is a toast at the time (2.7), the Health `desk`
row (9.7) and the state line in Settings · Desk install (9.6). Skill and plugin updates are a badge on
Settings · Desk install only: no banner, no Inbox item.

### 2.6 Command palette (⌘K) — shadcn `Command` in a 640 x 480 centered panel
- Input placeholder: `Type a ticket, PR, repo or command`.
- Empty query shows sections: `Recent` (last 5 tickets visited), `Needs you` (top 3), `Commands`.
- Result groups and row formats:
  - **Tickets:** `◆ SV-3844  Robin can look up production Sentry issues from Merl…  studia-web`. Enter opens ticket; ⌘Enter opens in Jira.
  - **Pull requests:** `#3113  SV-3952 · Review gate needs agent-pullbot review  studia-web`. ⌘Enter opens GitHub.
  - **Repos:** `studia-web  ◆ 14 · 59 waiting`.
  - **Commands** (verb first):
    - `Go to Inbox` `⌘1` · `Go to Repos` `⌘2` · `Go to Workers` `⌘3` · `Go to Conversations` `⌘4` · `Go to Usage & costs` `⌘5` · `Go to Levers` `⌘6` · `Go to Health` `⌘7` · `Go to Decisions` `⌘8` (updated 15 Nov)
    - `Open conversation for DS-606`
    - `Move DS-615 to top of desk-skills`
    - `Set desk-skills workers…` (opens the workers control, does not set)
    - `Check needs-you now` (runs the settling list)
    - `Run /desk-admit in desk-skills` (opens a conversation)
    - `Run /desk-groom`, `/desk-clearance`, `/desk-setup`, `/desk-update`, `/desk-reboot`
    - `Rebuild Levers` (runs `levers-view build`, planned)
    - `Copy desk-q command for this view`
- Typing a bare key (`ds-563`, case-insensitive) puts that ticket first. Typing `#3113` puts that PR first.
- Typing `>` restricts to commands.
- No results: `No ticket, PR or command matches "foo". Keys look like DS-563 or #3113.`
- Loading: results appear instantly from the local index; PR titles not yet cached show the key and `PR title loading…` in muted text.
- Keyboard: ↑/↓, Enter, ⌘Enter external, Tab cycles group, Esc closes.

### 2.7 Toasts (Sonner, bottom-right, max 3 stacked) (updated 15 Nov)
Used only for: undo windows (not now only; drop has no undo), a background write finishing while the user is elsewhere, a session ending, a desk release result.
- Undo: `SV-3957 put off until the next check-in.  Undo (⌘Z)` — 10 s, with a draining 2 px bar.
- Release failed: `✕ main's tests check failed on 3e91b0d2, so desk didn't install it. You're still on c47f43ab.` · `See the check ↗`. Stays until dismissed.
- Release installed: `✓ Desk updated to 3e91b0d2 (2 commits). Supervisors move to it by themselves.`
- Background: `DS-615 moved to position 1 in desk-skills.`
- Session: `Conversation for SV-3844 ended. It recorded: answer SV-3844 "run the checks…".  View`

### 2.8 Server down / unreachable (whole window)
The app's service worker, in Desk.app's window, keeps the shell and the last snapshot. Before any copy is cached, Desk.app shows this card itself (updated 16 Nov).
- Layout: shell stays, sidebar dimmed (still navigable to cached pages), body replaced by a centered card 520 wide.
- Title: `Desk can't reach its local server`
- Body: `The desk-ui server on 127.0.0.1:4823 isn't answering. Your queues are safe: workers and the supervisor keep running without it. You're looking at the copy from 10:06.`
- Code block with copy button: `launchctl kickstart -k gui/$(id -u)/com.desk-skills.ui`
- Secondary: `If it keeps stopping, run desk-ui doctor in Terminal.`
- Status line: `Trying again in 5 s… (attempt 3)` with `Try now` button.
- When the server returns: banner collapses, data reloads, toast `Reconnected. Showing live data.`
- Writes while down: every action button disabled with tooltip `Can't change anything until the server is back.`

### 2.9 First run / not set up (shown in body)
- **Desk not installed:** `Desk isn't installed on this Mac yet.` body `Install it, then reopen this window.` code `git clone …desk-skills && ./install.sh` with copy. (Rare; install.sh installs the server and Desk.app together.)
- **Installed, 0 repos:** pre-staged first action, not an illustration. Title `Set up desk in your first repo`. List of git repos found under `~/studia/`: `desk-skills`, `studia-web`, `studia-zendesk`… each with `Set up` button that opens a `/desk-setup` conversation in that folder. Footer: `Desk only acts in repos you set up.`
- **Notifications permission:** inline card on Inbox, once: `Get told when production breaks or something needs you.` buttons `Allow notifications` / `Not now`.

### 2.10 Window not signed in to Desk (updated 16 Nov)
Shown when the server answers but Desk.app could not sign in: its token file is missing, or the server refused it again after Desk.app's one automatic retry
(see `desktop-architecture.md` §9). Whole body, shell dimmed, like 2.8.
- Title: `This window isn't signed in to Desk`
- Body: `Re-run install.sh in Terminal. It writes Desk's sign-in again, and this window signs in by itself.`
- Code block with copy: `cd ~/studia/desk-skills && ./install.sh` (this Mac's desk-skills checkout).
- **Never show the token**, its file path contents or any part of it, in this card, in a URL the user
  can copy, or in an error message. There is no `desk ui` command (dropped 16 Nov, Ben).
- Writes disabled with tooltip `Sign in first: re-run install.sh in Terminal.`

---

## 3. Repos overview (all repos)

**Purpose:** J1 and A1/A2. Answer "is every repo moving, and where is the pressure?" in one look.
Route `/repos`. Reached by ⌘2, sidebar section label, status bar.

### 3.1 Layout (1440)
- Page header: title `Repos`, subtitle `4 repos · all on the supervisor · last pass just now`. Actions: `View: Table | Cards` toggle (default Table), `Run /desk-admit…` (secondary).
- Summary strip (88 px, 4 stat tiles): `◆ 25 need you` sub `oldest 12d 14h` · `● 7 running` sub `cap 30 · room for 7` · `○ 20 ready` sub `15 with no free slot` · `✓ 275 done` sub `this batch set`.
- Table (full width, sticky header):

| Repo | Last pass | Run | Ready | Merging | Wait | Needs you | Done | All done by | Workers |
|---|---|---|---|---|---|---|---|---|---|
| `bigbenjoman/desk-skills` | `● supervisor · just now` | 4 | 17 | 2 | 14 | – | 90 | `no date yet` | `4 of 30` + callout `12 ready with no free slot` |
| `sophos-education/studia-zendesk` | `● supervisor · just now` | 0 | 0 | 0 | 15 | `◆ 5` | 8 | `no date yet` | `0 of 11` |
| `sophos-education/studia-web` | `● supervisor · just now` | 0 | 0 | 0 | 59 | `◆ 14` | 36 | `no date yet` | `0 of 5` |
| `…/ai-agents` | `● supervisor · just now` | 3 | 3 | 0 | 14 | `◆ 6` `+17 put off` | 141 | `Mon 18:32` | `3 of 3` + `3 ready with no free slot` |

- Named batches render as indented child rows: `desk-skills:DS-631 · levers epic`.
- Default sort: Needs you desc, then Run desc. Column headers sortable.
- Row click: opens that repo's Queue. Clicking the Needs-you cell opens Inbox filtered to that repo.

### 3.2 Cell components
- **"No free slot" callout:** amber outline badge `12 ready, no free slot` with HoverCard:
  `DS-606 is running and collides with 13 ready tickets, so they wait for it. Raising workers won't help until DS-606 finishes (ships today 11:51).` Link `See DS-606`.
- **All done by:** `Mon 18:32` with p80 whisker tooltip `Could run to Tue 04:10 (1 run in 5 is later)`; `no date yet` tooltip `Not enough merged history, or tickets wait on you.`
- **Workers:** `3 of 3` as a 40 px segmented mini-bar; at cap shows `at cap` muted.

### 3.3 Cards view (alternative)
2 x 2 grid of 640 x 220 cards: repo name, supervisor line, a stacked bar of the five states with counts, top 2 needs-you rows, ETA, workers. For users who prefer spatial.

### 3.4 States
| State | Treatment |
|---|---|
| Loading | Table skeleton: 4 rows, cells as bars; summary tiles show last snapshot numbers with 40% opacity until confirmed (≤ 300 ms). |
| Supervisor off for a repo | Row tinted muted; Last pass cell `○ supervisor off · last pass 2h ago`; trailing button `Turn on` (opens 9.4 confirmation). |
| Passes stopped (supervisor on but failing) | `✕ passes stopped 10:01 · see why` link to Health. Row badge red. |
| A live Claude session runs the batch | Last pass cell `● live session · /desk-autopilot`, tooltip `A Claude session is running this batch instead of the supervisor.` |
| Repo config missing | `◌ not set up` with `Finish setup` (opens `/desk-setup` conversation). |
| Many repos (10+) | Table scrolls; summary strip stays; sidebar Repos section collapses to top 6 + `Show 8 more`. |
| Offline | Unchanged (local). |
| 0 repos | First-run body (2.9). |

---

## 4. Inbox (landing screen)

**Purpose:** J2/J3, C1-C10. Drain needs-you correctly. Route `/inbox`, also `/inbox/{repo}/{key}/{kind}`.

### 4.1 Layout (1440)
```
+ header 56: Inbox  25 need you · oldest 12d 14h       [All repos v] [All kinds v] [Oldest first v]  ◌ as of 10:07 · Check now
+---------------------------------------+--------------------------------------------------------------+
| LIST (flex, min 440)                  | DETAIL (520)                                                 |
| ! Production broken (0, hidden)       | item header                                                  |
| ▼ Review gate needs agent-pullbot (9) | QUESTION (hero, verbatim)                                    |
|   ◆ SV-3952 #3113 Alert the pipe…  1d | ANSWER options (radio cards, recommended first)              |
|   ◆ SV-3960 #3096 The metrics ma… 1d  | [Record answer ⏎]  [Open conversation o]                     |
|   … 7 more                            | link chips: PR #3113 ↗  SV-3952 in Jira ↗  Checks ✕1         |
| ◆ SV-3844 External-shape change  8d   | tabs: PR & CI | Jira | Decisions | Log                        |
| ◆ SV-3880 Worktree in use       18h   | tab body                                                     |
| ◆ SV-3377 Lane C staging check   1d   |                                                              |
| ◆ SV-3954 #3084 Only a person m…13h   |                                                              |
| ▸ Put off · 17                        |                                                              |
+---------------------------------------+--------------------------------------------------------------+
```
Compact (1024): list 400, detail flex; filter dropdowns collapse into one `Filter` button; tabs collapse to a `More` dropdown after 3.

### 4.2 List

**Order** (as needs-you orders it): production broken first; then put-off items with ≥ 3 tickets held behind them; then longest waiting. Groups (same cause) sit at the position of their oldest member.

**Row anatomy (36 px):** `◆` glyph · key (mono, link) · PR number if any · short need (front-loaded, ≤ 60 chars, truncated) · repo chip (only when "All repos") · held-behind count `⧗ 4 behind` when ≥ 1 · waited `8d 19h` right-aligned, amber after 3 days, red after 7.
- Example rows (real):
  - `◆ SV-3844  #2699  External-shape change, no live check possible  studia-web  ⧗ 1  8d 19h`
  - `◆ SV-3880  Worktree in use by another session  studia-web  ⧗ 6  18h`
  - `◆ SV-3377  Lane C: Zendesk staging check (AC1/AC4)  studia-web  1d`
  - `◆ SV-3954  #3084  Only a person merges it: changes CI workflow  studia-web  12h 48m`
  - `◆ DS-615  #655  1 check failed, fix tries used 2 of 2  desk-skills  ⧗ 0  3h`
- Kind tag: small mono tag before the need, one of `parked` `session` `spine` `plan` `triage` `held` `stopped` `pr` `worktree` `usage` `base-push` `config` `templates` `unset` `reviewer` `step` `lever` (`lever` added 15 Nov, see 11b). Tooltip explains the kind in one line (see 4.5). There is no `update` kind: skill and plugin updates are a badge on Settings · Desk install only.
  - Lever row (real shape, illustrative values): `◆ codex  lever  Turned off twice in ai-agents, paused until you decide  ai-agents  12d 1h`.
- Unread dot: a 6 px dot at the far left until the item has been shown in Detail for ≥ 1 s.
- Hover/focus: row raises; right side swaps waited for a ghost `Open` button (updated 15 Nov: not the recommended action, which read as if it would record). Clicking it selects the row; it does **not** record (recording happens only from Detail, where the question is visible).

**Group row (cause group, needs G3):**
- `▼ Review gate needs an agent-pullbot review · 9 PRs · studia-web · oldest 1d`
- Expanded by default when ≤ 5 members, collapsed when more; members indent 24 px.
- Trailing: `Apply to all 9` secondary button (opens group answer in Detail, 4.4.6).
- Until G3 ships, group by exact normalised need text on the client and label the group `Same cause (matched by text)`, so the user knows the match is heuristic.

**Put off section:** collapsed `▸ Put off · 17` at the bottom. Expanded rows show `put off 2d ago · comes back at the 17:00 check-in` and a `Bring back` link.

**Filters:** Repo (multi-select with counts: `studia-web 14`), Kind (multi), Sort (`Oldest first` default, `Most held behind`, `Repo`). Active filters show as removable chips under the header.

### 4.3 Detail pane

**Header (sticky, 64 px):**
- Line 1: `◆ SV-3844` (link) · kind tag `session` · repo `studia-web` · `waited 8d 19h` · `⧗ blocks SV-4017`.
- Line 2: ticket title, 15 px semibold, 2 lines max: `[Ops] Robin can look up production Sentry issues from Merl, with its own token and no model`.
- Right: `‹ ›` prev/next (k/j), `Open ticket` (t).

**Question block (the hero):**
- Label `Needs your answer` (12 px uppercase muted).
- Verbatim park text, never truncated, 15/24, max-width 60ch, left 3 px amber rule (mirrors desk-q's `▌`):
  > SV-3844 PR #2699 is an external-shape change with no live check possible from a worker (curl denied, no Sentry token, Merl previews behind Vercel Authentication, MERL_ROBIN_TOKEN unset): can someone with a Sentry token run the checks in the PR's Testing list and record a real payload for the fixture, or accept merging with them as post-merge checks? Not reached: live Sentry verification, real-payload fixture, Vercel max-duration read, CI test result read, undraft, approval, merge, post-merge token, firewall and curl steps.
- Gate blocks (`JIRA COMMENT — awaiting approval`, etc.) render in a mono bordered block with a `Copy` button and the caption `This is the exact text that will be posted.` Approval has its own states (4.4 state 13).
- Keys, PR numbers and SHAs inside the text are links (link rule).
- If the text exceeds the pane, the pane scrolls; the action bar does not cover the text (it sits below, not sticky over it).

**Answer block:**
- Label `Your answer`.
- Options as radio cards (full width, 56-72 px each), numbered 1-9, recommended first:
  - Card 1 (recommended): `1  answer`  tag `Recommended` · description `Run the PR's Testing checks with a Sentry token, then record the real payload. Unblocks SV-4017.` · sub `Why: the fixture must come from a real payload (lane A demotion trigger).`
  - Card 2: `2  open session` · `Work it yourself in /desk-ticket SV-3844 (studia-web).`
  - Card 3: `3  not now` · `Comes back at the 17:00 check-in.`
  - Card 4: `4  drop` · `Deletes SV-3844 from the batch and removes its worktree. Can't be undone; /desk-admit brings it back. SV-4017 stays waiting.` Choosing it opens the two-step confirm (4.4 state 12).
- Options needing text expand a `Textarea` inside the card on select:
  label `What should the worker do?` placeholder `Say what to do, in the worker's terms. It's passed on word for word.` helper (updated 15 Nov) `Don't paste tokens or passwords. This text is saved and passed on as written.` Max 2,000 chars, counter after 1,500.
- When the item has **no recommendation** (a value only the user holds): no `Recommended` tag; a line above options: `No recommendation: this needs something only you know.`
- **Multi-choice question** from the park (worker offered options): the worker's options become cards 1..n with their verbatim text, then `Something else…` (typed), then `not now`.

**Action bar (below options):**
- Primary: `Record answer` + `⏎` kbd. Label changes with the chosen option so it names the outcome:
  `Record "done"` · `Send answer to SV-3844` · `Start SV-3880` · `Requeue DS-615` · `Drop SV-3957` · `Put off until 17:00` · `Approve this Jira comment`.
- Disabled until an option is chosen and, for typed options, text is non-empty. Disabled tooltip: `Choose an answer first.`
- Secondary: `Open conversation` (o). Tertiary text link: `Copy needs-you command`.
- Under the bar, muted: `Runs: needs-you.mjs record studia-web SV-3844 answer "…"` (shows the exact command; deep-dive users trust what they can see).

**Evidence chips (row under action bar):**
`PR #2699 ↗` · `SV-3844 in Jira ↗` · `Checks ✓ 14 ✕ 1` · `Branch task/SV-3844-robin-sentry-lookup` · `Log`.

**Tabs:** `PR & CI` (default when a PR exists), `Jira`, `Decisions (3)`, `Log`. Bodies are the compact versions of the Ticket tabs (section 6), height-limited with `Open full ticket`.

### 4.4 Detail states (draw each) (updated 15 Nov)

1. **Default** (as above).
2. **Submitting:** primary button busy (label kept: `Sending answer…`), options locked, `Esc` does nothing.
3. **Recorded (exit 0):** the question block collapses to one line with a check: `✓ Answer sent to SV-3844 at 10:14. The worker picks it up at the next pass (10:17).` Verbatim record line below in mono. The list row animates out (150 ms height collapse, reduced-motion: instant). Detail does **not** auto-advance; it shows `Next: SV-3880 worktree in use · j` with the next item's first line, so the user moves on deliberately.
4. **Nothing to do (exit 10):** neutral note `Nothing changed: SV-3954 was already merged at 10:02.` + verbatim stdout. Item leaves at the next refresh.
5. **Refused (exit 11):** red-bordered `Alert` directly under the action bar:
   title `Desk didn't record that`, body = verbatim stdout, e.g.
   `SV-3880's worktree ~/studia/studia-web/.worktrees/SV-3880 holds work origin does not have (3 commit(s) not pushed: …): push or discard it, then drop SV-3880 again. Nothing was dropped` (queue.mjs drop's real refusal).
   Actions: `Choose another answer` (focuses options) · `Open conversation`. Typed text is kept.
6. **Group answer:** Detail shows the shared cause as the question, then a member list with checkboxes (all checked):
   `☑ SV-3952 #3113 · ☑ SV-3960 #3096 · … ☑ SV-3965 #3102`. Each member has an expand chevron showing its own verbatim text (to catch a near-duplicate). Options are the intersection of members' actions. Primary: `Record "done" for 9`.
   Progress while running: `Recording 4 of 9…` with a per-member ✓/✕. Partial failure: `7 recorded, 2 refused` and the 2 stay selected with their verbatim refusals.
7. **`MESSAGE` to a live session (G4):** after recording, a callout:
   `A live Claude session runs this batch (desk-autopilot-web). Pass it this message:` mono block `MESSAGE desk-autopilot-web: SV-3880 start` with `Copy message`. Footer `Desk can't send to a session directly yet.`
8. **PR merge hold (kind `pr`):** question `#3084 · only a person merges it: changes CI workflow`. Options: `1 Open PR to merge (Recommended)` opens GitHub; after return, `2 done: I merged it`. Copy: `Merge it on GitHub, then come back and choose "done". Desk checks the PR before it records.`
9. **Usage hold (kind `usage`) (updated 15 Nov):** `desk-skills is waiting for its subscription's 7-day reset (Tue 08:00), 12 tickets ready.` desk never moves a repo to another subscription by itself. Options `1 Wait until Tue 08:00 (Recommended)` · `The 12 tickets start at Tue 08:00 on ben@studia.example. Nothing else changes.` and `2 Open Subscriptions in Usage & costs` · `Pin desk-skills to another subscription there.` The Inbox item never writes a pin itself: every subscription write happens in Usage & costs (11.4).
10. **Item already gone** (answered in the terminal meanwhile): replace detail with `SV-3952 was answered elsewhere at 10:11.` + its record line, `Next item · j`.
11. **Loading detail:** skeleton for header, 4 text lines, 3 option cards. Never blank.
12. **Drop, two-step confirm (new 15 Nov).** Drop is irreversible: `queue.mjs drop` deletes the ticket's queue row and removes its worktree (a running ticket's worktree is left; a worktree holding unpushed or uncommitted work is refused, state 5). So:
    - Step 1: choosing `drop` (click or its number key) only selects it. The primary reads `Drop SV-3957…` and nothing runs.
    - Step 2: pressing it replaces the action bar in place (not a dialog) with: `Drop SV-3957? This deletes it from the batch and removes its worktree. It can't be undone. To bring it back, run /desk-admit.` Buttons `Keep SV-3957` (focused, left) · `Drop SV-3957` (destructive). Esc = keep.
    - Running: `Dropping SV-3957…`. Done: `✓ Dropped SV-3957 at 10:14. Its worktree was removed. /desk-admit brings it back.` and the verbatim stdout. No undo, no undo toast.
    - No single key drops; `#` is not bound (4.8). Group apply never offers drop.
13. **Gate-block approval (new 15 Nov)** (kind `base-push`, or a park holding a `JIRA COMMENT` / GitHub write block). Runs `answer.mjs --approve` (desktop-architecture.md).
    - Default: the block verbatim in mono, `Copy` button, caption `This is the exact text that will be posted.` Primary `Approve this Jira comment ⏎`; secondary `Answer instead…` (typed).
    - Submitting: `Approving…`, block and buttons locked.
    - Recorded: `✓ Approved at 10:14. The worker posts exactly this text at its next pass.` The block stays visible, read-only.
    - Refused (exit 11): `Alert` with verbatim stdout; the block stays; `Choose another answer`.
14. **Batch grant, typed confirm (new 15 Nov).** A grant for a whole batch (`merge`, `undraft`, `base-push`, `images`; `queue.mjs set-batch approved.<grant>`) uses the 9.4 Dialog pattern: title `Let desk merge every green PR in studia-web's batch?` · body names the effect and the count (`9 PRs now, and any that turn green later in this batch.`) · field `Type studia-web to confirm` · `Keep asking each time` (focused) / `Grant for this batch` (disabled until typed). The server checks the typed text too.

### 4.5 Kind tooltips (exact copy)
| Kind | Tooltip |
|---|---|
| parked | A worker stopped to ask you something. |
| session | Only an interactive session can do this. |
| spine | The epic's shared plan needs a decision. |
| plan | A plan needs your approval before work starts. |
| triage | A new ticket needs sizing or a lane. |
| held | Started only when you say so. |
| stopped | A worker stopped and needs requeue or drop. |
| pr | A pull request needs a person, often to merge. |
| worktree | The ticket's folder is in use by something else. |
| usage | A usage limit is holding work. |
| base-push | Pushing to the base branch needs your approval. |
| config | The repo's desk setup is missing a value. |
| templates | A PR or ticket template is missing. |
| unset | A setting desk needs is unset. |
| reviewer | A review gate needs a reviewer. |
| step | A step in "your steps" is waiting on you. |
| lever | A lever desk is testing needs your decision. (new 15 Nov) |

### 4.6 Guardrails against answering too cheaply
- `⏎` records only if the item has been in Detail for ≥ 1 s and the question block was scrolled into view at least once. Otherwise pressing `⏎` scrolls to the question and shows the hint `Read the question first, then press ⏎.`
- No auto-advance after recording (state 3).
- Number keys select, they never record.
- Group apply always opens the member list first.

### 4.7 List states
| State | Copy / treatment |
|---|---|
| Loading (first open) | List skeleton 8 rows; detail skeleton. Under 300 ms usually, from the last snapshot. |
| Refreshing (settling list in flight) | Header stamp becomes `Checking GitHub and Jira…` with a 12 px ring; list stays interactive. |
| Empty (goal state) | Centered in list, no illustration: title `Nothing needs you` · body `7 workers are running. The next pass is at 10:11, and the next check-in is at 17:00.` · links `See workers` `See decisions taken (12)`. Detail pane shows today's activity summary: `Merged today: 3 · Started: 5 · Answered by you: 4`. |
| 1 item | Normal list; detail opens on it automatically (the one exception to "select manually"). |
| Many (100+) | Virtualised; header count; groups collapse by default above 50. |
| Filtered to empty | `No items in studia-zendesk match these filters. 20 others need you.` · `Clear filters`. |
| List failed (GitHub down) | Stamp `◌ As of 10:02 · GitHub didn't answer` and an inline `Alert`: `Showing the last list. GitHub isn't answering (gh: HTTP 502), so new PR items may be missing.` · `Try again`. |
| Auth expired | `GitHub sign-in has expired, so PR items can't be checked.` code `gh auth login` copy · `Check again`. Jira equivalent: `Jira sign-in for studia-web has expired. Run /desk-setup to add a new token.` · `Open /desk-setup`. |
| Offline | Stamp `◌ As of 10:02 · offline`. Answers that need the network (pr, reviewer) disabled with tooltip `Needs GitHub. You're offline.` Answers that only write local files (start, requeue, not now) still work. |
| Production broken present | Red top group `! Production broken · 1` pinned, always expanded, red left rule; detail opens on it on load. |

### 4.8 Inbox keyboard (updated 15 Nov)
| Key | Action |
|---|---|
| j / k | Next / previous item (opens it in Detail) |
| ⏎ | Record the chosen answer (guarded, 4.6) |
| 1-9 | Choose answer option n |
| e | Not now (records at once, 10 s undo) |
| ⌘Z | Undo the last not now within 10 s |

Drop has no key and no undo (updated 15 Nov): choose it, then confirm in place (4.4 state 12).
| a | Focus the answer text field |
| o | Open conversation for this item |
| t | Open the full ticket page |
| p | Show PR & CI tab · Shift+P open PR on GitHub |
| Shift+J | Open ticket in Jira |
| x | Add/remove item in a multi-select (then `Apply to selected`) |
| ← / → | Collapse / expand group |
| / | Focus filter |
| r | Check needs-you now |
| Esc | Leave text field; second Esc clears selection |

Shortcuts are inactive while typing in a field (except ⌘⏎ which records from inside the textarea, same guard).

---

## 5. Single queue (list and board)

**Purpose:** A3-A9, B1-B4, B7. Route `/repos/{repo}` (or `{repo}:{epic}`). Tabs in page header:
`Queue` · `Timeline` · `By day` · `Epics` · `Decisions` · `Settings (read only)`.

### 5.1 Header (repo context, 96 px)
- Breadcrumb `Repos › desk-skills`.
- Title `desk-skills` + full name muted `bigbenjoman/desk-skills`.
- State summary line (glyph counts, each a filter toggle): `◆ nothing needs you  ● 4 running  ○ 17 ready  ▸ 2 merging  · 14 waiting  ✓ 90 done`.
- Supervisor line: `● supervisor · last pass just now · next pass 10:11` · `Turn off…` text button (muted, friction 9.4).
- Workers control (right): segmented stepper `Workers  [−] 4 [+]  of 30` · helper under it `Machine 7 of 30`. See 5.5.
- View toggle `List | Board` (v). Default List.

### 5.2 List view (default)
Grouped table, groups in this order: Needs you, Running, Merging, Ready, Waiting, Done (collapsed).
(Needs you moves to the top here, unlike desk-q's order, because in the app the list is scanned for action.)

Columns: `#` (spawn position) · Ticket · State · What it needs · Starts · Ships · Title.
Real rows:
- Running: `1  DS-676  ● running  stage 4/9 Verify since 09:53  running  today 13:03  desk-pr: a saved-canvas PR shows one stitched image per board…`
- Running: `7  DS-606  ● running  stage 4/9 · collides with 13  running  today 11:51  autopilot: a fix try is held as worktree in use…`
- Merging: `–  DS-625  ▸ merging  #658 · draft · out of draft at the next pass  for 1h 26m  —  desk-q Usage: enter on a repo opens a dropdown…`
- Ready: `6  DS-615  ○ ready  #655 · 1 check failed · waits for DS-606 (collides)  today 11:55  today 17:34  autopilot: a park waiting on a PR…`
- Waiting: `3  DS-673  · waiting  behind DS-672 (running, stage 0/9)  Tue 00:33  Tue 08:32  upload: one shared queue uploads screenshots…`

Cell components:
- **Stage cell (updated 15 Nov):** 10-segment micro stepper (48 x 6, stages 0 to 9; 4b Self-review drawn as a half segment after 4) + text `stage 4/9 Verify`. Tooltip lists stages with times, using desk's names (7.2).
- **What it needs:** blockers are links (`behind DS-672`); `(collides)` gets a dotted underline with HoverCard `DS-680 and DS-672 both change skills/desk-pr/scripts/upload.mjs, so they don't run at the same time.`
- **Ships:** date + p80 whisker tooltip `Could run to today 17:10 (1 run in 5 is later). Based on 29 merged size M tickets.`
- **Group header:** `Ready · 17` + muted `12 with no free slot` + collapse chevron. Waiting collapses by default above 20 rows: `Show all 59 waiting`.

Row interactions:
- Click opens Ticket page (section 6) in the main area; Detail pane is not used here (queue needs width). Alt-click opens a 520 px peek `Sheet` on the right instead.
- Drag handle (6-dot, shows on hover/focus) on Ready and Waiting rows reorders spawn position. Running/Merging rows have no handle (tooltip `Running tickets keep their place`).
- Row context menu (right-click or `.`): `Move to top` · `Move up` · `Move down` · `Move to bottom` · `Move to position…` · separator · `Open PR` · `Open in Jira` · `Open conversation` · `Copy key`.

### 5.3 Reorder flow
1. User drags DS-615 to position 1 (or presses ⌥⇧↑).
2. Optimistic: row moves, shows a 2 px blue left rule and `Moving…` in the # cell.
3. Command runs (`queue.mjs move`). Exit 0: rule fades; inline line under the header for 4 s: `DS-615 is now first. It still waits for DS-606 (collides), so it starts at today 11:55.` (the ETA explains why moving it didn't help, when that's true).
4. Exit 11 or lock held: row returns to its place (200 ms), inline `Alert`: `Couldn't move DS-615: a pass holds the queue lock. Trying again in 3 s.` then retries twice, then `Try again`.
5. If G7 (what-if) exists: while dragging, a ghost ETA appears next to the dragged row: `ships today 17:34 → today 15:02`. Without G7, show nothing (no fake preview).

### 5.4 Board view
Five columns, 256 px min each, horizontal scroll inside the body only: `◆ Needs you 0`, `● Running 4`, `○ Ready 17`, `▸ Merging 2`, `· Waiting 14`. Done is a footer link `✓ 90 done`.
Card (240 x 92): key + kind/lane chip `A · M` · title 2 lines · footer: stage stepper or blocker line, ETA right. Running cards show a 1 px live pulse on the left edge (reduced-motion: static).
Dragging only reorders within Ready/Waiting (vertical). Cross-column drag is not allowed (state is not user-settable); attempting it shows a no-drop cursor and tooltip `State changes by itself. To act on a ticket, use its menu.`

### 5.5 Workers control
- Stepper `[−] 4 [+]`, range 0 to cap (30). Each click stages a new value; it applies after 1.5 s of no change or on Enter, showing `Setting workers to 6…` then `Workers set to 6. Up to 2 more start at the next pass (10:11).`
- Above repo cap: `+` disabled, tooltip `30 is this repo's cap. Change the cap in /desk-setup.`
- Exceeding machine headroom: allowed but warns inline `The machine has room for 7 more workers, so only 7 can start.`
- When a "no free slot" is caused by collisions: inline hint `More workers won't help now: 12 ready tickets wait for DS-606.`
- Setting 0: treated as a pause and gets a confirm in place (not a dialog): `Set workers to 0? Running workers finish; nothing new starts.` buttons `Pause new work` / `Keep 4`.

### 5.6 Other tabs (brief, one frame each)
- **Timeline:** Gantt, epics first then tickets; bars start→ship with p80 whiskers; today line; zoom `Day | Week | Month`. Empty: `No dates yet. Desk dates tickets after 3 merged tickets of a size; desk-skills has 2 of size L.`
- **By day:** a list per day `Today · 4 ship` `Mon · 3 ship`…
- **Epics:** `DS-631 Levers · 9 children · plan approved · base gate ● green`. Child rows reuse queue rows.
- **Decisions:** see section 10.
- **Settings (read only):** see 9.3.

### 5.7 States
| State | Treatment |
|---|---|
| Loading | Header from snapshot; table skeleton per group. |
| Each group empty | Group header with `0` and one muted line: Running `No worker on desk-skills right now.` · Ready `Nothing ready. Waiting tickets start as their blockers finish.` · Needs you `Nothing needs you here.` |
| All empty | `desk-skills's queue is empty. 90 tickets are done.` · `Add tickets with /desk-admit` (opens conversation). |
| Supervisor off | Banner in body: `The supervisor is off for desk-skills, so nothing moves.` · `Turn it on` (confirm, 9.4) · `Or run /desk-autopilot in a session.` |
| Lock held | Drag disabled 3 s with cursor `wait` and header note `A pass is updating the queue…`. |
| Many (59 waiting) | Waiting collapsed `Show all 59`; virtualised. |
| Long blocker lists | `behind SV-2451, SV-2885, SV-3092 +4` with HoverCard listing all. |

### 5.8 Queue keyboard
j/k move · ⏎ open ticket · Space peek · ⌥↑/⌥↓ move up/down · ⌥⇧↑/⌥⇧↓ top/bottom · m move to position · v list/board · w focus workers stepper · f filter by state · ⌘[ back.

---

## 6. Ticket page

**Purpose:** A5, D1-D7, E1-E3, F1-F4, H3, I1-I3, J1t-J2t. Route `/t/{repo}/{key}` (e.g. `/t/studia-web/SV-3844`). Same layout from anywhere.

### 6.1 Header (sticky, 128 px)
- Breadcrumb `desk-skills › Queue › DS-676`.
- Line 1: `DS-676` (mono, 20 px; ⌘-click Jira) · state badge `● running` · `Story · size M · lane A · position 1 of 24`.
- Line 2: title `desk-pr: a saved-canvas PR shows one stitched image per board and theme, with every breakpoint and its PASS/FAIL table`.
- **State line (hero), full-width, 3 px left rule in the state colour:**
  - running: `Moves without you: a worker is on it, stage 4/9 Verify since 09:53.`
  - needs you: `Needs your answer: SV-3844 PR #2699 is an external-shape change…` + `Answer in Inbox` button.
  - waiting: `Moves by itself: behind DS-672 (running, stage 0/9).`
  - merging: `Merges by itself once green: #658 is draft and comes out of draft at the next pass.`
  - ready: `Starts when a worker is free. Waits for DS-606 (collides).`
  - failed: `Stopped: unit (node 24) still red after 2 fix tries. Requeue or drop it in Inbox.`
  - done: `Merged at 09:41 as #651.`
- Right actions: `Open PR #651 ↗` · `Open in Jira ↗` · `Open conversation` (primary on needs-you, secondary otherwise) · overflow `…` (Move…, Copy key, Copy branch, Open worktree in Finder, Open in editor).

### 6.2 Tabs
`Overview` · `Live` (only when running or with a log) · `PR & CI` · `Jira` · `Cost` · `History`. Keys 1-6 when header focused; `[` `]` cycle.

### 6.3 Overview
Two columns (1440: 2/3 + 1/3; 1024: stacked).
- **Schedule card:** `Starts  running now` · `Ships  today 13:03, could run to today 17:10 (1 run in 5 is later)` · `Based on 29 merged size M tickets in desk-skills · typical 5.3 h spawn to merge, 4 in 5 within 12.7 h`. No-date variant: `No date: it starts once you answer it.` + `Date it as if answered at the next check-in`.
- **Why lane A:** verbatim lane reason paragraph, collapsible after 5 lines `Show all`.
- **Files in scope · 2:** mono list, each path clickable (copies path; ⌘-click opens in editor). 100+ files: first 20 + `Show 84 more`. 0 files: `No files listed. The worker decides scope.`
- **Collisions / blockers card:** `Never runs with SV-4017` · `Blocks: SV-4017` · `Waits for: —` with a mini graph (nodes as key chips, arrows) when ≥ 3 links.
- **Side column:** Branch `feat/DS-676-stitched-canvas-pr-images` (copy) · Worktree path (copy, `Open in Finder`) · Port `4831` · Subscription `ben@studia.example` (the default; updated 15 Nov) · Model `opus · effort high` · Session id (copy) · Log path (opens Live).

### 6.4 Live tab
Same component as section 7's worker view, embedded full-width.

### 6.5 PR & CI tab
- **Gate verdict (hero card):** one sentence answering "what blocks merge?":
  - `Ready to merge: all 14 required checks green and approved. The merge driver merges it at the next pass (10:11).`
  - `Blocked: unit (node 24) is red. Fix try 1 of 2 is running.`
  - `Stuck: unit (node 24) still red after 2 fix tries. It says: "expected 3 rows, got 2 at stitch.test.mjs:88".` (quote verbatim, mono)
  - `Only a person merges it: it changes CI workflow (.github/workflows/tests.yml).` + `Open PR to merge ↗`.
- **PR summary row:** `#651  fix(autopilot): an unreadable clears-when's restate hour does not run while no decider can start (DS-563)` · `Open · draft no · review APPROVED · 1 approval · mergeable CLEAN · head 73ee8aca (12m ago)` · `Open on GitHub ↗`.
- **Checks table:** columns Check · Kind (`required` / `advisory` / `known flaky`) · Status (`✓ passed` `✕ failed` `◷ running 3m` `○ queued`) · Duration · Runner · link `Job ↗`. Failed rows first. Row click expands the last 40 lines of the job log (fetched via server; `As of 10:07`). Footer: `Reruns used 1 of 2 · Fix tries used 2 of 2`.
- **Review card:** desk-review verdict `Review: 2 gaps need a person` with each gap quoted verbatim and its recommendation. Unresolved threads count `3 unresolved threads` + `Run /desk-review-response` (conversation).
- **Diff (collapsible, fetched live, G5):** file list with +/− counts; click a file to see the unified diff (read-only). Over 2,000 lines: `This diff is large (4,812 lines). Open it on GitHub ↗`.
- **States (updated 15 Nov):** no PR yet `No PR yet. The worker opens one at stage 7/9 (PR).` · draft `Draft. Comes out of draft at the next pass.` · merged `Merged 09:41 by the merge driver.` · GitHub unreachable `Showing the copy from the last pass (10:05). GitHub isn't answering.` · loading: summary from pass snapshot immediately, checks skeleton until live fetch returns.

### 6.6 Jira tab
- Card: `SV-3844 · Task · In Progress · Priority Medium · Assignee Ben L.` · summary · description (rendered, collapsible) · last 5 comments (author, time, text) · `Open in Jira ↗`. `As of 10:06 · Refresh`.
- **Pending Jira writes** (parked gate blocks): `1 Jira write waits for your approval` with the verbatim block and `Approve in Inbox`.
- **States:** Jira not configured `studia-zendesk has no Jira site set, so tickets link to GitHub issues.` + `Open issue #212 ↗` · Jira auth failed `Jira didn't accept studia-web's token. Run /desk-setup to add a new one.` · loading skeleton.

### 6.7 Cost tab
- Totals: `Tokens 4.2M (3.6M cache read · 0.31M cache write · 0.21M input · 0.08M output)` · `Notional $11.40` *(illustrative)* · `Wall 2h 14m`.
- Per round table: Round · Model · Tokens by kind · Cache hit % · Notional · Wall. `Round 2 (fix try 1)`.
- By caller: worker, triage, decider, subagent, interactive.
- Unrecorded runs show `unknown` never `$0.00`, with tooltip `This run ended without a result line, so its cost wasn't recorded.`
- Budget: `Per-worker cap $25 · used 46%` bar.

### 6.8 History tab
Reverse-chronological event list: `10:07 stage 4/9 Verify` · `09:53 stage 3/9 Implement` · `09:41 decision taken: split that width into one image per capture` (link to Decisions) · `09:12 spawned on ben@studia.example, port 4831` · `08:40 admitted by /desk-admit` · answers the user recorded, with their text. Previous rounds' logs `round1.gz · Download`.

### 6.9 Ticket keyboard
1-6 tabs · o open conversation · Shift+P PR on GitHub · Shift+J Jira · c copy key · b copy branch · ⌘[ back · a answer (if needs you, jumps to Inbox item).

---

## 7. Workers (live worker view)

**Purpose:** F1-F4, J5. Route `/workers` (grid) and `/workers/{repo}/{key}` (focused).

### 7.1 Grid (1440)
- Header: `Workers  7 running · machine cap 30 · 27.5 GiB free` · filter `All repos v` · sort `Longest running`.
- Tiles 3 across (440 x 220), Compact 2 across:
  - Top: `● DS-676` · `desk-skills` · `stage 4/9 Verify` stepper · elapsed `15m in stage · 2h 14m total`.
  - Middle (mono, 4 lines, last lines of activity, newest at bottom):
    `▸ Bash  node --test skills/desk-pr/scripts/test_stitch.mjs`
    `  ✓ 18 tests passed (2.4s)`
    `▸ Edit  skills/desk-pr/references/screenshots.md`
    `Writing the PASS/FAIL table rows for each breakpoint…`
  - Bottom: heartbeat `last activity 4 s ago` (green) · `opus · high · ben@studia.example` · `Open`.
- Tile stuck signal: when no tool progress for > 10 min and log not growing for 2 passes: amber border, line `No activity for 14 min. It may be stuck.` with `Look closer`.

### 7.2 Focused view (also the ticket's Live tab)
Layout: left 2/3 stream, right 1/3 facts.
- **Stage stepper (updated 15 Nov)** across the top, desk's real stages (`skills/desk-ticket/SKILL.md`): `0 Triage · 1 Branch · 2 Understand · 3 Implement · 4 Verify · 4b Self-review · 5 Evidence · 6 Hygiene · 7 PR · 8 Jira · 9 Cleanup`. The PR opens at 7/9; CI and fix tries happen around 7; 9 is cleanup after merge. Merging is the merge driver's job, not a stage, so it shows as the ticket's `▸ merging` state, never as a step. Done stages ✓ with time, current pulses, future muted.
- **Current activity line (hero):** `Verifying: running node --test (1m 12s)`.
- **Stream:** rendered stream-json events as compact cards:
  - assistant text (prose, 14 px),
  - tool call `▸ Bash` with command in mono, collapsible output (first 8 lines, `Show 120 more`),
  - edits `▸ Edit skills/desk-pr/SKILL.md +4 −1` expandable diff,
  - subagent `▸ Agent  "verify breakpoints"` nested, collapsed,
  - desk markers `desk_preflight` / `desk_spawn` as thin dividers `Spawned 09:12 · port 4831 · ben@studia.example`.
  - Controls: `Follow` toggle (on by default; scrolling up turns it off and shows `Jump to latest ↓ (12 new)`), `Show thinking` off by default, search within log (⌘F).
- **Facts column:** Is it stuck? card: `Last tool progress 4 s ago · log grew 18 KB in the last pass · idle passes 0` → verdict `Working.` / `Slow but working.` / `May be stuck: no activity for 14 min, 2 idle passes.` Then model, effort, login, port, database, worktree, session id, tokens so far *(illustrative)* `1.9M · $5.10 notional`.
- **Actions:** `Open conversation about this worker` (forks the session, see 8.3) · `Open log file` · `Copy session id`. No Stop button (G9). In its place a muted line: `To stop a worker, use /desk-reboot or the terminal. Desk has no safe stop button yet.`
- Accessibility: stream region `aria-live="polite"` announces only stage changes and the stuck verdict.

### 7.3 States
| State | Copy |
|---|---|
| No workers | `No worker is running. 17 tickets are ready in desk-skills, and the next pass is at 10:11.` (If none ready: `Nothing is ready to start.`) |
| No log yet (stage 0) | `Preflight: getting the worktree and subscription ready. The log starts when the worker does.` skeleton stream |
| Idle heartbeat (codex exec) | `Codex is working without output. Last heartbeat 20 s ago.` |
| Finished | Stream ends with result card `✓ Finished in 2h 14m · 4.2M tokens · $11.40 notional` *(illustrative)* `PR #651 opened`. |
| Killed / no result | `The worker ended without a result at 11:02. Cost unknown.` |
| Round 2 started | divider `Round 2 · fix try 1 started 11:20` with `Show round 1`. |
| Huge log (50 MB) | `Showing the last 2,000 events. Load earlier` |
| Log unreadable | `Can't read DS-676.log (permission denied). Open it in Terminal: tail -f …` |

---

## 8. Interactive Claude session panel (Conversations)

**Purpose:** J4, G1c-G5c. Route `/conversations` and `/conversations/{id}`. Also opens as a right-side panel (560 px, resizable 420-800) from any Inbox item, ticket or worker, so the evidence stays visible beside it.

### 8.1 Start sheet (shown when `Open conversation` is pressed; inline in the panel, not a modal) (updated 15 Nov)
- Title `Start a conversation about SV-3844`.
- **Start from** (radio cards, recommended first):
  1. `Fresh, with the ticket's briefing` tag `Recommended` · `Starts clean with SV-3844's briefing, the question and PR #2699. Cheapest: about 40k tokens to start.`
  2. `Continue the worker's session` · `Picks up where the worker stopped, with everything it saw. Its cache has expired, so the whole session is read again: about 1.4M tokens (≈ 2% of the 7-day window).` *(figures illustrative; computed from transcript size)*. Disabled while the worker is running: `The worker is still running. You can start fresh or wait until it stops.`
  3. `Run a skill` · dropdown `/desk-ticket SV-3844` (default for `session` items) · `/desk-needs-you` · `/desk-admit` · `/desk-groom` · `/desk-clearance` · `/desk-review-response` · `/desk-setup` · `/desk-update` · `/desk-reboot`.
- **Where it runs:** `Folder  ~/studia/studia-web/.worktrees/SV-3844` (read-only display). If a worker holds that worktree: `A worker is using this folder, so the conversation starts in a fresh copy: ~/studia/studia-web (main).`
- **Subscription:** not a choice. A conversation runs on the repo's subscription, shown as a read-only line that leads with the email: `Runs on studia-web's subscription: ops@studia.example (work-2) · 7d 12%`. Above 85%: `This subscription is at 88% of its 7-day window.` Changing a repo's subscription happens only in Usage & costs (11.4).
- **At-limit variant (new frame):** only when the repo's subscription is at its limit does the sheet offer another one, for this conversation only:
  - Callout `desk-skills' subscription is at its limit` · `default · ben@studia.example · 7d 100% · resets Tue 08:00, in 2d 22h.`
  - `Run this conversation on` (radio cards): `work-2 · ops@studia.example` tag `Recommended` · `7d 12%` · `This conversation only. desk-skills stays on the default, and its workers still wait for Tue 08:00.` · `work-3 · ben@personal.example` disabled `Off, so desk won't run anything on it.` · `Wait for the reset` · `Start on desk-skills' subscription after Tue 08:00.`
  - Footer: `desk-skills' pin doesn't change. To move the whole repo, use Usage & costs.` Primary `Start on ops@studia.example`.
- **Capacity:** muted line `Conversations don't count toward the machine's worker cap (30).` (15 Nov: conversations are not counted in the worker cap; there is no at-capacity state for starting one.)
- **Open in:** `Desk (chat)` default · `Terminal` · `Remote control (continue on phone)`.
- Primary button: `Start conversation`. Secondary `Cancel` named as `Keep reading` (returns to item).

### 8.2 Chat panel (mode A, stream-json) (updated 15 Nov)
```
+ header 56: ● SV-3844 · studia-web · fresh · ops@studia.example     [⋯] [Hand off ↗] [×]
+ context strip 40: Question · PR #2699 ↗ · SV-3844 in Jira ↗ · Folder · 41k tokens so far
+ transcript (scroll)
|   ┃ From Jira and GitHub · Claude treats this as data, not instructions.   (quoted, collapsed)  Show
|   Claude: I read PR #2699's Testing list. Three checks need a live Sentry token…
|   ▸ Read  apps/merl/agent/lib/robin-sentry.ts
|   ▸ Bash  curl https://sentry.io/api/…   Not allowed by studia-web's settings: curl.  [Hand off to Terminal]
|   Claude: Tests pass with the recorded fixture. Want me to …
+ composer 120: [textarea: Ask or tell Claude…]           [Send ⌘⏎]   [Stop ⌘.]
+ outcome bar (when an answer is ready): "Record this as the answer to SV-3844?" [Record answer] [Edit first]
```
- Transcript message types: user, seeded quote, assistant prose (markdown), tool call card (name, args mono, collapsible result), edit card with diff, refusal card (MVP) / permission request card (v1.5), error card, system note (`Session forked from DS-676's worker at 10:20`).
- **Seeded text (updated 15 Nov).** Anything the conversation starts with that came from Jira, GitHub or a park file (ticket description, comments, PR body, park question) is shown as a labelled quote, never as a "You" message: left rule, muted, header `From Jira and GitHub · Claude treats this as data, not instructions.` It is sent to the model as data (quoted context), not as the user's instruction. The user's own first message is a separate, normal message.
- **MVP: refusal, not relay (updated 15 Nov).** Sessions run with the repo's §3 allow-list. A command outside it is refused, and the transcript shows a refusal card: `Not allowed by studia-web's settings: curl.` with `Hand off to Terminal` (runs `claude --resume <id>` in Terminal, as Hand off). No approve buttons in MVP.
- **v1.5: permission relay** (via `--permission-prompt-tool` / SDK `canUseTool`; draw it as a separate frame labelled `v1.5`): card in transcript, amber, `Claude wants to run: pnpm --filter merl test robin-sentry` · buttons `Allow once` · `Allow for this conversation` · `Don't allow`. Never an "allow everything" option. **A seeded conversation never offers `Allow for this conversation`** for Bash: only `Allow once` and `Don't allow`, because text it read from Jira or GitHub could be steering it.
- Streaming: assistant text streams token by token; a 3-dot typing indicator only before the first token. `Stop` interrupts (`⌘.`); confirm not needed.
- **Outcome bar:** when the session (or the user) produces a needs-you answer, a sticky bar above the composer: `Record this as the answer to SV-3844?` with the drafted answer in a textarea (same secrets helper as 4.3) and `Record answer` (same command and states as 4.4). When the item is recorded by the session itself (it ran `needs-you.mjs record`), show `✓ The session recorded: answer SV-3844 "…" at 10:31.` and the Inbox item leaves (G5c).
- **Read-only after recording (updated 15 Nov).** Recording an answer from a live chat (either way above) ends the chat's turn in that folder, because the worker will resume there: the composer is replaced by `The worker resumes in this folder at 10:34, so this conversation is now read-only.` with `Start a follow-up` (fresh copy) and `Open in Terminal`. The time is the next pass. The app enforces this in the panel; making the worktree itself read-only to the session is **planned** (no ticket yet).
- **Hand off** (header): `Open in Terminal` runs `claude --resume <id>` in Terminal; `Continue on phone` starts `--remote-control`; both show `Handed off at 10:33. This panel is now read-only.`
- Header `⋯`: `Copy session id` · `Show token use` · `End conversation`.
- Token meter in context strip updates live: `41k tokens · $0.12 notional` *(illustrative)*.

### 8.3 Forked worker conversation
Header tag `forked from worker` and system note `This is a copy of DS-676's worker session. The worker keeps running and won't see this conversation.` Composer placeholder: `Ask why it did something, e.g. "Why split the image by width?"`.

### 8.4 Conversations list
- Left list (320): live first, then ended today, then earlier. Row: `● SV-3844 · fresh · 41k · 12m` / `✓ DS-606 · forked · ended 09:40 · recorded requeue`.
- Empty: `No conversations yet. Open one from any Inbox item or ticket with o.`

### 8.5 States (updated 15 Nov)
| State | Copy |
|---|---|
| Starting | `Starting Claude in studia-web… (ops@studia.example)` skeleton transcript, `Cancel start`. |
| Waiting for input | Composer focused, header dot steady green, `Your turn`. |
| Running | Header dot pulsing, `Working…`; composer accepts typing, `Send` queues the message (`Queued: sends when Claude finishes this step`). |
| Exited normally | Transcript ends with `Conversation ended at 10:40 · 212k tokens · recorded answer SV-3844`. Composer replaced by `Start a follow-up` (fresh, seeded with this transcript's summary). |
| Exited with error | `Claude stopped unexpectedly (exit 1). Last message: "…"` verbatim stderr tail · `Start again` · `Open in Terminal`. |
| claude not installed / signed out | `Claude Code isn't signed in for ops@studia.example (work-2). Run claude in Terminal and sign in, then try again.` code `CLAUDE_CONFIG_DIR=~/.claude-logins/work-2 claude` copy. |
| Usage at limit (updated 15 Nov) | The at-limit Start sheet (8.1): another subscription for this conversation only, or wait for the reset. |
| Recorded from this chat (new 15 Nov) | Read-only, see 8.2. |
| Server restarted mid-session | `Desk's server restarted, so this view lost the live connection. The session itself may still be running.` `Reconnect` · `Open in Terminal`. |

### 8.6 Session keyboard
⌘⏎ send · ⌘. stop · ⌘⇧T hand off to Terminal · ⌘L focus composer · Esc focus transcript · y/n on a focused permission card = allow once / don't allow (v1.5 only) · ⌘W close panel (session continues; list shows it live).

---

## 9. Settings (and Health)

**Purpose:** L1-L7, A10, B7, H7. Route `/settings/{section}`. Rare and high-stakes, so: grouped by task, most-changed first, search at top, repo config read-only with changes routed to `/desk-setup`.

### 9.1 Layout (updated 15 Nov)
Left section nav (200): search `Search settings` · `Notifications` · `App` · `Subscriptions` · `Repos` (each repo) · `Desk install` (badge `3 updates` when skills or plugins have updates) · `About`. Right: form, 640 max-width. (updated 15 Nov)

### 9.2 App-side settings (editable; these are the app's own, saved locally) (updated 16 Nov)
These are app-local display preferences. The app saves them in its own file, outside desk's state, and they are the one exception to the write rule (1.5): no desk command runs (Ben, 16 Nov). Subscriptions and logins are not here; they go through `desk-env` from Usage & costs (11.4).
- **Notifications:**
  - `Tell me when` checklist (all on by default): `Production breaks` (locked on, caption `Always on: this is the one that can't wait.`) · `A check-in digest is ready (08:00, 17:00)` · `A health check fails` · `A pass is refused` · `The merge driver fails twice` · `Something new needs me` (off by default, caption `Off by default: the dock badge already shows the count.`).
  - `Quiet hours  19:00 to 08:00` (Production still notifies, caption says so).
  - `Mute a repo` multi-select.
  - `Who sends notifications`  `Desk app when it's open, the supervisor when it isn't (Recommended)` / `Always the supervisor`. Caption: `One sender at a time, so you never get the same alert twice.` (G12)
- **App:** Theme `System / Light / Dark` · Density `Comfortable / Compact` · `Open at login` · `Default place for conversations: Desk / Terminal / iTerm` · `Show dock badge with needs-you count`.
- Saved state: inline `Saved` check next to the control for 2 s; no Save button for toggles.

### 9.3 Repo settings (read only, structured from desk-config, G13)
Per repo, grouped by task: `Autonomy (§3)` · `Capacity (§3b)` · `Spend` · `Checks (§4)` · `People`.
- Each row: label, current value, plain-language meaning. Example:
  - `Merge on green  ask` · `A person approves each merge.`
  - `Undraft PRs  allowed` · `Workers take PRs out of draft when checks pass.`
  - `Concurrency cap  30` · `Up to 30 workers for this repo.`
  - `Memory ceiling  24 GiB` · `No new worker starts above this.`
  - `Per-worker budget  $25`.
  - `Jira site  jira.example.net` · `Ticket keys link here.`
- Rows with TODO values: amber `Not set` + `Desk can't use this until it's set.`
- Top of page: `These come from desk-skills's desk setup. To change them, run /desk-setup: it checks each change with you before saving.` button `Change in /desk-setup` (opens conversation scoped to the repo and section).
- **Supervisor (the one write here):** `Supervisor  ● on  · Turn off…` (see 9.4).

### 9.4 Typed confirmation (supervisor off; the only Dialog in the app)
- Title: `Turn off the supervisor for studia-web?`
- Body: `No passes will run for studia-web. Running workers finish, but nothing new starts, nothing merges and no one checks PRs until you turn it back on. 14 items already wait for you here.`
- Field label: `Type studia-web to confirm`.
- Buttons: `Keep it running` (default, left, focused) · `Turn off supervisor` (destructive, disabled until typed).
- Turning on needs no typing: inline `Turn on` → `Supervisor on. The first pass runs within 3 min.`

### 9.5 Subscriptions (updated 15 Nov; was "Logins & usage")
DS-616 rules (`~/.config/desk/subscriptions.md`): each tool (Claude, Codex) has one **default**; every
other subscription is **unused** or **off**. A repo runs on this computer's default unless it is
**pinned** to a subscription by email (config §3b Subscription). desk never switches a repo's
subscription by itself, and there is no standby or rotation.

This page is **read only**. Every subscription write (make default, pin a repo, add, turn off,
remove) happens in Usage & costs (11.4), next to each subscription's limits.
- Header: `Subscriptions` · muted `This computer · ~/.config/desk/subscriptions.md · read only here`.
- Info line: `Make a default, pin a repo or add a subscription in Usage & costs, next to each subscription's limits.` · `Open Subscriptions` (goes to 11.4).
- Rows, each leading with the email (the folder name `default` is never the label):
  - `Claude default` · `ben@studia.example · Max 20x` · badge `Default`
  - `Codex default` · `ben@studia.example · Pro · runs every Codex review` · badge `Default`
  - `Pinned repos` · `studia-web and ai-agents run on ops@studia.example (work-2)`
  - `ops@studia.example` · `work-2` · badge `Pinned · 2 repos` (a non-default subscription with pins is never labelled `Unused`)
  - `ben@personal.example` · `work-3` · badge `Off` · `desk won't pick it for new work.`
- Badge rule, both here and in 11.4: `Default` · else `Off` · else `Pinned · N repos` when N ≥ 1 · else `Unused`.
- "Off" means desk won't pick it for new work. A repo already pinned to an off subscription is not yet refused by desk (`subscription set` accepts an off email, and `logins set … off` accepts one with pins); that enforcement is a **pending ticket** from Ada's review.

### 9.6 Desk install (updated 15 Nov)
- Header: `Desk install` · `This computer · installed from ~/studia/desk-skills` · `Checked GitHub 10:05 · next about 10:10 · Check now`.
- `Installed  Desk 2026.11.15 c47f43ab · installed today 09:58 from main` · `GitHub main  3e91b0d2 · 2 commits ahead · ✓ tests passed` · `See the commits ↗`.
- **State line (auto-release, `desk/bin/maintenance.mjs` autoRelease).** Between maintenance windows, a pass fetches origin/main (at most every 5 min) and installs it by itself once main's `tests` check passes. One line, glyph + word:
  - Up to date: `✓ Up to date. Installed c47f43ab is GitHub main.`
  - Check pending: `· Waiting for main's tests check on 3e91b0d2. desk installs it once the check passes.`
  - Check unreadable: `◌ Waiting: main's tests check on 3e91b0d2 couldn't be read (…verbatim…). desk tries again at the next pass.` (not drawn yet, section 17)
  - Worker at Stage 7: `· Waiting: DS-697 is opening its PR in studia-web. 3e91b0d2 passed its tests check. desk installs it once no worker is opening a PR.`
  - Window open: `· Waiting: maintenance window open until 06:00. desk checks GitHub main again when it closes.`
  - Installing: `● Installing 3e91b0d2 (2 commits). Started 10:07.`
  - Installed: `✓ Installed 3e91b0d2 at 10:12 (2 commits). Supervisors and merge drivers move to it by themselves.`
  - Check failed: `✕ main's tests check failed on 3e91b0d2, not installing. You stay on c47f43ab until a newer commit passes.` · `See the check ↗`.
  - Blocked by uncommitted changes: `✕ Not installing 3e91b0d2: ~/studia/desk-skills has uncommitted changes, so nothing was pulled or installed.` · `Open the folder` (opens it in Finder). Other blocked reasons (not on main, fast-forward failed, install.sh failed) show desk's reason verbatim with the same button.
  - Installed commit not on origin/main: `✕ Not installing 3e91b0d2: the installed commit c47f43ab is not on origin/main, so it was not replaced. Run /desk-update.` (not drawn yet, section 17)
  - Fetch failed: `◌ Couldn't reach GitHub at 10:05 (git fetch failed). desk tries again at the next pass.`
  - Caption: `desk checks GitHub main about every 5 minutes and installs it by itself once main's tests check passes. It waits while a worker is opening a PR, and while a maintenance window is open.`
- **Running code** list: each supervisor and merge driver, `✓ installed code (c47f43ab)` or `◌ old desk code (a91d02e7). It moves to the installed code when it next waits between loops.`
- **Skills & plugins:** `3 updates available · context-audit · claude-statusline · plugin vercel 1.4.0 → 1.5.1 · checked today 08:00. desk doesn't install these by itself.` · `Review` (opens a `/desk-update` conversation). This is the only place these updates show: a badge on the Settings nav item `Desk install`, no Inbox item, no banner.
- `Is it safe to restart this Mac?` · `Runs the /desk-reboot check. Nothing restarts.` · `Check`.
- **Desk app:** `Built from c47f43ab · server 127.0.0.1:4823 · running 3 days` · `Restart server`. Restart needs an inline confirm that names live conversations: `Restart Desk's server? 1 live conversation (SV-3844) loses its live view until it reconnects. Workers and the supervisor keep running.` · `Keep running` (focused) / `Restart server`. With no live conversation: `Restart Desk's server? Workers and the supervisor keep running.`

### 9.7 Health (sidebar item, route `/health`) (updated 15 Nov)
- Failing first. All ok compact: `All 8 checks pass · checked 10:07`.
- Rows: `● gh  signed in as bigbenjoman` · `● jira  studia-web, studia-zendesk` · `● claude  3 subscriptions · default ben@studia.example` · `● codex` · `✕ browser  Playwright can't start Chrome · failing 3 passes · holds every spawn in desk-skills` + fix block `Run: npx playwright install chromium` copy · `● disk  212 GiB free (floor 20 GiB)` · per repo `● supervisor` `● merge driver alive`.
- Each failing row: what failed, why (verbatim check output in mono, collapsible), what holds because of it, the fix.
- **`desk` row (new 15 Nov)**, states:
  - `● desk  Desk 2026.11.15 (c47f43ab) · up to date with main · every supervisor and merge driver runs the installed code` · `checked 10:05`
  - `◌ desk  studia-web's merge driver runs old desk code. It moves to the installed code when it next waits between loops.` · `since 09:58`
  - `◆ desk  desk-skills' supervisor runs old desk code. Run ./install.sh in desk-skills.` · `Copy command`
  - `✕ desk  main's tests check failed on 3e91b0d2, so it wasn't installed. You stay on c47f43ab.` · `See the check ↗` (this row plus the 2.7 toast and the 9.6 state line are the whole release-failed treatment)

### 9.8 Settings states
Loading skeleton per group · Subscriptions file unreadable `desk can't read ~/.config/desk/subscriptions.md: … Fix those rows first.` (desk's verbatim reason) · repo config unreadable `Can't read studia-web's desk setup (desk-config.md missing). Run /desk-setup to create it.` · search no result `No setting matches "foo". Repo settings change in /desk-setup.`

---

## 10. Decisions (taken by workers)

**Purpose:** C7, J9. Route `/decisions`, also per-repo tab.
- Header: `Decisions  12 since the 08:00 check-in` · filter repo · `Since: check-in / today / 7 days`.
- Grouped by ticket, newest first. Card:
  - `DS-679 · 09:43 · desk-skills`
  - Question (verbatim): `The browser half of test_stitch.mjs is skipped on CI's runner with no expiry (review P1): install desk's Playwright in CI in this PR, or give the skip an expiry and a follow-up ticket?`
  - `Chose ✓ create follow-up DS-681 (CI installs desk's Playwright, skip fails in CI) and name it on the skip`
  - `Other option: change .github/workflows/tests.yml in this PR to install desk's Playwright`
  - Action `Override…` → inline: radio of the other option(s) or `Something else` (typed), button `Override decision` → runs `digest.mjs override <slug> <decision-id> "<choice>"`; states: busy, `Override recorded. DS-679's worker reads it at its next step.`, refused (verbatim). (In-flight, recorded and refused frames are not drawn yet, section 17.)
  - Lever decisions (updated 15 Nov) also land here as decisions.jsonl lines, written by `levers decide` (11b), not by `digest.mjs override`.
- Empty: `No decisions taken since the 08:00 check-in.`

---

## 11. Usage & costs

**Purpose:** H1-H6, J7. Route `/usage`. Two tabs: `Usage` (default) · `Bills`.

### 11.1 Usage tab
- **Hero:** 7-day window meter per subscription, 100% width bar with a pace projection marker (updated 15 Nov):
  `Claude ben@studia.example (default) · 7d 88% · resets Tue 08:00` · projection dashed segment `At this pace: 100% Mon 14:00, 18 h before reset.` Colours by threshold, plus text (never colour alone): `Fine` < 70, `Watch` 70-89, `Tight` ≥ 90, `Limit reached`.
- Secondary meters: `5h 32% · resets 13:10`, Codex `7d 46% · Mon 09:25`, other subscriptions compact (`ops@studia.example · Pinned · 2 repos · 7d 12%`).
- Probe stamp `Checked 10:05 · next 10:10` (`◌ Probe stale: last read 09:12` when > 2 intervals).
- **Tokens chart** (stacked bars, last 14 days, by `Repo | Caller | Model` toggle): cache read / cache write / input / output. Line overlay: cache hit %. *(Figures illustrative until G11 provides `tokens.jsonl`; until then the chart is computed on open with `Computing from 214 logs… 3 s` and cached.)*
- **Top tickets by tokens** table: `DS-606  6.1M  $16.20  2 rounds` … `unknown` for unrecorded.
- **By caller** table: worker, triage, decider, probe, interactive, subagent: tokens, cache hit %, share.
- **Budgets:** per repo `desk-skills · per batch $400 · used 61%` bars.

### 11.2 Bills tab
- Header: `Charged $676.23 in November, 1-14 · AWS $441.24 · Vercel $234.99`.
- Table (real): `default  $441.24  AWS only, no repo in desk` · `studia-web  $109.60  ◌ Vercel last read 12 Nov, 3 days ago` · `studia-admin  $12.98  ◌ …` · `shared  $106.45  Vercel Pro plan $87.10 · Additional Team Seats $19.35` · `total  $676.23  includes 14 bills from 3 days ago`.
- Zero rows collapsed: `Show 11 projects at $0.00`. `–` rows: `No bill linked`.
- Stale alert: `Vercel hasn't answered since 12 Nov, so 14 figures are 3 days old.` `Try again`.

### 11.3 States (updated 15 Nov)
loading: meters from cache instantly, chart skeleton · at limit (updated 15 Nov): hero bar full red-pattern + `Limit reached. Repos on ben@studia.example wait until Tue 08:00. desk doesn't move them.` · `Pin a repo to another subscription` (scrolls to 11.4) · no history: `Token history starts once workers finish. None have since desk was updated.`

### 11.4 Subscriptions (new 15 Nov, DS-616): every subscription write lives here
- Section header `Subscriptions` · `Each repo runs on this computer's default, or on the one it's pinned to. desk never switches subscriptions on its own.` · `Add subscription`.
- **Cards**, one per subscription, leading with the email: `ops@studia.example` · muted `work-2 · Max 5x · ~/.claude-logins/work-2` · badge (9.5 rule) · 5h and 7d meters · `Pinned by studia-web, ai-agents`. Card actions: `Make default` · `Turn off` (`Set to unused` when off) · `Remove…`. Codex has its own default card.
- **Per-repo table** with a subscription dropdown per repo: `desk-skills  Default (ben@studia.example) ▾`. Menu: `This computer's default ✓` · `Pin to ops@studia.example · work-2 · 7d 12%` · `ben@personal.example · work-3 · off` · `Add subscription…`. Picking runs `desk-env subscription set <slug> <default|email>`; result `✓ desk-skills now runs on ops@studia.example from its next pass (10:11).` · `Undo ⌘Z` (sets the previous value back).
- **Make default** (inline confirm): `Make work-2 the default Claude subscription?` · `desk-skills and studia-zendesk run on the default, so they move to ops@studia.example at their next pass. Pinned repos stay where they are. default (ben@studia.example) becomes unused.` · `Runs: desk-env logins default claude work-2` · `Keep the current default` / `Make work-2 the default`.
- **What a change reaches:** `New workers start on ops@studia.example from the next pass. Running and resumed workers stay on their current subscription.` (pass.mjs: the repo's subscription is read once a pass; a resumed session stays in the login folder it started in.)
- **Turn off:** runs `desk-env logins set claude <name> off`; caption `desk won't pick it for new work.` Turning off the default, or the last usable Claude subscription, is refused by desk (verbatim). Off against pinned repos: pending ticket (9.5).
- **Remove:** runs `desk-env logins remove claude <name>`; refused while a repo is pinned to it: `Couldn't remove work-2: studia-web and ai-agents are pinned to it. Pin them to another subscription first, then remove it.` · `Ran: desk-env logins remove claude work-2 · refused` · caption `Removing takes it out of desk's list only. Its folder and sign-in stay on this computer.`
- **Add subscription** (4 frames on the canvas): sign-in happens in Terminal (`Signing in happens in Terminal. Desk opens it for you.`), then the new one appears as unused.
- **Waiting repos and unknown email:** `desk-skills waits for ben@studia.example's 7-day reset · 12 ready · starts Tue 08:00`. A pin naming an email no subscription here is signed in to (`desk-env subscription` exit 4): `✕ No subscription on this computer is signed in to old@studia.example, so studia-reports can't start work. Pick another subscription for it, or add one signed in to that account.` · `Add subscription`. Footer: `desk doesn't move a waiting repo to another subscription. Pinning it elsewhere is your choice, from its menu.`

---

## 11b. Levers (new 15 Nov, DS-702)

**Purpose:** "Are desk's levers making tickets cheaper without making anything worse, and does any
need me?" Route `/levers`, sidebar between Usage & costs and Health, ⌘6 (`g then l`). A native view
over `~/.desk-autopilot/levers/view.json` (schema `v: 1`, Jim's levers design,
`.handoffs/2026-11-13-4-jim-lever-analytics.md`), built by `levers-view build` (**planned**, V1 of
that design). The app never reads `levers.jsonl` itself; `view.json` is derived and regenerable.

### 11b.1 Layout
- Header: `Levers` · `desk tests ways to make tickets cheaper, keeps the ones that work, and turns off the rest.` · `Built 10:06 · 2 min ago` (+ `· all 4 repos reporting`) · `Rebuild`.
- Sentence (hero): today `Not started yet. desk has recorded what a ticket costs with no levers on. Testing starts once the trial tickets (DS-631) are built. Nothing needs you.`; six weeks in *(illustrative)* `Working. … 3 kept, 2 still being tested, and 1 needs your decision.` · `Decide on codex ⏎`.
- Stat tiles · Trends (Weeks / Months / Last 30 days toggle, now against before levers) · `Is each lever working?` table (Lever · Status · Result so far · Progress to a decision · By repo) · `Every change desk made` (newest first; each automatic keep has `To undo  Turn <lever> off in <repo>` · `Runs: levers undo <repo> <lever>`, **planned**) · `How desk decides` (fixed explainer).
- Repos overview (3.1) gains a Levers line under the four counts that opens this screen.

### 11b.2 Honesty states (draw each)
| State | Treatment |
|---|---|
| Below the minimum sample | Row grey, `Too early: 18 of 30`, no colour and no better/worse word until 30 tickets on each side finish. |
| One late pass | No banner; the age next to the title is enough. |
| Built over 1 hour ago | Amber banner `Built 3 hours ago. The supervisor may have stopped, so these numbers may be behind.` · `Rebuild`; while running `Rebuilding Levers…` (busy). Rebuild runs `levers-view build` (planned). |
| Built over 26 hours ago | Red banner `Built 30 hours ago, so these numbers are out of date. Nothing has rebuilt Levers since Thu 13 Nov, 08:12.` · `Rebuild` (primary). Everything under it is greyed, so an old number can't pass for a current one. |
| A number desk doesn't have | `—`, never `0`, with why (`No ticket finished in the last 7 days.` / `post-merge.jsonl is missing in ai-agents.`). |
| A stale repo | That repo's column hatched; the others normal. |
| Build failed | The last good build stays, with `couldn't update · studia-web lever-evals.jsonl line 214` and `Open the last good build`. |

### 11b.3 Lever decision (Inbox kind `lever`)
- Inbox row and Detail as 4.3. Example: `codex was turned off twice in ai-agents and is paused until you decide`.
- Options: `1 Keep codex off in ai-agents (Recommended)` · `2 Try codex again in ai-agents` (`On for 1 in 4 new tickets.`) · `3 Turn codex off everywhere` · `4 not now`.
- **Everywhere** runs once per repo. Choosing it lists the repos it will run in, with an inline confirm: `Turn codex off in 3 repos? desk-skills · studia-web · ai-agents. This runs levers decide once in each.` · `Keep it to ai-agents` / `Turn off in 3 repos`. Results per repo with ✓/✕ (as group apply, 4.4 state 6).
- The `Runs:` line follows the selected option: `Runs: levers decide ai-agents codex off · Records an override in levers.jsonl and a line in decisions.jsonl.`
- `levers decide <repo> <lever> <choice>` (**planned**, new ticket under DS-631, blocking DS-702) appends an `override` event (`actor: "ben"`, with `decision_id`) to that repo's `levers.jsonl` and a line to `decisions.jsonl`.
- Recorded: `✓ Recorded: keep codex off in ai-agents, at 10:14. Levers shows codex as Off in ai-agents after its next build.` + verbatim stdout + `Undo` (runs `levers undo <repo> <lever>`, planned).

---

## 12. Glance (Electron tray and Dock badge) (updated 16 Nov)

Desk.app has the tray from its shell features (Ben, 16 Nov: Electron from the start). The Dock badge shows `25` through the shell's `badge`, beside notifications. The tray popover (320 x 360) opens from the menu-bar icon or the global hotkey ⌃⌥D:
- `◆ 25 need you · oldest 12d 14h` · `● Healthy`
- `● 7 workers · cap 30 · 27.5 GiB free`
- `Claude 5h 32% · 7d 88% Tue 08:00`
- top 3 items (production broken first, red): `SV-3844 External-shape change 8d ›` · `SV-3880 Worktree in use 18h ›` · `9 × Review gate needs pullbot 1d ›`
- buttons `Open Desk` · `Answer next`
- States: 0 → `Nothing needs you. Next pass 10:11.` · server down → `Desk's server isn't running.` `Start it` · offline → `◌ As of 10:02`.

---

## 13. Global keyboard map (updated 15 Nov)

| Key | Action |
|---|---|
| ⌘K | Command palette |
| ⌘1-⌘8 | Inbox · Repos · Workers · Conversations · Usage & costs · Levers · Health · Decisions (updated 15 Nov) |
| ⌘, | Settings |
| ⌘\ | Toggle sidebar |
| ⌘[ / ⌘] | Back / forward |
| ⌘F | Find in current view |
| ⌘Z | Undo last not now (10 s); drop has no undo |
| ? | Shortcut sheet (Sheet listing all keys for the current screen) |
| g then i/r/w/c/u/l/h/d | Go-to sequences (same targets as ⌘1-8) |
| Shift+P / Shift+J | Open current PR on GitHub / ticket in Jira |
| o | Open conversation for the focused item |

All shortcuts are listed in tooltips (`Record answer ⏎`) and in `?`. Nothing is shortcut-only.

---

## 14. Assumptions to confirm with the user
1. Inbox as the landing screen (not Repos). Change to Repos if the user mostly opens the app to watch, not answer.
2. Needs you sits at the top of a queue list (desk-q puts it last). Chosen because the app is scanned for action.
3. No Stop button until G9 exists.
4. Repo config stays read-only; all changes through `/desk-setup`.
5. The 1 s "seen" guard on `⏎` won't annoy. Lower to 0.5 s if testing shows friction with no wrong answers.
6. `{jira-site}` value per repo (draw as `jira.example.net`).
7. Display name "Desk" and the stage names in 7.2. **Stage names resolved 15 Nov:** desk's real stages from `skills/desk-ticket/SKILL.md` (0 Triage … 9 Cleanup, with 4b; PR at 7/9; merge is the merge driver, not a stage). Display name "Desk" still to confirm.

---

## 15. What to test
1. **Answer accuracy:** 10 real items (incl. the 9-PR group and SV-3844). Count answers later overridden or refused. Watch whether people read the verbatim question before `⏎`.
2. **Group trap:** seed one near-duplicate with a different action set inside the 9-PR group. Does the member list catch it?
3. **5-second test** on the Inbox and the title bar: "How many things need you, and is anything broken?"
4. **Link rule:** ask "open the failing check for DS-615 on GitHub". Do people find ⌘-click / the `↗` icon?
5. **Reorder comprehension:** move DS-615 to the top. Does the "still waits for DS-606" line explain why its ETA barely moved?
6. **Conversation cost:** offer fresh vs continue-worker. Do people understand the token estimate and pick fresh by default?
7. **Server down:** kill `desk-ui`. Can the user recover from the card alone?

---

## 16. Handoff checklist for the UI designer
- Frames: every screen at 1440 x 900; Inbox, Queue (list + board), Ticket (Overview + PR & CI), Session panel also at 1024 x 700.
- State frames: Inbox detail states 1-14 (4.4), list states (4.7), queue states (5.7), worker states (7.3), session states (8.5), server down (2.8), first run (2.9), typed confirmation (9.4).
- Required frames added 15 Nov: gate-block approval default / submitting / recorded / refused (4.4 state 13) and batch-grant typed confirm (state 14); drop two-step confirm (state 12); window not signed in (2.10); keyboard focus states with the `--focus-ring` token at ≥ 3:1 (1.7); answer textarea with the secrets helper (4.3); start sheet at limit and seeded quote (8.1, 8.2); MVP refusal card and the v1.5 relay card, labelled (8.2); chat read-only after recording (8.2); Levers screen and honesty states (11b); Subscriptions (9.5, 11.4); Desk install states, Health `desk` row, Reload / server restarting / app build failed banners, release toasts (2.5, 2.7, 9.6, 9.7); Restart server confirm (9.6).
- Light and dark themes. Contrast WCAG AA on all state colours, including amber on dark.
- Focus rings visible on every interactive element; hit areas ≥ 44 px.
- Motion: row leave 150 ms, panels 200 ms open / 150 ms close, no motion under `prefers-reduced-motion` except opacity.
- Use only real strings from this spec; truncate in lists, never in question blocks.

---

## 17. Not yet drawn (backlog, new 15 Nov)
Specified or implied, with no frame on the canvas yet. Draw before the ticket that needs it.
- Queue tabs Timeline, By day and Epics (5.6).
- Ticket Live and History tabs (6.4, 6.8).
- Inbox Put off section expanded, with `Bring back` (4.2).
- Decisions override: in flight, recorded, refused (10).
- Conversations list, empty (8.4).
- Multi-choice park, and the No-recommendation detail (4.3).
- 10+ repos (3.4, sidebar collapse).
- Long backlog: 59 waiting in a queue (5.7), Inbox at 100+ items (4.7).
- Narrow window, below 1024 wide (1.1).
- Tray (12): production broken, at limit, health failing.
- Onboarding: repos found, supervisor not loaded, notification and other permissions (2.9).
- Settings: repo config unreadable, rows with TODO values (9.3, 9.8).
- Health: all checks OK (9.7).
- Release: "installed commit not on origin/main" and "check could not be read" (9.6).
