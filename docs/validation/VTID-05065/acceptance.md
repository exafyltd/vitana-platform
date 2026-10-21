# VTID-05065 - Kiro runs: one server-side run record per Kiro turn (Phase 1 of 4)

Owner approval 2026-10-10 (Gate 1: "approved"). Sparring: `plan-sparring.md` (converged after 2 rounds). This VTID is Phase 1 only (backend): run record, detached runs, replayable stream. The console is unchanged (Phase 2).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `/api/v1/operator/kiro/runs` (new file `services/gateway/src/routes/operator-kiro-runs.ts`, mounted in `index.ts` next to `/api/v1/operator/kiro/mcp`, before the operator router; `requireAdminAuth` on every route; a run is visible to and cancellable by its own user only). Routes: `POST /`, `GET /?thread_id=`, `GET /:id`, `GET /:id/stream?after_seq=`, `POST /:id/cancel`. The existing `POST /api/v1/operator/kiro/permissions/:requestId` also answers a card persisted on a run of another gateway task. Atlas: `/^operator-kiro-runs$/` in the `agents` domain.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/runs (staging).

CURL_PROOF: unauthenticated `GET /api/v1/operator/kiro/runs?thread_id=<uuid>` answers 401 application/json; unauthenticated `GET /api/v1/operator/kiro/runs/<uuid>/stream?after_seq=0` answers 401 application/json (`staging-tests.json`, read-only).

OASIS_PROOF: `operator.kiro.run_started`, `operator.kiro.run_finished`, `operator.kiro.run_interrupted` — vtid VTID-05065, source `gateway-operator`, declared in the `CicdEventType` union; payload `{ run_id, thread_id, status }` only, never message text. `run_interrupted` is emitted only for rows the guarded UPDATE actually changed (sweep and shutdown).

MIGRATION: `supabase/migrations/20261010210000_vtid_05065_kiro_runs.sql` — `kiro_runs`, `kiro_run_events` (unique `(run_id, seq)`), RLS on, no policies, `anon`/`authenticated` revoked. Documented in `DATABASE_SCHEMA.md`. Applied after merge via `RUN-MIGRATION.yml`; until it is applied the old /chat path keeps answering Kiro turns in-process (the run store failure is logged) and the run routes answer 503 `store_unavailable`.

## Acceptance criteria

AC-1: A run starts and returns at once (202 `{ run_id, status }`); the turn runs in the gateway background through the same chat-turn implementation the old path used (thread record, OASIS chat events, history restore, model pick unchanged); the run row ends `completed`/`refused`/`incomplete`/`failed`/`cancelled` from `kiro_status`/`stop_reason`, with the reply.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-05065-kiro-runs.test.ts
AC-2: Events carry an in-process `seq`; message text is coalesced (500 ms / 2 KB); events go to live listeners and to `kiro_run_events` in batched bulk inserts (1 s / 20 events, flushed at the end and at shutdown; a failed insert is retried in order).
  TEST: services/gateway/test/vtid-05065-kiro-runs.test.ts
AC-3: `GET /runs/:id/stream?after_seq=` replays the stored events after `after_seq`, then live, and ends after the terminal status: a dropped stream reattached with the last seen seq loses nothing and repeats nothing; a second listener sees the same events; a finished run replays from the store alone.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  CURL: staging GET of the stream route without a token -> 401 application/json
AC-4: An approval card is a run event and the run's `pending_permission` (`waiting_permission`); the existing permission route answers it from any listener (another gateway task: written onto the run, handed to Kiro by the owning task's control tick); only the run's user may answer; 120 s timeout → denied, recorded.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-05065-kiro-runs.test.ts
AC-5: A permission request titled exactly `Running: @vitana/<name>` with kind `other` and `<name>` on `KIRO_MCP_READ_TOOLS` is allowed without a card (pinned on the recorded kiro-cli 2.28.0 titles); a write tool, an unknown name, another format or another kind still asks.
  TEST: services/gateway/test/vtid-05065-kiro-runs.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-6: One running run per thread; up to 2 queued (a third answers 409 `queue_full`); the next queued run starts when the current one ends. Cancel: queued → `cancelled` at once; running → Kiro's own cancel, the run ends `cancelled`; owner only.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-7: Liveness: one heartbeat UPDATE per task every 30 s over its own unfinished runs; a sweep (boot + 60 s) marks other tasks' runs with a heartbeat older than 2 min `interrupted` exactly once (guarded); the graceful-shutdown hook (appended to the existing `drainHooks`, own 3 s bound) flushes events and marks this task's runs `interrupted`; a late finish never overwrites an ended run; a new run on the thread restores the history (Continue).
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-05065-kiro-runs.test.ts
AC-8: `POST /api/v1/operator/chat` and `/chat/stream` for Kiro threads start a run and wait for / stream it: same reply body, same SSE frame types (no `run.status`, no `seq` in frames); every existing operator and Kiro scenario stays green.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/vtid-05018-kiro-thread-memory.test.ts
AC-9: Every run route is admin-only and owner-only: unauthenticated 401 JSON, non-admin 403, another admin 403 on read/stream/cancel and on starting a run in the thread, invalid ids 400, LLM thread 409.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  CURL: staging GET of the list route without a token -> 401 application/json

## Changed existing tests

- `services/gateway/test/vtid-05018-kiro-thread-memory.test.ts` — the source pin that read the body of `runKiroChatTurn` now reads `executeKiroChatTurn` (the body moved there; `runKiroChatTurn` starts a run and waits). Same assertions.

## Mutation check

34 single-line mutations of the implementation (coalescing, byte threshold, text-before-event order, batch trigger, retry of a failed insert, replay dedupe, in-memory replay, live switch, stream end on terminal, read-tool trust and its anchors/name/kind checks, permission answer report, waiting_permission persistence, sweep guard and own-task exclusion, OASIS once, shutdown update, guarded finish, pump after finish, queue/queue_full, cancel queued/running/cross-task, status mapping, control-tick answer, heartbeat, owner and thread-ownership checks, legacy frame filter, persisted-answer fallback, event writes): every one fails at least one test. Details: `outputs/local-checks.txt`.
AC-R: The runs routes answer 401 without a caller, 403 for another user's run or thread, 400 on invalid input, 409 queue_full / thread_not_kiro, 503 when the store is down, and stream SSE frames with ids from after_seq / Last-Event-ID.
  TEST: services/gateway/test/operator-kiro-runs.test.ts
