# VTID-04598 — the Operator Console reports the coding model an execution actually runs on

Observed 2026-09-26 08:27 UTC on staging, right after VTID-04593 deployed: the
console queued execution `bf918337` (VTID-04597), whose row is stamped
`llm_on_ramp_override = bedrock/eu.anthropic.claude-sonnet-4-6`, and replied
"Executor: agent (provider: deepseek)". The tool results for
`autopilot_execute_task` and `autopilot_run_task` hard-coded
`provider: 'deepseek'`, and the tool descriptions called the on-ramp
"DeepSeek-powered".

## Acceptance criteria

AC-1: no on-ramp tool result hard-codes `provider: 'deepseek'`; both report `devWorkerModel()` provider and model.
TEST: services/gateway/test/vtid-04598-onramp-model-label.test.ts

AC-2: the wire description, the tool registry and both operator prompts describe "the execution on-ramp" without naming DeepSeek, and the two prompts stay in sync.
TEST: services/gateway/test/vtid-04598-onramp-model-label.test.ts
TEST: services/gateway/test/vtid-03838-operator-prompt-lists-execute-tool.test.ts

AC-3: the operator pipeline regression suite stays green.
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
