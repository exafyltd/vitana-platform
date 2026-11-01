---
slug: native-wave2-home-feed-news-r2
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-01T01:17Z
spar_refs:
  - exafyltd/vitana-v1: main
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
Re-plan of `native-wave2-home-feed-news` (PR #4273, converged) under a new slug; the old branch has commits without Collab trailers. Sparring history: https://github.com/exafyltd/vitana-platform/pull/4273.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-8e5e · created → drafted
Holder of the `native-wave2-home-feed-news-r2/_plan` claim. Re-plan of `native-wave2-home-feed-news` (PR #4273, converged and policy-approved), whose branch cannot pass Collab handoff without a history rewrite (commits without a Collab-Session trailer, and a `_plan` commit that edits existing lane files). Copied the converged plan, tasks, requirements, design and lane files from the old PR head (lane paths as widened there); lane VTIDs removed (CI allocates on convergence), lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-home-feed-news-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
### 2026-11-01T01:17Z · kiro-exafyltd-202611010001-8e5e · drafted (re-plan session)
Session 1 (`914797eb-10b4-47b6-8d7a-1ea958db8a34`) escalated with zero findings (`evidence_floor_not_met`, a partner-side failure). Added one line to the plan block so PLAN-SPAR opens the re-plan session; no plan content changed.
