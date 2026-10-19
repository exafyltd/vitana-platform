# Design — Multi-tenant Vitanaland

## What exists (read these, do not copy them)
- Program plan and decision register: `docs/MULTI-TENANT-PLAN.md`.
- Migration order, lane version ranges, apply status: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Public registry contract (field whitelist): `docs/multitenancy/LANE-C.md`.
- Provisioning API: `services/gateway/src/routes/admin-tenants.ts` — GET `/` (76), GET `/:id` (127), POST `/` (317),
  PATCH `/:id` (388), PUT `/:id/assets/:kind` (473), GET `/:id/readiness` (536). Auth: `verifyExafyAdmin` → 403
  `{ ok:false, error:'FORBIDDEN' }` for non-exafy callers (63–64, 78). Asset types: `ALLOWED_ASSET_TYPES`
  png/jpeg/webp (197); declared vs sniffed type mismatch → 415 (490). DB-level codes from `provision_tenant()` (209):
  `NOT_EXAFY_ADMIN`, `RESERVED_SLUG`, `SLUG_TAKEN`, `INVALID_*`.
- Payload schemas: `services/gateway/src/services/tenant-provisioning/schemas.ts` — `ProvisionTenantSchema` (73),
  `TenantBrandPackPatchSchema` (89), `ASSET_KINDS` (110), `JEV_MONTHLY_BUDGET_MAX_USD = 500`.
- Operator CLI and runbook: `scripts/tenants/**`, `docs/validation/VTID-05150/RUNBOOK-provision.md`.
- Frontend: `vitana-v1/src/lib/tenant-registry.ts`, `src/hooks/useTenant.tsx` (`isExafyAdmin`),
  `src/lib/admin-api.ts` (`adminFetch`: JSON only, sends only `Authorization` — its JSDoc about X-Vitana-* headers is
  wrong), `src/generated/reserved-tenant-slugs.json`, `src/pages/portals/TenantPortal.tsx`.

## provisioning-ui (VTID-05221)
- `src/lib/tenant-provisioning-api.ts`: typed JSON wrappers over `adminFetch` (list, get, provision, patch, readiness)
  and a separate `uploadTenantAsset(id, kind, file)` doing its own authenticated `fetch` (same token and base-URL logic
  as `adminFetch`) with `Content-Type` = the file's real MIME type and the raw file as body. Error mapping:
  `FORBIDDEN` (403 auth gate) and `NOT_EXAFY_ADMIN` (DB check) separately, `RESERVED_SLUG`, `SLUG_TAKEN`, `INVALID_*`,
  415 → i18n keys. Request types mirror `schemas.ts`; tests pin the request bodies.
- `src/components/admin/tenant-provisioning/`:
  - step 1 `ProvisionTenantForm` — exactly `ProvisionTenantSchema`: slug (client regex + reserved-slug list), name,
    display name, admin email, all-members group name, default + enabled locales, timezone, currency, optional Jev
    monthly budget 0–500 USD.
  - step 2 `BrandPackForm` — `TenantBrandPackPatchSchema`: colours (hex), legal entity line, support/sender name +
    email, landing cta, open sign-up toggle (default off), optional collapsible "Persona facts" (community name +
    pronunciation, anchor person, story/offer facts, tone); `override_reason` only when the server asks for it.
  - step 3 `AssetUpload` — logo / favicon / og_image, png/jpeg/webp only.
  - `ReadinessChecklist` — renders GET `/:id/readiness`.
- Mounted inline in `src/pages/admin/TenantManagement.tsx` (route `/admin/system/tenants`), only when
  `useTenant().isExafyAdmin`. No new route → no nav-registry, screen-manifest or parity-ledger change.
- **Exception to dark-by-default (owner-approved at Gate 1):** the panel is exafy_admin-only and server-gated; no
  member can see it.

## Rules every successor follows
1. **Migrations:** apply strictly in `MIGRATION-QUEUE.md` order, one `RUN-MIGRATION.yml` dispatch per file, by Claude
   only, with read-only pre/post checks. New multi-tenant migrations take the next version in their lane's range and are
   added to the queue in the same PR. A PR that adds a not-yet-live table adds it to
   `scripts/ci/migration-drift-baseline.json` and removes it after apply.
2. **Dark by default:** every merged code change is off unless enabled (`MT_RESOLUTION_V2` env master,
   `tenant_settings.feature_flags.mt.*`), because PUBLISH promotes the whole staging build. Exceptions are named in the
   approved plan (this slice: the exafy-only panel).
3. **VTID-05147 AC-5:** no later migration may grant members writes on `user_tenants` / role tables, recreate a dropped
   policy, or redefine `set_role_preference` without the membership check. Guard tests:
   `services/gateway/test/vtid-05147-s-m-membership-role-lockdown.test.ts`,
   `vitana-v1/src/integrations/supabase/role-tables-no-client-writes.vtid-05147.test.ts`.
4. **Lane C whitelist:** the public registry returns only the whitelisted fields in `LANE-C.md`; a new key means a new
   migration and a new harness case.
5. **D12** one session per VTID, at most 6 concurrent sessions; **D13** no synthetic tenant in production; **D14** the
   access-token auth hook is applied only by the owner from a committed runbook.
6. **Production is read-only** for every session and every test (CLAUDE.md rules 31–32, 48). The executor never writes
   to Supabase or AWS (collaboration §7a). Creating a real tenant is an owner-approved step done by Claude.
7. Test/service accounts never visible to members (rules 43–45); i18n DE-first du-form; RTL via logical properties;
   Spotlight design contract; WCAG 2.2 AA.
