# VTID-03910 — Operator fullscreen: symmetric edge spacing + scrollable content

Companion work in the same PR, own VTID, own acceptance criteria below:
**VTID-03911** (mic active/red state CSS-specificity fix).

## Report

User report (verbatim, from the Command Hub, after trying the VTID-03908
fullscreen toggle live): "what a terrible full-screen layout you have
built. There is absolutely no space on the bottom, top, left, or right
edges. Everything is going all the way to the frame edge... The scrolling
is missing... Move things more centered and create some symmetrical space
on the left, right, bottom, and top. Maybe move it 2 cm inside." Also:
"when I press the microphone, it should turn red... When I press the
microphone again, it turns off the color."

## Root causes

1. **Zero edge spacing.** `.operator-overlay--fullscreen` set
   `width/height: 100vw/100vh` — literally the full viewport, filling the
   `.overlay-backdrop` flex container completely and leaving no gap for
   its own `align-items:center`/`justify-content:center` to create.
2. **No scrolling.** `.overlay-panel`, `.operator-tab-content` and
   `.chat-container` are all `display:flex; flex-direction:column;` with a
   flexed child inside — a flex column child defaults to `min-height:auto`,
   which lets it grow past its own container instead of shrinking to the
   available space, defeating the `overflow-y:auto` declared further down
   the chain (`.chat-messages`/`.ticker-container`/`.history-content`)
   before it ever gets a chance to engage. Additionally `.chat-messages`
   had a fixed `max-height:65vh` tuned for the original ~80vh popup, which
   left a large dead gap (not a broken layout, but wasted space) once the
   panel was much taller in fullscreen.
3. **Mic never visibly turns red** — see VTID-03911 below; found via a
   local Playwright harness (`docs/validation/VTID-03910/outputs/*.png`),
   not guessed.

## Acceptance Criteria

AC-1 — `.operator-overlay--fullscreen` insets the panel by a real `2cm` on
every side (`calc(100vw - 4cm)` / `calc(100vh - 4cm)`) instead of true
100vw/100vh; `.overlay-backdrop`'s existing flex centering then spaces it
symmetrically on all four sides with no additional centering code needed.
A narrower `max-width:768px` breakpoint uses a smaller `1.5rem` inset
instead of the flat 2cm, since 2cm eats too much of a narrow viewport
(confirmed visually — the chat input row's textarea wrapped vertically at
390px width before this breakpoint was added).

TEST: `outputs/jest-new-suite.txt` — "VTID-03910" block, cases 1-3.

UI: `outputs/1-normal.png` (baseline popup), `outputs/2-fullscreen.png`
(symmetric inset confirmed at 1400×900), `outputs/6-mobile-fullscreen.png`
(390×844, smaller inset via the mobile breakpoint) — captured via a local
static harness that loads the real `styles.css` and mirrors the exact
class structure `renderOperatorOverlay()`/`renderOperatorChat()` produce
(this session has no live authenticated Command Hub browser session to
reach `preview-aws-gateway.vitanaland.com` directly).

AC-2 — the flex chain from `.overlay-panel` down through
`.operator-tab-content` and `.chat-container` sets `min-height: 0` so the
deeper `overflow-y:auto` containers (`.chat-messages`, `.ticker-container`,
`.history-content`) can actually shrink to the available space and scroll,
instead of the flex column growing past its bounds. `.chat-messages` also
drops its fixed `65vh` cap specifically in fullscreen mode
(`.operator-overlay--fullscreen .chat-messages { max-height: none; }`) so
it fills the taller available space instead of leaving a dead gap.

TEST: `outputs/jest-new-suite.txt` — "VTID-03910" block, cases 4-5.

UI: `outputs/3-fullscreen-scrolled.png` — the harness renders 40 message
rows (enough to overflow any reasonable viewport) and programmatically
scrolls `.chat-messages` to its bottom; the screenshot shows message row
#39 fully visible at the bottom, proving the scroll actually engages and
reaches the end of the content, with the fullscreen panel's own height
correctly filling the taller inset region rather than clipping short.

## VTID-03911 — mic active/red state CSS specificity bug

User request (verbatim): "when I press the microphone, it should turn red
so I visually see that the microphone is active. When I press the
microphone again, it turns off the color."

The JS toggle (`state.chatDictationActive` + `.chat-mic-btn--active` class
add/remove on click) was already correct and unit-tested since VTID-03907.
The real defect is CSS: `.chat-mic-btn:hover:not(:disabled)` has
specificity `(0,3,0)` (one class + two pseudo-classes — `:not()` counts
its argument's own specificity), which beats a bare `.chat-mic-btn--active`
at `(0,1,0)`. Since the mouse cursor stays on the button after a real
click (the normal case), the neutral hover style silently won and the
button never visibly turned red — confirmed directly by reading the
button's own `getComputedStyle()` in a Playwright harness (`bg:
rgba(255,255,255,0.05)`, `border: rgb(148,163,184)` — the hover colors —
even though `className` correctly showed `chat-mic-btn chat-mic-btn--active`
at the same moment).

AC-3 — `.chat-mic-btn--active`'s selector list now also explicitly matches
`.chat-mic-btn--active:hover:not(:disabled)`, so the active/red styling
wins (or at least ties on specificity with a later source-order win) over
the plain hover rule, both at rest and while hovered.

TEST: `outputs/jest-new-suite.txt` — "VTID-03911" case in the VTID-03907
describe block.

UI: `outputs/4-mic-active.png` / `outputs/7-mic-zoom.png` (red, confirmed
via `getComputedStyle` returning `rgb(239, 68, 68)` for border/color while
the harness's simulated cursor is still resting on the button, matching
the real-world click-then-hover sequence) and `outputs/5-mic-neutral.png`
(back to neutral after a second click) — same harness as VTID-03910.

## OASIS impact

OASIS_IMPACT: no — client-side layout/CSS fix only.
