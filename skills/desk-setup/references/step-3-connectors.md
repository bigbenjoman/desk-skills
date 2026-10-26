# desk-setup step 3: the connector checklist

Read at the start of step 3. The step table in `../SKILL.md` names this file for it.

## 3. Connector checklist

Only for connectors a granted row depends on. **Check presence, never content**: look for the tool
in this session (`ToolSearch` with the keywords below). Do not call it.

| Connector | Needed by | Look for | If missing |
|---|---|---|---|
| Atlassian (claude.ai) | Jira rows when `desk-jira` fails; `read-confluence` | `getJiraIssue`, `getConfluencePage` | claude.ai → Settings → Connectors → Atlassian → Connect, then restart Claude Code. The connector is signed in to one Atlassian account: if this repo's Jira is a different site or login, `desk-jira` is the path and the connector is only a fallback |
| Slack (claude.ai) | `slack-draft`, `read-slack-public`, `read-slack-own`, a Slack §4 Check-out destination | `slack_send_message_draft` | same path, Slack. The connector can also send; the deny-only plan denies those tools either way |
| Google Calendar and Gmail (claude.ai) | `read-calendar` | `list_events`, `search_threads` | same path |
| Figma (claude.ai) | `read-figma` | `get_design_context` | same path |
| Vercel (plugin) | `read-vercel` | `mcp__plugin_vercel_vercel__list_deployments` | `claude plugin install vercel@claude-plugins-official`, restart, `/mcp`. CLI: `vercel login`, `vercel switch <§4 Vercel team>` |
| Playwright (user-level MCP) | `pr-images`, screenshots | `browser_navigate` | re-run `./install.sh` (its Playwright MCP step), restart; signed out of GitHub: `node ~/.claude/desk/bin/github-signin.mjs` |

Report each connector as present, missing (with the step) or not needed.
