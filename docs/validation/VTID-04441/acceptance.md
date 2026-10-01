# VTID-04441 — forgetting a fact in the Memory Garden sticks

Plan item (docs/MEMORY-SYSTEM-PLAN.md §4.1): "Deleting a fact supersedes it and
adds a 'do not re-learn' marker, so the extractor does not re-infer it next
session." The Garden (VTID-04388) deleted every row of the key but recorded
nothing, so the next session's extractor could infer the same value again.

## Acceptance

AC-1: `memory_fact_forgotten` exists, is RLS-on and `service_role` only; `anon` and `authenticated` cannot read it. It stores a SHA-256 of the normalised value, never the value.
TEST: live privilege check in outputs/live-db-verification.md (applied live before merge).

AC-2: forgetting a fact in the Garden writes one hashed marker per distinct value of the key (history included) BEFORE deleting the rows; the marker rows contain no value text.
TEST: services/gateway/test/vtid-04441-forgotten-facts.test.ts ("writes one hashed marker per distinct value")

AC-3: an inferred write (assistant_inferred, behavior_inferred, system_observed, …) of a forgotten value is refused by `rememberFact()` with `blocked: 'forgotten'` before any RPC; a different value for the same key is still learned.
TEST: services/gateway/test/vtid-04441-forgotten-facts.test.ts

AC-4: an explicit user statement (`user_stated*`, `user_edited`, which includes the Garden's own add/edit) is written and clears the marker.
TEST: services/gateway/test/vtid-04441-forgotten-facts.test.ts ("writes an explicit user statement and clears the marker")

AC-5: failure posture — a marker read that fails lets the write through and logs `[VTID-04441]`; a marker write that fails never blocks the Garden delete. Every existing rememberFact / Garden / golden-eval test still passes.
TEST: services/gateway/test/vtid-04441-forgotten-facts.test.ts
TEST: services/gateway/test/services/memory/remember.test.ts
TEST: services/gateway/test/memory-golden-eval.test.ts

## Not verified live

No real user has forgotten a fact on a build that carries this code (the table is empty). The first signal is a `memory_fact_forgotten` row after a Garden delete on staging, and a `forgotten:` refusal in the gateway log when the extractor meets the same value.
