VTID: VTID-04090
VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1 — A shared `makeClickable(el, handler, opts)` helper exists, extracting the existing hand-written keyboard-access pattern (`tabIndex=0` + `role="button"` + `onclick` + an `onkeydown` mirroring `onclick` on Enter/Space with `preventDefault()`).
TEST: services/gateway/test/command-hub/t10-r3-keyboard-clickable-rows.test.ts

AC-2 — Every `<tr>` element used as a click target with no prior keyboard equivalent (12 found by a static audit) is converted to use `makeClickable()`, each with a real `aria-label` describing what it opens.
TEST: services/gateway/test/command-hub/t10-r3-keyboard-clickable-rows.test.ts

AC-3 — No other behavior change: the click behavior of every converted row is byte-for-byte the same handler, just also reachable by keyboard. Full Command Hub regression sweep unchanged.
TEST: services/gateway/test/command-hub/ full suite

AC-4 — Cache-bust bumped on both `styles.css` and `app.js` tags together.
TEST: services/gateway/test/command-hub/t10-r3-keyboard-clickable-rows.test.ts (index.html unaffected by content, verified by the full suite's existing cache-bust-pair assertions)

AC-5 — `tsc --noEmit` and `npm run build` both clean.
TEST: commands.log (both commands run, zero errors)

## Route Mount Evidence

Not applicable — this VTID adds zero routes. It only edits
`services/gateway/src/frontend/command-hub/app.js` (a new helper function
plus 12 call-site conversions) and `index.html` (cache-bust). No new
`router.<verb>(...)` registration is added anywhere in this diff.

## Scope note

A static audit found ~74 div/tr/span click-target candidates missing a
keyboard equivalent. This VTID scopes to the 12 `<tr>` rows — the clearest,
most unambiguous case (a table row that opens a detail drawer/view). The
remaining ~60 candidates are mostly modal/overlay backdrop click-to-dismiss
handlers (not real interactive controls needing Enter/Space activation —
Escape-to-close is the correct keyboard pattern there, which is Region 4's
territory: modal/drawer focus management) plus a long tail of card/chip/item
elements across many different rendering contexts that would need individual
visual verification per site to convert safely in one pass. Deferred as a
named follow-up rather than rushed into one large, harder-to-review PR.

See commands.log for the exact commands run.
