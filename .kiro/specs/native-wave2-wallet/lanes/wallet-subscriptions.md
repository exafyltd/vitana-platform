---
lane: wallet-subscriptions
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/wallet/subscriptions.tsx
  - apps/mobile/app/(app)/profile/subscriptions.tsx
  - apps/mobile/src/screens/wallet-subscriptions/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/wallet-subscriptions/**
  - apps/mobile/maestro/wallet-subscriptions/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/walletSubscriptionsNative.json
  - docs/validation/**
updated: 2026-10-22T13:00Z
---
# Subscriptions port — `/wallet/subscriptions` and `/profile/subscriptions` (mobile storefront)
Plan: `.kiro/specs/native-wave2-wallet/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: wallet-subscriptions -->` (tasks 1–7) are authoritative. VTID: assigned by CI after PLAN-SPAR converges;
do not start before `vtid:` is set here.
**Measured against `exafyltd/vitana-v1` `origin/main`:** 2 ledger rows under `"lane": "wallet"` for this lane, both
`not_started` — `WALLET.SUBSCRIPTIONS /wallet/subscriptions` and the exclusion route `/profile/subscriptions`. Web
sources `src/pages/wallet/Subscriptions.tsx` (143 lines; route `src/App.tsx:1568-1572`, lazy import `:287`);
`/profile/subscriptions` is `ProfileSubscriptionsRouter` (`src/App.tsx:730-733`, `:1477-1482`) → on mobile
`src/pages/MobileSubscriptions.tsx` (105 lines, lazy import `:186`), on desktop a redirect to
`/wallet/subscriptions`. Neither page imports `isIAPRestricted` today.
**Goal.** Port the subscriptions overview and the mobile `/profile/subscriptions` storefront to native on the N3
shell at 1:1 mobile-web parity. The native port mirrors the **mobile** branch (`MobileSubscriptions`) for
`/profile/subscriptions` — native is a mobile context, so the desktop redirect does not apply. **No
`isIAPRestricted` gate exists today → add none** (R3.2); subscriptions are flagged as digital content for the owner's
decision-5 call (documentation only; the port changes no behaviour). Flips both parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R7 for `/wallet/subscriptions` and `/profile/subscriptions`; mobile-web parity; `@vitana/core`-only
  web bridge; the mobile router resolves to the storefront; **no gate added (ungated as today)**.
- `npm run typecheck`, `npm test` (subscriptions overview loaded/empty/error; storefront renders; mobile router
  resolves `/profile/subscriptions` to the storefront, not the desktop redirect), `APP_PROFILE=development npm run
  bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19
  `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with both
  rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form; pt você-form) then mirrored; RTL (`ar`)
  covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 6)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 2 rows), `packages/core/manifest.json`
+ closure + `src/**` (this lane adds **no** core re-export — `wallet-home` owns the extraction; listed only so a
reused key resolves), and the DE-first i18n shard are shared by row/line; resolve a merge conflict by keeping both
lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile; no
new wallet route (NEVER rule 26); no `isIAPRestricted` gate behaviour change.
## Log
### 2026-10-22T13:00Z · kiro-202610151913-51bd · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 2 rows and the paths were computed from the parity
ledger on `origin/main` and `src/App.tsx` so no file belongs to two lanes; no inter-lane dependency. Adds no core
re-export (owned by `wallet-home`). Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd`
claims the lane (`queue.mjs claim native-wave2-wallet/wallet-subscriptions --session <id>`). Runs in parallel with
`wallet-home` and `wallet-rewards`.
