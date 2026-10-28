# VTID-05272 — acceptance (lane kiro-autonomy-fallback/pipeline-speed)
VALIDATION_PROFILE: gateway_backend
Scope: the lane's `paths` (plan-driver, TEST-SUITE shards + re-run, PLAN-SPAR slot step, STAGING-VERIFY per-VTID
attribution, the vtid-05077 test pin) and `docs/validation/VTID-05272/**`. The only gateway file is a test; no route,
no gateway source, no database change. Staging suite: `staging-tests.json`.
OASIS impact: no (no OASIS events emitted or changed).

AC-1 — `main` is unblocked: the vtid-05077 test expects the served `app.js` pin and asserts the chip renders; no
assertion dropped, `index.html` untouched.
TEST: npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts (services/gateway) — 15/15 pass (base: 1 failed)

AC-2 — The plan driver keeps one driver per plan (`collab-driver/<slug>` heartbeat, exit 3 on a live foreign tip
under 45 min, takeover after) and `next` picks the next action with at most 6 lanes in flight.
TEST: node --test scripts/collab/plan-driver.test.mjs — 12/12 pass

AC-3 — Gateway Jest runs as 4 shards and the union of the 4 results equals `jest --listTests`; a missing, duplicate or
unlisted file fails the union job.
TEST: node --test scripts/ci/test-suite/shard-union.test.mjs

AC-4 — A failed TEST-SUITE run is re-run once (attempt 1 only), only when every failed job died before its tests ran;
a real red is never re-run.
TEST: node --test scripts/ci/test-suite/rerun-policy.test.mjs

AC-5 — PLAN-SPAR waits for a slot: at most 2 sparring runs in flight, FIFO by run id, fail-open after 90 min.
TEST: node --test scripts/ci/plan-spar-slot/slot.test.mjs

AC-6 — STAGING-VERIFY records per-VTID failure attribution (`record.per_vtid`); the pass/fail rule is unchanged.
TEST: node --test scripts/ci/staging-verify/lib.test.cjs
