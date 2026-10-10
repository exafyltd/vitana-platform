# Plan — require a real caller on POST /create-pr and /safe-merge (security fix)

<!-- plan:begin -->
## Problem (verified 2026-10-09, staging, read-only probe)
`services/gateway/src/routes/cicd.ts` `router.post('/create-pr')` (:231) and `router.post('/safe-merge')` (:299)
have no auth. The router is mounted three times with no middleware (`src/index.ts`: `/api/v1/github`,
`/api/v1/deploy`, `/api/v1/cicd`); the only global middleware, `delegatedTokenGuard`, passes requests without a
bearer. Staging: `POST /api/v1/github/safe-merge` with no bearer and `{}` → 400 (body validation), not 401.
VTID-05014 (on staging, not production) widened both routes to `exafyltd/vitana-v1` (public repo) with
FRONTEND_DEPLOY_TOKEN: anyone reaching the gateway could merge a green fork PR there, and a merge to vitana-v1 main
deploys `supabase/functions/**` to the production Supabase project.

## Change (change class: standard — auth on two routes + their internal callers)
1. `cicd.ts`: add the existing `requireServiceOrAdmin` (`src/middleware/require-service-or-admin.ts`: bearer
   `GATEWAY_SERVICE_TOKEN` OR an `exafy_admin` JWT; fails closed, 401/403) to `router.post('/create-pr', …)` and
   `router.post('/safe-merge', …)`. Applies on all three mounts (same router). No log-only mode: it is a fix.
2. Update every in-repo caller of those two routes to send `Authorization: Bearer <GATEWAY_SERVICE_TOKEN>`:
   - `gemini-operator.ts` `executeDevCreatePr` / `executeDevMergePr` (today they send the Supabase service-role
     key as the bearer, which the gate would not accept) — the Operator's and Kiro's dev_create_pr/dev_merge_pr.
     Their unused `apikey: SUPABASE_SERVICE_ROLE` header is removed too (no Supabase key on a gateway self-call).
   - `autopilot-event-loop.ts` safe-merge call (~:670, no auth today).
   - `orb-tools/cicd-pr-tools.ts` `dev_create_pr` / `dev_safe_merge`: the header is passed PER CALL SITE through
     `gatewayApiCall`'s existing `headers` option; `gatewayApiCall` itself is not changed (its other callers, incl.
     the out-of-scope approval routes, keep sending what they send today).
   - `services/openclaw-bridge/src/skills/vitana-cicd.ts` `callGateway` (adds the header when
     `GATEWAY_SERVICE_TOKEN` is set in that service's env; without it the call now gets 401 instead of merging).
     Verified: ECS service `vitana-openclaw-bridge` runs desiredCount 0 and its task def has no GATEWAY_SERVICE_TOKEN,
     so nothing live calls these routes from there today.
   A missing token on a gateway caller → the call fails with the gate's 401, loudly (no fallback).
3. `GATEWAY_SERVICE_TOKEN` is already a secret on both live gateway task definitions (verified 2026-10-09 via
   `aws ecs describe-task-definition` on `vitana-gateway` and `vitana-gateway-awsdr`). The prod workflow never
   rebuilds that list: every mode re-registers the CURRENT awsdr task definition, replacing only the image and
   commit stamps (`AWS-PROD-DEPLOY-GATEWAY.yml:37-41`), so the secret is carried across deploys; staging wires it
   explicitly (`AWS-STAGE-DEPLOY-GATEWAY.yml:1216`). No workflow change. Gate 2 evidence re-reads the live prod
   task definition and shows the secret is present before anything ships.
4. Fix my VTID-05014 staging probe (`docs/validation/VTID-05014/staging-tests.json`), which asserted 401 and got 400:
   it stays as written and now passes, because the gate answers 401 before body validation. Add this VTID's own
   probes: POST `/api/v1/github/create-pr` and `/api/v1/cicd/safe-merge` with an invalid bearer → 401.

## Not in scope — reported, separate plan
Every other route on the same router is also unauthenticated at the route level — the seven mutating ones
(`POST /service`, `/merge`, `/deploy`, `/approvals/:id/approve`, `/approvals/:id/deny`, `/autonomous-pr-merge`,
`/lock-release`) and the reads that expose operational state (`GET /approvals`, `/lock-status` and the other GETs
listed in the `cicd.ts` header). On all three mount prefixes. Their callers (Command Hub UI, autopilot, openclaw) need mapping first; the owner gets a separate
plan. This plan does not change them.

## Risk
- A caller not found by the search (`safe-merge|create-pr` across services/, scripts/, .github/) would start getting
  401 — that is the intended fail-closed behaviour and is visible in logs.
- openclaw-bridge's own env may not hold GATEWAY_SERVICE_TOKEN; then its create/merge skill fails (401) until set.

## Tests
- `test/vtid-05019-cicd-pr-routes-auth.test.ts`: real router; no bearer → 401, wrong bearer → 401, non-admin JWT →
  403, service token → passes to the handler (github-service mocked), exafy_admin JWT → passes; on all three mount
  prefixes; the other routes unchanged (still reachable — documents the open finding).
- Executors send the service token: gemini-operator dev_create_pr/dev_merge_pr, autopilot event loop, orb
  cicd-pr-tools (fetch mocked).
- Existing: VTID-05014, VTID-05006 executor payload, operator pipeline regression (its fake must send/accept the
  token), autopilot suites.
- Staging (read-only): the three 401 probes above.
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] prod workflow never wires GATEWAY_SERVICE_TOKEN — ACCEPTED (clarified, verified): the live prod task def
  has it (describe-task-definition, both services), and the prod workflow re-registers the CURRENT awsdr task def in
  every mode, replacing only image + commit stamps (AWS-PROD-DEPLOY-GATEWAY.yml:37-41), so it carries across deploys.
  Plan states this, and Gate 2 re-reads the live prod task def for the secret before shipping.
- F2 [major] gatewayApiCall blast radius — ACCEPTED: header passed per call site via the existing `headers` option;
  gatewayApiCall unchanged.
- F3 [minor] incomplete list — ACCEPTED: "Not in scope" now names every remaining unauthenticated route incl. GETs.
- F4 [minor] apikey header — ACCEPTED: removed from both executors.
- F5 [minor] three prefixes redundant — ACKNOWLEDGED: tests check each route on one prefix plus a cross-prefix check.
- Q2: openclaw-bridge is an ECS service at desiredCount 0 with no GATEWAY_SERVICE_TOKEN — nothing live; noted in plan.

## Partner rounds 2–3
Round 2 was read before the revision was saved (all marked disputed for "no response"). Round 3 on the saved
revision: F1–F4 closed, F5 acknowledged, no new findings. Verdict: CONVERGED.

## Record
- Plan hash (sha256 of the text between the plan markers): `0ada3c9c745df4262fc68781f79d0d79bd80a0ee3bdae0f7d2cfe9f437aec40f`
- Partner: plan-sparring-partner, 3 rounds (round 2 read before the revision was saved). Verdict: **CONVERGED**.
- Approval: owner "Yes" in the Claude Code session, 2026-10-10. VTID-05019 allocated after approval.
