# Lane C — Frontend tenant registry + generic `/:slug` community portal (WS7 core; §4.1 anonymous resolution, §4.5 brand pack, §4.8 path slugs)

change class: standard
scope:
- vitana-platform: `supabase/migrations/20261014000600_vtid_05151_public_tenant_registry.sql`, `supabase/migrations/20261014000700_vtid_05151_seed_legacy_tenant_landing.sql`, `docs/validation/VTID-05151/{rollback-registry.sql,rollback-seed.sql,pre-check.sql,post-check.sql,plan-sparring.md}`, `supabase/tests/vtid_05151_public_tenant_registry.test.sql` (local-Postgres harness, same runner as `scripts/ci/test-vtid-05041-definer-lockdown.sh`), `services/gateway/test/vtid-05151-public-tenant-registry-migration.test.ts`, `docs/multitenancy/MIGRATION-QUEUE.md` (2 entries).
- vitana-v1, new files: `src/lib/tenant-registry.ts`, `src/hooks/useTenantRegistry.ts`, `src/pages/portals/TenantPortal.tsx`, `src/components/portal/TenantAuthCard.tsx`, `scripts/nav/build-reserved-tenant-slugs.mjs` → `src/generated/reserved-tenant-slugs.json` + `public/reserved-tenant-slugs.json`, `src/i18n/{de,en}/tenantPortal.json`, tests listed under Tests, `tests/e2e/staging/vtid-05151-tenant-registry.staging.spec.ts`, `docs/validation/VTID-05151/staging-tests.json`.
- vitana-v1, edited: `src/hooks/useTenant.tsx`, `src/components/TenantDetector.tsx`, `src/components/AppLayout.tsx` (logo click + display name only), `src/components/AuthGuard.tsx` (login route + intro branch only), `src/hooks/useSmartRouting.tsx`, `src/lib/guest-auth.ts`, `src/lib/tenant-display.ts`, `src/lib/localStorage.ts`, `src/context/ProfileProvider.tsx` (type only), `src/components/profile/ProfileDrawer.tsx`, `src/pages/{PublicEventLanding,PublicCampaignLanding,EventGamePublicLanding}.tsx` (login-route maps only), `src/pages/admin/TenantManagement.tsx`, `src/lib/retired-tenants.test.tsx`, `src/App.tsx` (≤20 lines, own PR), `src/navigation/registry/exclusions.json`, `src/design/screen-manifest.json`, `package.json` (`prebuild` adds the reserved-slug builder).
- Untouched on purpose: `MaxinaPortal.tsx`, `MaxinaConfirmed.tsx`, `IntroExperience.tsx`, `/maxina*` routes, `switch_to_tenant_by_slug`, `handle_new_user`, `provision_platform_user`.

Evidence base: origin/main @ `e1ad8a0fd` (platform), `d09d66c4f` (v1); local HEAD = origin/main in both (fetched 2026-10-13). Live read-only checks on `inmkhvwdcuyhnxkgfvsb` 2026-10-13.

<!-- plan:begin -->
## Problem
1. **The frontend knows two tenants by name.** `src/hooks/useTenant.tsx:11` `export type TenantType = "maxina" | "alkalma"`; `:22-39` compiled `TENANT_CONFIGS`; `:73` the URL-slug fallback walks only those keys; `:128-131` merges the DB row with `TENANT_CONFIGS[slug] || TENANT_CONFIGS.maxina`, so **any other tenant is rendered as Maxina** (name and brand). A newly provisioned tenant therefore cannot be shown.
2. **Hardcoded tenant lists elsewhere** (`git grep -i alkalma` in `src/**/*.ts(x)`, non-i18n, non-test):
   - `ProfileDrawer.tsx:37-40` (`TENANT_LABELS`)
   - `ProfileProvider.tsx:4,21` (`TenantType`)
   - `lib/localStorage.ts:1,22,37,51,63` (`TenantType`)
   - `lib/tenant-display.ts:4-7` (`SLUG_TO_NAME`)
   - `AppLayout.tsx:144-154,160-193` (logo-click switch and the display-name ladder)
   - `AuthGuard.tsx:73-76` (login route) and `:207-212` (intro only for maxina|alkalma)
   - `TenantDetector.tsx:26-27`
   - `useSmartRouting.tsx:16,130,136` (path lists); `:172-180,216,267-275` (the `default:` branch returns `/maxina` for an unknown tenant); `:296-303,313-316`
   - `lib/guest-auth.ts:22-24`
   - `PublicEventLanding.tsx:41`, `PublicCampaignLanding.tsx:165`, `EventGamePublicLanding.tsx:32`
   - `admin/TenantManagement.tsx:19-22`
   - Out of this slice (named under Out of scope): `tickets/ticket-tenant.ts:4`, `tickets/EventTicket.tsx:56`, `TicketDemo.tsx:11`, `Index.tsx:75-85`, `dev/DevDashboard.tsx:38`, `dev/DevSettings.tsx:163`, `dev/settings/Tenants.tsx:57`, `dev/modals/UploadFrontpageModal.tsx:48`, `dev/DocsFrontpagesView.tsx:9`, `config/domain-tenant-mapping.ts:5-11` (host mapping is the M3 custom-domain slice).
3. **Anonymous visitors cannot resolve a tenant.** Live 2026-10-13: `tenants` policies are `tenants_read` (`tenant_id = current_tenant_id()`, NULL for anon), `tenants_select_any_member`, `tenants_select_authenticated` (`true`, authenticated only) and exafy/service ALL. `tenant_settings` has only `tenant_settings_member_read`, and it checks the legacy `memberships` table, so the 18 `user_tenants`-only members cannot read their own brand. No `resolve_tenant` or `list_public_tenants` function exists. The only `*tenant*slug*` functions are `switch_to_tenant_by_slug` and `resolve_tenant_for_user` (both: anon EXECUTE false, authenticated true).
4. **Brand data already lives in the DB, but nothing reads it.** Live rows:
   - maxina: `open_signup=true`, `tenant_settings.branding={"brand_accent":"#FF7BAC","brand_bg":"#FFF5F8","brand_fg":"#1a1a2e"}`, `profile={"name":"Maxina",…}`.
   - alkalma: `open_signup=true`, `branding={}`, `profile={}`.
   - `tenants.branding` is `{}` for both. There is no `is_platform`, `is_default`, `tenant_domains`, `brand` or `landing` column yet. Program §2 does not mention `tenants.open_signup` (added by VTID-05043, `20261010180200_…:57-77`) or `tenant_settings.branding`; this plan relies on both.
