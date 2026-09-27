---
description: Regenerate the product IA map from the code by spawning a role-sharded agent team
argument-hint: "[role ...]"
---

Regenerate the IA map for the repo you are in.

## 0. This repo

This command runs in many different repositories. Establish which one before deciding anything:

1. Run `desk-env where`. If it prints `EXISTS=yes`, read the `CONFIG` file: §0 One-line
   description, §2 Primary repo root, §4 toolchain (package manager, command prefix), §5
   conventions and Repo instructions. If it prints `EXISTS=no` or the command is missing, carry on
   without it — this command does not need a desk config.
2. Read the repo's own instruction files where they exist: `CLAUDE.md`, `AGENTS.md`, `DESIGN.md`,
   at the root and in each frontend app.
3. Detect the frontend app(s) and routing model: monorepo layout (`pnpm-workspace.yaml`,
   `turbo.json`, `workspaces`, `apps/*`), framework (Next.js App or Pages Router, React Router,
   Remix, SvelteKit, …), where routes live, where the auth/role checks live (middleware, route
   guards, layouts, auth-provider metadata such as Clerk `publicMetadata`, NextAuth/Auth.js
   session callbacks, Supabase claims, a role enum in the database schema), and where e2e specs
   live. A repo with two user-facing apps (say a customer app and a separate admin portal) is
   mapped as one product: each role is mapped in the app(s) it actually uses.

You pass what you found here to every Otto — they have no shell and no conversation history.

## 1. Decide where the output goes

**Detect an existing convention first.** Look for an IA pipeline the repo already has: an IA
manifest (`**/ia/manifest.yml` or similar), package scripts such as `ia:apply` / `ia:render`, an
`ia.json`, a `journeys.yml`, or an instruction file that names an IA location. If one exists, use
its paths, its role list and its scripts, and follow its own documentation over the defaults below.
If it distinguishes derived *areas* (route-based groupings of screens) from hand-authored
*journeys* (coded user stories), keep them distinct — never write derived data into a hand-authored
file.

**If there is no convention**, use `docs/ia/` at the repo root:

| Output | Committed? | Written by |
|---|---|---|
| `docs/ia/.findings/<role>.json` | **no** — scratch, one file per shard | you, verbatim from each Otto |
| `docs/ia/manifest.yml` | yes | you, once: the role list, each role's entries and route prefixes, the app(s) in scope |
| `docs/ia/ia.json` | yes | you, step 5: the merged, validated graph |
| `docs/ia/journeys.md` | yes | you, step 5: one derived flow per role, readable by humans |

**State the location to the user before spawning anyone**, and say whether it came from an
existing convention or is the default. If `docs/ia/.findings/` is not gitignored, say so and
recommend adding it rather than committing scratch.

## 2. Resolve the roles (the shards)

Every role gets a shard. The role list comes from **the code, not from memory**:

- If the repo's IA manifest declares roles, use exactly those.
- Otherwise derive them from the auth/role model found in step 0: role enums, role metadata the
  auth provider sets, middleware and guards that branch on a role, per-role route groups or apps.
  Add `anonymous` if the product has any signed-out surface.
- For each role, record its **entries** (where it lands: a public homepage, the post-sign-in
  redirect for that role) and its **route prefixes**, each with the file that proves it.

If the code does not settle the list — two names that may be one role, per-organisation
permissions that may or may not change which screens exist, a role no screen checks — **ask the
user**, with your recommended list first and the evidence for each role, rather than guessing.
Write the settled list to the manifest so the next run does not re-derive it.

If `$ARGUMENTS` names one or more roles, re-derive only those and reuse the existing findings on
disk for the rest — useful when one area has changed and a full run is not worth the tokens. The
findings are uncommitted scratch, so "on disk" means *this checkout*, from a run you did yourself.
A fresh clone has none, so the first run in a new checkout has to derive every role; if a reused
shard's file is missing, stop and name it.

A role named in `$ARGUMENTS` that the role list does not declare is an error. Stop and say so
rather than inventing an entry point.

## 3. Spawn the team

Spawn one teammate per shard, all using the `otto-ia-mapper` agent type, named `otto-<role>`,
in parallel. Teammates inherit none of your conversation history, so each prompt must be
self-contained and state:

- the role it owns, and that it owns only that role
- that role's `entries` and `prefixes`
- the app(s) in scope, the routing model, and where routes, auth/role checks and e2e specs live
  (from step 0), plus the desk config path if `EXISTS=yes`
- the labels other shards are likely to use for cross-role destinations, so `toRole` edges
  line up — at minimum the landing screen of each other role

If the harness offers a shared task list, create one task per teammate on it.

**Wait for all of them.** Do not start analysing the code yourself, and do not proceed on a
partial set of shards. If a teammate fails or returns unparseable JSON, report which role is
missing and stop — never apply partial findings.

## 4. Persist the findings

The teammates have no write tool, so you write for them. Save each reply verbatim to
`<ia dir>/.findings/<role>.json`.

The filename must match the `role` field inside the JSON; the run is rejected if they disagree.

## 5. Apply

**If the repo has its own apply/render scripts**, run them with the repo's package manager and
command prefix (§4 in the desk config, otherwise what the lockfile implies), from the directory
its docs name. They validate, merge, lay out and write the model; run the render step too if the
pipeline has one, since a model applied but not rendered leaves any viewer showing the previous
run.

**Otherwise you are the apply step**, and you fail closed exactly as a script would. Validate every
shard before merging anything:

- it parses, and its `role` matches its filename
- every `route` is free of route groups and other directory-only segments
- labels are unique within the shard, and every edge's `from` and `to` resolve to a label in the
  shard — or, when `toRole` is set, to a label in that role's shard
- every `decision` has at least two outgoing edges, each with a `label`
- every `terminal` has a `terminalKind` and no outgoing edges; no other node has a `terminalKind`
- `route` is null only on a decision; `contents` is present on every node
- every `unknowns` entry has a `where`

If any check fails, report every failure with its shard and stop. Then merge: give each node the
id `<role>:<kebab-case label>`, rewrite edges to ids, and compute which screens no entry of any
role can reach (following cross-role edges). Write `ia.json` with the nodes, edges, unknowns, the
unreachable list, the counts, and the commit SHA it was derived from. Write `journeys.md` with, per
role, a Mermaid `flowchart` of its shard (decisions as diamonds, terminals marked by kind,
cross-role edges pointing at the other role's node), followed by that role's unknowns — headed as
*derived from the code on <date> at <sha>*, so nobody mistakes it for hand-authored user stories.

Either way: do not hand-edit the merged output, and do not adjust the findings to make an error go
away — a decision rejected for having one exit is a decision Otto got wrong, and silently
correcting it hides the signal this command exists to produce. Re-run that role instead.

## 6. Draw the board

Only if step 5 succeeded, and only if the repo's IA manifest (or its instruction files) names a
generated FigJam board key. Otherwise say there is no board configured and stop after step 5 — the
map is still written and inspectable.

Load the `figma-use` skill first — it is mandatory before any `use_figma` call. Then draw the
merged map onto that board: wipe its existing contents and recreate every node and edge. If the
repo's pipeline produced a render payload with coordinates, fills, strokes and dashes already
resolved, draw what it says rather than making layout decisions of your own.

Never write to a hand-authored IA board. The generated board is a separate file, and the manifest
holds its key.

## 7. Report

Give the user:

- where the output was written, and whether that location came from a convention or the default
- the role list and how it was decided (from a manifest, derived from which files, or confirmed
  by the user)
- the counts — screens / decisions / terminals, edges and how many are cross-role, confirmed vs
  inferred, unreachable, unknowns
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
