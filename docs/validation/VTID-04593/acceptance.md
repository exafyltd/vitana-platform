# VTID-04593 — Dev pipeline models: planner on DeepSeek Flash, coding agent on Bedrock Claude Sonnet 4.6

Owner instruction 2026-09-26: switch the planner to DeepSeek Flash and the
worker (coding agent) to Bedrock Claude Sonnet 5 if available, otherwise
Sonnet 4.6; then run a live end-to-end test.

Sonnet 5 is listed ACTIVE on the account but `invoke_model` answers
AccessDeniedException "not available for this account"
(`outputs/bedrock-sonnet-probe.txt`), so the coding agent uses
`eu.anthropic.claude-sonnet-4-6`.

Scope: each choice replaces the stage PRIMARY for the Dev pipeline callers
only. The shared `llm_routing_policy` `planner` stage is not changed, because
member-facing features (shopping agent, goal planner) read it too. The stage
fallbacks (Bedrock Sonnet 4.6 for both stages under v17) still apply.

## Acceptance criteria

AC-1: `devPlannerModel()` defaults to deepseek/deepseek-flash and `devWorkerModel()` to bedrock/eu.anthropic.claude-sonnet-4-6; env pairs override; vertex/anthropic are refused.
TEST: services/gateway/test/vtid-04593-dev-pipeline-models.test.ts
AC-2: the operator on-ramp stamps the coding agent model on the execution row (`llm_on_ramp_override`), so the executor and any self-heal child run on it.
TEST: services/gateway/test/vtid-04007-open-ended-intake.test.ts
AC-3: the agent executor's default model (rows without an override, i.e. the autonomous lane) is `devWorkerModel()`.
TEST: services/gateway/test/vtid-04593-dev-pipeline-models.test.ts
AC-4: Dev Autopilot plan generation and the spec generator override the `planner` stage primary with `devPlannerModel()`.
TEST: services/gateway/test/vtid-04593-dev-pipeline-models.test.ts
AC-5: the operator pipeline regression suite passes end to end with the new model on the row and on every worker call (assertions updated on purpose — the pipeline's model contract changed, per rule 42f).
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Not verified here

A live operator task on staging after this deploys (the test the owner asked
for) — recorded in `outputs/` once run.
