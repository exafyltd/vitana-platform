# VTID-03808 — acceptance

Suite: `services/gateway/test/frontend/orb-overlay-pointer-events.test.ts` (4 new)
Behavioural proof: `outputs/pointer-events-hit-test.txt` (real Chromium, real hit-testing)

---

AC-1 — The ORB overlay root declares `pointer-events:auto`, so it stays hit-testable under a `pointer-events:none` ancestor.
TEST: orb-overlay-pointer-events.test.ts — "declares pointer-events:auto on the overlay root"

AC-2 — The declaration is on the ROOT (the element that covers the viewport), not on some inner node that would leave the backdrop dead.
TEST: orb-overlay-pointer-events.test.ts — "declares it on the ROOT, not on an inner element"

AC-3 — The close button remains wired unconditionally; the handler was never the defect and must not acquire a guard.
TEST: orb-overlay-pointer-events.test.ts — "keeps the close button wired unconditionally — it was never disabled"

AC-4 — Overlay interactivity is not conditional on any guided-topic state; closing during teaching is identical to closing at any other time.
TEST: orb-overlay-pointer-events.test.ts — "does not gate the overlay on any guided-topic state"

AC-5 — With `react-remove-scroll`'s modal CSS applied to `document.body`, the browser reports the close button as absent at its own coordinates and the handler never fires — the reported symptom, reproduced.
UI: outputs/pointer-events-hit-test.txt — BEFORE row: computed `none`, `elementFromPoint` → `HTML`, handler ran `false`

AC-6 — With the fix, the same page yields the button at its own coordinates and the handler runs.
UI: outputs/pointer-events-hit-test.txt — AFTER row: computed `auto`, `elementFromPoint` → `close`, handler ran `true`

---

## Why the behavioural proof carries the weight here

The widget is a plain IIFE with no export surface, so its suites are static
source checks. A string match confirms the declaration is *present*; it cannot
confirm the browser *honours* it, and this whole defect lives in inherited CSS
that jsdom does not implement (`pointer-events` hit-testing is not in jsdom).

That gap is not hypothetical — earlier in this same chain a static-only suite
asserted a fire site existed while nothing populated `_cfg`, and the defect
shipped. So AC-5/AC-6 are a real Chromium run driving `document.elementFromPoint`
against `react-remove-scroll`'s verbatim injected CSS, and the probe is kept
(`outputs/pointer-events-hit-test.probe.mjs`) so it can be re-run rather than
trusted.

The probe is self-contained: no gateway call, no ORB session, no auth, no
writes. Safe against any host.

## Full run

- Gateway suite: **735/736 suites** (1 pre-existing skip), **13,656 passing, 0 failures** — `outputs/jest-full-suite.txt`
- `tsc --noEmit`: clean — `outputs/tsc.txt`
- `node --check orb-widget.js`: parses

## Not covered

The real tap on a real device mid-lesson. Mechanism and fix are proved in
Chromium; end-to-end confirmation needs a human, and the completion path it
would exercise writes journey progress for the account, which `vitana-v1`'s
absolute rule forbids on every host.
