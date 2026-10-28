# Plan — require a real caller on the rest of the cicd router (security fix, part 2)

<!-- plan:begin -->
## Problem (verified 2026-10-10)
VTID-05019 put `requireServiceOrAdmin` on `POST /create-pr` and `POST /safe-merge` only. Every other route on
`services/gateway/src/routes/cicd.ts` (mounted at `/api/v1/github`, `/api/v1/deploy`, `/api/v1/cicd` in
`src/index.ts`, no auth middleware) is still open to anyone who reaches the gateway:
- mutating: `POST /service` (:473, triggers a deploy workflow), `POST /merge` (:657, governed merge),
  `POST /deploy` (:831), `POST /approvals/:id/approve` (:1045), `POST /approvals/:id/deny` (:1172),
  `POST /autonomous-pr-merge` (:1246, merges with GITHUB_SAFE_MERGE_TOKEN), `POST /lock-release` (:2021);
- reads that expose operational state: `GET /approvals` (:917, open PRs + governance state), `GET /lock-status`
  (:2000, CICD lock holders).

## Change (change class: standard — auth on cicd routes + their callers)
1. `cicd.ts`: add `requireServiceOrAdmin` (GATEWAY_SERVICE_TOKEN bearer OR exafy_admin JWT; 401/403, fail closed) to
   the nine routes above. `GET /health` (:575) stays public on purpose — a liveness probe read by
   `scripts/ci/collect-status.py`, `constants/service-health-registry.ts` and the Command Hub health view, and it
   returns no PR, lock or governance data.
2. Callers (verified by search across services/, scripts/, .github/ for `cicd|github|deploy` + each route name):
   - Command Hub `app.js`: `GET /api/v1/cicd/approvals` (:5564) and `POST /api/v1/cicd/autonomous-pr-merge`
     (:5662) already send `Authorization: Bearer <admin JWT>` via `buildContextHeaders` (:1557). No change.
   - `routes/approvals.ts` (:588, :725) and `routes/execute.ts` (:1041) self-call `/api/v1/github/autonomous-pr-merge`
     with no auth → add `gatewayServiceAuthHeader()` (from VTID-05019).
   - `gemini-operator.ts`: `/api/v1/deploy/service` (:5830) and `/api/v1/cicd/lock-status` (~:5912/:5932) send the
     Supabase service-role key as bearer → switch to `gatewayServiceAuthHeader()`, drop the `apikey` header.
     (`/api/v1/cicd/health` call unchanged: route stays public.)
   - `orb-tools/cicd-pr-tools.ts`: `/api/v1/cicd/merge` (:140), `/lock-status` (:294), `/lock-release` (:320) →
     pass `gatewayServiceAuthHeader()` per call site (as VTID-05019 did). `/health` (:335) unchanged.
   - `openclaw-bridge` `vitana-cicd.ts`: `/deploy/service` (:153) added to `prRouteAuth`'s path list (service runs
     desiredCount 0).
   - No caller found for `POST /deploy` or `POST /approvals/:id/approve|deny` (the Command Hub approves through
     other routers); gated anyway — an unknown caller would now get 401, the intended fail-closed outcome.
3. No workflow, secret or migration change (GATEWAY_SERVICE_TOKEN is on both live task definitions).

## Risk
- A caller missed by the search starts getting 401 (loud, visible in logs) — the safe direction.
- The Command Hub approvals view needs a signed-in exafy_admin session, as every other Command Hub admin view does.

## Tests
- Extend `test/vtid-05019-cicd-pr-routes-auth.test.ts` (or a new `test/vtid-NNNNN-…`): each of the nine routes →
  401 without/with a wrong bearer, 403 for a non-admin JWT, reaches the handler with the service token and with an
  exafy_admin JWT; `GET /health` still 200 with no bearer.
- Caller source checks: approvals.ts, execute.ts, gemini-operator.ts, cicd-pr-tools.ts, openclaw-bridge send the
  service token on these paths; gemini-operator sends no Supabase key on them.
- Existing suites that drive these routes (operator pipeline regression, autopilot/approvals/execute suites, ORB
  tools) stay green — any that call a gated route without auth are updated to send the token (contract change on
  purpose, stated in the PR).
- Staging (read-only): `GET /api/v1/cicd/approvals` and `GET /api/v1/cicd/lock-status` without a caller → 401;
  `POST /api/v1/cicd/autonomous-pr-merge` and `POST /api/v1/deploy/service` with an invalid bearer → 401;
  `GET /api/v1/cicd/health` → 200.
<!-- plan:end -->

## Planner responses — round 1
- **F1 [blocker] — rejected (premise misread).** What you read is my *uncommitted draft* in the working tree, written
  ahead of the VTID so it could be typechecked; `VTID-PENDING` is the placeholder for the VTID this plan will get.
  `origin/main` has `requireServiceOrAdmin` on create-pr and safe-merge only
  (`git show origin/main:services/gateway/src/routes/cicd.ts | grep -c requireServiceOrAdmin` → 3: import + two
  routes). The plan's premises hold against main; the draft is the plan's implementation, not prior work.
- **F2 [major] — accepted, plan changed.** openclaw-bridge also calls `/cicd/approvals`, `/approvals/:id/approve|deny`,
  `/cicd/autonomous-pr-merge` and `/cicd/lock-status`. Change: `prRouteAuth` now sends the service token on every
  gateway call when `GATEWAY_SERVICE_TOKEN` is set (all of `callGateway`'s targets are the gateway itself; `/cicd/health`
  ignores it). Test: source check that prRouteAuth has no path allowlist.
- Q1: answered under F1. Q2: the placeholder is replaced by this plan's own VTID once allocated; no separate VTID.

## Planner responses — round 2 (partner verdict: CONVERGED)
- F3 [minor] — accepted: `test/vtid-05019-cicd-pr-routes-auth.test.ts:118` (old path-allowlist assertion) is replaced by
  the "no path allowlist, token sent when set" check.
- F4 [minor] — deferred: gemini-operator's `/api/v1/approvals/:id/approve` call (approvalsRouter, not cicd) still sends
  the Supabase service-role key; listed as a follow-up in the PR.

## Sparring partner findings (verbatim, round 1 and round 2)
See the session transcript; summary: round 1 F1 [blocker] (premise false: read the uncommitted draft) — rejected, partner closed it in round 2; F2 [major] openclaw-bridge other routes unauthenticated — accepted, fixed. Round 2: F3 [minor] old prRouteAuth assertion at test/vtid-05019-cicd-pr-routes-auth.test.ts:118 — accepted; F4 [minor] gemini-operator approvalsRouter call still sends the Supabase key — deferred (follow-up in PR). Verdict: CONVERGED (round 2).

## Approval
Plan hash: f0191f4716f8ca67 (sha256 of the plan:begin..plan:end block, first 16 hex).
Owner approval: 2026-10-10, Gate 1 "Yes". VTID allocated after approval: VTID-05047.
