# Tasks — mt-frontend-brand (WS7 rest)

Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval (one per lane).

<!-- lane: theme-tokens -->
## theme-tokens — tenant theme actually renders (repo vitana-v1)

Allowed paths:
- `src/index.css`
- `src/hooks/useTenant.tsx`
- `src/lib/tenant-registry.maxina-golden.test.tsx`
- `src/lib/tenant-theme.ts`
- `src/lib/tenant-theme.test.ts`
- `packages/tokens/**`
- `packages/core/src/extracted/**`
- `docs/SCREEN_INVENTORY.md`

- [ ] T1 In `src/index.css` `:root`/`.dark` only, redefine the Tailwind HSL tokens components
      use (`--primary`, `--accent`, `--background`, `--foreground`) as
      `var(--brand-accent, <current maxina hsl>)` etc. so runtime brand props override and the
      compiled Maxina value is the fallback. No brand props outside `:root`/`.dark`.
- [ ] T2 If needed, a small `tenant-theme.ts` mapping brand hex → HSL for the props set in
      `useTenant.tsx`; keep `useTenant` setting only `:root` props.
- [ ] T3 Update the C2 golden `tenant-registry.maxina-golden.test.tsx` deliberately to assert
      `var(--brand-*)` is now consumed and Maxina renders byte-identically via the fallback.
- [ ] T4 `node scripts/native/gen-tokens.mjs`; commit any regenerated `packages/tokens`/core.
- [ ] T5 Vitest: brand override renders the tenant value; no override renders the Maxina value.
Acceptance: full `npx vitest run` green; C2 golden green; `gen-tokens.mjs` reports no
uncommitted drift; ESLint design/i18n clean on new files; Maxina look unchanged.

<!-- lane: brand-surface -->
## brand-surface — member-facing brand constants tenant-driven (repo vitana-v1)

Allowed paths:
- `src/pages/CommerceJoin.tsx`
- `src/components/AuthGuard.tsx`
- `src/pages/RedeemVoucher.tsx`
- `src/components/voucher/RedemptionLanding.tsx`
- `src/lib/store-links.ts`
- `src/lib/store-links.test.ts`
- `src/hooks/useTenantMeta.ts`
- `src/hooks/useTenantMeta.test.ts`
- `src/App.tsx`
- `src/i18n/de/tenantBrand.json`
- `src/i18n/en/tenantBrand.json`
- `docs/SCREEN_INVENTORY.md`

- [ ] B1 Replace the literal `maxina` slug in `CommerceJoin.tsx` (142/149/176) with the active
      slug from `useTenant`; keep Maxina as the default when the active tenant is Maxina.
- [ ] B2 `AuthGuard.tsx:267,271`: derive the OAuth redirect base from the active tenant slug,
      Maxina as fallback.
- [ ] B3 `RedeemVoucher.tsx` (:65,108,135,161) / `RedemptionLanding.tsx` (:47,51 + logo :61):
      navigate to / render the active tenant's portal path and logo, Maxina as fallback.
- [ ] B4 `store-links.ts`: read per-tenant store URLs from the brand pack when present, else
      the current Maxina constants (compiled fallback).
- [ ] B5 `useTenantMeta()` hook sets `document.title` and favicon href ONLY from the registry,
      Maxina fallback. It does NOT mutate OG/`<meta>` tags (round-1 R1-F4: JS-set OG is invisible
      to share-card crawlers; per-tenant share cards are owned by the server-side OG worker lane
      `email-brand-code`). Mount it by adding one `useTenantMeta()` call to the existing
      `AppHooksInitializer` in `src/App.tsx:469` (import + one call only; no new route, no JSX
      element — so no nav-registry/screen-manifest/parity change).
- [ ] B6 i18n `src/i18n/de/tenantBrand.json` first (du-form), mirror to `en/`; no raw JSX text;
      `npm run i18n:inventory`.
- [ ] B7 Vitest: signup posts the active slug; redirect/navigate derive from the slug;
      `useTenantMeta` sets title/favicon (NOT OG) with Maxina fallback; store-links fall back; a
      test asserts `AppHooksInitializer` calls `useTenantMeta` (the hook is actually mounted).
Acceptance: full `npx vitest run` green; ESLint i18n + design clean on new files; Spotlight
tokens + logical start/end; RTL verified; the `src/App.tsx` edit adds no route/JSX element,
only the `useTenantMeta()` call (no nav-registry/screen-manifest/parity change).

<!-- lane: adminfetch-header -->
## adminfetch-header — adminFetch sends documented tenant headers (repo vitana-v1)

Allowed paths:
- `src/lib/admin-api.ts`
- `src/lib/admin-api.test.ts`

Preparatory plumbing (round-1 R1-F2): this lane only makes the client SEND the headers and
fixes the JSDoc. No gateway route `adminFetch` calls reads them yet; the gateway-side
tenant-scoping reads are a named WS7 follow-on VTID (plan Out of scope).

