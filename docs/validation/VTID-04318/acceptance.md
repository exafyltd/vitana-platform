# VTID-04318 — Orchestrator v2 P0: truth & cleanup

Phase P0 of `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §5, approved by the platform
owner 2026-09-23 ("I agree with your plan and overview. Go to execution").

## What changes

1. **One active-role rule.** `services/orchestrator/active-role.ts`
   (`pickEffectiveRole`, `applyEffectiveRoles`,
   `fetchTenantMembersWithEffectiveRole`). The ORB's `resolveEffectiveRole`
   and the community AP executor's `fetchUsersByRole` both use it, so a user
   who switched roles in the UI is addressed and targeted as the same role.
   Before, the AP executor read `user_tenants.active_role` only.
2. **AP targeting excludes test/service/automation accounts** (CLAUDE.md
   rules 43-45) through the existing `fetchExcludedTestServiceAccountIds`.
3. **Dead Cloud Run defaults removed from runtime gateway code.** Gateway
   self-calls use `gatewayBaseUrl()` (VTID-04220); the community app and OASIS
   operator get the same env-aware helpers; worker-runner (no public URL on
   AWS) and the verification engine (no ingress) report `not_configured`
   instead of calling a deleted host. The verification engine used to fail
   every call with a network error and ask for a retry.
4. **Dead code removed:** `services/agents/conductor`, `validator-core`,
   `crewai-gcp` (GCP-only, no deploy path, no callers), `services/oasis`
   (Dockerfile + manifest only), `services/deploy-watcher`, a committed
   `.pyc`; their `service-path-map.json` entries.

Not in this PR (owner-gated, plan §8.1): stopping the zombie ECS services and
removing the production secrets from their task definitions. Deleting the
source does not stop them. `ai-orchestrator.ts` stays: it is not a stub,
`routes/operator.ts` imports it.

## Acceptance criteria

AC-1 The ORB and the AP executor resolve the same effective role for the same user: UI preference first, then `user_tenants.active_role`, newest preference per user.
TEST: services/gateway/test/vtid-04318-orchestrator-p0.test.ts

AC-2 AP targeting never returns a registered test/service account; a failed preference read degrades to `user_tenants.active_role`; a failed membership read is returned as an error, not an empty audience.
TEST: services/gateway/test/vtid-04318-orchestrator-p0.test.ts

AC-3 No runtime gateway source outside the origin allowlists (CORS, ORB) and the Cloud-Run-only redirector branch references `*.run.app`.
TEST: services/gateway/test/vtid-04318-orchestrator-p0.test.ts

AC-4 Existing suites touching the changed call sites stay green.
TEST: services/gateway/test/test-contracts.test.ts
TEST: services/gateway/test/self-healing-reconciler-autopilot-link.test.ts
TEST: services/gateway/test/voice-synthetic-probe.test.ts
TEST: services/gateway/test/routes/discover-recommendations.test.ts
TEST: services/gateway/test/vtid-04220-gateway-base-url.test.ts

## OASIS

OASIS_PROOF: no new event types. When the verification engine is not configured, the existing verification event is emitted with `status=warning` and `not_configured:true` instead of a network error.

## Results

| AC | Result |
|---|---|
| AC-1 | MET — pickEffectiveRole / applyEffectiveRoles / fetchUsersByRole tests green |
| AC-2 | MET — exclusion, degrade and error-path tests green |
| AC-3 | MET — tree scan test green |
| AC-4 | MET — 8 suites / 90 tests green; full suite 1081/1082 suites (1 pre-existing skip), 17550 tests, 0 failures (outputs/jest-full.txt) |
