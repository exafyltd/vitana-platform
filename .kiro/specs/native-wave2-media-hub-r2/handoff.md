---
slug: native-wave2-media-hub-r2
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-11-10T10:30Z
spar_refs:
  - exafyltd/vitana-v1: main
sparring_record: .kiro/specs/native-wave2-media-hub-r2/sparring/verdict.md
vtids: [VTID-05677]
---
# Handoff — Native Wave 2: Media Hub port
Wave 2 screen port of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`, program
VTID-05021; Wave 2 lane "Media hub/shorts" in §5). Ports the 4 web destinations the parity ledger assigns to
`"lane": "media"` (`COMM.MEDIA_HUB`, `COMM.MEDIA_MUSIC`, `COMM.MEDIA_PODCASTS`, `COMM.MEDIA_SHORTS`; vitana-v1
origin/main `e31bf4627ff3`, ledger version 2, 435 rows) to native at 1:1 parity with the non-Spotlight mobile branch
of `src/pages/community/MediaHub.tsx`, on `@vitana/core` + `@vitana/ui` + the N3 shell. Fixture / fake-gateway tests
only; uploads, likes, comments, bookmarks and deletes go through the `MediaHubData` port and are tested against a
fake; device-runtime parity deferred to G1 (`next_actor: owner`). Plan block: `plan.md`. Lane: `lanes/media-hub.md`
(`ready`, executor kiro, seat exafyltd → reviewer agent, no `vtid` yet). No web screen, `App.tsx`, registry or
manifest change.
Re-plan of `native-wave2-media-hub` (PR #4658) under a new slug, one session: the old branch carries `_plan` commits from two Kiro sessions, which Collab handoff refuses, and its sparring escalated in round 3 on a stale vitana-v1 snapshot. This plan pins vitana-v1 and vitana-platform `origin/main` SHAs in its Measured state.
## Log
### 2026-11-10T10:05:00Z · kiro-exafyltd-202611072144-1c88 · created → drafted
Re-plan of `native-wave2-media-hub` (PR #4658) under a new slug so the `_plan` lane has commits from one session only. Content is the version that converged in rounds 1-2 there; citations re-verified at vitana-v1 `e31bf4627ff3`; lane `paths` trimmed (no package.json / package-lock.json / app.config.ts / tests/app-config.test.ts). No VTID allocated, no product code changed, no live system touched.

### 2026-11-10T10:30Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
