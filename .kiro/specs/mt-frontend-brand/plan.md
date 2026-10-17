---
change_class: standard
---
# plan(mt-frontend-brand): WS7 rest — per-tenant theme, brand surface, email, CORS & Command Hub

<!-- plan:begin -->
## Problem
Lane C (VTID-05151) delivered the DB-driven registry, generic `/:slug` portal and
DB-driven `useTenant`. WS7 "rest" (MULTI-TENANT-PLAN §6 WS7) is still Maxina-hardcoded.
Premises re-verified against current code (2026-10-15):

1. **Theme tokens are set but never consumed.** `vitana-v1/src/hooks/useTenant.tsx:124-133`
   sets `--brand-accent/-bg/-fg` on `documentElement`; its own comment says "nothing
   consumes them yet — C2", and `src/lib/tenant-registry.maxina-golden.test.tsx:172-183`
   asserts no `.tsx/.css` consumes `var(--brand-*)`. So brand colour never renders.
2. **adminFetch JSDoc lies.** `src/lib/admin-api.ts:5-7` claims it injects
   `X-Vitana-Tenant`/`X-Vitana-Active-Role`; the code (`admin-api.ts:33-41`) sends only
   `Content-Type` + `Authorization`. The gateway CORS already allows those headers
   (`services/gateway/src/middleware/cors.ts:71`), so adding them is safe.
3. **Hardcoded `maxina` slug in signup/commerce.** `src/pages/CommerceJoin.tsx:142,149,176`
   writes `tenant_slug: 'maxina'`; `src/components/AuthGuard.tsx:271` falls back to
   `.../' + (readStoredTenantSlug('tenant_slug') || 'maxina')` as the OAuth redirect base.
4. **Hardcoded brand in redeem/voucher/store surfaces.** `src/pages/RedeemVoucher.tsx`
   (lines 65-164) and `src/components/voucher/RedemptionLanding.tsx:44-51` navigate to
   `/maxina`; `src/lib/store-links.ts:6,31,49` hardcode the Apple app URL, the QR URL and
   the gotoapp fallback (the "Apple retry" fallbacks).
5. **Email sender/branding hardcoded.** v1 edge fns hardcode sender + brand:
   `supabase/functions/voucher-send-email/index.ts:265` (`maxina-logo.png`), `:344`
   (`sent via MAXINA`), `:359` (`noreply@vitanaland.com`); `send-appointment-email/index.ts:262`
   (`appointments@resend.dev`); `send-appointment-reminder`, `send-welcome-discount` similar.
6. **OG/share worker branding hardcoded.** `supabase/functions/og-share/index.ts:91,96,97`
   emit `… | VITANA`, `og:site_name "VITANA"`; `og-event`, `og-campaign`, `og-short` similar.
7. **CORS is a hardcoded array.** `services/gateway/src/middleware/cors.ts:7-40`
   (`ALLOWED_ORIGINS`) + patterns at `:46-51`; no tenant/config input. Supabase redirect
   allowlist is a Supabase-dashboard setting (owner-only), surfaced here as a runbook.
8. **Command Hub maxina-bound screens.** `services/gateway/src/frontend/command-hub/app.js`
   (≈29046-34750) hardcodes maxina in the AI-assistants / manuals / autopilot label area;
   no tenant picker. This path is reserved by `scripts/ci/command-hub-ownership-guard.js`
   (`PROTECTED_PATH`, L15; `ALLOWED_VTID_PATTERN`, L1051) for `DEV-COMHU-*`/allowlisted VTIDs,
   so a Kiro lane on a fresh PLAN-SPAR VTID cannot edit it — deferred (see Fix / Out of scope).

## Fix (per lane)
**Lane `theme-tokens` (kiro, exafyltd, vitana-v1)** — make `--brand-*` actually render.
Map the three brand custom properties into the existing Tailwind HSL tokens in
`src/index.css` `:root`/`.dark` ONLY (gen-tokens.mjs native-token generator reads only
`:root`/`.dark` custom-property declarations — do not add brand props elsewhere), so
`var(--brand-accent)` drives `--primary` etc. with the compiled Maxina value as the
fallback (`var(--brand-accent, <maxina hsl>)`). Update the C2 golden
(`tenant-registry.maxina-golden.test.tsx`) ON PURPOSE as a declared golden change: Maxina's
own tokens stay byte-identical because the fallback equals the compiled value. Run
`node scripts/native/gen-tokens.mjs` and commit regenerated `packages/tokens`/core if drift.
Dark-by-default exception: Maxina renders unchanged (fallback == compiled), so no flag.

