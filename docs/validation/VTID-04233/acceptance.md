# VTID-04233 — Spec generation on the `planner` stage with the codebase-index tools (no direct Bedrock call)

Build plan item 4, `docs/AGENT-REGISTRY.md` §4 finding 1 (spec-generator half)
and finding 3 (planner). `routes/specs.ts` `generateSpecWithLLM()` — what the
operator planner (`operator-planner.ts` → `POST /api/v1/specs/:vtid/generate`)
and the Command Hub's Generate Spec button run — called `callClaudeText()`
(`claude-text-client.ts` → `invokeBedrock()` directly): no
`llm_routing_policy` stage, no fallback, no `llm.call.*` telemetry, no cost
record, and no way to look at the codebase it was writing "Files to modify"
for. It now runs the shared VTID-04231 stage loop on the `planner` stage
with the VTID-04229 index tools.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — The generator calls the `planner` stage with `service:'spec-generator'`, the VTID, the unchanged `SPEC_GEN_SYSTEM_PROMPT`, `maxTokens:16384`, `allowFallback:true`, and the three index tools (`dev_index_query`, `dev_graph_path`, `dev_get_risk`) when the index loads; the tools execute against the loaded bundle.
TEST: `services/gateway/test/vtid-04233-spec-generator-planner-stage.test.ts` — "runs the planner stage through the stage loop with the three index tools …".

AC-2 — A code-index load failure (or `SPEC_GEN_INDEX_TOOLS_ENABLED=false`) means a single tool-less planner call from the system context — never a failed generation.
TEST: same suite — "plans without tools (single shot) …".

AC-3 — A stage failure returns `text:null` with the error, and the route falls back to its template exactly as before.
TEST: same suite — "a loop failure yields text:null …"; `test/specs-generate-claim.test.ts` (route contract, mock moved from `callClaudeText` to the stage loop) still green.

AC-4 — No direct Bedrock/Claude client remains in the spec route; the generation prompt tells the planner to use the index tools first.
TEST: same suite — "source contract …".

AC-5 — Type-check and the neighbouring suites are green.
TEST: `outputs/tsc-noEmit.log` (`exit=0`); `outputs/jest-vtid-04233.log` (spec-route, VTID-04231 loop, VTID-04229 index suites).

AC-6 — Live: the next `POST /api/v1/specs/:vtid/generate` on staging (a Command Hub Generate Spec click or the operator planner's tick) produces an `llm.call.completed` row with `stage=planner`, `service=spec-generator`, and the gateway log line `[VTID-01188] planner stage spec generated … tool_calls=N`.
TEST: not run in this session — recorded as the post-merge exercise, not claimed.

OASIS_PROOF: no new topic. The existing spec events (`spec.generated` family emitted by the route) are unchanged; the provider/model/tool telemetry is on the gateway log line and the router's `llm.call.*` rows.
