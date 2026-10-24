# Tasks — mt-m3 (M3 generally provisionable)

Authoritative plan: `plan.md`. Lane files: `lanes/`. VTID: allocated by PLAN-SPAR after approval.

<!-- lane: tenant-domains-db -->
## tenant-domains-db — tenant_domains table + resolve_tenant host arm (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101140000_vtid_*_mt_tenant_domains.sql`,
`supabase/migrations/20261101140000_vtid_*_mt_tenant_domains_rollback.sql`,
`supabase/migrations/20261101140100_vtid_*_mt_resolve_tenant_host.sql`,
`supabase/migrations/20261101140100_vtid_*_mt_resolve_tenant_host_rollback.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`. The lane also creates
`docs/validation/<vtid>/`.

- [ ] D1 `20261101140000` `tenant_domains(id, tenant_id uuid FK tenants, host citext UNIQUE, is_primary bool,
      verified_at, created_at)`; RLS enabled with NO client policy (service-role/exafy-admin only); host format CHECK;
      reserved-slug hosts rejected by a `BEFORE INSERT OR UPDATE OF host` trigger `tenant_domains_reject_reserved()`
      (`EXISTS (SELECT 1 FROM reserved_tenant_slugs r WHERE r.slug = lower(btrim(NEW.host)))` → RAISE) — a CHECK cannot
      read another table. Rollback drops trigger, fn and table.
- [ ] D2 `20261101140100` add a SEPARATE 2-arg overload `resolve_tenant(p_host text, p_slug text)` with NO parameter
      DEFAULTs; the VTID-05151 1-arg `resolve_tenant(p_slug text)` is NOT touched (its caller v1
      `src/lib/tenant-registry.ts:219` passes `{ p_slug }` and keeps binding it). The overload resolves a host ONLY when
      its `tenant_domains` row has `verified_at IS NOT NULL` and ONLY through `_tenant_public_registry()` (so the
      `is_active AND is_platform = false` filter still applies), else returns `resolve_tenant(p_slug)`; an unverified/
      inactive/platform host resolves empty and falls through to slug. Same 8-column return and grants as the 1-arg —
      no `tenant_domains` column (Lane C whitelist). Rollback drops only the 2-arg overload.
- [ ] D3 pgTAP: `tenant_domains` RLS (anon/b_member cannot read or write; service/exafy-admin can); `resolve_tenant`
      resolves a VERIFIED host, falls back to slug; INSERT and UPDATE of a host equal to a reserved slug both raise
      (trigger); an UNVERIFIED host (`verified_at IS
      NULL`) and a host on an INACTIVE or PLATFORM tenant BOTH resolve empty; the 1-arg `resolve_tenant(p_slug)` output
      is byte-identical before/after and a `{p_slug}`-only call binds it; both overloads return the same 8 columns.
- [ ] D4 MIGRATION-QUEUE rows appended after the current live last row (today row 8 `20261014000700`), + an mt-m3
      header range note `20261101140000–145959`; the `1101140000+` range sorts after any mt-tenant-admin `070xxx` rows
      so no re-position is needed. Add `tenant_domains` to `migration-drift-baseline.json`, note its removal in the
      post-apply PR. Read-only pre/post check SQL in `docs/validation/<vtid>/`.

Acceptance: expand-only; rollbacks + pre/post checks; QUEUE rows; pgTAP green. No Supabase/AWS writes. PR title
`VTID-xxxxx (mt-m3/tenant-domains-db): …`; commits carry `Collab-Session` / `Collab-Lane: mt-m3/tenant-domains-db`.

<!-- lane: host-resolution-gw -->
## host-resolution-gw — gateway host arm in TenantContext (repo vitana-platform)

Allowed paths: `services/gateway/src/services/tenancy/tenant-context.ts`,
`services/gateway/src/middleware/auth-supabase-jwt.ts`, `services/gateway/test/mt-m3-host-resolution*.test.ts`. The lane
also creates `docs/validation/<vtid>/`.

