---
name: ux-motion
description: "Expert motion design and animation implementation for web and mobile interfaces. Use this skill whenever implementing, reviewing, or coding motion, animation, transitions, or micro-interactions: CSS animations, Framer Motion, GSAP, React Spring, Lottie, Rive, scroll-driven animations, page transitions, loading states, skeleton screens, hover effects, spring physics, easing curves, choreography. Triggers on: 'animate this', 'add a transition', 'make it feel smooth', 'micro-interaction', 'loading animation', 'page transition', 'scroll animation', 'hover effect', 'spring animation', 'motion design', 'make it bounce', 'add movement'. Adapts motion to product context. Do NOT use for static visual styling (ui-designer), UX flow strategy (ux-designer), or interface copywriting (ux-copywriter)."
---

# UX Motion Implementation

Motion is not decoration. It is a communication layer that tells users where things come from, where they went, what changed, and what to do next. A well-animated interface feels responsive and trustworthy. A poorly animated one feels broken or annoying.

Your job is to implement motion that reinforces usability. Every animation must answer one question: what does this communicate to the user? If the answer is "nothing, it just looks nice," reconsider whether it belongs.

## Before You Animate: Understand the Context

Never write animation code without understanding what you are building. The same transition that feels perfect in a children's learning app will feel unprofessional in a banking dashboard. Context determines everything.

Before implementing any motion, identify:

- **What type of product is this?** Banking, e-commerce, education, SaaS, healthcare, portfolio, social? Each has a distinct motion personality.
- **What is the user doing?** Are they mid-task and need speed, or exploring and open to delight? Task-focused users are annoyed by motion that slows them down.
- **What device and performance budget?** Mobile on 3G needs lighter animation than desktop on fiber. Low-end Android devices struggle with complex CSS animations.
- **What framework is the project using?** React with Framer Motion, vanilla CSS, GSAP, Vue with built-in transitions? Match the tool to the ecosystem.

If you do not know these things, ask. Do not default to "add a nice animation." Default to understanding the context first.

**Match what already exists.** Before writing any animation, check the codebase for existing motion patterns: CSS custom properties for duration/easing, existing transition styles, animation libraries already installed. A new animation that uses different timing than everything else will feel wrong even if its values are technically correct. Consistency across the interface always beats a single perfect animation.

## Motion Profiles by Product Type

Different products demand different motion energy. This is not subjective preference; it is UX strategy. The wrong motion personality erodes trust, creates friction, or makes the product feel juvenile.

| Product Type | Motion Personality | Easing | Duration Range | Key Principle |
|---|---|---|---|---|
| **Banking, fintech** | Precise, restrained, secure | Smooth ease-out only | 150-250ms | Trust. No bounce, no overshoot. Every movement should feel controlled. |
| **E-commerce** | Snappy, efficient, non-blocking | Quick ease-out | 100-200ms | Speed. Never block the path to purchase. Cart animations must feel instant. |
| **Kids, education** | Playful, springy, rewarding | Springs with bounce | 200-400ms | Engagement. Motion teaches cause-and-effect. Celebrate milestones generously. |
| **Healthcare** | Calm, gentle, accessible | Slow ease-in-out | 250-400ms | Safety. No sudden movement. Respect vestibular sensitivity by default. |
| **SaaS, productivity** | Efficient, minimal, informative | Standard ease-out | 150-250ms | Clarity. Motion communicates state, not personality. Fast transitions, no flourish. |
| **Portfolio, creative** | Expressive, bold, scroll-driven | Custom springs, dramatic easing | 300-600ms | Impact. Motion IS the experience. Scroll reveals, magnetic interactions, custom cursors. |
| **Social, consumer** | Energetic, gesture-driven | Physics-based springs | 200-350ms | Delight on first encounter, subtle on repeat. Like animations, swipe physics, pull-to-refresh. |

For detailed motion recipes per product type with code examples, read `references/context-patterns.md`.

## Core Principles

### 1. Timing: The Invisible Skill

Duration is the difference between "smooth" and "sluggish." The human brain has specific windows for processing visual change.

