# Plan sparring record — VTID-05068 (option 2, Phase 3 of 4)

- Sparring session: `167f24b8-7ab6-4f1d-bff2-c4ad86a3d4ee`
- Plan hash: `ac52fdb8dd0824747775993b80cf52d121166144b1b3ce3bc3db5f199840131f`
- Verdict: **converged** after 2 rounds (round 1: 0/3/5, all accepted; round 2: all closed, 2 minors accepted)
- Owner approval: 2026-10-10, Claude Code session https://claude.ai/code/session_019XRHThojRVzYPDzoLtuby6 — "approved"
- This VTID implements Phase 3 only ("Runs survive a gateway deploy"), bound by the planner response to F7 (reattach token stored hashed on the run, valid only within the reattach window). Phase 1 is VTID-05065; Phases 2 and 4 have their own VTIDs.

---

# Plan — Kiro in the Operator, rebuilt on one server-side run record (option 2)

<!-- plan:begin -->
## Change class
standard, delivered as 4 phases, one VTID each, in order (no parallel VTID execution). Phase 1 includes a migration and new routes.

## Problem (verified 2026-10-10)
- A Kiro turn's live state exists only in the HTTP request that started it (`POST /api/v1/operator/chat/stream`, routes/operator.ts:788) and in one global slot in the browser (`state.chatSending`, `state.chatLiveKiro`, app.js). Reload, a second tab or a thread switch loses or misplaces it.
- Kiro sessions live in a gateway in-memory map (`sessions`, services/kiro/kiro-turn.ts); a gateway deploy/restart drops them; the graceful-shutdown hooks (index.ts ~1680) do not touch Kiro.
- Pending permission cards live in a gateway in-memory map (`pending`, permission-broker.ts) — lost on reload of the gateway, invisible to a second tab.
- Kiro's own MCP read tools arrive as permission kind `other` and each becomes a card (permission-broker.ts:16), so runs stall waiting for Allow and are denied after 120 s.
- No end-to-end test covers the experience (start → switch thread → reload → idle → continue).

## Target model
One **run** per Kiro turn, stored server-side, owns everything; the console only displays a run and can always replay it.

## Reused as is
kiro-runner (relay, workspace parking from VTID-05064, repo mirrors, key store, MCP proxy); `AcpClient`; `runKiroTurn` internals (history restore, session rules, model pick, stop statuses); Kiro MCP read/write tools + `kiro_mcp_confirmations` (DB-backed write Allow); `operator_threads`/`operator_messages` recording; OASIS events `operator.kiro.*`.

