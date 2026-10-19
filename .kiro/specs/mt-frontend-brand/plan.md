---
change_class: standard
---
# plan(mt-frontend-brand): WS7 rest — per-tenant theme, brand surface, email, CORS & Command Hub

<!-- plan:begin -->
## Problem
Lane C (VTID-05151) delivered the DB-driven registry, generic `/:slug` portal and
DB-driven `useTenant`. WS7 "rest" (MULTI-TENANT-PLAN §6 WS7) is still Maxina-hardcoded.
Premises re-verified against current code. vitana-v1 premises are pinned to vitana-v1
`origin/main` @ `32a82e6b` (the review session cannot read v1 — R1-F2); the two
security-relevant ones are quoted with platform citations in item 2 and are re-checked by
each lane's executor at build time (a mismatch stops the lane, `next_actor: claude`).

1. **Theme tokens are set but never consumed.** `vitana-v1/src/hooks/useTenant.tsx:122-133`
   sets `--brand-accent/-bg/-fg` on `documentElement`; its own comment says "nothing
   consumes them yet — C2", and `src/lib/tenant-registry.maxina-golden.test.tsx:172-183`
   asserts no `.tsx/.css` consumes `var(--brand-*)`. So brand colour never renders.
2. **adminFetch JSDoc lies.** `src/lib/admin-api.ts:7` claims "Injects X-Vitana-Tenant and
   X-Vitana-Active-Role context headers"; the `fetch` at `admin-api.ts:35-42` sets only
   `"Content-Type"`, `Authorization: Bearer …` and `...init.headers`. The gateway CORS already
   allows those headers (`services/gateway/src/middleware/cors.ts:67`), so adding them is safe.
   No route `adminFetch` calls reads them: the only gateway readers are
   `routes/autopilot-recommendations.ts:406,430,1799,2336` (mounted `/api/v1/autopilot/recommendations`,
   `index.ts:905`), `routes/calendar.ts:186,1054` and `routes/memory-garden.ts:48`. adminFetch's
   path prefixes (v1 `git grep adminFetch(`) are `/admin/*`, `/api/v1/{admin,community,conversation,
   partner-health,patient,vcaop,voice-lab}/*`; its autopilot calls (`useAdminAutopilot.ts:143-322`)
   hit `/api/v1/admin/autopilot` = `routes/admin-autopilot.ts` (`index.ts:555,1489`), which reads
   neither header. No calendar/memory-garden adminFetch call exists.
3. **Hardcoded `maxina` slug in signup/commerce.** `src/pages/CommerceJoin.tsx:142,149,176`
   writes `tenant_slug: 'maxina'`; `src/components/AuthGuard.tsx:267,271` falls back to
   `.../' + (readStoredTenantSlug('tenant_slug') || 'maxina')` as the OAuth redirect base.
4. **Hardcoded brand in redeem/voucher/store surfaces.** `src/pages/RedeemVoucher.tsx`
   (navigate('/maxina') at :65,108,135,161) and `src/components/voucher/RedemptionLanding.tsx:47,51`
   navigate to `/maxina` (and hardcode `/images/maxina-logo.png` at :61); `src/lib/store-links.ts:6,31,49`
   hardcode the Apple app URL, the QR URL and the gotoapp fallback (the "Apple retry" fallbacks).
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
`node scripts/native/gen-tokens.mjs` (verified present) and commit regenerated
`packages/tokens`/core if drift. Dark-by-default exception: Maxina renders unchanged
(fallback == compiled), so no flag.

**Lane `brand-surface` (kiro, exafyltd, vitana-v1)** — remove hardcoded Maxina constants on
member-facing surfaces, driven by `useTenant()`/registry slug: CommerceJoin signup slug,
AuthGuard OAuth redirect base, RedeemVoucher/RedemptionLanding navigate targets + logo,
store-links (per-tenant store URLs from brand pack with the Maxina values as compiled
fallback). Logo/favicon/`document.title` per tenant via a `useTenantMeta()` effect driving
`document.title` and favicon href from the registry (Maxina values as fallback). **No OG/`<meta>`
mutation in this hook** (round-1 R1-F4): share-card crawlers do not run JS, so client-side og:*
writes are ineffective; per-tenant share cards are owned entirely by the server-side OG worker
lane (`email-brand-code`), consistent with the gateway's own `publicProfileOgRouter`
(`services/gateway/src/index.ts:193-194`). No component sets `document.title` today (verified:
zero `document.title` in `src/**/*.tsx`), so `useTenantMeta()` is mounted by adding one hook
call to the existing `AppHooksInitializer` component (`src/App.tsx:469`, mounted inside
`<BrowserRouter>` at `src/App.tsx:772`) — import + one call, no new route and no JSX element,
so the "no nav-registry/screen-manifest/parity change" claim holds. `src/App.tsx` is in this
lane's paths for that one line. i18n DE-first du-form for any new visible string; Spotlight
tokens; RTL logical props.

