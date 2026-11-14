---
slug: native-wave2-discover-commerce
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-21T13:30Z
sparring_record: .kiro/specs/native-wave2-discover-commerce/sparring/verdict.md
vtids: []
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Discover / Commerce / Cart / Orders screen ports
Second Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Follows the home/feed/news batch (`native-wave2-home-feed-news`) with the
next cluster. Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd →
reviewer_seat hotmail, disjoint `paths`, no `vtid` yet). Ports the 26 web destinations the parity ledger assigns to
`"lane": "discover-commerce"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell;
fixture / fake-gateway tests only, device-runtime parity deferred to G1 (`next_actor: owner`). This is a parity port —
no onboarding friction added, every purchase surface keeps today's iOS behaviour and is only flagged for the
`isIAPRestricted` gate. No web screen, `App.tsx` route or registry/manifest change — only native route files and
parity-row status flips.
## Log
### 2026-10-21T12:00Z · kiro-planner · created → drafted
Holder of the `native-wave2-discover-commerce/_plan` claim (planner). Measured on the worktree (= origin/main of
`exafyltd/vitana-v1`): `apps/mobile/parity/ledger.json` version 2 has **26 rows with `"lane": "discover-commerce"`,
every one `not_started`** (22 screen/registry, 4 route/exclusion; 435 rows total), counted with `node -e` over the
committed ledger (the `--report` CLI needs `typescript`, not installed here). Verified all 16 web source pages + the
three shared controls (`AddToCartButton`, `MobileDiscoverView`, `MobileOrdersView`) exist, and the `App.tsx` route
lines (`src/App.tsx:1029-1113`). Wrote requirements, design, tasks, plan and 3 lane files; partitioned the 26 rows
into `discover` (12), `product-cart-checkout` (5), `marketplace-orders` (9) with disjoint native file subtrees and
ledger-rows-by-row — 0 overlap, 0 orphan (registry 11+2+9 = 22, exclusion 1+3+0 = 4). No VTID allocated, no product
code changed, no live system touched.
Next: PLAN-SPAR spars the `plan(native-wave2-discover-commerce)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd` claims lanes in
dependency order — `discover` and `marketplace-orders` in parallel, `product-cart-checkout` after `discover` is `done`
(it depends on the `AddToCartButton` twin that `discover` owns). Reviewer seat `hotmail` reviews each lane.
Device-runtime parity (task 7/8 in each lane) waits on the owner's G1 isolated test environment.
### 2026-10-21T13:30Z · kiro-planner · review fix (drafted)
Plan review (`.worktrees/w2-commerce-plan/.agents/plan/review.json`, verdict `CHANGES_REQUESTED`, 1 HIGH + 1 MEDIUM).
Finding 1 (HIGH) — `requirements.md` and `design.md` were missing while `tasks.md`/`plan.md`/the lane files cited them
(R0.2–R0.4, R1–R6, R5) and the `design.md` inventory. Authored both in the model `native-wave2-home-feed-news` shape:
`requirements.md` (R0 measured ledger state + the 26 keys/web-paths, R1–R6 per-screen requirements, R5 the
per-purchase-surface `isIAPRestricted` flag table, R5a Commerce UX contract, R5b verification/safety, R6 done) and
`design.md` (route-file plan, screen source + archetypes, twin ownership, the discover↔product-cart-checkout port
boundary, decisions, test design). Every dangling reference now resolves; the spec folder's file set now matches the
model (requirements, design, handoff, plan, tasks, lanes/). Finding 2 (MEDIUM) — with the two files authored, the
creation-log entry above ("Wrote requirements, design, tasks, plan and 3 lane files") is accurate as written. The
review's recorded glob NIT is addressed in `design.md` §1/§3: lanes enumerate their own `app/(app)/discover/` leaves
rather than a bare recursive glob. No change to planned product behaviour — still a 1:1 parity port, every purchase
surface keeps today's iOS behaviour (R5), no onboarding friction added (R5a). No VTID allocated, no code changed, no
live system touched.
