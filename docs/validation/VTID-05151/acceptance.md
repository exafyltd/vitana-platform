# VTID-05151 - Public tenant registry + legacy landing seed (multi-tenant M0, lane C, PR1 platform)

Owner approval 2026-10-13 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 2 rounds).

VALIDATION_PROFILE: gateway_backend

Scope of this PR: two migrations (not applied by merge; applied through `RUN-MIGRATION.yml` in the
owner-approved window after the local-harness dry run), their rollbacks, pre/post checks, the
local-Postgres harness and the Jest guard. No gateway source change. The vitana-v1 consumers
(registry client, `useTenant`, generic `/:tenantSlug` portal) ship in two vitana-v1 PRs with their
own evidence under `docs/validation/VTID-05151/` in that repo.

OASIS_PROOF: none; no event is emitted or changed.

## Acceptance criteria

AC-1: An anonymous visitor can list and resolve the active, slugged, non-platform tenants through `list_public_tenants()` / `resolve_tenant(p_slug)` (STABLE SECURITY DEFINER, GET-able, granted to anon/authenticated/service_role after revoking PUBLIC); inactive and slug-less tenants never appear.
  TEST: supabase/tests/vtid_05151_public_tenant_registry.test.sql (cases a, b, d) via scripts/ci/test-vtid-05151-public-tenant-registry.sh
  TEST: services/gateway/test/vtid-05151-public-tenant-registry-migration.test.ts

AC-2: `resolve_tenant` returns 0 or 1 row for `lower(btrim(p_slug))` and never falls back (unknown, empty, NULL and prefix slugs are empty).
  TEST: supabase/tests/vtid_05151_public_tenant_registry.test.sql (case c)
  TEST: services/gateway/test/vtid-05151-public-tenant-registry-migration.test.ts

AC-3: Only whitelisted fields leave the functions: brand {accent,bg,fg,logo_path,favicon_path,og_image_path}, landing {tagline,intro,auto_switch_on_visit,post_login_path,oauth}, locales; planted secrets in branding/profile/integrations/billing/policy_profile never appear; mistyped values are dropped.
  TEST: supabase/tests/vtid_05151_public_tenant_registry.test.sql (cases a, f)
  TEST: services/gateway/test/vtid-05151-public-tenant-registry-migration.test.ts

AC-4: The internal `_tenant_public_registry()` is not SECURITY DEFINER and no client role can execute it; anon and non-member reads of `tenants` / `tenant_settings` are unchanged.
  TEST: supabase/tests/vtid_05151_public_tenant_registry.test.sql (case d)

AC-5: Forward compatibility: once lane A adds `tenants.is_platform` and lane B adds `tenant_settings.brand/landing/locales`, the platform row disappears and the new columns override the legacy keys, without re-creating the functions and still through the whitelist.
  TEST: supabase/tests/vtid_05151_public_tenant_registry.test.sql (case e)

AC-6: The seed gives alkalma display name "AlKalma" with its compiled colours and both legacy tenants their landing data (maxina post-login /onboarding/welcome, alkalma /home); existing keys win; exactly 2 rows; snapshot in legacy_archive first; re-running changes nothing.
  TEST: scripts/ci/test-vtid-05151-public-tenant-registry.sh (idempotency check + case a)
  TEST: services/gateway/test/vtid-05151-public-tenant-registry-migration.test.ts

AC-7: Both migrations assert their end state by effect and abort as a whole otherwise (the seed refuses before the registry exists and leaves nothing behind); both rollbacks restore the previous state and the migrations re-apply cleanly afterwards.
  TEST: scripts/ci/test-vtid-05151-public-tenant-registry.sh (order guard, rollback, re-apply)

AC-8: The VTID-05041 SECURITY DEFINER guard stays green (revokes + `definer-public` reason present).
  TEST: services/gateway/test/vtid-05041-definer-lockdown.test.ts

AC-9: Both migrations are recorded in `docs/multitenancy/MIGRATION-QUEUE.md` with rollbacks and the A/B cross-lane follow-ups; the lane B column contract is in `docs/multitenancy/LANE-C.md`.
  TEST: services/gateway/test/vtid-05151-public-tenant-registry-migration.test.ts

## Post-apply (read-only, after the owner-approved `RUN-MIGRATION.yml` run)

AC-10: `post-check.sql` returns anon_list/anon_resolve true, internal false, legacy_rows 2, unknown_empty true, exactly the maxina and alkalma rows, and no unexpected key.
  CURL: GET <supabase>/rest/v1/rpc/list_public_tenants with the anon key -> 200, maxina + alkalma, whitelisted keys only (vitana-v1 staging spec tests/e2e/staging/vtid-05151-tenant-registry.staging.spec.ts)