- [ ] H1 Add a host arm as the NEW FIRST arm of `getTenantContext()` (`auth-supabase-jwt.ts:635-650`): resolve
      `req.hostname` through `resolve_tenant(host,…)`, then the unchanged token arm (`:639-646`), then the primary
      fallback (`:647-649`) — the gateway has no slug/claim arm; sets context only. Add `'host'` to the `TenantSource` union (`tenant-context.ts:22`) and update every consumer so TS compiles
      (`auth-supabase-jwt.ts:35,579,607,617` — `PrimaryTenantOutcome`, `tokenTenantOrigin`, the `source` param). Dark
      behind `MT_RESOLUTION_V2`.
- [ ] H1b Hot-path budget (`AUTH_LOOKUP_TIMEOUT_MS=2500`, `auth-supabase-jwt.ts:63-69`): look up ONLY when the flag is
      on AND `req.hostname` is not a platform host (one constant in `tenant-context.ts`: `vitanaland.com` + subdomains,
      `localhost`, staging/ALB hosts); bounded host→tenant cache (hits and misses) with the 60s `tenantMetaCache` TTL
      (`tenant-context.ts:66-86`); RPC under `abortAfter(AUTH_LOOKUP_TIMEOUT_MS)` (`:71`); timeout/error → logged, the
      host arm yields nothing and the next arm runs.
- [ ] H2 Membership still required for data: re-check the host-resolved tenant through the existing VTID-05043
      `lookupTenantMembership(user_id, tenant_id)` (`:531`; positive cached 60s, negatives never cached), exafy_admin
      skip as at `:640`; `not_member` → the existing join posture, `unavailable` → fail-closed 503 as in
      `applyTenantMembershipResult` (`:656-680`). No new membership RPC, never a silent default.
- [ ] H3 Jest/Vitest: host arm precedence over token/primary; no data without membership (contract test: the
      host-resolved tenant_id is passed to `lookupTenantMembership`, a repeat hits its cache, no other membership query); flag-off path byte-identical to
      today; no RPC for a platform host; cache hit skips the RPC; timeout falls through to the next arm. `npm run test:support` + `npm run test:operator` stay green if touched.
- [ ] H4 `docs/validation/<vtid>/`: `scope.json`, `staging-tests.json` (read-only), plan-sparring copy.

Acceptance: dark behind the flag; tests green; depends on `tenant-domains-db`. No live writes. PR title
`VTID-xxxxx (mt-m3/host-resolution-gw): …`; commits carry `Collab-Session` / `Collab-Lane: mt-m3/host-resolution-gw`.

<!-- lane: tenant-switcher-ui -->
## tenant-switcher-ui — member community switcher (repo vitana-v1)

Allowed paths (vitana-v1): `src/components/tenant-switcher/**`, `src/pages/settings/**`,
`src/i18n/de/tenantSwitcher.json`, `src/i18n/en/tenantSwitcher.json`,
`tests/e2e/staging/vtid-*-tenant-switcher.staging.spec.ts`, `docs/validation/VTID-*/**`, `docs/SCREEN_INVENTORY.md`,
`i18n-source-stamps/**`.

- [ ] S1 `CommunitySwitcher` in `src/components/tenant-switcher/`: list the member's own memberships from
      `useMemberships()` (no-arg → `list_my_memberships`, `src/hooks/useMemberships.ts:23-30`; rows carry
      `tenant_id` + `tenants.slug`, deduped by `tenant_id`), using the public registry only to resolve each membership's
      brand for display (never list the public registry itself); switch via `useTenant().setTenantBySlug`
      (`useTenant.tsx:170`); hidden when <2 distinct tenants; NOT exafy-admin-gated (`canSwitchTenant`,
      `permissions.ts:24`, stays the admin path).
- [ ] S2 Mount in Settings (`src/pages/settings/**`); Spotlight tokens, logical start/end, skeletons; RTL.
- [ ] S3 i18n `src/i18n/de/tenantSwitcher.json` first (du-form), mirrored to `en/`; `npm run i18n:inventory`.
- [ ] S4 Vitest: lists only own memberships; hidden for a single-tenant member; calls the switch; no non-GET on render.
- [ ] S5 Staging spec (read-only): a single-tenant test user sees no switcher; network guard aborts non-GET.
- [ ] S6 `docs/validation/VTID-*/`: `scope.json`, `staging-tests.json`, plan-sparring copy.