| Element Type | Duration | Why |
|---|---|---|
| Button feedback, toggles | 100-150ms | Below conscious perception. Feels instant. |
| Tooltips, dropdowns, menus | 150-200ms | Fast enough to feel responsive, slow enough to register. |
| Panel slides, card expansions | 200-300ms | The brain needs time to track spatial changes. |
| Page transitions, modals | 300-500ms | Context shifts need more processing time. |
| Complex choreography | 500-700ms | Staggered sequences need time to tell their story. |
| Maximum for any UI animation | 1000ms | Beyond this, you break the user's flow of thought. |

**Scale duration to distance.** An element moving 50px should animate faster than one moving 500px. An element changing size by 10% should animate faster than one expanding to full screen.

### 2. Easing: How Things Move

Linear motion feels robotic. Real objects accelerate and decelerate.

- **ease-out (decelerate):** Elements entering the screen. They arrive with energy and settle into place. This is your default for most UI motion.
- **ease-in (accelerate):** Elements leaving the screen. They start slow and speed away. Used less often.
- **ease-in-out:** Elements moving between positions on screen. Smooth start and stop.
- **linear:** Color changes, opacity fades, progress bars. Where constant rate feels natural.
- **spring:** When you need overshoot, bounce, or physics-based feel. Springs do not have fixed duration; they simulate stiffness, damping, and mass. This produces more natural motion than cubic bezier curves.

For the complete easing reference with cubic bezier values, spring parameters, and platform tokens, read `references/easing-reference.md`.

### 3. Choreography: Motion as Narrative

When multiple elements animate, their order and timing tell a story. Choreography is how you direct the user's attention.

**Staggering:** Delay child animations by 30-50ms each. Creates rhythm and directs the eye. Do not stagger more than 5-6 elements; after that, group them.

**Sequencing:** The most important element animates first. This establishes visual priority. Primary action leads, secondary content follows.

**Parent-child:** The container animates first, then children animate within it. Never animate children before their parent is in place.

**Overlap:** Sequences should overlap slightly. Do not wait for one step to fully complete before starting the next. A 10-20% overlap between steps creates fluid motion.

**Total choreography budget:** The entire stagger sequence should complete within 300-500ms. If your orchestrated animation takes longer than 700ms, users are waiting, not watching.

### 4. Motion as Communication

Every animation should serve one of these four functions:

| Function | What it communicates | Example |
|---|---|---|
| **Feedback** | "Your action was received" | Button press, toggle switch, form validation |
| **Spatial** | "This came from there, it went over here" | Shared element transitions, card expansions, slide-in panels |
| **State** | "Something changed" | Skeleton to content, loading to loaded, error shake |
| **Attention** | "Look at this now" | Notification entrance, badge pulse, toast appearance |

If an animation does not fit one of these categories, question whether it should exist.

### 5. Consistency: Motion as a System

Individual animations do not exist in isolation. Every animated element is part of a larger motion language. If your modal enters at 250ms ease-out but your tooltip enters at 400ms ease-in-out, the interface feels disjointed even though both animations are individually fine.

**Hierarchy of speed:** Smaller, simpler elements should animate faster than larger, more complex ones. Tooltips < dropdowns < panels < modals < page transitions. This creates a natural rhythm where quick feedback is instant and context shifts take a beat.

**Shared tokens:** Define duration and easing values as design tokens (CSS custom properties or JS constants) and reuse them across all components. When every component draws from the same small set of timing values, the interface feels cohesive.

**Exit vs. enter ratio:** Exits should be 60-70% the duration of entrances. Users have already seen the element; they do not need as much time to process it leaving.

## When Motion Feels Wrong

When a user says "this feels off," translate the subjective feeling into a specific parameter fix:

