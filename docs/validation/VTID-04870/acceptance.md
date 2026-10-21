# VTID-04870 — recall(): name the slow stream, drop the 3x overfetch

The VTID-04784 shadow found `recall()` 2–3x slower than the legacy read, whichever path was served:
- production: recall p50 353 ms (the shadow), legacy 144 ms (served);
- staging: recall p50 767 ms (served), legacy 237 ms (the shadow).

The tables are tiny (3,749 memory_items, average 90 chars), so database work does not explain it.

Pairing each session's recall log line with its shadow line on staging (72 h) put the time inside `recall()` itself. Selection and formatting added under 10% on top. The recall line logged only the total, so the slow stream was unknown.

Changed:
- The `[VTID-04452] orb recall` line now ends with `stream_ms=` (per stream, sorted, counts only). Staging logs then show which stream is slow.
- The episodic REST step fetched 3x the rows it kept, for a ranker that no longer exists. It now fetches `limit` rows. The rows are already ordered importance then recency, so the kept rows are identical.

## Acceptance

AC-1: the recall log line carries per-stream latency and no member text.
TEST: services/gateway/test/services/memory/vtid-04870-recall-stream-latency.test.ts

AC-2: the episodic REST step requests exactly `limit` rows (fails on the old code).
TEST: services/gateway/test/services/memory-broker-episodic-fallback.test.ts
