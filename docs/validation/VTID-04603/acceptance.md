# VTID-04603 — one specialist job per question burst
AC-2: a second call to the same specialist in the same session while the first runs joins it (one run, same job id).
TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
AC-3: a call within 15 s of a finished job reuses its result; after the window it runs again.
TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
AC-4: never reused across sessions, users or surfaces, nor when reuse is off (operator hand-off unchanged).
TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
Reason: live staging showed the model calling ask_support_specialist twice in one turn (reworded) in 2 of 3 runs.
