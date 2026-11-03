---
slug: native-wave2-discover-commerce-r2
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-11-02T16:30Z
spar_refs:
  - exafyltd/vitana-v1: main
sparring_record: .kiro/specs/native-wave2-discover-commerce-r2/sparring/verdict.md
vtids: [VTID-05510, VTID-05511, VTID-05512]
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
Re-plan of `native-wave2-discover-commerce` (PR #4276) under a new slug; the old branch has commits without Collab trailers (and lane files with an empty `vtid:` key, which made CI PLAN-SPAR allocate 0 VTIDs). Sparring history: https://github.com/exafyltd/vitana-platform/pull/4276.
## Log
### 2026-11-01T17:10Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-discover-commerce-r2/_plan` claim. Re-plan of `native-wave2-discover-commerce` (PR #4276), because the old branch has commits without Collab trailers (and lane files with an empty `vtid:` key, which made CI PLAN-SPAR allocate 0 VTIDs). Copied the plan, tasks, requirements, design and lane files from the old PR head; lane `vtid` keys removed (CI allocates on convergence), lane `paths` widened to the shared native-infra files a screen port produces, lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-discover-commerce-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
### 2026-11-02T15:24Z · kiro-exafyltd-202611011658-9f52 · drafted (sparring round 1 answered)
R1-F1 accepted: `/discover/ai-picks` (no ledger row) is mapped by the `discover` lane to the native AI Picks tab in resolve.ts, with a cold-start test; a dedicated twin is a follow-up. Answers: `sparring/responses-1.md`.

### 2026-11-02T16:30Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 3 lane(s) got a VTID and are handed to Kiro.
