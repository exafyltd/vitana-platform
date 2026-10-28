# VTID-04623 — operator chat stage: Bedrock Claude Sonnet 4.6 primary

Owner report 2026-09-26 (staging console turn "how many registered users do
we have in vitanaland"): the operator stage, primary DeepSeek Flash (policy
v17), wrote a fake `knowledge_search` call with invented results — an
endpoint `/api/v1/ops/metrics/user-count` and a section "AGENT-REGISTRY.md
§4.1" that do not exist (`git grep` on main: no match; the registry has no
§4.1). The console's own guard flagged "no such call ran".

Change (data only, through the governed `POST /api/v1/llm/routing-policy`):
policy v18 — operator primary `bedrock/eu.anthropic.claude-sonnet-4-6`,
fallback `deepseek/deepseek-flash`. Every other stage byte-identical to v17.

## Acceptance criteria

AC-1: the same question on staging after v18 is served by bedrock / eu.anthropic.claude-sonnet-4-6, calls the real `dev_run_sql_readonly` tool, and presents no fabricated tool call (observed: provider bedrock, tools [dev_run_sql_readonly], honest refusal while the tool was disabled).
TEST: services/gateway/test/vtid-04624-operator-sql-live-db.test.ts
