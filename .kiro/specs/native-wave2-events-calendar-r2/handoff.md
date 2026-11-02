---
slug: native-wave2-events-calendar-r2
author: kiro
executor: kiro
next_actor: claude
state: parked
author_seat: exafyltd
updated: 2026-11-02T16:32Z
spar_refs:
  - exafyltd/vitana-v1: main
parked_from: drafted
---
# Handoff — Native Wave 2: Events / Meetups / Calendar / Reminders / Live-rooms screen ports
Second Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Follows the first Wave 2 batch `native-wave2-home-feed-news` (home / feed
/ news). Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd → reviewer_seat
hotmail, disjoint `paths`, no `vtid` yet). Ports the 22 web destinations the parity ledger assigns to
`"lane": "events-calendar"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell;
fixture / fake-gateway tests only, device-runtime parity (the live-rooms Daily.co join especially) deferred to G1
(`next_actor: owner`). No web screen, `App.tsx` route or registry / manifest change — only native route files and
parity-row status flips.
Re-plan of `native-wave2-events-calendar` (PR #4271) under a new slug; the old branch has commits without Collab trailers (and lane files with an empty `vtid:` key, which made CI PLAN-SPAR allocate 0 VTIDs). Sparring history: https://github.com/exafyltd/vitana-platform/pull/4271.
## Log
### 2026-11-01T17:10Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-events-calendar-r2/_plan` claim. Re-plan of `native-wave2-events-calendar` (PR #4271), because the old branch has commits without Collab trailers (and lane files with an empty `vtid:` key, which made CI PLAN-SPAR allocate 0 VTIDs). Copied the plan, tasks, requirements, design and lane files from the old PR head; lane `vtid` keys removed (CI allocates on convergence), lane `paths` widened to the shared native-infra files a screen port produces, lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-events-calendar-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
### 2026-11-02T15:24Z · kiro-exafyltd-202611011658-9f52 · drafted (re-plan session)
Session 1 (`4b6931d8-e0cb-4786-8acf-63de2ace33cd`) escalated with zero findings (`evidence_floor_not_met`). Added one line to the plan block so PLAN-SPAR opens the re-plan session; no plan content changed.

### 2026-11-02T16:32Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (evidence_floor_not_met). Parked with the open findings in sparring/.
