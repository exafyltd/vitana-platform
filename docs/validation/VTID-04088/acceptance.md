# VTID-04088 — Acceptance: T10 accessibility region 1 (live regions)

## Context

First of 4 accessibility regions in the Command Hub cleanup program
(CLAUDE.md §"Always maintain WCAG 2.2 AA compliance"). A prior research
pass (grep audit across `app.js`, `index.html`, `orb-widget.js`, etc.)
found `aria-live` used **zero** times anywhere in the Command Hub's
runtime JS, and identified the toast notification container as the
single most concentrated, highest-value, lowest-risk fix: `showToast()`
pushes to `state.toasts` and triggers a re-render, but nothing in the DOM
change is marked as a live region, so a screen-reader user gets no
announcement when a toast (success/error/info) appears.

The same audit flagged two `status-dot`-class color-only indicator
candidates for closer inspection. Both were checked directly against the
surrounding code and found to already be text-backed (not color-only):

- `heartbeat-status-dot` (`app.js`, `statusDot`) sits immediately next to
  a `statusText` span rendering the same state as text ("Standby").
- `deploy-status-dot` (`app.js`, `depDot`) sits immediately next to a
  `depStatusEl` span whose `textContent` is `dep.status`.

No change was needed for either — this region is scoped to the toast
container only, per the audit's "false-positive risk" note.

## Acceptance Criteria

AC-1 — `renderToastContainer()`'s container element gets `role="status"`
and `aria-live="polite"` (not `assertive` — an error toast must not
interrupt whatever the user is already being told), set before any
individual toast element is appended.
TEST: services/gateway/test/command-hub/t10-r1-toast-aria-live.test.ts —
  "renderToastContainer() sets role="status" and aria-live="polite" on
  the container"; "the live-region attributes are set on the container
  itself, before any toast is appended"; "uses "polite", not
  "assertive" — an error toast must not interrupt"

AC-2 — No change to toast content, close-button behavior, styling, or
`showToast()`'s own logic — this region is additive attributes only.
Verified by re-running the full `test/command-hub/` suite unmodified
(10 suites / 162 tests, all pre-existing tests pass unchanged).

AC-3 — `index.html`'s cache-bust bumped on both `styles.css` and
`app.js` together, per CLAUDE.md §16.
TEST: existing suites that assert the cache-bust pair stays in sync
  (e.g. t6-dead-cloudflare-redirect-removed.test.ts) re-run green
  against the new value.

AC-4 — Compiles and builds cleanly.
TEST: `tsc --noEmit` (services/gateway) — 0 errors.
TEST: `npm run build` (services/gateway) — exit 0.

## Not done / explicitly out of scope

- Icon-only `aria-label`s (close buttons, refresh/toggle icons),
  `<label for=>` wiring — region 2.
- Keyboard access for custom `div`/`tr`/`span`-as-button click targets
  (`createOasisEventRow`, pipeline rows, cards/chips/pills) — region 3.
- Modal/drawer focus management (Escape-to-close, focus trap, focus
  return) — region 4.
- Heading-hierarchy review — flagged by the audit as not mechanically
  fixable; folded into whichever region's PR happens to touch a given
  view, not a fifth pass.
- Not verified live on staging or with a screen reader — this session
  has no reachable gateway or assistive-tech tooling. The next real
  signal is a manual VoiceOver/NVDA pass against the Command Hub once
  deployed, or a future Playwright+axe smoke suite (flagged by the audit
  as a good follow-on, not built here).
