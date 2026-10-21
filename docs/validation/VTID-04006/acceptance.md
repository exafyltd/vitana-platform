# VTID-04006 — Operator agent W1: agentic executor (DeepSeek Flash primary, Bedrock fallback)

Plan: `docs/OPERATOR-AGENT-BUILD-PLAN.md` (W1). Ships in the same PR as VTID-04005 (the PR-title VTID); this pack records W1's own acceptance.

AC-1 — Every agent tool is jailed to the clone: repo-relative paths only, no `..` escapes, no absolute paths, no `.git/`; read/list/search/find/write/edit/delete behave as specified and report errors instead of throwing.
TEST: services/gateway/test/autopilot-agent-tools.test.ts

AC-2 — `run_check` accepts only the allowlisted kinds (tsc, jest, git_diff, git_status, node_check), validates every target path against the jail, and returns exit codes; there is no shell.
TEST: services/gateway/test/autopilot-agent-tools.test.ts

AC-3 — The loop is provider-neutral: tool calls are executed and answered as `toolResults` history, text-only replies are nudged (max 3), `finish` ends the loop, LLM failures/deadline/turn-cap surface as errors, prior transcripts continue for fix rounds, and `fallbackUsed` is recorded.
TEST: services/gateway/test/autopilot-agent-loop.test.ts

AC-4 — After `finish`, the runner enforces allow/deny scope on `git status` (deny wins; evidence-pack paths exempt), the test-coverage rule, and pairs changed sources with their jest suites by basename per project.
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts

AC-5 — Executor selection defaults to single-shot; `metadata.executor='agent'` on the row wins over `DEV_AUTOPILOT_EXECUTOR=agent`; `runExecutionSession` delegates after the PR-flood guard; the on-ramp stamps `executor:'agent'` only when `OPERATOR_ONRAMP_EXECUTOR=agent`.
TEST: services/gateway/test/autopilot-agent-scope-validate.test.ts
TEST: services/gateway/test/vtid-03820-execution-onramp-metadata.test.ts

AC-6 — The executor image (`Dockerfile.job`) carries git and the full dependency tree so the clone can run tsc/jest without an install; `AGENT_NODE_MODULES_SOURCE` points at it. The single-shot path is byte-for-byte unchanged.
TEST: services/gateway/test/dev-autopilot-execute.test.ts
TEST: services/gateway/test/dev-autopilot-runexec-pr-flood-guard.test.ts