| What they say | What is actually wrong | Fix |
|---|---|---|
| "It feels sluggish" | Duration is too long | Reduce duration by 30-50%. Most common mistake is animations that are too slow. |
| "It feels janky" | Animating layout properties, or too many elements at once | Switch to transform/opacity only. Reduce simultaneous animations. Check DevTools Performance tab. |
| "It feels robotic" | Using linear easing, or duration-based curves that feel stiff | Switch to spring physics or add ease-out. Springs always feel more natural than cubic bezier. |
| "It feels cheap" | Using default CSS `ease` or identical timing on everything | Use intentional easing curves. Vary duration by element importance. Add subtle stagger. |
| "It feels aggressive" | Easing is too sharp, or overshoot is too strong | Reduce spring stiffness, increase damping. Switch from `power3` to `power2`. Soften the curve. |
| "It feels disconnected" | No spatial relationship between trigger and result | Animate from the point of interaction. Use shared element transitions. Add directional continuity. |
| "It is distracting" | Animation draws attention but communicates nothing | Remove it, or reduce amplitude/distance. If it does not serve feedback, spatial, state, or attention purposes, it should not move. |
| "It feels like too much" | Too many things animate, or choreography takes too long | Reduce stagger count. Group elements. Cut total sequence to under 500ms. Remove the least important animations first. |

## Component Motion Patterns

| Component | Motion | Duration | Easing | Notes |
|---|---|---|---|---|
| **Button hover** | Scale 1.02, subtle shadow lift | 150ms | ease-out | Use transform only. Never animate width/height. |
| **Button press** | Scale 0.97, shadow reduce | 100ms | ease-out | Must feel tactile. Restore on release. |
| **Toggle switch** | Thumb slides, track color changes | 200ms | spring (stiff) | Color and position animate together. |
| **Dropdown/menu** | Scale from origin point, fade in | 150-200ms | ease-out | Transform-origin should match the trigger element. |
| **Modal entrance** | Scale from 0.95, fade in | 250ms | ease-out | Backdrop fades in parallel at 200ms. |
| **Modal exit** | Fade out, slight scale down | 150ms | ease-in | Exits should be faster than entrances (60-70% of enter duration). |
| **Toast notification** | Slide in from edge, auto-dismiss | 300ms in, 200ms out | ease-out in, ease-in out | Include progress bar for auto-dismiss timing. |
| **Skeleton screen** | Shimmer gradient sweep | 1.5-2s loop | linear | Left-to-right gradient. Match skeleton shapes to actual content dimensions. |
| **Page transition** | Crossfade or shared element morph | 300-400ms | ease-in-out | Never block interaction during transition. |
| **Accordion expand** | Height auto with opacity | 250ms | ease-out | Use `grid-template-rows: 0fr → 1fr` for smooth height. Never animate `height` or `max-height` directly. |
| **Card hover** | TranslateY -2px, shadow increase | 200ms | ease-out | Subtle lift. Do not scale cards on hover. |
| **List item entrance** | Fade up (translateY + opacity) | 200ms, stagger 40ms | ease-out | Cap stagger at 5-6 items. |
| **Error state** | Horizontal shake (2-3 cycles) | 400ms | ease-in-out | Small amplitude (4-6px). Do not shake the entire form, only the errored field. |
| **Success state** | Checkmark draw-on, brief color flash | 400ms | ease-out | Use SVG stroke-dashoffset for the checkmark animation. |
| **Scroll reveal** | Fade up from 20-30px offset | 400ms | ease-out | Trigger when element is 20% in viewport. Only animate once. |

## Performance

Animation performance is non-negotiable. Janky animation is worse than no animation.

### GPU-accelerated properties (animate these)

- `transform` (translate, scale, rotate)
- `opacity`
- `filter` (blur, brightness)

These bypass the main thread and run on the GPU compositor. They produce smooth 60fps animation.

### Layout-triggering properties (never animate these)

- `width`, `height`, `top`, `left`, `right`, `bottom`
- `margin`, `padding`, `border-width`
- `font-size`

Animating these forces the browser to recalculate layout for the entire page on every frame. This causes jank.

### Rules

- Target 16.67ms per frame (60fps). On 120Hz displays, 8.33ms.
- Use `will-change` sparingly. Each promoted layer consumes GPU memory. Apply it only to elements that will actually animate, and remove it after.
- Prefer CSS transitions for simple state changes. Reach for JavaScript animation libraries only when you need orchestration, springs, or gesture-driven motion.
- Test on low-end devices. An animation that runs smoothly on a MacBook Pro might stutter on a budget Android phone.
- Measure with browser DevTools Performance tab. If frames are dropping, simplify.

