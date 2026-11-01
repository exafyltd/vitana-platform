# Tasks — mt-identity-r2 (WS1 identity, tenancy resolution & roles; re-plan of mt-identity)

Authoritative plan: `plan.md`. Design and successor rules: `design.md`. Lane files: `lanes/`.
VTIDs: allocated by CI PLAN-SPAR after policy approval, never by hand. Each lane also writes its own
`docs/validation/<VTID>/` evidence, which Lane scope allows without a `paths` entry.
Every lane: `executor: kiro`, reviewed by `agent:vitana-lane-reviewer`; commits carry `Collab-Session` /
`Collab-Lane: mt-identity-r2/<lane>`. Migrations are applied by Kiro through `RUN-MIGRATION.yml` only after the owner
approves the files and the target database (`collaboration.md` §7d).

<!-- lane: helpers-and-policy-rewrite -->
## helpers-and-policy-rewrite — tenant_id_for_policies() + is_member() + bare-policy rewrite (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261102030000_vtid_xxxxx_tenant_id_for_policies_is_member.sql`
- `supabase/migrations/20261102030100_vtid_xxxxx_bare_policy_rewrite.sql`
- `supabase/migrations/20261102030100_vtid_xxxxx_bare_policy_rewrite_rollback.sql`
- `scripts/ci/bare-policy-lint.mjs`
- `services/gateway/test/mt-identity-bare-policy-lint.test.ts`
- `supabase/tests/mt_identity_helpers_*.sql`

- [ ] H1 Migration: `tenant_id_for_policies()` (new name, STABLE SECURITY DEFINER, N2 degraded path) and
      `is_member(tenant_id)` over the unique `(tenant_id, user_id)` index; both callable as `(select …)`. Do NOT
      redefine `current_tenant_id()`.
- [ ] H2 Migration: rewrite every bare `current_tenant_id()` policy to the user-private or tenant-shared form.
      Recount on 2026-11-01: 32 policies on 15 tables (`community_groups`, `community_meetups`, `community_listings`,
      `d42_domain_weights`, `event_attendance`, `live_highlights`, `live_room_attendance`, `live_rooms`,
      `products_catalog`, `services_catalog`, `tenant_catalog_overrides`, `match_targets`, `relationship_nodes`,
      `social_alignment_signals`, `topic_registry`). Re-run the recount against current migrations first and record
      the exact set, each policy's classification and the column evidence (`user_id` present or not) in the PR.
      Keep the extra predicates of `community_listings_select_public` and `d42_domain_weights_select`. Keep today's
      write audience (any tenant member). Do NOT create or relax policies on the 5 no-policy tables
      (`access_audit_log`, `consents`, `retrieval_traces`, `role_sessions`, `user_roles`); they are WS2/WS10.
- [ ] H3 Bare-policy lint (`scripts/ci/bare-policy-lint.mjs`) counting bare policies outside the owner-tagged
      tenant-shared allowlist; the N3 gate requires 0. A Jest test runs it over the migrations and asserts 0 after the
      rewrite. Red on `origin/main`: the lint reports the current set (32 on the 2026-11-01 recount).
- [ ] H4 Rollback migration (pre-approved); read-only pre/post checks and the MIGRATION-QUEUE row in
      `docs/validation/<vtid>/`.

Acceptance:
- Change types: Database, Tooling/docs.
- pgTAP: a_member cannot read a_admin's rows on every rewritten user-private policy (and, read-only, on the health
  tables). Tenant-shared (`is_member`) policies on all 15 tables admit same-tenant members only. The 5 no-policy
  tables are not asserted.
- The lint reads 0, and its red run on `origin/main` is recorded.
- The migrations apply and roll back clean on the local stack. The PR lists the recount output.
- Nothing is applied from the PR. Applying it is a later owner-approved `RUN-MIGRATION.yml` run (§7d).
- PR title `VTID-xxxxx (mt-identity-r2/helpers-and-policy-rewrite): …`.

<!-- lane: membership-unification -->
## membership-unification — user_tenants canonical, memberships → view, dual-write + drift (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261102031000_vtid_xxxxx_user_tenants_canonical.sql`
- `supabase/migrations/20261102031100_vtid_xxxxx_memberships_view_dualwrite.sql`
- `supabase/migrations/20261102031200_vtid_xxxxx_membership_drift_report.sql`
- `supabase/migrations/20261102031000_vtid_xxxxx_membership_unification_rollback.sql`
- `supabase/tests/mt_identity_membership_*.sql`

