# VTID-05150 — plan sparring record (multi-tenant M0, lane B: tenant provisioning)

Sparring record: `c62b4f75-b3c0-48e0-a78d-d19b848bc803` (plan_sparring_sessions). Change class: standard. Rounds: 3. Verdict: **CONVERGED** (round 3).
Final plan hash (sha256, computed before VTID substitution, as recorded at Gate 1): `9b05a91052fa3c69a90750149e524c5682afd8b00436a9488493e6dfd9158efb`.

Sections: (1) the final plan, verbatim, including the planner's responses to every round; (2) the sparring partner's output for every round, verbatim; (3) the owner's Gate 1 approval.
The plan text uses `vtid-XXXXX` placeholders; the implementation uses VTID-05150 for them.

---

## 1. Final plan (verbatim)

# Lane B — Tenant provisioning: brand pack, `provision_tenant()`, admin API, readiness, CLI (WS4 core)
change class: standard
scope: vitana-platform — new `supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql`, `supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql`; `services/gateway/src/routes/admin-tenants.ts` + `admin-tenants-repository.ts` (add routes, no new route file; repository: new functions only — the existing read functions `fetchTenantsList`, `fetchAllTenantMemberships`, `fetchTenantById`, `fetchTenantBySlug` are not modified); `routes/tenant-admin/settings.ts` (+ its repository/test: server-side merge of `feature_flags`, governed `jev` key ignored for non-exafy_admin); new `services/gateway/src/services/tenant-provisioning/{schemas.ts,readiness.ts,reserved-slugs.ts,reserved-slugs.json}`; new `scripts/tenants/{provision-tenant.mjs,gen-reserved-slugs.mjs}`; new `scripts/supabase/setup-tenant-assets-bucket.mjs`; new `.github/workflows/TENANT-RESERVED-SLUGS-DRIFT.yml`; new `scripts/ci/test-vtid-XXXXX-provision-tenant.sh`; new tests `services/gateway/test/vtid-XXXXX-{provision-tenant-sql,admin-tenants-provisioning,reserved-slugs}.test.ts`; `DATABASE_SCHEMA.md`; `docs/validation/VTID-05150/{plan-sparring.md,staging-tests.json,acceptance.md,live-before.sql,post-apply-checks.sql,rollback.sql,rollback-complete.sql,RUNBOOK-provision.md}`; `docs/multitenancy/MIGRATION-QUEUE.md` entries (created by Lane A; B's entries come after A's M1). vitana-v1 — **no change** (read-only source for the generator). No Command Hub file (decision in Fix 6).
Evidence base: origin/main @ e1ad8a0fd (platform, 2026-10-13 13:47), d09d66c4f (v1, 2026-10-13 13:19); live read-only checks on `inmkhvwdcuyhnxkgfvsb` 2026-10-13 ~12:40 UTC.
<!-- plan:begin -->
## Problem
1. No create path. `routes/admin-tenants.ts` has only `GET /` (:53) and `GET /:id` (:104), both behind the inline `verifyExafyAdmin` (:28-49, user client `auth.getUser()` + `app_metadata.exafy_admin === true`). Mounted at `/api/v1/admin/tenants` (`index.ts:1399`). Program §2 "No tenant creation path" still holds.
2. Live schema (2026-10-13): `tenants(tenant_id, name, slug UNIQUE, policy_profile, branding, is_active, open_signup DEFAULT false, created_at, updated_at)` — **no `is_default`/`is_platform` yet** (Lane A not shipped). `tenant_settings(tenant_id PK, profile, branding, feature_flags, integrations, domains, billing jsonb, updated_at, updated_by)`. No `tenant_domains`, `reserved_tenant_slugs`, `tenant_content_overrides`; no `provision_tenant`/`resolve_tenant`/`is_member` functions. Tenants: `maxina`, `alkalma`.
3. Existing jsonb columns cannot carry the brand pack safely: the tenant-admin `PUT /admin/tenants/:tenantId/settings` **replaces** `profile`/`branding` wholesale (`tenant-admin/settings.ts:63-64`), and the v1 Branding page sends only `{brand_accent, brand_bg, brand_fg, logo_url}` (`src/pages/admin/settings/Branding.tsx:49`) — any extra key (logo path, legal line, persona) would be wiped by a tenant-admin save. Legal entity, sender and persona are Exafy-governed (D3, rule 41), not tenant-admin-editable.
4. Where today's brand values live (backfill sources): SPA colors/name — `vitana-v1/src/hooks/useTenant.tsx:22-39` (Maxina `#FF7BAC/#FFF5F8/#1A1A1A`, "Maxina"; Alkalma `#3B82F6/#EFF6FF/#1A1A1A`, display "AlKalma"); the DB `tenant_settings.branding` for Maxina says `brand_fg #1a1a2e` and is not read by `useTenant` (it reads `tenants` + code constants, :113-128). Support email: Maxina `tenant_settings.profile.support_email = support@vitanaland.com` (live), UI copy shows `support@exafy.io` (v1 i18n, 11 hits). Sender: `"Maxina by VITANA <noreply@vitanaland.com>"` (`send-welcome-discount/index.ts:187`). Legal entity: "Exafy LTD" (v1 i18n legal shard `exafyLtd`). Timezone: `Europe/Berlin` hardcoded in 26 gateway files. Locale: fallback `de` (llm-locale helper); 11 locales `ga` in live `supported_locales`. Persona facts: community name + pronunciation in `ai-personality-service.ts:86`.
5. Instance data a new community needs, and how Maxina/Alkalma got it (live counts 2026-10-13):
   - `notification_type_controls`: missing row = OFF, auto-registered OFF on first send (`20260926190000_vtid_04674…sql:17-19,103-115`). The 16 platform-baseline types were seeded `FROM tenants CROSS JOIN` by 04674 (:287-297, 13 types), 04926 (:15-19, 2), 05055 (:140-144, 1) — Alkalma has exactly these 16. A tenant created later gets none → every notification silently off.
   - `ai_provider_policies`: 2 rows per tenant seeded for all tenants by `20260420140000_BOOTSTRAP_seed_ai_policies_all_tenants.sql:26-66`; live rows identical for both tenants.
   - `tenant_settings.feature_flags.jev`: Alkalma `{enabled:true, planes:[internal,system_autopilot,member], monthly_budget_usd:10}` (data-fixup `20261003120000_vtid_04857…sql:11-21`).
   - `tenant_autopilot_settings`: one row, created lazily with column defaults (`admin-autopilot-repository.ts:26`); Maxina 1, Alkalma 0.
   - System chat group + bot: Maxina "Alle Beisammen" `is_system=true, metadata.cap=null`, bot `…0001` as `role='bot'` (`20260625000000_alle_beisammen_chat_group.sql:171-205`); `fire_welcome_chat_on_membership` auto-enrols primary members into every `is_system` group of the tenant (live def). Alkalma has none.
   - No per-tenant pattern exists for: founding campaign (Founding 1000 is one global pool, `20261003100000_vtid_04859…sql`), tip cursor (`did_you_know_state` is per user), tenant_autopilot_bindings (admin choice), ERP bootstrap, job enrolment (jobs still use DEFAULT_TENANT_ID, WS6).
