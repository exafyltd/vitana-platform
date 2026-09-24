# VTID-04416 — Conversation rebuild WS-1.4: every greeting decision goes through the brain entry point

This is Plan v1 (Conversation Intelligence Rebuild), Phase 1, workstream WS-1.4.
It ships in PR #3614 as a companion to VTID-04339.

## What was wrong

`decideConversationFlow` is documented as "the single place a conversation decision is made". In production nothing called it.

`routes/orb-live.ts` calls `computeGreetingDecision` directly in five places:

- the safe-fast opening (`_sfDecision`);
- the new-session opening (`_decisionNS`);
- its fallback (`_fallbackNS`);
- the recovery path (`_recoverNS`);
- the sync ladder (`_syncDecision`).

So the brain entry point was a seam with no traffic through it, and later decision work (WS-2.x) had no single place to change.

## Fix (behaviour-identical by construction)

- **`ConversationDecision` gains `greeting`:** the full `GreetingDecision` the transport renders today.
- **New `decideOpeningFlow(ctx, { transport, role })`** in `services/conversation/decide-conversation-flow.ts`. It calls `decideConversationFlow`, returns `.greeting`, and is the same object `computeGreetingDecision` returns.
- **All five call sites in `orb-live.ts`** call `decideOpeningFlow(..., { transport: 'vertex', role: session.active_role ?? null })`. `computeGreetingDecision` is imported there only as a type.
- **Nothing else changes.** The rendering code, the effects and the diag are untouched.

## Acceptance criteria

AC-1: For every golden rung context, `decideOpeningFlow` returns an object deep-equal to `computeGreetingDecision`, and `decideConversationFlow(...).greeting` equals it too; the existing byte-equality suite for the mapped fields still passes.
TEST: services/gateway/test/services/conversation/decide-conversation-flow.test.ts

AC-2: `orb-live.ts` has no `computeGreetingDecision(` call left; all five decision variables are assigned from `decideOpeningFlow(`.
TEST: services/gateway/test/services/conversation/decide-conversation-flow.test.ts, services/gateway/test/orb/live/characterization/vertex-safe-fast-ladder.characterization.test.ts

AC-3: The golden snapshot and characterization suites pass unchanged apart from the one call-name assertion; tsc clean.
TEST: services/gateway/test/services/conversation, services/gateway/test/orb

AC-4 (post-deploy, staging): greeting telemetry (`orb.live.diag` `greeting_sent`, `wake_opener` distribution) shows no shift against the week before the deploy.
CURL: curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/alive

## Not verified live

- **Not deployed.** The change is proven identical by the tests, not by traffic.
