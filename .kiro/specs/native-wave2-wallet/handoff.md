---
slug: native-wave2-wallet
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-22T13:00Z
sparring_record: .kiro/specs/native-wave2-wallet/sparring/verdict.md
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Wallet screen ports
A Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`, program
VTID-05021; Wave 2 lane list in §5, "Wallet (iOS gates)"). Ports the 14 web destinations the parity ledger assigns to
`"lane": "wallet"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell; fixture /
fake-gateway tests only, device-runtime parity deferred to G1 (`next_actor: owner`). It is a **parity port that
preserves today's iOS-IAP gating per surface** (`isIAPRestricted` / `isIOSApp`, `src/lib/appilix.ts`) — no gate is
added, removed, widened or narrowed; **no new wallet route** (NEVER rule 26; program §3 Wallet line). No web screen,
`App.tsx` route or registry/manifest change — only native route files and parity-row status flips.
Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd → reviewer_seat hotmail,
disjoint `paths`, no `vtid` yet — CI allocates on convergence). `spar_refs` points PLAN-SPAR at
`exafyltd/vitana-v1:main` so it can read the native app + the web wallet sources this plan's premises rest on.
## Log
### 2026-10-22T13:00Z · kiro-202610151913-51bd · created → drafted
Holder of the `native-wave2-wallet/_plan` claim (planner). Measured against `exafyltd/vitana-v1` `origin/main`:
`apps/mobile/parity/ledger.json` version 2 has **14 rows with `"lane": "wallet"`, every one `not_started`**
(11 screen, 1 overlay, 2 route; 435 rows total), counted with `node -e` over the committed ledger read from
`origin/main` (the `--report` CLI needs `typescript`, not installed here). The ledger lane is literally named
`wallet` (grepped the committed JSON — not `home-feed`, which was the model's lane). Verified all 6 web source pages
exist on `origin/main` with the line counts and `App.tsx` route lines cited in `plan.md`
(`Wallet.tsx` 970 `:1558-1562`, `wallet/Balance.tsx` 491 `:1563-1567`, `wallet/Rewards.tsx` 137 `:1573-1577`,
`wallet/Subscriptions.tsx` 143 `:1568-1572`, `RedeemVoucher.tsx` 206 `:849`, `MobileSubscriptions.tsx` 105 `:186` via
`ProfileSubscriptionsRouter` `:730-733`/`:1477-1482`). Verified the iOS-IAP gate: `isIAPRestricted`/`isIOSApp`
(`src/lib/appilix.ts:230-247`) referenced by 21 files, `Wallet.tsx`/`Balance.tsx`/`Rewards.tsx` gated,
`Subscriptions.tsx`/`MobileSubscriptions.tsx`/`RedeemVoucher.tsx` ungated today — recorded per surface in R3.2 and
preserved 1:1. Verified core-extraction classes: `exchangeRates.ts` (117 lines, no imports/IO) is class-A and the one
core re-export (owned by `wallet-home`); the data hooks and `appilix.ts` are class-B and re-implemented natively.
Wrote requirements, design, tasks, plan and 3 lane files; partitioned the 14 rows into `wallet-home` (8),
`wallet-rewards` (4), `wallet-subscriptions` (2) with disjoint native file subtrees and ledger-rows-by-row — 0
overlap, 0 orphan. No VTID allocated, no product code changed, `exafyltd/vitana-v1` read-only, no live system touched.
Next: PLAN-SPAR spars the `plan(native-wave2-wallet)` PR (it reads `exafyltd/vitana-v1:main` via `spar_refs`); this
session answers each round in `sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then
seat `exafyltd` claims the three lanes in parallel (no inter-lane deps). Reviewer seat `hotmail` reviews each lane.
Device-runtime parity (the last task in each lane) waits on the owner's G1 isolated test environment.
