# Plan sparring record — VTID-05064

- Sparring session: `b954072d-5fb6-48a7-ae8e-94ef96f660ed` (plan_sparring_sessions)
- Plan hash (sha256 of the text between the plan markers): `eb37ea096798b0c21d5ffa64c5a8232bf5db1d82a02aa1dccb69555b4ed989a6`
- Partner: plan-sparring-partner agent (independent, read-only)
- Verdict: **converged** after 2 rounds (round 1: 0 blocker / 3 major / 4 minor, all accepted; round 2: all closed, 2 new minors accepted)
- Owner approval: 2026-10-10, Claude Code session https://claude.ai/code/session_019XRHThojRVzYPDzoLtuby6 — "very good. approved"

---

# Plan — Kiro Operator Console reliability (lost edits, hidden refusals, thin history, VTID asks, misrouted turns)

<!-- plan:begin -->
## Change class
standard (gateway service + kiro-runner + Command Hub frontend + CI ownership guard allowlist line; no migration, no new route, no auth change, no LLM-routing change).

## Evidence (incident 2026-10-10, owner's threads 214bcb76…, 96de5275…)
- 17:53 UTC thread 96de5275: Kiro edited `app.js` + `styles.css` in its runner worktree and ran `node --check`; no push event followed. Runner + gateway idle close at 15 min (`kiro-runner/src/index.ts:41`, `gateway/src/services/kiro/kiro-turn.ts:145`) → `relay.ts:153` `fs.rm(dir)` deleted the edits.
- 17:52 UTC thread 214bcb76: `stop_reason: "refusal"` recorded with `kiro_status: "ok"` (`kiro-turn.ts` `runKiroTurn` returns `result('ok', …)` for any stopReason). The console showed a truncated reply as a normal answer.
- 18:21 UTC: new session (idle reopen) restored history via `restoredHistoryBlock` (`kiro-turn.ts:68-87`): each message clipped to its FIRST 1,500 chars, tool rows excluded. The 17:09 answer (6,010 chars) lost its findings/recommendation, so Kiro reported "I was still mid-investigation".
- 17:17 + 17:48: Kiro asked the owner to "tell me the VTID". Write tools require an open VTID (`kiro-mcp-writes.ts:45,71`) and VTID-minting tools are deliberately excluded (`kiro-mcp-writes.ts:14-17`), but nothing tells Kiro how to behave instead, so it asks the user — contrary to CLAUDE.md rule 2b / §4.1.
- Command Hub console: in-flight turn state is global (`state.chatSending`, `state.chatLiveKiro`, app.js ~4004/4018); `startNewOperatorThread` (~802) / `switchOperatorThread` (~1024) do not touch it; the final reply is saved to `state.operatorActiveThreadId` at completion (~25218-25222), i.e. to whatever thread is on screen. Switching back to a thread with non-empty local history never reloads typed messages from the server (~1053, `syncOperatorVoiceTurns` merges voice only, ~873). `stopKiroTurn` (~24550) cancels the active id, not the running one. Server thread row + user message are written only after the turn completes (`services/operator-threads.ts:182` `recordOperatorTurn`).

## Changes

### A. kiro-runner: never delete a workspace that holds uncommitted work (services/kiro-runner/src/relay.ts, server.ts, index.ts)
1. At `end()`, before `fs.rm(dir)`: for each repo worktree under `dir`, run `git status --porcelain` (bounded 5 s). If any is dirty → do NOT delete; write `dir/.kiro-parked.json` `{ user_id, thread_id, parked_at }` and register it in an in-memory `parked` map keyed `user_id:thread_id` (kill the kiro-cli child as today).
2. On `startRelay` for the same `user_id:thread_id`: if a parked dir exists, reuse it as the session dir (remove marker, skip `addWorktrees` for repos whose worktree directory already exists — add only missing ones). Path stays identical, so the mirror's `git worktree` admin data stays valid and `worktree prune` does not drop it.
3. Startup: scan `workRoot/*/.kiro-parked.json` to rebuild the map after a process restart on the same task (disk is task-ephemeral; a runner redeploy loses parked dirs — accepted residual, documented).
4. Retention sweep every 30 min: delete parked dirs older than `KIRO_RUNNER_PARK_TTL_MS` (default 24 h) and keep at most `KIRO_RUNNER_MAX_PARKED` (default 20, oldest evicted, logged). Clean workspaces are deleted exactly as today.
5. Key revocation (`stopUserSessions(..., 'kiro_key_revoked')`) deletes that user's parked dirs too.
6. Reuse is exclusive: the parked entry is removed from the map before the dir is handed to the new session, so two concurrent starts for one thread can never share a dir (the second gets a fresh one; the gateway already allows one session per thread, `kiro-turn.ts` `sessions` map). A reused worktree stays at the commit it was on; Kiro sees it via `git status`/`git log` (no auto-rebase).
7. Signal, never silent (F2): when parking, the runner sends one text frame `{"kiro_runner":"parked"}` before closing (if the socket is still open). After READY on every session it sends `{"kiro_runner":"workspace","state":"restored"|"fresh"}`. `remote-backend.ts` `socketAsAcpChild` filters `kiro_runner` frames out of the ACP stream and hands them to kiro-turn. The gateway emits OASIS `operator.kiro.workspace_parked` (thread, user) on the first, and on a `fresh` start for a thread whose latest event is `workspace_parked` with no later `workspace_restored`, emits `operator.kiro.parked_workspace_lost` and puts a notice on that turn's reply meta (`kiro_workspace: 'lost'`) which the console shows above the reply ("Earlier uncommitted Kiro edits in this thread were lost (runner restarted or retention expired)."). `restored` emits `operator.kiro.workspace_restored`. READY frame text is unchanged, so an old gateway against a new runner still starts.

