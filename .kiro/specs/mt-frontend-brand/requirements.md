# Requirements — mt-frontend-brand (WS7 rest)

Program: `docs/MULTI-TENANT-PLAN.md` (v5.1, §6 WS7). This spec links the program's records
instead of copying them. It is the WS7 "rest" slice after Lane C (VTID-05151) shipped the
DB-driven registry, generic `/:slug` portal and DB-driven `useTenant`.

## Program position
- **Predecessors (done, in production):** VTID-05149 (`tenants.is_default`/`is_platform`,
  `TenantContext`), VTID-05150 (brand pack columns, `provision_tenant()`, assets), VTID-05151
  (public registry RPCs, DB-driven `useTenant`, `/:slug` portal). Records:
  `docs/validation/VTID-0514{9}/**`, `docs/validation/VTID-0515{0,1}/**`,
  `docs/multitenancy/LANE-C.md`, `docs/multitenancy/MIGRATION-QUEUE.md`.
- **Successors:** mt-packs (WS5 assistant/content persona), mt-jobs (WS6 tenant loops),
  mt-native-health (WS9 native brand), mt-m3 (custom domains/offboarding).

## Requirements (EARS)

### R1 — Tenant theme actually renders (lane `theme-tokens`)
1. WHERE a tenant defines brand colours THE SYSTEM SHALL render them: the `--brand-*` custom
   properties set by `useTenant` (`src/hooks/useTenant.tsx:124-133`) SHALL drive the Tailwind
   HSL tokens consumed by components.
2. WHEN no tenant override is present THE SYSTEM SHALL render Maxina's exact compiled values
   (fallback == compiled), so the Maxina build is byte-identical (C2 golden pins this).

### R2 — Member-facing brand constants are tenant-driven (lane `brand-surface`)
1. THE signup/commerce flow SHALL post the active tenant's slug, not a literal `maxina`
   (`CommerceJoin.tsx`), and the OAuth redirect base SHALL derive from the active tenant
   (`AuthGuard.tsx:271`).
2. Redeem/voucher navigation (`RedeemVoucher.tsx`, `RedemptionLanding.tsx`) and store links
   (`store-links.ts`) SHALL derive from the tenant, with Maxina's current values as fallback.
3. `document.title`, favicon and OG `<meta>` SHALL be set per tenant from the registry, Maxina
   as fallback. EVERY new user-visible string SHALL come from `src/i18n/{de,en}/**` (DE first,
   du-form); layout SHALL follow the Spotlight contract and RTL logical properties.

### R3 — adminFetch sends the tenant headers it documents (lane `adminfetch-header`)
1. `adminFetch` SHALL inject `X-Vitana-Tenant` and `X-Vitana-Active-Role` when a tenant/role
   is known, and its JSDoc SHALL match the code.

### R4 — Email & OG branding per tenant (lanes `email-brand-db`, `email-brand-code`)
1. THE v1 email edge functions SHALL resolve sender name, sender email, logo and brand name
   from a tenant-keyed DB helper (seeded with Maxina's current values), falling back to Maxina.
2. THE OG/share workers SHALL emit the resolved site name/title suffix per tenant.
3. Supabase Auth email templates and the Supabase redirect allowlist SHALL be changed by the
   owner from a committed runbook (not scripted — no live write by Kiro).

### R5 — CORS is config-driven (lane `cors-config`)
1. THE gateway CORS allowed-origin list SHALL be extensible by config without a code edit,
   keeping every current origin as the compiled default.

## Not in this slice
Registry/portal (VTID-05151); assistant/content persona (mt-packs); tenant job loops
(mt-jobs); native brand (mt-native-health/WS9); custom domains (M3). Supabase project
settings beyond the owner runbook. Creating a real tenant row (owner-approved, after Gate 2).
**The Command Hub tenant picker + de-maxina label UI** (`command-hub/app.js`): deferred to a
separate `DEV-COMHU-*` lane because `scripts/ci/command-hub-ownership-guard.js` reserves that
path for `DEV-COMHU-*`/allowlisted VTIDs, which a fresh PLAN-SPAR VTID is not; its data endpoint
`GET /api/v1/admin/tenants` already exists, so nothing in this slice depends on it.
