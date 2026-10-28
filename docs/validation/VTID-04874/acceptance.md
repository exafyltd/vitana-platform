# VTID-04874 — Jev community cost control, slice 3: community share of the Jev rate limit, shadow first

Owner approval 2026-10-03: "a separate TypeSafe key, or a gateway token bucket capping the community plane at about
30% of the 1,200 requests/min limit". TypeSafe's limit is per account (docs/JEV-INTEGRATION-PLAN.md §8.5), so a second
key on the same account would not protect internal traffic; this builds the token bucket. Slices 1–2: VTID-04857,
VTID-04872.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Every call counted as member spend (`jevSpendPlane() === 'member'`), safety decisions included, takes one token from a per-gateway-task bucket before the Jev call. Internal and Dev Autopilot calls never take a token.
  TEST: services/gateway/test/vtid-04874-jev-community-rate.test.ts
AC-2: The bucket refills continuously at `JEV_COMMUNITY_RPM_PER_TASK` per minute (default 180 = 360/min = 30% of 1,200 over 2 tasks; a positive integer overrides) and never holds more than one minute's worth.
  TEST: services/gateway/test/vtid-04874-jev-community-rate.test.ts
AC-3: `JEV_COMMUNITY_RATE_MODE`: `off` and `enforce` exact, anything else `shadow`. Shadow never refuses and emits at most one `jev.community_rate.would_limit` per task per 10 minutes carrying the count. Enforce returns the fallback `community_rate_limited` (429) with no Jev call; nothing is queued. Off takes no tokens.
  TEST: services/gateway/test/vtid-04874-jev-community-rate.test.ts
AC-4: All Jev suites, the operator pipeline, role-separation and customer-support suites stay green.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-community-rate.ts (new)
- services/gateway/src/services/jev/jev-decision-service.ts (token check after the member quota)
- services/gateway/test/vtid-04874-jev-community-rate.test.ts (new)
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04874/**

## OASIS

OASIS_IMPACT: yes — one new topic, `jev.community_rate.would_limit` (VTID-04874, source `jev:community_rate`, warning; payload `would_limit, rpm_per_task, decision, mode`), at most once per gateway task per 10 minutes in shadow mode.

OASIS_PROOF: `services/gateway/test/vtid-04874-jev-community-rate.test.ts` — "shadow never refuses and reports at most once per 10 minutes" asserts one emit of `jev.community_rate.would_limit` (vtid VTID-04874, would_limit 1, rpm_per_task 1) for two limited calls inside the window and a second emit carrying the accumulated count after 10 minutes. Live: `select metadata from oasis_events where topic='jev.community_rate.would_limit'` (none expected while the member plane is closed).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy. No env change, no schema change. The member plane stays closed
(`JEV_COMMUNITY_ENABLED` unset), so no call takes a token until community decisions run; then shadow reports how
often the share would bite before anyone sets enforce.