### B. gateway: surface non-normal endings (services/gateway/src/services/kiro/kiro-turn.ts, routes/operator.ts recording path, app.js)
1. `runKiroTurn`: `stopReason === 'refusal'` → `kiro_status: 'refused'` (new KiroStatus member); `max_tokens` / `max_turn_requests` / `cancelled` → `kiro_status: 'incomplete'` with `stop_reason` kept. Reply text and tool results unchanged and still recorded. (F7) `KiroStatus` union gains `'refused' | 'incomplete'`; consumers audited: `routes/operator.ts:303` (no_credits only — unaffected), `:325` (pass-through), app.js:24416/24427 (`KIRO_FALLBACK_STATUSES` no_credits/not_connected — unaffected; new marker rendering added).
2. Console renders a visible marker under such a reply ("Kiro stopped early: refusal / limit / cancelled") — admin console text, English by design (13b admin exclusion, as existing Kiro strings).

### C. gateway: better history restore on a new session (kiro-turn.ts `restoredHistoryBlock`, operator.ts loadHistory)
1. Long assistant messages are clipped head + tail (first 500 + last 1,500 chars with an "… N chars omitted …" marker) instead of head-only, so conclusions survive. Per-message cap 2,000, total cap raised 12,000 → 16,000 chars (~4k tokens, newest kept, same algorithm). Kiro's models (Claude family via Kiro) have ≥200k-token contexts; the extra ~1k tokens is billed once per new session only, not per turn.
2. Header text adds: the history is truncated; the workspace may still hold uncommitted edits from earlier turns — check `git status` in each repo worktree before describing past progress. (Intent text for the agent, not user-facing speech.)
3. Recorded stop markers: an assistant message whose meta has `kiro_status` refused/incomplete is prefixed "[this reply was cut off: <stop_reason>]" in the restored block.

### D. Kiro must never ask the user for a VTID (kiro-mcp-writes.ts tool descriptions; kiro-mcp-tools.ts if a session-level instruction exists there; history header)
1. Replace the `[Kiro] Needs a vtid …` suffix and `VTID_PARAM.description` with guidance: the vtid must be an existing in_progress+approved VTID; never ask the user to supply or invent one; if no VTID exists for the work, finish the change in the workspace, say plainly that it needs a sparred, owner-approved plan before a VTID can exist (Plan Sparring Gate), and offer to write that plan. The gate itself (`checkVtidOpen`) is unchanged — no new VTID-minting path for Kiro.
2. Session-level rules (F6, F9): the rules block is prepended to the restored history in the ONE `context` string `prompt()` accepts (rules first, then history; rules alone when there is no history). The FIRST prompt of every new Kiro session (with or without restored history) carries a short marked rules block through the existing `prompt(sessionId, message, undefined, prefix)` path: never ask the user for a VTID; you cannot create one; unpushed edits must be pushed with `dev_push_kiro_branch` (which needs an open VTID) — when none exists, say so and offer the plan; check `git status` before describing earlier progress. Tool descriptions reinforce it.

### E. Command Hub console: replies land in the thread that asked (frontend/command-hub/app.js, styles.css, index.html ?v= bump; scripts/ci/command-hub-ownership-guard.js allowlist line)
Scoped down (F1): keep ONE running turn per console (existing global `state.chatSending` guard at app.js:25001 stays), no scalar→map conversion. Add one field `state.chatTurnThreadId`, set at send, cleared at completion/error.
1. Completion/error paths (~25218-25222 and the error branch): save history to `chatTurnThreadId` via `saveOperatorThreadHistory(chatTurnThreadId, …)`; push into `state.chatMessages`/`operatorChatHistory` only when `operatorActiveThreadId === chatTurnThreadId`, otherwise load-modify-save that thread's stored history.
2. Live transcript render (~23754): `if (state.chatSending && state.operatorActiveThreadId === state.chatTurnThreadId)`; on any other thread show a one-line banner "Kiro is working in <thread title> — open it" instead of the live transcript; Send stays disabled (existing behaviour) with that hint.
3. Thread list row for `chatTurnThreadId` gets a spinner while `chatSending`.
4. `stopKiroTurn` (~24550), the confirmation poll and `kiro.turn_end` model reset (~24471) use `chatTurnThreadId`.
5. (F3) Replace the voice-only filter in `syncOperatorVoiceTurns` (~872) with a sync of all user/assistant server messages for the thread that have no local counterpart (match on server message id stored in local entries; entries without an id — every typed turn today — matched by role + the first 500 chars of whitespace-normalised content, never by timestamp, since the server copy may be clipped by `clipMessage` and local timestamps are client `Date.now()`), appended in server order. Called on every thread open (~1052-1054), not only when local history is empty, and once after a reload for the active thread.
Every reader of `chatSending` / `chatLiveKiro` is unchanged in meaning (still one global turn); only the four sites above and the sync function change.
Deferred: true multi-thread concurrent turns (map-based live state) — a separate plan if wanted.

