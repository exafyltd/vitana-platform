# VTID-04362 — Orchestrator v2 P2: ORB tool capability catalog + policy shadow

Plan: `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §3.2, §5 P2. Shadow only: nothing is blocked.

## Acceptance criteria

AC-1 Every name in `ORB_TOOL_NAMES` resolves to `{domain, tier, self}` without falling through to the default rule. A new tool must be classified on purpose.
TEST: services/gateway/test/services/orchestrator/vtid-04362-tool-policy-shadow.test.ts

AC-2 `high` is an explicit list and is never inferred from a verb. `dev_`/`admin_` tools land in their own domains, and user-own low-risk commits are marked `self`.
TEST: services/gateway/test/services/orchestrator/vtid-04362-tool-policy-shadow.test.ts

AC-3 `evaluateToolCall`: a `self` commit is allowed by voice when the role may commit. Every other voice commit escalates to chat/web. `high` escalates to maker-checker or is denied, and is never allowed directly.
TEST: services/gateway/test/services/orchestrator/vtid-04362-tool-policy-shadow.test.ts

AC-4 The shadow recorder aggregates by role|tool|decision and keeps only non-allow decisions in a recent ring. It is bounded (2000 keys / 200 recent) and never throws.
TEST: services/gateway/test/services/orchestrator/vtid-04362-tool-policy-shadow.test.ts

AC-5 `dispatchOrbTool` records a decision and still runs the handler. A shadow `deny` never blocks.
TEST: services/gateway/test/services/orchestrator/vtid-04362-tool-policy-shadow.test.ts

AC-6 `GET /api/v1/orchestrator/policy/shadow` is exafy_admin only and returns the shadow window plus the catalog summary, with `enforced: false`.
TEST: services/gateway/test/routes/orchestrator.test.ts

## Route evidence

ROUTE_MOUNT: `services/gateway/src/routes/orchestrator.ts` → `router.get('/policy/shadow', requireDevRole, …)`, mounted at `/api/v1/orchestrator` (the existing orchestrator router, VTID-04319).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/orchestrator/policy/shadow
CURL_PROOF: not yet available. Staging has been unable to place new ECS tasks since 2026-09-22 22:57 UTC (AWS account block), so no build containing this route is serving yet. After the next staging deploy, the expected result is `curl -s -o /dev/null -w "%{http_code} %{content_type}" …/policy/shadow` → `401 application/json`. The route-level behaviour is verified in `test/routes/orchestrator.test.ts` via supertest.

## Finding for review (not changed here)

Under the VTID-04325 defaults, `professional` stops at `draft` in the professional domain, so `create_service` / `update_service_offerings` are a shadow **deny**. That fits the plan (commit only after confirmation on an approval channel), but it will show up in the shadow window as a would-change. It needs a decision before any enforce flip.
