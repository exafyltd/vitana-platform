# VTID-04205 — Acceptance

The Operator Console's per-turn cost/model badge
(`services/gateway/src/frontend/command-hub/app.js`) shows an estimated
dollar figure derived from list prices (`MODEL_COSTS`/`estimateCost` in
`services/gateway/src/constants/llm-defaults.ts`, per VTID-04031's own
CHANGE LOG entry: "Rates are list prices, an estimate"). That caveat was
documented in this repo's own history but never surfaced to the person
actually looking at the badge — the tooltip (`describeTurnCost()`, shown
via `badge.title` on hover, per VTID-04031's wiring) said only "Est. cost:
$X.XXXXXX" with no note that it is not exact billing.

## Fix

`describeTurnCost()` now appends one more line — `(estimate — list
prices, not exact billing)` — immediately after the cost line, but only
when a real cost was actually shown (`meta.cost_priced !== false`; an
unpriced model's "Cost: model not in the price table" line needs no
estimate caveat, since there is no dollar figure to caveat). The visible
badge text (`formatTurnCostBadge()`) and its layout are completely
unchanged — only the hover tooltip gained the note.

## Acceptance criteria

AC-1: the cost badge now includes a visible note or tooltip stating the
cost is an estimate based on list prices, not exact billing.
TEST: `services/gateway/test/vtid-04205-cost-badge-tooltip-estimate.test.ts`
— "appends the estimate note after a priced cost line" and "the note sits
inside the same meta.usage guard as the cost line, never on its own".

AC-2: no other badge content or layout is changed.
TEST: same file — "does NOT change the visible badge text function or its
layout" (asserts `formatTurnCostBadge()`'s body contains neither
"estimate" nor "list price", and still joins its parts the same way).

## Command Hub ownership guard

`scripts/ci/command-hub-ownership-guard.js` requires every PR touching
`services/gateway/src/frontend/command-hub/**` to carry either a
`DEV-COMHU-*` marker or a VTID already present in its hardcoded
`ALLOWED_VTID_PATTERN` allowlist, in the branch name or PR title — read in
full before editing anything, since a PR without one would fail CI
outright regardless of how correct the change itself is. `VTID-04205` has
been added to that pattern (prepended) and a short changelog-style comment
entry added to the file's own header, matching every prior Command-Hub-
touching VTID's convention there. Pinned by two new tests exercising the
guard's own exported `evaluateMarkerAuthorization()` directly (by branch
name and by PR title) rather than trusting the regex edit by inspection
alone.

## Verification

`node --check` on `app.js` — clean. `tsc --noEmit` clean (no `.ts` source
touched by the core fix; the guard script is plain Node.js, syntax-checked
the same way).

Own suite: 7/7 tests passing, against the real `app.js` source text and
the real, unmocked `evaluateMarkerAuthorization()`.

Cache-bust: `app.js`/`styles.css` version bumped together to
`20260920-vtid-04205-cost-badge-tooltip-estimate` in `index.html`, per this
repo's own "always bump these version strings when making frontend
changes" rule — even though `styles.css` itself has no content change, per
the established convention that both are always bumped together (the
`INDEX_HTML` version string is shared between them).

Regression sweep — every test file exercising the touched functions, the
ownership guard, or a sibling Command Hub cache-bust/allowlist pattern:
`vtid-04031-operator-turn-cost.test.ts`,
`scripts/command-hub-ownership-guard.test.ts`,
`vtid-03947-message-copy-timestamp.test.ts`,
`vtid-04033-operator-execution-follow.test.ts`,
`vtid-04104-operator-follow-persist.test.ts`,
`vtid-04106-operator-chat-stick-to-bottom.test.ts`,
`vtid-04110-operator-console-flicker-fullscreen-persist.test.ts`,
`vtid-04136-single-format-relative-time.test.ts`, plus the new file — 9
suites, 78 tests, 0 failures.

## Not done here

- No live/Playwright screenshot verification — this environment has no
  deployed staging build carrying this change to point a browser at (the
  PR is unmerged), and the change is a one-line addition to a native HTML
  `title` attribute's text (a tooltip shown on hover), not a layout or
  visual change; the source-level test suite is the verification this
  repo's own established pattern uses for exactly this class of change
  (see e.g. VTID-04031/VTID-04033's own "visually verified on a local
  harness" vs. plain source-test entries in CLAUDE.md's CHANGE LOG,
  depending on whether the change was visual/layout or textual).
- Did not touch `formatTurnCostBadge()` (the visible badge text) at all —
  confirmed by the "does NOT change..." test above.

OASIS_IMPACT: no — this is a client-side string/text change in the
Command Hub's static frontend bundle; it emits no OASIS events and
changes no gateway route or schema.
