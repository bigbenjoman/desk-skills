# Desk desktop app: target architecture (Jim)

Date: 2026-11-15. Inputs: `desktop-feasibility.md`, `orca.md` Part B, `desk-map.md` section 7 and `use-cases.md`. I also checked these on this machine: the installed `~/.claude/desk/bin` (`desk-q.mjs`, `desk-env.mjs`, `borrow.mjs`, `answer.mjs`, `supervisor.mjs`), `install.sh` and the local tools.

**Local facts that shape this design:**
- Node is 24.22.1 (mise). npm is present.
- Google Chrome and Ghostty are installed. **tmux is not installed.**
- Nothing listens on 4823.
- The supervisor sends notifications through `osascript display notification`. It keeps a `notified` register in `supervisor.json` and checks for duplicates across repos with `sentElsewhere()` (`supervisor.mjs:266-299, 498-502`).
- Concurrency is counted by `borrow.mjs` `machineCap()` / `machineBudget()`. `desk-env.mjs` `spawnGate()` is a config row.

Everything here runs on one machine: no cloud, no dashboard-only resources, and nothing to deploy.

---

## 0. The one-paragraph answer

The product is a **local server, `desk-ui`**, kept alive by launchd and bound to `127.0.0.1:4823`. It imports desk-q's read model, writes only by running the existing desk commands, and brokers Claude sessions. The **window around it can be replaced.**

- **Window:** Desk.app, a thin Electron shell of about 300 lines, built locally by `install.sh`, that loads the server's URL. It gives the menu-bar popover, a global hotkey, a real `desk://` scheme, the Dock badge and clickable native notifications from the first release (Ben, 2026-11-16: Electron from the start, not a PWA first).
- **Sessions:** structured chat over `claude -p` stream-json for park, ticket and fork conversations, and a hand-off to Ghostty or Terminal for anything that needs the full TUI. An embedded terminal (node-pty + xterm.js, run by a separate pty daemon) comes later.
- **GitHub and Jira:** deep links always work. Embedding their pages is blocked (`x-frame-options: deny`). The app shows PR and ticket details itself, fetched server-side with `gh` and `desk-jira`.
- **State:** the files stay the only record. The server stores no durable state, so queue data RPO and RTO are unchanged from today.

You described this as "an Electron app". I first recommended a PWA, arguing it cost no binary and no signing; Ada's review (`challenge.md` D-1) showed that a locally built Electron app needs no notarisation and no updater, so the real difference is about a day, and both PWA features were unverified spikes. **On 2026-11-16 Ben chose Electron from the start (D1, §2 and §12).** The server stays shell-agnostic: the shell only renders.

---

## 1. Component diagram

```
                         ┌──────────────────── Window shell: Desk.app (Electron, thin) ─────────────┐
                         │  - BrowserWindow.loadURL(http://127.0.0.1:4823), hidden-inset title bar   │
                         │  - Tray popover, globalShortcut (⌃⌥D), Dock badge                         │
                         │  - desk:// + single-instance lock, native Notification, openExternal      │
                         │  - main process signs in from ui-token; preload sends the per-load token  │
                         │  React 19 + shadcn/ui + Tailwind v4 SPA (static build, served by desk-ui) │
                         └───────┬───────────────────────────▲──────────────────────▲───────────────┘
                     fetch /api  │ cookie + Origin + JSON    │ SSE /api/events      │ WS /api/sessions/:id
                                 ▼                           │ (state deltas)       │ (chat | pty)
┌──────────────────────────────── desk-ui server  (node 24, zero-dep, launchd com.desk-skills.ui) ─────────────────────┐
│ http guard: Host allowlist · Origin check · cookie token · CSP · JSON only · loopback bind                           │
│                                                                                                                      │
│  ReadModel ───── imports desk-q.mjs view-model exports (loadRepos, repoPlace, holdOf, stuckOf, forecastOf, ...)      │
│     ▲            + needs-you.mjs list --json --no-settle  (inbox)                                                    │
│     │ invalidate                                                                                                     │
│  Watcher ─────── fs.watch(~/.desk-autopilot, ~/.claude/desk/repos, recursive) → 250 ms debounce → rev++ → SSE diff   │
│                  + 5 s clock tick (heartbeat liveness LIVE_MS changes with no file write)                            │
│  LogTailer ───── per-subscribed-ticket tail of <state>/logs/<KEY>.log → compact WorkerEvent stream (refcounted)      │
│  Scheduler ───── single owner of usage probes (probesDue/probe) and cost refresh (startRefresh)                      │
│  Commands ────── execFile allowlist: queue.mjs · answer.mjs · needs-you.mjs record · desk-env logins · supervisor.mjs │
│                  exit 0/10/11 → HTTP; stdout returned verbatim; every call appended to ui/audit.jsonl                │
│  Links ───────── gh pr view/diff/api, desk-jira get (per-repo creds) → 30-60 s cache keyed by head SHA / updated     │
│  SessionBroker ─ spawns claude (stream-json) with the repo's login (CLAUDE_CONFIG_DIR), not in machineBudget          │
│                  hand-off: osascript → Ghostty/Terminal `claude --resume <id>`                                       │
└──────────┬───────────────────────────┬────────────────────────────┬────────────────────────────┬────────────────────┘
           │ read                       │ execFile                   │ spawn                      │ unix socket 0600 (later)
           ▼                            ▼                            ▼                            ▼
  ~/.desk-autopilot/<slug>/*      desk/bin CLIs (own locks)    claude -p --input-format     desk-ptyd (later): node-pty
  ~/.claude/desk/repos/*/queue    → same files                  stream-json ...              daemon, survives server
  costs/, usage/, digest/                                       (one child per chat)         restart; xterm over WS
           ▲                            ▲
           │ same files, unchanged      │
  supervisor (launchd) · pass.mjs · workers · merge-driver · desk-q TUI      ← existing system, unaware of the app
```

