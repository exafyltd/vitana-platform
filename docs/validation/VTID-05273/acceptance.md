# VTID-05273 — acceptance (lane kiro-autonomy-fallback/plan-spar-allocation)

VALIDATION_PROFILE: gateway_backend
Scope: `scripts/collab/plan-spar.mjs`, `scripts/collab/plan-spar.test.mjs`, `docs/validation/VTID-05273/**`, the lane
file. CI script only: deploys nothing, so no staging suite and no Gate 2. Detail per test: `local-tests.md`.
OASIS impact: no (no OASIS events, no gateway or database change).

AC-1 — A converged, policy-approved plan whose lane has no VTID gets one on a later PLAN-SPAR run (`allocate_retry`),
after the live session is verified; no new round and no new session.
TEST: node --test scripts/collab/plan-spar.test.mjs — "late lane: a converged, policy-approved plan allocates a lane added after convergence"

AC-2 — `sparring_id` + `plan_hash` are sent at most once per session (only while the live session has no `vtid`); the
first lane lacking a VTID carries them, later allocations carry neither.
TEST: node --test scripts/collab/plan-spar.test.mjs — "late lane: the retry never re-sends the sparring id once the session is bound"; "lanes added later to a lane-less converged plan: first lane gets the bound VTID"

AC-3 — Idempotent per lane: a second run with every lane allocated allocates nothing and writes nothing.
TEST: node --test scripts/collab/plan-spar.test.mjs — "retry with every lane allocated is a no-op with zero writes"

AC-4 — An orphaned VTID already bound to the session is adopted, never re-allocated.
TEST: node --test scripts/collab/plan-spar.test.mjs — "orphaned bound VTID is adopted, not re-allocated"

AC-5 — A failed allocation keeps the VTIDs already allocated, exits 0, and the next run allocates the rest.
TEST: node --test scripts/collab/plan-spar.test.mjs — "allocation failure keeps the VTIDs already allocated and retries the rest on the next run"

AC-6 — With allocation on, the handoff goes to `next_actor: kiro` with `reason: lanes_missing | allocation_pending`,
never to Claude; `claude` only when allocation is off.
TEST: node --test scripts/collab/plan-spar.test.mjs — "no lanes at convergence: handoff goes to kiro with reason lanes_missing, not \"allocation is off\""; "allocation off: a converged plan with a late lane is not retried and still goes to claude"

AC-7 — The retry refuses a state.json that names another plan's session.
TEST: node --test scripts/collab/plan-spar.test.mjs — "retry refuses a state.json that names another plan's session"

AC-8 — Existing behaviour unchanged (partner chain, round count, first-run allocation).
TEST: node --test scripts/collab/plan-spar.test.mjs — the 10 pre-existing tests, unchanged, pass