Acceptance: Vitest + full `npx vitest run` green; ESLint i18n + design clean on new files; `npm test` (nav/design
manifest) unaffected unless a route is added (then registry+manifest+parity rows in this lane). No live writes. PR title
`VTID-xxxxx (mt-m3/tenant-switcher-ui): …`; commits carry `Collab-Session` / `Collab-Lane: mt-m3/tenant-switcher-ui`.

<!-- lane: native-domains-aasa -->
## native-domains-aasa — AASA/assetlinks custom-domain readiness (repo vitana-v1)

Allowed paths (vitana-v1): `public/.well-known/apple-app-site-association`, `public/.well-known/assetlinks.json`,
`apps/mobile/parity/**`, `scripts/native/**`, `src/lib/universal-links/**` (incl. its test file),
`docs/validation/VTID-*/**`.

- [ ] N1 Keep the single `vitanaland.com` AASA/assetlinks set covering path-slug tenants; add a README/generation note.
- [ ] N2 Guard test (`src/lib/universal-links/`): committed AASA/assetlinks stay valid JSON + shape; a `tenant_domains`
      host needing native reach is flagged as requiring a per-domain app release (entitlements) — not silently covered.
- [ ] N3 Parity-ledger row if a mobile-visible surface changes (`node scripts/native/parity-ledger.mjs --sync`).
- [ ] N4 `docs/validation/VTID-*/`: `scope.json`, plan-sparring copy.

Acceptance: guard test green; no store submission (owner-gated native release). PR title
`VTID-xxxxx (mt-m3/native-domains-aasa): …`; commits carry `Collab-Session` / `Collab-Lane: mt-m3/native-domains-aasa`.

<!-- lane: provision-erp-monitoring-db -->
## provision-erp-monitoring-db — ERP bootstrap request + per-tenant isolation health (repo vitana-platform)

Allowed paths: `supabase/migrations/20261101141000_vtid_*_mt_provision_erp_request.sql`,
`supabase/migrations/20261101141000_vtid_*_mt_provision_erp_request_rollback.sql`,
`supabase/migrations/20261101141100_vtid_*_mt_isolation_health_by_tenant.sql`,
`supabase/migrations/20261101141100_vtid_*_mt_isolation_health_by_tenant_rollback.sql`,
`docs/multitenancy/MIGRATION-QUEUE.md`, `scripts/ci/migration-drift-baseline.json`. The lane also creates
`docs/validation/<vtid>/`.

- [ ] E1 `20261101141000` extend `provision_tenant()` to idempotently record the ERP bootstrap request
      (`tenant_settings.feature_flags.erp.bootstrap_requested`). Because the `tenant_settings` INSERT is `ON CONFLICT
      (tenant_id) DO NOTHING`, add a guarded `UPDATE ... jsonb_set(feature_flags,'{erp,bootstrap_requested}','true',true)
      WHERE tenant_id = v_tid AND NOT (feature_flags #> '{erp,bootstrap_requested}' = 'true')` AFTER the INSERT so an
      already-provisioned re-run still records it; every existing assertion still holds. Make `erp` a governed key: the
      same migration re-creates `tenant_settings_merge_feature_flags()` (`20261014000400_…:175-193`) dropping
      `- 'jev' - 'erp'` when `p_allow_governed = false`; grants unchanged; rollback restores the `jev`-only body.
- [ ] E2 `20261101141100` `ci_tenant_isolation_health_by_tenant()` — the existing counts grouped per tenant, summing to
      `ci_tenant_isolation_health()`; the latter unchanged.
- [ ] E3 pgTAP: ERP request idempotent (assert the flag is set on BOTH first-run and a re-run on an
      already-provisioned tenant) + existing provision assertions; a `p_allow_governed=false` merge sending `{"erp":…}`
      leaves the stored flag intact (an exafy-admin merge still can); per-tenant counts sum to the global function.
- [ ] E4 MIGRATION-QUEUE rows after `tenant-domains-db`; drift-baseline maintenance around apply; read-only pre/post
      checks in `docs/validation/<vtid>/`.

Acceptance: expand/contract; rollbacks + pre/post checks; QUEUE rows; pgTAP green. No live writes. PR title
`VTID-xxxxx (mt-m3/provision-erp-monitoring-db): …`; commits carry `Collab-Session` /
`Collab-Lane: mt-m3/provision-erp-monitoring-db`.