**Lane `brand-surface` (kiro, exafyltd, vitana-v1)** — remove hardcoded Maxina constants on
member-facing surfaces, driven by `useTenant()`/registry slug: CommerceJoin signup slug,
AuthGuard OAuth redirect base, RedeemVoucher/RedemptionLanding navigate targets,
store-links (per-tenant store URLs from brand pack with the Maxina values as compiled
fallback). Logo/favicon/`<meta>`/OG tags per tenant via a `useTenantMeta()` effect driving
`document.title`, favicon href and OG meta from the registry (Maxina values as fallback).
No component sets `document.title` today (verified: zero `document.title` in `src/**/*.tsx`),
so `useTenantMeta()` is mounted by adding one hook call to the existing `AppHooksInitializer`
component in `src/App.tsx:469` (a hook-only child already inside `<BrowserRouter>` that runs
session-wide hooks like `useOrbFrontDoor`); the edit is import + one call, no new route and no
JSX element, so the "no nav-registry/screen-manifest/parity change" claim holds. `src/App.tsx`
is in this lane's paths for that one line.
i18n DE-first du-form for any new visible string; Spotlight tokens; RTL logical props.

**Lane `adminfetch-header` (kiro, exafyltd, vitana-v1)** — `admin-api.ts`: inject
`X-Vitana-Tenant` (active tenant id) + `X-Vitana-Active-Role` from `useTenant`/role source
when present, and fix the JSDoc to match. Small, isolated; a Vitest pins the headers.

**Lane `email-brand-db` (kiro, hotmail, vitana-v1)** — DB migration: add a brand-email
read helper/view the edge fns can select (sender name, sender email, logo url, brand name,
support email) keyed by tenant, seeded with Maxina's current values so behaviour is
byte-identical until a tenant overrides. Expand-only; rollback drops the helper. Adds the
MIGRATION-QUEUE row at the stated position. (Separate from the code lane per §4.7.)

**Lane `email-brand-code` (kiro, exafyltd, vitana-v1)** — the v1 edge fns
(`voucher-send-email`, `send-appointment-email`, `send-appointment-reminder`,
`send-welcome-discount`) resolve sender/logo/brand from the `email-brand-db` helper by the
row's tenant, Maxina values as fallback when a tenant has none. OG/share worker branding
(`og-share`, `og-event`, `og-campaign`, `og-short`) read site name/title suffix from the
same helper. Supabase Auth email template per-tenant + the Supabase redirect allowlist are
owner-only dashboard steps — documented in the lane's `docs/validation/<vtid>/` runbook,
not scripted (Kiro never writes to a live system). depends_on: `email-brand-db`.

**Lane `cors-config` (kiro, jtadic, gateway)** — `services/gateway/src/middleware/cors.ts`:
read the allowed-origin list from config/env (keep the current array as the compiled
default so nothing is removed) so a new tenant's custom origin can be added without a code
edit. Hot file; ≤20-line change in its own PR. Not a governance path (`services/gateway/src/**`),
so executor kiro seat `jtadic` (uncovered-platform gateway rule); reviewer a different seat.

The Command Hub tenant picker + de-maxina label work (Problem 8) is **out of scope here and
deferred to a separate DEV-COMHU lane** (see Out of scope): `services/gateway/src/frontend/
command-hub/**` is reserved by `scripts/ci/command-hub-ownership-guard.js` (VTID-0302) for
`DEV-COMHU-*` or allowlisted VTIDs, which a fresh PLAN-SPAR VTID is not — the guard would exit 1.
The data such a picker needs already exists (`GET /api/v1/admin/tenants`, `admin-tenants.ts:76`),
so no other lane in this spec is blocked by the deferral.

## Migrations
`email-brand-db`: one file in this spec's range `20261101090000` (next free in the
`20261101NN….` block; executor renumbers if a later migration exists at build time),
rollback `docs/validation/<vtid>/rollback.sql` (DROP the helper/view). Expand-only, no
NOT NULL, no lock-heavy op; `SET lock_timeout` guard. MIGRATION-QUEUE position: after all
applied M0 rows (last is `20261014000700`), as the first `20261101…` entry. Read-only
pre-check: helper absent; post-check: `SELECT` returns Maxina's seeded row. No other lane
has a migration.

