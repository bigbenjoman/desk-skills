# A missing connector

Read from `desk-checkout` step 2, when a role (Gmail, Calendar, Slack) has no connector.

A role is missing when no tool name a `ToolSearch` with its required term (`+gmail`, `+calendar`,
`+slack`, e.g. `ToolSearch "+slack search"`) returns contains that term. Unrelated hits like
WebSearch or Atlassian search don't count, so never stand them in.

When a role is missing, run `perl -e 'alarm 90; exec @ARGV' claude mcp list`. If it shows the
connector as `✔ Connected`, it was connected after this session started, and the fix is a **new
session**: reconnecting won't help. Otherwise the fix is to enable it at claude.ai → Settings →
Connectors. Either way, carry on and **name it under the draft** with its fix.
