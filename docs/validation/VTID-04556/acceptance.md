# VTID-04556 — the ORB brain cache rebuilds when the member's memory changed

Same staging test: session B logged `[ORB-BRAIN-CACHE] HIT … (age 175782ms)` — its memory context was
built 3 minutes earlier, before session A saved 5 facts and a session summary. The cache had a 5-minute
TTL and no notion of memory changing. The gateway runs several tasks, so an in-process invalidation on
the task that wrote the memory would not reach the others; a cache hit now asks the store whether a
fact or item was written after the cached build started, and rebuilds if so.

AC-1: a cache hit is served only when no memory was written after the cached build; otherwise it rebuilds.
TEST: services/gateway/test/vitana-brain-cache.test.ts

AC-2: the probe answers null without a store (old behaviour), true on a newer fact/item, false otherwise,
and true (rebuild) on an error or a timeout.
TEST: services/gateway/test/vitana-brain-cache.test.ts

AC-3 (live, after the staging deploy): a voice session started within 5 minutes of a session that saved
memory logs `[ORB-BRAIN-CACHE] STALE … rebuilding` and recalls the new facts.
TEST: services/gateway/test/vitana-brain-cache.test.ts (live evidence in outputs/)