## Accessibility

Motion accessibility is not optional. It is a core requirement.

### prefers-reduced-motion

Always provide a reduced-motion alternative. This is not "remove all animation." It means replacing motion with instant state changes or simple crossfades.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Better approach: instead of killing all animation globally, provide thoughtful alternatives per component. A slide-in panel becomes an instant appear. A staggered list loads all at once. A page transition becomes a crossfade.

### Vestibular considerations

- 35% of US adults over 40 have experienced vestibular dysfunction
- Parallax scrolling, zoom animations, and spinning are the most problematic triggers
- Large-scale movement across the viewport causes more issues than contained, small-scale motion
- Auto-playing animations are worse than user-triggered ones

### WCAG compliance

- **2.3.1 (A):** No content flashes more than 3 times per second
- **2.3.3 (AAA):** Users can disable motion from interactions unless it is essential to functionality
- Provide a motion toggle in your app settings when possible

## Choosing the Right Tool

| Scenario | Recommended Tool | Why |
|---|---|---|
| Simple hover/focus states | CSS transitions | Zero overhead, native performance |
| Keyframe sequences | CSS @keyframes | No JS dependency for declarative animation |
| Scroll-linked animation | CSS scroll-driven animations | Native API, no JS scroll listeners |
| Spring physics, gestures | Framer Motion (React) | Declarative springs, layout animations, gesture system |
| Complex timelines, sequencing | GSAP | Most powerful timeline engine, framework-agnostic |
| Physics-based (non-React) | React Spring or anime.js | Spring model, cross-platform |
| Designer-created animations | Lottie (After Effects export) | Complex illustrations, brand moments |
| Interactive state machines | Rive | Smaller than Lottie, built-in logic, real-time interactivity |
| Scroll reveals (simple) | Intersection Observer + CSS | Lightweight, no library needed |
| Page transitions (MPA) | View Transitions API | Native browser API for cross-document transitions |

For implementation code patterns with each tool, read `references/implementation-patterns.md`.

## Quality Check

Before delivering any animation code, verify:

### Function
- Does every animation communicate something (feedback, spatial, state, attention)?
- Is the duration appropriate for the element size and travel distance?
- Does the easing match the direction (ease-out for enter, ease-in for exit)?

### Performance
- Are you only animating transform, opacity, or filter?
- Did you test on a low-end device or throttled CPU?
- Is `will-change` used only where needed and cleaned up after?

### Accessibility
- Does the animation respect `prefers-reduced-motion`?
- Is there a meaningful reduced-motion alternative (not just "no animation")?
- Does any content flash more than 3 times per second?

### Context
- Does the motion personality match the product type?
- Would this animation annoy a user on their 100th visit?
- Is the animation interruptible? Can the user act before it completes?

## Never

- **Never** animate `width`, `height`, `top`, `left`, `margin`, or `padding`. Use `transform` instead.
- **Never** block user interaction while an animation plays. All animations should be interruptible.
- **Never** add motion without a `prefers-reduced-motion` fallback.
- **Never** use bounce or spring easing in products where the context calls for restraint and trust. Match motion energy to the product's personality. When in doubt, err on the side of less.
- **Never** let a stagger sequence exceed 700ms total. After that, users are waiting.
- **Never** auto-play large-scale animations. User-triggered motion only, unless it is a loading indicator.
- **Never** animate more than 2-3 properties simultaneously on the same element. Each additional property increases the chance of jank.
- **Never** use animation duration as a way to "slow down" the user. If you need them to pause, use copy or a confirmation step, not a slow animation.
- **Never** apply the same generic animation to everything. A modal entrance and a tooltip entrance are different interactions with different needs.

## Working With Other Skills

- **ux-designer** handles experience strategy, user flows, and interaction design. When the design reaches the point of implementing actual motion in code, this skill takes over.
- **ui-designer** handles visual styling, spacing, and component design. This skill handles how those components move and transition.
- **ux-copywriter** handles interface text. This skill may inform how text content appears (fade-in, typewriter effect) but the words themselves belong to ux-copywriter.
