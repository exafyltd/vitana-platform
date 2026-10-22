---
slug: profile-posts-full-width
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-10-22T08:46Z
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
