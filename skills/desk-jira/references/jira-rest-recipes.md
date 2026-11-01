# Jira REST recipes — what `desk-jira` has no command for

Call the Jira API through `desk-jira`, which signs every request with **this repo's** credentials
and never shows the token: `desk-jira api <path>` for a read, and `desk-jira rest <PUT|POST|DELETE>
<path> [<body file>]` for a write. The path is everything after `/rest/`. Every recipe here is a
**write** unless marked otherwise, so the gate in SKILL.md applies exactly as it does to any other
CLI call. §4 Tracker (`desk-env get tracker`) `none` means none of this applies; §4 Jira project
below is `desk-env get jira-project`.

```bash
desk-jira api 'api/3/issue/ABC-123?fields=summary'                 # read: raw JSON
desk-jira rest PUT api/3/issue/ABC-123 fields.json                 # write: the file is sent as is, as JSON
```

Never define a shell function or call `curl` with the token yourself: a function definition prompts
every time it runs, and a hand-built credential is one `ps` or a pasted command away from showing.
Build a JSON body with `jq` into a file in the working directory (`desk-jira rest` refuses a body
outside the repo, `$DESK_STATE` or a temp dir), then send it. `desk-jira rest` checks the credentials
before it writes, so a 2xx is never Jira's anonymous answer.

## Read every write back

A 2xx is not proof. Past failures all returned success:

| Write | Silent failure seen | Read back with |
|---|---|---|
| description PUT via v3 | 204 even when a node was malformed | re-GET and compare |

Issue links are not here: `desk-jira link` and `desk-jira unlink` handle every link type, its
inverted direction and the read-back.

## Deleting or editing a comment

No CLI subcommand. `desk-jira comments <KEY>` prints each comment's id.

```bash
# edit — comments hold no media, so v2 wiki markup is safe (200 = applied).
# curl sends the file as is. `desk-jira comments` prints wiki markup: edit that text in body.wiki
# and send it as is. New text written in markdown is converted first:
desk-jira md2wiki body.md > body.wiki
jq -n --rawfile b body.wiki '{body: $b}' > comment.json
desk-jira rest PUT api/2/issue/ABC-123/comment/<id> comment.json

# delete a mistaken comment (204)
desk-jira rest DELETE api/2/issue/ABC-123/comment/<id>
```

Editing the canonical root-cause comment beats leaving a superseded one that now reads as false.

## Editing a description that contains screenshots

Without images, `desk-jira edit ABC-123 description=@body.wiki` is enough. `desk-jira get` prints the
description as wiki markup, so save the edited text as `.wiki` and it is sent unchanged; a `.md`
file of markdown is converted.

Inline images live in the description as ADF `mediaSingle` nodes. Writing the field as markdown or
wiki markup (API v2, or `desk-jira edit description=…`) flattens the document, and **the images are
gone**. Patch the ADF instead:

1. `desk-jira api 'api/3/issue/ABC-123?fields=description' > before.json` (a read).
2. Change only the offending nodes in the `content` array. Inline code needs
   `marks: [{"type":"code"}]` on the text node.
3. Assert the `mediaSingle` node ids are identical before and after.
4. Write `{"fields":{"description": <adf>}}` to `after.json` and
   `desk-jira rest PUT api/3/issue/ABC-123 after.json` (204 = accepted).
5. Re-read with `desk-jira api` and compare. The 204 is not proof.

## Creating a ticket when `desk-jira create` fails

The file form (`desk-jira create Task "<summary>" body.md field=value…`) is the reliable one. If it
400s, the error body names the field. The usual cause is a required field; `desk-jira meta <type>`
lists them. Raw fallback, which sends the file as is, so convert the markdown first:

```bash
desk-jira md2wiki body.md > body.wiki
jq -n --rawfile d body.wiki --arg p <§4 Jira project> \
  '{fields: {project: {key: $p}, issuetype: {name: "Bug"}, summary: "…", description: $d}}' > issue.json
desk-jira rest POST api/2/issue issue.json
```

## Sprints and subtasks

The sprint field (find its id with `desk-jira fields sprint`) takes a plain sprint id. A **Subtask** rejects any sprint write with a bare 400,
because it inherits its parent's sprint. Bulk "add these to the sprint" loops should check
`issuetype` and skip subtasks rather than report them as errors.

## Deleting a ticket

Ordinary accounts lack the permission. Close it as a duplicate or out of scope instead (gate item 1
in SKILL.md), or ask whoever §4 People names under Deletes tickets.
