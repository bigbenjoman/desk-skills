# Implementation Patterns

Code patterns for each major animation tool. Choose based on your project's framework and needs.

## Table of Contents

1. [CSS Transitions](#css-transitions)
2. [CSS Keyframes](#css-keyframes)
3. [3D Transforms](#3d-transforms)
4. [CSS Scroll-Driven Animations](#css-scroll-driven-animations)
5. [Framer Motion (React)](#framer-motion-react)
6. [GSAP](#gsap)
7. [React Spring](#react-spring)
8. [Lottie](#lottie)
9. [Rive](#rive)
10. [View Transitions API](#view-transitions-api)
11. [Intersection Observer + CSS](#intersection-observer--css)

---

## CSS Transitions

Use for simple state changes (hover, focus, active, class toggles). Zero JavaScript overhead.

### Button with hover and press states

```css
.button {
  transform: translateY(0);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  transition: transform 150ms ease-out, box-shadow 150ms ease-out;
}

.button:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}

.button:active {
  transform: translateY(0) scale(0.97);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  transition-duration: 100ms;
}
```

### Toggle switch

```css
.toggle-thumb {
  transform: translateX(0);
  transition: transform 200ms cubic-bezier(0.2, 0.8, 0.4, 1.2);
  /* Slight overshoot for tactile feel */
}

.toggle--active .toggle-thumb {
  transform: translateX(20px);
}

.toggle-track {
  background: #ccc;
  transition: background 200ms ease-out;
}

.toggle--active .toggle-track {
  background: #4ade80;
}
```

### Accordion with smooth height

```css
.accordion-content {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 250ms ease-out;
}

.accordion-content > div {
  overflow: hidden;
}

.accordion--open .accordion-content {
  grid-template-rows: 1fr;
}
```

This pattern avoids animating `height` directly. The `grid-template-rows` approach still triggers layout, but it handles dynamic content height gracefully and is the most reliable CSS-only technique for animating to auto height.

### Reduced motion fallback

```css
@media (prefers-reduced-motion: reduce) {
  .button,
  .toggle-thumb,
  .toggle-track,
  .accordion-content {
    transition-duration: 0.01ms;
  }
}
```

---

## CSS Keyframes

Use for looping animations, multi-step sequences, and effects that do not depend on state changes.

### Skeleton shimmer

```css
.skeleton {
  background: linear-gradient(
    90deg,
    #e5e7eb 25%,
    #f3f4f6 50%,
    #e5e7eb 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s linear infinite;
  border-radius: 4px;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .skeleton {
    animation: none;
    background: #e5e7eb;
  }
}
```

### Error shake

```css
.field--error {
  animation: shake 400ms ease-in-out;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-4px); }
  40% { transform: translateX(4px); }
  60% { transform: translateX(-4px); }
  80% { transform: translateX(2px); }
}
```

### SVG checkmark draw

```css
.checkmark-path {
  stroke-dasharray: 24;
  stroke-dashoffset: 24;
  animation: draw-check 400ms ease-out forwards;
}

@keyframes draw-check {
  to { stroke-dashoffset: 0; }
}
```

### Pulse (attention indicator)

```css
.notification-dot {
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.7; transform: scale(1.15); }
}
```

---

## 3D Transforms

3D transforms use the same `transform` property as 2D, so they are GPU-accelerated. The key addition is `perspective`, which creates depth, and `rotateX`/`rotateY` for rotation along those axes.

### Perspective basics

Perspective is set on the **parent** container, not the element itself. Lower values create stronger depth effect (more dramatic foreshortening).

```css
.card-container {
  perspective: 1000px; /* moderate depth — good default */
}
```

| Perspective Value | Depth Effect | Use Case |
|---|---|---|
| 500px | Dramatic, close | Bold creative effects |
| 800-1000px | Moderate, natural | Card flips, panel rotations |
| 1500px+ | Subtle, distant | Gentle tilts, hover effects |

### Card flip

The classic two-sided card. Front and back are stacked, and the card rotates on Y axis to reveal the other side.

```css
.card-flip {
  perspective: 1000px;
}

.card-flip-inner {
  position: relative;
  transition: transform 500ms cubic-bezier(0.4, 0, 0.2, 1);
  transform-style: preserve-3d;
}

.card-flip--flipped .card-flip-inner {
  transform: rotateY(180deg);
}

.card-flip-front,
.card-flip-back {
  position: absolute;
  inset: 0;
  backface-visibility: hidden;
}

.card-flip-back {
  transform: rotateY(180deg);
}
```

**Secondary motion cues make 3D flips feel real:**

```css
/* Add lift and shadow during the flip */
.card-flip-inner {
  transition:
    transform 500ms cubic-bezier(0.4, 0, 0.2, 1),
    box-shadow 500ms cubic-bezier(0.4, 0, 0.2, 1);
}

.card-flip--flipped .card-flip-inner {
  transform: rotateY(180deg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
}
```

Without the shadow lift, the flip feels flat despite being "3D." The shadow sells the physicality.

### 3D tilt on hover

Subtle perspective tilt that responds to cursor position. Creates a "floating card" effect.

```js
function tiltCard(card, maxTilt = 8) {
  card.addEventListener("mousemove", (e) => {
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;

    card.style.transform = `
      perspective(800px)
      rotateY(${x * maxTilt}deg)
      rotateX(${-y * maxTilt}deg)
    `;
  });

  card.addEventListener("mouseleave", () => {
    card.style.transition = "transform 400ms cubic-bezier(0.2, 0, 0, 1)";
    card.style.transform = "perspective(800px) rotateY(0deg) rotateX(0deg)";
    setTimeout(() => (card.style.transition = ""), 400);
  });
}
```

### Framer Motion 3D flip

```jsx
function FlipCard({ isFlipped, front, back }) {
  return (
    <div style={{ perspective: 1000 }}>
      <motion.div
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{ duration: 0.5, ease: [0.4, 0, 0.2, 1] }}
        style={{ transformStyle: "preserve-3d", position: "relative" }}
      >
        <div style={{ backfaceVisibility: "hidden" }}>
          {front}
        </div>
        <motion.div
          style={{
            backfaceVisibility: "hidden",
            rotateY: 180,
            position: "absolute",
            inset: 0,
          }}
        >
          {back}
        </motion.div>
      </motion.div>
    </div>
  );
}
```

### 3D performance rules

- `transform-style: preserve-3d` creates a new stacking context and compositing layer. Use it only on the element that needs 3D children.
- `backface-visibility: hidden` is required on both sides of a flip card. Without it, the back face bleeds through.
- Avoid deep nesting of `preserve-3d`. Each nested 3D context increases compositing complexity.
- On mobile, reduce perspective and tilt angles. 3D transforms are more expensive on mobile GPUs.

### Reduced motion for 3D

3D motion is more likely to trigger vestibular discomfort than 2D. Replace rotations with crossfades.

```css
@media (prefers-reduced-motion: reduce) {
  .card-flip-inner {
    transition: opacity 200ms ease-out;
    transform: none !important;
  }

  .card-flip--flipped .card-flip-front {
    opacity: 0;
  }

  .card-flip--flipped .card-flip-back {
    opacity: 1;
    transform: none;
  }
}
```

---

## CSS Scroll-Driven Animations

Native browser API for tying animation progress to scroll position. No JavaScript scroll listeners needed.

### Fade-in on scroll

```css
.reveal {
  opacity: 0;
  transform: translateY(20px);
  animation: fade-up 1s ease-out forwards;
  animation-timeline: view();
  animation-range: entry 0% entry 30%;
}

@keyframes fade-up {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

### Scroll progress bar

```css
.progress-bar {
  transform-origin: left;
  transform: scaleX(0);
  animation: grow-bar linear forwards;
  animation-timeline: scroll();
}

@keyframes grow-bar {
  to { transform: scaleX(1); }
}
```

**Browser support note:** Scroll-driven animations have ~85% global support as of early 2026. Provide a fallback using Intersection Observer for browsers that do not support it.

---

## Framer Motion (React)

The most popular React animation library. Declarative API, spring physics, layout animations, gesture support.

### Basic entrance animation

```jsx
import { motion } from "motion/react";

function Card() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      {/* content */}
    </motion.div>
  );
}
```

### Spring animation

```jsx
<motion.div
  animate={{ scale: 1 }}
  whileHover={{ scale: 1.02 }}
  whileTap={{ scale: 0.97 }}
  transition={{
    type: "spring",
    stiffness: 400,
    damping: 25,
  }}
/>
```

Spring parameters:
- **stiffness** (100-1000): Higher = snappier. 400 is a good default.
- **damping** (10-100): Higher = less bounce. 25 gives slight overshoot. 40+ gives no overshoot.
- **mass** (0.1-3): Higher = heavier, slower to start/stop. 1 is default.

### Staggered list

```jsx
import { motion } from "motion/react";

const container = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.1,
    },
  },
};

const item = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.2, ease: "easeOut" },
  },
};

function List({ items }) {
  return (
    <motion.ul variants={container} initial="hidden" animate="visible">
      {items.map((i) => (
        <motion.li key={i.id} variants={item}>
          {i.content}
        </motion.li>
      ))}
    </motion.ul>
  );
}
```

### Layout animations with layoutId

Framer Motion's layout animation system is one of its most powerful features. When a `motion` component has a `layoutId`, it automatically animates between positions, sizes, and parents across renders. This is how you build spatial continuity without manually calculating positions.

#### Shared element transition (card to detail)

```jsx
// In the list view
<motion.div layoutId={`card-${id}`} transition={{ duration: 0.3, ease: "easeOut" }}>
  <img src={image} alt={alt} />
</motion.div>

// In the detail view — same layoutId, different position/size
<motion.div layoutId={`card-${id}`} transition={{ duration: 0.3, ease: "easeOut" }}>
  <img src={image} alt={alt} />
</motion.div>
```

Framer Motion automatically morphs between the two positions. No manual animation math needed.

#### Sliding pill / active indicator

The most common layoutId pattern in modern UI. The active indicator slides between items without animating each item individually.

```jsx
function Tabs({ tabs, activeTab, onSelect }) {
  return (
    <div className="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          className="tab"
        >
          {tab.id === activeTab && (
            <motion.div
              layoutId="active-pill"
              className="active-indicator"
              transition={{
                type: "spring",
                stiffness: 500,
                damping: 35,
              }}
            />
          )}
          <span className="tab-label">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
```

```css
.tab {
  position: relative;
  padding: 8px 16px;
}

.active-indicator {
  position: absolute;
  inset: 0;
  background: var(--color-active);
  border-radius: 8px;
  z-index: 0;
}

.tab-label {
  position: relative;
  z-index: 1;
}
```

The pill slides smoothly between whichever tab is active. The `layoutId` tells Framer Motion these are the same element across renders, so it interpolates position and size automatically.

#### Layout animation tips

- Use `layout` prop (without an ID) when an element needs to animate its own position/size changes within the same parent (e.g., reordering a list).
- Use `layoutId` when an element moves between different parents or mount/unmount cycles.
- Add `layout="position"` if you only want to animate position changes, not size. This prevents distortion on elements with border-radius.
- Wrap layout animations in `<LayoutGroup>` when you have multiple independent layout animation contexts that should not interfere with each other.

### AnimatePresence (exit animations)

```jsx
import { AnimatePresence, motion } from "motion/react";

function Modal({ isOpen }) {
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2 }}
        >
          {/* modal content */}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

### Respecting reduced motion

```jsx
import { useReducedMotion } from "motion/react";

function AnimatedComponent() {
  const shouldReduce = useReducedMotion();

  return (
    <motion.div
      initial={shouldReduce ? false : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={shouldReduce ? { duration: 0 } : { duration: 0.25 }}
    />
  );
}
```

---

## GSAP

The industry standard for complex timeline animation. Framework-agnostic. Most powerful sequencing engine available.

### Basic tween

```js
import gsap from "gsap";

gsap.to(".card", {
  y: 0,
  opacity: 1,
  duration: 0.3,
  ease: "power2.out",
});
```

### Timeline (sequenced animation)

```js
const tl = gsap.timeline();

tl.to(".backdrop", { opacity: 1, duration: 0.2 })
  .to(".modal", { scale: 1, opacity: 1, duration: 0.25, ease: "power2.out" }, "-=0.1")
  .to(".modal-content", { y: 0, opacity: 1, duration: 0.2 }, "-=0.05");
```

The third argument (`"-=0.1"`) is a position parameter. It tells GSAP to start this tween 0.1s before the previous one finishes. This creates the overlap that makes sequences feel fluid.

### Scroll-triggered animation

```js
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

gsap.from(".section-title", {
  y: 30,
  opacity: 0,
  duration: 0.5,
  ease: "power2.out",
  scrollTrigger: {
    trigger: ".section-title",
    start: "top 80%",
    once: true,
  },
});
```

### Staggered grid

```js
gsap.from(".grid-item", {
  y: 20,
  opacity: 0,
  duration: 0.3,
  ease: "power2.out",
  stagger: {
    amount: 0.4,
    grid: "auto",
    from: "start",
  },
});
```

### GSAP easing reference

| GSAP Ease | Equivalent | Use Case |
|---|---|---|
| `power1.out` | Gentle deceleration | Subtle movements |
| `power2.out` | Standard deceleration | Default for most UI |
| `power3.out` | Strong deceleration | Dramatic entrances |
| `power2.inOut` | Smooth both ways | On-screen repositioning |
| `back.out(1.4)` | Overshoot and settle | Playful, bouncy feel |
| `elastic.out(1, 0.5)` | Elastic bounce | Very playful, use sparingly |

---

## React Spring

Physics-based animation library. Springs feel more natural than duration-based animation because they simulate real physical behavior.

### Basic spring

```jsx
import { useSpring, animated } from "@react-spring/web";

function FadeIn({ children }) {
  const styles = useSpring({
    from: { opacity: 0, transform: "translateY(16px)" },
    to: { opacity: 1, transform: "translateY(0px)" },
    config: { tension: 280, friction: 24 },
  });

  return <animated.div style={styles}>{children}</animated.div>;
}
```

### Common spring presets

| Preset | Tension | Friction | Feel |
|---|---|---|---|
| Default | 170 | 26 | Balanced, general purpose |
| Gentle | 120 | 14 | Slow, soft settle |
| Wobbly | 180 | 12 | Bouncy, playful |
| Stiff | 210 | 20 | Quick, responsive |
| Molasses | 120 | 40 | Very slow, heavy |

---

## Lottie

For complex, designer-created animations exported from After Effects as JSON.

### React integration

```jsx
import Lottie from "lottie-react";
import successAnimation from "./success.json";

function SuccessState() {
  return (
    <Lottie
      animationData={successAnimation}
      loop={false}
      style={{ width: 120, height: 120 }}
    />
  );
}
```

### When to use Lottie

- Brand illustrations that need to animate (onboarding, empty states, celebrations)
- Complex motion that would be impractical to code by hand (particle effects, character animation)
- Animations created by motion designers in After Effects

### When not to use Lottie

- Simple UI transitions (use CSS or Framer Motion instead)
- Interactive animations that need to respond to user input (use Rive instead)
- Performance-critical contexts (Lottie files can be large; optimize with LottieFiles tools)

---

## Rive

Interactive, state-machine-driven animations. Smaller file sizes than Lottie. Built-in logic for interactive states.

### React integration

```jsx
import { useRive } from "@rive-app/react-canvas";

function InteractiveIcon() {
  const { RiveComponent, rive } = useRive({
    src: "/icon.riv",
    stateMachines: "main",
    autoplay: true,
  });

  return <RiveComponent style={{ width: 48, height: 48 }} />;
}
```

### When to use Rive

- Animated icons that change state (loading, success, error)
- Interactive illustrations that respond to hover, click, or scroll
- Animated toggles or controls with complex visual states
- When you need smaller file size than Lottie

---

## View Transitions API

Native browser API for animating between page states, including cross-document (MPA) transitions.

### Same-document transition

```js
document.startViewTransition(() => {
  updateDOM();
});
```

### Customizing the transition

```css
::view-transition-old(root) {
  animation: fade-out 200ms ease-in;
}

::view-transition-new(root) {
  animation: fade-in 300ms ease-out;
}
```

### Named transitions (shared element)

```css
.card-image {
  view-transition-name: hero-image;
}

::view-transition-old(hero-image) {
  animation: none;
}

::view-transition-new(hero-image) {
  animation: none;
}
```

When elements on different pages share the same `view-transition-name`, the browser automatically morphs between them during navigation.

**Browser support:** ~80% global support. Progressive enhancement is recommended; the page still works without it.

---

## Intersection Observer + CSS

Lightweight scroll-reveal pattern. No animation library needed.

### JavaScript

```js
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.2 }
);

document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
```

### CSS

```css
.reveal {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 400ms ease-out, transform 400ms ease-out;
}

.reveal.visible {
  opacity: 1;
  transform: translateY(0);
}

@media (prefers-reduced-motion: reduce) {
  .reveal {
    opacity: 1;
    transform: none;
    transition: none;
  }
}
```

This is the lightest-weight scroll reveal possible. Use it when you do not need a full animation library.
