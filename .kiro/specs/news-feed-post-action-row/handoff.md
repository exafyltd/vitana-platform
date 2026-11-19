---
slug: news-feed-post-action-row
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: jtadic
updated: 2026-11-19T12:10Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — News Feed post card: author row on top, actions on their own row
Owner request 2026-11-19 (Kiro Web, phone screenshot): the like, comment and send controls look crowded and sit too
close to the author on News Feed post cards; continue what the earlier Claude Code session started (VTID-05795,
exafyltd/vitana-v1#1685, which merged the actions on the author line). Plan block: `plan.md`. Lane:
`lanes/card-actions.md` (one lane, one source file and its test in vitana-v1).

## Log
### 2026-11-19T12:10Z · kiro-jtadic-202611191143-e223 · created → drafted
Holder of the `news-feed-post-action-row/_plan` claim. Read `CommunityPostCard.tsx` and its test on vitana-v1
origin/main bbe90b713 and the history of #1685. Prototyped the layout locally (mocked hooks, no live data) and
measured it at 390×844. No VTID allocated, no live system touched.
Next: PLAN-SPAR spars the `plan(news-feed-post-action-row)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTID into the lane; seat `jtadic` builds `card-actions`.