**Lane `adminfetch-header` (kiro, exafyltd, vitana-v1) — preparatory plumbing (round-1 R1-F2).**
`admin-api.ts`: inject `X-Vitana-Tenant` (active tenant id) + `X-Vitana-Active-Role` from
`useTenant`/role source when present, and fix the JSDoc so it matches the code. **No gateway
route that `adminFetch` calls reads these headers yet** — the only current readers
(Problem 2) are not adminFetch targets, and `reminders.ts:58` records that header-based tenant resolution was removed there. So this
lane is explicitly preparatory: it fixes the lying JSDoc (member-neutral value today) and sends
the headers so a WS7 follow-on can add the gateway-side tenant-scoping reads. The Vitest proves
only that the client SENDS the headers (present with a tenant/role, absent without) — not that
any route acts on them. The gateway-side reads are a named WS7 follow-on VTID (Out of scope),
not part of this lane.

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
same helper — this lane owns ALL per-tenant share-card branding (R1-F4). Supabase Auth email
template per-tenant + the Supabase redirect allowlist are owner-only dashboard steps —
documented in the lane's `docs/validation/<vtid>/` runbook, not scripted (Kiro never writes to
a live system). depends_on: `email-brand-db`.

**Lane `cors-config` (kiro, jtadic, gateway)** — `services/gateway/src/middleware/cors.ts`:
a new tenant origin is added by env, not a code edit (R1-F1). Mechanism: the existing
gateway pattern for env origin lists (`services/outbound-http-worker.ts:151`, comma-split
`OUTBOUND_HTTP_ALLOWED_ORIGINS`), no new config module. A new `CORS_EXTRA_ORIGINS` is
parsed ONCE at module load into a module-scope array (trim, drop empties, keep only exact
`https://` origins with no path/wildcard), **appended** to `ALLOWED_ORIGINS` (`cors.ts:7-39`) —
augment, never replace; unset = today's list exactly. Takes effect on task restart/deploy (an
ECS env change redeploys), no hot reload. Untouched: `ALLOWED_ORIGIN_PATTERNS` (`:45-50`),
`isOriginAllowed` (`:52-55`, still checks list then patterns), `allowedHeaders` (`:67`), and the
narrow `applyDiscoveryCors` rules (`OPENAI_MCP_ORIGINS`/`MCP_CHATGPT_PATHS`/`WELL_KNOWN_PREFIX`,
`:87-121`) — an extra origin never widens `/mcp/chatgpt`. Hot file; ≤20-line change in its own PR. Not a governance path
(`services/gateway/src/**`), so executor kiro seat `jtadic` (uncovered-platform gateway rule);
reviewer a different seat.

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
  redirect/navigate targets derive from the slug; `useTenantMeta` sets title/favicon (NOT OG)
  from registry with Maxina fallback; store-links fall back to Maxina values when unset.
- `adminfetch-header`: Vitest pins the two headers present with a tenant/role, absent
  without (client-send only — the gateway-side read is the follow-on VTID).
- `email-brand-db`: pgTAP/SQL — helper returns the seeded Maxina row; expand-only.
- `email-brand-code`: Vitest/Deno — each edge fn selects sender/logo/brand by tenant and
  falls back to Maxina; OG worker emits the resolved site name.
- `cors-config`: Jest `services/gateway/test/middleware/cors.test.ts` (`jest.isolateModules`
  per env value) — unset env: every current origin + pattern still allowed;
  a configured extra origin is allowed; a malformed/wildcard entry is ignored; an unknown
  origin blocked; `/.well-known/*` and `/mcp/chatgpt` behave exactly as before (an extra origin
  is NOT reflected on `/mcp/chatgpt`). No live call.

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
- `adminfetch-header` shipping dead plumbing. Mitigation: lane is explicitly preparatory;
  its value today is the JSDoc fix; gateway-side reads tracked as a WS7 follow-on VTID.

## Out of scope
Registry/portal (done, VTID-05151); the assistant/content persona split (mt-packs, WS5);
jobs looping tenants (mt-jobs, WS6); per-tenant money/custom domains (M3); native brand
(WS9/mt-native-health). Supabase project settings beyond documenting the owner runbook.
**Gateway-side consumption of `X-Vitana-Tenant`/`X-Vitana-Active-Role`** on the admin/commerce
routes `adminFetch` calls — a named WS7 follow-on VTID (R1-F2); this spec only sends the headers.
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
