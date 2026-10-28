---
slug: native-wave2-home-feed-news
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-10-21T11:19Z
sparring_record: .kiro/specs/native-wave2-home-feed-news/sparring/verdict.md
vtids: [VTID-05296, VTID-05297, VTID-05298]
---
# Handoff — Native Wave 2: Home / Feed / News screen ports
First Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Picks up the handover item in
`vitana-platform:.kiro/specs/health-native/handoff.md` "What Kiro does next" → native Wave 2 → home/feed/news first.
Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd → reviewer_seat hotmail,
disjoint `paths`, no `vtid` yet). Ports the 27 web destinations the parity ledger assigns to `"lane": "home-feed"`
to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell; fixture / fake-gateway tests only,
device-runtime parity deferred to G1 (`next_actor: owner`). No web screen, `App.tsx` route or registry/manifest change
— only native route files and parity-row status flips.
## Log
### 2026-10-16T12:00Z · kiro-planner · created → drafted
Holder of the `native-wave2-home-feed-news/_plan` claim (planner). Measured on the worktree (= origin/main):
`apps/mobile/parity/ledger.json` version 2 has **27 rows with `"lane": "home-feed"`, every one `not_started`**
(19 screen, 3 overlay, 5 route; 435 rows total), counted with `node -e` over the committed ledger (the `--report`
CLI needs `typescript`, not installed here). Verified all 13 web source pages + 4 feed modules + the card twin exist
with the line counts cited in `plan.md`, and the `App.tsx` route lines. Wrote requirements, design, tasks, plan and
3 lane files; partitioned the 27 rows into `home` (8), `news` (2), `community-hub` (17) with disjoint native file
subtrees and ledger-rows-by-row — 0 overlap, 0 orphan. No VTID allocated, no product code changed, no live system
touched.
Next: PLAN-SPAR spars the `plan(native-wave2-home-feed-news)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes; then seat `exafyltd` claims lanes in
dependency order — `news` and `community-hub` in parallel, `home` after `news` is `done` (it depends on the
`NewsArticleCard` twin that `news` owns). Reviewer seat `hotmail` reviews each lane. Device-runtime parity (task 7/8
in each lane) waits on the owner's G1 isolated test environment.

### 2026-10-17T14:17Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T14:45Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:33Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T19:32Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-21T11:19Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 3 lane(s) got a VTID and are handed to Kiro.
