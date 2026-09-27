---
description: Regenerate the product IA map from the code by spawning a role-sharded agent team
argument-hint: "[role ...]"
---

Regenerate the Studia IA map.

## What this produces, and who reads it

| Output | Committed? | Read by |
|---|---|---|
| `packages/studia-web/ia/.findings/<role>.json` | **no**, gitignored | `ia:apply`, one file per shard |
| `packages/studia-web/ia/ia.json` | yes | the model — everything else is derived from it |
| `packages/studia-web/ia/ia.render.json` | **no**, gitignored | `apps/userflow`, and step 5's board |
| the generated FigJam board | n/a | humans wanting a shareable snapshot |

Each file has exactly one writer. **`ia:apply` writes `ia.json`; `ia:render` writes
`ia.render.json`** from an unchanged `ia.json` — that is the command to run after editing
`naming.yml` or `journeys.yml`, and it is what the `studia-journeys` Vercel project runs at
build time, because the payload is derived rather than committed. `ia:render` is also the only
thing that reads `journeys.yml`, so it is the only thing that can fail the build on a journey
code whose prefix was never declared or a `nodes:` entry pointing at a screen that no longer
exists. Running `ia:apply` alone leaves the map showing whatever the last render produced.

`apps/userflow` is the interactive reader of that payload and the reason this pipeline exists.
It is a separate Vercel project (`studia-journeys`, Root Directory `apps/userflow`). Run it
locally with `bun run --filter @studia/userflow dev` on port 3100.

**Two words that are not synonyms.** An **area** is a route-derived band of the map —
`checkout`, `account`, `lesson` — assigned by `src/lib/ia/areas.ts` from a screen's first route
segment, then spread along edges within a role. It is a grouping of screens. A **journey** is a
coded user story with acceptance criteria, such as `PAY-6`; it spans areas and roles, and one
screen serves many. Areas are derived; journeys are hand-authored. Do not read one as the other.

A `naming.yml` written before this rename used `journeys:` and `journey:`. Those still load, with
a warning, for one release.

## 1. Resolve the shards

Read `packages/studia-web/ia/manifest.yml`.

Every role it declares gets a shard. If `$ARGUMENTS` names one or more roles, re-derive only
those and reuse the existing findings on disk for the rest — useful when one area has changed
and a full run is not worth 400k tokens.

The findings are gitignored scratch, so "on disk" means *this checkout*, from a run you did
yourself. A fresh clone has none, and `ia:apply` exits non-zero naming the missing file, so the
first run in a new checkout has to derive every role.

A role named in `$ARGUMENTS` that the manifest does not declare is an error. Stop and say so
rather than inventing an entry point.

## 2. Spawn the team

Spawn one teammate per shard, all using the `otto-ia-mapper` agent type, named `otto-<role>`.
Teammates inherit none of your conversation history, so each prompt must be self-contained
and state:

- the role it owns, and that it owns only that role
- that role's `entries` and `prefixes` from the manifest
- the labels other shards are likely to use for cross-role destinations, so `toRole` edges
  line up — at minimum the portal screen of each other role

Create one task per teammate on the shared task list.

**Wait for all of them.** Do not start analysing the code yourself, and do not proceed on
four shards out of five. If a teammate fails or returns unparseable JSON, report which role
is missing and stop — never run the apply script on partial findings.

## 3. Persist the findings

The teammates have no write tool, so you write for them. Save each reply verbatim to:

```
packages/studia-web/ia/.findings/<role>.json
```

The filename must match the `role` field inside the JSON; the apply script rejects the run if
they disagree.

## 4. Apply

```bash
bun run --filter studia-web ia:apply
```

This validates every shard, merges them into one graph, checks the graph's invariants, lays
it out and writes `packages/studia-web/ia/ia.json`. Follow it with `ia:render` to rebuild the
payload the app draws:

```bash
bun run --filter studia-web ia:render
```

The script fails closed. If it exits non-zero, report the error and stop. Do not hand-edit
`ia.json`, and do not adjust the findings to make an error go away — a decision the script
rejects for having one exit is a decision Otto got wrong, and silently correcting it hides
the signal this command exists to produce.

## 5. Draw the board

Only if step 4 succeeded, and only if `figma.boardFileKey` in the manifest is non-empty.

Load the `figma-use` skill first — it is mandatory before any `use_figma` call. Then draw
`ia.render.json` onto that board: wipe its existing contents and recreate every node and
edge from the payload. The payload carries absolute coordinates, fills, strokes, shapes and
dashes already resolved; draw what it says rather than making layout decisions of your own.

Never write to the hand-authored *Rough IA — Userflow V2* board. The generated board is a
separate file and the manifest holds its key.

If `boardFileKey` is empty, say so and stop after step 4 — the payload is still written and
inspectable.

## 6. Report

Give the user:

- the counts the script printed — screens / decisions / terminals, edges and how many are
  cross-role, confirmed vs inferred, unreachable, unknowns
- the board URL if you drew one
- every `unknown`, with its reason. These matter more than the screens that resolved cleanly:
  each one is either genuinely dynamic or a gap in the analysis, and only a human can tell
  which.
- every unreachable screen. A screen no entry point can reach is either dead code or a
  navigation the analysis missed — both are worth knowing.
- the count of screens graded `inferred` rather than `confirmed`. Those are precisely the
  screens no test covers, and it is the single most useful number in the run.

Do not claim the map is complete or correct. It is derived and graded by evidence, and the
`inferred` nodes are precisely those no test covers.
