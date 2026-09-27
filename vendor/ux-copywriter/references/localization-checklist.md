# Localization Checklist

Every piece of UX copy should survive translation. Read when writing copy
for international products or when checking copy for localization readiness.

---

## Text Expansion

The same content gets longer in other languages. Design for this from day one.

| Source Language | Target | Typical Expansion |
|---|---|---|
| English | German | 20-35% longer |
| English | French | 15-25% longer |
| English | Finnish | 30-40% longer |
| English | Japanese | Often shorter |
| English | Chinese | Often shorter |
| English | Arabic | ~25% longer + RTL |

**Rule:** Build 30-40% padding into all text containers. A button that barely
fits "Save" in English will break with "Speichern" in German or
"Sauvegarder" in French.

**Write English copy as short as possible, not just short enough for English.**

---

## Idioms and Wordplay

These die in translation. Every time.

| Don't | Do |
|-------|-----|
| "Piece of cake!" | "That was easy!" |
| "You're on fire!" | "Great progress!" |
| "Break a leg" | "Good luck" |
| "Out of the box" | "Ready to use" |
| "Touch base" | "Connect" or "Check in" |
| "Ballpark figure" | "Estimate" or "Rough number" |

**Rule:** If a phrase relies on a cultural reference, metaphor, or double
meaning, replace it with a direct statement. Clever copy in English becomes
confusing copy in 40 other languages.

---

## Right-to-Left (RTL) Languages

Arabic, Hebrew, Farsi, and Urdu mirror the entire UI.

**What breaks:**
- "Click the arrow on the right" — there is no "right" in RTL, it's now left
- "Swipe left to delete" — direction reverses
- Progress bars that fill left-to-right
- Breadcrumb trails with directional arrows (→)
- Numbered lists with left-aligned text

**Rule:** Avoid ALL spatial references in copy. Instead of "the button on the
right," say "the Save button." Instead of "swipe left," say "swipe to dismiss."

---

## Cultural Tone Differences

"Friendly" means different things in different cultures.

- **US English:** Casual, first-name basis, contractions, exclamation marks OK
- **German:** More formal default. "Sie" (formal you) unless brand is explicitly casual
- **Japanese:** Politeness levels are grammatical, not just tonal. Casual US copy
  reads as disrespectful
- **French:** Moderate formality. US-style enthusiasm ("Awesome!") reads as
  childish or insincere
- **Brazilian Portuguese:** Warm and personal — closer to US casual but with
  different sensibilities

**Rule:** Write source copy in a neutral-warm tone. Avoid extremes of
formality or casualness. Let localization teams adapt tone for each market.

---

## Numbers, Dates, and Currency

These format differently everywhere.

| Format | US | Germany | Japan |
|---|---|---|---|
| Number | 1,000.50 | 1.000,50 | 1,000.50 |
| Date | 03/04/2026 | 04.03.2026 | 2026/03/04 |
| Currency | $25.00 | 25,00 € | ¥2,500 |

**Rule:** Use the user's locale settings for formatting. In copy, avoid
baking formats into strings. Use relative dates when possible:
"Today," "Yesterday," "2 hours ago" translate more cleanly than "March 4."

---

## Character Limits

Some limits are universal (SMS = 160 characters in all languages), but German
needs more characters to say the same thing.

**Rule:**
- Push notifications: 40-50 characters for the critical info
- Button text: 1-3 words maximum (allows for expansion)
- Tooltips: under 80 characters
- Error messages: under 120 characters if possible

---

## Translation Context

Translators need context to choose the right word.

- "Post" — is this a blog post, a mail post, or the verb "to post"?
- "Save" — save to disk, save money, or save a life?
- "Set" — a setting, a data set, or to set a value?

**Rule:** Provide translation notes for ambiguous terms. If your copy uses
a word with multiple meanings, add a comment explaining which meaning applies.

---

## Quick Self-Check Before Delivering

Run this on every piece of copy:

1. Will this survive 35% text expansion without breaking the layout?
2. Any idioms, puns, metaphors, or cultural references?
3. Any spatial directions (left, right, above, below)?
4. Any date/time/number formats baked into the string?
5. Could any word be ambiguous to a translator without context?
6. Is the tone neutral enough to adapt across cultures?

If any answer is yes, revise before delivering.
