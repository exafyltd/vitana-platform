# Design — mt-launch (WS8 Tenant Launch engineering)

## What exists (read these, do not copy them)
- Program plan + decision register: `docs/MULTI-TENANT-PLAN.md` (§6 WS8, §4.9 health lineage guard, D18, D6/rule 41).
- Migration order + lane version ranges + apply status: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Provisioning API + brand pack: `services/gateway/src/routes/admin-tenants.ts` — PACK_FIELDS (`:384`), PATCH `/:id`
  (`:388`), assets `PUT /:id/assets/:kind` logo/favicon/og_image (`:471-473`), readiness `GET /:id/readiness` (`:536`).
  Payload schemas: `services/gateway/src/services/tenant-provisioning/schemas.ts`.
- Analytics base: `supabase/migrations/20260612140000_BOOTSTRAP_product_analytics_events.sql` (tenant-scoped,
  service-role-only RLS), `20260612140100_BOOTSTRAP_product_analytics_rollups.sql`; ingestion
  `services/gateway/src/routes/product-analytics.ts` + `track-server.ts` + `services/product-analytics/rollup.ts`;
  admin reads `services/gateway/src/routes/tenant-admin/product-analytics.ts` (mounted
  `/api/v1/admin/tenants/:tenantId/analytics`, `requireTenantAdmin`).
- Health lineage guard pattern to copy: `services/gateway/test/vtid-05025-commerce-health-boundary.test.ts` and
  `test/vtid-05156-people-match-health-boundary.test.ts` — a `HEALTH_TABLES` regex + import bans scanned over named
  source files, with a self-test proving the regex catches a planted read.
- Content-discipline prompt rules (not linters): `services/gateway/src/services/community-autopilot/drafts.ts:94`,
  `services/gateway/src/services/anthropic-vision-client.ts:68`.
- Per-tenant feature-flag pattern to copy: `services/gateway/src/services/data-export-consent.ts` (`tenantExportPolicy()`
  `:79-108` — reads `tenant_settings.feature_flags.data_export_ok === true`, default OFF, error ⇒ off, 5-min cache) +
  `data-export-consent-repository.ts:25` (`fetchTenantSettingsFeatureFlags(sb, tenantId)`). The GLOBAL env flag helper
  `services/gateway/src/services/feature-flags.ts` (`isFeatureLive(name: string): boolean`, `:81`) is NOT this — it is
  single-arg, reads `FEATURE_<NAME>_ENV`, and has no per-tenant resolution; do not use it for a per-tenant dark flag.
- `MT_RESOLUTION_V2` program-wide master switch: does **not exist** in `services/gateway/**/*.ts` today (case-sensitive
  grep = 0, 2026-10-15); it is mt-identity's (WS1) to introduce. This spec's per-tenant `mt.launch_*` flags do not need it.
- Support: `services/gateway/src/routes/feedback-admin.ts` (`GET /tenants/:tenantId/tickets`, `:221`),
  `routes/feedback-intake.ts`, `routes/feedback-admin-repository.ts` (`feedback_tickets`); specialists
  Devon/Sage/Atlas/Mira (`orb/live/tools/live-tool-catalog.ts:1006`). Rule 42c suite: `npm run test:support`.
