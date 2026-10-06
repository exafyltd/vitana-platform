# VTID-04872 — Jev community cost control, slice 2: per-member daily quota for Class B, Class C off, shadow first

Owner approval 2026-10-03 ("Community cost control: approved"): Class A community uses on with no quota; Class B
(including the D1–D8 ranking gates) shadow first, 300 per member per day, safety decisions exempt; Class C at 0.
Slice 1 was VTID-04857 (budget scope, 80%/100% alerts, Maxina $50 / Alkalma $10).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: A decision may declare `community_class` (A/B/C) and `safety`. Every existing member-content decision is classified; `moderation_severity` is Class B and a safety decision.
  TEST: services/gateway/test/vtid-04872-jev-member-quota.test.ts
AC-2: Only calls counted as member spend (`jevSpendPlane() === 'member'`) whose decision is Class B (or unclassified) and not a safety decision are quota-limited. Internal, Dev Autopilot and safety decisions are never counted.
  TEST: services/gateway/test/vtid-04872-jev-member-quota.test.ts
AC-3: The member is `opts.member_id` (a system caller ranking for a member names them) or, on the member plane, the caller. Only an auth user uuid is counted, in `jev_member_daily_counters` keyed by `user_id` so account erasure (VTID-04765) removes it.
  TEST: services/gateway/test/vtid-04872-jev-member-quota.test.ts
AC-4: `JEV_MEMBER_QUOTA_MODE`: `off` and `enforce` exact, anything else `shadow`. Shadow never refuses and emits one `jev.member_quota.would_refuse` (no member id in it) on the first call over the limit per member per day. Enforce returns the fallback `member_daily_quota_exhausted` (429) with no Jev call; an unreadable counter fails closed in enforce (`member_quota_check_failed`) and passes in shadow. `JEV_MEMBER_DAILY_QUOTA` defaults to 300.
  TEST: services/gateway/test/vtid-04872-jev-member-quota.test.ts
AC-5: A Class C decision counted as member spend is refused (`community_class_c_off`) before any token is spent.
  TEST: services/gateway/test/vtid-04872-jev-member-quota.test.ts
AC-6: Migration `20261004100000_vtid_04872_jev_member_quota.sql` adds the table (RLS on, service role only) and `jev_member_quota_bump()`; applied after merge. Until it is, shadow mode logs a failed bump and lets the call through.
AC-7: All Jev suites, the operator pipeline, role-separation and customer-support suites stay green.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-member-quota.ts (new)
- services/gateway/src/services/jev/jev-decisions.ts (community_class, safety fields; moderation classified)
- services/gateway/src/services/jev/jev-decision-service.ts (Class C refusal, quota check)
- services/gateway/src/services/jev/jev-repository.ts (bump RPC)
- services/gateway/test/vtid-04872-jev-member-quota.test.ts (new)
- supabase/migrations/20261004100000_vtid_04872_jev_member_quota.sql (new)
- DATABASE_SCHEMA.md, docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04872/**

## OASIS

OASIS_IMPACT: yes — one new topic, `jev.member_quota.would_refuse` (VTID-04872, source `jev:member_quota`, warning; payload `tenant_id, decision, limit, mode`, never a member id), at most once per member per day in shadow mode.

OASIS_PROOF: `services/gateway/test/vtid-04872-jev-member-quota.test.ts` — "shadow over the limit" asserts one emit of `jev.member_quota.would_refuse` (status warning, no `member_id`) on the 301st call and none on later calls; the decide() shadow case asserts exactly one such event. Live: `select metadata from oasis_events where topic='jev.member_quota.would_refuse'` (none expected while the member plane is closed).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy. No env change. The member plane stays closed (`JEV_COMMUNITY_ENABLED`
unset), and the only member-content decision is a safety decision, so no call is counted until the D1–D8 ranking
gates arrive. Migration applied after merge (additive).
