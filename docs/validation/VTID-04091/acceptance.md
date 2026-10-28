VTID: VTID-04091
VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1 — A shared `attachModalA11y(panel, opts)` helper exists: gives the panel `tabIndex=-1`, moves focus into it once nothing is meaningfully focused (deferred one tick so the caller's synchronous DOM append completes first), traps Tab between its first/last visible focusable descendant, and calls `opts.onClose` on Escape.
TEST: services/gateway/test/command-hub/t10-r4-modal-focus-management.test.ts

AC-2 — Every `.focus()` call inside the helper passes `preventScroll: true`, so a background-polling re-render of a scroll-retained panel cannot hijack the user's scroll position.
TEST: services/gateway/test/command-hub/t10-r4-modal-focus-management.test.ts

AC-3 — 9 overlay/drawer/modal render functions are wired to `attachModalA11y()`, each with an `onClose` matching its existing close-button/backdrop-click state reset: renderHeartbeatOverlay, renderPublishModal, renderAutopilotRecommendationsModal, renderGovernanceBlockedModal, renderExecutionApprovalModal, renderGovernanceRuleDetailDrawer, renderOasisEventDrawer, renderOasisVtidLedgerDrawer, openAiAssistantDrawer.
TEST: services/gateway/test/command-hub/t10-r4-modal-focus-management.test.ts

AC-4 — renderOperatorOverlay (streaming chat) and renderTaskDrawer (live execution-status polling) are deliberately NOT converted this pass — real risk of the new focus-management fighting frequent re-renders in exactly those two views. Flagged as a named follow-up.
TEST: services/gateway/test/command-hub/t10-r4-modal-focus-management.test.ts

AC-5 — No other behavior change: full Command Hub regression sweep unchanged.
TEST: services/gateway/test/command-hub/ full suite

AC-6 — Cache-bust bumped on both `styles.css` and `app.js` tags together.
TEST: services/gateway/test/command-hub/t10-r4-modal-focus-management.test.ts (index.html unaffected by content; verified by the full suite's existing cache-bust-pair assertions)

AC-7 — `tsc --noEmit` and `npm run build` both clean.
TEST: commands.log (both commands run, zero errors)

## Route Mount Evidence

Not applicable — this VTID adds zero routes. It only edits
`services/gateway/src/frontend/command-hub/app.js` (a new helper function
plus 9 call-site conversions) and `index.html` (cache-bust). No new
`router.<verb>(...)` registration is added anywhere in this diff.

## Scope note

This app has no component mount/unmount lifecycle — `renderApp()` tears
down and rebuilds whatever is open on every call. Three risk mitigations
were applied specifically because of that: (1) initial focus is deferred
via `setTimeout(fn, 0)` since the panel isn't in the document yet at the
point the render function returns it; (2) focus is only moved when
`document.activeElement` is `<body>`/`null` — the reliable signal this
architecture gives for "focus needs to be re-placed" without a lifecycle
hook, so a re-render can never steal focus from something the user is
actively using; (3) every `.focus()` call passes `preventScroll: true`,
since several of the converted panels are periodically rebuilt by
background polling while open (`dataset.scrollRetain` is this codebase's
own marker for exactly that) and a default `.focus()` call would otherwise
fight the existing scroll-retention guard. `renderOperatorOverlay`
(streaming chat, re-renders on every token) and `renderTaskDrawer`
(embeds `renderTaskExecutionStatus`, a live-polling child) were judged too
high-risk to convert in the same pass without deeper tracing of their
render cadence — named as an explicit follow-up rather than silently
skipped.

See commands.log for the exact commands run.
