# Requirements — Native Wave 2: Wallet screen ports (native-wave2-wallet)

A Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021, §5 Wave 2 lane list "Wallet (iOS gates)"). Port
the wallet surfaces that the parity ledger assigns to the `wallet` lane to the native app (`apps/mobile/`) at 1:1
parity with today's **mobile web** wallet screens, built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit
(`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device needs the
isolated test environment G1 and is called out per task as `depends-on-owner`.

Measured against `exafyltd/vitana-v1` `origin/main`, parity ledger `apps/mobile/parity/ledger.json` version 2:
**14 rows carry `"lane": "wallet"`, every one `status: "not_started"`** (11 `screen`, 1 `overlay`, 2 `route`; 435
rows total). Counted with `node -e` over the committed ledger JSON read from `origin/main` (the `--report` command
needs `typescript`, which is not installed in this checkout). The three lanes below partition those 14 rows with
**disjoint `paths`**.

Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture, Wallet line — mirror
existing routes only), §4 (parity method), §6 (verification & safety), the N2 README web→native prop map
(`apps/mobile/README.md` "Web → native prop map"), and the Spotlight / design rules via tokens. **No new wallet
route** (NEVER rule 26; program §3 Wallet line), no `App.tsx` route, no `screens.json` / `exclusions.json` entry is
added by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity row — only
status flips on existing rows. The plan is a **1:1 parity port that preserves today's iOS-IAP gating behaviour per
surface** — the `isIAPRestricted` / `isIOSApp` gates are mirrored exactly, not changed (R3).

## R0 — Scope and the three lanes

0.1 The plan ports exactly the 14 web destinations the parity ledger lists under `"lane": "wallet"`, split into three
disjoint lanes by page-file cluster. No row is in two lanes; no row in scope is left without a lane; no lane claims a
row the ledger does not carry under `"lane": "wallet"`. Partition: **`wallet-home` 8 + `wallet-rewards` 4 +
`wallet-subscriptions` 2 = 14** (verified against the live ledger, §R0.2–R0.4).

0.2 Lane **`wallet-home`** — the wallet overview + popup overlay + balance surfaces (8 rows). Rows:
`WALLET.OVERVIEW /wallet`, `OVERLAY.WALLET_POPUP /wallet` (the `WalletPopup` global overlay),
`WALLET.ACTIONS /wallet?tab=actions`, `WALLET.ACTIVITY /wallet?tab=activity`, `WALLET.BALANCE /wallet/balance`,
`WALLET.BALANCE_MEMBERSHIP /wallet/balance?tab=membership`,
`WALLET.BALANCE_OPTIMIZATION /wallet/balance?tab=optimization`, `WALLET.BALANCE_TOKENS /wallet/balance?tab=tokens`.
Web sources: `src/pages/Wallet.tsx` (970 lines; route `src/App.tsx:1558-1562`, lazy import `:199`) and
`src/pages/wallet/Balance.tsx` (491 lines; route `src/App.tsx:1563-1567`, lazy import `:286`). This lane also **owns
the core extraction** of the one pure wallet helper (`src/lib/exchangeRates.ts`, 117 lines, IO-free; R4).

0.3 Lane **`wallet-rewards`** — rewards + voucher redemption (4 rows). Rows: `WALLET.REWARDS /wallet/rewards`,
`WALLET.REWARDS_EARN_MORE /wallet/rewards?tab=earn`, `WALLET.REWARDS_SHOP /wallet/rewards?tab=shop`, and the
exclusion route `/redeem`. Web sources: `src/pages/wallet/Rewards.tsx` (137 lines; route `src/App.tsx:1573-1577`,
lazy import `:288`) and `src/pages/RedeemVoucher.tsx` (206 lines; route `src/App.tsx:849`, lazy import `:89`).

0.4 Lane **`wallet-subscriptions`** — the subscriptions storefront (2 rows). Rows:
`WALLET.SUBSCRIPTIONS /wallet/subscriptions` and the exclusion route `/profile/subscriptions`. Web sources:
`src/pages/wallet/Subscriptions.tsx` (143 lines; route `src/App.tsx:1568-1572`, lazy import `:287`) and the
`/profile/subscriptions` router (`ProfileSubscriptionsRouter`, `src/App.tsx:1477-1482` + the function at `:730-733`),
which on mobile renders `src/pages/MobileSubscriptions.tsx` (105 lines; lazy import `:186`) and on desktop redirects
to `/wallet/subscriptions`. The native port mirrors the mobile branch (`MobileSubscriptions`) for
`/profile/subscriptions` — this is today's behaviour, not a change.

## R1 — 1:1 parity with the mobile web screen

1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).

1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web
component, no raw colour, every visual value from `@vitana/tokens`.

1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four
web defects the N2 README lists (slider range thumb, progress RTL fill, inert `shouldScaleBackground`, close-button
RTL side) are **not** reproduced — the native kit's corrected behaviour is used, and no web file is touched.

1.4 Business logic, query keys, hooks, types and currency/reward computations are reused from `@vitana/core`, never
re-implemented, when the module is pure (class-A). A web module a lane needs that is not yet re-exported is added to
`packages/core/manifest.json` with a re-export in the same lane PR and `node scripts/native/core-closure.mjs --write`
run (program §3; `apps/mobile/README.md` "Web code: `@vitana/core`"). A module that performs IO (class-B — e.g. it
imports `@/integrations/supabase/client` or `@/lib/community-gateway`, or reads browser globals) is **re-implemented
natively**, never extracted (R4). `@vitana/core` is the only web→native bridge; ESLint bans `@/` and relative paths
into the web `src/` from app code.

## R2 — i18n (11 locales) + RTL

2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n").

2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/<screen>.json`) then mirrored to the other ten; DE is du-form; pt is Brazilian você-form.

