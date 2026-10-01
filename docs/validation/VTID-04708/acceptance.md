# VTID-04708 — a forget invalidates the cached ORB brain instruction

Pass 6 of the live voice suite on staging `fcf53eb` (2026-09-28, B-FORG-01):
the member asked Vitana to forget the dog's name. The forget ran at 18:23:49
(fact deleted, marker written, 2 transcript lines removed). The next session
started at 18:24:12 and its instruction still listed `user_pet_name: Bello`;
Vitana said the name again. No Bello row existed anywhere in the store.

Cause: the brain cache reuses a completed build while `memoryChangedSince()`
reports no change, and that probe only looked for NEW facts and items. A
forget deletes rows and writes only a `memory_fact_forgotten` marker, so the
build cached before the forget was served. The probe now also counts a
forget marker written after the build (`forgotten_at` defaults to now(),
index on `user_id` leads).

## Acceptance

AC-1: a forget marker newer than the build makes the probe report a change.
TEST: services/gateway/test/vitana-brain-cache.test.ts

AC-2: an error reading forget markers makes the probe rebuild, never serve stale.
TEST: services/gateway/test/vitana-brain-cache.test.ts

AC-3: live B-FORG-01 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
