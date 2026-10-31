---
slug: native-wave2-sharing-business
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-21T19:13Z
sparring_record: .kiro/specs/native-wave2-sharing-business/sparring/verdict.md
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Sharing / Business hub screen ports
Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Sibling of `native-wave2-home-feed-news` — same model, next
`sharing-business` ledger cluster. Plan block: `plan.md`. Lanes: `lanes/*.md` (2, both `ready`, executor kiro, seat
exafyltd → reviewer_seat hotmail, disjoint `paths`, no `vtid` yet). Ports the 21 web destinations the parity ledger
assigns to `"lane": "sharing-business"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3
shell; fixture / fake-gateway tests only, device-runtime parity deferred to G1 (`next_actor: owner`). No web screen,
`App.tsx` route or registry/manifest change — only native route files and parity-row status flips.
## Log
### 2026-10-21T19:13Z · kiro-202610151913-51bd · created → drafted
Holder of the `native-wave2-sharing-business/_plan` claim (planner). Measured on `exafyltd/vitana-v1` `origin/main`:
`apps/mobile/parity/ledger.json` version 2 has **21 rows with `"lane": "sharing-business"`, every one `not_started`**
(19 screen, 2 route; 435 rows total), counted with `node -e` over the ledger read from `origin/main`
(`git show origin/main:apps/mobile/parity/ledger.json | node …`; the `--report` CLI needs `typescript`, not installed
here). Verified all web source pages + component libraries + the App.tsx route lines exist (line counts in `plan.md`
Measured state). Measured the class-B coupling: 10 `src/components/sharing/**` components import
`@/integrations/supabase/client` and `ChannelConnector` also imports `useChannels` — class B, re-implemented natively,
not extracted; `InstagramShareModal.tsx` uses `html2canvas` (`:2,52`) → native `react-native-view-shot`. Wrote
requirements, design, tasks, plan and 2 lane files; partitioned the 21 rows into `sharing` (8) + `business-hub` (13)
with disjoint native file subtrees and ledger-rows-by-row — 0 overlap, 0 orphan. No VTID allocated, no product code
changed, no live system touched (read-only in vitana-v1).

Self-check (recorded per the sibling plan's created-entry convention):
(a) **Every in-scope ledger row in exactly one lane, 0 overlap / 0 orphan, arithmetic shown.** `sharing` 8
    (SHARING.OVERVIEW, SHARING.CAMPAIGNS, SHARING.CAMPAIGN_DETAIL, SHARING.DISTRIBUTION, SHARING.DATA_CONSENT,
    COMM.INVITE, /creator/onboarded, /pub/campaigns/:id) + `business-hub` 13 (BUSINESS.OVERVIEW, BUSINESS.SERVICES,
    BUSINESS.CLIENTS, BUSINESS.SELL_EARN, BUSINESS.ANALYTICS, BUSINESS.SERVICES_EVENTS, BUSINESS.SERVICES_PACKAGES,
    BUSINESS.SALES_PROMOTIONS, BUSINESS.SALES_REFERRALS, BUSINESS.INSIGHTS_EARNINGS, BUSINESS.INSIGHTS_GROWTH,
    BUSINESS.OPPORTUNITIES, BUSINESS.LISTINGS) = **8 + 13 = 21**. ✓
(b) **Every lane's `paths` has the full mandatory baseline + its own app/screens subtrees.** Both lanes carry
    `apps/mobile/src/ports/**`, `apps/mobile/src/navigation/resolve.ts`, `apps/mobile/tests/<cluster>/**`,
    `packages/core/manifest.json`, `packages/core/closure.generated.json`, `packages/core/src/**`,
    `scripts/native/mobile-ci-paths.generated.json`, `apps/mobile/parity/ledger.json`, `src/i18n/*/<cluster>Native.json`,
    `docs/validation/**`, plus `apps/mobile/app/(app)/<cluster>/**` + `apps/mobile/src/screens/<cluster>/**`. ✓
(c) **handoff.md has `spar_refs: - exafyltd/vitana-v1: main`, `state: drafted`, NO `vtids:`.** ✓
(d) **No lane file has a `vtid:` yet.** ✓ (CI fills it on convergence.)
(e) **Spec mirrors the reference six-file structure + markers** — `requirements.md`, `design.md`, `tasks.md` (with a
    `<!-- lane: <id> -->` marker per lane group), `plan.md` (`<!-- plan:begin -->`/`<!-- plan:end -->`, Lanes table,
    Goal, Measured state, Decisions, Test plan, Open items), `handoff.md`, `lanes/sharing.md` + `lanes/business-hub.md`
    (each with the `created → ready` log entry). ✓

Next: PLAN-SPAR spars the `plan(native-wave2-sharing-business)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd` claims both lanes
(no deps — `sharing` and `business-hub` run in parallel). Reviewer seat `hotmail` reviews each lane. Device-runtime
parity (the G1 task in each lane) waits on the owner's G1 isolated test environment.
