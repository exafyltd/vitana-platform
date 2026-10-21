# Tasks — mt-launch (WS8 Tenant Launch engineering)

Authoritative plan: `plan.md` (this folder). Design + successor rules: `design.md`. Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval. Every lane is dark by default and never writes to a live system.

<!-- lane: pack-intake-db -->
## pack-intake-db — tenant pack intake + content pipeline tables (repo vitana-platform)

Allowed paths:
- `supabase/migrations/20261101110000_mt_launch_tenant_pack_intake.sql`
- `supabase/migrations/20261101110100_mt_launch_tenant_content_pipeline.sql`
- `docs/multitenancy/MIGRATION-QUEUE.md`
- `scripts/ci/migration-drift-baseline.json`
- `services/gateway/test/mt-launch-pack-intake-pgtap.test.ts`

- [ ] P1 `tenant_pack_intake` table + `(tenant_id, item_key)` PK + status CHECK + service-role-only RLS (mirror
      `product_analytics_events`). Expand-only, no backfill.
- [ ] P2 `tenant_content_pipeline` table + `unique (tenant_id, locale, key)` + review_state CHECK + service-role RLS.
- [ ] P3 `get_tenant_launch_readiness(p_tenant_id)` SECURITY INVOKER STABLE, `SET search_path = public, pg_catalog`,
      EXECUTE revoked from PUBLIC/anon/authenticated, granted to service_role; reads only intake + `tenants`, no health table.
- [ ] P4 MIGRATION-QUEUE rows for both files, ordered AFTER WS5 `tenant_content_overrides`, with rollback paths +
      pre/post checks noted; add both tables to `scripts/ci/migration-drift-baseline.json` (removed after apply by Claude).
- [ ] P5 pgTAP: a non-service-role client read of either table fails; `get_tenant_launch_readiness` is read-only and
      returns for maxina; renumber migrations if a later one exists at build time.

Acceptance: migrations lint/apply clean on the local stack dry-run; pgTAP green; MIGRATION-QUEUE + drift baseline
updated; rollback SQL present under `docs/validation/<vtid>/`. Applied in production by Claude via RUN-MIGRATION.

<!-- lane: pack-intake-admin -->
## pack-intake-admin — intake API + AI content pipeline + linters (repo vitana-platform)

Allowed paths:
- `services/gateway/src/routes/tenant-admin/pack-intake.ts`
- `services/gateway/src/routes/tenant-admin/pack-intake-repository.ts`
- `services/gateway/src/services/tenant-launch/tenant-feature-flag.ts`
- `services/gateway/src/services/tenant-launch/tenant-feature-flag-repository.ts`
- `services/gateway/src/services/tenant-launch/health-claim-linter.ts`
- `services/gateway/src/services/tenant-launch/leftover-brand-linter.ts`
- `services/gateway/src/services/tenant-launch/undated-claim-linter.ts`
- `services/gateway/src/services/tenant-launch/content-pipeline.ts`
- `services/gateway/src/services/tenant-launch/publish.ts`
- `services/gateway/src/index.ts`
- `services/gateway/test/mt-launch-tenant-feature-flag.test.ts`
- `services/gateway/test/mt-launch-linters.test.ts`
- `services/gateway/test/mt-launch-pack-intake.test.ts`
- `docs/validation/VTID-mt-launch-pack-intake/**`

- [ ] P1 `pack-intake.ts` + repository seam: `GET/POST/PATCH /api/v1/admin/tenants/:tenantId/pack-intake`, tenant from
      the path segment only, `requireTenantAdmin` + exafy-admin for sensitive items; mounted in `index.ts`.
- [ ] P2 Per-tenant dark-flag resolver `tenant-feature-flag.ts` + repo seam `tenant-feature-flag-repository.ts`:
      `isTenantFeatureLive(tenantId, key)` reads `tenant_settings.feature_flags.<key>` strictly `=== true`, default OFF,
      lookup error ⇒ OFF, 5-min cache — a copy of `services/data-export-consent.ts` (NOT `isFeatureLive`, which is
      single-arg/global and cannot express a per-tenant flag). The other two code lanes import it.
- [ ] P3 Three pure linters (`(text)=>Finding[]`): health-claim, leftover-brand (`Maxina`/`Mariia` case-insensitive,
      immutable-identifier allowlist), undated-time-bound-claim.
- [ ] P4 `content-pipeline.ts` state machine (`generated→linted→in_review→signed_off→published`, `→rejected`);
      health-claim/leftover-brand findings block publish; undated warns.
- [ ] P5 `publish.ts` writes to `tenant_content_overrides` ONLY from `signed_off`, then seeds i18n; all gated by
      `isTenantFeatureLive(tenantId, 'mt.launch_pipeline')`. A missing-relation error (`42P01` / `PGRST205`) maps to
      409 `DEPENDENCY_NOT_READY` (row stays `signed_off`, OASIS `tenant.content.publish_blocked`), independent of the flag.
- [ ] P6 Jest: the resolver (`=== true` on, missing/non-boolean/error ⇒ off, cache); linters (block/warn, allowlist),
      route auth gates (non-admin 403, T_B admin blocked from T_A), publish refuses from non-`signed_off`; publish answers
      409 `DEPENDENCY_NOT_READY` on `42P01` and on `PGRST205`;
      `docs/validation/<vtid>/` scope.json + staging-tests.json + plan copy.

