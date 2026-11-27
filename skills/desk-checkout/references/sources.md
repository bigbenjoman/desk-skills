# desk-checkout sources

Every source a check-out reads, what it's good for, and the per-repo §3 row that allows it. The
collectors are in `scripts/`. Run each with the same `--day` (and `--since`, `--since-for`) so they all
cover one window. Each applies every repo's own row and lists what it skipped. For an `ask` row, ask
the user once, then re-run with the flag the note names (`--include <slug>`, `--include-others <slug>`).

| Source | How | Permission (per repo) | What it's good for |
|---|---|---|---|
| **Jira** | `jira_activity.py`: REST through `desk-jira api` for each in-scope repo whose §4 Tracker is `jira` | `read-own-work` | Tickets raised, status moves, reassignments, field changes, the user's comments, and what others did to their tickets the same day |
| **GitHub PRs** | `github_activity.py` via `gh` | `read-own-work`; everyone's merged count needs `read-others` | PRs opened, merged, closed or pushed to, with review decision and failing checks for open ones; reviews given; merged counts per repo, yours and everyone's |
| **GitHub issues** | `github_activity.py`, the same run | `read-own-work` | Issues the user opened, closed or commented on in the window, grouped by repo, then by label (or the title's `prefix:`). Each gives number, title, state, and created or closed time. With §4 Tracker `none` these are the repo's tickets |
| **Work logs** | `worklog_activity.py`: the files or globs in each in-scope repo's §3b **Check-out work logs** row (default `none`) | `read-own-work` | Work done outside PRs and tickets that the user wrote down: entries on timestamped lines (`- HH:MM …` under a date heading, or ISO date-times), or a file's last lines when it has no times and was modified in the window |
| **Desk's own records** | `worklog_activity.py`, the same run, from `~/.config/desk/repos/<slug>/` and `~/.desk-autopilot/<slug>/` | `read-own-work` | Settings and calls desk recorded itself, one fact each with its source: config rows changed (each `config.md.bak*` written in the window, diffed against the next copy), lever changes (`levers.jsonl`), logged decisions (`decisions.jsonl`, the repo's and each batch's) and needs-you items answered (the check-in digest's `answered.json`) |
| **Claude Code** | `claude_activity.py` over every Claude login's `projects/*/*.jsonl` | `read-transcripts` | The *why* and the story: what they were chasing, what got found, work that never became a PR |
| **Claude Code, long sessions** | `claude_activity.py --window-turns` | `read-transcripts` | Use it when a session ran through the window (an orchestrator, or a session kept open all day): one whose activity spans more than half the window, or whose prompts and replies pass `--turn-threshold` characters (default 40000), is listed turn by turn, each prompt with Claude's final reply (cut at `--reply-chars`, default 500), instead of only its end. Without it such a session loses everything before its last replies |
| **Claude Code, one session's end** | `claude_activity.py --session <8-char id> --tail 4` | `read-transcripts` | The last replies of a session in full, for the two or three that carry the day's main items: the root cause, the status, the drafted announcement |
| **Calendar** | Google Calendar connector | `read-calendar` | The candidate meetings |
| **Meeting notes** | Gmail connector, Gemini notes | `read-calendar` | Decisions and actions from each meeting, and whether the user spoke |
| **Slack** | Slack connector | `read-slack-public`; DMs and private channels need `read-slack-own` | What they already announced, asks they made, and their previous check-out |

To run every collector once, in one call, with the window from the previous check-out (`W=` when
none was found):

```bash
S=~/.claude/skills/desk-checkout/scripts; D=auto; W="--since <its ISO time> --since-for <its day>"
python3 $S/jira_activity.py --day $D $W; python3 $S/github_activity.py --day $D $W
python3 $S/worklog_activity.py --day $D $W; python3 $S/claude_activity.py --day $D $W --window-turns
```

**Searches that hit the cap.** GitHub's search returns at most 1000 results. Each search pages to
that, and `github_activity.py` lists any search cut short under **Searches cut short**, with how many
it found. A count from a capped search is a lower bound. Say so under **Check before posting**.