**Platform placement:** every component runs on the user's Mac. The only network traffic is what the CLIs already make: `gh` to GitHub, `desk-jira` to Atlassian, `claude` to Anthropic. The app adds no new cloud trust and no new credentials.

---

## 2. Decisions

Each decision gives the choice, the trade-off, the failure mode it guards against, and what it costs to reverse.

| # | Decision | Trade-off | Failure mode it guards against | Cost to reverse |
|---|---|---|---|---|
| A1 | **Server is the product; the shell is a thin client.** All logic lives in `desk-ui.mjs`. The shell only renders. | One extra process and a loopback hop (under 1 ms). | Logic locked into an Electron main process, which is the Orca shape: about 900 IPC channels and a forced rewrite to change shells. | Low. Nothing depends on the shell. |
| A2 | **Shell: Desk.app, a thin Electron shell, from the start** (Ben, 2026-11-16), loading the fixed origin `http://127.0.0.1:4823`. | About 120 MB, plus an Electron major roughly every 8 weeks (keep the shell small so a bump is a version change). | A first release with no tray glance (S1), no inbound deep links (E4) and no clickable notifications, resting on two unverified PWA spikes (`challenge.md` D-1). | Low. Nothing in the server depends on the shell. Moving the port is the one expensive change (see A4). |
| A3 | **The shell is built locally by `install.sh`** whenever its source changed. A locally built `.app` carries no quarantine flag, so personal use needs no notarisation; a fixed ad-hoc signing identity keeps macOS permissions across rebuilds. | An install may rebuild the app (about a minute). | An app that drifts from the installed server, or a rebuild that makes macOS ask for permissions again. | Low. Delete `Desk.app`; the server keeps running and desk is unchanged. |
| A4 | **Fixed port 4823**, checked against `repoPortClaims()` / `portClashes()` at install and on every start. On a clash it refuses to start; it never moves. | A port can collide with a future repo's dev range. | The window's origin changing silently: the origin is what the shell allows, what the server's Origin check expects and what the service worker caches under. | Medium. The shell's allowed origin and the server's Origin rule change together. |
| A5 | **The server keeps no durable state.** Files are the database and the server holds only caches. | Each read recomputes, but that is cheap: `queue.json` is about 266 KB at most. | The app and the TUI disagreeing, and losing data when the server crashes. | None. |
| A6 | **Reads import desk-q.mjs functions.** No copied logic. | Needs one refactor: view builders return objects, and TUI output stays byte-identical. | App/TUI drift, which desk-skills has history of. | Low. |
| A7 | **Writes go only through the existing CLIs, from an execFile allowlist.** | Each write takes 50-300 ms of process start. | A second writer racing the pass and orchestrator locks, and corrupting `queue.json`. | None. |
| A8 | **SSE for state, WebSocket only for sessions.** | Two transports. | WebSocket reconnect bugs on one-way data; SSE gives `Last-Event-ID` resume for free. | Low. |
| A9 | **Sessions: structured chat by default; terminal for TUI-only work** (table in section 6). | Chat loses slash commands and TUI niceties. | Pulling a native module (node-pty) into a zero-dependency install before the shell is settled, and unbounded token spend through casual "resume". | Low. |
| A10 | **One OS-notification sender at a time.** Desk.app while it runs, the supervisor whenever it does not; they share the `notified` register (§8). | A heartbeat handshake between the shell and the supervisor. | Duplicate banners, or an alert lost because the window was closed. | Low. |
| A11 | **Render GitHub and Jira natively; never embed them.** | Building and maintaining PR and Jira panels. | XFO/CSP blocking iframes outright; a second GitHub or Jira login and cookie store inside the app. | Low. |

**Decisions of 2026-11-16 (Ben):**
- **D1, the shell: Electron from the start.** No localhost PWA or Chrome app window first; the `setAppBadge` and `web+desk://` spikes are dropped.
- **No browser sign-in page.** Desk.app's main process reads `~/.config/desk/ui-token` and makes the sign-in exchange itself, and signs in again once when the server refuses its session. A window that still cannot sign in says to re-run `install.sh`, which writes the token. There is no `desk ui` command.
- **App-local display preferences are not desk writes.** Theme, density, the Dock badge, open at login and the notification choices are saved by the app in its own file outside desk's state, and are the one exception to A7. Subscriptions and logins still go through `desk-env logins` and `desk-env subscription`.
- **A control and its shortcut are drawn only once its route exists.** Each screen's ticket adds its own entry points (sidebar item, palette command, buttons that open it).
- **`queue.mjs stop <KEY>` refuses with exit 11** when the ticket has no running worker, as `queue.mjs drop` refuses.
- **The Decisions screen ships with Health**, read only; its override waits for its frames.
- **The global hotkey is ⌃⌥D**: no macOS symbolic hotkey and no app on this Mac binds it. VoiceOver uses ⌃⌥ as its modifier (VO-D moves to the Dock) only while VoiceOver runs.
- **The specs live in `docs/design/DS-691/`** beside the canvas copy (`project/index.html`).

---

## 3. Process model

| Process | Owner | Lifetime | Holds |
|---|---|---|---|
| `desk-ui` server (`~/.claude/desk/bin/desk-ui.mjs`) | launchd `com.desk-skills.ui` (`RunAtLoad`, `KeepAlive`, `ThrottleInterval 5`) | always on, about 40-60 MB RSS | caches only: snapshot rev, gh/jira cache, live session table |
| Chat session children | the server's `SessionBroker` | one per open conversation; idle-killed after 30 min with no client and no turn in flight | nothing durable. The transcript is Claude Code's own, under the login's `CLAUDE_CONFIG_DIR` |
| `desk-ptyd` (later) | launchd `com.desk-skills.ptyd`, or forked detached by the server | survives server restarts | PTYs, plus a 256 KB scrollback ring per terminal |
| Shell (Desk.app, Electron) | the user | while the app is open | UI state, and the app-local preferences file |
| Existing system (supervisor, pass, workers, merge-driver) | launchd, as today | unchanged | the files |

