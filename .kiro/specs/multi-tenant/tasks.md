# Tasks — Multi-tenant Vitanaland

Authoritative plan: `plan-sparring.md` (this folder). Lane files: `lanes/`.

<!-- lane: provisioning-ui -->
## provisioning-ui — exafy-admin "New community" panel (VTID-05221, Kiro, repo vitana-v1)

Allowed paths (vitana-v1 only): `src/lib/tenant-provisioning-api.ts`, `src/lib/tenant-provisioning-api.test.ts`,
`src/components/admin/tenant-provisioning/**`, `src/pages/admin/TenantManagement.tsx`,
`src/i18n/de/tenantProvisioning.json`, `src/i18n/en/tenantProvisioning.json`,
`tests/e2e/staging/vtid-05221-*.staging.spec.ts`, `docs/validation/VTID-05221/**`, `docs/SCREEN_INVENTORY.md`,
`i18n-source-stamps/**`. Nothing under `supabase/migrations/`, `.claude/` or other `docs/validation/` folders.

- [ ] P1 `src/lib/tenant-provisioning-api.ts`: JSON wrappers over `adminFetch` (list, get, provision, patch,
      readiness) + `uploadTenantAsset(id, kind, file)` with the file's real MIME type and raw body (see design.md).
      Error codes mapped to i18n keys (`FORBIDDEN`, `NOT_EXAFY_ADMIN`, `RESERVED_SLUG`, `SLUG_TAKEN`, `INVALID_*`, 415).
- [ ] P2 Step 1 `ProvisionTenantForm` — fields exactly `ProvisionTenantSchema`; slug regex + reserved-slug check.
- [ ] P3 Step 2 `BrandPackForm` — `TenantBrandPackPatchSchema` fields, open sign-up default off, optional persona facts.
- [ ] P4 Step 3 `AssetUpload` (png/jpeg/webp) + `ReadinessChecklist`.
- [ ] P5 Mount inline in `TenantManagement.tsx` only when `isExafyAdmin`; Spotlight tokens, logical start/end, skeletons.
- [ ] P6 i18n: `src/i18n/de/tenantProvisioning.json` first (du-form), mirrored to `en/`; `npm run i18n:inventory`.
- [ ] P7 Vitest: wrapper URLs/bodies/error mapping; upload sends real MIME + raw body; form validation (slug, reserved
      slug, email, hex colours, budget 0–500); panel absent for non-exafy admin; readiness rendering; no write request
      on render.
- [ ] P8 Staging spec `tests/e2e/staging/vtid-05221-provisioning-ui.staging.spec.ts` (read-only): test user (not
      exafy_admin) → panel absent on `/admin/system/tenants`; `GET /api/v1/admin/tenants` with that token → 403 JSON;
      network guard aborts any non-GET.
- [ ] P9 `docs/validation/VTID-05221/`: copy of `plan-sparring.md`, `scope.json` (kind feature, the allowed paths),
      `staging-tests.json` (the spec + the Vitest files).

Acceptance: all Vitest green, full `npx vitest run` green, ESLint (i18n + design) clean on new files, PR gate
scope/sparring/weakening green, PR title `VTID-05221 (multi-tenant/provisioning-ui): …`, commits carry
`Collab-Session` / `Collab-Lane: multi-tenant/provisioning-ui`. Kiro never calls a write endpoint against any live
system.

## Coordinator task (not a queue lane) — VTID-05149 AC-10 24 h signup re-check (VTID-05222, Claude)

This spec's executor is Kiro, so the queue cannot route a Claude lane here; the coordinator runs this read-only check
directly under VTID-05222 and records the result below.

- [ ] A1 Read-only SQL on production: auth.users created since 2026-10-13 (A-M2 apply) without exactly one primary
      `user_tenants` row, or without a `memberships` row in that tenant; rule-43 accounts flagged.
- [ ] A2 Record counts and the query in `docs/validation/VTID-05149/acceptance.md` (AC-10 line) via a PR.
- [ ] A3 Non-zero → stop, report to the owner with ids redacted.
