# Sparring responses — round 1 (session 80ec8512)

Both findings accepted and fixed in the plan block. The partner is now reading real vitana-v1 code (cites
feed-compose.ts:27, news-feed-ranker.ts:23-24, App.tsx:969, the parity ledger) — the ref fix works.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct — the @vitana/core extraction was under-scoped. feed-compose.ts:27 imports a type from @/lib/news-feed-ranker, and news-feed-ranker.ts:23-24 import MatchReason from @/lib/matchReason and PostAttachedRef from @/lib/post-attachment, so moving only feed-compose/ranker leaves @/lib/* imports in the core copies and core-closure.mjs --check would fail / leak web paths. Fixed: Decision 2 now moves (or inlines the minimal type shapes of) feed-compose, news-feed-ranker, matchReason, post-attachment, plus any transitive @/lib/* type imports in useNewsFeed/useAllNewsFeed, each as its own re-export PR, so the core copies carry no @/lib/* imports and core-closure --write/--check passes with core self-contained. The 'one re-export line per module' wording is superseded."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Correct — the home lane double-counted. /home has 6 ledger rows (HOME.OVERVIEW, HOME.NEWS_ALL, HOME.NEWS_COMMUNITY, HOME.CREATE_POST + the 2 overlays LIFE_COMPASS.OVERLAY, OVERLAY.MASTER_ACTION), not 8; /home/compose, /home/comments, /home/notif (App.tsx:969-998) are routes with no parity-ledger rows. Fixed: the partition is re-counted to home 6 + news 2 + community-hub 19 = 27; the three /home sub-routes are ported as native route files but carry no dedicated parity row and are covered under HOME.OVERVIEW for parity-ledger.mjs --check, so the '0 orphan / only status flips' guarantee holds for the 6 rows and the deep-links are explicitly excluded from row accounting. Decision 1, the lane table, and the partition line are all updated consistently."
  }
]
```

## Note for the next round
Both defects fixed in the plan block. The extraction scope now includes the transitive type modules so core stays
self-contained; the home-lane row accounting matches the ledger (6+2+19=27) with the 3 /home deep-link sub-routes
ported but excluded from parity rows. This session (80ec8512) reads vitana-v1, so these premises are now
partner-verifiable.
