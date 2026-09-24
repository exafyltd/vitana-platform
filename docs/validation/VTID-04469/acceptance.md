# VTID-04469 — RECOMMENDED_MODELS: Bedrock + DeepSeek only

Registry finding (docs/AGENT-REGISTRY.md §6, VTID-04238 item 3): `RECOMMENDED_MODELS`
in `services/gateway/src/constants/llm-defaults.ts` listed `gemini-3.1-pro-preview`
first for most stages and named bare `claude-opus-4-7` / `gpt-5` — Google
(decommissioned), the direct Anthropic API (no credit balance, VTID-03563) and an
OpenAI key that is not provisioned.

## Acceptance criteria

AC-1: every routed stage has at least one recommended model.
TEST: services/gateway/test/vtid-04469-recommended-models-no-google.test.ts
AC-2: every recommended model is a Bedrock inference profile or a DeepSeek model.
TEST: services/gateway/test/vtid-04469-recommended-models-no-google.test.ts
AC-3: no recommended model is Google, direct Anthropic or OpenAI.
TEST: services/gateway/test/vtid-04469-recommended-models-no-google.test.ts
AC-4: each stage's safe-default primary is itself recommended.
TEST: services/gateway/test/vtid-04469-recommended-models-no-google.test.ts

No routing change: `RECOMMENDED_MODELS` / `isRecommendedModel` have no caller that
selects a model; the live policy (`llm_routing_policy` v17) is untouched.
