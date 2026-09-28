# VTID-04671 — Autopilot recommendations P6: a card that shows why

Plan: `docs/AUTOPILOT-RECOMMENDATION-QUALITY-PLAN.md` §4 P6. Builds on P2
(VTID-04668, priority score), P3 (VTID-04669, quality review) and P5
(VTID-04670, dismiss reasons).

## Why

The Pending Approvals card showed a constant `Impact 6/10 · Effort 5/10`
for every recommendation, gave no reason to trust or doubt it, and Dismiss
recorded no reason. After Activate the card vanished, so the operator could
not see whether anything ran.

## Fix (Command Hub only: app.js, styles.css, index.html)

- Impact/Effort is replaced by an `Executable` / `Needs a person` badge, then
  priority, value, confidence, success odds and expected cost (USD and
  tokens), all read from `quality` (P2). The executable list is the P4
  mirror `MANUALLY_BRIDGEABLE_SOURCE_TYPES`, not a second copy.
- A collapsible **Why** section renders the P3 review: the problem, the
  evidence, the files with their risk, the acceptance criteria and why now.
  All text goes through `textContent`. A scored row without a kept review
  shows an "awaiting quality review" note.
- The popup footer reports `below_floor_count` and `awaiting_review_count`
  from the listing.
- **Dismiss** opens a reason picker with the six P5 codes (not a real
  problem, not worth it, duplicate, already fixed, wrong fix proposed,
  other) and an optional note (≤ 300 chars). It posts `reason_code` +
  `reason`. The Overview card uses the same picker.
- After Activate, a queued execution keeps the card and follows the existing
  per-execution SSE tail (VTID-03897). Closing the popup closes the streams
  and resets the modal flag.
- CSS classes only (no inline styles; CSP gate). Cache-bust bumped to
  `20261017-vtid-04671`. VTID-04671 added to the ownership guard.

## Acceptance criteria

AC-1: The card shows the badge, priority, value, confidence, success odds and expected cost; no Impact/Effort line.
TEST: services/gateway/test/vtid-04671-recommendation-card.test.ts

AC-2: Why renders the review (problem, evidence, files + risk, acceptance, why now) through textContent; an unreviewed card shows the awaiting note.
TEST: services/gateway/test/vtid-04671-recommendation-card.test.ts

AC-3: The footer reports below-floor and awaiting-review counts.
TEST: services/gateway/test/vtid-04671-recommendation-card.test.ts

AC-4: Dismiss opens the six-code picker and posts reason_code + reason (note ≤ 300); the Overview card uses the same picker.
TEST: services/gateway/test/vtid-04671-recommendation-card.test.ts

AC-5: A queued Activate keeps the card and follows the SSE tail; closing the popup closes the streams.
TEST: services/gateway/test/vtid-04671-recommendation-card.test.ts

AC-6: No inline styles; cache-bust bumped; ownership guard allows VTID-04671.
TEST: services/gateway/test/vtid-04671-recommendation-card.test.ts

## Existing test changed (contract changed on purpose)

`test/vtid-04667-executable-source-types-drift.test.ts` pinned the exact
cache-bust string `20261016-vtid-04667`. It now asserts at-or-after
20261016, the form used by other cache-bust pins, because this change bumps
the string again.

## Visual verification

A local harness (`outputs/harness-server.js` serves the working tree's
statics with stubbed APIs; `outputs/harness-shoot.js` drives Chromium). No
live system was called. Screenshots at 1400×900 and 390×844:
`p6-modal-*`, `p6-why-*`, `p6-dismiss-picker-*`, `p6-activated-live-*`.
Checked: text is readable and not clipped, there is no horizontal overflow on
mobile, and the picker and the live execution render.

## Not verified live

No staging render: the card needs reviewed rows (P3), which only exist after
P3 has run on staging. The staging suite checks the static assets are
served; the behaviour is proven by the suite above.
