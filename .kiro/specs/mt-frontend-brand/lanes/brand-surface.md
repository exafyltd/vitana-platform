---
lane: brand-surface
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
paths:
  - src/pages/CommerceJoin.tsx
  - src/components/AuthGuard.tsx
  - src/pages/RedeemVoucher.tsx
  - src/components/voucher/RedemptionLanding.tsx
  - src/lib/store-links.ts
  - src/lib/store-links.test.ts
  - src/hooks/useTenantMeta.ts
  - src/hooks/useTenantMeta.test.ts
  - src/App.tsx
  - src/i18n/de/tenantBrand.json
  - src/i18n/en/tenantBrand.json
  - docs/SCREEN_INVENTORY.md
updated: 2026-10-19T20:32Z
vtid: VTID-05242
---
# brand-surface — member-facing brand constants tenant-driven (repo vitana-v1)

Plan: `.kiro/specs/mt-frontend-brand/plan.md` and the `brand-surface` section of `tasks.md`
(B1–B7, allowed paths, acceptance). Design + successor rules: `design.md`.

**Held until PLAN-SPAR allocates this lane's VTID** (`next_actor: owner`); PLAN-SPAR flips it to
`kiro`. Do not build before then.

Executor rules (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of
`handoff.md` or another lane, no merge/approve/deploy/dispatch, no Supabase/AWS writes. Work
only in the allowed paths. New visible strings DE-first du-form (`i18n/de/tenantBrand.json`
first, mirror to `en/`), no raw JSX text, Spotlight tokens, logical start/end, RTL. The only
edit to `src/App.tsx` is adding one `useTenantMeta()` call to `AppHooksInitializer` (:469) —
import + one call, no new route or JSX element → no nav-registry/screen-manifest/parity change.
`useTenantMeta()` sets `document.title` and favicon href ONLY — it does NOT mutate OG/`<meta>`
tags (round-1 R1-F4: share-card crawlers do not run JS; per-tenant share cards are owned by the
server-side OG worker lane `email-brand-code`). The lane adds its own
`docs/validation/<vtid>/`. Branch `kiro/mt-frontend-brand/brand-surface`; PR title
`VTID-xxxxx (mt-frontend-brand/brand-surface): …`; trailers `Collab-Session`/`Collab-Lane`.
On PR open: `state: in-review`, `next_actor: kiro`, `pr: <url>`, log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created and held. Premises: hardcoded `maxina` in `CommerceJoin.tsx:142,149,176`,
`AuthGuard.tsx:271`, `RedeemVoucher.tsx:65-164`, `RedemptionLanding.tsx:44-51`; store constants
`store-links.ts:6,31,49`. Open question (plan.md): store-links per-tenant field may defer to
mt-native-health; default is Maxina-fallback-only. Reviewer seat `jtadic` (≠ `exafyltd`).

### 2026-10-16T09:30Z · kiro-hotmail-202610151618-b437 · internal review fix (still ready)
INTERNAL-REVIEW Finding 2 (MEDIUM): `useTenantMeta` had no mount file in `paths`, and no
component sets `document.title` today (zero in `src/**/*.tsx`). Added `src/App.tsx` to `paths`
and named the exact mount — one `useTenantMeta()` call in the existing `AppHooksInitializer`
(`src/App.tsx:469`), import + one call, no new route/JSX, so the no-parity-change claim holds.
plan.md, tasks.md B5/B7 and these paths now name the same mount. State unchanged (`ready`).

### 2026-10-16T17:20Z · kiro-hotmail-202610151618-b437 · sparring round-1 fix (still ready)
Round-1 R1-F4 (minor, accepted): `useTenantMeta()` must NOT mutate OG/`<meta>` tags — JS-set
OG tags are invisible to Facebook/Slack/X/WhatsApp/iMessage crawlers (no JS), and the gateway
already serves share cards server-side (`services/gateway/src/index.ts:193-194`
`publicProfileOgRouter`). Scoped `useTenantMeta()` to `document.title` + favicon href only;
all per-tenant share-card branding stays with the server-side OG worker lane `email-brand-code`.
Verified premises re-hold on the current vitana-v1 checkout (R1-F1): `useTenant.tsx:122-133`,
`CommerceJoin.tsx:142,149,176`, `AuthGuard.tsx:267,271`, `RedeemVoucher.tsx:65,108,135,161`,
`RedemptionLanding.tsx:47,51`, `App.tsx:469/772`. plan.md Fix + tasks.md B5/B7 updated to match.
State unchanged (`ready`).

### 2026-10-19T20:32Z · ci-plan-spar · ready (VTID allocated)
VTID-05242 allocated after policy approval (converged-auto-v1).
