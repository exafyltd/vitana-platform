# VTID-04493 — Community Autopilot CA-1: one activation path + shared voice tools

Step CA-1 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`.

## What was wrong

- `activate_recommendation` (the tool a spoken "yes" to a single Autopilot
  offer calls) only flipped `status` to `activated`: no calendar slot, no OASIS
  event, no notification, unlike the popup's Go button.
- `get_autopilot_recommendations` / `activate_autopilot_recommendations` existed
  only as inline `case` arms in `routes/orb-live.ts`, keeping the read-out ids in
  the WebSocket session object. LiveKit and `/api/v1/orb/tool` could not use them.
- The LiveKit `activate_recommendation` wrapper posted to
  `/api/v1/autopilot/recommendations/:id/activate` **without `role=community`**,
  so a member's "yes" took the Dev Autopilot branch (`activate_autopilot_recommendation`
  RPC, VTID allocation) instead of the community activation.
- The tool description told the model to "speak `spoken` verbatim" (NEVER-rule 41).

## What changed

- New `services/orb-tools/community-autopilot-tools.ts`: `activateForVoice` (the one
  voice activation, over the canonical `activateCommunityAutopilotRecommendation`),
  `get_autopilot_recommendations`, `activate_autopilot_recommendations` on the shared
  registry. Read-out ids persist in `orb_session_state` key `autopilot_listed_ids`
  (10 min TTL, cleared after use); `positions` resolves "the second one"; at most 5
  per call; per-item results.
- `tool_activate_recommendation` delegates to `activateForVoice`; error codes kept.
- `orb-live.ts` cases delegate to the shared dispatcher.
- LiveKit agent: `activate_recommendation` dispatches through `/api/v1/orb/tool`;
  `get_autopilot_recommendations` and `activate_autopilot_recommendations` added.
- Tool description rewritten as intent; `positions` parameter declared.
- Orchestrator tool catalog: both activation tools are user-own self commits
  (owner decision 1, 2026-09-24). Policy is shadow-only today.
- `voice-pipeline-spec/spec.json`: the three tools marked implemented on LiveKit.

## Acceptance criteria

AC-1: `get_autopilot_recommendations`, `activate_autopilot_recommendations` and `activate_recommendation` are on the shared ORB tool registry, so Vertex/Nova, LiveKit and `/api/v1/orb/tool` all reach the same handler.
TEST: services/gateway/test/vtid-04493-community-autopilot-voice-tools.test.ts

AC-2: Listing stores exactly the read-out ids; activating with no arguments activates exactly those, in order, through the canonical community activation with `skipReplenish`, and clears the stored list.
TEST: services/gateway/test/vtid-04493-community-autopilot-voice-tools.test.ts

AC-3: `positions` resolves against the read-out list ("the second one"); explicit ids are de-duplicated and capped at 5; nothing listed means no activation; a per-item failure is reported while the rest activate; anonymous callers are refused.
TEST: services/gateway/test/vtid-04493-community-autopilot-voice-tools.test.ts

AC-4: `activate_recommendation` delegates to the canonical activation (calendar slot, OASIS, notification) and maps its failures to the stable error codes; the pending-offer fallback still works and is only consumed after success.
TEST: services/gateway/test/voice-activate-recommendation-shared.test.ts

AC-5: The only snapshot changes are the rewritten `activate_autopilot_recommendations` description (intent, no verbatim speech) and its new `positions` parameter.
TEST: services/gateway/test/orb/live/characterization/tool-catalog.characterization.test.ts

AC-6: The new tests fail against the unchanged source (10 of 19) and pass with it.
TEST: docs/validation/VTID-04493/outputs/mutation-src-reverted.txt

## Not verified

- No live voice activation on any host (CLAUDE.md: no writes as the test account).
- The LiveKit Python agent was syntax-checked only; `pytest` is not installed in
  this sandbox and its catalogue parity test is not run in CI. That test was
  already failing before this change: 11 spec tools were missing on LiveKit.
  This PR adds 2 of them; the other 9 are out of scope.
