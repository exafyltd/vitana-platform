# Tasks — mt-identity (WS1 identity, tenancy resolution & roles)

Authoritative plan: `plan.md`. Design and successor rules: `design.md`. Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval.

<!-- lane: helpers-and-policy-rewrite -->
## helpers-and-policy-rewrite — tenant_id_for_policies() + is_member() + bare-policy rewrite (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261101030000_vtid_xxxxx_tenant_id_for_policies_is_member.sql`
- `supabase/migrations/20261101030100_vtid_xxxxx_bare_policy_rewrite.sql`
- `supabase/migrations/20261101030100_vtid_xxxxx_bare_policy_rewrite_rollback.sql`
- `scripts/ci/bare-policy-lint.mjs`
- `services/gateway/test/mt-identity-bare-policy-lint.test.ts`

- [ ] H1 Migration: `tenant_id_for_policies()` (new name, STABLE SECURITY DEFINER, N2 degraded path) and
      `is_member(tenant_id)` over the unique `(tenant_id, user_id)` index; both callable as `(select …)`. Do NOT
      redefine `current_tenant_id()`.
- [ ] H2 Migration: rewrite every bare `current_tenant_id()` policy to the user-private or tenant-shared form.
      Recounted this review: 19 bare policies on 11 tables (community_groups, community_meetups, community_listings,
      d42_domain_weights, event_attendance, live_highlights, live_room_attendance, live_rooms, products_catalog,
      services_catalog, tenant_catalog_overrides). Re-run the recount against current migrations first and record the
      exact set in the PR. Do NOT create or relax policies on the 5 no-policy tables (access_audit_log, consents,
      retrieval_traces, role_sessions, user_roles) — WS2/WS10, out of scope.
- [ ] H3 Bare-policy lint (`scripts/ci/bare-policy-lint.mjs`) counting bare policies outside the owner-tagged
      tenant-shared allowlist; the N3 gate requires 0. Vitest asserts 0 after the rewrite.
- [ ] H4 Rollback migration (pre-approved); read-only pre/post checks and the MIGRATION-QUEUE row in
      `docs/validation/<vtid>/`.

Acceptance: pgTAP shows a_member cannot read a_admin's user-private rows on each of the 11 rewritten tables (and,
read-only, the health tables); tenant-shared (`is_member`) policies admit same-tenant members only; the 5 no-policy
tables are not asserted; the lint reads 0; migrations apply + roll back clean on the local stack. Claude applies via RUN-MIGRATION after merge. PR title
`VTID-xxxxx (mt-identity/helpers-and-policy-rewrite): …`; commits carry `Collab-Session` / `Collab-Lane`.

<!-- lane: membership-unification -->
## membership-unification — user_tenants canonical, memberships → view, dual-write + drift (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261101031000_vtid_xxxxx_user_tenants_canonical.sql`
- `supabase/migrations/20261101031100_vtid_xxxxx_memberships_view_dualwrite.sql`
- `supabase/migrations/20261101031200_vtid_xxxxx_membership_drift_report.sql`
- `supabase/migrations/20261101031000_vtid_xxxxx_membership_unification_rollback.sql`

- [ ] M1 Backfill the drifted memberships-only rows into `user_tenants` (expand/contract, snapshot first), suppressing
      the four `user_tenants` AFTER INSERT triggers for the backfill transaction (N1). Exclude the bot user `…0001`
      and every `service_bot_accounts` user from the backfill and drift counts. Re-verify counts read-only.
- [ ] M2 Replace `memberships` with a view over `user_tenants`; dual-write trigger keeps legacy writers working.
- [ ] M3 Nightly drift report (reads 0 when converged); rollback migration; MIGRATION-QUEUE rows + read-only checks in
      `docs/validation/<vtid>/`.

Acceptance: dual-write keeps `memberships` and `user_tenants` in sync; drift report reads 0; the four side-effect
triggers do not fire on the backfill (pgTAP: 0 welcome chats / founding seats / autopilot rows / live rooms);
migrations apply + roll back clean. PR title `VTID-xxxxx (mt-identity/membership-unification): …`.

