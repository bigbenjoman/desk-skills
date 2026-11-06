# Where to capture before/after shots

Pick the cheapest surface that renders the real component with real copy. In order of cost (the
rows named here are read with `desk-env get local-db`, `desk-env list staging`,
`desk-env get staging-bypass`, `desk-env get dev-port`, `desk-env cmds dev-cmd` and
`desk-env get command-prefix`):

| Surface | Use when | Needs |
|---|---|---|
| The repo's component workshop (Storybook or similar), if it has one | Presentational component driven by props | Nothing beyond the workshop's own dev command |
| Throwaway preview page | Needs providers the workshop doesn't mount, or auth/third-party data you can fake as props | A temporary page (and route entry, if routing is allowlisted), reverted before the diff |
| The real app, signed in | Needs real server data | A seeded database (§4 Local database) and a signed-in session — see blockers below |
| The PR's preview deployment | §4 Dev server has no item for the app (`desk-env cmds dev-cmd` has no line for its directory), so its dev server cannot run | The preview's URL (the host's bot comment on the PR, or the branch deployment's `environment_url`), and the screen loads signed out or a §4 Staging bypass token or the sign-in token below works against it. The "before" comes from §4 Staging |
| §4 Staging | The change is already deployed there, or the "before" is exactly what staging runs now | §4 Staging reachable; a bypass token from §4 Staging bypass token location if staging is protected. `none`: not an option |

Whatever the surface, use a port nobody else holds (config §3b "Preferred dev-server port"), start
the app with §4 Dev server (prefixed with §4 Command prefix unless it is `none`), import `playwright`
by absolute path from the worktree's own `node_modules` (or the primary checkout's, §2 Primary repo
root), and save to `<§2 Handoff directory>/<TICKET>/`.

## Every surface: suppress the overlays

**Seed any cookie-consent state before the first `goto`.** If the app shows a consent banner,
without it the banner covers the content, and on some pages the dialog breaks hydration so
measurements come back junk (a row selector intermittently `null`), and every shot has to be
recaptured.

```js
await ctx.addCookies([{ name: '<consent cookie name>', value: '<consent value>', domain: 'localhost', path: '/' }]);
```

Get the name and value by accepting the banner once in a normal browser on localhost and copying
the cookie it sets. Never invent one.

Also hide the framework's dev overlay (for Next.js: `nextjs-portal, [data-nextjs-toast]`) and the
consent dialog's root with `addStyleTag` — `<selectors> { display: none !important }` — and
re-apply after opening a modal, since the overlay re-mounts.

## Getting a genuine "before"

Capture *after* first. Then restore the old code in place and let the dev server hot-reload:

```bash
git checkout origin/<§0 Default branch> -- <component paths> <any messages/translation files they read>
# shoot before
git checkout HEAD -- <same paths>
git diff HEAD --stat   # must be empty
```

- **Restore any i18n messages file in the same command.** The old component reads keys the new one
  renamed, so components alone render missing-key errors.
- A file the change renamed away comes back on restore: `git rm --cached` + `rm` it.
- Never `git stash` for this — after a commit it no-ops, and stashes are shared across worktrees.

## Component workshop (Storybook)

Check how the repo's preview config mounts providers: if it mounts the real i18n provider on the
actual message files, a story renders real copy (unlike unit tests, where a translation function
often returns the key).

- Shoot the iframe: `http://127.0.0.1:<port>/iframe.html?id=<story-id>&viewMode=story`. The id is
  the `title` slugified plus the export: `Checkout/SuccessScreen` + `ForGuest` →
  `checkout-successscreen--for-guest`.
- Screenshot the `#storybook-root` locator, not the page.
- Override a hardcoded port by passing `-p <port>` through the repo's storybook script.
- **Assert the DOM as well as the pixels** — read the CTA text and `href` back per story. Guard with
  `locator.count()`; a state with no `<a>` makes a bare `getAttribute` throw.
- **Data mocks often return nothing.** If the workshop mocks the API client so every query resolves
  with no data, anything behind a data gate renders empty and silently dead-ends. To reach it, copy
  the mock outside the repo, make it return fixture data for the one call you need, capture,
  restore from the copy, check `git status`.

## Throwaway preview page

For a component whose real screen needs auth or third-party data (e.g. saved-card rows needing a
signed-in user *and* a payment-provider customer), render it from a page with hand-written props:

1. **Put it where the app's routing will build it** — inside a route group that has a layout, not
   somewhere that fails to build for lack of one. Look for an existing dev-only page as precedent.
2. **If routing is gated by an allowlist** (auth middleware listing public paths), add the route
   temporarily. Revert before the diff.
3. **Clear any fixed header.** Give the page enough top padding that a fixed navbar does not
   intercept pointer events and time out clicks.
4. **Paste the real i18n strings**, never sample copy. Invented text changes line wrapping, every
   measurement and both shots, and can produce a false "copy differs from the design" finding.
