# VTID-04258 — Acceptance

## Context

Live, repeatedly-reported bug: Vitana offers to navigate somewhere, the user
confirms ("yes, do it"), and the session drops to listening mode instead of
navigating. Root cause: a Nova Sonic tool-calling compliance gap — the
model verbally commits to calling `navigate`/`navigate_to_screen` but does
not always actually emit the tool call. A deterministic, already-built,
already-unit-tested backstop for exactly this shape
(`services/gateway/src/services/assistant-continuation/acceptance-gate.ts`,
wired into `upstream-message-handler.ts`'s `handleTurnComplete`) exists but
was never activated: no deploy workflow ever set the
`NAV_CONTINUATION_BIND=true` env var it's gated behind.

This PR is a scoped env-activation fix: pin the flag on the two gateway
deploy workflows. No application logic changes.

## Acceptance Criteria

AC-1: `AWS-STAGE-DEPLOY-GATEWAY.yml` pins `NAV_CONTINUATION_BIND=true` via
the established strip-then-add jq pattern, so it survives every staging
deploy rather than depending on whatever the inherited task definition
happened to carry.
TEST: services/gateway/test/vtid-04258-nav-continuation-bind-flag-pinned.test.ts
  ("staging: upserts the flag as exact string \"true\"",
   "staging: strips the inherited value first, so a stale one cannot survive")

AC-2: `AWS-PROD-DEPLOY-GATEWAY.yml` declares `NAV_CONTINUATION_BIND=true`
the same way, following the established "declared, not dispatched" posture
this repo uses for prod-parity flags (e.g. VTID-04230) — the block runs on
every prod dispatch but changes nothing on production until an owner
actually dispatches the workflow (IF-THEN 26 / staging-first governance).
TEST: services/gateway/test/vtid-04258-nav-continuation-bind-flag-pinned.test.ts
  ("prod: upserts the flag as exact string \"true\", declared not dispatched",
   "prod: strips the inherited value before re-adding it, in that order")

AC-3: The new prod jq block is syntactically well-formed (balanced
parentheses) — a hand-written jq snippet is exactly the shape that has
broken this repo's CI silently before (VTID-03505, VTID-03549).
TEST: services/gateway/test/vtid-04258-nav-continuation-bind-flag-pinned.test.ts
  ("the pinned jq block on prod has balanced parens (no stray paren the shell would choke on)")

## Out of scope (flagged, not silently dropped)

`acceptance-gate.ts`'s own doc comment notes its `pending_cta` producers
today are the wake-brief opener layer (`wake-brief-wiring.ts`) and the
`navigate` tool's own ambiguous-disambiguation branch
(`orb-tools-shared.ts`). A purely spontaneous mid-conversation offer made
in free text outside those two paths still has no `pending_cta` captured
and still depends on the model calling the tool. Extending capture to
arbitrary mid-conversation offers is a larger, separate change and is not
attempted in this PR.

## Verification not run from this session

No live AWS/gateway access from this Claude Code session. The real
end-to-end signal is the next "yes, do it" confirmation on staging actually
triggering `orb_directive: navigate_to_screen` via the acceptance-gate path.
