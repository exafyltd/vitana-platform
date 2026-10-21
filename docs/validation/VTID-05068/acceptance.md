# VTID-05068 - Kiro runs survive a gateway deploy (Phase 3 of 4)

Owner approval 2026-10-10 (Gate 1: "approved"). Sparring: `plan-sparring.md` (converged after 2 rounds; binding planner response F7: the reattach token is stored hashed on the run and is valid only inside the reattach window). This VTID is Phase 3 only. Phase 1 (VTID-05065) is merged; the console (Phase 2) and the pipeline tree (Phase 4) are separate VTIDs.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new gateway route. New kiro-runner WebSocket path `/sessions/reattach?user_id=&thread_id=` (private service, runner token + `X-Kiro-Reattach-Token` header; refusals close 4403 `kiro_reattach_refused` — token missing, wrong or expired — and 4404 `kiro_session_not_found`; a socket replaced by a reattach closes 4409 `kiro_session_taken_over`). `/sessions` additionally accepts `X-Kiro-Reattach-Token` (header only, never the URL).

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/runs (staging; the run API a reattached run is read through).

CURL_PROOF: unauthenticated `GET /api/v1/operator/kiro/runs?thread_id=<uuid>` answers 401 application/json (`staging-tests.json`, read-only). The reattach itself needs a running Kiro session and a gateway deploy, so it is proven by the CI suites listed there, not on staging (rule 48: staging tests are read-only).

OASIS_PROOF: new topic `operator.kiro.run_reattached` — vtid VTID-05068, source `gateway-operator`, status info, declared in the `CicdEventType` union; payload `{ run_id, thread_id, status }` only (no message text, never a token or nonce). Emitted once per run the new task takes over. A refused reattach emits the Phase 1 `operator.kiro.run_interrupted` exactly as the sweep does.

MIGRATION: `supabase/migrations/20261010220000_vtid_05068_kiro_run_reattach.sql` — additive nullable columns on `kiro_runs`: `reattach_nonce`, `reattach_token_hash`, `reattach_expires_at`, `turn_context`. Documented in `DATABASE_SCHEMA.md`. Applied after merge via `RUN-MIGRATION.yml`. Until it is applied, the reattach identity write fails (logged) and the run is treated as not reattachable: shutdown and sweep keep the Phase 1 behaviour.

## Acceptance criteria

AC-1: kiro-runner keeps a session's kiro-cli process alive for `KIRO_RUNNER_REATTACH_MS` (default 10 min; `0` = off) when its gateway socket drops while a prompt is running and the session was opened with a reattach token; frames produced meanwhile are buffered (cap 2 MB, `KIRO_RUNNER_REATTACH_BUFFER_BYTES`; past it the session ends `kiro_reattach_buffer_full`). Without a token, between turns, or on a deliberate gateway close (1000/1005) the session ends exactly as before (workspace parked/removed as in VTID-05064).
  TEST: services/kiro-runner/test/runner.test.ts
AC-2: A new socket for the same user + thread presenting the session's token takes the session over and receives, in order: one `reattached` frame (ACP session id, the prompt ids unanswered at the drop, replay count), the agent requests the old socket never answered, then the buffered frames; the same kiro-cli answers later prompts. A wrong, missing or expired token is refused (4403) and the session keeps waiting; another user or thread finds nothing (4404). The runner keeps only sha256(token). Idle and lifetime timers still end a detached session; a new session of the thread replaces its detached one and gets its parked workspace.
  TEST: services/kiro-runner/test/runner.test.ts
AC-3: The gateway mints a reattach identity per reattachable Kiro session at spawn (kiro-runner backend and `GATEWAY_INTERNAL_TOKEN` set): random nonce; token = HMAC-SHA256(HKDF(GATEWAY_INTERNAL_TOKEN), nonce), sent only in the `X-Kiro-Reattach-Token` header; the run row stores the nonce, hex sha256(token) and the window end — never the token. `turn_context` keeps how the turn was asked.
  TEST: services/gateway/test/vtid-05068-kiro-run-reattach.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-4: Graceful shutdown lets a running run on a reattachable session go (runner socket closed 1001 before the events are flushed; the waiting turn is not failed or recorded here) and sets `reattach_expires_at`; runs on non-reattachable sessions are marked `interrupted` exactly as in Phase 1.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-05068-kiro-run-reattach.test.ts
AC-5: On boot and every sweep, a task first claims (guarded UPDATE of `gateway_task`) other tasks' runs that are let go inside their window, or whose heartbeat is stale (2 min) with the window counted from it still open; it re-derives and checks the token, reattaches the runner session, rebuilds the AcpClient (adopting the pending prompt before the replay is read), continues the run's seq after the stored max, emits `run.reattached` and `operator.kiro.run_reattached`, and finishes the turn through the same executor (reply = text before + after the hand-over, recorded once). An approval card open at the deploy is shown again and answerable.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-05068-kiro-run-reattach.test.ts
AC-6: If the runner refuses (4403/4404), the token does not match the stored hash, or reattach is not available, the claimed run is marked `interrupted` with `error: gateway_task_lost` and one `operator.kiro.run_interrupted` — the Phase 1 outcome; a run past its window is left to the unchanged Phase 1 sweep.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-7: Every Phase 1 run scenario, the operator, support and role suites, and every Kiro suite stay green.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-05065-kiro-runs.test.ts
  TEST: services/gateway/test/vtid-04999-kiro-runner-backend.test.ts

## Changed existing tests

- `services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts` — the Phase 1 shutdown scenario's `drainKiroRunsForShutdown` result now also reports `detached: 0` (the return shape gained a count; the behaviour asserted is unchanged). New describe "Kiro runs survive a gateway deploy (VTID-05068)" (4 scenarios).

## Decisions taken

- The token is derived (HMAC of a random per-session nonce under a key from `GATEWAY_INTERNAL_TOKEN`) instead of purely random: the task that reattaches is a different process and must be able to present it, while F7 forbids storing it. A database reader alone cannot present it.
- The runner detaches only while a prompt is running; a drop between turns ends the session as before, so the thread's next session still gets its parked workspace.
- A reattach of a still-attached session with the right token takes it over (old socket closed 4409) — covers a new task reaching the runner before the old task's socket has closed.
- Any failure to reattach (refusal, token mismatch, runner unreachable) marks the run `interrupted` exactly as Phase 1 does; nothing retries.
- A reattached session serves the running turn; its MCP pass was minted by the old task, so with MCP enabled the next turn opens a fresh session (history restore) — model list is unknown on a reattached session (`kiro_model: null` for that turn).

## Mutation check

Single-line mutations, each restored afterwards: frames not held until the AcpClient listens (remote backend) → the real-socket reattach test fails; shutdown not detaching → 3 regression scenarios fail; candidate rule bypassed → the crash/window scenario fails. Details: `outputs/local-checks.txt`.