**Restart behaviour (session durability):**
- A chat child's stdin is a pipe from the server, so a server restart ends the child at its next read.
- This is safe, because the session id is known. On the user's next turn the broker re-spawns with `--resume <session_id>` and the conversation carries on.
- What is lost: a turn that was mid-stream when the server died. The UI shows it as "interrupted — resend".
- Resuming within the cache TTL (5 min default, 1 h when the cache is warm) costs about the same as a persistent process, because the API re-reads the transcript every turn either way.
- **RPO is 0 completed turns; RTO is about 1 s** (launchd restart) plus about 2 s for the CLI to start on the next turn.

PTYs need the separate daemon (Orca's pattern). A PTY cannot be resumed the way a stream-json session can: killing it loses the live TUI state. tmux would do the same job but is not installed, and I would rather not make it a dependency.

---

## 4. Local server API

Every response carries `{ at: ISO, rev: n }`. Errors are `{ error: { code, message, exit?, stdout?, stderr? } }`. Every `/api/*` route needs the `desk_ui` cookie and the per-load token header (section 9).

### 4.1 Auth and meta

| Method / path | Body → response |
|---|---|
| (no browser sign-in page) | Desk.app's main process reads the token file and posts it to the exchange below (Ben, 2026-11-16). |
| `POST /api/auth/exchange` | `{ token }` → `204` + `Set-Cookie: desk_ui=<random session>; HttpOnly; SameSite=Strict; Path=/`, held only in Desk.app's own session store, plus `{ loadToken }`, which the preload sends as a header on every `/api` call (`challenge.md` D-2) |
| `GET /api/meta` | `{ version, deskCommit, nodeVersion, shell: "electron", features: { ptyd:boolean, agentSdk:boolean }, port }` |

### 4.2 Reads

```ts
type Snapshot = {
  at: string; rev: number;
  needsYou: { count: number; oldestAt: string | null; productionBroken: number };
  repos: RepoSummary[];
  machine: { running: number; cap: number; availGiB: number; memoryCeilingGiB: number };
  usage: UsageWindow[];          // per login
  health: { failing: string[]; at: string };
};
type RepoSummary = {
  slug: string; supervised: boolean; passesStopped: boolean; liveSession: string | null;
  running: number; concurrency: number; ready: number; readyNoSlot: number;
  parked: number; held: number; waiting: number;
  lastPassAt: string | null; nextShipEta: string | null; jiraSite: string | null; ghRepo: string;
};
type TicketRow = {
  key: string; state: string; lane: "A"|"B"|"C"|"D"|null; stage: string | null;  // "3/9"
  hold: { kind: string; text: string } | null; stuck: { why: string; sinceMs: number } | null;
  pr: { number: number; url: string; draft: boolean; checks: "green"|"red"|"pending"|null } | null;
  collidesWith: string[]; heldBy: string[]; model: string | null; login: string | null;
  eta: { starts: string|null; ships: string|null; p80: string|null } | null;
  links: { jira: string | null; pr: string | null; failingJob: string | null };
};
type InboxItem = {
  id: string;                     // stable: `${repo}:${ticket}:${kind}:${parkRound}`
  cause: string | null;           // G3 grouping key
  kind: "parked"|"session"|"spine"|"plan"|"triage"|"held"|"stopped"|"pr"|"worktree"
      | "usage"|"base-push"|"config"|"templates"|"unset"|"reviewer"|"step";
  repo: string; ticket: string | null; waitedMs: number;
  question: string;               // verbatim, never summarised
  gateBlock: string | null;       // verbatim JIRA COMMENT / transition block when present
  actions: { action: string; label: string; recommended: boolean; why: string | null;
             needsText: boolean; confirm: "none"|"typed" }[];
  links: TicketRow["links"];
  liveSession: { name: string; message: string } | null;  // MESSAGE <name>: <text> case (G4)
};
type WorkerEvent =
  | { t: string; kind: "stage"; stage: string; label: string }
  | { t: string; kind: "tool"; name: string; summary: string; elapsedS?: number }
  | { t: string; kind: "text"; text: string }              // assistant text, first 2 KB
  | { t: string; kind: "rate"; window: string; utilization: number; resetsAt: string }
  | { t: string; kind: "result"; costUsd: number|null; turns: number; tokens: Record<string,number> }
  | { t: string; kind: "rotated"; round: number };
```

| Method / path | Response | Source |
|---|---|---|
| `GET /api/snapshot` | `Snapshot` | desk-q `loadRepos`, `machineBudget`, `readUsage`, `health.json` |
| `GET /api/repos/:slug` | `{ summary: RepoSummary, groups: { running, ready, held, parked, waiting: TicketRow[] }, batches: {name, supervised, concurrency}[], pass: {at, errors[]} }` | desk-q view models |
| `GET /api/repos/:slug/tickets/:key` | `{ row: TicketRow, triage, park, handoff, briefingMd, runs[], decisions[], sessionId, worktree, port }` | `<state>/triage`, `parks`, `handoffs`, `briefings`, `workers/<T>.runs.jsonl` |
| `GET /api/repos/:slug/tickets/:key/log?from=<byte>&limit=200` | `{ events: WorkerEvent[], next: number, rounds: number[] }` | parsed log (backfill) |
| `GET /api/repos/:slug/timeline?view=days\|epics` | `{ bars: {key, start, end, p80}[], minHistoryMet: boolean }` | `forecastOf`, `eta*.jsonl` |
| `GET /api/inbox?settle=0` | `{ items: InboxItem[], asOf, settledAt }` | `needs-you.mjs list --json --no-settle` (new, gap G2). `settle=1` runs the settling variant, at most once a minute |
| `GET /api/decisions?since=<ISO>` | `{ items: {id, at, repo, ticket, question, options, chose, category, pr, source}[] }` | `decisions.jsonl` |
| `GET /api/digest/:date/:slot` | `{ md, items[] }` | `digest/*.md` |
| `GET /api/usage` | `{ logins: {name, windows: UsageWindow[], standby}[], pace: {projectedAt, hitsLimitAt} }` | usage probes (server-owned loop) |
| `GET /api/costs?period=` | `{ infra: {github, vercel, aws}, tokens: {byRepo, byDay, byCaller} \| null }` | `costs/cache.json`, `tokens.jsonl` (G11, v2) |
| `GET /api/health` | `health.json` + supervisor and merge-driver liveness | files |
| `GET /api/prs/:repo/:n` | `{ title, state, draft, mergeable, reviewDecision, checks[{name, state, url, runId, jobId}], reviews[], threads[], files[], gate: evaluateGate(), asOf }` | `gh pr view --json`, `gh api graphql` (threads), cached by head SHA, 60 s |
| `GET /api/prs/:repo/:n/diff` | `text/x-diff`, capped at 2 MB, "open on GitHub" beyond that | `gh pr diff` |
| `GET /api/jira/:key` | `{ summary, status, assignee, priority, descriptionHtml (sanitised), comments[], url, asOf }` | `desk-jira get --json`, cached on `updated`, 30 s |
| `GET /api/config/:slug` | read-only `{ rows[{section, key, value, todo}] }` | `desk-env ids --json` / `get` (never a raw read of config.md) |

### 4.3 Writes

Every write maps one-to-one to an existing command. The response is always `{ exit: 0|10|11, stdout, stderr }`. HTTP status: `200` for 0, `202` for 10 (nothing yet), `409` for 11 (show the person; the UI keeps what the user typed), `500` for anything else.

| Method / path | Body | Command (execFile, fixed argv) |
|---|---|---|
| `POST /api/inbox/:id/record` | `{ action, text? }` | `needs-you.mjs record <ticket> <action> [text]` |
| `POST /api/inbox/group/:cause/record` | `{ action, text?, exclude: string[] }` | sequential `record` per member; returns per-item results |
| `POST /api/repos/:slug/tickets/:key/answer` | `{ text, approve?: boolean }` | `answer.mjs <KEY> [--approve] "<text>"` |
| `POST /api/repos/:slug/move` | `{ key, to: "top"\|"bottom"\|{before:key}\|{after:key} }` | `queue.mjs move …` (as desk-q `up/down`) |
| `POST /api/repos/:slug/workers` | `{ n }` | same path as `desk-q <repo> workers <n>` |
| `POST /api/repos/:slug/batch/approve` | `{ grant: "merge"\|"undraft"\|"base-push"\|"images", confirm: "<typed>" }` | `queue.mjs set-batch approved.<grant>` |
| `POST /api/repos/:slug/supervisor` | `{ on: boolean, confirm: "<typed repo slug>" }` | `supervisor.mjs install\|uninstall` |
| `POST /api/decisions/:id/override` | `{ chose, text? }` | the digest override path (`answer.mjs` / `needs-you record override`) |
| `POST /api/logins` | `{ op: "set"\|"remove", name, … }` | `desk-env logins set/remove` |

Things the app deliberately does not do:
- **No stop-worker endpoint** until `queue.mjs stop <KEY>` exists (gap G9).
- **No config writes.** Those go through a `/desk-setup` conversation (G13).
- **No raw file writes** of any kind.

### 4.4 Sessions

| Method / path | Body → response |
|---|---|
| `POST /api/sessions` | `{ purpose: "park"\|"ticket"\|"fork"\|"skill"\|"blank", repo, ticket?, skill?: "desk-needs-you"\|"desk-admit"\|..., mode: "chat"\|"handoff"\|"terminal", model?, effort?, login? }` → `{ id, ws: "/api/sessions/<id>", sessionId, login, cwd, estimate: { freshTokens, resumeTokens \| null, cacheWarm: boolean } }`. Refused with `429 { reason }` when the repo's subscription is at its usage limit and no `login` override was given (the Start sheet then offers another subscription for this conversation only). Conversations are not counted in `machineBudget`, which counts queue workers only (updated 15 Nov) |
| `GET /api/sessions` | `{ items: {id, purpose, repo, ticket, mode, state: "starting"\|"running"\|"waiting"\|"exited"\|"interrupted", tokens, startedAt}[] }` |
| `POST /api/sessions/:id/handoff` | `{ target: "ghostty"\|"terminal"\|"remote-control" }` → `{ ok, command }` (the command is shown so the user can paste it) |
| `DELETE /api/sessions/:id` | interrupt (sends a stream-json interrupt control message), then SIGTERM after 5 s |

WebSocket `/api/sessions/:id` frames (JSON, one per message):

```ts
// client → server
{ type: "user", text: string }
{ type: "interrupt" }
{ type: "permission", requestId: string, decision: "allow"|"deny", remember?: false }   // v1.5 (section 6)
{ type: "resize", cols, rows }                                                           // terminal mode only
{ type: "stdin", data: string }                                                          // terminal mode only (base64)
// server → client
{ type: "init", sessionId, model, tools: string[], cwd }
{ type: "delta", messageId, text }                  // --include-partial-messages
{ type: "assistant", messageId, content: Block[] }  // text | tool_use {name, input summary}
{ type: "tool_result", toolUseId, summary, isError }// truncated to 4 KB, full on demand
{ type: "permission_request", requestId, tool, input }
{ type: "result", costUsd, turns, usage }
{ type: "exited", code, outcome: string | null }    // e.g. the record line the session produced
{ type: "stdout", data }                            // terminal mode only (base64)
```

### 4.5 SSE `/api/events`

The stream supports `Last-Event-ID` (= `rev`). On connect, or when the server's ring of the last 500 events cannot cover the requested gap, the server sends a full `snapshot` event.

| `event:` | `data:` |
|---|---|
| `snapshot` | `Snapshot` |
| `repo` | `{ slug, summary: RepoSummary }` |
| `tickets` | `{ slug, upsert: TicketRow[], remove: string[] }` |
| `inbox` | `{ added: InboxItem[], removed: string[], changed: InboxItem[], count, oldestAt }` |
| `worker` | `{ slug, key, event: WorkerEvent }`, only for tickets the client subscribed to via `GET /api/events?watch=DS-676,DS-680` (or a re-subscribe call) |
| `usage` | `{ login, windows: UsageWindow[] }` |
| `health` | `{ failing: string[], results }` |
| `notify` | `{ key, title, body, route: "/inbox/<id>" }`, in-app toast; and OS-level only when the shell is the notifier (section 8) |
| `server` | `{ version, restartRequired: boolean }`, sent after `install.sh` replaces files |
| `ping` | `{ at }` every 15 s (keeps proxies and sleep or wake detection honest) |

**Diffing.** The watcher re-runs the read model for the affected slug only, derived from the changed path. It diffs rows by key against the previous model and emits `tickets` and `repo` events. A full rebuild across 4 repos measured well under 100 ms in the feasibility read, so the 250 ms debounce is the binding limit, not CPU.

---

## 5. Queue state: read and mutate

- **Read path.** The server imports `~/.claude/desk/bin/desk-q.mjs`, which is safe because of the `isMain` guard at line 3845, plus `needs-you.mjs` once it exports a pure `listItems({settle:false})`.
- **Prerequisite refactor (Phase 0):** split desk-q's string builders into `model*()` functions that return plain objects (`modelHome`, `modelRepo`, `modelTicket`, `modelCosts`, `modelUsage`), and have `render*()` take those models. TUI output stays byte-identical under the existing tests. The server calls `model*()` and the TUI calls `render(model*())`. This also closes G1 without a separate `--json` mode, though `desk-q --json` falls out for free and is useful for scripts.
- **Probes move to the server.** The server becomes the single owner of `probesDue`/`probe` and `startRefresh`, and desk-q in TTY mode reads only the cache when it sees a fresh `ui/scheduler.json` heartbeat. Today every open TUI can fire its own probe. This is a small, real saving of tokens and requests.
- **Write path.** Writes go through the allowlisted `execFile` (no shell) with argv built by the server. The commands take their own locks. The server serialises writes per repo, so the UI gets results in order. **It never touches `queue.json` directly.**
- **Optimistic UI.** Only for move (reorder): the row moves at once and snaps back if the exit code is non-zero, or if the next snapshot disagrees. Everything else waits for the exit code. Answers are high-stakes and should not look done before they are.

---

## 6. Interactive Claude sessions

All spawns run in the server with the batch's login (`claudeChoice` → `CLAUDE_CONFIG_DIR`), so billing and usage pacing land on the right subscription. **None is counted in `machineBudget`**, which counts queue workers only (updated 15 Nov, Ben). The app is kept from bypassing the cap by its own limits instead: the usage guard, at most 4 concurrent UI sessions and at most 10 creations per 10 min (§9).

**Fixed command template** (the server builds it; the client never supplies argv):

```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages \
  --session-id <uuid> | --resume <id> [--fork-session] \
  --permission-mode default --permission-prompt-tool mcp__desk_ui__approve \
  --append-system-prompt <seed: briefing + park verbatim + PR/Jira refs>  [--model] [--effort]
cwd = the ticket's worktree when no worker holds it, else a read-only scratch clone
```

`--dangerously-skip-permissions` is never passed. The repo's §3 allow-list applies: a UI session gets no more than its user.

**Which mode for which use case:**

| Use case | Mode | Why |
|---|---|---|
| G2c: answer a hold / "explain this park" (seeded with the park, briefing and PR) | **Chat** (fresh session) | Short, structured and answer-shaped. It renders tool calls and diffs as cards, and when the session writes a record line the item leaves the inbox. |
| G3c: "why did the worker do X" on a finished or parked worker | **Chat, fork** (`--resume <id> --fork-session`) behind an explicit cost button | A fork leaves the worker's own session untouched. A resume of a *running* worker is refused outright. |
| G1c: a lane C/D `session` item, i.e. run `/desk-ticket <KEY>` interactively | **Hand-off** (MVP), **embedded terminal** (later) | Long and TUI-native (slash commands, AskUserQuestion, plan mode). Rebuilding that TUI in chat is wasted work. |
| G4c: model-driven skills (`/desk-admit`, `/desk-groom`, `/desk-clearance`, `/desk-setup`, `/desk-update`, `/desk-reboot`) | **Hand-off / terminal** | They rely on AskUserQuestion and multi-step interaction that the TUI handles. `/desk-setup` especially should stay in a full session (G13). |
| Approve a parked Jira or GitHub write | **Neither: a native button** calling `answer.mjs --approve` | A deterministic write needs no model and no tokens. |
| Continue on phone | **Hand-off `--remote-control <name>`** | Free, and already supported by the CLI. |

**Permission prompts in chat:**
- **MVP:** sessions run with the batch's §3 allow-list as settings. Anything outside it is denied, and the chat shows "needs a permission the app doesn't grant — continue in terminal" with a hand-off button.
- **v1.5:** add `--permission-prompt-tool` pointing at a tiny stdio MCP server, `desk-ui-approve.mjs`, that relays each request to the WebSocket as a `permission_request` and blocks until the user answers.
- The alternative, `@anthropic-ai/claude-agent-sdk` with `canUseTool` (what Orca uses, pointing `pathToClaudeCodeExecutable` at the user's CLI), is cleaner but adds the first npm runtime dependency to the server. Adopt it at the Electron step if the MCP relay proves clunky.

**Token discipline** (this is where the app can save or waste the most):
- The default is a **fresh session seeded with about 2-6 KB of briefing**, not a resume.
- The resume or fork button shows an estimate. It is computed from `<state>/workers/<T>.runs.jsonl` plus the log's last `result.usage`: "about N k tokens; the cache is cold (last turn 3 h ago)". The cache is warm only if the last turn was within the TTL (1 h for workers, measured 2026-11-14).
- **Effort and model:** chat sessions default to the worker's model at `effort=medium`. The user can raise it.
- **Idle kill:** after 30 min with no client and no turn, the broker kills the child. The transcript stays and resume is free to *start*; it is only paid per turn.
- **Usage guard:** when the 7-day window passes 85% (it is 88% today), the create dialog warns, and above the usage-hold threshold it refuses, the same as workers.

**MESSAGE to a live session (gap G4).** The app cannot use SendMessage. In the MVP it shows the text with a copy button and the session name. Later it writes to the briefing mailbox the live session already watches.

---

## 7. Live worker streaming

- **Subscription.** The client opens a ticket's Live tab, which adds the key to its SSE `watch` set, which takes a reference on that ticket's `LogTailer`. When the reference count reaches 0, the tailer closes. A worker nobody is watching costs nothing.
- **Tailing.** On open, the tailer reads the last 256 KB of `<state>/logs/<KEY>.log`, scanning back to a newline boundary to backfill, then follows from the end offset using `fs.watch` on the file. On rotation (a `.log.roundN.gz` appearing, or the file shrinking) it emits `rotated` and resets the offset to 0.
- **Parsing** stream-json into `WorkerEvent`:
  - `system/init`: model and session.
  - `desk_spawn` / `desk_preflight` markers, and stage lines: `stage`.
  - `assistant` `tool_use`: `tool`, with the input summarised to about 120 characters (`Bash: npm test …`, `Edit: src/x.ts`).
  - `tool_progress`: refreshes `elapsedS`.
  - `rate_limit_event`: `rate`.
  - `result`: `result`.
  - Full `tool_result` bodies are **never forwarded**; the UI fetches them on demand by line offset.
- **Stuck check.** The client shows `stuckOf()` from the read model (idle passes, log growth, last `tool_progress`) rather than computing its own. A heartbeat that keeps a hung `codex exec` looking alive is surfaced as "heartbeat only, no progress for N min".
- **Backpressure.** At most 20 events per second per ticket to a client. Above that, consecutive `tool` events are merged into "+N tool calls".
- **Terminal view of a worker.** None. Workers are `claude -p` headless and there is no TUI to attach to. The Live tab is the view, and "Open in terminal" means a fork hand-off.

---

## 8. Notifications

- **Whenever Desk.app is not running, the supervisor is the OS notifier.** It runs when the app is closed, and it already de-duplicates through `notified` and `sentElsewhere()`.
- **The app adds:**
  - in-app toasts from the SSE `notify` event, emitted when `supervisor.json` `notified` gains a key;
  - a **Dock badge** through the preload's `badge` (Electron's `app.dock.setBadge`), updated on every `inbox` event while Desk.app runs;
  - a notification history page fed from the same register.
- **Desk.app as the notifier.** The shell writes a heartbeat to `~/.desk-autopilot/ui/notifier.json` every 30 s. When the heartbeat is fresh, the supervisor's `notify()` appends `{key, title, body, route}` to `ui/notify-outbox.jsonl` instead of calling `osascript`, and still marks the key as notified. If the heartbeat is stale (shell quit or crashed), the supervisor falls back to `osascript`.
  - Electron then shows a native `Notification` whose click focuses the window on `route`.
  - The register is the same, so there is never a duplicate. If the shell dies, the fallback means nothing is lost; at worst one notification arrives as a plain banner.
  - **Failure mode it guards against:** an important "production broken" alert that never arrives because the app's window was closed.
- **Rejected:** Web Push. It needs a push service (FCM) and a public endpoint, which is far more than a local tool should carry.

---

## 9. Security model

**Threat model:**
- **Primary attacker:** a hostile web page, in any browser on this Mac, that reaches `127.0.0.1:4823` and can make the server spawn `claude` or record answers. That would be a local RCE through a confused deputy.
- **Out of scope:** same-user local processes, which can already read `~/.desk-autopilot` and the CLIs' credentials.

| Control | Detail |
|---|---|
| Loopback bind | `127.0.0.1` only. The server refuses to start if asked to bind elsewhere. |
| DNS-rebinding guard | Reject unless `Host` is exactly `127.0.0.1:4823` or `localhost:4823`. |
| CSRF / cross-origin | Non-GET requests and WebSocket upgrades require `Origin` equal to the app origin and `Content-Type: application/json`. No CORS headers, ever. `SameSite=Strict` cookie. |
| Auth token | 32 random bytes in `~/.config/desk/ui-token` (chmod 600), written by `install.sh`. Desk.app's main process reads it and posts it to `/api/auth/exchange`; it never appears in a URL, a log or a window. It is exchanged for an `HttpOnly` session cookie that lasts 30 days, held only in Desk.app's own session store, plus a per-load token the preload sends as a header (D-2). On a refusal the main process signs in again once; if that fails the window says to re-run `install.sh` (Ben, 2026-11-16). Rotating the token revokes every session. |
| No arbitrary execution | Commands come from a fixed allowlist with server-built argv, and every value is validated: ticket keys `^[A-Z][A-Z0-9]+-\d+$`, slugs taken from `loadRepos()`, actions from the item's own action list. Sessions take `purpose` + `ticket`, never a prompt template or flags. Free text goes only into the stream-json user message or as `answer.mjs`'s final argv element. |
| Session limits | Not counted in `machineBudget` (queue workers only, updated 15 Nov), usage-guarded, at most 4 concurrent UI sessions, at most 10 creations per 10 min. |
| Secrets server-side | Jira tokens and `gh` auth never reach the browser. No `VITE_*` variables carry anything secret. The SPA bundle is public-safe. |
| CSP | `default-src 'self'; connect-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; frame-ancestors 'none'`. Fonts are bundled. Jira description HTML is sanitised server-side, with an allowlist of tags. |
| Audit | Every write and every session creation is appended to `~/.desk-autopilot/ui/audit.jsonl` as `{at, route, argv-redacted, exit}`. |
| Human-gated changes stay gated | No config, grant or §3 writes from toggles. Supervisor off and batch grants require typed confirmation, server-checked. |
| Electron shell | `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no `webviewTag`. `setWindowOpenHandler` and `will-navigate` deny navigation; `shell.openExternal` only for `https://github.com/*` and `https://<jira-site>/*`. The preload exposes only `{ badge, notify, openExternal, onDeepLink, startServer }`. Copy Orca's hardening, **not** its plaintext credential fallback; the shell holds no credential but the token it reads at sign-in. |
| Review | Run a security review (the `security-review` skill plus a human read) of `desk-ui.mjs` before first launch, because it is a process that can start `claude`. |

---

## 10. PR and Jira linking

| Capability | Possible? | How |
|---|---|---|
| Outbound deep link to a PR, a failing check job or a Jira issue | **Yes** | `pr.url`; `https://github.com/<repo>/actions/runs/<runId>/job/<jobId>`; `https://<jira-site>/browse/<KEY>` (desk-q already builds this). Desk.app: `shell.openExternal`, with an allowlist, opens it in the Mac's default browser. |
| Embedding github.com or Jira in an iframe | **No** | `x-frame-options: deny` and `frame-ancestors 'none'`, checked live 2026-11-15. |
| Real GitHub or Jira page inside the app | **Electron only**, via `WebContentsView` (a top-level context, so XFO does not apply) | Needs `session.fromPartition('persist:github')` and its own login. **Not recommended**: a second cookie store and login to maintain, for little gain over native panels. |
| Native rendering | **Yes, recommended** | `GET /api/prs/...` and `/api/jira/...` (section 4.2): checks, review threads, files and diff for PRs; status, assignee, description and comments for Jira. Each panel has "Open on GitHub" or "Open in Jira". |
| Inbound deep link (`desk://ticket/DS-676` from Slack or Jira) | **`desk://<route>`** via `setAsDefaultProtocolClient` + single-instance forwarding | A link opens Desk.app whether it is running or not. |
| Writing to Jira from the app | Only by approving a parked gate block verbatim | `answer.mjs --approve`. The worker does the write through `desk-jira`. The app never calls the Jira write API. |

**Route table** (SPA, shared by deep links):
- `/inbox[/:id]`
- `/r/:slug[/queue|timeline|decisions|settings]`
- `/t/:key[/overview|live|pr|jira|cost|history]`
- `/workers`
- `/usage`
- `/health`
- `/conversations[/:id]`
- `/settings`

---

## 11. Packaging and install (`install.sh`)

**Layout:**
- `desk/bin/desk-ui.mjs`: the server (zero-dependency) plus `desk-ui-approve.mjs` (v1.5).
- `desk/ui/`: the SPA. It is the repo's first `package.json`, scoped to that folder: Vite, React 19, Tailwind v4, shadcn/ui, with a committed lockfile.
- `desk/shell/`: the Electron shell's `package.json`, `main.mjs` and `preload.mjs`.
- `desk/ptyd/` (later): node-pty with its own `node_modules`.

**What `install.sh` does:**
1. Copies the bin scripts, as it does today.
2. **Builds the SPA if its source hash changed:** `npm ci && npm run build` in `desk/ui`, writing `~/.claude/desk/ui/dist.new`, then an atomic `mv` swap. **If the build fails, the previous `dist` stays in service** and the installer warns but still succeeds. A broken build never takes down a working app.
3. Generates `~/.config/desk/ui-token` if missing (chmod 600).
4. Checks port 4823 with `portClashes()`. On a clash it stops with a message, and never picks another port silently.
5. Writes `~/Library/LaunchAgents/com.desk-skills.ui.plist` and runs `launchctl bootstrap gui/$UID`, then `kickstart -k` on update. The plist sets the absolute node path (mise) and `PATH` so `gh`, `claude` and `desk-jira` resolve under launchd.
6. Sends `server.restartRequired` so open windows reload.
7. **Builds Desk.app if the shell's source hash changed:** `npm ci && electron-builder --dir` in `desk/shell`, copied to `~/Applications`; if the build fails the previous `Desk.app` stays and the installer warns but still succeeds. On first run it opens Desk.app, which signs itself in. **Nothing prints the token.**
8. Uninstall: the existing `launchctl` unload loop (`install.sh:552-557`) gains the `com.desk-skills.ui` (and `.ptyd`) labels, and `~/Applications/Desk.app` is removed.

**Rollback:** unload `com.desk-skills.ui`, then remove `~/Applications/Desk.app`, `~/.claude/desk/ui/` and `~/.desk-autopilot/ui/`. No queue data is touched. **Fully reversible.**

**Desk.app:**
- Every `install.sh` run rebuilds it when its source changed (step 7); there is no separate flag.
- A locally built app carries no quarantine flag, so there is no notarisation for personal use. Distributing the app to other people would change that and need a Developer ID.
- No `electron-updater`: re-running `install.sh` *is* the updater.

---

## 12. Phased delivery

| Phase | Scope | Exit criterion | Reversible? |
|---|---|---|---|
| **0. Groundwork** (backend only) | desk-q `model*()`/`render*()` split (G1); `needs-you.mjs list --json --no-settle` and an exported `listItems` (G2); a `cause` key on items (G3); `forecast` accepting a hypothetical order and concurrency (G7, optional) | TUI byte-identical under the existing tests; `desk-q --json home` works | Yes |
| **1. MVP: read-only window** | `desk-ui.mjs` with the guard, token, read API, SSE, watcher and server-owned probe loop; launchd; Desk.app (the Electron shell, §11) signing itself in; SPA with Inbox (read), Repos, Ticket overview, Workers, Usage, Health; outbound GitHub and Jira links everywhere; Dock badge | Shows the same counts as `desk-q` within 1 s of a file change; passes the security review; the 5-second test from the Dock badge plus the Inbox | Yes |
| **2. MVP+: act** | Inbox actions (record, answer, approve verbatim gate blocks, group apply with exclusions, refusal-11 inline); move and workers; supervisor on/off and batch grants with typed confirm; decisions override; audit log; Live worker tab (LogTailer); native PR panel (checks, failing-job links, threads) and Jira panel | A day of real use clearing needs-you from the app with no TUI fallback needed; no answer later overridden because of a UI misread (UX risk 1) | Yes; every write is an existing command |
| **3. Conversations v1** | SessionBroker: chat for park, ticket and fork (fresh by default, resume and fork cost estimate, usage guard, the 4-session cap; not counted in machineBudget); hand-off to Ghostty, Terminal or remote-control; MESSAGE copy box | A park answered through a seeded chat produces the record line and the item leaves the inbox | Yes |
| **v1.5** | In-app permission dialog (the `--permission-prompt-tool` MCP relay); `tokens.jsonl` (G11) and cost charts; PR diff view | — | Yes |
| **Shell features** | Tray popover (S1), global hotkey ⌃⌥D, `desk://` with single-instance forwarding, clickable notifications via the outbox handshake; then `desk-ptyd` plus xterm.js embedded terminal for `/desk-ticket` and skills; `queue.mjs stop` (G9), then a Stop button; mailbox delivery for MESSAGE (G4) | The glance takes 2 s from the menu bar; `/desk-ticket` runs in-app with the full TUI | Yes; delete `Desk.app` |
| **Later / maybe** | Agent SDK in place of the MCP relay; WebContentsView for GitHub (only if native panels fall short); a what-if reorder forecast in drag preview | — | — |

**Decisions for you** (my recommendation first):
1. **D1, the shell. Decided 2026-11-16 by Ben: Electron from the start.** Jim had recommended the PWA first, with Electron in v2; Ada's D-1 showed the difference is about a day for a locally built app, and both PWA features were unverified spikes.
2. **D2, in-app permission prompts.** I recommend the MCP relay (zero new dependencies). The runner-up, the Agent SDK, is cleaner but adds the server's first npm dependency.
3. **D3, embedded terminal.** I recommend v2 behind `desk-ptyd`. The runner-up, hand-off only forever, is cheaper, but `/desk-ticket` sessions then always leave the app.

---

## 13. Risks and mitigations

| Risk | Blast radius | Mitigation |
|---|---|---|
| A local server that can spawn `claude` is attacked by a web page | Local code execution as the user | Section 9 controls plus a security review before first launch. Sessions take purpose and ticket only. |
| The app becomes a way around the concurrency cap or usage pacing | Usage window exhaustion, which stalls every worker | The usage guard, a cap of 4 concurrent sessions and 10 creations per 10 min; conversations stay out of `machineBudget`, so they never take a worker slot (updated 15 Nov) |
| A fast inbox makes wrong answers cheap | A wrong park answer becomes wrong code or a wrong Jira write | The verbatim question as the main element, no auto-advance, gate blocks approved verbatim, override still available via decisions |
| App and TUI drift | Operator confusion | A single imported read model, and the server stores nothing |
| A failed SPA build at install | The app goes blank | Atomic swap; the old `dist` stays |
| A port clash with a new repo's dev range | The app won't start | Refuse with a clear message; never move silently |
| `desk://` claimed by another app | No inbound deep links | The Inbox and the ⌘K palette reach every item; the desk links story checks macOS names Desk for the scheme |
| Electron upgrade treadmill | Upgrade toil every 8 weeks | Keep the shell thin, about 300 lines; no updater; a bump is one version line |
| Large logs choke the Live tab | UI jank | Tail window, never forward `tool_result` bodies, rate cap with merging |

**Durability:** the app adds no durable data of its own beyond `ui/audit.jsonl`, which is append-only and loss-tolerant. Queue data RPO and RTO are unchanged. Server RTO is about 1 s (launchd). Chat sessions have RPO 0 completed turns (Claude Code's transcript), and RTO is the next turn's `--resume`.

## Not verified

- Electron's current major when the shell is built (this doc first named 45.x; Orca pins 43.8.7).
- That a rebuilt, ad-hoc-signed Desk.app keeps its notification permission (the shell story compares signing identities across builds).
- The `needs-you.mjs list` side effects and the exact `record` argv were taken from use-cases.md, not re-read here. Confirm both when building G2.
- The exact stream-json interrupt control message shape for `claude` 2.1.325. Check `claude --help` and the SDK's control requests when building section 6.
- The Agent SDK's current version (Orca pins 0.3.319). Check npm before D2.