5. **Give each mock shell `shrink-0`** (or the equivalent). Side-by-side shells in a flex row shrink
   below their fixed width; a before shot went up at 262px and looked like a real layout.
6. **An auth provider that only needs a key to be present** can take a synthetic, obviously-fake
   test key in a gitignored local env file. It is not a real secret; never copy a real key instead.
7. Dev servers can write untracked or modify tracked files (generated type stubs, build info, agent
   files). Delete and restore them, plus the page and any env file you added.

## Signed-in, data-backed surfaces: known blockers

- **Seed an isolated per-ticket database**, never a shared one and never staging (§4 Local
  database; §3 `db-per-ticket`, and `tests-shared-db` for anything another session may be using).
  Local database `none`: this surface needs whatever the repo's instructions say, or it is not an
  option — use a cheaper one.
- **A development auth instance can be at its user quota** (user creation returns a quota error).
  **Do not prune the leftover test users**; they are shared across every checkout. Sign in as an
  existing test user with the provider's server-side sign-in token where it has one, and save
  Playwright `storageState` — such tokens are usually single-use.

Both are cheaper to avoid than to fix: for a component-level visual change, use the workshop or a
preview page.

## Signed in with a sign-in token (Clerk)

For a page behind real auth, on a development instance only. It needs §4 Env files
(`desk-env list env-files`) to hold the instance's key pair for the app under test, and a test user
who already holds the app's grant.

1. **Start the right app.** `desk-env cmds dev-cmd` gives one `DIR<TAB>CMD` line per app, so in a
   multi-app repo pick the line whose directory holds the page. Run it through `with-lock.sh nolock
   --cwd <dir> -- <§4 Command prefix> <cmd>`, the only form a worker has for a directory item, and
   pass the port the way that row's note says: an app that ignores `PORT` takes `-p <port>` after the
   command. Generate any client the app imports (§4 Codegen, `desk-env cmds codegen-cmd`) first; a
   fresh worktree has none.
2. **Write the capture script at the worktree's root** and run it with `with-lock.sh browser node
   ./<script>.mjs <port> <path> <out.png> <test user email> <env file holding the instance's keys>`. A script elsewhere, or an argument holding `..`, is
   refused. Delete the script afterwards.
3. **Refuse any key but a development one.** Mint the token server-side, sign in from a page where
   ClerkJS has loaded, and print what the session token carries before looking at the page:

```js
import { readFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, path, out, email, envFile] = process.argv.slice(2);
const key = /^CLERK_SECRET_KEY="?([^"\n]+)"?$/m.exec(readFileSync(envFile, 'utf8'))?.[1] ?? '';
if (!key.startsWith('sk_test_')) throw new Error('not a development instance key');
const clerk = async (method, p, body) => {
  const r = await fetch(`https://api.clerk.com/v1${p}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`clerk ${p}: ${r.status}`);
  return r.json();
};
const [user] = await clerk('GET', `/users?email_address=${encodeURIComponent(email)}`);
const { token } = await clerk('POST', '/sign_in_tokens', { user_id: user.id, expires_in_seconds: 300 });

const { chromium } = createRequire(resolve('package.json'))('playwright');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const base = `http://localhost:${port}`;
await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 60000 });
const signedIn = await page.evaluate(async (ticket) => {
  const si = await window.Clerk.client.signIn.create({ strategy: 'ticket', ticket });
  await window.Clerk.setActive({ session: si.createdSessionId });
  const jwt = await window.Clerk.session.getToken();
  const claims = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return { status: si.status, claims: Object.keys(claims) };
}, token);
console.log('sign-in', JSON.stringify(signedIn));
await ctx.storageState({ path: `${out}.state.json` }); // the token is single-use; this is what you reuse
chmodSync(`${out}.state.json`, 0o600);
await page.goto(`${base}${path}`, { waitUntil: 'networkidle', timeout: 180000 });
console.log('landed', page.url().replace(base, ''));
await page.screenshot({ path: out, fullPage: true });
await browser.close();
```

4. **Read `landed` and the screenshot before trusting the shot.** Sign-in succeeding proves little:
   - **The app's gate reads a claim the instance does not emit.** Compare the printed claim names
     with what the app's middleware reads. The session-token template is instance configuration,
     not code, and each instance has its own. A missing claim is a config fault: say so and park,
     and never change the template or the app's gate to get a shot.
   - **`clerkMiddleware() was not run` in the dev server's log.** Next.js looks for `middleware.ts`
     beside `app/`, so with `src/app` a root-level file may not run under `next dev`. A signed-out
     request for a gated page that returns 500, not a redirect, is the quick test. It is a code
     problem in that repo: report it, and do not move the file in the ticket's diff unless the ticket
     is about it.

Keep the state file out of the handoff directory and delete it with the script: it is a live session.
