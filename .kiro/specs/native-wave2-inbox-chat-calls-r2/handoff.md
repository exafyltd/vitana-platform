---
slug: native-wave2-inbox-chat-calls-r2
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-01T17:10Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Inbox / Chat / Calls screen ports
Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`, program
VTID-05021; Wave 2 lane list in §5). Ports the 9 web destinations the parity ledger assigns to
`"lane": "inbox-chat-calls"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell;
fixture / fake-gateway tests only, device-runtime parity (and especially the realtime + WebRTC call journey) deferred
to G1 (`next_actor: owner`). No web screen, `App.tsx` route or registry/manifest change — only native route files and
parity-row status flips. Plan block: `plan.md`. Lanes: `lanes/*.md` (2, both `ready`, executor kiro, seat exafyltd →
reviewer_seat hotmail, disjoint `paths`, no `vtid` yet).
Re-plan of `native-wave2-inbox-chat-calls` (PR #4269) under a new slug; the old branch has commits without Collab trailers (and lane files with an empty `vtid:` key, which made CI PLAN-SPAR allocate 0 VTIDs). Sparring history: https://github.com/exafyltd/vitana-platform/pull/4269.
## Log
### 2026-11-01T17:10Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-inbox-chat-calls-r2/_plan` claim. Re-plan of `native-wave2-inbox-chat-calls` (PR #4269), because the old branch has commits without Collab trailers (and lane files with an empty `vtid:` key, which made CI PLAN-SPAR allocate 0 VTIDs). Copied the plan, tasks, requirements, design and lane files from the old PR head; lane `vtid` keys removed (CI allocates on convergence), lane `paths` widened to the shared native-infra files a screen port produces, lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-inbox-chat-calls-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