- [ ] AF1 Inject `X-Vitana-Tenant` (active tenant id) and `X-Vitana-Active-Role` in
      `adminFetch` when known, from the tenant/role source callers already use; fix the JSDoc
      (`admin-api.ts:7`; the fetch at `:35-42`) so it matches the code. First re-check both
      premises at build time (plan Problem 2); a mismatch stops the lane. Gateway CORS already allows both headers
      (`services/gateway/src/middleware/cors.ts:67`).
- [ ] AF2 Vitest pins both headers present with a tenant/role, absent without, Authorization
      unchanged. The test proves client-send only — not that any gateway route consumes them.
Acceptance: full `npx vitest run` green; no behaviour change for calls without a tenant/role.

<!-- lane: email-brand-db -->
## email-brand-db — tenant-keyed email branding helper (repo vitana-v1, DB)

Allowed paths:
- `supabase/migrations/20261101090000_vtid_xxxxx_tenant_email_branding.sql`
- `docs/multitenancy/MIGRATION-QUEUE.md`

- [ ] ED1 Expand-only migration: a tenant-keyed read helper/view returning sender name, sender
      email, logo url, brand name, support email; seed Maxina's current literal values. Guard
      with `SET lock_timeout`; no NOT NULL, no backfill of hot tables.
- [ ] ED2 Add the MIGRATION-QUEUE row as the first `20261101…` entry (after `20261014000700`),
      with the rollback path `docs/validation/<vtid>/rollback.sql` (DROP the helper/view).
Acceptance: SQL/pgTAP: helper returns the seeded Maxina row; rollback drops it cleanly;
read-only pre-check (helper absent) and post-check (SELECT returns Maxina) written for Claude.
VTID allocated by PLAN-SPAR; renumber if a later migration exists at build time.

<!-- lane: email-brand-code -->
## email-brand-code — edge fns & OG workers read branding by tenant (repo vitana-v1)

Allowed paths:
- `supabase/functions/voucher-send-email/index.ts`
- `supabase/functions/send-appointment-email/index.ts`
- `supabase/functions/send-appointment-reminder/index.ts`
- `supabase/functions/send-welcome-discount/index.ts`
- `supabase/functions/og-share/index.ts`
- `supabase/functions/og-event/index.ts`
- `supabase/functions/og-campaign/index.ts`
- `supabase/functions/og-short/index.ts`
- `supabase/functions/_shared/tenant-brand.ts`
- `supabase/functions/_shared/tenant-brand.test.ts`

- [ ] EC1 `_shared/tenant-brand.ts`: resolve sender/logo/brand/site-name from the
      `email-brand-db` helper by a tenant id, Maxina values as fallback.
- [ ] EC2 Each email edge fn resolves sender/logo/brand from the row's tenant; OG workers emit
      the resolved site name/title suffix (this lane owns ALL per-tenant share-card branding,
      R1-F4). No literal `MAXINA`/`VITANA` left in the resolved path.
- [ ] EC3 Owner runbook `docs/validation/<vtid>/runbook-supabase.md`: the Supabase Auth email
      templates + redirect allowlist steps (owner-only; no script).
- [ ] EC4 Vitest/Deno: each fn selects by tenant and falls back to Maxina; OG site name
      resolves; no email is sent in any test.
Acceptance: tests green; no live send; depends on `email-brand-db` applied first.

<!-- lane: cors-config -->
## cors-config — config-driven CORS allowlist (repo vitana-platform)

Allowed paths:
- `services/gateway/src/middleware/cors.ts`
- `services/gateway/test/middleware/cors.test.ts`

- [ ] CC1 Parse `CORS_EXTRA_ORIGINS` (comma-split, same pattern as
      `services/outbound-http-worker.ts:151`) ONCE at module load; keep only exact `https://`
      origins (no path, no wildcard); APPEND to the compiled `ALLOWED_ORIGINS` (`cors.ts:7-39`) —
      never replace; unset = today's list. Restart/deploy to apply, no hot reload. Leave
      `ALLOWED_ORIGIN_PATTERNS` (`:45-50`), `isOriginAllowed` (`:52-55`), `allowedHeaders` (`:67`)
      and `applyDiscoveryCors` (`:87-121`, MCP/.well-known rules) unchanged. Hot file, own PR.
- [ ] CC2 Jest (`jest.isolateModules` per env value): unset env allows every current origin and
      pattern; a configured extra origin is allowed; malformed/wildcard entries ignored; an
      unknown origin blocked; `/.well-known/*` and `/mcp/chatgpt` unchanged (an extra origin is
      not reflected on `/mcp/chatgpt`).
Acceptance: `npm test` in the gateway green; no live call.

<!-- Command Hub tenant picker UI is deferred to a separate DEV-COMHU lane (see plan.md
     Out of scope): services/gateway/src/frontend/command-hub/** is reserved by
     scripts/ci/command-hub-ownership-guard.js for DEV-COMHU-*/allowlisted VTIDs, which a
     fresh PLAN-SPAR VTID is not. The data it needs (GET /api/v1/admin/tenants) already
     exists (admin-tenants.ts:76), so nothing in this spec is blocked. -->
