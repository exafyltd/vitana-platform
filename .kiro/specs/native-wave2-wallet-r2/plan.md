# Plan — native-wave2-wallet-r2
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2 lane "Wallet (iOS gates)".

<!-- plan:begin -->
## Re-plan
Re-plan of native-wave2-wallet (PR #4332, converged) under a new slug; the old branch has commits without Collab trailers.
The content below is the converged plan of `native-wave2-wallet` unchanged except the slug. The old plan's VTIDs (VTID-05378, VTID-05379, VTID-05380) were written only on the old PR branch, never on `main`; they are to be retired (terminalized `cancelled` by the PM or the exceptions seat once these lanes have their own VTIDs); this plan does not touch the ledger.
Sparring history: https://github.com/exafyltd/vitana-platform/pull/4332 (rounds under `.kiro/specs/native-wave2-wallet/sparring/` on the old branch; not copied here). PLAN-SPAR spars this slug as a fresh session.
## Goal
A Wave 2 screen-port batch of the native Maxina app: port the wallet cluster — the 14 web destinations the parity
ledger assigns to `"lane": "wallet"` — to the native app (`apps/mobile/`) at 1:1 parity with today's **mobile web**
wallet screens, built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with
fixture / fake-gateway unit tests. It is a **parity port that preserves today's iOS-IAP gating behaviour per surface**
(`isIAPRestricted` / `isIOSApp`, `src/lib/appilix.ts`) — no gate is added, removed, widened or narrowed. Does **not**
need G1 planned or built to land the ports; every device-runtime verification step is marked depends-on-owner (G1).
No redesign (program §4), **no new wallet route** (NEVER rule 26; program §3 Wallet line), no `App.tsx` route, no
registry/manifest change — only native route files and parity-row status flips.

## Measured state (`exafyltd/vitana-v1` `origin/main`, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **14 rows** carry `"lane": "wallet"`, **all `status: "not_started"`** (11 `screen`, 1 `overlay`, 2 `route`);
  **435 rows total**. Counted with `node -e` over the committed ledger read from `origin/main` (the `--report` CLI
  needs `typescript`, not installed in this checkout). The 14 rows and their web paths are listed in `requirements.md`
  R0.2–R0.4 and in each lane file.
- Web sources verified present on `origin/main` with line counts (approximate, for scoping; exact counts are not
  load-bearing) and `App.tsx` route lines: `src/pages/Wallet.tsx`
  (970; route `:1558-1562`, import `:199`), `src/pages/wallet/Balance.tsx` (491; route `:1563-1567`, import `:286`),
  `src/pages/wallet/Rewards.tsx` (137; route `:1573-1577`, import `:288`), `src/pages/wallet/Subscriptions.tsx` (143;
  route `:1568-1572`, import `:287`), `src/pages/RedeemVoucher.tsx` (206; route `:849`, import `:89`),
  `src/pages/MobileSubscriptions.tsx` (105; import `:186`, reached via `ProfileSubscriptionsRouter`
  `:730-733`/`:1477-1482`). The one pure (class-A) helper `src/lib/exchangeRates.ts` (**127 lines** on
  `origin/main` — corrected per sparring R1-F3; no imports, no IO)
  is confirmed IO-free and extractable; `src/lib/appilix.ts` (`isIAPRestricted`/`isIOSApp`, `:230-247`) is class-B
  (browser globals) and the IAP gate is referenced by **21 files** on `origin/main` (listed in `design.md` §4).
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Three disjoint lanes split by page-file cluster.** `wallet-home` (`Wallet.tsx` + `Balance.tsx` — the hub +
   balance, **8 rows**), `wallet-rewards` (`Rewards.tsx` + `RedeemVoucher.tsx` — rewards + redeem, **4 rows**),
   `wallet-subscriptions` (`Subscriptions.tsx` + `MobileSubscriptions.tsx` — subscriptions, **2 rows**). The three
   touch disjoint route files and component folders, build/review independently, each leaves the app buildable.
   8 + 4 + 2 = 14 — the exact `wallet`-lane row count (0 overlap, 0 orphan).
2. **No new wallet route (NEVER rule 26; program §3 Wallet line).** Every native route file maps to an existing
   `App.tsx` route verified on `origin/main` (`/wallet`, `/wallet/balance`, `/wallet/rewards`, `/wallet/subscriptions`,
   `/redeem`, `/profile/subscriptions`). A native Expo Router file is not an `App.tsx` route, so the "new page needs
   screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only parity-row **status** flips.
2a. **`/redeem` is public/unauthenticated on web and the native twin preserves that — it is placed OUTSIDE the
   authenticated `(app)` layout group (sparring R1-F1).** Verified on `origin/main`: `/redeem` sits under the
   "Public Routes - No Auth Required" block in `src/App.tsx` (line 849), with **no `AuthGuard`**, whereas every other
   wallet-lane route (`/wallet`, `/wallet/balance`, `/wallet/rewards`, `/wallet/subscriptions`) is wrapped in
   `AuthGuard`. The parity guarantee covers the auth boundary, not just IAP gates: to avoid silently narrowing access
   (requiring auth where web does not), the `wallet-rewards` lane places the native `RedeemVoucher` screen in the
   **public/unauthenticated** Expo Router group (the native equivalent of being outside `(app)` — e.g. the public
   `app/redeem.tsx` route segment, not under `app/(app)/`), so an unauthenticated member can reach it exactly as on
   web. No parity-ledger exception is needed because the boundary is preserved, not changed. The `wallet-rewards`
   lane file records this placement explicitly and a unit/routing test asserts the redeem screen renders without an
   authenticated session. (The other three wallet routes stay inside the authenticated group, matching their
   `AuthGuard` web wrappers.)
3. **iOS-IAP gating preserved 1:1 — a parity port, not a gating change (decision 5 / R3).** Each surface's current
   `isIAPRestricted()` branches are mirrored one-for-one; no gate is added, removed, widened or narrowed. Verified
   per surface on `origin/main`: `Wallet.tsx` **gated** (hides add-funds/buy/withdraw/deposit + quick-exchange on iOS),
   `Balance.tsx` **gated** (`if (isIAPRestricted()) return null` on the top-up affordance), `Rewards.tsx` **gated**
   (shop purchase branched), `Subscriptions.tsx` / `MobileSubscriptions.tsx` / `RedeemVoucher.tsx` **ungated today**
   (the port adds no gate). Per-surface decision-5 classification (physical/real-world service = external payment
   allowed; digital content = StoreKit IAP or hidden on iOS) is **recorded for the owner** in R3.2 — documentation
   only; the final iOS payment decision is an owner gate (`next_actor: owner`), not made here.
4. **Only the pure `exchangeRates` helper moves into `@vitana/core`; the data hooks and screens do NOT** (R4).
   `src/lib/exchangeRates.ts` is IO-free (class-A). The wallet data hooks (`useWallet`, `useWalletGateway`,
   `useRedeemVoucher`, …) runtime-import `@/integrations/supabase/client` (class-B) and would fail
   `core-closure --check`, so they are **re-implemented natively** (native Supabase client + native auth context).
   `src/lib/appilix.ts` is class-B (browser globals) and is **not** extracted — the native app has its own platform
   detection, and each native screen applies the same per-surface gate decision through it. **The core-extraction work
   is owned by the `wallet-home` lane**, which consumes `exchangeRates`: its PR adds `packages/core/src/exchangeRates.ts`
   (the re-export) + the `packages/core/manifest.json` line, and **in the same PR** runs
   `node scripts/native/core-closure.mjs --write` and commits the regenerated `packages/core/closure.generated.json`
   and `scripts/native/mobile-ci-paths.generated.json`, so `--check` passes. `wallet-rewards` and
   `wallet-subscriptions` consume core but add no core entry.
5. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; only parity-row
   **status** flips (`not_started`→`in_progress`→`native`). The lane adds nothing in `src/navigation/registry/`.
6. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and `staging-tests.json`. Matches the program's "fixture / fake-gateway tests only until G1" model.
7. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its source
   (program §1 shell), composed through N3/N2, every visual value from `@vitana/tokens`; the four N2-documented web
   defects are not reproduced and no web file is touched beyond a DE-first i18n key and a `@vitana/core` re-export line.
   For `/profile/subscriptions` the mobile branch is the `MobileSubscriptions` storefront (today's behaviour).

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence — none allocated yet)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `wallet-home` | exafyltd → hotmail | `/wallet` (OVERVIEW + WALLET_POPUP overlay + `?tab=actions\|activity`), `/wallet/balance` (+ `?tab=membership\|optimization\|tokens`) — **8 rows**; **owns the core extraction** of `exchangeRates` | — |
| `wallet-rewards` | exafyltd → hotmail | `/wallet/rewards` (+ `?tab=earn\|shop`), `/redeem` — **4 rows** | — |
| `wallet-subscriptions` | exafyltd → hotmail | `/wallet/subscriptions`, `/profile/subscriptions` (mobile = `MobileSubscriptions` storefront) — **2 rows** | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 14 parity rows partition **8 (wallet-home) + 4 (wallet-rewards)
+ 2 (wallet-subscriptions)** with 0 overlap and 0 orphan. The query-string variants are the same route file read by
the search param (exact `shapeOf` match, query dropped — `parity-ledger.mjs:60`), and each lane flips **every** one of
its rows to `native`, not only the base rows. All three lanes have no inter-lane dependency (disjoint page files and
a single core-extraction owner) and run in parallel.

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; **the `isIAPRestricted` gate tested both ways on wallet-home —
  iOS-gated fixture hides add-funds/buy/withdraw + quick-exchange, non-iOS shows them**; rewards earn/shop + shop gate;
  redeem code valid/invalid/claimed (**rendered without an authenticated session**, decision 2a); subscriptions
  overview + mobile router; **`exchangeRates` pure-module tests — because `getCurrentExchangeRates()` sets
  `lastUpdated: new Date()` on every call (two call sites, `src/lib/exchangeRates.ts:27` onward), the tests assert the
  deterministic fields (`from`/`to`/`rate`/`trend`/`change24h`) exactly and assert `lastUpdated` with
  `expect.any(Date)` (not deep-equality / snapshot), so they are not stale on the next millisecond** (sparring R1-F4);
  i18n no-raw-text + RTL start/end; React 19 `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction deliverable (R4): run `--write` AND commit the generated files, not just `--check`.** The
  `wallet-home` PR that adds the `exchangeRates` re-export to `packages/core/src/` MUST also run
  `node scripts/native/core-closure.mjs --write` and commit the regenerated `packages/core/closure.generated.json`
  and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then `node scripts/native/core-closure.mjs
  --check` passes. Without the `--write`+commit, `--check` fails in NATIVE-CI with "stale generated file" regardless
  of whether the module is class A. (Confirmed IO-free premise: `src/lib/exchangeRates.ts` on `origin/main` is **127
  lines** (R1-F3) with no imports and no IO, so the core copy is class A.) **`extract.json` is NOT a `--write` output
  (R1-F2):** `core-closure.mjs --write` writes only `closure.generated.json` and `mobile-ci-paths.generated.json`
  (verified at `core-closure.mjs:240`, which writes `r.outputs`, and its header comment); `packages/core/extract.json`
  is **read as input**, never mutated by `--write`, so the `wallet-home` commit checklist does **not** include it —
  reviewers should not flag its absence from the commit.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form; pt Brazilian você-form)
  then mirrored; RTL (`ar`) rendered per screen, start/end only.
- **iOS-IAP parity:** every `isIAPRestricted` branch mirrored one-for-one; no gate added/removed/widened/narrowed
  (R3). The per-surface decision-5 classification is recorded, not acted on.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<lane>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen; listed
  in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`; **no purchase ever attempted**). STAGING-VERIFY is read-only by construction
  (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.

## Open owner / sparring items (not decided here)
- **Decision 5 (iOS payment classification):** the per-surface classifications in `requirements.md` R3.2 are recorded
  for the owner; whether StoreKit / Google Play Billing is introduced for any digital-content surface is an owner
  call, not made here. Until decided the port keeps today's behaviour (the existing `isIAPRestricted` gates).
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred tasks
  stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
<!-- plan:end -->

<!-- re-trigger after PLAN-SPAR repair; 2026-10-28T09:53:01.1255134+01:00 -->
