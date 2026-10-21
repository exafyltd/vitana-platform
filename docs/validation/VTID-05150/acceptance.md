# VTID-05150 - Tenant provisioning: brand pack, provision_tenant(), admin API, readiness, CLI (multi-tenant M0, lane B)

Owner approval 2026-10-13 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 3 rounds, record c62b4f75-b3c0-48e0-a78d-d19b848bc803).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `adminTenantsRouter` at `/api/v1/admin/tenants` (`services/gateway/src/index.ts`, unchanged) gains `POST /`, `PATCH /:id`, `PUT /:id/assets/:kind`, `GET /:id/readiness`, all behind the existing `verifyExafyAdmin`. `index.ts` is not touched.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/tenants (staging); same paths on production after PUBLISH.

CURL_PROOF: the STAGING-VERIFY run on the merge commit (`staging-tests.json`): every new route answers 401 application/json to an anonymous caller or an invalid bearer (route mounted, nothing written).

OASIS_PROOF: `tenant.provisioned`, `tenant.brand_pack.updated`, `tenant.asset.uploaded` (source `gateway/admin-tenants`) — payloads carry ids, slug, counts and field names only; tested to never contain the invitation token or an email.

## Acceptance criteria

AC-1: Migration 20261014000400 is expand-only: 14 new `tenant_settings` columns with defaults equal to today's behaviour, CHECKs NOT VALID→VALIDATE, the brand-pack trigger fires only on its own columns, the two backfills write new columns only, and Maxina/Alkalma's existing columns are byte-identical (md5) after apply; re-applying is a no-op.
  TEST: services/gateway/test/vtid-05150-provision-tenant-sql.test.ts
  TEST: scripts/ci/test-vtid-05150-provision-tenant.sh (local PostgreSQL 16; `ok: migration 1 backfill, reserved slugs, grants`)

AC-2: `reserved_tenant_slugs` (service_role only) equals `reserved-slugs.json` (112 slugs: vitana-v1 top-level routes, public/ files, platform words; maxina/alkalma/earthlinks included); `gen-reserved-slugs.mjs --check` fails naming a new v1 segment; `TENANT-RESERVED-SLUGS-DRIFT.yml` runs it weekly, read-only.
  TEST: services/gateway/test/vtid-05150-reserved-slugs.test.ts

AC-3: `provision_tenant()` creates, in one transaction, 1 tenant (invite-only), its settings + Jev flag, the 16-type notification baseline computed at call time (bool_or; maxina-local rows excluded; a new CROSS JOIN type picked up without an edit), the default tenant's 2 AI policies, the autopilot row, one system group with the bot, and one admin invitation; a re-run returns created:false with the same tenant and invitation and adds no rows.
  TEST: scripts/ci/test-vtid-05150-provision-tenant.sh (`ok: create …`, `ok: re-run …`, `ok: a new CROSS JOIN type …`)
  TEST: services/gateway/test/vtid-05150-provision-tenant-sql.test.ts

AC-4: Refusals write nothing: reserved/invalid slugs, an existing never-provisioned slug (SLUG_TAKEN), a non-exafy `p_invited_by`, a service-bot/test-actor/e2e admin email, bad name/budget/timezone/locale/currency, and no default tenant (NO_DEFAULT_TENANT). anon/authenticated cannot EXECUTE; service_role can.
  TEST: scripts/ci/test-vtid-05150-provision-tenant.sh (`ok: every refusal raised its code word`, `ok: refusals wrote nothing`, `ok: authenticated EXECUTE denied`)

AC-5: Maxina and Alkalma are unchanged by a provisioning call (md5 of every row in tenants, tenant_settings, notification_type_controls, ai_provider_policies, tenant_autopilot_settings, chat_groups, chat_group_members, tenant_invitations) and zero rows are added to user_tenants, memberships, app_users, chat_messages, user_notifications, founding_members.
  TEST: scripts/ci/test-vtid-05150-provision-tenant.sh (`ok: maxina/alkalma unchanged (md5 of every row), zero member-facing writes`)

