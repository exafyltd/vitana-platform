# VTID-04222 — Agent registry and inventory (`docs/AGENT-REGISTRY.md`)

Read-only inventory of every LLM-driven agent in the platform: its
`llm_routing_policy` stage and live provider/model (from the ACTIVE row,
v17, read through the governed `GET /api/v1/llm/routing-policy` on both
gateways), memory in/out, tool set, env gate, and staging/prod pin status
(from the live ECS task definitions). No code path changes.

## Acceptance Criteria

AC-1 — The policy table in §1 matches the ACTIVE `llm_routing_policy` row served by both gateways (same version, same stage→provider/model pairs).
CURL: `GET https://preview-aws-gateway.vitanaland.com/api/v1/llm/routing-policy` and `GET https://gateway.vitanaland.com/api/v1/llm/routing-policy` — captured in `outputs/routing-policy-v17-2026-09-21.json` (version 17 on both).

AC-2 — Every gate/pin cell in the §2 registry table is taken from the live task definitions, not from workflow files.
CURL: `aws ecs describe-task-definition` for `vitana-gateway:487`, `vitana-gateway-awsdr:114`, `vitana-autopilot-executor:20` — env/secrets snapshot in `outputs/live-task-definitions-2026-09-21.json`.

AC-3 — The codeintel "not_configured" finding (§3) is observed on staging, not inferred from the Dockerfile.
CURL: one read-only staging operator turn calling `dev_repowise` — `outputs/staging-operator-codeintel-check.json` (tool result `not_configured`; root cause: `repowise` depends on `lancedb`, which publishes no musllinux wheel).

AC-4 — Every agent listed as "direct provider call" (architecture investigator, spec generator behind the operator planner) is cited to the exact source line making the call.
TEST: `grep -n "api.deepseek.com" services/gateway/src/services/architecture-investigator.ts` and `grep -n "callClaudeText" services/gateway/src/routes/specs.ts` — both hit; recorded in `commands.log`.

AC-5 — Docs-only change: no gateway source, test, workflow or schema file is touched.
TEST: `git diff --name-only origin/main...HEAD` lists only `docs/AGENT-REGISTRY.md` and `docs/validation/VTID-04222/**` — recorded in `commands.log`.
