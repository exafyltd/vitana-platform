# VTID-04888 — Rule 45: test/service accounts never reach a real member (Find-a-Match, matchmaker, member lists)

Owner approval 2026-10-05 ("yes" to the converged plan, hash `34223a65…`); must merge before VTID-04883 (ranking
gates). Plan sparred (2 rounds + confirmation, converged) — `plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `search_intent_catalog_v2`, `compute_intent_matches_v2` and the uncalled v1 pair never put an intent of a
`service_bot_accounts` / `notification_test_actors` account into the candidate pool or the pool-size count; `search_*`
return nothing for an excluded caller and `compute_*` return 0 for an excluded source intent; real members' results
are unchanged.
  TEST: scripts/ci/test-vtid-04888-rule45.sh (supabase/tests/vtid_04888_rule45.test.sql)
AC-2: Every other line of the four functions is identical to the live definitions captured before apply
(`live-functions-before.sql`, md5-verified against production); only the 3 marked lines per function differ.
  TEST: services/gateway/test/vtid-04888-rule45-exclusion.test.ts
AC-3: An excluded account's `global_community_profiles` row is always stored with `is_visible = false` (insert, update,
including a member-role update); listing an account later hides its profile; real profiles are unaffected.
  TEST: scripts/ci/test-vtid-04888-rule45.sh
AC-4: No `intent_matches` row pairing an excluded account is ever stored, whichever code writes it (either intent's
requester, or the profile fallback's `external_target_id`); real matches are stored.
  TEST: scripts/ci/test-vtid-04888-rule45.sh
AC-5: `is_excluded_account(uuid)` is executable by `service_role` only (no client enumeration of service/test accounts).
  TEST: scripts/ci/test-vtid-04888-rule45.sh
  TEST: services/gateway/test/vtid-04888-rule45-exclusion.test.ts
AC-6: The matchmaker profile fallback (`loadProfileFallback`) drops excluded accounts before the agent prompt.
  TEST: services/gateway/test/vtid-04888-rule45-exclusion.test.ts
AC-7: The data fix-up hides the 3 profiles, closes their 18 live intents, deletes their 16 recommendation rows, strips
them from 11 real members' recommendation rows (stale readback/summary cleared), deletes the 173 matches involving them,
is idempotent, and aborts without changing anything if a dependent row points at one of those matches.
  TEST: scripts/ci/test-vtid-04888-rule45.sh
AC-8: The rollback restores the four captured bodies and drops the triggers and helper (fix-up not rolled back).
  TEST: scripts/ci/test-vtid-04888-rule45.sh
AC-9: Operator, roles and support suites stay green.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

## Deferred (follow-ups)

- `countOpenIntentsExcludingUser` (matchmaker pool-size probe, mode label only) still counts excluded accounts' open
  intents; with their intents closed it counts none today. A NEW test account listed later with open intents would be
  counted again (no match can be created — the RPC predicates and the backstop prevent that).
- Events/groups created by excluded accounts in the vitana-v1 recommendation function (VTID-04889 plan, deferred).

## Scope

SCOPE_ALLOWLIST:
- supabase/migrations/20261005120000_vtid_04888_rule45_intents_profiles.sql (new)
- supabase/migrations/data-fixups/20261005120100_vtid_04888_rule45_cleanup.sql (new)
- supabase/tests/vtid_04888_fixture.sql, supabase/tests/vtid_04888_rule45.test.sql, scripts/ci/test-vtid-04888-rule45.sh (new)
- services/gateway/src/services/matchmaker-agent.ts (fallback filter; `loadProfileFallback` exported for the test)
- services/gateway/test/vtid-04888-rule45-exclusion.test.ts (new)
- DATABASE_SCHEMA.md, docs/validation/VTID-04888/**

## OASIS

OASIS_IMPACT: no — no event topic added or changed; the RPCs, triggers and fix-up emit nothing.

## Database apply

Applied to the shared Supabase project before merge (migration + fix-up), then verified read-only: live bodies' md5
equal the migration file's, triggers present, helper grants, and the post-apply counts in `outputs/`.

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy of the gateway with the matchmaker fallback filter. The database part is
already live (single shared project). No production gateway change until PUBLISH.
