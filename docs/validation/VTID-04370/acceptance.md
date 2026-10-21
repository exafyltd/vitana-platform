# VTID-04370 — Orchestrator v2 P2: LLM budgets from `llm.call.*`

Plan: `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §3.2 "Budgets", §5 P2 exit criterion: "budgets block a synthetic over-spend in a unit/integration test". Shadow mode: nothing calls this before a model call yet.

## Acceptance criteria

AC-1 Bedrock inference-profile ids are priced. `estimateCost` reduces a profile id to its bare model name (this used to happen only in the Operator Console, VTID-04031), and the two profiles the policy serves (Opus 4.5, Sonnet 4.5) have `MODEL_COSTS` rows. Router telemetry priced every Bedrock call at $0 before this.
TEST: services/gateway/test/services/orchestrator/vtid-04370-budgets.test.ts

AC-2 A telemetry row recorded at $0 that has tokens is repriced from its tokens. A model with no price is counted as unpriced, never guessed.
TEST: services/gateway/test/services/orchestrator/vtid-04370-budgets.test.ts

AC-3 A synthetic over-spend is a policy DENY naming the exhausted budget (platform → agent → run), and under budget is allow.
TEST: services/gateway/test/services/orchestrator/vtid-04370-budgets.test.ts

AC-4 Defaults: the platform daily limit is the $6,000 monthly envelope divided by 30 days ($200). Agent lines are sized from 7 days of repriced spend (`outputs/repriced-spend-7d.md`), so the measured 09-22 planning spike would be denied and the steady translator day would not.
TEST: services/gateway/test/services/orchestrator/vtid-04370-budgets.test.ts

AC-5 `loadSpendToday` reads only `llm.call.completed` since UTC midnight, pages through results, and never writes.
TEST: services/gateway/test/services/orchestrator/vtid-04370-budgets.test.ts

AC-6 `GET /api/v1/orchestrator/budgets` is exafy_admin only. It returns today's spend against the budgets, lists the over-limit lines as `would_deny`, reports `enforced: false`, and returns 502 on a read error.
TEST: services/gateway/test/routes/orchestrator.test.ts

## Route evidence

ROUTE_MOUNT: `services/gateway/src/routes/orchestrator.ts` → `router.get('/budgets', requireDevRole, …)`, mounted at `/api/v1/orchestrator`.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/orchestrator/budgets
CURL_PROOF: pending. Staging cannot place new ECS tasks (AWS account block since 2026-09-22 22:57 UTC). Expected after the next staging deploy: `401 application/json` without auth. The route behaviour is verified via supertest in `test/routes/orchestrator.test.ts`.

## Findings for the owner (not changed here)

1. **`db-i18n-translator` spends about $33/day, every day** (about $1,000/month). It was invisible because every Bedrock call was recorded at $0. It fits under the new $40/day line, but it is the single largest steady cost and needs a decision: is the translation backlog finite, and should it run on a cheaper model?
2. **`dev-autopilot-planning` spent $58 on 09-22.** This is the concurrent re-planning defect already recorded under VTID-04228. Its $25/day budget would have denied it.
3. **No per-tenant budget yet.** `llm.call.completed` carries no tenant. Adding one is a telemetry change for its own VTID.
