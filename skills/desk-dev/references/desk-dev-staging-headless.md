# Driving staging headlessly

For §4 Staging (`desk-env get staging`). §4 Staging `none`: none of this applies.

Building a signed-in fixture on staging by hand can cost most of a session. Every blocker below is
an **invisible** failure: the app looks broken rather than gated.

Signing up on staging **creates real accounts and data in a shared environment**. That falls under
config §3 `staging-write`, so say what you'll create and get agreement first (`no`: don't). Use the
auth provider's test-email convention (for Clerk, a `+clerk_test` address) so the accounts are
recognisably test ones, and record what you created so it can be found again. Keep fixture passwords
in your own notes, never in a skill, PR, ticket or screenshot.

## Getting past deployment protection

Where §4 Staging is protected by Vercel, use the bypass **cookie**: one navigation to
`/?x-vercel-protection-bypass=$TOKEN&x-vercel-set-bypass-cookie=true` per browser context. Never set
the token through Playwright's `extraHTTPHeaders`. That header goes on cross-origin requests too,
which forces a CORS preflight that a third-party CDN (the auth provider's script, for one) can
answer with a redirect. The script then fails, and the app spins forever. Token handling is covered
in SKILL.md.

## The auth provider

- **Bot protection (a CAPTCHA such as Cloudflare Turnstile) can silently kill every headless
  sign-up.** The form submits and validates, but no network request is made and no error is shown.
  Use the provider's testing helper with the **staging** instance's keys — for Clerk,
  `clerkSetup()` + `setupClerkTestingToken({ page })` from `@clerk/testing/playwright`.
- **Seeded personas can carry stale provider user ids**, so they can't sign in. An account
  self-registered through the UI mints a correct one.

## Phone and OTP

- **Some roles may be hard-gated on a verified phone** while others can skip the step. Read the
  onboarding code before assuming a gate is a bug.
- An app that validates with libphonenumber `isValid()` rejects some providers' canonical test
  numbers. For Clerk, **`+1 202 555 01XX`** is valid to libphonenumber and inside Clerk's test range,
  so its test OTP `424242` works; outside `0100`–`0199` the code is rejected.
- **An OTP step may not survive a page reload.** Do phone entry and OTP in one script run.

## Form quirks seen in custom inputs

- **Inputs that are height-0 until focused** make `.fill()` refuse them. Focus with
  `el.evaluate(e => e.focus())`, then `page.keyboard.type()`.
- **Checkboxes hidden inside a styled `<label>`**: click the label. `.check({ force: true })` sets
  the DOM, but React never registers it.
- Some inputs have no `type` attribute, so `input[type=text]` doesn't match them.

## Cheaper routes, when they are enough

For a component-level visual change you don't need staging or auth at all. A component workshop, or
a throwaway local preview page that is never committed, renders the component without auth or
seeded data. For a signed-in local surface, use a server-side sign-in token for an existing dev user,
as described in SKILL.md's local seed section.
