# Context-Specific Motion Patterns

Motion adapts to context. These are example product types to illustrate how motion personality changes based on what you are building. Real projects may blend multiple profiles or fall outside these categories entirely. The principle is always the same: understand the product context first, then choose motion that reinforces it.

## Table of Contents

1. [Banking and Fintech](#banking-and-fintech)
2. [E-Commerce](#e-commerce)
3. [Kids and Education](#kids-and-education)
4. [Healthcare](#healthcare)
5. [SaaS and Productivity](#saas-and-productivity)
6. [Creative and Portfolio](#creative-and-portfolio)
7. [Social and Consumer](#social-and-consumer)

---

## Banking and Fintech

**Personality:** Precise, restrained, trustworthy.
**Principle:** Every pixel of motion should feel controlled. Users are managing money; the interface must feel secure.

### Rules

- Use ease-out only. No bounce, no overshoot. Springs are acceptable only when critically damped (no oscillation).
- Duration range: 150-250ms. Faster is better. Users check balances quickly.
- Skeleton screens for all data loading. Never use spinners for financial data.
- Number changes (balance updates) should count up/down, not pop in.
- No decorative animation. Every movement serves a function.

### Do

- Smooth crossfade between account views (200ms ease-out)
- Skeleton shimmer while transactions load
- Subtle slide for transaction detail panels (200ms ease-out)
- Number counter animation for balance changes
- Confirmation checkmark (SVG draw-on) after transfers

### Do Not

- Use underdamped springs (any visible bounce or overshoot)
- Stagger animations on transaction lists (show all at once)
- Add parallax or scroll-driven effects
- Celebrate successful transfers with confetti or elaborate animation
- Auto-animate charts on load (let users trigger chart animations)

### Example: Balance Counter

```jsx
// Framer Motion number counter
import { useEffect } from "react";
import { motion, useSpring, useTransform } from "motion/react";

function Balance({ value }) {
  const spring = useSpring(0, { stiffness: 100, damping: 30 });

  useEffect(() => {
    spring.set(value);
  }, [value, spring]);

  const display = useTransform(spring, (v) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(v)
  );

  return <motion.span>{display}</motion.span>;
}
```

### Example: Transaction Panel Slide

```css
.transaction-detail {
  transform: translateX(100%);
  transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
}

.transaction-detail--open {
  transform: translateX(0);
}
```

---

## E-Commerce

**Personality:** Snappy, efficient, conversion-focused.
**Principle:** Motion should never stand between the user and the purchase. Speed is revenue.

### Rules

- Duration range: 100-200ms. Every millisecond matters in checkout flows.
- Cart interactions must feel instant. Add-to-cart should provide immediate feedback.
- Product image transitions should use shared element patterns for continuity.
- Loading states preserve layout to prevent content shifting (which erodes trust).
- Subtle motion only. The product is the star, not the animation.

### Do

- Quick add-to-cart feedback (icon pulse, badge count increment)
- Product image zoom on hover (scale 1.05, 200ms)
- Skeleton grids that match exact product card dimensions
- Smooth filter/sort transitions with layout animation
- Micro-feedback on size/color selection toggles

### Do Not

- Block checkout flow with loading animations
- Add elaborate page transitions between product and cart
- Use parallax on product listing pages
- Animate price changes without explaining why (confusing)
- Play celebration animations on "add to cart" (save celebration for order confirmation)

### Example: Add to Cart Feedback

```css
.cart-badge {
  transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.cart-badge--bump {
  transform: scale(1.3);
}
```

```js
function addToCart(item) {
  updateCart(item);
  const badge = document.querySelector(".cart-badge");
  badge.classList.add("cart-badge--bump");
  setTimeout(() => badge.classList.remove("cart-badge--bump"), 200);
}
```

### Example: Product Grid Skeleton

```css
.product-skeleton {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 24px;
}

.product-skeleton-card {
  aspect-ratio: 3/4;
  border-radius: 8px;
  background: linear-gradient(90deg, #f0f0f0 25%, #fafafa 50%, #f0f0f0 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s linear infinite;
}
```

---

## Kids and Education

**Personality:** Playful, rewarding, encouraging.
**Principle:** Motion teaches cause-and-effect. It celebrates effort, not just results. It makes learning feel like play.

### Rules

- Springs with bounce are welcome. This is the one context where overshoot feels right.
- Duration range: 200-400ms. Slightly slower so young users can track what happened.
- Celebrate milestones generously. Confetti, stars, character reactions.
- Errors should feel like part of the game, not failures. "Try again" animation, not error shake.
- Interactive elements should have exaggerated hover/press feedback.

### Do

- Spring-based button presses with visible bounce
- Staggered entrance for lesson content (helps focus attention sequentially)
- Reward animations: stars collecting, progress bar filling with particles
- Character reactions to user actions (thumbs up, excited bounce)
- Satisfying completion animations (checkmark with confetti burst)

### Do Not

- Use subtle, enterprise-style transitions (they feel lifeless here)
- Skip celebration on achievements (kids need positive reinforcement)
- Use complex scroll-driven animations (younger users may not scroll predictably)
- Animate text content while the user is reading it
- Autoplay distracting animations during focused tasks (reading, problem-solving)

### Example: Bouncy Button

```jsx
import { motion } from "motion/react";

<motion.button
  whileHover={{ scale: 1.08 }}
  whileTap={{ scale: 0.9 }}
  transition={{
    type: "spring",
    stiffness: 300,
    damping: 10,
  }}
>
  Start Lesson!
</motion.button>
```

### Example: Star Reward

```jsx
import { motion } from "motion/react";

const starVariants = {
  hidden: { scale: 0, rotate: -180, opacity: 0 },
  visible: (i) => ({
    scale: 1,
    rotate: 0,
    opacity: 1,
    transition: {
      type: "spring",
      stiffness: 200,
      damping: 12,
      delay: i * 0.15,
    },
  }),
};

function Stars({ count }) {
  return (
    <div className="stars">
      {Array.from({ length: count }).map((_, i) => (
        <motion.span
          key={i}
          custom={i}
          variants={starVariants}
          initial="hidden"
          animate="visible"
        >
          ★
        </motion.span>
      ))}
    </div>
  );
}
```

---

## Healthcare

**Personality:** Calm, reassuring, accessible.
**Principle:** Users may be anxious, in pain, or cognitively impaired. Motion should soothe, never startle.

### Rules

- Default to `prefers-reduced-motion` behavior even for users who have not enabled it. Keep everything minimal.
- Duration range: 250-400ms. Slightly slower signals patience and calm.
- Ease-in-out for everything. No sharp accelerations.
- No parallax, no scroll-driven effects, no auto-playing animation.
- Large touch targets with clear, gentle feedback.
- All animations must pass WCAG AAA (2.3.3), not just AA.

### Do

- Gentle crossfades between screens (300ms ease-in-out)
- Soft progress indicators for appointment booking steps
- Calm confirmation states (gentle checkmark, no confetti)
- Subtle skeleton loading with reduced shimmer speed
- Breathing-pace animations for meditation or waiting contexts (if appropriate)

### Do Not

- Use any bounce or spring easing
- Add scroll reveals or entrance animations
- Animate charts automatically on load
- Use flashing or pulsing indicators
- Add motion to error states (use color and icon changes instead)

### Example: Gentle Page Transition

```css
.page-enter {
  opacity: 0;
}

.page-enter-active {
  opacity: 1;
  transition: opacity 300ms ease-in-out;
}

.page-exit {
  opacity: 1;
}

.page-exit-active {
  opacity: 0;
  transition: opacity 200ms ease-in-out;
}
```

---

## SaaS and Productivity

**Personality:** Efficient, minimal, informative.
**Principle:** Users are here to work. Motion communicates state changes and provides feedback, never entertains.

### Rules

- Duration range: 150-250ms. Fast. Users repeat these actions hundreds of times.
- Ease-out for entries. Instant for exits when possible (modals can just disappear).
- No stagger on data tables or lists. Show everything at once.
- Toggle and switch feedback should be near-instant (100-150ms).
- Loading states should show progress, not just activity.

### Do

- Instant toggles with smooth track color transition (150ms)
- Subtle panel slides for side panels and drawers (200ms ease-out)
- Skeleton screens for dashboard widgets
- Smooth drag-and-drop with position snapping
- Brief success indicators that auto-dismiss

### Do Not

- Add entrance animations to data tables (users are scanning, not admiring)
- Celebrate task completion (checking off a task is its own reward in productivity tools)
- Use page transitions between dashboard views (instant swap is better)
- Animate sidebar navigation open/close if it is frequently toggled
- Add hover animations to every row in a data table

### Example: Efficient Sidebar Toggle

```css
.sidebar-layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  transition: grid-template-columns 200ms cubic-bezier(0.2, 0, 0, 1);
}

.sidebar-layout--collapsed {
  grid-template-columns: 56px 1fr;
}

.sidebar {
  overflow: hidden;
}
```

---

## Creative and Portfolio

**Personality:** Expressive, bold, immersive.
**Principle:** Motion IS the experience. This is the one context where animation can be a primary design element, not just a supporting one.

### Rules

- Duration range: 300-600ms. Slower motion feels more intentional and cinematic.
- Custom easing curves define the personality of the site.
- Scroll-driven animation is expected. Parallax, reveal sequences, progress-linked effects.
- Page transitions should feel crafted, not generic.
- Interactive experiments welcome: magnetic buttons, custom cursors, physics simulations.

### Do

- Scroll-triggered text and image reveals with stagger
- Smooth page transitions with shared element morphing
- Custom cursor interactions (magnetic pull to links, shape changes)
- Parallax depth layers for hero sections
- Image reveal effects (clip-path, mask animation)

### Do Not

- Sacrifice loading performance for visual impact (optimize assets aggressively)
- Make content inaccessible behind complex animations (content must be reachable without motion)
- Forget `prefers-reduced-motion` (creative sites are the worst offenders)
- Let animations block navigation (user should always be able to click away)
- Overdo it. Even in creative contexts, restraint is a skill. Pick 2-3 signature interactions.

### Example: Magnetic Button

```js
function magneticButton(button, strength = 0.3) {
  button.addEventListener("mousemove", (e) => {
    const bound = button.getBoundingClientRect();
    const x = (e.clientX - bound.left - bound.width / 2) * strength;
    const y = (e.clientY - bound.top - bound.height / 2) * strength;
    button.style.transform = `translate(${x}px, ${y}px)`;
  });

  button.addEventListener("mouseleave", () => {
    button.style.transition = "transform 400ms cubic-bezier(0.2, 0, 0, 1)";
    button.style.transform = "translate(0, 0)";
    setTimeout(() => (button.style.transition = ""), 400);
  });
}
```

### Example: Scroll-Driven Image Reveal

```css
.image-reveal {
  clip-path: inset(100% 0 0 0);
  animation: reveal 0.8s ease-out forwards;
  animation-timeline: view();
  animation-range: entry 10% entry 50%;
}

@keyframes reveal {
  to { clip-path: inset(0 0 0 0); }
}
```

---

## Social and Consumer

**Personality:** Energetic, gesture-driven, delightful on first encounter and subtle on repeat.
**Principle:** Motion creates emotional connection. The "like" animation matters as much as the feature itself.

### Rules

- Physics-based springs for all gesture-driven interactions (swipe, pull, fling).
- First-time interactions can be more expressive; repeated interactions should be faster.
- Duration range: 200-350ms for standard transitions. Gesture-driven motion follows the user's input velocity.
- Haptic feedback coordination when possible (trigger haptics at animation peaks).
- Social proof animations (typing indicator, live activity) should feel alive but not distracting.

### Do

- Heart/like burst animation with particle effects
- Swipe card physics (velocity-dependent throw, rubber-band at boundaries)
- Pull-to-refresh with custom branded animation
- Story/reel progress bars with smooth auto-advance
- Typing indicator with organic, breathing-like rhythm

### Do Not

- Make the like animation so elaborate it slows down rapid scrolling
- Add transition delays between feed items
- Auto-play video with motion overlays that compete for attention
- Use identical animation timing for all interactions (vary by importance)
- Forget that power users will trigger these animations thousands of times

### Example: Like Button Burst

```jsx
import { useState } from "react";
import { motion } from "motion/react";

function LikeButton({ onLike }) {
  const [liked, setLiked] = useState(false);

  return (
    <motion.button
      onClick={() => { setLiked(!liked); onLike(); }}
      whileTap={{ scale: 0.8 }}
    >
      <motion.span
        animate={liked ? {
          scale: [1, 1.4, 1],
          transition: {
            type: "spring",
            stiffness: 500,
            damping: 15,
          },
        } : { scale: 1 }}
      >
        {liked ? "❤️" : "🤍"}
      </motion.span>
    </motion.button>
  );
}
```
