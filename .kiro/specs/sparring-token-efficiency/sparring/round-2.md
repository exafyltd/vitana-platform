# Sparring round 2 — in_progress

Session: `b2df0328-27f7-43fe-bee5-2d6ba8866cb2` · plan hash `eb2e8b598afce11f1256747064fcfaf01b4233e2b7ef7fe146f05645954356d3`

## Summary

Round 2. Three accepted findings (R1-F2, R1-F3, R1-F4) are substantively addressed in the revised plan. The one rejected finding (R1-F1) has a rationale consistent with the Anthropic prefix-ordering contract — acknowledged. One new major finding: the OASIS telemetry change requires updating `services/gateway/src/types/llm-telemetry.ts` (`LLMTelemetryPayload`), but that file is absent from the plan's lane paths and change list; implementing the plan as written will break `npx tsc --noEmit`.

## Findings

### R2-F1 [major]

`services/gateway/src/types/llm-telemetry.ts` is not listed in the plan's lane paths or file changes, yet it must be updated for the OASIS telemetry additions to compile. `LLMTelemetryPayload` (llm-telemetry.ts:22-66, confirmed by read_file) declares only `input_tokens?` and `output_tokens?` for token counts — no `cache_read_input_tokens` or `cache_creation_input_tokens` fields. `buildLLMCallCompleted` (llm-telemetry-service.ts:170-231) constructs `const payload: LLMTelemetryPayload = { … }` as a typed object literal. Adding `cache_read_input_tokens`/`cache_creation_input_tokens` to that literal without first declaring them on `LLMTelemetryPayload` causes TypeScript to reject it with 'Object literal may only specify known properties' — the error is not suppressible by the `as unknown as Record<string, unknown>` cast on the return value (line 229) because the error is on the assignment to `payload`, not on the return. The plan explicitly requires `npx tsc --noEmit` to stay green, so this missing file update is a blocker for the stated green-tsc requirement.

- `exafyltd/vitana-platform:services/gateway/src/types/llm-telemetry.ts:22` — export interface LLMTelemetryPayload {
  // ...
  input_tokens?: number;
  output_tokens?: number;
  cost_estimate_usd?: number;
- `exafyltd/vitana-platform:services/gateway/src/services/llm-telemetry-service.ts:184` — const payload: LLMTelemetryPayload = {
  vtid: context.vtid,
  ...
  input_tokens: result.inputTokens,
  output_tokens: result.outputTokens,
  cost_estimate_usd: costEstimate,

Suggestion: Add `services/gateway/src/types/llm-telemetry.ts` to the `partner-caching-code` lane's file list. Add `cache_read_input_tokens?: number` and `cache_creation_input_tokens?: number` as optional fields to `LLMTelemetryPayload`. Then in `buildLLMCallCompleted`, spread them conditionally from `result.cacheReadTokens`/`result.cacheWriteTokens`. Update test T-d to also assert those fields appear in `buildLLMCallCompleted`'s returned payload when the cache values are set.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The planner cites the Anthropic docs: 'Cache prefixes are created in the following order: tools, system, then messages.' Under that ordering, a cache_control marker on the last system block creates a checkpoint that covers the entire tools+system prefix — tools come before system in the prefix chain, so they are cached as part of it. The plan also correctly notes the JSON key order in buildBedrockRequestBody (system before messages before tools, confirmed at bedrock.ts:267-285) is irrelevant — the prefix ordering is an API-level semantic contract, not a serialization order. The rationale is logically sound and internally consistent with the stated API contract.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
