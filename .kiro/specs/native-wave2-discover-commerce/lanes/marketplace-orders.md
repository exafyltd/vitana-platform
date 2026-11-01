---
lane: marketplace-orders
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/discover/marketplace.tsx
  - apps/mobile/app/(app)/discover/doctors-coaches.tsx
  - apps/mobile/app/(app)/discover/provider/**
  - apps/mobile/app/(app)/discover/orders.tsx
  - apps/mobile/app/(app)/my-tickets.tsx
  - apps/mobile/src/screens/marketplace-orders/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/maestro/discover-commerce/**
  - apps/mobile/tests/discover-commerce/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/discoverCommerceNative.json
  - docs/validation/**
updated: 2026-10-21T12:00Z
vtid:
---
# Marketplace + orders port — commercial-intent marketplace, provider directory, orders / tickets views
Plan: `.kiro/specs/native-wave2-discover-commerce/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: marketplace-orders -->` (tasks 1–9) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do
not start before `vtid:` is set here. No deps — runs in parallel with `discover`. This lane owns the `MobileOrdersView`
native twin.
**Measured on the worktree (= origin/main of `exafyltd/vitana-v1`):** 9 ledger rows under
`"lane": "discover-commerce"` for this lane, all `not_started` — `DISCOVER.MARKETPLACE /discover/marketplace`,
`DISCOVER.MARKETPLACE_MINE /discover/marketplace?view=mine`,
`DISCOVER.MARKETPLACE_OPEN /discover/marketplace?view=open`, `DISCOVER.DOCTORS_COACHES /discover/doctors-coaches`,
`DISCOVER.PROVIDER_PROFILE /discover/provider/:id`, `DISCOVER.ORDERS /discover/orders`,
`DISCOVER.ORDERS_ACTIVE /discover/orders?tab=active`, `DISCOVER.ORDERS_HISTORY /discover/orders?tab=history`,
`DISCOVER.MY_TICKETS /my-tickets` (9 registry, 0 exclusion). Web sources `src/pages/discover/Marketplace.tsx` (intents
board — commercial_buy + commercial_sell + affiliate — with the mobile compact utility bar and the mine/open filters),
`src/pages/discover/DoctorsCoaches.tsx`, `src/pages/discover/ProviderProfile.tsx`, `src/pages/discover/Orders.tsx`
(`MobileOrdersView` branch; active/history tabs; unified tickets / CJ orders / vouchers), `src/pages/MyTickets.tsx`;
shared control `src/components/orders/MobileOrdersView.tsx` (this lane owns the twin); routes at
`src/App.tsx:1029-1113`. Fetching reused natively (class B, not moved into core): `getIntentBoard`, the provider
query, `supabase.from('cj_orders')`, `useMyTickets`, `useMyVouchers`.
**Goal.** Port the commercial-intent marketplace (board + `view=mine` / `view=open`), the doctors-&-coaches directory
and provider profile, and the orders / my-tickets views to native on the N3 shell at 1:1 mobile-web parity: the
intents board with the mobile compact utility bar, the gated provider list and detail, and the `MobileOrdersView` twin
(active/history tabs, unified tickets / CJ orders / vouchers — view/track only). **No add-to-cart / checkout control
anywhere in this lane, so no iOS-IAP-gate flag applies to any of its 9 rows.** Reuses the web member-listing / provider
queries unchanged so any test/service allowlist exclusion (program NEVER 45) is inherited, not re-implemented. Flips
the 9 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the nine destinations; mobile-web parity (`MobileOrdersView` branch; `/discover/orders`
  tabs); `@vitana/core`-only web bridge; member-listing / orders queries reused unchanged (inherit any allowlist
  exclusion, state it in the PR).
- `npm run typecheck`, `npm test` (marketplace board load / mine / open / empty / error; doctors list + provider
  profile open + back; orders active/history tab switch + empty + error; my-tickets list/detail),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from
  `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with the 9
  rows `native` and their routes present in `apps/mobile/app/`; if this lane extracts a class-A helper, the regenerated
  `closure.generated.json` + `mobile-ci-paths.generated.json` are committed in-PR (default: consume core, add nothing).
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Commerce UX contract:** PR "UX acceptance" section present; friction unchanged; no onboarding step added; no
  purchase surface in this lane. No class-B module moved into core.
- **Device-runtime parity (task 8)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 9 rows), `packages/core/manifest.json`
+ closure + `src/**` (only the re-exports this lane adds, if any) + `scripts/native/mobile-ci-paths.generated.json`,
`apps/mobile/src/ports/**`, `apps/mobile/src/navigation/resolve.ts`, and the DE-first i18n shard
`src/i18n/*/discoverCommerceNative.json` are shared by row/key with the other two lanes; resolve a merge conflict by
keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T12:00Z · kiro-planner · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 9 rows and the paths were computed from the parity
ledger and `src/App.tsx` so no file belongs to two lanes. No deps — runs in parallel with `discover`. Next: PLAN-SPAR
spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-discover-commerce/marketplace-orders --session <id>`).