## Phase 1 — Run record, detached runs, replayable stream (backend only)
1. Migration `kiro_runs` (id uuid, thread_id, user_id, status queued|running|waiting_permission|completed|refused|incomplete|failed|cancelled|interrupted, message, reply, stop_reason, kiro_model, workspace jsonb, created_at, started_at, ended_at, gateway_task) and `kiro_run_events` (run_id, seq int, type, payload jsonb, created_at; unique (run_id, seq)). RLS on, service-role only (gateway writes; no client access). `DATABASE_SCHEMA.md` updated.
2. `services/kiro/kiro-runs.ts`: `startRun(thread, user, message)` inserts the run (`queued` if the thread already has a running run, else `running`) and returns immediately; the turn runs in the gateway background via the existing `runKiroTurn` with an event sink that appends to `kiro_run_events` (message chunks coalesced to one event per 500 ms or 2 KB; tool_call / tool_update / permission_request / permission_answer / turn_end each one event) and to an in-process pub/sub for live listeners. `seq` is assigned in-process by the single owning task before both the pub/sub emit and the DB write, so replay + live hand-off has no gap or duplicate. DB writes are batched: one bulk insert per run every 1 s or 20 events, flushed on terminal status and on shutdown — a typical turn (≈20 tool calls, ≈10 KB text) is 5–15 inserts; with the existing caps (3 sessions per user, 10 global) peak is ≈10 inserts/s. On end: status from `kiro_status`, reply stored, `recordOperatorTurn` + OASIS reply event as today. One running run per thread; the next queued run of that thread starts when it ends; at most 2 queued runs per thread (a third answers 409 `queue_full`).
3. Routes (new file `routes/operator-kiro-runs.ts`, `requireAdminAuth`, owner-only, atlas: add `/^operator-kiro-runs$/` to the `agents` domain `routes` in `orb/developer/domain-atlas.ts`): `POST /api/v1/operator/kiro/runs` (start or queue) → `{ run_id, status }`; `GET /runs?thread_id=` (latest 20); `GET /runs/:id`; `GET /runs/:id/stream?after_seq=` (SSE: replays stored events after `after_seq`, then live, closes on terminal; a dropped stream or an expired JWT just reconnects with a fresh token and the last seen `after_seq`); `POST /runs/:id/cancel` (running → existing ACP cancel; queued → cancelled); `DELETE` none.
4. Permissions persisted: a permission request is written as a run event and its pending state stored on the run (`waiting_permission`); `POST /api/v1/operator/kiro/permissions/:requestId` (existing route) answers it; a second tab sees and can answer the same card. Timeout stays 120 s → denied, recorded.
5. Read-tool trust: a permission request whose title is exactly `Running: @vitana/<name>` (kiro-cli's MCP title format — observed in production with kiro-cli 2.28.0: OASIS `operator.chat.message` metadata.toolCalls on 2026-10-10 16:50 UTC holds "Running: @vitana/dev_system_status", "Running: @vitana/dev_db_query", and the owner's screenshots show the permission cards "Running: @vitana/dev_read_file" / "…dev_search_codebase" with kind `other`; the CI pin uses those recorded strings; if a future kiro-cli changes the format the request falls back to a card — never to an allow) with `<name>` in `KIRO_MCP_READ_TOOLS` is auto-allowed; anything else still asks. A CI test pins the exact title format from a recorded kiro-cli frame, so a format change fails CI instead of silently bringing cards back. Write tools keep both the card and their DB-backed Allow; the MCP route dispatches by its own tool name, so a misleading title cannot skip a write's Allow.
6. Ownership and liveness: each gateway process mints `GATEWAY_TASK_ID` (random uuid at boot) stored on its runs as `gateway_task`; every 30 s it runs ONE update setting `last_heartbeat_at = now()` on its own non-terminal runs. A sweep (on boot and every 60 s, in every task) marks non-terminal runs with `last_heartbeat_at < now() - 2 min` as `interrupted` (Phase 3 tries a reattach first). Graceful shutdown (`installGracefulShutdown` drainHooks, index.ts ~1688) flushes pending events and marks this task's running runs `interrupted` immediately. The console shows interrupted with a "Continue" action (a new run with the same thread; history restore + parked workspace from VTID-05064 carry the context).
7. Old path kept: `POST /chat` / `/chat/stream` for Kiro threads call `startRun` and stream that run, so the current console keeps working unchanged until Phase 2.
8. End-to-end harness FIRST (extends `test/vtid-04465-operator-pipeline-regression.test.ts`, in-memory DB + fake kiro-cli): start run → stream; drop the stream and reattach with after_seq (no lost / duplicated event); second listener; permission answered from a second listener; read tool auto-allowed; queued run starts after the first; cancel running / queued; shutdown hook marks interrupted; continue after interrupted restores history. Mutation-checked (each assertion fails when its line of code is reverted).

## Phase 2 — Kiro console as its own module
1. New `frontend/command-hub/kiro-console.js` (+ `kiro-console.css`) — takes over the ≈850 lines of Kiro rendering/state now in app.js (VTID-04975…05064 sections) plus their CSS; the goal is one owner of the Kiro view, not shrinking app.js, loaded by index.html (external file, CSP-compliant, `?v=`); app.js delegates the chat pane of a Kiro thread to it and keeps the thread list, the engine switch and the LLM path unchanged. The VTID-05064 Kiro live-transcript code in app.js is removed (one owner of the Kiro view).
2. The module renders a thread as: past runs (messages + collapsible steps: tool calls with status, permission cards with their answer, stop marker) and the current run live from `GET /runs/:id/stream?after_seq=`; on reload / thread switch / second tab it lists runs and reattaches. Thread list spinner from run status.
3. Composer always enabled: Send while a run is running → `POST /runs` queues it (shown as a queued item with Cancel); it starts automatically when the current run ends (the owner pressed Send — an explicit instruction).
4. Stop = cancel current run; "Continue" on interrupted runs.
5. Visual check per CLAUDE.md IF-THEN 26 on staging (read-only: render existing runs; no new run on staging, rule 48).