### F. gateway: thread exists from the moment of send (services/operator-threads.ts, routes/operator.ts)
1. Before the Kiro/LLM turn runs, upsert the `operator_threads` row (no messages, turns unchanged) so the server thread list contains an in-progress thread after a reload. `recordOperatorTurn` stays the single writer of messages and the turn count. No schema change. A row left with zero messages (gateway crash mid-turn) is harmless: the list shows its title; opening it shows the user's message from local history and the server sync adds nothing. No cleanup job.

## Out of scope
Persisting parked workspaces across runner redeploys (needs S3 or EFS = new infra, separate plan). Giving Kiro a VTID-minting or plan-sparring tool. Changing idle timeouts.

## Tests
- kiro-runner `test/runner.test.ts`: dirty worktree survives end + reused by same user/thread; clean worktree deleted; TTL/max-parked eviction; key revoke deletes parked; startup rescan.
- gateway jest: `restoredHistoryBlock` head+tail clipping, caps, cut-off prefix (extend vtid-05018 test); `runKiroTurn` refusal/incomplete statuses (extend vtid-04975 test); write-tool description no longer invites asking for a VTID (vtid-05006 test); thread upsert-at-send (operator-threads test).
- Operator pipeline suite `npm run test:operator` + support suite stay green; add a Kiro scenario (the suite already seeds Kiro threads, test:1348/1416): a refused stopReason records `kiro_status: 'refused'`. kiro-runner tests also cover the parked/workspace frames and remote-backend filtering of `kiro_runner` frames.
- Frontend: node --check; jsdom/unit test for per-thread routing if the command-hub test harness supports it (test/command-hub/*), else Playwright on staging: start a turn in thread A, switch to B, reply lands in A, spinner in list.
- Staging suite `docs/validation/<VTID>/staging-tests.json`: read-only checks — staging Command Hub serves the new `?v=` app.js containing the per-thread marker, gateway build-info at merge commit, kiro-runner `/alive` + build version.
<!-- plan:end -->

## Scope (files)
- services/kiro-runner/src/relay.ts, server.ts, index.ts, test/runner.test.ts
- services/gateway/src/services/kiro/kiro-turn.ts, kiro-mcp-writes.ts (maybe kiro-mcp-tools.ts)
- services/gateway/src/services/operator-threads.ts, src/routes/operator.ts
- services/gateway/src/frontend/command-hub/app.js, styles.css, index.html
- scripts/ci/command-hub-ownership-guard.js (one allowlist line)
- services/gateway/test/vtid-04975/05006/05018 tests, new staging-tests.json

## Planner responses — round 1
- F1 major — ACCEPTED. E scoped down: one global running turn stays; add `chatTurnThreadId`; only completion/error save, live-render condition, stop/poll/turn_end, list spinner and the sync change. Map-based concurrent turns DEFERRED (out of scope, separate plan if wanted).
- F2 major — ACCEPTED. A.7: runner `parked`/`workspace` frames → OASIS `operator.kiro.workspace_parked|workspace_restored|parked_workspace_lost` + console notice on the next reply when parked work is gone.
- F3 major — ACCEPTED. E.5: voice-only filter replaced by an all-message server sync on every thread open.
- F4 minor — ACCEPTED. Line refs corrected (68-87, 145).
- F5 minor — ACCEPTED. Total cap 16,000 (not 24,000) with the token/billing note.
- F6 minor — ACCEPTED. D.2: rules block on the first prompt of every new session.
- F7 minor — ACCEPTED. Union change + audited consumers listed; operator-suite scenario made unconditional.
- Q1 — E.5 replaces the filter inside the sync function (renamed for clarity), called on every open.
- Q2 — A.6: exclusive handoff; worktree stays at its commit, no auto-rebase.
- Q3 — F: empty row harmless, no cleanup.

## Planner responses — round 2
- F8 minor — ACCEPTED (verified, no change needed): `AcpClient.onLine` (acp-client.ts:117-131) drops any JSON object without `method`/`id`, so a `kiro_runner` frame reaching an old gateway is ignored silently. Noted in the PR.
- F9 minor — ACCEPTED. D.2 now states one concatenated `context` string, rules first.
- Q1 — ACCEPTED. E.5 dedupe is role + first 500 chars of normalised content for id-less entries, never timestamps.

## Verdict
CONVERGED after 2 rounds (round 1: 3 major + 4 minor, all accepted; round 2: all closed, 2 new minors accepted).
