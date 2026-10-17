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
      verified_at, created_at)`; RLS enabled with NO client policy (service-role/exafy-admin only); host format check;
      reject a host equal to a `reserved_tenant_slugs` entry. Rollback drops the table.
- [ ] D2 `20261101140100` extend `resolve_tenant` with an optional `host` arg (additive): resolve a host ONLY when its
      `tenant_domains` row has `verified_at IS NOT NULL` and ONLY through `_tenant_public_registry()` (so the
      `is_active AND is_platform = false` filter still applies), else the existing slug arm; an unverified/inactive/
      platform host resolves empty and falls through to slug. Returned field set unchanged — no `tenant_domains` column
      added (Lane C whitelist). Rollback restores the prior definition.
- [ ] D3 pgTAP: `tenant_domains` RLS (anon/b_member cannot read or write; service/exafy-admin can); `resolve_tenant`
      resolves a VERIFIED host, falls back to slug, rejects a reserved-slug host; an UNVERIFIED host (`verified_at IS
      NULL`) and a host on an INACTIVE or PLATFORM tenant BOTH resolve empty; the returned column set and the slug-only
      behaviour are pinned.
- [ ] D4 MIGRATION-QUEUE rows after mt-tenant-admin's `070600`; add `tenant_domains` to `migration-drift-baseline.json`,
      note its removal in the post-apply PR. Read-only pre/post check SQL in `docs/validation/<vtid>/`.

Acceptance: expand-only; rollbacks + pre/post checks; QUEUE rows; pgTAP green. No Supabase/AWS writes. PR title
`VTID-xxxxx (mt-m3/tenant-domains-db): …`; commits carry `Collab-Session` / `Collab-Lane: mt-m3/tenant-domains-db`.

<!-- lane: host-resolution-gw -->
## host-resolution-gw — gateway host arm in TenantContext (repo vitana-platform)

Allowed paths: `services/gateway/src/services/tenancy/tenant-context.ts`,
`services/gateway/src/middleware/auth-supabase-jwt.ts`, `services/gateway/test/mt-m3-host-resolution*.test.ts`. The lane
also creates `docs/validation/<vtid>/`.

- [ ] H1 Add a host arm: resolve `req.hostname` through `resolve_tenant(host,…)` BEFORE the slug/claim arms; sets context
      only. Dark behind `MT_RESOLUTION_V2`.
- [ ] H2 Membership still required for data: host tenant ≠ member → the existing join posture, never a silent default.
- [ ] H3 Jest/Vitest: host arm precedence; no data without membership (contract test); flag-off path byte-identical to
      today. `npm run test:support` + `npm run test:operator` stay green if touched.
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
      `useMemberships()` (`list_my_memberships`), using the public registry only to resolve each membership's slug/brand
      for display (never list the public registry itself); switch via `useTenant().setTenantBySlug`; hidden when <2
      memberships; NOT exafy-admin-gated.
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
`apps/mobile/parity/**`, `scripts/native/**`, `src/lib/universal-links/**`,
`src/lib/universal-links/universal-links.test.ts`, `docs/validation/VTID-*/**`.

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
      (`tenant_settings.feature_flags.erp.bootstrap_requested`); every existing assertion still holds.
- [ ] E2 `20261101141100` `ci_tenant_isolation_health_by_tenant()` — the existing counts grouped per tenant, summing to
      `ci_tenant_isolation_health()`; the latter unchanged.
- [ ] E3 pgTAP: ERP request idempotent + existing provision assertions; per-tenant counts sum to the global function.
- [ ] E4 MIGRATION-QUEUE rows after `tenant-domains-db`; drift-baseline maintenance around apply; read-only pre/post
      checks in `docs/validation/<vtid>/`.

Acceptance: expand/contract; rollbacks + pre/post checks; QUEUE rows; pgTAP green. No live writes. PR title
`VTID-xxxxx (mt-m3/provision-erp-monitoring-db): …`; commits carry `Collab-Session` /
`Collab-Lane: mt-m3/provision-erp-monitoring-db`.

<!-- lane: monitoring-erp-gw -->
## monitoring-erp-gw — per-tenant health surface + ERP consumer (repo vitana-platform)

Allowed paths: `services/gateway/src/routes/admin-health.ts`,
`services/gateway/src/services/backoffice/**`, `services/gateway/test/mt-m3-monitoring-erp*.test.ts`. The lane also
creates `docs/validation/<vtid>/`.

- [ ] M1 Surface `ci_tenant_isolation_health_by_tenant()` on the existing admin health read; dark behind the flag.
- [ ] M2 Wire the ERP bootstrap-request consumer into the BackOffice ERP path (idempotent).
- [ ] M3 Jest/Vitest: per-tenant counts shape; ERP consumer idempotent; flag-off path unchanged.
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
