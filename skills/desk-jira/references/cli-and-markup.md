# desk-jira: the CLI's write traps, and markdown and wiki markup

Read before writing a body (a ticket, a comment or a description), setting a field with the CLI, or
acting on a priority `search` shows: the step table in `../SKILL.md` names this file for those steps.
The config, the gate and the rest of *Transport* (the transport check, the credentials, the reads)
are in `../SKILL.md`, already loaded. §4 Priority below is `desk-env list jira-priority`.

## What the CLI does on a write, and the traps it still has

- **Field values.** `field=@path` reads a file. JSON passes through untouched. A bare value is
  wrapped to the shape the field needs: `customfield_12345=P1` becomes `{"value":"P1"}`,
  `assignee=me` becomes your accountId. If `desk-jira --help` doesn't mention `@file`, your copy
  predates 2.0: re-run `install.sh`.
- **Every `edit` prints the fields read back from Jira.** Check that output. A line saying
  `the write did not stick` is a failed write, even though the PUT returned 2xx.
- **Bodies are positional.** `comment <KEY> <body-file|text>`, and `create`'s description the same
  way. There is no `--file` flag. The CLI refuses a body that looks like a flag or a missing
  `.md`/`.txt`. Write approved text to a file and pass the path. The literal-string form of
  `create` can return a bare 400, and a file avoids shell-quoting anyway. **The file must be inside
  the repo, `$DESK_STATE` or a temp directory**: the CLI refuses any other path (and `field=@path`
  and `attach` the same way), so it can never post another repo's credentials by mistake.
- **`search` shows the §4 Priority custom field** in its third column when §4 Priority names one
  (`desk-jira where` prints which), otherwise the built-in priority. For anything you will act on,
  confirm with `desk-jira get <KEY>`, which prints every set custom field by name (`--json` for raw).
- **Write bodies in markdown, in a `.md` file.** `create`'s description, `comment` and
  `edit description=@body.md` convert a `.md` file to Jira wiki markup before sending, because API v2
  reads wiki markup: a markdown `## Summary` sent raw renders as a nested numbered list, not a
  heading. `desk-jira md2wiki body.md` prints what would be sent, with no credentials.
  - **A body already in wiki markup goes unchanged.** A `.wiki` or `.txt` file and literal text are
    never converted, and nor is a `.md` file holding wiki markup (an `h2.` heading, a `{code}` or
    `{noformat}` block, `bq.`, a `||` header row, a `[text|url]` link). A `.md` file converts only
    when it has something only markdown writes: a fence, a backtick, `**bold**`, `[text](url)`, a
    `1.` item, a `|---|` row or a `#` heading on its own after a blank line. `- ` items, which wiki
    markup writes too, convert only when nothing wiki-like is beside them (`{{monospace}}`,
    `*bold*`, a run of `#` list lines).
  - **Once converting, a line starting `#` and a space is a heading**, never a wiki list item. So
    text copied from `get` or `comments`, which print wiki markup, goes back as a `.wiki` file.
  - `desk-jira rest` sends the file as it is: run `desk-jira md2wiki body.md > body.wiki` first.

  When you write wiki markup yourself (a `.wiki` file, or a `desk-jira rest` recipe), the forms are, wiki first:
  - lists `* item` and `# item` (nest with `**`, `##`), not `- item` / `1. item`;
  - bold `*bold*`, not `**bold**`;
  - inline code, flags and paths `{{\-\-add\-dir}}`, not backticks, **with every hyphen inside the
    braces escaped `\-`**: monospace does not stop the renderer, so an unescaped `{{--add-dir}}`
    renders as one hyphen and a strikethrough running to the next flag (measured). A code
    block `{code}…{code}`, not fences;
  - links `[text|https://…]`, not `[text](https://…)`;
  - tables `||head||head||` then `|cell|cell|`, with no `---` separator row.

  Some plain text is markup too: `-x-` is strikethrough and a stray `{word}` is read as a macro,
  so escape them with `\`. A `--flag` mid-sentence is left alone (measured), but `{{\-\-flag}}` is
  still the clearer way to write one. The converter escapes all of these in a `.md` body for you.

  Check a new body once in the rendered HTML with two counts. `grep -c '<h2'` should match the
  `h2.` headings sent (the `##` headings of a `.md` body). `grep -c '<del'` must print `0`: any
  `<del` is a failure (a hyphen read as strikethrough), so escape it and edit the body again:
  `desk-jira api "api/2/issue/<KEY>?fields=description&expand=renderedFields" | jq -r .renderedFields.description | grep -c '<del'`,
  or for a comment,
  `desk-jira api "api/2/issue/<KEY>/comment/<ID>?expand=renderedBody" | jq -r .renderedBody | grep -c '<del'`,
  and the same with `'<h2'`.
