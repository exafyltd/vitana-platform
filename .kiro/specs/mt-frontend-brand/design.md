# Design — mt-frontend-brand (WS7 rest)

## What exists (read these, do not copy them)
- Program plan + decisions: `docs/MULTI-TENANT-PLAN.md` (§6 WS7, decision register).
- Migration order + lane ranges: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Registry contract: `docs/multitenancy/LANE-C.md`; records `docs/validation/VTID-0515{0,1}/**`.
- vitana-v1:
  - `src/hooks/useTenant.tsx:124-133` — sets `--brand-accent/-bg/-fg` on `documentElement`;
    comment "nothing consumes them yet — C2".
  - `src/lib/tenant-registry.maxina-golden.test.tsx:172-183` — golden asserting no file
    consumes `var(--brand-*)`; C2 updates this on purpose.
  - `src/lib/admin-api.ts:5-7` (wrong JSDoc), `:33-41` (sends only Content-Type + Authorization).
  - `src/pages/CommerceJoin.tsx:142,149,176` — hardcoded `tenant_slug: 'maxina'`.
  - `src/components/AuthGuard.tsx:271` — OAuth redirect base `… || 'maxina'`.
  - `src/pages/RedeemVoucher.tsx:65-164`, `src/components/voucher/RedemptionLanding.tsx:44-51`
    — `navigate('/maxina' …)`.
  - `src/lib/store-links.ts:6,31,49` — hardcoded Apple URL, QR URL, gotoapp fallback.
  - `supabase/functions/voucher-send-email/index.ts:265,344,359`,
    `send-appointment-email/index.ts:262`, `send-appointment-reminder`, `send-welcome-discount`
    — hardcoded sender/brand.
  - `supabase/functions/og-share/index.ts:91,96,97`, `og-event`, `og-campaign`, `og-short`
    — hardcoded `VITANA` site name/title.
- vitana-platform:
  - `services/gateway/src/middleware/cors.ts:7-51` — hardcoded `ALLOWED_ORIGINS` + patterns.
  - `services/gateway/src/frontend/command-hub/app.js` (≈29046-34750) — maxina-bound screens.
    This path is CI-reserved (`scripts/ci/command-hub-ownership-guard.js`, PROTECTED_PATH L15,
    ALLOWED_VTID_PATTERN L1051) for `DEV-COMHU-*`/allowlisted VTIDs, so the picker UI is not in
    this spec — deferred to a separate DEV-COMHU lane (see Design per lane / plan.md Out of scope).
  - `vitana-v1/src/App.tsx:469` — `AppHooksInitializer`, the hook-only child inside
    `<BrowserRouter>` where session-wide hooks run; the brand-surface `useTenantMeta()` mounts here.
- Native-token generator constraint: `scripts/native/gen-tokens.mjs` reads custom-property
  declarations only in `:root`/`.dark` of `src/index.css` — brand props MUST live there.

## Design per lane
- **theme-tokens:** in `src/index.css` `:root`/`.dark`, redefine the Tailwind HSL tokens that
  components already use (`--primary`, `--accent`, `--background`, `--foreground`) as
  `var(--brand-accent, <existing maxina hsl>)` etc. so the brand props (set at runtime by
  `useTenant`) override, and the compiled Maxina values remain the fallback. No new props
  outside `:root`/`.dark`. Regenerate native tokens; update the C2 golden deliberately.
- **brand-surface:** a `useTenantMeta()` hook (title/favicon/OG from `useTenant().tenant`,
  Maxina fallback), mounted by one call added to `AppHooksInitializer` in `src/App.tsx:469`
  (import + one call, no new route/JSX — no component sets `document.title` today, verified zero
  in `src/**/*.tsx`); replace literal `maxina` slug/paths with the active slug from `useTenant`;
  `store-links.ts` reads per-tenant URLs from the brand pack when present, else the current
  constants. New strings DE-first du-form; Spotlight tokens; logical start/end.
- **adminfetch-header:** add the two headers in `admin-api.ts` from the current tenant/role
  (importing the tenant/role source already used by callers); fix the JSDoc.
- **email-brand-db:** a tenant-keyed read helper/view (sender name, sender email, logo url,
  brand name, support email) seeded with Maxina's current literal values. Expand-only.
- **email-brand-code:** edge fns + OG workers select from the helper by the row's tenant,
  Maxina fallback. Owner runbook for Supabase Auth templates + redirect allowlist.
- **cors-config:** `cors.ts` merges an env/config list onto the compiled default array.
- **(deferred) Command Hub tenant picker:** a tenant picker + de-maxina label area in `app.js`
  is a separate `DEV-COMHU-*` lane (CI ownership guard reserves that path); its data endpoint
  `GET /api/v1/admin/tenants` already exists, so nothing in this spec depends on it.

## Rules every successor follows
1. **Migrations:** apply strictly in `MIGRATION-QUEUE.md` order, one RUN-MIGRATION dispatch
   per file, by Claude only, with read-only pre/post checks. New migrations take the next
   version in this spec's range `20261101090000`–`20261101095959` and add a queue row in the
   same PR; a not-yet-live table goes in `scripts/ci/migration-drift-baseline.json` and is
   removed after apply.
2. **Dark by default** (`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`) for every
   code change, EXCEPT `theme-tokens`/`brand-surface`, whose named exception is that Maxina's
   values are the compiled fallback so the live build is byte-identical and tenant values are
   inert in production (no non-Maxina tenant exists in prod — D13).
3. **VTID-05147 AC-5** unchanged: no later migration grants member writes on role tables.
4. **Lane C whitelist:** a new registry key = a new migration + a new harness case.
5. **D13** no synthetic tenant in production; the owner provisions a real tenant after Gate 2.
6. **Production is read-only** for every session and test (rules 31/31b/48); the executor
   never writes to Supabase/AWS (collaboration §7a). Email templates/redirect allowlist are
   owner-only Supabase-dashboard steps from the runbook.
7. Test/service accounts never member-visible (rules 43–45); i18n DE-first du-form; RTL via
   logical properties; Spotlight contract; WCAG 2.2 AA. `gen-tokens.mjs`: custom props only in
   `:root`/`.dark`.
