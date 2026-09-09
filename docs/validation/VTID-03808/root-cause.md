# VTID-03808 — root cause

## Report

> I cannot close the Orb when Vitana is teaching, providing guided-topic
> content. It should be enabled!

Asked what pressing the X actually does, the platform owner answered:
**"Nothing at all happens."** Not a slow close, not audio continuing after the
overlay went away — the tap is simply ignored.

## What it is NOT

Ruled out before looking further, by reading the shipped source:

- The close button is **not** disabled or conditionally rendered. It is created
  unconditionally in `_ensureRoot()` and wired with
  `closeBtn.addEventListener('click', _hide)`. There is no `disabled`, no
  guided-topic gate, no `opacity`/`display` toggle on it anywhere.
- `_hide()` is **not** failing partway. Every call in it that could throw
  (`clearInterval`, `_sessionStop`, `onClose`) is individually try/catch'd, and
  it stops scheduled audio synchronously before any network teardown — that was
  VTID-03295's fix for an earlier, different "un-closeable" report.
- The auras that sit over the orb are already `pointer-events:none`, so they do
  not intercept.

So the handler was never the problem. Nothing reaches it.

## Root cause

**The overlay is `pointer-events: none` for the entire lesson, inherited from
`document.body`, because a modal drawer is open behind it.**

`GuidedJourneyCatalog` (vitana-v1) starts a lesson like this — both entry
points, `handleTopicClick` (a topic) and `handleSessionClick` (a session):

```ts
activateOrb(topic.topicId);   // -> VitanaOrb overlay, appended to document.body
...
setOpenTopic(topic);          // -> <Drawer open>, vaul, modal by DEFAULT
```

The drawer is opened *immediately after* the ORB and stays open for the whole
lesson — it is the post-listen explanation panel, deliberately parked behind the
overlay.

vaul's modal mode uses `react-remove-scroll`, which injects (verbatim, from
`react-remove-scroll/dist/es2015/SideEffect.js`):

```css
.block-interactivity-<id> { pointer-events: none; }   /* applied to document.body */
.allow-interactivity-<id> { pointer-events: all;  }   /* applied to the drawer only */
```

The ORB widget's `_root` is appended to `document.body`, **outside** the
drawer's portal, so it is inside the blocked subtree and outside the allowed
one. `pointer-events` is inherited, so the overlay and everything in it — the X,
the mic button, the orb itself — become invisible to hit-testing. The browser
discards the tap before any listener is consulted.

That is why the symptom is *nothing at all*, and why it is specific to guided
topics: this is the only flow that holds a modal dialog open behind the ORB.

### Proved in a real browser, not inferred

jsdom does not implement `pointer-events` hit-testing, so this cannot be
asserted in a unit test. `outputs/pointer-events-hit-test.txt` is a real
Chromium run that reproduces `react-remove-scroll`'s exact CSS and asks the
browser via `document.elementFromPoint`:

| | computed `pointer-events` on the X | element at the X's centre | close handler ran |
|---|---|---|---|
| **before** | `none` | `HTML` | **false** |
| **after** | `auto` | `close` | **true** |

Before the fix the browser does not even report the button as present at its own
coordinates. That is the report, reproduced.

## Fix

`pointer-events:auto` on the ORB overlay root. A descendant may opt back in even
under an ancestor set to `none` — the same escape Radix's own dialog overlay
uses (`pointerEvents: "auto"` in `@radix-ui/react-dialog`).

One declaration, no behavioural branch, no new state. The overlay is a
top-level surface of its own and should be interactive regardless of what is
mounted behind it.

## Rejected alternatives

- **Make the drawer non-modal** (`modal={false}`) — would drop its focus trap
  and scroll lock for every other consumer of that primitive, to fix a problem
  that belongs to the overlay.
- **Close the drawer before activating the ORB** — the drawer is deliberately
  the post-listen summary; closing it would change the flow the product wants,
  and the ORB would still be unclickable behind any *other* modal.

## How long this has been broken

The `activateOrb(...)` → `setOpenTopic(...)` ordering is VTID-03291-era, so this
has been live since guided topics existed. It is plausibly part of what the very
first report in this chain meant by *"you cannot stop it at any point, close
button doesn't work"* — that was attributed at the time to the replay loop
(VTID-03799), which was real and is fixed, but this is a second, independent
cause that was never found because the loop explained the same words.

## Not verified

That the X now closes on a real device mid-lesson. The mechanism is proved in
Chromium and the deployed bytes can be confirmed by grep, but the end-to-end tap
needs a human — and crediting a completion still writes journey progress for the
account, which `vitana-v1`'s absolute rule forbids on every host.