6. Invitations (S-G hardened, VTID-05044): `POST /admin/tenants/:tenantId/invitations` validates roles; accept (`POST /api/v1/admin/invitations/accept/:token`) requires confirmed email = invited email, claims atomically, inserts `user_tenants` with `is_primary:false` (`invitations.ts:291`), active_role = first role. No email is sent (`:106` TODO); v1 has no page at `/admin/invitations/accept/:token` (only the copy-link in `Invitations.tsx:82`). A member switches into a tenant they belong to with `switch_to_tenant_by_slug` (live def: member → switch only; non-member only if `open_signup`).
7. No `tenant-assets` bucket (live `storage.buckets`, 21 buckets). Grants: `tenants` readable by every `authenticated` user (`tenants_select_authenticated` = true); `tenant_settings` readable only by active members (`tenant_settings_member_read`) + service_role.
8. Reserved slugs: D5 path slugs (`vitanaland.com/<slug>`) collide with SPA top-level routes. App.tsx has ~69 top-level segments today (`admin`, `auth`, `u`, `maxina`, `alkalma`, `earthlinks`, …); `screens.json` covers only 32 of them (184 screens) — the complete list is `extractSpaRoutes(App.tsx)` (`vitana-v1/scripts/nav/spa-routes.mjs`, used by `registry.routes.test.ts:16`) plus `exclusions.json` prefixes plus `public/` top-level entries.