## Phase 3 — Runs survive a gateway deploy
1. kiro-runner keeps a kiro-cli process alive for `KIRO_RUNNER_REATTACH_MS` (default 10 min) after its gateway socket drops instead of ending it; frames produced meanwhile are buffered (cap 2 MB, then the session ends).
2. A new gateway task reattaches with `user_id` + `thread_id` + the run's `session_reattach_token` (minted at start, stored hashed on the run, sent in a header like the MCP pass, valid only for the `KIRO_RUNNER_REATTACH_MS` window after the drop) and receives the buffered frames; the run continues instead of becoming interrupted. Without a token match the runner refuses.
3. Boot recovery in the gateway: runs `running` on a dead task are reattached first; only if the runner refuses are they marked interrupted.

## Phase 4 — Pipeline tree on top of runs
The already sparred pipeline-tree plan (sparring session 159d2217…, converged; scratchpad pipeline-tree-plan.md) is implemented here, reading Plan/Implement nodes from the run record instead of client-side frames; all other nodes unchanged from that plan.

## Out of scope
Concurrent runs in one thread; Kiro on mobile ORB; persisting kiro-cli across a runner redeploy (runner redeploy still interrupts; reported, Continue available).

## Tests per phase
P1: harness above + unit tests (event coalescing, seq ordering, status mapping, auth/owner checks, title pin). P2: command-hub jest for the module (reattach with after_seq, queue, stop, interrupted→continue) + staging read-only render screenshots desktop/mobile. P3: runner vitest (socket drop keeps process, buffer cap, token check, reattach replays buffer) + gateway harness (deploy simulated mid-run → run completes). P4: as in the pipeline plan. Every phase keeps `npm run test:operator`, `test:support`, `test:roles` green and ships `docs/validation/<VTID>/staging-tests.json` (read-only).
<!-- plan:end -->

## Planner responses — round 1
- F1 major — ACCEPTED: the title format is observed, not guessed (production OASIS toolCalls 2026-10-10 16:50 UTC and the owner's screenshots, kiro-cli 2.28.0); cited in P1.5; CI pins the recorded strings; a format change degrades to cards, never to an allow; write tools are never auto-allowed and keep their DB-backed Allow.
- F2 major — ACCEPTED: per-process `GATEWAY_TASK_ID`, `last_heartbeat_at` updated every 30 s (one UPDATE per task), sweep on boot + every 60 s marks stale (>2 min) runs interrupted; graceful shutdown marks immediately.
- F3 major — ACCEPTED: batched bulk inserts (1 s / 20 events / terminal / shutdown), volume estimate stated.
- F4 minor — ACCEPTED: atlas edit explicit.
- F5 minor — ACCEPTED: reconnect with fresh token + after_seq; seq assigned in-process before emit and write.
- F6 minor — ACCEPTED: ≈850 lines move; purpose is one owner of the Kiro view.
- F7 minor — ACCEPTED: reattach token stored hashed, valid only within the reattach window.
- F8 minor — ACCEPTED: max 2 queued runs per thread, 409 beyond.
- Q3 — the pipeline-tree plan is in the scratchpad; Phase 4 reads Implement nodes from kiro_runs/kiro_run_events by thread + VTID.

## Planner responses — round 2
- F9 minor — ACCEPTED: the Kiro drain hook is appended to the existing `drainHooks` array (no second install) with its own internal 3 s bound, sharing the 5 s drain.
- F10 minor — ACCEPTED: the sweep's UPDATE is guarded (`status in (running, waiting_permission, queued)` and stale heartbeat), so a second task's sweep is a no-op; the OASIS event is emitted only for rows the UPDATE actually changed.

## Verdict
CONVERGED after 2 rounds (round 1: 0 blocker / 3 major / 5 minor, all accepted; round 2: all closed, 2 new minors accepted).
