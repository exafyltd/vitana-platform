# VTID-04851 — recall() keeps old facts in the voice prompt

Found by the VTID-04784 shadow comparison on production (read-only CloudWatch report, 12 h, 18 sessions):
- recall() matched the legacy read's facts in only 7 of 18 sessions.
- On average it gave 3.06 fewer facts (37.9 against 40.9).
- It gave 0 facts the legacy read lacked, and 0 values differed.

Cause: the context window ranks items by relevance, and relevance decays with `occurred_at` (half after about 2 weeks).
- recall() stamped each fact with the date it was learned.
- The legacy read stamps facts with the read time.
- Facts share the personal domain's 5,000-char budget with the member's own "personal" episodes. Fresh episodes therefore outranked old facts, and the old facts were dropped.
- Both reads pick the same rows: the `superseded_by`/`superseded_at` tests agree on every live row, and both limits are 50.

Fix (`services/memory/recall.ts`): a current fact is stamped with the read time, as the legacy read does. The learned date stays in `content_json.asserted_at` and `created_at`.

## Acceptance

AC-1: a recall fact is stamped with the read time and keeps its learned date.
TEST: services/gateway/test/services/memory/vtid-04851-recall-fact-recency.test.ts

AC-2: 45 old facts competing with 25 fresh personal episodes all stay in the context window, the same as the legacy read. The old code kept 24.
TEST: services/gateway/test/services/memory/vtid-04851-recall-fact-recency.test.ts
