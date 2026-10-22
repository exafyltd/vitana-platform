---
lane: business-hub
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/business/**
  - apps/mobile/src/screens/business/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/business/**
  - apps/mobile/maestro/business/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/businessNative.json
  - docs/validation/**
updated: 2026-10-21T19:13Z
---
# Business hub port — `/business` shell (+ tabs) + opportunities + listings
Plan: `.kiro/specs/native-wave2-sharing-business/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: business-hub -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on `exafyltd/vitana-v1` `origin/main`:** 13 ledger rows under `"lane": "sharing-business"` for this lane,
all `not_started` — `BUSINESS.OVERVIEW /business`, `BUSINESS.SERVICES /business/services`,
`BUSINESS.CLIENTS /business/clients`, `BUSINESS.SELL_EARN /business/sell-earn`, `BUSINESS.ANALYTICS /business/analytics`,
`BUSINESS.SERVICES_EVENTS /business?tab=services.events`, `BUSINESS.SERVICES_PACKAGES /business?tab=services.packages`,
`BUSINESS.SALES_PROMOTIONS /business?tab=sales.promotions`, `BUSINESS.SALES_REFERRALS /business?tab=sales.referrals`,
`BUSINESS.INSIGHTS_EARNINGS /business?tab=insights.earnings`, `BUSINESS.INSIGHTS_GROWTH /business?tab=insights.growth`,
`BUSINESS.OPPORTUNITIES /business/opportunities`, `BUSINESS.LISTINGS /business/listings`. Web sources
`src/pages/BusinessHub.tsx` (689, a `/business` shell with nested index/`services`/`clients`/`sell-earn`/`analytics`
subroutes and `?tab=…` variants driven by `pathToMobileTab`/`useSearchParams` at `:11,67`; route `src/App.tsx:1295-1306`),
`src/pages/BusinessOpportunities.tsx` (138, route `src/App.tsx:1527-1531`), `src/pages/BusinessListings.tsx` (153,
route `src/App.tsx:1532-1536`); sub-tab components `src/components/business/**` (ServicesSubTabs, ClientsSubTabs,
SellAndEarnSubTabs, AnalyticsSubTabs), organizer / reseller tabs `src/components/reseller/**`
(ResellerAvailableEventsTab, ResellerCampaignsTab). The business data hooks (earnings, growth, clients, services,
reseller campaigns) are gateway/Supabase-coupled — **class B, re-implemented natively, not extracted.**
**Goal.** Port the business hub to native on the N3 shell at 1:1 mobile-web parity: one `(app)/business/index.tsx`
shell with the `MobileModePill` driving the `services`/`clients`/`sell-earn`/`analytics` tabs and the
`?tab=services.*|sales.*|insights.*` variants (mirroring `pathToMobileTab`), the four nested tab files, and the two
standalone pages (opportunities, listings). Composes the business sub-tab and reseller / organizer event-sales tabs —
business packages, operations panel, organizer event sales, reseller tabs, earnings. Class-B data hooks re-implemented
natively; pure helpers (`pathToMobileTab`, IO-free earnings/growth aggregation) consumed from `@vitana/core`. The
**Commerce UX contract** (`CLAUDE.md` VTID-05204) governs the onboarding surfaces: AI-led, one dominant action per
screen, plain business language, progressive disclosure — honoured by a 1:1 port that adds no field/step, so friction
is unchanged. Flips all 13 parity rows to `native`.
**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the business surfaces; mobile-web parity; `@vitana/core`-only web bridge (class-A only;
  class-B business data hooks re-implemented natively); Commerce UX contract honoured (1:1 port, no added friction).
- `npm run typecheck`, `npm test` (shell renders each tab + `?tab=` variant from fixtures; opportunities and listings
  load/empty/error; reseller tabs and earnings render), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (all from `apps/mobile/`); React 19 `ReactElement`.
- `node scripts/native/core-closure.mjs --check` and `node scripts/native/parity-ledger.mjs --check` green with all 13
  rows `native` (the `?tab=…` rows match the single `/business` route file by `shapeOf()`, each status flipped) and
  the routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored, `pt` Brazilian você-form;
  RTL (`ar`) covered (start/end only); no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`;
  the PR carries the Commerce UX "UX acceptance" section (friction unchanged, 1:1 port).
- **Device-runtime parity (task 7)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`.
**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 13 rows), `packages/core/manifest.json`
+ `closure.generated.json` + `src/**` (only the pure class-A re-exports this lane adds),
`scripts/native/mobile-ci-paths.generated.json`, `apps/mobile/src/ports/**`,
`apps/mobile/src/navigation/resolve.ts`, and the DE-first i18n shard are shared by row/line with `sharing`;
resolve a merge conflict by keeping both lanes' rows/keys.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only; the native app has no production profile.
## Log
### 2026-10-21T19:13Z · kiro-202610151913-51bd · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). The 13 rows and the paths were computed from the parity
ledger on `origin/main` and `src/App.tsx` so no file belongs to two lanes; the 6 `?tab=…` rows map to the single
`/business` route file (exact `shapeOf` match, not prefix) and each row's status is flipped. No deps — runs in
parallel with `sharing`. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim native-wave2-sharing-business/business-hub --session <id>`).