- [ ] M1 Backfill the drifted memberships-only rows into `user_tenants` (expand/contract, snapshot first), with
      `membership_side_effects_suppressed()` true for the backfill transaction (N1). Exclude the bot user `…0001`
      and every `service_bot_accounts` user from the backfill and the drift counts. Re-verify the counts read-only.
- [ ] M2 Replace `memberships` with a view over `user_tenants`. The dual-write trigger keeps legacy writers working
      and writes `ON CONFLICT (tenant_id, user_id) DO NOTHING`.
- [ ] M3 Nightly drift report (reads 0 when converged); rollback migration; MIGRATION-QUEUE rows and read-only checks
      in `docs/validation/<vtid>/`.

Acceptance:
- Change types: Database.
- Dual-write keeps `memberships` and `user_tenants` in sync, and the drift report reads 0.
- pgTAP: the four side-effect triggers do not fire on the backfill or on a re-insert of an existing row (0 welcome
  chats, founding seats, autopilot rows and live rooms). A bot-user insert yields 0 `chat_messages`.
- The migrations apply and roll back clean on the local stack. Nothing is applied from the PR.
- PR title `VTID-xxxxx (mt-identity-r2/membership-unification): …`.

<!-- lane: access-token-hook-shadow -->
## access-token-hook-shadow — custom access-token hook in SHADOW (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261102032000_vtid_xxxxx_access_token_hook_shadow.sql`
- `supabase/migrations/20261102032100_vtid_xxxxx_tenant_claim_mismatch_log.sql`
- `supabase/migrations/20261102032000_vtid_xxxxx_access_token_hook_shadow_rollback.sql`
- `supabase/tests/mt_identity_hook_*.sql`

- [ ] S1 Hook function reading the active `user_tenants` membership (treating `app_metadata.active_tenant_id` as a
      preference only), emitting `tenant_id_shadow` ONLY, failing open (`EXCEPTION WHEN OTHERS` → original claims),
      single indexed lookup, short statement timeout.
- [ ] S2 Mismatch-log table recording shadow-vs-membership disagreements as decisions for the 7-day soak.
      Service-role-only: `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT ALL … TO service_role`, RLS on, no
      policy.
- [ ] S3 Rollback migration; MIGRATION-QUEUE rows and read-only checks in `docs/validation/<vtid>/`. No auth-config
      change here. The GO-LIVE is a separate later owner-applied lane (D14).

Acceptance:
- Change types: Database.
- pgTAP: the hook returns the original claims on a forced error and never emits a top-level `tenant_id`. The mismatch
  log fills on a deliberate disagreement. `authenticated` cannot read the log; `service_role` can.
- The migrations apply and roll back clean on the local stack. Nothing is applied from the PR.
- PR title `VTID-xxxxx (mt-identity-r2/access-token-hook-shadow): …`.

<!-- lane: role-source-and-bootstrap -->
## role-source-and-bootstrap — one role source + fix bootstrap_admin_user (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261102033000_vtid_xxxxx_single_role_source.sql`
- `supabase/migrations/20261102033100_vtid_xxxxx_fix_bootstrap_admin_user.sql`
- `supabase/migrations/20261102033000_vtid_xxxxx_role_source_rollback.sql`
- `supabase/tests/mt_identity_roles_*.sql`

- [ ] R1 Make `user_tenants.active_role` the one role source of truth and derive the others from it; expand/contract,
      snapshot first.
- [ ] R2 Redefine `bootstrap_admin_user` (last definition: vitana-v1 `20250915132930_…:166`) to key on
      `tenants.is_default` (no `name = 'Maxina'` / `name IN (…)`) and write canonical `user_tenants` through the
      dual-write path. Keep the signature (`p_user_id`, `p_user_email`).
- [ ] R3 Rollback migration (restores the `20250915132930` body); MIGRATION-QUEUE rows and read-only checks in
      `docs/validation/<vtid>/`.

Acceptance:
- Change types: Database.
- `npm run test:roles` (42h) is green.
- pgTAP: `bootstrap_admin_user` grants admin in the `is_default` tenant with no tenant-name pin. The rollback restores
  the previous body.