Acceptance: full `npm test` (gateway Jest) green incl. new suites; dark flag off = no behaviour change; Lane scope +
sparring + weakening checks green. Never calls a write endpoint against a live system; publish path reaches
`tenant_content_overrides` only via a migration-created table (WS5 dependency).

<!-- lane: tenant-owner-analytics -->
## tenant-owner-analytics — tenant-owner funnel + D18 lineage guard (repo vitana-platform)

Allowed paths:
- `services/gateway/src/routes/tenant-admin/owner-analytics.ts`
- `services/gateway/src/routes/tenant-admin/owner-analytics-repository.ts`
- `services/gateway/src/index.ts`
- `services/gateway/test/mt-launch-owner-analytics.test.ts`
- `services/gateway/test/mt-launch-owner-analytics-health-boundary.test.ts`
- `docs/validation/VTID-mt-launch-owner-analytics/**`

- [ ] P1 `owner-analytics.ts` + repository seam: `GET /api/v1/admin/tenants/:tenantId/owner-analytics/{signups,
      activation,journey,events,retention}`, `requireTenantAdmin`, tenant from the path segment; reads
      `product_analytics_events`/rollups + `get_tenant_launch_readiness`; mounted in `index.ts`. Dark behind
      `isTenantFeatureLive(tenantId, 'mt.launch_analytics')` (the resolver `pack-intake-admin` creates — imported read-only).
- [ ] P2 D18 guard `mt-launch-owner-analytics-health-boundary.test.ts`: copy the VTID-05025 pattern; list the
      owner-analytics source files; assert no health-table match + no health repository import; explicit read allowlist
      `product_analytics_events`, `product_analytics_daily_rollups`, `tenant_pack_intake`, `tenant_content_pipeline`, `tenants`, RPC `get_tenant_launch_readiness` — every `.from('…')`/`.rpc('…')` name outside it fails; inline `HEALTH_TABLES` regex (as
      `vtid-05025`), migrated to mt-identity `isHealthTable()` once it ships; self-test plants a read.
- [ ] P3 Jest: handlers tenant-scoped, no health read, non-admin 403, T_B admin blocked from T_A; `docs/validation/<vtid>/`.

Acceptance: full `npm test` green incl. the health-boundary guard; dark flag off = endpoints gated; Lane scope +
sparring + weakening checks green.

<!-- lane: support-landing -->
## support-landing — per-tenant support routing + landing SEO/OG (repo vitana-platform)

Allowed paths:
- `services/gateway/src/services/tenant-launch/support-routing.ts`
- `services/gateway/src/routes/feedback-admin.ts`
- `services/gateway/src/routes/feedback-intake.ts`
- `services/gateway/src/routes/landing-seo.ts`
- `services/gateway/src/routes/community-invites.ts`
- `services/gateway/test/mt-launch-support-landing.test.ts`
- `docs/validation/VTID-mt-launch-support-landing/**`

- [ ] P1 `support-routing.ts`: resolve answerer + SLA + contact from `tenants.support_email`/`sender_*` +
      `tenant_settings.feature_flags.mt.support`; dark behind `isTenantFeatureLive(tenantId, 'mt.launch_support')` (the
      resolver `pack-intake-admin` creates — imported read-only; off = byte-identical to today).
- [ ] P2 Call the resolver from `feedback-admin.ts` / `feedback-intake.ts` so a tenant's tickets carry its routing;
      no change to ticket pipeline contract (keep `npm run test:support` green).
- [ ] P3 `landing-seo.ts`: surface the tenant's `landing`/`og_image` brand-pack fields through the public registry read
      path (reuse the Lane-C whitelist; add no new registry key).
- [ ] P3b `community-invites.ts` `/claim` (`:72-80`): add `tenant_id` = `resolvePrimaryTenant(identity.user_id)` (service-role,
      membership-authoritative; JWT `identity.tenant_id` not used; unresolved ⇒ null, never `DEFAULT_TENANT_ID`) to the
      attribution OASIS payload behind `mt.launch_support`. `admin-signups.ts` is NOT touched (owned by mt-jobs
      VTID-05267); before opening the PR verify on `origin/main` that VTID-05267 merged, else stop with
      `next_actor: claude`.
- [ ] P4 Jest + `npm run test:support`: resolver mapping, flag-off no-op, SEO/OG read shape, a non-default-tenant
      `/claim` event carries its own `tenant_id`; an active-tenant ≠ primary-tenant member gets the primary; `docs/validation/<vtid>/`.

Acceptance: full `npm test` + `npm run test:support` green; dark flag off = no behaviour change; Lane scope + sparring +
weakening checks green.

<!-- lane: worker-test-gate -->
## worker-test-gate — CI gate for linters, D18 guard, golden (repo vitana-platform, executor claude)

Allowed paths:
- `.github/workflows/PR-GATE.yml`
- `.github/workflows/mt-launch-suites.yml`

- [ ] P1 Add the three linter suites, the D18 analytics health-boundary guard, and the unchanged Maxina golden assertion
      to the gateway Jest job / PR-GATE so WS8 code cannot merge without them.
- [ ] P2 No source changes; governance paths only; executor claude per collaboration §3a/§7a.

Acceptance: PR-GATE runs the suites; the gate fails if any is removed; no non-workflow file touched.
