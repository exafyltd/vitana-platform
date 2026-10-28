# VTID-05350 — acceptance (lane plan-spar-stuck-session/stuck-recovery; criteria from tasks.md)

AC-1: A partner model call that never returns ends the pass at the pass deadline with `deadline_exceeded` (an escalated,
infra-retryable round 1) instead of hanging the create request.
TEST: services/gateway/test/plan-sparring-stuck-session.test.ts "(1) a partner model call that never resolves …"

AC-2: A code-access tool call that never returns ends the pass the same way (round-1 R1-F1).
TEST: services/gateway/test/plan-sparring-stuck-session.test.ts "(1b) a code-access tool call that never resolves …"

AC-3: STALE_AFTER_MS is 20 min: above the 15-min standard pass deadline, below the CI wait; a 21-min 0-round session is
dead (fresh session), a 19-min one is deduplicated. Existing stale-session boundary cases stay green.
TEST: plan-sparring-stuck-session.test.ts (2), (3); services/gateway/test/plan-sparring-stale-session.test.ts (a)-(i)

AC-4: The CI client re-posts once after a stuck wait on either `create` path and returns the fresh session; a session
still stuck after the re-post fails with an explicit `stuck` error after exactly 2 posts (no loop).
TEST: scripts/collab/plan-spar.test.mjs "a stuck round-1 session is re-posted once…", "the lost-response path … 3 posts", "a session still stuck after the re-post …"

AC-5: The cross-file invariant WAIT_MS > STALE_AFTER_MS is machine-checked.
TEST: scripts/collab/plan-spar.test.mjs "timing invariant: the client waits longer than the gateway stale window …"

AC-6: The review is unchanged: no edit to partner prompts, submit_review, the evidence floor, round caps,
convergence/escalation rules, MAX_SESSIONS, policy approval or VTID allocation; all sparring suites stay green.
TEST: npx jest test/vtid-04868 test/plan-sparring (7 suites, 128 passed, 1 skipped); node --test scripts/collab/*.test.mjs (181, 0 failed)