2.3 Each screen works in RTL (`ar`): `start`/`end`, never physical `left`/`right`; the shell root `direction` follows
the language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.

2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it; a lane that can reuse an existing key does so and adds none.

## R3 — iOS-IAP gating preserved 1:1 (no behaviour change)

3.1 The wallet is gated on iOS by `isIAPRestricted()` / `isIOSApp()` (`src/lib/appilix.ts:230-247`), referenced by
**21 files on `origin/main`** (the program's "~18 files" figure; verified list in `design.md` §4). `isIAPRestricted()`
returns `isIOSApp()` — the App Store Guideline 3.1.1 gate that hides digital purchases on iOS. The native port
**preserves each surface's gating exactly** — it is a parity port, not a gating change (program §3 Wallet; decision 5
"keep today's behaviour").

3.2 Per-surface gating carried today (verified on `origin/main`; the native twin mirrors each one-for-one, changing
nothing):
- `WALLET.OVERVIEW /wallet` (`src/pages/Wallet.tsx`) — **gated**: imports `isIAPRestricted`; hides add-funds / buy /
  withdraw / deposit primary actions and the quick-exchange widget on iOS (`{!isIAPRestricted() && …}`,
  `primaryAction={isIAPRestricted() ? undefined : …}`). Classification (decision 5): the credit / add-funds / deposit
  flows are **digital content → StoreKit IAP or hidden on iOS** (today: hidden). Membership is a real-world service
  (external payment allowed) but is reached through `/wallet/balance` (see below).
- `WALLET.BALANCE /wallet/balance` (`src/pages/wallet/Balance.tsx`) — **gated**: `if (isIAPRestricted()) return null`
  on the optimization/top-up affordance; `spotlightAction` varies on the gate. Classification: the top-up /
  optimization action is **digital content → hidden on iOS** today; the membership tab is a **physical/real-world
  service** (external payment allowed) and stays visible.
- `WALLET.REWARDS /wallet/rewards` (`src/pages/wallet/Rewards.tsx`) — **gated**: imports `isIAPRestricted`; the shop /
  earn-more purchase affordance is branched on iOS. Classification: the rewards **shop** purchase is **digital content
  → hidden on iOS** today; the "earn more" (non-purchase) tab is informational and stays visible.
- `WALLET.SUBSCRIPTIONS /wallet/subscriptions` (`src/pages/wallet/Subscriptions.tsx`) — **no `isIAPRestricted` import
  today**; it is the subscriptions overview. Classification: subscriptions are **digital content** on iOS → the
  StoreKit-IAP-or-hidden decision applies at store-submission time (decision 5, deferred to the owner), but the port
  **does not add a gate the web does not have** — it mirrors today's behaviour (no gate) and records the
  classification for the owner's decision-5 call.
- `/profile/subscriptions` → `MobileSubscriptions.tsx` (mobile) — **no `isIAPRestricted` import today**; same as above
  (digital content classification flagged, no gate added).
- `/redeem` (`src/pages/RedeemVoucher.tsx`) — **no `isIAPRestricted` import today**; voucher redemption is a
  code-claim, not a purchase (no money movement in-app). Classification: **not a purchase surface** — no IAP concern;
  stays ungated.