<!-- lane: access-token-hook-shadow -->
## access-token-hook-shadow — custom access-token hook in SHADOW (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261101032000_vtid_xxxxx_access_token_hook_shadow.sql`
- `supabase/migrations/20261101032100_vtid_xxxxx_tenant_claim_mismatch_log.sql`
- `supabase/migrations/20261101032000_vtid_xxxxx_access_token_hook_shadow_rollback.sql`

- [ ] S1 Hook function reading the active `user_tenants` membership (treating `app_metadata.active_tenant_id` as a
      preference only), emitting `tenant_id_shadow` ONLY, failing open (`EXCEPTION WHEN OTHERS` → original claims),
      single indexed lookup, short statement timeout.
- [ ] S2 Mismatch-log table recording shadow-vs-membership disagreements as decisions for the 7-day soak.
- [ ] S3 Rollback migration; MIGRATION-QUEUE rows + read-only checks in `docs/validation/<vtid>/`. No auth-config
      change here — the GO-LIVE is a separate later owner-applied lane (D14).

Acceptance: pgTAP shows the hook returns original claims on a forced error and never emits a top-level `tenant_id`;
the mismatch log fills on a deliberate disagreement; migrations apply + roll back clean. PR title
`VTID-xxxxx (mt-identity/access-token-hook-shadow): …`.

<!-- lane: role-source-and-bootstrap -->
## role-source-and-bootstrap — one role source + fix bootstrap_admin_user (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261101033000_vtid_xxxxx_single_role_source.sql`
- `supabase/migrations/20261101033100_vtid_xxxxx_fix_bootstrap_admin_user.sql`
- `supabase/migrations/20261101033000_vtid_xxxxx_role_source_rollback.sql`

- [ ] R1 Pick one role source of truth (proposed `user_tenants.active_role`); make the others derive from it;
      expand/contract, snapshot first.
- [ ] R2 Rewrite `bootstrap_admin_user` to key on `tenants.is_default` (drop `name = 'Maxina'`) and write canonical
      `user_tenants` through the dual-write path.
- [ ] R3 Rollback migration; MIGRATION-QUEUE rows + read-only checks in `docs/validation/<vtid>/`.

Acceptance: `npm run test:roles` (42h) green; `bootstrap_admin_user` grants admin in the default tenant with no Maxina
pin; migrations apply + roll back clean. Depends on `membership-unification`. PR title
`VTID-xxxxx (mt-identity/role-source-and-bootstrap): …`.

<!-- lane: tenant-db-and-slug-cleanup -->
## tenant-db-and-slug-cleanup — tenantDb/TENANT_TABLES, isHealthTable()/healthDb, slug cleanup (repo vitana-platform)

Allowed paths:
- `services/gateway/src/services/tenancy/tenant-db.ts`
- `services/gateway/src/services/tenancy/tenant-db.test.ts`
- `services/gateway/src/services/tenancy/tenant-tables.ts`
- `services/gateway/src/services/tenancy/is-health-table.ts`
- `services/gateway/src/services/tenancy/is-health-table.test.ts`
- `services/gateway/src/services/tenancy/health-db.ts`
- `services/gateway/src/routes/me.ts`
- `services/gateway/src/routes/dev-auth.ts`
- `services/gateway/src/services/orb-memory-bridge.ts`
- `services/gateway/test/mt-identity-slug-cleanup.test.ts`
- `services/gateway/src/routes/autopilot-prompts.ts`
- `services/gateway/src/middleware/auth-supabase-jwt-repository.ts`
- `services/gateway/src/routes/presence.ts`
- `services/gateway/src/routes/presence-repository.ts`
- `services/gateway/src/routes/presence-did-you-know.ts`
- `services/gateway/src/routes/presence-did-you-know-repository.ts`
- `services/gateway/test/mt-identity-primary-tenant-readers.test.ts`
- `services/gateway/src/services/tenancy/tenant-context.ts`
- `services/gateway/test/mt-identity-tenant-slug-lookup.test.ts`

- [ ] T1 `tenantDb(ctx)` wrapping the service-role client and injecting the tenant predicate for a schema-derived
      `TENANT_TABLES`; raw access allowlisted to platform/cron code. Dark behind `MT_RESOLUTION_V2` /
      `tenant_settings.feature_flags.mt.*`.
- [ ] T2 Canonical `isHealthTable()` (ruling O1) + `healthDb(userId)` (frozen home tenant); health tables EXCLUDED
      from `TENANT_TABLES`.