5. **Theme tokens are written but never used.** `useTenant.tsx:134-141`, `MaxinaPortal.tsx:231-233` and `AlkalmaPortal.tsx:53-55` write hex values to `--brand-accent/-bg/-fg`. `index.css:138-140,385-387` declares the same variables as HSL triplets. `git grep "var(--brand-"` returns 0 hits and `tailwind.config.ts` has no `brand`. Writing different values therefore cannot change what renders today.
6. **No generic portal.** `App.tsx:875` routes `/maxina` to `MaxinaPortal` (870 lines) and `:877` routes `/alkalma` to `AlkalmaPortal` (454 lines; a copy with `'alkalma'` hardcoded at `:44,82,117,146` and raw colours). The only top-level dynamic route is `/u/:identifier` (`App.tsx:1492`). `/_intro/:tenantSlug` (`:818`) is already slug-generic, but its content is Maxina-specific.
7. **Two premises this slice depends on but must not change** (owned by Lane A):
   - (a) `handle_new_user` (live) enrols the user into any `raw_user_meta_data.tenant_slug` without an `open_signup` check, and falls back to the oldest tenant. An OAuth signup carries no metadata slug, so it lands in Maxina.
   - (b) **Live, outside this slice, P1:** `user_tenants` has `user_tenants_update_own` (`user_id = auth.uid()`, no WITH CHECK). `authenticated` holds UPDATE on all of its columns, including `active_role` and `tenant_id`, and the table has no UPDATE trigger. A member can therefore set their own `active_role='admin'`, which `require-tenant-admin.ts:33-45,119` trusts, or move their own membership into a closed tenant. This bypasses the join gate this portal relies on. It is escalated under Owner decisions.

## Fix
1. **DB: public tenant registry (2 SECURITY DEFINER read functions over 1 internal function).**
   - `public._tenant_public_registry()` RETURNS TABLE(`tenant_id uuid, slug text, name text, display_name text, open_signup boolean, brand jsonb, landing jsonb, locales jsonb`):
     - LANGUAGE sql STABLE with a non-atomic body: the INTERNAL query is planned at call time, so columns that Lane A/B add later (read through `to_jsonb(...)`) are picked up without re-creating the function. The RETURN shape is fixed by the explicit `RETURNS TABLE(...)` column list and the key whitelist, so a new column never reaches the output unless a migration adds it to the whitelist.
     - Its body reads `to_jsonb(t)`/`to_jsonb(s)` from `tenants t LEFT JOIN tenant_settings s USING (tenant_id)`, filters on `t.is_active AND t.slug IS NOT NULL AND coalesce((to_jsonb(t)->>'is_platform')::boolean,false) = false`, and orders by slug. The `is_platform` term is deliberately inert until Lane A adds the column (no platform row exists before then); Lane A defines it as `boolean NOT NULL DEFAULT false`, so the cast cannot fail. Whichever of A/C ships second replaces the `to_jsonb(t)` read with `t.is_platform` in its own migration (recorded in `docs/multitenancy/MIGRATION-QUEUE.md`). Only the whitelisted keys leave the function; `to_jsonb(s)` stays internal to a function that is itself `REVOKE ALL … FROM PUBLIC, anon, authenticated`.
     - `display_name` = `coalesce(nullif(b->>'display_name',''), t.name)`.
     - `brand` is a **whitelisted** `jsonb_strip_nulls(jsonb_build_object(...))` with exactly these keys:
       - `accent`, `bg`, `fg`: from `b->'tokens'->>'accent'|'bg'|'fg'`, falling back to `brand_accent|brand_bg|brand_fg`;
       - `logo_path`, `favicon_path`, `og_image_path`: from `b->'assets'->>…`, falling back to flat `*_path`.
       - The merge is `b = coalesce(t.branding,'{}') || coalesce(s.branding,'{}') || coalesce(to_jsonb(s)->'brand','{}')`, so Lane B's `tenant_settings.brand` wins when it exists.
     - `landing` is whitelisted to `tagline` (object locale→text), `intro` (bool), `auto_switch_on_visit` (bool), `post_login_path` (text), `oauth` (bool). The source is `coalesce(s.profile->'landing','{}') || coalesce(to_jsonb(s)->'landing','{}')`.
     - `locales` = `coalesce(to_jsonb(s)->'locales', s.profile->'locales')`. NULL means all platform GA locales.
     - Nothing else is exposed: no `policy_profile`, `feature_flags`, `integrations`, `billing`, `domains` or support email.
     - REVOKE ALL FROM PUBLIC, anon, authenticated.
   - `public.list_public_tenants()` and `public.resolve_tenant(p_slug text)`:
     - LANGUAGE sql STABLE SECURITY DEFINER, `SET search_path = public, pg_temp`, same RETURNS TABLE.
     - `resolve_tenant` filters `slug = lower(btrim(p_slug))` and returns 0 or 1 row; it never falls back.
     - `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO anon, authenticated, service_role;` plus `-- definer-public: anonymous visitors resolve a community's public brand/landing fields before sign-in (program §4.1); fixed whitelisted field list, never inactive or platform rows`. This satisfies the VTID-05041 guard (`vtid-05041-definer-lockdown.test.ts:125-135`).
     - Both are STABLE, so PostgREST serves them over GET.
   - **Ordering with Lane B: no hard dependency.** C works against today's columns and picks up B's columns automatically. The shape C reads is `tenant_settings.brand {tokens:{accent,bg,fg}, assets:{logo,favicon,og_image}, display_name}`, `tenant_settings.landing {…keys above}`, `tenant_settings.locales jsonb`, `tenants.is_platform boolean`. This contract goes into `docs/multitenancy/LANE-C.md` for Lane B to match. If B picks other names, B's PR adds them to the whitelist; the pgTAP shape test fails until it does.
