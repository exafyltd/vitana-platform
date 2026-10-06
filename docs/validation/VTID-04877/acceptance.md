# VTID-04877: recall()'s broker flag check no longer blocks the memory read

VTID-04870's first staging lines showed each recall total running 66–280 ms past its slowest stream. The streams run in parallel. The only serial step before them is `isBrokerEnabled()`: a 30 s cache over `getSystemControl('memory_broker_enabled')`. Voice sessions are minutes apart, so that cache was cold on almost every session.

Changed:
- Stale-while-revalidate. Only the first read of a process waits for the flag. After that, an expired value is served at once and a single background refresh runs. A failure still means off (fail closed). `invalidateBrokerFlagCache()` fences a refresh that is still in flight.
- `MemoryPack.meta.gate_ms`. The recall log line gains `gate_ms=` and `unaccounted_ms=` (total − gate − slowest stream); the `unavailable` line gains `gate_ms=`.

## Acceptance

AC-1: once the flag is known, an expired cache never makes a read wait for `getSystemControl`. Concurrent reads start one refresh, and the refresh's value is used by the next read. (These tests fail on the old code.)
TEST: services/gateway/test/services/memory-broker.test.ts

AC-2: invalidating the cache during a pending refresh is not overwritten by that refresh.
TEST: services/gateway/test/services/memory-broker.test.ts

AC-3: the recall log carries `gate_ms` and `unaccounted_ms` (shown as `-` when unknown) and no member text.
TEST: services/gateway/test/services/memory/vtid-04877-recall-gate-latency.test.ts
