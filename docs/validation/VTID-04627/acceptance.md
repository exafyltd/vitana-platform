# VTID-04627 — rebuild the core snapshot when the member changes their memory

Found by the live memory suite (VTID-04600, scenario B-REC-01, staging, session
`live-65523b9d-5a1d-428f-a290-d51bdd12271c`): `user_pet_name=Bello` was added
through the Memory Garden, a new German session asked "Wie heißt mein Hund?",
and Vitana answered that the information was not stored. OASIS showed
`core_snapshot_used` (12,418 chars) and no `search_memory` call: the session
ran on the VTID-04399 core snapshot, which only refreshes 90 s after a session
ends. A Garden delete had the mirror defect — the deleted value stayed in the
snapshot and could still be spoken.

AC-1: A Memory Garden add, edit or delete schedules a snapshot rebuild within 3 s (`BRAIN_CORE_SNAPSHOT_EDIT_REFRESH_DELAY_MS`).
TEST: services/gateway/test/services/conversation/vtid-04627-snapshot-refresh-on-memory-edit.test.ts

AC-2: A fact saved by remember_fact (the tool and the gateway backstop) schedules the same rebuild; a refused or failed write does not.
TEST: services/gateway/test/services/conversation/vtid-04627-snapshot-refresh-on-memory-edit.test.ts

AC-3: The forget_memory voice tool schedules the rebuild after its delete.
TEST: services/gateway/test/services/conversation/vtid-04627-snapshot-refresh-on-memory-edit.test.ts

AC-4: The edit refresh runs in its own debounce lane and never cancels the post-session refresh (which waits for the session's memory commit); `BRAIN_CORE_SNAPSHOT=false` still disables everything.
TEST: services/gateway/test/services/conversation/vtid-04627-snapshot-refresh-on-memory-edit.test.ts

AC-5: Existing snapshot, Garden, remember_fact and conformance suites stay green.
TEST: services/gateway/test/services/conversation/vtid-04399-brain-core-snapshot.test.ts

AC-6 (live, after staging deploy): B-REC-01 re-run on staging recalls the Garden-seeded fact.
TEST: scripts/memory-verification/run-live.mjs