2. **DB: seed legacy landing data** (separate migration, idempotent, existing keys always win: `new || existing`):
   - alkalma `tenant_settings.branding` gains `{"display_name":"AlKalma","brand_accent":"#3B82F6","brand_bg":"#EFF6FF","brand_fg":"#1A1A1A"}`. These are the values compiled in today (`useTenant.tsx:31-38`, `AppLayout.tsx:165`).
   - maxina `profile.landing` = `{"intro":true,"auto_switch_on_visit":true,"post_login_path":"/onboarding/welcome","oauth":true}`.
   - alkalma `profile.landing` = `{"intro":true,"auto_switch_on_visit":true,"post_login_path":"/home","oauth":true}`. (Today `useSmartRouting.tsx:174-175` sends an Alkalma member to `/alkalma`; since `/alkalma` becomes the portal, the member now lands on `/home` directly. This affects Alkalma's 1 member and is listed as a deliberate behaviour change.)
   - Together these move every per-tenant branch in Problem 2 into data, without changing behaviour for these two tenants.
3. **v1 `src/lib/tenant-registry.ts`** (pure functions, unit-tested):
   - `type TenantEntry` mirrors the RPC row.
   - `COMPILED_MAXINA_FALLBACK`: the safety net. It is used **only** when the RPC call errors (network/5xx), never for an unknown slug.
   - `fetchTenantRegistry()` = `supabase.rpc('list_public_tenants', undefined, { get: true })`. The GET matters: the staging network guard aborts non-GET Supabase calls.
   - `findBySlug`, `findById`, `tenantSlugFromPath(pathname, reg)` (first segment, after `canonicalTenantSlug`).
   - `safeHex(v)` (`^#[0-9a-fA-F]{6}$`, else undefined), so DB values cannot inject CSS.
   - `safeInternalPath(p)`: must start with `/`, not `//`, no scheme, else `/home`. This is the open-redirect guard for `post_login_path`.
   - `assetUrl(path)`: Storage public URL for `tenant-assets/<slug>/…` relative paths only; an absolute URL is rejected.
   - `isReservedSlug(slug)` reads `src/generated/reserved-tenant-slugs.json`.
   - `SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/`.
   - Snapshot: `readRegistrySnapshot()` and `writeRegistrySnapshot()` in localStorage `tenant_registry_v1`, wrapped in try/catch, for the synchronous callers (`getInstantTenantName`, `resolveLoginRoute`, `AuthGuard.getLoginRoute`). With no snapshot they fall back to compiled Maxina, which matches today's behaviour for Maxina.
4. **v1 `useTenantRegistry()`**: React Query key `['tenant-registry','v1']`, `staleTime` 10 min, `gcTime` 24 h, writes the snapshot on success. On error it returns `{ source:'fallback', tenants:[COMPILED_MAXINA_FALLBACK] }` and logs `console.warn('[tenant-registry] fallback', err)` (fail loudly; no silent switch).
5. **v1 `useTenant.tsx` rewrite (public API unchanged:** `activeTenantId, tenant, isExafyAdmin, setActiveTenant, setTenantBySlug`):
   - Delete the `TenantType` union and `TENANT_CONFIGS`. Export `type TenantSlug = string`.
   - The URL fallback (`:71-77`) uses `tenantSlugFromPath` over the registry. The slug→id lookup (`:85-89`, `:204-208`) uses the registry instead of `from('tenants')`.
   - `tenant` = `{ tenant_id, id: '', tenantId, slug, name: display_name, displayName, openSignup, landing, brandAccent, brandBg, brandFg }`.
     - `id: ''` is kept on purpose. Today's merge always yields `id:""` (`:24,32,130`), and `AppLayout.tsx:471-487` keys the sidebar state on `tenant?.id || "global"`. A real UUID would reset every member's sidebar state, so the golden test pins `id === ''`.
     - The new `tenantId` field carries the UUID.
   - An `activeTenantId` that is not in the registry (inactive, platform, or registry fallback) builds a neutral entry from the authenticated `tenants` row: name = DB name, no brand tokens. **It is never Maxina**, which removes the overwrite at `:130`.
   - The CSS-var effect is kept and only writes `safeHex` values.
   - `setTenantBySlug` keeps the `switch_to_tenant_by_slug` RPC + `refreshSession()` path unchanged, but it **rejects an unknown or reserved slug before calling it**, with no local fallback that sets a tenant the RPC refused.
6. **v1 consumers.** Each fix reads the registry:
   - `ProfileDrawer`: `displayName`.
   - `ProfileProvider`, `localStorage.ts`: `string`.
   - `tenant-display.ts`: snapshot.
   - `AppLayout` logo click: `/${slug}` if the slug is in the registry, else `/`. The display-name ladder becomes `entry.displayName`, with the final `'Community'` fallback kept.
   - `AuthGuard` login route: `/${slug}` for a registry slug, else `/`. The intro branch runs when `entry.landing.intro`, else `navigate(loginRoute)`.
   - `TenantDetector`: auto-switch only when `entry.landing.auto_switch_on_visit` is true (seeded for maxina/alkalma, so their behaviour is unchanged). A new tenant's path never auto-joins; joining is an explicit button on the portal.
   - `useSmartRouting`: the path lists become `isTenantPortalPath(path)`. The `community` branch goes to `safeInternalPath(entry.landing.post_login_path ?? '/onboarding/welcome')`. The unknown-tenant `default` no longer returns `/maxina`; it returns `/home`. The logout redirect and `useTenantFromUrl` use the registry.
   - `guest-auth.resolveLoginRoute`: a registry slug gives `/${slug}`, otherwise `/maxina` (unchanged default).
   - The three public landings use the registry slug if present, else `/maxina` (unchanged default).
   - `TenantManagement`: names from the registry; badge colours use neutral `muted` tokens.
   - `retired-tenants.test.tsx:32-42`: rewritten to assert there is no `TenantType` union and earthlinks is not in the compiled fallback (VTID-04836 intent kept).
7. **v1 generic portal `TenantPortal.tsx`** at `/:tenantSlug` (App.tsx; react-router ranks static segments above dynamic ones, so `/maxina`, `/commerce`, `/home` etc. keep winning):
   - **Slug checks, in order:** a slug that fails `SLUG_RE` or is reserved renders `<NotFound/>` with no RPC call. A retired slug (`canonicalTenantSlug`) gets `<Navigate>` to its successor. Otherwise call `resolve_tenant` (GET). An unknown slug renders `<NotFound/>`. **No Maxina fallback on this page, even when the RPC fails**: the page shows the archetype error state with Retry.
   - **Layout:** `<ScreenFrame archetype="form">` with one `VCard size="spotlight"` (logo via `assetUrl`, display name, tagline). The tagline is `landing.tagline[locale]` when present, else the i18n key `screens.tenantPortal.tagline` with `{{brand}}`. Tokens only, logical properties, the archetype skeleton while loading, `aria-live` errors, labelled inputs.
   - **Anonymous visitor:** `TenantAuthCard` shows sign-in (`signInWithPassword`, then `setTenantBySlug(slug)`). Sign-up (`signUp` with `data:{full_name, tenant_slug: slug}`, `emailRedirectTo: getEmailRedirectUrl('/' + slug + '?confirmed=true')`) is shown **only if `open_signup`**; otherwise an invite-only notice. OAuth buttons only if `landing.oauth === true` (see Problem 7a and Risks).
   - **Signed-in member** (`user_tenants` select-own, live policy `user_tenants_select_own`): if the active tenant is not already this slug, `setTenantBySlug(slug)` (switch only, once per mount). Then navigate to `safeInternalPath(post_login_path)`, **except** when that path is the portal itself (`/${slug}` or starts with `/${slug}/`, or any `isTenantPortalPath`), in which case it navigates to `/home`. The portal therefore never redirects to a portal path, for any tenant's config (cycle guard; unit-tested with a config whose `post_login_path` is its own slug).
   - **Signed-in non-member:** if `open_signup`, a "Join {{brand}}" button runs `setTenantBySlug(slug)`, which calls the hardened `switch_to_tenant_by_slug` (VTID-05043, open_signup only, writes `user_tenants`). If not open, the invite-only notice. A `42501 TENANT_NOT_JOINABLE` error shows an i18n error and never falls back.
   - `?confirmed=true` shows the "email confirmed, sign in" state (same as `/maxina?confirmed=true`).
   - `/alkalma` becomes `<TenantPortal slug="alkalma"/>` (alias). `/alkalma/confirmed` keeps `AlkalmaConfirmed`. `AlkalmaPortal.tsx` is deleted in the same PR.
8. **Reserved slugs:**
   - `scripts/nav/build-reserved-tenant-slugs.mjs` takes the first path segments of `extractSpaRoutes(App.tsx)` (`scripts/nav/spa-routes.mjs`, already used by `registry.routes.test.ts:16`) ∪ the first segments of `screens.json` routes ∪ the `public/` top-level entries ∪ `{api, auth, rest, storage, functions, _intro, e, i, u, assets}`, minus `LEGACY_TENANT_ROUTES = ['maxina','alkalma']` (tenant-owned static routes). It writes `src/generated/reserved-tenant-slugs.json` and `public/reserved-tenant-slugs.json`.
   - It runs in `prebuild` next to `build-nav-registry.mjs` (`package.json:9`).
   - The public copy is the input for Lane B's `provision_tenant` slug check (program §4.8). Lane B consumes it; C only publishes it.
9. **Nav registry and design manifest:**
   - `exclusions.json` gains `{ "route": "/:tenantSlug", "reason": "Community portal/sign-in for a tenant reached by link — not a voice destination (same as /maxina)" }`.
   - `npm run design:manifest` adds `/:tenantSlug` with archetype `form`, tier `P`, area "Public, auth, legal & portals", status `migrated`.
10. **i18n:**
   - New namespace `tenantPortal`, about 18 keys (signIn, join {{brand}}, inviteOnly, notJoinable, confirmed, retry, tagline {{brand}}, form labels, errors), written DE first in du-form, then EN.
   - Run `npm run i18n:stamp`. The other 9 GA locales follow through `I18N-PROPAGATE.yml` after merge (repo convention: `I18N-PROPAGATE.yml:11-17` derives every locale from EN). Gate 2 lists the propagate run.
   - Shared form strings reuse the existing `screens.portals.*` keys.
   - No hardcoded string; nothing spoken (rule 41 not touched).
11. **Theme tokens (item 4) are deferred** by name to C2 (see Out of scope). Applying `--brand-*` across the app means choosing consumers inside Spotlight tokens and is a design-contract change. This slice only delivers validated tokens in the registry and keeps today's (unconsumed) variable writes.

## Migrations
- `20261014000600_vtid_05151_public_tenant_registry.sql`:
  - Expand only: 3 new functions; no table, column or policy change.
  - `BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; … COMMIT;`
  - Ends with a `DO` block that asserts the end state by effect:
    - `has_function_privilege('anon','public.list_public_tenants()','EXECUTE')` true;
    - the same for `resolve_tenant(text)`;
    - `_tenant_public_registry()` false for anon and authenticated;
    - `(select count(*) from list_public_tenants() where slug in ('maxina','alkalma')) = 2`;
    - `not exists (select 1 from resolve_tenant('zz-not-a-tenant'))`.
  - Rollback `docs/validation/VTID-05151/rollback-registry.sql`: `DROP FUNCTION IF EXISTS public.resolve_tenant(text), public.list_public_tenants(), public._tenant_public_registry();` No data is touched.
- `20261014000700_vtid_05151_seed_legacy_tenant_landing.sql`:
  - Two `UPDATE tenant_settings … SET branding = <seed> || branding, profile = jsonb_set(profile,'{landing}', <seed> || coalesce(profile->'landing','{}'))`, `WHERE tenant_id = (select tenant_id from tenants where slug=…)`. That is 2 rows; existing keys win.
  - Snapshot first: `CREATE TABLE bak_vtid_05151_tenant_settings AS SELECT tenant_id, branding, profile FROM tenant_settings`, retained 30 days (§4.7).
  - Rollback restores `branding` and `profile` from the snapshot for those 2 tenant_ids.
- Pre-check (`pre-check.sql`, read-only):
  - `to_regprocedure('public.resolve_tenant(text)') IS NULL` and the same for `list_public_tenants()`;
  - `select slug, open_signup, is_active from tenants` = {maxina t t, alkalma t t};
  - `select branding, profile from tenant_settings` matches the 2026-10-13 values above.
- Post-check (`post-check.sql`, read-only):
  - the DO-block assertions above;
  - `select slug, display_name, brand, landing from list_public_tenants()` returns exactly 2 rows with whitelisted keys only;
  - `select jsonb_object_keys(brand)` ⊆ {accent,bg,fg,logo_path,favicon_path,og_image_path}.
- Both migrations are entered in `MIGRATION-QUEUE.md` (owner lane C, depends-on: none, Lane A reviewed) and applied through `RUN-MIGRATION.yml` in the owner-approved off-peak window, after the local-harness dry run.

## Tests
- **Local Postgres harness** (`supabase/tests/vtid_05151_public_tenant_registry.test.sql`, runner modelled on `scripts/ci/test-vtid-05041-definer-lockdown.sh`), with fixtures active, inactive, slug-NULL and `is_platform` tenants:
  - (a) anon gets active non-platform rows only;
  - (b) an inactive or platform tenant is absent from both functions;
  - (c) `resolve_tenant('UNKNOWN')` is empty, and `resolve_tenant(' Maxina ')` resolves;
  - (d) anon cannot EXECUTE `_tenant_public_registry` and cannot SELECT `tenants`/`tenant_settings` beyond today's policies;
  - (e) **forward-compat:** after `ALTER TABLE tenants ADD COLUMN is_platform boolean` and `ALTER TABLE tenant_settings ADD COLUMN brand jsonb, landing jsonb, locales jsonb` in the test, the platform row disappears and `brand.tokens` overrides `branding`, with no re-create;
  - (f) a secret key planted in `branding` and `profile` (e.g. `stripe_key`) never appears in the output.
- **Jest** `vtid-05151-public-tenant-registry-migration.test.ts` (the file guard, like `vtid-05043-s3-migrations.test.ts`): revokes plus the `definer-public` reason are present; no `SELECT *` or `to_jsonb(t)` is returned unfiltered; the rollback files exist. The existing `vtid-05041-definer-lockdown.test.ts` stays green.
- **Vitest (v1):**
  - `tenant-registry.test.ts`: `safeHex`, `safeInternalPath` (`//evil`, `https://x`, `javascript:`), `assetUrl`, `tenantSlugFromPath`, retired slug, fallback only on error.
  - `useTenant.registry.test.tsx`:
    - an unknown activeTenantId gives a neutral entry, never `name:'Maxina'`;
    - `setTenantBySlug('zz')` makes no RPC call;
    - `setTenantBySlug` with an RPC 42501 does not set the tenant.
  - **`tenant-registry.maxina-golden.test.tsx`**, with two sources, the live-shaped RPC fixture and RPC failure (compiled fallback). Both must produce the same snapshot of:
    - the resolved Maxina `tenant` (`id:''`, `name:'Maxina'`, `slug`, `displayName`);
    - `getInstantTenantName('/maxina')`;
    - the `AppLayout` display name and logo-click target `/maxina`;
    - `AuthGuard` login route `/maxina` and intro `/_intro/maxina`;
    - `useSmartRouting` community redirect `/onboarding/welcome`, logout `/maxina`, path lists containing `/maxina`;
    - `resolveLoginRoute()` `/maxina`;
    - the TenantDetector auto-switch for `/maxina`;
    - `App.tsx` still maps `/maxina` → `MaxinaPortal` and `/maxina/confirmed` → `MaxinaConfirmed`;
    - `git grep "var(--brand-"` = 0, so the change of Maxina's unconsumed `--brand-fg` (#1A1A1A → DB #1a1a2e) is pinned as non-rendering, and C2 must update this golden consciously.
  - `tenant-slug-reserved.test.ts`:
    - the generated file equals a fresh build from App.tsx and screens.json;
    - `/:tenantSlug` is the only top-level single-segment dynamic route (`/u/:identifier` has two segments; any new `/:x` fails). This test is a **build-time blocker for the new route**, not for the portal: a developer adding a top-level `/:param` route must nest it under a static prefix (as `/i/:code`, `/u/:identifier` do). The test failure message says so;
    - every top-level static route except `LEGACY_TENANT_ROUTES` is reserved;
    - the seeded slugs are not reserved;
    - `TenantPortal` renders NotFound for a reserved slug without calling the RPC.
  - `TenantPortal.test.tsx`: unknown slug → NotFound; RPC error → error state with no Maxina; anon + open → sign-up visible; anon + closed → invite-only; member → switch + `post_login_path`; non-member join → RPC called once; 42501 → error; RTL (`dir="rtl"`) renders with logical classes; axe check, no violations.
  - Existing tests that must stay green: `registry.routes.test.ts`, `registry.test.ts`, `build-nav-registry.test.ts`, `screen-manifest.test.ts`, `retired-tenants.test.tsx` (rewritten), `useTenant.error-logging.test.ts`, `tenant-display.test.ts`, `domain-tenant-mapping.test.ts`, `spotlight.vtid-05105.test.tsx`; ESLint `design/*` and `i18n/*` at error; PR-GATE design ratchet.
- Platform suites `test:roles`/`test:support`/`test:operator`: not touched (no gateway source change). They run in CI as usual.

## Staging verification (read-only; staging uses production Supabase)
`tests/e2e/staging/vtid-05151-tenant-registry.staging.spec.ts`, anonymous, with the existing network guard (non-GET to the gateway or Supabase aborted):
1. `/maxina` renders MaxinaPortal (`[data-maxina-app]`, sign-in fields), has no `[data-screen="tenant-portal"]`, and makes no `switch_to_tenant_by_slug` request. `/_intro/maxina` still loads its poster.
2. `/zz-unknown-<random>` renders the NotFound text. `/home2x` (bad slug) renders NotFound with zero `resolve_tenant` requests.
3. `/alkalma` renders `[data-screen="tenant-portal"]` with "AlKalma" and the sign-up tab (`open_signup`).
4. `GET <supabase>/rest/v1/rpc/list_public_tenants` with the anon key returns 200, includes `maxina` and `alkalma`, and returns only whitelisted keys. `GET …/rpc/resolve_tenant?p_slug=zz-unknown` returns `[]`.
5. Live slugs ∩ `/reserved-tenant-slugs.json` (minus the legacy pair) = ∅.

`docs/validation/VTID-05151/staging-tests.json` lists the spec plus the vitest/pgTAP refs (as `kind: existing`, with the reason: joining writes, so it is proven in CI only). No sign-in, no join click, no writes.

## Rollout
1. PR1 (platform): the two migrations, rollbacks, pre/post checks, harness test, Jest guard. It merges dark; the functions only exist once applied. Dry run on the local harness, then owner-approved apply via `RUN-MIGRATION.yml`, then post-check.
2. PR2 (v1): registry lib/hook, `useTenant` and consumers, golden and unit tests. Merge is safe before PR1 is applied: the RPC errors, which uses the compiled-Maxina fallback; behaviour for Maxina is identical. **But merge only after PR1 is applied**, so that Alkalma is not shown as an unknown tenant on staging.
3. PR3 (v1): `TenantPortal`, `TenantAuthCard`, App.tsx (≤20 lines), the reserved-slug builder, exclusions, manifest, i18n DE/EN, staging spec. Rebased just before merge (hot file).
4. Flow: staging deploy → STAGING-VERIFY → Gate 2 (commit range, migrations applied, Decisions taken) → PUBLISH pinned to the verified commit. No feature flag. An unknown slug rendered NotFound before (`*`) and still does; registry slugs exist only for provisioned tenants; the only visible change is `/alkalma` (1 member). Rollback = revert PR3, then PR2; DB rollback files are pre-approved.

## Risks
1. **The join gate is bypassable live** (Problem 7b, `user_tenants` UPDATE grant). This is not created by this slice, but the portal's "open_signup only" promise is false until it is fixed. It must be fixed (Track S) before any closed tenant is provisioned.
2. **Signup metadata bypass** (Problem 7a): `signUp({data:{tenant_slug}})` joins any tenant, open or not, and OAuth signups land in Maxina as the oldest tenant. Mitigations:
   - the portal hides sign-up for closed tenants and hides OAuth unless `landing.oauth`;
   - the real fix is Lane A (`handle_new_user` honours `open_signup` + `tenants.is_default`) and must land before the first closed or OAuth-enabled new tenant.
3. **`/:tenantSlug` catches every unmatched single-segment URL.** Unknown slugs cost one cached GET before NotFound, and reserved or bad slugs cost none. A future static route that collides with a provisioned slug would shadow that tenant; the reserved-slug test plus Lane B's provision check prevent it.
4. The Supabase redirect allowlist may not include `https://vitanaland.com/<slug>?confirmed=true` [FACT, auth config not readable from SQL]. If it does not, confirmation lands on the Site URL `/`. This is a degraded path, not a failure; it is listed in Gate 2.
5. The localStorage snapshot can be stale for up to 10 min after a rename. This is cosmetic only (display name); authority stays with the RPC and the membership.

## Out of scope (deferred, named)
- **C2 — WS7 theme & brand surface:** `--brand-*` consumed via Spotlight tokens on the portal and in-app for members; logo/favicon/meta/OG per tenant; tickets (`ticket-tenant.ts`, `EventTicket.tsx`, `TicketDemo.tsx`); `Index.tsx` community picker; dev pages' tenant lists; IntroExperience made generic (today `landing.intro` is false for new tenants).
- **Lane A:** `handle_new_user`/`provision_platform_user` open_signup + `is_default`; `tenants.is_platform`.
- **Lane B:** brand/landing/locales columns (C's whitelist contract above); `provision_tenant` consuming `reserved-tenant-slugs.json`.
- **M3:** host resolution (`tenant_domains`, `DOMAIN_TENANT_MAP`); tenant switching UI.
- **WS5:** tenant content overrides (`tenant_content_overrides`) replacing `landing.tagline`.

## Owner decisions
- **None for this slice's design.**
- **One escalation (Autonomy Contract stop (c), security):** Problem 7b is a live self-escalation. Any member can `UPDATE user_tenants SET active_role='admin'` (trusted by `requireTenantAdmin`) or move their membership into any tenant via PostgREST (verified read-only 2026-10-13: `authenticated` has UPDATE on all 7 columns, the policy has no WITH CHECK, there is no UPDATE trigger, and v1 has no client writer: `git grep "from('user_tenants')"` finds only `queue-campaign-recipients`).
- **Recommended:** an expedited Track S slice to `REVOKE UPDATE ON user_tenants FROM authenticated` and drop `user_tenants_update_own`. This slice does not wait on it, but no closed tenant is provisioned before it lands.
<!-- plan:end -->

## Planner responses — round 1
- F1 (major) — ACCEPTED (documentation + sequencing, approach kept). The `to_jsonb(t)` read of `is_platform` is kept on purpose so C has no ordering dependency on A; Fix 1 now says it is inert until A adds the column, that A defines it `boolean NOT NULL DEFAULT false` (cast cannot fail), and that whichever lane ships second rewrites it to `t.is_platform` in its own migration (tracked in MIGRATION-QUEUE.md). `to_jsonb(s)` never leaves the function; the output is the explicit whitelist and the helper is revoked from PUBLIC/anon/authenticated. Harness test (e) already asserts the platform row is FILTERED OUT after the column exists (not only that the column is picked up); wording in Tests unchanged.
- F2 (major) — ACCEPTED. The reserved/only-dynamic-route test is stated as a build-time blocker for any new top-level `/:param` route, with the remedy (nest under a static prefix) in the failure message.
- F3 (minor) — CLOSED by verification: `git grep AlkalmaPortal -- src` shows only `App.tsx:118,877` (plus an i18n key name); `AlkalmaConfirmed` does not import it. Deletion in PR3 stands.
- F4 (minor) — ACKNOWLEDGED; same as today's behaviour, covered by the golden test.
- F5 (minor) + F6 (blocker) — ACCEPTED. Two changes: (a) Alkalma's seeded `post_login_path` is `/home` (listed as a deliberate change for Alkalma's 1 member); (b) a general cycle guard in TenantPortal: switch only if the active tenant differs, once per mount, and never navigate to a portal path (`/${slug}`, `/${slug}/…`, or any `isTenantPortalPath`) — such a target becomes `/home`. Unit test with a self-referencing `post_login_path`.
- F7 (minor) — ACCEPTED. Wording clarified: internal query planned at call time; return shape fixed by `RETURNS TABLE` + whitelist.
- Q3 — Migrating `/maxina` from MaxinaPortal to TenantPortal is DEFERRED to slice C2 (named in Out of scope), after the golden suite has been proven on TenantPortal with Alkalma. Until then the Maxina golden test pins MaxinaPortal unchanged; drift between the two portals is accepted for that window because MaxinaPortal is not edited by this program before C2.

## Planner note after convergence (numbering only, no design change)
Migration files renumbered to the lane ranges recorded in `docs/multitenancy/MIGRATION-QUEUE.md`: `20261014000600_…_public_tenant_registry.sql`, `20261014000700_…_seed_legacy_tenant_landing.sql` (A owns 000100–000300, B 000400–000500, S-M 20261013200000). No dependency change: C still reads A's/B's columns through `to_jsonb` when present.

## Partner rounds (verbatim)

# Partner output — round 1 (verbatim)

Now I have everything needed. Let me write the findings.

```
## Verified premises

- **Claim: `TenantType = "maxina" | "alkalma"` at useTenant.tsx:11, with TENANT_CONFIGS at :22-39 and Maxina fallback at :130** --> TRUE -- `src/hooks/useTenant.tsx:11` has the exact union, `:22-39` has the two configs, `:130` merges with `TENANT_CONFIGS[...] || TENANT_CONFIGS.maxina`.

- **Claim: `git grep "var(--brand-"` returns 0 hits; tailwind.config.ts has no `brand`** --> TRUE -- ripgrep for `var(--brand` across the entire vitana-v1 tree returns zero matches. `tailwind.config.ts` has no `brand` entry. The CSS file `index.css:138-140,385-387` only DECLARES the variables (`--brand-accent: ...`), never CONSUMES them via `var()`.

- **Claim: useSmartRouting default branch returns `/maxina` for unknown tenant (`:172-180,267-275`)** --> TRUE -- `src/hooks/useSmartRouting.tsx:180` `navigate("/maxina")` in the `default:` case of the community redirect; `:274` `return "/maxina"` in `getRedirectUrl()`'s default.

- **Claim: AuthGuard intro branch at `:207-212` only runs for maxina|alkalma** --> TRUE -- `src/components/AuthGuard.tsx:208` checks `slug === 'maxina' || slug === 'alkalma'`.

- **Claim: `user_tenants_update_own` has no WITH CHECK** --> TRUE -- `supabase/migrations/20251231000000_vtid_01101_phase_a_bootstrap.sql:116-117`: `FOR UPDATE TO authenticated USING (user_id = auth.uid())` with no `WITH CHECK` clause.

## Findings

F1 [major] The `_tenant_public_registry()` body description says "non-atomic body" with `to_jsonb(t)` / `to_jsonb(s)` from the join, but the whitelisted output is built from `jsonb_build_object(...)` with explicit keys. The plan describes building the merge as `b = coalesce(t.branding,'{}') || coalesce(s.branding,'{}') || coalesce(to_jsonb(s)->'brand','{}')` which reads the ENTIRE `to_jsonb(s)` record and extracts `brand`, meaning `to_jsonb(s)` is computed even though its unfiltered form is never returned. If a future column on `tenant_settings` contains sensitive data (billing keys, integrations), it would be present in the function's internal working set. More critically, the plan states `to_jsonb(t)` is used for the `is_platform` filter: `coalesce((to_jsonb(t)->>'is_platform')::boolean, false)` -- but `is_platform` does not exist yet on `tenants` (Lane A adds it). This means the filter silently evaluates to `false` for every row, which is the DESIRED result (no platform row to exclude). However, this is fragile: if `to_jsonb` is used elsewhere and someone adds a column named `is_platform` with a non-boolean type, the cast would fail at runtime for every call.

Evidence: Plan Fix 1 body description; `tenants` live schema has no `is_platform` column (Lane A Problem 1 confirms this, Lane A Fix adds it).

Suggestion: Use `EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tenants' AND column_name='is_platform') AND coalesce(t.is_platform, false)` or simply omit the `is_platform` filter from C and let Lane A add it to the function when it adds the column. Alternatively, since the internal helper is private (REVOKE ALL), accept the `to_jsonb` approach but document that the `is_platform` filter is inert until Lane A ships, and add a pgTAP test that confirms the filter excludes a platform row after Lane A's column exists (the forward-compat test (e) partially covers this but should assert the filtering, not just that the column is picked up).

F2 [major] The `/:tenantSlug` catch-all route collides with ALL single-segment paths that are not statically declared above it in App.tsx. React Router v6 ranks static over dynamic, so `/maxina`, `/home`, `/discover` etc. win. But paths like `/i/:code` (line 876) and `/e/:slug` (line 850) are also dynamic single-segment routes (well, `/e/:slug` is two segments, but `/i/:code` is). The plan says "react-router ranks static segments above dynamic ones" but the real ranking rule is more nuanced: `/i/:code` has a static first segment `i` so it wins, fine. The real risk is `/u/:identifier` at line 1492 -- that IS a two-segment route so it is safe. But the plan's reserved-slug builder takes "first path segments" of all routes. If a new feature adds a simple `/:param` route (not just `/:tenantSlug`), two dynamic catch-alls would be ambiguous. The test at `tenant-slug-reserved.test.ts` asserting "the only top-level single-segment dynamic route" is good defense, but the plan does not explain what happens if that test FAILS -- is it a blocker for the new route or for the tenant portal?

Evidence: Plan Fix 7, Fix 8; `src/App.tsx:876` `/i/:code`, `:1492` `/u/:identifier`.

Suggestion: Add a sentence to the plan stating that the reserved-slug test is a BUILD-TIME blocker: if a new `/:param` route is added to App.tsx, the build fails and the developer must choose between nesting it under a static prefix or using the tenant portal's own resolution. This is the intended behavior but should be explicit.

F3 [minor] The plan says AlkalmaPortal.tsx is "deleted in the same PR" as the TenantPortal (PR3), and `/alkalma` becomes `<TenantPortal slug="alkalma"/>`. But it also says `/alkalma/confirmed` keeps `AlkalmaConfirmed`. The existing `AlkalmaConfirmed` component likely imports from or references `AlkalmaPortal`. If so, deleting AlkalmaPortal without updating AlkalmaConfirmed would break the build.

Evidence: Plan Fix 7: "AlkalmaPortal.tsx is deleted in the same PR" and "/alkalma/confirmed keeps AlkalmaConfirmed".

Suggestion: Verify that `AlkalmaConfirmed` has no import from `AlkalmaPortal.tsx` before committing to deleting it in the same PR. If it does, either inline/extract the shared code or defer the deletion to a follow-up.

F4 [minor] The plan says `COMPILED_MAXINA_FALLBACK` is used "only when the RPC call errors (network/5xx), never for an unknown slug." But the `useTenantRegistry` hook returns this fallback on error, and `useTenant.tsx` is rewritten to use the registry. If the registry fetch fails on initial page load (before the localStorage snapshot exists -- e.g., first-ever visit with Supabase down), the fallback would make every tenant appear as Maxina until the RPC succeeds. This is acknowledged but worth noting that it is the SAME behavior as today, so it is not a regression. The plan correctly states this.

Evidence: Plan Fix 3 and Fix 4.

Suggestion: No change needed -- the plan correctly identifies this as matching today's behavior. Just confirm the golden test covers this path (it does per the plan).

F5 [minor] The seed migration (Fix 2) sets Maxina's `profile.landing.post_login_path` to `/onboarding/welcome` and Alkalma's to `/alkalma`. After the `useTenant` rewrite, `useSmartRouting`'s community branch will read `entry.landing.post_login_path` and pass it through `safeInternalPath`. The Alkalma value `/alkalma` would redirect a logged-in Alkalma community member to the TenantPortal page (which is the login/join page). This is the CURRENT behavior (line 174-175 of useSmartRouting navigates to `/alkalma`), so it is not a regression, but it means an authenticated Alkalma member landing on `/` gets sent to their own login portal. Is that intentional?

Evidence: Plan Fix 2 seeds `post_login_path: "/alkalma"`; `useSmartRouting.tsx:174-175` currently navigates to `/alkalma`.

Suggestion: If the TenantPortal for a signed-in member immediately does `setTenantBySlug` and redirects to `post_login_path` again, this would be a redirect loop. The plan says the signed-in member path does "setTenantBySlug(slug), then post_login_path" but that post_login_path IS `/alkalma` itself. Confirm TenantPortal detects the already-a-member state and does NOT redirect to `post_login_path` again, or change Alkalma's seeded `post_login_path` to something like `/home`.

F6 [blocker] The `TenantPortal` signed-in member flow says: `setTenantBySlug(slug)` (switch only), then redirect to `post_login_path`. But `post_login_path` for Alkalma is `/alkalma`, which IS the TenantPortal itself. If TenantPortal detects the user is already a member and auto-switches + redirects to `post_login_path`, the user would land back on `/alkalma`, which would detect they are a member again, switch again, redirect to `/alkalma`... infinite loop. The plan must specify how TenantPortal breaks this cycle.

Evidence: Plan Fix 2 seeds Alkalma `post_login_path: "/alkalma"`; Plan Fix 7 says signed-in member gets "setTenantBySlug(slug), then post_login_path". `/alkalma` is now TenantPortal.

Suggestion: Either (a) change Alkalma's seeded `post_login_path` to `/home` (breaking from today's behavior, which routes to the AlkalmaPortal -- a different component that does not redirect), or (b) have TenantPortal check if the user's active tenant already matches the slug and skip the switch+redirect, going directly to `/home` or a non-portal path. Option (b) is safer because it handles the general case for any tenant whose `post_login_path` might point back to its own portal. The plan's Fix 7 says "Signed-in member: setTenantBySlug(slug) (switch only), then post_login_path" -- add "unless post_login_path starts with `/${slug}`, in which case redirect to `/home`" or similar cycle-break logic.

F7 [minor] The plan says the registry functions use `LANGUAGE sql STABLE` with a "non-atomic body, so the row types are resolved at call time." This is a PostgreSQL implementation detail: `LANGUAGE sql` functions with no `RETURNS TABLE` are indeed non-atomic, but `RETURNS TABLE(...)` with explicitly named columns binds the column names at CREATE time. The plan describes `RETURNS TABLE(tenant_id uuid, slug text, name text, ...)` which IS explicit. The claim about "resolved at call time" applies to the internal SELECT, not the return type -- new columns added to `tenants`/`tenant_settings` would not automatically appear in the function output (the whitelist prevents that, which is good). The "non-atomic" note is somewhat misleading but not incorrect.

Evidence: Plan Fix 1 describes `RETURNS TABLE(...)` with explicit columns.

Suggestion: Clarify that "non-atomic" means the internal query adapts to schema changes (e.g., `is_platform` column appearing), not that the return type changes. This is already implicitly correct in the plan but the wording could confuse a reviewer.

## Questions for the planner

1. On F6: how does TenantPortal break the redirect cycle when a signed-in Alkalma member lands on `/alkalma` and `post_login_path` is `/alkalma`? Today AlkalmaPortal is a different component with its own login-focused layout that does not redirect members. Replacing it with TenantPortal, which DOES redirect members to `post_login_path`, creates a loop unless there is explicit cycle-breaking logic.

2. On F1: is the `to_jsonb(t)->>'is_platform'` approach intentional forward-compatibility with Lane A, or should the filter simply be omitted until Lane A ships? If Lane A ships first, the function would need to be re-created anyway to use `t.is_platform` directly (cheaper than `to_jsonb`).

3. The plan says `/maxina` stays pointing to MaxinaPortal (the existing 870-line component). Does this mean Maxina is permanently excluded from the generic TenantPortal, or is migrating `/maxina` to TenantPortal deferred to C2? If deferred, the two portals could drift.

## Verdict

NOT CONVERGED

F6 is a blocker: the redirect loop for Alkalma's signed-in member flow must be resolved before implementation. F1 is major and needs a clear answer on the `to_jsonb` / `is_platform` forward-compatibility strategy. The rest are minor or informational.
```

# Partner output — round 2 (verbatim)

The file does not exist yet (the round-1 output was returned inline but never written). Let me produce my round-2 output now.

Here is my round-2 assessment:

---

## Round 2

### Prior findings — status

- **F1 (major)** `to_jsonb`/`is_platform` forward-compat strategy --> **closed**. The planner accepted the concern and clarified the approach: the `to_jsonb` read is kept intentionally so C has no ordering dependency on A; Lane A defines `is_platform` as `boolean NOT NULL DEFAULT false` (cast cannot fail); whichever lane ships second rewrites to `t.is_platform` directly, tracked in MIGRATION-QUEUE.md. The plan body at Fix 1 (line 42-43) now documents this clearly. The harness test (e) asserts filtering, not just column pickup. Satisfactory.

- **F2 (major)** `/:tenantSlug` catch-all collision risk --> **closed**. The planner accepted and added explicit language at line 171: the reserved-slug test is a "build-time blocker for the new route" with a failure message telling developers to nest under a static prefix.

- **F3 (minor)** AlkalmaConfirmed import from AlkalmaPortal --> **closed**. Planner verified by grep: `AlkalmaConfirmed` does not import `AlkalmaPortal`.

- **F4 (minor)** Compiled fallback = today's behavior --> **acknowledged**. No change needed; golden test covers it.

- **F5 (minor)** Alkalma `post_login_path` pointing to own portal --> **closed** (subsumed by F6 fix).

- **F6 (blocker)** Redirect loop for signed-in Alkalma member --> **closed**. Two changes applied: (a) Alkalma's seeded `post_login_path` changed to `/home` (line 62), and (b) a general cycle guard in TenantPortal (line 101): if `post_login_path` is the portal itself or any `isTenantPortalPath`, redirect to `/home` instead. Unit-tested with a self-referencing config. Both changes are reflected in the plan body.

- **F7 (minor)** "Non-atomic" wording misleading --> **closed**. Wording clarified at line 42: "the INTERNAL query is planned at call time... The RETURN shape is fixed by the explicit `RETURNS TABLE(...)` column list."

- **Q3** Maxina migration to TenantPortal --> **acknowledged**. Deferred to C2 (line 224). Drift between MaxinaPortal and TenantPortal is accepted for that window, pinned by the golden test. Reasonable.

### New findings

No new blockers or majors. The revisions are clean and address every finding substantively. The cycle guard and `post_login_path` fix are the right shape. The `to_jsonb` sequencing with MIGRATION-QUEUE.md is a reasonable forward-compat strategy given the lane independence constraint.

## Verified premises
- (carried from round 1, no changes)

## Findings
(all prior findings closed or acknowledged; no new findings)

## Questions for the planner
(none)

## Verdict
CONVERGED

## Record
- Plan hash (sha256 of the text between the plan markers, as recorded at approval, computed before VTID substitution): `6c831475a7b64985aa2ebc0e4bc2fc0508b1942c995c2e7fcd56e2dce03fff75`
- Sparring record: `f313b43c-2a6a-434a-b250-cae562fda66a` (plan_sparring_sessions). Partner: plan-sparring-partner, 2 rounds. Verdict: **CONVERGED**.
- VTID-05151 allocated after approval. In this copy the `VTID-XXXXX` placeholders are replaced by VTID-05151.

Owner approval (Gate 1): "Yes" — 2026-10-13, Claude Code session; plan hash 6c831475a7b64985aa2ebc0e4bc2fc0508b1942c995c2e7fcd56e2dce03fff75 (computed before VTID substitution); sparring record f313b43c-2a6a-434a-b250-cae562fda66a.