- Referral/invite attribution: `routes/automations.ts` (`/referrals`), `routes/admin-signups.ts:205-229` (dispatch pinned to
  `DEFAULT_TENANT_ID` — fixed by mt-jobs VTID-05267, not here), `routes/community-invites.ts:72-80` (`/claim` OASIS event
  without `tenant_id` — this spec's `support-landing` adds it from `resolvePrimaryTenant`, service role), `routes/click-redirect.ts` referral validation.
- `tenant_content_overrides` does **not** exist yet — `mt-packs` creates it. This spec only publishes INTO it.

## Design per lane

### pack-intake-db (DB)
Two expand-only tables, no backfill, service-role-only RLS (gateway-mediated like `product_analytics_events`):
- `tenant_pack_intake(tenant_id uuid references tenants, item_key text, status text check (…), evidence jsonb default '{}', decided_by uuid, decided_at timestamptz, updated_at timestamptz default now(), primary key (tenant_id, item_key))`.
  `item_key` is a free-text column constrained by an application enum (the WS8 checklist) — do not hard-code a DB enum
  type (keeps the list editable without a type migration); the API validates it.
- `tenant_content_pipeline(id uuid pk, tenant_id uuid references tenants, locale text, key text, source_template text, candidate_value text, lint_report jsonb default '{}', review_state text check (…), reviewed_by uuid, signed_off_by uuid, published_at timestamptz, created_at timestamptz default now(), unique (tenant_id, locale, key))`.
- `get_tenant_launch_readiness(p_tenant_id uuid) returns jsonb` — SECURITY INVOKER, STABLE, `SET search_path = public,
  pg_catalog`, EXECUTE revoked from PUBLIC/anon/authenticated and granted to service_role only; reads only
  `tenant_pack_intake` (+ `tenants`), never a health table; aggregates intake completeness.
Migrations `20261101110000` / `20261101110100` (renumber if a later migration exists at build time); rollback drops
both tables + the function; MIGRATION-QUEUE rows added in the same PR, ordered after WS5's `tenant_content_overrides`
with an explicit depends-on note. Read-only pre/post checks in `docs/validation/<vtid>/`.

### pack-intake-admin (gateway code)
- Routes under `services/gateway/src/routes/tenant-admin/pack-intake.ts` (new) mounted beside the existing tenant-admin
  routers; a repository seam `pack-intake-repository.ts` for every `.from()` (Aurora-migration convention, like
  `product-analytics-repository.ts`). Auth: `requireTenantAdmin` + exafy-admin for sensitive items; tenant from the
  path segment only.
- Content pipeline service `services/gateway/src/services/tenant-launch/` with pure linters
  `health-claim-linter.ts`, `leftover-brand-linter.ts`, `undated-claim-linter.ts` (each `(text) => Finding[]`), a
  `content-pipeline.ts` state machine, and `publish.ts` writing to `tenant_content_overrides` only from `signed_off`;
  a missing table (`42P01`/`PGRST205`) ⇒ 409 `DEPENDENCY_NOT_READY`, row unchanged, independent of the flag.
  Leftover-brand allowlist = immutable identifiers (bundle id `com.exafy.maxina`, AASA appID, existing route aliases)
  pinned by test.
- **Per-tenant dark-flag resolver** `services/gateway/src/services/tenant-launch/tenant-feature-flag.ts` (created in
  THIS lane; the other two code lanes import it, hence they `depends_on` this lane): `isTenantFeatureLive(tenantId,
  key)` reads `tenant_settings.feature_flags.<key>` for the request's tenant, strictly `=== true`, default OFF, any
  lookup error ⇒ OFF, with a 5-min in-process cache. It is a direct copy of the `services/data-export-consent.ts`
  pattern (`tenantExportPolicy()` at `data-export-consent.ts:79-108`, DB read via
  `data-export-consent-repository.ts:25` `fetchTenantSettingsFeatureFlags`), its own repository seam
  `tenant-feature-flag-repository.ts` for the single `.from('tenant_settings')`. **Do NOT use
  `isFeatureLive`/`services/feature-flags.ts`** — that function is `isFeatureLive(name: string): boolean`
  (`feature-flags.ts:81`), single-argument and reading a GLOBAL `FEATURE_<NAME>_ENV` env setting; it has no `tenantId`
  parameter and cannot express a per-tenant flag at all, so a two-arg call would not compile and a one-arg call would
  wire a global flag where per-tenant dark rollout is required. The pipeline is gated by
  `isTenantFeatureLive(tenantId, 'mt.launch_pipeline')`.

### tenant-owner-analytics (gateway code)
- Router `services/gateway/src/routes/tenant-admin/owner-analytics.ts` (new) mounted
  `/api/v1/admin/tenants/:tenantId/owner-analytics`, `requireTenantAdmin`, reading `product_analytics_events`/rollups +
  `get_tenant_launch_readiness` through a repository seam. Five read endpoints: signups, activation, journey, events,
  retention. Dark behind `isTenantFeatureLive(tenantId, 'mt.launch_analytics')` — the resolver `pack-intake-admin`
  creates (`services/gateway/src/services/tenant-launch/tenant-feature-flag.ts`), imported read-only here (no path entry needed; importing
  does not change the file, so Lane scope is satisfied), which is why this lane `depends_on` `pack-intake-admin`.
- **D18 guard:** `services/gateway/test/mt-launch-owner-analytics-health-boundary.test.ts` copies the VTID-05025
  pattern: it lists exactly the owner-analytics source files, asserts none match the health-table regex and none import
  a health repository, and a self-test plants a read to prove the regex works. The allowlist of readable tables is
  explicit — `product_analytics_events`, `product_analytics_daily_rollups`, `tenant_pack_intake`, `tenant_content_pipeline`, `tenants`, RPC `get_tenant_launch_readiness` — and any `.from`/`.rpc` name not on it (unknown provenance) fails the test. The health-table
  deny list is an inline `HEALTH_TABLES` regex now (as `vtid-05025`) and moves to mt-identity's canonical
  `isHealthTable()` (O1) once it ships.

### support-landing (gateway code)
- Support routing resolver `services/gateway/src/services/tenant-launch/support-routing.ts` reads
  `tenants.support_email`/`sender_*` + `tenant_settings.feature_flags.mt.support` (answerer, SLA hours, contact) and is
  called from `routes/feedback-admin.ts` / `routes/feedback-intake.ts` to stamp a tenant's routing on its tickets.
  Dark behind `isTenantFeatureLive(tenantId, 'mt.launch_support')` — the resolver `pack-intake-admin` creates, imported
  read-only here (hence this lane `depends_on` `pack-intake-admin`); when off, behaviour is byte-identical to today (so
  `npm run test:support` stays green).
- Landing SEO/OG: expose the tenant's `landing`/`og_image` brand-pack fields through the public registry read path
  (reuse the Lane-C registry whitelist; a new key = a new migration + harness case — do not add keys here). The `/claim` invite
  OASIS event (`community-invites.ts:72-80`) gains `tenant_id`; `admin-signups.ts` signup attribution is mt-jobs VTID-05267's.

### worker-test-gate (governance, executor claude)
- `.github/workflows/**` only: add the three linter suites + the D18 guard test + the golden assertion to the gateway
  Jest job / PR-GATE. No source changes. executor claude because governance paths are reserved for Claude.

## Rules every successor follows
1. **Migrations:** apply strictly in `MIGRATION-QUEUE.md` order, one RUN-MIGRATION dispatch per file, by Claude only,
   with read-only pre/post checks; new rows added in the same PR; this spec's rows ordered AFTER WS5's
   `tenant_content_overrides`. A PR adding a not-yet-live table adds it to `scripts/ci/migration-drift-baseline.json`
   and removes it after apply.
2. **Dark by default:** every merged code change is off unless its own per-tenant flag
   (`tenant_settings.feature_flags.mt.launch_*`, resolved by `isTenantFeatureLive`) is `=== true`, because PUBLISH
   promotes the whole staging build. No WS8 exception. The program-wide `MT_RESOLUTION_V2` master is **not an existing
   gate** — it does not exist in gateway code yet (grep = 0, 2026-10-15) and is mt-identity's (WS1) to introduce; this
   spec never defines or assumes it. Each `mt.launch_*` flag is independently default-OFF, so the lanes are dark-safe
   with or without any master.
3. **D18 fail-closed:** no owner/tenant-facing analytics surface reads a health table; unknown-provenance = health; the
   guard is build-failing and references mt-identity's `isHealthTable()` (O1).
4. **Rule 41:** the content pipeline publishes UI/catalog/push/email strings (`{{brand}}` templating) to
   `tenant_content_overrides`; it never produces a spoken line.
5. **Production read-only** for every session and test (31/31b/48); the executor never writes to Supabase/AWS
   (collaboration §7a); a DB change is a migration file in the PR.
6. **Support/operator contracts:** `npm run test:support` (42c) and `npm run test:operator` (42e) stay green; a
   contract change adds a scenario in the same PR.
7. Test/service/platform-only accounts invisible to members (43–45); i18n DE-first du-form; RTL logical properties;
   Spotlight contract; WCAG 2.2 AA.
