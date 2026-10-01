# VTID-04418 — Conversation rebuild WS-1.6: remove duplicate voice code paths

This is Plan v1 (Conversation Intelligence Rebuild), Phase 1, workstream WS-1.6.
It ships in PR #3614 as a companion to VTID-04339.

## What was duplicated (read from the code)

1. **Two upstream handler sets.**
   - **The raw frame handler** `createUpstreamLiveMessageHandler` (about 1 300 lines) serves only the Vertex path, which today is the Serbian bridge.
   - **The provider-neutral handlers** `bindUpstreamSessionHandlers` serve Nova Sonic and the cascade.

   A feature diff of the two (`outputs/handler-diff.md`) found:
   - **`VertexLiveClient` already emits every event the shared handlers bind to.**
   - **Unique to the raw handler:**
     1. clearing consumed tool results at turn complete;
     2. a push notification after the Vitana→user chat bridge write;
     3. forwarding model text parts;
     4. stopping at an interruption within a frame.
   - **Unique to the shared handlers:**
     1. the still-here backstop, never wired on Vertex despite the VTID-03824 note;
     2. the graceful tool-loop guidance;
     3. a per-turn reset of the model-responded flag, without which the no-ack watchdog never re-arms on Vertex;
     4. a stricter function-call id echo.
2. **A missed end path.** `terminateExistingSessionsForUser` closes a session superseded by a newer one. It closed that session with no memory commit, voice summary or continuity write. This is the one session end VTID-04353 did not route through `finalizeLiveSession`.
3. **Five hand-copied keepalive teardown blocks** in `orb-live.ts` and the controller, next to the `clearUpstreamKeepalive` helper.

## Fix

- **Consumed tool results are cleared.** The shared `handleTurnComplete` now clears consumed tool results, as the raw handler did. Without this, Nova and cascade sessions re-injected up to three already-consumed results as "unfinished work" into every rebuilt setup (persona swap, reconnect).
- **`VertexLiveClient` and `GeminiApiKeyLiveClient`** stop processing a frame at an interruption, as the raw handler did.
- **The Vertex path can use the shared handlers.**
  - With `ORB_VERTEX_SHARED_HANDLERS=true` (exact string), the path binds the shared handlers before `connect()`: `enableSilenceKeepalive`, and `bindConnectionEvents: false` because the route keeps its own raw-socket error and close handlers.
  - It then does not register the raw handler; both at once would process every frame twice. It emits an `upstream_handlers_bound` diag.
  - The flag is pinned on the staging deploy only; production does not set it.
- **Superseded sessions are finalized** before they are marked inactive.
- **One keepalive teardown:** `clearUpstreamKeepalive` replaces the five copies.

## Owner decision, not changed

The raw handler sends a push notification for each Vitana voice line bridged into chat (VTID-03520). The shared handlers never did, so Nova and cascade users have not received it for months, and Serbian sessions lose it once the switch is on. Porting it would send every voice user one push per Vitana turn. That is a product decision, not a refactor.

## Not done here

- **The raw handler is not deleted yet.** Deleting it waits for a real Serbian bridge session on staging running on the shared handlers (`upstream_handlers_bound` with `path: shared`, then audio and turns). Staging is currently not placing tasks.
- **Model text parts are not forwarded on the shared path.** Vertex sessions are audio; this also stops thought text from being passed on as a transcript.

## Acceptance criteria

AC-1: A superseded session is finalized before it is marked inactive.
TEST: services/gateway/test/orb/live/session/vtid-04418-teardown-dedupe.test.ts

AC-2: No hand-copied keepalive clearing remains in orb-live.ts or the controller; the helper clears both intervals and is idempotent.
TEST: services/gateway/test/orb/live/session/vtid-04418-teardown-dedupe.test.ts

AC-3: A completed turn clears the consumed tool results on the shared handlers.
TEST: services/gateway/test/orb/live/session/vtid-04418-teardown-dedupe.test.ts

AC-4: The Vertex switch is an exact-string opt-in, binds before connect without connection events, and skips the raw handler; it is pinned on staging only.
TEST: services/gateway/test/orb/live/session/vtid-04418-teardown-dedupe.test.ts

AC-5: VertexLiveClient emits no audio from a frame that carries an interruption.
TEST: services/gateway/test/orb/live/session/vtid-04418-teardown-dedupe.test.ts

AC-6: No regression in the ORB, route, conversation, script and Command Hub suites (including the provider-parity and the raw-handler characterization suites); tsc clean; the staging workflow bash/size guard passes.
TEST: services/gateway/test/orb, services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-7 (post-deploy, staging): a Serbian session logs `orb.live.diag` `upstream_handlers_bound` (`path: shared`) and completes turns with audio; a superseded session produces `conversation.session.finalized` with reason `superseded_by_new_session`.
CURL: curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/alive
