---
slug: profile-posts-full-width
author: kiro
executor: kiro
next_actor: kiro
state: done
author_seat: exafyltd
updated: 2026-11-11T12:09Z
spar_refs:
  - exafyltd/vitana-v1: main
sparring_record: .kiro/specs/profile-posts-full-width/sparring/verdict.md
vtids: [VTID-05330]
---
# Handoff — profile Posts tab: avatar header on top, post full width
Owner request 2026-10-22 (Kiro Web): move the avatar out of the left column on the profile Posts tab so the post
text and media take the full card width, Facebook-style. Owner confirmed "The profile Posts tab only" with a phone
screenshot. Plan block: `plan.md`. Lane: `lanes/card-layout.md` (one lane, one source file in vitana-v1).

## Log
### 2026-10-22T08:40Z · kiro-exafyltd-202610220818-5273 · created → drafted
Holder of the `profile-posts-full-width/_plan` claim. Read `ProfilePostsTab.tsx`, `FeedMedia.tsx`,
`CommunityPostCard.tsx` on vitana-v1 origin/main 60c18aee4. Wrote plan, tasks and the lane file. No VTID allocated, no
product code changed, no live system touched.
Next: PLAN-SPAR spars the `plan(profile-posts-full-width)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTID into the lane; seat `exafyltd` builds `card-layout`.

### 2026-10-22T08:46Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
### 2026-11-11T12:09Z · session_01Cp885JNj3BnQzQqwppFc9t · approved → done
Plan closed. Merged: vitana-platform#4299 (plan, 2026-10-22T09:03:51Z), vitana-v1#1489 (card-layout, 2026-10-22T09:30:34Z). Lane `card-layout` done.
### 2026-11-11T12:09Z · session_01Cp885JNj3BnQzQqwppFc9t · stale release (logged)
Stale-claim release: `queue.mjs release profile-posts-full-width/_plan --session session_01Cp885JNj3BnQzQqwppFc9t --stale` ran; the ref delete was refused by the session's git proxy (HTTP 403, policy denial), so `collab-claim/profile-posts-full-width/_plan` (held by kiro-exafyltd-202610220818-5273, ~480 h old) is still on origin. Not retried. Needs a delete by someone with ref-delete rights.
Stale-claim release (card-layout): `queue.mjs release profile-posts-full-width/card-layout --session session_01Cp885JNj3BnQzQqwppFc9t --stale` ran; the ref delete was refused by the session's git proxy (HTTP 403, policy denial), so `collab-claim/profile-posts-full-width/card-layout` (held by kiro-exafyltd-202610220818-5273, ~480 h old) is still on origin. Not retried. Needs a delete by someone with ref-delete rights.
Driver heartbeat `collab-driver/profile-posts-full-width`: `git push origin --delete` refused the same way (HTTP 403); still on origin.