## Fix
1. **Brand pack columns on `tenant_settings`** (not `tenants`: `tenants` is readable by every signed-in user; pre-login reads come later through Lane C/WS7's public `resolve_tenant` with a field allowlist). All new, Exafy-governed, never written by the tenant-admin PUT (it only writes the six listed keys):
   `display_name text`, `brand jsonb NOT NULL DEFAULT '{}'` (`{colors:{accent,bg,fg}, tokens:{}, logo_path, favicon_path, og_image_path}`), `legal_entity_line text`, `support_email text`, `sender_name text`, `sender_email text`, `default_locale text NOT NULL DEFAULT 'de'`, `enabled_locales text[] NOT NULL DEFAULT '{de,en,es,sr,fr,pl,pt,ru,tr,zh,ar}'`, `timezone text NOT NULL DEFAULT 'Europe/Berlin'`, `currency text NOT NULL DEFAULT 'EUR'`, `landing jsonb NOT NULL DEFAULT '{}'` (`{hero_image_path, cta:'invite_only'|'signup'|'waitlist'}` — copy comes from content packs, WS5), `persona_facts jsonb NOT NULL DEFAULT '{}'`, `provisioned_at timestamptz`, `provisioned_by uuid`.
   Defaults equal today's platform behaviour, so an absent value changes nothing. `persona_facts` = FACTS only (`community_name`, `community_pronunciation`, `anchor_person{name,pronunciation,role}`, `story_facts[]`, `offer_facts[]`, `tone[]`); each string ≤200 chars, ≤8 items per list; never a sentence Vitana speaks (rule 41) — the WS5 consumer frames facts inside an English intent block. CHECKs (immutable): email regex on `support_email`/`sender_email`, `currency ~ '^[A-Z]{3}$'`, `cardinality(enabled_locales) > 0`, `default_locale = ANY(enabled_locales)`, `jsonb_typeof(...)='object'` on the three jsonb, `char_length(legal_entity_line) <= 200`. A BEFORE INSERT/UPDATE OF (`enabled_locales, default_locale, timezone, brand, landing`) trigger `tenant_settings_brand_pack_validate()` (SECURITY INVOKER) checks every locale exists in `supported_locales`, timezone exists in `pg_timezone_names`, and every `*_path` in `brand`/`landing` starts with `<tenants.slug>/` and has no `..`.
   **Backfill (2 rows, values from where they live today, Problem 4):** Maxina `display_name 'Maxina'`, `brand.colors {#FF7BAC,#FFF5F8,#1A1A1A}` (the SPA's values, not the unused DB `#1a1a2e`), `legal_entity_line 'Exafy LTD'`, `support_email 'support@vitanaland.com'` (current DB value), `sender_name 'Maxina by VITANA'`, `sender_email 'noreply@vitanaland.com'`, `persona_facts {community_name:'Maxina', community_pronunciation:'mah-KSEE-nah'}`; Alkalma `display_name 'AlKalma'`, colors `{#3B82F6,#EFF6FF,#1A1A1A}`, `legal_entity_line 'Exafy LTD'`, persona `{community_name:'Alkalma'}`, sender/support NULL (none exist in code). Locale/timezone/currency take the defaults. `provisioned_at` stays NULL = legacy tenant. Existing columns are not written. **Nothing reads the new columns in this slice** (consumers are WS5/WS7, each with its own golden test), so Maxina is unchanged by construction.
2. **Reserved slugs** — `reserved_tenant_slugs(slug text PK, source text NOT NULL CHECK (source IN ('spa_route','public_file','platform')), added_vtid text)`, RLS on, service_role only. Seeded in migration 1 from `services/gateway/src/services/tenant-provisioning/reserved-slugs.json` = `{source_commit, spa_routes[], public_files[], platform[]}`. `scripts/tenants/gen-reserved-slugs.mjs --v1 <path> [--check]` builds it from a vitana-v1 checkout: top-level segments of `extractSpaRoutes(App.tsx)` ∪ `screens.json` routes/mobile routes ∪ `exclusions.json` prefixes ∪ `public/` top-level names (minus extension), plus a fixed platform list (`api, auth, admin, app, www, static, assets, vitana, vitanaland, vitanaland-platform, platform, exafy, login, signup, join, invite, help, docs, status, health, alive, command-hub, backoffice, dev, staging, preview, mail, support, new, null, undefined`). Legacy tenant slugs that are also routes (`maxina`, `alkalma`, `earthlinks`) are reserved too — no new tenant can take them. No runtime cross-repo coupling: the gateway reads its checked-in JSON; the DB reads its table. **Drift:** `TENANT-RESERVED-SLUGS-DRIFT.yml` (weekly + `workflow_dispatch`, read-only) checks out vitana-v1 `main` with `VITANA_V1_READ_TOKEN` (pattern of `REGEN-SCREENS-CATALOG.yml:64-67`), installs v1 deps, runs `gen-reserved-slugs.mjs --check`; a new segment fails with `::error::` naming it (fix = a migration adding the row + JSON update). A slug check also runs at provision time against both the table and the JSON.
3. **`provision_tenant()`** (migration 2), `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public`, `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role`:
   ```sql
   provision_tenant(p_slug text, p_name text, p_admin_email text, p_invited_by uuid,
     p_all_members_group_name text, p_display_name text DEFAULT NULL,
     p_jev_monthly_budget_usd numeric DEFAULT 10, p_default_locale text DEFAULT 'de',
     p_enabled_locales text[] DEFAULT NULL, p_timezone text DEFAULT 'Europe/Berlin',
     p_currency text DEFAULT 'EUR') RETURNS jsonb
   ```
   Steps, one transaction, `pg_advisory_xact_lock(42001, hashtext(p_slug))` (two-key form; namespace 42001 is reserved for provision_tenant and recorded in the function comment, so no other function's lock can collide):
   a. Validate: slug `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, length 3–32; not in `reserved_tenant_slugs`; `p_name`/group name 1–80 chars; admin email format; `p_invited_by` exists in `auth.users` with `raw_app_meta_data->>'exafy_admin'='true'` (defence in depth behind the route gate); the admin email does not belong to a user in `service_bot_accounts` or `notification_test_actors` (rules 43–45) → `RAISE … USING ERRCODE='22023'` with a stable code word (`INVALID_SLUG`, `RESERVED_SLUG`, `INVALID_ADMIN_EMAIL`, `NOT_EXAFY_ADMIN`, `SERVICE_ACCOUNT_EMAIL`).
   b. Tenant: if a row with this slug exists and its `tenant_settings.provisioned_at IS NULL` → `SLUG_TAKEN` (Maxina/Alkalma and any hand-made tenant are never touched). If it exists and was provisioned → idempotent re-run (`created:false`), `p_name` must match or `SLUG_TAKEN`. Else `INSERT INTO tenants (name, slug)` — `is_active` true, `open_signup` false (column defaults; joining is invite-only until the owner opens it); **`is_default`/`is_platform` are not named**, so the function works before and after Lane A adds them (their `DEFAULT false` applies).
   c. `tenant_settings` row: brand-pack params + `feature_flags = {jev:{enabled:true, planes:[internal,system_autopilot,member], monthly_budget_usd:p_jev_monthly_budget_usd}}` (the Alkalma pattern; listing `member` does not open the member plane, VTID-04857 note) + `provisioned_at/by`; `ON CONFLICT (tenant_id) DO NOTHING`.
   d. Instance data, each `ON CONFLICT DO NOTHING` / `WHERE NOT EXISTS` (re-runs only fill gaps): the baseline `notification_type_controls`, **computed at call time, not hardcoded**: the `(type, source_key)` pairs present in EVERY existing non-provisioned-by-this-call, active, non-platform tenant (the platform baseline is exactly what every type migration seeds `FROM tenants CROSS JOIN`; tenant-local rows auto-registered OFF on first send exist in one tenant only and are excluded), with `enabled = bool_or(enabled)` across tenants (a baseline type one tenant's admin switched off stays on for the new tenant) and `reason='VTID-05150: platform baseline at provisioning'`. Live 2026-10-13 this yields 16 rows (Alkalma's full set; Maxina's 3 extra first-send-OFF rows excluded). A harness test asserts the computed set equals the 16 live baseline types and that a newly migrated `CROSS JOIN` type is picked up without editing the function; the `ai_provider_policies` rows copied column-for-column at call time from the **default tenant** (`tenants.is_default`, Lane A M1) — live 2026-10-13 both tenants hold identical rows (chatgpt + claude, `allowed=true`, cap $50/month), i.e. the values of the corrective seed `20260420170000_BOOTSTRAP_seed_ai_policies_fixed.sql`, not the original 20260420140000 values; copying the live default avoids picking either migration's literal. If no default tenant exists the function raises `NO_DEFAULT_TENANT` (nothing is written); `tenant_autopilot_settings (tenant_id)` with column defaults (same as the lazy create); one `chat_groups` row `is_system=true, name=p_all_members_group_name, description NULL, metadata {cap:null, seeded_by:'provision_tenant'}` + the bot `…0001` as `role='bot'` member (Alle Beisammen pattern). No `chat_messages` (no group welcome post — content, WS8).
   e. First-admin invitation through the existing table: reuse a pending unexpired `tenant_invitations` row for (tenant, lower(email)) with `'admin' = ANY(roles)`; else insert `(tenant_id, email, roles '{admin}', invited_by p_invited_by)` (token/expiry defaults). `admin` is not super-admin-only (`constants/vitana-roles.ts:41`), so accept succeeds under the S-G rules unchanged.
   f. Never touched: `auth.users`, `app_users`, `user_tenants`, `memberships`, `profiles`, `chat_messages`, `user_notifications`, founding tables → no member fan-out trigger can fire (the four fan-out triggers are AFTER INSERT on `user_tenants` only; `tenants`/`tenant_settings`/`chat_groups`/`chat_group_members`/`tenant_invitations` have no triggers, live 2026-10-13).
   Returns `{tenant_id, slug, created, invitation:{id, token, expires_at, reused}, ensured:{notification_controls, ai_policies, autopilot_settings, system_group}}`.
4. **Gateway** (`routes/admin-tenants.ts`, same `verifyExafyAdmin` gate, Zod in `tenant-provisioning/schemas.ts`, writes via `getSupabase()` service role through `admin-tenants-repository.ts`):
   - `POST /api/v1/admin/tenants` — body `ProvisionTenantSchema` (slug, name, admin_email, all_members_group_name, optional display_name, jev budget 0–500, locales/timezone/currency). Pre-checks the slug against `reserved-slugs.json` (fast 400), calls `rpc('provision_tenant', {…, p_invited_by: auth.user_id})`, maps the code words to 400/409 (`SLUG_TAKEN` 409). 201 created / 200 re-run. Response includes the accept path `/admin/invitations/accept/<token>` (operator delivers it; no email sender yet, Problem 6). OASIS `tenant.provisioned` (`source:'gateway/admin-tenants'`, payload: tenant_id, slug, created, invitation_id, ensured counts — never the token or email).
   - `PATCH /api/v1/admin/tenants/:id` — `TenantBrandPackPatchSchema` (strict, every field optional: display_name, brand, legal_entity_line, support_email, sender_name, sender_email, locales, timezone, currency, landing, persona_facts, open_signup). Slug, name, is_active are not patchable. **Legacy tenants (`provisioned_at IS NULL`) → 409 `LEGACY_TENANT_READ_ONLY`** in this slice (Maxina/Alkalma packs are edited when WS5/WS7 start reading them). Writes only the named columns (+ `tenants.open_signup` when given), `updated_by`. **`open_signup:true` is refused with 409 `TENANT_NOT_READY` unless `computeReadiness()` is all-green**; an exafy_admin may pass `override_reason` (≥10 chars), which is recorded in the OASIS event. `open_signup:false` is always allowed. OASIS `tenant.brand_pack.updated` with the changed field names only.
   - `PUT /api/v1/admin/tenants/:id/assets/:kind` (`kind ∈ logo|favicon|og_image`) — `express.raw` ≤1 MB, type by magic bytes via the existing `sniffImageType` (`services/operator-media.ts:35`), then checked against the route's own `ALLOWED_ASSET_TYPES = ['image/png','image/jpeg','image/webp']` (sniffImageType also returns GIF; GIF and anything else → 415; no SVG on a public bucket). Test: GIF bytes → 415. Uploads with service role to `tenant-assets/<slug>/<kind>.<ext>` (upsert), sets `brand.<kind>_path`. Legacy tenants 409 as above. OASIS `tenant.asset.uploaded`.
   - `GET /api/v1/admin/tenants/:id/readiness` — pure `computeReadiness()` over fetched rows → `{ok, ready, checks:[{key, ok, detail}]}`: `slug_valid_not_reserved`, `path_url` (`<platform host>/<slug>`, host from `tenant_settings.domains.primary_domain`, else the existing `FRONTEND_URL` env the gateway already reads — never hardcoded), `brand_colors`, `assets_present` (storage list of `tenant-assets/<slug>/` vs `brand.*_path`), `legal_entity_line`, `support_email`, `sender`, `locales_timezone_currency`, `persona_facts.community_name`, `instance_data` (16 controls, 2 policies, autopilot row, system group with bot, jev flag), `first_admin` (accepted invitation with `admin` or a `user_tenants.active_role='admin'` row — boolean only, no email in the body), `open_signup` (informational). Works for legacy tenants (read-only).
   No change to `index.ts` (router already mounted); `/:id` single-segment routes do not shadow the `/:tenantId/*` sub-routers mounted after it (`index.ts:1405-1456`); a jest pin asserts that.
5. **Bucket** — `scripts/supabase/setup-tenant-assets-bucket.mjs` (Storage API, like `setup-operator-media-bucket.mjs`): public read, 1 MB, `image/png,image/jpeg,image/webp`, **no client write policies** (gateway service role only). Idempotent; run once as a gated production step.
6. **UI decision: CLI now, Command Hub form deferred.** `scripts/tenants/provision-tenant.mjs --gateway <url> --pack <file.json> [--assets <dir>] [--readiness-only]`: reads an exafy_admin JWT from `VITANA_ADMIN_JWT`, POSTs, PATCHes the pack, PUTs assets, prints readiness and the accept path; no default host (rule: never hardcode URLs). Why: a Command Hub edit needs a `DEV-COMHU-*` marker + guard entry (`scripts/ci/command-hub-ownership-guard.js:1-10`), CSP/cache-bust and rule-26 screenshots — a second review surface on the critical path. The API is the contract; the form (new standalone `tenants.{html,js,css}`, the `jev.html` pattern) is follow-up slice B-UI.

## Migrations
- `20261014000400_vtid_05150_tenant_brand_pack.sql` (expand only): `BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s';` ADD COLUMN IF NOT EXISTS ×14 (constant defaults → metadata-only); CHECKs `NOT VALID` then `VALIDATE` (2 rows); validation trigger function (INVOKER, `REVOKE ALL … FROM PUBLIC, anon, authenticated`) + trigger; `reserved_tenant_slugs` + RLS + `REVOKE ALL ON TABLE … FROM anon, authenticated` + seed `ON CONFLICT DO NOTHING`; backfill `UPDATE tenant_settings SET <new columns only> WHERE tenant_id = '<maxina uuid>'` / alkalma, each guarded `AND provisioned_at IS NULL AND display_name IS NULL` (re-run safe); in-migration guard: `RAISE` if either backfill touched ≠1 row. `COMMIT`.
- `20261014000500_vtid_05150_provision_tenant.sql`: the function + REVOKE/GRANT above (VTID-05041 guard: revokes PUBLIC and anon in the same file). Depends on migration 1. **Depends on Lane A M1** (`tenants.is_default`, used only to pick the AI-policy template) — applied after A's M1; the queue entry says so.
- Rollback `docs/validation/VTID-05150/rollback.sql`: `DROP FUNCTION provision_tenant`; drop trigger/function; `DROP TABLE reserved_tenant_slugs`; columns dropped **only if** `SELECT count(*) FROM tenant_settings WHERE provisioned_at IS NOT NULL` = 0, else first `CREATE TABLE bak_vtid_05150_tenant_settings AS SELECT tenant_id, <new columns> FROM tenant_settings` (kept 30 days) and the rollback stops before dropping columns (a provisioned tenant must not lose its pack silently). A second, separate script `rollback-complete.sql` finishes the rollback after the backup has been reviewed (drops the new columns; keeps the `bak_` table for its 30 days); its header says when it may run.
- Pre-check `live-before.sql` (read-only): the 2 tenants rows + full tenant_settings rows (md5 of `row_to_json` of the six existing jsonb + updated_at), counts per tenant in the 6 touched tables, `to_regclass('public.reserved_tenant_slugs') IS NULL`, `has_function_privilege` absent.
- Post-check `post-apply-checks.sql`: md5 of the existing columns unchanged for both tenants; new columns = backfill values; `reserved_tenant_slugs` count = JSON count; `has_function_privilege('anon'|'authenticated','provision_tenant(…)','EXECUTE')` = false, service_role = true; counts per tenant unchanged; zero rows with `provisioned_at IS NOT NULL`.
- Dry-run of both files + rollback on the local stack/PGlite replay (`docs/validation/VTID-05150/pglite-migration-check.mjs`, VTID-05124 pattern).

## Tests
1. `scripts/ci/test-vtid-XXXXX-provision-tenant.sh` (local PostgreSQL harness, VTID-04981/05041 pattern, run by `vtid-XXXXX-provision-tenant-sql.test.ts` when a server is available; static assertions always): fixture with stub `auth.users`, `supported_locales`, two legacy tenants (+ their settings), service/test-account tables, a bot. Cases: create → 1 tenant, settings, 16 controls, 2 policies, 1 autopilot row, 1 system group + bot, 1 invitation; re-run → `created:false`, same tenant, **same** invitation reused, no duplicate rows; `maxina`/`alkalma`/`admin`/`u`/`Maxina`/`a`/`x--y`/`-x` → errors, zero writes; existing legacy slug → `SLUG_TAKEN`, zero writes; non-exafy `p_invited_by` → `NOT_EXAFY_ADMIN`; admin email of a `service_bot_accounts`/`notification_test_actors` user → refused; anon/authenticated `EXECUTE` denied; **Maxina/Alkalma unchanged**: md5 of every row of both legacy tenants in `tenants`, `tenant_settings`, `notification_type_controls`, `ai_provider_policies`, `chat_groups`, `chat_group_members`, `tenant_invitations` identical before/after a provision; zero rows added to `user_tenants`, `memberships`, `app_users`, `chat_messages`, `user_notifications`, `founding_members`; the validation trigger rejects a bad timezone, an unknown locale, a `logo_path` outside `<slug>/` or with `..`; the tenant-admin-style upsert of `{profile, branding}` still succeeds on a legacy row (trigger column list excludes them).
2. `vtid-XXXXX-admin-tenants-provisioning.test.ts` (supertest, mocks as `test/routes/admin-tenants.test.ts`): 401 no token / 403 non-exafy on all four new routes; Zod 400s (bad slug, unknown persona key, 201-char fact, bad email, bad currency, `slug` in PATCH body); reserved slug 400 before any RPC; RPC code words → 400/409; 201 vs 200 re-run; PATCH on legacy → 409 and no update call; asset: SVG/GIF/oversize/mislabelled bytes → 415/413, png → storage path `<slug>/logo.png`; OASIS emitted with no token/email in payload; readiness all-green fixture, each check flipping individually, legacy tenant readable; pin: `/:id` routes don't capture `/x/invitations`.
3. `vtid-XXXXX-reserved-slugs.test.ts`: JSON sorted/unique/lowercase/format; migration seed set == JSON set; every legacy slug present; `gen-reserved-slugs.mjs` on a fixture v1 tree produces the expected list and `--check` exits 1 on a new App.tsx segment.
4. Existing suites green: `test/routes/admin-tenants.test.ts` (GET shapes unchanged), `vtid-05041-definer-lockdown.test.ts`, invitation tests (`test/routes/tenant-admin/*`), `npm run test:roles` (no new route file; `admin-tenants` already claimed by `/^admin-/`, `domain-atlas.ts:183`), `npm run test:support` and `npm run test:operator` (not touched; run as required by rules 42c/42e only if CI selects them), gateway `tsc`/lint.

## Staging verification
`docs/validation/VTID-05150/staging-tests.json`, read-only (staging writes to production Supabase — no provisioning on staging):
- `GET /api/v1/admin/tenants/<maxina uuid>/readiness` unauthenticated → 401 JSON `UNAUTHENTICATED` (route exists, JSON not HTML).
- `POST /api/v1/admin/tenants` `{rejected_probe:true, expect_status:401}` (invalid bearer → `INVALID_TOKEN`, nothing written).
- `PATCH /api/v1/admin/tenants/<maxina uuid>` rejected probe → 401; `PUT …/assets/logo` rejected probe → 401.
- `GET /api/v1/admin/tenants` unauthenticated → 401 (unchanged).
- `existing`: the three jest files above.
Acceptance evidence (`acceptance.md`): ROUTE_MOUNT `adminTenantsRouter` at `/api/v1/admin/tenants` (`index.ts:1399`, unchanged) gains `POST /`, `PATCH /:id`, `PUT /:id/assets/:kind`, `GET /:id/readiness`; FINAL_URL `https://preview-aws-gateway.vitanaland.com/api/v1/admin/tenants…` (staging), same paths on production after PUBLISH; CURL_PROOF = the STAGING-VERIFY run above (401 JSON on every new route).

## Rollout
1. Merge (gateway code is inert without the migration: the RPC call fails closed with 503 `PROVISIONING_UNAVAILABLE` when `provision_tenant` is missing; readiness reports `schema_missing`) → `AWS-STAGE-DEPLOY-GATEWAY.yml` → STAGING-VERIFY on the merge commit → Gate 2 (gateway deploy, pinned commit, diffed against prod build-info).
2. DB, gated (Gate-1-covered, owner-approved off-peak window): pre-check SQL → `RUN-MIGRATION.yml` migration 1 → post-check → migration 2 → post-check. Order vs Lane A: B's migration 1 is independent, B's migration 2 (`provision_tenant`) **depends on Lane A M1** (`tenants.is_default`) and is applied only after A's M1 post-check passed; the `MIGRATION-QUEUE.md` entries record `depends-on: A-M1` and the rollback ids. The pre-check refuses to run B's M2 if `information_schema` shows no `tenants.is_default`.
3. Bucket: run `setup-tenant-assets-bucket.mjs` once (production write, same approved window), verify with a read-only bucket list.
4. **Creating the real new tenant is NOT part of this slice's tests or deploy.** It is a separate owner-approved production action after Gate 2: owner approves the filled pack file (`RUNBOOK-provision.md`: pack fields, persona facts review for rule 41, asset files, jev budget), an exafy_admin runs the CLI against the production gateway, then readiness; result posted with the OASIS event id. No flag is needed: the routes are exafy_admin-only and the function is service_role-only.
5. First admin: the operator sends the accept path; the admin accepts while signed in with the invited, confirmed email (API today; page in Lane C slice), then switches in via `switch_to_tenant_by_slug` (member path) so `requireTenantAdmin` sees the tenant in the token.

## Risks
1. **Signup still lands in the oldest tenant.** A first admin (or any founding member) who signs up fresh is enrolled as a *primary Maxina member* by `handle_new_user` / `auth.ts:654` (oldest-tenant fallback) — that fires Maxina's welcome fan-out. Mitigation in the runbook: first admin = an existing account where possible; member onboarding into the new tenant waits for Lane A (`is_default` + signup routing) and the WS3 join flow. Readiness cannot fix this; it is stated in Gate 1.
2. **Reserved-list drift** between a new SPA top-level route and an existing tenant slug: the drift workflow is weekly, not per-PR in v1; a v1 route added on a provisioned slug would shadow the tenant path until noticed. Accepted for M1 (WS7 portal not live yet); a v1-side PR check is follow-up B-SLUG-V1.
3. **Persona facts are free text** written by Exafy staff; length caps and the facts-only schema limit but cannot prove rule 41. The consumer (WS5) must frame them as facts inside intents, golden-tested there.
4. Tenant-admin `PUT /settings` overwrites `feature_flags` wholesale, including `jev.monthly_budget_usd` (`settings.ts:65`) — pre-existing, but a new tenant gets tenant admins, so it is **closed in this slice**: the tenant-admin PUT merges `feature_flags` server-side and ignores the governed key `jev` (enabled, planes, monthly_budget_usd) unless the caller is exafy_admin. Mechanics: in SQL, one statement `feature_flags = coalesce(feature_flags,'{}') || (\$client_flags - 'jev')` for non-exafy_admin (top-level key merge; `jev` keeps its stored value whole, other keys are replaced by the client's value as today), and `coalesce(feature_flags,'{}') || \$client_flags` for exafy_admin — no read-modify-write race; the response lists ignored keys. Test: a tenant admin raising the Jev budget leaves it unchanged; an exafy_admin can change it.
5. A provisioned tenant with `open_signup=false` is reachable only by invitation; PATCHing `open_signup=true` makes it self-joinable through the S-E path — exafy_admin-only, refused unless readiness is all-green (or an explicit logged override), OASIS-logged.

## Out of scope
- Command Hub provisioning form → **B-UI** (standalone module, DEV-COMHU).
- Invitation accept page outside the admin guard + real invitation email → **Lane C WS4 accept-page slice**.
- `tenants.is_default`/`is_platform`, signup default tenant, `bootstrap_admin` fix → **Lane A WS1**.
- Founding pool per tenant, Network/Community scopes → **WS3**; system-group welcome post, seed groups, Season 0, KB docs → **WS8**; tip cursor, job enrolment/loops → **WS6**; ERP bootstrap request → **M3**; custom domains / `tenant_domains` → **M3**; isolation smoke in readiness → **WS0**; deactivate/archive → **WS4 follow-up**; consuming the brand pack in SPA/emails/ORB → **WS7/WS5**; tenant-admin settings key guard → **B-SETTINGS-GUARD**.

## Owner decisions
None new. (Defaults chosen inside the approved program: invite-only `open_signup=false` for new tenants; Jev budget default $10/month, the Alkalma value, overridable per call.)
<!-- plan:end -->

## Planner responses — round 1
- F1 (blocker) — ACCEPTED. Lane B's migrations are renumbered to `20261014000400_…_tenant_brand_pack.sql` and `20261014000500_…_provision_tenant.sql` (Lane A owns 000100–000300). Both are recorded in `docs/multitenancy/MIGRATION-QUEUE.md` after Lane A's M1, on which B's M2 now depends (see F3/Q3).
- F2 (major) — ACCEPTED. The asset route checks the `sniffImageType` result against its own `ALLOWED_ASSET_TYPES` (png/jpeg/webp); GIF and everything else → 415; test added (GIF bytes → 415).
- F3 (major) — ACCEPTED (variant of the suggestion). The notification baseline is computed at call time as the `(type, source_key)` pairs present in every existing active non-platform tenant, `enabled = bool_or(enabled)`. Copying one tenant's rows would also copy its local first-send-OFF rows (live: Maxina has 3 that Alkalma lacks) and its admin's toggles; the intersection is exactly what every `CROSS JOIN tenants` type migration seeds. Harness test: the computed set = the 16 live baseline types, and a new CROSS JOIN type is picked up with no function edit.
- F4 (major) — ACCEPTED. Two-key `pg_advisory_xact_lock(42001, hashtext(p_slug))`, namespace documented in the function comment.
- F5 (minor) — ACCEPTED (mechanical, not only discipline): PATCH `open_signup:true` → 409 `TENANT_NOT_READY` unless readiness is all-green; an exafy_admin override needs `override_reason`, recorded in OASIS.
- F6 (minor) — ACCEPTED. A separate `rollback-complete.sql` finishes the rollback after backup review; its header states the precondition.
- F7 (minor) — ACKNOWLEDGED (confirmation only).
- F8 (minor) — ACCEPTED. Scope line: the repository gets new functions only; existing read functions untouched.
- Q1 — See F1: fixed ranges per lane in MIGRATION-QUEUE.md (A 000100–000300, B 000400–000500; C and S-M take later ranges).
- Q2 — See F3: computed at call time (no hardcoded list) plus the drift test.
- Q3 — Live 2026-10-13: both tenants hold identical `ai_provider_policies` rows that match the corrective seed `20260420170000_BOOTSTRAP_seed_ai_policies_fixed.sql`. The function now copies the default tenant's live rows at call time (no literal from either migration); no default tenant → `NO_DEFAULT_TENANT`, nothing written. This makes B's M2 depend on Lane A M1.
- Additional change by the planner (not from a finding; please review): Risk 4 (tenant admins can overwrite `feature_flags.jev`, incl. the Jev budget, via `PUT /settings`) is now CLOSED in this slice rather than deferred, because provisioning creates new tenant admins: the PUT merges `feature_flags` server-side and ignores the governed `jev` key for non-exafy_admin callers; tests added.

## Planner responses — round 2
- F9 (major) — ACCEPTED. Rollout step 2 now states B's M2 depends on Lane A M1, applied only after A-M1's post-check; queue entries record `depends-on: A-M1`; the pre-check refuses B's M2 when `tenants.is_default` is absent.
- F10 (minor) — ACCEPTED. The merge is one SQL expression (`feature_flags || (client - 'jev')` for tenant admins, `feature_flags || client` for exafy_admin): top-level key merge, `jev` preserved whole, no read-modify-write race.


---

## 2. Sparring partner output (verbatim, every round)

### Partner output — round 1 (verbatim)

I notice the plan says "png/jpeg/webp only (no SVG on a public bucket)" but `sniffImageType` also handles GIF. The plan says GIF will be rejected (415), so the asset upload route would need its own subset check, not directly reuse the full `sniffImageType` return. Minor point but worth noting.

Now I have all the evidence I need. Let me write the findings.

## Verified premises

- **Claim: `admin-tenants.ts` has only `GET /` and `GET /:id`, both behind `verifyExafyAdmin`** -- TRUE. `/home/user/vitana-platform/services/gateway/src/routes/admin-tenants.ts:53` (GET /), `:104` (GET /:id), `:28-49` (verifyExafyAdmin). No POST/PATCH/PUT.
- **Claim: tenant-admin `PUT /settings` replaces `profile`/`branding` wholesale** -- TRUE. `/home/user/vitana-platform/services/gateway/src/routes/tenant-admin/settings.ts:63-64` does `if (profile !== undefined) updates.profile = profile;` / `if (branding !== undefined) updates.branding = branding;` and the repository at `settings-repository.ts:23-24` runs a full `upsert()`. The six keys the PUT writes are `profile`, `branding`, `feature_flags`, `integrations`, `domains` plus `updated_at`/`updated_by` (`:57-67`). New brand-pack columns (`display_name`, `brand`, `legal_entity_line`, etc.) are never named there, so the PUT cannot wipe them. Correct design.
- **Claim: `admin` is not in `SUPER_ADMIN_ONLY_ROLES`** -- TRUE. `/home/user/vitana-platform/services/gateway/src/constants/vitana-roles.ts:37`: only `['developer', 'infra']`. `admin` at `:25` is a regular role. Invitation acceptance for an `admin` role succeeds under S-G rules.
- **Claim: `sniffImageType` exists at `operator-media.ts:35`** -- TRUE. `/home/user/vitana-platform/services/gateway/src/services/operator-media.ts:35`. However, it returns `OperatorMediaType` which includes `image/gif` (`:30-31`), while the plan says GIF should be rejected (415). The plan would need a post-sniff allowlist check, not raw reuse of `sniffImageType`.
- **Claim: 16 baseline notification_type_controls (13 + 2 + 1)** -- TRUE. 04674 migration `:287-297` seeds 13 types via `CROSS JOIN`; 04926 `:15-18` adds `chat_mention` + `comment_mention`; 05055 `:140-143` adds `partner_link_request`. Total = 16.
- **Claim: `adminTenantsRouter` mounted at `/api/v1/admin/tenants` at `index.ts:1399`** -- TRUE. Exact match at `:1399`.

## Findings

F1 [blocker] Migration timestamps collide with Lane A

Evidence: Lane A declares `20261014000100_vtid_XXXXX_tenants_default_platform_flags.sql` (M1) and `20261014000200_vtid_XXXXX_signup_default_tenant.sql` (M2) (`A-tenant-foundation.md:6-7`). Lane B declares `20261014000100_vtid_XXXXX_tenant_brand_pack.sql` (M1) and `20261014000200_vtid_XXXXX_provision_tenant.sql` (M2) (`B-provision-tenant.md:54-55`). Supabase orders migrations lexicographically by filename and requires unique timestamps. Two files with `20261014000100` cannot coexist; whichever lane merges second will fail at `supabase db push` / the `RUN-MIGRATION.yml` runner with a duplicate-migration error, or worse, run in an unintended order if the suffix sorts differently than expected.

Suggestion: Give Lane B its own non-colliding timestamps, e.g. `20261014000400` and `20261014000500` (Lane A uses 100-300). Or coordinate through `MIGRATION-QUEUE.md` with pre-assigned non-overlapping ranges per lane. This must be resolved before either lane can merge.

F2 [major] `sniffImageType` returns GIF but the plan says GIF is rejected

Evidence: `operator-media.ts:30-31` defines `OPERATOR_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']` and `sniffImageType` at `:35-43` returns `image/gif` for GIF bytes. The plan says "png/jpeg/webp only (no SVG on a public bucket)" and "GIF... -> 415". If the asset upload route naively checks `sniffImageType(buf) !== null` as a pass/fail, GIF uploads would silently succeed.

Suggestion: The plan should explicitly state that the asset route maintains its own `ALLOWED_ASSET_TYPES` allowlist (`['image/png', 'image/jpeg', 'image/webp']`) and checks the `sniffImageType` result against it, not just for non-null. Add a test case: GIF bytes -> 415.

F3 [major] `provision_tenant()` hardcodes the 16 notification types in its body -- future drift

Evidence: The plan says the function body holds "the exact union of the 04674/04926/05055 lists" (Fix 3d). Every future `CROSS JOIN tenants` migration that adds a new notification type (the established pattern at `04674:287`, `04926:15`, `05055:140`) will NOT update the function body, so a tenant provisioned after that migration will be missing the new types while existing tenants have them. The function becomes a parallel source of truth that drifts from the live baseline.

Suggestion: Instead of hardcoding the 16 types, query them from an existing tenant's `notification_type_controls` rows at provision time: `INSERT INTO notification_type_controls SELECT p_new_tenant_id, type, source_key, enabled, reason FROM notification_type_controls WHERE tenant_id = (SELECT tenant_id FROM tenants WHERE is_default LIMIT 1)`. This way new types added by future migrations are automatically included. If `is_default` is not yet available (Lane A dependency), use a materialized list but add a prominent `-- DRIFT WARNING` comment and a test that compares the function's list against the actual types present in Maxina. The test is the minimum.

F4 [major] Advisory lock key collision risk across functions

Evidence: The plan uses `pg_advisory_xact_lock(hashtext('provision_tenant:' || p_slug))`. `hashtext` returns a 32-bit integer. With a production Postgres that may run other functions using `pg_advisory_xact_lock`, there is no namespace separation -- any other function using `hashtext` with a similar string pattern could collide on the same lock ID. More importantly, if two concurrent `provision_tenant` calls use different slugs that hash to the same 32-bit value, they would not serialize. This is a birthday-problem scenario.

Suggestion: Use the two-key form: `pg_advisory_xact_lock(<fixed namespace int>, hashtext(p_slug))` where the namespace is a constant unique to this function (e.g. `42001`). This eliminates cross-function collisions. The within-function birthday collision is acceptable for tenant provisioning (rare operation).

F5 [minor] `PATCH /:id` on a provisioned tenant allows `open_signup` toggle without readiness check

Evidence: Fix 4 says PATCH writes `tenants.open_signup` when given, and it is exafy_admin-only and OASIS-logged. But the readiness check (Fix 4, `GET /:id/readiness`) is a separate call. A new tenant could be PATCHed to `open_signup=true` before all readiness checks pass (e.g., no assets, no legal entity, no first admin). The plan acknowledges this in Risk 5 but only says "exafy_admin-only and OASIS-logged." That is an operational control, not a mechanical one.

Suggestion: Either (a) add a sentence in the plan stating this is an accepted residual (exafy_admin discipline), or (b) add a readiness pre-check to the `open_signup=true` PATCH path that warns (or blocks) when readiness is not all-green. The RUNBOOK could also state it. At minimum acknowledge it explicitly as a design decision.

F6 [minor] Rollback SQL conditionally drops columns only if no provisioned tenant exists, but backup table is created first -- ordering ambiguity

Evidence: Rollback says "columns dropped ONLY IF `SELECT count(*) FROM tenant_settings WHERE provisioned_at IS NOT NULL` = 0, else first `CREATE TABLE bak_vtid_XXXXX_tenant_settings AS SELECT ...`... and the rollback stops before dropping columns." This is a sensible guard, but the plan does not say what happens to the backup table if a later rollback attempt (after reviewing the backup) wants to proceed. The 30-day retention is mentioned but the actual "continue rollback after review" step is missing.

Suggestion: Add a `-- To complete rollback after backup review: DROP TABLE bak_...; then ALTER TABLE tenant_settings DROP COLUMN ...` comment block to the rollback SQL, or a second rollback script. Otherwise an operator performing rollback under pressure may not know how to proceed past the stop.

F7 [minor] The plan says "no Command Hub file" but `reserved-slugs.json` is a new static file under `services/gateway/src/services/tenant-provisioning/`

Evidence: The plan's scope line says "No Command Hub file (decision in Fix 6)." This is correct -- no file under `services/gateway/src/frontend/command-hub/`. The `reserved-slugs.json` file is under `services/gateway/src/services/tenant-provisioning/`, which is not a Command Hub path and does not trigger the `PROTECTED_PATH` guard at `scripts/ci/command-hub-ownership-guard.js:15`. No issue here; just confirming the claim is accurate.

F8 [minor] The `admin-tenants-repository.ts` file is listed as edited but no current POST/PATCH/PUT repository functions exist

Evidence: The plan says routes will go through `admin-tenants-repository.ts` (Fix 4). The current file (`admin-tenants-repository.ts`) contains only read functions (`fetchTenantsList`, `fetchAllTenantMemberships`, `fetchTenantById`, `fetchTenantBySlug`). The plan should note that new repository functions will be added for the provision RPC call, the PATCH update, the asset upload, and the readiness check -- this is additive, not editing existing functions. Low risk but worth being explicit about since the file is shared with the existing GET routes.

Suggestion: Clarify in the scope line that `admin-tenants-repository.ts` gets new functions added, and existing functions are not modified.

## Questions for the planner

1. How will you coordinate migration timestamp ranges with Lane A? Will you use `MIGRATION-QUEUE.md` to pre-assign non-overlapping ranges, or will you simply use later timestamps?

2. For the notification_type_controls seeding: have you considered querying the default tenant's live rows instead of hardcoding the 16 types? If hardcoding is deliberate, will you add a drift-detection test?

3. The `ai_provider_policies` seed copies values "column-for-column from the 20260420140000 seed values held in the function body." There is also a corrective migration `20260420170000_BOOTSTRAP_seed_ai_policies_fixed.sql` that inserts different values. Which set does the function actually use -- the original or the corrected?

## Verdict

NOT CONVERGED -- F1 (migration timestamp collision) is a blocker that must be resolved. F2, F3, and F4 are majors that need answers or plan changes.

### Partner output — round 2 (verbatim)

I notice Rollout step 2 still says "depends-on: none" even though the planner's response says B's M2 now depends on Lane A's M1. Let me check whether this was updated in the plan text.

Looking at line 55: "Depends on Lane A M1 (tenants.is_default, used only to pick the AI-policy template) -- applied after A's M1; the queue entry says so."

And line 78: "Order vs Lane A: independent; if MIGRATION-QUEUE.md exists, both entries go in it (depends-on: none; rollback id listed)."

There is a contradiction. Line 55 says B's M2 depends on A's M1. Line 78 says "depends-on: none." This is an inconsistency that needs to be fixed.

Now I have everything. Let me write the final output.

## Prior findings — status

- F1 [blocker] Migration timestamp collision -- **closed**. Plan revised: B uses `20261014000400` and `20261014000500`; Lane A owns 000100-000300. Scope line (`:3`) and migration section (`:54-55`) updated. Q1 also resolved by the same fix.

- F2 [major] sniffImageType returns GIF but plan rejects GIF -- **closed**. Plan now explicitly states the route uses its own `ALLOWED_ASSET_TYPES = ['image/png','image/jpeg','image/webp']` and GIF -> 415 with a test (`:47`).

- F3 [major] Hardcoded notification types drift -- **closed**. The function now computes the baseline at call time from existing tenants (`:40`). A harness test asserts parity with the 16 live types and that new `CROSS JOIN` types are picked up without editing the function. Q2 also resolved.

- F4 [major] Advisory lock key collision -- **closed**. Two-key form adopted: `pg_advisory_xact_lock(42001, hashtext(p_slug))` (`:36`).

- F5 [minor] open_signup without readiness check -- **closed**. PATCH now refuses `open_signup:true` with 409 `TENANT_NOT_READY` unless readiness all-green; exafy_admin override requires `override_reason` logged in OASIS (`:46`, `:88`).

- F6 [minor] Rollback ordering ambiguity -- **closed**. Separate `rollback-complete.sql` with precondition header (`:56`).

- F7 [minor] No Command Hub file confirmation -- **acknowledged** (was confirmation only; no action needed).

- F8 [minor] Repository new vs edited functions -- **closed**. Scope line now explicitly states new functions only, existing reads untouched (`:3`).

- Q1 -- **closed** (see F1).
- Q2 -- **closed** (see F3).
- Q3 -- **closed**. Function copies the default tenant's live rows at call time (`:40`, `:111`), which hold the corrective seed values. B's M2 depends on A's M1 for `is_default`. `NO_DEFAULT_TENANT` error if no default exists.

## Findings

F9 [major] Rollout step 2 contradicts the dependency declared in Migrations

Evidence: Line 55 says "Depends on Lane A M1 (`tenants.is_default`, used only to pick the AI-policy template) -- applied after A's M1; the queue entry says so." But line 78 (Rollout step 2) still says "Order vs Lane A: independent" and "depends-on: none." The planner's response at line 101 (F1) and line 111 (Q3) both confirm the dependency exists. This is a stale sentence that directly contradicts the new design -- an operator following the Rollout section would apply B's M2 without first confirming A's M1 is in place, causing the function to reference a non-existent `is_default` column (hard SQL error, not a graceful `NO_DEFAULT_TENANT`).

Suggestion: Update Rollout step 2 to say "B's M2 depends on A's M1 (`tenants.is_default`); the `MIGRATION-QUEUE.md` entry records this" and remove "depends-on: none." One sentence fix.

F10 [minor] Feature_flags.jev guard requires a read-before-write in the settings PUT, but the plan does not describe the merge mechanics

Evidence: The current `settings.ts:65` replaces `feature_flags` wholesale via `upsertTenantSettings`. The plan says the PUT will "merge feature_flags server-side and ignore the governed jev key for non-exafy_admin" (`:87`). This requires reading the existing `feature_flags` from the database first, stripping `jev` from the client payload (unless exafy_admin), merging, then writing. The plan does not describe this read-merge-write pattern. The current code does not read before writing (`:59-70`), so this is a new code pattern for this route. While straightforward, the lack of description could lead to an implementer doing a naive shallow merge that loses nested keys.

Suggestion: Add one sentence to Risk 4 or Fix 4 describing the pattern: "The PUT reads the existing `feature_flags` via `fetchTenantSettings`, deep-merges the client's non-governed keys into it, and writes the result." Or equivalently, the merge could be done in a SQL expression (e.g., `feature_flags = feature_flags || $1` with `jev` stripped), avoiding the read.

## Questions for the planner

None -- the remaining items are clear.

## Verdict

NOT CONVERGED -- F9 is a major (stale rollout text contradicts the actual dependency, creating an operational risk during migration application). F10 is minor and does not block convergence by itself. One sentence fixes both.

### Partner output — round 3 (verbatim)

Both fixes are in the plan text and consistent with the responses. Let me confirm the Rollout step 2 and Risk 4 changes are coherent.

Rollout step 2 (`:78`): Now says "B's migration 2 (`provision_tenant`) depends on Lane A M1 (`tenants.is_default`) and is applied only after A's M1 post-check passed; the `MIGRATION-QUEUE.md` entries record `depends-on: A-M1`" and adds a pre-check guard. Consistent with the Migrations section (`:55`) and the planner responses.

Risk 4 (`:87`): Now describes the SQL expression `feature_flags = coalesce(feature_flags,'{}') || ($client_flags - 'jev')` for non-exafy_admin -- a single-statement atomic merge with no read-modify-write race. Clean solution.

No new blockers or majors introduced by these changes.

## Prior findings -- status

- F1 [blocker] Migration timestamp collision -- **closed** (round 1)
- F2 [major] sniffImageType GIF handling -- **closed** (round 1)
- F3 [major] Hardcoded notification types drift -- **closed** (round 1)
- F4 [major] Advisory lock collision -- **closed** (round 1)
- F5 [minor] open_signup without readiness -- **closed** (round 1)
- F6 [minor] Rollback ordering -- **closed** (round 1)
- F7 [minor] No Command Hub file -- **acknowledged** (round 1)
- F8 [minor] Repository scope clarity -- **closed** (round 1)
- F9 [major] Rollout step 2 contradicts dependency -- **closed**. Rollout step 2 (`:78`) now explicitly states B's M2 depends on A's M1, the queue records it, and the pre-check refuses if `tenants.is_default` is absent in `information_schema`.
- F10 [minor] Feature_flags merge mechanics -- **closed**. Risk 4 (`:87`) now describes the SQL expression: `feature_flags || ($client_flags - 'jev')` for tenant admins, `feature_flags || $client_flags` for exafy_admin -- single statement, no read-modify-write race.

## Findings

No new blockers or majors.

## Questions for the planner

None.

## Verdict

CONVERGED -- all blockers and majors from rounds 1-2 are closed with verified plan changes. The plan is internally consistent: migration timestamps are non-colliding, dependencies are recorded and mechanically enforced, notification seeding is dynamic, the advisory lock uses two-key form, the feature_flags guard is race-free, the rollout section matches the migration section, and the rollback has a complete two-step path. The planner-initiated addition (jev guard) is sound. Ready for Gate 1.

---

## 3. Owner approval (Gate 1)

Owner approval (Gate 1): "Yes" — 2026-10-13, Claude Code session; plan hash 9b05a91052fa3c69a90750149e524c5682afd8b00436a9488493e6dfd9158efb (computed before VTID substitution); sparring record c62b4f75-b3c0-48e0-a78d-d19b848bc803.
