# Check-out sources

The newer collectors step 2 can run alongside the three in its code block, where they are
installed. #1646 adds them and fills in this file; until then, a collector missing from
`~/.claude/skills/desk-checkout/scripts/` is skipped and named under **Missing sources**.

- `worklog_activity.py`: the day's worklog, for work no ticket or PR records (settings changed, <!-- prose-ok: #1646 adds it -->
  environments set up, root causes found).
- `claude_activity.py --window-turns`: each session's turns inside the window only, so a long
  session's earlier days do not read as today's work.
- Issues in `github_activity.py`: issues filed, closed or commented on in the window, so a batch of
  issues filed on one theme becomes an item (`references/items.md`).