- The migrations apply and roll back clean on the local stack. Nothing is applied from the PR.
- Depends on `membership-unification`. PR title `VTID-xxxxx (mt-identity-r2/role-source-and-bootstrap): …`.

<!-- lane: tenant-db-and-slug-cleanup -->
## tenant-db-and-slug-cleanup — tenantDb/TENANT_TABLES, isHealthTable()/healthDb, slug cleanup (repo vitana-platform)

Allowed paths:
- `services/gateway/src/services/tenancy/tenant-db.ts`
- `services/gateway/src/services/tenancy/tenant-db.test.ts`
- `services/gateway/src/services/tenancy/tenant-tables.ts`
- `services/gateway/src/services/tenancy/is-health-table.ts`
- `services/gateway/src/services/tenancy/is-health-table.test.ts`
- `services/gateway/src/services/tenancy/health-db.ts`
- `services/gateway/src/services/tenancy/tenant-context.ts`
- `services/gateway/src/routes/me.ts`
- `services/gateway/src/routes/dev-auth.ts`
- `services/gateway/src/services/orb-memory-bridge.ts`
- `services/gateway/src/routes/autopilot-prompts.ts`
- `services/gateway/src/middleware/auth-supabase-jwt-repository.ts`
- `services/gateway/src/routes/presence.ts`
- `services/gateway/src/routes/presence-repository.ts`
- `services/gateway/src/routes/presence-did-you-know.ts`
- `services/gateway/src/routes/presence-did-you-know-repository.ts`
- `services/gateway/test/mt-identity-slug-cleanup.test.ts`
- `services/gateway/test/mt-identity-primary-tenant-readers.test.ts`
- `services/gateway/test/mt-identity-tenant-slug-lookup.test.ts`
- `services/gateway/test/mt-identity-presence-tenant.test.ts`

- [ ] T1 `tenantDb(ctx)` wrapping the service-role client and injecting the tenant predicate for a schema-derived
      `TENANT_TABLES`; raw access allowlisted to platform/cron code. Dark behind `isMtResolutionV2Enabled()`
      (`services/mt-flags.ts:23`) / `tenant_settings.feature_flags.mt.*`; no second `MT_RESOLUTION_V2` reader.
- [ ] T2 Canonical `isHealthTable()` (ruling O1) + `healthDb(userId)` (frozen home tenant); health tables EXCLUDED
      from `TENANT_TABLES`.
- [ ] T3 Remove the slug maps at `routes/me.ts:15-27` and `routes/dev-auth.ts:26-30`, and the `…0001` pin in
      `services/orb-memory-bridge.ts:66-71` `DEV_IDENTITY` (`DEV_TENANT_SLUG`, default `vitana`, registry-resolved).
      Resolve through `TenantContext` + the DB registry.
- [ ] T3b Add `bySlug` + `getTenantIdBySlug(slug)` to `tenant-context.ts` (`loadTenantFlags()` `:70` builds only
      `byId`). `dev-auth.ts:491` uses it (unknown slug → 400 with the live slug list; registry unavailable → 503).
      `me.ts:270,408` use `(await getTenantMeta(id))?.slug ?? null`. Jest `mt-identity-tenant-slug-lookup.test.ts`:
      both directions round-trip, unknown → null.
- [ ] T3c (R3-F1) `dev-auth.ts:364`: resolve the tenant as the body's `tenant_id`, then `DEV_TENANT_ID`, then
      `await getDefaultTenantId()`. If none resolves and the role is a bootstrap role, return
      `503 { ok: false, error: 'REGISTRY_UNAVAILABLE' }` before `bootstrapRequestContext` and before
      `mintTokenForUser`.
- [ ] T4 Jest: `tenantDb` predicate injection; `isHealthTable()` matches the health set and health tables are absent
      from `TENANT_TABLES`; `healthDb` resolves the frozen home tenant; `me.ts`/`dev-auth.ts`/`orb-memory-bridge.ts`
      hold no `…0001`–`…0004` literal; ratchet: other `…0001` literals in non-test gateway TS outside
      `lib/vitana-bot.ts` never exceed the baseline (34 in 29 files on `62990ce285`, minus this lane's removals,
      recorded in the test).