- [ ] T3 Remove the slug maps / fake tenant ids / `limit(1)` at `routes/me.ts:15-26`, `routes/dev-auth.ts:26-29`,
      `services/orb-memory-bridge.ts` `DEV_IDENTITY` (~lines 65-77); resolve through `TenantContext` + the DB registry.
- [ ] T4 Vitest: `tenantDb` predicate injection; `isHealthTable()` matches the health set and health tables are absent
      from `TENANT_TABLES`; `healthDb` resolves the frozen home tenant; `me.ts`/`dev-auth.ts`/`orb-memory-bridge.ts`
      hold no `…0001`–`…0004` literal; ratchet: other `…0001` literals outside `lib/vitana-bot.ts` never exceed the
      recorded baseline.
- [ ] T3b Add `bySlug` + `getTenantIdBySlug(slug)` to `tenant-context.ts` (`loadTenantFlags()` builds only `byId`);
      `dev-auth.ts:491` uses it (unknown → 400 with live slug list, unavailable → 503); `me.ts:270,408` use
      `getTenantMeta(id)?.slug`. Vitest `mt-identity-tenant-slug-lookup.test.ts`: both directions round-trip, unknown → null.
- [ ] T4b Move the last `fetchPrimaryTenantForUser` callers (`routes/autopilot-prompts.ts:109`, `routes/presence.ts:55`,
      `routes/presence-did-you-know.ts:63`) to `resolvePrimaryTenant()` behind the flag; mark the three repo fns
      `@deprecated` and rewrite the `auth-supabase-jwt-repository.ts:17` forward-reference; Vitest
      `mt-identity-primary-tenant-readers.test.ts`; `vtid-05121-autopilot-prompts-…` stays green.
- [ ] T5 Read-only staging spec + `docs/validation/<vtid>/` (scope.json, staging-tests.json).

Acceptance: all Vitest green; full gateway suite green; `npm run test:support` (42c) + `npm run test:operator` (42e)
green; no fake-tenant literal remains; nothing calls a live write. Depends on `helpers-and-policy-rewrite`. PR title
`VTID-xxxxx (mt-identity/tenant-db-and-slug-cleanup): …`.

## Escalation carry-over (owner approved escalated, 2026-10-20)

The plan was round-capped and escalated (session `ee011de1`, s2 round 3); the owner approved it as escalated on
2026-10-20 ("yes, A all 4 approved"). The open last-round findings are folded into the lane tasks here; `plan.md`
is unchanged.

- R3-F1 [major] — "Lane 5b replaces `dev-auth.ts:364`'s `DEV_TENANT_ID || '…0001'` with `getDefaultTenantId()`,
  which is declared `Promise<string | null>`."
  Lane `tenant-db-and-slug-cleanup`, added task:
  - [ ] T3c In `dev-auth.ts` (~:364), when the body has no `tenant_id`, `DEV_TENANT_ID` is unset and
        `getDefaultTenantId()` resolves `null`, return `503 { ok: false, error: 'REGISTRY_UNAVAILABLE' }` before
        `bootstrapRequestContext` runs and before any token is minted; a null tenant never reaches
        `bootstrapRequestContext`.
        Acceptance (carry-over R3-F1): a test (in `mt-identity-slug-cleanup.test.ts`) with `getDefaultTenantId()`
        stubbed to `null` and no `tenant_id` asserts `POST /dev/auth/token` returns 503 (not 200) and
        `bootstrapRequestContext` is not called.
- R3-F2 [minor] — "Lane 5c migrates `fetchPrimaryTenantForUser` in `presence.ts:55` and `presence-did-you-know.ts:63`
  (via `presence-repository.ts:22` and `presence-did-you-know-repository.ts:23`) to `resolvePrimaryTenant()`."
  Lane `tenant-db-and-slug-cleanup`, added task:
  - [ ] T4c Add one test per presence route (in `mt-identity-primary-tenant-readers.test.ts`) that stubs the route's
        repository `fetchPrimaryTenantForUser` and, with `MT_RESOLUTION_V2` on, asserts the tenant used matches
        `resolvePrimaryTenant()`'s return value and the deprecated repo function is never called.
        Acceptance (carry-over R3-F2): both `presence.ts` and `presence-did-you-know.ts` tenant resolution are
        covered and green.