## Tests
- `theme-tokens`: Vitest — `var(--brand-accent)` resolves to the Maxina compiled value with
  no tenant override (golden unchanged), and to the tenant value when set; updated C2 golden
  green; `node scripts/native/gen-tokens.mjs` reports no uncommitted drift; full `npm test`
  (nav registry/design manifest unaffected); ESLint design/i18n clean on new files.
- `brand-surface`: Vitest — signup posts the active tenant slug (not literal `maxina`);
  redirect/navigate targets derive from the slug; `useTenantMeta` sets title/favicon/OG
  from registry with Maxina fallback; store-links fall back to Maxina values when unset.
- `adminfetch-header`: Vitest pins the two headers present with a tenant/role, absent
  without.
- `email-brand-db`: pgTAP/SQL — helper returns the seeded Maxina row; expand-only.
- `email-brand-code`: Vitest/Deno — each edge fn selects sender/logo/brand by tenant and
  falls back to Maxina; OG worker emits the resolved site name.
- `cors-config`: Jest — the default list still allows every current origin; a configured
  extra origin is allowed; an unknown one is blocked (rule-48 posture, no live call).

## Staging verification
Read-only (rule 48). `theme-tokens`/`brand-surface`/`adminfetch-header`: a Playwright
staging spec signs in as the test user, loads a tenant portal, asserts the rendered
`--primary`/title/favicon match the tenant (reads only, network guard aborts non-GET).
`email-brand-code`/`og`: assert the OG worker response for an existing share renders the
resolved site name (GET only). No email is sent from any suite. `cors-config`: a GET
preflight assertion against staging only.

## Rollout
Dark-by-default via `tenant_settings.feature_flags.mt.*` / `MT_RESOLUTION_V2` for every
code lane EXCEPT `theme-tokens` and `brand-surface`, whose named exception is that Maxina's
values are the compiled fallback, so the live Maxina build is byte-identical with no flag —
tenant values only render for a non-Maxina tenant, which cannot exist in production until an
owner-approved provisioning step. `email-brand-db` applied by Claude via RUN-MIGRATION after
merge, post-check before the code lane deploys. Supabase Auth templates + redirect allowlist:
owner-only Supabase-dashboard steps from the runbook. Command Hub/CORS behind the same flag
default where a behaviour could change.

## Risks
- Theme consumption changing Maxina's look. Mitigation: fallback == compiled value; golden
  pins byte-identity; gen-tokens drift check.
- Edge-fn sender change bouncing email. Mitigation: DB helper seeded with the exact current
  sender; code falls back to it; no live send in any test.
- `app.js`/`cors.ts` hot files. Mitigation: ≤20-line PRs, rebased before merge, own lane.

## Out of scope
Registry/portal (done, VTID-05151); the assistant/content persona split (mt-packs, WS5);
jobs looping tenants (mt-jobs, WS6); per-tenant money/custom domains (M3); native brand
(WS9/mt-native-health). Supabase project settings beyond documenting the owner runbook.
**The Command Hub tenant picker + de-maxina label UI** (`command-hub/app.js`): deferred to a
separate `DEV-COMHU-*` lane because `scripts/ci/command-hub-ownership-guard.js` reserves that
path for `DEV-COMHU-*`/allowlisted VTIDs; its data endpoint `GET /api/v1/admin/tenants` already
exists, so nothing here depends on it.

## Depends on
- Done: VTID-05151 (registry/portal/`useTenant`), VTID-05150 (brand pack columns), VTID-05149
  (`tenants.is_default`/`TenantContext`).
- Within spec: `email-brand-code` depends on `email-brand-db`.

## Owner decisions
No new owner decision. Cite D13 (no synthetic tenant in prod — so tenant values are inert in
prod), §4.7 DB-slice split, and the stated dark-by-default exception for `theme-tokens`/
`brand-surface` (Maxina byte-identical via fallback), carried over from the Lane-C precedent.
<!-- plan:end -->

## Open questions for sparring
- `cors-config` touches `services/gateway/src/**`, a platform area the area map does not assign
  to a frontend seat. Proposal: executor kiro seat `jtadic` (uncovered-platform gateway rule),
  reviewer a different seat; NOT a governance path, so not Claude-held.
- Per-tenant store links (`store-links.ts`) assume the brand pack carries store URLs; if it
  does not yet, that lane ships only the Maxina fallback and defers the per-tenant field to
  mt-native-health (WS9). Default: ship fallback-only, note the dependency.