<!-- lane: monitoring-erp-gw -->
## monitoring-erp-gw — per-tenant health + ERP-request display (repo vitana-platform)

Allowed paths: `services/gateway/src/routes/admin-health.ts`,
`services/gateway/test/mt-m3-monitoring-erp*.test.ts`. The lane also creates `docs/validation/<vtid>/`.

- [ ] M1 Surface `ci_tenant_isolation_health_by_tenant()` on the existing admin health read; dark behind the flag.
- [ ] M2 Display-only: per tenant, report whether `tenant_settings.feature_flags.erp.bootstrap_requested` is set. No ERP
      action — the erp-bridge is execute-only (`backoffice/erp-bridge-client.ts:17,45`); a consumer is a separate
      ERP-bootstrap spec.
- [ ] M3 Jest/Vitest: per-tenant counts + ERP-flag shape; no erp-bridge call; flag-off path unchanged.
- [ ] M4 `docs/validation/<vtid>/`: `scope.json`, `staging-tests.json` (read-only), plan-sparring copy.

Acceptance: dark behind the flag; tests green; depends on `provision-erp-monitoring-db`. No live writes. PR title
`VTID-xxxxx (mt-m3/monitoring-erp-gw): …`; commits carry `Collab-Session` / `Collab-Lane: mt-m3/monitoring-erp-gw`.

<!-- lane: morning-health-pertenant -->
## morning-health-pertenant — MORNING health per-tenant breakdown (repo vitana-platform, executor claude)

Allowed paths: `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml`. The lane also creates `docs/validation/<vtid>/`.

- [ ] W1 Add the per-tenant isolation breakdown to the MORNING workflow (read-only, report-only), calling
      `ci_tenant_isolation_health_by_tenant()`.
- [ ] W2 Keep the existing `ci_tenant_isolation_health()` row and the report-only posture unchanged.

Acceptance: report-only, read-only; depends on `provision-erp-monitoring-db`; governance path → executor claude. PR title
`VTID-xxxxx (mt-m3/morning-health-pertenant): …`; commits carry `Collab-Session` /
`Collab-Lane: mt-m3/morning-health-pertenant`.

<!-- lane: wizard-price-polish -->
## wizard-price-polish — wizard polish, price-display de-hardcoding, offboarding runbook (repo vitana-v1)

Allowed paths (vitana-v1): `src/components/admin/tenant-provisioning/**`, `src/lib/tenant-provisioning-api.ts`,
`src/lib/price-display/**`, `src/i18n/de/tenantProvisioning.json`, `src/i18n/en/tenantProvisioning.json`,
`docs/multitenancy/RUNBOOK-offboarding.md`,
`tests/e2e/staging/vtid-*-wizard-polish.staging.spec.ts`, `docs/validation/VTID-*/**`, `docs/SCREEN_INVENTORY.md`,
`i18n-source-stamps/**`.

- [ ] P1 Wizard polish on VTID-05221's panel: readiness affordances, a custom-domain field posting to `tenant_domains`
      (via the admin API), clearer step errors.
- [ ] P2 `src/lib/price-display/`: render price/currency from `tenant_settings.currency` (DISPLAY only; no wallet/plan/
      invoice — D2/D9).
- [ ] P3 `docs/multitenancy/RUNBOOK-offboarding.md` referencing mt-tenant-admin deactivate/archive RPCs (reference only).
- [ ] P4 i18n DE-first du-form, mirrored to en; `npm run i18n:inventory`.
- [ ] P5 Vitest: custom-domain field posts correctly; price render uses tenant currency; no non-GET on render.
- [ ] P6 Staging spec (read-only): wizard custom-domain field renders for exafy-admin; network guard aborts non-GET.
- [ ] P7 `docs/validation/VTID-*/`: `scope.json`, `staging-tests.json`, plan-sparring copy.

Acceptance: Vitest + full `npx vitest run` green; ESLint i18n + design clean; `npm test` unaffected; price change is
display-only (no economy). No live writes. PR title `VTID-xxxxx (mt-m3/wizard-price-polish): …`; commits carry
`Collab-Session` / `Collab-Lane: mt-m3/wizard-price-polish`.