AC-6: Migration 20261014000500 refuses to apply before Lane A M1 (`tenants.is_default`/`is_platform`) and leaves nothing behind; rollback.sql stops before dropping columns when a tenant was provisioned (backup table), rollback-complete.sql finishes it; with nothing provisioned rollback restores the pre-existing columns byte-identically and the migrations re-apply.
  TEST: scripts/ci/test-vtid-05150-provision-tenant.sh (`order guard …`, `rollback: stopped …`, `rollback-complete …`, `re-apply after rollback: ok`)

AC-7: `POST /api/v1/admin/tenants`: exafy_admin only (401/403, no DB call otherwise); Zod 400s; reserved slug 400 before any RPC; RPC code words → 400/403/409; 201 created / 200 re-run with the accept path; 503 PROVISIONING_UNAVAILABLE while the function is missing.
  TEST: services/gateway/test/vtid-05150-admin-tenants-provisioning.test.ts
  CURL: staging POST /api/v1/admin/tenants with an invalid bearer -> 401 application/json INVALID_TOKEN

AC-8: `PATCH /api/v1/admin/tenants/:id`: strict schema (slug/name/is_active not patchable, persona facts-only with caps), legacy tenants 409 LEGACY_TENANT_READ_ONLY with no write, only named columns written (asset paths kept), `open_signup:true` refused 409 TENANT_NOT_READY unless readiness is green or an override_reason is given (recorded in OASIS), `open_signup:false` always allowed.
  TEST: services/gateway/test/vtid-05150-admin-tenants-provisioning.test.ts
  CURL: staging PATCH /api/v1/admin/tenants/<maxina> with an invalid bearer -> 401 application/json

AC-9: `PUT /api/v1/admin/tenants/:id/assets/:kind`: png/jpeg/webp by magic bytes only (SVG, GIF, mislabelled bytes → 415; >1 MB → 413), stored with the service role at `tenant-assets/<slug>/<kind>.<ext>` (upsert), `brand.<kind>_path` set; legacy 409.
  TEST: services/gateway/test/vtid-05150-admin-tenants-provisioning.test.ts
  CURL: staging PUT /api/v1/admin/tenants/<maxina>/assets/logo with an invalid bearer -> 401 application/json

AC-10: `GET /api/v1/admin/tenants/:id/readiness` returns 12 checks (each failing case flips only its own check), no email in the body, path URL from `domains.primary_domain` else `FRONTEND_URL` (never hardcoded), works read-only for legacy tenants, reports `schema_missing` before the migration.
  TEST: services/gateway/test/vtid-05150-admin-tenants-provisioning.test.ts
  CURL: staging GET /api/v1/admin/tenants/<maxina>/readiness without a bearer -> 401 application/json UNAUTHENTICATED

AC-11: The new `/:id` routes never capture the per-tenant sub-routers mounted after them (`/:tenantId/invitations`, `/settings`, …); the existing GET shapes are unchanged.
  TEST: services/gateway/test/vtid-05150-admin-tenants-provisioning.test.ts (route shadowing pin)
  TEST: services/gateway/test/routes/admin-tenants.test.ts

AC-12: The tenant-admin `PUT /api/v1/admin/tenants/:tenantId/settings` merges `feature_flags` per key in one SQL statement and keeps the governed `jev` key (incl. the Jev budget) unless the caller is exafy_admin; ignored keys are listed; before the migration the gateway applies the same merge and guard.
  TEST: services/gateway/test/routes/tenant-admin/settings.test.ts
  TEST: scripts/ci/test-vtid-05150-provision-tenant.sh (`ok: feature_flags merge keeps jev for tenant admins, exafy_admin may change it`)

AC-13: Operator tooling: `provision-tenant.mjs` (no default host, JWT from env, idempotent steps, readiness printout) and `setup-tenant-assets-bucket.mjs` (public read, 1 MB, png/jpeg/webp, refuses to change an existing different bucket); neither is run by this PR.
  TEST: services/gateway/test/vtid-05150-admin-tenants-provisioning.test.ts (operator scripts)
