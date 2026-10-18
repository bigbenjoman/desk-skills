# Jira REST recipes — what `desk-jira` has no command for

Same Basic auth as the CLI, from **this repo's** config folder: the email in its `jira-email` and
the token in its `atlassian-token`. `desk-jira where` prints both paths and the site; `desk-jira
where --dir` prints the folder. Every recipe here is a **write** unless marked otherwise, so the gate
in SKILL.md applies exactly as it does to a CLI call. §4 Tracker `none` means none of this applies.

```bash
DIR="$(desk-jira where --dir)"                       # ~/.config/desk/repos/<slug>
SITE="$(desk-env get jira-site | awk '{print $1}')"  # §4 Jira site
PROJECT="$(desk-env get jira-project | awk '{print $1}')"  # §4 Jira project key
EMAIL="${JIRA_EMAIL:-$(tr -d ' \t\r\n' < "$DIR/jira-email")}"
# Credentials go to curl as a config on stdin (`-K -`), never on its argv, where `ps` shows them to
# every user on the machine. printf is a shell builtin, so it does not put them on an argv either.
jcurl() { printf 'user = "%s:%s"\n' "$EMAIL" "$(tr -d ' \t\r\n' < "$DIR/atlassian-token")" | curl -K - -sS "$@"; }
```

Never echo the token, never pass it as `-u`, and never paste it into a command you will show in the
conversation. `jcurl` reads stdin for the credentials, so send a body with `-d` or `--data-binary
@<file>` (a file inside the repo, `$DESK_STATE` or a temp dir), never on stdin. Before trusting an
empty read, check `desk-jira whoami` succeeds: Jira answers an anonymous request with 200 and no
issues.

## Read every write back

A 2xx is not proof. Past failures all returned success:

| Write | Silent failure seen | Read back with |
|---|---|---|
| issue link | created backwards, 201 | the `issuelinks` query below |
| description PUT via v3 | 204 even when a node was malformed | re-GET and compare |

## Issue links — the direction is inverted

Use `desk-jira link <KEY> blocked-by|blocks <OTHER>` for Blocks links: it handles all of this. The
recipe below is for another link type, or for deleting a wrong link. The usual link types are `Blocks`, `Duplicate` and `Relates`; ids vary by site. List them with `GET /rest/api/3/issueLinkType`.

`inwardIssue` is the **subject that performs the outward verb** on `outwardIssue`. To record
"ABC-1 is blocked by ABC-2", send `inwardIssue: ABC-2, outwardIssue: ABC-1`. The reading the field
names suggest creates the link backwards, and it still returns 201.

```bash
jcurl -X POST -H 'Content-Type: application/json' \
  "https://$SITE/rest/api/3/issueLink" \
  -d '{"type":{"name":"Blocks"},"inwardIssue":{"key":"ABC-2"},"outwardIssue":{"key":"ABC-1"}}'

# read back (read-only)
jcurl "https://$SITE/rest/api/3/issue/ABC-1?fields=issuelinks" | jq -r '
  .fields.issuelinks[] | if .outwardIssue then "\(.type.outward) \(.outwardIssue.key)"
                         else "\(.type.inward) \(.inwardIssue.key)" end'
```

There is no update: fix a wrong link with `DELETE /rest/api/3/issueLink/<id>` and re-post.
`Relates` is symmetric, so order doesn't matter.

## Deleting or editing a comment

No CLI subcommand. `desk-jira comments <KEY>` prints each comment's id.

```bash
# edit — comments hold no media, so v2 wiki markup is safe (200 = applied).
# curl sends the file as is. `desk-jira comments` prints wiki markup: edit that text in body.wiki
# and send it as is. New text written in markdown is converted first:
desk-jira md2wiki body.md > body.wiki
jcurl -X PUT -H 'Content-Type: application/json' \
  "https://$SITE/rest/api/2/issue/ABC-123/comment/<id>" -d "$(jq -n --rawfile b body.wiki '{body:$b}')"

# delete a mistaken comment (204)
jcurl -X DELETE "https://$SITE/rest/api/2/issue/ABC-123/comment/<id>"
```

Editing the canonical root-cause comment beats leaving a superseded one that now reads as false.

## Editing a description that contains screenshots

Without images, `desk-jira edit ABC-123 description=@body.wiki` is enough. `desk-jira get` prints the
description as wiki markup, so save the edited text as `.wiki` and it is sent unchanged; a `.md`
file of markdown is converted.

Inline images live in the description as ADF `mediaSingle` nodes. Writing the field as markdown or
wiki markup (API v2, or `desk-jira edit description=…`) flattens the document, and **the images are
gone**. Patch the ADF instead:

1. `GET /rest/api/3/issue/ABC-123?fields=description` and save the JSON.
2. Change only the offending nodes in the `content` array. Inline code needs
   `marks: [{"type":"code"}]` on the text node.
3. Assert the `mediaSingle` node ids are identical before and after.
4. `PUT /rest/api/3/issue/ABC-123` with `{"fields":{"description": <adf>}}` (204 = accepted).
5. Re-GET and compare. The 204 is not proof.

## Creating a ticket when `desk-jira create` fails

The file form (`desk-jira create Task "<summary>" body.md field=value…`) is the reliable one. If it
400s, the error body names the field. The usual cause is a required field; `desk-jira meta <type>`
lists them. Raw fallback, which sends the file as is, so convert the markdown first:

```bash
desk-jira md2wiki body.md > body.wiki
jcurl -X POST -H 'Content-Type: application/json' \
  "https://$SITE/rest/api/2/issue" \
  -d "$(jq -n --rawfile d body.wiki --arg p "$PROJECT" '{fields:{project:{key:$p},issuetype:{name:"Bug"},summary:"…",description:$d}}')"
```

## Sprints and subtasks

The sprint field (find its id with `desk-jira fields sprint`) takes a plain sprint id. A **Subtask** rejects any sprint write with a bare 400,
because it inherits its parent's sprint. Bulk "add these to the sprint" loops should check
`issuetype` and skip subtasks rather than report them as errors.

## Deleting a ticket

Ordinary accounts lack the permission. Close it as a duplicate or out of scope instead (gate item 1
in SKILL.md), or ask whoever §4 People names under Deletes tickets.
