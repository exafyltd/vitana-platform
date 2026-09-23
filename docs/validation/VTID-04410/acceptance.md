# VTID-04410 — Orchestrator P7: OpenTelemetry GenAI attributes on llm.call.* events

Plan: docs/ORCHESTRATOR-REDESIGN-PLAN.md §5, P7 ("OTel GenAI spans → OASIS").

Every `llm.call.started` / `.completed` / `.failed` OASIS payload gains an
additive `otel` object: span name, kind, W3C trace id (32 hex), span id
(16 hex, the same for all three events of one call), status, and
`gen_ai.*` attributes (operation, provider, request/response model,
response id, usage tokens, conversation id, `error.type`) plus
`vitana.llm.*` / `vitana.vtid`. No existing field is renamed or removed,
no collector or exporter is added, no schema changes. Prompt and
completion text are never included.

## Acceptance

AC-1 Vitana provider keys map to the `gen_ai.provider.name` well-known values; unknown providers pass through.
TEST: services/gateway/test/services/vtid-04410-genai-semconv.test.ts

AC-2 Trace id is 32 lowercase hex (a UUID with dashes stripped), span id 16 hex and stable per call.
TEST: services/gateway/test/services/vtid-04410-genai-semconv.test.ts

AC-3 A completed span carries usage, response model, response id, conversation id, status OK, and no prompt/completion content.
TEST: services/gateway/test/services/vtid-04410-genai-semconv.test.ts

AC-4 A failed span has status ERROR and `error.type` (`_OTHER` when no code); a started span is UNSET and carries no usage.
TEST: services/gateway/test/services/vtid-04410-genai-semconv.test.ts

AC-5 The three emitters attach the span with one shared trace/span id, and every pre-existing payload field is unchanged.
TEST: services/gateway/test/services/vtid-04410-genai-semconv.test.ts

AC-6 After a fallback, `gen_ai.response.model` is the model that actually served the call.
TEST: services/gateway/test/services/vtid-04410-genai-semconv.test.ts

## Not verified live

Staging still serves `e09eb26` (the AWS account block stops ECS from placing
new tasks), so no `llm.call.*` row carrying `otel` exists yet. The first one
after the next staging deploy is the check:
`select payload->'otel' from oasis_events where topic like 'llm.call.%' order by created_at desc limit 1`.
