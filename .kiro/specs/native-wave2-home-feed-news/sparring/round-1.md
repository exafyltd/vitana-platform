# Sparring round 1 — in_progress

Session: `80ec8512-302f-4261-8134-3f8a34b0cc3b` · plan hash `888d34c957fe55686d26734bf90f313aa8bd3ee2904848cfeabe2613c82bd6f9`

## Summary

The plan is broadly well-structured: the ledger premise (27 home-feed rows, all not_started) roughly checks out, the three-lane partition is coherent, and the device-runtime deferral to G1 is consistent with program governance. Two real defects emerged: (1) Decision 2 under-scopes the feed-module extraction — feed-compose.ts and news-feed-ranker.ts carry `@/lib/*` transitive type imports (matchReason, post-attachment) that are not being moved, so `@vitana/core` will not be self-contained and `core-closure --write`/`--check` will fail or leak web paths into core; (2) the home lane's "8 rows" and its inclusion of /home/compose, /home/comments, /home/notif is inconsistent — those three are App.tsx routes but are NOT parity ledger rows (the /home web_path has only 4 screen + 2 overlay rows), so the "0 orphan / only status flips / parity-ledger check rows native routes present" guarantees cannot cover them, and the 8+2+17=27 accounting does not add up if the deep-links are counted as rows.

## Findings

### R1-F1 [major]

Decision 2 under-scopes the feed-module extraction into @vitana/core. feed-compose.ts imports a type from `@/lib/news-feed-ranker` (line 27), and news-feed-ranker.ts imports types from `@/lib/matchReason` (line 23) and `@/lib/post-attachment` (line 24). Neither of those two is listed as being moved, so after `core-closure.mjs --write` the `@vitana/core` copies will still reference web-side `@/lib/*` modules, breaking the 'pure, self-contained single source of truth' claim and likely failing `core-closure --check` (or leaking web paths into the published core package).

- `exafyltd/vitana-v1:src/lib/feed-compose.ts:27` — import type { FeedItem, FeedItemKind } from "@/lib/news-feed-ranker";
- `exafyltd/vitana-v1:src/lib/news-feed-ranker.ts:23` — import type { MatchReason } from "@/lib/matchReason";
import type { PostAttachedRef } from "@/lib/post-attachment";

Suggestion: Enumerate the transitive type-only dependencies of feed-compose/ranker/hooks (matchReason, post-attachment, and any others in useNewsFeed/useAllNewsFeed) in the extraction plan, and either move those type modules into core too (their own re-export PRs) or in-line/duplicate the minimal type shapes inside core so the moved modules drop the `@/lib/*` imports. Update the 'one re-export line per module' statement accordingly.

### R1-F2 [major]

The home lane's '8 rows' scope is inconsistent with the ledger and cannot be verified by the stated parity checks. The ledger rows for /home are HOME.OVERVIEW, HOME.NEWS_ALL, HOME.NEWS_COMMUNITY, HOME.CREATE_POST plus the two /home overlays LIFE_COMPASS.OVERLAY and OVERLAY.MASTER_ACTION = 6 rows. The lane additionally scopes /home/compose, /home/comments and /home/notif — but those are App.tsx routes (lines 969-998) that have no parity ledger rows (the ledger `--sync` only produced `?compose=1` as HOME.CREATE_POST). Therefore '8 rows' over-counts, and 'no new parity row, only status flips' cannot be satisfied for the three deep-link paths because there is no row to flip and no route name for `parity-ledger.mjs --check` to match.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:1469` — HOME.CREATE_POST /home?compose=1 ... HOME.NEWS_ALL /home?tab=all ... HOME.NEWS_COMMUNITY /home?tab=community ... HOME.OVERVIEW /home
- `exafyltd/vitana-v1:src/App.tsx:969` — <Route path="/home/compose" ... /> ... <Route path="/home/comments" ... /> ... <Route path="/home/notif" ... />

Suggestion: Reconcile the home lane row count with the ledger: state that home is 6 ledger rows (4 screen + 2 overlay) plus 3 in-scope deep-link routes that are implemented as native route files but carry no dedicated parity row, and clarify how the 27-total partition (8+2+17) is derived without double-counting the deep-links. Ensure `parity-ledger.mjs --check` has a defined expectation for the 3 deep-link files (e.g. excluded or covered by HOME.OVERVIEW) so the 'rows native, routes present' gate actually passes.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