3.3 **Flagging is documentation only.** For each purchase surface the lane records (a) the gate it carries today and
(b) its decision-5 classification (physical/real-world service = external payment allowed; digital content = StoreKit
IAP or hidden on iOS). The port **does not change any gate** — it does not add, remove, widen or narrow
`isIAPRestricted` use. The final iOS payment decision (decision 5, whether StoreKit/Play Billing is introduced) is an
owner gate recorded in the lane log as `next_actor: owner`, not made here.

3.4 `isIAPRestricted` / `isIOSApp` live in `src/lib/appilix.ts`, which reads browser globals (`window`, `navigator`,
`window.appilix`) — a **class-B** module (R4). It is **not** extracted to `@vitana/core`; the native app has its own
platform-detection equivalent (the shell already distinguishes native iOS/Android), and each native wallet screen
applies the same gate decision through that native equivalent, preserving the per-surface behaviour of §3.2.

## R4 — Core extraction (class-A only)

4.1 Only pure IO-free (class-A) modules enter `@vitana/core`. A module that imports `@/integrations/supabase/client`
or `@/lib/community-gateway`, or reads browser globals, is class-B and is **re-implemented natively**, never
extracted. Verified on `origin/main`: the wallet **page** components (`Wallet.tsx`, `Balance.tsx`, `Rewards.tsx`,
`Subscriptions.tsx`, `RedeemVoucher.tsx`, `MobileSubscriptions.tsx`) are DOM-coupled screen components (class-B,
re-implemented natively); `src/lib/appilix.ts` is class-B (browser globals; §3.4). The one **class-A** wallet helper
is `src/lib/exchangeRates.ts` (117 lines, **no imports, no IO** — `convertFromUsd`, `getCurrencySymbol`,
currency-conversion math), consumed by `Wallet.tsx`.

4.2 The lane that adds the `@vitana/core` re-export (**`wallet-home`**, which consumes `exchangeRates`) MUST, in the
**same PR**, add the manifest line + the `packages/core/src/**` re-export, run `node scripts/native/core-closure.mjs
--write`, and commit the regenerated `packages/core/closure.generated.json` and
`scripts/native/mobile-ci-paths.generated.json`, so `--check` passes. The data hooks (`useWallet`,
`useWalletGateway`, `useRedeemVoucher`, …) runtime-import the Supabase client (class-B) and are **not** extracted —
the native screens re-implement their fetching through the native Supabase client + native auth context and consume
only the pure helper from core. `wallet-rewards` and `wallet-subscriptions` consume core but add no core entry.

## R5 — Parity ledger

5.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived fields),
and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in `apps/mobile/app/`, and
no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). The query-string variants
(`?tab=actions|activity`, `?tab=membership|optimization|tokens`, `?tab=earn|shop`) are the **same route file** reading
the search param; `parity-ledger.mjs` matches by exact `shapeOf()` (query dropped), so each tab row is satisfied by
its base route file and the lane flips every one of its rows (no row left `not_started` under a base route).

5.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The three lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.

## R6 — Verification and safety (never production)

6.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production
Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").

6.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and
Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` and `node scripts/native/core-closure.mjs --check` from the repo root.
No live call is made.

6.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen) is a **depends-on-owner (G1)** step: it needs the isolated test environment (and macOS minutes /
G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md` and the lane records G1 as a
blocker in its log; it does not block the build-time port landing.

6.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`. The iOS-gated surfaces are verified read-only against the device-class web branch —
no purchase is ever attempted.

6.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New rule).

## R7 — Done

7.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered; the per-surface iOS-IAP
gating matches the web 1:1.

7.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check`, `parity-ledger --check` and
`core-closure --check` green; NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane
scope PR-GATE checks green.

7.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record).

## Out of scope (named so a lane does not drift into them)

- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `ai`, `discover-commerce`,
  `inbox-chat-calls`, `profile-settings-support`, `role-modes`, `memory-diary`, etc.) — each is its own plan.
- **Any new wallet route** (NEVER rule 26; program §3 Wallet line) — the native app mirrors existing routes only.
- Changing any `isIAPRestricted` / `isIOSApp` gate behaviour; introducing StoreKit / Google Play Billing (decision 5
  is an owner call, flagged here, not made).
- The wallet popups / exchange widgets reached from these screens as sub-components are ported with their parent
  screen's parity work; no new purchase flow is added.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and a `@vitana/core` re-export line.
