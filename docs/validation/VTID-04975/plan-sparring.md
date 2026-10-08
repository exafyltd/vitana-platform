# Plan sparring record - VTID-04975

Plan hash (sha256 of the text between the plan markers): `f79d54111fa9bd859a80ee8600486a3d3849d0b95206554fd1c9c08e8cb29cc6`. Partner: plan-sparring-partner (read-only, independent), 3 rounds, CONVERGED (standard class). The plan body below carries Revision 2 and 3 text added during sparring; the hash is of the text approved by the owner at Gate 1 (the full text between the markers at that time).

# Plan: Kiro engine in the Command Hub Operator (replace Kiro Web)

Change class: standard
Scope: services/gateway/src/services/gemini-operator.ts, services/gateway/src/routes/operator.ts, new services/gateway/src/services/kiro/* (ACP client, key vault, session manager), new ECS service "kiro-runner" (new Dockerfile, AWS-*-DEPLOY-KIRO-RUNNER.yml), Command Hub frontend (services/gateway/src/frontend/command-hub), new tests, docs/DATABASE_SCHEMA.md if a table is added.

<!-- plan:begin -->
Goal: a Command Hub user links their own Kiro API key to their Command Hub account and drives Kiro (coding agent) from the Operator chat, replacing Kiro Web. First account: dstevanovic@hotmail.com. Owner has a Kiro Power subscription for several users; admin has enabled API key generation for every seat.

Facts (from Kiro docs): Kiro exposes no REST API. Programmatic use is `kiro-cli` only: headless (`kiro-cli chat --no-interactive --output-format stream-json`, auth by env KIRO_API_KEY) or ACP (`kiro-cli acp`, JSON-RPC 2.0 over stdio: initialize, session/new, session/load, session/prompt, session/cancel, session/set_mode). API keys are per user account, Pro/Pro+/Pro Max/Power only. Docs state no concurrency limits.

Design:
1. Key vault: one AWS Secrets Manager secret per user, `vitana/kiro/users/<command_hub_user_id>`, in account 472838866351 / eu-central-1. Key is submitted once via an authenticated gateway endpoint (POST /api/v1/operator/kiro/key, user JWT, tenant+user from token), written to Secrets Manager, never stored in the DB, never logged, never returned. DB table `kiro_user_links` (tenant_id, user_id, secret_arn, status, linked_at, last_used_at, RLS by tenant+user) holds only the link metadata. Admin (exafy_admin) can revoke.
2. kiro-runner: new ECS service (own VTID, ECR, port 8080, /alive, deployed via a canonical AWS-*-DEPLOY workflow, staging first). Internal only, authenticated with GATEWAY_SERVICE_TOKEN. Spawns one `kiro-cli acp` process per active session with an isolated HOME and workspace, KIRO_API_KEY injected only into that child's env, idle timeout + max concurrent sessions per user and globally (initial cap 3 per user, 10 global, configurable), cancel and close endpoints, streaming of ACP events.
3. Operator wiring: new engine "kiro" selectable in the Operator chat; ACP events (message chunks, tool calls, turn end) mapped onto the existing OperatorTurnEvent stream. Default tool trust is read-only; write/exec tools go through the existing approval hold. Role gate: developer/admin only (same as the existing engineering-context gate). Each run emits OASIS events (user, session, duration; no key material, no prompt contents beyond existing excerpt limits) and is bound to a VTID.
4. Command Hub UI: "Connect Kiro" panel (paste key, status, revoke), engine picker, session list with resume via session/load. Bump ?v= cache param. No sidebar change.
5. Governance: Kiro is a coding-agent runtime, not an llm_routing_policy provider; no Google dependency, no change to Bedrock routing. Autonomous-plane runs must carry metadata.autonomous_execution=true.
6. Tests: unit tests for ACP client and key vault (mocked Secrets Manager, mocked child process); extend test/vtid-04465-operator-pipeline-regression.test.ts with a Kiro scenario; staging-tests.json read-only (link status endpoint, runner /alive, an ACP initialize against a fixture, no writes).
7. Rollout: staging only until STAGING-VERIFY passes; then Gate 2.

Linking the first account (dstevanovic@hotmail.com): after the gateway endpoint is deployed to staging, the owner pastes the key in the Connect Kiro panel while signed in as that account (the key never passes through chat). Until then, the interim path is a local script that writes the same Secrets Manager secret.

Open owner items: (a) whether Kiro's terms allow a backend to drive Kiro on a user's behalf (unconfirmed; owner says set up together), (b) concurrency caps are guesses because Kiro documents none.
Revision 2 (after round 1):
R1. Tool trust (F1): no reuse claim. The runner starts every ACP session in the most restrictive mode (no auto-trusted write/exec tools). ACP permission requests from the agent (`session/request_permission`, standard ACP; to be confirmed against kiro-cli on staging before relying on it) are forwarded to the Hub as an approval card for the session owner; no answer within 120s = deny; the user may grant per-session trust for read tools only. Approvals are logged as OASIS events. If kiro-cli cannot emit permission requests, write/exec stays disabled and Kiro runs read-only (`--trust-tools=read,grep` equivalent).
R2. Events (F2): add NEW additive union members in a separate `KiroTurnEvent` type (kiro.message_chunk, kiro.tool_call, kiro.tool_update, kiro.permission_request, kiro.turn_end), mapped from ACP AgentMessageChunk, ToolCall, ToolCallUpdate, session/request_permission, and the session/prompt response (stop reason). Existing OperatorTurnEvent is not modified, so existing consumers are unaffected.
R3. Engine selection (F3): no refactor of processWithGemini or gemini-operator.ts (zero lines changed there). The route in operator.ts dispatches on a per-thread `engine` value ('llm' default, 'kiro') fixed when the thread is created; no mid-thread switching. A Kiro thread's history lives in the Kiro session (session/load), not in the LLM transcript.
R4. Infra (F4): kiro-runner is Phase 2 with its own VTID and its own infra checklist: internal-only (no public ALB rule), service discovery name, security group allowing gateway only, services_catalog row, config/service-path-map.json entry, ECS capacity check, task role limited to secretsmanager:GetSecretValue on arn:...:secret:vitana/kiro/users/* in eu-central-1, kiro-cli version pinned in the Dockerfile.
R5. Vault (F5): on submit the gateway checks format, then validates the key with one cheap headless probe through the runner before storing; kiro_user_links gets last_validated_at and status (active|invalid|revoked); a key Kiro rejects at session start flips status to invalid and the Hub shows "reconnect Kiro". Rotation = resubmit (put-secret-value). Per-secret cost ($0.40/month) accepted.
R6. ToS gate (F6): Phase 1 (design, ACP client against a fixture, Hub UI, tests) uses no real key. Phase 2 (runner deployment and storing any real user key, including dstevanovic@hotmail.com) starts only after the owner has written confirmation from AWS/Kiro that a backend may run kiro-cli with each user's own key on that user's behalf. If denied, the plan stops after Phase 1.
R7. Process safety (F8): per-session supervisor (crash detection on stdio, SIGTERM drain on ECS stop, orphan reaper), per-session workspace quota and disk monitor, idle timeout, cleanup on close.
R8. Code produced by Kiro: Kiro works in an isolated clone and cannot push to main; any PR it produces goes through the same VTID, sparring, CI and staging gates as a human session's PR. It is a session-plane tool, never the autonomous plane.
R9. Deliverables made explicit: docs/DATABASE_SCHEMA.md update for kiro_user_links; Command Hub path services/gateway/src/frontend/command-hub/index.html ?v= bump.
Revision 3 (after round 2):
R10. Engine storage (F11): migration adds `engine TEXT NOT NULL DEFAULT 'llm' CHECK (engine IN ('llm','kiro'))` to `operator_threads`; set once at thread creation (operator-threads.ts upsert), never updated afterwards; returned by the thread-list endpoint so the console shows the thread type. docs/DATABASE_SCHEMA.md updated. Existing rows default to 'llm'.
R11. Dispatch (F12): option (a). Inside `runOperatorChatTurn()`, after validation, auth and thread resolution but before `processWithGemini()`, a thread with engine='kiro' delegates to `runKiroTurn()` (new file under services/gateway/src/services/kiro/), which returns the same `OperatorChatTurnOutcome`. Validation, auth, OASIS events and thread recording are reused; `/chat` and `/chat/stream` both work because both call `runOperatorChatTurn()`. Kiro events are written to the SSE stream through the existing onEvent callback.
R12. Recording (Q3): Kiro turns are recorded in `operator_messages` for audit with the existing roles only: the user prompt as 'user', the final agent text as 'assistant', and a one-line summary of each tool call as 'tool'. Full Kiro event history stays in the Kiro session. No CHECK-constraint change.
R13. Session commands (F13): new, load, cancel and close go through dedicated endpoints under /api/v1/operator/kiro/sessions (same auth and role gate), not through the chat schema; the chat message schema is unchanged.
<!-- plan:end -->

## Planner responses (round 2)
- F11 ACCEPTED — R10.
- F12 ACCEPTED — R11 (option a) and R12 for recording.
- F13 ACCEPTED — R13.
- Q1 R10. Q2 R11. Q3 R12.

## Planner responses (round 1)
- F1 ACCEPTED — see R1; the false "existing approval hold" reuse claim is removed and a Kiro-specific permission flow is designed.
- F2 ACCEPTED — see R2.
- F3 ACCEPTED — see R3 (dispatch at the route, no change to gemini-operator.ts).
- F4 ACCEPTED — see R4.
- F5 ACCEPTED — see R5.
- F6 ACCEPTED — see R6; phased so no real key is stored before ToS confirmation. Owner decision still required on whether to proceed to Phase 2.
- F7 DEFERRED — renaming gemini-operator.ts is out of scope and risky for a 1.85/10 health file; tracked as follow-up cleanup, not in this plan.
- F8 ACCEPTED — see R7.
- F9 ACCEPTED — see R9.
- F10 ACCEPTED — see R9.
- Q1 per-thread, fixed at creation; see R3. Q2 mapping in R2. Q3 yes, scoped task role in R4. Q4 version pinned in R4. Q5 see R8.

## Round 1 findings (partner)
F1 blocker: the "existing approval hold" does not exist. F2 blocker: ACP events do not map onto OperatorTurnEvent. F3 major: no engine abstraction. F4 major: kiro-runner infra checklist missing. F5 major: key validation/rotation/audit. F6 major: ToS risk listed but work would proceed. F7 major: gemini-operator.ts name is misleading. F8 minor: process management on Fargate. F9 minor: ?v= path. F10 minor: DATABASE_SCHEMA.md update. Verdict: NOT CONVERGED (2 blockers, 5 majors).

## Round 2 findings (partner)
F1-F10 closed (F7 acknowledged-deferred). New: F11 major (engine storage unspecified), F12 major (dispatch point unspecified), F13 minor (session commands vs chat schema). Verdict: NOT CONVERGED (2 majors).

## Round 3 (partner)
F11-F13 closed. No new findings. Verdict: CONVERGED.

## Owner approval
Approved by the owner in session 2026-10-08 ("yes, go ahead") at Gate 1, plan hash above.

## Decisions taken inside the approved plan (listed for Gate 2)
- Phase 1 only. Phase 2 (kiro-runner, Secrets Manager key vault, kiro_user_links, real keys, dstevanovic@hotmail.com link) is NOT in this change and stays gated on written Kiro/AWS terms confirmation.
- Session new/load happen implicitly on the first/next chat turn of a Kiro thread; explicit endpoints exist for cancel, close, permission answers and status (R13 narrowed to what a client needs; new/load add nothing the chat turn does not already do).
- Kiro turns skip the LLM-only extras (simulated-tool-call retry, route-gate shadow check, turn-memory extraction).
- The Command Hub UI panel ships in a follow-up commit of the same plan, because the Command Hub frontend is a path-guarded zone.
