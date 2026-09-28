# Easing Reference

A lookup table for easing curves, spring parameters, and motion tokens across platforms.

## Table of Contents

1. [Cubic Bezier Cheat Sheet](#cubic-bezier-cheat-sheet)
2. [Spring Parameters Guide](#spring-parameters-guide)
3. [CSS linear() for Native Springs](#css-linear-for-native-springs)
4. [Platform Motion Tokens](#platform-motion-tokens)
5. [When to Use What](#when-to-use-what)

---

## Cubic Bezier Cheat Sheet

All values are `cubic-bezier(x1, y1, x2, y2)`.

### Standard Curves

| Name | Value | Feel | Use For |
|---|---|---|---|
| **ease-out** | `(0, 0, 0.58, 1)` | Quick start, gentle stop | Elements entering the screen |
| **ease-in** | `(0.42, 0, 1, 1)` | Slow start, quick finish | Elements leaving the screen |
| **ease-in-out** | `(0.42, 0, 0.58, 1)` | Smooth both ends | On-screen repositioning |
| **ease** (CSS default) | `(0.25, 0.1, 0.25, 1)` | Balanced, slightly quick start | General purpose fallback |
| **linear** | `(0, 0, 1, 1)` | Constant speed | Opacity, color, progress bars |

### Expressive Curves

| Name | Value | Feel | Use For |
|---|---|---|---|
| **Snappy** | `(0.2, 0, 0, 1)` | Sharp deceleration | Fast, responsive UI |
| **Gentle** | `(0.4, 0, 0.2, 1)` | Soft, understated | Calm, trust-oriented, gentle products |
| **Energetic** | `(0.34, 1.56, 0.64, 1)` | Slight overshoot | Playful products, toggles, bouncy feel |
| **Dramatic entry** | `(0, 0.55, 0.45, 1)` | Starts fast, long settle | Modal entrances, hero reveals |
| **Quick exit** | `(0.55, 0, 1, 0.45)` | Quick acceleration out | Dismissals, toast exits |

### With Overshoot (for playful contexts only)

| Name | Value | Feel |
|---|---|---|
| **Mild overshoot** | `(0.34, 1.2, 0.64, 1)` | Subtle bounce at end |
| **Medium overshoot** | `(0.34, 1.56, 0.64, 1)` | Noticeable spring feel |
| **Strong overshoot** | `(0.2, 1.8, 0.4, 1)` | Pronounced bounce |

Only use overshoot curves in contexts where playfulness fits the product personality. If the product demands trust, precision, or calm, avoid overshoot entirely.

---

## Spring Parameters Guide

Springs simulate real physics: an object attached to a spring, with friction. They do not have a fixed duration; the animation takes as long as the physics dictates.

### Parameters

| Parameter | Range | What It Controls |
|---|---|---|
| **Stiffness (tension)** | 50-1000 | How tight the spring is. Higher = snappier movement. |
| **Damping (friction)** | 5-100 | How much friction slows the spring. Higher = less bounce. |
| **Mass** | 0.1-5 | How heavy the object feels. Higher = slower to start, slower to stop. |

### Common Presets

| Name | Stiffness | Damping | Mass | Feel | Use Case |
|---|---|---|---|---|---|
| **Default** | 170 | 26 | 1 | Balanced | General purpose |
| **Snappy** | 400 | 30 | 1 | Quick, minimal bounce | Buttons, toggles, SaaS |
| **Bouncy** | 300 | 10 | 1 | Playful bounce | Kids apps, celebrations |
| **Gentle** | 120 | 14 | 1 | Slow, soft | Healthcare, onboarding |
| **Stiff** | 600 | 35 | 1 | Very fast, no bounce | Data-heavy UIs, enterprise |
| **Heavy** | 200 | 20 | 3 | Slow, weighty | Large modals, full-screen panels |
| **Micro** | 500 | 40 | 0.5 | Almost instant | Micro-interactions, icon feedback |

### The Damping Ratio

The ratio of damping to the critical damping value determines the behavior:
- **Underdamped (ratio < 1):** Oscillates before settling. This is the "bounce."
- **Critically damped (ratio = 1):** Settles as fast as possible without oscillating.
- **Overdamped (ratio > 1):** Slower than critically damped, no oscillation.

For most UI animation, aim for slightly underdamped (0.6-0.9 ratio) or critically damped. Heavy bouncing (ratio < 0.4) should be reserved for playful, non-critical interactions.

### Tuning Progressions

When animation values are close but not right, do not guess. Walk through these progressions to find the sweet spot.

**Spring: "too stiff" to "too soft"**

Each step reduces stiffness and damping together. Start in the middle and move in the direction that feels right.

| Step | Stiffness | Damping | Feel |
|---|---|---|---|
| 1 (very stiff) | 600 | 40 | Near instant, no bounce |
| 2 | 500 | 35 | Very snappy, barely perceptible settle |
| 3 (default start) | 400 | 30 | Quick, slight overshoot |
| 4 | 300 | 25 | Balanced, noticeable spring feel |
| 5 | 200 | 20 | Soft, gentle settle |
| 6 | 150 | 15 | Slow, visible bounce |
| 7 (very soft) | 100 | 10 | Heavy bounce, playful |

**Spring: adjusting bounce independently**

Keep stiffness fixed, change only damping. This controls how much overshoot you get without changing speed.

| Damping | Behavior at stiffness 400 |
|---|---|
| 40+ | No overshoot at all. Critically damped. |
| 30-35 | Barely perceptible overshoot. Feels natural. |
| 20-25 | Noticeable overshoot. Satisfying for toggles, likes. |
| 12-18 | Visible bounce. Playful, attention-grabbing. |
| 8-10 | Heavy bounce. Kids apps, celebrations only. |

**Cubic bezier: "too sharp" to "too soft"**

For ease-out curves, the control points determine how aggressively the element decelerates.

| Step | Value | Feel |
|---|---|---|
| 1 (very sharp) | `(0, 0, 0, 1)` | Slams to a stop. Dramatic. |
| 2 | `(0.1, 0, 0, 1)` | Strong deceleration. Bold entrances. |
| 3 (default) | `(0.2, 0, 0, 1)` | Standard snappy feel. M3 default. |
| 4 | `(0.25, 0.1, 0.25, 1)` | CSS `ease`. Softer, more gradual. |
| 5 | `(0.4, 0, 0.2, 1)` | Gentle. Calm, trust-focused products. |
| 6 (very soft) | `(0.4, 0, 0.6, 1)` | Very gradual. Almost linear feel. |

**Duration: fine-tuning**

If the motion feels close but not right, adjust in 50ms increments:

| Starting at | Try shorter | Try longer | For context |
|---|---|---|---|
| 150ms | 100ms | 200ms | Buttons, toggles, micro-interactions |
| 250ms | 200ms | 300ms | Panels, menus, cards |
| 350ms | 300ms | 400ms | Modals, page transitions |

The difference between 200ms and 250ms is subtle but perceptible. Between 200ms and 300ms it is obvious. Tune in small steps when you are close.

---

## CSS linear() for Native Springs

The `linear()` CSS timing function accepts multiple data points, enabling native spring-like curves without JavaScript.

### Example: spring curve in CSS

```css
.spring-animation {
  transition: transform 600ms linear(
    0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%,
    0.938 16.7%, 1.017, 1.077, 1.121, 1.149 24.3%,
    1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%,
    1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%,
    0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1
  );
}
```

Generate these values using tools like the Spring Easing Generator or Josh Comeau's spring visualizer. Do not hand-author these values.

**Browser support:** ~88% global support as of early 2026.

---

## Platform Motion Tokens

### Material Design 3

**Duration tokens:**

| Token | Value | Use Case |
|---|---|---|
| `duration.short1` | 50ms | Micro-feedback |
| `duration.short2` | 100ms | Button feedback |
| `duration.short3` | 150ms | Small transitions |
| `duration.short4` | 200ms | Tooltips, menus |
| `duration.medium1` | 250ms | Standard transitions |
| `duration.medium2` | 300ms | Cards, panels |
| `duration.medium3` | 350ms | Modals |
| `duration.medium4` | 400ms | Complex transitions |
| `duration.long1` | 450ms | Large transitions |
| `duration.long2` | 500ms | Page transitions |
| `duration.extra-long1` | 700ms | Complex choreography |

**Easing tokens:**

| Token | Curve | Use Case |
|---|---|---|
| `easing.standard` | `cubic-bezier(0.2, 0, 0, 1)` | Most transitions |
| `easing.standard-decelerate` | `cubic-bezier(0, 0, 0, 1)` | Elements entering |
| `easing.standard-accelerate` | `cubic-bezier(0.3, 0, 1, 1)` | Elements exiting |
| `easing.emphasized` | Two-phase curve | High-emphasis transitions |
| `easing.emphasized-decelerate` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | Dramatic entry |
| `easing.emphasized-accelerate` | `cubic-bezier(0.3, 0, 0.8, 0.15)` | Dramatic exit |

### IBM Carbon

**Two modes:**

| Mode | Purpose | Standard Easing |
|---|---|---|
| **Productive** | Efficient, subtle, fast | `cubic-bezier(0.2, 0, 0.38, 0.9)` |
| **Expressive** | Enthusiastic, vibrant | `cubic-bezier(0.4, 0.14, 0.3, 1)` |

**Duration tokens:**

| Token | Productive | Expressive |
|---|---|---|
| Fast-01 | 70ms | 150ms |
| Fast-02 | 110ms | 240ms |
| Moderate-01 | 150ms | 400ms |
| Moderate-02 | 240ms | 700ms |
| Slow-01 | 400ms | 1000ms |

### Creating Your Own Motion Tokens

If the project does not follow M3 or Carbon, define motion tokens early:

```css
:root {
  /* Duration */
  --motion-duration-instant: 100ms;
  --motion-duration-fast: 150ms;
  --motion-duration-normal: 250ms;
  --motion-duration-slow: 400ms;
  --motion-duration-slower: 600ms;

  /* Easing */
  --motion-ease-default: cubic-bezier(0.2, 0, 0, 1);
  --motion-ease-enter: cubic-bezier(0, 0, 0, 1);
  --motion-ease-exit: cubic-bezier(0.3, 0, 1, 1);
  --motion-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
}
```

Consistent tokens prevent the "every component has different timing" problem that makes interfaces feel disjointed.

---

## When to Use What

| Situation | Easing Type | Why |
|---|---|---|
| Element appears on screen | ease-out or spring | Arrives with energy, settles into place |
| Element leaves screen | ease-in | Accelerates away, clears space quickly |
| Element moves between positions | ease-in-out | Smooth pickup and landing |
| Color or opacity change | linear | Constant rate feels natural for non-spatial changes |
| Playful interaction (toggle, like) | spring with bounce | Physics feel makes it satisfying |
| Trust-critical or calm context | ease-out, no overshoot | Controlled motion builds trust |
| Long scrolling narrative | scroll-linked linear | Progress matches scroll input directly |
| Loading progress bar | linear | Progress should feel honest, not deceptive |
