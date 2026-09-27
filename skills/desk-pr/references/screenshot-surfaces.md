# Where to capture before/after shots

Pick the cheapest surface that renders the real component with real copy. In order of cost:

| Surface | Use when | Needs |
|---|---|---|
| Storybook | Presentational component driven by props | Nothing — no Clerk, DB or middleware |
| Throwaway preview page | Needs providers Storybook doesn't mount, or auth/third-party data you can fake as props | A temporary page + route entry, reverted before the diff |
| The real app, signed in | Needs real server data | A seeded DB and a Clerk session — see blockers below |

Whatever the surface, use a port nobody else holds (config §3b "Preferred dev-server port"),
import `playwright` by absolute path from the worktree's own `node_modules`, and save to
`<handoff dir>/SV-XXX/`.

## Every surface: suppress the overlays

**Seed the Cookiebot consent cookie before the first `goto`.** Without it the banner covers the
content, and on some pages the dialog breaks hydration so measurements come back junk (a row
selector intermittently `null`), and every shot has to be recaptured.

```js
await ctx.addCookies([{ name: 'CookieConsent', value: '<consent value>', domain: 'localhost', path: '/' }]);
```

Get `<consent value>` by accepting the banner once in a normal browser on localhost and copying the
`CookieConsent` cookie (it starts `{stamp:%27-1%27%2Cnecessary:true%2C…`).

Also hide the Next dev overlay with `addStyleTag` —
`nextjs-portal, [data-nextjs-toast], [id^="CybotCookiebot"] { display: none !important }` — and
re-apply after opening a modal, since the overlay re-mounts.

## Getting a genuine "before"

Capture *after* first. Then restore the old code in place and let the dev server hot-reload:

```bash
git checkout origin/main -- <component paths> <src/i18n/messages/en/<ns>.json>
# shoot before
git checkout HEAD -- <same paths>
git diff HEAD --stat   # must be empty
```

- **Restore the i18n messages file in the same command.** The old component reads keys the new one
  renamed, so components alone render missing-key errors.
- A file the change renamed away comes back on restore: `git rm --cached` + `rm` it.
- Never `git stash` for this — after a commit it no-ops, and stashes are shared across worktrees.

## Storybook

`.storybook/preview.tsx` mounts a real `NextIntlClientProvider` on the actual message files, so a
story renders real copy (unlike Jest, where `t()` returns the key).

- Shoot the iframe: `http://127.0.0.1:<port>/iframe.html?id=<story-id>&viewMode=story`. The id is
  the `title` slugified plus the export: `Subscriptions/SubscriptionSuccessScreen` +
  `ParentForChildSuccess` → `subscriptions-subscriptionsuccessscreen--parent-for-child-success`.
- Screenshot the `#storybook-root` locator, not the page.
- Override the hardcoded port with `bun run --filter studia-web storybook -- -p <port>`.
- **Assert the DOM as well as the pixels** — read the CTA text and `href` back per story. Guard with
  `locator.count()`; a state with no `<a>` makes a bare `getAttribute` throw.
- **The tRPC mock returns no data.** `.storybook/mocks/trpc-react.tsx` answers every `useQuery` with
  `{ data: undefined, isSuccess: true }`, so anything behind a data gate renders empty and silently
  dead-ends (the booking picker shows every date disabled). To reach it, copy the mock outside the
  repo, make the proxy path-aware (return fixture data when `path.join('.')` matches the procedure),
  capture, restore from the copy, check `git status`.

## Throwaway preview page — studia-web

For a component whose real screen needs auth or third-party data (e.g. saved-card rows needing Clerk
*and* a Stripe customer), render it from a page with hand-written props:

1. **Put it under `src/app/(public)/<name>/page.tsx`.** There is no root layout, so a page at
   `src/app/dev/…` fails to build.
2. **Add the route to `publicRoutes` in `middleware.ts`** temporarily — the matcher lists paths, so
   `(public)` alone still redirects. Revert before the diff.
3. **Give the page `pt-24` or more.** The fixed navbar intercepts pointer events and clicks time out.
4. **Paste the real i18n strings**, never sample copy. Invented text changes line wrapping, every
   measurement and both shots, and can produce a false "copy differs from Figma" finding.
5. **Give each mock shell `shrink-0`.** Side-by-side shells in a flex row shrink below their fixed
   width; a before shot went up at 262px and looked like a real layout.

## Throwaway preview page — portal

Everything is under `apps/portal/apps/web/`. No `.env`, Clerk login or staging DB is needed:

- The portal has no `middleware.ts`, and `src/app/dev/` sits outside the `(portal)` layout that
  redirects to `/login` (precedent: `src/app/dev/email-preview/page.tsx`, guarded against production).
- Components render from hand-written fixtures; type-only DB imports are erased at build.
- `ClerkProvider` needs a publishable key present, not valid, if the page never calls `auth()`. A
  synthetic `pk_test_` key built from the dev instance hostname in the root layout's comment works,
  in `apps/web/.env.local` (gitignored). It is not a real secret; never copy a real key instead.
- The portal's own Playwright may want a browser build that isn't installed — import studia-web's by
  absolute path instead.
- `next dev` writes untracked `AGENTS.md`/`CLAUDE.md` into `apps/web/` and modifies tracked
  `next-env.d.ts`/`tsconfig.tsbuildinfo`. Delete and restore them, plus the page and `.env.local`.

## Signed-in, data-backed surfaces: known blockers

- **`db:seed:rich` may die importing `server-only`.** Run it with the flag `tutors:import` already
  carries: from `packages/studia-web`, `bunx tsx --conditions=react-server prisma/seed.ts --rich`.
  Seed an isolated per-ticket database, never the shared one and never staging.
- **The dev Clerk instance can be at its 100-user quota** — `createUser` returns 403
  `user_quota_exceeded`. **Do not prune the leftover test users**; that is shared across every
  checkout. Sign in as an existing user with a Backend-API sign-in token redeemed via
  `Clerk.client.signIn.create({ strategy: 'ticket', ticket })` + `setActive`, and save Playwright
  `storageState` — the token is single-use.

Both are cheaper to avoid than to fix: for a component-level visual change, use Storybook or a
preview page.
