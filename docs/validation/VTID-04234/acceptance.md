# VTID-04234 — Architecture investigator routed through the `triage` stage

`services/gateway/src/services/architecture-investigator.ts` (the
self-healing root-cause agent behind the operator tool
`investigate_failure` and `routes/architecture-investigator.ts`) called
`https://api.deepseek.com/chat/completions` directly with
`DEEPSEEK_API_KEY` — no `llm_routing_policy` stage, no fallback, no
`llm.call.*` telemetry, no cost record, and a hard `DEEPSEEK_API_KEY not
set` throw on production (`docs/AGENT-REGISTRY.md` §4 finding 1). It now
goes through `callViaRouter('triage', …)` like the self-healing triage
agent already does: Bedrock Sonnet 4.6 primary, DeepSeek fallback under
policy v17, provider/model/tokens/fallback recorded on the
`architecture_reports` row and the completion event.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — The investigator's model call goes through the router on the `triage` stage with `service:'architecture-investigator'`, the incident VTID, `allowFallback:true`, `maxTokens:4096` and the investigator system prompt; no provider override is applied by default.
TEST: `services/gateway/test/vtid-04234-architecture-investigator-triage-stage.test.ts` — "calls the router on the triage stage …" (asserts every option on the recorded `callViaRouter` call).

AC-2 — The provider and model that actually served the call (as reported by the router, fallback included) are written to `architecture_reports.llm_provider` / `llm_model`, carried on the `architecture.investigation.completed` event (`stage`, `fallback_used`) and returned to the caller (`llm_provider`, `llm_model`, `llm_fallback_used`, token counts).
TEST: same suite — "records the serving provider/model/tokens on the row, the event and the return value".

AC-3 — No direct DeepSeek HTTP call remains: every `fetch` the investigator makes is a Supabase REST call; the source contains no non-comment reference to `api.deepseek.com`, `DEEPSEEK_API_KEY` or `chat/completions`, and contains `callViaRouter(ARCH_INVESTIGATOR_STAGE` with `ARCH_INVESTIGATOR_STAGE = 'triage'`.
TEST: same suite — "never calls DeepSeek directly …" and "source contract …"; `outputs/source-contract-grep.txt`.

AC-4 — A router failure (both providers refused) or an empty text response is a loud failure: `investigateIncident` throws `triage stage call failed: …` and writes no `architecture_reports` row and no completion event — never a silent fallback and never a partial report.
TEST: same suite — "throws and writes nothing when the router call fails" and "treats an empty response as a failure".

AC-5 — `ARCH_INVESTIGATOR_PROVIDER` + `ARCH_INVESTIGATOR_MODEL` act as a router override only when BOTH are set (a lone model or provider is ignored), passed through as `providerOverride`/`modelOverride`.
TEST: same suite — "resolveInvestigatorOverride …" (null / lone value null / both pass through) and "applies the env override pair to the router call".

AC-6 — Type-check and the affected suites are green.
TEST: `outputs/tsc-noEmit.log` (`exit=0`), `outputs/jest-vtid-04234.log` (9/9 new tests passing).

AC-7 — Live: the first `investigate_failure` call on staging after this deploys produces an `llm.call.completed` row with `stage=triage`, `service=architecture-investigator` and `provider=bedrock` (or `deepseek` with `fallback_used=true`), and an `architecture_reports` row whose `llm_provider` matches it.
TEST: not run in this session — the investigator is only reachable through an operator turn that names a real incident topic; recorded as the post-merge exercise, not claimed.

OASIS_PROOF: the existing `architecture.investigation.completed` event (topic `architecture.investigation.completed`, source `architecture-investigator`) is unchanged in name and now carries `stage`, `llm_provider`, `llm_model` and `fallback_used` in its payload — asserted by AC-2's test against the mocked `emitOasisEvent`. No new topic.
