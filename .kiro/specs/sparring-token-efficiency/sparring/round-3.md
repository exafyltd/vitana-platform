# Sparring round 3 — escalated

Session: `b2df0328-27f7-43fe-bee5-2d6ba8866cb2` · plan hash `71acdb7cfbf0016db67a6af91b7a5d524864a9708520e80e0b4cc2c2b44c4a0f`

## Summary

The revision correctly addresses R2-F1 (LLMTelemetryPayload type) and all previously accepted R1 findings (R1-F2 call-site update, R1-F3 exported constant, R1-F4 throttle note). One new major finding: T-d leaves the critical `completeLLMCallDetached` call-site (the exact mechanism R1-F2 targeted) without a spy assertion, so an implementer who correctly populates `result.usage` but forgets to spread the cache fields into the void call passes all tests while silently dropping cache tokens from every `llm.call.completed` event. All other plan premises checked against the pinned code hold.

## Findings

### R3-F1 [major]

T-d has no assertion that the `void completeLLMCallDetached(ctx, {…})` call inside `callViaRouter` actually passes `cacheReadTokens`/`cacheWriteTokens`. At the pinned commit that call (llm-router.ts:1326-1330) passes only `{ inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens, fallbackUsed }`. The plan says this call will be updated to forward the cache fields. T-d verifies two independent facts: (a) `result.usage` carries `cacheReadTokens`/`cacheWriteTokens` (the router's return value) and (b) the pure function `buildLLMCallCompleted` emits those fields when given them. Neither check exercises the actual `completeLLMCallDetached` call site. Because the call is `void` (fire-and-forget), the router's return value is unaffected by whether the void call passes the right arguments; an implementation that correctly sets `result.usage.cacheReadTokens` but omits those fields from the `completeLLMCallDetached` spread passes every test in the plan while silently dropping cache tokens from every `llm.call.completed` OASIS event — the exact defect R1-F2 was raised to prevent.

- `exafyltd/vitana-platform:services/gateway/src/services/llm-router.ts:1325` — if (result.ok) {
  void completeLLMCallDetached(ctx, {
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    fallbackUsed,
  });
- `exafyltd/vitana-platform:services/gateway/src/services/llm-telemetry-service.ts:155` — export interface CompleteLLMCallResult {
  inputTokens?: number;
  outputTokens?: number;
  requestId?: string;
  fallbackUsed?: boolean;
  fallbackFrom?: string;
  fallbackTo?: string;
  retryCount?: number;
}

Suggestion: Add a `jest.spyOn` on `completeLLMCallDetached` (or mock the telemetry service module) inside T-d and assert it was called with `cacheReadTokens` and `cacheWriteTokens` matching the values the mocked Bedrock response returned. This one assertion closes the coverage gap for R1-F2's accepted fix and prevents the silent-drop regression.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The planner's rejection is correct. The Anthropic/Bedrock cache prefix order is tools → system → messages, not system → tools → messages as my finding asserted. A `cache_control` marker on the system block therefore creates a checkpoint that includes [tools + system] — tools are covered because they precede system in the prefix chain. My original finding had the ordering backwards. The system-only checkpoint is the right approach.
- R2-F1: acknowledged — Properly accepted and addressed. The revision adds optional `cache_read_input_tokens?`/`cache_creation_input_tokens?` to `LLMTelemetryPayload`, adds `services/gateway/src/types/llm-telemetry.ts` to the lane, extends `CompleteLLMCallResult`, and asserts both fields in T-d. Confirmed by reading the current `LLMTelemetryPayload` (lines 22-66) and `buildLLMCallCompleted` (lines 184-221).
