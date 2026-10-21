# Requirements — Multi-tenant Vitanaland

Program: `docs/MULTI-TENANT-PLAN.md` (v5.1, owner-approved 2026-10-10; decision register at its end). This spec is the
Kiro-readable hand-off of that program. It links the program's records instead of copying them.

## Program goal
Vitanaland hosts many communities (tenants) on one platform. Maxina stays exactly as it is; a new community can be
provisioned, branded and opened without code changes or hand-written SQL, and no tenant can ever see another tenant's
data.

## Done (M0 lanes S-M, A, B, C — in production)

| Lane | VTID | What it delivered | Records |
|---|---|---|---|
| S-M | VTID-05147 | Members can no longer write their own `user_tenants` / role rows; `set_role_preference` checks membership; `requireTenantAdmin` tightened | `docs/validation/VTID-05147/` · platform #4093, v1 #1369 |
| A | VTID-05149 | `tenants.is_default` / `is_platform`, signup lands in the default tenant, one primary-tenant resolver, `TenantContext`, `ci_tenant_isolation_health()` | `docs/validation/VTID-05149/` · platform #4094 |
| B | VTID-05150 | Tenant brand pack columns, `reserved_tenant_slugs`, `provision_tenant()`, exafy_admin provisioning API + readiness + assets, CLI | `docs/validation/VTID-05150/` · platform #4097, #4108 |
| C | VTID-05151 | Public tenant registry (`list_public_tenants()` / `resolve_tenant()`), DB-driven `useTenant`, generic portal at `/:tenantSlug` | `docs/validation/VTID-05151/`, `docs/multitenancy/LANE-C.md` · platform #4103, v1 #1382 |

All 8 migrations are applied (run ids in `docs/multitenancy/MIGRATION-QUEUE.md`), staging-verified (gateway
STAGING-VERIFY 91/91 at f3bcf3dc3) and published (gateway 0b875e98, app 49182e04 on 2026-10-14).

## This slice (VTID-05221, VTID-05222)

### R1 — Exafy admin can provision a community from the app (lane `provisioning-ui`, VTID-05221)
1. WHEN an exafy_admin opens `/admin/system/tenants` THE SYSTEM SHALL show a "New community" panel; for anyone else the
   panel SHALL NOT render (the gateway also answers 403 `FORBIDDEN`).
2. THE panel SHALL provision in three explicit steps: (1) create — POST `/api/v1/admin/tenants`; (2) brand pack —
   PATCH `/api/v1/admin/tenants/:id`; (3) assets — PUT `/api/v1/admin/tenants/:id/assets/:kind`; then show
   GET `/:id/readiness`.
3. THE panel SHALL send exactly the fields the gateway schemas accept
   (`services/gateway/src/services/tenant-provisioning/schemas.ts`) and SHALL validate slug format and reserved slugs
   before submitting.
4. THE panel SHALL NOT call any write endpoint except on an explicit admin button press; open sign-up SHALL default off.
5. EVERY user-visible string SHALL come from `src/i18n/{de,en}/tenantProvisioning.json` (DE first, du-form); layout
   SHALL follow the Spotlight contract (tokens only, logical start/end, skeletons).

### R2 — Signup integrity re-check (coordinator task, VTID-05222)
1. Every auth.users row created since A-M2 was applied (2026-10-13, RUN-MIGRATION 38446340122) SHALL have exactly one
   primary `user_tenants` row and a `memberships` row in the same tenant (VTID-05149 AC-10). Checked read-only;
   result recorded in `docs/validation/VTID-05149/acceptance.md`.

## Not in this slice
Remaining M0 items (WS0 lints/isolation suites in CI, WS1 access-token hook in shadow — D14, WS2 expand half, policy
classification), creating the real new tenant row (owner-approved step after Gate 2), custom domains, native app (WS9).
Each later slice is sparred and approved on its own.
