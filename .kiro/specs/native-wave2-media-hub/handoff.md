---
slug: native-wave2-media-hub
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-01T17:25Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Media Hub port
Wave 2 screen port of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`, program
VTID-05021; Wave 2 lane "Media hub/shorts" in §5). Ports the 4 web destinations the parity ledger assigns to
`"lane": "media"` (`COMM.MEDIA_HUB`, `COMM.MEDIA_MUSIC`, `COMM.MEDIA_PODCASTS`, `COMM.MEDIA_SHORTS`; vitana-v1
origin/main `a41e89a0d`, ledger version 2, 435 rows) to native at 1:1 parity with the non-Spotlight mobile branch
of `src/pages/community/MediaHub.tsx`, on `@vitana/core` + `@vitana/ui` + the N3 shell. Fixture / fake-gateway tests
only; uploads, likes, comments, bookmarks and deletes go through the `MediaHubData` port and are tested against a
fake; device-runtime parity deferred to G1 (`next_actor: owner`). Plan block: `plan.md`. Lane: `lanes/media-hub.md`
(`ready`, executor kiro, seat exafyltd → reviewer_seat hotmail, no `vtid` yet). No web screen, `App.tsx`, registry or
manifest change.
## Log
### 2026-11-01T17:25Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-media-hub/_plan` claim. Wrote plan, requirements, design, tasks and the one lane file
(`media-hub`) from measurements on vitana-v1 origin/main `a41e89a0d` (file:line in `plan.md`); registered the slug
in `docs/programs/native-app/program.md`. One commit, one session. No VTID allocated, no product code changed, no
live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-media-hub)` PR; this session answers each round in
`sparring/responses-<n>.md`.