- [ ] T4b Move the last `fetchPrimaryTenantForUser` callers (`routes/autopilot-prompts.ts:109`,
      `routes/presence.ts:55`, `routes/presence-did-you-know.ts:63`) to `resolvePrimaryTenant()` behind the flag;
      mark the three repo fns `@deprecated` and rewrite the `auth-supabase-jwt-repository.ts:17-21` comment. Jest
      `mt-identity-primary-tenant-readers.test.ts`;
      `test/vtid-05121-autopilot-prompts-not-behind-service-token.test.ts` stays green.
- [ ] T4c (R3-F2) Jest `mt-identity-presence-tenant.test.ts`: one supertest case per presence route, flag on (tenant
      equals `resolvePrimaryTenant()`'s `tenantId`, deprecated repo fn never called) and flag off (legacy call made).
- [ ] T5 Read-only staging spec + `docs/validation/<vtid>/` (scope.json, staging-tests.json).

Acceptance:
- Change types: Backend.
- Every new test was recorded red on `origin/main` before the fix, and is green after it.
- The full gateway Jest suite is green, and so are `npm run test:support` (42c) and `npm run test:operator` (42e).
- No fake-tenant literal remains in the three files, and nothing calls a live write.
- Depends on `helpers-and-policy-rewrite`. PR title `VTID-xxxxx (mt-identity-r2/tenant-db-and-slug-cleanup): …`.

## Escalation carry-over (from `mt-identity`, session `ee011de1`, round 3)
Each finding is answered in `plan.md` "Re-plan answers"; the tasks carry the acceptance.
- R3-F1 [major], verbatim: "Lane 5b replaces `dev-auth.ts:364`'s `DEV_TENANT_ID || '…0001'` with
  `getDefaultTenantId()`, which is declared `Promise<string | null>`. When the tenant-registry is unavailable
  (Supabase cold start, network failure) `getDefaultTenantId()` returns `null`, making `defaultTenantId = null` and
  `tenantId = tenant_id || null` when the caller omits `tenant_id`. `bootstrapRequestContext(supabase, null, role)` is
  then invoked with a null tenant. The existing code at line 372 treats bootstrap failure as non-fatal and continues
  to mint the JWT, so the silent path is: token minted with an undefined/null bootstrap tenant, returning a 200 with
  no error to the caller. The plan specifies no null-guard, no 503, and no last-resort fallback for this case."
  Task: `tenant-db-and-slug-cleanup` T3c.
  Acceptance: in `test/mt-identity-slug-cleanup.test.ts`, with `getDefaultTenantId()` stubbed to `null`,
  `DEV_TENANT_ID` unset, no `tenant_id` in the body and role `developer`, `POST /dev/auth/token` returns 503
  `REGISTRY_UNAVAILABLE`. `bootstrapRequestContext` and `mintTokenForUser` are not called, and the body carries no
  `token`. With `DEV_TENANT_ID` set, the same request returns 200 and bootstraps with that id. Both cases are red on
  `origin/main`, where the first returns 200.
- R3-F2 [minor], verbatim: "Lane 5c migrates `fetchPrimaryTenantForUser` in `presence.ts:55` and
  `presence-did-you-know.ts:63` (via `presence-repository.ts:22` and `presence-did-you-know-repository.ts:23`) to
  `resolvePrimaryTenant()`. Both repository files explicitly document 'zero coverage today.' The plan's Vitest
  section names only the 'existing `vtid-05121-autopilot-prompts-…` test' for 'the three callers,' without adding any
  new test for the presence paths. After this lane ships, the presence tenant-resolution migration has no regression
  coverage."
  Task: `tenant-db-and-slug-cleanup` T4c.
  Acceptance: `test/mt-identity-presence-tenant.test.ts` has, for each of `routes/presence.ts` and
  `routes/presence-did-you-know.ts`, a flag-on case (the tenant used equals the stubbed `resolvePrimaryTenant()`
  `tenantId`, the repository's `fetchPrimaryTenantForUser` is called 0 times) and a flag-off case (it is called once).
  The flag-on cases are red on `origin/main`, and all four are green on the lane head.
- Re-verification finding (this re-plan; not a partner finding): the bare-policy set is 32 policies on 15 tables, not
  19 on 11 (`plan.md` "Re-plan answers").
  Task: `helpers-and-policy-rewrite` H2, H3.
  Acceptance: the PR's recount lists `match_targets`, `relationship_nodes`, `social_alignment_signals` and
  `topic_registry`, and each policy is rewritten. pgTAP covers all 15 tables, and the lint reads 0.
