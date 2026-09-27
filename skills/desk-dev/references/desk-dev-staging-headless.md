# Driving next.studia.io headlessly

Building a signed-in fixture on staging by hand can cost most of a session. Every blocker below is an **invisible** failure: the app looks broken rather than gated.

Signing up on staging **creates real accounts and data in a shared environment**. That falls under
config §3 `staging-write`, so say what you'll create and get agreement first. Use a
`+clerk_test` email address so the accounts are recognisably test ones, and record what you
created so it can be found again. Keep fixture passwords in your own notes, never in a skill, PR,
ticket or screenshot.

## Getting past Vercel protection

Use the bypass **cookie**: one navigation to
`/?x-vercel-protection-bypass=$TOKEN&x-vercel-set-bypass-cookie=true` per browser context. Never set
the token through Playwright's `extraHTTPHeaders`. That header goes on cross-origin requests too,
which forces a CORS preflight that Clerk's CDN answers with a redirect. `clerk.browser.js` then
fails, and the app spins forever. Token handling is covered in SKILL.md.

## Clerk

- **Smart CAPTCHA (Cloudflare Turnstile) silently kills every headless sign-up.** The form submits
  and validates, but no network request is made and no error is shown. Fix: `clerkSetup()` +
  `setupClerkTestingToken({ page })` from `@clerk/testing/playwright`, with the **staging** Clerk
  keys from `.env.staging`.
- **Seeded personas have stale `clerkId`s**, so they can't sign in. An account
  self-registered through the UI mints a correct one.

## Phone and OTP

- **Parents are hard-gated on a verified phone.** Students are exempt: their step has a Skip.
- The app validates with libphonenumber `isValid()`, which rejects Clerk's canonical
  `+1 555 555 01xx` numbers. Use **`+1 202 555 01XX`** instead. It is valid to libphonenumber and
  inside Clerk's test range, so Clerk's test OTP `424242` works. Outside `0100`–`0199` the code is
  rejected. Staging test accounts use `+1` numbers, not `+44`.
- **The OTP step does not survive a page reload.** Do phone entry and OTP in one script run.

## Form quirks

- **Inputs are height-0 until focused**, so `.fill()` refuses them. Focus with
  `el.evaluate(e => e.focus())`, then `page.keyboard.type()`.
- **Checkboxes are hidden inside a 36×36 `<label>`.** Click the label. `.check({ force: true })`
  sets the DOM, but React never registers it.
- Some inputs have no `type` attribute, so `input[type=text]` doesn't match them.

## Cheaper routes, when they are enough

For a component-level visual change you don't need staging or auth at all. Storybook, or a
throwaway local preview page that is never committed, renders the component without Clerk or
seeded data. For a signed-in local surface, use a Backend API sign-in token for an existing dev
user, as described in SKILL.md's local seed section.
